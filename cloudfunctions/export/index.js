/**
 * 云函数：export —— 本周值日 CSV 导出（开发文档 8.2 #9）
 * BOM 头保证 Excel 打开中文不乱码；上传云存储 export/{week}_duty.csv，签发临时链接。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { getPool } = require('./common/db');
const guard = require('./common/guard');
const week = require('./common/week');
const { BizError, ok, fail } = require('./common/resp');

const STATUS_TEXT = {
  PENDING: '待完成', ONGOING: '进行中', DONE: '已完成',
  LEAVE: '已请假', SWAPPED_OUT: '已换出', EXPIRED: '待补录'
};

const routes = {
  weekCsv: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const admin = guard.isAdmin(ctx.member);
      const classId = guard.classIdOf(ctx);
      const wk = Number(payload.week);
      if (!wk) throw new BizError(41001, '参数错误');
      const pool = getPool();
      const cfg = await week.getConfig(pool, classId);
      const periods = week.periodMap(cfg);
      // 同学仅可导出已发布周
      const [pub] = await pool.query('SELECT status FROM schedule_publish WHERE class_id = ? AND week = ?', [classId, wk]);
      const published = !!(pub[0] && pub[0].status === 'PUBLISHED');
      if (!admin && !published) throw new BizError(41001, '本周排班尚未发布，无法导出');

      const [rows] = await pool.query(
        `SELECT d.*, s.day_of_week, s.period, c.name AS courseName, c.room, m.name AS memberName, m.group_tag
           FROM duty d
           JOIN session s ON s.id = d.session_id
           JOIN course c ON c.id = s.course_id
           JOIN member m ON m.id = d.member_id
          WHERE d.class_id = ? AND d.week = ?
          ORDER BY d.class_date, s.period`, [classId, wk]
      );
      // 临时调课后的真实节次：duty 表不含节次，得靠 resolveSlot 解析才准
      const shifts = await week.loadSessionShifts(pool, classId);
      rows.forEach((d) => {
        const slot = week.resolveSlot(d.session_id, d.day_of_week, d.period, wk, shifts);
        if (slot) d.period = slot.period;
      });
      rows.sort((a, b) => {
        const da = String(a.class_date).slice(0, 10);
        const db = String(b.class_date).slice(0, 10);
        return (da < db ? -1 : da > db ? 1 : a.period - b.period);
      });
      const head = ['日期', '星期', '节次', '时间', '课程', '教室', '分组课', '姓名', '所属组', '状态'];
      const lines = [head.join(',')];
      for (const d of rows) {
        const date = String(d.class_date).slice(0, 10);
        const p = periods[d.period] || {};
        const eff = week.effectiveStatus(d, periods);
        const row = [
          date,
          '周' + '一二三四五六日'[week.weekdayOf(date) - 1],
          '第' + d.period + '节',
          (p.start || '') + '-' + (p.end || ''),
          d.courseName,
          d.room || '',
          d.group_scope ? d.group_scope + ' 组' : '全体',
          d.memberName,
          d.group_tag,
          STATUS_TEXT[eff] || eff
        ].map(v => '"' + String(v).replace(/"/g, '""') + '"');
        lines.push(row.join(','));
      }
      const csv = '\uFEFF' + lines.join('\r\n');
      const cloudPath = 'export/' + wk + '_duty.csv';
      await cloud.uploadFile({ cloudPath, fileContent: Buffer.from(csv, 'utf8') });
      const res = await cloud.getTempFileURL({ fileIdList: [cloudPath] });
      const url = ((res.fileList || [])[0] || {}).tempFileURL || '';
      console.log(JSON.stringify({ fn: 'export', action: 'weekCsv', member: me.id, week: wk, rows: rows.length }));
      return { fileId: cloudPath, url, rows: rows.length };
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
    console.error('[export] unhandled', action, e);
    return fail(50000, '服务开小差了，请稍后重试');
  }
};
