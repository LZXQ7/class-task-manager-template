/**
 * C9 值日详情弹层（P2 / P4 共用）
 * 展示值日信息 + 操作；内置换班 / 请假申请（P7.1 能力内联）
 * 本工具只做值日提醒，不含打卡与照片凭证。
 *
 * v0.7.32：**外壳并入 components/bottom-sheet**（下拉关闭 / grabber / 遮罩联动 / 开合两帧动画
 * 全在那边）——本组件不再自带 popup-anim，也不再有 .ds-root/.ds-mask/.ds-panel；
 * `show` 原样透传给 bottom-sheet，关闭动画由它负责「先播完再卸载」。
 * 原来的 spring-scroll 也换成了 bottom-sheet 的 scroll-view（同一套滚动实现，全站一致）。
 */
const api = require('../../utils/api');
const util = require('../../utils/util');

const REASONS = [
  { key: 'COURSE', text: '有课冲突' },
  { key: 'SICK', text: '身体不适' },
  { key: 'INTERN', text: '实习外出' },
  { key: 'OTHER', text: '其他' }
];

const ACTION_TEXT = {
  CONFIRM: '确认完成',
  UNDO: '撤销完成',
  SWAP_OUT: '换出',
  SWAP_IN: '换入',
  REASSIGN: '换人',
  LEAVE: '请假',
  MANUAL: '手动添加',
  REMOVE: '移除'
};

Component({
  options: { addGlobalClass: true, multipleSlots: true },
  properties: {
    show: { type: Boolean, value: false },
    dutyId: { type: Number, value: 0 },
    week: { type: Number, value: 0 }
  },
  data: {
    /** 面板高度（rpx）= 78vh —— 并入前这里写死 78vh，换算过来保持一致 */
    sheetH: 0,
    /** 是否需要底部操作条（决定 bottom-sheet 的 footer 具名 slot 是否渲染） */
    showFoot: false,
    loading: false,
    detail: null,
    isAdmin: false,
    isSuper: false,
    mineActs: false,        // 本人可发起请假 / 换班
    canAct: false,          // 底部操作区是否出现
    /* 换班 / 请假 */
    adjusting: '',          // '' | 'SWAP' | 'LEAVE' | 'REASSIGN'
    candidates: [],
    toMemberId: 0,
    reason: 'OTHER',
    reasons: REASONS,
    startDate: '',
    endDate: '',
    submitting: false
  },
  observers: {
    'show, dutyId': function (show, dutyId) {
      if (show && dutyId) this._load(dutyId);
      if (!show) {
        this.setData({ adjusting: '', candidates: [], toMemberId: 0 });
      }
    },
    /* 底部操作条有无：三种形态（可操作 / 还原换人 / 调整中）全靠它决定 footer 是否渲染 */
    'canAct, adjusting, detail': function (canAct, adjusting, detail) {
      const need = !!(canAct || adjusting || (detail && detail.reassign));
      if (need !== this.data.showFoot) this.setData({ showFoot: need });
    }
  },
  lifetimes: {
    attached() {
      const app = getApp && getApp();
      const g = (app && app.globalData) || {};
      const ww = g.windowWidth || 375;
      const wh = g.windowHeight || 812;
      // rpx = px * 750 / 视口宽 → 78vh 的 rpx 值（并入前是 CSS 里的 78vh，这里显式换算保持同高）
      this.setData({ sheetH: Math.round(wh * 0.78 * 750 / ww) });
    }
  },
  methods: {
    _load(dutyId) {
      this.setData({ loading: true, detail: null });
      const app = getApp();
      api.dutyDetail({ dutyId }, { toast: false })
        .then((d) => {
          this._decorate(d);
          const isSuper = !!(app && app.isSuper && app.isSuper());
          const mineActs = !!(d && d.duty && d.duty.isMine &&
            ['PENDING', 'ONGOING', 'EXPIRED'].indexOf(d.duty.status) >= 0);
          this.setData({
            loading: false,
            detail: d,
            isAdmin: !!(app && app.isAdmin && app.isAdmin()),
            isSuper,
            mineActs,
            canAct: mineActs || isSuper,
            startDate: d && d.duty ? d.duty.classDate : '',
            endDate: d && d.duty ? d.duty.classDate : ''
          });
        })
        .catch(() => {
          this.setData({ loading: false });
          this.triggerEvent('close');
        });
    },

    _decorate(d) {
      if (!d || !d.duty) return;
      const duty = d.duty;
      const p = String(duty.classDate || '').split('-');
      if (p.length >= 3) {
        duty.dateText = Number(p[1]) + '月' + Number(p[2]) + '日';
      } else {
        duty.dateText = String(duty.classDate || '');
      }
      const WD = ['一', '二', '三', '四', '五', '六', '日'];
      duty.weekdayText = WD[Number(duty.dayOfWeek) - 1] || '';
      // 姓名牌统一显示「序号」（= 学号后两位），与值日页一致
      duty.seqText = duty.seq ? String(duty.seq) : '·';
      // 保洁课次（kind='CLEAN'）显示「18点前」，其它课次显示「第 N 节」
      duty.whenText = util.whenText(duty.kind, duty.period);
      d.peers = (d.peers || []).map(x => Object.assign({}, x, {
        seqText: x.seq ? String(x.seq) : '·'
      }));
    },

    _decorateCandidates(list) {
      return (list || []).map(x => Object.assign({}, x, {
        seqText: x.seq ? String(x.seq) : '·'
      }));
    },

    onClose() { this.triggerEvent('close'); },

    /* ---------- 操作 ---------- */
    onRemoveDuty() {
      const d = this.data.detail && this.data.detail.duty;
      if (!d) return;
      util.confirm('取消后该值日将从本周排班中移除', '取消值日').then(ok => {
        if (!ok) return;
        api.scheduleRemove({ dutyId: d.id }, { loading: '处理中' })
          .then(() => {
            util.toast('已取消');
            this.triggerEvent('changed');
            this.triggerEvent('close');
          })
          .catch(() => {});
      });
    },

    /* ---------- 换班 / 请假 / 换人 ---------- */
    onAdjust(e) {
      const type = String(e.currentTarget.dataset.type);
      const d = this.data.detail && this.data.detail.duty;
      if (!d) return;
      if (type === 'SWAP' || type === 'REASSIGN' || type === 'ADD') {
        api.swapCandidates({ dutyId: d.id }, { loading: '加载中' })
          .then((list) => {
            this.setData({ adjusting: type, candidates: this._decorateCandidates(list), toMemberId: 0 });
          })
          .catch(() => {});
      } else {
        this.setData({ adjusting: type });
      }
    },

    onPickTo(e) {
      this.setData({ toMemberId: Number(e.currentTarget.dataset.id) });
    },

    onReason(e) {
      this.setData({ reason: String(e.currentTarget.dataset.key) });
    },

    onDate(e) {
      const field = String(e.currentTarget.dataset.field);
      this.setData({ [field]: e.detail.value });
    },

    onCancelAdjust() {
      this.setData({ adjusting: '', candidates: [], toMemberId: 0 });
    },

    onSubmitAdjust() {
      const d = this.data.detail && this.data.detail.duty;
      if (!d || this.data.submitting) return;
      const type = this.data.adjusting;
      this.setData({ submitting: true });
      let p;
      if (type === 'SWAP') {
        if (!this.data.toMemberId) {
          this.setData({ submitting: false });
          util.toast('请选择换给哪位同学');
          return;
        }
        p = api.applySwap({ dutyId: d.id, toMemberId: this.data.toMemberId, reason: this.data.reason });
      } else if (type === 'LEAVE') {
        p = api.applyLeave({
          dutyIds: [d.id],
          startDate: this.data.startDate,
          endDate: this.data.endDate,
          reason: this.data.reason
        });
      } else if (type === 'ADD') {
        if (!this.data.toMemberId) {
          this.setData({ submitting: false });
          util.toast('请选择要添加的同学');
          return;
        }
        p = api.scheduleAddManual({ sessionId: d.sessionId, week: this.data.week, memberId: this.data.toMemberId });
      } else {
        if (!this.data.toMemberId) {
          this.setData({ submitting: false });
          util.toast('请选择替补同学');
          return;
        }
        p = api.scheduleReassign({ dutyId: d.id, toMemberId: this.data.toMemberId });
      }
      p.then((res) => {
        this.setData({ submitting: false, adjusting: '' });
        // REASSIGN / 超管直接换人：原地替换、无需对方确认；普通成员 SWAP 才提示「等待确认」
        const direct = res && res.direct;
        util.toast({
          LEAVE: '请假已提交',
          ADD: '已添加值日',
          REASSIGN: '已替换值日人',
          SWAP: direct ? '已替换值日人' : '已提交，等待生活委员确认'
        }[type] || '已提交');
        this._load(d.id);
        this.triggerEvent('changed');
      }).catch(() => {
        this.setData({ submitting: false });
      });
    },

    /**
     * 还原换人：把这条（被换上来的）值日还给原来的同学。
     * 后端 reassignUndo 会恢复原值日、删掉换上来那条、并把双方 duty_count 回滚。
     */
    onUndoReassign() {
      const d = this.data.detail && this.data.detail.duty;
      const r = this.data.detail && this.data.detail.reassign;
      if (!d || !r) return;
      util.confirm('将还原为原来的值日同学：' + r.fromName + '，当前的替补会被移出这次值日。', '还原换人').then((ok) => {
        if (!ok) return;
        api.scheduleReassignUndo({ reassignId: r.reassignId }, { loading: '处理中' })
          .then(() => {
            util.toast('已还原');
            this.triggerEvent('changed');
            this.triggerEvent('close');
          })
          .catch(() => {});
      });
    },

    actionText(a) { return ACTION_TEXT[a] || a; }
  }
});
