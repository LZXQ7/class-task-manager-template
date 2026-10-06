const util = require('../../utils/util');

// C14 姓名牌：底 #F0F5FF，字 #3370FF；停用：底 #F2F3F5，字 #C9CDD4
const FS_MAP = {
  48: 22,   // 24px 叠放
  56: 24,   // 28px
  64: 26,   // 32px 列表
  72: 30,   // 36px 选人
  80: 32    // 40px 我的 / 详情
};

Component({
  options: { addGlobalClass: true },
  properties: {
    name: { type: String, value: '' },
    text: { type: String, value: '' },      // 指定后直接显示该文本（如值日序号），否则显示姓名首字
    noFallback: { type: Boolean, value: false }, // true：text 为空时显示占位符，而不是回落成「姓」
    src: { type: String, value: '' },       // 微信头像 URL：有值显示图片，加载失败/为空回落姓氏色块
    size: { type: Number, value: 64 },     // rpx
    disabled: { type: Boolean, value: false },
    ring: { type: Boolean, value: false },  // 叠放白描边
    ringWidth: { type: Number, value: 3 },
    label: { type: Boolean, value: false },
    labelSize: { type: Number, value: 26 },
    labelColor: { type: String, value: '#1D2129' },
    sub: { type: String, value: '' }
  },
  data: {
    char: '',
    fs: 26,
    bg: '#F0F5FF',
    fg: '#3370FF',
    showImg: false   // src 有效且未加载失败时才显示图片
  },
  observers: {
    'name, text, size, disabled, noFallback, src': function () {
      this._calc();
    }
  },
  lifetimes: {
    attached() { this._calc(); }
  },
  methods: {
    _calc() {
      const s = Number(this.data.size) || 64;
      const t = String(this.data.text || '').trim();
      const base = FS_MAP[s] || Math.round(s * 0.42);
      // 计算值日序号的意义就是「一眼看到第几号」，所以字号给足，两位数字略缩
      const fs = !t ? base : (t.length >= 3 ? Math.round(base * 0.7) : (t.length === 2 ? Math.round(base * 0.88) : Math.round(base * 1.06)));
      this.setData({
        char: t || (this.data.noFallback ? '·' : util.firstChar(this.data.name)),
        fs,
        bg: this.data.disabled ? '#F2F3F5' : '#F0F5FF',
        fg: this.data.disabled ? '#C9CDD4' : '#3370FF',
        // 换 src（或复用组件实例）时重置回落标记；空 src 直接用色块
        showImg: !!String(this.data.src || '').trim()
      });
    },
    /** 头像图片 404 / 加载失败：回落成姓氏色块，页面不留破图 */
    _onImgError() {
      this.setData({ showImg: false });
    }
  }
});
