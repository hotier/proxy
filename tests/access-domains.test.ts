// 访问线路清单同时喂状态页展示和首页转换器拼链接：清单里的形状写错（带协议、带路径）
// 会直接产出坏掉的加速链接，所以这里钉住它只能是裸主机名

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCESS_DOMAINS,
  UNREACHABLE,
  knownOrigins,
  lineOptions,
  lineOrigin,
  pickFastestLine,
  swapOrigin,
} from '../src/lib/domains.ts';

describe('加速线路清单', () => {
  it('每项都有对外线路名，host 是裸主机名', () => {
    assert.ok(ACCESS_DOMAINS.length > 0);
    for (const d of ACCESS_DOMAINS) {
      assert.ok(d.name);
      assert.match(d.host, /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i);
    }
  });

  it('线路名与主机名都不重复', () => {
    assert.equal(new Set(ACCESS_DOMAINS.map((d) => d.host)).size, ACCESS_DOMAINS.length);
    assert.equal(new Set(ACCESS_DOMAINS.map((d) => d.name)).size, ACCESS_DOMAINS.length);
  });
});

describe('加速链接前缀', () => {
  it('选中当前站点时沿用它自己的 origin，本机开发的 http + 端口不丢', () => {
    assert.equal(lineOrigin('localhost', 'http://localhost:4321'), 'http://localhost:4321');
  });

  it('其余线路一律 https，不带上当前来源的端口', () => {
    assert.equal(
      lineOrigin('proxy.hotier.deno.net', 'http://localhost:4321'),
      'https://proxy.hotier.deno.net'
    );
  });
});

describe('线路选项', () => {
  it('清单里就有当前来源时不额外补项', () => {
    const origin = `https://${ACCESS_DOMAINS[0].host}`;
    assert.deepEqual(
      lineOptions(origin).map((o) => o.host),
      ACCESS_DOMAINS.map((d) => d.host)
    );
    assert.equal(lineOptions(origin).filter((o) => o.current).length, 1);
  });

  it('当前来源不在清单里（本机开发、构建预览）时补一项「当前站点」', () => {
    const options = lineOptions('http://localhost:4321');
    assert.equal(options[0].name, '当前站点');
    assert.equal(options[0].host, 'localhost');
    assert.ok(options[0].current);
    assert.equal(options.length, ACCESS_DOMAINS.length + 1);
  });
});

describe('示例链接改写', () => {
  it('把页面里出现的任一线路前缀换成选中项', () => {
    const from = knownOrigins('http://localhost:4321');
    const text = `curl https://${ACCESS_DOMAINS[0].host}/api/gh/a/b && docker pull http://localhost:4321/library/nginx`;
    const swapped = swapOrigin(text, from, 'https://x.test');
    assert.ok(!swapped.includes(ACCESS_DOMAINS[0].host));
    assert.ok(!swapped.includes('localhost:4321'));
    assert.ok(swapped.includes('https://x.test/api/gh/a/b'));
    assert.ok(swapped.includes('https://x.test/library/nginx'));
  });

  it('目标本身在已知前缀里：别家换成它，它自己不再被替换', () => {
    const target = `https://${ACCESS_DOMAINS[1].host}`;
    const text = `https://${ACCESS_DOMAINS[0].host}/v2/ 与 ${target}/api/npm/`;
    const swapped = swapOrigin(text, knownOrigins(target), target);
    assert.ok(!swapped.includes(ACCESS_DOMAINS[0].host));
    assert.equal(swapped.split(target).length - 1, 2);
  });

  it('没有可替换的前缀时原样返回', () => {
    assert.equal(swapOrigin('git clone x', [], 'https://x.test'), 'git clone x');
  });
});

// 首次进入没有用户选择可恢复时，兜底按实测延迟选路。选错一次就把访客丢到慢线路甚至死线路上，
// 所以这条规则要钉住：取最小值、不可达的排除在外、全不可达时不选
describe('首次进入的兜底选路', () => {
  const hosts = ['a.test', 'b.test', 'c.test'];

  it('选延迟最小的一条', () => {
    assert.equal(pickFastestLine(hosts, { 'a.test': 900, 'b.test': 120, 'c.test': 400 }), 'b.test');
  });

  it('不可达的线路不参与，哪怕它"最快"', () => {
    assert.equal(
      pickFastestLine(hosts, { 'a.test': UNREACHABLE, 'b.test': 800, 'c.test': 90 }),
      'c.test'
    );
  });

  it('还没测出来的项不算数', () => {
    assert.equal(pickFastestLine(hosts, { 'b.test': 300 }), 'b.test');
  });

  it('全不可达或不曾测速时不选，让页面留在当前来源', () => {
    assert.equal(
      pickFastestLine(hosts, { 'a.test': UNREACHABLE, 'b.test': UNREACHABLE, 'c.test': UNREACHABLE }),
      undefined
    );
    assert.equal(pickFastestLine(hosts, {}), undefined);
  });
});
