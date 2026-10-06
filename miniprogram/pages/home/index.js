/**
 * P2 · 首页 · 今日（Tab 1）
 */
const api = require('../../utils/api');
const util = require('../../utils/util');
const subscribe = require('../../utils/subscribe');
const pageAnim = require('../../utils/page-anim');
const notice = require('../../utils/notice');
const request = require('../../utils/request');
const impersonate = require('../../utils/impersonate');

/**
 * Hero 卡 = 纯提醒：只告诉你「今天你值日」以及在哪一节、和谁一起，
 * 不再提供打卡 / 确认完成（本工具只做值日提醒，不做打卡验收）。
 */
const HERO = {
  PENDING: { cls: 'plain', title: '今天你值日', titleColor: '#1D2129', subColor: '#4E5969', status: '待值日' },
  ONGOING: { cls: 'blue', title: '今天你值日', titleColor: '#FFFFFF', subColor: 'rgba(255,255,255,0.8)', status: '进行中' },
  DONE: { cls: 'plain', title: '今天你值日', titleColor: '#1D2129', subColor: '#4E5969', status: '已完成' },
  LEAVE: { cls: 'leave', title: '今天你请假了', titleColor: '#D46B08', subColor: '#D46B08', status: '已请假' },
  SWAPPED_OUT: { cls: 'plain', title: '今天已换出', titleColor: '#1D2129', subColor: '#4E5969', status: '已换出' },
  EXPIRED: { cls: 'plain', title: '今天你值日', titleColor: '#1D2129', subColor: '#4E5969', status: '已结束' }
};

/** 数据新鲜度窗口：切换回首页时，只要在这个窗口内拉过数据，就直接复用、不再发起请求 */
const STALE_MS = 20000;

/** 「按职位」预设职位：辅导员发通知时一键选择。
 *  取值统一从 `utils/util.js` 的 POSITIONS 取（与云函数 member 的 POSITIONS 同源，
 *  由门禁 scripts/check-positions-sync.js 强制比对），这里不再各写一份。 */
const NOTICE_POSITION_PRESETS = util.POSITIONS;

Page({
  data: {
    statusBarHeight: 20,
    loading: true,
    failed: false,
    unbound: false,

    dateText: '',
    weekText: '',
    myDuty: null,
    sessions: [],
    /** 明日课次（后端按「实际上课日期」算，放假 / 调课 / 跨周都已考虑） */
    tomorrowSessions: [],
    tomorrowText: '',
    pendingSwapCount: 0,
    unreadNotice: null,
    isAdmin: false,
    member: null,
    /* 「切换测试账号」模拟态顶部横幅（v1.0.5）：非空即渲染红色护栏条 */
    impersonateBanner: '',
    /* 更新公告（v0.7.25）：超管发送 → 主页弹一次、看过不再弹 */
    anncSheetShow: false,
    anncNotice: {},
    /* 通知一次性弹窗（v1.0.5）：发布通知时可选 → 收件人主页弹一次、看过不再弹 */
    npopSheetShow: false,
    npopNotice: {},
    /** 管理员卡标题（按身份显示职位头衔；超管金 / 班委蓝 / 辅导员青） */
    adminTag: '',
    adminTier: '',
    /** 是否可查看班级（超管 / 辅导员，多班级 §43） */
    canViewClass: false,
    /** 教职工（辅导员）视角：隐藏学生功能块（v0.7.16 需求⑥⑨） */
    isCounselor: false,
    /** 「关注的学生」卡可见（v0.7.17 需求⑥）：与成员详情的「固定到主页」按钮同口径 */
    showPins: false,
    /** 固定到主页的学生（≤ pinLimit 条）：{ memberId, name, classId, className, latestNote, noteCount } */
    pins: [],
    pinLimit: 8,
    currentWeek: 1,
    /** Tab 入场动画序号：0 = 还没进过（播完整版），之后在 1 / 2 之间轮换（轻量版），见 utils/page-anim.js */
    animSeq: 0,
    /** 入场动画就绪标记（v0.7.31）：false = 根节点挂 pa-hold（块透明），等首屏身份+数据就绪再统一开播 */
    paReady: false,

    hero: null,
    heroSub: '',
    periodText: '',

    sheetShow: false,
    sheetDutyId: 0,

    playing: false,
    remindOn: false,
    /** 微信提醒额度耗尽（后端 remind_block，cron 发送 43101 时置 1）→ 首页弹「重新开启」 */
    remindBlock: false,
    /** 测试提醒发送中（防连点） */
    remindBusy: false,
    /** 查看通知入口角标 = 待确认数（同步读缓存，不阻塞首屏） */
    noticeUnacked: 0,

    /* 发布通知（管理员） */
    noticeShow: false,
    noticeTitle: '',
    noticeContent: '',
    noticeLinkUrl: '',
    noticeLinkName: '',
    noticeLinkDetecting: false,
    noticeLinkError: '',
    /** 金山文档链接预警：小程序内无法直达，提示管理员改用腾讯文档 */
    noticeLinkHint: '',
    noticeScope: 'ALL',
    noticeScopeItems: [{ key: 'ALL', text: '全体成员' }, { key: 'PICK', text: '指定成员' }],
    noticeNeedAck: false,
    /** 发布时附带「一次性弹窗」（v1.0.5）：收件人首页弹一次、看过不再弹 */
    noticePopup: false,
    /* 配图（v0.7.14）：本地临时路径数组，提交时直传云存储后转成 fileID 传给后端 */
    noticeImages: [],
    noticeMembers: [],
    /** 勾选的成员：{ [memberId]: true } —— 用对象而不是数组，WXML 里好判断选中态 */
    noticePick: {},
    noticePickedCount: 0,
    noticePickAllA: false,
    noticePickAllB: false,
    noticeKw: '',
    noticeBusy: false,
    /** 多班级（§43 需求⑥）：可选班级列表（辅导员跨班发送） */
    noticeClasses: [],
    noticeClassIds: [],
    noticeAllClasses: false,
    /**
     * 班级高亮表 {classId: true}。
     * ⚠️ 必须在 JS 里预先算好：WXML 表达式**不支持方法调用**（`arr.indexOf(x)` 恒为假），
     *    写成 `noticeClassIds.indexOf(item.id) >= 0` 会导致选了班级却**永不落 `on`**（即「选了没高亮」）。
     */
    noticeClassPicked: {},
    /** 仅辅导员账号显示「发送班级」区（超管不再显示） */
    noticeShowClasses: false,
    /** 按职位发布：positions 逗号分隔（由预设 chip 勾选生成） */
    noticePositions: '',
    /** 预设职位（辅导员「按职位」一键选择，口径 = member.position 实际的 7 种） */
    noticePosPresets: [],
    /** 当前已选的预设职位（用于高亮） */
    noticePosPicked: {},
    /** 已选职位个数（用于提示文案） */
    noticePosPickedCount: 0,

    /* 首页请假卡（1.0.5 追加，需求①②）：班委/超管看本班请假人数；辅导员看各班总数 */
    showLeaveHome: false,
    leaveHomeMode: 'class',
    leaveHomeClassName: '',
    leaveHomeDate: '',
    leaveHomeLeave: 0,
    leaveHomeLeaveA: 0,
    leaveHomeLeaveB: 0,
    leaveHomeRaw: [],
    leaveHomeClasses: [],
    /** 名单查看弹层（班委可撤销；辅导员只读） */
    leaveHomeShow: false,
    leaveHomeViewTitle: '',
    leaveHomeListA: [],
    leaveHomeListB: [],
    leaveHomeCanCancel: false,
    leaveHomeBusy: false,
    /** 弹层内「加载中…」（v0.7.32 问题②：点开即弹，名单后台再刷新） */
    leaveHomeLoading: false
  },

  onLoad() {
    const app = getApp();
    this.setData({ statusBarHeight: app.globalData.statusBarHeight || 20 });
    this._renderDate();
  },

  onShow() {
    const app = getApp();
    this.setData({ remindOn: !!wx.getStorageSync('remindOn') });
    app.setTabBar(0);
    // v0.7.31：不再立即播 —— 等「身份(app.ready) + 首屏数据(loading=false)」就绪、或 READY_MS 兜底超时再统一开播
    pageAnim.playReady(this, getApp());
    const p = this._applyIdentity();
    /*
     * §41 需求③：切换测试账号切回原身份后，首页按钮不见。
     * 根因是 STALE_MS 缓存窗口内 load() 直接 return，沿用旧 isAdmin/adminTag 数据。
     * 修复：onShow 身份指纹变化时强制 load(true) 重拉一次。
     * 指纹含 classId —— 跨班查看/切换后也要重拉。
     */
    const fp = this._identityFpOf(p);
    const identityChanged = (this._identityFp !== undefined && this._identityFp !== fp);
    this._identityFp = fp;
    /*
     * §43 需求①：进入小程序时「查看班级」不显示，切到别的 Tab 再回来才出现。
     * 根因：首次进入时 onShow 早于登录完成，profile 还是 null → canViewClass=false，
     * 之后再没人重算。修复：未完成登录时等 app.ready()，就绪后重套一次身份。
     */
    if (app && app.globalData && !app.globalData.authChecked) {
      app.ready().then(() => {
        const p2 = this._applyIdentity();
        const fp2 = this._identityFpOf(p2);
        if (fp2 !== this._identityFp) { this._identityFp = fp2; this.load(true); }
      });
    }
    // 角标：从 utils/notice 缓存同步读取（命中即有，无需网络）。空缓存保持 0。
    // 需求⑤：角标 = 我还没看过的新通知（排除自己发的），游标按成员隔离。
    const cached = notice.read(0);
    const meId = Number((p && p.id) || 0);
    this.setData({ noticeUnacked: cached ? notice.unackedCount(cached, meId) : 0 });
    // v0.7.16（需求④）：角标改为 **SWR** —— 旧值先亮，每次 onShow 都后台重拉一次。
    // 旧实现只读缓存（最长 15s 内不更新），别人刚发的通知红点不动。
    this._refreshNoticeBadge(meId);
    // 换班确认/拒绝/撤销后，首页 badge 与底部红点必须立即失效：
    // 「我的」页操作成功后会置位 swapDirty，这里强制跳过 STALE_MS 缓存重载一次。
    const swapDirty = !!(app.globalData && app.globalData.swapDirty);
    if (app.globalData) app.globalData.swapDirty = false;
    // 1.0.4.4 #28：换班同意后值日表已变，dutyDirty 置位时首页 Hero 也强制重拉。
    // 注意：dutyDirty 只由「值日页」onShow 清空（它是权威消费者），首页/我的只消费不清，
    // 保证无论先逛哪个 Tab，最终进值日页一定刷新得到最新排班。
    const dutyDirty = !!(app.globalData && app.globalData.dutyDirty);
    // v0.7.32 问题②：在「成员与分组」里改了职位（含把自己设成班委）后置位 rosterDirty，
    // 这里强制跳过 STALE_MS 重拉一次，班委专属卡片（admin-card）立即出现。
    const rosterDirty = !!(app.globalData && app.globalData.rosterDirty);
    if (app.globalData) app.globalData.rosterDirty = false;
    this.load(identityChanged || swapDirty || dutyDirty || rosterDirty);
    // 今日课次灰化计时器：即便 load 命中 STALE_MS 缓存直接 return（数据已在），也要续排到点翻面
    this._scheduleDoneTimer();
    /*
     * v0.7.32 问题②（别人的手机）：切 tab 也做一次节流身份重校（app 内 20s 一次）。
     * 过去只在 App.onShow（回前台）重校 ⇒ 对方不杀进程、不回前台就永远看不到新权限。
     * 重校发现身份变了就重套身份 + 强刷首页（back-end 的 isAdmin 也随之刷新）。
     */
    if (app && typeof app.recheckAuth === 'function') {
      app.recheckAuth().then((changed) => {
        if (!changed) return;
        const p2 = this._applyIdentity();
        this._identityFp = this._identityFpOf(p2);
        this.load(true);
      }).catch(() => {});
    }
  },

  /** 后台静默重拉通知列表 → 更新缓存与角标（失败静默，不打扰用户） */
  _refreshNoticeBadge(meId) {
    api.msgList({}, { toast: false })
      .then((list) => {
        notice.write(list);
        this.setData({ noticeUnacked: notice.unackedCount(list, meId) });
      })
      .catch(() => {});
  },

  /** 身份指纹：任一维度变化都视为换了身份，需要重拉数据 */
  _identityFpOf(p) {
    return p
      ? (p.id + '/' + (p.isSuper ? 1 : 0) + '/' + (p.role || '') + '/' + (p.position || '') + '/' + (p.classId || 1))
      : 'none';
  },

  /**
   * 按当前登录身份刷新「管理员卡标题」与「查看班级」入口。
   * 返回 profile，供调用方算身份指纹。
   */
  _applyIdentity() {
    const app = getApp();
    const p = (app && app.globalData && app.globalData.profile) || null;
    const rt = util.roleTag({
      isSuper: !!(app && app.isSuper && app.isSuper()),
      groupTag: p ? p.groupTag : '',
      role: p ? p.role : '',
      position: p ? p.position : ''
    });
    // 查看班级入口：超管或辅导员可见（多班级 §43 需求⑤）
    const canViewClass = !!(app && app.isSuper && app.isSuper()) || !!(p && p.groupTag === 'X');
    // v0.7.16：教职工（辅导员）视角 —— 首页隐藏学生功能（值日 Hero / 今日明日课次 / 提醒胶囊）
    const isCounselor = !!(p && p.groupTag === 'X');
    // 「关注的学生」卡片（v0.7.18 需求①）：**仅辅导员**可见。
    // 上一版跟着 canViewClass（超管 ∨ 辅导员），超管也会看到这张卡 —— 已按用户口径收紧，
    // 与后端 pinList / pinToggle 的「仅辅导员」一致。
    const showPins = isCounselor;
    // 首页请假卡（1.0.5 追加）：班委/超管看本班请假人数、辅导员看各班总数 —— 一律可见，
    // 普通同学不可见（决策④）。辅导员只读（leaveHomeMode='counselor'），班委/超管可撤销。
    const canLeave = !!(app && app.canLeave && app.canLeave());
    const showLeaveHome = isCounselor || canLeave;
    const patch = {
      canViewClass, isCounselor, showPins,
      canLeave,
      showLeaveHome,
      leaveHomeMode: isCounselor ? 'counselor' : 'class'
    };
    if (rt) { patch.adminTag = rt.text; patch.adminTier = rt.tier; }
    this.setData(patch);
    if (showPins) this._loadPins();
    if (showLeaveHome) this._loadLeaveHome();
    // 模拟态护栏（v1.0.5）：每次套用身份都同步一次顶部横幅，登录晚到时也能补上
    impersonate.sync(this);
    return p;
  },

  /** 顶部「模拟中」横幅的「恢复本人」（v1.0.5） */
  onRecoverSelf() {
    impersonate.recover();
  },

  /**
   * 关注的学生列表（v0.7.17 需求⑥）。
   * 每次进首页都重拉（≤8 行的小查询），保证在成员详情里刚钉的人**切回来就能看到** ——
   * 和「我的」页计数用同一套 SWR 口径：旧值先显示、后台静默刷新。
   */
  _loadPins() {
    api.pinList({}, { toast: false })
      .then((r) => this.setData({
        pins: (r && r.list) || [],
        pinLimit: Number((r && r.limit) || 8)
      }))
      .catch(() => {});
  },

  /* ---------------- 首页请假卡（1.0.5 追加，需求①②） ----------------
   * 班委/超管：**走已部署的 leaveBoard**（与「成员与分组」同源，返回 { date, list, stat }）——
   *            刻意不依赖追加批次新加的 leaveSummary 路由，避免「后端没更新到就整卡看不了」。
   * 辅导员    ：走 leaveSummary（其绑定范围内每班今日请假数，mode:'counselor'）。
   * 点击卡 → 班委/超管打开可撤销的名单弹层；辅导员点某班 → 拉该班名单（只读）。 */
  _loadLeaveHome() {
    if (this.data.leaveHomeMode === 'counselor') {
      api.leaveSummary({}, { toast: false })
        .then((r) => { if (r && r.classes) this.setData({ leaveHomeClasses: util.sortClasses(r.classes || []) }); })
        .catch(() => {});
      return;
    }
    api.leaveBoard({}, { toast: false })
      .then((r) => { if (r) this._setLeaveHomeClass(r); })
      .catch(() => {});
  },

  _setLeaveHomeClass(r) {
    const list = (r && r.list) || [];
    const a = list.filter(x => x.groupTag === 'A');
    const b = list.filter(x => x.groupTag === 'B');
    const stat = (r && r.stat) || {};
    this.setData({
      leaveHomeClassName: (r && r.className) || '',
      leaveHomeDate: (r && r.date) || '',
      leaveHomeLeave: stat.leave != null ? stat.leave : list.length,
      leaveHomeLeaveA: stat.leaveA != null ? stat.leaveA : a.length,
      leaveHomeLeaveB: stat.leaveB != null ? stat.leaveB : b.length,
      leaveHomeRaw: list,
      leaveHomeListA: a,
      leaveHomeListB: b
    });
  },

  /** 班委/超管：点击本班请假卡 → **立即**弹层（用 onShow 已拉到的名单），再后台刷新。
   *  v0.7.32 问题②：过去「先请求 leaveBoard、回来才开弹层」→ 点一下要等一段时间才弹。
   *  走已部署的 leaveBoard（不依赖 leaveSummary）；失败可见（主动动作）。 */
  onLeaveHomeOpen() {
    this.setData({
      leaveHomeShow: true,
      leaveHomeViewTitle: (this.data.leaveHomeClassName || '本班') + '请假',
      leaveHomeCanCancel: true,
      leaveHomeLoading: true
    });
    api.leaveBoard({}, { toast: false })
      .then((r) => {
        if (r) this._setLeaveHomeClass(r);
        this.setData({ leaveHomeLoading: false });
      })
      .catch((err) => {
        this.setData({ leaveHomeLoading: false });
        util.toast((err && err.errMsg) || '名单加载失败，请重试');
      });
  },

  /** 辅导员：点击某班 → **立即**弹层（先空、显示加载中），再拉该班名单（只读）
   *  2026-10-04 修「名单加载失败」：过去调 leaveSummary({classId}) 并期望 mode:'class'，
   *  但后端 leaveSummary 的辅导员分支**从不认 classId**（恒回 mode:'counselor' 汇总），
   *  该分支从未实现过 ⇒ 必然失败。改走已部署的 leaveBoard（resolveClassId 认传入班级、
   *  staffClassIds 收口越权），返回 {date,list,stat}，名单结构与其完全一致。 */
  onLeaveHomeClassTap(e) {
    const cid = Number(e.currentTarget.dataset.id);
    const name = e.currentTarget.dataset.name || '';
    this.setData({
      leaveHomeShow: true,
      leaveHomeViewTitle: name + '请假',
      leaveHomeCanCancel: false,
      leaveHomeListA: [],
      leaveHomeListB: [],
      leaveHomeLoading: true
    });
    api.leaveBoard({ classId: cid }, { toast: false })
      .then((r) => {
        if (!r) {
          this.setData({ leaveHomeLoading: false });
          util.toast('名单加载失败，请重试');
          return;
        }
        const list = (r.list) || [];
        this.setData({
          leaveHomeListA: list.filter(x => x.groupTag === 'A'),
          leaveHomeListB: list.filter(x => x.groupTag === 'B'),
          leaveHomeLoading: false
        });
      })
      .catch((err) => {
        this.setData({ leaveHomeLoading: false });
        util.toast((err && err.errMsg) || '名单加载失败，请重试');
      });
  },

  onLeaveHomeClose() {
    this.setData({ leaveHomeShow: false, leaveHomeLoading: false });
  },

  /** 班委/超管：撤销某条请假（区间内被标记「已请假」的值日会恢复）并刷新弹层 */
  onLeaveHomeCancelTap(e) {
    if (this.data.leaveHomeBusy) return;
    const leaveId = Number(e.currentTarget.dataset.id);
    util.confirmStrict('撤销这条请假？区间内被标记为「已请假」的值日会恢复。', '撤销请假')
      .then((act) => {
        if (act !== 'confirm') return;
        this.setData({ leaveHomeBusy: true });
        api.leaveCancel({ leaveId }, { toast: false })
          .then(() => {
            this.setData({ leaveHomeBusy: false });
            util.toast('已撤销');
            this.onLeaveHomeOpen();   // 重新拉本班汇总并重建弹层名单
          })
          .catch((err) => {
            this.setData({ leaveHomeBusy: false });
            util.toast((err && err.errMsg) || '撤销失败，请重试');
          });
      });
  },

  /** 点关注的学生 → 直接进他的成员详情（带 classId，辅导员跨班也能定位） */
  onPinTap(e) {
    const d = e.currentTarget.dataset || {};
    const memberId = Number(d.id) || 0;
    if (!memberId) return;
    const qs = 'classId=' + (Number(d.classId) || 0) +
      '&openMemberId=' + memberId +
      '&name=' + encodeURIComponent(String(d.name || ''));
    wx.navigateTo({ url: '/pages/roster/index?' + qs });
  },

  onUnload() {
    if (this._doneTimer) { clearTimeout(this._doneTimer); this._doneTimer = null; }
    if (this._audio) { this._audio.destroy(); this._audio = null; }
  },

  onHide() {
    if (this._doneTimer) { clearTimeout(this._doneTimer); this._doneTimer = null; }
    if (this._audio) { this._audio.stop(); this.setData({ playing: false }); }
  },

  _renderDate() {
    const d = new Date();
    const wd = util.weekdayCn(util.todayWeekday());
    this.setData({
      dateText: (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + wd
    });
  },

  load(force) {
    /*
     * 需求①「切换页面若无变化则无需重载」：Tab 切换回来时，只要上一次数据还很新鲜
     * （STALE_MS 内拉过），就直接复用已渲染的内容、连请求都不发 —— 切回来「秒显」。
     * 显式操作（点开 Hero 弹层后换班等）走 `load(true)` 强制刷新。
     */
    const now = Date.now();
    if (!force && this._hasData && this._lastLoad && now - this._lastLoad < STALE_MS) {
      return;
    }
    /*
     * 页面实例在 Tab 切换时**不会销毁**，data 里还是上一次的内容 ——
     * 所以「切回首页闪一下骨架」纯粹是自己造成的：无条件 `loading: true` 会把
     * 屏幕上的内容整页替换成骨架，等云函数回来再换回去。
     * 有内容就保持内容、后台静默刷新（与通知页同一套策略）。
     */
    const hasContent = !!this._hasData;
    if (!hasContent) this.setData({ loading: true, failed: false });
    return api.dutyToday({}, { toast: false })
      .then((r) => {
        const myDuty = r.myDuty || null;
        let hero = null;
        let heroSub = '';
        let periodText = '';
        if (myDuty) {
          hero = HERO[myDuty.status] || HERO.PENDING;
          heroSub = [myDuty.room, myDuty.courseName, myDuty.groupScope ? myDuty.groupScope + ' 组' : '全体']
            .filter(Boolean).join(' · ');
          // 保洁（kind='CLEAN'）显示「18点前」；它没有 periodTime（后端已置空），
          // 避免出现「18点前 · 16:00」这种自相矛盾的组合
          periodText = util.whenText(myDuty.kind, myDuty.period) + (myDuty.periodTime ? ' · ' + myDuty.periodTime.start : '');
        }
        this._hasData = true;
        this._lastLoad = Date.now();
        this.setData({
          loading: false,
          failed: false,
          unbound: false,
          myDuty,
          hero,
          heroSub,
          periodText,
          sessions: this._markDone(this._filterSessions(r.sessions || [])),
          tomorrowSessions: this._filterSessions(r.tomorrowSessions || []),
          tomorrowText: this._fmtDay(r.tomorrow),
          pendingSwapCount: r.pendingSwapCount || 0,
          unreadNotice: this._fmtNotice(r.unreadNotice),
          isAdmin: !!r.isAdmin,
          member: r.member || null,
          remindBlock: !!(r.member && r.member.remindBlock),
          currentWeek: r.currentWeek || 1,
          weekText: '第 ' + (r.currentWeek || 1) + ' 周'
        });
        // 今日课次「已上完」灰化：数据落盘后排一个到点自动翻面的计时器
        this._scheduleDoneTimer();
        const tb = typeof this.getTabBar === 'function' ? this.getTabBar() : null;
        // 值相同就不写：每次 onShow 都 setData 会让 tabBar 多渲染一轮（视觉抖动）
        const dotNext = (r.pendingSwapCount || 0) > 0;
        if (tb && tb.data && tb.data.dot !== dotNext) tb.setData({ dot: dotNext });
        // 主页弹层（不阻塞首屏）：先看「通知一次性弹窗」，再看「更新公告」，未读才弹
        this._loadPopups();
      })
      .catch((e) => {
        const code = e && e.errCode;
        this.setData({
          loading: false,
          unbound: code === 40001 || code === 40002,
          // 已经有内容时刷新失败不把整页打成错误态（对用户应当无感）
          failed: !hasContent && code !== 40001 && code !== 40002
        });
      });
  },

  onReload() { this.load(true); },

  /* v1.0.5：spring-scroll 下拉刷新 → 强制重载并收起指示器 */
  onRefresh() {
    Promise.resolve(this.load(true)).then(() => {
      const sc = this.selectComponent('#homeMain');
      if (sc && sc.finishRefresh) sc.finishRefresh();
    }).catch(() => {
      const sc = this.selectComponent('#homeMain');
      if (sc && sc.finishRefresh) sc.finishRefresh();
    });
  },

  goBind() { wx.reLaunch({ url: '/pages/bind/index' }); },

  /* ---------------- 主页弹层：通知一次性弹窗 + 更新公告 ----------------
   * 两类弹窗共用「未读才弹、看过不再弹」，但**有先后**：通知弹窗 > 更新公告，
   * 一次只弹一层（关掉通知弹窗后，更新公告下次进主页再弹），避免叠两层把首屏糊住。
   *   ① 通知一次性弹窗（v1.0.5）：发布通知勾了「弹出一次性弹窗」→ 取「我可见、没看过」的
   *      最新一条弹一次。「我可见」由 msgList 的可见性 SQL 保证（本班 / 指定 / 按职位…），
   *      「看过」= 关闭时写 notice_popup_seen（每人每条一次，与更新公告机制完全隔离）。
   *   ② 更新公告（v0.7.25）：超管发、全员弹一次；「看过」= 关闭时写 member.app_notice_seen。
   * 拉取失败静默（都不是关键路径，不为准入 / 首屏让路）。 */
  _loadPopups() {
    this._popupSeenIds = this._popupSeenIds || {};   // 本会话已关掉的弹窗 id，防「关掉又被缓存弹回来」
    api.msgList({}, { toast: false })
      .then((list) => {
        const pop = (list || []).find(n =>
          n.popup && !n.popupSeen && !n.isPublisher && !this._popupSeenIds[n.id]);
        if (pop) { this.setData({ npopNotice: pop, npopSheetShow: true }); return null; }
        return this._loadAppNotice();
      })
      // 通知列表挂了也别把更新公告一起吞掉
      .catch(() => { this._loadAppNotice(); });
  },

  /** 更新公告：未读才弹（appNoticeLatest + appNoticeSeen，全局单条只增不减） */
  _loadAppNotice() {
    return api.appNoticeLatest({}, { toast: false })
      .then((r) => {
        const n = r && r.notice;
        if (n && !n.seen) this.setData({ anncNotice: n, anncSheetShow: true });
      })
      .catch(() => {});
  },

  /** 关闭「通知一次性弹窗」：写已读 + 记本会话，避免关掉后又被旧缓存重新弹出来 */
  onNpopDismiss() {
    const n = this.data.npopNotice || {};
    if (this.data.npopSheetShow && n.id) {
      this._popupSeenIds = this._popupSeenIds || {};
      this._popupSeenIds[n.id] = true;
      api.msgPopupSeen({ noticeId: n.id }, { toast: false }).catch(() => {});
    }
    this.setData({ npopSheetShow: false });
  },

  onAnncDismiss() {
    const n = this.data.anncNotice || {};
    if (this.data.anncSheetShow && n.id) {
      api.appNoticeSeen({ noticeId: n.id }, { toast: false }).catch(() => {});
    }
    this.setData({ anncSheetShow: false });
  },

  _groupTag() {
    const app = getApp();
    return (app && app.globalData.profile && app.globalData.profile.groupTag) || '';
  },

  /**
   * 'YYYY-MM-DD' → '9月26日 周六'。
   * 星期必须用**本地时区**构造再 getDay()：走 toDate()+getUTCDay() 会因为 +08:00 位移
   * 落到前一天（项目里踩过的「星期整体差一天」坑）。
   */
  _fmtDay(dateStr) {
    const p = String(dateStr || '').split('-');
    if (p.length < 3) return '';
    const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    const wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    return Number(p[1]) + '月' + Number(p[2]) + '日 周' + wd;
  },

  /** 今日课次按分组可见性过滤：A 组仅看 A 组 + 全体课，B 组仅看 B 组 + 全体课 */
  _filterSessions(sessions) {
    const tag = this._groupTag();
    if (!tag) return sessions;
    return (sessions || []).filter(s => !s.groupScope || s.groupScope === tag);
  },

  /* ---------------- 今日课次「已上完」灰化（2026-09-29 需求） ----------------
   * 触发规则：当前时间 ≥ 该节课的下课时间(periodTime.end) ⇒ 视为上完、整行变灰。
   * 保洁/CLEAN 课次后端 periodTime 为 null（显示「18点前」），没有下课时间 ⇒ 不参与灰化。
   * 明日课次是未来日期、永远不应灰化，所以只在本函数给「今日」sessions 打标。 */
  _doneAt(s) {
    if (!s || !s.periodTime || !s.periodTime.end) return false;
    const m = /^(\d{1,2}):(\d{2})$/.exec(s.periodTime.end);
    if (!m) return false;
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    return (Number(m[1]) * 60 + Number(m[2])) <= nowMin;
  },
  _markDone(sessions) {
    return (sessions || []).map(s => Object.assign({}, s, { done: this._doneAt(s) }));
  },
  /* 计时器到点/前台切回时，只重算「今日」sessions 的 done，真正翻面了才 setData（开销极小） */
  _refreshDoneFlags() {
    const sessions = this.data.sessions || [];
    if (!sessions.length) return;
    let changed = false;
    const next = sessions.map((s) => {
      const done = this._doneAt(s);
      if (done !== !!s.done) changed = true;
      return done === s.done ? s : Object.assign({}, s, { done });
    });
    if (changed) this.setData({ sessions: next });
  },
  /* 排下一个「到点翻面」的定时器：算最近一节还没上完的课的下课时刻，到点后再评估+续排。
   * 全部已上完 ⇒ 不排；切走/卸载由 onHide/onUnload 清掉。_scheduleDoneTimer 自身先清旧计时器，
   * 所以在 load 的 .then 与 onShow 里重复调用也不会叠出多个。 */
  _scheduleDoneTimer() {
    if (this._doneTimer) { clearTimeout(this._doneTimer); this._doneTimer = null; }
    const sessions = this.data.sessions || [];
    if (!sessions.length) return;
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    let nextMs = Infinity;
    sessions.forEach((s) => {
      if (s.done || !s.periodTime || !s.periodTime.end) return;
      const m = /^(\d{1,2}):(\d{2})$/.exec(s.periodTime.end);
      if (!m) return;
      const endMin = Number(m[1]) * 60 + Number(m[2]);
      if (endMin > nowMin) {
        const fire = (endMin - nowMin) * 60000 - (now.getSeconds() * 1000 + now.getMilliseconds());
        if (fire < nextMs) nextMs = fire;
      }
    });
    if (!isFinite(nextMs)) return;            // 全部已上完，无需再排
    const delay = Math.max(1000, nextMs);     // 至少 1s，避免 0ms 抖动；否则睡到下一节下课
    this._doneTimer = setTimeout(() => {
      this._doneTimer = null;
      this._refreshDoneFlags();
      this._scheduleDoneTimer();
    }, delay);
  },

  /* ---------------- Hero ---------------- */
  onHero() {
    if (!this.data.myDuty) return;
    this.setData({ sheetShow: true, sheetDutyId: this.data.myDuty.id });
  },

  onSheetClose() { this.setData({ sheetShow: false }); },
  onSheetChanged() { this.load(true); },

  /* ---------------- 语音通知 ---------------- */
  onPlayNotice() {
    const n = this.data.unreadNotice;
    if (!n) return;
    if (this.data.playing) {
      if (this._audio) this._audio.stop();
      this.setData({ playing: false });
      return;
    }
    if (!n.url) { util.toast('语音还在审核中，请稍后再听'); return; }
    if (this._audio) this._audio.destroy();
    const a = wx.createInnerAudioContext();
    a.src = n.url;
    a.play();
    this._audio = a;
    this.setData({ playing: true });
    a.onEnded(() => {
      this.setData({ playing: false });
      this._markRead(n.id);
    });
    a.onError(() => {
      this.setData({ playing: false });
      util.toast('播放失败，请稍后重试');
    });
    a.onStop(() => this.setData({ playing: false }));
  },

  _markRead(id) {
    api.markNoticeRead({ noticeId: id }, { toast: false })
      .then(() => this.setData({ unreadNotice: null }))
      .catch(() => {});
  },

  /* ---------------- 扫码 ---------------- */
  onScan() {
    wx.scanCode({
      onlyFromCamera: false,
      success: (res) => {
        const raw = String((res && (res.path || res.result || res.rawData)) || '');
        this._handleScan(raw);
      },
      fail: () => {}
    });
  },

  _handleScan(raw) {
    let scene = raw;
    const m = /[?&]scene=([^&]+)/.exec(raw);
    if (m) {
      try { scene = decodeURIComponent(m[1]); } catch (e) { scene = m[1]; }
    }
    scene = String(scene || '').trim();
    if (/^N\d+$/.test(scene)) {
      this._playNoticeById(Number(scene.slice(1)));
      return;
    }
    if (/^\d+$/.test(scene)) {
      this._playNoticeById(Number(scene));
      return;
    }
    if (scene) {
      api.resolveScene({ scene }, { toast: false })
        .then(() => {
          const app = getApp();
          app.globalData.scene = scene;
          wx.reLaunch({ url: '/pages/bind/index' });
        })
        .catch(() => util.toast('无法识别的二维码'));
      return;
    }
    util.toast('无法识别的二维码');
  },

  _playNoticeById(noticeId) {
    api.noticeAudio({ noticeId }, { loading: '加载中' })
      .then((n) => {
        if (this._audio) this._audio.destroy();
        const a = wx.createInnerAudioContext();
        a.src = n.url;
        a.play();
        this._audio = a;
        this.setData({ playing: true });
        a.onEnded(() => { this.setData({ playing: false }); this._markRead(n.noticeId); });
        a.onError(() => { this.setData({ playing: false }); util.toast('播放失败'); });
        a.onStop(() => this.setData({ playing: false }));
        wx.showToast({ title: n.publisherName + ' 的语音通知', icon: 'none' });
      })
      .catch(() => {});
  },

  /* ---------------- 快捷入口 ---------------- */
  _fmtNotice(n) {
    if (!n) return null;
    const durSec = Math.round((Number(n.durationMs) || 0) / 1000);
    n.durationText = util.fmtDuration(durSec);
    return n;
  },

  /* goDuty 已随首页「本周值日」快捷入口一起下线：值日本来就有底部 Tab */
  goTimetable() { wx.switchTab({ url: '/pages/timetable/index' }); },

  goMine() { wx.switchTab({ url: '/pages/mine/index' }); },

  /** 成员与分组（管理员入口）：独立页，从「我的」迁出 */
  goRoster() { wx.navigateTo({ url: '/pages/roster/index' }); },

  /** 查看班级（超管 / 辅导员，多班级 §43 需求⑤） */
  goClasses() { wx.navigateTo({ url: '/pages/classes/index' }); },

  /** 查看通知（§41 需求⑦）：首页快捷入口，全员可见，避免绕到「我的」 */
  goNotice() {
    wx.navigateTo({
      url: '/pages/notice/index',
      fail: () => wx.switchTab({ url: '/pages/mine/index' })
    });
  },

  /* ---------------- 发布通知（管理员） ---------------- */
  /** 每次打开都重置表单：上一次填了一半的内容不该被下一次悄悄带上 */
  onNoticeOpen() {
    // 「班级管理」（2026-09-25 需求③ + §41 重构）：发布范围按身份不同
    //   · 班委：只能发同班 → 「本班成员」(ALL) 或「指定成员」(PICK，限本班)
    //   · 辅导员：可「班级发送」或「仅发班委」或「按职位」（可跨班），不开放任意 PICK
    //   · 超管：全体成员 / 指定成员 / 仅发班委 / 按职位（可跨班）
    const app = getApp();
    const p = (app.globalData && app.globalData.profile) || null;
    const isSuper = !!(app && app.isSuper && app.isSuper());
    const isCounselor = !!(p && p.groupTag === 'X');
    const isCommittee = !isSuper && !isCounselor && !!(p && (p.role === 'ADMIN' || p.role === 'MONITOR'));
    let items, scope;
    if (isCommittee) {
      items = [{ key: 'ALL', text: '本班成员' }, { key: 'PICK', text: '指定成员' }];
      scope = 'ALL';
    } else if (isCounselor) {
      items = [
        { key: 'ALL', text: '班级发送' },
        { key: 'COMMITTEE', text: '仅发班委' },
        { key: 'POSITION', text: '按职位' }
      ];
      scope = 'ALL';
    } else {
      items = [
        { key: 'ALL', text: '全体成员' },
        { key: 'PICK', text: '指定成员' },
        { key: 'COMMITTEE', text: '仅发班委' },
        { key: 'POSITION', text: '按职位' }
      ];
      scope = 'ALL';
    }
    // 发布范围默认「本班」（2026-09-26 需求④）：以前默认 noticeAllClasses=true →
    // 空数组被后端解释成「全部启用班级」，于是想发本班的人把通知发成了全校各班。
    // 现在默认只勾本班，要发多班必须显式点「全部班级」或逐个点班。
    const myClassId = Number((p && p.classId) || 1) || 1;
    this.setData({
      noticeShow: true,
      noticeTitle: '', noticeContent: '', noticeLinkUrl: '', noticeLinkName: '', noticeImages: [],
      noticeLinkDetecting: false, noticeLinkError: '', noticeLinkHint: '',
      noticeScope: scope, noticeScopeItems: items, noticeNeedAck: false, noticePopup: false,
      noticeMembers: [], noticePick: {}, noticePickedCount: 0,
      noticePickAllA: false, noticePickAllB: false, noticeKw: '', noticeBusy: false,
      noticeClasses: [], noticeClassIds: [myClassId], noticeAllClasses: false, noticeClassPicked: {},
      noticeShowClasses: isCounselor,
      noticePositions: '', noticePosPresets: NOTICE_POSITION_PRESETS,
      noticePosPicked: {}, noticePosPickedCount: 0
    });
    // 仅辅导员可跨班发送：拉班级列表（默认只勾本班，列表回来后高亮本班）
    if (isCounselor) this._loadNoticeClasses();
  },
  onNoticeClose() { this.setData({ noticeShow: false }); },
  onNoticeTitle(e) { this.setData({ noticeTitle: e.detail.value }); },
  onNoticeContent(e) { this.setData({ noticeContent: e.detail.value }); },

  /** 配图（v0.7.14）：chooseMedia 压缩后只存本地路径，提交时再直传云存储（避开云函数 60s 与 VPC 下载慢） */
  onNoticePickImage() {
    const left = 3 - this.data.noticeImages.length;
    if (left <= 0) { util.toast('图片最多 3 张'); return; }
    wx.chooseMedia({
      count: left,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (r) => {
        const add = (r.tempFiles || []).map(f => f.tempFilePath).filter(Boolean).slice(0, left);
        if (add.length) this.setData({ noticeImages: this.data.noticeImages.concat(add) });
      }
    });
  },
  onNoticeRemoveImage(e) {
    const i = Number(e.currentTarget.dataset.i);
    const arr = this.data.noticeImages.slice();
    if (i >= 0 && i < arr.length) { arr.splice(i, 1); this.setData({ noticeImages: arr }); }
  },
  onNoticeLink(e) { this._onNoticeLinkInput(String(e.detail.value || '')); },

  /** 拉取可选班级列表（仅辅导员），默认勾选「全部班级」 */
  _loadNoticeClasses() {
    api.classList({ all: true }, { toast: false })
      .then((list) => {
        const classes = util.sortClasses((list || []).filter(c => c.isActive !== false));
        this.setData({
          noticeClasses: classes,
          noticeClassPicked: this._clsPickedMap(this.data.noticeAllClasses, this.data.noticeClassIds)
        });
      })
      .catch(() => this.setData({ noticeClasses: [], noticeClassPicked: {} }));
  },

  /**
   * 班级高亮表。WXML 不能调方法，所以在这里算好 {classId: true}。
   * all=true 时把所有可选班级都点亮（「全部班级」态）。
   */
  _clsPickedMap(all, ids) {
    const map = {};
    if (all) {
      (this.data.noticeClasses || []).forEach(c => { map[Number(c.id)] = true; });
    } else {
      (ids || []).forEach(id => { map[Number(id)] = true; });
    }
    return map;
  },

  /**
   * 「全部班级」= **显式全选**（把每个班 id 都铺进 noticeClassIds）。
   * ⚠️ 不能再用「清空 id 列表 + 后端兜底」的写法：后端已改成「classIds 缺省 = 本班」
   *   （需求④），空数组只代表本班，会静默漏发。
   */
  onNoticeToggleAllClasses() {
    const ids = (this.data.noticeClasses || []).map(c => Number(c.id));
    if (!ids.length) { util.toast('班级列表还没加载出来'); return; }
    this.setData({ noticeAllClasses: true, noticeClassIds: ids, noticeClassPicked: this._clsPickedMap(true, ids) });
  },
  /** 「清空」= 一个班都不选（发布时会被拦下并提示） */
  onNoticeClearClasses() {
    this.setData({ noticeAllClasses: false, noticeClassIds: [], noticeClassPicked: {} });
  },
  /** 点某个班：全选态下 = 取消该班；非全选态 = 增删；选满则标记为「全部班级」态 */
  onNoticeToggleClass(e) {
    const id = Number(e.currentTarget.dataset.id);
    const allIds = (this.data.noticeClasses || []).map(c => Number(c.id));
    const ids = (this.data.noticeAllClasses ? allIds : this.data.noticeClassIds).slice();
    const idx = ids.indexOf(id);
    if (idx >= 0) ids.splice(idx, 1); else ids.push(id);
    const isAll = allIds.length > 0 && ids.length === allIds.length;
    this.setData({
      noticeClassIds: ids,
      noticeAllClasses: isAll,
      noticeClassPicked: this._clsPickedMap(false, ids)
    });
  },
  /** 点预设职位：加入 / 移除（一键选择，7 个预设以外不接受手输） */
  onNoticePosPreset(e) {
    const p = String((e.currentTarget.dataset && e.currentTarget.dataset.pos) || '');
    if (!p) return;
    const cur = String(this.data.noticePositions || '').split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean);
    const idx = cur.indexOf(p);
    if (idx >= 0) cur.splice(idx, 1); else cur.push(p);
    this.setData({
      noticePositions: cur.join(','),
      noticePosPicked: this._posPickedOf(cur.join(',')),
      noticePosPickedCount: cur.length
    });
  },
  /** 由职位字符串算出「已选预设」高亮表 */
  _posPickedOf(text) {
    const list = String(text || '').split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean);
    const picked = {};
    (this.data.noticePosPresets || []).forEach(p => { if (list.indexOf(p) >= 0) picked[p] = true; });
    return picked;
  },

  /**
   * 在线文档链接自动检测标题：输入停止 600ms 后调 ai-proxy.title 抓 <title>，
   * 回填到「显示名」（用户已手填就不覆盖）。用 token 防抖 + 乱序丢弃。
   */
  _onNoticeLinkInput(url) {
    const token = (this._linkToken = (this._linkToken || 0) + 1);
    const patch = { noticeLinkUrl: url };
    // 金山文档（kdocs.cn）小程序没有「直达指定文档」的公开路径，且其「最近」列表只显示
    // 用户自己打开过的文档 → 接收同学点开也找不到。发布时就提示管理员改用腾讯文档。
    patch.noticeLinkHint = /^https:\/\/(www\.)?kdocs\.cn\//i.test(url.trim())
      ? '金山文档链接无法在小程序内直达，接收同学需复制链接到浏览器打开。建议改用腾讯文档链接'
      : '';
    if (!url) {
      patch.noticeLinkName = '';
      patch.noticeLinkDetecting = false;
      patch.noticeLinkError = '';
      this.setData(patch);
      return;
    }
    const valid = /^https:\/\//i.test(url.trim());
    patch.noticeLinkDetecting = valid;
    this.setData(patch);
    if (!valid) return;
    clearTimeout(this._linkTimer);
    this._linkTimer = setTimeout(() => {
      api.linkTitle({ url: url.trim() }, { toast: false })
        .then((r) => {
          if (token !== this._linkToken) return;   // 已经继续输入了，丢弃旧结果
          const title = String((r && r.title) || '').trim();
          this.setData({
            noticeLinkDetecting: false,
            noticeLinkError: '',
            noticeLinkName: this.data.noticeLinkName.trim() ? this.data.noticeLinkName : (title || this.data.noticeLinkName)
          });
        })
        .catch((e) => {
          if (token !== this._linkToken) return;
          // 检测失败不打扰用户：显示名留空，提交时后端会兜底「在线文档」
          this.setData({ noticeLinkDetecting: false, noticeLinkError: String((e && e.errMsg) || '') });
        });
    }, 600);
  },
  onNoticeLinkName(e) { this.setData({ noticeLinkName: e.detail.value }); },
  onNoticeAck(e) { this.setData({ noticeNeedAck: !!e.detail.value }); },
  /** 一次性弹窗开关（v1.0.5） */
  onNoticePopupChange(e) { this.setData({ noticePopup: !!e.detail.value }); },

  /**
   * ⚠️ segmented 组件 emit 的是 `{ key }`（见 components/segmented/index.js），
   * **不是** `{ value }`。曾经写成 `String(e.detail.value)` → 拿到 `"undefined"` 字符串：
   * 于是 noticeScope 既不是 'ALL' 也不是 'PICK'，不但名单不展开、连 segmented 的高亮也不动，
   * 看起来就是「点『指定成员』没反应，再点『全体成员』也没反应」（用户 2026-09-25 反馈）。
   * 门禁：scripts/check-segmented.js
   */
  onNoticeScope(e) {
    const scope = String((e.detail && e.detail.key) || 'ALL');
    this.setData({ noticeScope: scope });
    // 名单懒加载：切到「指定成员」才去拉，避免每次打开弹层都多一次请求
    // （COMMITTEE / POSITION 不展开选人面板，接收人由服务端按班委集合 / 职位算定）
    if (scope === 'PICK' && !this.data.noticeMembers.length) this._loadNoticeMembers();
  },

  onNoticeKw(e) {
    this.setData({ noticeKw: String(e.detail.value || '') });
    this._loadNoticeMembers();
  },

  _loadNoticeMembers() {
    api.memberList({ public: 'manage', kw: this.data.noticeKw }, { toast: false })
      .then((list) => {
        // §42 隔离：测试账号（学号 2608057499xx）与辅导员（groupTag=X）不接收通知
        // （与 §39 全班通知口径一致：辅导员负责发布不接收；99 段是合成账号）。
        // picker 已自动隐藏；后端 msgPublish PICK 同步拦截防直接 POST 绕过。
        // 学号仅展示末两位（需求④）：前端按学号后两位算序号，与后端 seqOf 一致
        const rows = (list || [])
          .filter(x => x.status !== 'DISABLED')
          .filter(x => x.groupTag !== 'X')                                  // 辅导员不接收
          // 测试账号不接收：优先用后端 test 标记（辅导员的 studentNo 已被后端清空，
          // 只靠「学号 99 段」正则会漏判）
          .filter(x => !(x.test || String(x.studentNo || '').startsWith('2608057499')))
          .map(x => Object.assign({}, x, { seq: util.seqOf(x.studentNo) }))
          .sort((a, b) => a.seq - b.seq); // 按 1-56 顺序排列
        // 同步 pick：丢弃已被过滤掉（不可接收）的成员勾选，避免点了发布按钮还以为发了
        const validIds = new Set(rows.map(r => r.id));
        const cleanPick = {};
        Object.keys(this.data.noticePick).forEach(k => { if (validIds.has(Number(k))) cleanPick[k] = true; });
        this.setData(Object.assign({ noticeMembers: rows }, this._syncPick(cleanPick, rows)));
      })
      .catch(() => this.setData({ noticeMembers: [] }));
  },

  onNoticePick(e) {
    const id = Number(e.currentTarget.dataset.id);
    const pick = Object.assign({}, this.data.noticePick);
    if (pick[id]) delete pick[id]; else pick[id] = true;
    this.setData(this._syncPick(pick));
  },

  /** A/B 组一键切换：点击全选，再次点击取消全选 */
  onPickGroup(e) {
    const tag = String((e.currentTarget.dataset && e.currentTarget.dataset.tag) || '');
    if (tag !== 'A' && tag !== 'B') return;
    const groupIds = (this.data.noticeMembers || [])
      .filter(m => m.groupTag === tag)
      .map(m => m.id);
    if (!groupIds.length) return;
    const pick = Object.assign({}, this.data.noticePick);
    const allSelected = groupIds.every(id => pick[id]);
    if (allSelected) {
      groupIds.forEach(id => delete pick[id]);
    } else {
      groupIds.forEach(id => pick[id] = true);
    }
    this.setData(this._syncPick(pick));
  },

  /** 清空已选 */
  onClearPick() {
    this.setData(this._syncPick({}));
  },

  /** 同步 pick 计数与 A/B 组全选状态（按钮需要视觉反馈） */
  _syncPick(pick, members) {
    members = members || this.data.noticeMembers || [];
    const idsA = members.filter(m => m.groupTag === 'A').map(m => m.id);
    const idsB = members.filter(m => m.groupTag === 'B').map(m => m.id);
    return {
      noticePick: pick,
      noticePickedCount: Object.keys(pick).length,
      noticePickAllA: idsA.length > 0 && idsA.every(id => pick[id]),
      noticePickAllB: idsB.length > 0 && idsB.every(id => pick[id])
    };
  },

  onNoticeSubmit() {
    if (this.data.noticeBusy) return;
    const title = String(this.data.noticeTitle).trim();
    const content = String(this.data.noticeContent).trim();
    if (!content) { util.toast('请填写通知内容'); return; }
    const scope = this.data.noticeScope;
    const memberIds = Object.keys(this.data.noticePick).map(Number);
    if (scope === 'PICK' && !memberIds.length) { util.toast('请至少选择一位接收成员'); return; }
    // 多班级（需求④）：**一律显式传班级 id**。后端把「空数组」解释成「发布者本班」，
    // 所以想跨班就必须把 id 铺开传过去（辅导员「全部班级」按钮已改成显式全选）。
    // 非辅导员（班委 / 超管）恒为本班 —— 前端也只放本班一个 id，后端还会再兜一次。
    const classIds = (this.data.noticeAllClasses
      ? (this.data.noticeClasses || []).map(c => Number(c.id))
      : this.data.noticeClassIds
    ).slice();
    if (this.data.noticeShowClasses && !classIds.length) {
      util.toast('请至少选择一个发送班级'); return;
    }
    const positions = scope === 'POSITION'
      ? String(this.data.noticePositions || '').split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean)
      : [];
    if (scope === 'POSITION' && !positions.length) { util.toast('请至少选择一个职位'); return; }
    this.setData({ noticeBusy: true });
    // 配图先直传云存储（本地路径 → fileID），再随发布一起提交；无图则跳过上传
    const localImgs = this.data.noticeImages.slice();
    Promise.resolve()
      .then(() => {
        if (!localImgs.length) return [];
        wx.showLoading({ title: '上传图片 0/' + localImgs.length, mask: true });
        let done = 0;
        return Promise.all(localImgs.map((p, i) =>
          request.uploadFile('notice/' + Date.now() + '-' + i + '-' + Math.floor(Math.random() * 10000) + '.jpg', p)
            .then((id) => { done++; wx.showLoading({ title: '上传图片 ' + done + '/' + localImgs.length, mask: true }); return id; })
            .catch(() => { throw new Error('图片上传失败'); })
        ));
      })
      .then((fileIds) => {
        wx.hideLoading();
        return api.msgPublish({
          title,
          content,
          images: fileIds,
          linkUrl: String(this.data.noticeLinkUrl).trim(),
          linkName: String(this.data.noticeLinkName).trim(),
          scope,
          memberIds,
          classIds,
          positions,
          needAck: this.data.noticeNeedAck,
          popup: this.data.noticePopup
        }, { loading: '发布中' });
      })
      .then((r) => {
        this.setData({ noticeBusy: false, noticeShow: false });
        // v0.7.16（需求④）：发布成功立刻失效通知缓存 —— 自己与接收端下一次 onShow
        // 都会强制重拉列表 / 角标，不再等 15s TTL 自然过期
        notice.invalidate();
        const push = (r && r.push) || {};
        let msg = '通知已发布';
        if (push.skipped) msg += '（微信提醒待模板上线）';
        else if (push.sent) msg += '，已提醒 ' + push.sent + ' 人';
        util.toast(msg);
      })
      .catch(() => { wx.hideLoading(); this.setData({ noticeBusy: false }); });
  },

  /* ---------------- 提醒 ---------------- */
  /**
   * 微信通知：先要「订阅消息」授权（必须由点击触发），再顺手加手机日历。
   * 模板 ID 未配置（utils/config.js 为空）时只加日历，并如实提示。
   *
   * v0.7.15：悬浮胶囊有三种形态（见 index.wxml）——
   *   未开启 / 已开启但额度耗尽（remindBlock）/ 已开启且额度正常（隐藏）。
   * 「额度耗尽」分支走 `request()` 重新授权，成功后调 `remindReopen` 清掉后端标记。
   */
  onRemind() {
    if (this.data.remindBlock) {
      if (!subscribe.ready()) { util.toast('微信提醒待模板上线'); return; }
      subscribe.request().then((r) => {
        if (!r.ok) { util.toast('未授权成功，可稍后重试'); return; }
        api.remindReopen().catch(() => {}).then(() => {
          this.setData({ remindBlock: false });
          util.toast('已重新开启微信提醒');
        });
      });
      return;
    }
    if (this.data.remindOn) { util.toast('微信通知已打开'); return; }
    if (!subscribe.ready()) { this._enableRemind(true); return; }
    subscribe.request().then((r) => {
      if (!r.ok) { util.toast('未授权订阅消息，可在「我的」再试一次'); return; }
      this._enableRemind(false);
    });
  },

  /** 落地「已打开」：写 storage + 加手机重复日历（可选能力） */
  _enableRemind(noTemplate) {
    const hint = noTemplate ? '（微信提醒待模板上线）' : '';
    const done = (msg) => {
      wx.setStorageSync('remindOn', 1);
      this.setData({ remindOn: true });
      util.toast(msg + hint);
    };
    if (wx.addPhoneRepeatCalendar) {
      const start = Math.floor(Date.now() / 1000) + 86400;
      wx.addPhoneRepeatCalendar({
        title: '查看本周班级值日安排',
        startTime: start,
        endTime: start + 600,
        repeatInterval: 'week',
        repeatCount: 18,
        alarmOffset: 1800,
        success: () => done('已打开微信通知，并加入日历'),
        fail: () => done('已打开微信通知')
      });
    } else {
      done('已打开微信通知');
    }
  },

  /**
   * 测试提醒：向本人发一条值日提醒模板消息，弹窗回访「收到没」；
   * 没收到 / 发送失败则引导重新授权（详见 utils/subscribe.js runTest）。
   */
  onTestRemind() {
    if (this.data.remindBusy) return;
    this.setData({ remindBusy: true });
    subscribe.runTest(() => api.testRemind()).then(() => this.setData({ remindBusy: false }));
  },

  noop() {}
});
