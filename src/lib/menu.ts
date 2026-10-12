// 下拉选择器的共享层：一套类名 token + 一套开合逻辑，SelectMenu.astro 和两个选择器都靠它。
// DOM 约定（全部由 SelectMenu.astro 产出）：
//   [data-menu="<name>"] 外层，[data-menu-btn] 触发器，[data-menu-panel] 浮层（带 data-menu-align），
//   [data-menu-text] 当前项文字，[data-menu-option] 选项行；各选择器自己的 data-* 挂在行上，
//   业务逻辑认自己那套 name
// 这里只管"开哪个、关哪个"：同时最多一个浮层是开的，点了选项就收起，点外面或按 Esc 也收起。
// 浮层展开时会被挂到 body 上（place/unplace），宿主 DOM 里收起态才有它——查引用一律走下面的 WeakMap。
// 选中了什么归业务层（首页格式选择器在 UrlConverter.astro 的脚本里，线路在 lines.ts）。
export type SelectSize = 'sm' | 'md' | 'field';

const triggerBase =
  'flex items-center bg-surface-container-low border border-outline-variant text-sm text-on-surface focus:outline-none focus:border-primary hover:border-primary transition-colors';

/**
 * 触发器三种形态：sm/md 是卡片表头和页面标题里的线路选择，field 是首页输入框旁边那种表单控件，
 * 靠 h-full 跟输入框等高。圆角只写在各档里，不写进 base——同一个属性的两个类谁生效取决于
 * 产物 CSS 的先后顺序，不是 class 属性的书写顺序，别留这种冲突。
 */
export const menuTrigger: Record<SelectSize, string> = {
  sm: `${triggerBase} gap-1 rounded-lg px-3 py-1.5`,
  md: `${triggerBase} gap-1 rounded-xl px-4 py-2.5`,
  field: `${triggerBase} gap-2 justify-between rounded-xl px-3 sm:px-4 py-2 h-full min-w-[128px] sm:min-w-[140px] shrink-0`,
};

/**
 * 浮层。上下不留内边距：当前项的底色是方形的，留了边就碰不到容器的圆角，
 * 菜单顶/底会各露出一块没被选中的菜单底色。留白交给选项自己的 py 撑，
 * 这样每一行等高，底色也能贴着边缘被 overflow-hidden 裁成圆角。
 *
 * 展开时这套 absolute 定位只是收起态的占位：真正显示前会被 place() 改成 fixed 并挂到 body，
 * 见文件末尾。对齐方向由 SelectMenu 写进 data-menu-align，不靠嗅 Tailwind 类名。
 */
export const menuPanel =
  'hidden absolute top-full mt-2 max-w-[calc(100vw-2rem)] whitespace-nowrap rounded-2xl border border-outline-variant bg-surface-container-highest shadow-lg overflow-hidden z-50';

/** 选项行的公共部分；单行还是两行、图标还是域名，留给各选择器自己拼 */
export const menuOption =
  'menu-option w-full px-4 py-3 text-sm text-on-surface hover:bg-primary/15 hover:text-primary transition-colors';

/** 触发器底边到浮层顶边的间距，和收起态的 mt-2 同值 */
const GAP = 8;
/** 浮层离视口左右边缘的最小留白：手机上域名行不能贴出屏幕 */
const EDGE = 16;

// 浮层会被挂到 body，开合关系不能依赖 DOM 包含查询，这里把引用正反各存一份
const btnOf = new WeakMap<HTMLElement, HTMLElement>();
const rootOf = new WeakMap<HTMLElement, HTMLElement>();
let opened: HTMLElement | null = null;

/**
 * 展开时把浮层挂到 body，用 fixed 贴在触发器下面。
 *
 * 原因是 Blink 的 backdrop root：卡片自己是 .lg（带 backdrop-filter），而带 backdrop-filter 的
 * 祖先会把后代 backdrop-filter 取到的背景快照限制在自己内部——浮层拿到的是卡片合成完的较暗结果，
 * 于是把背景「压暗」而不是「透亮」。实测首页格式浮层中心中位色 (226,234,238)，
 * 挪出卡片后回到 (240,253,255)，与 /github 顶部那种没有玻璃祖先的下拉一致。
 * 顺带彻底躲开「浮层被 DOM 靠后的卡片盖住」那一类层叠事故。
 */
function place(panel: HTMLElement, btn: HTMLElement): void {
  document.body.append(panel);
  panel.style.position = 'fixed';
  panel.style.margin = '0';
  // 收起态靠 right-0/left-0 贴对齐边，挂到 body 后那两个偏移还留在类名里。fixed 盒子的
  // left 和 right 同时给定、width 又是 auto 时，用的是「拉伸填满」而不是收缩适应——
  // 浮层会横铺满视口。这里显式放开另一侧，让宽度回到内容本身。
  panel.style.right = 'auto';
  const { width } = panel.getBoundingClientRect();
  const t = btn.getBoundingClientRect();
  const raw = panel.dataset.menuAlign === 'left' ? t.left : t.right - width;
  panel.style.left = `${Math.round(Math.min(Math.max(raw, EDGE), Math.max(EDGE, innerWidth - width - EDGE)))}px`;
  panel.style.top = `${Math.round(t.bottom + GAP)}px`;
}

function unplace(panel: HTMLElement, root: HTMLElement): void {
  for (const prop of ['position', 'left', 'right', 'top', 'margin']) panel.style.removeProperty(prop);
  root.append(panel);
}

function setOpen(panel: HTMLElement, open: boolean): void {
  const btn = btnOf.get(panel);
  const root = rootOf.get(panel);
  if (!btn || !root) return;
  // 先摘掉 hidden 才有盒子，place() 量得到宽高
  panel.classList.toggle('hidden', !open);
  if (open) place(panel, btn);
  else unplace(panel, root);
  btn.setAttribute('aria-expanded', String(open));
  if (open) opened = panel;
  else if (opened === panel) opened = null;
}

function closeAll(except?: HTMLElement): void {
  document.querySelectorAll<HTMLElement>('[data-menu-panel]').forEach((panel) => {
    if (panel !== except) setOpen(panel, false);
  });
}

// 类名 token 会被 Astro 组件在服务端 import，接线只能留在浏览器里
if (typeof window !== 'undefined') {
  /**
   * 挂到 body 之后 root.querySelector('[data-menu-panel]') 就找不到了，
   * 所以开合关系在第一次就把三个方向的引用固定下来，之后一律查表不查 DOM 包含关系。
   */
  const panelByBtn = new WeakMap<HTMLElement, HTMLElement>();
  for (const root of document.querySelectorAll<HTMLElement>('[data-menu]')) {
    const btn = root.querySelector<HTMLElement>('[data-menu-btn]');
    const panel = root.querySelector<HTMLElement>('[data-menu-panel]');
    if (!btn || !panel) continue;
    panelByBtn.set(btn, panel);
    btnOf.set(panel, btn);
    rootOf.set(panel, root);
  }

  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    // 菜单外的任何点击都要把浮层收掉，否则它会一直盖在页面上。
    // 展开中的浮层已经不在 [data-menu] 里了（挂在 body 下），所以「算不算菜单内」要两个都认，
    // 否则点浮层自己会被当成点外面。
    if (!target?.closest<HTMLElement>('[data-menu], [data-menu-panel]')) {
      closeAll();
      return;
    }
    if (target.closest('[data-menu-option]')) {
      closeAll();
      return;
    }
    const btn = target.closest<HTMLElement>('[data-menu-btn]');
    const panel = btn ? panelByBtn.get(btn) : undefined;
    if (!panel) return;
    const wasOpen = !panel.classList.contains('hidden');
    // 互斥：开这个就关掉别的那些（首页上格式菜单和线路菜单会挨着）
    closeAll(panel);
    setOpen(panel, !wasOpen);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeAll();
  });

  // 浮层是 fixed 的，页面滚动或视口变了要跟着触发器重新贴一次
  let frame = 0;
  const reflow = () => {
    if (!opened || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const btn = opened ? btnOf.get(opened) : undefined;
      if (opened && btn) place(opened, btn);
    });
  };
  addEventListener('scroll', reflow, { passive: true, capture: true });
  addEventListener('resize', reflow, { passive: true });
}
