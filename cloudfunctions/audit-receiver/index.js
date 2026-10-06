/**
 * 云函数：audit-receiver —— 微信内容安全异步审核结果接收端（开发文档 8.2 #11 / 14.3）
 * mp 后台「消息推送」→ 云函数接收，绑定本函数。
 * Event=wxa_media_check：按 trace_id 更新 attachment；isrisky=1 → BLOCKED + 删源文件。
 * 必须快速 ack（5s 内），只做单行 UPDATE。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { getPool } = require('./common/db');

function pick(obj, keys) {
  const out = {};
  keys.forEach(k => { if (obj[k] !== undefined) out[k] = obj[k]; });
  return out;
}

exports.main = async (event) => {
  const pool = getPool();
  try {
    let evt = event;
    if (typeof evt === 'string') {
      try { evt = JSON.parse(evt); } catch (e) { evt = {}; }
    }
    // 部分推送会把数据包在 data / Data 字段
    if (evt && evt.data && typeof evt.data === 'string') {
      try { evt = JSON.parse(evt.data); } catch (e) { /* 保持原样 */ }
    }
    const eventName = (evt && (evt.Event || evt.event || '')) + '';
    if (eventName.toLowerCase().indexOf('media_check') < 0 && !(evt && evt.trace_id)) {
      // URL 校验等其它消息直接 ack
      console.log('[audit-receiver] ignored event', eventName);
      return { errcode: 0, errmsg: 'ok' };
    }
    const traceId = evt.trace_id || evt.traceId || '';
    const risky = String(evt.isrisky || evt.is_risky || '0') === '1';
    if (!traceId) return { errcode: 0, errmsg: 'ok' };

    const [rows] = await pool.query('SELECT id, file_id, audit_status FROM attachment WHERE audit_trace = ? LIMIT 1', [traceId]);
    const att = rows[0];
    if (!att) return { errcode: 0, errmsg: 'ok' };
    if (att.audit_status !== 'AUDITING') return { errcode: 0, errmsg: 'ok' };

    if (risky) {
      await pool.query("UPDATE attachment SET audit_status = 'BLOCKED' WHERE id = ?", [att.id]);
      try { await cloud.deleteFile({ fileList: [att.file_id] }); } catch (e) { /* 忽略 */ }
    } else {
      await pool.query("UPDATE attachment SET audit_status = 'PASS' WHERE id = ?", [att.id]);
    }
    console.log(JSON.stringify({ fn: 'audit-receiver', traceId, risky, attachmentId: att.id }));
    return { errcode: 0, errmsg: 'ok' };
  } catch (e) {
    console.error('[audit-receiver] error', e);
    // 仍 ack，避免微信重试风暴；错误由 hourly 兜底扫描处理
    return { errcode: 0, errmsg: 'ok' };
  }
};
