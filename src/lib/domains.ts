// 本站的加速线路清单：状态页展示它，首页转换器与三个文档页按它拼接/改写链接。
// 数据来自 Deno Deploy 官方接口 GET /v2/domains（组织级），这里存的是当时的核对结果：
// 线路一跟应用名走，改应用名它就失效；线路二是自己绑的域名，要 DNS 校验通过才可用。
// 对外只说"线路几"，域名归属与区域性注意点留在注释里——使用者挑的是线路，不必先理解这些
export type AccessDomain = {
  /** 面向使用者的线路名，按清单顺序编号 */
  name: string;
  host: string;
};

export const ACCESS_DOMAINS: AccessDomain[] = [
  { name: '线路一', host: 'proxy.hotier.deno.net' },
  { name: '线路二', host: 'proxy.hotier.cc.cd' },
];

/** 选中的线路（裸主机名）。所有页面共用一份，换线路后示例链接跟着改写 */
export const LINE_STORAGE_KEY = 'proxyLine';
/** 浏览器实测的各线路延迟，按 TTL 复用，避免每次进页面都打一轮探针 */
export const LATENCY_STORAGE_KEY = 'proxyLineLatency';
export const LATENCY_TTL_MS = 10 * 60 * 1000;
// 探针走 /api/health：响应几百字节、不计入页面访问统计，且和真实请求一样要过一整套
// DNS + TLS + 边缘调度，测出来的就是"这条线路对你有多快"
export const LATENCY_PROBE_PATH = '/api/health';

export function hostOf(origin: string): string {
  return origin.replace(/^https?:\/\//, '').split(':')[0];
}

/** 线路选项 = 清单 + 当前来源。本机开发和每次构建的预览域名不在清单里，补一项，
 *  否则转换器在这些来源上就没法用 */
export function lineOptions(currentOrigin: string): Array<{ name: string; host: string; current: boolean }> {
  const currentHost = hostOf(currentOrigin);
  const options = ACCESS_DOMAINS.map((d) => ({ name: d.name, host: d.host, current: d.host === currentHost }));
  if (!options.some((o) => o.current)) options.unshift({ name: '当前站点', host: currentHost, current: true });
  return options;
}

/** 线路的链接前缀：选中当前站点时沿用它自己的 origin（http + 端口在本机开发时是对的），其余一律 https */
export function lineOrigin(host: string, currentOrigin: string): string {
  return hostOf(currentOrigin) === host ? currentOrigin : `https://${host}`;
}

/** 页面上可能写死的全部前缀：SSR 按请求 origin 渲染，示例里出现的只会是它或某条线路的 https 前缀 */
export function knownOrigins(currentOrigin: string): string[] {
  return Array.from(new Set([currentOrigin, ...ACCESS_DOMAINS.map((d) => `https://${d.host}`)]));
}

/** 把文本里出现的任一其它线路前缀换成 target。长串优先，否则短前缀会先吃掉长前缀的一部分 */
export function swapOrigin(text: string, from: string[], target: string): string {
  const others = from.filter((o) => o && o !== target);
  if (!others.length) return text;
  const pattern = others
    .sort((a, b) => b.length - a.length)
    .map((o) => o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  return text.replace(new RegExp(pattern, 'g'), target);
}

/** 测速探针失败（DNS 不通、TLS 被阻断、连接被重置）的记号，与真实延迟区分开 */
export const UNREACHABLE = -1;

/** 首次进入时的兜底选路：可达线路里延迟最小的一条。没测到或全不可达就不选（返回 undefined），
 *  宁可留在当前来源，也不要把用户丢到一条打不通的线路上 */
export function pickFastestLine(
  hosts: string[],
  measured: Record<string, number | undefined>
): string | undefined {
  let best: string | undefined;
  for (const host of hosts) {
    const ms = measured[host];
    if (ms === undefined || ms === UNREACHABLE) continue;
    if (best === undefined || ms < measured[best]!) best = host;
  }
  return best;
}
