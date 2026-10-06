const popupAnim = require('../popup-anim');

Component({
  options: { addGlobalClass: true, multipleSlots: true },
  behaviors: [popupAnim],
  properties: {
    // observer 必须留在组件里（见 popup-anim.js 顶部说明）
    show: { type: Boolean, value: false, observer(nv) { this.animSync(nv); } },
    title: { type: String, value: '提示' },
    content: { type: String, value: '' },
    icon: { type: String, value: '' },        // warn | info | 空
    iconVariant: { type: String, value: 'orange' },
    cancelText: { type: String, value: '取消' },
    confirmText: { type: String, value: '确定' },
    confirmColor: { type: String, value: '#3370FF' },
    showCancel: { type: Boolean, value: true },
    maskClose: { type: Boolean, value: false }
  },
  methods: {
    onMask() {
      if (this.data.maskClose) this.triggerEvent('close');
    },
    onCancel() {
      this.triggerEvent('cancel');
      this.triggerEvent('close');
    },
    onConfirm() {
      this.triggerEvent('confirm');
    },
    noop() {}
  }
});
