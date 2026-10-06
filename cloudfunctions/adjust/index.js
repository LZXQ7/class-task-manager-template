/**
 * 云函数：adjust —— 换班 / 请假（开发文档 8.2 #6 / 7.5 状态机）
 * 原因仅预设 chips（COURSE/SICK/INTERN/OTHER），无自由文本。
 * action: swapCandidates / applySwap / applyLeave / listMine / pendingList / confirm / cancel
 *         + leaveBoard / addLeave / cancelLeave（1.0.5 需求④ 班委代登记请假）
 *
 * 换班确认权（2026-09-24 调整）：
 *   超级管理员「换人」= schedule.reassign，直接替换、无需申请（可还原）；
 *   普通成员「申请换班」= applySwap，落 PENDING_ADMIN，由**超级管理员**确认或拒绝。
 *   成员之间不再互相确认（历史 PENDING_PEER 数据仍兼容）。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { getPool } = require('./common/db');
const guard = require('./common/guard');
const week = require('./common/week');
const { BizError, ok, fail } = require('./common/resp');

const REASONS = ['COURSE', 'SICK', 'INTERN', 'OTHER'];
const EXPIRE_HOURS = 24;

const STATUS_TEXT = {
  PENDING_PEER: 'PENDING_PEER',
  PENDING_ADMIN: 'PENDING_ADMIN',
  DONE: 'DONE',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED'
};

/* ---------------- 1.0.5 需求④ 请假登记用的常量与工具 ---------------- */

/** 测试账号学号前缀（与 member/index.js 的 TEST_NO_PREFIX 逐字一致） */
const TEST_NO_PREFIX = '2608057499';
/**
 * 「排除测试账号」的 SQL 片段。
 * ⚠️ 必须**同时**带 `group_tag <> 'X'`（占位学号 STAFF 会顶坏前缀匹配，见 MEMORY）——
 *    调用侧自己拼 alias 时也别漏（notTest('m') + 各 SQL 里的 m.group_tag <> 'X'）。
 */
const notTest = (alias) => (alias ? alias + '.' : '') + "student_no NOT LIKE '" + TEST_NO_PREFIX + "%'";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 单次请假最长天数（含首尾）：防手滑选成跨学期 */
const LEAVE_MAX_DAYS = 31;

/** 归一化 YYYY-MM-DD；非法返回 ''（绝不放行 '2026-9-1' 这种能过 SQL 但语义不明的写法） */
function normDate(v) {
  const s = String(v == null ? '' : v).slice(0, 10);
  if (!DATE_RE.test(s)) return '';
  return Number.isFinite(Date.parse(s + 'T00:00:00Z')) ? s : '';
}

/** [a, b] 的天数（含首尾）；参数非法返回 Infinity（调用方据此拒绝） */
function spanDays(a, b) {
  const ta = Date.parse(a + 'T00:00:00Z');
  const tb = Date.parse(b + 'T00:00:00Z');
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return Infinity;
  return Math.round((tb - ta) / 86400000) + 1;
}

async function loadSwap(pool, swapId) {
  const [rows] = await pool.query('SELECT * FROM swap_request WHERE id = ?', [swapId]);
  return rows[0] || null;
}

const routes = {
  /** 候选：同组 ACTIVE、当日无值日、未请假，按 duty_count 升序 */
  swapCandidates: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const dutyId = Number(payload.dutyId);
      const classId = guard.classIdOf(ctx);
      const pool = getPool();
      const [duties] = await pool.query(
        `SELECT d.*, s.group_scope FROM duty d JOIN session s ON s.id = d.session_id WHERE d.id = ? AND d.class_id = ?`, [dutyId, classId]
      );
      const duty = duties[0];
      if (!duty) throw new BizError(41001, '值日不存在');
      const classDate = String(duty.class_date).slice(0, 10);
      const scope = duty.group_scope;
      const args = ['ACTIVE', classId];
      let sql = 'SELECT id, name, group_tag, duty_count, last_duty_at, student_no FROM member WHERE status = ? AND class_id = ? AND id != ? AND duty_off = 0';
      args.push(me.id);
      if (scope) { sql += ' AND group_tag = ?'; args.push(scope); }
      const [members] = await pool.query(sql + ' ORDER BY duty_count, id', args);
      const [leaves] = await pool.query(
        "SELECT member_id FROM leave_request WHERE class_id = ? AND status = 'APPROVED' AND start_date <= ? AND end_date >= ?",
        [classId, classDate, classDate]
      );
      const onLeave = new Set(leaves.map(l => l.member_id));
      const [busy] = await pool.query(
        "SELECT DISTINCT member_id FROM duty WHERE class_id = ? AND class_date = ? AND status != 'SWAPPED_OUT'", [classId, classDate]
      );
      const busySet = new Set(busy.map(b => b.member_id));
      return members
        .filter(m => !onLeave.has(m.id) && !busySet.has(m.id))
        .map(m => ({ id: m.id, name: m.name, groupTag: m.group_tag, seq: week.seqOf(m.student_no), dutyCount: m.duty_count || 0, lastDutyAt: m.last_duty_at || null }));
    }
  },

  applySwap: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const dutyId = Number(payload.dutyId);
      const toMemberId = Number(payload.toMemberId);
      const reason = REASONS.includes(payload.reason) ? payload.reason : 'OTHER';
      const classId = guard.classIdOf(ctx);
      const pool = getPool();
      const [duties] = await pool.query('SELECT * FROM duty WHERE id = ? AND class_id = ?', [dutyId, classId]);
      const duty = duties[0];
      if (!duty) throw new BizError(41001, '值日不存在');
      if (duty.member_id !== me.id) throw new BizError(40003, '仅能调整自己的值日');
      if (!['PENDING', 'ONGOING', 'EXPIRED'].includes(duty.status)) throw new BizError(41001, '该值日当前不可调整');
      // 不可重复发起
      const [dup] = await pool.query(
        "SELECT id FROM swap_request WHERE duty_id = ? AND from_member = ? AND status IN ('PENDING_PEER','PENDING_ADMIN')", [dutyId, me.id]
      );
      if (dup.length) throw new BizError(41001, '该值日已有待确认的申请');
      /**
       * 超管兜底：换人走 schedule.reassign（直接原地替换），不应产生「待确认」孤儿申请。
       * 前端已对超管隐藏「申请换班」按钮，这里再兜底一次 —— 万一有旧版/其它入口调到本接口，
       * 直接原地换人并落 DONE + duty_reassign（与 confirm(agree) 同一套做法），避免红点/待确认计数被孤儿请求污染。
       */
      if (guard.isSuper(me)) {
        const classDate = String(duty.class_date).slice(0, 10);
        try {
          await pool.query(
            "UPDATE duty SET member_id = ?, source = 'MANUAL', status = 'PENDING', done_at = NULL WHERE id = ?",
            [toMemberId, dutyId]
          );
        } catch (e) {
          throw new BizError(41001, '对方该时段已有值日，无法换入');
        }
        await pool.query('UPDATE member SET duty_count = duty_count + 1, last_duty_at = ? WHERE id = ?', [classDate, toMemberId]);
        await pool.query('UPDATE member SET duty_count = GREATEST(duty_count - 1, 0) WHERE id = ?', [me.id]);
        await pool.query(
          'INSERT INTO duty_log (duty_id, operator_id, action, from_member, to_member) VALUES (?,?,?,?,?)',
          [dutyId, me.id, 'SWAP', me.id, toMemberId]
        );
        const [rec] = await pool.query(
          `INSERT INTO duty_reassign (duty_id, new_duty_id, session_id, week, from_member, to_member, operator_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [dutyId, dutyId, duty.session_id, duty.week, me.id, toMemberId, me.id]
        );
        const [r] = await pool.query(
          `INSERT INTO swap_request (duty_id, type, from_member, to_member, reason, status, expire_at)
           VALUES (?, 'SWAP', ?, ?, ?, 'DONE', ?)`,
          [dutyId, me.id, toMemberId, reason, week.addMinutes(EXPIRE_HOURS * 60)]
        );
        console.log(JSON.stringify({ fn: 'adjust', action: 'applySwap', superDirect: true, member: me.id, swapId: r.insertId }));
        return { swapId: r.insertId, direct: true };
      }
      /**
       * 普通成员申请换人 = 需要**超级管理员确认**（不再是「被邀请人确认」）。
       * 成员只负责「提名想换给谁」，成不成由生活委员拍板；因此状态直接落 PENDING_ADMIN。
       */
      const [r] = await pool.query(
        `INSERT INTO swap_request (duty_id, type, from_member, to_member, reason, status, expire_at)
         VALUES (?, 'SWAP', ?, ?, ?, 'PENDING_ADMIN', ?)`,
        [dutyId, me.id, toMemberId, reason, week.addMinutes(EXPIRE_HOURS * 60)]
      );
      console.log(JSON.stringify({ fn: 'adjust', action: 'applySwap', member: me.id, swapId: r.insertId }));
      return { swapId: r.insertId };
    }
  },

  /** 请假：本人提交即时生效（MVP 简化，管理员订阅知会），值日置 LEAVE 并写 leave_request */
  applyLeave: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const dutyIds = (payload.dutyIds || []).map(Number).filter(Boolean);
      const startDate = String(payload.startDate || '').slice(0, 10);
      const endDate = String(payload.endDate || '').slice(0, 10);
      const reason = REASONS.includes(payload.reason) ? payload.reason : 'OTHER';
      if (!dutyIds.length || !startDate || !endDate) throw new BizError(41001, '参数错误');
      const classId = guard.classIdOf(ctx);
      const pool = getPool();
      let swapId = null;
      for (const dutyId of dutyIds) {
        const [rows] = await pool.query('SELECT * FROM duty WHERE id = ? AND class_id = ?', [dutyId, classId]);
        const duty = rows[0];
        if (!duty || duty.member_id !== me.id) continue;
        if (!['PENDING', 'ONGOING', 'EXPIRED'].includes(duty.status)) continue;
        const [r] = await pool.query(
          `INSERT INTO swap_request (class_id, duty_id, type, from_member, start_date, end_date, reason, status, expire_at)
           VALUES (?, ?, 'LEAVE', ?, ?, ?, ?, 'DONE', ?)`,
          [classId, dutyId, me.id, startDate, endDate, reason, week.addMinutes(EXPIRE_HOURS * 60)]
        );
        swapId = r.insertId;
        await pool.query("UPDATE duty SET status = 'LEAVE' WHERE id = ?", [dutyId]);
        // ⚠️ class_id 必须显式写：线上 leave_request.class_id 是 NOT NULL DEFAULT 1 ——
        //    靠默认值只在 1 班正确，2/3/9/10 班会串班（而 schedule 侧按 class_id 过滤请假，
        //    串班后这条请假在排班里查不到 ⇒ 已请假的人照样被排到值日）。
        await pool.query(
          `INSERT INTO leave_request (class_id, member_id, swap_id, start_date, end_date, status)
           VALUES (?, ?, ?, ?, ?, 'APPROVED')`, [classId, me.id, r.insertId, startDate, endDate]
        );
        await pool.query(
          'INSERT INTO duty_log (duty_id, operator_id, action, from_member) VALUES (?,?,?,?)',
          [dutyId, me.id, 'LEAVE', me.id]
        );
      }
      if (!swapId) throw new BizError(41001, '没有可请假的有效值日');
      return { swapId };
    }
  },

  listMine: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const pool = getPool();
      const cfg = await week.getConfig(pool, guard.classIdOf(ctx));
      const periods = week.periodMap(cfg);
      const [rows] = await pool.query(
        `SELECT sr.*, d.class_date, d.status AS dutyStatus, d.session_id, d.week,
                s.period AS sp, s.day_of_week, s.kind AS sessionKind, c.name AS courseName, c.room,
                mf.name AS fromName, mt.name AS toName, d.member_id AS dutyMemberId
           FROM swap_request sr
           JOIN duty d ON d.id = sr.duty_id
           JOIN session s ON s.id = d.session_id
           JOIN course c ON c.id = s.course_id
           JOIN member mf ON mf.id = sr.from_member
           LEFT JOIN member mt ON mt.id = sr.to_member
          WHERE sr.from_member = ? OR sr.to_member = ?
          ORDER BY sr.id DESC LIMIT 50`, [me.id, me.id]
      );
      // 临时调课后的真实节次（duty 表不含节次，需按 session_shift 解析）
      const shifts = await week.loadSessionShifts(pool, guard.classIdOf(ctx));
      return rows.map((r) => {
        const slot = week.resolveSlot(r.session_id, r.day_of_week, r.sp, r.week, shifts);
        const period = slot ? slot.period : r.sp;
        return {
          swapId: r.id,
          type: r.type,
          direction: r.from_member === me.id ? 'out' : 'in',
          dutyId: r.duty_id,
          dutyStatus: week.effectiveStatus({ status: r.dutyStatus, class_date: r.class_date, period }, periods),
          classDate: String(r.class_date).slice(0, 10),
          period,
          // CLEAN = 保洁课次（打扫 410）→ 前端显示「18点前」而不是「第 4 节」
          kind: r.sessionKind || 'COURSE',
          courseName: r.courseName,
          room: r.room || '',
          reason: r.reason,
          fromName: r.fromName,
          toName: r.toName || '',
          status: STATUS_TEXT[r.status] || r.status,
          createdAt: String(r.created_at).slice(0, 16),
          expireAt: String(r.expire_at).slice(0, 16)
        };
      });
    }
  },

  /**
   * 待确认的换班申请（超级管理员）。
   * 成员申请换人后落 PENDING_ADMIN，只有这里能看到「全班待我拍板」的申请。
   */
  pendingList: {
    auth: { scheduleAuth: true },
    handler: async (payload, ctx) => {
      const pool = getPool();
      // v0.7.25：超管默认看**全部班** —— 主页红点计数（duty.today）是全库口径，
      // 这里却按 classIdOf(ctx) 只看「当前班」，跨班申请（如测试班）在「我的」页永远查不到，
      // 红点也因此永远不灭。两处口径必须一致：待确认列表 = 待确认计数。
      // 显式传 classId 仍可只看单班。
      // 需求 D：生活委员（非超管）**只能看本班** —— 超管的「默认全库」口径不适用，
      // 且即便显式传 classId 也只认本班（classIdOf 对非超管恒为本班，不可伪造）。
      const me = ctx.member || ctx.realMember;
      const targetClass = guard.isSuper(me)
        ? (payload.classId ? Number(payload.classId) : null)
        : guard.classIdOf(ctx);
      const classFilter = targetClass ? 'AND d.class_id = ?' : '';
      const [rows] = await pool.query(
        `SELECT sr.*, d.class_date, d.status AS dutyStatus, d.session_id, d.week,
                d.class_id, s.period AS sp, s.day_of_week, s.kind AS sessionKind,
                c.name AS courseName, c.room, cl.name AS className,
                mf.name AS fromName, mt.name AS toName
           FROM swap_request sr
           JOIN duty d ON d.id = sr.duty_id
           JOIN session s ON s.id = d.session_id
           JOIN course c ON c.id = s.course_id
           JOIN class cl ON cl.id = d.class_id
           JOIN member mf ON mf.id = sr.from_member
           LEFT JOIN member mt ON mt.id = sr.to_member
          WHERE sr.status = 'PENDING_ADMIN' AND sr.type = 'SWAP' ${classFilter}
          ORDER BY sr.id DESC LIMIT 50`,
        targetClass ? [targetClass] : []
      );
      // 临时调课映射按班各自加载（跨班列表不能只载当前班的 shifts）
      const classIds = [...new Set(rows.map((r) => Number(r.class_id)))];
      const shiftMap = {};
      for (const cid of classIds) {
        shiftMap[cid] = await week.loadSessionShifts(pool, cid);
      }
      return rows.map((r) => {
        const slot = week.resolveSlot(r.session_id, r.day_of_week, r.sp, r.week, shiftMap[Number(r.class_id)] || []);
        return {
          swapId: r.id,
          dutyId: r.duty_id,
          classId: Number(r.class_id),
          className: r.className || '',
          classDate: String(r.class_date).slice(0, 10),
          period: slot ? slot.period : r.sp,
          kind: r.sessionKind || 'COURSE',
          courseName: r.courseName,
          room: r.room || '',
          reason: r.reason,
          fromMemberId: r.from_member,
          fromName: r.fromName,
          toMemberId: r.to_member,
          toName: r.toName || '',
          createdAt: String(r.created_at).slice(0, 16)
        };
      });
    }
  },

  /**
   * 确认换班：**由超级管理员处理**（agree=true 生效换班 / false 拒绝）。
   * 成员之间不再互相确认 —— 申请提交时状态即为 PENDING_ADMIN。
   * 生效后同样写一条 duty_reassign，管理员点错了也能一键还原。
   */
  confirm: {
    auth: { scheduleAuth: true },
    handler: async (payload, ctx) => {
      const me = guard.requireScheduleAuth(ctx);
      const swapId = Number(payload.swapId);
      const agree = !!payload.agree;
      const pool = getPool();
      const swap = await loadSwap(pool, swapId);
      if (!swap) throw new BizError(41001, '申请不存在');
      if (!swap.to_member) throw new BizError(41001, '该申请没有指定替补');
      // PENDING_PEER 是改造前的历史状态，一并兼容
      if (!['PENDING_PEER', 'PENDING_ADMIN'].includes(swap.status)) throw new BizError(41001, '该申请已处理');
      // v0.7.25：按 duty_id 直接取，不再叠加 class_id = classIdOf(ctx) ——
      // 超管已过 guard.requireSuper（可跨班），原写法在「当前班 ≠ 申请所在班」时
      // 会 41001「原值日不存在」：列表修好后这里就成了第二个断点。
      const [duties] = await pool.query('SELECT * FROM duty WHERE id = ?', [swap.duty_id]);
      const duty = duties[0];
      if (!duty) throw new BizError(41001, '原值日不存在');
      // 需求 D：非超管（生活委员）只能处理**本班**申请。
      // 列表侧已按本班过滤，这里再卡一道 —— 否则可直接构造别班的 swapId 越权确认。
      if (!guard.isSuper(me) && Number(duty.class_id) !== guard.classIdOf(ctx)) {
        throw new BizError(40003, '只能处理本班的换班申请');
      }
      if (!agree) {
        await pool.query("UPDATE swap_request SET status = 'REJECTED' WHERE id = ?", [swapId]);
        return { status: 'REJECTED' };
      }
      const classDate = String(duty.class_date).slice(0, 10);
      // 生效：**原地换人**（与 schedule.reassign 同一套做法，一个课次只留一条值日记录）
      try {
        await pool.query(
          "UPDATE duty SET member_id = ?, source = 'MANUAL', status = 'PENDING', done_at = NULL WHERE id = ?",
          [swap.to_member, swap.duty_id]
        );
      } catch (e) {
        await pool.query("UPDATE swap_request SET status = 'REJECTED' WHERE id = ?", [swapId]);
        throw new BizError(41001, '对方该时段已有值日，无法换入');
      }
      await pool.query('UPDATE member SET duty_count = duty_count + 1, last_duty_at = ? WHERE id = ?', [classDate, swap.to_member]);
      await pool.query('UPDATE member SET duty_count = GREATEST(duty_count - 1, 0) WHERE id = ?', [swap.from_member]);
      await pool.query(
        'INSERT INTO duty_log (duty_id, operator_id, action, from_member, to_member) VALUES (?,?,?,?,?)',
        [swap.duty_id, me.id, 'SWAP', swap.from_member, swap.to_member]
      );
      // 与 schedule.reassign 共用同一套换人记录，管理员在值日详情里可以「还原」
      const [rec] = await pool.query(
        `INSERT INTO duty_reassign (duty_id, new_duty_id, session_id, week, from_member, to_member, operator_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [swap.duty_id, swap.duty_id, duty.session_id, duty.week, swap.from_member, swap.to_member, me.id]
      );
      await pool.query("UPDATE swap_request SET status = 'DONE' WHERE id = ?", [swapId]);
      return { status: 'DONE', reassignId: rec.insertId };
    }
  },

  cancel: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const swapId = Number(payload.swapId);
      const pool = getPool();
      const swap = await loadSwap(pool, swapId);
      if (!swap) throw new BizError(41001, '申请不存在');
      if (swap.from_member !== me.id) throw new BizError(40003, '仅申请人可撤销');
      if (!['PENDING_PEER', 'PENDING_ADMIN'].includes(swap.status)) throw new BizError(41001, '当前状态不可撤销');
      // 若请假已即时生效，撤销时恢复值日
      if (swap.type === 'LEAVE') {
        await pool.query("UPDATE duty SET status = 'PENDING' WHERE id = ? AND status = 'LEAVE'", [swap.duty_id]);
        await pool.query("UPDATE leave_request SET status = 'CANCELLED' WHERE swap_id = ?", [swapId]);
      }
      await pool.query("UPDATE swap_request SET status = 'CANCELLED' WHERE id = ?", [swapId]);
      return {};
    }
  },

  /* ================= 1.0.5 需求④：班委「请假登记」 =================
   * 与本人请假（applyLeave）的三点差别：
   *   ① **代他人登记**（班委替本班学生）；
   *   ② **按日期区间**登记，不挑具体值日行（学生下周请假也能提前登记）；
   *   ③ 不写 swap_request —— 那是「本人申请」的载体，代登记不是学生本人的申请；
   *      且 swap_request.duty_id 是 NOT NULL，区间请假没有唯一 duty 可挂。
   * 值日侧：区间内状态为 PENDING/ONGOING 的行置 'LEAVE'（已完成/已请假的保持原状）。
   */

  /** 请假看板：某一天（默认今天）本班生效中的请假名单 + 计数（成员与分组页用） */
  leaveBoard: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      guard.requireLeaveView(ctx);
      const pool = getPool();
      const classId = await guard.resolveClassId(pool, ctx, payload);
      const date = normDate(payload.date) || week.todayStr();
      const [rows] = await pool.query(
        `SELECT l.id AS leaveId, l.member_id AS memberId, l.start_date, l.end_date,
                m.name, m.group_tag, m.student_no
           FROM leave_request l
           JOIN member m ON m.id = l.member_id
          WHERE l.class_id = ? AND l.status = 'APPROVED'
            AND l.start_date <= ? AND l.end_date >= ?
            AND m.class_id = ? AND m.status <> 'DISABLED'
            AND m.group_tag <> 'X' AND ${notTest('m')}
          ORDER BY m.student_no`,
        [classId, date, date, classId]
      );
      const list = rows.map(r => ({
        leaveId: Number(r.leaveId),
        memberId: Number(r.memberId),
        name: r.name,
        groupTag: r.group_tag,
        seq: String(r.student_no || '').slice(-2),
        startDate: week.dateStr(r.start_date),
        endDate: week.dateStr(r.end_date)
      }));
      return {
        date,
        list,
        stat: {
          leave: list.length,
          leaveA: list.filter(x => x.groupTag === 'A').length,
          leaveB: list.filter(x => x.groupTag === 'B').length
        }
      };
    }
  },

  /**
   * 首页请假卡 / 辅导员各班汇总（1.0.5 追加，需求①②）：
   *   · 辅导员（X 组）→ { mode:'counselor', classes:[{classId, className, leave}] }（其绑定范围内每班今日请假数）
   *   · 其它身份（班委 / 超管 / 学生）→ { mode:'class', classId, className, date, list, stat }（本班今日请假）
   * 权限 = requireLeaveView（辅导员可读不可写）；班级隔离走 resolveClassId。
   * 注意：本接口**只给汇总/查看**，登记与撤销仍是 addLeave / cancelLeave。
   */
  leaveSummary: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireLeaveView(ctx);
      const pool = getPool();
      const date = normDate(payload.date) || week.todayStr();
      if (guard.isCounselor(me)) {
        const ids = await guard.staffClassIds(pool, me);
        const classes = [];
        for (const cid of ids) {
          const [c] = await pool.query('SELECT name FROM `class` WHERE id = ?', [cid]);
          const [r] = await pool.query(
            "SELECT COUNT(*) AS n FROM leave_request l JOIN member m ON m.id = l.member_id " +
            "WHERE l.class_id = ? AND l.status = 'APPROVED' AND l.start_date <= ? AND l.end_date >= ? " +
            "AND m.group_tag <> 'X' AND " + notTest('m'),
            [cid, date, date]
          );
          classes.push({ classId: cid, className: c.length ? c[0].name : ('班级' + cid), leave: Number(r[0].n) || 0 });
        }
        return { mode: 'counselor', date, classes };
      }
      const classId = await guard.resolveClassId(pool, ctx, {});
      const [cl] = await pool.query('SELECT name FROM `class` WHERE id = ?', [classId]);
      const [rows] = await pool.query(
        `SELECT l.id AS leaveId, l.member_id AS memberId, l.start_date, l.end_date,
                m.name, m.group_tag, m.student_no
           FROM leave_request l
           JOIN member m ON m.id = l.member_id
          WHERE l.class_id = ? AND l.status = 'APPROVED'
            AND l.start_date <= ? AND l.end_date >= ?
            AND m.class_id = ? AND m.status <> 'DISABLED'
            AND m.group_tag <> 'X' AND ${notTest('m')}
          ORDER BY m.student_no`,
        [classId, date, date, classId]
      );
      const list = rows.map(r => ({
        leaveId: Number(r.leaveId),
        memberId: Number(r.memberId),
        name: r.name,
        groupTag: r.group_tag,
        seq: String(r.student_no || '').slice(-2),
        startDate: week.dateStr(r.start_date),
        endDate: week.dateStr(r.end_date)
      }));
      return {
        mode: 'class',
        classId,
        className: cl.length ? cl[0].name : '',
        date,
        list,
        stat: {
          leave: list.length,
          leaveA: list.filter(x => x.groupTag === 'A').length,
          leaveB: list.filter(x => x.groupTag === 'B').length
        }
      };
    }
  },

  addLeave: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireLeaveRegister(ctx);
      const classId = guard.classIdOf(ctx);
      const pool = getPool();
      const memberId = Number(payload.memberId);
      const startDate = normDate(payload.startDate);
      const endDate = normDate(payload.endDate);
      if (!memberId || !startDate || !endDate) throw new BizError(41001, '请选择同学与请假日期');
      if (endDate < startDate) throw new BizError(41001, '结束日期不能早于开始日期');
      if (spanDays(startDate, endDate) > LEAVE_MAX_DAYS) throw new BizError(41001, '单次请假最多 ' + LEAVE_MAX_DAYS + ' 天');
      // 目标必须是本班在读**学生**（教职工 / 测试账号 / 已停用一律拒绝）
      const [ms] = await pool.query(
        "SELECT id FROM member WHERE id = ? AND class_id = ? AND status <> 'DISABLED' AND group_tag <> 'X' AND " + notTest(''),
        [memberId, classId]
      );
      if (!ms.length) throw new BizError(41003, '只能给本班在读学生登记请假');
      // 幂等：同人同区间已生效 → 直接返回（重复提交不重复写，避免 BASH 重试/连点造成双写）
      const [dup] = await pool.query(
        "SELECT id FROM leave_request WHERE class_id = ? AND member_id = ? AND status = 'APPROVED' AND start_date = ? AND end_date = ?",
        [classId, memberId, startDate, endDate]
      );
      if (dup.length) return { leaveId: Number(dup[0].id), affected: 0, existed: true };
      // 区间内「还没值完」的值日 → 置 LEAVE
      const [duties] = await pool.query(
        "SELECT id FROM duty WHERE class_id = ? AND member_id = ? AND status IN ('PENDING','ONGOING') AND class_date BETWEEN ? AND ?",
        [classId, memberId, startDate, endDate]
      );
      const [ins] = await pool.query(
        "INSERT INTO leave_request (class_id, member_id, start_date, end_date, status) VALUES (?, ?, ?, ?, 'APPROVED')",
        [classId, memberId, startDate, endDate]
      );
      for (const d of duties) {
        await pool.query("UPDATE duty SET status = 'LEAVE' WHERE id = ?", [d.id]);
        await pool.query('INSERT INTO duty_log (duty_id, operator_id, action, from_member) VALUES (?,?,?,?)',
          [d.id, me.id, 'LEAVE', memberId]);
      }
      console.log(JSON.stringify({ fn: 'adjust', action: 'addLeave', by: me.id, target: memberId, startDate, endDate, affected: duties.length }));
      return { leaveId: Number(ins.insertId), affected: duties.length };
    }
  },

  /** 撤销代登记的请假：置 CANCELLED，并恢复**不被其它请假覆盖**的值日（对称） */
  cancelLeave: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireLeaveRegister(ctx);
      const classId = guard.classIdOf(ctx);
      const leaveId = Number(payload.leaveId);
      if (!leaveId) throw new BizError(41001, '参数错误');
      const pool = getPool();
      const [lr] = await pool.query('SELECT * FROM leave_request WHERE id = ? AND class_id = ?', [leaveId, classId]);
      const leave = lr[0];
      if (!leave) throw new BizError(41004, '请假记录不存在');
      if (leave.status !== 'APPROVED') throw new BizError(41001, '该请假已撤销');
      await pool.query("UPDATE leave_request SET status = 'CANCELLED' WHERE id = ?", [leaveId]);
      const from = week.dateStr(leave.start_date);
      const to = week.dateStr(leave.end_date);
      const [duties] = await pool.query(
        "SELECT id, class_date FROM duty WHERE class_id = ? AND member_id = ? AND status = 'LEAVE' AND class_date BETWEEN ? AND ?",
        [classId, leave.member_id, from, to]
      );
      let restored = 0;
      for (const d of duties) {
        const date = week.dateStr(d.class_date);
        // 同一天若仍被**另一条生效请假**覆盖（例如学生本人也请过）→ 不恢复，
        // 否则「撤一条」会把另一条请假的效力一起抹掉。
        const [other] = await pool.query(
          "SELECT id FROM leave_request WHERE class_id = ? AND member_id = ? AND status = 'APPROVED' AND start_date <= ? AND end_date >= ? LIMIT 1",
          [classId, leave.member_id, date, date]
        );
        if (other.length) continue;
        await pool.query("UPDATE duty SET status = 'PENDING' WHERE id = ? AND status = 'LEAVE'", [d.id]);
        await pool.query('INSERT INTO duty_log (duty_id, operator_id, action, from_member) VALUES (?,?,?,?)',
          [d.id, me.id, 'CANCEL', leave.member_id]);
        restored++;
      }
      console.log(JSON.stringify({ fn: 'adjust', action: 'cancelLeave', by: me.id, leaveId, restored }));
      return { restored };
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
    // 排班域（需求 D）：超管（可跨班）/ 生活委员（仅本班，班级来自 classIdOf）
    if (route.auth && route.auth.scheduleAuth) guard.requireScheduleAuth(ctx);
    const data = await route.handler(payload, ctx);
    return ok(data);
  } catch (e) {
    if (e && e.errCode) return fail(e.errCode, e.errMsg, e.data);
    console.error('[adjust] unhandled', action, e);
    return fail(50000, '服务开小差了，请稍后重试');
  }
};
