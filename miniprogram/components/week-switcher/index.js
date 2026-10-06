const util = require('../../utils/util');

/**
 * C15 · 周切换条（P3 / P4 / P5 共用）
 * 左箭头 32×32（x=16）｜右箭头（距右 16）｜中间可点：日期区间 + 第 N 周 · 单/双周
 */
Component({
  options: { addGlobalClass: true },
  properties: {
    week: { type: Number, value: 1 },
    total: { type: Number, value: 18 },
    current: { type: Number, value: 1 },
    termStart: { type: String, value: '' },
    statusText: { type: String, value: '' },
    statusType: { type: String, value: '' },   // draft | published | archived
    locked: { type: Boolean, value: false }
  },
  data: {
    rangeText: '',
    oddText: '',
    isCurrent: false
  },
  observers: {
    'week, termStart': function () {
      this._calc();
    }
  },
  lifetimes: { attached() { this._calc(); } },
  methods: {
    _calc() {
      const wk = Number(this.data.week) || 1;
      const start = util.dateOfWeekDay(this.data.termStart, wk, 1);
      const end = util.dateOfWeekDay(this.data.termStart, wk, 7);
      this.setData({
        rangeText: (start && end) ? (util.md(start) + ' - ' + util.md(end)) : ('第 ' + wk + ' 周'),
        oddText: '第 ' + wk + ' 周 · ' + (wk % 2 === 1 ? '单周' : '双周'),
        isCurrent: Number(this.data.current) === wk
      });
    },
    onPrev() {
      if (this.data.locked) return;
      this.triggerEvent('change', { week: Number(this.data.week) - 1 });
    },
    onNext() {
      if (this.data.locked) return;
      this.triggerEvent('change', { week: Number(this.data.week) + 1 });
    },
    onPick() {
      this.triggerEvent('pick', { week: Number(this.data.week) });
    }
  }
});
