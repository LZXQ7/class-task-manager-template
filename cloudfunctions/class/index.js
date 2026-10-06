/**
 * 云函数：class —— 班级管理（多班级 §43）
 * action: list / detail / create / update / setActive
 *
 * 权限模型：
 *   - list：超管 / 辅导员看全部启用班级；普通用户只看自己班级（绑定态）
 *   - detail：超管 / 辅导员可看任意班；普通用户只看本班
 *   - create：仅超级管理员 / 辅导员（「新建班级」放宽到辅导员）
 *   - update：名称可由超管 / 辅导员修改（改名应用到全部成员，因为成员引用 class_id）；
 *             学期 / 周数 / 绑定开关 / 大节时间等敏感字段仍仅超管
 *   - setActive：仅超级管理员
 *   - delete：超管 / 辅导员，仅可删除「无人班级」（有成员则拒绝，避免账号 orphan）
 *
 * 班级口令 join_token 与邀请码 invite_code 由服务端生成并保证全局唯一，
 * 前端新建班级时只需给 name / term_start / total_weeks。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { getPool } = require('./common/db');
const guard = require('./common/guard');
const { BizError, ok, fail } = require('./common/resp');

const DEFAULT_PERIODS = [
  { period: 1, start: '08:00', end: '09:40' },
  { period: 2, start: '10:05', end: '11:45' },
  { period: 3, start: '14:00', end: '15:40' },
  { period: 4, start: '16:00', end: '17:40' },
  { period: 5, start: '19:00', end: '20:40' }
];

function maskRow(r) {
  return {
    id: r.id,
    name: r.name,
    joinToken: r.join_token,
    inviteCode: r.invite_code,
    termStart: typeof r.term_start === 'string' ? r.term_start.slice(0, 10) : r.term_start,
    totalWeeks: r.total_weeks,
    bindOpen: r.bind_open !== 0,
    isActive: r.is_active !== 0,
    periodTime: (() => {
      try { return typeof r.period_time === 'string' ? JSON.parse(r.period_time) : (r.period_time || []); }
      catch (e) { return []; }
    })()
  };
}

/** 生成唯一邀请码：CLS26A + 两位序号（保证不与已有冲突） */
async function nextInviteCode(pool) {
  const [rows] = await pool.query("SELECT invite_code FROM `class` WHERE invite_code LIKE 'CLS26A%' ORDER BY invite_code DESC");
  let max = 1; // id=1 占用 CLS26A01
  for (const r of rows) {
    const m = /^CLS26A(\d+)$/.exec(String(r.invite_code || ''));
    if (m) max = Math.max(max, Number(m[1]));
  }
  let n = max + 1;
  // 跳过已被占用（理论上不会，但兜底）
  for (let i = 0; i < 100; i++) {
    const code = 'CLS26A' + String(n).padStart(2, '0');
    const [dup] = await pool.query('SELECT id FROM `class` WHERE invite_code = ? LIMIT 1', [code]);
    if (!dup.length) return code;
    n += 1;
  }
  throw new BizError(50001, '邀请码分配失败');
}

/** 生成唯一班级口令：6 位数字，不与任何班级口令/邀请码冲突 */
async function nextJoinToken(pool) {
  for (let i = 0; i < 100; i++) {
    const token = String(Math.floor(100000 + Math.random() * 900000));
    const [dup] = await pool.query('SELECT id FROM `class` WHERE join_token = ? OR invite_code = ? LIMIT 1', [token, token]);
    if (!dup.length) return token;
  }
  throw new BizError(50001, '口令分配失败');
}

const routes = {
  /** 班级列表：超管/辅导员看全部启用班；普通用户只看本班 */
  list: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const pool = getPool();
      const me = ctx.member || ctx.realMember;
      const isSuperNow = guard.isSuper(me);
      const isCounselorNow = guard.isCounselor(me);
      let sql = 'SELECT * FROM `class`';
      const args = [];
      if (isSuperNow) {
        if (!payload.all) sql += ' WHERE is_active = 1';
      } else if (isCounselorNow) {
        // v0.7.16：教职工只看到自己被绑定的班级（staff_class；无映射回退主班）
        const ids = await guard.staffClassIds(pool, me);
        if (!ids.length) return [];
        sql += ' WHERE is_active = 1 AND id IN (' + ids.map(() => '?').join(',') + ')';
        args.push.apply(args, ids);
      } else {
        sql += ' WHERE id = ?';
        args.push(guard.classIdOf(ctx));
      }
      sql += ' ORDER BY id';
      const [rows] = await pool.query(sql, args);
      return rows.map(maskRow);
    }
  },

  /** 班级详情：超管/辅导员可跨班，普通用户仅本班 */
  detail: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const pool = getPool();
      const me = ctx.member || ctx.realMember;
      const cid = Number(payload.classId) || guard.classIdOf(ctx);
      if (cid !== guard.classIdOf(ctx) && !(guard.isSuper(me) || guard.isCounselor(me))) {
        throw new BizError(40003, '仅超级管理员或辅导员可查看其它班级');
      }
      const [rows] = await pool.query('SELECT * FROM `class` WHERE id = ? LIMIT 1', [cid]);
      if (!rows.length) throw new BizError(41001, '班级不存在');
      return maskRow(rows[0]);
    }
  },

  /** 新建班级（仅超管 / 辅导员） */
  create: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = ctx.member || ctx.realMember;
      if (!(guard.isSuper(me) || guard.isCounselor(me))) {
        throw new BizError(40003, '仅超级管理员或辅导员可新建班级');
      }
      const name = String(payload.name || '').trim();
      if (!name || name.length > 64) throw new BizError(41001, '班级名不能为空且不超过 64 字');
      const termStart = String(payload.termStart || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(termStart)) throw new BizError(41001, '开学日期格式应为 YYYY-MM-DD');
      const totalWeeks = Math.min(Math.max(Number(payload.totalWeeks) || 16, 1), 40);
      const pool = getPool();
      // 班级名唯一（同一名称视为重复，避免误建）
      const [dupName] = await pool.query('SELECT id FROM `class` WHERE name = ? LIMIT 1', [name]);
      if (dupName.length) throw new BizError(41001, '该班级名已存在');
      const joinToken = await nextJoinToken(pool);
      const inviteCode = await nextInviteCode(pool);
      let periodTime = DEFAULT_PERIODS;
      if (payload.periodTime) {
        try {
          const parsed = typeof payload.periodTime === 'string' ? JSON.parse(payload.periodTime) : payload.periodTime;
          if (Array.isArray(parsed) && parsed.length) periodTime = parsed;
        } catch (e) { /* 用默认 */ }
      }
      const [r] = await pool.query(
        `INSERT INTO \`class\` (name, join_token, invite_code, term_start, total_weeks, bind_open, period_time, is_active)
         VALUES (?, ?, ?, ?, ?, 1, ?, 1)`,
        [name, joinToken, inviteCode, termStart, totalWeeks, JSON.stringify(periodTime)]
      );
      const [row] = await pool.query('SELECT * FROM `class` WHERE id = ? LIMIT 1', [r.insertId]);
      return maskRow(row[0]);
    }
  },

  /**
   * 更新班级：名称可由超管 / 辅导员修改（改名会应用到全部成员，因为成员引用 class_id）；
   * 学期 / 周数 / 绑定开关 / 大节时间等敏感字段仍仅超管可改。
   */
  update: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = ctx.member || ctx.realMember;
      const isSuper = guard.isSuper(me);
      const superOrCounselor = isSuper || guard.isCounselor(me);
      const cid = Number(payload.classId);
      if (!cid) throw new BizError(41001, '参数错误');
      const pool = getPool();
      const [rows] = await pool.query('SELECT * FROM `class` WHERE id = ? LIMIT 1', [cid]);
      if (!rows.length) throw new BizError(41001, '班级不存在');
      const sets = [];
      const args = [];
      if (payload.name !== undefined) {
        if (!superOrCounselor) throw new BizError(40003, '仅超级管理员或辅导员可修改班级名');
        const name = String(payload.name).trim();
        if (!name || name.length > 64) throw new BizError(41001, '班级名不能为空且不超过 64 字');
        const [dupName] = await pool.query('SELECT id FROM `class` WHERE name = ? AND id != ? LIMIT 1', [name, cid]);
        if (dupName.length) throw new BizError(41001, '该班级名已存在');
        sets.push('name = ?'); args.push(name);
      }
      if (payload.termStart !== undefined) {
        if (!isSuper) throw new BizError(40003, '仅超级管理员可修改学期');
        const termStart = String(payload.termStart).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(termStart)) throw new BizError(41001, '开学日期格式应为 YYYY-MM-DD');
        sets.push('term_start = ?'); args.push(termStart);
      }
      if (payload.totalWeeks !== undefined) {
        if (!isSuper) throw new BizError(40003, '仅超级管理员可修改学期周数');
        const totalWeeks = Math.min(Math.max(Number(payload.totalWeeks) || 16, 1), 40);
        sets.push('total_weeks = ?'); args.push(totalWeeks);
      }
      if (payload.bindOpen !== undefined) {
        if (!isSuper) throw new BizError(40003, '仅超级管理员可修改绑定开关');
        sets.push('bind_open = ?'); args.push(payload.bindOpen ? 1 : 0);
      }
      if (payload.periodTime !== undefined) {
        if (!isSuper) throw new BizError(40003, '仅超级管理员可修改大节时间');
        let pt = payload.periodTime;
        try { if (typeof pt === 'string') pt = JSON.parse(pt); } catch (e) { pt = null; }
        if (!Array.isArray(pt) || !pt.length) throw new BizError(41001, '大节时间格式错误');
        sets.push('period_time = ?'); args.push(JSON.stringify(pt));
      }
      if (!sets.length) throw new BizError(41001, '没有可更新的字段');
      args.push(cid);
      await pool.query('UPDATE `class` SET ' + sets.join(', ') + ' WHERE id = ?', args);
      const [row] = await pool.query('SELECT * FROM `class` WHERE id = ? LIMIT 1', [cid]);
      return maskRow(row[0]);
    }
  },

  /** 停用 / 启用班级（仅超管）：停用后该班不再参与排班、不能新绑定 */
  setActive: {
    auth: { needSuper: true },
    handler: async (payload) => {
      const cid = Number(payload.classId);
      if (!cid) throw new BizError(41001, '参数错误');
      const active = payload.active ? 1 : 0;
      const pool = getPool();
      const [rows] = await pool.query('SELECT * FROM `class` WHERE id = ? LIMIT 1', [cid]);
      if (!rows.length) throw new BizError(41001, '班级不存在');
      await pool.query('UPDATE `class` SET is_active = ? WHERE id = ?', [active, cid]);
      return { id: cid, isActive: !!active };
    }
  },

  /**
   * 删除班级（超管 / 辅导员）：仅可删除「无人班级」。
   * 有成员则拒绝，避免成员 class_id 悬空导致账号 orphan / 全应用崩溃。
   */
  delete: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = ctx.member || ctx.realMember;
      if (!(guard.isSuper(me) || guard.isCounselor(me))) {
        throw new BizError(40003, '仅超级管理员或辅导员可删除班级');
      }
      const cid = Number(payload.classId);
      if (!cid) throw new BizError(41001, '参数错误');
      const pool = getPool();
      const [rows] = await pool.query('SELECT * FROM `class` WHERE id = ? LIMIT 1', [cid]);
      if (!rows.length) throw new BizError(41001, '班级不存在');
      const [cnt] = await pool.query('SELECT COUNT(*) AS c FROM member WHERE class_id = ?', [cid]);
      const memberCount = Number((cnt[0] && cnt[0].c) || 0);
      if (memberCount > 0) {
        throw new BizError(41001, '该班级还有 ' + memberCount + ' 名成员，不可删除（请先移除或转班后再删）');
      }
      await pool.query('DELETE FROM `class` WHERE id = ?', [cid]);
      console.log(JSON.stringify({ fn: 'class', action: 'delete', classId: cid, name: rows[0].name, operator: me.id }));
      return { id: cid, name: rows[0].name, memberCount };
    }
  },

  /**
   * 随机重置班级口令（超管 / 辅导员）。
   * 旧口令立即失效；入班码的 scene 就是口令，所以重置后重新生成的二维码会带新口令，
   * 扫码即可自动填入（已发出去的旧二维码将无法再解析）。
   */
  randomToken: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = ctx.member || ctx.realMember;
      if (!(guard.isSuper(me) || guard.isCounselor(me))) {
        throw new BizError(40003, '仅超级管理员或辅导员可重置口令');
      }
      const cid = Number(payload.classId);
      if (!cid) throw new BizError(41001, '参数错误');
      const pool = getPool();
      const [rows] = await pool.query('SELECT * FROM `class` WHERE id = ? LIMIT 1', [cid]);
      if (!rows.length) throw new BizError(41001, '班级不存在');
      const token = await nextJoinToken(pool);
      await pool.query('UPDATE `class` SET join_token = ? WHERE id = ?', [token, cid]);
      console.log(JSON.stringify({ fn: 'class', action: 'randomToken', classId: cid, operator: me.id }));
      return { id: cid, joinToken: token, name: rows[0].name };
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
    if (route.auth && route.auth.needSuper) guard.requireSuper(ctx);
    const data = await route.handler(payload, ctx);
    return ok(data);
  } catch (e) {
    if (e && e.errCode) return fail(e.errCode, e.errMsg, e.data);
    console.error('[class] unhandled', action, e);
    return fail(50000, '服务开小差了，请稍后重试');
  }
};
