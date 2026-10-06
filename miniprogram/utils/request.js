/**
 * 云开发统一请求层
 * - 统一 cloud.init
 * - 统一 envelope 解包（{errCode:0,data} / {errCode!==0,errMsg}）
 * - 统一错误提示与鉴权事件广播
 */
const ENV_ID = require('./config').ENV_ID;

let inited = false;
function cloudInit() {
  if (inited || typeof wx === 'undefined' || !wx.cloud) return;
  wx.cloud.init({ env: ENV_ID, traceUser: true });
  inited = true;
}

const bus = {};
function on(evt, fn) {
  (bus[evt] = bus[evt] || []).push(fn);
}
function emit(evt, payload) {
  (bus[evt] || []).forEach(fn => {
    try { fn(payload); } catch (e) { console.error('[bus]', evt, e); }
  });
}

function mkErr(errCode, errMsg, data) {
  const e = new Error(errMsg || '请求失败');
  e.errCode = errCode;
  e.errMsg = errMsg;
  e.data = data === undefined ? null : data;
  return e;
}

/**
 * 调用云函数
 * @param {string} name   云函数名
 * @param {string} action 动作
 * @param {object} payload 业务参数
 * @param {object} opt    { toast:boolean 默认 true, loading:string|false }
 */
function call(name, action, payload, opt) {
  cloudInit();
  payload = payload || {};
  opt = opt || {};
  const needToast = opt.toast !== false;
  const loadingText = opt.loading;

  if (loadingText) {
    wx.showLoading({ title: loadingText, mask: true });
  }

  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name,
      data: { action, payload },
      success(res) {
        if (loadingText) wx.hideLoading();
        const r = (res && res.result) || {};
        if (r.errCode === 0) {
          resolve(r.data === undefined ? null : r.data);
          return;
        }
        const err = mkErr(r.errCode, r.errMsg || '请求失败', r.data);
        if (r.errCode === 40001 || r.errCode === 40002) emit('needBind', err);
        if (needToast && r.errCode !== 40001 && r.errCode !== 40002) {
          wx.showToast({ title: err.errMsg || '请求失败', icon: 'none', duration: 2000 });
        }
        reject(err);
      },
      fail(e) {
        if (loadingText) wx.hideLoading();
        const raw = (e && e.errMsg) || '';
        // ⚠️ 2026-10-05：原先这里是
        //   `/cloud|network|fail/i.test(msg) ? '网络异常，请稍后重试' : msg`
        // 而 wx.cloud.callFunction 的 errMsg **几乎总含 'fail'**（request:fail timeout 等）
        // ⇒ 永远命中前一分支 ⇒ 真实原因（超时？云函数不存在？基础库不支持？）被无条件吞掉，
        //    连续三轮排查「网络异常」都拿不到真因就是这里害的。
        // 现在：把原始 errMsg **原样透出**（只对完全空的情况兜底），
        // 并 console.error 落日志。基础库版本问题（3.x 老版本 callFunction 行为差异）
        // 也只有这样才看得见。
        const detail = raw || '请求失败（未返回错误信息）';
        console.error('[request] callFunction fail:', name, action, raw, e);
        const err = mkErr(-1, detail);
        if (needToast) wx.showToast({ title: err.errMsg, icon: 'none', duration: 2500 });
        reject(err);
      }
    });
  });
}

/** 上传本地文件到云存储 */
function uploadFile(cloudPath, filePath) {
  cloudInit();
  return wx.cloud.uploadFile({ cloudPath, filePath }).then(r => r.fileID);
}

/** 取云存储临时访问链接 */
function getTempFileURL(fileList) {
  cloudInit();
  const list = Array.isArray(fileList) ? fileList : [fileList];
  if (!list.length) return Promise.resolve([]);
  return wx.cloud.getTempFileURL({ fileList: list }).then(r => {
    const map = {};
    (r.fileList || []).forEach(it => {
      if (it.status === 0) map[it.fileID] = it.tempFileURL;
    });
    return map;
  });
}

module.exports = { ENV_ID, cloudInit, call, on, emit, uploadFile, getTempFileURL };
