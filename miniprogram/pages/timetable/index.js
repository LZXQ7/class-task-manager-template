/**
 * P3 · 课表周视图（Tab 2）
 * ------------------------------------------------------------
 * 课表数据是**一学期不变的静态数据**，已固化在 `data/timetable.js` 里，
 * 打开页面即渲染，不依赖网络（断网、云函数异常都不会再出现「数据没加载出来」）。
 *
 * 仍然联网的两处，且都不影响课表渲染：
 *   ① 打开「课次详情」时按需拉一次本周值日名单（失败就只不显示名单）；
 *   ② 管理员改动课表 / 校历时需要写回数据库 —— 值日生成读的是库里那份。
 */
const api = require('../../utils/api');
const util = require('../../utils/util');
const req = require('../../utils/request');
const tt = require('../../data/timetable');
const config = require('../../utils/config');
const pageAnim = require('../../utils/page-anim');
const impersonate = require('../../utils/impersonate');
/*
 * v0.7.20 需求③「课程表左右切换添加动画」：复用值日页 / 手动排班页那套方向性过渡
 * （out 160ms 滑走 → 换数据 → in 220ms 滑入，class 与 keyframes 都在 app.wxss）。
 * ⚠️ 只借它的**动画**，**不借它的手势**：课表主体本身是 `scroll-x`，横向手势另有归属，
 *    挂 onSwipeStart 会和横向滚动抢方向（scripts/check-week-swipe.js ③ 明确断言
 *    「课表页不得挂 onSwipeStart」）。所以这里只有 onWeekChange / onPickWeek 走 swipe.shift。
 */
const swipe = require('../../utils/swipe');
/** 列表过渡（A 组 ⇄ B 组）：机制/时长/可打断全在该模块，与 roster / duty 共用一份 */
const listTransition = require('../../utils/list-transition');

const WEEK_RULES = [
  { key: 'ALL', text: '全周' },
  { key: 'ODD', text: '单周' },
  { key: 'EVEN', text: '双周' }
];
const DAYS = [
  { key: 1, text: '一' }, { key: 2, text: '二' }, { key: 3, text: '三' },
  { key: 4, text: '四' }, { key: 5, text: '五' },
  // 周六 / 周日也要能排课：调休（周末补课）时把课次直接排到周末那两天
  { key: 6, text: '六' }, { key: 7, text: '日' }
];

/**
 * 课表列宽不再写死 —— 按「实际显示的天数」自适应屏幕宽度：
 *   周一~周五（5 天）→ 平分右侧可视宽，正好铺满，无需横向滚动；
 *   有周末课（6/7 天）→ 用较窄的固定列宽 + 横向滚动（7 列硬塞进 600rpx 会看不清课名）。
 * 下列常量必须与 WXSS 的 `.tt-fixed` width（86rpx）与 `.tt-board` 左右留白（32rpx×2）一致。
 */
const FIXED_W = 86;               // 左侧「节次」列宽
const BOARD_PAD = 64;             // 课表左右留白（各 32rpx）
const BOARD_INNER = 750 - BOARD_PAD - FIXED_W;   // 右侧可视宽（rpx）= 600
const COL_W_WEEKEND = 110;        // 显示周六 / 周日时的列宽（放不下就横向滚）

/** 周次数组 → 展示文案：空 = 每周都上 */
function weekText(weeks) {
  const arr = typeof weeks === 'string'
    ? weeks.split(',').filter(Boolean).map(Number)
    : (weeks || []);
  if (!arr.length) return '每周';
  return '第 ' + arr.join('、') + ' 周';
}

Page({
  data: {
    statusBarHeight: 20,
    /** Tab 入场动画序号：0 = 还没进过（播完整版），之后在 1 / 2 之间轮换（轻量版），见 utils/page-anim.js */
    animSeq: 0,
    /** 入场动画就绪标记（v0.7.31）：false = 根节点挂 pa-hold（块透明），等首屏身份+数据就绪再统一开播 */
    paReady: false,
    /** 切周方向性动画 class（'' = 静止）；由 utils/swipe.js 下发，样式在 app.wxss */
    swipeCls: '',
    loading: true,
    failed: false,
    isAdmin: false,
    isSuper: false,
    /** 辅导员（group_tag='X'）：课表暂不展示（需求⑧，等学校教务系统接入） */
    isCounselor: false,
    /** 当前班级是否有真实课表（仅 TIMETABLE_CLASS_ID 班；其余班走空态） */
    hasTimetable: true,
    /** 「切换测试账号」模拟态顶部横幅（v1.0.5）：非空即渲染红色护栏条 */
    impersonateBanner: '',
    /**
     * 课表数据源（2026-10-06 个人课表）：'class' = 全班课表（原有行为）、
     * 'mine' = 我自己的课表（member_timetable，仅自己可见）。
     * ⚠️ 与 viewGroup（A/B 组）**正交**：先选数据源，再按组过滤。
     */
    srcView: 'class',
    srcTabs: [
      { key: 'class', text: '全班课表' },
      { key: 'mine', text: '我的课表' }
    ],
    /** 我的课表原始行（member_timetable） */
    mineRows: [],
    mineCount: 0,
    mineLoaded: false,
    mineLoading: false,
    /** 我的课表为空时的提示（用于网格上方的空态条） */
    mineEmpty: false,
    /** 班委权限（可发布到全班），与后端 requireTimetablePublish 同口径 */
    canPublish: false,
    /** 查看 A/B 组课表 + 临时调课权限（超管/班委），与后端 guard.requireCommittee 同口径 */
    canViewGroups: false,
    /* 我的课次编辑弹层 */
    mineFormShow: false,
    mineFormSaving: false,
    /** 清空我的课表弹层 */
    mineClearShow: false,
    mineClearBusy: false,
    mineForm: null,
    dayOptions: [],
    periodOptions: [],
    weekPresets: [
      { key: 'all', text: '每周' }, { key: 'odd', text: '单周' }, { key: 'even', text: '双周' }
    ],
    /* 选文件导入 */
    mineImportShow: false,
    mineImportStep: 'pick',
    mineImportBusy: false,
    mineImportPreview: null,
    mineImportTotal: 0,
    mineImportWarn: [],
    mineImportFile: '',
    /* 发布到全班 */
    minePublishShow: false,
    minePublishing: false,
    minePublishTarget: 0,
    termStart: '',
    totalWeeks: 18,
    week: 1,
    current: 1,

    dates: [],          // [{dow, short, day, isToday, isHoliday, holidayName, isMakeup, isWeekend}]（只含实际显示的天）
    periods: [],        // [{p, label, start}]
    grid: [],           // 5 行 × N 列（N = 实际显示天数，默认周一~周五，周末有课才含周六日）
    dateWidth: 0,       // 日期区总宽（rpx）：供横向滚动容器定宽
    colW: 120,          // 单列宽（rpx）：按显示天数自适应
    rowH: 132,          // 单行高（rpx）：按屏幕高度自适应
    headH: 72,          // 表头高（rpx）
    showScrollHint: false, // 仅在出现周末列（需要横向滚动）时提示
    tip: '',
    viewGroup: 'A',     // 课表视图：仅看 A 组 / 仅看 B 组（含全体课）
    /** 左下角入口（视图 + 临时调课合并）的展开态，v0.7.21 需求③ */
    fabMenuOpen: false,
    failMsg: '',

    detailShow: false,
    detail: null,

    formShow: false,
    form: null,

    weekPickerShow: false,
    weekList: [],
    weekBtns: [],

    /* 校历（节假日 / 调休 / 调课） */
    calShow: false,
    calLoading: false,
    calHolidays: [],
    calShifts: [],
    holidayForm: { date: '', name: '', kind: 'OFF' },
    shiftForm: { from: '', to: '', note: '' },

    /* ---------- 临时调课（按周生效的课次例外） ---------- */
    shiftShow: false,
    shiftTab: 'week',
    shiftTabs: [
      { key: 'week', text: '本周' },
      { key: 'multi', text: '多周次' },
      { key: 'date', text: '按日期' },
      { key: 'ai', text: 'AI 调课' },
      { key: 'list', text: '结果' }
    ],
    shiftSessionLabels: [],
    shiftSessionIndex: 0,
    shiftKind: 'OFF',          // OFF=本周不上；MOVE=改到别的格子
    shiftToDay: 1,
    shiftToPeriod: 1,
    shiftWeeks: [],            // 多周次模式选中的周次
    shiftWeekBtns: [],
    shiftSaving: false,
    offDays: [],               // 「按日期」里勾选的「不上课」的星期（1-7）
    periodChips: [1, 2, 3, 4, 5],

    /* AI 智能调课 */
    aiText: '',
    aiBusy: false,
    aiError: '',
    aiPrompt: '',
    aiPromptShow: false,
    aiPreview: [],
    aiOps: [],
    aiNotes: '',
    aiWarnings: [],
    aiExamples: [
      '把周三第 5 节的音乐基础改到周五第 1 节',
      '这周四第 3 节不上',
      '周五的课全部不上',
      '周一第 2 节的微课设计与制作改到周二第 4 节'
    ],

    /* 临时调课结果 */
    shiftItems: [],

    dayChips: DAYS,
    weekRules: WEEK_RULES,
    saving: false,

    /* ---------- 青果课表导入 / 申请适配（需求 D-2） ---------- */
    canSchedule: false,      // 超管或本班生活委员：可直接导入本班课表
    importShow: false,       // 导入预览弹层
    importPreview: null,     // {courseCount, sessionCount, warnings, courses, sessions}
    importBusy: false,       // 上传 / 解析 / 导入中
    importFileID: '',        // 已上传云存储的 fileID（大文件兜底路径才用）
    // 🔍 2026-10-05：改为 base64 直传（云函数在 VPC 内回下载云存储极慢，会 20s 超时）
    importFileBase64: '',    // 课表文件的 base64（主路径）
    importFileGroup: '',     // 本次导入选定的组别（提交时复用）
    // 组别选择（2026-10-05）：青果的 A 组 / B 组是两个**独立文件**、文件内无任何组别标记，
    // 所以组别完全由用户在导入前手选。''=全体课（A/B 两视图都看得到）。
    groupSheetShow: false,   // 组别选择弹层
    groupPending: '',        // 记住这次要选什么：'import' 导入 / 'apply' 申请适配
    importGroup: '',         // 选定的组别（提交给云端）
    diagFileID: ''           // 🔍 诊断用：最近一次上传成功的 fileID（导入失败后也能拿去量下载耗时）
  },

  onLoad() {
    const app = getApp();
    // 课表相关的一律用本地常量，不依赖登录返回的 config
    const cw = util.currentWeek(tt.TERM_START, tt.TOTAL_WEEKS) || 1;
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight || 20,
      termStart: tt.TERM_START,
      totalWeeks: tt.TOTAL_WEEKS,
      current: cw,
      week: cw
    });
    this._buildWeekList();
  },

  onShow() {
    const app = getApp();
    app.setTabBar(1);
    // v0.7.31：不再立即播 —— 等「身份(app.ready) + 首屏数据(loading=false)」就绪、或 READY_MS 兜底超时再统一开播
    pageAnim.playReady(this, getApp());
    let firstCounselor = false;
    const applyAuth = () => {
      const p = (app && app.globalData && app.globalData.profile) || {};
      firstCounselor = p.groupTag === 'X';
      const canViewGroups = !!(app.isCommittee && app.isCommittee());
      const patch = {
        isAdmin: !!(app && app.isAdmin && app.isAdmin()),
        isSuper: !!(app && app.isSuper && app.isSuper()),
        isCounselor: firstCounselor,
        hasTimetable: (p.classId || 1) === config.TIMETABLE_CLASS_ID,
        // 排班域：超管或本班生活委员（后端 guard 已算好下发，前端只读，不再比对 position 字面量）
        canSchedule: !!(app.canSchedule && app.canSchedule()),
        // 查看 A/B 组课表 + 临时调课：超管/班委（后端 guard.requireCommittee 同口径）
        canViewGroups: canViewGroups
      };
      if (canViewGroups) {
        // 班委/超管：默认按本人所属组（A/B），手动选过则尊重选择
        if (!this._groupPicked && p.groupTag) patch.viewGroup = p.groupTag;
      } else {
        // 普通成员不能看 A/B 组课表 → 全班课表只显示「全体课」(groupScope 为空)
        patch.viewGroup = 'ALL';
      }
      this.setData(patch);
      // 模拟态护栏（v1.0.5）：身份套用后同步顶部横幅
      impersonate.sync(this);
    };
    applyAuth();
    const wasCounselor = firstCounselor;
    this._afterAuth();
    // 登录可能在 onShow 之后才完成：登录就绪后重新套用身份，避免超级管理员编辑入口首屏不显示。
    // 需求⑧：身份从「非辅导员」变成「辅导员」时必须再走一次 _afterAuth 把网格清掉。
    if (app && app.globalData && !app.globalData.authChecked) {
      app.ready().then(() => {
        applyAuth();
        if (this.data.isCounselor !== wasCounselor) this._afterAuth();
      });
    }
    // v0.7.32 问题②：切 tab 也做一次节流身份重校；身份变了就重套 + 重建课表
    if (typeof app.recheckAuth === 'function') {
      app.recheckAuth().then((changed) => {
        if (!changed) return;
        applyAuth();
        this._afterAuth();
      }).catch(() => {});
    }
  },

  /** 顶部「模拟中」横幅的「恢复本人」（v1.0.5） */
  onRecoverSelf() {
    impersonate.recover();
  },

  /**
   * 需求⑧：辅导员暂不展示课表（原话：等学校教务系统开通后接入，并支持按班级 A/B/全体切换查看）。
   * 只决定「要不要渲染网格」：辅导员不调 load()，`loading` 置 false 让页面走空态分支。
   * 将来接教务系统时，把这里换成「按 viewGroup 拉教务课表」即可。
   */
  _afterAuth() {
    this._buildMineOptions();
    if (this.data.isCounselor || !this.data.hasTimetable) {
      // 辅导员 / 非课表班：清掉可能由上一个身份渲染出来的网格，避免课表残影，走空态分支
      this.setData({ loading: false, failed: false, failMsg: '', grid: [], dates: [], periods: [], tip: '' });
      return;
    }
    this.load();
  },

  /**
   * 「我的课表」弹层用的两组选项 + 班委权限。
   * canPublish 口径**必须**与后端 `requireTimetablePublish` 一致：
   * 超管 / 班长兼团支书 / 副班长（**不含辅导员** —— 发布覆盖全班课表，授权面要窄）。
   * 前端只是少显示一个按钮，真正的闸门在后端。
   */
  _buildMineOptions() {
    const app = getApp();
    const p = (app && app.globalData && app.globalData.profile) || {};
    const pos = String(p.position || '');
    const isSuper = !!(app && app.isSuper && app.isSuper());
    const canPublish = isSuper || pos === '班长兼团支书' || pos === '副班长';
    const days = [];
    for (let d = 1; d <= 7; d++) days.push({ d: d, t: '周' + ['一', '二', '三', '四', '五', '六', '日'][d - 1] });
    const periods = [];
    for (let i = 1; i <= 7; i++) periods.push({ p: i, text: '第' + i + '节' });
    this._dayOptions = days;
    this._periodOptions = periods;
    this.setData({ canPublish: canPublish, dayOptions: days, periodOptions: periods });
  },

  _buildWeekList() {
    const list = [];
    for (let i = 1; i <= (this.data.totalWeeks || 18); i++) list.push(i);
    this.setData({ weekList: list });
  },

  /** 课表完全本地渲染：不发任何网络请求 */
  load() {
    this.setData({ loading: false, failed: false, failMsg: '' });
    this._holidays = tt.holidays();
    this._shifts = tt.shifts();
    // 按数据源取课次：全班走本地 timetable.js；我的课表走后端 member_timetable
    this._courses = this._resolveCourses();
    try {
      this._build(this._courses);
    } catch (e) {
      console.error('[timetable] _build failed', e);
      this.setData({ failed: true, failMsg: '课表渲染出错：' + ((e && e.message) || e) });
      return;
    }
    // 临时调课弹层依赖的课次列表 / 周次按钮跟着本周刷新
    // ⚠️ 「我的课表」没有 sessionId（值日/调课是全班课次的事），不给调课面板塞我的行
    this._syncShiftSessions();
    this._syncShiftWeekBtns();
    this.setData({ loading: false });
    // 首次进「我的课表」时才拉数据（懒加载，不给首页/全班视图添网络开销）
    if (this.data.srcView === 'mine' && !this.data.mineLoaded) this._loadMine();
  },

  /** 当前数据源对应的课次数组（形状与 tt.sessionsOfWeek 一致，供 _build 消费） */
  _resolveCourses() {
    if (this.data.srcView === 'mine') return this._mineAsCourses();
    return tt.sessionsOfWeek(this.data.week);
  },

  /**
   * 我的课表 → 课表网格用的形状。
   * ⚠️ sessionId 用 `m<memberId>-<行id>` 合成**字符串**占位：个人课表不对应
   *    session 表的课次（没有值日、没有调课），但 _build / 详情 / onCell 都按
   *    sessionId 索引，给一个稳定的合成 id 最省改动，且绝不会撞真实 sessionId。
   * ⚠️ courseId 固定 0：配色走 util.courseColor(0)，个人课表整屏同色（个人课表
   *    没有「课程配色」语义，同色反而更干净）。
   */
  _mineAsCourses() {
    return (this.data.mineRows || []).map((r) => ({
      sessionId: 'm' + r.id,
      mineId: Number(r.id),
      courseId: 0,
      name: r.name,
      teacher: r.teacher || '',
      room: r.room || '',
      dayOfWeek: Number(r.dayOfWeek) || 1,
      period: Number(r.period) || 1,
      weeks: r.weeks || '',
      weekRule: r.weekRule || 'ALL',
      groupScope: '',
      dutyCount: 0,
      isMine: true
    }));
  },

  /** 拉我的课表（member_timetable） */
  _loadMine(force) {
    if (this.data.mineLoading) return;
    if (this.data.mineLoaded && !force) return;
    this.setData({ mineLoading: true });
    api.myTimetableList({}, { toast: false })
      .then((res) => {
        const list = (res && res.list) || [];
        this._mineRaw = list;
        this.setData({
          mineRows: list,
          mineCount: list.length,
          mineLoaded: true,
          mineLoading: false,
          mineEmpty: list.length === 0
        });
        if (this.data.srcView === 'mine') {
          this._courses = this._resolveCourses();
          this._build(this._courses);
        }
      })
      .catch(() => {
        this.setData({ mineLoading: false });
        if (this.data.srcView === 'mine') {
          util.toast('加载我的课表失败');
        }
      });
  },

  /**
   * 值日名单：只在打开课次详情时才按需拉一次。
   * 课表本身不依赖它 —— 请求失败就只不显示名单，页面照常。
   */
  _ensureDuties() {
    const wk = this.data.week;
    if (this._dutyWeek === wk || this._dutyLoading) return;
    this._dutyLoading = true;
    api.courseListWeek({ week: wk }, { toast: false })
      .then((res) => {
        this._dutyLoading = false;
        const list = Array.isArray(res) ? res : ((res && res.list) || []);
        const map = {};
        list.forEach(c => { map[c.sessionId] = (c.duties || []); });
        this._dutyMap = map;
        // 把名单同步回 _courses，保证点开的详情读得到值日名单
        (this._courses || []).forEach(c => {
          c.duties = (map[c.sessionId] || []).map(x => Object.assign({}, x, {
            seqText: x.seq ? String(x.seq) : '·'
          }));
        });
        this._dutyWeek = wk;
        this._build(this._resolveCourses());
        // 详情正开着：把新拿到的名单回填进去
        if (this.data.detailShow && this.data.detail) {
          const co = (this._courses || []).find(c => Number(c.sessionId) === Number(this.data.detail.sessionId));
          if (co) this.setData({ detail: co });
        }
      })
      .catch(() => { this._dutyLoading = false; });
  },

  /** 在已构建的网格里按 sessionId 找课程（一格可能有多节课） */
  _findCell(sessionId) {
    const grid = this.data.grid || [];
    for (const row of grid) {
      for (const cell of row) {
        if (cell && cell.courses) {
          const hit = cell.courses.find(c => Number(c.sessionId) === Number(sessionId));
          if (hit) return hit;
        }
      }
    }
    return null;
  },

  /** 按「分组视图」过滤：仅看所选组的分组课 + 全体课。
   *  ⚠️ 只对「全班课表」生效；「我的课表」是本人私有课表，不做 A/B 过滤（源数据 groupScope 恒空）。
   *  ⚠️ 普通成员（canViewGroups=false）不允许看 A/B 组课表 → 只看「全体课」(groupScope 为空)。 */
  _filterByGroup(courses) {
    if (this.data.srcView === 'mine') return courses;
    if (!this.data.canViewGroups) {
      return courses.filter(c => !c.groupScope);
    }
    const g = this.data.viewGroup;
    if (g !== 'A' && g !== 'B') return courses.filter(c => !c.groupScope);
    return courses.filter(c => !c.groupScope || c.groupScope === g);
  },

  /**
   * 左下角入口（v0.7.21 需求③）：A 组 / B 组 / 临时调课 三行收在一个按钮里。
   * 展开态纯 CSS 过渡（transform + opacity），所以这里只翻一个布尔值，
   * 不锁点击、不等动画 —— 半途再点一下能立刻反向收起。
   */
  onMenuToggle() { this.setData({ fabMenuOpen: !this.data.fabMenuOpen }); },

  /** 选 A 组 / B 组：切换视图（不重新请求，直接重建网格）+ 收起菜单 */
  onMenuGroup(e) {
    const key = String(e.currentTarget.dataset.key || '');
    if (!key) return;
    this.setData({ fabMenuOpen: false });
    if (key === this.data.viewGroup) return;
      this._groupPicked = true;
      this.setData({ viewGroup: key });
      // 换组带过渡（需求⑤）：_build 收到 animate=true 时走 FLIP
      this._build(this._resolveCourses(), true);
    },

  /**
   * 切换课表数据源：全班课表 ⇄ 我的课表（2026-10-06）。
   *
   * 为什么不用跳独立页：用户原话「每次这样很麻烦，还要单独点击进去」——
   * 跳页会丢失当前周次/滚动位置/组选择，且多一次返回操作。
   * 页内切换只换数据源，**周次 / A-B 组 / 节假日 / 调课全部保持不变**。
   */
  onSwitchSrc(e) {
    const key = String(e.currentTarget.dataset.key || '');
    if (!key || key === this.data.srcView) return;
    const first = (this.data.srcView === 'mine');
    this.setData({ srcView: key, detailShow: false });
    if (key === 'mine' && !this.data.mineLoaded) {
      // 首次切进我的课表：**立即**用空 mineRows 重建网格（空态秒出，不建国等待），
      // 数据回来后 _loadMine 会再 _build 填充。这里必须主动 _build —— 否则
      // 旧的全班网格会一直挂着，等网络回来才切换（用户感知约 1 秒延迟）。
      this.setData({ mineRows: [], mineCount: 0, mineEmpty: false });
      this._courses = this._resolveCourses();
      this._build(this._courses);
      this._loadMine();
      return;
    }
    this._courses = this._resolveCourses();
    this._build(this._courses, !first ? false : true);
  },

  /** 进临时调课（仅超管有这一行）；收起菜单再开弹层，避免两层浮层叠在一起 */
  onMenuShift() {
    this.setData({ fabMenuOpen: false });
    this.onShiftOpen();
  },

  /** 构建「上课周次」多选按钮的选中态（WXML 不支持 .indexOf，改用预计算数组） */
  _syncWeekBtns() {
    const weeks = (this.data.form && this.data.form.weeks) || [];
    const set = new Set(weeks);
    const btns = (this.data.weekList || []).map(n => ({ n, on: set.has(n) }));
    this.setData({ weekBtns: btns });
  },

  /**
   * @param {Array}   courses
   * @param {boolean} [animate] 用 FLIP 过渡换网格（只有 A 组 ⇄ B 组用）。
   *   为什么只有这一个入口开动画：
   *     · 切周已经由 .wk-swipe 那套方向性滑动包着，再叠一层 FLIP 是两段运动打架；
   *     · 首屏 / 重新加载没有「旧位置」可飞（列表还没渲染过，量不到反而会误判成新增）。
   */
  _build(courses, animate) {
    const wk = this.data.week;
    const visible = this._filterByGroup(courses || []);
    const hMap = {};
    (this._holidays || []).forEach(h => { hMap[h.date] = h; });
    const shList = this._shifts || [];
    const md = (ds) => { const p = String(ds || '').split('-'); return p.length === 3 ? (Number(p[1]) + '/' + Number(p[2])) : ''; };

    const datesAll = [];
    const todayStr = new Date().toISOString().slice(0, 10);
    const todayDow = util.todayWeekday();
    for (let d = 1; d <= 7; d++) {
      const ds = util.dateOfWeekDay(this.data.termStart, wk, d);
      const num = ds ? Number(ds.slice(8, 10)) : '';
      const h = ds ? hMap[ds] : null;
      const off = !!(h && h.kind === 'OFF');
      const outShift = ds ? shList.find(s => String(s.from).slice(0, 10) === ds) : null;
      const inShift = ds ? shList.find(s => String(s.to).slice(0, 10) === ds) : null;
      datesAll.push({
        dow: d,
        short: util.weekdayShort(d),
        day: num,
        isToday: !!ds && ds === todayStr && d === todayDow,
        isHoliday: off,
        holidayName: off ? h.name : '',
        isMakeup: !!(h && h.kind === 'MAKEUP'),
        isWeekend: d >= 6,
        // 「按日期调课」里勾选的「这几天不上」——WXML 不支持 indexOf，这里预先算好
        off: (this._offDays || []).indexOf(d) >= 0,
        shiftOutText: outShift ? ('调至 ' + md(outShift.to)) : '',
        shiftInText: inShift ? (md(inShift.from) + ' 调入') : ''
      });
    }

    /*
     * 显示哪些天：默认周一~周五；只要周末（周六 / 周日）有课就补上这两列
     * ——「没课不显示周六日，调课后有课了则显示」（§43 需求④）。
     * 注意用 visible 且排除「调出」的课：调出日的课已经挪走，不该再撑出一列。
     */
    const hasWeekend = visible.some(c => !c.movedOut && Number(c.dayOfWeek) >= 6);
    const showDows = hasWeekend ? [1, 2, 3, 4, 5, 6, 7] : [1, 2, 3, 4, 5];
    const colW = showDows.length <= 5
      ? Math.floor(BOARD_INNER / showDows.length)
      : COL_W_WEEKEND;
    const dates = showDows.map(d => datesAll[d - 1]);

    // 左列只显示节次号「1-5」，**不显示上课时间**（用户要求去掉时间行）
    const periods = [];
    for (let p = 1; p <= 5; p++) periods.push({ p });

    // 一格多课：grid[p][c] = { empty, dow, period, wk, courses:[] }；列下标 c ↔ showDows[c]
    const grid = [];
    for (let p = 1; p <= 5; p++) {
      grid.push(showDows.map(d => ({ empty: true, dow: d, period: p, wk: d >= 6, courses: [] })));
    }
    const colorOf = (cid) => util.courseColor(Number(cid || 0));
    visible.forEach(c => {
      if (c.movedOut) return; // 调出日的课从原列消失，仅日期表头标注「调至 X/X」
      const p = Number(c.period), d = Number(c.dayOfWeek);
      if (p < 1 || p > 5) return;
      const ci = showDows.indexOf(d);
      if (ci < 0) return;
      const cell = grid[p - 1][ci];
      const col = colorOf(c.courseId);
      cell.courses.push({
        sessionId: c.sessionId,
        name: c.name,
        room: c.room,
        teacher: c.teacher,
        weekRule: c.weekRule,
        weeks: c.weeks || '',
        weekText: weekText(c.weeks || ''),
        groupScope: c.groupScope,
        dutyCount: c.dutyCount,
        // 值日名单来自按需请求；没拉到就是空数组，不影响课表本身
        duties: ((this._dutyMap && this._dutyMap[c.sessionId]) || []).map(x => Object.assign({}, x, {
          seqText: x.seq ? String(x.seq) : '·'
        })),
        classDate: c.classDate,
        shifted: !!c.shifted,
        isHoliday: !!c.isHoliday,
        holidayName: c.holidayName || '',
        movedOut: !!c.movedOut,
        movedIn: !!c.movedIn,
        shiftToText: c.shiftToText || '',
        shiftFromText: c.shiftFromText || '',
        dowText: util.weekdayShort(d),
        dayOfWeek: d,
        period: p,
        bg: col.bg,
        fg: col.fg,
        // A 组 ⇄ B 组 FLIP 的内联样式落点（v0.7.21 需求⑤）；wxml 用 style="background:{{co.bg}};{{co.flip}}"
        flip: ''
      });
    });
    grid.forEach(row => row.forEach(cell => { cell.empty = cell.courses.length === 0; }));

    const grouped = visible.filter(c => c.groupScope);
    const tips = [];
    if (grouped.length) tips.push('本周有 ' + grouped.length + ' 节分组课（仅对应小组可见）');
    const offDays = dates.filter(x => x.isHoliday);
    if (offDays.length) tips.push('本周放假：' + offDays.map(x => (x.day + '日 ' + x.holidayName)).join('、'));
    const mkDays = dates.filter(x => x.isMakeup);
    if (mkDays.length) tips.push('调休上班：' + mkDays.map(x => ('周' + x.short + ' ' + x.day + '日')).join('、'));
    const wkCourses = visible.filter(c => !c.movedOut && Number(c.dayOfWeek) >= 6);
    if (wkCourses.length) tips.push('本周有 ' + wkCourses.length + ' 节排在周六 / 周日');
    if (shList.length) tips.push('本周有 ' + shList.length + ' 处按天调课');

    const patch = () => ({
      dates,
      periods,
      grid,
      colW,
      dateWidth: showDows.length * colW,
      showScrollHint: showDows.length > 5,
      tip: tips.join('  ·  ')
    });

    if (!animate) { this.setData(patch(), () => this._fitHeight()); return; }

    /*
     * A 组 ⇄ B 组：网格整体重建（onMenuGroup 里直接 _build，不重新请求），
     * 用 FLIP 让**两个视图都有的课**（全体课）飞到新位置，只在目标视图出现的课从下方淡入。
     * 位置只用 top —— 课表主体是 scroll-x，横向偏移不在过渡范围内；而且换组只改变
     * 「哪些格子有内容」，不改变行列几何（除非本组课多出一列周末，那时横向是跳变的，
     * 这是横向滚动容器本身的限制，不在这条过渡的职责里）。
     *
     * ⚠️ 已知取舍：离场块是**瞬时移除**。网格没有「行高」可塌缩（把单个格子的高度塌掉会把
     *    同一行其余格子一起拉开），而 max-height 并集渲染要把新旧两套 grid 拼成一张，
     *    代价远大于收益。观众要看到的是「留下来的课在飞、新来的课在长」，这一条已经满足。
     */
    const lt = listTransition;
    const tk = (this._ttFlipToken = (this._ttFlipToken || 0) + 1);
    // 新对象一律带 flip=''，避免上一次的残留样式跟着重建的对象一起渲染
    grid.forEach((row) => row.forEach((cell) => (cell.courses || []).forEach((co) => { co.flip = ''; })));

    lt.flip(this, {
      sel: '.tt-cell[data-sid]', key: 'sessionId', field: 'flip',
      guard: () => this._ttFlipToken === tk,
      rows: () => {
        const out = [];
        grid.forEach((row) => row.forEach((cell) => (cell.courses || []).forEach((co) => out.push(co))));
        return out;
      },
      patch,
      after: () => {
        if (this._ttFlipToken !== tk) return;
        grid.forEach((row) => row.forEach((cell) => (cell.courses || []).forEach((co) => { co.flip = ''; })));
        this.setData({ grid });
        this._fitHeight();
      }
    });
  },

  /**
   * 自适应屏幕高度：量出课表顶部在屏幕中的位置，把剩下的高度平分给 5 行。
   * 行高夹在 [104, 168]rpx —— 太矮课名挤成一条线，太高就得滚动。
   * 登录态/网络都不依赖，纯本地计算；测不到（节点未渲染）就保持默认 rowH。
   */
  _fitHeight() {
    let win = null;
    try {
      win = (typeof wx.getWindowInfo === 'function') ? wx.getWindowInfo() : wx.getSystemInfoSync();
    } catch (e) { win = null; }
    if (!win || !win.windowWidth || !win.windowHeight) return;
    // 查询接口在部分环境（单测桩 / 低版本基础库）不完整，取不到就保持默认行高
    if (typeof this.createSelectorQuery !== 'function') return;
    const ratio = 750 / win.windowWidth;              // 1px = ?rpx
    const viewH = win.windowHeight * ratio;           // 视口高（rpx）
    const headH = this.data.headH || 72;
    const reserve = 206;                              // 底部：提示语 + 悬浮按钮 + 底栏让位（rpx；第 6 轮底栏缩小后 220→206）
    try {
      const q = this.createSelectorQuery();
      const sel = q && q.select ? q.select('.tt-board') : null;
      if (!sel || typeof sel.boundingClientRect !== 'function') return;
      sel.boundingClientRect((rect) => {
        if (!rect) return;
        const boardTop = rect.top * ratio;
        let rowH = Math.floor((viewH - boardTop - reserve - headH) / 5);
        rowH = Math.max(104, Math.min(rowH, 168));
        if (rowH !== this.data.rowH) this.setData({ rowH });
      }).exec();
    } catch (e) { /* 测量失败：保持默认行高，不影响课表渲染 */ }
  },

  /* ---------------- 校历：节假日 / 调休 / 调课 ----------------
   * 课表读的是本地副本，所以这里改动也先落本地（立刻生效），
   * 再尽力同步到数据库 —— 值日生成读的是库里那份，同步失败要提示。
   */
  onCalOpen() {
    this.setData({
      calShow: true,
      calLoading: false,
      calHolidays: tt.holidays(),
      calShifts: tt.shifts()
    });
  },
  onCalClose() { this.setData({ calShow: false }); },
  _reloadCal() {
    this.setData({ calHolidays: tt.holidays(), calShifts: tt.shifts() });
    return Promise.resolve();
  },
  /** 本地改动已生效，同步数据库失败时明确告知（值日生成读的是库里那份校历） */
  _syncWarn() {
    return () => util.toast('已本地保存，但同步服务端失败');
  },
  _syncOk() { util.toast('已保存'); },

  onHolidayPick(e) { this.setData({ 'holidayForm.date': e.detail.value }); },
  onHolidayName(e) { this.setData({ 'holidayForm.name': e.detail.value }); },
  onHolidayKind(e) { this.setData({ 'holidayForm.kind': e.currentTarget.dataset.value }); },
  onHolidaySave() {
    const f = this.data.holidayForm;
    if (!f.date) { util.toast('请选择日期'); return; }
    const date = String(f.date).slice(0, 10);
    const item = { date, name: String(f.name || '').trim() || '节假日', kind: f.kind === 'MAKEUP' ? 'MAKEUP' : 'OFF' };
    const list = tt.holidays().filter(h => String(h.date).slice(0, 10) !== date);
    list.push(item);
    list.sort((a, b) => (a.date < b.date ? -1 : 1));
    tt.saveHolidays(list);
    this.setData({ 'holidayForm.date': '', 'holidayForm.name': '' });
    this._reloadCal().then(() => this.load());
    api.saveHoliday({ date: item.date, name: item.name, kind: item.kind }, { toast: false })
      .then(() => this._syncOk())
      .catch(this._syncWarn());
  },
  onHolidayDel(e) {
    const date = String(e.currentTarget.dataset.date).slice(0, 10);
    util.confirm('删除后该日恢复正常上课', '删除节假日').then(ok => {
      if (!ok) return;
      tt.saveHolidays(tt.holidays().filter(h => String(h.date).slice(0, 10) !== date));
      this._reloadCal().then(() => this.load());
      api.removeHoliday({ date }, { toast: false })
        .then(() => this._syncOk())
        .catch(this._syncWarn());
    });
  },

  onShiftFrom(e) { this.setData({ 'shiftForm.from': e.detail.value }); },
  onShiftTo(e) { this.setData({ 'shiftForm.to': e.detail.value }); },
  onShiftNote(e) { this.setData({ 'shiftForm.note': e.detail.value }); },
  onShiftSave() {
    const f = this.data.shiftForm;
    if (!f.from || !f.to) { util.toast('请选择调出 / 调入日期'); return; }
    const item = {
      id: Date.now(),
      _local: true,          // 本地自增 id，库里没有对应记录，删除时只能按 from_date 匹配
      week: this.data.week,
      from: String(f.from).slice(0, 10),
      to: String(f.to).slice(0, 10),
      note: String(f.note || '')
    };
    const list = tt.shifts().filter(s => String(s.from).slice(0, 10) !== item.from);
    list.push(item);
    tt.saveShifts(list);
    this.setData({ shiftForm: { from: '', to: '', note: '' } });
    // 调出日如果不在当前周，先跳到那一週，超管才能立刻看到「原列消失 + 调入日出现」
    const fw = tt.weekOfDate(item.from);
    this._reloadCal().then(() => {
      if (Number(fw) >= 1 && Number(fw) <= this.data.totalWeeks && Number(fw) !== this.data.week) {
        this.setData({ week: Number(fw) });
      }
      this.load();
    });
    // 服务端防呆（v0.7.16）：跨周调课返回 needConfirm，弹确认后带 confirm=true 重发
    const doSave = (confirmed) => api.saveShift(
      { from: item.from, to: item.to, note: item.note, confirm: confirmed === true },
      { toast: false }
    ).then((r) => {
      if (r && r.needConfirm) {
        util.confirm(r.message, '跨周调课').then(ok => { if (ok) doSave(true); });
        return;
      }
      util.toast('已保存，值日请重新生成');
    }).catch(this._syncWarn());
    doSave(false);
  },
  onShiftDel(e) {
    const id = Number(e.currentTarget.dataset.id);
    util.confirm('取消后该日恢复原课表', '取消调课').then(ok => {
      if (!ok) return;
      const hit = tt.shifts().find(s => Number(s.id) === id);
      tt.saveShifts(tt.shifts().filter(s => Number(s.id) !== id));
      this._reloadCal().then(() => this.load());
      // 本地新建的调课没有库里的 id，只能按 from_date 删
      api.removeShift(hit && hit._local ? { from: hit.from } : { id: id }, { toast: false })
        .then(() => this._syncOk())
        .catch(this._syncWarn());
    });
  },

  /* ---------------- 临时调课（按周生效的课次例外） ----------------
   * 与「校历 · 按天整体调课」的分工：
   *   校历 → 某一天整体挪走（day_shift），影响这一天所有课次；
   *   这里 → 某节课这一周例外（session_shift），只动被点名的那节课。
   * 两者正交、可叠加，都由 common/week.js 的 resolveSlot 统一解释。
   * 写入策略是**先服务端后本地**：服务端还要同步值日、退回已发布的草稿，
   * 本地抢先改会让超管看到一张与真实入库不一致的课表。
   * ------------------------------------------------------------ */

  onShiftOpen() {
    this._syncShiftSessions();
    this._syncShiftWeekBtns();
    this._loadShiftItems();
    this._loadAiPrompt();
    this.setData({ shiftShow: true });
  },

  onShiftClose() { this.setData({ shiftShow: false }); },

  onShiftTab(e) {
    const key = e.detail.key;
    this.setData({ shiftTab: key });
    if (key === 'list') this._loadShiftItems();
    if (key === 'ai') this._loadAiPrompt();
  },

  /** 本周可选课次（picker 用）。按「星期 + 节次」排序，标签一眼能认出是哪节课 */
  _syncShiftSessions() {
    const list = (this._courses || []).slice()
      .filter(c => !c.movedOut && !c.movedIn) // 调入/调出是显示层产物，不进调课选择器
      .sort((a, b) => (a.dayOfWeek - b.dayOfWeek) || (a.period - b.period));
    this._shiftSessions = list;
    const labels = list.map(c => '周' + util.weekdayShort(c.dayOfWeek) + ' 第' + c.period + '节 · '
      + c.name + (c.groupScope ? '（' + c.groupScope + ' 组）' : ''));
    let idx = Number(this.data.shiftSessionIndex) || 0;
    if (idx >= list.length) idx = 0;
    this.setData({ shiftSessionLabels: labels, shiftSessionIndex: idx });
  },

  onShiftPickSession(e) { this.setData({ shiftSessionIndex: Number(e.detail.value) }); },
  onShiftKind(e) { this.setData({ shiftKind: e.detail.key }); },
  onShiftToDay(e) { this.setData({ shiftToDay: Number(e.currentTarget.dataset.value) }); },
  onShiftToPeriod(e) { this.setData({ shiftToPeriod: Number(e.currentTarget.dataset.value) }); },

  _targetSession() {
    const list = this._shiftSessions || [];
    return list[Number(this.data.shiftSessionIndex) || 0] || null;
  },

  /** 长按课表格子 → 直接打开「本周调整」并定位到这一格的那节课 */
  onCellLongPress(e) {
    if (!this.data.canViewGroups) { util.toast('只有班委可以临时调课'); return; }
    const sid = Number(e.currentTarget.dataset.sid);
    if (!sid) { util.toast('这个格子没有课，长按无效'); return; }
    this._syncShiftSessions();
    this._syncShiftWeekBtns();
    const idx = (this._shiftSessions || [])
      .findIndex(s => Number(s.sessionId) === sid);
    this.setData({
      shiftShow: true,
      shiftTab: 'week',
      shiftSessionIndex: idx >= 0 ? idx : 0,
      shiftKind: 'OFF'
    });
  },

  /** 统一提交：成功后落本地并刷新课表；服务端告警（撞车等）用弹窗说清楚 */
  _applyShift(payload, localItems, tipText) {
    if (this.data.shiftSaving) return;
    this.setData({ shiftSaving: true });
    api.shiftSet(payload, { toast: false })
      .then((r) => {
        this.setData({ shiftSaving: false });
        tt.upsertSessShifts(localItems || []);
        this._offDays = [];
        this.load();
        this._loadShiftItems();
        const warns = (r && r.warnings) || [];
        if (warns.length) {
          wx.showModal({
            title: '已保存，但有提醒',
            content: warns.join('\n'),
            showCancel: false,
            confirmColor: '#3370FF'
          });
        } else {
          util.toast(tipText + ((r && r.resetPublish) ? '（需重新发布值日）' : ''));
        }
      })
      .catch((e) => {
        this.setData({ shiftSaving: false });
        util.toast((e && e.errMsg) || '同步服务端失败，未生效');
      });
  },

  /** ① 本周调整：只改第 this.data.week 周 */
  onShiftApplyWeek() {
    const s = this._targetSession();
    if (!s) { util.toast('请先选择课次'); return; }
    const wk = this.data.week;
    const move = this.data.shiftKind === 'MOVE';
    const toDay = move ? this.data.shiftToDay : null;
    const toPeriod = move ? this.data.shiftToPeriod : null;
    this._applyShift(
      { week: wk, sessionIds: [s.sessionId], kind: move ? 'MOVE' : 'OFF', toDay, toPeriod, note: '手动调课' },
      [{ sessionId: s.sessionId, week: wk, kind: move ? 'MOVE' : 'OFF', toDay, toPeriod, note: '手动调课' }],
      move ? ('已改到 周' + util.weekdayShort(toDay) + '第 ' + toPeriod + ' 节') : '已设为本周不上'
    );
  },

  /* ② 多周次：同一个课次一次改好几周 */
  _syncShiftWeekBtns() {
    const set = {};
    (this.data.shiftWeeks || []).forEach(n => { set[n] = 1; });
    this.setData({
      shiftWeekBtns: (this.data.weekList || []).map(n => ({
        n, on: !!set[n], cur: n === this.data.week
      }))
    });
  },

  onToggleShiftWeek(e) {
    const wk = Number(e.currentTarget.dataset.week);
    const cur = (this.data.shiftWeeks || []).slice();
    const i = cur.indexOf(wk);
    if (i >= 0) cur.splice(i, 1); else cur.push(wk);
    cur.sort((a, b) => a - b);
    this.setData({ shiftWeeks: cur });
    this._syncShiftWeekBtns();
  },

  onShiftApplyMulti() {
    const s = this._targetSession();
    if (!s) { util.toast('请先选择课次'); return; }
    const weeks = this.data.shiftWeeks || [];
    if (!weeks.length) { util.toast('请选择要调整的周次'); return; }
    const move = this.data.shiftKind === 'MOVE';
    const toDay = move ? this.data.shiftToDay : null;
    const toPeriod = move ? this.data.shiftToPeriod : null;
    this._applyShift(
      { weeks, sessionIds: [s.sessionId], kind: move ? 'MOVE' : 'OFF', toDay, toPeriod, note: '多周次调课' },
      weeks.map(wk => ({
        sessionId: s.sessionId, week: wk, kind: move ? 'MOVE' : 'OFF',
        toDay, toPeriod, note: '多周次调课'
      })),
      '已应用到 ' + weeks.length + ' 周'
    );
  },

  /* ③ 按日期：这几天不上 / 某天调到另一天 */
  onToggleOffDay(e) {
    const d = Number(e.currentTarget.dataset.dow);
    const cur = (this._offDays || []).slice();
    const i = cur.indexOf(d);
    if (i >= 0) cur.splice(i, 1); else cur.push(d);
    cur.sort((a, b) => a - b);
    this._offDays = cur;
    this.setData({ offDays: cur });
    this._build(this._courses || []);
  },

  onApplyDateOff() {
    const days = this.data.offDays || [];
    if (!days.length) { util.toast('请先选择要取消的日期'); return; }
    const wk = this.data.week;
    const dates = days.map(d => util.dateOfWeekDay(this.data.termStart, wk, d));
    // 本地那份要按**课次原本的星期**筛（与服务端 dates 展开口径一致），
    // 不能用已套过临时调课的 _courses，否则两边会算出不同的课次。
    const local = [];
    tt.sessions().forEach((s) => {
      if (days.indexOf(Number(s.day)) < 0) return;
      if (!tt.matchesWeeks(s.weeks, wk)) return;
      local.push({ sessionId: s.id, week: wk, kind: 'OFF', note: '按日期取消' });
    });
    this._applyShift(
      { dates, kind: 'OFF', note: '按日期取消' },
      local,
      '已取消 ' + days.length + ' 天的课'
    );
  },

  /* ④ AI 智能调课 */
  _loadAiPrompt() {
    if (this.data.aiPrompt) return;
    api.aiShiftPrompt({}, { toast: false })
      .then(r => this.setData({ aiPrompt: (r && r.prompt) || '' }))
      .catch(() => {});
  },

  onAiText(e) { this.setData({ aiText: e.detail.value, aiError: '' }); },
  onAiExample(e) {
    this.setData({ aiText: String(e.currentTarget.dataset.text || ''), aiError: '' });
  },
  onAiPromptShow() { this.setData({ aiPromptShow: true }); },
  onAiPromptClose() { this.setData({ aiPromptShow: false }); },
  onAiPromptInput(e) { this.setData({ aiPrompt: e.detail.value }); },
  onAiPromptReset() {
    api.aiShiftPrompt({}, { toast: false })
      .then(r => this.setData({ aiPrompt: (r && r.prompt) || '' }))
      .catch(() => {});
  },

  onAiPlan() {
    if (this.data.aiBusy) return;
    const text = String(this.data.aiText || '').trim();
    if (!text) { util.toast('请先说说要怎么调课'); return; }
    this.setData({
      aiBusy: true, aiError: '', aiPreview: [], aiOps: [], aiWarnings: [], aiNotes: ''
    });
    api.aiShiftPlan({ week: this.data.week, text, prompt: this.data.aiPrompt || undefined }, { toast: false })
      .then((r) => {
        const preview = (r && r.preview) || [];
        this.setData({
          aiBusy: false,
          aiPreview: preview,
          aiOps: (r && r.operations) || [],
          aiNotes: (r && r.notes) || '',
          aiWarnings: (r && r.warnings) || []
        });
        if (!preview.length) util.toast('AI 没有给出需要调整的课次');
      })
      .catch((e) => {
        // 不要把错误吞掉：AI 链路的失败原因必须让超管看见
        this.setData({ aiBusy: false, aiError: (e && (e.errMsg || e.message)) || 'AI 调课失败' });
      });
  },

  onAiDiscard() {
    this.setData({ aiPreview: [], aiOps: [], aiWarnings: [], aiNotes: '', aiError: '' });
  },

  onAiApply() {
    const ops = this.data.aiOps || [];
    if (!ops.length) { util.toast('没有可应用的方案'); return; }
    if (this.data.shiftSaving) return;
    const wk = this.data.week;
    this.setData({ shiftSaving: true, aiError: '' });
    // 一个操作可能包含多节课次，逐个写；某一步失败就停下并如实说明「前几步已生效」
    const run = (i) => {
      if (i >= ops.length) {
        this.setData({ shiftSaving: false });
        tt.upsertSessShifts((this.data.aiPreview || []).map(p => ({
          sessionId: p.sessionId, week: wk, kind: p.kind,
          toDay: p.toDay, toPeriod: p.toPeriod, note: p.note
        })));
        this.load();
        this._loadShiftItems();
        this.setData({ aiPreview: [], aiOps: [], aiWarnings: [], aiNotes: '' });
        util.toast('已应用 AI 调课方案');
        return;
      }
      const op = ops[i];
      api.shiftSet({
        week: wk, sessionIds: op.sessionIds, kind: op.kind,
        toDay: op.toDay, toPeriod: op.toPeriod, note: op.note || 'AI 调课'
      }, { toast: false })
        .then(() => run(i + 1))
        .catch((e) => {
          this.setData({
            shiftSaving: false,
            aiError: '第 ' + (i + 1) + ' 步写入失败：' + ((e && e.errMsg) || '未知原因')
              + '（前面的步骤已生效，可在「结果」里撤销）'
          });
        });
    };
    run(0);
  },

  onAiCheck() {
    if (this.data.aiBusy) return;
    this.setData({ aiBusy: true, aiError: '' });
    api.scheduleAiCheck({ probe: false }, { toast: false })
      .then((r) => {
        this.setData({ aiBusy: false });
        const lines = [
          '通道：' + ((r && r.route) || '-'),
          '模型：' + ((r && r.model) || '-'),
          '出口：' + ((r && r.egress) || '-') + ((r && r.httpStatus) ? (' HTTP ' + r.httpStatus) : ''),
          '密钥：' + ((r && r.hasKey) ? '已配置' : '缺失'),
          '公共模块：' + ((r && r.hasSeqOf === false) ? '缺少 seqOf，请重新同步部署' : '正常'),
          (r && r.error) ? ('错误：' + r.error) : '未发现错误'
        ];
        wx.showModal({
          title: 'AI 链路自检', content: lines.join('\n'),
          showCancel: false, confirmColor: '#3370FF'
        });
      })
      .catch((e) => this.setData({ aiBusy: false, aiError: (e && e.errMsg) || '自检失败' }));
  },

  /* ⑤ 调课结果 */
  _loadShiftItems() {
    const wk = this.data.week;
    const items = tt.sessShiftsOfWeek(wk).map((x) => {
      const fromText = '周' + util.weekdayShort(x.fromDay) + ' 第' + x.fromPeriod + ' 节';
      return Object.assign({}, x, {
        effText: x.kind === 'OFF'
          ? (fromText + ' → 本周不上')
          : (fromText + ' → 周' + util.weekdayShort(x.toDay) + ' 第' + x.toPeriod + ' 节')
      });
    });
    this.setData({ shiftItems: items });
  },

  onShiftUndo(e) {
    const id = Number(e.currentTarget.dataset.id);
    const wk = this.data.week;
    util.confirm('撤销后这节课恢复原来的时间', '撤销临时调课').then((ok) => {
      if (!ok) return;
      api.shiftRemove({ week: wk, sessionIds: [id] }, { toast: false })
        .then(() => {
          tt.removeSessShifts([id], [wk]);
          this.load();
          this._loadShiftItems();
          util.toast('已撤销');
        })
        .catch(err => util.toast((err && err.errMsg) || '撤销失败'));
    });
  },

  onShiftClearWeek() {
    const wk = this.data.week;
    if (!this.data.shiftItems.length) { util.toast('本周没有临时调课'); return; }
    util.confirm('本周全部临时调课都会被撤销，课表恢复原样', '撤销本周全部调课').then((ok) => {
      if (!ok) return;
      api.shiftRemove({ weeks: [wk] }, { toast: false })
        .then(() => {
          tt.removeSessShifts([], [wk]);
          this.load();
          this._loadShiftItems();
          util.toast('已撤销本周全部临时调课');
        })
        .catch(err => util.toast((err && err.errMsg) || '撤销失败'));
    });
  },

  /* ---------------- 周切换 ---------------- */
  /**
   * 点日期条上的气泡箭头 / 越界回弹，都汇到这里。
   * 与值日页同一条路：先让旧课表朝方向滑走（160ms），再换数据、新课表从反方向滑入。
   * 越界（第 1 周还往左 / 最后一周还往右）由 swipe.shift 拦下，只播回弹、不换数据。
   */
  onWeekChange(e) {
    const wk = Number(e.detail.week);
    if (wk < 1 || wk > this.data.totalWeeks) return;
    const delta = wk - Number(this.data.week);
    if (!delta) return;
    swipe.shift(this, delta, (w) => this._applyWeek(w));
  },

  /** 真正换周（动画 out 段结束后才被回调） */
  _applyWeek(wk) {
    // 「按日期不上」是跟周走的，换周就清空勾选，免得张冠李戴
    this._offDays = [];
    // 左下角入口顺手收起：换周时它挂在原地会挡着课表滑入
    this.setData({ week: wk, offDays: [], fabMenuOpen: false });
    this.load();
  },

  onWeekPick() { this.setData({ weekPickerShow: true }); },
  onWeekPickerClose() { this.setData({ weekPickerShow: false }); },
  onPickWeek(e) {
    const wk = Number(e.currentTarget.dataset.week);
    if (wk < 1 || wk > this.data.totalWeeks) return;
    // 弹层先关掉：它是 fixed 的、又在动画容器之外，让它挡着看不到课表在动
    this.setData({ weekPickerShow: false });
    const delta = wk - Number(this.data.week);
    if (!delta) return;
    swipe.shift(this, delta, (w) => this._applyWeek(w));
  },

  /** 页面销毁时清掉动画定时器（否则定时器回来时 setData 一个已销毁的页面） */
  onUnload() {
    swipe.cancel(this);
    // A 组/B 组 FLIP 的打断令牌作废：链上还没醒的 setTimeout 自己退出，不再对已销毁实例 setData
    this._ttFlipToken = (this._ttFlipToken || 0) + 1;
  },

  /* ---------------- 课次 ---------------- */
  onCell(e) {
    const r = Number(e.currentTarget.dataset.r);
    const c = Number(e.currentTarget.dataset.c);
    const sid = e.currentTarget.dataset.sid;
    // 「我的课表」视图：点格子 = 编辑/删除我自己的这一节（不走值日/调课的课次详情）
    if (this.data.srcView === 'mine') {
      if (!sid) { this._openMineForm(null, c + 1, r + 1); return; }
      const mineId = Number(String(sid).replace(/^m/, ''));
      if (mineId) this._openMineForm(mineId, 0, 0);
      return;
    }
    const nSid = Number(sid);
    if (!nSid) {
      // 空格子：管理员点一下＝在该时间新增课次
      if (this.data.isAdmin) this._openForm(null, c + 1, r + 1);
      return;
    }
    const course = (this._courses || []).find(x => Number(x.sessionId) === nSid);
    if (!course) return;
    // 值日名单按需拉取：课表本身是本地的，这一步失败也只是没有名单
    this._ensureDuties();
    this.setData({ detailShow: true, detail: course });
  },

  /* ================================================================
   * 我的课表（页内，2026-10-06）
   * ------------------------------------------------------------
   * 个人课表 = member_timetable（后端强制 member_id=本人，所以「仅自己可见」
   * 是后端保证的）。这里只负责：增删改的弹层、选文件导入、一键同步全班、发布。
   * ================================================================ */

  /** 工具条「添加」：在当前视图默认时段（周一第1节）打开新增表单 */
  onMineAddTap() {
    this._openMineForm(null, 1, 1);
  },

  /** 打开「我的课次」表单（mineId=0 新增；否则编辑） */
  _openMineForm(mineId, dayOfWeek, period) {
    const src = mineId ? (this.data.mineRows || []).find(r => Number(r.id) === Number(mineId)) : null;
    this.setData({
      mineFormShow: true,
      mineFormSaving: false,
      mineForm: {
        id: src ? Number(src.id) : 0,
        name: src ? (src.name || '') : '',
        teacher: src ? (src.teacher || '') : '',
        room: src ? (src.room || '') : '',
        dayOfWeek: src ? (Number(src.dayOfWeek) || 1) : (dayOfWeek || 1),
        period: src ? (Number(src.period) || 1) : (period || 1),
        weekPreset: src ? (src.weekRule === 'ODD' ? 'odd' : (src.weekRule === 'EVEN' ? 'even' : 'all')) : 'all',
        weeksText: src ? (src.weeks || '') : ''
      },
      dayOptions: this._dayOptions || this._dayOptions,
      periodOptions: this._periodOptions || this._periodOptions
    });
  },

  onMineFormClose() {
    if (this.data.mineFormSaving) return;
    this.setData({ mineFormShow: false });
  },

  onMineFormInput(e) {
    const field = e.currentTarget.dataset.field;
    const val = e.detail && e.detail.value !== undefined ? e.detail.value : e.currentTarget.dataset.value;
    this.setData({ ['mineForm.' + field]: val });
  },

  onMinePickDay(e) { this.setData({ 'mineForm.dayOfWeek': Number(e.currentTarget.dataset.d) || 1 }); },
  onMinePickPeriod(e) { this.setData({ 'mineForm.period': Number(e.currentTarget.dataset.p) || 1 }); },
  onMinePickWeekPreset(e) { this.setData({ 'mineForm.weekPreset': e.currentTarget.dataset.key || 'all' }); },

  onMineSave() {
    const f = this.data.mineForm;
    if (!f) return;
    const name = String(f.name || '').trim();
    if (!name) { util.toast('请填写课程名'); return; }
    const preset = f.weekPreset || 'all';
    const weekRule = preset === 'odd' ? 'ODD' : (preset === 'even' ? 'EVEN' : 'ALL');
    let weeks = [];
    if (preset !== 'all') {
      weeks = String(f.weeksText || '').split(/[,，\s]+/).map(Number)
        .filter(n => Number.isInteger(n) && n >= 1 && n <= 53);
      if (!weeks.length) { util.toast('请填写周次，如 1,3,5,7'); return; }
    }
    this.setData({ mineFormSaving: true });
    api.myTimetableSave({
      item: {
        id: f.id || 0, name: name,
        teacher: String(f.teacher || '').trim(), room: String(f.room || '').trim(),
        dayOfWeek: f.dayOfWeek, period: f.period, weeks: weeks, weekRule: weekRule, kind: 'COURSE'
      }
    }, { loading: '保存中' })
      .then(() => {
        util.toast(f.id ? '已更新' : '已添加');
        this.setData({ mineFormShow: false });
        this._loadMine(true);
      })
      .catch(() => this.setData({ mineFormSaving: false }));
  },

  onMineDelete() {
    const f = this.data.mineForm;
    if (!f || !f.id) return;
    wx.showModal({
      title: '删除这节课？', content: '只会删除你自己课表里的这一条。', confirmColor: '#A32D2D',
      success: (res) => {
        if (!res.confirm) return;
        api.myTimetableDelete({ id: f.id }, { loading: '删除中' })
          .then(() => { util.toast('已删除'); this.setData({ mineFormShow: false }); this._loadMine(true); })
          .catch(() => {});
      }
    });
  },

  /* ---------- 一键同步：全班课表 → 我的课表 ---------- */
  onSyncFromClass() {
    api.myTimetableSync({ commit: false }, { toast: false })
      .then((res) => {
        const w = (res && res.willWrite) || 0;
        const r = (res && res.willReplace) || 0;
        if (!w) { util.toast('本班还没有课表，先等班委导入'); return; }
        wx.showModal({
          title: '同步全班课表？',
          content: '将用本班课表（' + w + ' 节）覆盖我的课表' + (r ? '，你现有的 ' + r + ' 节会被替换' : '') + '。',
          confirmColor: '#3370FF',
          success: (rs) => {
            if (!rs.confirm) return;
            api.myTimetableSync({ commit: true }, { loading: '同步中' })
              .then((rr) => { util.toast('已同步 ' + ((rr && rr.synced) || 0) + ' 节'); this._loadMine(true); })
              .catch(() => {});
          }
        });
      })
      .catch(() => util.toast('同步失败'));
  },

  /** 清空我的课表（2026-10-06）：打开二次确认弹层 */
  onMineClear() {
    if (!this.data.mineCount) { util.toast('我的课表本来就是空的'); return; }
    this.setData({ mineClearShow: true });
  },
  onMineClearClose() { this.setData({ mineClearShow: false }); },
  onMineClearConfirm() {
    if (this.data.mineClearBusy) return;
    this.setData({ mineClearBusy: true });
    api.myTimetableClear({}, { toast: false })
      .then((res) => {
        this.setData({ mineClearBusy: false, mineClearShow: false });
        util.toast('已清空 ' + ((res && res.cleared) || 0) + ' 节');
        this._loadMine(true);
      })
      .catch(() => { this.setData({ mineClearBusy: false }); util.toast('清空失败'); });
  },

  /* ---------- 选文件导入（青果 .xlsx）→ 我的课表 ---------- */
  onOpenMineImport() {
    this.setData({ mineImportShow: true, mineImportStep: 'pick', mineImportPreview: null, mineImportTotal: 0, mineImportWarn: [], mineImportFile: '' });
  },
  onMineImportClose() {
    if (this.data.mineImportBusy) return;
    this.setData({ mineImportShow: false, mineImportStep: 'pick' });
  },
  onMinePickFile() {
    const self = this;
    if (!wx.chooseMessageFile) { util.toast('当前微信版本不支持选择文件'); return; }
    wx.chooseMessageFile({
      count: 1, type: 'file', extension: ['xlsx', 'xls'],
      success(res) {
        const f = (res.tempFiles || [])[0];
        if (!f) return;
        // 选完文件先验扩展名（2026-10-06 用户需求）：教务系统常导出 .xls 旧格式，
        // 解析器按 .xlsx 处理，格式不对要明确提醒「另存为 .xlsx」而不是报解析失败。
        // ⚠️ 部分安卓选文件器不回传 name —— name 为空时不拦（交给后端解析兜底报错），防误杀。
        const name = String(f.name || '');
        if (name && !/\.xlsx$/i.test(name)) {
          wx.showModal({
            title: '文件格式不支持',
            content: '只支持 .xlsx 格式，你选的是「' + name + '」。请在电脑上用 Excel / WPS 打开后，另存为 .xlsx 格式再导入。',
            showCancel: false,
            confirmColor: '#3370FF'
          });
          return;
        }
        // ⚠️ base64 直传：云函数在 VPC 内回下载云存储极慢（20s 超时）
        wx.getFileSystemManager().readFile({
          filePath: f.tempFilePath || f.path, encoding: 'base64',
          success(r) { self._previewMineImport(r.data, f.name || '课表.xlsx'); },
          fail() { util.toast('读取文件失败，请重新选择'); }
        });
      },
      fail() {}
    });
  },
  _previewMineImport(b64, name) {
    const self = this;
    this.setData({ mineImportBusy: true });
    api.myTimetableImport({ base64: b64, commit: false }, { loading: '解析中', toast: false })
      .then((res) => {
        self.setData({
          mineImportBusy: false, mineImportStep: 'preview', mineImportFile: name,
          mineImportPreview: (res && res.preview) || [],
          mineImportTotal: (res && res.total) || 0,
          mineImportWarn: (res && res.warnings) || []
        });
        self._pendingImportB64 = b64;
      })
      .catch(() => { self.setData({ mineImportBusy: false }); util.toast('解析失败，请确认是青果导出的 .xlsx'); });
  },
  onConfirmMineImport() {
    const self = this;
    const b64 = this._pendingImportB64;
    if (!b64) return;
    this.setData({ mineImportBusy: true });
    api.myTimetableImport({ base64: b64, commit: true }, { loading: '导入中' })
      .then((res) => {
        util.toast('已导入 ' + ((res && res.imported) || 0) + ' 节');
        self.setData({ mineImportBusy: false, mineImportShow: false, mineImportStep: 'pick' });
        self._loadMine(true);
      })
      .catch(() => self.setData({ mineImportBusy: false }));
  },

  /* ---------- 班委：发布到全班 ---------- */
  onOpenMinePublish() {
    if (!this.data.canPublish) { util.toast('仅班长 / 副班长 / 超管可发布'); return; }
    if (!this.data.mineCount) { util.toast('你的个人课表还是空的，先导入或添加'); return; }
    this.setData({ minePublishShow: true, minePublishTarget: this._classSessionCount() });
  },
  onMinePublishClose() {
    if (this.data.minePublishing) return;
    this.setData({ minePublishShow: false });
  },
  onConfirmMinePublish() {
    const self = this;
    this.setData({ minePublishing: true });
    api.myTimetablePublish({}, { loading: '发布中' })
      .then((res) => {
        util.toast('已发布，全班课次 ' + ((res && res.created) || 0) + ' 条');
        self.setData({ minePublishing: false, minePublishShow: false });
        self.setData({ srcView: 'class' });
        self._courses = self._resolveCourses();
        self._build(self._courses);
      })
      .catch(() => self.setData({ minePublishing: false }));
  },

  /** 全班课次条数（发布确认弹层用） */
  _classSessionCount() {
    return (tt.sessionsOfWeek(this.data.week) || []).length;
  },

  onDetailClose() { this.setData({ detailShow: false }); },

  onEditCourse() {
    const d = this.data.detail;
    if (!d) return;
    // 调入是调课产生的临时显示，编辑会误改源课次 —— 让它回到真正的调课入口
    if (d.movedIn) { util.toast('这是「按天调课」产生的临时显示，请在「临时调课 → 按日期」里撤销'); return; }
    this.setData({ detailShow: false });
    this._openForm(d, d.dayOfWeek || 1, d.period || 1);
  },

  onDeleteCourse() {
    const d = this.data.detail;
    if (!d) return;
    if (d.movedIn) { util.toast('这是「按天调课」产生的临时显示，请在「临时调课 → 按日期」里撤销'); return; }
    util.confirm('删除后该课次未开始的值日也会移除', '删除课次').then(ok => {
      if (!ok) return;
      api.courseDelete({ sessionIds: [d.sessionId] }, { loading: '删除中' })
        .then(() => {
          tt.removeSession(d.sessionId);      // 同步本地课表，否则删掉了还显示
          util.toast('已删除');
          this.setData({ detailShow: false });
          this.load();
        })
        .catch(() => {});
    });
  },

  /* ---------------- 表单 P3.1 ---------------- */
  onFab() { this._openForm(null, 1, 1); },

  _openForm(cell, dayOfWeek, period) {
    let weeks = [];
    if (cell && cell.weeks) {
      weeks = typeof cell.weeks === 'string'
        ? cell.weeks.split(',').filter(Boolean).map(Number)
        : (cell.weeks || []);
    }
    this.setData({
      formShow: true,
      form: {
        sessionId: cell ? cell.sessionId : 0,
        name: cell ? cell.name : '',
        teacher: cell ? (cell.teacher || '') : '',
        room: cell ? (cell.room || '') : '',
        courseType: cell && cell.groupScope ? 'GROUP' : 'ALL',
        groupScope: (cell && cell.groupScope) || 'A',
        dayOfWeek,
        period,
        weeks,
        dutyCount: (cell && cell.dutyCount) || 2
      }
    });
    this._syncWeekBtns();
  },

  onFormClose() { this.setData({ formShow: false }); },

  onFormInput(e) {
    const f = String(e.currentTarget.dataset.field);
    this.setData({ ['form.' + f]: e.detail.value });
  },

  onFormChoose(e) {
    const f = String(e.currentTarget.dataset.field);
    this.setData({ ['form.' + f]: e.currentTarget.dataset.value });
  },

  /** segmented 组件 change 事件携带 detail.key（修复「分组」误置为 undefined） */
  onFormSegmented(e) {
    const f = String(e.currentTarget.dataset.field);
    this.setData({ ['form.' + f]: e.detail.key });
  },

  /** 上课周次多选：切换某周选中态 */
  onToggleWeek(e) {
    const wk = Number(e.currentTarget.dataset.week);
    const cur = (this.data.form && this.data.form.weeks) || [];
    const i = cur.indexOf(wk);
    const next = i >= 0 ? cur.slice(0, i).concat(cur.slice(i + 1)) : cur.concat([wk]);
    this.setData({ 'form.weeks': next });
    this._syncWeekBtns();
  },

  onStepper(e) {
    this.setData({ 'form.dutyCount': Number(e.detail.value) });
  },

  /** 服务端返回真实 sessionId 后，把同一份改动写进本地课表 */
  _saveLocal(f, sessionId) {
    const cid = (f && f.localCourseId) || 0;
    tt.upsertSession({
      id: Number(sessionId),
      cid: cid,
      name: String(f.name || '').trim(),
      teacher: String(f.teacher || '').trim(),
      room: String(f.room || '').trim(),
      day: Number(f.dayOfWeek),
      period: Number(f.period),
      group: f.courseType === 'GROUP' ? (f.groupScope === 'B' ? 'B' : 'A') : null,
      weeks: (f.weeks || []).slice().sort((a, b) => a - b).join(',')
    });
    this.load();
  },

  _payloadOf(f) {
    return {
      sessionId: f.sessionId || 0,
      course: {
        name: f.name, teacher: f.teacher, room: f.room,
        courseType: f.courseType,
        groupScope: f.groupScope,
        weeks: (f.weeks || []),
        dayOfWeek: Number(f.dayOfWeek),
        period: Number(f.period),
        dutyCount: Number(f.dutyCount)
      }
    };
  },

  onSave() {
    const f = this.data.form;
    if (!f) return;
    if (!String(f.name || '').trim()) { util.toast('请填写课程名'); return; }
    if (this.data.saving) return;
    // 编辑已有课次时保留原 courseId，避免本地配色跳变
    if (f.sessionId) {
      const old = tt.sessions().find(s => Number(s.id) === Number(f.sessionId));
      f.localCourseId = old ? old.cid : 0;
    }
    this.setData({ saving: true });
    api.courseUpsert(this._payloadOf(f), { toast: false })
      .then((r) => {
        this.setData({ saving: false, formShow: false });
        this._saveLocal(f, (r && r.sessionId) || f.sessionId);
        util.toast('已保存');
      })
      .catch((e) => {
        this.setData({ saving: false });
        if (e && e.errCode === 50010) {
          wx.showModal({
            title: '时间冲突',
            content: '该时间已有《' + ((e.data && e.data.conflictName) || '其他课程') + '》',
            confirmText: '覆盖',
            cancelText: '换个时间',
            confirmColor: '#3370FF',
            success: (r) => {
              if (!r.confirm) return;
              this.setData({ saving: true });
              const p = this._payloadOf(f);
              p.force = true;
              api.courseUpsert(p, { toast: false })
                .then((r) => {
                  this.setData({ saving: false, formShow: false });
                  this._saveLocal(f, (r && r.sessionId) || f.sessionId);
                  util.toast('已覆盖保存');
                })
                .catch(() => this.setData({ saving: false }));
            }
          });
        }
      });
  },

  /* ---------------- 青果课表导入 / 申请适配（需求 D-2） ---------------- */
  /**
   * 选 .xlsx → 上传云存储 → 返回 fileID
   *
   * ⚠️ 2026-10-05 真机踩坑（用户报「网络异常，请稍后重试」+ `[guard] showLoading 超过 20000ms`）：
   *   1. **上传阶段原先没有任何 loading / 超时** ⇒ 挂在 `wx.cloud.uploadFile` 上时
   *      界面看起来像「卡死」，20 秒后被 app.js 的看门狗强制收起。
   *   2. **上传失败的真实原因被吃掉了**：`wx.cloud.uploadFile` 的 errMsg 形如
   *      `uploadFile:fail ...`（含 'fail'），页面原先只 toast 一句笼统的「网络异常」，
   *      排查时完全看不到真因。现在改成把 errMsg 原样透出。
   *   3. ⚠️ `wx.chooseMessageFile` 给的 `f.path` 是**微信临时文件路径**，在部分机型 /
   *      开发者工具上直接喂给 `wx.cloud.uploadFile` 会失败 —— 所以失败提示里要带上
   *      「换个文件 / 重试」的可操作指引，而不是让用户干等。
   */
  _pickTimetableFile() {
    return new Promise((resolve, reject) => {
      if (!wx.chooseMessageFile) { reject(new Error('当前微信版本不支持选择文件')); return; }
      wx.chooseMessageFile({
        count: 1,
        type: 'file',
        success: (res) => {
          const f = (res.tempFiles || [])[0];
          if (!f) { reject(new Error('没有读到所选文件')); return; }
          const name = f.name || 'timetable.xlsx';
          const ext = String(name.split('.').pop() || '').toLowerCase();
          if (ext !== 'xlsx') {
            reject(new Error('请选择青果导出的 .xlsx 文件（旧版 .xls 请在 Excel / WPS 中另存为 .xlsx）'));
            return;
          }
          const cloudPath = 'timetable/' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.xlsx';
          // ⚠️⚠️ 2026-10-05 23:2x 真因定位：**base64 直传，不要走云存储上传**。
          //   云函数在 VPC 内 `cloud.downloadFile` 极慢（20 秒打不完 ⇒ 客户端
          //   errCode -504005 "invoking task timed out after 20 seconds"）。
          //   `pages/classes` 的名单导入**早就踩过并绕过了**（那里注释写着
          //   「跳过云函数在 VPC 内回下载云存储那一步（极慢）」）—— 本功能当时没沿用。
          //   课表 .xlsx 一般几十 KB，base64 直传完全够；大文件才回落云存储。
          const size = Number(f.size || 0);
          if (size > 900 * 1024) { this._uploadToCloud(cloudPath, f.path, resolve, reject); return; }
          wx.showLoading({ title: '读取中', mask: true });
          wx.getFileSystemManager().readFile({
            filePath: f.path,
            encoding: 'base64',
            success: (res) => {
              wx.hideLoading();
              resolve({ base64: res.data, name: name, size: size });
            },
            fail: (err) => {
              // 读不到就回落云存储上传（保持能用的兜底）
              console.warn('[timetable] readFile base64 失败，回落云存储', err);
              this._uploadToCloud(cloudPath, f.path, resolve, reject);
            }
          });
        },
        fail: (err) => {
          const raw = String((err && err.errMsg) || '');
          if (raw.indexOf('cancel') >= 0) return;   // 用户主动取消：不报错
          reject(new Error(raw || '选择文件失败'));
        }
      });
    });
  },

  /** 兜底：大文件才走云存储上传（函数端仍支持 fileId 下载，但 VPC 内很慢，尽量别走到） */
  _uploadToCloud(cloudPath, filePath, resolve, reject) {
    wx.showLoading({ title: '上传中', mask: true });
    req.uploadFile(cloudPath, filePath)
      .then((fileID) => {
        wx.hideLoading();
        this.setData({ diagFileID: fileID || '' });
        resolve({ fileID: fileID, name: '', size: 0 });
      })
      .catch((e) => {
        wx.hideLoading();
        // 原样透出云存储的 errMsg（含 fail / 权限 / 网络等原因），别再吞成「网络异常」
        const raw = (e && (e.errMsg || e.message)) || '';
        console.error('[timetable] uploadFile failed', raw, e);
        reject(new Error(raw || '文件上传失败，请重试或换一个文件'));
      });
  },

  /* ---------- 组别选择（导入 / 申请适配 共用，2026-10-05） ---------- */
  /** 打开组别选择弹层。mode: 'import' 直接导入 | 'apply' 申请适配 */
  _openGroupSheet(mode) {
    this.setData({ groupSheetShow: true, groupPending: mode });
  },
  onGroupSheetClose() { this.setData({ groupSheetShow: false, groupPending: '' }); },
  /** 选定组别 → 关弹层 → 接着选文件（组别必填 A / B，没有「全体课」选项） */
  onGroupPick(e) {
    const g = String((e.currentTarget.dataset.g) || '').toUpperCase();
    if (g !== 'A' && g !== 'B') { util.toast('请选择 A 组或 B 组'); return; }
    const mode = this.data.groupPending;
    this.setData({ importGroup: g, groupSheetShow: false, groupPending: '' });
    if (mode === 'apply') this._doApply(g);
    else this._doImport(g);
  },

  /** 生活委员 / 超管：直接导入本班课表（先选组别 → 选文件 → 预览 → 确认） */
  onImportTap() {
    if (this.data.importBusy) return;
    if (!this.data.canSchedule) { util.toast('只有超管或本班生活委员可以导入课表'); return; }
    this._openGroupSheet('import');
  },

  /** 真正执行导入（已确定组别） */
  _doImport(group) {
    this._pickTimetableFile()
      .then((picked) => {
        if (!picked) return null;
        // ⚠️ 基底优先（base64 直传），fileID 只是大文件兜底 —— 云函数在 VPC 内回下载云存储极慢
        const payload = { base64: picked.base64 || '', fileID: picked.fileID || '', group: picked.group || group, commit: false };
        this.setData({
          importBusy: true,
          importFileID: payload.fileID,
          importFileBase64: payload.base64,   // 确认提交时复用，不用再读一次文件
          importFileGroup: payload.group
        });
        // ⚠️ 这里必须用 request 层的 loading（opt.loading）而不是自己 wx.showLoading：
        //    只有前者，request.js 才会在 success/fail 两条路径都 hideLoading
        //    （原先自己 show + {toast:false}，fail 分支不关 ⇒ 遮罩残留到 20s 看门狗兜底）
        return api.importTimetable(payload, { toast: false, loading: '解析中' });
      })
      .then((r) => {
        wx.hideLoading();   // 兜底：fileID 为空时可能没走过 request 的 loading
        this.setData({ importBusy: false, importShow: true, importPreview: r || null });
      })
      .catch((e) => {
        wx.hideLoading();
        this.setData({ importBusy: false });
        util.toast((e && e.errMsg) || (e && e.message) || '文件解析失败，请确认是青果导出的 .xlsx');
      });
  },

  onImportClose() {
    this.setData({ importShow: false, importPreview: null, importFileID: '', importFileBase64: '', importFileGroup: '' });
  },

  onConfirmImport() {
    const preview = this.data.importPreview;
    // ⚠️ 复用预览时已读好的 base64 / fileID，别再读一次文件（base64 留着即可）
    const base64 = this.data.importFileBase64;
    const fileID = this.data.importFileID;
    if (!preview || (!base64 && !fileID) || this.data.importBusy) return;
    const group = this.data.importFileGroup || this.data.importGroup;
    this.setData({ importBusy: true });
    api.importTimetable({ base64: base64, fileID: fileID, group: group, commit: true }, { loading: '导入中' })
      .then((r) => {
        this.setData({
          importBusy: false, importShow: false, importPreview: null,
          importFileID: '', importFileBase64: '', importFileGroup: ''
        });
        const courses = r && r.courses != null ? r.courses : preview.courseCount;
        const sessions = r && r.imported != null ? r.imported : preview.sessionCount;
        const reset = r && r.resetPublish ? '\n（已发布周已退回草稿，请重新发布值日）' : '';
        // 把「已自动合并为全体课」的提醒也带上（后端在两重合同时才会出现）
        const shared = (r && r.warnings || []).filter((w) => String(w).indexOf('全体课') >= 0).join('；');
        const sharedLine = shared ? ('\n（' + shared + '）') : '';
        wx.showModal({
          title: '导入成功',
          content: '已导入「' + group + ' 组」' + courses + ' 门课程、' + sessions + ' 节课次。'
            + (group === 'A' ? 'B 组课次不受影响。' : 'A 组课次不受影响。')
            + sharedLine + reset,
          showCancel: false, confirmColor: '#3370FF'
        });
      })
      .catch((e) => {
        this.setData({ importBusy: false });
        util.toast((e && e.errMsg) || (e && e.message) || '导入失败');
      });
  },

  /** 普通成员：提交适配申请（先选组别 → 选文件 → 提交，超管后续适配） */
  onApplyTap() {
    if (this.data.importBusy) return;
    this._openGroupSheet('apply');
  },

  /** 真正执行提交申请（已确定组别） */
  _doApply(group) {
    this._pickTimetableFile()
      .then((picked) => {
        if (!picked) return null;
        this.setData({ importBusy: true });
        // ⚠️ 同导入：base64 直传优先（云函数在 VPC 内回下载云存储极慢）
        return api.applyTimetable({
          base64: picked.base64 || '', fileID: picked.fileID || '', group: group
        }, { loading: '提交中' });
      })
      .then((r) => {
        wx.hideLoading();
        this.setData({ importBusy: false });
        const warns = r && r.summary && r.summary.warnings && r.summary.warnings.length
          ? ('\n（解析提醒：' + r.summary.warnings.join('；') + '）') : '';
        wx.showModal({
          title: '已提交',
          content: '「' + group + ' 组」课表文件已提交给超管，适配完成后会在此显示。' + warns,
          showCancel: false, confirmColor: '#3370FF'
        });
      })
      .catch((e) => {
        wx.hideLoading();
        this.setData({ importBusy: false });
        if (e && e.errCode === 41010) { util.toast('本班该组已有待处理的适配申请'); return; }
        util.toast((e && e.errMsg) || (e && e.message) || '提交失败');
      });
  },

  /** 超管：进入「课表适配申请」列表页 */
  onApplyListTap() { wx.navigateTo({ url: '/pages/timetable-apply/index' }); },

  /**
   * 🔍 临时自诊断（2026-10-05 排查「网络异常 / -504005」）：调 course 的 diag action，
   * 把「建池 / 查 member / 查 class / 连测3次 / 解析」各步耗时**直接显示出来**。
   * ⚠️ 为什么需要它：本机拉不到云函数日志（环境未开通 CLS，`tcb fn log` 报 topic not exist），
   *    只能让后端把耗时算好 return 回来。定位完成后删掉这个 handler + wxml 按钮 +
   *    api.courseDiag + course 的 diag action。
   */
  onDiagTap() {
    wx.showLoading({ title: '诊断中', mask: true });
    // ⚠️ 带上最近一次上传的 fileID（若有），这样能连「下载 + 解析」一起量到
    const fid = this.data.diagFileID || this.data.importFileID || '';
    api.courseDiag({ fileID: fid }, { loading: false, toast: false })
      .then((r) => {
        wx.hideLoading();
        const steps = (r && r.steps) || [];
        const lines = steps.map((s) => s.step + ' ' + s.ms + 'ms' + (s.info ? ' (' + s.info + ')' : '')).join('\n');
        wx.showModal({
          title: '各阶段耗时' + (fid ? '' : '（无文件）'),
          content: lines || '（无数据）',
          showCancel: false, confirmColor: '#3370FF'
        });
      })
      .catch((e) => {
        wx.hideLoading();
        util.toast((e && e.errMsg) || (e && e.message) || '诊断失败');
      });
  },

  onReload() { this.load() },
  noop() {}
});
