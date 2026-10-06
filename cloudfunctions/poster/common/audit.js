/**
 * 内容安全审核封装（开发文档 第 14 章）
 * - 文本：msgSecCheck v2（同步，入库前）
 * - 媒体：mediaCheckAsync v2（异步，先审后显）
 * 降级策略：
 * - 文本审核接口异常 → fail-open（开发期），错误码 87014 命中仍拦截
 * - 媒体送审接口异常 → 由 MEDIA_AUDIT 环境变量决定：auto_pass 置 PASS，否则 AUDITING + 24h cron 兜底 BLOCKED
 *   ⚠️ 上线前应将 MEDIA_AUDIT 设为 strict，并确认 mp 后台消息推送已绑定 audit-receiver
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

async function msgSecCheck(openid, content) {
  try {
    const res = await cloud.openapi.security.msgSecCheck({
      openid,
      scene: 2,
      version: 2,
      content: String(content || '').slice(0, 2500)
    });
    if (res && res.result && res.result.suggest && res.result.suggest !== 'pass') {
      return { pass: false, label: res.result.label };
    }
    return { pass: true };
  } catch (e) {
    if (e && (e.errCode === 87014 || e.errMsg && String(e.errMsg).indexOf('87014') >= 0)) {
      return { pass: false };
    }
    console.error('[audit] msgSecCheck error:', e && e.errCode, e && e.errMsg);
    return { pass: true, degraded: true };
  }
}

async function mediaCheckAsync(openid, mediaUrl, mediaType) {
  try {
    const res = await cloud.openapi.security.mediaCheckAsync({
      openid,
      scene: 3,
      version: 2,
      media_type: mediaType, // 1=音频 2=图片
      media_url: mediaUrl
    });
    return { traceId: (res && res.trace_id) || null };
  } catch (e) {
    console.error('[audit] mediaCheckAsync error:', e && e.errCode, e && e.errMsg);
    return { traceId: null, error: e };
  }
}

/** 媒体审核落库状态：strict 模式 AUDITING；auto_pass 模式（或送审成功）PASS */
function mediaAuditStatus(mode, traceId) {
  if (mode === 'auto_pass') return 'PASS';
  return traceId ? 'AUDITING' : 'AUDITING';
}

function getMediaAuditMode() {
  return String(process.env.MEDIA_AUDIT || 'strict').toLowerCase();
}

module.exports = { msgSecCheck, mediaCheckAsync, mediaAuditStatus, getMediaAuditMode };
