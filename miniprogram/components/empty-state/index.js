Component({
  options: { addGlobalClass: true, multipleSlots: true },
  properties: {
    icon: { type: String, value: 'empty-box' },   // empty-box | cloud-off | search-empty
    title: { type: String, value: '暂无数据' },
    desc: { type: String, value: '' },
    btnText: { type: String, value: '' },
    size: { type: Number, value: 160 },
    padding: { type: Number, value: 80 }
  },
  methods: {
    onTap() {
      this.triggerEvent('action');
    }
  }
});
