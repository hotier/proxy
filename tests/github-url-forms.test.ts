// GitHub 链接形状：地址栏复制来的是网页地址(/blob/<ref>/<path>)，raw 端点没有 blob 这一段。
// 转换器要给文件不是网页，代理入口要兜住手工换域名带来的 404，两边必须同一条规则

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  withoutBlobSegment,
  githubFileProxyPath,
  findApiRoute,
  PREFIX_BY_HOST,
} from '../src/lib/services.ts';

describe('blob 段识别', () => {
  it('剥掉 blob 段，ref 与文件路径原样接续', () => {
    assert.equal(
      withoutBlobSegment('/pdone/lx-music-source/blob/main/README.md'),
      '/pdone/lx-music-source/main/README.md'
    );
    // GitHub 页面里 "View raw" 给的是 refs/heads 全写形式，同样只多一个 blob|raw 段
    assert.equal(
      withoutBlobSegment('/pdone/lx-music-source/raw/refs/heads/main/README.md'),
      '/pdone/lx-music-source/refs/heads/main/README.md'
    );
  });

  it('首斜杠可选，因为代理入口剥掉前缀后拿到的是裸路径', () => {
    assert.equal(
      withoutBlobSegment('pdone/lx-music-source/blob/main/README.md'),
      '/pdone/lx-music-source/main/README.md'
    );
  });

  it('只认仓库坐标后的那一段，别的位置不动', () => {
    for (const path of [
      '/api/gh/owner/repo/releases/download/v1/app.zip',
      '/api/gh/owner/repo/archive/refs/heads/main.tar.gz',
      '/owner/repo.git',
      '/owner/repo',
      // blob 段必须在第 3 段：文件路径里含 blob 目录不能误剥
      '/owner/repo/main/blob/x/y',
      '/owner/blob/main/README.md',
    ]) {
      assert.equal(withoutBlobSegment(path), null, path);
    }
  });
});

describe('转换器的输出形状', () => {
  it('github.com 网页地址转成 raw 端点路径，前缀来自注册表', () => {
    assert.equal(
      githubFileProxyPath('/cli/cli/blob/trunk/README.md'),
      PREFIX_BY_HOST['raw.githubusercontent.com'] + '/cli/cli/trunk/README.md'
    );
  });

  it('非文件网页返回 null，交给通用前缀透传', () => {
    assert.equal(githubFileProxyPath('/cli/cli'), null);
    assert.equal(
      githubFileProxyPath('/cli/cli/releases/download/v2.67.0/gh.zip'),
      null
    );
  });
});

describe('代理入口对两种前缀的分工', () => {
  it('ghraw 容忍 blob 段，gh 保持原样', () => {
    assert.equal(findApiRoute('/api/ghraw/o/r/blob/main/x.md')?.stripBlobSegment, true);
    assert.equal(findApiRoute('/api/gh/o/r/blob/main/x.md')?.stripBlobSegment, undefined);
  });

  it('最长前缀优先，ghraw 不会被 gh 抢走', () => {
    assert.equal(findApiRoute('/api/ghraw/o/r/main/x.md')?.prefix, '/api/ghraw/');
  });
});
