Component({
  options: { addGlobalClass: true },
  properties: {
    type: { type: String, value: 'warning' },  // warning | danger | info
    icon: { type: String, value: 'bell' },
    text: { type: String, value: '' },
    btnText: { type: String, value: '' },
    closable: { type: Boolean, value: false }
  },
  data: {
    bg: '#FFF7E8',
    color: '#D46B08',
    iconColor: '#FF7D00',
    variant: 'orange'
  },
  observers: {
    'type': function (type) {
      const map = {
        warning: { bg: '#FFF7E8', color: '#D46B08', iconColor: '#FF7D00', variant: 'orange' },
        danger: { bg: '#FFECE8', color: '#CF1322', iconColor: '#F53F3F', variant: 'red' },
        info: { bg: '#F0F5FF', color: '#245BDB', iconColor: '#3370FF', variant: 'brand' }
      };
      this.setData(map[type] || map.warning);
    }
  },
  lifetimes: {
    attached() {
      this.setData({
        bg: this.data.bg, color: this.data.color, iconColor: this.data.iconColor
      });
    }
  },
  methods: {
    onBtn() { this.triggerEvent('action'); },
    onClose() { this.triggerEvent('close'); }
  }
});
