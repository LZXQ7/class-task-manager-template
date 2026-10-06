/**
 * 学期周次 / 日期 / 单双周计算（与端上 utils/format.js 同源，开发文档 附录 A）
 * 全部以「东八区墙钟字符串」为准，避免服务器时区差异。
 */
const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;

function fmtDate(d) {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function stampOf(ms) {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

function nowStamp() {
  return stampOf(Date.now());
}

function addMinutes(min) {
  return stampOf(Date.now() + min * 60000);
}

function todayStr() {
  return fmtDate(new Date());
}

function nowHHmm() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(11, 16);
}

function toDate(dateStr) {
  return new Date(dateStr + 'T00:00:00+08:00');
}

/** 学期周次（1 起）；termStart: 'YYYY-MM-DD' */
function getWeek(termStart, dateStr) {
  const diff = toDate(dateStr).getTime() - toDate(termStart).getTime();
  return Math.floor(diff / WEEK_MS) + 1;
}

/** 某周某星期几对应的日期 */
function getDateOfWeekDay(termStart, week, dayOfWeek) {
  const ms = toDate(termStart).getTime() + ((week - 1) * 7 + (dayOfWeek - 1)) * DAY_MS;
  return fmtDate(new Date(ms));
}

/** 周一日期 */
function weekStart(termStart, week) {
  return getDateOfWeekDay(termStart, week, 1);
}

/**
 * 1=周一 ... 7=周日。
 *
 * 必须按「东八区墙钟」取星期：直接在日期分量上做 Date.UTC 再读 getUTCDay。
 * 不能写成 toDate(dateStr).getUTCDay()——toDate 会加上 +08:00 位移，
 * UTC 时刻落到**前一天**，星期就会整体差一天（曾导致首页「今日课次」
 * 查错 day_of_week、导出 CSV 的「星期」列也差一天）。
 */
function weekdayOf(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr == null ? '' : dateStr));
  if (!m) return 1;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const w = d.getUTCDay();
  return w === 0 ? 7 : w;
}

function matchesWeekRule(rule, week) {
  if (rule === 'ODD') return week % 2 === 1;
  if (rule === 'EVEN') return week % 2 === 0;
  return true;
}

/** 将逗号分隔的周次串解析为去重后的升序数字数组（空/非法 → 空数组） */
function parseWeeks(weeks) {
  if (weeks === null || weeks === undefined || weeks === '') return [];
  const arr = String(weeks)
    .split(',')
    .map(s => parseInt(s, 10))
    .filter(n => Number.isInteger(n) && n >= 1 && n <= 53);
  return Array.from(new Set(arr)).sort((a, b) => a - b);
}

/** 课次是否在本周生效：weeks 为空表示每周都上，否则命中集合才上；兼容旧 week_rule */
function matchesWeeks(weeks, week, weekRule) {
  const arr = parseWeeks(weeks);
  if (!arr.length) return matchesWeekRule(weekRule, week);
  return arr.indexOf(week) >= 0;
}

function currentWeek(cfg) {
  const w = getWeek(cfg.term_start, todayStr());
  return Math.min(Math.max(w, 1), cfg.total_weeks);
}

/**
 * 读班级配置（含大节时间）。
 * 多班级（§43）：优先读 `class` 表按 classId 取；id=1 且 class 表缺行时回退 class_config 兜底。
 * @param {object} pool
 * @param {number} [classId] 班级 id，默认 1（存量数据迁移后 class_id 均为 1）
 */
async function getConfig(pool, classId) {
  const cid = Number(classId) || 1;
  let c = null;
  const [rows] = await pool.query('SELECT * FROM `class` WHERE id = ?', [cid]);
  if (rows.length) c = rows[0];
  if (!c && cid === 1) {
    const [legacy] = await pool.query('SELECT * FROM class_config WHERE id = 1');
    if (legacy.length) c = legacy[0];
  }
  if (!c) throw new Error('班级配置未初始化（class_id=' + cid + '）');
  let periodTime = [];
  try {
    periodTime = typeof c.period_time === 'string' ? JSON.parse(c.period_time) : c.period_time || [];
  } catch (e) { periodTime = []; }
  return {
    classId: cid,
    name: c.name,
    termStart: fmtDate(new Date(c.term_start)),
    totalWeeks: c.total_weeks,
    joinToken: c.join_token,
    inviteCode: c.invite_code,
    // 绑定入口开关（防爆破：24h 累计失败过多自动关闭，超管可手动开回）
    bindOpen: c.bind_open !== 0,
    isActive: c.is_active !== 0,
    periodTime
  };
}

function periodMap(config) {
  const map = {};
  (config.periodTime || []).forEach(p => { map[p.period] = p; });
  return map;
}

/* ============================================================
 * 校历：节假日 / 调休 / 调课（按天整体调课）
 * ============================================================ */

/** DATE 列在 dateStrings=true 下已是 'YYYY-MM-DD'，这里做一次兜底归一 */
function dateStr(v) {
  if (!v) return '';
  if (typeof v === 'string') return v.slice(0, 10);
  return fmtDate(new Date(v));
}

/**
 * 载入校历。
 * holiday.kind: OFF=放假不上课；MAKEUP=调休上班（周末补课日）
 * day_shift: 把 from_date 当天的课整体挪到 to_date 上
 * 表不存在时降级为空校历（不阻断主流程）
 */
async function loadCalendar(pool) {
  let holidays = [];
  let shifts = [];
  try {
    const [h] = await pool.query('SELECT holiday_date, name, kind FROM holiday ORDER BY holiday_date');
    holidays = h.map(r => ({ date: dateStr(r.holiday_date), name: r.name, kind: r.kind }));
  } catch (e) { /* holiday 表未建：忽略 */ }
  try {
    const [s] = await pool.query('SELECT id, week, from_date, to_date, note FROM day_shift ORDER BY from_date');
    shifts = s.map(r => ({
      id: r.id,
      week: r.week,
      from: dateStr(r.from_date),
      to: dateStr(r.to_date),
      note: r.note || ''
    }));
  } catch (e) { /* day_shift 表未建：忽略 */ }
  const off = new Set(holidays.filter(x => x.kind === 'OFF').map(x => x.date));
  const makeup = new Set(holidays.filter(x => x.kind === 'MAKEUP').map(x => x.date));
  const shiftFrom = {};
  shifts.forEach(s => { shiftFrom[s.from] = s.to; });
  return { holidays, shifts, off, makeup, shiftFrom };
}

/* ============================================================
 * 名册序号：全项目唯一的「序号」定义
 * 260805740301 → 1，260805740311 → 11；非数字/空 → 0
 * 取值天然等于 A/B 分组（奇=A、偶=B）
 * ============================================================ */
function seqOf(studentNo) {
  const s = String(studentNo == null ? '' : studentNo).replace(/\D/g, '');
  if (!s) return 0;
  const n = parseInt(s.slice(-2), 10);
  return isNaN(n) ? 0 : n;
}

/**
 * 某周某星期几课次的「实际上课日期」。
 * 返回 null 表示当天放假不上课；有调课记录时返回调课后的日期。
 */
function classDateOf(cfg, wk, dayOfWeek, cal) {
  const base = getDateOfWeekDay(cfg.termStart, wk, dayOfWeek);
  const c = cal || { off: new Set(), shiftFrom: {} };
  if (c.shiftFrom && c.shiftFrom[base]) return c.shiftFrom[base];
  if (c.off && c.off.has(base)) return null;
  return base;
}

/**
 * 值日展示态推导（1.0.4.4 状态机）：库内 PENDING + 时间窗 → ONGOING / DONE / EXPIRED
 * - 库内 status 非 PENDING（DONE/LEAVE/SWAPPED_OUT/EXPIRED）→ 原样返回（DB 写入为准）
 * - 过期日期 → EXPIRED（已结束）；未来日期 → PENDING（待值日）
 * - 今天：
 *   · 课次（COURSE）：课中时间窗内 = 进行中；下课～下一节开课 = 进行中（打扫时段）；
 *     下一节开课（最后一节 = 当天 21:00）→ DONE（已值日）
 *   · 保洁（CLEAN）：18:00 前 = 待值日；18:00 起 = 已值日（对应「18点前打扫完」口径）
 * 纯派生，不回写 DB（游标 / 统计口径以 duty 表行数为准，不受影响）。
 */
function effectiveStatus(duty, periods) {
  if (duty.status !== 'PENDING') return duty.status;
  const dateStr = typeof duty.class_date === 'string' ? duty.class_date.slice(0, 10) : duty.class_date;
  const today = todayStr();
  if (dateStr < today) return 'EXPIRED';
  if (dateStr > today) return 'PENDING';
  // 今天
  const now = nowHHmm();
  if (duty.kind === 'CLEAN') {
    return now >= '18:00' ? 'DONE' : 'PENDING';
  }
  const p = periods[duty.period] || { start: '00:00', end: '23:59' };
  if (now < p.start) return 'PENDING';
  if (now <= p.end) return 'ONGOING'; // 课中
  // 已过本节课时间窗：进入打扫时段，到下一切换点翻「已值日」
  const flip = flipTimeOf(periods, duty.period);
  return now >= flip ? 'DONE' : 'ONGOING';
}

/** 下一节开始时刻（作为「已值日」翻转点）；最后一节无下一节 → 当天 21:00 */
function flipTimeOf(periods, period) {
  const sorted = Object.keys(periods || {})
    .map((k) => periods[k])
    .sort((a, b) => (Number(a.period) || 0) - (Number(b.period) || 0));
  for (const p of sorted) {
    if ((Number(p.period) || 0) > Number(period)) return p.start;
  }
  return '21:00';
}

/* ============================================================
 * 临时调课（session_shift）：按周生效的课次覆盖
 * ------------------------------------------------------------
 * 为什么单独一张表：用「改 session.weeks」表达「本周不上」会改掉整学期的课表计划，
 * 而且不可逆；这里存**那一周**的例外，原始课表一行不动，随时可撤销。
 *   kind=OFF  → 该课次本周不上
 *   kind=MOVE → 该课次本周改到 to_day / to_period（同周内，不跨周）
 * ⚠️ 端上 `miniprogram/data/timetable.js` 有一份同构的本地实现，改这里必须同步改那边。
 * ============================================================ */

const shiftKey = (sessionId, week) => Number(sessionId) + '#' + Number(week);

/**
 * 载入临时调课。表不存在时降级为「没有任何临时调课」（不阻断主流程，与其他校历表一致）。
 * 多班级（§43）：session_shift 已加 class_id；传 classId 则按班级过滤，缺省则取全部（兼容存量单班）。
 * @param {object} pool
 * @param {number} [classId] 班级 id，缺省不按班级过滤
 * @returns {Object} map: '<sessionId>#<week>' → { kind, toDay, toPeriod, note }
 */
async function loadSessionShifts(pool, classId) {
  const map = {};
  try {
    let sql = 'SELECT session_id, week, kind, to_day, to_period, note FROM session_shift';
    const args = [];
    if (classId) { sql += ' WHERE class_id = ?'; args.push(classId); }
    const [rows] = await pool.query(sql, args);
    rows.forEach((r) => {
      map[shiftKey(r.session_id, r.week)] = {
        kind: r.kind,
        toDay: r.to_day === null ? null : Number(r.to_day),
        toPeriod: r.to_period === null ? null : Number(r.to_period),
        note: r.note || ''
      };
    });
  } catch (e) { /* session_shift 表未建：当作没有临时调课 */ }
  return map;
}

/**
 * 一个课次在某一周的「实际落位」——**全项目唯一的解释器**。
 * @returns {null|{day:number, period:number, shifted:boolean}}  null = 这周不上
 */
function resolveSlot(sessionId, dayOfWeek, period, week, shifts) {
  const ov = shifts && shifts[shiftKey(sessionId, week)];
  if (ov) {
    if (ov.kind === 'OFF') return null;
    return {
      day: ov.toDay || Number(dayOfWeek),
      period: ov.toPeriod || Number(period),
      shifted: true
    };
  }
  return { day: Number(dayOfWeek), period: Number(period), shifted: false };
}

module.exports = {
  fmtDate, stampOf, nowStamp, addMinutes, todayStr, nowHHmm,
  getWeek, getDateOfWeekDay, weekStart, weekdayOf,
  matchesWeekRule, matchesWeeks, parseWeeks, currentWeek, getConfig, periodMap, effectiveStatus,
  dateStr, loadCalendar, classDateOf,
  seqOf,
  shiftKey, loadSessionShifts, resolveSlot
};
