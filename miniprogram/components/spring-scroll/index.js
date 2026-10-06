/**
 * spring-scroll —— 带边界阻尼的弹性滚动容器（v1.0.5 追加「拉伸 + 下拉刷新」）
 *
 * 设计目标：
 *  1. spring 物理驱动回位：stiffness=250 / damping=30 / mass=1（阻尼比 ζ≈0.95，近临界、无卡通过冲）。
 *  2. 边界 rubber-banding：越过上下边界按指数衰减，越拉越沉，最多约 120px 到极限；临界阻尼回位，不过冲。
 *  3. 全程 momentum：松手按当前速度惯性滑行 + 自然衰减（spring 用松手瞬间的真实速度作初速度，自带惯性）。
 *  4. 可打断：touchstart 立刻停掉正在播放的动画并接住当前速度/位置，从当前点继续跟手。
 *  5. 「拉长」形变：顶部下拉时内容 translateY 跟随（0.6× 阻尼），同时 scaleY 轻微拉伸
 *     （transform-origin 随方向切换 top/bottom，最大 1.03），做出「有重量、被慢慢拉出来」的观感。
 *  6. 下拉刷新：顶部拉过阈值(60px)松手 → 进入 refreshing 态、在拉出的空间里显示指示器、emit('refresh')；
 *     父组件加载完调 finishRefresh() 收起。刷新进行中不再叠加拉伸。
 *
 * 禁用：ease-in-out / linear / 边界硬 clamp 成静止 / 固定 300ms / 单个回弹 cubic-bezier / 用 height 做拉伸。
 * 降级：prefers-reduced-motion（wx.getSystemSetting.reducedMotion）下不做惯性/橡皮筋/拉伸，直接吸附边界。
 *
 * 子节点原生 bindtap / picker 不受影响：移动小于阈值视为 tap，不进入拖拽；达到阈值才跟手。
 */

// —— 物理参数（stiffness/damping/mass 即需求给定区间）——
const STIFFNESS = 250;   // k
const DAMPING = 30;      // c  → ζ = c/(2√(k·m)) ≈ 0.95（临界附近，恰好不过冲）
const MASS = 1;          // m

// —— 边界拉伸（v1.0.5）——
const RUBBER_MAX = 120;  // 边界最大可拉出 px（需求 100~140px）
const RUBBER_SCALE = 150;// 指数衰减常数：导数@0 = RUBBER_MAX/SCALE ≈ 0.8（<1，永不 1:1 跟手）
const CONTENT_DAMP = 0.6;// 内容位移 = 手指位移的 0.6×（更有重量，与 scaleY 形成阻尼差）
const SCALE_MAX = 0.03;  // scaleY 最大拉伸 1.03（transform-origin 随方向切换）
const REFRESH_PX = 60;   // 下拉刷新阈值 px

const DRAG_THRESHOLD = 6; // px：小于此位移视为 tap，不拖拽
const MOMENTUM_MS = 500; // 松手惯性投影时长（0.5s）* 速度(px/ms) = 滑行 px

/**
 * 橡皮筋映射：指数衰减，随越界量增大而趋近 RUBBER_MAX。
 * @param {number} overshoot 越界量（正=越过上界，负=越过下界）
 */
function rubber(overshoot) {
  const mag = RUBBER_MAX * (1 - Math.exp(-Math.abs(overshoot) / RUBBER_SCALE));
  const capped = Math.min(mag, RUBBER_MAX);
  return overshoot < 0 ? -capped : capped;
}

Component({
  options: { addGlobalClass: false, multipleSlots: false },
  properties: {
    /** 是否允许下拉刷新（默认关；列表型页开启） */
    refreshable: { type: Boolean, value: false }
  },
  data: {
    _offset: 0,      // 当前内容 translateY(px)，0=顶部，负值=向下滚动
    _scale: 1,       // 当前 scaleY（仅在越界时 >1）
    _origin: 'top center', // transform-origin：顶部下拉=top，底部上拉=bottom
    _indY: 0,        // 刷新指示器 translateY(px)，随拉伸在拉出空间里移动
    _indOpacity: 0,  // 刷新指示器透明度
    _refreshing: false,
    _spin: false
  },
  lifetimes: {
    created() {
      this._offset = 0;       // 与 data 同步的实时值
      this._velocity = 0;     // px/ms（向下为正）
      this._target = 0;       // spring 目标
      this._maxScroll = 0;    // 可滚动距离 = max(0, 内容高 - 视口高)
      this._dragging = false;
      this._moved = false;
      this._startY = 0;
      this._startOffset = 0;
      this._samples = [];     // 速度采样 {y, t}
      this._raf = null;       // 动画句柄（setTimeout）
      this._reduced = false;
      this._refreshing = false;
    },
    ready() {
      // 读取系统「减弱动态效果」偏好
      try {
        const sys = wx.getSystemSetting && wx.getSystemSetting();
        this._reduced = !!(sys && sys.reducedMotion === 'enable');
      } catch (e) { /* 老基础库无此 API，忽略 */ }
      this._measure();
    },
    detached() {
      if (this._raf) { clearTimeout(this._raf); this._raf = null; }
    }
  },
  methods: {
    /** 测量视口与内容高度，计算可滚动范围（content 的 transform 不影响 fields size） */
    _measure(cb) {
      const q = this.createSelectorQuery();
      q.select('.ss-viewport').fields({ size: true });
      q.select('.ss-content').fields({ size: true });
      q.exec((res) => {
        if (res && res[0] && res[1]) {
          this._viewportH = res[0].height;
          this._contentH = res[1].height;
          this._maxScroll = Math.max(0, this._contentH - this._viewportH);
        }
        if (typeof cb === 'function') cb();
      });
    },

    /** 外部（父组件）在内容高度变化后调用，重新测量并夹紧当前偏移 */
    resize() {
      this._measure(() => {
        const clamp = (v) => Math.max(-this._maxScroll, Math.min(0, v));
        if (this._offset > 0 || this._offset < -this._maxScroll) {
          this._offset = clamp(this._offset);
          this.setData({ _offset: this._offset });
        }
      });
    },

    /** 父组件刷新完成后调用：收起指示器 + 回弹归位 */
    finishRefresh() {
      this._refreshing = false;
      this._target = 0;
      this.setData({ _refreshing: false, _spin: false, _indOpacity: 0, _indY: 0 });
      this._startAnim();
    },

    onStart(e) {
      // 刷新进行中不再叠加拉伸（手势直接不接管）
      if (this._refreshing) return;
      if (this._raf) { clearTimeout(this._raf); this._raf = null; } // 打断正在播放的动画，保留 velocity → 可打断
      const t = e.touches[0];
      this._dragging = true;
      this._moved = false;
      this._startY = t.clientY;
      this._startOffset = this._offset;
      this._samples = [{ y: t.clientY, t: Date.now() }];
      // 手势起点即重新测量一次（内容可能已变化，如展开候选人列表）
      this._measure();
    },

    onMove(e) {
      if (!this._dragging || this._refreshing) return;
      if (e.touches.length > 1) { this._dragging = false; return; } // 多点触控取消拖拽
      const y = e.touches[0].clientY;
      const now = Date.now();
      const dy = y - this._startY;

      // 未达到阈值：视为 tap 候选，不跟手（保证子元素 bindtap 正常触发）
      if (!this._moved) {
        if (Math.abs(dy) < DRAG_THRESHOLD) return;
        this._moved = true;
        // 重新锚定，消除跨过阈值时的跳动
        this._startY = y;
        this._startOffset = this._offset;
        this._samples = [{ y, t: now }];
        return;
      }

      // 速度采样（取最近 ~50ms 窗口，抑制抖动）
      this._samples.push({ y, t: now });
      while (this._samples.length > 2 && now - this._samples[0].t > 50) this._samples.shift();
      const s0 = this._samples[0];
      const sN = this._samples[this._samples.length - 1];
      const dtm = sN.t - s0.t;
      if (dtm > 0) this._velocity = (sN.y - s0.y) / dtm; // px/ms

      // 1:1 跟手；越界则橡皮筋（带 0.6× 内容阻尼）
      const raw = this._startOffset + (y - this._startY);
      let off = raw;
      let origin = 'top center';
      if (raw > 0) {
        // 顶部下拉：内容位移 = rubber(0.6×手指)，scaleY 轻微拉伸（origin top）
        off = this._reduced ? 0 : rubber(raw * CONTENT_DAMP);
        origin = 'top center';
      } else if (raw < -this._maxScroll) {
        // 底部上拉：内容位移 = -maxScroll + rubber(0.6×越界)，scaleY 拉伸（origin bottom）
        off = this._reduced ? -this._maxScroll : (-this._maxScroll + rubber((raw + this._maxScroll) * CONTENT_DAMP));
        origin = 'bottom center';
      }
      this._applyTransform(off, origin);
    },

    /** 把 offset 同步成 transform 数据（translateY + scaleY + 指示器位置），只动 transform */
    _applyTransform(off, origin) {
      this._offset = off;
      const stretch = Math.min(Math.abs(off) / RUBBER_MAX, 1);
      const scale = 1 + stretch * SCALE_MAX;
      // 指示器只在顶部下拉时出现，随拉伸在拉出空间里移动（transform，无跳变）
      const indY = off > 0 ? (off * 0.6 - 14) : 0;
      const indOpacity = off > 0 ? Math.min(off / REFRESH_PX, 1) : 0;
      this.setData({
        _offset: off,
        _scale: scale,
        _origin: origin || 'top center',
        _indY: this._refreshing ? (REFRESH_PX * 0.6 - 14) : indY,
        _indOpacity: this._refreshing ? 1 : indOpacity
      });
    },

    onEnd() {
      if (!this._dragging) return;
      this._dragging = false;
      if (!this._moved) return; // 没拖动过 = tap，不触发任何动画

      const clamp = (v) => Math.max(-this._maxScroll, Math.min(0, v));

      // 降级：直接吸附到边界，无惯性/橡皮筋/拉伸
      if (this._reduced) {
        const t = clamp(this._offset);
        this._offset = t; this._velocity = 0; this._target = t;
        this.setData({ _offset: t, _scale: 1, _indY: 0, _indOpacity: 0 });
        return;
      }

      // 顶部下拉过刷新阈值 → 进入 refreshing（仅当开启了 refreshable）
      if (this.data.refreshable && this._offset > 0 && this._offset >= REFRESH_PX) {
        this._refreshing = true;
        this._target = REFRESH_PX; // 保持在刷新高度，露出指示器
        this.setData({ _refreshing: true, _spin: true, _indOpacity: 1, _indY: REFRESH_PX * 0.6 - 14 });
        this._startAnim();
        this.triggerEvent('refresh');
        return;
      }

      // 惯性投影：用松手瞬间的真实速度决定滑行终点，再由 spring 从当前点带速收敛
      const projection = this._velocity * MOMENTUM_MS;
      this._target = clamp(this._offset + projection);
      this._startAnim();
    },

    /** spring-damper 积分（半隐式欧拉），初速度 = 松手真实速度 → 自带 momentum */
    _startAnim() {
      if (this._raf) clearTimeout(this._raf);
      let last = Date.now();
      const tick = () => {
        const now = Date.now();
        let dt = (now - last) / 1000;
        last = now;
        if (dt <= 0) { this._raf = setTimeout(tick, 16); return; }
        if (dt > 0.032) dt = 0.032; // 卡顿保护

        const Fspring = -STIFFNESS * (this._offset - this._target);
        const Fdamp = -DAMPING * this._velocity;
        const a = (Fspring + Fdamp) / MASS;
        this._velocity += a * dt;
        this._offset += this._velocity * dt;

        // 收敛判定：速度与位移都足够小 → 吸附并停止
        if (Math.abs(this._velocity) < 0.02 && Math.abs(this._offset - this._target) < 0.5) {
          this._offset = this._target;
          this._velocity = 0;
          // 回弹归位时清掉 scaleY / 指示器
          const finalScale = this._target === 0 ? 1 : (1 + Math.min(Math.abs(this._target) / RUBBER_MAX, 1) * SCALE_MAX);
          this.setData({ _offset: this._offset, _scale: finalScale, _indY: 0, _indOpacity: 0 });
          this._raf = null;
          return;
        }
        // 动画中保持 scaleY 跟随（仅越界时 >1）+ 指示器位置
        const stretch = Math.min(Math.abs(this._offset) / RUBBER_MAX, 1);
        const scale = 1 + stretch * SCALE_MAX;
        const indY = this._offset > 0 ? (this._offset * 0.6 - 14) : 0;
        const indOpacity = this._offset > 0 ? Math.min(this._offset / REFRESH_PX, 1) : (this._refreshing ? 1 : 0);
        this.setData({ _offset: this._offset, _scale: scale, _indY: indY, _indOpacity: indOpacity });
        this._raf = setTimeout(tick, 16);
      };
      this._raf = setTimeout(tick, 16);
    }
  }
});
