/**
 * P7 · 我的（Tab 4）+ 内联 P8 关于 / 我的申请
 * （成员与分组已迁出到独立页 pages/roster/index，由首页「成员与分组」入口进入）
 */
const api = require('../../utils/api');
const util = require('../../utils/util');
const subscribe = require('../../utils/subscribe');
const pageAnim = require('../../utils/page-anim');
const config = require('../../utils/config');
const impersonate = require('../../utils/impersonate');

/**
 * AI 排班常用接口预设（点一下即填好接口地址 + 一个默认模型名）。
 * 之后仍可用「获取」从服务商拉回**真实**模型列表覆盖默认。
 * base_url 走 OpenAI 兼容端点；默认模型名是各家的常用款，拿不准就以「获取」为准。
 */
const AI_PROVIDERS = {
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  glm: { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  qwen: { label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-turbo' }
};

/** 数据新鲜度窗口：切换回「我的」时，只要在这个窗口内拉过数据，就直接复用、不再发起请求 */

const SWAP_STATUS = {
  PENDING_PEER: { text: '待对方确认', bg: '#FFF7E8', fg: '#FF7D00' },
  PENDING_ADMIN: { text: '待管理员确认', bg: '#F0F5FF', fg: '#3370FF' },
  DONE: { text: '已完成', bg: '#E8FFEA', fg: '#00B42A' },
  REJECTED: { text: '已拒绝', bg: '#FFECE8', fg: '#F53F3F' },
  CANCELLED: { text: '已撤销', bg: '#F2F3F5', fg: '#86909C' }
};
const REASON_TEXT = { COURSE: '有课冲突', SICK: '身体不适', INTERN: '实习外出', OTHER: '其他' };

Page({
  data: {
    statusBarHeight: 20,
    /** Tab 入场动画序号：0 = 还没进过（播完整版），之后在 1 / 2 之间轮换（轻量版），见 utils/page-anim.js */
    animSeq: 0,
    /** 入场动画就绪标记（v0.7.31）：false = 根节点挂 pa-hold（块透明），等首屏身份+数据就绪再统一开播 */
    paReady: false,
    loading: true,
    profile: null,
    isAdmin: false,
    isSuper: false,
    /**
     * 排班域能力位（需求 D）：超管 | 本班生活委员。
     * 单一来源是 `auth.login` 下发的 canSchedule（经 app.canSchedule() 读），
     * 前端**不自己比对 position 字面量** —— 判定式散落两处必然漂移。
     * 只决定入口显隐，**不是安全边界**（真拦截在云函数 guard.requireScheduleAuth）。
     */
    canSchedule: false,
    /* AI 排班设置（需求 D：自带密钥，跟随本人）。
       ⚠️ aiKey 只用于**输入**，永不回填服务端明文（接口只回掩码）。 */
    aiShow: false,
    aiBaseUrl: '',
    aiModel: '',
    aiKey: '',
    aiKeyMask: '',
    aiConfigured: false,
    aiBusy: false,
    aiTestResult: '',
    /** 当前选中的预设服务商（''=未选 / 自定义），用于高亮 */
    aiProvider: '',
    /** 「获取」拉回的可用模型列表（点击某条即填进 aiModel） */
    aiModels: [],
    isCounselor: false,
    /** 个人卡职位头衔（来自登录 profile.position；超管金 / 班委蓝 / 辅导员青） */
    selfTag: '',
    selfTier: '',
    /** 超管「切换测试账号」模拟态：true 时显示「恢复本人」入口 */
    switched: false,
    /** 「切换测试账号」模拟态顶部横幅（v1.0.5）：非空即渲染红色护栏条，内含「恢复本人」 */
    impersonateBanner: '',
    /** 班级绑定入口开关（仅超管可见可操作，防爆破自动锁死后在这里开回） */
    bindOpen: true,
    stats: null,
    remindOn: false,
    /** 微信提醒额度耗尽（后端 remind_block，cron 发送 43101 时置 1）→ 行尾换成「重新开启」 */
    remindBlock: false,
    calendarOn: false,

    appShow: false,
    apps: [],
    /** 超管：全班待确认的换班申请（成员提交 → 生活委员拍板） */
    pendingSwaps: [],
    pendingCount: 0,

    aboutShow: false,
    appVersion: config.APP_VERSION,
    swapStatusMap: SWAP_STATUS,
    reasonMap: REASON_TEXT,

    /* 发送更新公告（v0.7.25→改，仅超管）：版本号/标题自动，只填内容 */
    anncShow: false,
    anncContent: '',
    anncBusy: false,

    /* 值日明细（需求：「待值日 / 已结束」数字可点开查看具体条目） */
    dutyListShow: false,
    dutyListLoading: false,
    dutyListTitle: '',
    dutyList: []
  },

  onLoad() {
    const app = getApp();
    this.setData({ statusBarHeight: app.globalData.statusBarHeight || 20 });
  },

  onShow() {
    const app = getApp();
    app.setTabBar(3);
    // v0.7.31：不再立即播 —— 等「身份(app.ready) + 首屏数据(loading=false)」就绪、或 READY_MS 兜底超时再统一开播
    pageAnim.playReady(this, getApp());
    const isSuperNow = !!(app && app.isSuper && app.isSuper());
    /* 排班域（需求 D）：「待确认换班」与「手动排班」入口改为按 canSchedule 显隐 ——
       生活委员也进了排班域，继续用 isSuper 会让 TA 看不到自己该处理的换班申请。 */
    const canScheduleNow = !!(app && app.canSchedule && app.canSchedule());
    const p = app.globalData.profile || null;
    this.setData({
      profile: p,
      isAdmin: !!(app && app.isAdmin && app.isAdmin()),
      isSuper: isSuperNow,
      canSchedule: canScheduleNow,
      isCounselor: !!(p && p.groupTag === 'X'),
      switched: !!(app.globalData.switched),
      impersonateBanner: impersonate.bannerText(),
      bindOpen: !!(app.globalData.config && app.globalData.config.bindOpen !== false),
      remindOn: !!wx.getStorageSync('remindOn'),
      remindBlock: !!(p && p.remindBlock),
      calendarOn: !!wx.getStorageSync('calendarOn'),
      selfTag: this._selfRoleTag().text,
      selfTier: this._selfRoleTag().tier
    });
    this.load();
    if (canScheduleNow) {
      this._loadPending();
      // 「AI 排班设置」行的「已配置」角标（只取掩码，不取明文）
      this._loadAiSetting();
    }
    // v0.7.32 问题③：超管预取「可切换的测试账号」→ 点「切换测试账号」时立即弹 ActionSheet
    if (isSuperNow) this._loadTestAccounts();
    // 登录可能晚于 onShow 完成：就绪后补一次身份，否则排班负责人首屏看不到「待确认换班」
    if (app && app.globalData && !app.globalData.authChecked) {
      app.ready().then(() => {
        const s = !!(app.isSuper && app.isSuper());
        const cs = !!(app.canSchedule && app.canSchedule());
        const p2 = app.globalData.profile || null;
        this.setData({
          profile: p2,
          isAdmin: !!(app.isAdmin && app.isAdmin()),
          isSuper: s,
          canSchedule: cs,
          isCounselor: !!(p2 && p2.groupTag === 'X'),
          switched: !!(app.globalData.switched),
          impersonateBanner: impersonate.bannerText()
        });
        if (cs) this._loadPending();
        if (s) this._loadTestAccounts();
      });
    }
    if (app.globalData.openApps) {
      app.globalData.openApps = false;
      this.openApps();
    }
    /*
     * v0.7.32 问题②：切 tab 也做一次节流身份重校 —— 别人把你设为班委后，
     * 不必杀进程重开；身份变了就重套身份 + 重拉统计。
     */
    if (typeof app.recheckAuth === 'function') {
      app.recheckAuth().then((changed) => {
        if (!changed) return;
        const p3 = app.globalData.profile || null;
        this.setData({
          profile: p3,
          isAdmin: !!(app.isAdmin && app.isAdmin()),
          isSuper: !!(app.isSuper && app.isSuper()),
          canSchedule: !!(app.canSchedule && app.canSchedule()),
          isCounselor: !!(p3 && p3.groupTag === 'X'),
          switched: !!(app.globalData.switched),
          impersonateBanner: impersonate.bannerText(),
          selfTag: this._selfRoleTag().text,
          selfTier: this._selfRoleTag().tier
        }, () => this.load());
      }).catch(() => {});
    }
  },

  /** 个人卡职位头衔：超管金 / 班委蓝 / 辅导员青，由登录 profile 推导 */
  _selfRoleTag() {
    const app = getApp();
    const p = (app && app.globalData && app.globalData.profile) || this.data.profile;
    const rt = util.roleTag({
      isSuper: !!(app && app.isSuper && app.isSuper()),
      groupTag: p ? p.groupTag : '',
      role: p ? p.role : '',
      position: p ? p.position : ''
    });
    return rt || { text: '', tier: '' };
  },

  load(force) {
    /*
     * v0.7.16（需求③「本学期 / 待值日更新慢」）：改为 **SWR** ——
     * 旧值先显示（不清屏、不闪骨架），每次进入页面都**后台重拉**统计。
     * 旧实现有 20s 静默窗：被超管加值日 / 值日状态变化后切回「我的」，
     * 窗口内不重拉，表现为「数字要等几秒或来回切页才更新」。
     * duty.myStats 是一次小查询，每次 onShow 拉一遍没有性能顾虑；
     * `force` 语义保留（写操作后显式刷新），只是不再决定「拉不拉」。
     *
     * v1.0.6（真机反馈「待值日最后才显示出来」）：v0.7.16 只做了一半 ——
     * 「后台重拉」有了，但 stats 初始 null、**没有旧值回填**，统计卡
     * `wx:if="{{stats && ...}}"` 首帧整块空白，要等云函数往返（含 duty 冷启动）
     * 才出现；而其它卡（身份 / 日历 / 提醒开关）全是本地数据首帧就有，
     * 感知上就是「统计（待值日）最后才出来」。现在补上真缓存：
     * 每次 onShow 先回填**当前身份**上次成功的统计（key 按成员隔离，
     * 切换测试账号 / 换绑后各读各的），接口返回后原位刷新并写回缓存。
     */
    // 辅导员不参与值日：统计块对他整块不渲染（v0.7.17 需求⑤），这一次请求也一并省掉
    if (this.data.isCounselor) {
      this.setData({ loading: false, stats: null });
      return Promise.resolve();
    }
    const app = getApp();
    const p = app.globalData.profile || null;
    const cacheKey = p ? ('mnStats:' + p.class_id + ':' + p.id) : '';
    if (cacheKey) {
      const cached = wx.getStorageSync(cacheKey);
      if (cached && cached.termCount != null) {
        this.setData({ loading: false, stats: cached });
      }
    }
    return api.dutyMyStats({}, { toast: false })
      .then((r) => {
        this._hasData = true; this._lastLoad = Date.now();
        this.setData({ loading: false, stats: r });
        if (cacheKey) wx.setStorageSync(cacheKey, r);
      })
      .catch(() => this.setData({ loading: false }));
    /* v0.7.22 需求④：本页不再有「通知」入口 → 通知角标（_loadNoticeBadge）随之删除；
     * utils/notice 的列表缓存改由首页独力写入（首页的通知入口保留）。 */
  },

  /* v1.0.5：spring-scroll 下拉刷新 → 强制重载并收起指示器 */
  onRefresh() {
    Promise.resolve(this.load(true)).then(() => {
      const sc = this.selectComponent('#mineMain');
      if (sc && sc.finishRefresh) sc.finishRefresh();
    }).catch(() => {
      const sc = this.selectComponent('#mineMain');
      if (sc && sc.finishRefresh) sc.finishRefresh();
    });
  },

  /* ---------------- 切换测试账号（仅超管） ---------------- */
  /**
   * 拉 99 段测试账号 → ActionSheet 选择 → 切换身份。
   * 切换后所有云函数的生效身份变成目标账号（guard 按 impersonation 映射），
   * 真实 openid 仍是本人，随时可一键恢复。列表用管理员接口（模拟态下不提供再切换）。
   */
  /** 预取「可切换的测试账号」（v0.7.32 问题③）：超管进页面就拉一次、缓存在实例上，
   *  点「切换测试账号」时**立即**弹 ActionSheet，不再现场等网络。 */
  _loadTestAccounts() {
    if (this._testAccounts) return;
    api.memberList({ public: 'manage' }, { toast: false })
      .then((list) => { this._testAccounts = this._pickTestAccounts(list); })
      .catch(() => {});
  },
  /** 测试账号判定：优先用后端返回的 test 标记（辅导员的 studentNo 已被后端清空，
   *  只用「学号 99 段」正则会把「测试辅导员」漏掉，导致无法切到辅导员视角验证） */
  _pickTestAccounts(list) {
    return (list || []).filter(x => x.test || /^2608057499/.test(String(x.studentNo || '')));
  },
  _showSwitchSheet(accounts) {
    if (!accounts.length) { util.toast('没有可切换的测试账号'); return; }
    wx.showActionSheet({
      itemList: accounts.map(x => x.name + (x.groupTag === 'X' ? '（辅导员）' : '（' + x.groupTag + ' 组）')),
      success: (res) => {
        const target = accounts[res.tapIndex];
        if (!target) return;
        api.switchAccount({ memberId: target.id }, { loading: '切换中' })
          .then(() => this._afterSwitch('已切换为 ' + target.name))
          .catch(() => {});
      }
    });
  },

  onSwitchAccount() {
    // 已预取 → 立即弹；没预取到（首次进入 / 预取失败）→ 现拉一次再弹，并回填缓存
    if (this._testAccounts) { this._showSwitchSheet(this._testAccounts); return; }
    api.memberList({ public: 'manage' }, { toast: false })
      .then((list) => {
        this._testAccounts = this._pickTestAccounts(list);
        this._showSwitchSheet(this._testAccounts);
      })
      .catch(() => {});
  },
  /** 顶部「模拟中」横幅的「恢复本人」（v1.0.5）：与其余 3 个 Tab 页共用同一份实现 */
  onRecoverSelf() {
    impersonate.recover();
  },
  /**
   * 绑定入口开关（仅超管）。关闭后所有人无法走「口令 → 选人 → 学号验证」流程，
   * 已绑定成员不受影响。防爆破自动锁死（24h 累计失败 ≥500）后在这里手动开回；
   * 开启前建议先确认失败日志（云函数日志 fn=auth ALERT）。
   */
  onToggleBind() {
    const next = !this.data.bindOpen;
    const tip = next ? '开放班级绑定入口？' : '关闭班级绑定入口？关闭后新成员将无法绑定';
    wx.showModal({
      title: tip,
      confirmText: next ? '开放' : '关闭',
      success: (res) => {
        if (!res.confirm) return;
        api.setBindOpen({ open: next }, { loading: '处理中' })
          .then(() => {
            this.setData({ bindOpen: next });
            util.toast(next ? '绑定入口已开放' : '绑定入口已关闭');
          })
          .catch(() => {});
      }
    });
  },
  _afterSwitch(tip) {
    const app = getApp();
    app.refreshAuth().then(() => {
      this.setData({
        profile: app.globalData.profile,
        isAdmin: !!(app.isAdmin && app.isAdmin()),
        isSuper: !!(app.isSuper && app.isSuper()),
        /* 切换账号后权限整体变了（含排班域），canSchedule 必须一起补，
           否则从超管切到生活委员后「待确认换班」会沿用旧值不刷新 */
        canSchedule: !!(app.canSchedule && app.canSchedule()),
        switched: !!(app.globalData.switched),
        impersonateBanner: impersonate.bannerText()
      });
      util.toast(tip);
    }).catch(() => util.toast('已切换，下拉刷新后生效'));
  },

  /* ---------------- 提醒 ---------------- */
  /**
   * 点自己的头像 → 微信官方「选择头像」面板（open-type=chooseAvatar）。
   * getUserProfile 已被微信回收（只会返回灰色默认头像），必须走 chooseAvatar。
   * 选中的是临时文件 → 上传云存储拿 fileID（小程序 image 组件直接支持 cloud:// 显示）→ 存库。
   */
  onChooseAvatar(e) {
    const tempPath = e && e.detail && e.detail.avatarUrl;
    if (!tempPath) { util.toast('未获取到头像'); return; }
    const app = getApp();
    const me = this.data.profile;
    const memberId = (me && me.id) || 'me';
    const cloudPath = 'avatars/' + memberId + '-' + Date.now() + '.png';
    wx.showLoading({ title: '保存中', mask: true });
    wx.cloud.uploadFile({
      cloudPath,
      filePath: tempPath,
      success: (res) => {
        const fileID = res && res.fileID;
        if (!fileID) { wx.hideLoading(); util.toast('头像上传失败'); return; }
        api.updateAvatar({ avatarUrl: fileID }, { toast: false })
          .then(() => app.refreshAuth())
          .then(() => {
            wx.hideLoading();
            this.setData({ profile: app.globalData.profile });
            util.toast('头像已更新');
          })
          .catch(() => { wx.hideLoading(); });
      },
      fail: () => {
        wx.hideLoading();
        util.toast('头像上传失败，请重试');
      }
    });
  },

  /**
   * 值日微信提醒。订阅消息授权必须由点击触发，所以要分两种状态：
   *  · 未开启 → 首次授权（拿到第 1 条额度）；
   *  · 已开启 → **再攒 1 条额度**。
   *
   * ⚠️ v0.7.15 改口径（旧行为是 bug 级的不匹配）：提醒从「一天一条」变成
   *   「一天两条」（前一晚 21:00 预告 + 当天 07:00 再提醒），而一次性订阅是
   *   「用户同意一次 = 服务端 1 条额度」——旧实现在已开启后把本行改成「测试提醒」，
   *   每点一次反而**消耗**一条额度，一天两条的额度永远攒不起来。
   *   现在已开启后的每一次点击都再要一次授权（勾了「总是保持以上选择」后静默累积）。
   */
  onRemind() {
    if (this.data.remindBlock) {
      // 额度耗尽 → 重新授权并清掉后端标记（行尾橙字「额度已用完 · 点此重新开启」）
      if (!subscribe.ready()) { util.toast('微信提醒待模板上线'); return; }
      subscribe.request().then((r) => {
        if (!r.ok) { util.toast('未授权成功，可稍后重试'); return; }
        api.remindReopen().catch(() => {}).then(() => {
          const p = getApp().globalData.profile;
          if (p) p.remindBlock = false;
          this.setData({ remindBlock: false });
          util.toast('已重新开启微信提醒');
        });
      });
      return;
    }
    if (this.data.remindOn) {
      if (!subscribe.ready()) { util.toast('微信提醒待模板上线'); return; }
      subscribe.request().then((r) => {
        util.toast(r.ok ? '已再攒 1 条提醒额度' : '未授权成功，可稍后重试');
      });
      return;
    }
    if (!subscribe.ready()) {
      wx.setStorageSync('remindOn', 1);
      this.setData({ remindOn: true });
      util.toast('已开启（微信提醒待模板上线）');
      return;
    }
    subscribe.request().then((r) => {
      if (!r.ok) { util.toast('未授权订阅消息，可稍后重试'); return; }
      wx.setStorageSync('remindOn', 1);
      this.setData({ remindOn: true });
      util.toast('已开启微信提醒');
    });
  },

  /** 测试提醒（v0.7.15 独立成行）：向自己发一条模板消息验证链路。
   *  ⚠️ 会**消耗** 1 条订阅额度，所以不挂在「攒额度」的主点击上。 */
  onTestRemind() {
    if (!this.data.remindOn) return;
    subscribe.runTest(() => api.testRemind());
  },

  onCalendar() {
    if (this.data.calendarOn) { util.toast('已添加到日历'); return; }
    if (!wx.addPhoneRepeatCalendar) { util.toast('当前微信版本不支持'); return; }
    const start = Math.floor(Date.now() / 1000) + 86400;
    wx.addPhoneRepeatCalendar({
      title: '查看本周班级值日安排',
      startTime: start,
      endTime: start + 600,
      repeatInterval: 'week',
      repeatCount: 18,
      alarmOffset: 1800,
      success: () => {
        wx.setStorageSync('calendarOn', 1);
        this.setData({ calendarOn: true });
        util.toast('已加入日历提醒');
      },
      fail: () => util.toast('未添加到日历，请允许日历权限')
    });
  },

  /* ---------------- 我的申请 ---------------- */
  openApps() {
    this.setData({ appShow: true });
    this._loadApps();
    if (this.data.canSchedule) this._loadPending();
  },
  onAppClose() { this.setData({ appShow: false }); },

  /* ---------------- 发送更新公告（v0.7.25→改，仅超管） ---------------- */
  /* 版本号自动取 APP_VERSION、标题固定「版本更新公告」，超管只需填更新内容 */
  openAnnc() {
    this.setData({ anncShow: true, anncContent: '', anncBusy: false });
  },
  onAnncClose() { this.setData({ anncShow: false }); },
  onAnncContent(e) { this.setData({ anncContent: e.detail.value }); },
  onAnncSend() {
    if (this.data.anncBusy) { util.toast('正在发送，请稍候'); return; }
    const version = config.APP_VERSION;
    const title = '版本更新公告';
    const content = (this.data.anncContent || '').trim();
    if (!content) { util.toast('请填更新内容'); return; }
    util.confirmStrict(
      '版本 ' + version + '「版本更新公告」：发送后所有人下次打开小程序时主页弹窗展示一次。确认发送？',
      '发送更新公告'
    ).then((r) => {
      if (r !== 'confirm') return;
      this.setData({ anncBusy: true });
      api.appNoticePublish({ version, title, content }, { loading: '发送中' })
        .then(() => {
          this.setData({ anncShow: false, anncBusy: false });
          util.toast('公告已发送');
        })
        .catch(() => this.setData({ anncBusy: false }));
    }).catch(() => {});
  },
  _loadApps() {
    api.adjustListMine({}, { toast: false })
      .then((list) => {
        const apps = (list || []).map(x => {
          const s = SWAP_STATUS[x.status] || SWAP_STATUS.CANCELLED;
          const pending = x.status === 'PENDING_PEER' || x.status === 'PENDING_ADMIN';
          return Object.assign({}, x, {
            statusText: s.text, statusBg: s.bg, statusFg: s.fg,
            reasonText: REASON_TEXT[x.reason] || '其他',
            // 保洁课次显示「18点前」，其它课次显示「第 N 节」
            whenText: util.whenText(x.kind, x.period),
            // 排班域（需求 D）：超管 | 本班生活委员可同意/拒绝；申请人自己只能撤销
            canAgree: !!(pending && this.data.canSchedule && x.direction === 'out'),
            canCancel: !!(pending && x.direction === 'out')
          });
        });
        this.setData({ apps });
      })
      .catch(() => this.setData({ apps: [] }));
  },
  /** 排班域（需求 D：超管 | 本班生活委员）：全班待确认的换班申请 */
  _loadPending() {
    api.adjustPending({}, { toast: false })
      .then((list) => {
        const pendingSwaps = (list || []).map(x => Object.assign({}, x, {
          whenText: util.whenText(x.kind, x.period)
        }));
        this.setData({ pendingSwaps, pendingCount: pendingSwaps.length });
      })
      .catch(() => this.setData({ pendingSwaps: [], pendingCount: 0 }));
  },
  onPendingAgree(e) {
    const id = Number(e.currentTarget.dataset.id);
    api.adjustConfirm({ swapId: id, agree: true }, { loading: '处理中' })
      .then(() => { util.toast('已确认换班'); this._loadApps(); this._loadPending(); this.load(); this._syncSwapDot(); })
      .catch(() => {});
  },
  onPendingReject(e) {
    const id = Number(e.currentTarget.dataset.id);
    api.adjustConfirm({ swapId: id, agree: false }, { loading: '处理中' })
      .then(() => { util.toast('已拒绝'); this._loadApps(); this._loadPending(); this._syncSwapDot(); })
      .catch(() => {});
  },
  onSwapAgree(e) {
    const id = Number(e.currentTarget.dataset.id);
    api.adjustConfirm({ swapId: id, agree: true }, { loading: '处理中' })
      .then(() => { util.toast('已确认换班'); this._loadApps(); this.load(); this._syncSwapDot(); })
      .catch(() => {});
  },
  onSwapReject(e) {
    const id = Number(e.currentTarget.dataset.id);
    api.adjustConfirm({ swapId: id, agree: false }, { loading: '处理中' })
      .then(() => { util.toast('已拒绝'); this._loadApps(); this._syncSwapDot(); })
      .catch(() => {});
  },
  onSwapCancel(e) {
    const id = Number(e.currentTarget.dataset.id);
    util.confirm('撤销后该申请立即失效', '撤销申请').then(ok => {
      if (!ok) return;
      api.adjustCancel({ swapId: id }, { loading: '处理中' })
        .then(() => { util.toast('已撤销'); this._loadApps(); this.load(); this._syncSwapDot(); })
        .catch(() => {});
    });
  },
  /**
   * 换班操作后：用 duty.today 的真实待确认数直接同步底部「值日」tab 红点，
   * 并把首页 badge 标脏（swapDirty），让首页 onShow 强制重载 ——
   * 修复「确认/拒绝换班后，首页黄条 + 值日 tab 红点不消失」的 bug。
   * 直接读真实计数而非本地推断，超管（全班待确认）与普通成员（仅自己）都正确。
   */
  _syncSwapDot() {
    const app = getApp();
    if (app && app.globalData) {
      // swapDirty：首页红点 / 黄条立即失效（既有逻辑）
      app.globalData.swapDirty = true;
      // dutyDirty：换班同意/拒绝/撤销后值日表已变，值日页 / 首页 / 我的 下次 onShow 强刷
      app.globalData.dutyDirty = true;
    }
    api.dutyToday({}, { toast: false })
      .then((r) => {
        const tb = this.getTabBar();
        if (tb) tb.setData({ dot: (r.pendingSwapCount || 0) > 0 });
      })
      .catch(() => {});
  },

  /* ---------------- 关于 ---------------- */
  onAbout() { this.setData({ aboutShow: true }); },
  onAboutClose() { this.setData({ aboutShow: false }); },

  /* ---------------- 值日明细（待值日 / 已结束 可点开） ----------------
   * 只读清单：每条 = 日期 + 时间段 + 课程 + 教室 + 状态标签，不可点（grill-me 定案）。
   * type: pending（待值日+进行中）/ past（已过期+已完成）。 */
  _dutyStatusView(d) {
    const map = {
      PENDING: { text: '待值日', cls: 'pending' },
      ONGOING: { text: '进行中', cls: 'ongoing' },
      EXPIRED: { text: '已过期', cls: 'expired' },
      DONE:    { text: '已值日', cls: 'done' }
    };
    const s = map[d.status] || { text: '未知', cls: '' };
    // 保洁课次（CLEAN）→ 时间段统一显示「18点前」，不显示具体节次
    const periodText = (d.kind === 'CLEAN')
      ? '18点前'
      : (d.periodTime ? (d.periodTime.start + '-' + d.periodTime.end) : ('第' + d.period + '节'));
    return Object.assign({}, d, { statusText: s.text, statusCls: s.cls, periodText });
  },
  onShowDutyList(e) {
    const type = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.type) || 'pending';
    if (this.data.dutyListLoading) return; // 防连点：静默忽略，不报错（避免「点了没反应」无反馈的歧义）
    const title = type === 'past' ? '已结束的值日' : '待值日';
    this.setData({ dutyListShow: true, dutyListLoading: true, dutyListTitle: title, dutyList: [] });
    api.dutyMyList({ type }, { toast: false })
      .then((r) => {
        const list = (r && r.list || []).map(x => this._dutyStatusView(x));
        this.setData({ dutyList: list, dutyListLoading: false });
      })
      .catch((err) => {
        // 保留真实错误到控制台便于排查；给用户的仍是可读文案，不暴露后端细节
        console.error('[mine] dutyMyList 加载失败', err);
        this.setData({ dutyList: [], dutyListLoading: false });
        util.toast('加载失败，请重试');
      });
  },
  onDutyListClose() { this.setData({ dutyListShow: false }); },
  /** 用户协议 / 隐私政策：先收起「关于」弹层，再进二级页，回来时不会还挂着弹层 */
  onAgreement() { this._openDoc('agreement'); },
  onPrivacy() { this._openDoc('privacy'); },
  _openDoc(type) {
    this.setData({ aboutShow: false });
    wx.navigateTo({ url: '/pages/doc/index?type=' + type });
  },

  /* ---------------- 其它 ---------------- */
  /* ---------------- AI 排班设置（需求 D：自带密钥） ----------------
   * 密钥**跟随本人**而非班级，且接口只回掩码 —— 明文一旦保存就再也读不出来，
   * 所以这里只做「覆盖写入」：留空 = 不改，填了 = 覆盖。
   */
  openAiSetting() {
    this.setData({ aiShow: true, aiBusy: false, aiTestResult: '', aiKey: '' });
    this._loadAiSetting();
  },
  onAiClose() { this.setData({ aiShow: false }); },
  onAiBaseUrl(e) { this.setData({ aiBaseUrl: e.detail.value }); },
  onAiModel(e) { this.setData({ aiModel: e.detail.value }); },
  onAiKey(e) { this.setData({ aiKey: e.detail.value }); },
  /** 一键填好预设服务商的接口地址 + 默认模型名（之后可再「获取」覆盖） */
  onAiPreset(e) {
    const key = e.currentTarget.dataset.p;
    const p = AI_PROVIDERS[key];
    if (!p) return;
    this.setData({ aiProvider: key, aiBaseUrl: p.baseUrl, aiModel: p.model, aiModels: [] });
  },
  /** 输入密钥后点「获取」：从服务商拉回可用模型列表，供直接点选（避免手敲拼错） */
  onAiFetchModels() {
    if (this.data.aiBusy) return;
    this.setData({ aiBusy: true, aiTestResult: '', aiModels: [] });
    const p = { baseUrl: this.data.aiBaseUrl };
    if (this.data.aiKey) p.apiKey = this.data.aiKey;
    api.aiSettingModels(p, { loading: '获取模型' })
      .then((d) => {
        const models = (d && d.models) || [];
        this.setData({ aiBusy: false, aiModels: models });
        if (!models.length) {
          this.setData({ aiTestResult: (d && d.error) || '该接口未返回可用模型（可能不支持 /models）' });
        }
      })
      .catch((e) => {
        this.setData({ aiBusy: false, aiModels: [] });
        util.toast(String((e && e.errMsg) || e || '获取失败'));
      });
  },
  /** 从拉回的模型列表里点选一个，填进 aiModel */
  onPickModel(e) {
    const m = e.currentTarget.dataset.m;
    if (!m) return;
    this.setData({ aiModel: m, aiModels: [] });
  },
  _loadAiSetting() {
    api.aiSettingGet({}, { toast: false })
      .then((r) => {
        const d = r || {};
        this.setData({
          aiConfigured: !!d.configured,
          aiKeyMask: d.keyMask || '',
          aiBaseUrl: d.baseUrl || '',
          aiModel: d.model || ''
        });
      })
      .catch(() => {});
  },
  onAiTest() {
    if (this.data.aiBusy) return;
    this.setData({ aiBusy: true, aiTestResult: '' });
    const p = {
      baseUrl: this.data.aiBaseUrl,
      model: this.data.aiModel
    };
    if (this.data.aiKey) p.apiKey = this.data.aiKey;
    api.aiSettingTest(p, { loading: '测试中' })
      .then((d) => {
        const okEgress = d && d.egress === 'ok';
        this.setData({
          aiBusy: false,
          aiTestResult: okEgress
            ? '连通正常（HTTP ' + (d.httpStatus || 0) + '）'
            : '未连通：' + ((d && d.error) || '未知原因')
        });
      })
      .catch((e) => this.setData({ aiBusy: false, aiTestResult: '未连通：' + String((e && e.errMsg) || e || '') }));
  },
  onAiSave() {
    if (this.data.aiBusy) return;
    this.setData({ aiBusy: true, aiTestResult: '' });
    const p = {
      baseUrl: this.data.aiBaseUrl,
      model: this.data.aiModel
    };
    // 留空 = 不改；填了才覆盖
    if (this.data.aiKey) p.apiKey = this.data.aiKey;
    api.aiSettingSave(p, { loading: '保存中' })
      .then((r) => {
        const d = r || {};
        this.setData({
          aiBusy: false,
          aiKey: '',
          aiConfigured: !!d.configured,
          aiKeyMask: d.keyMask || '',
          aiTestResult: d.configured ? '已保存' : '已保存（未配置密钥）'
        });
        util.toast('已保存');
      })
      .catch((e) => {
        this.setData({ aiBusy: false });
        util.toast(String((e && e.errMsg) || e || '保存失败'));
      });
  },
  onAiClear() {
    if (this.data.aiBusy) return;
    util.confirmStrict('清除后密钥无法恢复（系统只存这一份，也不回显），需要重新填写。确认清除？', '清除密钥')
      .then((r) => {
        if (r !== 'confirm') return;
        this.setData({ aiBusy: true });
        api.aiSettingClear({}, { loading: '清除中' })
          .then(() => {
            this.setData({ aiBusy: false, aiConfigured: false, aiKeyMask: '', aiKey: '', aiBaseUrl: '', aiModel: '', aiTestResult: '' });
            util.toast('已清除');
          })
          .catch((e) => {
            this.setData({ aiBusy: false });
            util.toast(String((e && e.errMsg) || e || '清除失败'));
          });
      })
      .catch(() => {});
  },

  /**
   * 手动排班（P5 唯一入口）：排班域（需求 D：超管 | 本班生活委员）进「手动排班」页，
   * 可把同学安排到某节课（含空课次）；其余人仍去值日页看结果即可。
   * ⚠️ 这里只是「给不给入口」，真拦截在云函数侧（schedule 路由的 scheduleAuth）。
   */
  goManual() {
    const app = getApp();
    if (app && app.canSchedule && app.canSchedule()) {
      wx.navigateTo({
        url: '/pages/manual/index',
        fail: () => wx.switchTab({ url: '/pages/duty/index' })
      });
      return;
    }
    wx.switchTab({ url: '/pages/duty/index' });
  },

  noop() {}
});
