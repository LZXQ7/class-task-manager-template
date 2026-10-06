/**
 * C · 分段控件（单选 · 等分）
 * ------------------------------------------------------------
 * P3 课表（A 组 / B 组、全体课 / 分组课、调课模式…）、P4 值日（按日 / 按人）、
 * P1 首页（全体成员 / 指定成员）共用。
 *
 * v0.7.20 需求②：**动画改成和底部导航栏一样**（用户原话：「课程表页上面的 ab 组 …
 *   切换太僵硬，动画改为和底部导航栏一样。选到的选择稍微变大」）。
 *   因此这里的几何与两拍节奏**逐条对齐** custom-tab-bar 的液态指示器：
 *     · 高亮从「选中项自己变白底」改为**一块独立的胶囊指示器** `.seg-ind`，
 *       `position:absolute` + `transform:translateX()` / `width` 由 JS 下发
 *       （`left` 恒为 0；v0.7.21 需求⑤ 规格④把位移轴从 left 换成 transform —— 位移走合成器，
 *        而等分格宽固定 ⇒ 换格时 width 是常量，真正在动的只有这一条轴）；
 *     · 两拍 setData：`stretch`（140ms，前缘朝移动方向预冲 OVER_RPX）→
 *       `settle`（220ms，带过冲的贝塞尔落回格位）。中途再次点击从**当前可见位置**续接
 *       （CSS transition 天然从当前插值起播，改 transform 不会跳变）；
 *     · 指示器满高、圆角 = 轨道半径（36rpx），首格左缘 / 末格右缘与轨道圆角同心；
 *       预冲冲出轨道时由 `.seg` 的 `overflow:hidden` 沿圆弧裁掉 —— 与底栏同一种「贴边流动」。
 *
 * ⚠️ 事件契约**一个字都不能动**（scripts/check-segmented.js 守着）：
 *   `triggerEvent('change', { key })` —— 只 emit `key`；六个使用处的 handler 都读 `e.detail.key`。
 *   历史事故：组件 emit `key`、页面读 `e.detail.value` → 拿到字符串 "undefined" → 「点了没反应」。
 *
 * ⚠️ 单选 + 等分固定宽，**不参与**「多选标签挤开」动画（scripts/check-chip-anim.js ③ 有意排除）；
 *   但 `.seg-item` 必须保留带 background 的 transition（切换不是硬切）。
 *
 * ⚠️ 父级把 items 写成**内联数组字面量**（`items="{{[{key:'A',…}]}}"`），每次父级 setData
 *   都会生成新数组 → observer 再响一次。若在「值没变」时直接落位，会把正在播的两拍**打断**
 *   （表现为「点了没反应、白块瞬移」）。所以下面用 `_curIdx` 记住**上一个选中下标**，
 *   值没变时只补几何、并且**动画进行中一律不插手**。
 */
/** 指示器常态横向内缩（rpx）：两侧各留 3rpx，免得满格白块贴着轨道边缘 */
const INSET_RPX = 3;
/** 拉伸拍前缘预冲（rpx）：先越过目标再回落 —— 与底栏 OVER_RPX=14 同源，按控件尺寸收小 */
const OVER_RPX = 8;
/** stretch 拍时长（ms）：必须与 index.wxss 里 `.seg-ind.stretch` 的 left 时长一致 */
const IND_MS = 140;

Component({
  options: { addGlobalClass: true },
  properties: {
    items: { type: Array, value: [] },   // [{key, text}]
    value: { type: String, value: '' },
    width: { type: Number, value: 320 }  // rpx（外层定宽，格宽 = width / items.length）
  },
  data: {
    indLeft: 0,     // 指示器位置（rpx）
    indWidth: 0,    // 指示器宽度（rpx）
    indCls: ''      // '' = 无过渡（首次定位 / 原地）；'stretch' → 'settle' 两拍
  },
  observers: {
    'items, value, width': function () { this._sync(); }
  },
  lifetimes: {
    attached() { this._sync(); },
    detached() {
      if (this._indTimer) { clearTimeout(this._indTimer); this._indTimer = null; }
    }
  },
  methods: {
    /** 当前选中项下标；找不到（含 value 为空）落到第 0 项 */
    _idx() {
      const items = this.data.items || [];
      const v = String(this.data.value);
      for (let i = 0; i < items.length; i++) {
        if (String(items[i] && items[i].key) === v) return i;
      }
      return 0;
    },
    /**
     * 把指示器同步到当前选中项。
     * · 下标**真的变了** → 播两拍（stretch → settle）；
     * · 首次定位（还没有上一个下标）→ 直接落位，不做「从最左边滑过来」的假动画；
     * · 下标没变（父级重渲染带来的重复通知）→ 只补几何，且不打断正在播的两拍。
     */
    _sync() {
      const n = (this.data.items || []).length || 1;
      const cell = (Number(this.data.width) || 320) / n;
      const idx = this._idx();
      const normLeft = Math.round(idx * cell + INSET_RPX);
      const normWidth = Math.round(cell - INSET_RPX * 2);
      const prev = this._curIdx;

      if (prev === idx) {
        if (this._indTimer) return;   // 两拍进行中：重复通知不得插手
        if (this.data.indCls || this.data.indLeft !== normLeft || this.data.indWidth !== normWidth) {
          this.setData({ indCls: '', indLeft: normLeft, indWidth: normWidth });
        }
        return;
      }
      this._curIdx = idx;

      if (typeof prev !== 'number') {
        this.setData({ indCls: '', indLeft: normLeft, indWidth: normWidth });
        return;
      }

      if (this._indTimer) { clearTimeout(this._indTimer); this._indTimer = null; }
      // 拍 1：stretch —— 前缘朝移动方向预冲，落得比目标远一点
      this.setData({
        indCls: 'stretch',
        indLeft: normLeft + (idx > prev ? OVER_RPX : -OVER_RPX),
        indWidth: normWidth
      });
      // 拍 2：settle —— 带过冲的贝塞尔回落到格位（与底栏同一条曲线）
      this._indTimer = setTimeout(() => {
        this._indTimer = null;
        this.setData({ indCls: 'settle', indLeft: normLeft, indWidth: normWidth });
      }, IND_MS);
    },
    onPick(e) {
      const key = String(e.currentTarget.dataset.key);
      if (key === this.data.value) return;
      this.triggerEvent('change', { key });
    }
  }
});
