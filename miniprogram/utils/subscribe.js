/**
 * 微信订阅消息辅助（值日提醒）。
 *
 * 为什么单独抽一个模块：首页「提醒我」与「我的 → 开启微信提醒」两处都要发起授权，
 * 模板 ID 只能有一个来源（utils/config.js）。
 *
 * ⚠️ wx.requestSubscribeMessage 必须由用户点击触发（微信限制），
 *    不要在 onLoad / onShow 里自动调用。
 * ⚠️ 模板 ID 未配置时安全降级：不调用、不报错，返回 skipped。
 *
 * 关于「一次性订阅」：用户同意一次 = 获得 1 条发送额度。用户若勾选
 * 「总是保持以上选择，不再询问」，之后再点「开启微信提醒」会直接通过并再累积 1 条，
 * 因此提醒入口多放几个、让同学顺手点一下，比只放一个入口可靠得多。
 *
 * ⚠️ 值日提醒是**一天两条**（值日前一晚 21:00 预告 + 当天早上 07:00 再提醒，见
 *    cloudfunctions/cron-weekly 的 remindDuty），所以每人每天要消耗 **2** 条额度 ——
 *    「我的 → 值日微信提醒」在已开启后每次点击仍是「再攒 1 条」（`request()`），
 *    不要改成只提示「已开启」（那样额度永远攒不够，第二天早上那条必然 43101）。
 *    长期订阅（一次授权长期下发）只对政务/医疗/交通/金融/教育等类目开放，
 *    本小程序类目是「信息查询」，拿不到 —— 只能靠攒。
 */
const { SUBSCRIBE_TEMPLATE_ID, NOTICE_TEMPLATE_ID } = require('./config');

/** 班级通知模板是否已配置（未配置时发布照常，只是不推微信服务通知） */
function noticeReady() {
  return !!NOTICE_TEMPLATE_ID && typeof wx !== 'undefined' && !!wx.requestSubscribeMessage;
}

/**
 * 发起「班级通知」的订阅授权（必须在点击回调里调用）。
 * 与值日提醒同一个「一次订阅一条」的规则：同学点一次 = 服务端多 1 条推送额度。
 * @returns {Promise<{ok:boolean, skipped?:boolean, reason:string}>}
 */
function requestNotice() {
  if (!noticeReady()) return Promise.resolve({ ok: false, skipped: true, reason: 'no-template' });
  return new Promise((resolve) => {
    wx.requestSubscribeMessage({
      tmplIds: [NOTICE_TEMPLATE_ID],
      success: (res) => {
        const v = res && res[NOTICE_TEMPLATE_ID];
        resolve({ ok: v === 'accept', reason: String(v || 'unknown') });
      },
      fail: (err) => resolve({ ok: false, reason: String((err && err.errMsg) || 'fail') })
    });
  });
}

/** 模板是否已配置（未配置时入口应降级为「待上线」文案） */
function ready() {
  return !!SUBSCRIBE_TEMPLATE_ID && typeof wx !== 'undefined' && !!wx.requestSubscribeMessage;
}

/**
 * 发起订阅授权（必须在点击回调里调用）。
 * @returns {Promise<{ok:boolean, skipped?:boolean, reason:string}>}
 *   ok=true 表示用户本次同意，服务端因此获得 1 条发送额度
 */
function request() {
  if (!ready()) return Promise.resolve({ ok: false, skipped: true, reason: 'no-template' });
  return new Promise((resolve) => {
    wx.requestSubscribeMessage({
      tmplIds: [SUBSCRIBE_TEMPLATE_ID],
      success: (res) => {
        const v = res && res[SUBSCRIBE_TEMPLATE_ID];
        resolve({ ok: v === 'accept', reason: String(v || 'unknown') });
      },
      fail: (err) => resolve({ ok: false, reason: String((err && err.errMsg) || 'fail') })
    });
  });
}

/**
 * 发送一条测试提醒并弹窗回访「收到没」。
 *
 * 流程：调 sendFn（云函数 media/testRemind，向本人 openid 发值日提醒模板消息）
 *   → 发送成功：弹窗问「收到这条测试提醒了吗？」
 *   → 用户答「没收到」或发送失败（43101 = 无订阅额度 / 授权被关）：引导重新授权，
 *     点「重新开启」走一次 request() 补额度，成功后提示再点一次测试按钮验证。
 *
 * @param {Function} sendFn 返回 Promise<{sent:boolean, errCode?:number, errMsg?:string}>，一般传 () => api.testRemind()
 */
function runTest(sendFn) {
  return Promise.resolve()
    .then(sendFn)
    .then((r) => {
      if (r && r.sent) {
        wx.showModal({
          title: '测试提醒已发送',
          content: '请切到微信「服务通知」查看，收到这条测试提醒了吗？',
          confirmText: '收到了',
          cancelText: '没收到',
          success: (res) => { if (!res.confirm) _reEnableGuide({}); }
        });
      } else {
        _reEnableGuide(r || {});
      }
      return r || {};
    })
    .catch(() => {
      wx.showToast({ title: '发送失败，请稍后再试', icon: 'none' });
      return { sent: false };
    });
}

/** 「没收到」分支：说明原因并引导重新授权订阅 */
function _reEnableGuide(r) {
  const code = Number((r && r.errCode) || 0);
  let why;
  if (code === 43101) why = '你的订阅额度已用完或授权被关闭';
  else if (r && r.errMsg) why = '原因：' + String(r.errMsg);
  else why = '可能未完成订阅授权';
  wx.showModal({
    title: '没收到测试提醒？',
    content: why + '。点「重新开启」重新授权后，再点一次测试按钮验证。',
    confirmText: '重新开启',
    cancelText: '暂不',
    success: (res) => {
      if (!res.confirm) return;
      request().then((s) => {
        wx.showToast({ title: s.ok ? '已重新授权，可再测一次' : '未授权成功', icon: s.ok ? 'success' : 'none' });
      });
    }
  });
}

module.exports = { ready, request, noticeReady, requestNotice, runTest };
