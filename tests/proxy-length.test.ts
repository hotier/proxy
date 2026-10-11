// 响应长度保真：下载工具靠 Content-Length 显示进度、开多线程、断点续传，
// HEAD 探大小更是只看这一个头。上游的字节数只在 identity 响应上等于我们转发的字节数

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { proxyRequest } from '../src/lib/proxy.ts';
import { CONFIG } from '../src/lib/config.ts';

const g = globalThis as any;

const ASSET = 'https://release-assets.githubusercontent.com/x/app.tar.gz';

function stubUpstream(init: {
  status?: number;
  headers?: Record<string, string>;
  body?: BodyInit | null;
}) {
  const original = g.fetch;
  g.fetch = async () =>
    new Response(init.body ?? 'ok', { status: init.status ?? 200, headers: init.headers });
  return () => {
    g.fetch = original;
  };
}

function request(path: string, method = 'GET') {
  return new Request('http://proxy.test' + path, { method });
}

const ASSET_PATH = '/api/release-assets/x/app.tar.gz';

describe('代理响应的长度保真', () => {
  let restore: (() => void) | undefined;
  const saved = { password: CONFIG.PROXY_PASSWORD, token: CONFIG.GITHUB_TOKEN };

  afterEach(() => {
    restore?.();
    CONFIG.PROXY_PASSWORD = saved.password;
    CONFIG.GITHUB_TOKEN = saved.token;
    restore = undefined;
  });

  it('identity 透传带上上游的 Content-Length（release 包大小由此而来）', async () => {
    const bytes = new Uint8Array(4096);
    restore = stubUpstream({
      headers: { 'content-length': '4096', 'content-type': 'application/octet-stream' },
      body: bytes,
    });
    const resp = await proxyRequest(request(ASSET_PATH), ASSET, '/x/app.tar.gz', '');
    assert.equal(resp.headers.get('content-length'), '4096');
  });

  it('HEAD 探大小拿到真实体积，而不是空体的 0', async () => {
    restore = stubUpstream({
      headers: { 'content-length': '13065800', 'content-type': 'application/octet-stream' },
      body: null,
    });
    const resp = await proxyRequest(request(ASSET_PATH, 'HEAD'), ASSET, '/x/app.tar.gz', '');
    assert.equal(resp.headers.get('content-length'), '13065800');
  });

  it('fetch 解压过的响应不带 Content-Length：那个数已不等于转发的字节', async () => {
    restore = stubUpstream({
      headers: { 'content-length': '120', 'content-encoding': 'gzip', 'content-type': 'text/plain' },
      body: 'uncompressed by fetch, far longer than 120 bytes',
    });
    const resp = await proxyRequest(request('/api/ghraw/o/r/main/f'), 'https://raw.githubusercontent.com', '/o/r/main/f', '');
    assert.equal(resp.headers.get('content-encoding'), null);
    assert.equal(resp.headers.get('content-length'), null);
  });

  it('分片响应带分片自己的长度，同时保住 Content-Range', async () => {
    restore = stubUpstream({
      status: 206,
      headers: {
        'content-length': '1',
        'content-range': 'bytes 0-0/13065800',
        'content-type': 'application/octet-stream',
      },
      body: new Uint8Array(1),
    });
    const resp = await proxyRequest(request(ASSET_PATH), ASSET, '/x/app.tar.gz', '');
    assert.equal(resp.status, 206);
    assert.equal(resp.headers.get('content-length'), '1');
    assert.equal(resp.headers.get('content-range'), 'bytes 0-0/13065800');
  });

  it('正文改写后不能带上游的 Content-Length：改写会改变字节数', async () => {
    const json = '{"url":"https://registry.npmjs.org/acme/-/acme-1.0.0.tgz"}';
    restore = stubUpstream({
      headers: {
        'content-length': String(json.length),
        'content-type': 'application/json',
      },
      body: json,
    });
    const resp = await proxyRequest(request('/api/npm/acme'), 'https://registry.npmjs.org', '/acme', '');
    const body = await resp.text();
    assert.notEqual(body, json, '改写没生效，用例失去意义');
    // 改写后的长度与上游不同，透传上游那个值会让客户端截断或悬挂
    const len = resp.headers.get('content-length');
    assert.ok(len === null || Number(len) === Buffer.byteLength(body), `长度头与实际正文不符: ${len}`);
  });
});
