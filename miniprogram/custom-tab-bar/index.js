/*
 * 自定义 tabBar —— 双图层图标 + 实例路由初始化（2026-09-25 闪烁修复）
 *
 * 两个历史 bug 的根因：
 * ① 「文字先变色、图标后变色」：旧实现用 <app-icon variant="on/off">，variant 一变
 *    image 的 src 就换成另一个 cloud:// 文件 → 重新走云存储加载/解码（几百 ms），
 *    而文字 class 是即时生效的。现在每个位置**同时渲染 off/on 两张内联 base64
 *    图标**（data URI 零网络），叠放只切 opacity —— 与文字同帧变化。
 * ② 「切换时别的 tab 亮一下 / 导航栏闪一下」：每个 Tab 页持有独立的 tabBar 实例，
 *    旧实现 data.active 初始恒为 0 —— 从首页切到「我的」时，mine 页自己的实例
 *    先渲染出 active=0（首页亮）再被 onShow 的 setTabBar 修正。现在 attached 时
 *    按 getCurrentPages() 顶层路由直接初始化 active，实例一出生就是正确状态。
 */
const { get } = require('../utils/icons');

const TABS = [
  { key: 'home', text: '首页', url: '/pages/home/index', icon: 'tab-home' },
  { key: 'timetable', text: '课程表', url: '/pages/timetable/index', icon: 'tab-timetable' },
  { key: 'duty', text: '值日', url: '/pages/duty/index', icon: 'tab-duty' },
  { key: 'mine', text: '我的', url: '/pages/mine/index', icon: 'tab-mine' }
];

/* 两张内联 base64（off/on）在模块加载时算一次，所有页面实例共享，零网络请求 */
const LIST = TABS.map(t => {
  const off = get(t.icon, 'off') || {};
  const on = get(t.icon, 'on') || {};
  return Object.assign({}, t, { srcOff: off.data || '', srcOn: on.data || '' });
});

/* ============ 液态指示器几何（v0.7.14 第 6 轮：整体缩小一号 + 指示器满格） ============
 * ⚠️ 定位基准不是 750rpx，而是**胶囊自身的内容宽**：
 *   可用宽 = 750 − 2×`SIDE_RPX`，四等分 = 格宽。
 * 第 5 轮（用户「底栏整体宽度收缩，大概我圈出来这么大」）：
 *   按其截图红框实测 ≈502rpx / 屏 750rpx → 取整 **500rpx**（左右各内缩 125rpx）。
 * 第 6 轮（用户「整体都小一点，左右上下，内部图标文字都小一点」）：
 *   内缩 125→**143rpx**、胶囊内容宽 **464rpx**、格宽 **116rpx**；胶囊高 104→92rpx。
 *   ⚠️ `SIDE_RPX` **必须取奇数** —— `750 − 2S` 要能被 4 整除（格宽为整数）；取 140 时
 *   470/4 = 117.5，`normLeft(3)+CELL ≠ BAR_W`，门禁的「零留白」硬断言会失败。
 *
 * 历史 bug（2026-09-26 用户截图「位置不对」）：曾按 750/4 = 187.5rpx 算，
 *   指示器整体右偏且偏宽，越靠右越明显 —— 最后一格（我的）偏右 84rpx。
 *
 * 零留白口径（第 5 轮第 ② 条：用户「蓝色的遮罩边缘和底栏的边缘不要有留白，
 * 尤其是左边『首页』和右边『我的』」）：
 *   常态**指示器宽度 = 整格宽**（`NORM_W_RPX = CELL_RPX`）→ 首格左缘贴胶囊左缘、
 *   末格右缘贴胶囊右缘，两侧零留白。因此 `normLeft(i) = i × CELL_RPX`，不再有居中偏移。
 *   「先拉长再收拢」的手感改由 **left 预冲**（`OVER_RPX`）承担：stretch 拍先越过目标，
 *   settle 拍回落到格位。首/末格朝外预冲会被胶囊 `overflow: hidden` 沿圆弧裁掉 —— 观感即贴边流动。
 * `SIDE_RPX` 必须与 index.wxss 的 margin 一致，由 check-tabbar-liquid 绑定校验（不写死具体值）。 */
/**
 * 底栏底部留白兜底（2026-09-29，需求①「安卓底栏贴着屏幕底」）
 * ------------------------------------------------------------
 * 现状：`.tabbar-wrap` 的 `padding-bottom` 只取 `safeBottom`（= screenHeight − safeArea.bottom）。
 *  · iPhone（有 Home Indicator）：safeBottom ≈ 34 ⇒ 胶囊下沿离屏幕底 ~37px，观感正确；
 *  · 安卓（绝大多数无安全区）：safeBottom = 0 ⇒ 胶囊紧贴屏幕底 —— 用户报的 bug。
 * 修法：**无安全区时补一段固定留白**，量级对齐 iPhone 的安全区高度，
 * 让两端「胶囊下沿 ~ 屏幕底」的距离一致；有安全区的机型（iPhone）**完全不动**。
 * ⚠️ 这个值同时也是全站「底栏让位」的增量：改它必须同步
 *    app.js `sheetMetrics().tabbarPx`、timetable `_fitHeight()` 的 `reserve`、
 *    以及 4 处 `bottom/padding-bottom: calc(…rpx + env(…))`（由 check-tabbar-liquid 守）。
 */
const TABBAR_LIFT_PX = 32;
const SIDE_RPX = 143;                   // 与 index.wxss `.tabbar { margin: 0 143rpx 6rpx }` 一致（须为奇数）
const BAR_W_RPX = 750 - SIDE_RPX * 2;   // 胶囊内容宽 464rpx
const CELL_RPX = BAR_W_RPX / 4;         // 116rpx
const NORM_W_RPX = CELL_RPX;            // 常态宽 = 整格宽（两侧零留白）
const OVER_RPX = 14;                    // 拉伸拍前缘预冲：先越过目标 14rpx，settle 拍回落
const IND_MS = 140;                     // stretch 拍时长（与 index.wxss .tab-ind.stretch left 时长一致）

const normLeft = (i) => Math.round(i * CELL_RPX);
/** 拉伸拍：朝移动方向越过目标 OVER_RPX（首/末格朝外时由胶囊 overflow 裁掉，观感为贴边流动） */
const stretchLeft = (i, from) => Math.round(i * CELL_RPX + (i >= from ? OVER_RPX : -OVER_RPX));

/* ============ 跨页指示器交接（v0.7.15） ============
 * 病灶（2026-09-26 用户截图 + 口述「四个按钮两两相邻之间点击有动画，但从首页直接点我的，
 * 动画就直接消失了，蓝色遮罩变成瞬间出现在选择的页面位置，而不是滑动过去」）：
 *   custom-tab-bar 是**每个 Tab 页各一个实例**。旧实现把两拍动画起在「点击时所在的那个
 *   实例」上，而 `wx.switchTab` 紧接着就把该页隐藏 —— 动画只播了个开头就随页面一起消失。
 *   屏幕上真正显示的是**目标页实例**，它要么首帧就画在终点（首次访问该 Tab），
 *   要么因为 `active` 早在 click 那一刻就被乐观预置成同值、被 `app.setTabBar` 的
 *   「值相同就跳过」守卫挡回（缓存页）—— 两种情况都不会播放动画。
 *   距离一格时视觉差只有 116rpx，看着像「滑过去了」；隔三格（首页→我的，348rpx）
 *   就暴露成「瞬移」。
 *
 * 修法：把「起拍格」通过**模块级变量**交接给目标页实例。同一份 JS 模块在所有实例间共享
 *   （上方 `LIST` 就是靠这一点只算一次），所以模块级 `HANDOFF` 天然是跨实例的：
 *   · 所有实例注册进 `INSTANCES`，`attached` 时记下自己所属页面的路由 `_route`；
 *   · 点击时只写 `HANDOFF`，并把**即将显示的那一个实例**的指示器预置到起点格
 *     —— 不广播给全部实例：否则隐藏页会留下陈旧位置，之后从二级页 switchTab 回来会闪一下；
 *   · 目标实例在页面 `onShow`（→ `app.setTabBar` → `syncActive`）时消费交接，
 *     先把指示器画在起点格（无过渡），渲染完成后起拍，完整播放 stretch → settle。
 *
 * 空间一致性（Apple《Designing Fluid Interfaces》§3 可中断 / §7 空间一致）：
 *   指示器是**一个连续物体**，换页只是它的容器换了 —— 必须从**当前可见位置**续接，
 *   绝不能从逻辑目标值起播（那正是「瞬移」的来源）。
 */
const INSTANCES = new Set();            // 活着的 tabBar 实例（每个 Tab 页一个）
let HANDOFF = null;                     // { to, from, at } —— 跨页交接
const HANDOFF_MS = 900;                 // 超过即视为陈旧（switchTab 失败 / 用户中途离开）

/** 取一份尚未过期的交接；传 index 时只认「目标格相符」的那一次 */
const freshHandoff = (index) => {
  if (!HANDOFF || Date.now() - HANDOFF.at > HANDOFF_MS) return null;
  if (index !== undefined && HANDOFF.to !== index) return null;
  return HANDOFF;
};

Component({
  options: { addGlobalClass: true },
  data: {
    active: 0,
    popIndex: -1,            // 只在「点击切换」的那一项上播弹跳动画（attached 初始化不播，防闪烁）
    safeBottom: 0,
    /** 实际施加到 `.tabbar-wrap` 的 padding-bottom(px)：有安全区用安全区，无安全区用兜底留白 */
    tabbarPad: 0,
    dot: false,              // 值日 tab 红点（有待确认事项）
    list: LIST,
    indLeft: 0,              // 液态指示器位置（rpx）
    indWidth: NORM_W_RPX,    // 液态指示器宽度（rpx）—— 恒为整格宽
    indCls: ''               // '' = 无过渡（初始定位/回退）；'stretch' → 'settle' 两拍
  },
  lifetimes: {
    attached() {
      INSTANCES.add(this);
      this._route = this._currentRoute();
      const app = getApp && getApp();
      if (app) {
        const sb = app.globalData.safeBottom || 0;
        this.setData({
          safeBottom: sb,
          // max 而非三元：iPhone(safeBottom≈34) 取安全区 → **完全不动**；
          // 安卓(safeBottom=0，或只有一个小手势条) 兜底到 32 → 与 iPhone 观感一致。
          tabbarPad: Math.max(sb, TABBAR_LIFT_PX)
        });
      }
      // 每个页面自己的 tabBar 实例一创建就按真实路由点亮对应 tab，
      // 消除「先亮错的 tab、再被 onShow 修正」那一帧闪烁。
      this._syncActiveFromRoute();
      /*
       * 指示器初始定位：元素创建时就在正确位置（首渲染不带 transition，不会播动画）。
       * ⚠️ 首次访问某个 Tab 时本实例是**新建**的，没有任何「上次渲染」可继承 ——
       *    它的起点只能来自交接里的 `from`，否则会首帧就画在终点，动画同样丢失。
       */
      const h = freshHandoff();
      this.setData({
        active: h ? h.to : this.data.active,
        indCls: '',
        indLeft: normLeft(h ? h.from : this.data.active),
        indWidth: NORM_W_RPX
      });
    },
    detached() {
      INSTANCES.delete(this);
      if (this._indTimer) { clearTimeout(this._indTimer); this._indTimer = null; }
    }
  },
  methods: {
    /** 液态指示器两拍移动：stretch 拍预冲越过目标 → settle 拍回落格位（微回弹）。
     *  连续点击续接：CSS transition 从当前插值位置起播，中途改目标不跳变；
     *  只需清掉上一轮未播完的 settle 定时器，避免旧拍覆盖新拍。
     *  @param {number} index 目标格
     *  @param {number} from  起拍格（决定预冲方向） */
    _indMove(index, from) {
      if (this._indTimer) { clearTimeout(this._indTimer); this._indTimer = null; }
      this.setData({
        indCls: 'stretch',
        indLeft: stretchLeft(index, typeof from === 'number' ? from : index),
        indWidth: NORM_W_RPX
      });
      this._indTimer = setTimeout(() => {
        this._indTimer = null;
        this.setData({
          indCls: 'settle',
          indLeft: normLeft(index),
          indWidth: NORM_W_RPX
        });
      }, IND_MS);
    },

    /** 点击时把「即将显示的那个实例」的指示器预置到起点格。
     *  只认 `_route` 与目标 URL 相符的实例 —— 它是这一跳的落地页；
     *  其余实例（含当前这一页自己）保持原样，避免留下陈旧位置。
     *  新页首次创建时它还不存在 → 由 `attached` 的 `freshHandoff()` 兜住。 */
    _preplace(from, to) {
      const url = (TABS[to] && TABS[to].url) || '';
      if (!url) return;
      INSTANCES.forEach((inst) => {
        if (inst === this || inst._route !== url) return;
        inst.setData({ active: to, indCls: '', indLeft: normLeft(from), indWidth: NORM_W_RPX });
      });
    },

    onChange(e) {
      const index = Number(e.currentTarget.dataset.index);
      const item = this.data.list[index];
      if (!item) return;

      /*
       * 用「当前真实路由」判断是否已在该页，不再依赖组件内部的 active：
       * active 由各页 onShow 写入，一旦 onShow 没跑到 / getTabBar() 为空就会脱节，
       * 旧的 `index === active → return` 会让点击静默失效（表现为 tabBar 点了没反应）。
       */
      const curRoute = this._currentRoute();
      if (curRoute && curRoute === item.url) return;

      /*
       * 乐观选中 + 跨页交接：
       *  · `active` 立刻置位（这个守卫不依赖 active，提前置位是安全的）——
       *    switchTab 到首次访问的 Tab 页要等页面注入 + 首帧（100~300ms），
       *    这段空窗期图标必须已经亮了。
       *  · 指示器**不在本实例上起拍**：本页马上会被隐藏，动画会跟着一起消失。
       *    改成写 HANDOFF + 预置目标实例，由目标页 onShow 播放完整两拍。
       */
      const from = this.data.active;   // 起拍格：先取，供指示器判定预冲方向
      HANDOFF = { to: index, from, at: Date.now() };
      this.setData({ active: index });
      this._preplace(from, index);

      wx.switchTab({
        url: item.url,
        fail: (r) => {
          // 切失败要把选中态**退回去**，否则图标停在一个没打开的页上；
          // 交接也必须作废，否则下一次无关的 onShow 会把指示器从旧起点又滑一遍。
          HANDOFF = null;
          this._syncActiveFromRoute();
          const msg = (r && r.errMsg) ? String(r.errMsg) : '';
          if (msg) {
            console.error('[tabbar] switchTab fail', msg);
            wx.showToast({ title: '切换失败：' + msg.slice(0, 60), icon: 'none', duration: 3000 });
          }
        }
      });
    },

    /** 当前真实路由，形如 '/pages/home/index'；拿不到返回 '' */
    _currentRoute() {
      const pages = (typeof getCurrentPages === 'function' && getCurrentPages()) || [];
      const cur = pages.length ? pages[pages.length - 1] : null;
      return (cur && cur.route) ? ('/' + String(cur.route).replace(/^\//, '')) : '';
    },

    /** 取走一次交接（消费式）。只有「目标格相符」的那个实例取得到，取到即失效。 */
    _takeHandoff(index) {
      const h = freshHandoff(index);
      if (h) HANDOFF = null;
      else if (HANDOFF && Date.now() - HANDOFF.at > HANDOFF_MS) HANDOFF = null;
      return h;
    },

    /** 按真实路由回填 active（attached 初始化 + 切失败回退共用）。拿不到路由就不乱动。
     *  回退时指示器也要跟着归位：不播动画（indCls 清空 = 无过渡瞬移回真实位置），
     *  并取消在途的 settle 拍 —— 图标不能停在一个没打开的页上。 */
    _syncActiveFromRoute() {
      const curRoute = this._currentRoute();
      if (!curRoute) return;
      const i = this.data.list.findIndex(x => x.url === curRoute);
      if (i >= 0 && this.data.active !== i) {
        if (this._indTimer) { clearTimeout(this._indTimer); this._indTimer = null; }
        this.setData({ active: i, indCls: '', indLeft: normLeft(i), indWidth: NORM_W_RPX });
      }
    },

    /** 外部（app.setTabBar / 页面 onShow）同步 active 与指示器位置。
     *  · 有跨页交接 → 完整播放两拍（这是「首页直接点我的也能滑过去」的唯一入口）；
     *  · 没有交接（切失败回退 / 从二级页 switchTab 回来）→ 只纠正状态，不播动画，
     *    避免与正在播放的交接动画冲突或覆盖。 */
    syncActive(index) {
      // onShow 时顶层路由就是本实例所属页面 —— 顺便把 `_route` 校正一次
      // （attached 时万一 getCurrentPages 还没就绪，这里能自愈）。
      this._route = this._currentRoute() || this._route;

      const h = this._takeHandoff(index);
      if (h && h.from !== index) {
        /*
         * 分两拍 setData：
         *  第一拍把指示器**无过渡**画到起点格（渲染回调 = 这一帧已经落地）；
         *  第二拍才挂 stretch 起拍 —— 若把「挂过渡 class」和「给目标值」塞进同一次
         *  setData，before-change 里还没有 transition，会变成直接瞬移（本项目已有教训）。
         * popIndex 也在这里置位：弹跳必须发生在**屏幕上这一个实例**上，
         *  在离场实例上置位等于没置（旧实现的弹跳同样被页面切换吃掉了）。
         */
        this.setData(
          { active: index, popIndex: index, indCls: '', indLeft: normLeft(h.from), indWidth: NORM_W_RPX },
          () => this._indMove(index, h.from)
        );
        return;
      }

      if (this.data.active === index && this.data.indLeft === normLeft(index) && this.data.indWidth === NORM_W_RPX) {
        return;
      }
      if (this._indTimer) { clearTimeout(this._indTimer); this._indTimer = null; }
      this.setData({ active: index, indCls: '', indLeft: normLeft(index), indWidth: NORM_W_RPX });
    }
  }
});
