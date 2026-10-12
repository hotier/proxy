// Deno Deploy 不替我们压缩响应：实测生产首页 23.6KB 的 HTML 原样上线，而浏览器必须先拿到
// 它才能发现那 93.5KB 的 CSS——首屏被这条串行链路拖住。静态资源在构建期就压好
// （src/integrations/static-compress.ts），这里只管运行时生成的响应。
//
// 白名单而不是黑名单：代理透传的响应一律不动。那里面是上游已经压好或本就是二进制的字节流，
// 再压一遍既花 CPU 又会把 countOutboundBytes 记出去的字节数改掉。
const COMPRESSIBLE = /^text\/html|^application\/json/i;

/** 小于这个量级压不出几个字节，不值得为它整体缓冲一次 */
const MIN_BYTES = 1024;

/** CompressionStream 只有 gzip/deflate，没有 brotli；而会提 br 的客户端一定也提 gzip */
export function wantsGzip(acceptEncoding: string | null): boolean {
  return /(?:^|,)\s*gzip\b/i.test(acceptEncoding ?? '');
}

export function isCompressible(contentType: string | null): boolean {
  return COMPRESSIBLE.test(contentType ?? '');
}

/** 全程用 ArrayBuffer 过边界：Blob/Response 的 BodyInit 只认它，拿 Uint8Array 传是类型不过的 */
async function gzip(source: ArrayBuffer): Promise<ArrayBuffer> {
  const stream = new Blob([source]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

function rebuilt(response: Response, body: ArrayBuffer, headers: Headers): Response {
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * 能压就压；压不了原样返回同一个 Response，不动 Astro 已经算好的头。
 * 压缩要整体缓冲，所以只用于 KB 级的页面与接口响应。
 */
export async function compressResponse(response: Response, acceptEncoding: string | null): Promise<Response> {
  if (!response.body || response.headers.has('content-encoding')) return response;
  if (!isCompressible(response.headers.get('content-type')) || !wantsGzip(acceptEncoding)) return response;

  const raw = await response.arrayBuffer();
  const headers = new Headers(response.headers);
  // 无论最后压没压，变体协商都要声明出去：缓存不看 Vary 就会把压缩体发给没提 gzip 的客户端
  headers.append('vary', 'Accept-Encoding');
  if (raw.byteLength < MIN_BYTES) return rebuilt(response, raw, headers);

  const packed = await gzip(raw);
  // 压不动（正文已经高熵）就别硬上，解压开销反过来拖累首字节
  if (packed.byteLength >= raw.byteLength) return rebuilt(response, raw, headers);

  headers.set('content-encoding', 'gzip');
  headers.set('content-length', String(packed.byteLength));
  return rebuilt(response, packed, headers);
}
