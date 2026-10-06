/**
 * P6 · 成员与分组（独立页，从「我的」迁出，仅管理员可见入口）
 * 包含：成员列表 + 详情 + 调组/启停/解绑 + 导入名单 + 增删成员 + 撤回导入
 * 调组/解绑按钮对「自己」一律隐藏（自保 §41 需求①）。
 * 多班级（§43）：可由「班级管理 → 查看人员」带 classId 进入，查看指定班级；
 *   不带参数则看本班（classId=0，后端 targetClassId 回退本班）。
 * 名单增强（2026-09-25）：
 *   · 导入支持任意列序（姓名,学号 / 学号,姓名 / 班级,学号,姓名,…）；带「班级」列时先预览、再确认；
 *   · 每次导入可「撤回」；超管 / 辅导员可单个「添加」「移出」成员。
 * v0.7.9（2026-09-26）：
 *   · 列表新增「仅班委」筛选（纯展示层，members 保持全量供详情查找）；
 *   · 详情新增「设为班委 / 改班委职位」（超管 + 辅导员），职位取值唯一来源 util.POSITIONS，
 *     落库走 member.setPosition（同时写 role=ADMIN）。
 */
const api = require('../../utils/api');
const util = require('../../utils/util');
/** 列表过渡（全班 ⇄ 仅班委）：机制/时长/两阶段 setData 全在该模块，三页共用一份 */
const listTransition = require('../../utils/list-transition');
/** 成员名单内存缓存（v0.7.32 问题①）：同班回访先用缓存渲染、再后台刷新（SWR） */
const mem = require('../../utils/mem');

/** Date → 'YYYY-MM-DD'（本地时区；请假登记的原生 picker 取值格式） */
function ymd(d) {
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

Page({
  data: {
    statusBarHeight: 20,
    /** 目标班级 id；0 = 本班（后端按生效身份回退） */
    classId: 0,
    navTitle: '成员与分组',
    /** 是否在查看别的班级 */
    otherClass: false,
    /** 超管 / 辅导员：可移出成员、停用、撤回导入（破坏性操作） */
    canManage: false,
    /**
     * 名册录入权（需求 D，2026-09-27）：超管 / 辅导员 / 班长兼团支书。
     * 覆盖「添加成员」「导入名单」「调至 A/B 组」——即**增改**，不含移出/撤回。
     * 取值来自 auth.login 的 canRosterEdit（单一来源，避免与后端判定漂移）。
     */
    canRosterEdit: false,
    /** 职位授予权（需求 D）：仅超管。「生活委员」「班长兼团支书」两个授权职位置灰的依据 */
    canGrantPosition: false,
    /** 管理员 / 超管：详情里「解除微信绑定」等按钮的显示依据 */
    isAdmin: false,
    isSuper: false,
    /** 辅导员（groupTag='X'）：与超管同享「看绑定状态 / 停用成员」权限（v0.7.19） */
    isCounselor: false,
    /** 成员备注（v0.7.16 需求⑦）：仅教职工 + 超管可见可写 */
    noteVisible: false,
    noteList: [],
    noteDraft: '',
    noteEditId: 0,
    noteBusy: false,
    /** 主页关注（v0.7.17 需求⑥，权限与备注同源）：当前这个人是否已被固定到主页 */
    pinVisible: false,
    pinned: false,
    pinBusy: false,
    pinCount: 0,
    pinLimit: 8,

    memberStats: null,
    members: [],
    /** 列表展示用的（可能是筛选后的）成员；`members` 始终保留全量，供详情查找 */
    viewMembers: [],
    /** 首屏成员列表是否已加载完成：加载中显示骨架，避免「没有匹配的成员」闪现（Req 3） */
    membersLoaded: false,
    /** 「仅班委」筛选开关（2026-09-26 需求①） */
    onlyCommittee: false,
    /** 班委人数（用于筛选 chip 上的角标） */
    committeeCount: 0,
    /** 全班已绑定微信人数（只在未搜索时统计，避免把搜索结果当全班） */
    boundCount: 0,
    memberKw: '',
    mDetailShow: false,
    mDetail: null,
    /** 详情选中是否是自己；true 时调组/启停/解绑按钮一律隐藏 */
    mDetailIsSelf: false,

    /* 设置班委（超管 / 辅导员）：点开后在弹层里选具体职位 */
    posShow: false,
    /** [{ text, on }] —— on = 当前职位 */
    posList: [],
    posCurrent: '',
    /** 目标当前是否已是班委（决定是否显示「取消班委」） */
    posIsCommittee: false,

    importShow: false,
    importText: '',
    /** 'input' 粘贴阶段 → 'preview' 分组确认阶段 */
    importPhase: 'input',
    importBusy: false,
    importGroups: [],
    importClasses: [],
    importResult: null,
    lastBatch: null,
    /** 走的是 Excel 文件而不是粘贴文本 */
    importFromExcel: false,
    importFileId: '',
    importFileName: '',
    /** 缺失的班级自动新建（仅超管 / 辅导员可勾） */
    importCreateMissing: false,

    addShow: false,
    addName: '',
    addNo: '',
    addBusy: false,

    /* ---------- 1.0.5 需求④：请假登记（班委） ---------- */
    /** 请假登记权：超管 / 本班学生班委（来自 auth.login 的 canLeave，单一来源） */
    canLeave: false,
    /** 请假看板（后端 adjust.leaveBoard）：{ leave, leaveA, leaveB } + 前端算出的在位 */
    leaveStat: null,
    leaveShow: false,
    leaveList: [],
    /** 请假中查表：{ [memberId]: true } —— wxml 用 `leaveMap[item.id]` 判断（不动态改成员行，
     *  否则会被 _loadMembers 的异步回填覆盖） */
    leaveMap: {},
    /** 请假区间（YYYY-MM-DD）；打开弹层时默认今天 */
    leaveStart: '',
    leaveEnd: '',
    leaveKw: '',
    /** 选人列表（按搜索词过滤后的学生） */
    leaveCands: [],
    leaveBusy: false,
    /** 原生 picker 的日期上限（今天 + 一年），避免手滑选到很远的未来 */
    leaveMaxDate: '',
    /** 请假名单按 A/B 组拆分（顶部「请假人数」点击后只读查看用；登记弹层里也直接复用） */
    leaveListA: [],
    leaveListB: [],
    /** 辅导员只读名单弹层（辅导员只看不改，无撤销/登记） */
    leaveViewShow: false,
    leaveViewListA: [],
    leaveViewListB: []
  },

  onLoad(options) {
    const app = getApp();
    const o = options || {};
    const classId = Number(o.classId) || 0;
    const name = o.name ? decodeURIComponent(o.name) : '';
    /** 首页「关注的学生」深链带过来的成员 id：名单加载完自动打开他的详情（见 _openPendingMember） */
    this._pendingOpenId = Number(o.openMemberId) || 0;
    const p = (app && app.globalData && app.globalData.profile) || null;
    const isSuper = !!(app && app.isSuper && app.isSuper());
    const canManage = isSuper || !!(p && p.groupTag === 'X');
    const canRosterEdit = !!(app && app.canRosterEdit && app.canRosterEdit());
    const canGrantPosition = !!(app && app.canGrantPosition && app.canGrantPosition());
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight || 20,
      classId,
      otherClass: classId > 0,
      canManage,
      canRosterEdit,
      canGrantPosition,
      isSuper,
      isCounselor: !!(p && p.groupTag === 'X'),
      isAdmin: !!(app && app.isAdmin && app.isAdmin()),
      canLeave: !!(app && app.canLeave && app.canLeave()),
      navTitle: name ? (name + ' · 成员') : '成员与分组'
    });
    // 登录可能晚于 onLoad 完成：就绪后补一次身份，否则超管首屏看不到「解除微信绑定」
    if (app && app.globalData && !app.globalData.authChecked) {
      app.ready().then(() => {
        const p2 = (app.globalData && app.globalData.profile) || null;
        const s2 = !!(app.isSuper && app.isSuper());
        this.setData({
          isSuper: s2,
          isCounselor: !!(p2 && p2.groupTag === 'X'),
          isAdmin: !!(app.isAdmin && app.isAdmin()),
          canManage: s2 || !!(p2 && p2.groupTag === 'X'),
          canRosterEdit: !!(app.canRosterEdit && app.canRosterEdit()),
          canGrantPosition: !!(app.canGrantPosition && app.canGrantPosition()),
          canLeave: !!(app.canLeave && app.canLeave())
        }, () => {
          // ⚠️ 登录晚于 onLoad 完成时：onLoad/onShow 里那两次 _loadLeaveBoard 都会因为
          //    canLeave 还没算出来而直接 return —— 必须在这里补拉一次，
          //    否则班委首屏会看到「请假」入口却没有第二行统计（要退出重进才出现）。
          this._loadLeaveBoard();
        });
      });
    }
    this._loadStats();
    this._loadMembers();
    this._loadLeaveBoard();
    // ⚠️ v0.7.32 问题①：`class.list`（导入预览的选班）与 `importBatches`（撤回导入）
    //    **只在「导入名单」弹层里用到**，不再在进页面时发 —— 否则首屏要并发 5 个云函数
    //    （每个都可能有冷启动）。改到 onImportOpen 打开弹层时才拉。
  },

  onShow() {
    // 从详情回来时实时刷新统计
    this._loadStats();
    this._loadLeaveBoard();
  },

  /** 全班 ⇄ 仅班委的过渡链在页面销毁后不该继续（guard 见 _applyFilter） */
  onUnload() {
    this._ltToken = (this._ltToken || 0) + 1;
  },

  /** 统一的入参：带上目标班级（0 = 本班） */
  _payload(extra) {
    return Object.assign({ classId: this.data.classId }, extra || {});
  },

  _loadStats() {
    api.memberStats(this._payload(), { toast: false })
      .then((r) => this.setData({ memberStats: r }, () => this._applyLeaveStat()))
      .catch(() => {});
  },

  /* ================= 1.0.5 需求④：请假登记（班委） =================
   * 权限 = 超管 / 本班学生班委（后端 guard.requireLeaveRegister 真拦；前端只控制入口显隐）。
   * 口径：按**日期区间**登记；区间内已排的值日会被置「已请假」；可撤销并恢复值日。
   * 「在位人数」= 名册人数 − 当天请假人数（A/B 组同理）—— 两个数同源，不各自算一套。
   */

  /** 拉今日请假看板（名单 + 计数），并回填「请假中」查表
   *  权限：canLeave（班委/超管）或 isCounselor（辅导员只读）—— 辅导员也要看本班请假人数
   *  loud：用户**主动**打开登记/名单时传 true → 失败走 toast；页面加载/onShow 的静默刷新传空。 */
  _loadLeaveBoard(loud) {
    if (!this.data.canLeave && !this.data.isCounselor) return;
    api.leaveBoard(this._payload(), { toast: false })
      .then((r) => {
        const raw = (r && r.list) || [];
        const list = this._sanitizeLeaveRows(raw);
        this._applyLeaveRows(list, (r && r.stat) || {}, raw.length - list.length);
      })
      .catch((err) => { if (loud) util.toast((err && err.errMsg) || '请假名单加载失败，请重试'); });
  },

  /**
   * 把（可能已过滤的）请假行落到 data。
   * dropped>0 表示**过滤掉了不属于本班的行** → stat 必须按过滤后的行重算，
   * 否则「请假人数」还会是后端那份（串班的）数字。
   */
  _applyLeaveRows(list, backendStat, dropped) {
    const map = {};
    list.forEach(x => { map[x.memberId] = true; });
    const st = backendStat || {};
    const stat = dropped
      ? {
        leave: list.length,
        leaveA: list.filter(x => x.groupTag === 'A').length,
        leaveB: list.filter(x => x.groupTag === 'B').length
      }
      : {
        leave: st.leave != null ? st.leave : list.length,
        leaveA: st.leaveA != null ? st.leaveA : list.filter(x => x.groupTag === 'A').length,
        leaveB: st.leaveB != null ? st.leaveB : list.filter(x => x.groupTag === 'B').length
      };
    this.setData({
      leaveList: list,
      leaveListA: list.filter(x => x.groupTag === 'A'),
      leaveListB: list.filter(x => x.groupTag === 'B'),
      leaveMap: map,
      leaveStat: Object.assign({ leave: 0, leaveA: 0, leaveB: 0, onAll: 0, onA: 0, onB: 0 }, stat),
      leaveCands: this._leaveFilter(this.data.leaveKw, this.data.members)
    }, () => this._applyLeaveStat());
  },

  /**
   * **只保留本班成员**的请假行（v0.7.32 兜底，防跨班串号）。
   * 背景：云端 `adjust.leaveBoard` 曾出现「忽略传入班级、恒按调用者自己的班查」的旧版 ——
   * 超管查看别班时会把**本班**的请假名单端出来（用户实拍：示例班级A显示 示例班级C 的 8 人，
   * 点开「请假登记」名单里也是 示例班级C 的人）。这里用**本班名单**（`member.list` 的返回，
   * 它按班过滤是正确的）做一次交叉过滤：名单里没有的人一律剔除。
   * ⚠️ 只在**成员搜索为空**时启用 —— 搜索态下 `this.data.members` 是子集，过滤会误删。
   */
  _sanitizeLeaveRows(rows) {
    const kw = String(this.data.memberKw || '').trim();
    const members = this.data.members || [];
    if (kw || !members.length) return rows;
    const ids = {};
    members.forEach(m => { ids[m.id] = true; });
    return rows.filter(r => ids[r.memberId]);
  },

  /** 成员名单到齐（或搜索清空）后，对已渲染的请假名单再过滤一次（处理两者到达顺序的竞态） */
  _resanitizeLeave() {
    const cur = this.data.leaveList || [];
    if (!cur.length) return;
    const keep = this._sanitizeLeaveRows(cur);
    if (keep.length === cur.length) return;
    this._applyLeaveRows(keep, null, cur.length - keep.length);
  },

  /** 在位人数 = 名册人数 − 当天请假人数（A/B 组同理） */
  _applyLeaveStat() {
    const st = this.data.memberStats;
    const lv = this.data.leaveStat;
    if (!st || !lv) return;
    const leave = lv.leave || 0;
    const leaveA = lv.leaveA || 0;
    const leaveB = lv.leaveB || 0;
    this.setData({
      leaveStat: {
        leave,
        leaveA,
        leaveB,
        onAll: Math.max(0, (st.total || 0) - leave),
        onA: Math.max(0, (st.groupA || 0) - leaveA),
        onB: Math.max(0, (st.groupB || 0) - leaveB)
      }
    });
  },

  /** 选人候选：本班在读**学生**（排除教职工 X 组），按姓名/序号/学号过滤 */
  _leaveFilter(kw, rows) {
    const k = String(kw || '').trim().toLowerCase();
    return (rows || [])
      .filter(m => m.groupTag !== 'X')
      .filter(m => !k
        || String(m.name || '').toLowerCase().indexOf(k) >= 0
        || String(m.seq || '').indexOf(k) === 0
        || String(m.studentNo || '').indexOf(k) >= 0)
      .slice(0, 200);
  },

  onLeaveOpen() {
    const now = new Date();
    const today = ymd(now);
    this.setData({
      leaveShow: true,
      leaveStart: today,
      leaveEnd: today,
      leaveKw: '',
      leaveMaxDate: ymd(new Date(now.getFullYear() + 1, now.getMonth(), now.getDate())),
      leaveCands: this._leaveFilter('', this.data.members)
    });
    this._loadLeaveBoard(true);
  },

  onLeaveClose() {
    this.setData({ leaveShow: false });
  },

  /**
   * 顶部「请假人数」点击（1.0.5 追加，需求①②）：
   *   · 班委/超管 → 打开请假登记弹层（含 A/B 名单 + 撤销，复用 leaveShow）；
   *   · 辅导员   → 打开**只读**名单弹层（只看不改，无撤销/登记，leaveViewShow）。
   * 辅导员进具体班级时「只显请假人数、不显在位」，点开能看到 A/B 分组的人。
   */
  onLeaveViewOpen() {
    if (this.data.canLeave) { this.onLeaveOpen(); return; }
    if (this.data.isCounselor) {
      const list = this.data.leaveList || [];
      this.setData({
        leaveViewShow: true,
        leaveViewListA: list.filter(x => x.groupTag === 'A'),
        leaveViewListB: list.filter(x => x.groupTag === 'B')
      });
    }
  },

  onLeaveViewClose() {
    this.setData({ leaveViewShow: false });
  },

  onLeaveKw(e) {
    const kw = e.detail.value;
    this.setData({ leaveKw: kw, leaveCands: this._leaveFilter(kw, this.data.members) });
  },

  /** 原生日期选择（dataset.kind = start | end） */
  onLeaveDate(e) {
    const key = e.currentTarget.dataset.kind === 'end' ? 'leaveEnd' : 'leaveStart';
    this.setData({ [key]: e.detail.value });
  },

  /** 点某位同学 → 确认 → 按当前区间登记请假 */
  onLeavePick(e) {
    if (this.data.leaveBusy) return;
    const id = Number(e.currentTarget.dataset.id);
    const m = (this.data.members || []).find(x => x.id === id);
    if (!m) return;
    const { leaveStart, leaveEnd } = this.data;
    if (!leaveStart || !leaveEnd) { util.toast('请先选择请假日期'); return; }
    if (leaveEnd < leaveStart) { util.toast('结束日期不能早于开始日期'); return; }
    util.confirmStrict('为「' + m.name + '」登记 ' + leaveStart + ' ~ ' + leaveEnd + ' 的请假？\n区间内已排的值日会标记为「已请假」。', '请假登记')
      .then((act) => {
        if (act !== 'confirm') return;
        this.setData({ leaveBusy: true });
        api.leaveAdd({ memberId: id, startDate: leaveStart, endDate: leaveEnd }, { toast: false })
          .then((r) => {
            this.setData({ leaveBusy: false });
            util.toast((r && r.existed) ? '该区间已登记过' : '已登记请假');
            this._loadLeaveBoard();
          })
          .catch((err) => {
            this.setData({ leaveBusy: false });
            util.toast((err && err.errMsg) || '登记失败，请重试');
          });
      });
  },

  /** 撤销某条请假（并恢复区间内的值日） */
  onLeaveCancelTap(e) {
    if (this.data.leaveBusy) return;
    const leaveId = Number(e.currentTarget.dataset.id);
    const item = (this.data.leaveList || []).find(x => x.leaveId === leaveId);
    if (!item) return;
    util.confirmStrict('撤销「' + item.name + '」' + item.startDate + ' ~ ' + item.endDate + ' 的请假？\n区间内被标记为「已请假」的值日会恢复。', '撤销请假')
      .then((act) => {
        if (act !== 'confirm') return;
        this.setData({ leaveBusy: true });
        api.leaveCancel({ leaveId }, { toast: false })
          .then((r) => {
            this.setData({ leaveBusy: false });
            util.toast((r && r.restored) ? ('已撤销，恢复 ' + r.restored + ' 条值日') : '已撤销');
            this._loadLeaveBoard();
          })
          .catch((err) => {
            this.setData({ leaveBusy: false });
            util.toast((err && err.errMsg) || '撤销失败，请重试');
          });
      });
  },

  /** 可选班级（用于导入预览里手动指定归属） */
  _loadClasses() {
    api.classList({ all: true }, { toast: false })
      .then((list) => this.setData({ importClasses: util.sortClasses((list || []).filter(c => c.isActive !== false)) }))
      .catch(() => {});
  },

  /** 最近一次可撤回的导入 */
  _loadLastBatch() {
    api.importBatches(this._payload(), { toast: false })
      .then((list) => {
        const b = (list || []).find(x => !x.reverted) || null;
        this.setData({ lastBatch: b });
      })
      .catch(() => this.setData({ lastBatch: null }));
  },

  onBack() {
    wx.navigateBack({ delta: 1, fail: () => wx.switchTab({ url: '/pages/home/index' }) });
  },

  _loadMembers() {
    const kw = this.data.memberKw;
    const key = mem.keys.roster(this.data.classId, kw);
    // v0.7.32 问题①：同班回访先用**内存缓存**同步渲染（不闪骨架），再后台刷新（SWR）
    const cached = mem.read(key);
    if (cached && cached.length) this._applyMemberRows(cached, kw);
    api.memberList(this._payload({ public: 'manage', kw }), { toast: false })
      .then((list) => {
        // 2026-10-04 需求③：成员与分组**不显示教职工（辅导员）** —— 教职工的账号与绑定
        // 情况只在「班级管理 → 教职工管理」里维护。后端 list 的 manage 分支**不过滤 X**
        // （因为「切换测试账号」要能切到测试辅导员），所以按生效身份在这里过滤。
        const rows = (list || []).filter(x => x.groupTag !== 'X').map(x => {
          const rt = util.roleTag(x);
          return Object.assign({}, x, {
            // 辅导员（X 组）不展示学号：seq 只用于排序，给一个大值让他留在列表末尾
            // （展示层由 groupTag==='X' 分支接管，不会出现「999 号」）
            seq: x.groupTag === 'X' ? 999 : util.seqOf(x.studentNo),
            // 优先用后端返回的 test 标记 —— 辅导员的学号已被后端清空，正则判不出来了
            test: !!x.test || String(x.studentNo || '').indexOf('2608057499') === 0,
            roleTag: rt ? rt.text : '',
            roleTier: rt ? rt.tier : '',
            // 列表过渡的内联样式落点（v0.7.21 需求⑤）；wxml 用 style="{{item.lt}}"
            lt: ''
          });
        });
        rows.sort((a, b) => a.seq - b.seq);
        mem.write(key, rows);
        this._applyMemberRows(rows, kw);
      })
      .catch(() => { if (!cached) this.setData({ members: [], viewMembers: [], membersLoaded: true }); });
  },

  /** 把整理好的名单行落到 data（缓存渲染与网络回填共用同一条路径，避免两套写法漂移） */
  _applyMemberRows(rows, kw) {
    const patch = {
      members: rows,
      viewMembers: this._filterRows(rows, this.data.onlyCommittee),
      committeeCount: rows.filter(x => this._isCommittee(x)).length,
      membersLoaded: true
    };
    // 2026-10-04 需求②：「已绑定」不含测试账号与辅导员（辅导员行已在上游滤掉，这里再兜一层）
    if (!kw) patch.boundCount = rows.filter(x => x.bound && !x.test && x.groupTag !== 'X').length;
    this.setData(patch);
    this._openPendingMember(rows);
    // v0.7.32：名单到齐后，对「已经渲染出来的请假名单」再过滤一次 ——
    // 首页/本页的 leaveBoard 可能先于 member.list 返回，那时没有名单可比对。
    this._resanitizeLeave();
  },

  /**
   * 深链自动打开某位成员的详情（v0.7.17 需求⑥）：
   * 首页「关注的学生」卡片点进来时带 openMemberId，落到这里直接把详情弹出来 ——
   * 否则用户还要在几十行名单里自己再找一遍，等于没省事。
   * ⚠️ 只在**名单加载完成之后**按 id 查，不要在 onLoad 里查（那时 members 还是空的）。
   */
  _openPendingMember(rows) {
    const id = Number(this._pendingOpenId) || 0;
    if (!id) return;
    this._pendingOpenId = 0;      // 只自动打开一次：用户关掉详情后不该再弹回来
    const hit = (rows || []).find(x => Number(x.id) === id);
    if (!hit) { util.toast('该学生不在这个班级里'); return; }
    this.onMemberRow({ currentTarget: { dataset: { id: hit.id } } });
  },

  /**
   * 「班委」判据（2026-09-26 需求①）：有管理身份、且不是辅导员（教职工）、不是测试账号。
   * 超管（宋艾霖·生活委员）也算班委 —— 他确实担任着一个班委职位。
   */
  _isCommittee(x) {
    return !!x && (x.role === 'ADMIN' || x.role === 'MONITOR')
      && x.groupTag !== 'X' && !x.test;
  },

  /** 按「仅班委」开关过滤；筛选是纯展示层行为，不动 members（详情查找仍按全量） */
  _filterRows(rows, only) {
    return only ? (rows || []).filter(x => this._isCommittee(x)) : (rows || []);
  },

  /**
   * 全班 ⇄ 仅班委（v0.7.21 需求⑤）：
   * 被筛掉的行**边渐隐边塌缩行高**（不是先渐隐、留一块空白再突然跳位），
   * 保留下来的行被布局连续带走；切回全班时新出现的行从 0 高度展开 + 从下方淡入。
   * ⚠️ 这段过渡的机制、时长、两阶段 setData 全在 utils/list-transition.js，
   *    三页共用一份；这里只负责说清「现在筛谁」和「补丁长什么样」。
   * ⚠️ 列表项必须有稳定 wx:key（这里是 id）+ 稳定的 data-id，FLIP/塌缩靠它认人。
   */
  _applyFilter(only) {
    const lt = listTransition;
    // 打断令牌：chip 连点时，上一轮的 setTimeout 醒来发现令牌变了就自己退出，
    // 不会回来把新一轮的 max-height / opacity 清掉（否则第二轮会被「按住」）
    const tk = (this._ltToken = (this._ltToken || 0) + 1);
    lt.filterSwap(this, {
      sel: '.mb-row[data-id]',
      key: 'id',
      field: 'lt',
      guard: () => this._ltToken === tk,
      cur: () => this.data.viewMembers,
      next: () => this._filterRows(this.data.members, only),
      // 选中态（chip 高亮）立刻生效，不等动画 —— 控件必须马上响应，动画只是内容的
      patch: (rows) => ({ viewMembers: rows, onlyCommittee: only })
    });
  },

  onToggleCommittee() {
    this._applyFilter(!this.data.onlyCommittee);
  },

  /** 「全班」chip：关掉筛选（点两次同一个 chip 不会来回抖） */
  onFilterAll() {
    if (!this.data.onlyCommittee) return;
    this._applyFilter(false);
  },

  onMemberKw(e) {
    this.setData({ memberKw: String(e.detail.value || '') });
    this._loadMembers();
  },

  onMemberRow(e) {
    const id = Number(e.currentTarget.dataset.id);
    const m = this.data.members.find(x => x.id === id);
    if (!m) return;
    const app = getApp();
    const me = (app && app.globalData && app.globalData.profile) || null;
    const isCounselor = !!(me && me.groupTag === 'X');
    const noteVisible = isCounselor || !!(app && app.isSuper && app.isSuper());
    this.setData({
      mDetailShow: true,
      mDetail: m,
      mDetailIsSelf: !!(me && me.id === m.id),
      isCounselor,
      noteVisible,
      // 主页关注**仅辅导员**（v0.7.18 需求①）：超管不再有这个入口，与后端 pinList/pinToggle 同口径
      pinVisible: isCounselor,
      noteList: [],
      noteDraft: '',
      noteEditId: 0
    });
    if (noteVisible) {
      this._loadNotes(m.id);
    }
    if (isCounselor) {
      this._loadPinState(m.id);
    }
  },

  onMDetailClose() { this.setData({ mDetailShow: false }); },

  /* ---------------- 主页关注（v0.7.17 需求⑥） ---------------- */

  /**
   * 关注状态：`pinList` 最多 8 条，一次拉全量后本地判定，不为「这一条是否已关注」再开一个接口。
   * 详情页只要判断布尔值 + 显示已用名额，全量数据足够。
   */
  _loadPinState(memberId) {
    api.pinList({}, { toast: false })
      .then((r) => {
        const list = (r && r.list) || [];
        this.setData({
          pinned: list.some(x => Number(x.memberId) === Number(memberId)),
          pinCount: list.length,
          pinLimit: Number((r && r.limit) || 8)
        });
      })
      .catch(() => {});
  },

  onTogglePin() {
    const m = this.data.mDetail;
    if (!m || this.data.pinBusy) return;
    this.setData({ pinBusy: true });
    api.pinToggle({ memberId: m.id }, { toast: false })
      .then((r) => {
        const nowPinned = !!(r && r.pinned);
        this.setData({
          pinBusy: false,
          pinned: nowPinned,
          pinCount: Number((r && r.count) || 0),
          pinLimit: Number((r && r.limit) || 8)
        });
        util.toast(nowPinned ? '已固定到主页' : '已取消固定');
      })
      .catch((e) => {
        this.setData({ pinBusy: false });
        util.toast((e && e.errMsg) || '操作失败');
      });
  },


  /* ---------------- 成员备注（v0.7.16 需求⑦，仅教职工 + 超管） ---------------- */

  _loadNotes(memberId) {
    api.noteList({ memberId }, { toast: false })
      .then((list) => {
        this.setData({
          noteList: (list || []).map(x => Object.assign({}, x, {
            createdAtText: String(x.createdAt || '').replace('T', ' ').slice(5, 16)
          }))
        });
      })
      .catch(() => {});
  },

  onNoteInput(e) { this.setData({ noteDraft: e.detail.value }); },

  /** 点自己写的备注 = 载入草稿改为编辑（保存走 noteSave 带 id） */
  onNoteEdit(e) {
    const id = Number(e.currentTarget.dataset.id) || 0;
    const hit = (this.data.noteList || []).find(x => x.id === id);
    if (!hit) return;
    this.setData({ noteEditId: id, noteDraft: hit.content });
  },

  /** 退出编辑态，回到「写一条新备注」（草稿丢弃） */
  onNoteCancel() {
    this.setData({ noteEditId: 0, noteDraft: '' });
  },

  onNoteSave() {
    const m = this.data.mDetail;
    if (!m || this.data.noteBusy) return;
    const content = String(this.data.noteDraft || '').trim();
    if (!content) { util.toast('备注内容不能为空'); return; }
    this.setData({ noteBusy: true });
    api.noteSave(
      { memberId: m.id, content, id: this.data.noteEditId || undefined },
      { loading: '保存中' }
    )
      .then(() => {
        this.setData({ noteBusy: false, noteDraft: '', noteEditId: 0 });
        util.toast('备注已保存');
        this._loadNotes(m.id);
      })
      .catch((e) => { this.setData({ noteBusy: false }); util.toast((e && e.errMsg) || '保存失败'); });
  },

  onNoteDelete(e) {
    const id = Number(e.currentTarget.dataset.id) || 0;
    if (!id) return;
    util.confirm('删除这条备注？', '删除备注').then((ok) => {
      if (!ok) return;
      api.noteDelete({ id }, { loading: '删除中' })
        .then(() => { util.toast('已删除'); this._loadNotes(this.data.mDetail.id); })
        .catch((err) => util.toast((err && err.errMsg) || '删除失败'));
    });
  },

  onToggleGroup() {
    const m = this.data.mDetail;
    if (!m) return;
    if (this.data.mDetailIsSelf) return;        // 自保：不给调组
    // 需求 D：调 A/B 组属名册编辑（影响轮转公平），与导入写入同集合
    if (!this.data.canRosterEdit) { util.toast('仅超级管理员、辅导员或班长可调整分组'); return; }
    const tag = m.groupTag === 'A' ? 'B' : 'A';
    api.updateGroup(this._payload({ memberId: m.id, groupTag: tag }), { loading: '处理中' })
      .then(() => {
        util.toast('已调整到 ' + tag + ' 组');
        this.setData({ mDetailShow: false });
        this._loadMembers();
      })
      .catch(() => {});
  },

  onToggleStatus() {
    const m = this.data.mDetail;
    if (!m) return;
    if (this.data.mDetailIsSelf) return;        // 自保：不给启停
    const status = m.status === 'DISABLED' ? 'ACTIVE' : 'DISABLED';
    api.setMemberStatus(this._payload({ memberId: m.id, status }), { loading: '处理中' })
      .then(() => {
        util.toast(status === 'DISABLED' ? '已停用' : '已恢复');
        this.setData({ mDetailShow: false });
        this._loadMembers();
      })
      .catch(() => {});
  },

  /**
   * 设置班委（2026-09-26 需求②）：超管 + 辅导员可用。
   * 点「设为班委 / 改班委职位」→ 弹层里选具体职位（取值唯一来源 util.POSITIONS）。
   * 已是班委时，弹层里额外提供「取消班委」。
   * 需求 D（2026-09-27）：职位分两类 —— 「生活委员」「班长兼团支书」是**授权职位**
   * （前者给排班权、后者给名册录入权），任免只有超管能点；其余职位辅导员照旧可任免。
   * 前端置灰只是提示，真正拦截在云函数 `member.setPosition` 的 requirePositionGrant。
   */
  onOpenPosition() {
    const m = this.data.mDetail;
    if (!m) return;
    if (!this.data.canManage) { util.toast('仅超级管理员或辅导员可设置班委'); return; }
    if (this.data.mDetailIsSelf) return;             // 自保：不给自己调班委身份
    if (m.groupTag === 'X') { util.toast('辅导员不是学生班委'); return; }
    if (m.isSuper) { util.toast('超级管理员的身份不能在这里修改'); return; }
    const isCommittee = this._isCommittee(m);
    const canGrant = !!this.data.canGrantPosition;
    this.setData({
      posShow: true,
      posCurrent: isCommittee ? (m.position || '') : '',
      posIsCommittee: isCommittee,
      posList: util.POSITIONS.map(p => ({
        text: p,
        on: isCommittee && p === (m.position || ''),
        // 授权职位对非超管置灰（含「撤销」场景：m.position 本身就落在这两项上）
        locked: !canGrant && util.GRANTED_POSITIONS.indexOf(p) >= 0
      }))
    });
  },

  onPosClose() { this.setData({ posShow: false }); },

  /** 选中某个职位 → 落库（role 同时置为 ADMIN） */
  onPickPosition(e) {
    const m = this.data.mDetail;
    if (!m) return;
    const position = String(e.currentTarget.dataset.pos || '');
    if (!position) return;
    // 授权职位：非超管一律拦下并说明原因（不静默返回，避免「点了没反应」）
    if (!this.data.canGrantPosition && util.GRANTED_POSITIONS.indexOf(position) >= 0) {
      util.toast('「' + position + '」由超级管理员任命');
      return;
    }
    this._savePosition(m, position);
  },

  /** 取消班委（清空职位 + role 置回 MEMBER） */
  onCancelPosition() {
    const m = this.data.mDetail;
    if (!m) return;
    // 目标当前职位是授权职位时，撤销同样属「授予权」范围 → 仅超管
    if (!this.data.canGrantPosition && util.GRANTED_POSITIONS.indexOf(String(m.position || '')) >= 0) {
      util.toast('「' + m.position + '」的撤销由超级管理员操作');
      return;
    }
    util.confirm('取消「' + m.name + '」的班委身份？其职位也会一并清空', '取消班委').then((ok) => {
      if (!ok) return;
      this._savePosition(m, '');
    });
  },

  _savePosition(m, position) {
    api.setMemberPosition(this._payload({ memberId: m.id, position }), { loading: '处理中' })
      .then(() => {
        util.toast(position ? ('已设为' + position) : '已取消班委');
        this.setData({ posShow: false, mDetailShow: false });
        this._loadMembers();
        /*
         * v0.7.32 问题②：职位变更会改变「班委专属入口」的可见性 ——
         *   · 置 rosterDirty → 首页 onShow 强制跳过 STALE_MS 重拉（同一台设备立即生效）；
         *   · 若改的是**本人**，本地 profile（角色/职位）也变了，顺手重校一次身份。
         * 别人手机上的那位：由对方 tab 页 onShow 的节流身份重校兜住（见 app.recheckAuth）。
         */
        const app = getApp();
        if (app && app.globalData) app.globalData.rosterDirty = true;
        if (this.data.mDetailIsSelf && app && app.refreshAuth) app.refreshAuth().catch(() => {});
      })
      .catch(() => {});
  },

  /** 解除微信绑定（不可逆）。解绑自己 = 两次确认 + 跳回绑定页。 */
  onUnbindMember() {
    const m = this.data.mDetail;
    if (!m) return;
    if (this.data.mDetailIsSelf) return;        // 自保：走自己的「解除绑定」入口
    const firstTip = '解除后「' + m.name + '」需重新绑定才能使用。';
    util.confirm(firstTip, '解除微信绑定').then((ok) => {
      if (!ok) return;
      api.unbindMember(this._payload({ memberId: m.id }), { loading: '处理中' })
        .then(() => {
          util.toast('已解除绑定');
          this.setData({ mDetailShow: false });
          this._loadMembers();
        })
        .catch(() => {});
    });
  },

  /** 移出班级（超管 / 辅导员）：删成员 + 未开始的值日 */
  onRemoveMember() {
    const m = this.data.mDetail;
    if (!m || !this.data.canManage) return;
    if (m.bound) { util.toast('该成员已绑定微信，请先解除绑定'); return; }
    util.confirm('将「' + m.name + '」移出本班名单？未开始的值日会一并移除', '移出班级').then((ok) => {
      if (!ok) return;
      api.removeMember(this._payload({ memberId: m.id }), { loading: '处理中' })
        .then((r) => {
          util.toast('已移出' + ((r && r.dutyRemoved) ? '（含 ' + r.dutyRemoved + ' 条值日）' : ''));
          this.setData({ mDetailShow: false });
          this._loadMembers();
          this._loadStats();
        })
        .catch(() => {});
    });
  },

  /* ---------------- 单个添加成员（超管 / 辅导员 / 班长，需求 D） ---------------- */
  onAddOpen() {
    if (!this.data.canRosterEdit) { util.toast('仅超级管理员、辅导员或班长可添加成员'); return; }
    this.setData({ addShow: true, addName: '', addNo: '', addBusy: false });
  },
  onAddClose() { this.setData({ addShow: false }); },
  onAddName(e) { this.setData({ addName: String(e.detail.value || '') }); },
  onAddNo(e) { this.setData({ addNo: String(e.detail.value || '') }); },
  onAddSubmit() {
    if (this.data.addBusy) return;
    const name = String(this.data.addName || '').trim();
    const studentNo = String(this.data.addNo || '').trim();
    if (!name) { util.toast('请填写姓名'); return; }
    if (!/^[A-Za-z0-9]{4,32}$/.test(studentNo)) { util.toast('请填写正确的学号（4 位以上数字）'); return; }
    this.setData({ addBusy: true });
    api.addMember(this._payload({ name, studentNo }), { loading: '添加中' })
      .then((r) => {
        this.setData({ addShow: false, addBusy: false });
        util.toast('已添加至 ' + r.groupTag + ' 组');
        this._loadMembers();
        this._loadStats();
      })
      .catch(() => this.setData({ addBusy: false }));
  },

  /* ---------------- 导入名单（粘贴 / Excel → 预览 → 确认） ---------------- */
  onImportOpen() {
    // 需求 D：导入=批量增改名册，与「添加成员」同集合
    if (!this.data.canRosterEdit) { util.toast('仅超级管理员、辅导员或班长可导入名单'); return; }
    // v0.7.32 问题①：这两个请求改为「开弹层才拉」（过去在 onLoad 就发，拖慢首屏）
    this._loadClasses();
    this._loadLastBatch();
    this.setData({
      importShow: true, importPhase: 'input', importText: '',
      importGroups: [], importResult: null, importBusy: false,
      importFromExcel: false, importFileId: '', importFileName: '', importCreateMissing: false
    });
  },
  onImportClose() { this.setData({ importShow: false }); },
  onImportText(e) { this.setData({ importText: String(e.detail.value || '') }); },

  /** 从聊天里选一个 Excel / CSV 文件（微信只允许从小程序外部选文件） */
  onImportPickFile() {
    if (this.data.importBusy) return;
    if (!wx.chooseMessageFile) { util.toast('当前微信版本不支持选择文件，请改用上面的粘贴方式'); return; }
    /*
     * ⚠️ `extension` 每一项**必须带点**（官方要求，如 '.xlsx'）。之前写成 'xlsx' 会被当作
     * 过滤条件且匹配不到任何文件 → 聊天里明明有表格却「无文件可选」。
     * 这里索性**不加过滤**（只限定 type='file'），选完再由 _uploadAndPreview 校验后缀：
     * 宁可列表里多几项，也不要出现「一个都选不了」。
     */
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      success: (res) => {
        const f = (res.tempFiles || [])[0];
        if (!f) { util.toast('没有选到文件'); return; }
        this._uploadAndPreview(f);
      },
      fail: (err) => {
        // 用户主动取消不算失败，别弹提示
        if (String((err && err.errMsg) || '').indexOf('cancel') >= 0) return;
        util.toast('打开文件列表失败，可改用上面的粘贴方式');
      }
    });
  },

  _uploadAndPreview(f) {
    const name = f.name || 'roster.xlsx';
    const ext = String(name.split('.').pop() || '').toLowerCase();
    if (['xlsx', 'csv'].indexOf(ext) < 0) {
      util.toast('请选择 .xlsx 或 .csv 文件（旧版 .xls 请先另存为 .xlsx）');
      return;
    }
    const cloudPath = 'import/' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.' + ext;
    wx.showLoading({ title: '读取中', mask: true });
    wx.cloud.uploadFile({
      cloudPath,
      filePath: f.path,
      success: (r) => {
        wx.hideLoading();
        this.setData({ importFileId: r.fileID, importFileName: name });
        this._runPreview({ fileId: r.fileID }, { fromExcel: true });
      },
      fail: () => { wx.hideLoading(); util.toast('文件上传失败，请重试'); }
    });
  },

  /** 第一阶段：解析预览（不写库） —— 有粘贴文本走文本，否则用已选的文件 */
  onImportParse() {
    if (this.data.importBusy) return;
    if (String(this.data.importText).trim()) {
      this._runPreview({ text: this.data.importText }, { fromExcel: false });
      return;
    }
    if (this.data.importFileId) {
      this._runPreview({ fileId: this.data.importFileId }, { fromExcel: true });
      return;
    }
    util.toast('请粘贴名单，或从聊天选择一个表格');
  },

  _runPreview(extra, opts) {
    if (this.data.importBusy) return;
    this.setData({ importBusy: true });
    const call = opts.fromExcel ? api.importExcel : api.importCsv;
    call(this._payload(Object.assign({ preview: true }, extra)), { loading: '解析中' })
      .then((r) => {
        const rows = (r.groups || []).map(g => Object.assign({}, g, {
          // 默认勾选：已匹配到班、且不是「可疑（weak）/冲突（conflict）」
          include: !!g.classId && !g.weak && !g.conflict
        }));
        this.setData({
          importBusy: false, importGroups: rows, importPhase: 'preview',
          importFromExcel: !!opts.fromExcel
        });
        if (!rows.length) util.toast('没有解析到有效名单');
      })
      .catch(() => this.setData({ importBusy: false }));
  },

  onImportBack() { this.setData({ importPhase: 'input' }); },

  onToggleCreateMissing(e) {
    this.setData({ importCreateMissing: !!e.detail.value });
  },

  onToggleInclude(e) {
    const i = Number(e.currentTarget.dataset.i);
    const groups = this.data.importGroups.slice();
    if (!groups[i]) return;
    groups[i] = Object.assign({}, groups[i], { include: !groups[i].include });
    this.setData({ importGroups: groups });
  },

  /** 给某个分组手动指定归属班级（同班号不同专业 / 未匹配时用） */
  onPickGroupClass(e) {
    const i = Number(e.currentTarget.dataset.i);
    const g = this.data.importGroups[i];
    if (!g) return;
    const classes = this.data.importClasses || [];
    if (!classes.length) { util.toast('没有可选班级'); return; }
    wx.showActionSheet({
      itemList: classes.map(c => c.name),
      success: (res) => {
        const cls = classes[res.tapIndex];
        if (!cls) return;
        const groups = this.data.importGroups.slice();
        groups[i] = Object.assign({}, g, { classId: Number(cls.id), className: cls.name, include: true, weak: false, conflict: false });
        this.setData({ importGroups: groups });
      }
    });
  },

  /** 第二阶段：按确认结果写入（可顺带新建缺失班级） */
  onImportConfirm() {
    if (this.data.importBusy) return;
    const picked = (this.data.importGroups || []).filter(g => g.include);
    if (!picked.length) { util.toast('请至少选择一个要导入的班级'); return; }
    const mapping = {};
    const createLabels = [];
    picked.forEach((g) => {
      if (g.classId) mapping[g.label] = g.classId;
      else if (this.data.importCreateMissing && g.label) createLabels.push(g.label);
    });
    if (!Object.keys(mapping).length && !createLabels.length) {
      util.toast('选中的分组还没有归属班级：请「选班」或打开「自动新建班级」');
      return;
    }
    const payload = this._payload({
      mapping,
      createLabels,
      createMissing: this.data.importCreateMissing && createLabels.length > 0
    });
    if (this.data.importFromExcel) payload.fileId = this.data.importFileId;
    else payload.text = this.data.importText;

    const call = this.data.importFromExcel ? api.importExcel : api.importCsv;
    this.setData({ importBusy: true });
    call(payload, { loading: '导入中' })
      .then((r) => {
        this.setData({
          importBusy: false, importResult: r, importPhase: 'input', importText: '',
          importGroups: [], importFromExcel: false, importFileId: '', importFileName: ''
        });
        const parts = [];
        if (r.imported) parts.push('新增 ' + r.imported + ' 人');
        if (r.updated) parts.push('更新 ' + r.updated + ' 人');
        if (r.skipped) parts.push('跳过 ' + r.skipped + ' 人');
        if (r.createdClasses && r.createdClasses.length) parts.push('新建 ' + r.createdClasses.length + ' 个班级');
        const content = parts.join('，') || '没有变化';
        this._loadMembers();
        this._loadStats();
        this._loadClasses();
        this._loadLastBatch();
        wx.showModal({
          title: '导入完成',
          content: content
            + (r.createdClasses && r.createdClasses.length ? '\n新建班级：' + r.createdClasses.join('、') : '')
            + (r.skipped ? '\n（跳过：学号已属于其它班级）' : '')
            + '\n\n要撤回这次导入吗？',
          confirmText: '撤回',
          cancelText: '完成',
          confirmColor: '#F53F3F',
          success: (res) => { if (res.confirm) this._doRevert(r.batchId); }
        });
      })
      .catch(() => this.setData({ importBusy: false }));
  },

  /* ---------------- 撤回导入 ---------------- */
  onRevertTap() {
    const b = this.data.lastBatch;
    if (!b) { util.toast('没有可撤回的导入记录'); return; }
    util.confirm('将删除这次导入新增的 ' + b.inserted + ' 人（已绑定或有值日的会跳过）', '撤回这次导入').then((ok) => {
      if (!ok) return;
      this._doRevert(b.id);
    });
  },

  _doRevert(batchId) {
    api.revertImport(this._payload({ batchId }), { loading: '撤回中' })
      .then((r) => {
        let msg = '已撤回：删除 ' + r.removed + ' 人';
        if (r.restored) msg += '，还原 ' + r.restored + ' 人';
        if (r.skipped) msg += '，跳过 ' + r.skipped + ' 人';
        util.toast(msg);
        this.setData({ importResult: null });
        this._loadMembers();
        this._loadStats();
        this._loadLastBatch();
      })
      .catch(() => {});
  }
});
