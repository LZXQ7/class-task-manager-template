/**
 * 在线文档 web-view
 * 从通知页点击在线文档链接跳转而来。
 * 注意：web-view 只能打开已在小程序后台「业务域名」中配置白名单的 https 链接，
 * 未配置的域名会加载失败，此时提供复制链接兜底。
 */
const util = require('../../utils/util');

Page({
  data: {
    url: '',
    failed: false
  },

  onLoad(options) {
    const raw = String((options && options.url) || '');
    let url = '';
    try { url = decodeURIComponent(raw); } catch (e) { url = raw; }
    if (!url || !/^https:\/\//i.test(url)) {
      this.setData({ failed: true });
      return;
    }
    this.setData({ url });
  },

  onError() {
    this.setData({ failed: true });
  },

  onCopy() {
    const url = this.data.url;
    if (!url) return;
    wx.setClipboardData({ data: url, success: () => util.toast('链接已复制，可在浏览器打开') });
  },

  onBack() {
    wx.navigateBack({ delta: 1 });
  }
});
