const popupAnim = require('../popup-anim');

/**
 * 通用底部弹层（全站唯一实现）
 * ============================================================
 * v0.7.32：**下拉关闭（可拖拽）**——按用户口径实现：
 *   ① grabber 指示条 + **标题栏整块**作为拖动感应区（约 60px，不是只有文字热区）；
 *   ② 向上拖：跟手到顶后进入 **rubber-banding**（位移指数衰减、渐近最多 26px），松手 spring 弹回；
 *   ③ 向下拖：完全跟手；松手**位移 + 速度共同判定** ——
 *      超过面板高度一半 / 或快速下滑轻扫 → 滑出并关闭；否则 spring 回位；
 *      **回弹与关闭的时长都由松手瞬间的速度算出来**（不是固定 300ms 匀速）；
 *   ④ 遮罩透明度跟随拖动位移同步减淡；
 *   ⑤ **可打断**：回弹/关闭动画进行中按住标题栏，接住当前位移与速度继续拖；
 *   ⑥ 只有 `.sheet-drag`（指示条 + 标题栏）响应 touchmove，内容区 scroll-view 不受影响。
 *
 * ⚠️ 实现纪律（用户明确要求「不要出现」的两点）：
 *   · **只动 transform / opacity**，绝不改 width/height/top → 拖动期不重排、不闪烁；
 *   · **先播完滑出动画再卸载**：drag 关闭走 `_closeOut()` 自己的位移动画，播完才
 *     `triggerEvent('close')`；节点卸载仍由 popup-anim 的 mounted/active 两帧机制负责。
 * ⚠️ 小程序没有真 spring：用「速度算时长 + 带轻微 overshoot 的 cubic-bezier」逼近，
 *    并把打断时的位置按同一条曲线的近似解算出来（`_curOffset()`）。
 */
const DURATION = 240;

/** rubber-band：向上最多再拉这么多 px（渐近值，永远拉不到） */
const RUBBER_MAX = 26;
/** 「快速下滑轻扫」的速度阈值（px/ms，向下为正） */
const FLICK_V = 0.6;
/** 回弹/关闭动画的时长夹取范围（ms） */
const MIN_MS = 130;
const MAX_MS = 420;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
/** 指数衰减：raw 越大越拉不动，渐近 RUBBER_MAX */
const rubber = (raw) => RUBBER_MAX * (1 - 1 / (1 + raw / RUBBER_MAX));
/** 与 .22,1.06,.36,1 形状接近的近似解（打断时按它反推当前位置） */
const easeOutApprox = (p) => 1 - Math.pow(1 - clamp(p, 0, 1), 3);

Component({
  options: { addGlobalClass: true, multipleSlots: true },
  behaviors: [popupAnim],
  properties: {
    // ⚠️ show 的 observer 必须写在组件里（popup-anim 只提供 mounted/active 与 animSync）：
    // 若在 behavior 里也声明 show，组件自身这份会覆盖掉它，observer 直接不生效。
    show: { type: Boolean, value: false, observer(nv) { this.animSync(nv); } },
    title: { type: String, value: '' },
    height: { type: Number, value: 0 },      // rpx，0=自适应
    maskClose: { type: Boolean, value: true },
    showClose: { type: Boolean, value: true },
    radius: { type: Number, value: 24 },
    // 是否让开底部自定义 tabBar（Tab 页弹层需 true，避免内容被 tabBar 遮挡）
    tabbar: { type: Boolean, value: true },
    // v0.7.25：更高的面板（max-height 92vh）—— 内容确实装不进 78vh 的弹层（如成员详情：
    // 固定操作区 + 备注列表 + 书写区）用它；内容少的弹层不要开，避免「小内容大面板」。
    tall: { type: Boolean, value: false },
    // v0.7.25：底部固定操作条（<view slot="footer"> … </view>）—— 结构级固定在面板底部
    // （panel 是 flex column，footer 是第三个 flex 子项），不随 sheet-body 滚动。
    // ⚠️ 不要用 position:fixed 实现「固定」：panel 带过渡 transform，会建包含块（MEMORY 铁律②）。
    footer: { type: Boolean, value: false },
    // v0.7.32：是否允许下拉关闭。带表单 / 日期选择的弹层（如请假登记）可置 false 防误关。
    draggable: { type: Boolean, value: true },
    // v1.0.5：body 是否允许下拉刷新（成员与分组等列表型弹层开启；表单类弹层保持 false）
    refreshable: { type: Boolean, value: false }
  },
  data: {
    safeBottom: 0, tabbarPx: 49, capStyle: '', bodyMaxH: '',
    /* ---- 拖拽（v0.7.32）---- */
    dragging: false,     // 手指按住拖动中（用于给面板加 .drag 关掉过渡）
    dragStyle: '',       // 面板内联样式：拖拽/回弹/滑出期间覆盖 class 的 transform
    maskStyle: ''        // 遮罩内联样式：透明度跟手
  },
  observers: {
    /* 关闭（active 落回 false）后清掉拖拽内联样式 —— 否则残留的 inline opacity/transform
       会盖住 class 规则（下一次打开时面板停在半途）。 */
    active(v) {
      if (!v && (this.data.dragStyle || this.data.maskStyle || this.data.dragging)) {
        this.setData({ dragging: false, dragStyle: '', maskStyle: '' });
      }
    }
  },
  lifetimes: {
    /**
     * 度量统一走 `app.sheetMetrics()`（惰性算一次 + 全局缓存）。
     * ⚠️ 弹层即使**没打开**，组件实例也已经在页面组件树里，所以这里的花销是
     * 「每打开一个页面」都要付的：原来每次都调一次同步的 `wx.getWindowInfo()`
     * 并 `setData` 触发二次渲染 —— 这正是「进新页面先卡一下」的一部分。
     */
    attached() {
      const app = getApp && getApp();
      const m = (app && app.sheetMetrics)
        ? app.sheetMetrics()
        : { safeBottom: 0, tabbarPx: 49, sheetCapStyle: '' };
      // 滚动兜底（v1.0.5）：未显式传 height 的弹层（成员详情 / 我的页明细 /
      // 请假登记 / 首页请假名单），面板只有 max-height 没有确定高度，
      // flex:1 的 scroll-view 在微信里拿不到确定高度 → 整段内容滚不动。
      // 由 JS 给 body 下发一个确定的 max-height（内容短时面板仍按内容自适应，
      // 内容长时 body 被 caps → 内容可滚动）。传了 height 的弹层已有确定高度，无需再 cap。
      // ⚠️ v0.7.32：扣掉的头部高度 104rpx → **124rpx**（新增 28rpx grabber 指示条）——
      //    改头部结构必须同步这里，否则长内容会比面板高一条指示条的高度。
      const ph = this.properties.height || 0;
      const tall = this.properties.tall;
      const bodyMaxH = ph
        ? ''
        : ';max-height: calc(' + (tall ? '92vh' : '78vh') + ' - 124rpx)';
      if (m.safeBottom === this.data.safeBottom && m.tabbarPx === this.data.tabbarPx
        && (m.sheetCapStyle || '') === this.data.capStyle && bodyMaxH === this.data.bodyMaxH) return;
      this.setData({
        safeBottom: m.safeBottom,
        tabbarPx: m.tabbarPx,
        capStyle: m.sheetCapStyle || '',
        bodyMaxH
      });
    },
    detached() {
      if (this._dragTimer) { clearTimeout(this._dragTimer); this._dragTimer = null; }
    }
  },
  methods: {
    onMask() {
      if (this.data.maskClose) this.triggerEvent('close');
    },
    onClose() {
      this.triggerEvent('close');
    },
    noop() {},

    /* v1.0.5：body 下拉刷新 → 转发给使用方页面（roster 等监听 bindrefresh 重载） */
    _onRefresh() {
      this.triggerEvent('refresh');
    },
    /** 使用方重载完成后调用：收起 body 的下拉刷新指示器 */
    finishRefresh() {
      const sc = this.selectComponent('#sheetScroll');
      if (sc && sc.finishRefresh) sc.finishRefresh();
    },
    /** 使用方内容高度变化后调用：让 body 重新测量可滚动范围 */
    resizeScroll() {
      const sc = this.selectComponent('#sheetScroll');
      if (sc && sc.resize) sc.resize();
    },

    /* ================= 拖拽（v0.7.32） ================= */

    /** 量一次面板高度（关闭阈值 = 一半，遮罩衰减也用它）。异步，命中前用兜底值。 */
    _measure() {
      const q = this.createSelectorQuery && this.createSelectorQuery();
      if (!q || !q.select) return;
      const sel = q.select('.sheet-panel');
      if (!sel || typeof sel.boundingClientRect !== 'function') return;
      sel.boundingClientRect((rect) => {
        if (rect && rect.height) this._panelH = rect.height;
      }).exec();
    },

    /** 当前位移（px，0=打开态）：有动画在跑就按同一条曲线近似解出来（打断用） */
    _curOffset() {
      const a = this._anim;
      if (!a) return this._applied || 0;
      const p = a.dur ? clamp((Date.now() - a.t0) / a.dur, 0, 1) : 1;
      return a.from + (a.to - a.from) * easeOutApprox(p);
    },

    /** 打断：把正在跑的动画收干，停到当前位置 */
    _freeze() {
      if (!this._anim) return;
      this._applied = this._curOffset();
      this._anim = null;
      if (this._dragTimer) { clearTimeout(this._dragTimer); this._dragTimer = null; }
    },

    _panelStyle(y) {
      return 'transform: translateY(' + y.toFixed(2) + 'px); transition: none;';
    },
    /** 遮罩跟着位移线性减淡（拖到底 = 全透明） */
    _maskStyle(y) {
      const h = this._panelH || 1;
      const o = clamp(1 - y / h, 0, 1);
      return 'opacity: ' + o.toFixed(3) + '; transition: none;';
    },

    onHeadStart(e) {
      if (!this.data.draggable || !this.data.active) return;
      const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
      if (!t) return;
      // 关闭按钮等「点按型」子元素不参与拖动（避免一碰标题栏就进入 dragging 态）
      const ds = (e.target && e.target.dataset) || {};
      if (ds.nodrag) return;
      this._measure();
      this._freeze();                                  // ⑤ 接住正在跑的回弹/关闭动画
      const base = this._applied || 0;
      this._drag = {
        y0: t.clientY, base, lastY: t.clientY, lastT: Date.now(), v: 0, moved: false
      };
      this.setData({ dragging: true, dragStyle: this._panelStyle(base), maskStyle: this._maskStyle(base) });
    },

    onHeadMove(e) {
      const d = this._drag;
      if (!d || !this.data.dragging) return;
      const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
      if (!t) return;
      const now = Date.now();
      const raw = t.clientY - d.y0 + d.base;            // 向下为正
      // ② 向上超过原位 → rubber-banding（指数衰减，最多再拉 RUBBER_MAX）
      const y = raw < 0 ? -rubber(-raw) : raw;
      const dt = now - d.lastT;
      if (dt > 0) d.v = (t.clientY - d.lastY) / dt;     // px/ms（向下为正）
      d.lastY = t.clientY;
      d.lastT = now;
      if (Math.abs(raw) > 3) d.moved = true;
      this._applied = y;
      this.setData({ dragStyle: this._panelStyle(y), maskStyle: this._maskStyle(y) });
    },

    onHeadEnd() {
      const d = this._drag;
      this._drag = null;
      if (!d || !this.data.dragging) return;
      const y = this._applied || 0;
      const h = this._panelH || 480;
      const v = d.v || 0;
      // ③ 位移 + 速度共同判定：过半 或 快速下滑轻扫 → 关闭；否则回位
      if (y > h / 2 || v > FLICK_V) this._closeOut(y, h, v);
      else this._springBack(y, v);
    },

    /** 回弹：时长由「剩余距离 / 松手速度」算出（速度越大越快，带一点回弹手感） */
    _springBack(y, v) {
      const speed = Math.max(Math.abs(v), 0.45);
      const dur = Math.round(clamp((Math.abs(y) / speed) * 0.9 + 90, MIN_MS, MAX_MS));
      this._anim = { t0: Date.now(), from: y, to: 0, dur };
      this.setData({
        dragging: false,
        dragStyle: 'transform: translateY(0px); transition: transform ' + dur
          + 'ms cubic-bezier(.22,1.06,.36,1);',
        maskStyle: ''
      });
      this._finish(dur, () => {
        this._anim = null;
        this._applied = 0;
        this.setData({ dragStyle: '', maskStyle: '' });   // 交还给 class 规则
      });
    },

    /** 滑出关闭：先播完位移动画，再通知页面关（页面把 show 置 false）——「先动画后卸载」 */
    _closeOut(y, h, v) {
      const speed = Math.max(Math.abs(v), 0.5);
      const dur = Math.round(clamp(((h - y) / speed) * 0.9 + 80, MIN_MS, MAX_MS));
      this._anim = { t0: Date.now(), from: y, to: h, dur };
      this.setData({
        dragging: false,
        dragStyle: 'transform: translateY(' + h + 'px); transition: transform ' + dur
          + 'ms cubic-bezier(.4,0,.6,1);',
        maskStyle: 'opacity: 0; transition: opacity ' + dur + 'ms linear;'
      });
      this._finish(dur, () => {
        this._anim = null;
        this._applied = 0;
        // ⚠️ 这里**不清** dragStyle / maskStyle：交给 active 变 false 的 observer 清，
        //    否则清掉的那一帧遮罩会被 class 的 `.in` 拽回全不透明 → 闪一下。
        this.triggerEvent('close');
      });
    },

    _finish(dur, cb) {
      if (this._dragTimer) clearTimeout(this._dragTimer);
      this._dragTimer = setTimeout(() => {
        this._dragTimer = null;
        cb();
      }, dur + 16);
    }
  }
});
