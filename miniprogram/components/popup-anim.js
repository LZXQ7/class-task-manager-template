/**
 * 弹层开合动画（Behavior）
 * ------------------------------------------------------------
 * 起因（2026-09-25 用户反馈）：「这种弹出式小窗现在都是瞬间打开，太僵硬了，需要添加展开动画」。
 *
 * 根因：原来三个弹层都是
 *     <view wx:if="{{show}}">
 *       <view class="mask {{show ? 'in' : ''}}">
 *       <view class="panel {{show ? 'up' : ''}}">
 * `wx:if` 在 show 变 true 的那一刻才创建节点，而创建时 `.in` / `.up` **已经**在 class 里了 ——
 * 浏览器只看到「元素从不存在 → 直接是终态」这一次布局，没有起始态，CSS transition 不会执行。
 * 表现就是遮罩和面板「啪」地出现（也就是用户说的瞬间打开）。
 *
 * 修法：把「挂载」与「激活」拆成两帧。
 *   · 开：mounted=true（节点入 DOM，此时**不带**动画类，处在起始态）
 *         → 下一帧 active=true（加动画类，transition 有起始态可过渡）
 *   · 关：active=false（过渡回起始态）→ 等动画时长后再 mounted=false 卸载节点
 * 于是「关」也有动画，而不是直接消失。
 *
 * 用法（组件里必须自己保留 `show` 属性，只把 observer 接过来 —— 不要在本 behavior 里
 * 重新声明 show，否则组件自身的声明会覆盖掉 observer，动画静默失效）：
 *
 *   const popupAnim = require('../popup-anim');
 *   Component({
 *     behaviors: [popupAnim],
 *     properties: {
 *       show: { type: Boolean, value: false, observer(nv) { this.animSync(nv); } }
 *     }
 *   });
 *
 *   <!-- 节点用 mounted；动画类用 active -->
 *   <view wx:if="{{mounted}}" class="sheet-root">
 *     <view class="sheet-mask {{active ? 'in' : ''}}"></view>
 *     <view class="sheet-panel {{active ? 'up' : ''}}"></view>
 *   </view>
 *
 * 时长常量与三个组件的 CSS 过渡时长保持一致（240ms），改一处要改另一处。
 */
const DURATION = 240;

module.exports = Behavior({
  data: {
    /** 节点是否在 DOM 里（决定 wx:if） */
    mounted: false,
    /** 是否已到「终态」（决定 .in / .up 动画类） */
    active: false
  },

  lifetimes: {
    detached() {
      if (this._popupAnimTimer) {
        clearTimeout(this._popupAnimTimer);
        this._popupAnimTimer = null;
      }
    }
  },

  methods: {
    /** 由组件的 show observer 调用 */
    animSync(show) {
      if (this._popupAnimTimer) {
        clearTimeout(this._popupAnimTimer);
        this._popupAnimTimer = null;
      }
      if (show) {
        // 已经在场（比如连续两次 setData true）就只确保 active，不要重复触发
        if (this.data.mounted && this.data.active) return;
        this.setData({ mounted: true, active: false }, () => {
          // 下一帧再加动画类：setData 回调时视图层已完成本次渲染，
          // 起始态已经落到 DOM 上，这一帧加类才会产生过渡
          this._popupAnimTimer = setTimeout(() => {
            this._popupAnimTimer = null;
            this.setData({ active: true });
          }, 20);
        });
        return;
      }
      if (!this.data.mounted) return;
      this.setData({ active: false });
      this._popupAnimTimer = setTimeout(() => {
        this._popupAnimTimer = null;
        this.setData({ mounted: false });
      }, DURATION);
    }
  }
});
