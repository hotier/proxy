// 生产上那 93.5KB 的 CSS 是原样过海的：Deno Deploy 不自动压缩，适配器用的 @std/http serveFile
// 也不认预压缩文件（1.1.1 的 ServeFileOptions 只有 etagAlgorithm/fileInfo，没有 precompressed）。
// 而它是渲染阻塞的——实测冷启动 FCP 2552ms，其中约一半就在这条 CSS 往返上。
//
// 所以在构建期把文本资源另存 .br/.gz，并把生成的入口里那两处 serveFile 换成 serveCompressed：
// 静态资源从此按 Accept-Encoding 挑现成的变体，运行时零压缩 CPU
// （运行时只有 gzip 可用，且 CPU 才是这个应用的瓶颈配额；HTML 那部分才走 src/lib/compress.ts）。
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import type { AstroIntegration } from 'astro';

/** 只压文本：图片、字体这些再压也省不出几个字节 */
const TEXT_EXT = new Set(['.css', '.js', '.mjs', '.html', '.svg', '.json', '.webmanifest', '.txt']);

/** 小于 1KB 的产物体征是「一个请求里成百个小文件」，多存两份变体不值 */
const MIN_BYTES = 1024;

/**
 * serveFile 是按扩展名给 content-type 的，喂给它 .br/.gz 会把头丢掉，
 * 而 CSS 丢了 `text/css` 会被浏览器按严格 MIME 直接拒收，所以这里得自己补。
 */
const RUNTIME_MIME = `{
  '.css': 'text/css; charset=UTF-8',
  '.js': 'text/javascript; charset=UTF-8',
  '.mjs': 'text/javascript; charset=UTF-8',
  '.html': 'text/html; charset=UTF-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=UTF-8',
}`;

/** 注入到生成入口里的运行时协商，只在静态文件那一路被调用 */
const RUNTIME_HELPER = `
// ── 由 src/integrations/static-compress.ts 在构建期注入：按 Accept-Encoding 挑预压缩变体 ──
const SC_MIME = ${RUNTIME_MIME};

function scType(filePath) {
  const dot = filePath.lastIndexOf(".");
  return SC_MIME[filePath.slice(dot).toLowerCase()] || null;
}

async function serveCompressed(request, filePath) {
  const type = scType(filePath);
  // 二进制资源没有变体可给，走原路径，省掉两次必然落空的 stat
  if (!type) return serveFile(request, filePath);
  const accept = request.headers.get("accept-encoding") || "";
  const variants = [];
  if (/(^|,)\\s*br\\b/i.test(accept)) variants.push([".br", "br"]);
  if (/(^|,)\\s*gzip\\b/i.test(accept)) variants.push([".gz", "gzip"]);
  variants.push(["", null]);
  let last;
  for (const [suffix, encoding] of variants) {
    const resp = await serveFile(request, filePath + suffix);
    if (resp.status === 200 || resp.status === 304) {
      resp.headers.set("content-type", type);
      // 变体协商必须声明出去，否则中间缓存可能把 brotli 体发给没提 br 的客户端
      resp.headers.append("vary", "Accept-Encoding");
      if (encoding) resp.headers.set("content-encoding", encoding);
      // _astro/ 下的文件名带内容哈希，换内容就换名，可以放心让浏览器留一年
      if (/[\\\\/]_astro[\\\\/]/.test(filePath)) resp.headers.set("cache-control", "public, max-age=31536000, immutable");
      return resp;
    }
    // 404 只说明这一档变体不存在，继续往下试；最后一档落空才交给原来的兜底逻辑
    await resp.body?.cancel();
    last = resp;
  }
  return last;
}
`;

/** 入口里那两处静态文件调用（主路径 + 预渲染 index 回退）都要换掉，少一处就是漏网 */
const SERVE_CALLS = ['serveFile(request, fromFileUrl(localPath))', 'serveFile(request, fromFileUrl(fallback))'];

/** 深度优先列出目录里的文件（构建产物层数很浅，递归够用） */
async function* walk(dir: string): AsyncGenerator<string> {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = `${dir}/${ent.name}`;
    if (ent.isDirectory()) yield* walk(p);
    else yield p;
  }
}

export default function staticCompress(): AstroIntegration {
  // 路径在 config:done 就拿：build:done 的 dir 参数跟着 adapter 的资源搬移走，指哪儿都有可能
  let clientURL: URL | undefined;
  let entryURL: URL | undefined;
  return {
    name: 'static-compress',
    hooks: {
      'astro:config:done': ({ config }) => {
        clientURL = new URL(config.build.client);
        entryURL = new URL('server/entry.mjs', config.outDir);
      },
      'astro:build:done': async ({ logger }) => {
        const client = fileURLToPath(clientURL!).replace(/\\/g, '/');
        const entryPath = fileURLToPath(entryURL!);

        let count = 0;
        let saved = 0;
        for await (const file of walk(client)) {
          const dot = file.lastIndexOf('.');
          if (!TEXT_EXT.has(file.slice(dot).toLowerCase())) continue;
          const body = await readFile(file);
          if (body.byteLength < MIN_BYTES) continue;
          const br = brotliCompressSync(body, {
            params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: body.byteLength },
          });
          const gz = gzipSync(body, { level: 9 });
          // 压完还变大的（正文已经高熵）就不留文件，运行时那一档自然落空
          if (br.byteLength < body.byteLength) await writeFile(`${file}.br`, br);
          if (gz.byteLength < body.byteLength) await writeFile(`${file}.gz`, gz);
          count++;
          saved += body.byteLength - Math.min(br.byteLength, gz.byteLength);
        }
        logger.info(`预压缩 ${count} 个文本资源，最大一档省 ${(saved / 1024).toFixed(0)} KB`);

        const entry = await readFile(entryPath, 'utf8');
        if (!entry.includes('async function start() {')) {
          throw new Error('静态资源预压缩没能接上生成的入口：找不到 start() 的注入点，检查 @deno/astro-adapter 是否改了源码');
        }
        let patched = entry.replace('async function start() {', `${RUNTIME_HELPER}\nasync function start() {`);
        for (const call of SERVE_CALLS) {
          const needle = `await ${call};`;
          if (!patched.includes(needle)) {
            throw new Error(
              `静态资源预压缩没能接上生成的入口：找不到 ${needle}。` +
                '多半是 @deno/astro-adapter 改了这段源码，对照 dist/server/entry.mjs 更新 SERVE_CALLS。',
            );
          }
          patched = patched.replace(needle, `await ${call.replace('serveFile(', 'serveCompressed(')};`);
        }
        await writeFile(entryPath, patched);
        logger.info('入口已接上 serveCompressed');
      },
    },
  };
}
