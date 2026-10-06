/**
 * 云函数：duty —— 值日提醒所需的数据（开发文档 8.2 #5）
 * action: today / myStats / detail / noticeAudio
 *
 * 产品口径：本工具只做「值日提醒」，不做打卡、不收照片凭证。
 * 因此 detail 不再返回照片，前端也不再暴露完成/撤销入口。
 * confirm / undoConfirm 两个旧接口暂时保留在下方：历史库里存在 DONE 数据，
 * 且未来若恢复打卡可直接复用；前端已无任何调用点。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { getPool } = require('./common/db');
const guard = require('./common/guard');
const week = require('./common/week');
const { BizError, ok, fail } = require('./common/resp');

const DAY_MS = 86400000;
const EXPIRED_MAKEUP_DAYS = 3; // 补录窗口

/**
 * 值日状态的**分桶**（唯一来源）。
 * ⚠️ 「我的」页顶部数字（myStats）与弹层明细（myList）**必须**走同一套分桶 ——
 *    2026-09-29 修复：myStats 原来自己写 SQL 数 `duty.status` 列，而该列在库里
 *    **恒为 'PENDING'**（状态是**读时派生**的，见 week.effectiveStatus）→
 *    顶部显示「待值日 4 / 已结束 0」，弹层明细却是「3 / 1」，两处对不上。
 * @param {string} status week.effectiveStatus 派生的状态
 * @returns {'pending'|'past'|'other'}
 */
function dutyBucket(status) {
  if (status === 'PENDING' || status === 'ONGOING') return 'pending';
  if (status === 'EXPIRED' || status === 'DONE' || status === 'LEAVE') return 'past';
  return 'other'; // SWAPPED_OUT 等：这条值日已经不属于本人
}

/**
 * 「我的值日」派生明细 —— myList / myStats 的**唯一**数据来源。
 * 状态一律经 week.effectiveStatus 读时派生；`SWAPPED_OUT` 行整体剔除
 * （值日已被换走，不算本人的），因此恒有 termCount === pendingCount + expiredCount。
 * 禁止在别处另写一套过滤 / 计数。
 */
async function deriveMyDuties(pool, classId, memberId) {
  const cfg = await week.getConfig(pool, classId);
  const periods = week.periodMap(cfg);
  const shifts = await week.loadSessionShifts(pool);
  const [rows] = await pool.query(
    `SELECT d.id, d.session_id, d.class_date, d.week, d.status,
            s.kind AS sessionKind, s.day_of_week, s.period, s.group_scope,
            c.name AS courseName, c.room
       FROM duty d
       JOIN session s ON s.id = d.session_id
       JOIN course c ON c.id = s.course_id
      WHERE d.member_id = ?
      ORDER BY d.class_date, s.period`, [memberId]
  );
  const list = [];
  for (const d of rows) {
    const status = week.effectiveStatus(d, periods);
    if (dutyBucket(status) === 'other') continue; // 换走的行不计入本人值日
    const slot = week.resolveSlot(d.session_id, d.day_of_week, d.period, d.week, shifts)
      || { day: d.day_of_week, period: d.period };
    list.push({
      id: d.id,
      classDate: String(d.class_date).slice(0, 10),
      period: slot.period,
      // kind 取自 session（duty 表无此列，SQL 里已 AS sessionKind）
      kind: d.sessionKind || 'COURSE',
      courseName: d.courseName,
      room: d.room || '',
      groupScope: d.group_scope,
      status,
      periodTime: (d.sessionKind === 'CLEAN') ? null : (periods[slot.period] || null)
    });
  }
  return list;
}

const routes = {
  /** 首页聚合接口：我的今日值日 + 今日课次 + 待办数 + 未读语音通知 */
  today: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const pool = getPool();
      const classId = guard.classIdOf(ctx);
      const cfg = await week.getConfig(pool, classId);
      const periods = week.periodMap(cfg);
      const today = week.todayStr();
      const wk = week.currentWeek({ term_start: cfg.termStart, total_weeks: cfg.totalWeeks });
      // 临时调课：某节课这一周可能被取消或挪到别的日子 / 节次。
      // duty 表只存日期，节次与星期都要靠 resolveSlot 解析才准。
      const shifts = await week.loadSessionShifts(pool, classId);   // 按班取，避免别班的调课串进来

      const [myRows] = await pool.query(
        `SELECT d.*, s.day_of_week, s.period, s.group_scope, s.kind AS sessionKind, c.name AS courseName, c.room, c.teacher
           FROM duty d
           JOIN session s ON s.id = d.session_id
           JOIN course c ON c.id = s.course_id
          WHERE d.member_id = ? AND d.class_date = ?
          ORDER BY s.period LIMIT 1`, [me.id, today]
      );
      let myDuty = null;
      if (myRows.length) {
        const d = myRows[0];
        const slot = week.resolveSlot(d.session_id, d.day_of_week, d.period, d.week, shifts)
          || { day: d.day_of_week, period: d.period };
        // 同伴
        const [peers] = await pool.query(
          `SELECT m.name, m.group_tag FROM duty d JOIN member m ON m.id = d.member_id
            WHERE d.session_id = ? AND d.week = ? AND d.member_id != ? AND d.status != 'SWAPPED_OUT'`,
          [d.session_id, d.week, me.id]
        );
        myDuty = {
          id: d.id, dutyId: d.id, sessionId: d.session_id,
          classDate: today, period: slot.period, courseName: d.courseName,
          room: d.room || '', groupScope: d.group_scope,
          // CLEAN = 保洁课次（打扫 410）。前端据此把「第 4 节」显示成「18点前」。
          // ⚠️ kind 是 session 表的列（duty 表没有 kind 列），SQL 里必须显式取 s.kind AS sessionKind，
          //    绝不要写成 d.kind —— 那会报 1054 Unknown column（myList 曾因此整表报错）。
          kind: d.sessionKind || 'COURSE',
          status: week.effectiveStatus(d, periods),
          // 保洁不展示「第 4 节 16:00-17:40」：它挂在第 4 节只是为了有个排班位，
          // 真正的要求是「18 点前打扫完」，给上课时间反而误导。前端统一显示「18点前」。
          periodTime: (d.sessionKind === 'CLEAN') ? null : (periods[slot.period] || null),
          peers: peers.map(p => ({ name: p.name, groupTag: p.group_tag }))
        };
      }

      // 今日 / 明日全部课次（按周次 + 临时调课 + 校历 + 分组可见性过滤）
      // 排除保洁课次（kind='CLEAN'）：「打扫 410」不属于课程，只在值日页 / 手动排班板出现，
      // 不占首页「今日课次」的位置（用户 2026-09-24 要求）。
      // 注意：myDuty（首页 Hero）另有查询，保洁值日照常能被提示到，不受这里影响。
      // ⚠️ 必须按 `s.class_id` 过滤（v0.7.32 问题①）：`course`/`session` 在 migrate-multiclass.sql
      //    里加了 class_id，别班也各有自己的课表。这里曾漏掉该条件 ⇒ 首页「今日/明日课次」
      //    把**所有班**的课次混在一起（当时只有 2603 有课，于是人人看到 示例班级C 的课表）。
      const [sessions] = await pool.query(
        `SELECT s.id, s.day_of_week, s.period, s.week_rule, s.weeks, s.group_scope, c.name, c.room
           FROM session s JOIN course c ON c.id = s.course_id
          WHERE s.class_id = ? AND s.kind <> 'CLEAN'
          ORDER BY s.day_of_week, s.period`,
        [classId]
      );
      const myTag = me.group_tag;
      const cal = await week.loadCalendar(pool);

      /**
       * 取「某一天实际要上的课」。
       * 判据不是「星期几对上」，而是 **该课次的实际上课日期 === 目标日期**：
       *   · 临时调课（session_shift，按周生效）→ resolveSlot 给本周真实落位；
       *   · 校历放假（holiday kind=OFF）→ classDateOf 返回 null，当天自然一节课都没有；
       *   · 校历调课（day_shift 把某天的课整体挪走）→ classDateOf 返回挪过去的日期。
       * 旧实现只比了「星期几」，所以国庆这类「工作日放假」时首页照样把当天课次列出来
       * （用户 2026-09-25 反馈：节假日 / 无课当天应显示「今日无课」）。
       * 明日可能跨周（周日的明天是下周一），这里按目标日期重算周次，天然正确。
       */
      const sessionsOnDate = (targetDate) => {
        const targetWk = week.getWeek(cfg.termStart, targetDate);
        const out = [];
        sessions.forEach((s) => {
          if (!week.matchesWeeks(s.weeks, targetWk, s.week_rule)) return;
          const slot = week.resolveSlot(s.id, s.day_of_week, s.period, targetWk, shifts);
          if (!slot) return;                                        // 本周不上
          if (s.group_scope && myTag && s.group_scope !== myTag) return;
          if (week.classDateOf(cfg, targetWk, slot.day, cal) !== targetDate) return;
          out.push({
            sessionId: s.id, period: slot.period, name: s.name, room: s.room || '',
            groupScope: s.group_scope,
            periodTime: periods[slot.period] || null,
            isMine: myDuty ? myDuty.sessionId === s.id : false
          });
        });
        out.sort((a, b) => a.period - b.period);
        return out;
      };

      const todaySessions = sessionsOnDate(today);
      const tomorrow = week.fmtDate(new Date(Date.now() + DAY_MS));
      const tomorrowSessions = sessionsOnDate(tomorrow);

      // 待办：待我确认的换班 + 我发起进行中的。
      // 换班确认权归超级管理员（2026-09-24），所以超管看到的是「全班待拍板的申请」。
      // v0.7.25 两处修正：
      // ① JOIN duty —— swap_request 可能引用已被重建排班删掉的 duty（幽灵申请），
      //    这类申请永远无法被确认（confirm 按 duty_id 取不到原值日），计入只会让红点永远不灭；
      // ② 不再按班过滤 —— 与 adjust.pendingList（v0.7.25 起超管跨班可见）口径一致，
      //    否则「主页计数 > 0、待确认列表为空」。列表能看到的 = 计数能数到的。
      const superUser = guard.isSuper(me);
      const [pending] = await pool.query(
        superUser
          ? `SELECT COUNT(*) AS n FROM swap_request sr
              JOIN duty d ON d.id = sr.duty_id
              WHERE sr.status IN ('PENDING_PEER','PENDING_ADMIN')`
          : `SELECT COUNT(*) AS n FROM swap_request sr
              JOIN duty d ON d.id = sr.duty_id
              WHERE ((sr.to_member = ? AND sr.status = 'PENDING_PEER')
                 OR (sr.from_member = ? AND sr.status IN ('PENDING_PEER','PENDING_ADMIN')))`,
        superUser ? [] : [me.id, me.id]
      );

      // 未读语音通知（最近 5 条，过滤 BLOCKED 与已读；多班级：仅本班）
      const [notices] = await pool.query(
        `SELECT n.id, n.duration_ms, n.created_at, n.week, m.name AS publisherName, a.audit_status, a.file_id
           FROM notice n
           JOIN member m ON m.id = n.publisher_id
           JOIN attachment a ON a.id = n.audio_id
          WHERE n.class_id = ? AND a.audit_status != 'BLOCKED'
          ORDER BY n.id DESC LIMIT 5`, [classId]
      );
      let unreadNotice = null;
      for (const n of notices) {
        const [rd] = await pool.query('SELECT 1 FROM notice_read WHERE notice_id = ? AND member_id = ?', [n.id, me.id]);
        if (!rd.length) {
          let audioUrl = '';
          try {
            const t = await cloud.getTempFileURL({ fileIdList: [n.file_id] });
            const f = (t.fileList || [])[0];
            audioUrl = (f && f.tempFileURL) || '';
          } catch (e) { /* 取链失败不影响首页 */ }
          unreadNotice = {
            id: n.id,
            durationMs: n.duration_ms,
            publisherName: n.publisherName,
            createdAt: String(n.created_at).slice(0, 16),
            audioReady: n.audit_status === 'PASS',
            url: audioUrl,
            week: n.week || null
          };
          break;
        }
      }

      return {
        today,
        tomorrow,
        currentWeek: wk,
        myDuty,
        sessions: todaySessions,
        tomorrowSessions,
        pendingSwapCount: Number(pending[0].n) || 0,
        unreadNotice,
        isAdmin: guard.isAdmin(ctx.member),
        // 微信提醒「额度耗尽」标记（v0.7.15）：cron 发订阅消息吃到 43101 时由 cron-weekly 置 1。
        // 首页据此把提醒悬浮胶囊换成「微信提醒已失效，点此重新开启」，把同学拉回来再授权。
        member: { id: me.id, name: me.name, groupTag: me.group_tag, remindBlock: Number(me.remind_block) === 1 }
      };
    }
  },

  /** 确认完成（含补录：过期 ≤ 3 天）。前端已不调用，保留以兼容历史数据。 */
  confirm: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const admin = guard.isAdmin(ctx.member);
      const dutyId = Number(payload.dutyId);
      const classId = guard.classIdOf(ctx);
      const pool = getPool();
      const cfg = await week.getConfig(pool, classId);
      const periods = week.periodMap(cfg);
      const [rows] = await pool.query('SELECT * FROM duty WHERE id = ? AND class_id = ?', [dutyId, classId]);
      const duty = rows[0];
      if (!duty) throw new BizError(41001, '值日不存在');
      if (duty.member_id !== me.id && !admin) throw new BizError(40003, '仅能操作自己的值日');
      const eff = week.effectiveStatus(duty, periods);
      if (!['PENDING', 'ONGOING', 'EXPIRED'].includes(eff)) throw new BizError(41001, '当前状态不可确认');
      const dateStr = String(duty.class_date).slice(0, 10);
      const today = week.todayStr();
      if (eff === 'EXPIRED' && new Date(today + 'T00:00:00+08:00').getTime() - new Date(dateStr + 'T00:00:00+08:00').getTime() > EXPIRED_MAKEUP_DAYS * DAY_MS) {
        throw new BizError(40007, '已超过可补录时间');
      }
      await pool.query("UPDATE duty SET status = 'DONE', done_at = ? WHERE id = ?", [week.nowStamp(), dutyId]);
      await pool.query(
        'INSERT INTO duty_log (duty_id, operator_id, action, from_member) VALUES (?,?,?,?)',
        [dutyId, me.id, 'DONE', duty.member_id]
      );
      return {};
    }
  },

  /** 撤销完成：当日 23:59 前。前端已不调用，保留以兼容历史数据。 */
  undoConfirm: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const admin = guard.isAdmin(ctx.member);
      const dutyId = Number(payload.dutyId);
      const pool = getPool();
      const [rows] = await pool.query('SELECT * FROM duty WHERE id = ?', [dutyId]);
      const duty = rows[0];
      if (!duty) throw new BizError(41001, '值日不存在');
      if (duty.member_id !== me.id && !admin) throw new BizError(40003, '仅能操作自己的值日');
      if (duty.status !== 'DONE') throw new BizError(41001, '当前状态不可撤销');
      const doneDate = String(duty.done_at || '').slice(0, 10);
      if (doneDate !== week.todayStr()) throw new BizError(41001, '已过当日，不能撤销');
      await pool.query("UPDATE duty SET status = 'PENDING', done_at = NULL WHERE id = ?", [dutyId]);
      await pool.query(
        'INSERT INTO duty_log (duty_id, operator_id, action, from_member) VALUES (?,?,?,?)',
        [dutyId, me.id, 'UNDO', duty.member_id]
      );
      return {};
    }
  },

  /** 我的值日统计：本学期总次数 / 待值日 / 已结束（过去的日期） */
  myStats: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const classId = guard.classIdOf(ctx);
      const pool = getPool();
      // ⚠️ 必须与 myList 走同一条派生链（deriveMyDuties）—— 不要再自行 SQL 数 duty.status：
      //    该列在库里恒为 'PENDING'，直接 SUM 会得到「待值日 = 全部、已结束 = 0」。
      const list = await deriveMyDuties(pool, classId, me.id);
      let pendingCount = 0;
      let expiredCount = 0;
      for (const d of list) {
        const b = dutyBucket(d.status);
        if (b === 'pending') pendingCount++;
        else if (b === 'past') expiredCount++;
      }
      const [sw] = await pool.query(
        "SELECT COUNT(*) AS n FROM swap_request WHERE from_member = ? AND status IN ('PENDING_PEER','PENDING_ADMIN','DONE')", [me.id]
      );
      return {
        termCount: list.length,
        pendingCount,
        expiredCount,
        applyCount: Number(sw[0].n) || 0
      };
    }
  },

  /**
   * 我的值日明细列表（需求：「我的」页「待值日 / 已结束」数字可点开查看具体条目）。
   * 只读清单：每条返回 日期 + 时间段 + 课程 + 教室 + 状态；前端不可点。
   * type: all（默认，全部）/ pending（待值日+进行中）/ past（已过期+已完成）。
   * 时间段对「保洁课次（CLEAN）」返回 null，前端统一显示「18点前」。
   */
  myList: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const type = (payload && payload.type) || 'all'; // all | pending | past
      const classId = guard.classIdOf(ctx);
      const pool = getPool();
      // 与 myStats 同源（deriveMyDuties + dutyBucket）——
      // 保证「顶部数字」与「弹层明细条数」永远相等。
      const all = await deriveMyDuties(pool, classId, me.id);
      const list = (type === 'all') ? all : all.filter(d => dutyBucket(d.status) === type);
      return { list };
    }
  },

  /** 值日详情（Sheet 数据）：值日信息 + 同节次同伴 + 操作日志（不含照片） */
  detail: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const dutyId = Number(payload.dutyId);
      const classId = guard.classIdOf(ctx);
      const pool = getPool();
      const cfg = await week.getConfig(pool, classId);
      const periods = week.periodMap(cfg);
      const [rows] = await pool.query(
        `SELECT d.*, s.day_of_week, s.period, s.group_scope, s.week_rule, s.kind AS sessionKind,
                c.name AS courseName, c.room, c.teacher,
                m.name AS memberName, m.group_tag AS memberGroup, m.student_no
           FROM duty d
           JOIN session s ON s.id = d.session_id
           JOIN course c ON c.id = s.course_id
           JOIN member m ON m.id = d.member_id
          WHERE d.id = ? AND d.class_id = ?`, [dutyId, classId]
      );
      if (!rows.length) throw new BizError(41001, '值日不存在');
      const d = rows[0];
      // 临时调课后的真实落位（节次可能变了；duty 表里没有节次这一列）
      const slot = week.resolveSlot(d.session_id, d.day_of_week, d.period, d.week,
        await week.loadSessionShifts(pool, classId)) || { day: d.day_of_week, period: d.period };
      // 同班该课次所有人
      const [peers] = await pool.query(
        `SELECT m.name, m.group_tag, m.student_no, d.status FROM duty d JOIN member m ON m.id = d.member_id
          WHERE d.session_id = ? AND d.week = ? AND d.class_id = ? AND d.status != 'SWAPPED_OUT'`, [d.session_id, d.week, classId]
      );
      const [logs] = await pool.query(
        `SELECT l.action, l.created_at, m.name AS operatorName, l.from_member, l.to_member
           FROM duty_log l LEFT JOIN member m ON m.id = l.operator_id
          WHERE l.duty_id = ? ORDER BY l.id DESC LIMIT 10`, [dutyId]
      );
      /**
       * 这条值日是不是「被换人换上来的」？是的话，超级管理员可以在详情里一键还原。
       * 换人是**原地替换**（只有这一条值日记录），所以按 duty_id 反查即可；
       * 再加 `to_member = 当前值日人` 是为了防止「这条值日之后又被换过」时
       * 还给出一个会覆盖后续操作的还原按钮。
       */
      let reassign = null;
      if (guard.isSuper(me)) {
        const [rr] = await pool.query(
          'SELECT id, from_member FROM duty_reassign WHERE duty_id = ? AND to_member = ? AND undone = 0 ORDER BY id DESC LIMIT 1',
          [d.id, d.member_id]
        );
        if (rr.length) {
          const [fm] = await pool.query('SELECT name FROM member WHERE id = ?', [rr[0].from_member]);
          reassign = {
            reassignId: rr[0].id,
            fromMemberId: rr[0].from_member,
            fromName: (fm[0] && fm[0].name) || '原值日同学'
          };
        }
      }
      return {
        reassign,
        duty: {
          id: d.id, dutyId: d.id, week: d.week, sessionId: d.session_id,
          classDate: String(d.class_date).slice(0, 10),
          dayOfWeek: slot.day, period: slot.period,
          periodTime: (d.sessionKind === 'CLEAN') ? null : (periods[slot.period] || null),
          courseName: d.courseName, room: d.room || '', teacher: d.teacher || '',
          groupScope: d.group_scope, weekRule: d.week_rule,
          // CLEAN = 保洁课次（打扫 410）→ 前端显示「18点前」而不是「第 4 节」
          // （kind 是 session 表的列，SQL 里已 AS sessionKind，不要写成 d.kind）
          kind: d.sessionKind || 'COURSE',
          memberId: d.member_id, name: d.memberName, groupTag: d.memberGroup,
          seq: week.seqOf(d.student_no),
          status: week.effectiveStatus(d, periods),
          isMine: d.member_id === me.id
        },
        peers: peers.map(p => ({ name: p.name, groupTag: p.group_tag, seq: week.seqOf(p.student_no), status: p.status })),
        logs: logs.map(l => ({
          action: l.action,
          operatorName: l.operatorName || '系统',
          createdAt: String(l.created_at).slice(0, 16)
        }))
      };
    }
  },

  /** 扫码播放：按 noticeId 取语音（只读，任何已绑定成员可听） */
  noticeAudio: {
    auth: { needBind: true },
    handler: async (payload) => {
      const noticeId = Number(payload.noticeId);
      if (!noticeId) throw new BizError(41001, '参数错误');
      const pool = getPool();
      const [rows] = await pool.query(
        `SELECT n.id, n.duration_ms, n.created_at, m.name AS publisherName, a.file_id, a.audit_status
           FROM notice n
           JOIN member m ON m.id = n.publisher_id
           JOIN attachment a ON a.id = n.audio_id
          WHERE n.id = ? LIMIT 1`, [noticeId]
      );
      const n = rows[0];
      if (!n) throw new BizError(41001, '语音不存在或已删除');
      if (n.audit_status === 'BLOCKED') throw new BizError(43001, '该语音未通过内容审核');
      let url = '';
      try {
        const t = await cloud.getTempFileURL({ fileIdList: [n.file_id] });
        const f = (t.fileList || [])[0];
        url = (f && f.tempFileURL) || '';
      } catch (e) { /* ignore */ }
      if (!url) throw new BizError(41002, '语音读取失败，请稍后重试');
      return {
        noticeId: n.id,
        url,
        durationMs: n.duration_ms,
        publisherName: n.publisherName,
        createdAt: String(n.created_at).slice(0, 16)
      };
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
    console.error('[duty] unhandled', action, e);
    return fail(50000, '服务开小差了，请稍后重试');
  }
};
