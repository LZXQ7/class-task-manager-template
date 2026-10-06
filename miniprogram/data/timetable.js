/**
 * 本地课表数据源（离线）
 * ============================================================
 * 为什么是本地：课表是**一学期不变的静态数据**，却原来每次进课表页都要走一次
 * 云函数 + 数据库查询；一旦云函数/公共模块出任何问题，整页就变成「数据没加载出来」。
 * 现在课表直接写在小程序里，打开就有、断网也有。
 *
 * 数据来自示例课表（示例数据）：18 门 course / 25 个 session。
 * 值日生成仍在服务端跑（读库），与这里的课表是同一份数据的两个副本，
 * 若手工改过库里的课表，请同步改本文件的 SESSIONS。
 *
 * 节假日 / 调课：种子数据写在 HOLIDAYS / SHIFTS，管理员在「校历」里的改动
 * 会存到 wx.Storage 覆盖种子值，并尽力同步到数据库（值日生成读库里的那份）。
 */

const TERM_START = '2025-09-01';
const TOTAL_WEEKS = 16;

const KEY_SESSIONS = 'timetable_sessions_v1';
const KEY_HOLIDAYS = 'timetable_holidays_v1';
const KEY_SHIFTS = 'timetable_shifts_v1';
/** 临时调课（按周生效的课次例外），与服务端 session_shift 表一一对应 */
const KEY_SESS_SHIFTS = 'timetable_sess_shifts_v1';

/* ------------------------------------------------------------------
 * 课次：与库里 session 一一对应
 * id      = session.id（值日表关联用，务必与库一致）
 * cid     = course.id（仅用于配色，同一门课同色）
 * ------------------------------------------------------------------ */
const SEED_SESSIONS = [
  // ── 周一 ──
  { id: 1, cid: 1, name: '形势与政策', teacher: '示例教师1', room: '3号楼208', day: 1, period: 1, group: null, weeks: '6,8,10,12' },
  { id: 2, cid: 2, name: '微课设计与制作', teacher: '示例教师2', room: '3号楼109', day: 1, period: 2, group: 'A', weeks: '' },
  { id: 5, cid: 4, name: '习近平新时代中国特色社会主义思想概论', teacher: '示例教师3', room: '3号楼213', day: 1, period: 3, group: null, weeks: '' },
  { id: 3, cid: 2, name: '微课设计与制作', teacher: '示例教师2', room: '3号楼109', day: 1, period: 4, group: 'B', weeks: '1,2,3,4,5,6,7,8' },
  { id: 4, cid: 3, name: '微课设计与制作', teacher: '示例教师4', room: '3号楼109', day: 1, period: 4, group: 'B', weeks: '9,10,11,12,13,14,15,16' },

  // ── 周二 ──
  { id: 8, cid: 6, name: '小学人工智能教育', teacher: '示例教师5', room: '3号楼110', day: 2, period: 1, group: 'A', weeks: '' },
  { id: 10, cid: 7, name: '小学数学课程与教学论', teacher: '示例教师6', room: '3号楼305', day: 2, period: 2, group: null, weeks: '1,2,3,4' },
  { id: 25, cid: 8, name: '小学数学课程与教学论', teacher: '示例教师6', room: '3号楼112', day: 2, period: 2, group: 'A', weeks: '5,6,7,8,9,10,11,12,13,14,15,16' },
  { id: 22, cid: 17, name: '三笔字', teacher: '示例教师7', room: '3号楼111', day: 2, period: 5, group: 'A', weeks: '' },

  // ── 周三 ──
  { id: 9, cid: 6, name: '小学人工智能教育', teacher: '示例教师5', room: '3号楼110', day: 3, period: 1, group: 'B', weeks: '' },
  { id: 11, cid: 8, name: '小学数学课程与教学论', teacher: '示例教师6', room: '3号楼112', day: 3, period: 2, group: 'B', weeks: '5,6,7,8,9,10,11,12,13,14,15,16' },
  { id: 12, cid: 9, name: '小学生心理健康指导', teacher: '示例教师8', room: '3号楼222', day: 3, period: 3, group: null, weeks: '1,3,5,7,9,11,13,15' },
  { id: 13, cid: 10, name: '小学生心理健康指导', teacher: '示例教师8', room: '3号楼121', day: 3, period: 3, group: 'A', weeks: '2,4,6,8,10,12,14,16' },
  { id: 14, cid: 11, name: '小学生心理健康指导', teacher: '示例教师8', room: '3号楼123', day: 3, period: 4, group: 'B', weeks: '2,4,6,8,10,12,14,16' },
  { id: 15, cid: 12, name: '音乐基础', teacher: '示例教师9', room: '二区302', day: 3, period: 5, group: 'A', weeks: '' },

  // ── 周四 ──
  { id: 18, cid: 14, name: '小学语文课程与教学论', teacher: '示例教师10', room: '一区212', day: 4, period: 1, group: 'A', weeks: '5,6,7,8,9,10,11,12,13,14,15,16' },
  { id: 17, cid: 13, name: '小学语文课程与教学论', teacher: '示例教师10', room: '3号楼303', day: 4, period: 2, group: null, weeks: '1,2,3,4' },
  { id: 19, cid: 14, name: '小学语文课程与教学论', teacher: '示例教师10', room: '一区212', day: 4, period: 2, group: 'B', weeks: '5,6,7,8,9,10,11,12,13,14,15,16' },
  { id: 6, cid: 4, name: '习近平新时代中国特色社会主义思想概论', teacher: '示例教师3', room: '3号楼213', day: 4, period: 3, group: null, weeks: '1,3,5,7,9,11,15' },
  { id: 7, cid: 5, name: '习近平新时代中国特色社会主义思想概论', teacher: '示例教师3', room: '精神谱系馆', day: 4, period: 3, group: null, weeks: '13' },
  { id: 16, cid: 12, name: '音乐基础', teacher: '示例教师9', room: '二区302', day: 4, period: 5, group: 'B', weeks: '' },

  // ── 周五 ──
  { id: 20, cid: 15, name: '小学综合实践活动设计', teacher: '示例教师11', room: '3号楼110', day: 5, period: 1, group: 'A', weeks: '' },
  { id: 23, cid: 17, name: '三笔字', teacher: '示例教师7', room: '3号楼111', day: 5, period: 1, group: 'B', weeks: '' },
  { id: 21, cid: 16, name: '小学综合实践活动设计', teacher: '示例教师11', room: '3号楼113', day: 5, period: 2, group: 'B', weeks: '' },
  { id: 24, cid: 18, name: '儿童文学', teacher: '示例教师12', room: '3号楼205', day: 5, period: 3, group: null, weeks: '' }
];

/** 2026 法定节假日（国办发明电〔2025〕7 号）：OFF=放假，MAKEUP=调休上班 */
const SEED_HOLIDAYS = [
  { date: '2026-09-20', name: '国庆节调休上班', kind: 'MAKEUP' },
  { date: '2026-09-25', name: '中秋节', kind: 'OFF' },
  { date: '2026-09-26', name: '中秋节', kind: 'OFF' },
  { date: '2026-09-27', name: '中秋节', kind: 'OFF' },
  { date: '2026-10-01', name: '国庆节', kind: 'OFF' },
  { date: '2026-10-02', name: '国庆节', kind: 'OFF' },
  { date: '2026-10-03', name: '国庆节', kind: 'OFF' },
  { date: '2026-10-04', name: '国庆节', kind: 'OFF' },
  { date: '2026-10-05', name: '国庆节', kind: 'OFF' },
  { date: '2026-10-06', name: '国庆节', kind: 'OFF' },
  { date: '2026-10-07', name: '国庆节', kind: 'OFF' },
  { date: '2026-10-10', name: '国庆节调休上班', kind: 'MAKEUP' },
  { date: '2027-01-01', name: '元旦', kind: 'OFF' }
];

const SEED_SHIFTS = [];

/* ---------------------------- 日期 / 周次 ---------------------------- */

function pad(n) { return n < 10 ? '0' + n : String(n); }

/** 学期起始日 + 周次 + 星期(1-7) → 'YYYY-MM-DD'（本地时区，不加 UTC 偏移） */
function dateOfWeekDay(termStart, week, weekday) {
  const p = String(termStart || '').split('-');
  if (p.length !== 3) return '';
  const base = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  if (isNaN(base.getTime())) return '';
  base.setDate(base.getDate() + (Number(week) - 1) * 7 + (Number(weekday) - 1));
  return base.getFullYear() + '-' + pad(base.getMonth() + 1) + '-' + pad(base.getDate());
}

/** weeks 为空串 = 每周都上；否则只有在集合里才上 */
function matchesWeeks(weeks, wk) {
  const s = String(weeks || '').trim();
  if (!s) return true;
  const set = {};
  s.split(',').forEach(x => { const n = Number(x); if (n) set[n] = 1; });
  return !!set[Number(wk)];
}

/** 'YYYY-MM-DD' → {y,m,d} 或 null */
function ymdToParts(date) {
  const p = String(date || '').split('-');
  if (p.length !== 3) return null;
  const y = Number(p[0]); const m = Number(p[1]); const d = Number(p[2]);
  if (!y || !m || !d) return null;
  return { y, m, d };
}

/** 星期几（1=周一 … 7=周日），本地时区 */
function dowOfDate(date) {
  const parts = ymdToParts(date);
  if (!parts) return 0;
  const dt = new Date(parts.y, parts.m - 1, parts.d);
  const w = dt.getDay();
  return w === 0 ? 7 : w;
}

/** 某个日期属于第几周（从开学日算，开学前返回 0） */
function weekOfDate(date) {
  const parts = ymdToParts(date);
  if (!parts) return 0;
  const bp = String(TERM_START || '').split('-');
  if (bp.length !== 3) return 0;
  const base = new Date(Number(bp[0]), Number(bp[1]) - 1, Number(bp[2]));
  const dt = new Date(parts.y, parts.m - 1, parts.d);
  const diff = Math.round((dt.getTime() - base.getTime()) / 86400000);
  if (diff < 0) return 0;
  return Math.floor(diff / 7) + 1;
}

/** 'YYYY-MM-DD' → 'MM/DD'（表头 / 角标展示用） */
function mdText(date) {
  const parts = ymdToParts(date);
  if (!parts) return '';
  return pad(parts.m) + '/' + pad(parts.d);
}

/* ---------------------------- 存储读写 ---------------------------- */

function _read(key, fallback) {
  try {
    const v = wx.getStorageSync(key);
    if (Array.isArray(v)) return v;
  } catch (e) { /* 读不到就用种子值 */ }
  return fallback.slice();
}

function _write(key, list) {
  try { wx.setStorageSync(key, list || []); } catch (e) { /* 忽略写入失败 */ }
}

const holidays = () => _read(KEY_HOLIDAYS, SEED_HOLIDAYS);
const shifts = () => _read(KEY_SHIFTS, SEED_SHIFTS);
const saveHolidays = list => _write(KEY_HOLIDAYS, list);
const saveShifts = list => _write(KEY_SHIFTS, list);

/* ------------------- 临时调课（按周生效的课次例外） -------------------
 * 存的是一个数组（wx.Storage 读写数组最稳），每项：
 *   { sessionId, week, kind: 'OFF' | 'MOVE', toDay, toPeriod, note }
 * kind=OFF  → 该课次这一周不上
 * kind=MOVE → 该课次这一周改到 toDay / toPeriod（同周内，不跨周）
 * 「按天整体调课」（shifts）解决的是「某一天整体挪走」，
 * 这里解决的是「某一节课这一周例外」，两者正交、可叠加。
 * ------------------------------------------------------------------ */
const SEED_SESS_SHIFTS = [];
const sessShifts = () => _read(KEY_SESS_SHIFTS, SEED_SESS_SHIFTS);
const saveSessShifts = list => _write(KEY_SESS_SHIFTS, list);

const shiftKey = (sessionId, week) => Number(sessionId) + '#' + Number(week);

/** 数组 → '<sessionId>#<week>' 索引，方便 O(1) 查 */
function sessShiftMap(list) {
  const map = {};
  (list || sessShifts()).forEach((s) => {
    if (!s) return;
    map[shiftKey(s.sessionId, s.week)] = s;
  });
  return map;
}

/**
 * 一个课次在某一周的「实际落位」——**与云端 common/week.js 的 resolveSlot 同构**。
 * @returns {null|{day,period,shifted}} null = 这一周不上
 */
function resolveSlot(sessionId, dayOfWeek, period, week, map) {
  const m = map || sessShiftMap();
  const ov = m[shiftKey(sessionId, week)];
  if (ov) {
    if (ov.kind === 'OFF') return null;
    return {
      day: Number(ov.toDay) || Number(dayOfWeek),
      period: Number(ov.toPeriod) || Number(period),
      shifted: true
    };
  }
  return { day: Number(dayOfWeek), period: Number(period), shifted: false };
}

/** 写入 / 覆盖若干条临时调课（按 sessionId#week 去重） */
function upsertSessShifts(items) {
  const list = sessShifts().slice();
  (items || []).forEach((it) => {
    if (!it || !it.sessionId || !it.week) return;
    const i = list.findIndex(x => Number(x.sessionId) === Number(it.sessionId)
      && Number(x.week) === Number(it.week));
    const item = {
      sessionId: Number(it.sessionId),
      week: Number(it.week),
      kind: it.kind === 'MOVE' ? 'MOVE' : 'OFF',
      toDay: it.kind === 'MOVE' ? Number(it.toDay) || null : null,
      toPeriod: it.kind === 'MOVE' ? Number(it.toPeriod) || null : null,
      note: String(it.note || '')
    };
    if (i >= 0) list[i] = item; else list.push(item);
  });
  _write(KEY_SESS_SHIFTS, list);
  return list;
}

/** 删除若干条临时调课；weeks 为空数组表示不限周次 */
function removeSessShifts(sessionIds, weeks) {
  const ids = (sessionIds || []).map(Number);
  const wks = (weeks || []).map(Number);
  const list = sessShifts().filter((x) => {
    if (ids.length && ids.indexOf(Number(x.sessionId)) < 0) return true;
    if (wks.length && wks.indexOf(Number(x.week)) < 0) return true;
    return false;
  });
  _write(KEY_SESS_SHIFTS, list);
  return list;
}

/** 本周的临时调课清单（供「调课结果」列表展示，已带上课程名） */
function sessShiftsOfWeek(wk) {
  const byId = {};
  sessions().forEach(s => { byId[Number(s.id)] = s; });
  return sessShifts()
    .filter(x => Number(x.week) === Number(wk))
    .map((x) => {
      const s = byId[Number(x.sessionId)] || {};
      return {
        sessionId: Number(x.sessionId),
        name: s.name || ('课次 #' + x.sessionId),
        room: s.room || '',
        fromDay: Number(s.day) || 0,
        fromPeriod: Number(s.period) || 0,
        kind: x.kind,
        toDay: x.toDay,
        toPeriod: x.toPeriod,
        note: x.note || '',
        week: Number(x.week)
      };
    })
    .sort((a, b) => (a.fromDay - b.fromDay) || (a.fromPeriod - b.fromPeriod));
}


/**
 * 课次列表：优先读 Storage（管理员改过），否则用内置的种子数据。
 * 种子数据本身就是库里真实课表的一份快照，所以断网/未登录也有完整课表。
 */
const sessions = () => _read(KEY_SESSIONS, SEED_SESSIONS);

/** 新增 / 更新一条课次（管理员编辑课表后调用，与数据库同步后落本地） */
function upsertSession(item) {
  const list = sessions().slice();
  const i = list.findIndex(s => Number(s.id) === Number(item.id));
  if (i >= 0) list[i] = item; else list.push(item);
  _write(KEY_SESSIONS, list);
  return list;
}

/** 删除一条课次 */
function removeSession(id) {
  const list = sessions().filter(s => Number(s.id) !== Number(id));
  _write(KEY_SESSIONS, list);
  return list;
}

/** 恢复内置课表（清掉本地改动） */
function resetSessions() { _write(KEY_SESSIONS, SEED_SESSIONS.slice()); }

/**
 * 某周某星期几的实际上课日期。
 * 放假且没有调课 → null（本周这天不上课）
 * 有调课记录 → 返回调课后的日期
 */
function classDateOf(wk, dayOfWeek) {
  const date = dateOfWeekDay(TERM_START, wk, dayOfWeek);
  if (!date) return { date: '', shifted: false };
  const sh = shifts().find(s => String(s.from).slice(0, 10) === date);
  if (sh) return { date: String(sh.to).slice(0, 10), shifted: true, originalDate: date };
  const h = holidays().find(x => String(x.date).slice(0, 10) === date);
  if (h && h.kind === 'OFF') return { date: '', shifted: false };
  return { date, shifted: false };
}

/**
 * 某周的课次列表，字段命名沿用服务端 course.listWeek，页面无需改结构。
 * 处理顺序：
 *   ① 过滤上课周次；
 *   ② 套「临时调课」session_shift（OFF→本周不上；MOVE→换到别的格）；
 *   ③ 套「按天整体调课」day_shift（校历级）：
 *        - 调出日：当天的课从原列消失，打「调至 MM/DD」；
 *        - 调入日：把调出日那天的课加进来，打「自 MM/DD 调入」；
 *      两者都只改「显示 / 值日日期」，不删课次本身。
 *   ④ 放假照常显示，仅打「假期」标记（便于长按临时调课）。
 * 每个 (星期, 节次) 可能有多节课（调入 + 原本就有的），所以返回扁平列表，
 * 由页面 _build 按 (dayOfWeek, period) 聚合成「一格多课」。
 */
function sessionsOfWeek(wk) {
  const out = [];
  const map = sessShiftMap();
  const holidayMap = {};
  holidays().forEach(h => { holidayMap[String(h.date).slice(0, 10)] = h; });
  const dayShifts = shifts();

  // ③ 调入：to 日期落在本周的 day_shift → 把 from 那天（from 所在周）的课搬进来
  dayShifts.forEach(sh => {
    const toDate = String(sh.to).slice(0, 10);
    if (weekOfDate(toDate) !== Number(wk)) return;
    const fromDate = String(sh.from).slice(0, 10);
    const fromWk = weekOfDate(fromDate);
    const toDay = dowOfDate(toDate);
    sessions().forEach(s => {
      if (Number(s.day) !== dowOfDate(fromDate)) return;
      if (!matchesWeeks(s.weeks, fromWk)) return;
      const slot = resolveSlot(s.id, s.day, s.period, fromWk, map);
      if (!slot) return; // from 那天的这节课本来就不上，无需搬入
      out.push({
        sessionId: s.id,
        courseId: s.cid,
        name: s.name,
        teacher: s.teacher,
        room: s.room,
        weekRule: 'ALL',
        weeks: s.weeks || '',
        groupScope: s.group || null,
        dutyCount: 2,
        dayOfWeek: toDay,
        period: slot.period,
        classDate: toDate,
        originalDate: toDate,
        shifted: true,
        shiftKind: 'DAY_IN',
        isHoliday: false,
        holidayName: '',
        movedOut: false,
        movedIn: true,
        shiftToText: '',
        shiftFromText: mdText(fromDate),
        duties: []
      });
    });
  });

  // ① ② ④ 正常课次 + 调出
  sessions().forEach(s => {
    if (!matchesWeeks(s.weeks, wk)) return;
    const slot = resolveSlot(s.id, s.day, s.period, wk, map);
    if (!slot) return;
    const rawDate = dateOfWeekDay(TERM_START, wk, slot.day);
    if (!rawDate) return;
    // 这节课所在日期被「按天调出」了吗？
    const outShift = dayShifts.find(sh => String(sh.from).slice(0, 10) === rawDate);
    const movedOut = !!outShift;
    const shiftToDate = outShift ? String(outShift.to).slice(0, 10) : '';
    const h = holidayMap[rawDate];
    const isHoliday = !!(h && h.kind === 'OFF') && !movedOut;
    out.push({
      sessionId: s.id,
      courseId: s.cid,
      name: s.name,
      teacher: s.teacher,
      room: s.room,
      weekRule: 'ALL',
      weeks: s.weeks || '',
      groupScope: s.group || null,
      dutyCount: 2,
      dayOfWeek: slot.day,
      period: slot.period,
      classDate: movedOut ? shiftToDate : rawDate,
      originalDate: rawDate,
      shifted: movedOut || slot.shifted,
      shiftKind: movedOut ? 'DAY_OUT' : (slot.shifted ? 'SESSION' : ''),
      isHoliday: isHoliday,
      holidayName: isHoliday ? h.name : '',
      movedOut: movedOut,
      movedIn: false,
      shiftToText: movedOut ? mdText(shiftToDate) : '',
      shiftFromText: '',
      duties: []
    });
  });

  return out;
}

module.exports = {
  TERM_START,
  TOTAL_WEEKS,
  SEED_SESSIONS,
  SEED_HOLIDAYS,
  SEED_SHIFTS,
  SEED_SESS_SHIFTS,
  sessions,
  upsertSession,
  removeSession,
  resetSessions,
  holidays,
  shifts,
  saveHolidays,
  saveShifts,
  dateOfWeekDay,
  matchesWeeks,
  weekOfDate,
  classDateOf,
  sessionsOfWeek,
  /* 临时调课 */
  shiftKey,
  sessShifts,
  saveSessShifts,
  sessShiftMap,
  resolveSlot,
  upsertSessShifts,
  removeSessShifts,
  sessShiftsOfWeek
};
