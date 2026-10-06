/**
 * 班级通知（非 Tab 二级页）
 * 班委（管理员）在「首页 → 发布通知」发出；成员在「首页 → 查看通知」查看并确认收到。
 * 页面本身是纯前端渲染，改这里不需要部署云函数。
 *
 * 首屏策略（2026-09-25 修「打开很慢」）：
 *   先用 utils/notice 的内存缓存**同步渲染**（「我的」页拉角标时已经存过一份），
 *   再后台静默刷新。云函数 media 带 music-metadata 重依赖、冷启动要好几秒，
 *   不等它页面就已经有内容了。缓存命中时不显示骨架，只静默替换。
 */
const api = require('../../utils/api');
const util = require('../../utils/util');
const subscribe = require('../../utils/subscribe');
const notice = require('../../utils/notice');

/** 左滑删除区总露出宽度（px，包含删除区本身 + 与卡片的间距；
 *  WXSS 里 .nt-del-zone 实际宽度更小，靠 right 留出间距） */
const BTN_WIDTH = 88;

/**
 * 折叠展开 / 收起的动画时长（ms）—— 必须与 `pages/notice/index.wxss` 里
 * `.nt-body` / `.nt-fold-arrow` 的 transition duration **逐字一致**。
 * 改一处忘另一处不会报错，只是「收起动画还没播完 clamp 就回来了 → 文字突然跳一下」，
 * 所以由 check-notice 拿这个常量去比对 CSS。
 */
const FOLD_MS = 280;

/**
 * 「飞入回收站」动画时长（ms）—— 必须与 `pages/notice/index.wxss` 里
 * `.nt-fly-x` / `.nt-fly-y` 的 transition 时长**逐字一致**。
 * 不一致的后果是静默的：动画还没走完卡片就被从数据源里摘掉（或反过来，
 * 卡片已经消失还在等动画），由 check-notice 比对 CSS 与这个常量。
 */
const FLY_MS = 520;

/* ------------------------------------------------------------------
 * 卡片堆叠（v0.7.13 需求③，渐进增强）
 *   「通知过多时」才启用：列表超过 STACK_MIN 条才堆，短列表保持原样。
 *   做法：**不改列表结构**，只给「已经划过顶部的卡片」加 sticky ——
 *     最新划过去的那张钉在最上层（全尺寸、不透明），
 *     更早的逐层往上错开、缩小、变暗 → 层级和大小就是浏览进度。
 *   ⚠️ 三个数值必须与 pages/notice/index.wxss / 页面常量保持一致的地方都由
 *      check-notice-motion 钉死（改一处忘另一处不报错，只会「堆得歪」）。
 * ------------------------------------------------------------------ */
const STACK_MIN = 6;        // 少于这条数就不堆（短列表堆起来反而挡视线）
const MAX_STACK = 3;        // 最多留 3 层，更早的直接划走
const STACK_TOP_RPX = 40;   // 最上层那张钉在距顶 40rpx（留出状态栏，不压在系统栏上）
const STACK_STEP_RPX = 16;  // 每深一层往上错开 16rpx（露出这一层，看得出是「一摞」）
const STACK_SCALE = 0.04;   // 每深一层缩小 4%
const STACK_DIM = 0.18;     // 每深一层暗 18%

/** 给每条通知补上滑动 / 折叠 / 飞入回收站需要的字段 */
function withSwipe(list) {
  return (list || []).map(x => Object.assign({}, x, {
    offset: 0, swiping: false, expanded: false,
    flying: false, wrapStyle: '', flyStyle: ''
  }));
}

Page({
  data: {
    loading: true,
    failed: false,
    list: [],
    remindOn: false,
    /** 顶部「开启服务通知」提示条：只在模板就绪 + 未开启 + 总开关没关时显示 */
    showSubTip: false,
    /** 「清空全部通知」入口（2026-09-25）：仅测试超管（99 段）可见，真实超管不可清线上数据 */
    canClear: false,

    /* 回收站（v0.7.13 需求②）：右下角常驻入口 + 弹层里的已删列表 */
    recycleShow: false,
    recycleList: [],
    recycleCount: 0,
    /** 卡片正飞进回收站时，垃圾桶「接一下」（缩放脉冲），让落点看得见 */
    trashPulse: false,

    /* 图片查看器（v0.7.14，截图② Shared-element Image Expansion）：
       点击缩略图 → 图片从缩略图位置连续放大到全屏，关闭时缩回原位置。
       viewerStyle 由 JS 计算内联写入（px，视口坐标），分两拍 setData 起过渡。 */
    viewerShow: false,
    viewerImages: [],
    viewerIndex: 0,
    viewerStyle: '',
    viewerBg: 0,
    viewerAnim: false
  },

  onLoad() {
    this._refreshSubTip();
    const app = getApp();
    const p = (app.globalData && app.globalData.profile) || {};
    const s = !!(app && app.isSuper && app.isSuper());
    this.setData({ isSuper: s, canClear: !!(s && p.test) });
    // 缓存优先：**只要缓存里有就先同步渲染**，不再因 FRESH_MS 过期退回骨架。
    // 过期与否只影响「要不要后台再拉一次」，不影响首屏（解决「打开很慢」）。
    const cached = notice.read(0);
    if (cached) {
      this.setData({ loading: false, list: withSwipe(notice.toItems(cached)) });
    }
    // 需求⑤：一进通知页就把「未读游标」推到最新 —— 返回首页 / 我的，红点立刻消失。
    // 用缓存先推一次（同步渲染的那份就是用户此刻看到的），网络回来后再推一次。
    if (cached) notice.markSeen(cached, this._memberId());
    this.load();
  },

  /** 当前成员 id（未读游标按成员隔离；profile 尚未就绪时回落 0） */
  _memberId() {
    const app = getApp();
    const p = (app && app.globalData && app.globalData.profile) || {};
    return Number(p.id) || 0;
  },

  /**
   * 顶部「开启服务通知」提示条显隐（2026-09-25）：
   * 微信通知正常（已授权过）就不显示这一行。判定顺序：
   * ① 模板未上线（NOTICE_TEMPLATE_ID 为空）→ 不显示，点了也只是 toast；
   * ② 本地已记录授权成功（noticeRemindOn）→ 不显示；
   * ③ 都没有 → 再查微信订阅消息总开关，被用户关掉（mainSwitch=false）照样显示，
   *    此时授权额度已被封死，属于「通知不正常」，需要重新引导开启。
   */
  _refreshSubTip() {
    const remindOn = !!wx.getStorageSync('noticeRemindOn');
    this.setData({ remindOn });
    if (!subscribe.noticeReady() || remindOn) {
      this.setData({ showSubTip: false });
      return;
    }
    wx.getSetting({
      withSubscriptions: true,
      success: (r) => {
        const ss = r && r.subscriptionsSetting;
        // 拿不到 mainSwitch（低版本基础库）视为正常，不额外打扰
        const off = !!(ss && ss.mainSwitch === false);
        this.setData({ showSubTip: !off });
      },
      fail: () => this.setData({ showSubTip: true })
    });
  },

  load(done) {
    // 已经有内容就别再退回骨架：刷新过程对用户应当是无感的
    const hasContent = !!(this.data.list && this.data.list.length);
    this.setData({ loading: !hasContent, failed: false });
    api.msgList({}, { toast: false })
      .then((list) => {
        this._retriedOnce = false;
        notice.write(list);
        notice.markSeen(list, this._memberId());   // 需求⑤：拿到最新列表后同步推进未读游标
        // 列表整批换掉 → 堆叠从头算（不重置的话，旧的第几层会挂到新列表上）
        this._passed = 0;
        this.setData({ loading: false, list: withSwipe(notice.toItems(list)) }, () => {
          // 渲染完再量：此时可能已经滚了一段，但首卡还没被钉住（_passed=0）→ 量得到自然位置
          this._measureStack(() => this._applyPile(this._lastScroll || 0));
        });
        this._loadRecycleCount();
        if (done) done();
      })
      .catch(() => {
        // media 带重依赖冷启动偶发超时（2026-09-25 用户见「通知没加载出来」）：
        // 无缓存内容时先静默重试一次，仍失败才亮错误态
        if (!hasContent && !this._retriedOnce) {
          this._retriedOnce = true;
          setTimeout(() => this.load(done), 900);
          return;
        }
        // 缓存已经有内容时，刷新失败不要把整页打回错误态
        this.setData({ loading: false, failed: !hasContent });
        if (done) done();
      });
  },

  onReload() { this.load(); },

  /** 确认收到（幂等，重复点不会出错） */
  onAck(e) {
    const id = Number(e.currentTarget.dataset.id);
    if (this._acking) return;
    this._acking = true;
    api.msgRead({ noticeId: id }, { loading: '处理中' })
      .then(() => {
        this._acking = false;
        util.toast('已确认收到');
        notice.patchAcked(id);            // 同步内存缓存，「我的」页角标不会跳回去
        const list = this.data.list.map((x) => {
          if (x.id !== id || x.acked) return x;
          const next = Object.assign({}, x, { acked: true, ackCount: x.ackCount + 1 });
          next.ackText = next.recipientCount ? (next.ackCount + '/' + next.recipientCount) : '—';
          return next;
        });
        this.setData({ list });
      })
      .catch(() => { this._acking = false; });
  },

  /**
   * 删除自己收到的这条通知（软删除，仅对自己生效，不影响他人）
   * ----------------------------------------------------------------
   * v0.7.13 需求②：删除后卡片要「从卡片位置开始移动，沿曲线路径连到回收站图标，
   * 缩小、旋转后进入回收站」。所以这里是**动画与网络并行**：
   *   · 动画先起（点下去立刻有反馈，不等网络）；
   *   · Promise.all 等「动画播完」+「删除请求回来」两件事**都**完成，才把卡片从数据源摘掉；
   *   · 请求失败 → 把卡片飞回来（保留过渡，不是硬弹），提示重试。
   */
  onDelete(e) {
    const id = Number(e.currentTarget.dataset.id);
    const index = Number(e.currentTarget.dataset.index);
    if (this._deleting) return;
    this._deleting = true;
    const req = api.msgDelete({ noticeId: id }, { toast: false });
    Promise.all([
      req,
      new Promise((resolve) => { this._flyToTrash(index, resolve); })
    ]).then(() => {
      this._deleting = false;
      if (this._openId === id) this._openId = null;
      notice.removeFromCache(id);       // 同步缓存，返回列表页它不会又冒出来
      // 少了一张卡 → 后面所有卡的位置都往上移，堆叠必须清掉重新量
      const next = this.data.list
        .filter((x) => x.id !== id)
        .map((x) => Object.assign({}, x, { wrapStyle: '' }));
      this._passed = 0;
      this.setData({
        list: next,
        recycleCount: (Number(this.data.recycleCount) || 0) + 1
      }, () => {
        this._measureStack(() => this._applyPile(this._lastScroll || 0));
      });
      util.toast('已删除 · 可在回收站恢复');
    }).catch(() => {
      this._deleting = false;
      this._flyBack(index);
    });
  },

  /* ---------------- 飞入回收站（v0.7.13 需求②） ---------------- */

  /**
   * 让第 index 张卡片沿弧线飞向回收站图标，飞完回调 done。
   * 量不到位置（极端情况：节点还没渲染）就立刻回调 —— 宁可没有动画，也不能删不掉。
   */
  _flyToTrash(index, done) {
    this._measureFly(index, (dx, dy) => {
      if (dx === null) { done(); return; }
      const at = 'list[' + index + '].';
      // 第 1 拍：只挂上过渡 class，**还没有任何位移** ——
      // 若把「过渡」和「目标位移」放在同一次 setData 里，元素的 before-change 样式里
      // 根本不存在 transition，浏览器不会起过渡，卡片会瞬移（踩过的坑，别合并成一次）。
      this.setData({
        [at + 'flying']: true,
        [at + 'wrapStyle']: 'z-index:60',
        [at + 'flyStyle']: 'transform:translateY(0px) scale(1) rotate(0deg);opacity:1'
      }, () => {
        // 第 2 拍：给目标位移 → 过渡真的跑起来（X 线性 + Y ease-in = 弧线）
        this.setData({
          [at + 'wrapStyle']: 'z-index:60;transform:translateX(' + dx + 'px)',
          [at + 'flyStyle']: 'transform:translateY(' + dy + 'px) scale(.14) rotate(26deg);opacity:0'
        });
        this.setData({ trashPulse: true });
        this._flyTimer = setTimeout(() => {
          this.setData({ trashPulse: false });
          done();
        }, FLY_MS);
      });
    });
  },

  /** 量「卡片中心 → 回收站图标中心」的位移（px）。量不到回调 (null, null) */
  _measureFly(index, cb) {
    const q = wx.createSelectorQuery();
    if (q.in) q.in(this);
    q.selectAll('.nt-card').boundingClientRect();
    q.select('.nt-trash').boundingClientRect();
    q.exec((res) => {
      const cards = (res && res[0]) || [];
      const trash = (res && res[1]) || null;
      const c = cards[index];
      if (!c || !trash || !trash.width) { cb(null, null); return; }
      cb(
        (trash.left + trash.width / 2) - (c.left + c.width / 2),
        (trash.top + trash.height / 2) - (c.top + c.height / 2)
      );
    });
  },

  /** 删除失败：把卡片飞回原位（保留过渡，所以是「飞回来」而不是硬弹） */
  _flyBack(index) {
    const at = 'list[' + index + '].';
    this.setData({
      [at + 'wrapStyle']: 'z-index:60;transform:translateX(0px)',
      [at + 'flyStyle']: 'transform:translateY(0px) scale(1) rotate(0deg);opacity:1'
    });
    util.toast('删除失败，请重试');
    this._flyTimer = setTimeout(() => {
      this.setData({ [at + 'flying']: false, [at + 'wrapStyle']: '', [at + 'flyStyle']: '' });
    }, FLY_MS);
  },

  /* ---------------- 回收站：查看 + 恢复（v0.7.13 需求②） ---------------- */

  onTrashOpen() {
    this.setData({ recycleShow: true });
    api.msgRecycleList({}, { toast: false })
      .then((list) => {
        this.setData({ recycleList: notice.toItems(list), recycleCount: (list || []).length });
      })
      .catch(() => {});
  },

  onTrashClose() { this.setData({ recycleShow: false }); },

  /** 恢复一条：删掉 notice_msg_delete 那一行，主列表随之重新拉一次 */
  onRestore(e) {
    const id = Number(e.currentTarget.dataset.id);
    if (this._restoring) return;
    this._restoring = true;
    api.msgRestore({ noticeId: id }, { loading: '恢复中' })
      .then(() => {
        this._restoring = false;
        util.toast('已恢复');
        const left = (this.data.recycleList || []).filter((x) => x.id !== id);
        this.setData({ recycleList: left, recycleCount: left.length });
        this.load();   // 它已经不在「已删除」过滤里了 → 主列表要重新拉，否则恢复完看不见
      })
      .catch(() => { this._restoring = false; });
  },

  /** 进页面时把回收站条数取回来（让右下角垃圾桶能显示角标，否则用户不知道有东西可回收） */
  _loadRecycleCount() {
    api.msgRecycleList({}, { toast: false })
      .then((list) => this.setData({ recycleCount: (list || []).length }))
      .catch(() => {});
  },

  /**
   * 清空回收站（v0.7.16 需求⑤）：删掉我自己全部软删行 —— 彻底移除、不可再恢复。
   * 与逐条「恢复」不同，这里没有后悔药，所以二次确认里把后果写明白。
   */
  onRecycleClear() {
    const n = Number(this.data.recycleCount) || 0;
    if (!n) return;
    util.confirm(
      '将彻底移除回收站里的 ' + n + ' 条通知，之后不能再恢复。确定清空？',
      '清空回收站'
    ).then((ok) => {
      if (!ok) return;
      api.msgRecycleClear({}, { loading: '清空中' })
        .then((r) => {
          this.setData({ recycleList: [], recycleCount: 0 });
          util.toast('已清空 ' + ((r && r.cleared) || n) + ' 条');
        })
        .catch(() => {});
    });
  },

  /* ---------------- 卡片堆叠（v0.7.13 需求③） ---------------- */

  /** rpx → px（sticky 的判定线要用 px 跟 scrollTop 比） */
  _rpx(v) { return v * this._winW() / 750; },

  /**
   * 量出每张卡在**文档里**的顶端位置。
   * ⚠️ 不能直接拿 rect.top + scrollTop：已经钉住（sticky）的卡片，rect.top 是它
   *    被钉住的位置，不是自然位置 —— 滚一段再量就会把整条基准线算歪。
   *    所以只在「一张都还没钉住」时记录首卡的自然位置（_baseTop），
   *    之后一律用「上一张的位置 + 上一张的高度 + 间距」往下推 ——
   *    高度不受 sticky 影响，这样即使正在堆叠 / 刚展开某张卡（高度变了）也量得准。
   */
  _measureStack(after) {
    const q = wx.createSelectorQuery();
    if (q.in) q.in(this);
    q.selectAll('.nt-wrap').boundingClientRect();
    q.selectViewport().scrollOffset();
    q.exec((res) => {
      const rects = (res && res[0]) || [];
      const st = Number((res && res[1] && res[1].scrollTop) || 0);
      if (!rects.length) { this._tops = null; if (after) after(); return; }
      if (!this._passed) this._baseTop = rects[0].top + st;   // 首卡自然位置（此时它没被钉住）
      const gap = this._rpx(16);   // .nt-item 的 margin-top
      const tops = [];
      let acc = this._baseTop || 0;
      for (let i = 0; i < rects.length; i += 1) {
        tops[i] = acc;
        acc += (rects[i].height || 0) + gap;
      }
      this._tops = tops;
      if (after) after();
    });
  },

  /**
   * 按当前滚动位置重算「谁在堆里、第几层」。
   * 只有**堆的张数变了**才 setData（滚动过程中绝大多数帧都是空操作，
   * 否则每帧一次 setData 会把滚动拖垮）。
   */
  _applyPile(scrollTop) {
    const list = this.data.list || [];
    const tops = this._tops;
    if (!tops || tops.length !== list.length) return;
    const st = Number(scrollTop) || 0;
    let passed = 0;
    if (list.length > STACK_MIN) {
      const line = st + this._rpx(STACK_TOP_RPX);
      while (passed < tops.length && tops[passed] <= line) passed += 1;
    }
    if (passed === this._passed) return;
    this._passed = passed;

    const patch = {};
    const from = Math.max(0, passed - MAX_STACK);
    for (let i = 0; i < list.length; i += 1) {
      if (list[i].flying) continue;                     // 正在飞向回收站的卡片不参与
      const was = String(list[i].wrapStyle || '').indexOf('sticky') >= 0;
      if (i >= from && i < passed) {
        const d = passed - 1 - i;                       // 0 = 最上面那层
        patch['list[' + i + '].wrapStyle'] =
          'position:sticky;top:' + (STACK_TOP_RPX - d * STACK_STEP_RPX) + 'rpx'
          + ';z-index:' + (MAX_STACK - d)
          + ';transform:scale(' + (1 - d * STACK_SCALE).toFixed(3) + ')'
          + ';transform-origin:50% 0;opacity:' + (1 - d * STACK_DIM).toFixed(2);
      } else if (was) {
        patch['list[' + i + '].wrapStyle'] = '';
      }
    }
    if (Object.keys(patch).length) this.setData(patch);
  },

  /** 卡片高度变了（展开 / 收起正文）→ 等动画播完再量一次，否则堆叠会错位 */
  _restackSoon() {
    clearTimeout(this._stackTimer);
    this._stackTimer = setTimeout(() => { this._restack(); }, FOLD_MS + 30);
  },

  /** 重新量卡片位置并按当前滚动位置重算堆叠（_passed 不变时 _applyPile 会自己空转） */
  _restack() {
    if (!this._tops) return;
    this._measureStack(() => this._applyPile(this._lastScroll || 0));
  },

  onPageScroll(e) {
    const st = Number(e.scrollTop) || 0;
    this._lastScroll = st;
    this._applyPile(st);
  },

  /**
   * 展开 / 收起正文（需求⑥：只有估算超过 3 行的通知才渲染这个按钮）
   * ----------------------------------------------------------------
   * v0.7.13 要求「高度和文字**同步**展开、下方内容自然下移」，所以不能再像第一版那样
   * 只切一个 class（line-clamp 一摘，高度瞬间跳到位，下面整块跟着弹一下）。
   * 现在的做法是**测出真实高度再过渡过去**：
   *   ① 先摘掉 line-clamp（内容恢复自然高度）—— 此刻 max-height 仍是折叠值，视觉零变化；
   *   ② 量出内容真实高度（px → rpx）；
   *   ③ 把 max-height 从折叠值过渡到实测值 —— 高度连续变化，文字被连续「揭开」，
   *      卡片下面的「确认收到 / 回执 / 下一条通知」自然跟着下移。
   * 收起反向同理，等动画播完再把 line-clamp 挂回去（省略号回来）——
   * **提前挂回去会让内容高度被钉死在 3 行，收起动画直接消失**（这是踩过的坑，别回退）。
   *
   * ⚠️ 全程只改这一项的标量字段（路径 setData），**绝不重建 list 数组** ——
   *    数组重建会替换卡片内的节点，子元素 tap 随之丢失（同左滑卡片「按钮全失效」的坑）
   */
  onToggleFold(e) {
    const index = Number(e.currentTarget.dataset.index);
    const item = this.data.list[index];
    if (!item || !item.fold) return;
    if (item.expanded) this._collapseFold(index);
    else this._expandFold(index);
  },

  /** 展开：摘 clamp → 量高度 → 过渡过去 */
  _expandFold(index) {
    // ① 摘掉 line-clamp（max-height 还是折叠值，所以这一步看不到任何变化）
    this.setData({ ['list[' + index + '].clamped']: false }, () => {
      this._measureBody(index, (rpx) => {
        const patch = { ['list[' + index + '].expanded']: true };
        // 量不到（极端情况：节点还没渲染 / 基础库异常）就退化成「直接展开」，
        // 宁可没动画，也不能把正文卡在 3 行里出不来
        if (rpx) patch['list[' + index + '].bodyH'] = rpx;
        this.setData(patch);
        this._restackSoon();
      });
    });
  },

  /** 收起：高度过渡回折叠值，动画结束后再把 line-clamp 挂回去 */
  _collapseFold(index) {
    this.setData({
      ['list[' + index + '].bodyH']: notice.FOLD_H_RPX,
      ['list[' + index + '].expanded']: false
    });
    this._clampTimers = this._clampTimers || {};
    clearTimeout(this._clampTimers[index]);
    this._clampTimers[index] = setTimeout(() => {
      this.setData({ ['list[' + index + '].clamped']: true });
      this._restack();     // 收起后卡片变矮，堆叠位置要重新量
    }, FOLD_MS);
  },

  /**
   * 量第 index 条正文的**自然高度**（px → rpx，带 4rpx 余量防末行被切半个像素）。
   * 用 selectAll + 下标取值，避免为了「能选中某一条」去拼动态 class
   * （`class="nt-c-{{item.id}}"` 会被 check-wxss 判成「用了但没定义的 class」）。
   */
  _measureBody(index, cb) {
    const q = wx.createSelectorQuery();
    if (q.in) q.in(this);
    q.selectAll('.nt-content').boundingClientRect();
    q.exec((res) => {
      const rects = (res && res[0]) || [];
      const r = rects[index];
      const h = r && r.height;
      if (!h) { cb(0); return; }
      cb(Math.ceil(h * 750 / this._winW()) + 4);
    });
  },

  /** 屏幕宽度（rpx ↔ px 换算用；拿不到时按 375 兜底，只影响动画终值的 1~2rpx） */
  _winW() {
    if (this.__winW) return this.__winW;
    let w = 0;
    try {
      const info = (wx.getWindowInfo && wx.getWindowInfo()) || wx.getSystemInfoSync();
      w = Number(info && info.windowWidth) || 0;
    } catch (e) { w = 0; }
    this.__winW = w || 375;
    return this.__winW;
  },

  onUnload() {
    const t = this._clampTimers || {};
    Object.keys(t).forEach((k) => clearTimeout(t[k]));
    this._clampTimers = {};
    clearTimeout(this._flyTimer);   // 飞入动画的收尾定时器（页面已销毁还 setData 会报错）
    clearTimeout(this._stackTimer); // 展开正文后重新量高度的定时器
    clearTimeout(this._viewerTimer); // 图片查看器关闭动画的收尾定时器
  },

  /* ---------------- 左滑手势（露出删除区） ---------------- */
  onSwipeStart(e) {
    const t = e.touches[0];
    const id = Number(e.currentTarget.dataset.id);
    const index = Number(e.currentTarget.dataset.index);
    // 先收起其它已展开的卡片
    if (this._openId && this._openId !== id) {
      const i = (this.data.list || []).findIndex(x => x.id === this._openId);
      if (i >= 0) this.setData({ ['list[' + i + '].offset']: 0, ['list[' + i + '].swiping']: false });
      this._openId = null;
    }
    const item = this.data.list[index];
    this._swipe = {
      id, index,
      startX: t.clientX,
      startY: t.clientY,
      startOffset: (item && item.offset) || 0
    };
    if (item) this.setData({ ['list[' + index + '].swiping']: true });
  },

  onSwipeMove(e) {
    if (!this._swipe) return;
    const t = e.touches[0];
    const dx = t.clientX - this._swipe.startX;
    const dy = t.clientY - this._swipe.startY;
    // 纵向为主时交给页面滚动，不处理；只有横向滑动才移动卡片
    if (Math.abs(dx) < Math.abs(dy)) return;
    let offset = this._swipe.startOffset + dx;
    if (offset > 0) offset = 0;
    if (offset < -BTN_WIDTH) offset = -BTN_WIDTH;
    this.setData({ ['list[' + this._swipe.index + '].offset']: offset });
  },

  onSwipeEnd() {
    if (!this._swipe) return;
    const s = this._swipe;
    this._swipe = null;
    const item = this.data.list[s.index];
    const offset = (item && item.offset) || 0;
    let target = 0;
    // 滑过一半就吸附展开，否则回弹收起
    if (offset <= -BTN_WIDTH / 2) {
      target = -BTN_WIDTH;
      this._openId = s.id;
    } else {
      target = 0;
      if (this._openId === s.id) this._openId = null;
    }
    this.setData({
      ['list[' + s.index + '].swiping']: false,
      ['list[' + s.index + '].offset']: target
    });
  },

  /**
   * 在线文档链接（业务域名配不了第三方域名 —— 校验文件要放到对方域名根目录）：
   * - docs.qq.com（腾讯文档）→ 跳「腾讯文档」小程序，可直达该文档；
   * - kdocs.cn（金山文档/WPS）→ **不跳小程序**。金山文档小程序没有「直达指定文档」的
   *   公开路径（官方只开放 OAuth 授权页），且其「最近」列表只显示用户自己打开过的文档 ——
   *   接收同学没打开过这篇文档，跳过去也找不到。改为复制链接 + 弹窗引导：
   *   粘贴发给文件传输助手/好友后点开（微信内可直接看），或用浏览器打开；
   * - 其它 https 域名 → 内置 web-view（需已配置业务域名，失败页有复制兜底）。
   */
  onLink(e) {
    const url = String(e.currentTarget.dataset.url || '');
    if (!url) return;
    if (/^https:\/\/docs\.qq\.com\//i.test(url)) {
      wx.navigateToMiniProgram({
        appId: 'wxd45c635d754dbf59', // 腾讯文档小程序
        path: 'pages/detail/detail?url=' + encodeURIComponent(url),
        fail: (r) => {
          if (/cancel/i.test(String((r && r.errMsg) || ''))) return; // 用户点了取消
          this._copyLink(url);
        }
      });
      return;
    }
    if (/^https:\/\/(www\.)?kdocs\.cn\//i.test(url)) {
      wx.setClipboardData({
        data: url,
        success: () => {
          wx.showModal({
            title: '金山文档链接',
            content: '金山文档暂不支持在小程序内直接打开，链接已复制。可粘贴发给文件传输助手或好友后点开，也可以在浏览器中打开。',
            showCancel: false,
            confirmText: '知道了'
          });
        }
      });
      return;
    }
    wx.navigateTo({ url: '/pages/webview/index?url=' + encodeURIComponent(url) });
  },

  /** 跳转失败（非用户取消）时的兜底：复制链接到浏览器打开 */
  _copyLink(url) {
    wx.setClipboardData({ data: url, success: () => util.toast('已复制链接，可在浏览器打开') });
  },

  /** 开启微信服务通知（一次性订阅，点一次得 1 条额度） */
  onRemind() {
    if (this.data.remindOn) { util.toast('已开启'); return; }
    if (!subscribe.noticeReady()) {
      util.toast('通知提醒待模板上线');
      return;
    }
    subscribe.requestNotice().then((r) => {
      if (!r.ok) { util.toast('未授权订阅消息，可稍后重试'); return; }
      wx.setStorageSync('noticeRemindOn', 1);
      util.toast('已开启通知提醒');
      this._refreshSubTip();  // 已开启 → 顶部提示条整行隐藏
    });
  },

  /**
   * 清空全部历史通知（仅超管）：删除所有通知与回执记录、不可恢复。
   * 用于清理开发期发的测试通知；配合「绑定后才显示」口径双保险。
   */
  onClearAll() {
    wx.showModal({
      title: '清空全部通知？',
      content: '将删除所有通知及回执记录，对全班生效且不可恢复。用于清理测试数据，请确认。',
      confirmText: '清空',
      confirmColor: '#F53F3F',
      success: (res) => {
        if (!res.confirm) return;
        api.clearNotices({ confirm: true }, { loading: '清空中' })
          .then((r) => {
            util.toast('已清空 ' + ((r && r.cleared) || 0) + ' 条通知');
            this.load();
          })
          .catch(() => {});
      }
    });
  },

  /* ---------------- 图片查看器（v0.7.14，截图②） ---------------- */

  /** 点缩略图：量出它在视口里的真实位置，作为 shared-element 动画的起点 */
  onViewImages(e) {
    const nid = Number(e.currentTarget.dataset.nid);
    const i = Number(e.currentTarget.dataset.i);
    const card = (this.data.list || []).find(x => x.id === nid);
    if (!card || !(card.images || []).length) return;
    const q = wx.createSelectorQuery();
    q.select('#nimg-' + nid + '-' + i).boundingClientRect();
    q.exec((res) => {
      const r = (res && res[0]) || null;
      if (!r || !r.width) { this._openViewer(card.images, i, null); return; }
      this._openViewer(card.images, i, { left: r.left, top: r.top, w: r.width, h: r.height });
    });
  },

  /** 屏幕可用尺寸（px），用于把图片放大到「居中、留边、不超过 85% 屏高」 */
  _screen() {
    let w = 375, h = 667;
    try {
      const info = (wx.getWindowInfo && wx.getWindowInfo()) || wx.getSystemInfoSync();
      w = Number(info && info.windowWidth) || w;
      h = Number(info && info.windowHeight) || h;
    } catch (e) {}
    return { w, h };
  },

  /** 计算全屏目标矩形（px，视口坐标） */
  _viewerTarget(from) {
    const s = this._screen();
    const margin = 24 * s.w / 750;
    const tw = s.w - 2 * margin;
    const aspect = (from && from.h && from.w) ? (from.h / from.w) : 1;
    let th = tw * aspect;
    const maxH = s.h * 0.85;
    if (th > maxH) th = maxH;
    return { left: (s.w - tw) / 2, top: (s.h - th) / 2, w: tw, h: th };
  },

  /**
   * 打开查看器。from = 缩略图视口矩形（null 表示量不到，降级为「直接全屏、无过渡」）。
   * 分两拍 setData：第 1 拍把移动层瞬移贴到缩略图位置（viewerAnim=false，无过渡），
   * 第 2 拍（下一帧）挂 anim 并给目标值 → 过渡真的跑起来。两拍合并成一次会瞬移（踩过的坑）。
   */
  _openViewer(images, index, from) {
    if (!from || !from.w) {
      const t = this._viewerTarget(null);
      this.setData({
        viewerShow: true, viewerImages: images, viewerIndex: index, viewerFrom: null,
        viewerAnim: false, viewerBg: 1,
        viewerStyle: 'position:fixed;left:' + t.left + 'px;top:' + t.top + 'px;width:' + t.w + 'px;height:' + t.h + 'px;'
      });
      return;
    }
    this._viewerFrom = from;   // 关闭时缩回到这个位置（查看期间已用 page-meta 锁滚动，位置不会漂）
    this.setData({
      viewerShow: true, viewerImages: images, viewerIndex: index, viewerFrom: from,
      viewerAnim: false, viewerBg: 0,
      viewerStyle: 'position:fixed;left:' + from.left + 'px;top:' + from.top + 'px;width:' + from.w + 'px;height:' + from.h + 'px;'
    }, () => {
      const t = this._viewerTarget(from);
      this.setData({
        viewerAnim: true, viewerBg: 1,
        viewerStyle: 'position:fixed;left:' + t.left + 'px;top:' + t.top + 'px;width:' + t.w + 'px;height:' + t.h + 'px;'
      });
    });
  },

  /** 关闭：反向缩回缩略图位置，背景淡出，动画播完再摘掉整个查看器 */
  onViewerClose() {
    if (!this.data.viewerShow) return;
    const from = this._viewerFrom || this.data.viewerFrom;
    if (!from || !from.w) { this.setData({ viewerShow: false }); return; }
    this.setData({
      viewerAnim: true, viewerBg: 0,
      viewerStyle: 'position:fixed;left:' + from.left + 'px;top:' + from.top + 'px;width:' + from.w + 'px;height:' + from.h + 'px;'
    });
    clearTimeout(this._viewerTimer);
    this._viewerTimer = setTimeout(() => this.setData({ viewerShow: false }), 300);
  },

  /** 多图时切换上一张（钳制在范围内） */
  onViewerPrev() {
    const n = this.data.viewerImages.length;
    if (n < 2) return;
    let i = this.data.viewerIndex - 1;
    if (i < 0) i = n - 1;
    this.setData({ viewerIndex: i });
  },

  /** 多图时切换下一张 */
  onViewerNext() {
    const n = this.data.viewerImages.length;
    if (n < 2) return;
    let i = this.data.viewerIndex + 1;
    if (i >= n) i = 0;
    this.setData({ viewerIndex: i });
  }
});
