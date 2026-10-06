/**
 * 云函数：member —— 成员与分组（开发文档 8.2 #2）
 * action: list / stats / importCsv / importBatches / revertImport /
 *         addMember / addStaff / staffCode / staffList / removeMember / updateGroup / setStatus / setRole / setPosition / unbind
 *
 * 教职工（X 组，2026-09-26）：辅导员 / 老师没有班级也没有学号，原有绑定链路三重都不适用，
 * 改为「管理员发一次性绑定码 → 本人输入即绑定」（`addStaff` / `staffCode` 在这里生成码，
 * 校验绑定在 auth.bindStaff）。占位学号 `STAFF…`，role 默认 ADMIN，权限由 group_tag='X' 判定。
 *
 * 多班级（§43）：管理员操作的目标班级由 targetClassId 决定（超管/辅导员可跨班）。
 * 名单导入（2026-09-25 扩展）：
 *   · 列序自适应（姓名,学号 / 学号,姓名 / 班级,学号,姓名,性别,指导员 …）
 *   · 支持「班级」列 → 一条名单自动分类到多个班级（先预览、再确认）
 *   · 每次导入落 import_batch(+item)，可「撤回」（删掉这次新插的、还原被改的）
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { getPool } = require('./common/db');
const guard = require('./common/guard');
const week = require('./common/week');
const audit = require('./common/audit');
const { parseXlsx, sheetToText } = require('./xlsx-lite');
const { BizError, ok, fail } = require('./common/resp');

function maskNo(no) {
  const s = String(no || '');
  return s.length <= 4 ? '****' : s.slice(0, s.length - 4) + '****';
}

/**
 * 辅导员（X 组）不展示学号（2026-09-26 需求①）：
 * 辅导员是教职工，那个 student_no 只是入库用的占位学号，展示出来只会让人误以为他是学生。
 * 「我的」页个人卡、成员列表、成员详情、绑定选人列表统一走这两个 helper，
 * 保证前端任何一处都不会再冒出辅导员的学号。
 */
function noOf(r) {
  return (r && r.group_tag === 'X') ? '' : String((r && r.student_no) || '');
}
function maskedNoOf(r) {
  return (r && r.group_tag === 'X') ? '' : maskNo(r && r.student_no);
}

/** 测试账号（99 段）：前端用它代替「按学号前缀过滤」，学号被清空后依然认得出 */
function isTestNo(no) {
  return String(no || '').indexOf(TEST_NO_PREFIX) === 0;
}

/* 测试账号段（学号 2608057499xx，id 69+）：不计入任何人数统计，
 * 只在超级管理员的「成员与分组」中展示；绑定名单 / 普通成员列表一律隐藏。
 * SQL 里用 NOT LIKE 前缀过滤（常量拼接，无注入面）。 */
const TEST_NO_PREFIX = '2608057499';
const NOT_TEST = "student_no NOT LIKE '" + TEST_NO_PREFIX + "%'";

/**
 * 班委职位（唯一「可被设为班委」的取值集合，2026-09-26 需求②）。
 * ⚠️ 与前端 `miniprogram/utils/util.js` 的 `POSITIONS` 必须逐字一致 ——
 *    由门禁 `scripts/check-positions-sync.js` 强制比对，改一处必须改另一处。
 * 取值范围与库里 member.position 的实际口径一致（示例班级C 7 名班委职位）。
 */
const POSITIONS = [
  '班长兼团支书', '副班长', '学习委员', '生活委员',
  '组织宣传委员', '文体委员', '心理委员'
];

/**
 * 教职工一次性绑定码（2026-09-26）。
 * 辅导员 / 老师没有班级、没有学号，原有绑定链路（口令 → 名单选人 → 学号后 4 位）
 * 三重都不适用，所以给一条独立入口：管理员现场发码，本人在绑定页输入即完成绑定。
 *
 * · 字符集**去掉易混的 I/O/0/1**（码要口头念给老师，或让老师手抄）；
 *   32 个字符 × 8 位 ≈ 1.1e12 组合，配合 auth.bindStaff 的 openid 失败计数
 *   （5 次锁 30 分钟）与「一次性」（绑成功即清 NULL），枚举不可行。
 * · 有效期 **48 小时**：教职工通常当天拿到，给足跨天余量；过期由管理员「重发」。
 * · ⚠️ 默认 role='ADMIN' —— 与线上既有辅导员（罗翊瑄，role=ADMIN）一致。
 *   辅导员的管理权由 `guard.isCounselor`（group_tag='X'）判定，但路由层
 *   `auth: { needAdmin: true }` 要求 role ∈ {ADMIN,MONITOR}；若给 MEMBER，
 *   辅导员连「加成员 / 建班 / 设班委」都进不去。`is_super` 保持 0（不是超管）。
 */
const STAFF_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const STAFF_CODE_LEN = 8;
const STAFF_CODE_HOURS = 48;

/** 占位学号前缀：member.student_no 是 UNIQUE NOT NULL，教职工也得有个值；不会被展示（noOf 对 X 组返回空串） */
const STAFF_NO_PREFIX = 'STAFF';

function genRand(n, chars) {
  let s = '';
  for (let i = 0; i < n; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

/** 生成一个全局唯一的绑定码（staff_code 有索引，最多试 10 次） */
async function genUniqueStaffCode(pool) {
  for (let i = 0; i < 10; i++) {
    const c = genRand(STAFF_CODE_LEN, STAFF_CODE_CHARS);
    const [rows] = await pool.query('SELECT id FROM member WHERE staff_code = ? LIMIT 1', [c]);
    if (!rows.length) return c;
  }
  throw new BizError(50000, '绑定码生成冲突，请重试');
}

/** 生成一个全局唯一的占位学号（同 addMember 的重复检查口径：student_no 全局唯一） */
async function genUniqueStaffNo(pool) {
  for (let i = 0; i < 10; i++) {
    const c = STAFF_NO_PREFIX + genRand(6, STAFF_CODE_CHARS);
    const [rows] = await pool.query('SELECT id FROM member WHERE student_no = ? LIMIT 1', [c]);
    if (!rows.length) return c;
  }
  throw new BizError(50000, '占位学号生成冲突，请重试');
}

/**
 * 多班级（§43）：管理员操作的目标班级。
 * 默认 = 自己所属班级；可传 payload.classId 切班（v0.7.16 收紧跨班范围）：
 *   超管     → 任意活动班级；
 *   教职工   → 仅 staff_class 绑定集合内的班级（越界 40003）；
 *   普通管理员 → 恒本班（传入被忽略，防伪造越权）。
 * @returns {Promise<number>} 目标 class_id
 */
async function targetClassId(pool, payload, ctx) {
  const me = ctx.member || ctx.realMember;
  const own = guard.classIdOf(ctx);
  const req = Number(payload && payload.classId) || 0;
  if (!req || req === own) return own;
  if (!guard.isSuper(me) && !guard.isCounselor(me)) return own;
  if (guard.isCounselor(me) && !guard.isSuper(me)) {
    const allowed = await guard.staffClassIds(pool, me);
    if (!allowed.includes(req)) throw new BizError(40003, '该班级不在你的教职工绑定范围内');
  }
  const [rows] = await pool.query('SELECT id FROM `class` WHERE id = ? AND is_active = 1 LIMIT 1', [req]);
  if (!rows.length) throw new BizError(41001, '班级不存在或已停用');
  return req;
}

/** 超管或辅导员：可跨班增删成员 / 导入 / 撤回（普通管理员只能管本班名单） */
function requireSuperOrCounselor(ctx) {
  const m = guard.requireBind(ctx);
  if (!(guard.isSuper(m) || guard.isCounselor(m))) {
    throw new BizError(40003, '仅超级管理员或辅导员可操作');
  }
  return m;
}

/**
 * 需求 D：名册录入守卫（**增改不含删**）—— 超管 / 辅导员（可跨班）/ 班长（仅本班）。
 *
 * 覆盖：单个添加、导入（改姓名 / 改分组 / 补学号）、改 A/B 组。
 * **不**覆盖：移出班级、停用、设班委、解绑、教职工名册 —— 那些仍由
 * requireSuperOrCounselor / guard.requireSuper 把守（删比增危险，不与增同级）。
 *
 * 班级隔离：班长只能管本班。班级一律经 targetClassId() 取得，它对非超管、非辅导员
 * 恒返回本班（忽略传入的 classId），因此不存在构造别班 classId 越权的路径。
 */
function requireRosterEditCheck(ctx) {
  return guard.requireRosterEdit(ctx);
}

/**
 * 成员备注 / 主页关注（v0.7.16 需求⑦ + v0.7.17 需求⑥）的作用域校验：
 * 超管放行；教职工要求目标成员在自己绑定的班级里；其余身份一律 40003
 * （学生 / 普通班委不可见备注，也不可关注学生）。
 * @param {string} [what] 动作名（只用于错误文案，如「备注」「关注」）
 * @returns 成员行（调用方继续用 me.id）
 */
async function noteScopeOk(pool, ctx, targetMemberId, what) {
  const label = what || '备注';
  const me = guard.requireBind(ctx);
  if (guard.isSuper(me)) return me;
  if (!guard.isCounselor(me)) throw new BizError(40003, '仅辅导员或超级管理员可管理' + label);
  const [rows] = await pool.query('SELECT id, class_id FROM member WHERE id = ? LIMIT 1', [Number(targetMemberId)]);
  if (!rows.length) throw new BizError(41004, '成员不存在');
  const allowed = await guard.staffClassIds(pool, me);
  if (!allowed.includes(Number(rows[0].class_id))) throw new BizError(40003, '该成员不在你绑定的班级里');
  return me;
}

/** 主页关注的学生上限（v0.7.17 需求⑥）：超过就得先取消一个，避免首页被塞满 */
const PIN_MAX = 8;

/* ============================================================
 * 名单解析：列序自适应
 * ------------------------------------------------------------
 * 不靠固定下标认列，而是看「这一格像什么」：
 *   学号 = 4 位以上纯数字；姓名 = 中文/字母（排除性别、班级字样）；班级 = 含「班」「专业」「专升本」
 * 因此 姓名,学号 / 学号,姓名 / 班级,学号,姓名,性别,指导员 都能吃。
 * ============================================================ */
const GENDER = ['男', '女', '男性', '女性', '男生', '女生'];
const NAME_RE = /^[\u4e00-\u9fa5a-zA-Z·]{1,16}$/;
const NO_RE = /^[A-Za-z0-9]{4,32}$/;
const DIGIT_NO_RE = /^\d{4,}$/;

/**
 * 像「班级」的字样。
 * ⚠️ 「班」只认**结尾**（`示例班级A` / `xx（专升本）示例班级A`）—— 写成「包含班」会把
 * 「班超」这类**姓氏带班**的真实姓名误判成班级，导致那一行读不出姓名。
 * 「专升本 / 专业」出现在任意位置都算（这类词不会出现在人名里）。
 */
function looksLikeClass(s) {
  const t = String(s || '');
  if (/专升本/.test(t) || /专业/.test(t)) return true;
  return /班$/.test(t);
}
function looksLikeName(s) {
  const t = String(s || '');
  if (!NAME_RE.test(t)) return false;
  if (GENDER.indexOf(t) >= 0) return false;
  if (looksLikeClass(t)) return false;
  return true;
}
/** 像「名册序号」的小整数（1~999，容忍 Excel 的 1.0） */
function looksLikeSeq(s) {
  const t = String(s == null ? '' : s).trim();
  if (!/^\d{1,3}(?:\.0+)?$/.test(t)) return false;
  const n = parseInt(t, 10);
  return n >= 1 && n <= 999;
}

/**
 * 一行 → { name, studentNo, seq, label }；识别不出返回 null。
 * 有「姓名」且有「学号 或 序号」就算可用 —— 只有序号时由上层按班级学号前缀补全。
 */
function parseLine(line) {
  // 分隔符：半角/全角逗号、制表符、竖线，或 2 个以上空格
  const parts = String(line).split(/[,，\t|]+|\s{2,}/).map(s => s.trim()).filter(s => s !== '');
  if (!parts.length) return null;
  let studentNo = '';
  let name = '';
  let label = '';
  let seq = 0;
  for (const p of parts) {
    if (!studentNo && DIGIT_NO_RE.test(p)) { studentNo = p; continue; }
    if (!label && looksLikeClass(p)) { label = p; continue; }
    if (!name && looksLikeName(p)) { name = p; continue; }
    if (!seq && looksLikeSeq(p)) { seq = parseInt(p, 10); continue; }
  }
  if (!name) return null;
  if (!studentNo && !seq) return null;
  return { name, studentNo, label, seq };
}

/** 整段文本 → { rows, failed }；自动跳过表头行 */
function parseRoster(text) {
  const lines = String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const rows = [];
  const failed = [];
  lines.forEach((line, i) => {
    // 表头行：含「学号/姓名/班级/专业」等字样又没有纯数字学号 → 跳过不当失败
    const hasDigits = /\d{4,}/.test(line.replace(/[^\d,，\t|]/g, ''));
    if (!hasDigits && /学号|姓名|班级|专业|性别|指导员|序号/.test(line)) return;
    const r = parseLine(line);
    if (!r) { failed.push({ line: i + 1, reason: '缺少姓名，或既没有学号也没有序号', raw: line.slice(0, 40) }); return; }
    rows.push(Object.assign({ line: i + 1 }, r));
  });
  return { rows, failed };
}

/** 从班级标签里取 4 位班号（2001 / 2002 …） */
function classNumberOf(label) {
  const m = /(\d{4})\s*班/.exec(String(label || '')) || /(\d{4})/.exec(String(label || ''));
  return m ? m[1] : '';
}

/**
 * 每个班级「已存在的学号前缀」——用来把名单行对到正确的班（比只看班号更准）：
 * 专业A 2001 = 2001050101xx、专业B 2001 = 2001050201xx，两者班号都是 2601，
 * 只看班号会混；但有存量成员时前缀能区分。
 * @returns {{byPrefix: Map<string,number>, byClass: Map<number,Set<string>>}}
 */
async function loadPrefixMap(pool) {
  const byPrefix = new Map();
  const byClass = new Map();
  const [rows] = await pool.query(
    "SELECT DISTINCT LEFT(student_no, 10) AS p, class_id FROM member WHERE " + NOT_TEST
  );
  rows.forEach(r => {
    if (!r.p) return;
    const p = String(r.p);
    const cid = Number(r.class_id);
    byPrefix.set(p, cid);
    if (!byClass.has(cid)) byClass.set(cid, new Set());
    byClass.get(cid).add(p);
  });
  return { byPrefix, byClass };
}

/**
 * 把「班级标签」解析成目标班级。
 * 优先级：学号前缀命中 > 班号命中；两者不一致标 conflict（交给人工确认，不硬猜）。
 * 「只按班号命中、且与该班已有学号前缀不符」标 weak —— 很可能是同班号的不同专业
 * （如专业B2001 vs 专业A2001），前端提示必须人工确认。
 * @returns {{classId:number, match:string, conflict:boolean, weak:boolean}}
 */
function resolveLabel(label, classes, prefixMaps, sampleNos) {
  const byNumber = classNumberOf(label);
  let byNumberId = 0;
  if (byNumber) {
    const hit = classes.filter(c => String(c.name).indexOf(byNumber) >= 0);
    if (hit.length === 1) byNumberId = Number(hit[0].id);
  }
  let byPrefixId = 0;
  let rowPrefix = '';
  for (const no of (sampleNos || [])) {
    const p = String(no).slice(0, 10);
    if (!rowPrefix) rowPrefix = p;
    if (prefixMaps.byPrefix.has(p)) { byPrefixId = prefixMaps.byPrefix.get(p); break; }
  }
  if (byPrefixId && byNumberId && byPrefixId !== byNumberId) {
    return { classId: byPrefixId, match: 'conflict', conflict: true, weak: false };
  }
  if (byPrefixId) return { classId: byPrefixId, match: 'prefix', conflict: false, weak: false };
  if (byNumberId) {
    const set = prefixMaps.byClass.get(byNumberId);
    const weak = !!(set && set.size && rowPrefix && !set.has(rowPrefix));
    return { classId: byNumberId, match: 'number', conflict: false, weak };
  }
  return { classId: 0, match: 'none', conflict: false, weak: false };
}

/** 学号末位奇偶分组：奇 A 偶 B（与既有口径一致） */
function groupOf(studentNo) {
  const last = parseInt(String(studentNo).slice(-1), 10);
  return last % 2 === 0 ? 'B' : 'A';
}

/**
 * 各班「学号前缀」——用于把「只有序号没有学号」的名册补成完整学号。
 * 仅当该班存量成员的学号**长度一致、前 N-2 位一致、末 2 位是数字**时才认为可推导。
 * ⚠️ 必须排除 X 组：教职工用 `STAFF…` 占位学号（2026-09-26 新增绑定码时引入），
 *    它会同时把 `pfx`（前 10 位种类）和 `lens`（长度种类）顶成 2 →
 *    整个班级判定为「不可推导」，序号名册补学号功能**静默失效**。
 * @returns {Map<number,{prefix:string,width:number}>} class_id → 前缀
 */
async function loadSeqPrefix(pool) {
  const map = new Map();
  const [rows] = await pool.query(
    "SELECT class_id, MIN(student_no) AS mn, COUNT(*) AS n, COUNT(DISTINCT LEFT(student_no,10)) AS pfx, COUNT(DISTINCT LENGTH(student_no)) AS lens FROM member WHERE " + NOT_TEST + " AND group_tag <> 'X' GROUP BY class_id"
  );
  rows.forEach((r) => {
    const mn = String(r.mn || '');
    if (Number(r.pfx) === 1 && Number(r.lens) === 1 && mn.length >= 5 && /^\d+$/.test(mn)) {
      map.set(Number(r.class_id), { prefix: mn.slice(0, mn.length - 2), width: 2 });
    }
  });
  return map;
}

function pad2(n, width) {
  return String(n).padStart(width, '0');
}

/** 批量取已存在成员（按学号） */
async function loadExisting(pool, studentNos) {
  const map = new Map();
  for (let i = 0; i < studentNos.length; i += 400) {
    const chunk = studentNos.slice(i, i + 400);
    if (!chunk.length) continue;
    const [er] = await pool.query(
      'SELECT id, name, student_no, group_tag, class_id FROM member WHERE student_no IN (' + chunk.map(() => '?').join(',') + ')',
      chunk
    );
    er.forEach(r => map.set(String(r.student_no), r));
  }
  return map;
}

/* ============================================================
 * 批量导入（文本 / Excel 共用）
 * ============================================================ */

/** 班级标签 → 新建班级用的名字（保留专业信息，避免同班号不同专业重名） */
function deriveClassName(label) {
  let n = String(label || '').trim();
  if (!n) return '';
  n = n.replace(/\s+/g, '');
  if (!/班$/.test(n)) n += '班';
  return n.slice(0, 60);
}

/** 生成不与现有班级冲突的口令（6 位数字）与邀请码（CLS26A + 序号） */
async function allocClassKeys(pool) {
  let token = '';
  for (let i = 0; i < 50; i++) {
    const t = String(Math.floor(100000 + Math.random() * 900000));
    const [dup] = await pool.query('SELECT id FROM `class` WHERE join_token = ? OR invite_code = ? LIMIT 1', [t, t]);
    if (!dup.length) { token = t; break; }
  }
  if (!token) throw new BizError(50001, '口令分配失败');
  const [rows] = await pool.query("SELECT invite_code FROM `class` WHERE invite_code LIKE 'CLS26A%'");
  let max = 1;
  rows.forEach((r) => {
    const m = /^CLS26A(\d+)$/.exec(String(r.invite_code || ''));
    if (m) max = Math.max(max, Number(m[1]));
  });
  let code = '';
  for (let n = max + 1; n < max + 100; n++) {
    const c = 'CLS26A' + String(n).padStart(2, '0');
    const [dup] = await pool.query('SELECT id FROM `class` WHERE invite_code = ? LIMIT 1', [c]);
    if (!dup.length) { code = c; break; }
  }
  if (!code) throw new BizError(50001, '邀请码分配失败');
  return { token, code };
}

/**
 * 按名字取或新建班级（Excel 导入时「自动添加班级」用）。
 * 名字已存在则直接复用，不重复建。
 * ⚠️ 与 cloudfunctions/class/index.js 的建班逻辑同源；改动请同步两处。
 */
async function ensureClass(pool, name, classes) {
  const exist = classes.find(c => String(c.name) === String(name));
  if (exist) return Number(exist.id);
  const keys = await allocClassKeys(pool);
  const [base] = await pool.query('SELECT term_start, total_weeks, period_time FROM `class` WHERE id = 1 LIMIT 1');
  const termStart = (base[0] && base[0].term_start) ? week.fmtDate(new Date(base[0].term_start)) : '2026-09-14';
  const totalWeeks = (base[0] && base[0].total_weeks) ? Number(base[0].total_weeks) : 16;
  const periodTime = (base[0] && base[0].period_time) ? base[0].period_time : JSON.stringify([
    { period: 1, start: '08:00', end: '09:40' }, { period: 2, start: '10:05', end: '11:45' },
    { period: 3, start: '14:00', end: '15:40' }, { period: 4, start: '16:00', end: '17:40' },
    { period: 5, start: '19:00', end: '20:40' }
  ]);
  const [r] = await pool.query(
    'INSERT INTO `class` (name, join_token, invite_code, term_start, total_weeks, bind_open, period_time, is_active) VALUES (?, ?, ?, ?, ?, 1, ?, 1)',
    [name, keys.token, keys.code, termStart, totalWeeks, typeof periodTime === 'string' ? periodTime : JSON.stringify(periodTime)]
  );
  classes.push({ id: r.insertId, name });
  return Number(r.insertId);
}

/**
 * 解析出的行 → 分组（含目标班级判定）。
 * @param {object} opts { classes, prefixMaps, mapping, createLabels, fallbackClass }
 */
function buildGroups(rows, opts) {
  const buckets = new Map();
  rows.forEach((r) => {
    const key = r.label || '__none__';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  });
  const groups = [];
  for (const [label, list] of buckets) {
    const key = label === '__none__' ? '' : label;
    let classId = 0;
    let match = 'none';
    let conflict = false;
    let weak = false;
    let willCreate = false;
    if (opts.mapping && opts.mapping[label] !== undefined && Number(opts.mapping[label])) {
      classId = Number(opts.mapping[label]);
      match = 'manual';
    } else if (opts.createLabels && opts.createLabels.indexOf(label) >= 0 && key) {
      willCreate = true;
      match = 'create';
    } else {
      // 1) 精确匹配已有班级名：名字完全一致才算同一班，避免「专业B2001」被错配到「专业A2001」
      const exact = opts.classes.find(c => String(c.name) === String(key));
      if (exact) {
        classId = Number(exact.id);
        match = 'exact';
      } else if (opts.autoCreate && key) {
        // 2) 整表批量导入：名字不在已有班级里 → 直接标「将新建」（确认后真的建）
        willCreate = true;
        match = 'create';
      } else if (opts.fallbackClass) {
        classId = opts.fallbackClass;
        match = 'fixed';
      } else {
        // 3) 单班导入兜底：按班号 / 学号前缀猜测（可能 weak / conflict，交人工确认，不静默导入）
        const res = resolveLabel(key, opts.classes, opts.prefixMaps, list.map(x => x.studentNo));
        classId = res.classId; match = res.match; conflict = res.conflict; weak = res.weak;
      }
    }
    const cls = opts.classes.find(c => Number(c.id) === Number(classId)) || null;
    const missingNo = list.filter(x => !x.studentNo).length;
    const seqInfo = (classId && opts.seqPrefixMap) ? opts.seqPrefixMap.get(Number(classId)) : null;
    const seqRow = list.find(x => !x.studentNo && x.seq);
    groups.push({
      label: key,
      classId,
      className: cls ? cls.name : '',
      count: list.length,
      match,
      conflict,
      weak,
      willCreate,
      suggestName: deriveClassName(key),
      missingNo,
      seqSample: (seqInfo && seqRow) ? (seqInfo.prefix + pad2(seqRow.seq, seqInfo.width)) : '',
      sample: list.slice(0, 5).map(x => x.name + '(' + (x.studentNo ? String(x.studentNo).slice(-2) : ('序号' + x.seq)) + ')'),
      rows: list
    });
  }
  return groups;
}

/** 预览响应（文本与 Excel 两条链路共用） */
function previewOf(rows, failed, groups) {
  const allMissingNo = rows.length > 0 && rows.every(r => !r.studentNo);
  return {
    preview: true,
    parsed: rows.length,
    total: rows.length,
    allMissingNo,
    failed: (failed || []).slice(0, 20),
    groups: groups.map(g => ({
      label: g.label, classId: g.classId, className: g.className, count: g.count,
      match: g.match, conflict: g.conflict, weak: g.weak, willCreate: g.willCreate,
      suggestName: g.suggestName, missingNo: g.missingNo, seqSample: g.seqSample, sample: g.sample,
      stat: g.stat || null, diffs: g.diffs || []
    })),
    unmatched: groups.filter(g => !g.classId && !g.willCreate).map(g => ({ label: g.label, count: g.count }))
  };
}

/**
 * 给每个分组标注「与库里的差异」，供预览时先校验再决定导不导：
 *   fresh  库里没有 → 新增
 *   same   已存在且姓名/分组完全一致 → 无需导入，跳过
 *   diff   已存在但姓名或分组不同 → 会被更新（附前几条差异）
 *   other  学号已属于别的班级 → 不导入
 * 注意：只有整份名单都没有学号（要按序号补全）时，补全在写入阶段才做，
 * 这里对没有学号的行走「fresh」计数（说不准，交给写入阶段如实统计）。
 */
function annotateExisting(groups, existing) {
  groups.forEach((g) => {
    let fresh = 0, same = 0, diff = 0, other = 0;
    const diffs = [];
    g.rows.forEach((r) => {
      if (!r.studentNo) { fresh += 1; return; }
      const prev = existing.get(r.studentNo);
      if (!prev) { fresh += 1; return; }
      if (!g.classId || Number(prev.class_id) !== Number(g.classId)) { other += 1; return; }
      const want = groupOf(r.studentNo);
      if (String(prev.name) === String(r.name) && String(prev.group_tag) === want) { same += 1; return; }
      diff += 1;
      if (diffs.length < 5) {
        diffs.push({ name: r.name, wasName: prev.name, wasGroup: prev.group_tag || '', nowGroup: want });
      }
    });
    g.stat = { fresh, same, diff, other, total: g.rows.length };
    g.diffs = diffs;
  });
}

/** 预览时先查一遍库里已有成员，标注差异（「先检测验证，无问题就跳过」） */
async function annotateForPreview(pool, rows, groups) {
  const nos = [];
  rows.forEach(r => { if (r.studentNo) nos.push(r.studentNo); });
  const existing = nos.length ? await loadExisting(pool, nos) : new Map();
  annotateExisting(groups, existing);
}

/**
 * 真正写库：审核 → 逐行 insert/update → 落 import_batch(+item)。
 * @returns 统计结果（供前端展示与撤回）
 */
async function applyImport(pool, ctx, opts) {
  const { rows, failed, groups, createMissing, createNames } = opts;
  const createdClasses = [];
  if (createMissing) {
    for (const g of groups) {
      if (g.classId || !g.willCreate) continue;
      // 班级名允许在导入预览时修改：优先用 createNames[label]，回退 suggestName / 原始 label
      const wantName = String((createNames && createNames[g.label]) || g.suggestName || g.label || '').trim();
      if (!wantName) continue;
      const id = await ensureClass(pool, wantName, opts.classes);
      g.classId = id;
      g.className = wantName;
      createdClasses.push(wantName);
    }
  }
  let validGroups = groups.filter(g => g.classId);
  if (!validGroups.length) throw new BizError(41001, '没有可导入的班级：请先选班，或勾选「自动新建班级」');

  /*
   * 需求 D（2026-09-27）：名册写入权下放到「班长」后，这里必须补跨班兜底。
   * `mapping` 是前端回传的 { 班级标签 → classId }，可被伪造，而本函数只认 `g.classId`
   * —— 原先没人在此校验调用者班级，等于**跨班批量改姓名 / 分组**（此前只卡 needAdmin）。
   * 非超管 / 非辅导员只允许写自己那一班；越界的分组整组剔除，并**不静默**：计入 skipped 回报原因。
   */
  let scopeSkipped = [];
  {
    const meScope = ctx.member || ctx.realMember;
    if (!(guard.isSuper(meScope) || guard.isCounselor(meScope))) {
      const ownClassId = Number(guard.classIdOf(ctx));
      scopeSkipped = validGroups
        .filter(g => Number(g.classId) !== ownClassId)
        .map(g => ({ line: 0, reason: '不属于你的班级：' + (g.className || g.label || g.classId), name: '', studentNo: '' }));
      validGroups = validGroups.filter(g => Number(g.classId) === ownClassId);
      if (!validGroups.length) throw new BizError(40003, '只能导入本班名单');
    }
  }

  /*
   * 「只有序号、没有学号」的名册（如「示例班级C点名册.xlsx」：序号|姓名）：
   * 若整份名单都没有学号，则按目标班级的学号前缀 + 序号补全（2608057403 + 01）。
   * 前缀来自该班存量成员（长度一致 + 前 N-2 位一致才可用），补不完的行如实报失败。
   */
  const allMissingNo = rows.length > 0 && rows.every(r => !r.studentNo);
  const noNoRows = [];
  if (allMissingNo) {
    for (const g of validGroups) {
      const info = opts.seqPrefixMap ? opts.seqPrefixMap.get(Number(g.classId)) : null;
      for (const r of g.rows) {
        if (r.studentNo) continue;
        if (!info || !r.seq) {
          noNoRows.push({ line: r.line, reason: '只有姓名，且该班无法按序号补全学号', name: r.name, studentNo: '' });
          continue;
        }
        r.studentNo = info.prefix + pad2(r.seq, info.width);
        r.synthesized = true;
      }
    }
    if (!noNoRows.length) console.log(JSON.stringify({ fn: 'member', action: 'import', seqDerived: true, classIds: validGroups.map(g => g.classId) }));
  }

  const auditRes = await audit.msgSecCheck(ctx.openid, rows.map(x => x.name + ' ' + (x.studentNo || '')).join('\n'));
  if (!auditRes.pass) throw new BizError(43001, '名单内容未通过安全审核，请检查后重试');

  const targetNos = [];
  validGroups.forEach(g => g.rows.forEach(r => targetNos.push(r.studentNo)));
  const existing = await loadExisting(pool, targetNos);

  const insertedNos = [];
  const updatedItems = [];
  const skippedRows = noNoRows.concat(scopeSkipped);
  let imported = 0;
  let updatedCount = 0;
  let unchangedCount = 0;
  const perClass = {};

  for (const g of validGroups) {
    perClass[g.classId] = perClass[g.classId] || { classId: g.classId, className: g.className, imported: 0, updated: 0, skipped: 0, unchanged: 0 };
    for (const r of g.rows) {
      if (!r.studentNo) continue;   // 已在上面记入 skippedRows
      const prev = existing.get(r.studentNo);
      const group = groupOf(r.studentNo);
      try {
        if (prev) {
          if (Number(prev.class_id) !== Number(g.classId)) {
            // 已存在且属于别的班 → 拒绝跨班搬运（防串号），报告给人看
            skippedRows.push({ line: r.line, reason: '学号已属于其它班级', name: r.name, studentNo: r.studentNo });
            perClass[g.classId].skipped += 1;
            continue;
          }
          // 已存在且姓名 + 分组完全一致 → 不写库、不计「更新」，如实算「无变化」
          if (String(prev.name) === String(r.name) && String(prev.group_tag) === group) {
            unchangedCount += 1;
            perClass[g.classId].unchanged += 1;
            continue;
          }
          await pool.query('UPDATE member SET name = ?, group_tag = ? WHERE id = ?', [r.name, group, prev.id]);
          updatedItems.push({ id: prev.id, prevName: prev.name, prevGroup: prev.group_tag });
          updatedCount += 1;
          perClass[g.classId].updated += 1;
        } else {
          await pool.query(
            'INSERT INTO member (name, student_no, group_tag, class_id) VALUES (?, ?, ?, ?)',
            [r.name, r.studentNo, group, g.classId]
          );
          insertedNos.push(r.studentNo);
          imported += 1;
          perClass[g.classId].imported += 1;
        }
      } catch (e) {
        skippedRows.push({ line: r.line, reason: '写入失败', name: r.name, studentNo: r.studentNo });
        perClass[g.classId].skipped += 1;
      }
    }
  }

  const [batch] = await pool.query(
    'INSERT INTO import_batch (class_id, operator_id, label, total, inserted, updated) VALUES (?, ?, ?, ?, ?, ?)',
    [validGroups.length === 1 ? validGroups[0].classId : 0,
      ctx.member.id,
      validGroups.map(g => g.className).filter(Boolean).join('、').slice(0, 120),
      rows.length, imported, updatedCount]
  );
  const batchId = batch.insertId;
  if (insertedNos.length) {
    const idMap = new Map();
    for (let i = 0; i < insertedNos.length; i += 400) {
      const chunk = insertedNos.slice(i, i + 400);
      const [ir] = await pool.query(
        'SELECT id, student_no FROM member WHERE student_no IN (' + chunk.map(() => '?').join(',') + ')',
        chunk
      );
      ir.forEach(x => idMap.set(String(x.student_no), x.id));
    }
    for (const no of insertedNos) {
      const mid = idMap.get(no);
      if (mid) await pool.query('INSERT INTO import_batch_item (batch_id, member_id, action) VALUES (?, ?, ?)', [batchId, mid, 'INSERT']);
    }
  }
  for (const it of updatedItems) {
    await pool.query(
      'INSERT INTO import_batch_item (batch_id, member_id, action, prev_name, prev_group) VALUES (?, ?, ?, ?, ?)',
      [batchId, it.id, 'UPDATE', it.prevName, it.prevGroup]
    );
  }

  const statClassId = validGroups.length === 1 ? validGroups[0].classId : (Number(opts.fallbackClass) || guard.classIdOf(ctx));
  const [st] = await pool.query(
    "SELECT SUM(group_tag='A') AS a, SUM(group_tag='B') AS b FROM member WHERE class_id = ? AND status != 'DISABLED' AND " + NOT_TEST,
    [statClassId]
  );
  return {
    batchId,
    imported,
    updated: updatedCount,
    unchanged: unchangedCount,
    skipped: skippedRows.length,
    failed: (failed || []).concat(noNoRows.map(x => ({ line: x.line, reason: x.reason }))).slice(0, 20),
    skippedRows: skippedRows.slice(0, 20),
    groups: Object.keys(perClass).map(k => perClass[k]),
    createdClasses,
    groupA: Number(st[0].a) || 0,
    groupB: Number(st[0].b) || 0
  };
}

const routes = {
  /** public='bind' 绑定态脱敏列表；public='manage' 管理员全量 */
  /** public='roster' 绑定中名单：凭班级口令换取（脱敏），用于绑定选人 */
  list: {
    auth: null,
    handler: async (payload, ctx) => {
      const pool = getPool();
      if (payload.public === 'roster') {
        const token = String(payload.token || '').trim();
        if (!token) throw new BizError(41001, '参数错误');
        // 多班级：token → class_id，只列该班成员
        const [cfgRows] = await pool.query(
          'SELECT id FROM `class` WHERE (join_token = ? OR invite_code = ?) AND is_active = 1 LIMIT 1', [token, token]
        );
        if (!cfgRows.length) throw new BizError(40004, '口令不正确');
        const classId = Number(cfgRows[0].id);
        const kw = String(payload.kw || '').trim();
        // 教职工（X 组）走独立的一次性绑定码入口，不进学生名单（2026-09-26）
        let sql = "SELECT id, name, student_no, group_tag, openid FROM member WHERE class_id = ? AND status != 'DISABLED' AND " + NOT_TEST + " AND group_tag <> 'X'";
        const args = [classId];
        if (kw) {
          sql += ' AND name LIKE ?';
          args.push('%' + kw + '%');
        }
        sql += ' ORDER BY name';
        const [rows] = await pool.query(sql, args);
        return rows.map(r => ({
          id: r.id,
          name: r.name,
          studentNoMasked: maskedNoOf(r),
          groupTag: r.group_tag,
          bound: !!r.openid
        }));
      }
      if (payload.public === 'manage') {
        guard.requireAdmin(ctx);
        const classId = await targetClassId(pool, payload, ctx);
        const kw = String(payload.kw || '').trim();
        /*
         * 「值日次数」= 该成员在 duty 表里的**现存行数**（按值日列表现算，被删掉 / 清空的行为天然不计）。
         * ⚠️ 不能用 member.duty_count —— 那是**轮转游标**（决定"下一个排谁"），与"实际被安排了几次"
         *    会漂移（2026-09-27 线上实测：59 人里 25 人 duty_count ≠ 真实行数，游标合计 116 / 实际 86）。
         *    口径与 `duty.myStats` 的 term（本学期总次数）同源 —— 同实体计数/列表须同一条 SQL 语义（§73）。
         */
        let sql = 'SELECT m.*, (SELECT COUNT(*) FROM duty d WHERE d.member_id = m.id) AS live_duty FROM member m WHERE class_id = ?';
        const args = [classId];
        // 测试账号仅超管可见（按生效身份判定：模拟测试超管时同样可见，方便验证视角）
        const isSuperNow = guard.isSuper(ctx.member);
        if (!isSuperNow) sql += ' AND ' + NOT_TEST;
        if (kw) {
          sql += ' AND (name LIKE ? OR student_no LIKE ?)';
          args.push('%' + kw + '%', '%' + kw + '%');
        }
        sql += ' ORDER BY group_tag, student_no';
        const [rows] = await pool.query(sql, args);
        return rows.map(r => ({
          id: r.id, name: r.name, studentNo: noOf(r), groupTag: r.group_tag,
          role: r.role, status: r.status, bound: !!r.openid,
          isSuper: r.is_super === 1,
          test: isTestNo(r.student_no),
          position: r.position || '',
          avatarUrl: r.avatar_url || '',
          // 值日次数 = duty 表现存行数（见上方注释）；不再回传 lastDutyAt —— 前端无消费方
          dutyCount: Number(r.live_duty) || 0
        }));
      }
      guard.requireBind(ctx);
      const classId = guard.classIdOf(ctx);
      const [rows] = await pool.query(
        "SELECT id, name, student_no, group_tag, role, openid, status FROM member WHERE class_id = ? AND status != 'DISABLED' AND " + NOT_TEST + " AND group_tag <> 'X' ORDER BY id",
        [classId]
      );
      return rows.map(r => ({
        id: r.id, name: r.name, studentNoMasked: maskedNoOf(r),
        groupTag: r.group_tag, bound: !!r.openid, status: r.status
      }));
    }
  },

  stats: {
    auth: { needAdmin: true },
    handler: async (payload, ctx) => {
      const pool = getPool();
      const classId = await targetClassId(pool, payload, ctx);
      const [rows] = await pool.query(
        // 人数统计不含教职工：X 组既不是 A 也不是 B，但 COUNT(*) 会把它们算进 total
        "SELECT COUNT(*) AS total, SUM(group_tag='A') AS a, SUM(group_tag='B') AS b FROM member WHERE class_id = ? AND status != 'DISABLED' AND " + NOT_TEST + " AND group_tag <> 'X'",
        [classId]
      );
      return {
        total: Number(rows[0].total) || 0,
        groupA: Number(rows[0].a) || 0,
        groupB: Number(rows[0].b) || 0
      };
    }
  },

  /**
   * 名单导入（列序自适应 + 可多班级自动分类 + 可撤回）。
   *   payload.text      名单文本（必填）
   *   payload.classId   单一目标班级（无班级列时用）
   *   payload.preview   true = 只解析不写库，返回分组预览
   *   payload.mapping   { [班级标签]: classId } —— 预览确认后回传的显式映射
   * 写入策略：同班已存在 → 更新姓名/分组；**已存在于其它班 → 跳过并报告**（防跨班串号）；
   * 新学号 → 插入。每次调用落一条 import_batch，可 revertImport 撤回。
   */
  importCsv: {
    auth: { needAdmin: true },
    handler: async (payload, ctx) => {
      const text = String(payload.text || '');
      if (!text.trim()) throw new BizError(41001, '请粘贴名单内容');
      const pool = getPool();
      const { rows, failed } = parseRoster(text);
      if (!rows.length) {
        return { imported: 0, updated: 0, skipped: 0, failed: failed.slice(0, 20), groups: [], groupA: 0, groupB: 0 };
      }
      const [classes] = await pool.query('SELECT id, name FROM `class` WHERE is_active = 1 ORDER BY id');
      const prefixMaps = await loadPrefixMap(pool);
      const seqPrefixMap = await loadSeqPrefix(pool);
      const fallbackClass = Number(payload.classId) || 0;
      const groups = buildGroups(rows, {
        classes, prefixMaps, seqPrefixMap, fallbackClass,
        mapping: (payload.mapping && typeof payload.mapping === 'object') ? payload.mapping : null,
        createLabels: Array.isArray(payload.createLabels) ? payload.createLabels : null
      });

      if (payload.preview) {
        await annotateForPreview(pool, rows, groups);
        return previewOf(rows, failed, groups);
      }

      const createMissing = !!payload.createMissing;
      if (createMissing) requireSuperOrCounselor(ctx);   // 自动建班 = 班级管理，仅超管 / 辅导员
      // 需求 D：写入分支（改姓名 / 改分组 / 补学号 / 新增）收紧到「超管 / 辅导员 / 班长」。
      // 「导入即编辑」—— applyImport 里就是 UPDATE member SET name=?, group_tag=?，
      // 原先只卡 needAdmin ⇒ 全体班委都能批量改全班姓名，比产品口径（班长）更宽。
      requireRosterEditCheck(ctx);
      const res = await applyImport(pool, ctx, { rows, failed, groups, createMissing, classes, seqPrefixMap, fallbackClass });
      console.log(JSON.stringify({ fn: 'member', action: 'importCsv', member: ctx.member.id, batchId: res.batchId, imported: res.imported, updated: res.updated, skipped: res.skipped, created: res.createdClasses.length }));
      return res;
    }
  },

  /**
   * Excel 导入：从云存储取 .xlsx / .csv → 解析 → 分组 → 写入。
   * 与 importCsv 共用解析与写库链路；额外支持 createMissing（缺的班级自动新建）。
   * payload: { fileId, sheetIndex?, preview?, mapping?, createLabels?, createMissing?, classId? }
   */
  importExcel: {
    auth: { needAdmin: true },
    handler: async (payload, ctx) => {
      const fileId = String(payload.fileId || '');
      const content = String(payload.content || '');
      // 优先用客户端直传的 base64：避免云函数在 VPC 内回下载云存储文件（那一步在 VPC 出网极慢，
      // 之前表现为「一直解析中 / 网络错误」）。fileId 仅作大文件兜底（>1MB 时前端改走上传）。
      const pool = getPool();
      // 分段记时：解析慢/超时时要能一眼看出卡在哪一段（微信云开发控制台 → 云函数 → 日志）
      const t0 = Date.now();
      let buf;
      if (content) {
        buf = Buffer.from(content, 'base64');
      } else if (fileId) {
        try {
          const r = await cloud.downloadFile({ fileID: fileId });
          buf = r.fileContent;
        } catch (e) {
          throw new BizError(41002, '文件读取失败，请重新选择');
        }
      } else {
        throw new BizError(41001, '缺少文件');
      }
      const tDown = Date.now();
      const srcName = String(payload.name || fileId || '');
      const isCsv = /\.csv$/i.test(srcName);
      let text = '';
      try {
        if (isCsv) {
          text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
        } else {
          const sheets = parseXlsx(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
          const idx = Math.min(Math.max(Number(payload.sheetIndex) || 0, 0), sheets.length - 1);
          text = sheetToText(sheets[idx] || { rows: [] });
        }
      } catch (e) {
        throw new BizError(41002, '表格解析失败：' + String((e && e.message) || e).slice(0, 80) + '（请另存为 .xlsx 或 .csv 再试）');
      }
      const tParse = Date.now();
      text = String(text).replace(/^\uFEFF/, '');
      const { rows, failed } = parseRoster(text);
      if (!rows.length) throw new BizError(41001, '没从表格里读到名单（请确认含「姓名」「学号」列）');

      const [classes] = await pool.query('SELECT id, name FROM `class` WHERE is_active = 1 ORDER BY id');
      const prefixMaps = await loadPrefixMap(pool);
      const seqPrefixMap = await loadSeqPrefix(pool);
      const fallbackClass = Number(payload.classId) || 0;
      const groups = buildGroups(rows, {
        classes, prefixMaps, seqPrefixMap, fallbackClass,
        autoCreate: !!payload.autoCreate,
        mapping: (payload.mapping && typeof payload.mapping === 'object') ? payload.mapping : null,
        createLabels: Array.isArray(payload.createLabels) ? payload.createLabels : null
      });

      if (payload.preview) {
        await annotateForPreview(pool, rows, groups);
        const p = previewOf(rows, failed, groups);
        p.source = 'excel';
        // 注意：预览阶段**不能**删文件 —— 确认导入还要用它
        console.log(JSON.stringify({
          fn: 'member', action: 'importExcel.preview', member: ctx.member.id,
          rows: rows.length, groups: groups.length,
          ms: { download: tDown - t0, parse: tParse - tDown, total: Date.now() - t0 }
        }));
        return p;
      }

      const createMissing = !!payload.createMissing;
      if (createMissing) requireSuperOrCounselor(ctx);
      // 需求 D：同 importCsv —— 写入分支收紧到「超管 / 辅导员 / 班长」
      requireRosterEditCheck(ctx);
      const res = await applyImport(pool, ctx, {
        rows, failed, groups, createMissing, classes, seqPrefixMap, fallbackClass,
        createNames: (payload.createNames && typeof payload.createNames === 'object') ? payload.createNames : null
      });
      if (fileId) { try { await cloud.deleteFile({ fileList: [fileId] }); } catch (e) { /* 清理失败不影响结果 */ } }
      console.log(JSON.stringify({
        fn: 'member', action: 'importExcel', member: ctx.member.id,
        batchId: res.batchId, imported: res.imported, updated: res.updated,
        skipped: res.skipped, created: res.createdClasses.length,
        ms: { download: tDown - t0, parse: tParse - tDown, total: Date.now() - t0 }
      }));
      return res;
    }
  },

  /** 最近的导入批次（供「撤回」入口展示） */
  importBatches: {
    auth: { needAdmin: true },
    handler: async (payload, ctx) => {
      const pool = getPool();
      const classId = await targetClassId(pool, payload, ctx);
      const [rows] = await pool.query(
        'SELECT id, class_id, label, total, inserted, updated, created_at, reverted_at FROM import_batch WHERE class_id = ? OR class_id = 0 ORDER BY id DESC LIMIT 10',
        [classId]
      );
      return rows.map(r => ({
        id: r.id,
        classId: Number(r.class_id),
        label: r.label || '',
        total: Number(r.total) || 0,
        inserted: Number(r.inserted) || 0,
        updated: Number(r.updated) || 0,
        createdAt: String(r.created_at).slice(0, 16),
        reverted: !!r.reverted_at
      }));
    }
  },

  /**
   * 撤回一次导入：删掉这次**新插入**的成员（未绑定、无值日记录才删），
   * 被这次改过姓名/分组的还原回原值。
   * 不传 batchId 时撤回该班最近一次未撤回的导入。
   */
  revertImport: {
    auth: { needAdmin: true },
    handler: async (payload, ctx) => {
      const me = requireSuperOrCounselor(ctx);
      const pool = getPool();
      const classId = await targetClassId(pool, payload, ctx);
      let batchId = Number(payload.batchId) || 0;
      if (!batchId) {
        const [b] = await pool.query(
          'SELECT id FROM import_batch WHERE (class_id = ? OR class_id = 0) AND reverted_at IS NULL ORDER BY id DESC LIMIT 1',
          [classId]
        );
        if (!b.length) throw new BizError(41001, '没有可撤回的导入记录');
        batchId = Number(b[0].id);
      }
      const [batchRows] = await pool.query('SELECT * FROM import_batch WHERE id = ? LIMIT 1', [batchId]);
      const batch = batchRows[0];
      if (!batch) throw new BizError(41001, '导入记录不存在');
      if (batch.reverted_at) throw new BizError(41001, '该导入已经撤回过了');

      const [items] = await pool.query('SELECT * FROM import_batch_item WHERE batch_id = ? ORDER BY id', [batchId]);
      let removed = 0, restored = 0, skipped = 0;
      for (const it of items) {
        if (it.action === 'INSERT') {
          const [mr] = await pool.query('SELECT openid FROM member WHERE id = ? LIMIT 1', [it.member_id]);
          if (!mr.length) continue;                       // 已经不在了
          if (mr[0].openid) { skipped += 1; continue; }   // 已绑定微信：不动，避免误删真实账号
          const [dr] = await pool.query('SELECT COUNT(*) AS n FROM duty WHERE member_id = ?', [it.member_id]);
          if (Number(dr[0].n) > 0) { skipped += 1; continue; }  // 已有值日安排：不动
          await pool.query('DELETE FROM member WHERE id = ?', [it.member_id]);
          removed += 1;
        } else {
          await pool.query('UPDATE member SET name = ?, group_tag = ? WHERE id = ?',
            [it.prev_name, it.prev_group, it.member_id]);
          restored += 1;
        }
      }
      await pool.query('UPDATE import_batch SET reverted_at = NOW(), reverted_by = ? WHERE id = ?', [me.id, batchId]);
      console.log(JSON.stringify({ fn: 'member', action: 'revertImport', member: me.id, batchId, removed, restored, skipped }));
      return { batchId, removed, restored, skipped };
    }
  },

  /** 单个添加成员（超管 / 辅导员）：姓名 + 学号，尾号奇偶自动定组 */
  addMember: {
    auth: { needAdmin: true },
    handler: async (payload, ctx) => {
      // 需求 D：单个添加放宽到「超管 / 辅导员 / 班长」——与导入写入分支同集合
      requireRosterEditCheck(ctx);
      const name = String(payload.name || '').trim();
      const studentNo = String(payload.studentNo || '').trim();
      if (!NAME_RE.test(name)) throw new BizError(41001, '姓名格式不正确');
      if (!NO_RE.test(studentNo)) throw new BizError(41001, '学号格式不正确');
      const pool = getPool();
      const classId = await targetClassId(pool, payload, ctx);
      const [dup] = await pool.query('SELECT id, class_id FROM member WHERE student_no = ? LIMIT 1', [studentNo]);
      if (dup.length) {
        throw new BizError(41001, Number(dup[0].class_id) === Number(classId) ? '该学号已在本班名单中' : '该学号已存在于其它班级');
      }
      const group = groupOf(studentNo);
      const [r] = await pool.query(
        'INSERT INTO member (name, student_no, group_tag, class_id) VALUES (?, ?, ?, ?)',
        [name, studentNo, group, classId]
      );
      console.log(JSON.stringify({ fn: 'member', action: 'addMember', member: ctx.member.id, classId, newId: r.insertId }));
      return { memberId: r.insertId, name, studentNo, groupTag: group, classId };
    }
  },

  /**
   * 添加教职工（超管 / 辅导员）：建一条 X 组账号 + 发一次性绑定码。
   *
   * 为什么不能复用 addMember：教职工没有学号，而 addMember 强制 `NO_RE` 校验学号、
   * 并按学号末位奇偶分 A/B 组。这里落一条 `STAFF` 前缀的**占位学号**
   * （member.student_no 是 UNIQUE NOT NULL，不能留空），group_tag 固定 'X'。
   * 占位学号不会被展示 —— 本文件里 `noOf()` / `maskedNoOf()` 对 X 组一律返回空串。
   *
   * 返回体里带 `staffCode`（**唯一一次明文返回**）：前端弹窗展示 + 一键复制，
   * 之后 list 只回 `staffPending` / `staffCodeExpire` 状态，不再回码本身
   * —— 避免普通班主任把码读走拿去自己绑定（冒充教职工）。
   */
  addStaff: {
    auth: { needAdmin: true },
    handler: async (payload, ctx) => {
      guard.requireSuper(ctx); // v0.7.16：教职工名册收归超管（原 super-or-counselor）
      const name = String(payload.name || '').trim();
      const position = String(payload.position || '辅导员').trim();
      if (!NAME_RE.test(name)) throw new BizError(41001, '姓名格式不正确');
      if (position.length > 16) throw new BizError(41001, '职位不超过 16 个字');
      const pool = getPool();
      // v0.7.16：教职工是全局账号，不再落单一班级（class_id = 0）；
      // 可见范围由 staff_class 多对多映射决定（建号时可顺便绑定，也可之后在面板里改）。
      const classId = 0;
      const classIds = (Array.isArray(payload.classIds) ? payload.classIds : []).map(Number).filter(Boolean);
      if (classIds.length) {
        const [rows] = await pool.query(
          'SELECT id FROM `class` WHERE is_active = 1 AND id IN (' + classIds.map(() => '?').join(',') + ')', classIds
        );
        if (rows.length !== classIds.length) throw new BizError(41001, '存在无效的班级');
      }

      const studentNo = await genUniqueStaffNo(pool);
      const staffCode = await genUniqueStaffCode(pool);
      const [r] = await pool.query(
        'INSERT INTO member (name, student_no, group_tag, role, position, class_id, staff_code, staff_code_expire)' +
        ' VALUES (?, ?, \'X\', \'ADMIN\', ?, ?, ?, DATE_ADD(NOW(), INTERVAL ' + STAFF_CODE_HOURS + ' HOUR))',
        [name, studentNo, position, classId, staffCode]
      );
      if (classIds.length) {
        await pool.query(
          'INSERT IGNORE INTO staff_class (staff_id, class_id) VALUES ' + classIds.map(() => '(?,?)').join(','),
          classIds.flatMap(c => [r.insertId, c])
        );
      }
      const [ex] = await pool.query('SELECT staff_code_expire FROM member WHERE id = ?', [r.insertId]);
      const expireAt = (ex[0] && ex[0].staff_code_expire) || null;
      console.log(JSON.stringify({ fn: 'member', action: 'addStaff', member: ctx.member.id, classIds, newId: r.insertId }));
      return { memberId: r.insertId, name, position, classIds, staffCode, expireAt, hours: STAFF_CODE_HOURS };
    }
  },

  /**
   * 生成 / 重发 / 重置教职工绑定码（超管 / 辅导员）。
   * 仅对 X 组且**未绑定**的账号有效：已绑定的必须先走「解除微信绑定」再发码，
   * 否则新码指向一个已有 openid 的账号，bindStaff 一律拒绝 —— 用户白跑一趟。
   * 重发会直接覆盖旧码（旧码立即失效）。
   */
  staffCode: {
    auth: { needAdmin: true },
    handler: async (payload, ctx) => {
      guard.requireSuper(ctx); // v0.7.16：教职工名册收归超管
      const memberId = Number(payload.memberId);
      if (!memberId) throw new BizError(41001, '参数错误');
      const pool = getPool();
      // v0.7.16：教职工是全局账号，按 id 直接查（不再要求属于某个班）
      const [rows] = await pool.query(
        'SELECT id, name, group_tag, openid FROM member WHERE id = ? LIMIT 1', [memberId]
      );
      const t = rows[0];
      if (!t) throw new BizError(41004, '成员不存在或不属于该班级');
      if (t.group_tag !== 'X') throw new BizError(41002, '该成员不是教职工，没有绑定码');
      if (t.openid) throw new BizError(41002, '该教职工已绑定微信；如需更换，请先解除绑定');
      const code = await genUniqueStaffCode(pool);
      await pool.query(
        'UPDATE member SET staff_code = ?, staff_code_expire = DATE_ADD(NOW(), INTERVAL ' + STAFF_CODE_HOURS + ' HOUR) WHERE id = ?',
        [code, memberId]
      );
      const [ex] = await pool.query('SELECT staff_code_expire FROM member WHERE id = ?', [memberId]);
      const expireAt = (ex[0] && ex[0].staff_code_expire) || null;
      console.log(JSON.stringify({ fn: 'member', action: 'staffCode', member: ctx.member.id, target: memberId }));
      return { memberId, name: t.name, staffCode: code, expireAt, hours: STAFF_CODE_HOURS };
    }
  },

  /**
   * 教职工列表（超管 / 辅导员）：供班级管理页的「教职工」面板使用。
   *
   * 为什么单开一路而不是复用 `list{public:'manage'}`：
   *   manage 分支对非超管套了 `NOT_TEST`，而既有辅导员（罗翊瑄）的占位学号正好落在 99 段
   *   —— 复用会让辅导员自己看不见自己。又不想为了教职工去动「99 段只有超管可见」这条既有规则。
   * ⚠️ **不回 staff_code 本身**，只回状态（有无待用码 / 何时过期）：
   *   码只在 addStaff / staffCode 的响应里明文出现一次 —— 否则普通班委也能从列表把码抄走，
   *   拿去自己绑定，等于冒充教职工。
   */
  staffList: {
    auth: { needAdmin: true },
    handler: async (payload, ctx) => {
      guard.requireSuper(ctx); // v0.7.16：教职工名册收归超管；账号是全局的，不再按班过滤
      const pool = getPool();
      const [rows] = await pool.query(
        "SELECT id, name, position, openid, staff_code, staff_code_expire, class_id FROM member WHERE group_tag = 'X' AND status != 'DISABLED' ORDER BY id"
      );
      // 每人绑定的班级（staff_class 多对多；无映射时回退主班 class_id 展示存量数据）
      const [binds] = await pool.query('SELECT staff_id, class_id FROM staff_class ORDER BY class_id');
      const bindMap = {};
      binds.forEach(b => {
        (bindMap[Number(b.staff_id)] = bindMap[Number(b.staff_id)] || []).push(Number(b.class_id));
      });
      return rows.map(r => {
        let classIds = bindMap[Number(r.id)] || [];
        if (!classIds.length && Number(r.class_id)) classIds = [Number(r.class_id)];
        return {
          id: r.id,
          name: r.name,
          position: r.position || '',
          bound: !!r.openid,
          hasCode: !r.openid && !!r.staff_code,
          codeExpire: (!r.openid && r.staff_code) ? (r.staff_code_expire || null) : null,
          classIds
        };
      });
    }
  },

  /**
   * 覆写教职工的班级绑定（v0.7.16，仅超管）：全量替换 staff_class 映射。
   * 传空数组 = 解除全部班级绑定（该教职工将看不到任何班）。
   */
  staffBindClasses: {
    auth: { needAdmin: true },
    handler: async (payload, ctx) => {
      guard.requireSuper(ctx);
      const memberId = Number(payload.memberId);
      const classIds = (Array.isArray(payload.classIds) ? payload.classIds : []).map(Number).filter(Boolean);
      const pool = getPool();
      const [rows] = await pool.query("SELECT id FROM member WHERE id = ? AND group_tag = 'X' LIMIT 1", [memberId]);
      if (!rows.length) throw new BizError(41004, '教职工不存在');
      if (classIds.length) {
        const [ok] = await pool.query(
          'SELECT id FROM `class` WHERE is_active = 1 AND id IN (' + classIds.map(() => '?').join(',') + ')', classIds
        );
        if (ok.length !== classIds.length) throw new BizError(41001, '存在无效的班级');
      }
      await pool.query('DELETE FROM staff_class WHERE staff_id = ?', [memberId]);
      if (classIds.length) {
        await pool.query(
          'INSERT IGNORE INTO staff_class (staff_id, class_id) VALUES ' + classIds.map(() => '(?,?)').join(','),
          classIds.flatMap(c => [memberId, c])
        );
      }
      console.log(JSON.stringify({ fn: 'member', action: 'staffBindClasses', member: ctx.member.id, target: memberId, classIds }));
      return { memberId, classIds };
    }
  },

  /**
   * 解除教职工的微信绑定（v0.7.16，仅超管）：清 openid 与绑定码。
   * 与「移出班级」不同：账号保留、班级绑定保留，老师之后可凭新码重新绑定。
   */
  staffUnbind: {
    auth: { needAdmin: true },
    handler: async (payload, ctx) => {
      guard.requireSuper(ctx);
      const memberId = Number(payload.memberId);
      if (!memberId) throw new BizError(41001, '参数错误');
      const pool = getPool();
      const [rows] = await pool.query("SELECT id, openid FROM member WHERE id = ? AND group_tag = 'X' LIMIT 1", [memberId]);
      if (!rows.length) throw new BizError(41004, '教职工不存在');
      if (!rows[0].openid) throw new BizError(41002, '该教职工未绑定微信');
      await pool.query(
        'UPDATE member SET openid = NULL, staff_code = NULL, staff_code_expire = NULL WHERE id = ?', [memberId]
      );
      console.log(JSON.stringify({ fn: 'member', action: 'staffUnbind', member: ctx.member.id, target: memberId }));
      return {};
    }
  },

  /**
   * 删除教职工账号（v0.7.16，仅超管）：必须先解绑微信；级联清 staff_class。
   * 备注记录（member_note）按决策保留 —— 记录跟着学生走，不随教职工账号消失。
   */
  staffDelete: {
    auth: { needAdmin: true },
    handler: async (payload, ctx) => {
      const me = guard.requireSuper(ctx);
      const memberId = Number(payload.memberId);
      if (!memberId) throw new BizError(41001, '参数错误');
      if (Number(me.id) === memberId) throw new BizError(40003, '不能删除自己的教职工账号');
      const pool = getPool();
      const [rows] = await pool.query("SELECT id, openid FROM member WHERE id = ? AND group_tag = 'X' LIMIT 1", [memberId]);
      if (!rows.length) throw new BizError(41004, '教职工不存在');
      if (rows[0].openid) throw new BizError(41002, '该教职工已绑定微信，请先解除绑定再删除');
      await pool.query('DELETE FROM staff_class WHERE staff_id = ?', [memberId]);
      // 关注关系跟着账号一起走（v0.7.17）：教职工删号后 staff_pin 不能留孤儿行
      await pool.query('DELETE FROM staff_pin WHERE staff_id = ?', [memberId]);
      // 需求 D：自带密钥跟随本人，删号时一并清（与 removeMember 同源，防止孤儿钥匙行）
      await pool.query('DELETE FROM ai_setting WHERE member_id = ?', [memberId]);
      await pool.query("DELETE FROM member WHERE id = ? AND group_tag = 'X'", [memberId]);
      console.log(JSON.stringify({ fn: 'member', action: 'staffDelete', member: me.id, target: memberId }));
      return {};
    }
  },

  /* ============================================================
   * 成员备注（v0.7.16 需求⑦）：辅导员的学生信息 / 家庭情况管理记录。
   * 可见性（用户裁决）：仅教职工（X 组）+ 超管可见，学生与普通班委不可见；
   * 教职工只能给「自己绑定班级里的成员」写备注（noteScopeOk 做 staff_class 校验）；
   * 编辑 / 删除限「作者本人或超管」；教职工账号删除后备注保留（记录跟着学生走）。
   * ============================================================ */

  noteList: {
    auth: null,
    handler: async (payload, ctx) => {
      const pool = getPool();
      const memberId = Number(payload.memberId);
      if (!memberId) throw new BizError(41001, '参数错误');
      await noteScopeOk(pool, ctx, memberId);
      const [rows] = await pool.query(
        `SELECT n.id, n.content, n.author_id, n.created_at, m.name AS authorName
           FROM member_note n JOIN member m ON m.id = n.author_id
          WHERE n.member_id = ? ORDER BY n.id DESC`, [memberId]
      );
      return rows.map(r => ({
        id: r.id, content: r.content, authorId: r.author_id, authorName: r.authorName || '',
        createdAt: r.created_at, mine: Number(r.author_id) === Number(ctx.member.id)
      }));
    }
  },

  /** 新增 / 编辑备注：content ≤ 500 字；带 id = 编辑（限作者本人或超管） */
  noteSave: {
    auth: null,
    handler: async (payload, ctx) => {
      const pool = getPool();
      const memberId = Number(payload.memberId);
      const content = String(payload.content || '').trim();
      if (!memberId) throw new BizError(41001, '参数错误');
      if (!content) throw new BizError(41001, '备注内容不能为空');
      if (content.length > 500) throw new BizError(41001, '备注不超过 500 字');
      const me = await noteScopeOk(pool, ctx, memberId);
      const id = Number(payload.id) || 0;
      if (id) {
        const [rows] = await pool.query('SELECT id, author_id FROM member_note WHERE id = ? LIMIT 1', [id]);
        if (!rows.length) throw new BizError(41004, '备注不存在');
        if (Number(rows[0].author_id) !== Number(me.id) && !guard.isSuper(me)) {
          throw new BizError(40003, '只能编辑自己写的备注');
        }
        await pool.query('UPDATE member_note SET content = ? WHERE id = ?', [content, id]);
        return { id };
      }
      const [r] = await pool.query(
        'INSERT INTO member_note (member_id, author_id, content) VALUES (?,?,?)',
        [memberId, me.id, content]
      );
      console.log(JSON.stringify({ fn: 'member', action: 'noteSave', member: me.id, target: memberId, noteId: r.insertId }));
      return { id: r.insertId };
    }
  },

  /** 删除备注：限作者本人或超管 */
  noteDelete: {
    auth: null,
    handler: async (payload, ctx) => {
      const pool = getPool();
      const id = Number(payload.id);
      if (!id) throw new BizError(41001, '参数错误');
      const me = guard.requireBind(ctx);
      const [rows] = await pool.query(
        'SELECT n.id, n.author_id, t.class_id FROM member_note n JOIN member t ON t.id = n.member_id WHERE n.id = ? LIMIT 1', [id]
      );
      if (!rows.length) throw new BizError(41004, '备注不存在');
      if (Number(rows[0].author_id) !== Number(me.id) && !guard.isSuper(me)) {
        throw new BizError(40003, '只能删除自己写的备注');
      }
      await pool.query('DELETE FROM member_note WHERE id = ?', [id]);
      return {};
    }
  },

  /* ============================================================
   * 主页关注的学生（v0.7.17 需求⑥）
   * 「辅导员把某个学生固定到主页」（如家庭困难、需要长期跟踪的），首页直接看到
   * 头像 + 姓名 + 最新一条备注摘要，点开进详情继续记录。
   * 权限与备注**完全同源**（复用 noteScopeOk）：能给他写备注的人才允许关注他。
   * ⚠️ 列表额外按 staff_class 过滤：教职工的班级绑定被改小之后，
   *    历史 pin 不能继续把**已不在他范围内的学生**漏出来（纵深防御，不只靠写入时的校验）。
   * ============================================================ */

  pinList: {
    auth: null,
    handler: async (payload, ctx) => {
      const pool = getPool();
      const me = guard.requireBind(ctx);
      /*
       * v0.7.18 需求①（用户口径）：主页关注**只在辅导员账号上出现**。
       * 此前是「超管 ∨ 辅导员」，超管也会看到这张卡 —— 他的班主任视角不需要这个功能。
       * 现在收紧到**仅 group_tag='X' 的教职工**：超管 / 学生 / 普通班委一律 40003，
       * 前端也同步只给辅导员渲染入口，两端同口径（不会出现「能钉却看不到」）。
       */
      if (!guard.isCounselor(me)) {
        throw new BizError(40003, '仅辅导员可使用主页关注');
      }
      let sql =
        'SELECT p.member_id, m.name, m.group_tag, m.class_id, m.avatar_url, c.name AS className,' +
        ' (SELECT n.content FROM member_note n WHERE n.member_id = p.member_id ORDER BY n.id DESC LIMIT 1) AS latestNote,' +
        ' (SELECT COUNT(*) FROM member_note n2 WHERE n2.member_id = p.member_id) AS noteCount' +
        ' FROM staff_pin p' +
        ' JOIN member m ON m.id = p.member_id' +
        ' LEFT JOIN `class` c ON c.id = m.class_id' +
        ' WHERE p.staff_id = ?';
      const args = [me.id];
      // 走到这里必然是教职工（超管已在上面被拒）→ 一律按 staff_class 收窄，没有特权分支
      {
        const allowed = await guard.staffClassIds(pool, me);
        if (!allowed.length) return { limit: PIN_MAX, list: [] };
        sql += ' AND m.class_id IN (' + allowed.map(() => '?').join(',') + ')';
        allowed.forEach(x => args.push(x));
      }
      sql += ' ORDER BY p.created_at, p.member_id';
      const [rows] = await pool.query(sql, args);
      return {
        limit: PIN_MAX,
        list: rows.map(r => ({
          memberId: Number(r.member_id),
          name: r.name,
          groupTag: r.group_tag,
          classId: Number(r.class_id) || 0,
          className: r.className || '',
          avatarUrl: r.avatar_url || '',
          latestNote: r.latestNote || '',
          noteCount: Number(r.noteCount) || 0
        }))
      };
    }
  },

  /** 关注 / 取消关注（同一个入口切换）。返回切换后的状态与总数，前端不必自己推。 */
  pinToggle: {
    auth: null,
    handler: async (payload, ctx) => {
      const pool = getPool();
      const memberId = Number(payload.memberId);
      if (!memberId) throw new BizError(41001, '参数错误');
      // 与 pinList 同口径：先卡「仅辅导员」（noteScopeOk 允许超管，不能单独当这道门）
      const who = guard.requireBind(ctx);
      if (!guard.isCounselor(who)) throw new BizError(40003, '仅辅导员可使用主页关注');
      const me = await noteScopeOk(pool, ctx, memberId, '关注');
      const [has] = await pool.query(
        'SELECT member_id FROM staff_pin WHERE staff_id = ? AND member_id = ? LIMIT 1', [me.id, memberId]
      );
      let pinned;
      if (has.length) {
        await pool.query('DELETE FROM staff_pin WHERE staff_id = ? AND member_id = ?', [me.id, memberId]);
        pinned = false;
      } else {
        const [cnt] = await pool.query('SELECT COUNT(*) AS n FROM staff_pin WHERE staff_id = ?', [me.id]);
        if (Number(cnt[0].n) >= PIN_MAX) {
          throw new BizError(41001, '最多固定 ' + PIN_MAX + ' 名学生，请先取消一个');
        }
        await pool.query('INSERT INTO staff_pin (staff_id, member_id) VALUES (?,?)', [me.id, memberId]);
        pinned = true;
      }
      const [after] = await pool.query('SELECT COUNT(*) AS n FROM staff_pin WHERE staff_id = ?', [me.id]);
      console.log(JSON.stringify({ fn: 'member', action: 'pinToggle', staff: me.id, target: memberId, pinned }));
      return { pinned, count: Number(after[0].n), limit: PIN_MAX };
    }
  },

  /**
   * 移出班级（超管 / 辅导员）：删成员 + 未开始的值日。
   * 已绑定微信的成员不允许直接删（要先解绑），避免误删在用账号。
   */
  removeMember: {
    auth: { needAdmin: true },
    handler: async (payload, ctx) => {
      const me = requireSuperOrCounselor(ctx);
      const memberId = Number(payload.memberId);
      if (!memberId) throw new BizError(41001, '参数错误');
      const pool = getPool();
      const classId = await targetClassId(pool, payload, ctx);
      const [rows] = await pool.query('SELECT * FROM member WHERE id = ? AND class_id = ? LIMIT 1', [memberId, classId]);
      const m = rows[0];
      if (!m) throw new BizError(41001, '成员不存在或不属于该班级');
      if (me.id === m.id) throw new BizError(40003, '不能把自己移出班级');
      if (m.openid) throw new BizError(41001, '该成员已绑定微信，请先在成员详情里「解除微信绑定」');
      const [d] = await pool.query(
        "DELETE FROM duty WHERE member_id = ? AND class_id = ? AND status = 'PENDING' AND class_date >= ?",
        [memberId, classId, week.todayStr()]
      );
      // v0.7.25：成员被移出 → 其名下值日已删，引用这些值日的待确认申请一并作废（§73）
      await pool.query(
        `UPDATE swap_request SET status = 'CANCELLED'
          WHERE status IN ('PENDING_PEER','PENDING_ADMIN')
            AND from_member = ?
            AND NOT EXISTS (SELECT 1 FROM duty d2 WHERE d2.id = duty_id)`,
        [memberId]
      );
      // 被移出班级的学生，其关注关系（staff_pin）与备注（member_note）一并清掉：
      // 留着就是孤儿行，且下次 id 复用时可能把旧记录挂到别人身上（v0.7.17）
      await pool.query('DELETE FROM staff_pin WHERE member_id = ?', [memberId]);
      await pool.query('DELETE FROM member_note WHERE member_id = ?', [memberId]);
      /*
       * 需求 D：自带密钥**跟随本人**，人走了钥匙必须一起走（否则留一把孤儿钥匙在库里，
       * 且下次 id 复用时可能挂到别人身上）。
       * ⚠️ 这里是**唯一**允许清 ai_setting 的地方 —— 与「撤销职位不清」成对：
       *   职位会被频繁调整（生活委员换人很常见），撤一次职就清一次是不可逆的
       *   （密钥明文只存一次、接口只回掩码，清掉谁也读不回来）。
       *   反过来，本人没被移出班级时，钥匙始终保留，重新任命即可继续用。
       */
      await pool.query('DELETE FROM ai_setting WHERE member_id = ?', [memberId]);
      await pool.query('DELETE FROM member WHERE id = ? AND class_id = ?', [memberId, classId]);
      console.log(JSON.stringify({ fn: 'member', action: 'removeMember', member: me.id, classId, removedId: memberId, dutyRemoved: d.affectedRows }));
      return { removed: 1, dutyRemoved: d.affectedRows || 0 };
    }
  },

  updateGroup: {
    auth: { needAdmin: true },
    handler: async (payload, ctx) => {
      const memberId = Number(payload.memberId);
      const tag = payload.groupTag;
      if (!['A', 'B'].includes(tag)) throw new BizError(41001, '参数错误');
      // 需求 D：改 A/B 组属名册编辑（影响轮转公平），与导入写入同集合
      requireRosterEditCheck(ctx);
      const pool = getPool();
      const classId = await targetClassId(pool, payload, ctx);
      await pool.query('UPDATE member SET group_tag = ? WHERE id = ? AND class_id = ?', [tag, memberId, classId]);
      const [st] = await pool.query(
        "SELECT SUM(group_tag='A') AS a, SUM(group_tag='B') AS b FROM member WHERE class_id = ? AND status != 'DISABLED' AND " + NOT_TEST,
        [classId]
      );
      const a = Number(st[0].a) || 0, b = Number(st[0].b) || 0;
      const warn = Math.abs(a - b) >= 2 ? '两组人数相差 ' + Math.abs(a - b) + ' 人，建议手动调整以保证轮转公平' : null;
      return { groupA: a, groupB: b, warn };
    }
  },

  setStatus: {
    auth: { needAdmin: true },
    handler: async (payload, ctx) => {
      // 停用 / 恢复成员（2026-09-26 收紧）：仅超级管理员或辅导员。
      // 此前只卡 needAdmin，普通管理员也能停用别人 —— 与前端「停用按钮仅超管 / 辅导员可见」同口径。
      requireSuperOrCounselor(ctx);
      const status = payload.status;
      if (!['ACTIVE', 'LEAVE', 'DISABLED'].includes(status)) throw new BizError(41001, '参数错误');
      const pool = getPool();
      const classId = await targetClassId(pool, payload, ctx);
      await pool.query('UPDATE member SET status = ? WHERE id = ? AND class_id = ?', [status, Number(payload.memberId), classId]);
      return {};
    }
  },

  /**
   * 设置 / 取消管理员：**仅超级管理员**可操作。
   * 2026-09-24 收紧：此前是 needAdmin，普通管理员也能把别人提为管理员（越权提权路径）。
   * 注意 setRole 只改 role，不动 is_super → 被提升者只是普通管理员，不会获得超管能力。
   */
  setRole: {
    auth: { needSuper: true },
    handler: async (payload, ctx) => {
      const role = payload.role;
      if (!['ADMIN', 'MONITOR', 'MEMBER'].includes(role)) throw new BizError(41001, '参数错误');
      const memberId = Number(payload.memberId);
      if (!memberId) throw new BizError(41001, '参数错误');
      const pool = getPool();
      const classId = await targetClassId(pool, payload, ctx);
      // 保护：不允许取消最后一名超级管理员，否则将无人能再管理管理员
      if (role !== 'ADMIN') {
        const [tRows] = await pool.query('SELECT role, is_super FROM member WHERE id = ? AND class_id = ? LIMIT 1', [memberId, classId]);
        const t = tRows[0];
        if (t && t.role === 'ADMIN' && t.is_super === 1) {
          const [cRows] = await pool.query(
            "SELECT COUNT(*) AS n FROM member WHERE class_id = ? AND role = 'ADMIN' AND is_super = 1 AND status != 'DISABLED'",
            [classId]
          );
          if (Number(cRows[0].n) <= 1) {
            throw new BizError(41002, '不能取消唯一的超级管理员，否则将无人可管理管理员');
          }
        }
      }
      await pool.query('UPDATE member SET role = ? WHERE id = ? AND class_id = ?', [role, memberId, classId]);
      return {};
    }
  },

  /**
   * 设置 / 取消班委（2026-09-26 需求②）：**超管 + 辅导员**可操作。
   * payload.position = POSITIONS 之一 → role='ADMIN' 且写入该职位；
   * payload.position = ''            → role='MEMBER'，清空职位（取消班委）。
   *
   * 与 setRole 的区别：setRole 只改 role（超管专属、不涉及职位）；
   * setPosition 把「班委身份 + 具体职位」一起落库，是前端「设置班委」的唯一入口。
   * 保护：
   *   · 不允许改超级管理员（is_super=1）—— 超管身份只能走 setRole / 数据库；
   *   · 不允许改辅导员（group_tag='X'）—— 教职工不是学生班委。
   */
  setPosition: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      requireSuperOrCounselor(ctx);
      const position = String(payload.position || '').trim();
      if (position && POSITIONS.indexOf(position) < 0) {
        throw new BizError(41001, '职位不在可选范围：' + POSITIONS.join(' / '));
      }
      const memberId = Number(payload.memberId);
      if (!memberId) throw new BizError(41001, '参数错误');
      const pool = getPool();
      const classId = await targetClassId(pool, payload, ctx);
      const [rows] = await pool.query(
        'SELECT id, is_super, group_tag, name, position FROM member WHERE id = ? AND class_id = ? LIMIT 1',
        [memberId, classId]
      );
      const t = rows[0];
      if (!t) throw new BizError(41004, '成员不存在');
      if (t.is_super === 1) throw new BizError(41002, '超级管理员的身份不能在这里修改');
      if (t.group_tag === 'X') throw new BizError(41002, '辅导员不是学生班委，无需设置');
      /*
       * 需求 D：授予权比使用权更严。
       * 「生活委员」「班长兼团支书」是排班权与名册编辑权的**授权来源** ——
       * 谁能任命就等于谁能发权限。因此这两个职位（无论**授予**还是**撤销**，
       * 故同时判目标当前职位）一律要求超管；其余 5 个职位不含授权语义，维持
       * 超管 + 辅导员。不查目标当前职位会留下「辅导员把已有生活委员改掉」的后门。
       */
      if (guard.isGrantedPosition(position) || guard.isGrantedPosition(t.position)) {
        guard.requirePositionGrant(ctx);
      }
      const role = position ? 'ADMIN' : 'MEMBER';
      await pool.query(
        'UPDATE member SET role = ?, position = ? WHERE id = ? AND class_id = ?',
        [role, position, memberId, classId]
      );
      return { memberId, position, role };
    }
  },

  /** 超级管理员解绑他人：清 openid，保留历史（仅超级管理员可操作） */
  unbind: {
    auth: { needSuper: true },
    handler: async (payload, ctx) => {
      const pool = getPool();
      const classId = await targetClassId(pool, payload, ctx);
      await pool.query('UPDATE member SET openid = NULL WHERE id = ? AND class_id = ?', [Number(payload.memberId), classId]);
      return {};
    }
  },

  /**
   * 学生自助：重新授权微信提醒后清掉「额度耗尽」标记（v0.7.15）。
   * 标记由 cron-weekly 在发送吃到 43101 时置 1（一次性订阅没有长期通道，额度用尽后
   * 发送静默失败，学生无感知）→ 首页据此弹「微信提醒已失效，点此重新开启」。
   * 只写自己的行、只清这一个布尔位，无越权面；误清的代价只是少看一次提示。
   */
  remindReopen: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const pool = getPool();
      await pool.query('UPDATE member SET remind_block = 0 WHERE id = ?', [me.id]);
      return {};
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
    console.error('[member] unhandled', action, e);
    return fail(50000, '服务开小差了，请稍后重试');
  }
};
