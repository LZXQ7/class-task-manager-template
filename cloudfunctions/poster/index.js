/**
 * 云函数：poster —— 邀请码与入班小程序码（开发文档 8.2 #8 / 第 12 章）
 * action: getInviteCode / getQrcode
 *
 * 生成入班码的坑（2026-09-25 修）：
 *  ① `cloud.getTempFileURL` 只认 `cloud://...` 的 fileID，**不认 cloudPath**。
 *     旧代码把 `wxacode/xxx.png` 直接丢进去 → 取不到链接 → 前端拿到空 url，看着像「生成失败」。
 *     正确姿势：`uploadFile` 的返回值 `fileID` 拿去换临时链接；换不到时前端用 `cloud://` 直显也行。
 *  ② `getUnlimited` 的 `envVersion='release'` 要求**已有发布版本**；开发期会报 41030（invalid page）。
 *     所以先试首选版本，遇到「页面不存在 / 未发布」再换另一个版本重试，而不是直接失败。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { getPool } = require('./common/db');
const guard = require('./common/guard');
const week = require('./common/week');
const { BizError, ok, fail } = require('./common/resp');

/** 解析要操作的班级 id：默认本人班级；超管/辅导员可传 payload.classId 跨班生成入班码 */
function resolveClassId(payload, ctx) {
  if (payload.classId) {
    const cid = Number(payload.classId);
    if (cid && (guard.isSuper(ctx.member) || guard.isCounselor(ctx.member))) return cid;
  }
  return guard.classIdOf(ctx);
}

/** 该错误是否属于「页面不存在 / 未发布」——换 envVersion 重试才有意义 */
function isPageMissing(e) {
  const code = Number((e && e.errCode) || 0);
  const msg = String((e && (e.errMsg || e.message)) || '');
  return code === 41030 || msg.indexOf('41030') >= 0 || msg.indexOf('invalid page') >= 0;
}

const routes = {
  getInviteCode: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const pool = getPool();
      const cfg = await week.getConfig(pool, resolveClassId(payload, ctx));
      return { classId: cfg.classId, inviteCode: cfg.inviteCode, token: cfg.joinToken, className: cfg.name };
    }
  },

  /**
   * 入班小程序码。默认用本班邀请码作 scene、跳 `pages/bind/index`；
   * 传 scene/page 可生成自定义场景码（如语音通知扫码播放）。
   * @returns {{fileId:string, url:string, envVersion:string}} url 可能为空 —— 前端可退回用 fileId 显示
   */
  getQrcode: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const pool = getPool();
      const cfg = await week.getConfig(pool, resolveClassId(payload, ctx));
      const custom = String(payload.scene || '').trim();
      // 默认 scene = 班级口令（join_token）：扫码 → auth.resolveScene → 绑定页自动填入口令。
      // 口令可被「随机重置」，因此重置后重新生成的码会自动带新口令；invite_code 作兜底。
      const scene = custom ? custom.slice(0, 32) : (cfg.joinToken || cfg.inviteCode);
      const page = String(payload.page || (custom ? 'pages/home/index' : 'pages/bind/index')).replace(/^\//, '');
      const cloudPath = 'wxacode/' + scene.replace(/[^\w-]/g, '_') + '.png';

      // 首选版本：默认 release（正式版码，普通同学扫码才打得开）；可显式传 trial。
      const preferred = String(payload.envVersion || 'release') === 'trial' ? 'trial' : 'release';
      const order = preferred === 'release' ? ['release', 'trial'] : ['trial', 'release'];

      let buf = null;
      let used = '';
      let lastErr = null;
      for (const env of order) {
        try {
          const res = await cloud.openapi.wxacode.getUnlimited({
            scene: scene,
            page: page,
            // page 固定是 pages/bind/index（小程序里真实存在的页面），关闭版本存在性校验：
            // check_path=true 时「正式版未发布 / 目标版本没有这个 page」会报 41030，
            // 实测微信网关有时还会给 -604101（system error）而不是 41030 —— 直接关掉最稳。
            checkPath: false,
            envVersion: env,
            width: 430
          });
          /*
           * ⚠️ openapi 失败时**不一定抛异常**：它可能正常 resolve 一个
           * `{ errCode, errMsg }`。必须显式判 errCode，否则会被当成「返回里没有图片」
           * 而报出 "empty buffer" 这种看不出原因的错。
           */
          if (res && res.errCode) {
            const err = new Error(res.errMsg || ('errCode ' + res.errCode));
            err.errCode = res.errCode;
            err.errMsg = res.errMsg;
            throw err;
          }
          const b = res.buffer || (res.ContentType && res.body);
          if (!b) throw new Error('接口没有返回图片数据');
          buf = Buffer.from(b);
          used = env;
          break;
        } catch (e) {
          lastErr = e;
          console.error('[poster] getUnlimited ' + env + ' failed', (e && (e.errCode || e.errMsg || e.message)));
          // 2026-09-26 修：不再「非页面错误就 break」。实测未发布正式版时 release 码
          // 会报 -604101（system error），它不是 41030，旧逻辑会在这里直接放弃、
          // trial 版根本没机会试 —— 用户看到「入班码生成失败」。换 envVersion 重试
          // 的成本只是一次 API 调用（getUnlimited 无总量限制），两个版本都试完再报错。
        }
      }

      if (!buf) {
        const msg = String((lastErr && (lastErr.errMsg || lastErr.message)) || '未知错误').slice(0, 60);
        throw new BizError(50030, isPageMissing(lastErr)
          ? '小程序还没发布，暂时生成不了正式入班码；请先用上面的「班级口令 / 数字邀请码」让同学加入，正式版发布后会自动可用'
          : ('入班码生成失败（' + msg + '）；可先让同学用上面的口令 / 邀请码加入'));
      }

      const up = await cloud.uploadFile({ cloudPath, fileContent: buf });
      const fileId = (up && up.fileID) || cloudPath;
      let url = '';
      try {
        const r2 = await cloud.getTempFileURL({ fileIdList: [fileId] });
        url = ((r2.fileList || [])[0] || {}).tempFileURL || '';
      } catch (e) {
        // 拿不到临时链接不算失败：fileId 本身就能给 <image> 用
        console.error('[poster] getTempFileURL failed', (e && (e.errMsg || e.message)));
      }
      console.log(JSON.stringify({ fn: 'poster', action: 'getQrcode', classId: cfg.classId, env: used, fileId, hasUrl: !!url }));
      return { fileId, url, envVersion: used, cached: false };
    }
  }
};

exports.main = async (event) => {
  let action;
  try {
    action = event && event.action;
    const route = routes[action];
    if (!route) return fail(41001, '未知操作');
    const payload = (event && event.payload) || {};
    const ctx = await guard.getContext();
    if (route.auth && route.auth.needBind) guard.requireBind(ctx);
    if (route.auth && route.auth.needAdmin) guard.requireAdmin(ctx);
    const data = await route.handler(payload, ctx);
    return ok(data);
  } catch (e) {
    if (e && e.errCode) return fail(e.errCode, e.errMsg, e.data);
    console.error('[poster] unhandled', action, e);
    return fail(50000, '服务开小差了，请稍后重试');
  }
};
