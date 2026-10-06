/**
 * 云函数：cron-weekly —— 定时任务（开发文档 8.2 #10）
 * 触发器（CloudBase 7 段 cron，部署时经 API 创建，**整体覆盖语义，须一次传齐全部**）：
 *   weekly    周日 20:00  生成下周草稿（幂等）
 *   daily     每日 06:00  过期扫描（昨日未确认 → EXPIRED）
 *   hourly    每小时      换班申请超时撤销 / AUDITING 超 24h 未回调 → BLOCKED
 *   remind    每日 21:00  次日值日订阅提醒（当晚预告：明天有你的值日）
 *   remindAM  每日 07:00  当日值日订阅提醒（当天早上：今天有你的值日）★ v0.7.15 新增
 *
 * ⚠️ 提醒为什么要两条（2026-09-26 用户需求②）：
 *   21:00 那条是「预告」，学生可能已经睡了或没看手机；早上 7:00 那条是「临场」，
 *   出门前能看到具体第几节、哪个教室。两条共用 `remindDuty()`，只在「日期」与
 *   「今天/明天」用词上不同 —— 文案与字段拼装必须同源，禁止再抄第二份。
 * ⚠️ 一次性订阅额度：「同意一次 = 1 条」。**一天两条 = 每人每天要 2 条额度**，
 *   所以前端「开启微信提醒」入口要引导学生多点几次累积额度（见 utils/subscribe.js）。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { getPool } = require('./common/db');
const week = require('./common/week');
// 轮转取人内核：与 schedule 的「一键生成」共用同一份实现（禁止再写第二套算法）
const { rotationPick, repairRoundMarks, loadDayBlocks } = require('./common/schedule-core');

const DAY_MS = 86400000;
const DAY_TEXT = ['一', '二', '三', '四', '五', '六', '日'];

/**
 * 每周自动生成（weekly 触发器，周日 20:00 生成下周草稿）。
 *
 * ⚠️ 取人必须与超管手动「一键生成」完全同源 —— `common/schedule-core.js` 的 rotationPick。
 * 旧版这里自己写了一套「按 duty_count 排序 + `Math.random()` 打破平局」的算法，有两个致命问题：
 *   ① 不可复现：同一份数据每次跑出来的人不一样；
 *   ② **会把同一个人排进多个课次** —— duty_count 相同的一批人被随机打散到不同的天，
 *      于是同一个人周一、周三各值一次（2026-09-24 用户报的「一键生成会重复安排」）。
 * 另外旧版直接用 `getDateOfWeekDay` 算日期，不看校历、不看临时调课，
 * 会自动给中秋节 / 国庆当天排值日，也不认「这周这节课不上」。这些现在都补齐了。
 */
async function generateWeek(pool, wk, classId) {
  const cfg = await week.getConfig(pool, classId);
  if (wk > cfg.totalWeeks) return { skipped: true, reason: 'week overflow' };
  const [rulesRows] = await pool.query('SELECT * FROM schedule_rules WHERE class_id = ? ORDER BY id LIMIT 1', [classId]);
  const rules = rulesRows[0] || {};
  const avoidSameDay = !!rules.avoid_same_day;
  const conn = await pool.getConnection();
  let created = 0;
  let roundReset = false;
  let holidaySkipped = 0;
  let shiftSkipped = 0;
  const warnings = [];
  try {
    await conn.beginTransaction();
    const cal = await week.loadCalendar(conn);
    const shifts = await week.loadSessionShifts(conn);
    const [sessRows] = await conn.query(
      `SELECT s.id, s.weeks, s.week_rule, s.day_of_week, s.period, s.group_scope, s.duty_count
         FROM session s WHERE s.class_id = ? ORDER BY s.day_of_week, s.period`, [classId]
    );
    // 只排「这一周实际上课」的课次（weeks 数组 + week_rule 双条件）
    const sessions = sessRows.filter(s => week.matchesWeeks(s.weeks, wk, s.week_rule));

    // ── 本轮轮转池：duty_count 即「本轮已排次数」标记，0 = 本轮尚未安排 ──
    // 本周已有的 AUTO 值日马上会被下面的 DELETE 删掉，先扣掉它们，
    // 否则「重新生成同一周」会把这些人误判成本轮已排过（换一批人 + 标记重复累加）。
    const [memRows] = await conn.query(
      "SELECT id, student_no, group_tag, duty_count FROM member WHERE class_id = ? AND status = 'ACTIVE' AND group_tag <> 'X' AND duty_off = 0", [classId]
    );
    const [oldAuto] = await conn.query(
      "SELECT member_id, COUNT(*) AS n FROM duty WHERE class_id = ? AND week = ? AND source = 'AUTO' GROUP BY member_id", [classId, wk]
    );
    const ownAuto = new Map(oldAuto.map(r => [Number(r.member_id), Number(r.n) || 0]));
    const roster = memRows.map(m => ({
      id: m.id,
      seq: week.seqOf(m.student_no),
      group: m.group_tag,
      mark: Math.max(0, (Number(m.duty_count) || 0) - (ownAuto.get(Number(m.id)) || 0))
    })).sort((a, b) => (a.seq - b.seq) || (a.id - b.id));

    // 补齐序号断层（清空某周后那批人标记掉回 0，但后面还有人带标记）：
    // 与超管「一键生成」同口径，否则每周自动生成会从 1 号重排（见 repairRoundMarks）
    const roundFix = repairRoundMarks(roster);

    await conn.query("DELETE FROM duty WHERE class_id = ? AND week = ? AND source = 'AUTO'", [classId, wk]);
    // v0.7.25：作废全部「悬空申请」（引用的 duty 已不存在）—— 排班重建/删除会不断产生这种幽灵，
    // 它们永远无法被确认却一直计入「待确认」提醒（§73）。每周重建时顺带清一次，保证计数=列表。
    await conn.query(
      `UPDATE swap_request SET status = 'CANCELLED'
        WHERE status IN ('PENDING_PEER','PENDING_ADMIN')
          AND NOT EXISTS (SELECT 1 FROM duty d WHERE d.id = duty_id)`
    );

    // 手动排班视为已占用：不重排他，也算「本周已经值过日」（一轮里每人只排一次）
    const [manualRows] = await conn.query(
      "SELECT DISTINCT class_date, member_id FROM duty WHERE class_id = ? AND week = ? AND source = 'MANUAL'", [classId, wk]
    );
    const assignedByDate = {};
    const assignedWeek = new Set();
    manualRows.forEach(m => {
      const date = String(m.class_date).slice(0, 10);
      (assignedByDate[date] = assignedByDate[date] || new Set()).add(Number(m.member_id));
      assignedWeek.add(Number(m.member_id));
    });

    /* 轮转取人顺序 = 实际上课日期顺序（同日按节次、课次 id）。
     * ⚠️ 与 schedule.generate 同一道坑（2026-10-05 国庆调休 10/7→10/10 实锤）：
     * 不能按 SQL 的 day_of_week 顺序迭代 —— 调休（MOVE）只是把「周三的课」挪到周六，
     * session 的 day_of_week 仍是 3，于是调来的 10/10 被排在 10/8、10/9 前面分配序号。
     * 自动生成与手动「一键生成」必须同口径，否则两条链路给出的名单不一致。 */
    const rotatePlan = [];
    for (const s of sessions) {
      // 临时调课优先：OFF → 本周这节课不上；MOVE → 用调课后的星期 / 节次算日期
      const slot = week.resolveSlot(s.id, s.day_of_week, s.period, wk, shifts);
      if (!slot) { shiftSkipped += 1; continue; }
      // 法定放假且无调课 → 本周不上，不排值日
      const classDate = week.classDateOf(cfg, wk, slot.day, cal);
      if (!classDate) { holidaySkipped += 1; continue; }
      rotatePlan.push({ s, slot, classDate });
    }
    rotatePlan.sort((a, b) => (
      a.classDate < b.classDate ? -1
        : a.classDate > b.classDate ? 1
          : (Number(a.slot.period) - Number(b.slot.period)) || (a.s.id - b.s.id)
    ));

    for (const { s, slot, classDate } of rotatePlan) {
      const n = s.duty_count || 1;
      const blocks = await loadDayBlocks(conn, classDate);
      const picked = rotationPick(
        roster, s.group_scope, n, blocks, avoidSameDay,
        assignedByDate[classDate] || new Set(), new Set(), assignedWeek
      );
      if (picked.wrapped) roundReset = true;
      picked.chosen.forEach(m => { assignedWeek.add(m.id); });
      if (picked.short > 0) {
        warnings.push('周' + (DAY_TEXT[slot.day - 1] || '?') + '第' + slot.period
          + '节候选不足（还需 ' + picked.short + ' 人）');
      }
      for (const m of picked.chosen) {
        try {
          const ins = await conn.query(
            `INSERT IGNORE INTO duty (class_id, session_id, week, class_date, member_id, status, source)
             VALUES (?, ?, ?, ?, ?, 'PENDING', 'AUTO')`, [classId, s.id, wk, classDate, m.id]
          );
          // 已存在同课次同人 → 幂等跳过；**不能**在这里给 duty_count 加一，
          // 否则这一行被 IGNORE 掉了却仍然计数（旧版就是无条件 +1）
          if (!ins[0] || !ins[0].affectedRows) continue;
          await conn.query('UPDATE member SET last_duty_at = ? WHERE id = ?', [classDate, m.id]);
          created += 1;
          (assignedByDate[classDate] = assignedByDate[classDate] || new Set()).add(m.id);
        } catch (e) { /* 幂等 */ }
      }
    }

    // 回写轮转标记：duty_count = 本轮已排次数（TDSQL 一次只允许一条语句）
    if (roster.length) {
      const caseSql = 'UPDATE member SET duty_count = CASE id '
        + roster.map(r => `WHEN ${Number(r.id)} THEN ${Number(r.mark)}`).join(' ')
        + ' END WHERE id IN (' + roster.map(r => Number(r.id)).join(',') + ')';
      await conn.query(caseSql);
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  return { created, week: wk, roundReset, roundFixed: roundFix.filled.length, holidaySkipped, shiftSkipped, warnings };
}

/** 每日：昨日未确认 → EXPIRED */
async function markExpired(pool) {
  const today = week.todayStr();
  const [r] = await pool.query(
    "UPDATE duty SET status = 'EXPIRED' WHERE status IN ('PENDING','ONGOING') AND class_date < ?", [today]
  );
  return { expired: r.affectedRows };
}

/** 每小时：超时申请撤销 + 审核超时下架 */
async function hourlyJobs(pool) {
  const now = week.nowStamp();
  const [sw] = await pool.query(
    "UPDATE swap_request SET status = 'CANCELLED' WHERE status = 'PENDING_PEER' AND expire_at < ?", [now]
  );
  const cutoff = week.stampOf(Date.now() - 24 * 3600 * 1000);
  const [atts] = await pool.query(
    "SELECT id, file_id FROM attachment WHERE audit_status = 'AUDITING' AND created_at < ?", [cutoff]
  );
  let blocked = 0;
  for (const a of atts) {
    await pool.query("UPDATE attachment SET audit_status = 'BLOCKED' WHERE id = ?", [a.id]);
    try { await cloud.deleteFile({ fileList: [a.file_id] }); } catch (e) { /* 忽略 */ }
    blocked += 1;
  }
  return { swapCancelled: sw.affectedRows, auditBlocked: blocked };
}

/* ---------- 订阅消息（值日提醒） ---------- */

/**
 * 订阅消息关键词字段名。必须与公众平台所选模板的关键词**数量与类型**一致，
 * 模板不同时只改这组环境变量即可，不用动代码。
 *
 * 当前线上模板（编号 17406「日程提醒」/ 类目：信息查询）：
 *   日程主题 thing1 · 备注 thing5 · 课程名称 thing8   ← 三个都是 thing 类，各限 20 字符
 * 对应关系（2026-09-27 实测：模板 YOUR_SUBSCRIBE_TEMPLATE_ID 的关键词是 thing1/thing5/thing8）：
 *   TEMPLATE_REMIND_F_TITLE    默认 thing1  日程主题  ← 「明天有 N 项值日」
 *   TEMPLATE_REMIND_F_DIGEST   应配 thing5   备注      ← 具体值日内容（18点前打扫410、第2节大学英语）
 *   TEMPLATE_REMIND_F_COURSE   应配 thing8   课程名称  ← 第一门课程名（纯保洁日填「打扫410」）
 *   TEMPLATE_REMIND_F_DATE     默认未配置             ← 模板若带「日期」关键词才需要设（如 date2）
 *
 * ⚠️ 只填模板里真实存在的关键词。多传一个不存在的字段（例如模板没有 date 却传了 date2）
 *    会直接 47003 发送失败，所以日期字段默认留空、按需开启。
 */
const REMIND_FIELDS = {
  title: process.env.TEMPLATE_REMIND_F_TITLE || 'thing1',
  // 模板 YOUR_SUBSCRIBE_TEMPLATE_ID 真实关键词为 thing1/thing5/thing8；
  // env 已将上述字段映射到正确关键词，默认兜底也用 thing5/thing8 防止 env 丢失时发错格。
  digest: process.env.TEMPLATE_REMIND_F_DIGEST || 'thing5',
  course: process.env.TEMPLATE_REMIND_F_COURSE || 'thing8',
  date: process.env.TEMPLATE_REMIND_F_DATE || ''
};

/** 截断：thing 类关键词上限 20 个字符，超长会导致整条消息发送失败 */
function cut20(s) {
  const t = String(s == null ? '' : s);
  return t.length <= 20 ? t : t.slice(0, 19) + '…';
}

/** 日期类关键词用中文格式，如 2026年09月25日 */
function cnDate(dateStr) {
  const p = String(dateStr).split('-');
  return p.length === 3 ? (p[0] + '年' + p[1] + '月' + p[2] + '日') : String(dateStr);
}

/**
 * 值日订阅提醒（21:00 预告明天 / 07:00 提醒今天，**同源实现**）。
 *
 * 规则（2026-09-24 定稿，2026-09-26 加「当天早上」与「教室」）：
 *  1. 只提醒「该日有值日」的同学；`when='tomorrow'` 取明天、`'today'` 取今天。
 *  2. 一人一条：一次性订阅「同意一次 = 1 条额度」，一人当天多节课/还有保洁时必须
 *     合并成一条发，否则第二条一定失败。
 *  3. 未配置 TEMPLATE_REMIND 直接跳过，不影响其它定时任务。
 *  4. 43101 = 用户未订阅或额度用尽，属正常情况，静默计数不上报错误。
 *  5. 保洁（session.kind = 'CLEAN'）统一写「18点前打扫410」，不写「第4节」——
 *     它挂在第 4 节上只是为了有个排班位，学生看到「第 4 节打扫 410」会以为是去上课。
 *  6. **具体课次 + 教室**（用户需求②原话：「提醒第二天有你的值日，具体课次和教室」）：
 *     「备注」这一格放「时间地点」= 第N节 + 教室，「课程名称」那一格放课程名。
 *     两格分装是必要的 —— thing 类关键词每格上限 20 字符，课次+教室+课名塞一格
 *     必然被截断（`cut20` 会补省略号，学生看到的是「第2节大学英语(4…」）。
 *
 * @param {'tomorrow'|'today'} when 提醒的是哪一天的值日
 */
async function remindDuty(pool, when) {
  const templateId = process.env.TEMPLATE_REMIND;
  if (!templateId) return { skipped: true, reason: 'no template' };
  const isToday = when === 'today';
  // 东八区「今天 / 明天」：fmtDate 内部已 +8h，这里只加一天。重复再加 8h 会算成后天（曾踩过）。
  const date = isToday ? week.todayStr() : week.fmtDate(new Date(Date.now() + DAY_MS));
  const lead = isToday ? '今天' : '明天';
  const [rows] = await pool.query(
    `SELECT d.id, m.id AS memberId, m.openid, m.name, s.period, s.kind AS sessionKind,
            c.name AS courseName, c.room AS room
       FROM duty d
       JOIN member m ON m.id = d.member_id
       JOIN session s ON s.id = d.session_id
       JOIN course c ON c.id = s.course_id
      WHERE d.class_date = ? AND d.status IN ('PENDING','ONGOING')
        AND m.openid IS NOT NULL AND m.status = 'ACTIVE'
      ORDER BY m.id, s.period`,
    [date]
  );
  if (!rows.length) return { when, date, receivers: 0, sent: 0, refused: 0, failed: 0 };

  // 按 openid 聚合：一个人当天可能既上课值日、又要打扫 410
  const byOpenid = new Map();
  rows.forEach((r) => {
    const cur = byOpenid.get(r.openid) || { name: r.name, memberIds: [], items: [], courses: [] };
    if (!cur.memberIds.includes(Number(r.memberId))) cur.memberIds.push(Number(r.memberId));
    if (r.sessionKind === 'CLEAN') {
      cur.items.push('18点前打扫410');
    } else {
      // 「第2节410」= 具体课次 + 教室。教室字段（course.room）可能为空 ——
      // 空着就只写节次，不允许拿课程名去顶（课名另有「课程名称」那一格，不必重复）。
      const room = r.room ? String(r.room).trim() : '';
      cur.items.push('第' + r.period + '节' + room);
      if (r.courseName) cur.courses.push(r.courseName);
    }
    byOpenid.set(r.openid, cur);
  });

  const f = REMIND_FIELDS;
  let sent = 0, refused = 0, failed = 0;
  const okOpenids = [], refOpenids = [];
  for (const [openid, info] of byOpenid) {
    const data = {};
    data[f.title] = { value: cut20(lead + '有 ' + info.items.length + ' 项值日') };
    data[f.digest] = { value: cut20(info.items.join('、')) };
    // 纯保洁日没有课程名，「课程名称」这一格不能空着，用「打扫410」顶上
    data[f.course] = { value: cut20(info.courses.join('、') || '打扫410') };
    if (f.date) data[f.date] = { value: cnDate(date) };
    try {
      await cloud.openapi.subscribeMessage.send({
        touser: openid,
        templateId,
        page: process.env.TEMPLATE_REMIND_PAGE || 'pages/duty/index',
        miniprogramState: process.env.TEMPLATE_REMIND_STATE || 'formal',
        lang: 'zh_CN',
        data
      });
      sent += 1;
      okOpenids.push(openid);
    } catch (e) {
      const code = Number((e && (e.errCode || e.errcode)) || 0);
      if (code === 43101) { refused += 1; refOpenids.push(openid); }
      else {
        failed += 1;
        console.error('[cron-weekly] remind send fail', code, String((e && e.errMsg) || e).slice(0, 160));
      }
    }
  }

  /*
   * 「额度耗尽」标记（v0.7.15）：一次性订阅没有长期通道，额度用尽后发送静默失败，
   * 学生完全无感知 —— 必须把这件事写回库里，前端才能把人拉回来重新授权。
   *   发送成功 → remind_block = 0（说明他还有额度，之前误标的一并纠正）
   *   43101    → remind_block = 1（首页据此弹「微信提醒已失效，点此重新开启」）
   * 其它错误码不动标记（可能是模板/权限问题，不是学生的额度问题）。
   */
  if (okOpenids.length) {
    await pool.query(
      'UPDATE member SET remind_block = 0 WHERE openid IN (' + okOpenids.map(() => '?').join(',') + ')', okOpenids
    );
  }
  if (refOpenids.length) {
    await pool.query(
      'UPDATE member SET remind_block = 1 WHERE openid IN (' + refOpenids.map(() => '?').join(',') + ')', refOpenids
    );
  }
  return { when, date, receivers: byOpenid.size, sent, refused, failed, blockSet: refOpenids.length, blockClear: okOpenids.length };
}

exports.main = async (event) => {
  const pool = getPool();
  const trigger = (event && (event.TriggerName || event.triggerName)) || '';
  const result = { trigger, at: week.nowStamp() };
  try {
    if (trigger === 'weekly') {
      // 多班级（§43）：遍历所有启用班级，逐个生成下周草稿
      const [classes] = await pool.query('SELECT id, term_start, total_weeks FROM `class` WHERE is_active = 1 ORDER BY id');
      const perClass = [];
      for (const c of classes) {
        const classId = Number(c.id);
        const [rulesRows] = await pool.query('SELECT cron_enabled FROM schedule_rules WHERE class_id = ? ORDER BY id LIMIT 1', [classId]);
        const enabled = !rulesRows.length || !!rulesRows[0].cron_enabled;
        if (!enabled) {
          perClass.push({ classId, skipped: true, reason: 'cron disabled' });
          continue;
        }
        const nextWeek = week.currentWeek({ term_start: week.fmtDate(new Date(c.term_start)), total_weeks: c.total_weeks }) + 1;
        try {
          const r = await generateWeek(pool, nextWeek, classId);
          perClass.push({ classId, ...r });
        } catch (e) {
          perClass.push({ classId, error: String((e && e.message) || e) });
        }
      }
      result.weekly = { classes: perClass };
    } else if (trigger === 'daily') {
      result.daily = await markExpired(pool);
    } else if (trigger === 'remind') {
      // 每日 21:00：预告明天
      result.remind = await remindDuty(pool, 'tomorrow');
    } else if (trigger === 'remindAM') {
      // 每日 07:00：提醒今天（v0.7.15）。与 21:00 那条同源，只换日期与用词。
      result.remindAM = await remindDuty(pool, 'today');
    } else {
      // hourly 与手动触发：跑全部幂等任务，保证任何入口都收敛
      result.hourly = await hourlyJobs(pool);
      result.daily = await markExpired(pool);
    }
    console.log(JSON.stringify({ fn: 'cron-weekly', result }));
    return { errCode: 0, errMsg: 'ok', data: result };
  } catch (e) {
    console.error('[cron-weekly] failed', trigger, e);
    return { errCode: 50000, errMsg: String(e && e.message || e), data: result };
  }
};
