Component({
  options: { addGlobalClass: true, multipleSlots: true },
  properties: {
    title: { type: String, value: '' },
    showBack: { type: Boolean, value: false },
    showHome: { type: Boolean, value: false },
    delta: { type: Number, value: 1 },
    customBack: { type: Boolean, value: false },   // true：交给页面 bind:back 处理
    /** 导航底色：默认是**半透明**的玻璃白（v0.7.17），模糊与亮边由 .nav 的类承担
     *（inline style 只能给颜色，给不了 backdrop-filter）。需要实心底的页面仍可显式传值覆盖。 */
    bg: { type: String, value: 'rgba(255, 255, 255, 0.50)' },
    color: { type: String, value: '#1D2129' },
    border: { type: Boolean, value: false },
    /** 默认固定：所有页面顶栏不随内容滚动（2026-09-25 用户要求）。特殊页面可显式传 fixed="{{false}}" 关闭 */
    fixed: { type: Boolean, value: true },
    /**
     * 是否渲染「把正文顶下来」的占位块。
     * ⚠️ 只有 fixed=true 时才真的渲染（见 index.wxml）——fixed=false 时 nav 本来就在文档流里，
     * 再渲染占位块会让正文被顶两倍导航高度（notice/poster/bind 三页踩过）。
     */
    placeholder: { type: Boolean, value: true }
  },
  data: {
    statusBarHeight: 20,
    padRight: 0            // 右侧插槽避让微信胶囊按钮的像素宽度
  },
  lifetimes: {
    /**
     * 度量不在这里自己算 —— 统一走 `app.navMetrics()`（惰性算一次 + 全局缓存）。
     * 原实现在每个实例的 attached 里调 `wx.getMenuButtonBoundingClientRect()` +
     * `wx.getWindowInfo()`：两次**同步跨线程调用**，且回调里必 `setData` 一次
     * → 每开一个二级页都白付一次，表现为「点进去先卡一下」。
     */
    attached() {
      const app = getApp && getApp();
      const m = (app && app.navMetrics)
        ? app.navMetrics()
        : { statusBarHeight: 20, padRight: 0 };
      // 值没变就不 setData，省掉一次无意义的二次渲染
      if (m.statusBarHeight === this.data.statusBarHeight &&
          m.padRight === this.data.padRight) return;
      this.setData({ statusBarHeight: m.statusBarHeight, padRight: m.padRight });
    }
  },
  methods: {
    onBack() {
      if (this.data.customBack) {
        this.triggerEvent('back');
        return;
      }
      const pages = getCurrentPages();
      if (pages.length > 1) {
        wx.navigateBack({ delta: this.data.delta });
      } else {
        wx.switchTab({ url: '/pages/home/index' });
      }
    },
    onHome() {
      wx.switchTab({ url: '/pages/home/index' });
    }
  }
});
