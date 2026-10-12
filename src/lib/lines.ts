// 线路选择的前端共享层：一份选中状态 + 一组 DOM 约定，四个页面都靠它同步。
// 外壳 DOM 由 src/components/LinePicker.astro 产出（SelectMenu.astro + 线路特有的两行式选项）：
//   [data-menu="line"] 容器（改写示例时跳过，否则菜单里的域名标签会被自己换掉）
//   [data-menu-text] 触发器上的当前线路名
//   [data-line-option][data-host][data-name] 菜单项，[data-line-latency=host] 延迟徽标
// 浮层的开关、互斥、点外面收起都在 src/lib/menu.ts，这里只接选项点击。
// 页面只需要 import { initLines }，其余（示例链接改写、跨标签页同步、测速徽标）都在这里。
import {
  ACCESS_DOMAINS,
  LATENCY_PROBE_PATH,
  LATENCY_STORAGE_KEY,
  LATENCY_TTL_MS,
  LINE_STORAGE_KEY,
  UNREACHABLE,
  hostOf,
  knownOrigins,
  lineOrigin,
  pickFastestLine,
  swapOrigin,
} from './domains';
// 只要 import 就跑起来的接线：页面上任何 SelectMenu 浮层的开合都归它管
import './menu';

export const LINE_CHANGE_EVENT = 'proxylinechange';
// 一轮测速跑完（徽标已填好）时发一次，给需要显示"数据更新于"的页面用
export const LATENCY_EVENT = 'proxylinelatency';

type LineInfo = { host: string; origin: string; name: string };
type Probe = { ms: number; at: number };

const CURRENT_ORIGIN = window.location.origin;
const CURRENT_HOST = hostOf(CURRENT_ORIGIN);
// 页面上可能出现的全部前缀：SSR 按请求 origin 渲染，示例里只会是它或某条线路的 https 前缀
const ORIGINS = knownOrigins(CURRENT_ORIGIN);
// 候选线路 = 清单 + 当前来源。当前来源不在清单里（本机开发、构建预览）时它也算一条，
// 否则这些来源上转换器就没有可用的线路，测速也会把它们排除在外
const CANDIDATES = Array.from(new Set([CURRENT_HOST, ...ACCESS_DOMAINS.map((d) => d.host)]));

let selectedHost = CURRENT_HOST;
let initialized = false;

function optionName(host: string): string {
  const d = ACCESS_DOMAINS.find((x) => x.host === host);
  if (d) return d.name;
  return host === CURRENT_HOST ? '当前站点' : host;
}

/** 当前选中线路的链接前缀：拼接结果、生成命令都从这里取 */
export function lineBase(): string {
  return lineOrigin(selectedHost, CURRENT_ORIGIN);
}

export function currentLine(): LineInfo {
  return { host: selectedHost, origin: lineBase(), name: optionName(selectedHost) };
}

/** 换线路时 DOM 已经改写完毕，订阅者只要重算自己的东西 */
export function onLineChange(fn: (info: LineInfo) => void): void {
  window.addEventListener(LINE_CHANGE_EVENT, (event) => fn((event as CustomEvent<LineInfo>).detail));
}

/** 只替换 URL 前缀，不改结构：文档页的示例是 SSR 出来的纯文本，改写文本节点就能让
 *  可见示例和复制按钮读到的 textContent 一起跟着线路走 */
function rewriteExamples(): void {
  const root = document.querySelector('main') ?? document.body;
  const target = lineBase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Text) {
      const el = node.parentElement;
      if (!el || !(node.nodeValue ?? '').includes('://')) return NodeFilter.FILTER_REJECT;
      // 选择器自身的域名标签、以及样式与脚本源码都不能动
      if (el.closest('[data-menu], script, style')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    const text = node.nodeValue ?? '';
    const next = swapOrigin(text, ORIGINS, target);
    if (next !== text) node.nodeValue = next;
  }
}

function applySelection(): void {
  document.querySelectorAll<HTMLElement>('[data-menu="line"] [data-menu-text]').forEach((el) => {
    el.textContent = optionName(selectedHost);
  });
  document.querySelectorAll<HTMLElement>('[data-line-option]').forEach((el) => {
    el.classList.toggle('menu-active', el.dataset.host === selectedHost);
  });
  rewriteExamples();
  window.dispatchEvent(new CustomEvent<LineInfo>(LINE_CHANGE_EVENT, { detail: currentLine() }));
}

function select(host: string): void {
  if (!CANDIDATES.includes(host)) return;
  selectedHost = host;
  // 手动选过就固定下来：之后各路由都沿用这条，不再自动改选
  localStorage.setItem(LINE_STORAGE_KEY, host);
  applySelection();
}

function wireOptions(): void {
  document.querySelectorAll<HTMLElement>('[data-line-option]').forEach((option) => {
    option.addEventListener('click', () => {
      select(option.dataset.host ?? CURRENT_HOST);
    });
  });
}

function readProbes(): Record<string, Probe> {
  try {
    return JSON.parse(localStorage.getItem(LATENCY_STORAGE_KEY) ?? '{}') as Record<string, Probe>;
  } catch {
    return {};
  }
}

function writeProbes(probes: Record<string, Probe>): void {
  try {
    localStorage.setItem(LATENCY_STORAGE_KEY, JSON.stringify(probes));
  } catch {
    // 隐私模式写不进去，只是少了缓存，不影响功能
  }
}

// no-cors 拿的是不透明响应，但 fetch 的 resolve/reject 已经足够区分「通/不通」，
// 而 performance.now() 包住的是完整的 DNS + TLS + 边缘调度，正是用户体感的差别
async function probe(host: string): Promise<number> {
  const start = performance.now();
  try {
    await fetch(lineOrigin(host, CURRENT_ORIGIN) + LATENCY_PROBE_PATH, {
      mode: 'no-cors',
      cache: 'no-store',
    });
  } catch {
    return UNREACHABLE;
  }
  return Math.max(1, Math.round(performance.now() - start));
}

function renderLatency(host: string, probeMs: number | undefined): void {
  document.querySelectorAll<HTMLElement>(`[data-line-latency="${CSS.escape(host)}"]`).forEach((el) => {
    if (probeMs === undefined) {
      el.textContent = '…';
      el.title = '正在测速';
    } else if (probeMs === UNREACHABLE) {
      el.textContent = '不可达';
      el.title = '这条线路当前访问不通，不会被自动选中';
      el.classList.add('text-error');
    } else {
      el.textContent = `${probeMs} ms`;
      el.title = '浏览器实测的探测延迟';
      el.classList.remove('text-error');
    }
  });
}

/** 一轮测速里最快的那条：只给它上色，不改选中的线路。
 *  之前是自动改选，实测后果是每次路由切换都要重跑一遍决定（SSR 渲染的是「当前站点」，
 *  ~150ms 后触发器和整页示例的域名一起被换掉），而决定来自每条线路一次 no-cors 采样，
 *  同分钟内不同线路的读数能差一个量级，于是"这页跳线路二、下页跳线路一"。
 *  读者点进来的域名就是他正在读的站点，示例不该在他脚下自己换。 */
function markFastest(measured: Record<string, number | undefined>): void {
  const fastest = pickFastestLine(CANDIDATES, measured);
  document.querySelectorAll<HTMLElement>('[data-line-latency]').forEach((el) => {
    const hit = el.dataset.lineLatency === fastest;
    el.classList.toggle('text-primary', hit);
    el.classList.toggle('font-medium', hit);
    el.classList.toggle('text-on-surface-variant', !hit);
  });
}

/** 测一遍各线路：命中 TTL 缓存就复用，只有过期的才真打请求 */
async function measureLatency(): Promise<Record<string, number>> {
  const probes = readProbes();
  const now = Date.now();
  const result: Record<string, number> = {};
  for (const host of CANDIDATES) {
    const cached = probes[host];
    if (cached && now - cached.at < LATENCY_TTL_MS) result[host] = cached.ms;
  }
  Object.entries(result).forEach(([host, ms]) => renderLatency(host, ms));

  const pending = CANDIDATES.filter((host) => result[host] === undefined);
  await Promise.all(
    pending.map(async (host) => {
      const ms = await probe(host);
      result[host] = ms;
      probes[host] = { ms, at: Date.now() };
      renderLatency(host, ms);
    })
  );
  writeProbes(probes);
  markFastest(result);
  window.dispatchEvent(new Event(LATENCY_EVENT));
  return result;
}

/** 页面上这些延迟徽标对应的探测时间，取最新的一条，与状态页「数据更新于」的口径一致 */
export function latencyUpdatedAt(): number | undefined {
  const probes = readProbes();
  const times = Array.from(document.querySelectorAll<HTMLElement>('[data-line-latency]'))
    .map((el) => probes[el.dataset.lineLatency ?? '']?.at)
    .filter((at): at is number => typeof at === 'number');
  return times.length ? Math.max(...times) : undefined;
}

let measuring: Promise<Record<string, number>> | null = null;

/** 同一时刻只跑一轮测速：首屏那轮还没完就又点手动刷新，不该重复打探测 */
function measureOnce(): Promise<Record<string, number>> {
  measuring ??= measureLatency().finally(() => {
    measuring = null;
  });
  return measuring;
}

/**
 * 绕开 TTL 缓存把每条线路重测一遍，只更新延迟徽标，不改选中的线路。
 * 状态页的线路卡片用它做手动刷新——页面开着时没人自动重测，
 * 而探测是按访客各自打的，定时刷会给平台白添 CPU。
 */
export function refreshLatency(): Promise<void> {
  const probes = readProbes();
  for (const host of CANDIDATES) delete probes[host];
  writeProbes(probes);
  for (const host of CANDIDATES) renderLatency(host, undefined);
  return measureOnce().then(() => undefined);
}

/** 接线：沿用上次手动选择的线路（没有就留在当前来源），然后把延迟徽标测出来 */
export function initLines(): void {
  if (initialized) return;
  initialized = true;

  const stored =
    localStorage.getItem(LINE_STORAGE_KEY) ??
    // 这层之前只有首页转换器在用，键名不同；带过来，老用户不用重选一次
    localStorage.getItem('lastDomain');
  const restored = stored && CANDIDATES.includes(stored) ? stored : undefined;
  if (stored && !restored) localStorage.removeItem(LINE_STORAGE_KEY);

  selectedHost = restored ?? CURRENT_HOST;
  wireOptions();
  applySelection();
  // 测速只填延迟徽标、把最快的一条标出来，永远不动选中的线路
  void measureOnce();
}

// 另一个标签页改了线路，这边跟着改
window.addEventListener('storage', (event) => {
  if (event.key !== LINE_STORAGE_KEY) return;
  const host = event.newValue;
  if (host && CANDIDATES.includes(host) && host !== selectedHost) {
    selectedHost = host;
    applySelection();
  }
});
