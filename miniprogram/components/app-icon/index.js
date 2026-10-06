const { get } = require('../../utils/icons');

Component({
  options: { addGlobalClass: true },
  properties: {
    name: { type: String, value: '' },
    variant: { type: String, value: '' },
    size: { type: Number, value: 48 },      // rpx
    useCloud: { type: Boolean, value: true } // true=云存储统一引用，失败自动降级为内联
  },
  data: {
    src: '',
    fallback: ''
  },
  observers: {
    /**
     * ⚠️ 必须用回调参数，**不能**在这里读 `this.data`。
     * 属性监听器触发时 this.data 可能还是上一次的旧值，于是 _resolve 会算出旧的 src、
     * setData 成同一个字符串 → 视觉上「图标不变」，而同一次渲染里的文字/样式却已经更新了。
     * 曾经的 bug 表现：底部 tabBar 切到「我的」后，首页文字变灰了，首页图标却还是高亮的。
     */
    'name, variant, useCloud': function (name, variant, useCloud) {
      this._resolve(name, variant, useCloud);
    }
  },
  lifetimes: {
    attached() { this._resolve(); }
  },
  methods: {
    /** 优先用传入值（监听器回调参数），没传（attached）才回落到 this.data */
    _resolve(name, variant, useCloud) {
      const n = name === undefined ? this.data.name : name;
      const v = variant === undefined ? this.data.variant : variant;
      const uc = useCloud === undefined ? this.data.useCloud : useCloud;
      const item = get(n, v);
      if (!item) {
        this.setData({ src: '', fallback: '' });
        return;
      }
      const src = uc ? item.cloud : item.data;
      // 两个字段都没变就不 setData，省掉一次无意义的渲染
      if (src === this.data.src && item.data === this.data.fallback) return;
      this.setData({ src, fallback: item.data });
    },
    onError() {
      // 云存储取不到时降级为内联 base64（图标源本就一起打包在小程序里）
      if (this.data.fallback && this.data.src !== this.data.fallback) {
        this.setData({ src: this.data.fallback });
      }
    }
  }
});
