// 运行时压缩只该动本站自己产出的文本响应：代理透传的字节流一旦被重压，
// 既白花 CPU 又会让 countOutboundBytes 记的出口字节数对不上真实响应，
// 所以「什么该压、压完头对不对」必须由测试钉住。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compressResponse, isCompressible, wantsGzip } from '../src/lib/compress.ts';

async function gunzip(source: ArrayBuffer): Promise<string> {
  const stream = new Blob([source]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

const html = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { headers: { 'content-type': 'text/html; charset=UTF-8', ...headers } });

describe('accept-encoding 与 content-type 判定', () => {
  it('只认列了 gzip 的请求，x-gzip 不算', () => {
    assert.equal(wantsGzip('gzip, deflate, br'), true);
    assert.equal(wantsGzip('br, zstd'), false);
    assert.equal(wantsGzip(null), false);
    assert.equal(wantsGzip('x-gzip'), false);
  });

  it('只压页面 HTML 与接口 JSON', () => {
    assert.equal(isCompressible('text/html; charset=UTF-8'), true);
    assert.equal(isCompressible('application/json'), true);
    assert.equal(isCompressible('application/octet-stream'), false);
    assert.equal(isCompressible('image/svg+xml'), false);
    assert.equal(isCompressible(null), false);
  });
});

describe('compressResponse', () => {
  it('够大的 HTML 压完能原样解回来，头里带上编码、长度与 Vary', async () => {
    const body = `<html><body>${'加速'.repeat(600)}</body></html>`;
    const out = await compressResponse(html(body), 'gzip, deflate, br');

    assert.equal(out.headers.get('content-encoding'), 'gzip');
    assert.equal(out.headers.get('content-type'), 'text/html; charset=UTF-8');
    assert.match(out.headers.get('vary') ?? '', /Accept-Encoding/i);
    const packed = await out.arrayBuffer();
    assert.equal(out.headers.get('content-length'), String(packed.byteLength));
    assert.ok(packed.byteLength < body.length, '压缩后应当真的变小');
    assert.equal(await gunzip(packed), body);
  });

  it('KB 以下的小响应不缓冲压缩，但字节一个不少', async () => {
    const source = html('{"ok":true}');
    const out = await compressResponse(source, 'gzip');

    assert.equal(out.headers.get('content-encoding'), null);
    assert.equal(await out.text(), '{"ok":true}');
  });

  it('客户端没提 gzip 就原样返回同一个 Response', async () => {
    const source = html('x'.repeat(5000));
    const out = await compressResponse(source, 'identity');

    assert.equal(out, source);
  });

  it('已经带 content-encoding 的响应绝不二次压缩', async () => {
    const source = html('gzipped', { 'content-encoding': 'gzip' });
    assert.equal(await compressResponse(source, 'gzip'), source);
  });

  it('空 body 的跳转响应保持原样', async () => {
    const source = new Response(null, { status: 302, headers: { location: '/github' } });
    assert.equal(await compressResponse(source, 'gzip'), source);
  });

  it('状态码与状态行跟着一起搬过去', async () => {
    const out = await compressResponse(new Response('y'.repeat(4000), { status: 404, statusText: 'Not Found', headers: { 'content-type': 'application/json' } }), 'gzip');

    assert.equal(out.status, 404);
    assert.equal(out.statusText, 'Not Found');
    assert.equal(out.headers.get('content-encoding'), 'gzip');
  });
});
