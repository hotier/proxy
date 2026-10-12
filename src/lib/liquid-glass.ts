/**
 * 液态玻璃的几何折射层。
 *
 * 分工:CSS(global.css 的 .lg)负责材质(染色/模糊/边缘亮线/菲涅尔/镜面高光/色散环),
 * 这里只补 CSS 做不到的那一层——背景光线的几何弯折。
 *
 * 折射靠 `backdrop-filter: url(#滤镜)`,而只有 Blink 内核对 backdrop-filter 应用 SVG 滤镜:
 * WebKit(https://bugs.webkit.org/show_bug.cgi?id=245510)与 Gecko 至今不实现,
 * 且它们会**解析通过但不渲染**,整条声明连同 blur 一起变成空操作。
 * 所以不能用 @supports 探测,必须按内核判定;非 Blink 就完全不写内联值,退回纯 CSS 材质。
 *
 * 另一个坑:折射只在「祖先链上没有 transform」的表面生效。Blink 给带 url() 的 backdrop-filter
 * 取背景快照时,只要某个祖先算得出 transform(哪怕 animation-fill-mode 留下的恒等矩阵),
 * 快照就是空的——元素照旧显示,blur/saturate 照旧生效,只有折射静默失效。
 * 实测:入场动画用 fill-mode both 时卡片折射整块不生效,换成 backwards 后同一像素位置逐格有位移。
 *
 * 滤镜里的法线图用 canvas 现算:rounded-box 距离场给出「离边多近」和「朝哪个方向弯」,
 * 于是折射带是固定像素厚、且贴合元素真实圆角——用拉伸的渐变图做不到这点。
 */

/**
 * 参与折射的表面;挂 .lg 即整块液态玻璃(含几何折射),小元素留在 bg-surface-* 薄磨砂。
 * 下拉浮层要单独列出来:它的材质在 CSS 里按 [data-menu-panel] 给(不挂 .lg,免得类名 token
 * 和组件耦合),折射参数 --lg-refract 也写在那儿——这里不跟上的话那条参数就是死值,菜单只剩磨砂。
 */
const LENS_SELECTOR = '.lg, [data-menu-panel]';

/** 折射带厚度 = 短边占比,夹在两端:导航条要薄薄一圈,大面板也不该整片糊掉 */
const RIM_RATIO = 0.28;
const RIM_MIN = 8;
const RIM_MAX = 40;

/**
 * 法线图分辨率:先保证短边有这么多采样,再按面积封顶。
 * 只按长边限分辨率会把导航条这类细长元素算成 1256x8 —— 27px 的折射带只剩三行,
 * feImage 放大时的线性插值会把弯折糊满整条,中心区也跟着位移(实测中心差值 2.1/255)。
 */
const MAP_MIN_SHORT = 48;
const MAP_MAX_AREA = 40000;

/** 滤镜外扩比例:折射要从元素外面取像素,不然边缘会啃出一圈空白 */
const FILTER_INSET = -14;

const isBlink = (): boolean => {
  const uaData = (navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] } }).userAgentData;
  if (uaData?.brands?.length) {
    return uaData.brands.some((b) => /^(Chromium|Google Chrome|Microsoft Edge|Not.?A.?Browser)$/.test(b.brand));
  }
  const ua = navigator.userAgent;
  // iOS 上所有浏览器都是 WebKit,CriOS/EdgiOS/FxiOS 名字里带 Chrome 但没有 Blink
  return /Chrome|Chromium|Edg\//.test(ua) && !/(CriOS|FxiOS|EdgiOS|OPiOS|Firefox)/.test(ua);
};

/** 圆角矩形距离场 → 切线空间法线图,编码成 feDisplacementMap 能用的 RGB */
function buildNormalMap(w: number, h: number, radius: number): string {
  // 短边采样到位,长边按同比例缩放;面积超限就整体再收一档
  let k = Math.min(1, MAP_MIN_SHORT / Math.min(w, h));
  let mw = Math.max(2, Math.round(w * k));
  let mh = Math.max(2, Math.round(h * k));
  const area = mw * mh;
  if (area > MAP_MAX_AREA) {
    k = Math.sqrt(MAP_MAX_AREA / area);
    mw = Math.max(2, Math.round(mw * k));
    mh = Math.max(2, Math.round(mh * k));
  }

  const canvas = document.createElement('canvas');
  canvas.width = mw;
  canvas.height = mh;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return '';

  const img = ctx.createImageData(mw, mh);
  const data = img.data;

  const hw = mw / 2;
  const hh = mh / 2;
  // 半径按同一比例换算,保证形状和元素真实圆角一致
  const r = Math.min(radius, hw, hh) * (mw / w);
  const bx = hw - r;
  const by = hh - r;
  const rim = Math.max(1, Math.min(RIM_MAX, Math.max(RIM_MIN, Math.min(w, h) * RIM_RATIO)) * (mw / w));

  for (let y = 0; y < mh; y++) {
    // 像素中心,以及相对核心矩形的位置
    const py = y + 0.5 - hh;
    const qy = Math.abs(py) - by;
    for (let x = 0; x < mw; x++) {
      const px = x + 0.5 - hw;
      const qx = Math.abs(px) - bx;
      const ax = Math.max(qx, 0);
      const ay = Math.max(qy, 0);
      // rounded-box SDF:负值在内部,到边的距离 d = -sd
      const sd = Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
      const d = -sd;

      // 外法线方向:平边取主轴,圆角段取角点方向
      let gx: number, gy: number;
      if (qx > qy) {
        gx = px < 0 ? -1 : 1;
        gy = 0;
      } else {
        gx = 0;
        gy = py < 0 ? -1 : 1;
      }
      if (ax > 0 && ay > 0) {
        const len = Math.hypot(ax * gx, ay * gy) || 1;
        gx = (ax * gx) / len;
        gy = (ay * gy) / len;
      }

      const u = d < 0 ? 0 : d >= rim ? 1 : d / rim;
      // 三次曲线:边缘最强、向内平滑归零,中心区几乎不弯 —— 观感上就是整体轻微放大
      const bend = Math.pow(1 - u, 3);

      const i = (y * mw + x) * 4;
      // R>0.5 让采样点右移,画面左移 ⇒ 边缘内容向外扩张(透镜放大)
      data[i] = 128 - 127 * gx * bend;
      data[i + 1] = 128 - 127 * gy * bend;
      data[i + 2] = 128;
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}

interface LensSpec {
  /** 折射强度(CSS px) */
  scale: number;
  /** 色散:R/B 通道相对 G 的位移差(CSS px) */
  aberration: number;
  blur: number;
  saturate: number;
  brightness: number;
}

/** 同一尺寸+圆角的表面共用一个滤镜,避免 110 个 DOM 节点挂 110 份法线图 */
class LensRegistry {
  private host: SVGDefsElement;
  private entries = new Map<string, { id: string; uses: number }>();

  constructor() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-hidden', 'true');
    // 注意不能 display:none,那样滤镜不渲染
    svg.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;overflow:hidden';
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    svg.append(defs);
    document.body.append(svg);
    this.host = defs as SVGDefsElement;
  }

  acquire(key: string, href: string, spec: LensSpec): string {
    let entry = this.entries.get(key);
    if (entry) {
      entry.uses++;
      return entry.id;
    }
    const id = `lg-${this.entries.size}`;
    const ns = 'http://www.w3.org/2000/svg';
    const mk = (tag: string, attrs: Record<string, string | number>) => {
      const n = document.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
      return n;
    };

    const filter = mk('filter', {
      id,
      x: `${FILTER_INSET}%`,
      y: `${FILTER_INSET}%`,
      width: `${100 - 2 * FILTER_INSET}%`,
      height: `${100 - 2 * FILTER_INSET}%`,
      // 默认 linearRGB 会把通道值当线性光,法线图的 0.5 就不中性了,必须锁 sRGB
      'color-interpolation-filters': 'sRGB',
      // scale 用 CSS 像素:大小元素弯折厚度一致,不会随尺寸线性放大
      primitiveUnits: 'userSpaceOnUse',
    });
    filter.append(
      mk('feImage', {
        x: 0,
        y: 0,
        width: '100%',
        height: '100%',
        preserveAspectRatio: 'none',
        result: 'map',
        href,
      }),
    );

    const { scale, aberration } = spec;
    const channels = aberration > 0 ? [scale - aberration, scale, scale + aberration] : [scale];
    const outs = channels.map((s, i) => {
      const result = `d${i}`;
      filter.append(
        mk('feDisplacementMap', {
          in: 'SourceGraphic',
          in2: 'map',
          scale: Math.max(0, s),
          xChannelSelector: 'R',
          yChannelSelector: 'G',
          result,
        }),
      );
      return result;
    });

    if (outs.length > 1) {
      // 三档位移各取一个通道再 screen 合成 = 棱镜分色
      const mats = [
        '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0',
        '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0',
        '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0',
      ];
      const split = outs.map((src, i) => {
        const result = `c${i}`;
        filter.append(mk('feColorMatrix', { in: src, result, type: 'matrix', values: mats[i] }));
        return result;
      });
      filter.append(mk('feBlend', { in: split[0], in2: split[1], mode: 'screen', result: 'c01' }));
      filter.append(mk('feBlend', { in: 'c01', in2: split[2], mode: 'screen' }));
    }

    this.host.append(filter);
    entry = { id, uses: 1 };
    this.entries.set(key, entry);
    return id;
  }

  release(key: string) {
    const entry = this.entries.get(key);
    if (!entry || --entry.uses > 0) return;
    document.getElementById(entry.id)?.remove();
    this.entries.delete(key);
  }

  backdropCss(id: string, spec: LensSpec): string {
    const f = ['blur(' + spec.blur + 'px)', 'saturate(' + spec.saturate + '%)', 'brightness(' + spec.brightness + '%)'];
    return `${f.join(' ')} url(#${id})`;
  }
}

/** 数值型自定义属性:材质参数只在 CSS 里写一份,JS 读出来组装滤镜 */
function num(el: Element, name: string, fallback: number): number {
  const raw = getComputedStyle(el).getPropertyValue(name).trim();
  const v = Number.parseFloat(raw);
  return Number.isFinite(v) ? v : fallback;
}

function cornerRadius(el: Element): number {
  const cs = getComputedStyle(el);
  const corners = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius];
  let sum = 0;
  for (const c of corners) {
    const px = Number.parseFloat(c);
    // 50% 之类的胶囊圆角:交给 min(w,h)/2 兜底,这里按大值累加
    sum += Number.isFinite(px) ? px : 9999;
  }
  return sum / corners.length;
}

export function initLiquidGlass(): void {
  if (!isBlink()) return;

  const registry = new LensRegistry();
  const active = new WeakMap<HTMLElement, string>();

  const apply = (el: HTMLElement) => {
    const { width, height } = el.getBoundingClientRect();
    if (width < 2 || height < 2) return;

    const spec: LensSpec = {
      scale: num(el, '--lg-refract', 24),
      aberration: num(el, '--lg-aberration', 4),
      blur: num(el, '--lg-blur', 6),
      saturate: num(el, '--lg-saturate', 185),
      brightness: num(el, '--lg-brightness', 105),
    };
    if (spec.scale <= 0) return;

    const radius = Math.min(cornerRadius(el), Math.min(width, height) / 2);
    const key = `${Math.round(width)}x${Math.round(height)}r${Math.round(radius)}s${spec.scale}a${spec.aberration}`;
    const href = buildNormalMap(width, height, radius);
    if (!href) return;

    const prev = active.get(el);
    if (prev === key) return;
    if (prev) registry.release(prev);

    const id = registry.acquire(key, href, spec);
    active.set(el, key);
    const css = registry.backdropCss(id, spec);
    el.style.setProperty('-webkit-backdrop-filter', css);
    el.style.setProperty('backdrop-filter', css);
  };

  const clear = (el: HTMLElement) => {
    const key = active.get(el);
    if (!key) return;
    registry.release(key);
    active.delete(el);
    el.style.removeProperty('backdrop-filter');
    el.style.removeProperty('-webkit-backdrop-filter');
  };

  const targets = () => Array.from(document.querySelectorAll<HTMLElement>(LENS_SELECTOR));

  // 尺寸变化(含容器重排)要重算法线图;ResizeObserver 只在元素真的变了尺寸时回调
  const ro = new ResizeObserver((rows) => {
    for (const row of rows) {
      const el = row.target as HTMLElement;
      if (row.contentRect.width < 2 || row.contentRect.height < 2) clear(el);
      else apply(el);
    }
  });

  for (const el of targets()) {
    apply(el);
    ro.observe(el);
  }

  // 单例监听:指针只写「当前这块玻璃」的高光位置,整页光源角写根节点
  let pending: PointerEvent | null = null;
  let lit: HTMLElement | null = null;
  document.addEventListener(
    'pointermove',
    (e) => {
      pending = e;
      if (e.pointerType === 'touch') return;
      requestAnimationFrame(() => {
        if (!pending) return;
        const ev = pending;
        pending = null;
        const root = document.documentElement;
        root.style.setProperty('--lg-tilt', `${(((ev.clientX / window.innerWidth) - 0.5) * 70).toFixed(2)}deg`);
        const el = ev.target instanceof Element ? (ev.target.closest(LENS_SELECTOR) as HTMLElement | null) : null;
        if (el !== lit) {
          lit?.style.removeProperty('--lg-light-x');
          lit?.style.removeProperty('--lg-light-y');
          lit = el;
        }
        if (!lit) return;
        const r = lit.getBoundingClientRect();
        if (!r.width || !r.height) return;
        lit.style.setProperty('--lg-light-x', (((ev.clientX - r.left) / r.width) * 100).toFixed(2) + '%');
        lit.style.setProperty('--lg-light-y', (((ev.clientY - r.top) / r.height) * 100).toFixed(2) + '%');
      });
    },
    { passive: true },
  );

  // 滚动速度 → 玻璃「起雾发亮」,停手后指数衰减
  let lastY = window.scrollY;
  let vel = 0;
  let raf = 0;
  const decay = () => {
    vel *= 0.86;
    document.documentElement.style.setProperty('--lg-flow', vel.toFixed(3));
    if (vel > 0.002) raf = requestAnimationFrame(decay);
    else {
      raf = 0;
      document.documentElement.style.setProperty('--lg-flow', '0');
    }
  };
  addEventListener(
    'scroll',
    () => {
      vel = Math.min(1, vel + Math.abs(window.scrollY - lastY) / 140);
      lastY = window.scrollY;
      if (!raf) raf = requestAnimationFrame(decay);
    },
    { passive: true },
  );
}
