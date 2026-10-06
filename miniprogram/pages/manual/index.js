/**
 * P5 · 手动排班（超级管理员，全屏非 Tab）
 * ------------------------------------------------------------
 * 与值日页（P4）的分工：
 *   P4 是「看结果」——只列出已有值日的课次；
 *   P5 是「改结果」——列出本周**全部课次**（含尚无值日的空课次），
 *   可以直接把某个同学安排到某节课值日，也能换人 / 移除 / 发布。
 *
 * 硬规则（分组课只在对应组、同一天不重复、请假不排）由云函数强制校验，
 * 这里只做「不可选」的前置提示，避免用户白点。
 */
const api = require('../../utils/api');
const util = require('../../utils/util');
const mem = require('../../utils/mem');
const swipe = require('../../utils/swipe');

Page({
  data: {
    statusBarHeight: 20,
    loading: true,
    failed: false,

    week: 1,
    totalWeeks: 16,
    current: 1,
    termStart: '',
    published: false,

    days: [],
    stats: { total: 0, people: 0, sessions: 0 },
    busy: false,

    /** 左右滑动切周的方向性动画 class：由 utils/swipe.js 下发，写进数据区容器 */
    swipeCls: '',

    /* 选人弹层 */
    pickerShow: false,
    pickerTitle: '',
    pickerMode: 'ADD',        // ADD | REASSIGN
    pickerSession: null,
    pickerDutyId: 0,
    pickerCount: 0,
    kw: '',
    list: [],
    submitting: false
  },

  onLoad() {
    const app = getApp();
    const cfg = app.globalData.config || {};
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight || 20,
      termStart: cfg.termStart || '',
      totalWeeks: cfg.totalWeeks || 16,
      current: cfg.currentWeek || 1,
      week: cfg.currentWeek || 1
    });
  },

  onUnload() {
    // 二级页返回即销毁：切周动画的定时器还在跑就会对已销毁实例 setData
    swipe.cancel(this);
  },

  onShow() {
    const app = getApp();
    // 登录是异步的：首屏可能还没拿到身份。等就绪后再拉，避免被 40001 打回。
    // 只在 onShow 里拉一次（onLoad 不拉），否则冷启动会重复请求。
    const run = () => this.load();
    if (app && app.globalData && !app.globalData.authChecked) app.ready().then(run);
    else run();
  },

  /** 缓存键：统一由 utils/mem 的 keys 构造（与 app 后台预热同源） */
  _memKey() { return mem.keys.manual(this.data.week); },

  /** 值日表即将被改动 → 作废「值日页 + 手动排班页」的缓存（见 utils/mem） */
  _invalidateDuty() { mem.invalidateSchedule(this.data.week); },

  load() {
    /*
     * 二级页 navigateBack 后就被销毁了，所以「上次的内容」只能从内存缓存拿。
     * 命中就先渲染出来 —— 再进这一页时不必再等一次（很可能正在冷启动的）云函数，
     * 也就没有了「点进去先卡一下、先白一片」。
     * 缓存缺失（首次进入 / 换周）才真的显示骨架。
     */
    const key = this._memKey();
    const cached = mem.read(key);
    const hasContent = !!cached;
    if (hasContent) this._paint(cached);
    else this.setData({ loading: true, failed: false });

    api.scheduleManualBoard({ week: this.data.week }, { toast: false })
      .then((r) => {
        mem.write(key, r);
        this._paint(r);
      })
      .catch((e) => {
        this.setData({ loading: false, failed: !hasContent });
        // 这里是超管**改数据**的地方：即便屏幕上还有上次的内容，也要明说刷新失败，
        // 免得他对着旧名单做操作。
        util.toast(this._errText(e));
      });
  },

  /** 把服务端返回的名单铺到界面上（首次拉取与缓存命中共用） */
  _paint(r) {
    this.setData({
      loading: false,
      failed: false,
      published: !!(r && r.published),
      days: this._decorateDays((r && r.days) || []),
      roster: (r && r.roster) || [],
      stats: (r && r.stats) || { total: 0, people: 0, sessions: 0 }
    });
  },

  _decorateDays(days) {
    return (days || []).map(d => Object.assign({}, d, {
      weekdayText: util.weekdayCn(d.weekday),
      dateText: util.md(d.date),
      sessions: (d.sessions || []).map(s => {
        const members = (s.members || []).map(m => Object.assign({}, m, {
          seqText: m.seq ? String(m.seq) : '·'
        }));
        return Object.assign({}, s, {
          members,
          // 保洁课次（kind='CLEAN'）显示「18点前」，其它课次显示「第 N 节」
          whenText: util.whenText(s.kind, s.period),
          full: members.length >= (s.dutyCount || 1),
          countText: members.length + '/' + (s.dutyCount || 1)
        });
      })
    }));
  },

  onWeekChange(e) {
    const wk = Number(e.detail.week);
    if (wk < 1 || wk > this.data.totalWeeks) return;
    const delta = wk - Number(this.data.week);
    if (!delta) return;
    /*
     * 换周统一带方向性动画（滑动 / 点箭头 / 周次选择器同一条路，见 utils/swipe.js）：
     * 先让旧内容朝手指方向滑走 160ms，再换数据，新内容从反方向滑入。
     * 越界（第 1 周还往右滑 / 最后一周还往左滑）由 shift 拦下，只播回弹、不换数据。
     */
    swipe.shift(this, delta, (w) => this._applyWeek(w));
  },

  /** 真正换周（动画 out 段结束后才被回调） */
  _applyWeek(wk) {
    this.setData({ week: wk });
    this.load();
  },

  /** 左右滑动切周（左滑 = 下一周，右滑 = 上一周）。与箭头按钮同一条路径。 */
  _shiftWeek(delta) {
    this.onWeekChange({ detail: { week: Number(this.data.week) + delta } });
  },
  onSwipeStart(e) { swipe.begin(this, e); },
  onSwipeEnd(e) {
    // 选人弹层的 DOM 就在页面根节点里，滑动会冒泡上来，必须挡掉
    if (this.data.pickerShow) return;
    const dir = swipe.end(this, e);
    if (dir === 'prev') this._shiftWeek(-1);
    else if (dir === 'next') this._shiftWeek(1);
  },

  /* ---------------- 选人 ---------------- */
  onAdd(e) {
    const ds = e.currentTarget.dataset;
    this._openPicker('ADD', ds.date, Number(ds.sid), 0);
  },

  onMemberTap(e) {
    const ds = e.currentTarget.dataset;
    const dutyId = Number(ds.dutyid);
    const that = this;
    wx.showActionSheet({
      itemList: ['换人', '移除值日'],
      success: (res) => {
        if (res.tapIndex === 0) that._openPicker('REASSIGN', ds.date, Number(ds.sid), dutyId);
        else if (res.tapIndex === 1) that._removeDuty(dutyId);
      },
      fail: () => {}
    });
  },

  _openPicker(mode, date, sessionId, dutyId) {
    const day = this.data.days.find(d => d.date === date);
    if (!day) return;
    const session = (day.sessions || []).find(s => s.sessionId === sessionId);
    if (!session) return;

    const busyIds = day.busyIds || [];
    const leaveIds = day.leaveIds || [];
    const inSession = {};
    (session.members || []).forEach(m => { inSession[m.memberId] = true; });

    // 换人时，原值日生即将被换出：不再算「已在此课次 / 当日占用」
    let outgoing = 0;
    if (mode === 'REASSIGN') {
      const cur = (session.members || []).find(m => m.dutyId === dutyId);
      outgoing = cur ? cur.memberId : 0;
    }

    const all = this.data.roster.map(r => {
      // 已在本课次的（含原值日生，换人时不能换成他自己）→ 不可选
      const inThis = !!inSession[r.id];
      const onLeave = leaveIds.indexOf(r.id) >= 0;
      const groupBad = !!(session.groupScope && r.groupTag !== session.groupScope);
      // 当天已有别的值日的（原值日生即将被换出，不再算占用）
      const sameDay = busyIds.indexOf(r.id) >= 0 && r.id !== outgoing;
      const disabled = inThis || onLeave || groupBad || sameDay;
      let badge = '';
      if (inThis) badge = '已在此课次';
      else if (onLeave) badge = '已请假';
      else if (groupBad) badge = '限 ' + session.groupScope + ' 组';
      else if (sameDay) badge = '当天已有值日';
      return Object.assign({}, r, {
        seqText: r.seq ? String(r.seq) : '·',
        disabled,
        badge,
        badgeBad: inThis || onLeave || groupBad
      });
    });

    this.pickerAll = all;
    this.setData({
      pickerShow: true,
      pickerMode: mode,
      pickerSession: session,
      pickerDutyId: dutyId,
      pickerCount: all.length,
      pickerTitle: (mode === 'REASSIGN' ? '换人' : '添加值日') + ' · ' + day.weekdayText + ' ' + util.whenText(session.kind, session.period),
      kw: '',
      submitting: false
    });
    this._filter();
  },

  onPickerKw(e) {
    this.setData({ kw: String(e.detail.value || '') });
    this._filter();
  },

  _filter() {
    const kw = String(this.data.kw || '').trim();
    const all = this.pickerAll || [];
    const list = kw
      ? all.filter(x => x.name.indexOf(kw) >= 0 || String(x.seq).indexOf(kw) === 0)
      : all;
    this.setData({ list });
  },

  onPickMember(e) {
    if (this.data.submitting) return;
    const id = Number(e.currentTarget.dataset.id);
    const item = (this.data.list || []).find(x => x.id === id);
    if (!item || item.disabled) {
      if (item && item.badge) util.toast(item.badge + '，不可选择');
      return;
    }
    this._submit(id);
  },

  onPickerClose() { this.setData({ pickerShow: false }); },
  onPickerClear() { this.setData({ kw: '' }); this._filter(); },

  _submit(memberId) {
    const session = this.data.pickerSession || {};
    const mode = this.data.pickerMode;
    this.setData({ submitting: true });
    this._invalidateDuty();
    const p = mode === 'REASSIGN'
      ? api.scheduleReassign({ dutyId: this.data.pickerDutyId, toMemberId: memberId })
      : api.scheduleAddManual({ sessionId: session.sessionId, week: this.data.week, memberId });
    p.then(() => {
      this.setData({ submitting: false, pickerShow: false });
      util.toast(mode === 'REASSIGN' ? '已换人' : '已安排值日');
      this.load();
    }).catch((e) => {
      this.setData({ submitting: false });
      util.toast(this._errText(e));
    });
  },

  _removeDuty(dutyId) {
    const that = this;
    util.confirm('移除后该同学不再负责这节值日', '移除值日').then(ok => {
      if (!ok) return;
      that._invalidateDuty();
      api.scheduleRemove({ dutyId }, { loading: '处理中' })
        .then(() => { util.toast('已移除'); that.load(); })
        .catch((e) => util.toast(that._errText(e)));
    });
  },

  /* ---------------- 发布 ---------------- */
  onPublish() {
    if (this.data.busy) return;
    const that = this;
    this.setData({ busy: true });
    this._invalidateDuty();
    api.schedulePublish({ week: this.data.week }, { loading: '发布中' })
      .then(() => { that.setData({ busy: false }); util.toast('本周值日已发布'); that.load(); })
      .catch((e) => { that.setData({ busy: false }); util.toast(that._errText(e)); });
  },

  onUnpublish() {
    if (this.data.busy) return;
    const that = this;
    util.confirm('撤回后班级将暂时看不到本周值日', '撤回发布').then(ok => {
      if (!ok) return;
      that.setData({ busy: true });
      that._invalidateDuty();
      api.scheduleUnpublish({ week: that.data.week }, { loading: '处理中' })
        .then(() => { that.setData({ busy: false }); util.toast('已撤回发布'); that.load(); })
        .catch((e) => { that.setData({ busy: false }); util.toast(that._errText(e)); });
    });
  },

  onReload() { this.load(); },

  /** 把云函数回来的错误压成一行可读文本（带错误码） */
  _errText(e) {
    const code = e && (e.errCode !== undefined ? e.errCode : e.code);
    const msg = (e && (e.errMsg || e.message)) || '操作失败，请重试';
    return (code !== undefined && code !== null ? '[' + code + '] ' : '') + msg;
  },

  noop() {}
});
