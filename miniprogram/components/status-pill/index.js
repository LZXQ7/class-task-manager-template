const util = require('../../utils/util');

Component({
  options: { addGlobalClass: true },
  properties: {
    status: { type: String, value: 'PENDING' },
    text: { type: String, value: '' },
    size: { type: String, value: 'md' },   // sm | md
    solid: { type: Boolean, value: false }
  },
  data: {
    label: '',
    fg: '#86909C',
    bg: '#F2F3F5'
  },
  observers: {
    'status, text': function (status, text) {
      const s = util.dutyStatus(status);
      this.setData({
        label: text || s.text,
        fg: this.data.solid ? '#FFFFFF' : s.color,
        bg: this.data.solid ? s.color : s.bg
      });
    }
  },
  lifetimes: {
    attached() {
      const s = util.dutyStatus(this.data.status);
      this.setData({
        label: this.data.text || s.text,
        fg: this.data.solid ? '#FFFFFF' : s.color,
        bg: this.data.solid ? s.color : s.bg
      });
    }
  }
});
