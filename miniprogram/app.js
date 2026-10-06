/**
 * 小程序入口：云开发初始化 + openid 无感登录 + 全局布局常量
 */
const req = require('./utils/request');
const api = require('./utils/api');
const mem = require('./utils/mem');
const notice = require('./utils/notice');

const ENV_ID = require('./utils/config').ENV_ID;

/**
 * 回前台重新核对身份的节流窗口（v0.7.17 需求④）。
 * 切前后台很频繁，而身份失效（被超管解绑）是低频事件 —— 20s 内不重复校验。
 */
const AUTH_RECHECK_MS = 20000;

/**
 * 身份缓存（v0.7.32 问题①）
 * ------------------------------------------------------------
 * 过去 `profile` 只在内存（globalData），冷启动首屏必为 null —— 于是「身份门控」的卡片
 * （首页「本班请假」`showLeaveHome`、管理卡 `isAdmin`、我的页管理卡…）首帧**不在 DOM 里**，
 * 要等 auth 回来才被创建 ⇒ Tab 入场动画早已播完，它们才「独自冒出来」。
 * 现在登录成功后把 member 落一份 storage，启动时**同步**读出来先占位：卡片首帧就在 DOM 里，
 * 跟着入场动画一起出现；auth 回来后再用真身覆盖（数值上等价，只是时序提前）。
 * ⚠️ 解绑 / 身份失效（_handleUnbound）必须清掉，绝不能让人看到上一位成员的身份。
 */
const PROFILE_CACHE_KEY = 'profileCache';
/** 读缓存：{ profile, switched }（switched = 模拟态，见 utils/impersonate.js） */
function readCachedAuth() {
  try {
    const v = wx.getStorageSync(PROFILE_CACHE_KEY);
    return (v && typeof v === 'object' && v.profile) ? v : null;
  } catch (e) { return null; }
}
function writeCachedAuth(profile, switched) {
  try {
    if (profile) wx.setStorageSync(PROFILE_CACHE_KEY, { profile: profile, switched: !!switched });
    else wx.removeStorageSync(PROFILE_CACHE_KEY);
  } catch (e) { /* 缓存失败不影响主流程 */ }
}

App({
  globalData: {
    envId: ENV_ID,
    /* 布局常量（px） */
    statusBarHeight: 20,
    navBarHeight: 44,
    tabBarHeight: 50,
    safeBottom: 0,
    /* 底栏底部兜底留白(px) —— 1.0.5 需求①「安卓底栏贴着屏幕底」：
       底栏 `.tabbar-wrap` 的 padding-bottom 取 `max(safeBottom, tabbarLiftPx)`。
       iPhone(safeBottom≈34) 取安全区 ⇒ 完全不动；安卓(0) 兜底到 32 ⇒ 与 iPhone 观感一致。
       ⚠️ 唯一数值来源：custom-tab-bar/index.js 的 TABBAR_LIFT_PX 必须与本值相等
          （check-tabbar-liquid 守）；改这里要一并同步 sheetMetrics 的 tabbarPx 与
          4 处 `calc(…rpx + max(env(safe-area-inset-bottom), 32px))` 让位值。 */
    tabbarLiftPx: 32,
    windowWidth: 375,
    windowHeight: 812,
    /* 身份 */
    openid: '',
    bound: false,
    profile: null,   // { id, name, role, groupTag, studentNoMasked, status }
    config: null,    // { name, termStart, totalWeeks, periodTime, currentWeek }
    /* 启动参数 */
    launchOptions: null,
    scene: '',       // 扫码邀请码 scene
    /* 状态 */
    authChecked: false,
    authError: '',
    /* 换班脏标记（1.0.4.4 #28）：在「我的」页同意/拒绝/撤销换班后置位，
       值日页 / 首页 / 我的 三处 onShow 检测后强制重拉并清标记，
       修复「换班同意后值日表不更新、须重进小程序才更新」的 bug。 */
    dutyDirty: false
  },

  onLaunch(options) {
    this.globalData.launchOptions = options || {};
    // v0.7.32：先用**上次身份**同步占位（不等 auth）—— 身份门控的卡片才能在首帧就参与入场动画。
    // ⚠️ 模拟态标记（switched）必须一并还原：impersonate 横幅据此渲染，否则会出现
    //    「以别人身份显示、却还没有护栏」的窗口。auth 回来后 _bootstrap 用真身覆盖。
    const cached = readCachedAuth();
    if (cached) {
      this.globalData.profile = cached.profile || null;
      this.globalData.switched = !!cached.switched;
    }
    this._initSystemInfo();
    this._pickScene(options);
    this._installLoadingGuard();
    this._checkUpdate();
    req.cloudInit();
    this._watchUnbound();
    this._ready = this._bootstrap(options);
  },

  /**
   * 身份失效 → 立刻回绑定页（v0.7.17 需求④）
   * ------------------------------------------------------------
   * `request.js` 收到 40001 / 40002（未绑定 / 身份无效）时会 `emit('needBind')`，
   * 但此前**一个监听者都没有** —— 事件发出去就没了。后果是：被解绑的那台设备上，
   * 首页自己 catch 到 40001 画出了「未绑定」，而「我的」读的仍是 globalData 里的旧
   * profile、照旧显示原账号；整机只有**杀掉小程序重进**才会走到绑定页。
   * 这里补上监听：任何一次云调用发现「你已经不是绑定态」，就清身份 + 回绑定页。
   */
  _watchUnbound() {
    req.on('needBind', () => this._handleUnbound());
  },

  /**
   * 清身份与本地缓存，回绑定页。
   * 缓存必须一起清：解绑后换个人绑定，绝不能让他看到上一位成员的首页/值日/通知缓存。
   */
  _handleUnbound() {
    const g = this.globalData;
    if (g._unbinding) return;      // 一次失效会引发多个并发请求各报一次 40001
    g._unbinding = true;
    g.bound = false;
    g.profile = null;
    g.switched = false;
    g.authChecked = true;
    writeCachedAuth(null, false);      // v0.7.32：身份缓存必须一起清，绝不能留上一位成员
    try { mem.clear(); } catch (e) {}
    try { notice.invalidate(); } catch (e) {}
    this._goBind();
    setTimeout(() => { g._unbinding = false; }, 1500);
  },

  /**
   * 遮罩看门狗
   * ------------------------------------------------------------
   * `wx.showLoading({ mask: true })` 是全屏原生遮罩，会吞掉**所有**点击，
   * 包括底部自定义 tabBar。只要有一处漏调 hideLoading（或回调永远不触发，
   * 比如 canvasToTempFilePath 在开发者工具里静默失败），整个小程序就再也点不动，
   * 表现为「tabBar 点了没反应」。
   *
   * 这里接管原生 API：超时强制收起，保证界面永远不会被遮罩锁死。
   */
  _installLoadingGuard() {
    try {
      const GUARD_MS = 20000;
      const rawShow = wx.showLoading && wx.showLoading.bind(wx);
      const rawHide = wx.hideLoading && wx.hideLoading.bind(wx);
      if (!rawShow) return;
      let timer = null;
      const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
      wx.showLoading = (o) => {
        clear();
        timer = setTimeout(() => {
          timer = null;
          console.warn('[guard] showLoading 超过 ' + GUARD_MS + 'ms 未关闭，已强制收起');
          if (rawHide) rawHide();
        }, GUARD_MS);
        return rawShow(Object.assign({}, o || {}));
      };
      wx.hideLoading = (o) => { clear(); return rawHide ? rawHide(o) : undefined; };
    } catch (e) {
      console.warn('[guard] 遮罩看门狗未启用', e);
    }
  },

  /**
   * 新版本检测（v1.0.5 前置能力）
   * ------------------------------------------------------------
   * 微信的包更新机制：只有**冷启动**才检查新版本 → 后台静默下载 → 本次仍跑旧包 →
   * 下一次冷启动才切到新包。不接 getUpdateManager 时用户全程无感知，表现为
   * 「线上已发布，打开还是旧版」。这里补上官方唯一手段：
   * onUpdateReady → 弹「立即重启」（showCancel:false，官方允许范围内最强制）→
   * applyUpdate() 立刻用新包重启，跳过「等下一次冷启动」。
   *
   * onLaunch / onShow 都会调本函数（热启动也尽早触发下载），但：
   *   · 回调只绑一次（_umBound），否则 onUpdateReady 会弹多次窗；
   *   · checkForUpdate 主动检查按 60s 节流，避免每次切前台都打一次微信接口。
   * 开发者工具测不出来（onUpdateReady 不触发），真机验证：自定义编译勾选
   * 「下次编译时模拟更新」。
   */
  _checkUpdate() {
    if (typeof wx.getUpdateManager !== 'function') return;   // 基础库 < 1.9.90
    const um = wx.getUpdateManager();
    if (!this._umBound) {
      this._umBound = true;
      um.onUpdateReady(() => {
        wx.showModal({
          title: '版本更新',
          content: '新版本已就绪，需要重启小程序才能生效。',
          showCancel: false,
          confirmText: '立即重启',
          success: () => um.applyUpdate()
        });
      });
      um.onUpdateFailed(() => {
        wx.showModal({
          title: '更新失败',
          content: '新版本下载失败，请删除小程序后重新搜索打开。',
          showCancel: false
        });
      });
    }
    const now = Date.now();
    if (this._lastUpdCheck && now - this._lastUpdCheck < 60000) return;
    this._lastUpdCheck = now;
    try { um.checkForUpdate(); } catch (e) {}
  },

  onShow(options) {
    if (options && options.query && options.query.scene) {
      this._pickScene(options);
    }
    this._recheckAuth();
    this._checkUpdate();
  },

  /**
   * 回前台时重新核对身份（v0.7.17 需求④）
   * ------------------------------------------------------------
   * 「被超管解绑」只发生在服务端，而**课表页是 100% 本地渲染、一次云调用都不发** ——
   * 只靠 needBind 事件会漏掉它：用户停在课表上被解绑，回前台什么也不会发生。
   * 所以每次回前台补一次 auth.login（20s 节流）：未绑定就地清身份 + 回绑定页。
   * 首次启动不归这里管（authChecked 还是 false，由 onLaunch 的 _bootstrap 负责）。
   */
  /**
   * 节流式身份重校（**唯一实现**）：App.onShow（回前台）调它；四个 tab 页调下面同名的
   * `recheckAuth()` 薄封装（要它的返回值）。
   * v0.7.32 问题②：过去只在回前台时重校 ⇒「超管把某同学设为班委」后，那位同学只要
   * **不杀进程、也不回前台**，他的手机就永远看不到班委专属按钮。现在页面 onShow 也会调。
   * @returns {Promise<boolean>} 本次是否真的重校了、且身份发生了变化
   */
  _recheckAuth() {
    const g = this.globalData;
    if (!g.authChecked || g._unbinding) return Promise.resolve(false);
    const now = Date.now();
    if (g._authChecking) return Promise.resolve(false);
    if (g._lastAuthCheck && now - g._lastAuthCheck < AUTH_RECHECK_MS) return Promise.resolve(false);
    g._authChecking = true;
    g._lastAuthCheck = now;      // 先占位：嵌套调用会被节流挡掉，不会打转
    const before = this._identitySig();
    return this.refreshAuth()
      .then(() => {
        if (!g.bound) this._handleUnbound();
        return this._identitySig() !== before;
      })
      .catch(() => false)
      .then((changed) => { g._authChecking = false; return changed; });
  },

  /** 页面 onShow 用：与 `_recheckAuth()` 同一实现（名字面向页面，语义即「重校身份」） */
  recheckAuth() {
    return this._recheckAuth();
  },

  /** 身份指纹（重校前后比对用）：任一维度变了就当「身份变了」 */
  _identitySig() {
    const g = this.globalData;
    const p = g.profile || {};
    return [p.id || 0, p.role || '', p.position || '', p.groupTag || '', p.classId || 0, g.switched ? 1 : 0].join('/');
  },

  onError(err) {
    console.error('[app] onError', err);
  },

  /* ---------- 系统信息 ---------- */
  _initSystemInfo() {
    let win = null;
    try {
      if (wx.getWindowInfo) win = wx.getWindowInfo();
      else win = wx.getSystemInfoSync();
    } catch (e) {
      win = {};
    }
    const g = this.globalData;
    g.statusBarHeight = win.statusBarHeight || 20;
    g.windowWidth = win.windowWidth || 375;
    g.windowHeight = win.windowHeight || 812;
    const safeBottom = (win.safeArea && win.screenHeight)
      ? Math.max(0, win.screenHeight - win.safeArea.bottom)
      : (win.safeAreaInsets ? win.safeAreaInsets.bottom : 0);
    g.safeBottom = safeBottom || 0;
  },

  _pickScene(options) {
    const q = (options && options.query) || {};
    if (q.scene) {
      try { this.globalData.scene = decodeURIComponent(q.scene); }
      catch (e) { this.globalData.scene = String(q.scene); }
    }
  },

  /**
   * 导航度量（惰性计算 + 全局缓存）
   * ------------------------------------------------------------
   * `nav-bar` / `bottom-sheet` 都要用「状态栏高度」「胶囊按钮左边界」「窗口宽度」。
   * 这些值在**整个 App 生命周期内不会变**，但每个组件实例的 `attached` 都去调
   * `wx.getMenuButtonBoundingClientRect()` / `wx.getWindowInfo()` —— 那是**同步跨线程调用**，
   * 回调里还要 `setData` 一次触发二次渲染。于是每打开一个二级页就白付一次同步 IPC，
   * 表现为「点进去先卡一下」。改为在这里算一次、存 `globalData`，组件只读缓存。
   *
   * ⚠️ 胶囊位置只在**窗口真正布局好之后**才拿得到，过早调用会返回全 0。
   * 所以**只有拿到有效值（mb.left > 0）才写缓存**，否则不缓存、下次再试 ——
   * 避免把一个「0」锁死一整个生命周期。
   */
  navMetrics() {
    const g = this.globalData;
    if (g._navMetrics) return g._navMetrics;
    const statusBarHeight = g.statusBarHeight || 20;
    let padRight = 0;
    let valid = false;
    try {
      const mb = (typeof wx.getMenuButtonBoundingClientRect === 'function')
        ? wx.getMenuButtonBoundingClientRect() : null;
      if (mb && mb.left > 0 && g.windowWidth) {
        // 胶囊按钮避让：右侧插槽内容左移出胶囊区域（+2px 视觉间隙）
        padRight = Math.round(g.windowWidth - mb.left) + 2;
        valid = true;
      }
    } catch (e) {
      padRight = 0;
    }
    const m = { statusBarHeight, padRight };
    if (valid) g._navMetrics = m;
    return m;
  },

  /** 弹层度量：安全区底部（px）+ 自定义 tabBar 高度（px，98rpx 换算 =
   *  悬浮胶囊高 92rpx + 底部留白 6rpx；v0.7.14 第 6 轮底栏「整体缩小一号」后 112→98） */
  sheetMetrics() {
    const g = this.globalData;
    if (g._sheetMetrics) return g._sheetMetrics;
    /* 胶囊安全上限（1.0.4.4）：面板顶沿不得钻进右上角胶囊底下 ——
     * max-height = 100vh - (胶囊底沿 + 12px)。tall 档（92vh）顶沿 8vh、固定 height
     * 的大面板（AI 生成 1280 / 加值日生 1240 / 导入 1180rpx）在小屏机型上都会撞，
     * 所以统一在 bottom-sheet 上套这条 inline 上限；取不到胶囊信息时留空，
     * 回退到组件 wxss 的原档位（78vh / 92vh）。 */
    let sheetCapStyle = '';
    try {
      if (typeof wx !== 'undefined' && wx.getMenuButtonBoundingClientRect) {
        const rect = wx.getMenuButtonBoundingClientRect();
        if (rect && rect.bottom > 0) {
          sheetCapStyle = 'max-height:calc(100vh - ' + Math.round(rect.bottom + 12) + 'px);';
        }
      }
    } catch (e) { sheetCapStyle = ''; }
    g._sheetMetrics = {
      safeBottom: g.safeBottom || 0,
      /* 弹层 body 的底部让位（px）：占位 98rpx + **无安全区时的兜底留白**。
         与底栏实际离屏底的距离保持一致（iPhone 由 safeBottom 覆盖，故不再叠加 lift）。 */
      tabbarPx: Math.round(98 * (g.windowWidth || 375) / 750) + ((g.safeBottom > 0) ? 0 : (g.tabbarLiftPx || 0)),
      sheetCapStyle
    };
    return g._sheetMetrics;
  },

  /* ---------- 无感登录 ---------- */
  async _bootstrap(options) {
    const g = this.globalData;
    try {
      const r = await api.login();
      g.bound = !!(r && r.bound);
      g.profile = r && r.member ? r.member : null;
      g.config = r && r.config ? r.config : null;
      g.switched = !!(r && r.switched);   // 超管「切换测试账号」模拟态
      g.authChecked = true;
      writeCachedAuth(g.profile, g.switched);   // v0.7.32：落身份缓存（未绑定 → null 即清除）
      if (!g.bound) {
        this._goBind();
      } else {
        this._prefetchTabs();
      }
      return g;
    } catch (e) {
      console.error('[app] login failed', e);
      g.authChecked = true;
      g.authError = (e && e.errMsg) || '登录失败';
      // 云环境不可用时也进入绑定页，避免白屏
      if (e && (e.errCode === 40001 || e.errCode === 40002)) this._goBind();
      return g;
    }
  },

  /**
   * 后台预热其余 Tab 的数据
   * ------------------------------------------------------------
   * 「首次打开小程序，底部选项切换会很慢」的主体是**云函数冷启动**：每个 Tab 页的
   * 首屏都在等自己的那次调用，而首次启动时它们全是冷的（各要 1~3 秒）。
   *
   * 四个 Tab 里只有**值日页**需要预热：
   *   · 课表 = 100% 本地渲染（不联网，无需预热）；
   *   · 我的 = 页面本身是静态的（无骨架），角标走 notice 缓存；
   *   · 首页 = 落地页，自己会立刻拉。
   * 所以这里只预热值日页那一次 schedule.listWeek，写进内存缓存；等用户真的点到
   * 值日页时，函数已经热了、内容也已经在了 —— 不再有那几秒的骨架屏。
   *
   * 失败一律吞掉：预热是纯优化，绝不能影响启动。
   */
  _prefetchTabs() {
    try {
      const week = (this.globalData.config && this.globalData.config.currentWeek) || 1;
      const key = mem.keys.duty(week);
      if (!mem.read(key)) {
        api.scheduleListWeek({ week }, { toast: false })
          .then((r) => { mem.write(key, r); })
          .catch(() => {});
      }
      // 预热通知列表：让「首页 → 查看通知」一进去就有内容，连 media 冷启动都不用等
      // （解决「点击通知到打开通知页很慢」：首屏直接渲染缓存，后台静默刷新）。
      if (!notice.read(0)) {
        api.msgList({}, { toast: false })
          .then((list) => { notice.write(list); })
          .catch(() => {});
      }
    } catch (e) {
      console.warn('[app] 预热跳过', e);
    }
  },

  _goBind() {
    // 延迟一帧，确保首个 tabBar 页面已完成初始渲染，避免 reLaunch 抖动
    setTimeout(() => {
      const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
      const cur = pages.length ? pages[pages.length - 1] : null;
      if (cur && cur.route === 'pages/bind/index') return;
      wx.reLaunch({ url: '/pages/bind/index' });
    }, 0);
  },

  /** 页面/组件可 await 的登录就绪 Promise */
  ready() {
    return this._ready || Promise.resolve(this.globalData);
  },

  /** 绑定成功后刷新身份 */
  async refreshAuth() {
    const g = this.globalData;
    const r = await api.login();
    g.bound = !!(r && r.bound);
    g.profile = r && r.member ? r.member : null;
    g.config = r && r.config ? r.config : null;
    g.switched = !!(r && r.switched);
    writeCachedAuth(g.profile, g.switched);   // v0.7.32：切换测试账号 / 恢复本人 后同步身份缓存
    return g;
  },

  /**
   * tabBar 选中态同步（自定义 tabBar 必须手动设置）
   * ------------------------------------------------------------
   * ⚠️ 不能用 `this.getTabBar()` —— `getTabBar` 是**页面**实例上的方法，App 实例上没有，
   * 所以那样写 `typeof this.getTabBar === 'function'` 恒为 false，整个函数**静默空转**
   * （这正是以前各页宁可内联写 `this.getTabBar().setData({active})` 的原因）。
   * 正确姿势：从 `getCurrentPages()` 取当前页，再问它要 tabBar —— 那才是屏幕上这一个。
   */
  setTabBar(index) {
    this.globalData.tabIndex = index;
    const pages = (typeof getCurrentPages === 'function' && getCurrentPages()) || [];
    const cur = pages.length ? pages[pages.length - 1] : null;
    if (!cur || typeof cur.getTabBar !== 'function') return;
    const tb = cur.getTabBar();
    if (!tb) return;
    /*
     * ⚠️ 这里**不能**用「active 已相等就跳过」当守卫。
     * 点击时 tabBar 会把 active **乐观预置**成目标格（见 custom-tab-bar/index.js），
     * 于是目标页实例的 active 早在 click 那一刻就等于 index 了 —— 老守卫会直接
     * return，`syncActive` 永远收不到「跨页指示器交接」，指示器只能瞬移到目标格
     * （2026-09-26 用户反馈：「从首页直接点我的，动画就直接消失了，蓝色遮罩变成
     * 瞬间出现在选择的页面位置」）。
     * 去重的职责下沉到组件 `syncActive` 内部（它自己判重，重复值不产生多余渲染）。
     */
    if (typeof tb.syncActive === 'function') tb.syncActive(index);
    else tb.setData({ active: index });
  },

  isAdmin() {
    const p = this.globalData.profile;
    return !!(p && (p.role === 'ADMIN' || p.role === 'MONITOR'));
  },

  /** 超级管理员：role=ADMIN 且 isSuper=true（最高权限：解绑账号、安排值日） */
  isSuper() {
    const p = this.globalData.profile;
    return !!(p && p.role === 'ADMIN' && p.isSuper);
  },

  /**
   * 学生班委（超管亦属）：role ∈ {ADMIN, MONITOR} 且非教职工（group_tag <> 'X'）。
   * 与后端 guard.isCommittee 同口径；前端只决定「入口显不显示」，真正拦截在云函数侧。
   */
  isCommittee() {
    const p = this.globalData.profile;
    return !!(p && p.group_tag !== 'X' && (p.role === 'ADMIN' || p.role === 'MONITOR'));
  },

  /*
   * 需求 D：权限下放 —— 入口可见性三问。
   * 后端 auth.login 已用 common/guard.js 统一算好并下发（canSchedule / canRosterEdit /
   * canGrantPosition），前端**不再自己比对 position 字面量** —— 判定式散落两处必然漂移。
   * ⚠️ 这三个只决定「入口显不显示」，**不是安全边界**：真正拦截一律在云函数侧
   * （前端可伪造）。后端返回缺字段（老客户端）时一律 false，表现为入口不显示，不会越权。
   */

  /** 排班域：超管（可跨班）或本班生活委员 */
  canSchedule() {
    const p = this.globalData.profile;
    return !!(p && p.canSchedule);
  },

  /** 名册录入（增改不含删）：超管 / 辅导员 / 本班班长 */
  canRosterEdit() {
    const p = this.globalData.profile;
    return !!(p && p.canRosterEdit);
  },

  /** 授予「生活委员 / 班长兼团支书」：仅超管 */
  canGrantPosition() {
    const p = this.globalData.profile;
    return !!(p && p.canGrantPosition);
  },

  /** 请假登记（1.0.5 需求④）：超管 / 本班**学生班委**（role ADMIN|MONITOR 且非教职工） */
  canLeave() {
    const p = this.globalData.profile;
    return !!(p && p.canLeave);
  }
});
