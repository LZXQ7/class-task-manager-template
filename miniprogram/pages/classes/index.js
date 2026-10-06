/**
 * P9 · 班级管理（多班级 §43）
 * 超管 / 辅导员可查看全部班级；普通成员只能看到本班。
 * 超管可新建班级、查看邀请码 / 生成入班码、导入名单（名单导入复用 member.importCsv 传 classId）。
 */
const api = require('../../utils/api');
const util = require('../../utils/util');

Page({
  data: {
    statusBarHeight: 20,
    loading: true,
    classes: [],
    /** 是否超管（仅超管可停用班级） */
    isSuper: false,
    /** 是否辅导员（groupTag='X'）：辅导员管理所有班级，不区分「本班」 */
    isCounselor: false,
    /** 是否可跨班（超管 / 辅导员） */
    canCross: false,
    /** 是否可新建班级（超管 / 辅导员） */
    canCreate: false,
    /** 是否可删除班级（超管 / 辅导员） */
    canDelete: false,

    /** 改名弹层 */
    renameShow: false,
    renameId: 0,
    renameName: '',
    renameBusy: false,

    /** 新建班级弹层 */
    createShow: false,
    createName: '',
    createTermStart: '',
    createTotalWeeks: 16,
    createBusy: false,

    /** 邀请码 / 入班码弹层 */
    qrShow: false,
    qrClass: null,
    qrImg: '',
    qrLoading: false,
    qrError: '',
    /** 'release' | 'trial'：体验版码只有体验成员能扫，需要提示 */
    qrEnv: '',

    /** 整表批量导入（一张表含多个班级：自动识别 + 自动建班 + 已有则比对跳过） */
    wbShow: false,
    wbPhase: 'input',      // 'input' | 'preview'
    wbBusy: false,
    wbFileId: '',          // 大文件（>1MB）兜底：走云存储上传
    wbContent: '',         // 客户端直传的 base64（避免云函数在 VPC 内回下载云存储，那一步极慢）
    wbExt: '',
    wbFileName: '',
    wbGroups: [],
    wbResult: null,
    /** 解析失败的原始原因（原样显示，便于排查） */
    wbErr: '',

    /** 导入名单弹层 */
    importShow: false,
    importClassId: 0,
    importText: '',
    importBusy: false,
    importResult: '',

    /** 教职工体系（v0.7.16 重构）：教职工是全局账号（class_id=0），
     *  由超管在「教职工管理」里添加 / 解绑 / 删除，并把班级**多选**绑给每位教职工；
     *  教职工只能看到自己被绑定的班级。顶部筛选标签（全部 / 各教职工）也由这份名单驱动。 */
    staffMgrShow: false,
    staffList: [],           // 全部教职工：{id,name,position,bound,hasCode,codeExpire,classIds,codeExpireText}
    staffChips: [],          // 顶部筛选标签：[{id:0,name:'全部'}, {id,name}…]
    staffFilterId: 0,        // 顶部筛选：0 = 全部班级；其余 = 只看该教职工绑定的班级
    staffName: '',
    staffPosition: '辅导员',
    staffBusy: false,
    /** 新建教职工时的班级多选草稿（查表对象 {classId:true}，WXML 禁方法调用） */
    staffCreatePicks: {},
    /** 行内「绑班」编辑器：打开的是哪位教职工 + 班级多选草稿 */
    bindEditId: 0,
    bindDraft: {},
    /** 刚生成 / 重发的码（明文只在这一次响应里出现，关掉弹层就再也看不到） */
    staffCodeShow: false,
    staffCode: '',
    staffCodeName: '',
    staffCodeHours: 48
  },

  onLoad() {
    const app = getApp();
    this.setData({ statusBarHeight: app.globalData.statusBarHeight || 20 });
    try {
      const info = wx.getSystemInfoSync();
      this._rpxRatio = 750 / (info.windowWidth || 375);
    } catch (e) { this._rpxRatio = 2; }
    this._DEL_RPX = 160; // 删除按钮宽度（rpx），与 wxss .cl-del 保持一致
    this._load();
  },

  onShow() { this._syncRole(); },

  /**
   * 同步身份。
   * · 辅导员（groupTag='X'）**管理所有班级** → 页面上不区分「本班」（不显示「本班」标签、卡片不高亮）。
   * · 超管同样跨班；仅超管可停用/启用班级。
   * ⚠️ 登录态可能晚于 onShow（profile 尚未就绪）→ authChecked 未就绪时补一次。
   */
  _syncRole() {
    const app = getApp();
    const p = (app && app.globalData && app.globalData.profile) || null;
    const isSuper = !!(app && app.isSuper && app.isSuper());
    const groupX = !!(p && p.groupTag === 'X');
    this.setData({
      isSuper,
      isCounselor: groupX,
      canCross: isSuper || groupX,
      canCreate: isSuper || groupX,
      canDelete: isSuper || groupX
    });
    if (!this._roleSynced && app && app.globalData && !app.globalData.authChecked && typeof app.ready === 'function') {
      this._roleSynced = true;
      app.ready().then(() => this._syncRole()).catch(() => {});
    }
  },

  _load() {
    this.setData({ loading: true });
    api.classList({ all: true }, { toast: false })
      .then((list) => {
        const app = getApp();
        const myClassId = (app.globalData.profile && app.globalData.profile.classId) || 1;
        this._allClasses = util.sortClasses(list).map(c => Object.assign({}, c, {
          isMine: Number(c.id) === Number(myClassId)
        }));
        this._applyFilter();
        if (this.data.isSuper) this._loadStaff();
        else this.setData({ loading: false });
      })
      .catch(() => this.setData({ loading: false }));
  },

  /**
   * 顶部教职工筛选（v0.7.16 需求②）：0 = 全部；选中某教职工 → 只显示 TA 绑定的班级。
   * ⚠️ 替换整个 classes 数组只会发生在「切换筛选」时——不在任何触摸手势中途，
   *    不影响左滑卡片（左滑要求 touchend 无位移时绝不 setData，那是另一条纪律）。
   */
  _applyFilter() {
    const fid = Number(this.data.staffFilterId) || 0;
    const all = this._allClasses || [];
    if (!fid) { this.setData({ classes: all, loading: false }); return; }
    const staff = (this.data.staffList || []).find(s => Number(s.id) === fid);
    const ids = (staff && staff.classIds) || [];
    this.setData({
      classes: all.filter(c => ids.includes(Number(c.id))),
      loading: false
    });
  },

  /** 顶部筛选标签点击（挤开动画由 chip-motion 的 padding/font-size 过渡承担） */
  onStaffFilter(e) {
    const id = Number(e.currentTarget.dataset.id) || 0;
    if (id === Number(this.data.staffFilterId)) return;
    this.setData({ staffFilterId: id });
    this._applyFilter();
  },

  onBack() {
    wx.navigateBack({ delta: 1, fail: () => wx.switchTab({ url: '/pages/home/index' }) });
  },

  onRetry() { this._load(); },

  /* ---------------- 新建班级（超管 / 辅导员） ---------------- */
  onOpenCreate() {
    if (!this.data.canCreate) { util.toast('仅超级管理员或辅导员可新建班级'); return; }
    this.setData({
      createShow: true, createName: '', createTermStart: '', createTotalWeeks: 16, createBusy: false
    });
  },
  onCloseCreate() { this.setData({ createShow: false }); },
  onCreateName(e) { this.setData({ createName: e.detail.value }); },
  onCreateTerm(e) { this.setData({ createTermStart: e.detail.value }); },
  onCreateWeeks(e) { this.setData({ createTotalWeeks: Number(e.detail.value) || 16 }); },

  onCreateSubmit() {
    if (this.data.createBusy) return;
    const name = String(this.data.createName || '').trim();
    const termStart = String(this.data.createTermStart || '').trim();
    if (!name) { util.toast('请填写班级名'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(termStart)) { util.toast('请填写开学日期（YYYY-MM-DD）'); return; }
    this.setData({ createBusy: true });
    api.classCreate({ name, termStart, totalWeeks: this.data.createTotalWeeks }, { loading: '创建中' })
      .then((c) => {
        this.setData({ createBusy: false, createShow: false });
        util.toast('已创建「' + c.name + '」');
        this._load();
      })
      .catch(() => this.setData({ createBusy: false }));
  },

  /* ---------------- 查看人员（复用「成员与分组」页，按班级过滤） ---------------- */
  onViewMembers(e) {
    const id = Number(e.currentTarget.dataset.id);
    const name = String(e.currentTarget.dataset.name || '');
    if (!id) return;
    wx.navigateTo({
      url: '/pages/roster/index?classId=' + id + '&name=' + encodeURIComponent(name)
    });
  },

  /* ---------------- 邀请码 / 入班码 ---------------- */
  onShowQr(e) {
    const id = Number(e.currentTarget.dataset.id);
    const cls = this.data.classes.find(c => Number(c.id) === id);
    if (!cls) return;
    this.setData({ qrShow: true, qrClass: cls, qrImg: '', qrError: '', qrLoading: true, qrEnv: '' });
    this._regenQr(id);
  },
  onCloseQr() { this.setData({ qrShow: false }); },

  onCopyToken() {
    const c = this.data.qrClass;
    if (!c) return;
    wx.setClipboardData({ data: c.joinToken, success: () => util.toast('口令已复制') });
  },
  onCopyInvite() {
    const c = this.data.qrClass;
    if (!c) return;
    wx.setClipboardData({ data: c.inviteCode, success: () => util.toast('邀请码已复制') });
  },

  /** 随机重置班级口令（超管 / 辅导员）：旧口令立即失效，二维码同步换成新口令 */
  onRandomToken() {
    const c = this.data.qrClass;
    if (!c) return;
    util.confirm('重置后旧口令立即失效（已发出的旧二维码也会失效），并生成一张带新口令的入班码', '随机生成新口令').then((ok) => {
      if (!ok) return;
      api.classRandomToken({ classId: c.id }, { loading: '生成中' })
        .then((r) => {
          const token = (r && r.joinToken) || '';
          const next = Object.assign({}, c, { joinToken: token });
          // 列表里的口令也要同步，否则关掉弹层还是旧值
          const classes = this.data.classes.map(x => Number(x.id) === Number(c.id)
            ? Object.assign({}, x, { joinToken: token }) : x);
          this.setData({
            qrClass: next, classes,
            qrImg: '', qrLoading: true, qrError: '', qrEnv: ''
          });
          util.toast('已生成新口令');
          this._regenQr(c.id);
        })
        .catch(() => {});
    });
  },

  /** 用当前 scene（= 口令）重新生成入班码 */
  _regenQr(classId) {
    api.getQrcode({ classId }, { toast: false })
      .then((res) => {
        const img = (res && (res.url || res.fileId)) || '';
        this.setData({ qrImg: img, qrLoading: false, qrEnv: (res && res.envVersion) || '' });
      })
      .catch((e) => this.setData({
        qrLoading: false,
        qrError: (e && e.errMsg) || '入班码生成失败，可先用口令 / 邀请码'
      }));
  },

  /* ---------------- 教职工管理（v0.7.16 重构，仅超管） ----------------
   * 教职工是全局账号（后端 class_id=0），不再从属于某个班：
   *   · 添加：录姓名 + 职位 + 班级多选 → 生成 8 位一次性绑定码（48h，明文只出现这一次）；
   *   · 绑班：行内班级多选编辑器 → staffBindClasses 全量覆写；
   *   · 解绑：解除该教职工的微信绑定（账号与班级绑定保留，可发新码重新绑定）；
   *   · 删除：仅未绑定微信的账号可删（级联清 staff_class，备注保留）。
   * 教职工本人只能看到自己被绑定的班级（后端 guard.staffClassIds 强制）。 */
  onOpenStaffMgr() {
    if (!this.data.isSuper) { util.toast('仅超级管理员可管理教职工'); return; }
    this.setData({
      staffMgrShow: true, staffName: '', staffPosition: '辅导员', staffBusy: false,
      staffCodeShow: false, staffCode: '', staffCodeName: '',
      staffCreatePicks: {}, bindEditId: 0, bindDraft: {}
    });
    this._loadStaff();
  },
  onCloseStaffMgr() { this.setData({ staffMgrShow: false }); },
  onStaffName(e) { this.setData({ staffName: e.detail.value }); },
  onStaffPosition(e) { this.setData({ staffPosition: e.detail.value }); },

  /** 'YYYY-MM-DD HH:MM:SS' / ISO → 'MM-DD HH:MM'（WXML 里不能调方法，必须先算好） */
  _expireText(s) {
    const t = String(s || '').replace('T', ' ');
    return t.length >= 16 ? t.slice(5, 16) : t;
  },

  _loadStaff() {
    api.staffList({}, { toast: false })
      .then((list) => {
        const staffList = (list || []).map(x => Object.assign({}, x, {
          classIds: (x.classIds || []).map(Number),
          codeExpireText: this._expireText(x.codeExpire)
        }));
        // 顶部筛选标签：全部 + 各教职工（添加教职工后自动出现；被删除的自动消失）
        const staffChips = [{ id: 0, name: '全部' }].concat(
          staffList.map(s => ({ id: s.id, name: s.name }))
        );
        this.setData({ staffList, staffChips });
        this._applyFilter();
      })
      .catch(() => {});
  },

  /** 新建表单里的班级多选 chip */
  onStaffCreatePick(e) {
    const id = Number(e.currentTarget.dataset.id) || 0;
    if (!id) return;
    const picks = Object.assign({}, this.data.staffCreatePicks);
    if (picks[id]) delete picks[id]; else picks[id] = true;
    this.setData({ staffCreatePicks: picks });
  },

  onAddStaff() {
    const name = String(this.data.staffName || '').trim();
    if (!name) { util.toast('请填写姓名'); return; }
    if (this.data.staffBusy) return;
    this.setData({ staffBusy: true });
    api.addStaff({
      name,
      position: String(this.data.staffPosition || '').trim() || '辅导员',
      classIds: Object.keys(this.data.staffCreatePicks).map(Number).filter(Boolean)
    }, { toast: false })
      .then((r) => {
        this.setData({
          staffBusy: false, staffName: '', staffCreatePicks: {},
          staffCodeShow: true,
          staffCode: String((r && r.staffCode) || ''),
          staffCodeName: String((r && r.name) || name),
          staffCodeHours: Number((r && r.hours) || 48)
        });
        this._loadStaff();
      })
      .catch((e) => {
        this.setData({ staffBusy: false });
        util.toast((e && e.errMsg) || '添加失败');
      });
  },

  /** 生成 / 重发（旧码立即失效） */
  onIssueStaffCode(e) {
    const id = Number(e.currentTarget.dataset.id) || 0;
    if (!id) return;
    if (this.data.staffBusy) return;
    this.setData({ staffBusy: true });
    api.staffCode({ memberId: id }, { toast: false })
      .then((r) => {
        this.setData({
          staffBusy: false, staffCodeShow: true,
          staffCode: String((r && r.staffCode) || ''),
          staffCodeName: String((r && r.name) || ''),
          staffCodeHours: Number((r && r.hours) || 48)
        });
        this._loadStaff();
      })
      .catch((e) => {
        this.setData({ staffBusy: false });
        util.toast((e && e.errMsg) || '生成失败');
      });
  },

  onCopyStaffCode() {
    if (!this.data.staffCode) return;
    wx.setClipboardData({ data: this.data.staffCode, success: () => util.toast('绑定码已复制') });
  },

  /** 打开 / 关闭某行的「绑班」编辑器（编辑器打开时草稿 = 该教职工当前绑定） */
  onStaffBindEdit(e) {
    const id = Number(e.currentTarget.dataset.id) || 0;
    if (!id) return;
    if (Number(this.data.bindEditId) === id) { this.setData({ bindEditId: 0, bindDraft: {} }); return; }
    const staff = (this.data.staffList || []).find(s => Number(s.id) === id);
    const draft = {};
    ((staff && staff.classIds) || []).forEach(cid => { draft[cid] = true; });
    this.setData({ bindEditId: id, bindDraft: draft });
  },
  onStaffBindPick(e) {
    const cid = Number(e.currentTarget.dataset.id) || 0;
    if (!cid) return;
    const draft = Object.assign({}, this.data.bindDraft);
    if (draft[cid]) delete draft[cid]; else draft[cid] = true;
    this.setData({ bindDraft: draft });
  },
  onStaffBindSave() {
    const id = Number(this.data.bindEditId) || 0;
    if (!id || this.data.staffBusy) return;
    const classIds = Object.keys(this.data.bindDraft).map(Number).filter(Boolean);
    this.setData({ staffBusy: true });
    api.staffBindClasses({ memberId: id, classIds }, { toast: false })
      .then(() => {
        this.setData({ staffBusy: false, bindEditId: 0, bindDraft: {} });
        util.toast(classIds.length ? '已绑定 ' + classIds.length + ' 个班级' : '已解除全部班级');
        this._loadStaff();
      })
      .catch((e) => {
        this.setData({ staffBusy: false });
        util.toast((e && e.errMsg) || '保存失败');
      });
  },

  /** 解除微信绑定（账号与班级绑定保留，可发新码重新绑定） */
  onStaffUnbind(e) {
    const id = Number(e.currentTarget.dataset.id) || 0;
    if (!id) return;
    util.confirm('解除后这位教职工将无法登录小程序；账号与班级绑定保留，生成新码后可重新绑定', '解除微信绑定')
      .then((ok) => {
        if (!ok) return;
        api.staffUnbind({ memberId: id }, { loading: '处理中' })
          .then(() => { util.toast('已解除绑定'); this._loadStaff(); })
          .catch(() => {});
      });
  },

  /** 删除教职工账号（仅未绑定微信的账号；后端会再校验一次） */
  onStaffDelete(e) {
    const id = Number(e.currentTarget.dataset.id) || 0;
    if (!id) return;
    const staff = (this.data.staffList || []).find(s => Number(s.id) === id);
    util.confirm('删除后「' + ((staff && staff.name) || '') + '」的账号与班级绑定都会移除；TA 写过的学生备注会保留', '删除教职工账号')
      .then((ok) => {
        if (!ok) return;
        api.staffDelete({ memberId: id }, { loading: '删除中' })
          .then(() => {
            util.toast('已删除');
            if (Number(this.data.staffFilterId) === id) this.setData({ staffFilterId: 0 });
            this._loadStaff();
          })
          .catch((err) => util.toast((err && err.errMsg) || '删除失败'));
      });
  },

  /* ---------------- 导入名单（复用 member.importCsv） ---------------- */
  onOpenImport(e) {
    const id = Number(e.currentTarget.dataset.id);
    this.setData({ importShow: true, importClassId: id, importText: '', importResult: '' });
  },
  onCloseImport() { this.setData({ importShow: false }); },
  onImportText(e) { this.setData({ importText: e.detail.value }); },

  onImportSubmit() {
    if (this.data.importBusy) return;
    const text = String(this.data.importText || '').trim();
    if (!text) { util.toast('请粘贴名单内容'); return; }
    this.setData({ importBusy: true });
    api.importCsv({ text, classId: this.data.importClassId }, { loading: '导入中' })
      .then((r) => {
        const failed = (r.failed || []).length;
        let msg = '导入 ' + r.imported + ' 人';
        if (failed) msg += '，' + failed + ' 条失败';
        this.setData({ importBusy: false, importResult: msg });
        util.toast(msg);
      })
      .catch(() => this.setData({ importBusy: false }));
  },

  /* ---------------- 停用 / 启用（仅超管） ---------------- */
  onToggleActive(e) {
    if (!this.data.isSuper) return;
    const id = Number(e.currentTarget.dataset.id);
    const cls = this.data.classes.find(c => Number(c.id) === id);
    if (!cls) return;
    const next = !cls.isActive;
    util.confirm(next ? '启用该班级？' : '停用后该班不再参与排班、不能新绑定成员', next ? '启用班级' : '停用班级')
      .then(ok => {
        if (!ok) return;
        api.classSetActive({ classId: id, active: next }, { loading: '处理中' })
          .then(() => { util.toast(next ? '已启用' : '已停用'); this._load(); })
          .catch(() => {});
      });
  },

  /* ---------------- 左滑删除（超管 / 辅导员；仅无人班级可删） ----------------
   * ⚠️ 关键：轻点（未横向移动）时**不要** setData。onSwipeEnd 里重建整个 classes 数组
   * 会让卡片内的操作按钮（查看人员 / 邀请码 / 导入 / 改名）节点被替换，
   * 子元素的 tap 事件随即丢失 —— 表现为「四个按钮都没反应」。 */
  onSwipeStart(e) {
    const ds = e.currentTarget.dataset;
    this._swipeIdx = Number(ds.idx);
    this._swipeId = Number(ds.id);
    this._startX = e.touches[0].clientX;
    this._startY = e.touches[0].clientY;
    this._startOffset = (this.data.classes[this._swipeIdx] || {}).offset || 0;
    this._swipeMoved = false;
  },
  onSwipeMove(e) {
    if (this._swipeIdx == null) return;
    const t = e.touches[0];
    const dx = t.clientX - this._startX;
    const dy = t.clientY - (this._startY || 0);
    // 纵向为主 → 交给页面滚动，不处理（否则会误判成滑动）
    if (Math.abs(dx) < Math.abs(dy)) return;
    if (!this._swipeMoved) {
      if (Math.abs(dx) < 6) return;            // 抖动阈值：轻点不算滑动
      this._swipeMoved = true;
      // 拖动时关掉 transition，做到 1:1 跟手；松手再开 transition 做回弹动画
      this.setData({ ['classes[' + this._swipeIdx + '].noAnim']: true });
    }
    const deltaRpx = dx * (this._rpxRatio || 2);
    let off = this._startOffset + deltaRpx;
    if (off > 0) off = 0;
    if (off < -this._DEL_RPX) off = -this._DEL_RPX;
    this.setData({ ['classes[' + this._swipeIdx + '].offset']: off });
  },
  onSwipeEnd(e) {
    if (this._swipeIdx == null) return;
    const idx = this._swipeIdx;
    const moved = this._swipeMoved;
    this._swipeIdx = null;
    this._swipeId = null;
    this._swipeMoved = false;
    // 轻点（无横向位移）→ 不动任何数据，让子按钮的 tap 正常触发
    if (!moved) return;
    const off = (this.data.classes[idx] || {}).offset || 0;
    const opened = off < -this._DEL_RPX / 2;
    const classes = this.data.classes.map((c, i) =>
      Object.assign({}, c, { offset: i === idx ? (opened ? -this._DEL_RPX : 0) : 0, noAnim: false }));
    this.setData({ classes });
  },
  /** 全部收起（取消删除时把卡片滑回原位） */
  _closeAll() {
    const classes = this.data.classes.map(c => Object.assign({}, c, { offset: 0 }));
    this.setData({ classes });
  },
  onDeleteClass(e) {
    const id = Number(e.currentTarget.dataset.id);
    const name = String(e.currentTarget.dataset.name || '');
    if (!this.data.canDelete) { util.toast('仅超级管理员或辅导员可删除班级'); return; }
    util.confirm('删除后该班级将从列表移除；仅可删除「无人班级」，有成员则不可删（避免成员账号悬空）。', '删除『' + name + '』')
      .then(ok => {
        if (!ok) { this._closeAll(); return; }
        api.classDelete({ classId: id }, { loading: '删除中' })
          .then(() => { util.toast('已删除『' + name + '』'); this._load(); })
          .catch((err) => {
            util.toast((err && err.errMsg) || '删除失败');
            this._load();
          });
      });
  },

  /* ---------------- 改名（超管 / 辅导员；改名应用到全部成员） ---------------- */
  onRename(e) {
    if (!this.data.canCreate) { util.toast('仅超级管理员或辅导员可改名'); return; }
    const id = Number(e.currentTarget.dataset.id);
    const name = String(e.currentTarget.dataset.name || '');
    this.setData({ renameShow: true, renameId: id, renameName: name, renameBusy: false });
  },
  onCloseRename() { this.setData({ renameShow: false }); },
  onRenameInput(e) { this.setData({ renameName: e.detail.value }); },
  onRenameSubmit() {
    if (this.data.renameBusy) return;
    const name = String(this.data.renameName || '').trim();
    if (!name) { util.toast('请填写班级名'); return; }
    this.setData({ renameBusy: true });
    api.classUpdate({ classId: this.data.renameId, name }, { loading: '保存中' })
      .then((c) => {
        this.setData({ renameBusy: false, renameShow: false });
        util.toast('已改名「' + c.name + '」');
        this._load();
      })
      .catch(() => this.setData({ renameBusy: false }));
  },

  /* ---------------- 整表批量导入（Excel：自动识别班级 / 建班 / 已有则比对跳过） ---------------- */
  onWbOpen() {
    this.setData({
      wbShow: true, wbPhase: 'input', wbBusy: false,
      wbFileId: '', wbContent: '', wbExt: '', wbFileName: '', wbGroups: [], wbResult: null, wbErr: ''
    });
  },
  onWbClose() { this.setData({ wbShow: false }); },
  onWbBack() { this.setData({ wbPhase: 'input' }); },

  onWbPickFile() {
    if (this.data.wbBusy) return;
    if (!wx.chooseMessageFile) { util.toast('当前微信版本不支持选择文件'); return; }
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      // ⚠️ 不传 extension：它要求每项带点（'.xlsx'），写错会一个文件都列不出来
      success: (res) => {
        const f = (res.tempFiles || [])[0];
        if (!f) { util.toast('没有选到文件'); return; }
        this._wbUpload(f);
      },
      fail: (err) => {
        if (String((err && err.errMsg) || '').indexOf('cancel') >= 0) return;
        util.toast('打开文件列表失败');
      }
    });
  },

  _wbUpload(f) {
    const name = f.name || 'roster.xlsx';
    const ext = String(name.split('.').pop() || '').toLowerCase();
    if (['xlsx', 'csv'].indexOf(ext) < 0) {
      util.toast('请选择 .xlsx 或 .csv 文件（旧版 .xls 请先另存为 .xlsx）');
      return;
    }
    // 大文件（>1MB）base64 会撑爆 callFunction 包体，改走云存储上传兜底；
    // 一般名单都很小，走 base64 直传，跳过云函数在 VPC 内回下载云存储那一步（极慢）。
    const size = Number(f.size || 0);
    if (size > 900 * 1024) { this._wbUploadCloud(f, name); return; }
    wx.showLoading({ title: '读取中', mask: true });
    wx.getFileSystemManager().readFile({
      filePath: f.path,
      encoding: 'base64',
      success: (res) => {
        wx.hideLoading();
        this.setData({ wbContent: res.data, wbExt: ext, wbFileId: '', wbFileName: name, wbErr: '' });
        this._wbPreview();
      },
      fail: () => {
        // 读不到（极少见）就回落云存储上传
        wx.hideLoading();
        this._wbUploadCloud(f, name);
      }
    });
  },

  /** 兜底：大文件才走云存储上传（函数端仍支持 fileId 下载） */
  _wbUploadCloud(f, name) {
    const ext = String(name.split('.').pop() || '').toLowerCase();
    const cloudPath = 'import/' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.' + ext;
    wx.showLoading({ title: '上传中', mask: true });
    wx.cloud.uploadFile({
      cloudPath,
      filePath: f.path,
      success: (r) => {
        wx.hideLoading();
        this.setData({ wbFileId: r.fileID, wbContent: '', wbExt: ext, wbFileName: name, wbErr: '' });
        this._wbPreview();
      },
      fail: () => { wx.hideLoading(); util.toast('文件上传失败，请重试'); }
    });
  },

  /** 组装入参：优先 base64 直传，否则用兜底 fileId */
  _wbPayload(extra) {
    const p = Object.assign({}, extra);
    if (this.data.wbContent) { p.content = this.data.wbContent; p.name = this.data.wbFileName; }
    else if (this.data.wbFileId) { p.fileId = this.data.wbFileId; }
    else { return null; }
    return p;
  },

  onWbParse() {
    if (!this.data.wbContent && !this.data.wbFileId) { util.toast('请先选择 Excel / CSV 文件'); return; }
    this._wbPreview(false);
  },

  /**
   * 解析预览：autoCreate 让「没匹配到班级」的组直接标成「将新建」。
   * 传输层失败（网络抖动 / 冷启动超时）自动退避重试一次 —— 移动网络下这一步很常见。
   */
  _wbPreview(retry, fileId) {
    if (this.data.wbBusy && !retry) return;
    const payload = this._wbPayload({ preview: true, autoCreate: true });
    if (!payload) { this.setData({ wbBusy: false, wbErr: '没有拿到文件，请重新选择' }); return; }
    this.setData({ wbBusy: true, wbErr: '' });
    const opt = retry ? { toast: false } : { loading: '解析中' };
    api.importExcel(payload, opt)
      .then((r) => {
        const groups = (r.groups || []).map((g) => {
          const st = g.stat || { fresh: 0, same: 0, diff: 0, other: 0, total: g.count };
          // 默认勾选 = 这次真的会有写入（要新增 / 有差异）。
          // ⚠️ 「将新建」但 fresh=0 且 diff=0 的组（学号全已属别班）默认**不勾** ——
          //    否则勾选后只会建出一个空班级（用户已多次踩到），需要用户手动勾才会建。
          const include = !g.conflict && (st.fresh > 0 || st.diff > 0);
          return Object.assign({}, g, { stat: st, include, createName: g.suggestName || g.label });
        });
        this.setData({ wbBusy: false, wbGroups: groups, wbPhase: 'preview', wbErr: '' });
        if (!groups.length) util.toast('没从表格里读到名单');
      })
      .catch((e) => {
        // errCode -1 = 传输层失败（网络异常），重试一次
        if (!retry && e && e.errCode === -1) {
          this.setData({ wbBusy: false });
          util.toast('网络不太稳，正在重试…');
          setTimeout(() => this._wbPreview(true), 800);
          return;
        }
        this.setData({ wbBusy: false, wbErr: (e && e.errMsg) || '解析失败，请重试或改用粘贴方式' });
      });
  },

  onWbToggle(e) {
    const i = Number(e.currentTarget.dataset.i);
    const groups = this.data.wbGroups.slice();
    if (!groups[i]) return;
    groups[i] = Object.assign({}, groups[i], { include: !groups[i].include });
    this.setData({ wbGroups: groups });
  },

  /** 编辑「将新建」班级的班级名（建班时使用，默认值为系统推导名） */
  onWbNameInput(e) {
    const i = Number(e.currentTarget.dataset.i);
    const groups = this.data.wbGroups.slice();
    if (!groups[i]) return;
    groups[i] = Object.assign({}, groups[i], { createName: e.detail.value });
    this.setData({ wbGroups: groups });
  },

  onWbConfirm() {
    if (this.data.wbBusy) return;
    const picked = (this.data.wbGroups || []).filter(g => g.include);
    if (!picked.length) { util.toast('请至少勾选一个要导入的班级'); return; }
    const mapping = {};
    const createLabels = [];
    const createNames = {};
    picked.forEach((g) => {
      if (g.classId) mapping[g.label] = g.classId;
      else if (g.label) {
        createLabels.push(g.label);
        createNames[g.label] = (g.createName && g.createName.trim()) || g.suggestName || g.label;
      }
    });
    if (!Object.keys(mapping).length && !createLabels.length) {
      util.toast('勾选的分组还没有归属班级'); return;
    }
    this.setData({ wbBusy: true });
    const payload = this._wbPayload({
      mapping,
      createLabels,
      createNames,
      createMissing: createLabels.length > 0
    });
    if (!payload) { this.setData({ wbBusy: false, wbErr: '没有拿到文件，请重新选择' }); return; }
    api.importExcel(payload, { loading: '导入中' })
      .then((r) => {
        this.setData({ wbBusy: false, wbResult: r, wbPhase: 'input', wbGroups: [], wbFileId: '', wbContent: '', wbExt: '', wbFileName: '' });
        const parts = [];
        if (r.imported) parts.push('新增 ' + r.imported + ' 人');
        if (r.updated) parts.push('更新 ' + r.updated + ' 人');
        if (r.unchanged) parts.push('无需变动 ' + r.unchanged + ' 人');
        if (r.skipped) parts.push('跳过 ' + r.skipped + ' 人');
        if (r.createdClasses && r.createdClasses.length) parts.push('新建 ' + r.createdClasses.length + ' 个班级');
        util.toast(parts.join('，') || '没有变化');
        if (r.createdClasses && r.createdClasses.length) {
          const noMember = (!r.imported && !r.updated);
          wx.showModal({
            title: '导入完成',
            content: '新建班级：' + r.createdClasses.join('、') +
              (noMember
                ? '。\n注意：这些班级没有导入到任何成员（其学号已属于其它班级）。如需合并，请先删除空班级，再用「查看人员 → 导入名单」导入到已有班级。'
                : ''),
            showCancel: false,
            confirmColor: '#3370FF'
          });
        }
        this._load();
      })
      .catch(() => this.setData({ wbBusy: false }));
  },

  noop() {}
});
