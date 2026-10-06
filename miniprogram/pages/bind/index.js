/**
 * P1 · 身份绑定（三步：班级口令 → 名单选人 → 学号后四位）
 * openid 由云函数 auth.login 无感获取，本页只做「人 → 微信」的确认
 */
const api = require('../../utils/api');
const util = require('../../utils/util');

/**
 * 名单缓存（v0.7.17 需求①）：token → 脱敏名单。
 * 命中后「返回上一步再进来」「口令输错重试」「扫码进入」都是同帧出名字，不再等网络。
 * 只存内存（不落 storage）：名单是脱敏的，但也无须在设备上留痕。
 */
const ROSTER_CACHE = {};

Page({
  data: {
    step: 0,
    statusBarHeight: 20,
    safeBottom: 0,

    /* step 1 */
    token: '',
    tokenError: '',
    checking: false,
    /** 隐私合规（2026-09-25 审核）：必须主动勾选同意协议才可下一步，不得默认同意 */
    agreed: false,

    /* step 2 */
    roster: [],
    groups: [],
    kw: '',
    picked: null,
    rosterLoading: false,

    /* step 3 */
    code: '',
    codeArr: [],
    codeError: '',
    binding: false,
    shake: false,
    locked: false,

    className: '',

    /** 班级绑定入口被关闭（超管手动 / 防爆破自动锁死） */
    bindClosed: false,

    /** 教职工（辅导员 / 老师）绑定：无班级、无学号，走一次性绑定码（2026-09-26） */
    staffMode: false,
    staffCode: '',
    staffError: '',
    staffBinding: false
  },

  onLoad() {
    const app = getApp();
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight || 20,
      safeBottom: app.globalData.safeBottom || 0
    });
    // 绑定关闭时第一时间提示；登录晚于本页就绪则在 ready 后补查一次
    const cfg = app.globalData.config;
    if (cfg && cfg.bindOpen === false) this.setData({ bindClosed: true });
    else if (app.ready) {
      app.ready().then(() => {
        const c2 = getApp().globalData.config;
        if (c2 && c2.bindOpen === false) this.setData({ bindClosed: true });
      }).catch(() => {});
    }
    const scene = app.globalData.scene || '';
    if (scene) this._resolveScene(scene);

    /*
     * 已绑定却被扫码 / 分享落在绑定页（v0.7.19 修，恶性 bug）：
     * 口令页只该给未绑定的人看 —— 已绑定的人扫入班码，身份登录是成功的，
     * 却被留在口令输入页，看起来像「又要绑定一次」。
     * 放在 app.ready() 回调里而不是 app._bootstrap：冷启动落在 bind 页时，
     * onLaunch 阶段首个页面还没挂载，在页面侧判断才稳定；
     * 绑定成功自己会跳走（onUnload 置标志），不会和本逻辑互相拉扯。
     */
    this._leavingBind = false;
    if (app.ready) {
      app.ready().then((g) => {
        if (g && g.bound && !this._leavingBind) {
          this._leavingBind = true;
          wx.reLaunch({ url: '/pages/home/index' });
        }
      }).catch(() => {});
    }

    /*
     * 云函数预热（v0.7.17 需求①）。
     * 本页第一个要用的接口是 `member.list{public:'roster'}`，而 `auth` 函数已经被
     * onLaunch 的 `auth.login` 叫醒过 —— 唯独 `member` 在「首次打开小程序 → 直接走绑定」
     * 这条路径上还是冷的（1~3s）。这里提前把它叫醒，等用户输完口令、点下一步时它已经热了。
     * 用一个必然不存在的口令：走到「口令不正确」就返回，且**不会计入失败次数**
     * （爆破计数只发生在 auth.checkToken 里）。失败一律吞掉，预热绝不能影响页面。
     */
    api.memberList({ public: 'roster', token: '__warmup__' }, { toast: false }).catch(() => {});
  },

  onUnload() {
    this._leavingBind = true;   // 页面已离开：防 ready 迟到后把人从别处拉回主页
    clearTimeout(this._shakeTimer);
  },

  /* ---------------- 扫码邀请 ---------------- */
  _resolveScene(raw) {
    let scene = String(raw || '').trim();
    const m = /[?&]scene=([^&]+)/.exec(scene);
    if (m) {
      try { scene = decodeURIComponent(m[1]); } catch (e) { scene = m[1]; }
    }
    if (!scene) return;
    api.resolveScene({ scene }, { toast: false })
      .then(r => {
        if (r && r.token) {
          this.setData({ token: String(r.token) });
          util.toast('已自动填入班级口令');
          // 扫码进来的下一步必然是「点下一步看名单」→ 提前把名单拿到手上（并写缓存）
          this._rosterOf(String(r.token)).then((list) => {
            if (list) ROSTER_CACHE[String(r.token)] = list;
          });
        }
      })
      .catch(() => {});
  },

  onScan() {
    wx.scanCode({
      onlyFromCamera: false,
      success: (res) => {
        const raw = (res && (res.path || res.result || res.rawData)) || '';
        this._resolveScene(raw);
      },
      fail: () => {}
    });
  },

  /* ---------------- step 1 ---------------- */
  /** 口令（2026CC）与邀请码（CLS26A01）共用一个输入框：允许字母数字，统一转大写 */
  onTokenInput(e) {
    const v = String(e.detail.value || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase().slice(0, 12);
    this.setData({ token: v, tokenError: '' });
  },

  onToggleAgree() {
    this.setData({ agreed: !this.data.agreed });
  },

  /** 查看《用户协议》/《隐私政策》：内容唯一来源 data/legal.js，渲染 pages/doc/index */
  onDoc(e) {
    const type = String((e.currentTarget.dataset && e.currentTarget.dataset.type) || 'agreement');
    wx.navigateTo({ url: '/pages/doc/index?type=' + (type === 'privacy' ? 'privacy' : 'agreement') });
  },

  onNext() {
    // 隐私合规：未勾选同意一律不放行（审核红线：不得默认即同意）
    if (!this.data.agreed) {
      util.toast('请先阅读并同意《用户协议》与《隐私政策》');
      return;
    }
    const token = this.data.token.trim();
    if (token.length < 4) {
      this.setData({ tokenError: '请输入班级口令或邀请码' });
      return;
    }
    if (this.data.checking) return;
    this.setData({ checking: true });
    /*
     * 提速（v0.7.17 需求①）：口令校验与名单拉取**并行**。
     * 后端 `member.list{public:'roster'}` 的解析条件是 `join_token = ? OR invite_code = ?`，
     * 与 checkToken 完全一致 —— 所以**用户原始输入**就能直接换名单，不必等 checkToken
     * 回来拿「规范口令」。旧写法是「checkToken → 再 roster」两次串行云调用，
     * 两次冷启动叠加，表现为「进到选人页要干等好几秒才出名字」。
     */
    const rosterP = this._rosterOf(token);
    api.checkToken({ token }, { toast: false })
      .then((r) => {
        // 口令与邀请码等价入场：后端返回规范口令，后续 roster/bind 统一用它
        const canonical = String((r && r.token) || token);
        // 立刻进选人页 —— 名单已经在路上（缓存命中时同帧就有），不让用户对着按钮干等
        this.setData({ checking: false, step: 1, token: canonical, rosterLoading: !this.data.roster.length });
        rosterP.then((list) => {
          if (list && list.length) { this._renderRoster(list, token, canonical); return; }
          // 并行那一路失败 / 空 → 用规范口令补拉一次（保底，宁可慢也不再错）
          this._loadRoster(canonical);
        });
      })
      .catch((e) => {
        this.setData({ checking: false, tokenError: (e && e.errMsg) || '口令不正确，请重新输入' });
        this._shake();
      });
  },

  _shake() {
    this.setData({ shake: true });
    clearTimeout(this._shakeTimer);
    this._shakeTimer = setTimeout(() => this.setData({ shake: false }), 320);
  },

  /* ---------------- step 2 ---------------- */
  /** 取名单：命中缓存直接 resolve；否则发请求（失败 resolve null，由调用方决定补拉） */
  _rosterOf(token) {
    if (ROSTER_CACHE[token]) return Promise.resolve(ROSTER_CACHE[token]);
    return api.memberList({ public: 'roster', token }, { toast: false })
      .then((list) => (list && list.length ? list : null))
      .catch(() => null);
  },

  /** 渲染名单并写缓存（两个键：用户原始输入 + 后端规范口令，两种叫法下次都能命中） */
  _renderRoster(list, rawToken, canonicalToken) {
    ROSTER_CACHE[rawToken] = list;
    if (canonicalToken) ROSTER_CACHE[canonicalToken] = list;
    this.setData({ roster: list, rosterLoading: false });
    this._applyFilter();
    // 列表高度变化后让 spring-scroll 重新测量可滚动范围（否则一开始 _maxScroll=0 不滚不弹）
    setTimeout(() => {
      const sc = this.selectComponent('#bindMain');
      if (sc && sc.resize) sc.resize();
    }, 60);
  },

  _loadRoster(token, silent) {
    if (!silent) this.setData({ rosterLoading: true });
    return api.memberList({ public: 'roster', token }, { toast: false })
      .then((list) => {
        this._renderRoster(list || [], token, token);
      })
      .catch(() => {
        if (silent) { util.toast('刷新失败，显示的是上次的名单'); return; }
        this.setData({ rosterLoading: false, step: 0, tokenError: '口令校验失败，请重新输入' });
      });
  },

  /* v1.0.5：spring-scroll 下拉刷新（静默重载，不闪骨架）→ 收起指示器 */
  onRefresh() {
    const done = () => { const sc = this.selectComponent('#bindMain'); if (sc && sc.finishRefresh) sc.finishRefresh(); };
    if (!this.data.token) { done(); return; }
    Promise.resolve(this._loadRoster(this.data.token, true)).then(done).catch(done);
  },

  onKw(e) {
    this.setData({ kw: String(e.detail.value || '') });
    this._applyFilter();
  },

  _applyFilter() {
    const kw = this.data.kw.trim();
    const src = kw ? this.data.roster.filter(x => x.name.indexOf(kw) >= 0 || (x.studentNoMasked || '').indexOf(kw) >= 0) : this.data.roster;
    const a = src.filter(x => x.groupTag === 'A');
    const b = src.filter(x => x.groupTag === 'B');
    const t = src.filter(x => x.groupTag === 'X');   // 教职工（辅导员等），不参与 A/B 分组
    const groups = [];
    if (a.length) groups.push({ tag: 'A', title: 'A 组 · ' + a.length + ' 人', list: a });
    if (b.length) groups.push({ tag: 'B', title: 'B 组 · ' + b.length + ' 人', list: b });
    if (t.length) groups.push({ tag: 'X', title: '教职工 · ' + t.length + ' 人', list: t });
    this.setData({ groups });
  },

  onPick(e) {
    const id = Number(e.currentTarget.dataset.id);
    const item = this.data.roster.find(x => x.id === id);
    if (!item || item.bound) return;
    this.setData({ picked: item });
  },

  onConfirmPerson() {
    if (!this.data.picked) return;
    this.setData({ step: 2, code: '', codeArr: [], codeError: '' });
    setTimeout(() => this.setData({ codeFocus: true }), 300);
  },

  onBack() {
    if (this.data.step === 1) {
      // 连名单一起清：回上一步换口令后，若不清就会拿**上一个班**的名字顶着新口令的骨架
      // （v0.7.17 改成并行拉取后这一步更必要 —— rosterLoading 由「本地有没有名单」决定）
      this.setData({ step: 0, picked: null, kw: '', roster: [], groups: [] });
    } else if (this.data.step === 2) {
      this.setData({ step: 1, code: '', codeError: '' });
    }
  },

  onChangePerson() {
    this.setData({ step: 1, code: '', codeArr: [], codeError: '' });
  },

  /* ---------------- step 3 ---------------- */
  onCodeInput(e) {
    const v = String(e.detail.value || '').replace(/\D/g, '').slice(0, 4);
    this.setData({ code: v, codeError: '', codeArr: v.split('') });
  },

  onBind() {
    if (this.data.code.length !== 4) {
      this.setData({ codeError: '请输入学号后 4 位' });
      return;
    }
    if (this.data.binding) return;
    this.setData({ binding: true });
    // 头像不再绑定即采集：getUserProfile 已被微信回收（只能拿到灰头像），
    // 绑定后到「我的」页点头像，经微信 chooseAvatar 面板选择上传。
    this._doBind('');
  },

  /** 提交绑定；avatarUrl 可为空（用户未设置头像时） */
  _doBind(avatarUrl) {
    api.bind({
      token: this.data.token.trim(),
      memberId: this.data.picked.id,
      studentNoLast4: this.data.code,
      avatarUrl: avatarUrl || ''
    }, { toast: false })
      .then(() => {
        this.setData({ binding: false });
        wx.showToast({ title: '绑定成功，欢迎加入', icon: 'none', duration: 1500 });
        const app = getApp();
        app.refreshAuth().then(() => {
          setTimeout(() => wx.switchTab({ url: '/pages/home/index' }), 1200);
        }).catch(() => {
          setTimeout(() => wx.switchTab({ url: '/pages/home/index' }), 1200);
        });
      })
      .catch((e) => {
        this.setData({ binding: false });
        const code = e && e.errCode;
        if (code === 40005) {
          this.setData({ locked: true });
          return;
        }
        const remain = e && e.data && typeof e.data.remainAttempts === 'number' ? e.data.remainAttempts : null;
        this.setData({
          codeError: remain !== null
            ? '学号后 4 位不匹配，你还有 ' + remain + ' 次机会'
            : ((e && e.errMsg) || '验证失败，请重试')
        });
        this._shake();
        setTimeout(() => this.setData({ code: '' }), 1000);
      });
  },

  /* ---------------- 教职工绑定码 ---------------- */
  /**
   * 为什么单开一条路：辅导员 / 老师没有班级、没有学号。
   * 原有链路三重都不适用 —— ① 名单里没有他的条目；② 教职工不在 A/B 分组、按名字选人对不上；
   * ③ 没有学号，后 4 位无从验证。所以由管理员现场发 8 位一次性码（member.addStaff），
   * 本人在这里输入即完成绑定（后端 auth.bindStaff 只校验码本身，不查名单、不校验学号）。
   */
  onEnterStaff() {
    this.setData({ staffMode: true, staffCode: '', staffError: '', tokenError: '' });
  },

  onExitStaff() {
    this.setData({ staffMode: false, staffCode: '', staffError: '' });
  },

  /** 码的字符集是「去掉 I/O/0/1 的大写字母 + 数字」，输入即统一转大写 */
  onStaffInput(e) {
    const v = String(e.detail.value || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase().slice(0, 8);
    this.setData({ staffCode: v, staffError: '' });
  },

  onStaffSubmit() {
    // 与班级绑定同一条隐私红线：未勾选同意协议一律不放行
    if (!this.data.agreed) {
      util.toast('请先阅读并同意《用户协议》与《隐私政策》');
      return;
    }
    if (this.data.staffCode.length !== 8) {
      this.setData({ staffError: '请输入 8 位绑定码' });
      return;
    }
    if (this.data.staffBinding) return;
    this.setData({ staffBinding: true });
    api.bindStaff({ staffCode: this.data.staffCode }, { toast: false })
      .then(() => {
        this.setData({ staffBinding: false });
        wx.showToast({ title: '绑定成功，欢迎', icon: 'none', duration: 1500 });
        const app = getApp();
        const go = () => setTimeout(() => wx.switchTab({ url: '/pages/home/index' }), 1200);
        app.refreshAuth().then(go).catch(go);
      })
      .catch((e) => {
        this.setData({ staffBinding: false });
        if (e && e.errCode === 40005) {
          this.setData({ locked: true });
          return;
        }
        this.setData({ staffError: (e && e.errMsg) || '绑定失败，请重试' });
        this._shake();
      });
  },

  onLockedKnow() {
    this.setData({ locked: false });
  },

  noop() {}
});
