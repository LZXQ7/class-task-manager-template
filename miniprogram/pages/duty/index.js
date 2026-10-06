/**
 * P4 · 本周值日表（Tab 3）
 * 同学：按日 / 按人查看本周安排；管理员（超管）：生成 / 发布 / 换人 / 导出
 * 手动排班（P5）的入口在「我的」页，本页不再提供。
 * 注意：本工具只做值日提醒，不做打卡与照片凭证。
 */
const api = require('../../utils/api');
const util = require('../../utils/util');
const pageAnim = require('../../utils/page-anim');
const mem = require('../../utils/mem');
const swipe = require('../../utils/swipe');
/** 列表过渡（按日 ⇄ 按人）：机制/时长/可打断全在该模块，与 roster / timetable 共用一份 */
const listTransition = require('../../utils/list-transition');
const impersonate = require('../../utils/impersonate');

/** 数据新鲜度窗口：切换回本页时，只要在这个窗口内拉过数据，就直接复用、不再发起请求 */
const STALE_MS = 20000;

/**
 * 合并行汇总状态（1.0.4.4 #27）：同一节课的若干人合成一行，右侧只放一个汇总 pill。
 * 取「最未完成」者为准：待值日(PENDING) > 进行中(ONGOING) > 已值日(DONE) > 已结束(EXPIRED)。
 * 纯前端展示聚合，不改库、不影响单条 duty 的状态。
 */
function aggregateDutyStatus(statuses) {
  const rank = { PENDING: 0, ONGOING: 1, DONE: 2, EXPIRED: 3 };
  let best = 'EXPIRED';
  let bestRank = 99;
  (statuses || []).forEach((s) => {
    const r = rank[s] != null ? rank[s] : 99;
    if (r < bestRank) { bestRank = r; best = s; }
  });
  return best;
}

/**
 * 写操作（生成 / 发布 / 撤回 / 清空）的 busy 看门狗上限。
 * ------------------------------------------------------------
 * 为什么要有它（2026-09-26 用户反馈「点『按序号轮转』后没有任何反应」）：
 * 这四个入口都靠页面级 `busy` 做重入保护，命中就是一句裸 `return` ——
 * 不弹窗、不提示、按钮也不变。只要有一次请求卡住（云函数冷启动/网络挂起，
 * wx.cloud.callFunction 最长能吊 60s）或者 `.then` 里抛了个错，`busy` 就永久
 * 停在 true，之后**每一次**点击都被静默吞掉，表现正是「点了没反应」。
 * 现在：① busy 有上限，到点自动复位并告诉用户；② 命中 busy 时给反馈，
 * ③ 「上一次请求其实早没了」的残留 busy 直接放行，不让它挡住本次点击。
 */
const BUSY_TIMEOUT_MS = 15000;

Page({
  data: {
    statusBarHeight: 20,
    /** Tab 入场动画序号：0 = 还没进过（播完整版），之后在 1 / 2 之间轮换（轻量版），见 utils/page-anim.js */
    animSeq: 0,
    /** 入场动画就绪标记（v0.7.31）：false = 根节点挂 pa-hold（块透明），等首屏身份+数据就绪再统一开播 */
    paReady: false,
    loading: true,
    failed: false,
    isAdmin: false,
    isSuper: false,
    /** 「切换测试账号」模拟态顶部横幅（v1.0.5）：非空即渲染红色护栏条 */
    impersonateBanner: '',
    /** 教职工（辅导员）视角（v0.7.16 需求⑧）：顶部班级筛选标签，逐班查看值日分配 */
    isCounselor: false,
    dutyChips: [],           // [{id,name}] = 该教职工绑定的班级（class.list 已按 staff_class 过滤）
    viewClassId: 0,          // 当前查看的班级（0 = 未选择；教职工必选一个）

    week: 1,
    totalWeeks: 18,
    current: 1,
    termStart: '',

    mode: 'day',              // day | person
    status: 'DRAFT',
    unpublished: false,
    archived: false,
    days: [],
    /** 「按日」实际渲染的日子（本周 = 今天及以后；其它周 = 全部）。
     *  ⚠️ 底层 `days` **保持整周**：`_toPersons` 与各处 handler 都按它取数，
     *  「已结束」只是把它从**按日列表**里挪进弹层，不是删除数据。 */
    activeDays: [],
    /** 本周里「早于今天」的日子（仅在查看本周时非空）；进「已结束」弹层 */
    pastDays: [],
    /** 「已结束」弹层开关（2026-10-04 需求）：必须同步进 page-meta 的锁滚动表达式 */
    endedSheetShow: false,
    persons: [],
    expandId: 0,

    /** 左右滑动切周的方向性动画 class：由 utils/swipe.js 下发，写进数据区容器 */
    swipeCls: '',

    sheetShow: false,
    sheetDutyId: 0,
    /** 合并行点开后的「本课次成员」弹层（1.0.4.4 #27）：列出该节课每人一行，分别操作 */
    groupShow: false,
    groupMembers: [],
    groupTitle: '',
    busy: false,

    /* 加值日生（v0.7.16 需求③，仅超管）：选课次 → 选人 → scheduleAddManual */
    addShow: false,
    addDate: '',             // 目标日期（YYYY-MM-DD）
    addDateText: '',
    addSessions: [],         // 该天的课次（按 sessionId 去重）：{sessionId, whenText, room, courseName, count}
    addSessionId: 0,
    addKw: '',
    addMembers: [],          // 名单（已滤教职工/停用；taken = 已在该课次）
    addBusy: false,

    /* 一键生成 / AI 排班（DeepSeek） */
    aiShow: false,
    aiText: '',
    aiBusy: false,
    aiError: '',
    aiDiag: null,
    aiModel: '',
    aiHasKey: true,
    aiPlan: [],
    aiCleaningPlan: [],      // 保洁不进 AI 计划，单独回传用于预览展示
    aiWarnings: [],
    aiNotes: '',
    aiSkipSeqs: []
  },

  onLoad() {
    const app = getApp();
    const cfg = app.globalData.config || {};
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight || 20,
      termStart: cfg.termStart || '',
      totalWeeks: cfg.totalWeeks || 18,
      current: cfg.currentWeek || 1,
      week: cfg.currentWeek || 1
    });
  },

  onUnload() {
    // 切周动画的定时器：页面销毁后还在跑就会对已销毁实例 setData
    swipe.cancel(this);
    // busy 看门狗同理（Tab 页一般不销毁，但被 reLaunch 清掉时会走到这里）
    if (this._busyTimer) { clearTimeout(this._busyTimer); this._busyTimer = null; }
    // 按日/按人 FLIP 的打断令牌也一起作废：链上还没醒的 setTimeout 会自己退出，
    // 不会对已销毁的实例 setData（list-transition 的 guard 就是为这一下存在的）
    this._flipToken = (this._flipToken || 0) + 1;
  },

  onShow() {
    const app = getApp();
    app.setTabBar(2);
    // v0.7.31：不再立即播 —— 等「身份(app.ready) + 首屏数据(loading=false)」就绪、或 READY_MS 兜底超时再统一开播
    pageAnim.playReady(this, getApp());
    const applyAuth = () => {
      const isCounselor = !!(app.globalData.profile && app.globalData.profile.groupTag === 'X');
      this.setData({
        isAdmin: !!(app && app.isAdmin && app.isAdmin()),
        isSuper: !!(app && app.isSuper && app.isSuper()),
        // 需求 D：排班域入口（清空 / 一键生成 / 发布 / 调整 / 加人）改为
        // 「超管或本班生活委员」—— 判定来自后端 guard，前端不自己比 position
        canSchedule: !!(app && app.canSchedule && app.canSchedule()),
        isCounselor
      });
      // 教职工：加载自己绑定的班级做筛选标签（class.list 对教职工只回绑定班）
      if (isCounselor && !this.data.dutyChips.length) this._loadDutyClasses();
      // 模拟态护栏（v1.0.5）：身份套用后同步顶部横幅
      impersonate.sync(this);
    };
    applyAuth();
    // 登录可能在 onShow 之后才完成：登录就绪后重新套用身份，避免超级管理员按钮首屏不显示
    if (app && app.globalData && !app.globalData.authChecked) {
      app.ready().then(applyAuth);
    }
    // 换班同意/拒绝/撤销后（在「我的」页操作），值日表已变：检测 dutyDirty 脏标记，
    // 强制跳过 STALE_MS 缓存重拉一次，否则要「杀掉小程序重进」才看得到更新（1.0.4.4 #28）。
    const dutyDirty = !!(app.globalData && app.globalData.dutyDirty);
    if (app.globalData) app.globalData.dutyDirty = false;
    this.load(dutyDirty);
    // v0.7.32 问题②：切 tab 也做一次节流身份重校；身份变了就重套 + 强刷
    if (typeof app.recheckAuth === 'function') {
      app.recheckAuth().then((changed) => {
        if (!changed) return;
        applyAuth();
        this.load(true);
      }).catch(() => {});
    }
  },

  /** 顶部「模拟中」横幅的「恢复本人」（v1.0.5） */
  onRecoverSelf() {
    impersonate.recover();
  },

  /** 教职工：绑定班级列表（筛选标签数据源）。默认选中第一个班。 */
  _loadDutyClasses() {
    api.classList({}, { toast: false })
      .then((list) => {
        const chips = util.sortClasses(list || []).map(c => ({ id: Number(c.id), name: c.name }));
        if (!chips.length) { this.setData({ dutyChips: [] }); return; }
        const keep = chips.some(c => c.id === Number(this.data.viewClassId));
        this.setData({
          dutyChips: chips,
          viewClassId: keep ? Number(this.data.viewClassId) : chips[0].id
        });
        this.load(true);
      })
      .catch(() => {});
  },

  /** 教职工筛选标签点击：换一个班级查看 = 换一份数据（强制刷新，换班不走静默缓存） */
  onDutyClass(e) {
    const id = Number(e.currentTarget.dataset.id) || 0;
    if (!id || id === Number(this.data.viewClassId)) return;
    this.setData({ viewClassId: id });
    this.load(true);
  },

  /* ---------------- 加值日生（v0.7.16 需求③，仅超管） ---------------- */

  /** 打开弹层：从当天的值日行里去重出课次列表（period/教室/课名/已排人数） */
  onAddOpen(e) {
    if (!this.data.canSchedule) return;
    const date = String(e.currentTarget.dataset.date || '');
    const day = this.data.days.find(d => d.date === date);
    if (!day || !day.duties.length) { util.toast('这一天没有可安排的课次'); return; }
    const seen = {};
    const sessions = [];
    day.duties.forEach(x => {
      if (seen[x.sessionId]) { seen[x.sessionId].count += 1; return; }
      const row = {
        sessionId: x.sessionId,
        whenText: util.whenText(x.kind, x.period),
        room: x.room || '',
        courseName: x.courseName || '',
        count: 1
      };
      seen[x.sessionId] = row;
      sessions.push(row);
    });
    this.setData({
      addShow: true,
      addDate: date,
      addDateText: day.weekdayText + ' ' + day.dateText,
      addSessions: sessions,
      addSessionId: 0,
      addKw: '',
      addMembers: []
    });
  },
  onAddClose() { this.setData({ addShow: false }); },
  onAddBackSession() { this.setData({ addSessionId: 0, addKw: '', addMembers: [] }); },

  /** 选定课次 → 拉本班名单（滤掉教职工 / 停用；标记已在该课次的人）。基表留在 _addBase 供搜索过滤 */
  onAddPickSession(e) {
    const sessionId = Number(e.currentTarget.dataset.id) || 0;
    if (!sessionId) return;
    this.setData({ addSessionId: sessionId, addKw: '', addMembers: [], addBusy: true });
    api.memberList({ public: 'manage' }, { toast: false })
      .then((list) => {
        const day = this.data.days.find(d => d.date === this.data.addDate);
        const takenIds = {};
        ((day && day.duties) || []).forEach(x => {
          if (Number(x.sessionId) === sessionId) takenIds[Number(x.memberId)] = true;
        });
        const members = (list || [])
          .filter(m => m.groupTag !== 'X' && m.status !== 'DISABLED')
          .map(m => ({
            id: Number(m.id),
            name: m.name,
            studentNo: String(m.studentNo || ''),
            seqText: m.groupTag === 'X' ? '·' : (util.seqOf(m.studentNo) || '·'),
            groupTag: m.groupTag,
            taken: !!takenIds[Number(m.id)]
          }))
          .sort((a, b) => (util.seqOf(a.studentNo) - util.seqOf(b.studentNo)) || (a.id - b.id));
        this._addBase = members;
        this.setData({ addMembers: this._filterAdd(String(this.data.addKw || '').trim(), members), addBusy: false });
      })
      .catch(() => this.setData({ addBusy: false }));
  },

  onAddKw(e) {
    const kw = String(e.detail.value || '').trim();
    this.setData({ addKw: kw });
    // 在基表上过滤（不在子集上再滤，否则清空关键词回不去）
    this.setData({ addMembers: this._filterAdd(kw, this._addBase || []) });
  },

  /** 关键词过滤：姓名或学号含关键字（无关键字 = 全量） */
  _filterAdd(kw, list) {
    if (!kw) return list;
    return list.filter(m => m.name.indexOf(kw) >= 0 || m.studentNo.indexOf(kw) >= 0);
  },

  /** 选人 → 挂到该课次（schedule.addManual，超管）；成功即关弹层并强刷 */
  onAddPickMember(e) {
    const memberId = Number(e.currentTarget.dataset.id) || 0;
    if (!memberId || this.data.addBusy) return;
    const member = this.data.addMembers.find(m => m.id === memberId);
    if (member && member.taken) { util.toast('该同学已在这个课次'); return; }
    this.setData({ addBusy: true });
    this._invalidateManual();   // 乐观作废：写之前清掉（check-perf R6），失败也只是多拉一次
    api.scheduleAddManual(
      { sessionId: this.data.addSessionId, week: this.data.week, memberId },
      { loading: '添加中' }
    )
      .then(() => {
        this.setData({ addBusy: false, addShow: false });
        util.toast('已添加');
        this.load(true);
      })
      .catch(() => this.setData({ addBusy: false }));
  },

  load(force) {
    /*
     * 需求①「切换页面若无变化则无需重载」：Tab 切换回来时，只要上一次数据还很新鲜
     * （STALE_MS 内拉过），就直接复用已渲染的内容、连请求都不发 —— 切回来是「秒显」。
     * 显式写操作（生成 / 发布 / 撤回 / 清空 / 换人 / AI 应用）走 `load(true)` 强制刷新。
     */
    const now = Date.now();
    if (!force && this._hasData && this._lastLoad && now - this._lastLoad < STALE_MS) {
      return;
    }
    // 教职工按班查看：缓存键带上 classId，避免 A 班的名单冒充 B 班（v0.7.16）
    const cid = this.data.isCounselor ? (Number(this.data.viewClassId) || 0) : 0;
    const key = mem.keys.duty(this.data.week) + (cid ? ':' + cid : '');
    /*
     * 首屏优先用 app 在登录后**后台预热**好的那一份（见 app._prefetchTabs）：
     * 首次打开小程序时云函数是冷的，切到值日页要等好几秒；
     * 预热把这段时间挪到了用户还在首页的时候，这里就能直接渲染出来。
     *
     * 页面实例在 Tab 切换时不销毁、data 里还有上一次的内容 —— 只要本周已经画过，
     * 就不要退回骨架（无条件 `loading: true` 会让「切回值日」每次都先闪一遍骨架，
     * 主观上就是「切 Tab 卡卡的」）。
     */
    const cached = this._hasData ? null : mem.read(key);
    const hasContent = !!this._hasData || !!cached;
    if (cached) this._paint(cached);
    else if (!hasContent) this.setData({ loading: true, failed: false });

    return api.scheduleListWeek({ week: this.data.week, classId: cid || undefined }, { toast: false })
      .then((r) => {
        mem.write(key, r);
        this._lastLoad = Date.now();
        this._paint(r);
      })
      .catch(() => {
        this.setData({ loading: false, failed: !hasContent });
        // 已有内容时不清屏（清屏反而更糟），但必须让用户知道这次没刷上 ——
        // 值日名单看错是真会误事的，所以宁可弹一下。
        if (hasContent) util.toast('刷新失败，显示的是上次的名单');
      });
  },

  /* v1.0.5：spring-scroll 下拉刷新 → 强制重载并收起指示器 */
  onRefresh() {
    Promise.resolve(this.load(true)).then(() => {
      const sc = this.selectComponent('#dsMain');
      if (sc && sc.finishRefresh) sc.finishRefresh();
    }).catch(() => {
      const sc = this.selectComponent('#dsMain');
      if (sc && sc.finishRefresh) sc.finishRefresh();
    });
  },

  /** 把服务端返回的名单铺到界面上（首次拉取 / 预热命中 / 缓存命中共用） */
  _paint(r) {
    const days = this._decorate((r && r.days) || []);
    /*
     * 「已结束」折叠（2026-10-04 需求）：只折**当前周里早于今天**的日子（今天整天留在主列表）。
     *  · 只有查看本周时才折 —— 切到历史周时正常显示全部（历史周本来就是回顾，不该被抽空）；
     *  · 底层 days 保持整周不动（按人视图 / 各处 handler 都依赖它），只把「按日」的渲染源
     *    换成 activeDays，被折走的放进 pastDays 交给弹层。
     * ⚠️ 日期是 'YYYY-MM-DD' 固定宽字符串，字典序比较即日期序，无需转 Date。
     */
    const isCurrentWeek = Number(this.data.week) === Number(this.data.current);
    const today = util.fmtDate(new Date());
    const pastDays = isCurrentWeek ? days.filter(d => String(d.date) < today) : [];
    const activeDays = isCurrentWeek ? days.filter(d => String(d.date) >= today) : days;
    this._hasData = true;
    this.setData({
      loading: false,
      failed: false,
      status: (r && r.status) || 'DRAFT',
      unpublished: !!(r && r.unpublished),
      archived: !!(r && r.archived),
      days,
      activeDays,
      pastDays,
      persons: this._toPersons(days)
    }, () => { this._resizeMain(); });
  },

  _decorate(days) {
    return days.map(d => {
      // 姓名牌改为显示「序号」（名册序号 = 学号后两位）；序号缺失时显示占位符而不是悄悄回落成「姓」
      const duties = (d.duties || []).map(x => Object.assign({}, x, {
        seqText: x.seq ? String(x.seq) : '·',
        isClean: x.kind === 'CLEAN',
        flip: '', // 按日/按人切换的 FLIP 初值（v0.7.19 需求②）
        // 保洁课次显示「18点前」，普通课次显示「第 N 节」（唯一来源 util.whenText）
        whenText: util.whenText(x.kind, x.period)
      }));
      /*
       * 按课次（sessionId）合并（1.0.4.4 #27）：同一节课的两/三人合成一行，
       * 不再各占一排。合并对象带 members[]（原样引用已装饰的 duty，便于点开分别操作），
       * 行右侧只放一个「汇总 pill」（取最未完成状态）。按人视图继续用扁平 duties，不受影响。
       */
      const merged = [];
      const bySession = {};
      duties.forEach(x => {
        const key = x.sessionId;
        if (!bySession[key]) {
          const g = {
            id: 'g' + key,
            sessionId: x.sessionId,
            period: x.period,
            kind: x.kind,
            isClean: x.kind === 'CLEAN',
            whenText: util.whenText(x.kind, x.period),
            room: x.room || '',
            courseName: x.courseName || '',
            groupScope: x.groupScope,
            isMine: false,
            flip: '',
            members: []
          };
          bySession[key] = g;
          merged.push(g);
        }
        const g = bySession[key];
        g.members.push(x);
        if (x.isMine) g.isMine = true;
      });
      merged.forEach(g => {
        g.avatarSize = 56; // 序号牌统一 56rpx(28px)：与按人视图/成员弹层对齐（原两人行 72 过大）
        g.status = aggregateDutyStatus(g.members.map(m => m.status));
        g.namesText = g.members.map(m => m.name).join('、');
        g.groupTitle = (g.isClean ? '打扫 410 · ' : ('第' + g.period + '节 · ')) +
          (g.room || '未填教室') + ' · ' + g.courseName;
        g.count = g.members.length;
      });
      return Object.assign({}, d, {
        duties,
        mergedDuties: merged,
        ghFlip: '', // 日期头 crossfade 初值（v0.7.19 需求②）
        weekdayText: util.weekdayCn(util.weekdayOfNum(d.date)),
        dateText: util.md(d.date),
        totalText: duties.length + ' 人'
      });
    });
  },

  _toPersons(days) {
    const map = {};
    days.forEach(d => {
      (d.duties || []).forEach(x => {
        if (!map[x.memberId]) {
          map[x.memberId] = {
            memberId: x.memberId, name: x.name, groupTag: x.groupTag, seqText: x.seqText || '',
            list: [], weekCount: 0, isMine: !!x.isMine, ghFlip: '' // 按人视图分组标题 crossfade 初值
          };
        }
        map[x.memberId].list.push(x);
        map[x.memberId].weekCount += 1;
      });
    });
    return Object.keys(map).map(k => map[k]);
  },

  /* ---------------- 周 / 模式 ---------------- */
  onWeekChange(e) {
    const wk = Number(e.detail.week);
    if (wk < 1 || wk > this.data.totalWeeks) return;
    const delta = wk - Number(this.data.week);
    if (!delta) return;
    /*
     * 换周统一带方向性动画：滑动、点箭头、周次选择器走同一条路（见 utils/swipe.js）。
     * 时序是「先让旧内容朝手指方向滑走（160ms），再换数据，新内容从反方向滑入」——
     * 反过来（先换数据再动）会先白一下再动，比不加动画还难看。
     * 越界（第 1 周还往右滑 / 最后一周还往左滑）由 shift 拦下，只播回弹、不换数据。
     */
    swipe.shift(this, delta, (w) => this._applyWeek(w));
  },

  /** 真正换周（动画 out 段结束后才被回调） */
  _applyWeek(wk) {
    this.setData({ week: wk, expandId: 0 });
    // 换周 = 换一份数据：屏幕上那份已经不是这一周的了，必须让骨架回来，
    // 否则会拿上周的名单冒充本周（静默刷新只对「同一周重进页面」成立）
    this._hasData = false;
    this.load();
  },

  /** 左右滑动切周（左滑 = 下一周，右滑 = 上一周）。与箭头按钮同一条路径。 */
  _shiftWeek(delta) {
    this.onWeekChange({ detail: { week: Number(this.data.week) + delta } });
  },
  onSwipeStart(e) { swipe.begin(this, e); },
  onSwipeEnd(e) {
    // 弹层（值日详情 / 一键生成 / 合并行成员）的 DOM 就在页面根节点里，滑动会冒泡上来，必须挡掉
    if (this.data.sheetShow || this.data.aiShow || this.data.groupShow) return;
    const dir = swipe.end(this, e);
    if (dir === 'prev') this._shiftWeek(-1);
    else if (dir === 'next') this._shiftWeek(1);
  },

  /** 主内容 spring-scroll 重新测量可滚动范围（内容高度变化后必调，v0.7.19 需求④） */
  _resizeMain() {
    const sc = this.selectComponent('#dsMain');
    if (sc && typeof sc.resize === 'function') sc.resize();
  },

  onMode(e) {
    const next = e.detail.key;
    if (next === this.data.mode) return;
    // 系统开了「减弱动态效果」：直接切换，不做 FLIP
    // （list-transition 内部还会再兜一次，这里判一次是为了连「先钉成不可见」都不做）
    if (listTransition.reduced()) { this.setData({ mode: next }); this._resizeMain(); return; }
    this._flipMode(next);
  },

  /** 按日 ⇄ 按人 的过渡（v0.7.21 需求⑤：收敛到 utils/list-transition.js）
   * ============================================================
   * 页面自己写的那版（v0.7.19）有三处留给公共模块解决：
   *  ① 时长散在三个地方（.18s / .16s / 60ms 各写一遍），改一处不知道会牵动谁；
   *  ② **不可打断** —— 上一轮的 setTimeout 链还没跑完，下一轮已经进来，
   *     两轮的收尾 setData 会互相把对方的样式清掉，观感就是「点了没反应」；
   *  ③ 新增项从**上方** -8px 淡入，与「从下方飞上来」的规格相反。
   * 现在：duty 行（两视图共享同一份对象引用，见 _toPersons 直接把 days 里的 x 塞进 person.list）
   * 走 FLIP；新出现的分组标题（日期头 / 学生名）用 onInvert 搭车在同一拍淡入；
   * 主段 220ms + 落位沉降 70ms（行程 ≥24px 才补），全部落在 200~300ms。
   *
   * ⚠️ 为什么**不再**先让旧分组标题淡出 60ms 再切视图：
   *   `mode` 一换，旧视图整块就被 wx:if 卸载 —— 那 60ms 的淡出根本播不到（节点已不在 DOM），
   *   只是白白让切换晚 60ms 才开始。新标题跟着 FLIP 同拍淡入，反而更连续、也不出预算。
   */
  _flipMode(next) {
    const lt = listTransition;
    // 打断令牌：开始新一轮就把令牌自增，上一轮 setTimeout 醒来发现令牌变了会自己退出
    const tk = (this._flipToken = (this._flipToken || 0) + 1);

    // 目标视图的分组标题先钉成「不可见」（不带 transition），
    // 由 flip 的第一拍 setData 把 days/persons 一起下发时把它们渲染进去 —— 同一次数据，不会闪。
    const target = next === 'day' ? this.data.days : this.data.persons;
    target.forEach(it => { it.ghFlip = 'opacity:0;transform:translateY(-8px)'; });

    lt.flip(this, {
      sel: '.dt-row[data-id]', key: 'id', field: 'flip',
      guard: () => this._flipToken === tk,
      // 只列 days 这一份：person.list 里装的是同一批对象引用，写一次 flip 两个视图都生效
      rows: () => {
        const out = [];
        if (next === 'day') {
          // 合并行模式下，被快照的是每个课次的合并对象（带 flip 字段）
          this.data.days.forEach(d => ((d.mergedDuties || d.duties) || []).forEach(g => out.push(g)));
        } else {
          // 按人视图：扁平 duty 行（与 person.list 同一批对象引用）
          this.data.days.forEach(d => (d.duties || []).forEach(x => out.push(x)));
        }
        return out;
      },
      patch: () => ({ mode: next, days: this.data.days, persons: this.data.persons }),
      onInvert: () => {
        // 与新位置同一拍：新视图的分组标题淡入（自带 transition，模块不管它的曲线）
        target.forEach(it => {
          it.ghFlip = 'opacity:1;transform:translateY(0);transition:opacity ' + lt.MS.IN + 'ms ease-out'
            + ',transform ' + lt.MS.IN + 'ms ease-out';
        });
      },
      after: () => {
        if (this._flipToken !== tk) return;
        // 收尾：ghFlip 松回空串（与「已就位」同一视觉，不会跳）
        this.data.days.forEach(d => { d.ghFlip = ''; });
        this.data.persons.forEach(p => { p.ghFlip = ''; });
        this.setData({ days: this.data.days, persons: this.data.persons });
        this._resizeMain();
      }
    });
  },
  onExpand(e) {
    const id = Number(e.currentTarget.dataset.id);
    this.setData({ expandId: this.data.expandId === id ? 0 : id });
  },

  onRow(e) {
    const id = e.currentTarget.dataset.id;
    const row = this._findRow(id);
    if (!row) return;
    // 从「已结束」弹层里点进来时先收起它，避免两个弹层叠着（本来就已经关着时是 no-op）
    // 合并行（>1 人）：先弹「本课次成员」列表，再点具体某人进 duty-sheet
    if (row.members && row.members.length > 1) {
      this.setData({ endedSheetShow: false, groupShow: true, groupMembers: row.members, groupTitle: row.groupTitle || '' });
      return;
    }
    // 单行（1 人）或按人子行：直接开 duty-sheet
    const dutyId = (row.members && row.members[0]) ? row.members[0].id : Number(id);
    this.setData({ endedSheetShow: false, sheetShow: true, sheetDutyId: dutyId });
  },
  /** 按 data-id 找回行对象：合成 id（'g'+sessionId）= 合并行；数字 = 扁平 duty */
  _findRow(id) {
    if (typeof id === 'string' && id.charAt(0) === 'g') {
      let found = null;
      (this.data.days || []).forEach(d => ((d.mergedDuties || []) || []).forEach(g => { if (g.id === id) found = g; }));
      return found;
    }
    const nid = Number(id);
    let found = null;
    (this.data.days || []).forEach(d => ((d.duties || []) || []).forEach(x => { if (Number(x.id) === nid) found = x; }));
    return found;
  },
  onGroupClose() { this.setData({ groupShow: false }); },

  /* ---------------- 「已结束」（2026-10-04 需求） ----------------
   * 本周里早于今天的日子不进「按日」主列表，收进这里；今天及以后照常显示。
   * 查看历史周时不折（pastDays 为空 → 入口不渲染）。 */
  onEndedOpen() {
    if (!this.data.pastDays.length) return;
    this.setData({ endedSheetShow: true });
  },
  onEndedClose() { this.setData({ endedSheetShow: false }); },
  /** 合并行成员列表里点某人 → 关掉成员列表，开该人的 duty-sheet */
  onGroupPick(e) {
    const dutyId = Number(e.currentTarget.dataset.id);
    if (!dutyId) return;
    this.setData({ groupShow: false, sheetShow: true, sheetDutyId: dutyId });
  },
  onSheetClose() { this.setData({ sheetShow: false }); },
  onSheetChanged() { this._invalidateManual(); this.load(true); },

  /**
   * 值日表被改动 → 作废「手动排班页」的缓存。
   * 本页自己的缓存不用管：紧接着的 `load()` 会用服务端最新数据覆盖它。
   * 调用点选在**写操作发起前**（乐观作废）：即使中途失败，也只是让下一个页面少一次缓存命中，
   * 比「写成了但另一个页面还拿旧名单」安全。
   */
  _invalidateManual() { mem.clear(mem.keys.manual(this.data.week)); },

  /* ---------------- 写操作的重入保护（busy 看门狗） ----------------
   * 四个写入口（生成 / 发布 / 撤回 / 清空）共用。原先各自 `if (busy) return;`
   * 是「静默失败」的温床：busy 一旦卡住，所有按钮就永久失效且毫无提示。
   * 这里是唯一入口，规则写一次：
   *   _busyStart()  置忙 + 上表；到点没结束就自动复位并给用户一句话
   *   _busyEnd()    手动复位（成功/失败都要调，别只在成功分支调）
   *   _busyGate()   true = 本次点击要放弃（并已给提示）；false = 可以继续
   */
  _busyStart() {
    this._busyAt = Date.now();
    this.setData({ busy: true });
    if (this._busyTimer) clearTimeout(this._busyTimer);
    this._busyTimer = setTimeout(() => {
      this._busyTimer = null;
      if (!this.data.busy) return;
      this._busyAt = 0;
      this.setData({ busy: false });
      util.toast('操作超时，已恢复，请重试');
    }, BUSY_TIMEOUT_MS);
  },

  _busyEnd() {
    if (this._busyTimer) { clearTimeout(this._busyTimer); this._busyTimer = null; }
    this._busyAt = 0;
    if (this.data.busy) this.setData({ busy: false });
  },

  /**
   * 返回 true 表示「这次点击不往下走」。
   * 只在**确认还在跑**时拦下并提示；计时器已不在（上一次请求早结束了、只是没人复位
   * busy）或已超过上限，就直接放行 —— 宁可多跑一次也不能让按钮变哑巴。
   */
  _busyGate() {
    if (!this.data.busy) return false;
    const stale = !this._busyTimer || (Date.now() - (this._busyAt || 0) > BUSY_TIMEOUT_MS);
    if (stale) { this._busyEnd(); return false; }
    util.toast('上一个操作还在进行，请稍候');
    return true;
  },

  /* ---------------- 管理员 · 一键生成（序号轮转 / AI） ---------------- */
  onAiOpen() {
    this.setData({
      aiShow: true, aiBusy: false, aiError: '', aiDiag: null,
      aiPlan: [], aiCleaningPlan: [], aiWarnings: [], aiNotes: '', aiSkipSeqs: []
    });
    this._checkAi();
  },
  onAiClose() { this.setData({ aiShow: false }); },
  onAiInput(e) { this.setData({ aiText: e.detail.value }); },

  /** 真正探测一次「出口有没有配密钥」，避免只在代理模式下盲目显示可用 */
  _checkAi() {
    api.scheduleAiCheck({}, { toast: false })
      .then((r) => {
        this.setData({
          aiHasKey: !!(r && r.hasKey),
          aiModel: (r && r.model) || this.data.aiModel,
          aiDiag: r || null
        });
      })
      .catch(() => {});
  },

  /**
   * 自检：真实往返一次大模型（点它会真的花钱，但能一次定位到底是
   * 出口不通、缺密钥、包部署不对，还是模型本身在报错）。
   */
  onAiDiag() {
    if (this.data.aiBusy) return;
    this.setData({ aiBusy: true, aiError: '', aiDiag: null });
    api.scheduleAiCheck({ probe: true }, { toast: false, loading: '自检中' })
      .then((r) => this.setData({ aiBusy: false, aiDiag: r || null }))
      .catch((e) => this.setData({ aiBusy: false, aiError: this._errText(e) }));
  },

  onAiCopyDiag() {
    const d = this.data.aiDiag || {};
    let s = '模型：' + (d.model || '-') + '\n通路：' + (d.route || '-') +
      '\n出口：' + (d.egress || '-') + '（HTTP ' + (d.httpStatus || 0) + '）' +
      '\n有密钥：' + (d.hasKey ? '是' : '否') +
      '\n部署包含 seqOf：' + (d.hasSeqOf ? '是' : '否') +
      '\n环境变量：' + JSON.stringify(d.env || {});
    if (d.reply) s += '\n真实往返：成功（' + (d.probeMs || 0) + 'ms）返回 ' + d.reply;
    if (d.error) s += '\n错误：' + d.error;
    if (this.data.aiError) s += '\n本次失败：' + this.data.aiError;
    wx.setClipboardData({ data: s, success: () => util.toast('已复制自检信息') });
  },

  /** 把云函数回来的错误压成一行可读文本（带错误码，便于对照排查） */
  _errText(e) {
    const code = e && (e.errCode !== undefined ? e.errCode : e.code);
    const msg = (e && (e.errMsg || e.message)) || '未知错误';
    return (code !== undefined && code !== null ? '[' + code + '] ' : '') + msg;
  },

  onAiRun() {
    if (this.data.aiBusy) return;
    this.setData({ aiBusy: true, aiError: '', aiPlan: [], aiCleaningPlan: [], aiWarnings: [], aiNotes: '' });
    api.scheduleAiPlan({
      week: this.data.week,
      text: this.data.aiText
    }, { loading: 'AI 生成中' })
      .then((r) => {
        const plan = ((r && r.plan) || []).map(p => Object.assign({}, p, {
          namesText: (p.names || []).join('、') || '未排'
        }));
        // 保洁不在 aiPlan 里（模型看不到它），后端单独回传一份「应用后会补的保洁」
        const cleaning = ((r && r.cleaningPlan) || []).map(p => Object.assign({}, p, {
          namesText: (p.names || []).join('、') || '未排',
          whenText: util.whenText('CLEAN', p.period)
        }));
        this.setData({
          aiBusy: false,
          aiError: '',
          aiPlan: plan,
          aiCleaningPlan: cleaning,
          aiWarnings: (r && r.warnings) || [],
          aiNotes: (r && r.notes) || '',
          aiSkipSeqs: (r && r.skipSeqs) || [],
          aiModel: (r && r.model) || this.data.aiModel
        });
        if (!plan.length) util.toast('AI 没有给出可用的排班，请换个说法');
      })
      // 关键：不要吞掉错误。以前这里什么都不显示，用户只看到弹层没反应，
      // 完全无从下手排查。现在把云函数回的真实文案留在弹层里，可复制。
      .catch((e) => this.setData({ aiBusy: false, aiError: this._errText(e) }));
  },

  onAiApply() {
    if (this.data.aiBusy || !this.data.aiPlan.length) return;
    this.setData({ aiBusy: true, aiError: '' });
    this._invalidateManual();
    api.scheduleAiApply({
      week: this.data.week,
      plan: this.data.aiPlan.map(p => ({ sessionId: p.sessionId, memberSeqs: p.memberSeqs })),
      // 「保持原样」的课次必须显式告诉服务端，否则会被当成空计划重排
      unchanged: this.data.aiPlan.filter(p => p.kept).map(p => p.sessionId),
      skipSeqs: this.data.aiSkipSeqs
    }, { loading: '写入中' })
      .then((r) => {
        this.setData({ aiBusy: false, aiShow: false, aiPlan: [] });
        let msg = '已按 AI 方案排 ' + ((r && r.created) || 0) + ' 条值日';
        if (r && r.warnings && r.warnings.length) msg += '（有 ' + r.warnings.length + ' 条提醒）';
        if (r && r.resetPublish) msg += '；本周已退回待发布，请重新发布';
        util.toast(msg);
        this.load(true);
      })
      .catch((e) => this.setData({ aiBusy: false, aiError: this._errText(e) }));
  },

  onAiDiscard() { this.setData({ aiPlan: [], aiCleaningPlan: [], aiWarnings: [], aiNotes: '', aiSkipSeqs: [], aiError: '' }); },

  /** 不用 AI：直接按序号轮转生成（原有逻辑） */
  onGenerate() {
    if (this._busyGate()) return;
    /*
     * 用 confirmStrict 而不是 confirm：后者把「取消」和「弹窗没弹出来」都压成 false，
     * 调用方一句 `if (!ok) return;` 就变成「点了没反应」。这里对 fail 必须给一句话。
     */
    util.confirmStrict('按「序号轮转」生成本周值日：接上次排到的地方继续，排满 56 号后自动从 1 号重来；已手动调整的保留不动', '按序号轮转生成')
      .then((act) => {
        if (act === 'fail') { util.toast('确认弹窗没打开，请退出重进本页再试'); return; }
        if (act !== 'confirm') return;
        this._busyStart();
        this._invalidateManual();
        api.scheduleGenerate({ week: this.data.week }, { loading: '生成中' })
          .then((r) => {
            this._busyEnd();
            this.setData({ aiShow: false });
            let msg = '已生成 ' + ((r && r.created) || 0) + ' 条值日';
            if (r && r.holidaySkipped) msg += '，跳过 ' + r.holidaySkipped + ' 节放假课';
            /*
             * `roundReset` 在后端把**两种情形**合成了一个标志，所以文案必须对两者都成立，
             * 绝不能说成「从 1 号重新开始」——
             *   ① 生成开始时全班 56 人本轮都已排满 → 服务端清零标记，本轮从头开；
             *   ② 本周名额多于「本轮还没排的人」（第 4 周就是这样：只剩 49~56 八个人，
             *      却要排 16 个名额）→ 排完 49~56 后**接着序号**进入下一轮（01~08）。
             * 两句的共同事实只有一条：本轮 56 人已经走完一遍，之后是顺着序号继续，不是重头来。
             * （2026-09-26 用户明确要求「接着上一周继续生成，而不是从 1 号重新生成」，
             *   旧文案「本轮已排满，已从 1 号重新开始」正好把情形②说反了。）
             */
            if (r && r.roundReset) msg += '；本轮 56 人已轮完，接着序号继续往下排';
            if (r && r.resetPublish) msg += '；本周已退回待发布，请重新发布';
            util.toast(msg);
            this.load(true);
          })
          // 不能吞错误：只复位 busy、什么都不说的话，用户视角仍然是「点了没反应」
          .catch((e) => { this._busyEnd(); util.toast(this._errText(e)); });
      });
  },

  onPublish() {
    if (this._busyGate()) return;
    this._busyStart();
    this._invalidateManual();
    api.schedulePublish({ week: this.data.week }, { loading: '发布中' })
      .then(() => {
        this._busyEnd();
        util.toast('本周值日已发布');
        this.load(true);
      })
      .catch((e) => { this._busyEnd(); util.toast(this._errText(e)); });
  },

  onUnpublish() {
    if (this._busyGate()) return;
    this._busyStart();
    this._invalidateManual();
    api.scheduleUnpublish({ week: this.data.week }, { loading: '处理中' })
      .then(() => {
        this._busyEnd();
        util.toast('已撤回发布');
        this.load(true);
      })
      .catch((e) => { this._busyEnd(); util.toast(this._errText(e)); });
  },

  /** 清空本周：删除全部值日（含手动）并重置轮转计数，便于一键重新生成 */
  onClear() {
    if (this._busyGate()) return;
    util.confirmStrict('将清空本周全部值日（含手动调整）并重置轮转计数，之后可一键重新生成', '清空本周')
      .then((act) => {
        if (act === 'fail') { util.toast('确认弹窗没打开，请退出重进本页再试'); return; }
        if (act !== 'confirm') return;
        this._busyStart();
        this._invalidateManual();
        api.scheduleClear({ week: this.data.week }, { loading: '清空中' })
          .then(() => {
            this._busyEnd();
            util.toast('已清空，可重新生成');
            this.load(true);
          })
          .catch((e) => { this._busyEnd(); util.toast(this._errText(e)); });
      });
  },

  /* ---------------- 合并行成员弹层（1.0.4.4 #27，替代原「导出」） ---------------- */

  onReload() { this.load(true); },
  noop() {}
});
