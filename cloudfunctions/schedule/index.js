/**
 * 云函数：schedule —— 排班管理（开发文档 8.2 #4 / 8.3 生成算法）
 * action: listWeek / manualBoard / generate / reassign / addManual / remove / clear / publish / unpublish / getRules / setRules
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { getPool } = require('./common/db');
const guard = require('./common/guard');
const week = require('./common/week');
const { BizError, ok, fail } = require('./common/resp');
// 轮转取人内核：唯一实现在 common/schedule-core.js，cron-weekly 的每周自动生成共用
const { rotationPick, repairRoundMarks, loadDayBlocks } = require('./common/schedule-core');

const DAY_MS = 86400000;
const DAY_TEXT = ['一', '二', '三', '四', '五', '六', '日'];

/** 名册序号：统一实现见 common/week（260805740301 → 1） */
const seqOf = week.seqOf;

/**
 * 测试账号（学号 2608057499xx，id 69+），2026-09-26 需求④。
 * 这些账号在库里是 status='LEAVE'（不进自动轮转），但超管需要把它们
 * **手动**排进某个课次，再登进去发起换班，来验证主账号能否收到换班通知。
 * 所以：手动排班的名册 / 手动加人 / 换人 三处对测试账号放行，
 * 自动生成（generate）仍然排除它们（保持 status='ACTIVE' 过滤不动）。
 */
const TEST_NO_PREFIX = '2608057499';
function isTestNo(no) { return String(no || '').indexOf(TEST_NO_PREFIX) === 0; }

/* ============================================================
 * AI 排班 · DeepSeek
 * ------------------------------------------------------------
 * 两条调用路径：
 *   ① 默认走出口函数 ai-proxy（AI_PROXY 环境变量，默认 "ai-proxy"）。
 *      本环境的 VPC 路由表没有任何 0.0.0.0/0 路由，绑定 VPC 的 schedule
 *      访问不了公网，所以必须借道不绑定 VPC 的 ai-proxy；密钥也只放在 ai-proxy。
 *   ② AI_PROXY 置空字符串则直连 DeepSeek（仅用于函数本身能出网的环境）。
 *
 * 分工：「模型负责理解自然语言要求」+「本地负责硬规则校验与补齐」——
 * 任何模型输出都必须通过 validatePlan 才能落库，模型漏排/排错由本地规则兜底。
 * ============================================================ */
const AI_PROXY = process.env.AI_PROXY === undefined ? 'ai-proxy' : String(process.env.AI_PROXY);
const AI_BASE = String(process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const AI_MODEL = String(process.env.DEEPSEEK_MODEL || 'deepseek-chat');
const AI_TIMEOUT_MS = Number(process.env.DEEPSEEK_TIMEOUT_MS || 45000);

/** 走代理时密钥在 ai-proxy 侧，这里只关心代理是否可用 */
function aiAvailable() {
  return AI_PROXY ? true : !!process.env.DEEPSEEK_API_KEY;
}

/**
 * 默认提示词。
 * 客户端可覆盖（payload.prompt），但无论怎么改，落库前都会跑 validatePlan，
 * 因此提示词只管语义，不需要为「防错」负责。
 */
const DEFAULT_AI_PROMPT = [
  '你是「班级值日排班助手」。使用者会用一句自然语言描述要求。',
  '',
  '# 你的职责（很重要，先看这里）',
  '「谁配到哪节课次」由程序决定 —— 它会按课次的先后顺序，依次取序号最小的同学，',
  '所以「一轮里每人只排一次」「一路往后排、排完再从头」这些规则你不用操心，写错也不会落库。',
  '你要重点判断的只有三件事：',
  '① 哪些课次**保持原样、不要重排** → 写进 unchanged；',
  '② 哪些同学**本轮跳过、不要再排** → 写进 skipSeqs；',
  '③ assignments 里给出你理解的人选（程序可能不采用，但能让使用者核对你的理解）。',
  '',
  '# 输入说明',
  'user 消息里带一段 JSON：',
  '- sessions[]：本周要排的课次。sessionId 课次编号；date 日期；dayText 星期；period 第几节；',
  '  course 课程名；room 教室；groupScope 为 "A"/"B" 表示分组课（只对该组开放），null 表示全体课；',
  '  dutyCount 该课次需要几个人；existingDutySeqs 该课次现在已排的人（序号）；',
  '  busySameDaySeqs 当天已被别节课占用的人；onLeaveSeqs 当天请假的人。',
  '- roster[]：全班名册。seq 是「序号」（就是使用者口中的「N 号」）；group 是 A/B 组；',
  '  dutyCountThisRound 本轮已经被排过几次（0 = 本轮还没排过，≥1 = 本轮已排过）。',
  '',
  '# 必须遵守的硬性规则（优先级最高，与使用者描述冲突时以本节为准）',
  '1. 每个课次的安排人数必须恰好等于 dutyCount，不多不少。',
  '2. groupScope 为 "A" 或 "B" 的课次只能安排该组的同学；groupScope 为 null 的课次任何人都可以。',
  '3. 同一名同学在同一天（同一个 date）最多只出现一次，即使当天有多节课。',
  '4. onLeaveSeqs 里的同学当天请假，绝对不能安排。',
  '5. busySameDaySeqs 里的同学当天已被占用，只有该课次人数实在凑不齐时才可重复。',
  '6. 公平轮转：优先选 dutyCountThisRound 最小的同学（0 最优先），同一档内按 seq 从小到大取。',
  '7. 【一轮里每人最多排一次】同一个人绝对不能出现在两个课次里，即使这两天不是同一天。',
  '   排班像发号一样一直往后走：本周从「最小的、还没排过的号」开始连续取号，',
  '   下周接着从本周用到的最大号之后继续；直到全班 56 人都排过一次，才重新从 1 号开始。',
  '   dutyCountThisRound ≥ 1 的同学本轮已经排过，不要再给他们排（除非同组可用的人真的不够）。',
  '',
  '# 三句最常见的口语该怎么理解（务必照此执行）',
  'A. 「A 组 23 号之前全部排过了」「b 组 20 号之前全部排过了」这类话 = 这些同学本轮已排过，',
  '   本次不要再给他们排。请把它们写进 skipSeqs。注意分别按组判断：A 组的条件是 group="A" 且 seq<=23，',
  '   B 组的条件是 group="B" 且 seq<=20。',
  'B. 「从周四第二节开始排」这类话 = 周四第二节**之前**的所有课次保持原样、不要重排；',
  '   把那些 sessionId 写进 unchanged 数组，只给周四第二节及之后的课次出 memberSeqs。',
  '   「周四第二节」= dayText 为「周四」或日期是周四，且 period >= 2（含第 2 节本身）。',
  'C. 「一直往后排」「这周排到 40 号，下周从 41 号继续」= 使用者在陈述轮转规则，',
  '   程序本身就会照做。你不用为此做任何额外处理（既不用写 unchanged，也不用写 skipSeqs）。',
  '',
  '# 输出要求',
  '只输出一个严格 JSON 对象，不要输出任何解释文字，不要用 Markdown 代码块包裹。结构如下：',
  '{',
  '  "assignments": [ { "sessionId": 8, "memberSeqs": [9, 11] } ],',
  '  "unchanged": [1, 2, 3],',
  '  "skipSeqs": [2, 4, 6],',
  '  "notes": "一句话说明本次排班思路，不超过 60 字"',
  '}',
  '',
  '字段说明：',
  '- assignments：数组。memberSeqs 用「序号」表示，不要写姓名，不要写 id。',
  '  必须覆盖**所有没有出现在 unchanged 里的** sessionId，一个都不能漏。',
  '  ⚠️ 这只是你的理解：程序会按「课次先后 + 序号从小到大」重新配对，顺序写偏了不影响结果，',
  '  但**不许漏课次、不许编造序号、不许把「本轮跳过」的人写进来**。',
  '- unchanged：使用者要求「从某处开始排」时，该处之前那些**保持不动**的课次 sessionId。没有就返回空数组。',
  '- skipSeqs：本轮不再给这些人排（使用者点名跳过的、或说「N 号之前都排过了」的）。没有就返回空数组。',
  '  注意：skipSeqs 里的人【绝对不要】写进 assignments（系统会自动排除，但请直接别列，以免浪费）。',
  '- notes：给使用者看的一句话说明。'
].join('\n');

/**
 * 「临时调课」的默认提示词。
 * 与排班提示词分开：这里只让模型输出「哪几节课怎么办」，不涉及人员。
 * 同样地，模型只会给出候选操作，真正的合法性由 validateShiftPlan 兜底。
 */
const DEFAULT_SHIFT_PROMPT = [
  '你是「班级课表调课助手」。使用者会用一句自然语言说明这一周的课要临时怎么调。',
  '你只输出「哪几节课怎么办」，不要输出完整课表。',
  '',
  '# 输入说明',
  'user 消息里带一段 JSON：',
  '- week：这是第几周。',
  '- sessions[]：这一周按原定周次应该上的课次。',
  '  sessionId 课次编号；dayText 原来星期几；dayOfWeek 原来星期几(1-7)；period 原来第几节；',
  '  course 课程名；room 教室；groupScope 为 "A"/"B" 表示分组课（只对该组开放），null 表示全体课；',
  '  date 这一周实际上课的日期（"YYYY-MM-DD"）；',
  '  off=true 表示这节课本周已被临时取消，不要再对它输出操作。',
  '',
  '# 可以做的两种操作',
  '1. OFF  —— 这一周这节课不上（调休、放假补课冲突、老师有事等）。',
  '2. MOVE —— 这一周这节课改到同周的另外一天 / 另外一节（toDay 1-7，toPeriod 1-5）。',
  '',
  '# 必须遵守的规则（优先级最高，与使用者描述冲突时以本节为准）',
  '1. sessionIds 必须是 sessions[] 里出现过的编号，绝对不要编造。',
  '2. MOVE 的 toDay 必须是 1-7，toPeriod 必须是 1-5。不要跨周调课。',
  '3. 使用者说「某一天不上」时，把那天所有课次的 sessionId 都放进同一个 OFF 操作里，不要一节课一个操作。',
  '4. 使用者说「周四第二节开始」这类相对位置时，先在 sessions[] 里按 dayText / period 找到起点，再照做。',
  '5. 使用者说「原来的某些课不动」时，那些课次不要出现在 operations 里。',
  '6. 同一周同一个「星期 + 节次」只能有一门课。如果调过去会和别的课次撞车，在 warnings 里说明，但仍然输出该操作。',
  '',
  '# 输出要求',
  '只输出一个严格 JSON 对象，不要输出任何解释文字，不要用 Markdown 代码块包裹。结构如下：',
  '{',
  '  "operations": [',
  '    { "sessionIds": [12, 13], "kind": "OFF", "note": "一句话原因" },',
  '    { "sessionIds": [7], "kind": "MOVE", "toDay": 5, "toPeriod": 1, "note": "一句话原因" }',
  '  ],',
  '  "warnings": ["可能撞车的地方"],',
  '  "notes": "一句话说明本次调课思路，不超过 60 字"',
  '}',
  '',
  '字段说明：',
  '- operations：数组，没有要改的就给空数组。kind 只能是 "OFF" 或 "MOVE"；OFF 不需要 toDay/toPeriod。',
  '- warnings：数组，没有就给空数组。',
  '- notes：给使用者看的一句话说明。'
].join('\n');

function parseJsonLoose(raw) {
  let t = String(raw || '').trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  const i = t.indexOf('{');
  const j = t.lastIndexOf('}');
  if (i >= 0 && j > i) t = t.slice(i, j + 1);
  return JSON.parse(t);
}

/** 直连 DeepSeek（仅当函数自身能出网时可用）。apiKey 为本班自带密钥，缺省回落平台密钥 */
async function callDeepSeekDirect(body, timeoutMs, apiKey) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || AI_TIMEOUT_MS);
  try {
    const res = await fetch(AI_BASE + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (apiKey || process.env.DEEPSEEK_API_KEY)
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    const text = await res.text();
    if (!res.ok) throw new BizError(40010, 'DeepSeek HTTP ' + res.status + '：' + text.slice(0, 180));
    const data = JSON.parse(text);
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new BizError(40010, 'DeepSeek 返回内容为空');
    return { content, usage: (data && data.usage) || null };
  } catch (e) {
    if (e && e.name === 'AbortError') throw new BizError(40010, 'DeepSeek 响应超时，请缩短描述后重试');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- AI 设置（需求 D：各班自带密钥） ---------------- */

/** 密钥掩码：明文在库里只存一次，**接口永不回传明文** */
function maskKey(key) {
  const s = String(key || '');
  if (!s) return '';
  if (s.length <= 10) return s.slice(0, 2) + '****';
  return s.slice(0, 6) + '****' + s.slice(-4);
}

/**
 * 读某人的 AI 配置（**一人一条，跟随本人而非班级**）。
 * 排班仍按班进行，但「用谁的钥匙」按**生效身份**取 —— 所以 AI 排班路由禁模拟态
 * （否则会消耗被模拟者本人的额度、操作还记在他名下）。
 */
async function loadAiSetting(pool, memberId) {
  const [rows] = await pool.query('SELECT * FROM ai_setting WHERE member_id = ? LIMIT 1', [memberId]);
  return rows[0] || null;
}

/**
 * 接口地址**本地快拦**（只做不需要 DNS 的那部分）：协议 / 禁带参数 / 端口 / 内网 IP 字面量。
 * DNS 级校验（域名解析后复判）放在 ai-proxy —— 本函数绑了 VPC，**没有公网 DNS**，做不了解析。
 * 两处都拦是纵深防御：保存时立刻拦下明显非法的地址，出口函数再终拦一次。
 */
function assertBaseUrlLite(raw) {
  const s = String(raw || '').trim();
  if (!s) return;
  let u;
  try { u = new URL(s); } catch (e) { throw new BizError(41002, '接口地址格式不正确'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BizError(41002, '接口地址仅支持 http/https');
  if (/[?#]/.test(s)) throw new BizError(41002, '接口地址不能带参数（? 或 #）');
  if (u.port !== '' && u.port !== '80' && u.port !== '443' && u.port !== '8080' && u.port !== '8443') {
    throw new BizError(41002, '接口端口仅允许 80 / 443 / 8080 / 8443');
  }
  const h = u.hostname;
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(h)) throw new BizError(41002, '不允许填写内网地址');
  if (h === '::1' || h === '::') throw new BizError(41002, '不允许填写内网地址');
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 169 && b === 254)) {
      throw new BizError(41002, '不允许填写内网地址');
    }
  }
}

/**
 * 解析本次 AI 调用要用的配置（按**生效身份**所属班级读取，故 AI 路由禁模拟态）。
 *
 * ⚠️ 「平台密钥仅超管兜底」：本班没有自带密钥时，只有超管可以借用平台那一份 ——
 *    否则生活委员一键就把平台额度借走了，还无法归因到班。
 */
async function resolveAiCfg(pool, ctx) {
  const me = ctx.member;
  const s = await loadAiSetting(pool, me && me.id);
  const key = (s && s.api_key) || '';
  if (!key && !guard.isSuper(me)) {
    throw new BizError(40009, '你还没有配置自己的 AI 密钥；平台密钥仅超级管理员可用');
  }
  return { baseUrl: (s && s.base_url) || '', apiKey: key, model: (s && s.model) || '' };
}

/** 调 DeepSeek：默认经 ai-proxy 转发，密钥不落在本函数（aiCfg 来自本班自带配置） */
async function callAi(messages, timeoutMs, aiCfg) {
  const cfg = aiCfg || {};
  const body = {
    model: cfg.model || AI_MODEL,
    temperature: 0.2,
    // 必须显式限长：DeepSeek 默认 completion 上限 4096 token，
    // 而 schedule → ai-proxy 的链路只有 55s，长回答会直接撞超时，
    // 表现为用户看到的「AI 生成失败」。值日表 JSON 实测 ~150 token，2000 足够宽松。
    max_tokens: 2000,
    response_format: { type: 'json_object' },
    messages
  };
  if (!AI_PROXY) {
    // 直连模式没有出口函数兜底：自带密钥直接带上，否则仍需平台密钥
    const key = cfg.apiKey || process.env.DEEPSEEK_API_KEY || '';
    if (!key) throw new BizError(40009, 'AI 未配置：请设置 DEEPSEEK_API_KEY 或为本班配置密钥');
    return callDeepSeekDirect(body, timeoutMs, key);
  }
  // 函数间调用默认超时只有 15s，大模型经常超过，这里显式放宽
  const res = await cloud.callFunction({
    name: AI_PROXY,
    data: {
      action: 'chat',
      token: process.env.AI_PROXY_TOKEN || '',
      body,
      // 自带配置（留空则由 ai-proxy 回落到平台密钥）
      baseUrl: cfg.baseUrl || '',
      apiKey: cfg.apiKey || ''
    },
    timeout: 55000
  });
  const r = (res && res.result) || {};
  if (r.errCode !== 0) {
    throw new BizError(r.errCode || 40010, r.errMsg || 'AI 代理调用失败');
  }
  const d = r.data || {};
  if (!d.content) throw new BizError(40010, 'AI 返回内容为空');
  return { content: d.content, usage: d.usage || null };
}

/**
 * 本周自己的 AUTO 值日数（按成员）。
 *
 * 为什么需要：「本轮已排次数」复用 `member.duty_count`，而重新生成某一周时，
 * 这一周的 AUTO 值日会被整批删掉再重建（`writePlan` / `generate`）。若不先把它们扣掉，
 * 计算轮转位置时就会把这些人当成「本轮已排过」——既导致「重新生成同一周会换一批人」，
 * 也会让标记被重复累加（旧行 1 次 + 新行 1 次 = 2 次，凭空烧掉一轮名额）。
 *
 * @param {string[]} [excludeSessions] 不参与扣除的课次（`unchanged` 保持原样的课次不会被删）
 */
async function loadWeekAutoCounts(conn, wk, excludeSessions, classId) {
  const ex = (excludeSessions || []).map(Number).filter(Boolean);
  const sql = "SELECT member_id, COUNT(*) AS n FROM duty WHERE class_id = ? AND week = ? AND source = 'AUTO'"
    + (ex.length ? ' AND session_id NOT IN (' + ex.map(() => '?').join(',') + ')' : '')
    + ' GROUP BY member_id';
  const [rows] = await conn.query(sql, [classId, wk].concat(ex));
  const map = new Map();
  rows.forEach(r => map.set(Number(r.member_id), Number(r.n) || 0));
  return map;
}

/** 组装本周排班上下文（只喂必要信息，控制 token） */
async function buildAiContext(pool, wk, classId) {
  const cfg = await week.getConfig(pool, classId);
  const cal = await week.loadCalendar(pool);
  const shifts = await week.loadSessionShifts(pool);

  const [rawSessions] = await pool.query(
    `SELECT s.id, s.day_of_week, s.period, s.group_scope, s.duty_count, s.weeks, s.week_rule,
            c.name AS courseName, c.room
       FROM session s JOIN course c ON c.id = s.course_id
      WHERE s.class_id = ? AND s.kind <> 'CLEAN'
      ORDER BY s.day_of_week, s.period`, [classId]
  );

  const [mems] = await pool.query(
    "SELECT id, name, group_tag, student_no, duty_count, last_duty_at FROM member WHERE class_id = ? AND status = 'ACTIVE' AND group_tag <> 'X' AND duty_off = 0", [classId]
  );
  // 重新生成同一周时，本周将被删除的 AUTO 行不算「本轮已排过」（见 loadWeekAutoCounts）
  const ownAuto = await loadWeekAutoCounts(pool, wk, null, classId);
  const seqById = new Map();
  const idBySeq = new Map();
  const roster = mems.map(m => {
    const seq = seqOf(m.student_no);
    seqById.set(m.id, seq);
    idBySeq.set(seq, m.id);
    return {
      seq,
      name: m.name,
      group: m.group_tag,
      // 本轮已排次数，不含本周即将被重排的那批（那批会被 writePlan 回滚）
      dutyCountThisRound: Math.max(0, (Number(m.duty_count) || 0) - (ownAuto.get(Number(m.id)) || 0)),
      lastDutyAt: m.last_duty_at ? String(m.last_duty_at).slice(0, 10) : null
    };
  }).sort((a, b) => a.seq - b.seq);
  // 与 generate 同口径：先补序号断层，否则 AI 看到的「本轮已排」是残缺的，
  // validatePlan 的补齐也会倒回 1 号（两条链路必须给出同一份名单）
  const roundFix = repairRoundMarks(roster);

  const [duties] = await pool.query(
    `SELECT d.session_id, d.class_date, d.member_id, d.source
       FROM duty d WHERE d.class_id = ? AND d.week = ? AND d.status <> 'SWAPPED_OUT'`, [classId, wk]
  );
  const [leaves] = await pool.query(
    "SELECT member_id, start_date, end_date FROM leave_request WHERE class_id = ? AND status = 'APPROVED'", [classId]
  );
  const leaveRanges = leaves.map(l => ({
    id: l.member_id,
    from: String(l.start_date).slice(0, 10),
    to: String(l.end_date).slice(0, 10)
  }));

  const sessions = [];
  for (const s of rawSessions) {
    if (!week.matchesWeeks(s.weeks, wk, s.week_rule)) continue;
    // 临时调课优先：OFF → 本周不上；MOVE → 用调课后的星期 / 节次
    const slot = week.resolveSlot(s.id, s.day_of_week, s.period, wk, shifts);
    if (!slot) continue;
    const date = week.classDateOf(cfg, wk, slot.day, cal);
    if (!date) continue;   // 法定放假且无调课 → 本周不上
    const dayDuties = duties.filter(d => String(d.class_date).slice(0, 10) === date);
    sessions.push({
      sessionId: s.id,
      date,
      dayOfWeek: slot.day,
      dayText: '周' + (DAY_TEXT[slot.day - 1] || ''),
      period: slot.period,
      course: s.courseName,
      room: s.room || '',
      groupScope: s.group_scope || null,
      dutyCount: s.duty_count || 1,
      existingDutySeqs: dayDuties.filter(d => d.session_id === s.id).map(d => seqById.get(d.member_id)).filter(Boolean),
      busySameDaySeqs: dayDuties.map(d => seqById.get(d.member_id)).filter(Boolean),
      onLeaveSeqs: leaveRanges.filter(l => l.from <= date && l.to >= date)
        .map(l => seqById.get(l.id)).filter(Boolean)
    });
  }

  return {
    cfg, roster, sessions,
    seqById, idBySeq,
    // 本轮标记断层被补上的序号：writePlan 走增量写库，得把这批人一起补进 duty_count
    roundFillSeqs: roundFix.filled,
    weekStart: sessions.length ? sessions[0].date : week.weekStart(cfg.termStart, wk)
  };
}

/**
 * 生成 → 可直接落库的排班计划。
 *
 * ## 分工（2026-09-24 定稿）
 * **AI 只决定「哪些课次不动」和「哪些人本轮跳过」；「谁配到哪节课」一律由本地按
 * 「日期 + 节次」的先后顺序取最小可用号决定。**
 *
 * 为什么不让模型定配对 —— 模型会给出「人对了、顺序错了」的答案。用户报的例子：
 * 输入「A 组 23 号之前全部排过了，B 组 24 号之前全部排过了」，模型确实挑对了 24 个人
 * （A 组最小的 10 个、B 组最小的 14 个，两两不重复），却把 B 组最后两个号
 * （50 宋紫晗、52 兰怡佳）配给了**最早的** B 组课（周一第 4 节），
 * 把 46、48 放到了最晚的周四第 5 节。校验器当时只管「不重复 / 分组 / 请假 / 跳过」，
 * 不排顺序，于是原样落库。现在顺序由本地负责，结果可复现、可解释：
 * 同一个输入，周一第 4 节必然是最小的可用 B 组号。
 *
 * ## 本地强制的硬规则
 *   ① 分组课只排对应组；② 请假不排；③ 当天不重复；④ 序号必须存在；
 *   ⑤ **一轮里每人最多排一次**（跨天全局唯一）—— 2026-09-24 线上事故的根因，
 *      当时只查了「同课次内重复」和「同一天重复」，跨天重复被直接放行；
 *   ⑥ **顺序**：非「保持原样」的课次，按时间先后依次取最小可用号（见 fillByRotation）。
 */
function validatePlan(ctx, raw) {
  const warnings = [];
  let wrappedAny = false;   // 本次是否开过新一轮（56 人全排完 → 从最小序号继续）
  const sessions = ctx.sessions;
  const byId = new Map(sessions.map(s => [s.sessionId, s]));
  const rosterBySeq = new Map(ctx.roster.map(r => [r.seq, r]));
  /**
   * AI 建议的人选：**只用于事后给一句解释，完全不参与配对**。
   * 保留解析是为了在「AI 想用的号」和「本地按顺序排出来的号」不一致时提示使用者，
   * 免得以为自己的要求被吞了。
   */
  const suggested = new Set();
  (Array.isArray(raw && raw.assignments) ? raw.assignments : []).forEach((it) => {
    const sid = Number(it && it.sessionId);
    if (!byId.has(sid)) { warnings.push('AI 返回了不存在的课次 #' + sid + '，已忽略'); return; }
    (Array.isArray(it.memberSeqs) ? it.memberSeqs : []).forEach((v) => {
      const q = Number(v);
      if (rosterBySeq.has(q)) suggested.add(q);
    });
  });

  // 使用者要求「从某处开始排」：unchanged 里的课次保持原样，
  // 既不重排、也不参与本次挑选（对应的成员照旧）
  const keptIds = new Set(
    (Array.isArray(raw && raw.unchanged) ? raw.unchanged : [])
      .map(Number).filter(sid => byId.has(sid))
  );

  // 使用者要求「本轮跳过」的人：视为已用掉名额，本周不排
  const skipSeqs = (Array.isArray(raw && raw.skipSeqs) ? raw.skipSeqs : [])
    .map(Number).filter(n => rosterBySeq.has(n));

  const usedSameDay = {};       // date -> Set(seq)
  /**
   * 本次计划内已排过的人（**跨天全局唯一**）。
   *
   * 「按序号一直往后排」= 一轮里每人只排一次：这周排到 40 号，下周第一节就从 41 号继续，
   * 直到 56 人全部排完才清零重来。模型只负责理解语言，这条硬规则必须在本地强制——
   * 2026-09-24 的线上事故就是 AI 把同一个人写进了两个课次（赵婷婷/翟丹宁各出现 3 次），
   * 而当时的校验器只查「同一课次内重复」和「同一天重复」，跨天重复直接放行。
   */
  const usedInPlan = new Set();
  const plan = [];

  // 先按「日期 + 节次」排出处理顺序，保证同日去重的判定与真实占用一致
  const ordered = sessions.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.period - b.period));

  ordered.forEach(s => {
    // ① 「保持原样」的课次：原样回填当前成员，不参与本次挑选
    if (keptIds.has(s.sessionId)) {
      const dayKeep = (usedSameDay[s.date] = usedSameDay[s.date] || new Set(s.busySameDaySeqs));
      const keep = s.existingDutySeqs.slice(0, s.dutyCount);
      // 保持原样的人同样占掉本轮/本次的名额，后面的课次不能再选他们
      keep.forEach(q => { dayKeep.add(q); usedInPlan.add(q); });
      plan.push({
        sessionId: s.sessionId,
        date: s.date,
        period: s.period,
        dayText: s.dayText,
        course: s.course,
        room: s.room,
        groupScope: s.groupScope,
        dutyCount: s.dutyCount,
        memberSeqs: keep,
        memberIds: keep.map(q => ctx.idBySeq.get(q)),
        names: keep.map(q => (rosterBySeq.get(q) || {}).name || ''),
        reason: '保持原样',
        kept: true,
        rejected: []
      });
      return;
    }
  });

  /**
   * 轮转取人（与 rotationPick 同构，两条链路必须给出同样的结果）。
   *
   * 「按序号一直往后排」的完整含义：一轮 = 全班 56 人各值一次；本周排到 40 号，
   * 下周就从 41 号继续；56 人全部排完 → 重置标记，再从 1 号开始。
   * 一轮之内**每人最多排一次**，所以候选分成四档，永远优先取没排过的：
   *   ① 本轮未排 + 本次未排 —— 正常路径
   *   ② 本轮已排 + 本次未排 —— 本轮 56 人排完，开新一轮继续往后排
   *   ③ 本轮未排 + 本次已排 —— 名额多于人数时的降级（只可能命中「当天本来就有值日」的人）
   *   ④ 本轮已排 + 本次已排 —— 最后手段
   *
   * @returns {{picked:Array, wrapped:boolean}} wrapped = 用到了本轮已排过的人（已开新一轮）
   */
  const fillByRotation = (s, day, need) => {
    const base = ctx.roster.filter(r => s.onLeaveSeqs.indexOf(r.seq) < 0
      && (!s.groupScope || r.group === s.groupScope)
      && skipSeqs.indexOf(r.seq) < 0);
    const byRound = (a, b) => (a.dutyCountThisRound - b.dutyCountThisRound) || (a.seq - b.seq);
    const pool = base.filter(r => !usedInPlan.has(r.seq)).sort(byRound);
    const fresh = pool.filter(r => r.dutyCountThisRound === 0);
    const used = pool.filter(r => r.dutyCountThisRound > 0);
    const tiers = [
      fresh.filter(r => !day.has(r.seq)),
      used.filter(r => !day.has(r.seq)),
      fresh.filter(r => day.has(r.seq)),
      used.filter(r => day.has(r.seq))
    ];
    const picked = [];
    const taken = new Set();
    let wrapped = false;
    for (let i = 0; i < tiers.length && picked.length < need; i++) {
      for (const r of tiers[i]) {
        if (picked.length >= need) break;
        if (taken.has(r.seq)) continue;
        taken.add(r.seq);
        picked.push(r);
        if (i === 1 || i === 3) wrapped = true;
      }
    }
    // 极端兜底：名册都翻遍了还凑不齐（例如全班都当天有值日）→ 允许重复用人
    if (picked.length < need) {
      for (const r of ctx.roster) {
        if (picked.length >= need) break;
        if (taken.has(r.seq)) continue;
        if (s.onLeaveSeqs.indexOf(r.seq) >= 0) continue;
        if (skipSeqs.indexOf(r.seq) >= 0) continue;
        if (s.groupScope && r.group !== s.groupScope) continue;
        taken.add(r.seq);
        picked.push(r);
      }
    }
    picked.forEach(r => { day.add(r.seq); usedInPlan.add(r.seq); });
    return { picked, wrapped };
  };

  /**
   * 其余课次（非「保持原样」）：**按课次时间先后依次取最小可用号**。
   *
   * 这是「顺序」的唯一来源：先排周一第 2 节，再排周一第 3 节……所以周一的号一定小于周二。
   * 同一组内（同一 groupScope）更是严格递增 —— 后一节课拿到的号必然大于前一节课的号，
   * 也就是使用者要的「一路往后排，排到 56 再从头来」。
   * AI 给的人选在这里完全不参与，只用于事后解释（见下面的 suggested / aiOnly）。
   */
  ordered.forEach((s) => {
    if (keptIds.has(s.sessionId)) return;
    const day = (usedSameDay[s.date] = usedSameDay[s.date] || new Set(s.busySameDaySeqs));
    const { picked, wrapped } = fillByRotation(s, day, s.dutyCount);
    if (wrapped) wrappedAny = true;
    if (picked.length < s.dutyCount) {
      warnings.push('周' + s.dayText.replace('周', '') + '第' + s.period + '节候选人不足（还差 '
        + (s.dutyCount - picked.length) + ' 人）');
    }
    plan.push({
      sessionId: s.sessionId, date: s.date, period: s.period, dayText: s.dayText,
      course: s.course, room: s.room, groupScope: s.groupScope, dutyCount: s.dutyCount,
      memberSeqs: picked.map(r => r.seq),
      memberIds: picked.map(r => ctx.idBySeq.get(r.seq)),
      names: picked.map(r => r.name),
      reason: '',
      rejected: []
    });
  });

  // 兜底自检：一轮里每人只排一次。正常情况下这里永远不该命中；
  // 一旦命中说明上面的取号逻辑有漏洞（或真的候选人不足被放宽），必须让使用者看见。
  const seenOnce = new Set();
  const repeated = [];
  plan.forEach(p => p.memberSeqs.forEach(q => {
    if (seenOnce.has(q)) repeated.push(q); else seenOnce.add(q);
  }));

  if (skipSeqs.length) warnings.push('本轮跳过 ' + skipSeqs.join('、') + ' 号');
  if (keptIds.size) warnings.push('有 ' + keptIds.size + ' 个课次按你的要求保持原样');
  // AI 的建议号和本地按顺序排出来的号不一致时给一句解释，免得使用者以为自己的要求被吞了
  const localSeqs = new Set();
  const keptSeqs = new Set();
  plan.forEach(p => p.memberSeqs.forEach(q => { (p.kept ? keptSeqs : localSeqs).add(q); }));
  const aiOnly = Array.from(suggested).filter(q => !localSeqs.has(q) && !keptSeqs.has(q));
  if (aiOnly.length) {
    warnings.push('AI 建议的 ' + aiOnly.sort((a, b) => a - b).join('、')
      + ' 号与「按课次先后取最小可用号」的顺位不一致，已按序号顺序重新配对'
      + '（否则会出现「靠后的号排在靠前的课次」）');
  }
  if (wrappedAny) {
    warnings.push('本轮 56 人已轮到一遍，已开启新一轮，按序号继续往后排');
  }
  if (repeated.length) {
    warnings.push('注意：' + Array.from(new Set(repeated)).sort((a, b) => a - b).join('、') + ' 号在本次计划里被排了多次（候选人数不够，属放宽处理）');
  }

  plan.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.period - b.period));
  return { plan, warnings, skipSeqs, notes: String((raw && raw.notes) || '').slice(0, 120) };
}

/* ============================================================
 * AI 临时调课 · 上下文与校验
 * ------------------------------------------------------------
 * 模型只负责把「一句自然语言」翻译成「哪几节课不上 / 改到哪」；
 * 课次是否存在、目标位子是否合法、有没有撞车，全部由本地判定。
 * ============================================================ */

/** 组装「本周所有课次」的现状，供模型判断 */
async function buildShiftContext(pool, wk, classId) {
  const cfg = await week.getConfig(pool, classId);
  const cal = await week.loadCalendar(pool);
  const shifts = await week.loadSessionShifts(pool);
  const [rows] = await pool.query(
    `SELECT s.id, s.weeks, s.week_rule, s.day_of_week, s.period, s.group_scope,
            c.name AS courseName, c.room, c.teacher
       FROM session s JOIN course c ON c.id = s.course_id
      WHERE s.class_id = ? AND s.kind <> 'CLEAN'
      ORDER BY s.day_of_week, s.period`, [classId]
  );
  const sessions = [];
  rows.forEach((s) => {
    if (!week.matchesWeeks(s.weeks, wk, s.week_rule)) return;
    const slot = week.resolveSlot(s.id, s.day_of_week, s.period, wk, shifts);
    sessions.push({
      sessionId: Number(s.id),
      course: s.courseName,
      room: s.room || '',
      teacher: s.teacher || '',
      dayOfWeek: Number(s.day_of_week),
      period: Number(s.period),
      dayText: '周' + (DAY_TEXT[s.day_of_week - 1] || '?'),
      groupScope: s.group_scope || null,
      // 原定日期（不含临时调课）——模型用它理解「周四」指的是哪天
      baseDate: week.getDateOfWeekDay(cfg.termStart, wk, s.day_of_week),
      // 现状：已被临时取消 → off=true；已被挪走 → date/现在是调课后的落位
      off: !slot,
      nowDay: slot ? slot.day : null,
      nowPeriod: slot ? slot.period : null,
      date: slot ? (week.classDateOf(cfg, wk, slot.day, cal) || '') : ''
    });
  });
  return { cfg, sessions };
}

/** 校验模型输出 → 可直接交给 course.shiftSet 落库的操作列表 */
function validateShiftPlan(ctx, raw) {
  const warnings = [];
  const byId = new Map(ctx.sessions.map(s => [s.sessionId, s]));
  const ops = [];
  const touched = new Set();

  (Array.isArray(raw && raw.operations) ? raw.operations : []).forEach((o) => {
    const kind = o && o.kind === 'MOVE' ? 'MOVE' : (o && o.kind === 'OFF' ? 'OFF' : '');
    if (!kind) { warnings.push('AI 返回了无法识别的操作类型，已忽略一条'); return; }
    const rawIds = (Array.isArray(o.sessionIds) ? o.sessionIds : []).map(Number).filter(Boolean);
    const miss = rawIds.filter(id => !byId.has(id));
    if (miss.length) warnings.push('AI 提到了本周不存在的课次 #' + miss.join('、') + '，已忽略');
    let toDay = null;
    let toPeriod = null;
    if (kind === 'MOVE') {
      toDay = Number(o.toDay);
      toPeriod = Number(o.toPeriod);
      if (!(toDay >= 1 && toDay <= 7) || !(toPeriod >= 1 && toPeriod <= 5)) {
        warnings.push('AI 给的调课目标「周' + o.toDay + ' 第' + o.toPeriod + '节」不合法，已忽略该操作');
        return;
      }
    }
    const keep = [];
    rawIds.filter(id => byId.has(id)).forEach((id) => {
      if (touched.has(id)) { warnings.push('课次 #' + id + ' 被 AI 安排了多次，只保留第一条'); return; }
      touched.add(id);
      keep.push(id);
    });
    if (!keep.length) return;
    ops.push({ sessionIds: keep, kind, toDay, toPeriod, note: String((o && o.note) || '').slice(0, 64) });
  });

  // 撞车预检：把操作套进去后，同一周同一「星期 + 节次」是否挤了两门课
  const after = {};
  ctx.sessions.forEach((s) => {
    after[s.sessionId] = { day: s.dayOfWeek, period: s.period, name: s.course, off: !!s.off };
  });
  ops.forEach(op => op.sessionIds.forEach((id) => {
    const a = after[id];
    if (!a) return;
    if (op.kind === 'OFF') { a.off = true; return; }
    a.off = false;
    a.day = op.toDay;
    a.period = op.toPeriod;
  }));
  const seen = {};
  Object.keys(after).forEach((id) => {
    const a = after[id];
    if (a.off) return;
    const key = a.day + '-' + a.period;
    if (seen[key] && seen[key] !== a.name) {
      warnings.push('周' + (DAY_TEXT[a.day - 1] || '?') + '第' + a.period + '节会同时有《'
        + seen[key] + '》和《' + a.name + '》两门课');
    }
    seen[key] = a.name;
  });
  (Array.isArray(raw && raw.warnings) ? raw.warnings : []).forEach((w) => {
    const t = String(w || '').trim().slice(0, 80);
    if (t && warnings.indexOf(t) < 0) warnings.push(t);
  });

  const preview = [];
  ops.forEach(op => op.sessionIds.forEach((id) => {
    const s = byId.get(id);
    preview.push({
      sessionId: id,
      name: s.course,
      room: s.room || '',
      fromDay: s.dayOfWeek,
      fromPeriod: s.period,
      fromText: '周' + (DAY_TEXT[s.dayOfWeek - 1] || '?') + '第' + s.period + '节',
      kind: op.kind,
      toDay: op.toDay,
      toPeriod: op.toPeriod,
      effect: op.kind === 'OFF' ? '本周不上'
        : ('改到 周' + (DAY_TEXT[op.toDay - 1] || '?') + '第' + op.toPeriod + '节'),
      note: op.note
    });
  }));

  return {
    operations: ops,
    preview,
    warnings,
    notes: String((raw && raw.notes) || '').slice(0, 120)
  };
}

/** 落库：删除本周 AUTO → 回滚这些人的轮转标记 → 写入计划 → 回写标记 */
async function writePlan(pool, wk, ctx, plan, skipSeqs, operatorId) {
  const op = Number(operatorId) || 0;
  const classId = ctx && ctx.cfg ? (ctx.cfg.classId || 1) : 1;
  const conn = await pool.getConnection();
  let created = 0;
  try {
    await conn.beginTransaction();
    // 「保持原样」的课次：一行都不动（duty.id 不变，打卡照片与日志不会断链），
    // 因此要从「删除 AUTO」的范围里排除掉。
    const keptSessions = Array.from(new Set(
      plan.filter(p => p.kept).map(p => Number(p.sessionId)).filter(Boolean)
    ));
    const KEEP = keptSessions.length
      ? (' AND session_id NOT IN (' + keptSessions.map(() => '?').join(',') + ')')
      : '';

    // ① 回滚本周 AUTO 占用的轮转标记（保持原样的那些不在其中，标记也不动）
    const [oldAuto] = await conn.query(
      "SELECT member_id, COUNT(*) AS n FROM duty WHERE class_id = ? AND week = ? AND source = 'AUTO'" + KEEP + ' GROUP BY member_id',
      [classId, wk].concat(keptSessions)
    );
    for (const r of oldAuto) {
      await conn.query('UPDATE member SET duty_count = GREATEST(duty_count - ?, 0) WHERE id = ?', [Number(r.n) || 0, r.member_id]);
    }
    await conn.query(
      "DELETE FROM duty_log WHERE duty_id IN (SELECT id FROM duty WHERE class_id = ? AND week = ? AND source = 'AUTO'" + KEEP + ')',
      [classId, wk].concat(keptSessions)
    );
    // v0.7.25：删值日前先作废引用中的待确认申请 —— 否则申请悬空成幽灵，
    // 永远无法确认却一直计入「待确认」提醒（§73）
    await conn.query(
      `UPDATE swap_request SET status = 'CANCELLED'
        WHERE status IN ('PENDING_PEER','PENDING_ADMIN')
          AND duty_id IN (SELECT id FROM duty WHERE class_id = ? AND week = ? AND source = 'AUTO'` + KEEP + ')',
      [classId, wk].concat(keptSessions)
    );
    await conn.query("DELETE FROM duty WHERE class_id = ? AND week = ? AND source = 'AUTO'" + KEEP, [classId, wk].concat(keptSessions));

    // ② 已存在的手动值日视为占位，不重复排
    const [manual] = await conn.query(
      "SELECT session_id, member_id, class_date FROM duty WHERE class_id = ? AND week = ? AND source = 'MANUAL'", [classId, wk]
    );
    const manualKeys = new Set(manual.map(m => m.session_id + '#' + Number(m.member_id)));
    const manualDays = {};
    manual.forEach(m => {
      const d = String(m.class_date).slice(0, 10);
      (manualDays[d] = manualDays[d] || new Set()).add(Number(m.member_id));
    });

    const markDelta = new Map();   // memberId -> 本次新增次数

    for (const p of plan) {
      const day = manualDays[p.date] = manualDays[p.date] || new Set();
      for (let i = 0; i < p.memberIds.length; i++) {
        const mid = p.memberIds[i];
        if (!mid) continue;
        if (manualKeys.has(p.sessionId + '#' + mid)) continue;
        const ins = await conn.query(
          `INSERT IGNORE INTO duty (class_id, session_id, week, class_date, member_id, status, source)
           VALUES (?, ?, ?, ?, ?, 'PENDING', 'AUTO')`,
          [classId, p.sessionId, wk, p.date, mid]
        );
        if (!ins[0] || !ins[0].affectedRows) continue;   // 已存在同课次同人 → 幂等跳过
        await conn.query('UPDATE member SET last_duty_at = ? WHERE id = ?', [p.date, mid]);
        await conn.query(
          'INSERT INTO duty_log (duty_id, operator_id, action, to_member) VALUES ((SELECT id FROM duty WHERE class_id=? AND session_id=? AND week=? AND member_id=?), ?, ?, ?)',
          [classId, p.sessionId, wk, mid, op, 'CREATE', mid]
        );
        markDelta.set(mid, (markDelta.get(mid) || 0) + 1);
        created += 1;
      }
    }

    // ③ 被「本轮跳过」的人：不给值日，但消耗掉本轮名额
    for (const seq of (skipSeqs || [])) {
      const mid = ctx.idBySeq.get(seq);
      if (mid) markDelta.set(mid, (markDelta.get(mid) || 0) + 1);
    }
    // ④ 本轮标记的「序号断层」补上的那批人：AI 链路只按增量写库（不像
    //    generate 那样整表回写），所以得在这里把他们补成「已排」，否则下周生成
    //    又会把他们当成没排过、倒回 1 号（详见 repairRoundMarks）
    for (const seq of (ctx.roundFillSeqs || [])) {
      const mid = ctx.idBySeq.get(seq);
      if (mid && !markDelta.has(mid)) markDelta.set(mid, 1);
    }
    for (const [mid, delta] of markDelta) {
      await conn.query('UPDATE member SET duty_count = duty_count + ? WHERE id = ?', [delta, mid]);
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  return created;
}

/**
 * 保洁课次轮转补齐的核心计算（apply 与 preview 共用同一份逻辑）。
 *
 * 为什么需要它：保洁与课次值日【共用同一序号轮转】，但 AI 上下文（buildAiContext /
 * buildShiftContext）里刻意【不含保洁】（避免模型误把保洁当普通课次去调动），
 * 因此 AI 计划里没有保洁，writePlan 也不会写保洁。而 writePlan 又会删除本周全部
 * AUTO 值日（含历史保洁），所以 AI 生成后保洁会「被清空却没补回」。
 *
 * - apply（writePlan 之后）调用：直接用已被 AI 计划更新过的 member.duty_count 继续轮转。
 * - preview（aiPlan）调用：dryRun=true 不写库，并通过 opt.markMap / opt.dayBusy
 *   模拟 AI 计划对「轮转池」与「当天已排」的影响，让预览里也能看到保洁安排。
 *
 * @param {object} conn 数据库连接（apply 时调用方需已在事务里）
 * @param {number} wk   周次
 * @param {object} opt  { operatorId, dryRun, markMap:Map<id,delta>, dayBusy:{date:Set<id>}, startFrom, keepSessions:number[] }
 * @returns {{created:number, rows:Array}} rows 可直接给前端渲染预览
 */
/**
 * AI 计划的「起点边界」：最早一条「非保持原样」课次的 (date, period)。
 * 使用者说「从周四第二节开始排」时，周四第二节之前的课次会被标 kept，
 * 于是边界 = 周四第二节 → 保洁也必须从这一刻起才排（否则会出现
 * 「课次从周四起、保洁却从周一起」这种自相矛盾的结果）。
 * @returns {null|{date:string, period:number}} null = 没有任何需要新排的课次
 */
function planStartBoundary(plan) {
  let best = null;
  (plan || []).forEach((p) => {
    if (!p || p.kept) return;
    const date = String(p.date || '').slice(0, 10);
    const period = Number(p.period);
    if (!date || !period) return;
    if (!best || date < best.date || (date === best.date && period < best.period)) {
      best = { date, period };
    }
  });
  return best;
}

async function buildCleaningPlan(conn, wk, opt = {}) {
  const operatorId = Number(opt.operatorId) || 0;
  const dryRun = !!opt.dryRun;
  const classId = Number(opt.classId) || 1;
  // 起点边界：null = 本周没有要新排的课次 → 保洁也不排
  const startFrom = opt.startFrom || null;
  const cfg = await week.getConfig(conn, classId);
  const cal = await week.loadCalendar(conn);
  const shifts = await week.loadSessionShifts(conn);
  const rules = await loadRules(conn, classId);

  const [sessRows] = await conn.query(
    `SELECT s.id, s.weeks, s.week_rule, s.day_of_week, s.period, s.group_scope, s.duty_count,
            c.name AS courseName, c.room
       FROM session s JOIN course c ON c.id = s.course_id
      WHERE s.class_id = ? AND s.kind = 'CLEAN'
      ORDER BY s.day_of_week, s.period, s.id`, [classId]
  );
  const sessions = sessRows.filter(s => week.matchesWeeks(s.weeks, wk, s.week_rule));
  if (!sessions.length) return { created: 0, rows: [] };

  const [memRows] = await conn.query(
    "SELECT id, name, student_no, group_tag, duty_count FROM member WHERE class_id = ? AND status = 'ACTIVE' AND group_tag <> 'X' AND duty_off = 0", [classId]
  );
  const markMap = opt.markMap || new Map();
  // preview：本周现有的 AUTO 行还没被删，但应用后会被删掉/重建 → 先从 base 里扣掉，
  // 否则保洁会跳过「本来可用的人」（这批人的标记马上就会被回滚）。
  // apply 不扣：那时 writePlan 已经执行完，duty_count 就是最新值。
  const roundBase = dryRun ? await loadWeekAutoCounts(conn, wk, opt.keepSessions, classId) : new Map();
  const roster = memRows.map(m => ({
    id: m.id,
    name: m.name,
    group: m.group_tag,
    seq: seqOf(m.student_no),
    // apply：直接用库里的 duty_count；preview：还原到「不含本周」再叠加 AI 计划带来的增量
    mark: Math.max(0, (Number(m.duty_count) || 0) - (roundBase.get(Number(m.id)) || 0))
      + (Number(markMap.get(m.id)) || 0)
  }));
  roster.sort((a, b) => (a.seq - b.seq) || (a.id - b.id));
  const memberById = new Map(memRows.map(m => [m.id, m]));

  // 本周已有的保洁占用（手动 + 自动都算，避免重复排）
  const [existRows] = await conn.query(
    "SELECT session_id, member_id FROM duty WHERE class_id = ? AND week = ? AND status <> 'SWAPPED_OUT' AND session_id IN (?)",
    [classId, wk, sessRows.map(s => s.id)]
  );
  const bySession = {};
  existRows.forEach(d => {
    (bySession[d.session_id] = bySession[d.session_id] || new Set()).add(Number(d.member_id));
  });

  /**
   * 本周已经值过日的人（含全部课程值日、保洁与手动排班），用于保证
   * 「一轮里每人最多排一次」——课程值日与保洁值日共用同一个轮转池，
   * 不能同一个人在周一扫教室、周三又打扫 410。
   * preview（dryRun）时 DB 里还是上一轮的 AUTO 行，不能直接用查询结果，
   * 由调用方通过 opt.inWeek 传入「应用之后」的占用。
   */
  let inWeek = opt.inWeek;
  if (!(inWeek instanceof Set)) {
    const [weekRows] = await conn.query(
      "SELECT DISTINCT member_id FROM duty WHERE class_id = ? AND week = ? AND status <> 'SWAPPED_OUT'", [classId, wk]
    );
    inWeek = new Set(weekRows.map(r => Number(r.member_id)));
  }

  const rows = [];
  let created = 0;

  /* 轮转取人顺序 = 实际上课日期顺序（同日按节次、课次 id）。
   * ⚠️ 与 generate 同一道坑：不能按 day_of_week 迭代 —— 调休（MOVE）后 session 的
   * day_of_week 不变，调来的那天会被提前分配序号（2026-10-05 国庆调休 10/7→10/10 实锤）。 */
  const rotatePlan = [];
  for (const s of sessions) {
    const slot = week.resolveSlot(s.id, s.day_of_week, s.period, wk, shifts);
    if (!slot) continue;                       // 本周临时调成「不上」
    const classDate = week.classDateOf(cfg, wk, slot.day, cal);
    if (!classDate) continue;                  // 法定假日当天不上
    rotatePlan.push({ s, slot, classDate });
  }
  rotatePlan.sort((a, b) => (
    a.classDate < b.classDate ? -1
      : a.classDate > b.classDate ? 1
        : (Number(a.slot.period) - Number(b.slot.period)) || (a.s.id - b.s.id)
  ));

  for (const { s, slot, classDate } of rotatePlan) {
    // 跟随 AI 计划的起点：边界之前的保洁不排（对齐「从周四第二节开始排」这类要求）
    if (!startFrom) continue;
    if (classDate < startFrom.date
      || (classDate === startFrom.date && Number(slot.period) < startFrom.period)) continue;

    const taken = bySession[s.id] || new Set();
    const assigned = [];                       // 已有 + 本次新排（按展示顺序）
    taken.forEach((mid) => {
      const m = memberById.get(mid);
      if (m) assigned.push({ id: m.id, name: m.name, seq: seqOf(m.student_no) });
    });

    const need = (Number(s.duty_count) || 2) - taken.size;
    if (need > 0) {
      const blocks = await loadDayBlocks(conn, classDate);
      // preview：把 AI 计划当天刚排的人也计入「当天已有值日」
      const extra = opt.dayBusy && opt.dayBusy[classDate];
      if (extra) extra.forEach(id => blocks.busy.add(Number(id)));
      // inBatch 用当天全部已排人（与 generate 的 avoidSameDay 一致：同日不重复值日）
      // inWeek：本周任何一天（含课程值日）已经值过日的人，不再重复排
      const picked = rotationPick(roster, s.group_scope, need, blocks, rules.avoidSameDay, blocks.busy, taken, inWeek);
      for (const m of picked.chosen) {
        if (!dryRun) {
          await conn.query(
            `INSERT IGNORE INTO duty (class_id, session_id, week, class_date, member_id, status, source)
             VALUES (?, ?, ?, ?, ?, 'PENDING', 'AUTO')`,
            [classId, s.id, wk, classDate, m.id]
          );
          await conn.query('UPDATE member SET last_duty_at = ? WHERE id = ?', [classDate, m.id]);
          await conn.query(
            'INSERT INTO duty_log (duty_id, operator_id, action, to_member) VALUES ((SELECT id FROM duty WHERE class_id=? AND session_id=? AND week=? AND member_id=?), ?, ?, ?)',
            [classId, s.id, wk, m.id, operatorId, 'CREATE', m.id]
          );
        }
        created += 1;
        taken.add(m.id);
        inWeek.add(m.id);
        assigned.push({ id: m.id, name: m.name, seq: m.seq });
      }
    }

    rows.push({
      sessionId: s.id,
      date: classDate,
      dayOfWeek: slot.day,
      dayText: '周' + (DAY_TEXT[slot.day - 1] || '?'),
      period: slot.period,
      course: s.courseName || '打扫410',
      room: s.room || '',
      groupScope: s.group_scope || null,
      dutyCount: Number(s.duty_count) || 2,
      memberIds: assigned.map(a => a.id),
      memberSeqs: assigned.map(a => a.seq),
      names: assigned.map(a => a.name),
      isClean: true,
      kept: false,
      reason: need > 0 ? '保洁按轮转补齐' : '已有保洁，保持不变'
    });
  }

  if (!dryRun && roster.length) {
    const caseSql = 'UPDATE member SET duty_count = CASE id '
      + roster.map(r => `WHEN ${Number(r.id)} THEN ${Number(r.mark)}`).join(' ')
      + ' END WHERE id IN (' + roster.map(r => Number(r.id)).join(',') + ')';
    await conn.query(caseSql);
  }
  return { created, rows };
}

/** apply 用：AI 计划落库后，把本周保洁课次补成 AUTO 值日（startFrom = AI 计划的起点边界） */
async function fillCleaningByRotation(pool, wk, operatorId, startFrom, classId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { created } = await buildCleaningPlan(conn, wk, { operatorId, dryRun: false, startFrom, classId });
    await conn.commit();
    return created;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * aiPlan 预览用：模拟「先应用 AI 计划、再按轮转补齐保洁」的结果，不写库。
 * markMap 模拟 AI 计划给这些人新增的轮转次数，dayBusy 模拟 AI 计划当天的占用，
 * 这样预览里看到的保洁人选才和实际点击「应用到本周」后的结果一致。
 */
async function previewCleaning(pool, wk, ctx, v) {
  const conn = await pool.getConnection();
  const classId = ctx && ctx.cfg ? (ctx.cfg.classId || 1) : 1;
  try {
    const markMap = new Map();
    const dayBusy = {};
    (v.plan || []).forEach(p => {
      if (p.kept) return;                      // 保持原样：库里已有，duty_count 已反映
      (p.memberIds || []).forEach((mid) => {
        if (!mid) return;
        markMap.set(mid, (markMap.get(mid) || 0) + 1);
        const set = dayBusy[p.date] = dayBusy[p.date] || new Set();
        set.add(mid);
      });
    });
    (v.skipSeqs || []).forEach((seq) => {
      const mid = ctx.idBySeq.get(seq);
      if (mid) markMap.set(mid, (markMap.get(mid) || 0) + 1);
    });
    /**
     * 「应用之后」本周会值过日的人：AI 计划里的所有人（含保持原样的课次）
     * + 本轮跳过的人 —— 保洁轮转要避开他们，保证一轮里每人只排一次。
     * 不能直接用 DB 查询：此刻库里还躺着上一轮的 AUTO 行，马上就会被整批删掉。
     */
    const inWeek = new Set();
    (v.plan || []).forEach(p => (p.memberIds || []).forEach((mid) => { if (mid) inWeek.add(Number(mid)); }));
    (v.skipSeqs || []).forEach(seq => { const mid = ctx.idBySeq.get(seq); if (mid) inWeek.add(Number(mid)); });
    const [manualRows] = await conn.query(
      "SELECT DISTINCT member_id FROM duty WHERE class_id = ? AND week = ? AND source = 'MANUAL' AND status <> 'SWAPPED_OUT'", [classId, wk]
    );
    manualRows.forEach(r => inWeek.add(Number(r.member_id)));
    // 保洁跟随 AI 计划的起点（「从周四第二节开始排」→ 只从周四起排保洁）
    const startFrom = planStartBoundary(v.plan);
    // 「保持原样」的课次不会被删，它们现有的人要照旧算进轮转标记，不能一起扣掉
    const keepSessions = (v.plan || []).filter(p => p.kept).map(p => Number(p.sessionId)).filter(Boolean);
    const { rows } = await buildCleaningPlan(conn, wk, { dryRun: true, markMap, dayBusy, startFrom, keepSessions, inWeek, classId });
    return rows;
  } catch (e) {
    // 保洁预览失败不该拖垮主计划：宁可不显示，也不要让整个生成报错
    console.error('[schedule] aiPlan cleaning preview fail', String((e && e.message) || e).slice(0, 200));
    return [];
  } finally {
    conn.release();
  }
}


async function loadRules(pool, classId) {
  const [rows] = await pool.query('SELECT * FROM schedule_rules WHERE class_id = ? ORDER BY id LIMIT 1', [Number(classId) || 1]);
  const r = rows[0] || {};
  return {
    sortByCount: !!r.sort_by_count,
    avoidSameDay: !!r.avoid_same_day,
    avoidBackToBack: !!r.avoid_back_to_back,
    cronEnabled: !!r.cron_enabled,
    cronWeekday: r.cron_weekday || 0,
    cronHour: r.cron_hour || 20
  };
}

async function loadPublish(pool, wk, classId) {
  const [rows] = await pool.query('SELECT * FROM schedule_publish WHERE class_id = ? AND week = ? LIMIT 1', [Number(classId) || 1, wk]);
  return rows[0] || null;
}

/**
 * 值日内容发生变更（生成 / AI 重排）后，如果本周已发布，则退回草稿。
 * 否则班级看到的仍是「已发布」状态，但内容已经和当初发布的不一致了。
 * 退回后需要超级管理员重新点「发布」，班群才会再收到一次通知。
 */
async function toDraftIfPublished(pool, wk, classId) {
  const pub = await loadPublish(pool, wk, classId);
  if (!pub || pub.status !== 'PUBLISHED') return false;
  await pool.query("UPDATE schedule_publish SET status = 'DRAFT', published_at = NULL WHERE class_id = ? AND week = ?", [Number(classId) || 1, wk]);
  return true;
}

/**
 * 读本周值日。@param shifts week.loadSessionShifts() 的结果（可省）
 *
 * duty 表**不存节次**，课次的星期 / 节次都是 JOIN session 得来的。临时调课
 * 把某节课挪走之后，session 那一行并没有变，所以这里必须再用 resolveSlot
 * 解析一次，否则值日页会显示「老时间」。日期不用在这里改：class_date 已经
 * 在写入调课时同步改过了。
 */
async function loadWeekDuties(pool, wk, shifts, classId) {
  const [rows] = await pool.query(
    `       SELECT d.id, d.session_id, d.week, d.class_date, d.member_id, d.status, d.source, d.done_at,
              s.day_of_week, s.period, s.group_scope, s.kind AS sessionKind,
              c.name AS courseName, c.room,
              m.name AS memberName, m.group_tag AS memberGroup, m.student_no AS memberNo
       FROM duty d
       JOIN session s ON s.id = d.session_id
       JOIN course c ON c.id = s.course_id
       JOIN member m ON m.id = d.member_id
      WHERE d.class_id = ? AND d.week = ?
      ORDER BY d.class_date, s.period, d.id`, [Number(classId) || 1, wk]
  );
  return rows.map((d) => {
    const slot = week.resolveSlot(d.session_id, d.day_of_week, d.period, wk, shifts);
    if (!slot) return d;
    return Object.assign({}, d, { day_of_week: slot.day, period: slot.period });
  });
}

function decorateDuty(d, periods, meId) {
  return {
    id: d.id,
    dutyId: d.id,
    sessionId: d.session_id,
    week: d.week,
    classDate: String(d.class_date).slice(0, 10),
    dayOfWeek: d.day_of_week,
    period: d.period,
    courseName: d.courseName,
    room: d.room || '',
    // kind 是 session 表的列（duty 表没有 kind 列），SQL 里必须 AS sessionKind，别写成 d.kind（会 1054）
    kind: d.sessionKind || 'COURSE',
    groupScope: d.group_scope,
    memberId: d.member_id,
    name: d.memberName,
    groupTag: d.memberGroup,
    seq: seqOf(d.memberNo),
    status: week.effectiveStatus({ status: d.status, class_date: d.class_date, period: d.period }, periods),
    rawStatus: d.status,
    source: d.source,
    isMine: d.member_id === meId
  };
}

/** 当日已有值日者 / 已请假者 —— 实现见 common/schedule-core.js（与 cron-weekly 共用） */


/**
 * 轮转取人（核心规则）—— 唯一实现已抽到 `common/schedule-core.js`，
 * 与 `cron-weekly` 的每周自动生成共用同一份，禁止再写第二份。
 * 规则摘要：一轮 = 全班每人各值一次；一轮里每人最多排一次（跨天也算重复）；
 * 本周排到 40 号 → 下周从 41 号继续 → 56 人排完重置回 1 号。
 */


const routes = {
  listWeek: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const wk = Number(payload.week);
      if (!wk) throw new BizError(41001, '参数错误');
      const pool = getPool();
      // v0.7.16：教职工可传 classId 查看自己绑定班级的值日（resolveClassId 做范围校验）
      const classId = await guard.resolveClassId(pool, ctx, payload);
      const cfg = await week.getConfig(pool, classId);
      const periods = week.periodMap(cfg);
      const me = guard.requireBind(ctx);
      const admin = guard.isAdmin(ctx.member);
      const pub = await loadPublish(pool, wk, classId);
      const published = !!(pub && pub.status === 'PUBLISHED');
      if (!admin && !published) {
        return { status: 'DRAFT', unpublished: true, days: [], warnings: [] };
      }
      const shifts = await week.loadSessionShifts(pool);
      const rows = await loadWeekDuties(pool, wk, shifts, classId);
      const dayMap = {};
      rows.forEach(d => {
        const date = String(d.class_date).slice(0, 10);
        if (!dayMap[date]) {
          dayMap[date] = { date, weekday: week.weekdayOf(date), duties: [] };
        }
        dayMap[date].duties.push(decorateDuty(d, periods, me.id));
      });
      const days = Object.keys(dayMap).sort().map(k => dayMap[k]);
      return {
        status: published ? 'PUBLISHED' : 'DRAFT',
        unpublished: false,
        archived: wk < week.currentWeek(cfg),
        days,
        warnings: []
      };
    }
  },

  /**
   * 手动排班板（超级管理员）：返回本周「全部课次」——包括尚无值日的空课次——
   * 以及名册与当天的占用 / 请假信息，供手动把成员安排到某节课值日。
   *
   * 与 listWeek 的关键区别：listWeek 是按「已有值日」反推日期分组，没有值日的课次
   * 根本不会出现，所以无法给空课次安排第一个人。手动排班必须看到全部课次。
   */
  manualBoard: {
    auth: { scheduleAuth: true },
    handler: async (payload, ctx) => {
      const wk = Number(payload.week);
      if (!wk) throw new BizError(41001, '参数错误');
      const pool = getPool();
      const classId = guard.classIdOf(ctx);
      const cfg = await week.getConfig(pool, classId);
      const periods = week.periodMap(cfg);
      const cal = await week.loadCalendar(pool);
      const pub = await loadPublish(pool, wk, classId);
      const shifts = await week.loadSessionShifts(pool);

      const [sessRows] = await pool.query(
        `SELECT s.id, s.weeks, s.week_rule, s.day_of_week, s.period, s.group_scope, s.duty_count, s.kind,
                c.name AS courseName, c.room, c.teacher
           FROM session s JOIN course c ON c.id = s.course_id
          WHERE s.class_id = ?
          ORDER BY s.day_of_week, s.period, s.id`, [classId]
      );
      // 先按周次过滤，再套临时调课：本周临时不上的课次不该出现在排班板里
      const sessions = [];
      sessRows.forEach((s) => {
        if (!week.matchesWeeks(s.weeks, wk, s.week_rule)) return;
        const slot = week.resolveSlot(s.id, s.day_of_week, s.period, wk, shifts);
        if (!slot) return;
        sessions.push(Object.assign({}, s, {
          day_of_week: slot.day, period: slot.period, shifted: slot.shifted
        }));
      });

      // 本周已排值日（换出的不计入：这些人已经不再负责该课次）
      const duties = (await loadWeekDuties(pool, wk, shifts, classId)).filter(d => d.status !== 'SWAPPED_OUT');
      const bySession = {};
      duties.forEach(d => { (bySession[d.session_id] = bySession[d.session_id] || []).push(d); });

      const dayMap = {};
      sessions.forEach(s => {
        const date = week.classDateOf(cfg, wk, s.day_of_week, cal);
        if (!date) return;   // 放假且无调课：本周不上，不排值日
        if (!dayMap[date]) {
          dayMap[date] = { date, weekday: week.weekdayOf(date), busyIds: [], leaveIds: [], sessions: [] };
        }
        const members = (bySession[s.id] || [])
          .map(d => decorateDuty(d, periods, 0))
          .sort((a, b) => (a.seq || 0) - (b.seq || 0));
        dayMap[date].sessions.push({
          sessionId: s.id,
          period: s.period,
          courseName: s.courseName,
          room: s.room || '',
          teacher: s.teacher || '',
          // CLEAN = 保洁课次（打扫 410）→ 前端显示「18点前」，与值日页口径一致
          kind: s.kind || 'COURSE',
          groupScope: s.group_scope || null,
          dutyCount: Number(s.duty_count) || 1,
          classDate: date,
          members,
          filled: members.length
        });
      });
      const days = Object.keys(dayMap).sort().map(k => dayMap[k]);

      // 同日占用（含当天别节课的人）：手动添加/换人时的硬规则之一
      duties.forEach(d => {
        const date = String(d.class_date).slice(0, 10);
        const day = dayMap[date];
        if (day && day.busyIds.indexOf(d.member_id) < 0) day.busyIds.push(d.member_id);
      });

      // 请假（按天匹配，同一人可能只请其中几天）
      const dates = days.map(d => d.date);
      if (dates.length) {
        const [leaveRows] = await pool.query(
          `SELECT member_id, start_date, end_date FROM leave_request
            WHERE class_id = ? AND status = 'APPROVED' AND end_date >= ? AND start_date <= ?`,
          [classId, dates[0], dates[dates.length - 1]]
        );
        const leaves = leaveRows.map(r => ({
          memberId: r.member_id,
          from: week.dateStr(r.start_date),
          to: week.dateStr(r.end_date)
        }));
        days.forEach(day => {
          day.leaveIds = leaves.filter(l => l.from <= day.date && day.date <= l.to).map(l => l.memberId);
        });
      }

      // 名册（可安排的人）：只取在用成员。
      // 例外：测试账号状态是 LEAVE，但超管手动排班需要它们（需求④：排进课次后登进去换班，
      // 验证主账号能否收到换班通知），所以这里对 2608057499% 放行。
      const [memRows] = await pool.query(
        "SELECT id, name, student_no, group_tag, duty_count FROM member WHERE class_id = ? "
        + "AND (status = 'ACTIVE' OR student_no LIKE '" + TEST_NO_PREFIX + "%') AND group_tag <> 'X' AND duty_off = 0", [classId]
      );
      const roster = memRows.map(m => ({
        id: m.id,
        name: m.name,
        groupTag: m.group_tag,
        seq: seqOf(m.student_no),
        dutyCount: Number(m.duty_count) || 0,
        test: isTestNo(m.student_no)
      })).sort((a, b) => (a.seq - b.seq) || (a.id - b.id));

      const allMembers = [];
      days.forEach(d => d.sessions.forEach(s => s.members.forEach(m => allMembers.push(m))));
      const people = new Set(allMembers.map(m => m.memberId)).size;

      return {
        week: wk,
        published: !!(pub && pub.status === 'PUBLISHED'),
        days,
        roster,
        stats: { total: allMembers.length, people, sessions: sessions.length }
      };
    }
  },

  /** 一键生成 / 重新生成 / 沿用上周（幂等：先删本周 AUTO） */
  generate: {
    auth: { scheduleAuth: true },
    handler: async (payload, ctx) => {
      const wk = Number(payload.week);
      if (!wk) throw new BizError(41001, '参数错误');
      const pool = getPool();
      const classId = guard.classIdOf(ctx);
      const cfg = await week.getConfig(pool, classId);
      const rules = await loadRules(pool, classId);
      const cal = await week.loadCalendar(pool);
      const conn = await pool.getConnection();
      const warnings = [];
      let created = 0;
      let roundReset = false;    // 本次生成中是否开过新一轮（1→56 排完）
      let holidaySkipped = 0;    // 因法定放假跳过的课次数
      let shiftSkipped = 0;      // 因「临时调课 · 本周不上」跳过的课次数
      /*
       * v0.7.22 需求②实锤：「按序号轮转」每次都报 50000 的真凶 ——
       * roundFix 原先 `const` 在 try 块**内**声明，而 try/finally **之后**的
       * console.log 与 return 都引用它 → 块级作用域外引用 = ReferenceError:
       * 「roundFix is not defined」。此时事务**已经 commit**（库里落了行），
       * 但响应仍是 50000 —— 表现为「生成成功却报错、每次都失败」。
       * 修法：声明提到 try 外（与其它计数器同层），try 内只做赋值。
       * （cron-weekly 的同名声明本就在 try 外，无需改；超管 toast 里那句
       *   「（roundFi…」就是这次靠 v0.7.22 的诊断透出第一眼看到的。）
       */
      let roundFix = { cursor: 0, filled: [] };
      try {
        await conn.beginTransaction();
        const sessions = (await conn.query(
          `SELECT s.id, s.week_rule, s.weeks, s.day_of_week, s.period, s.group_scope, s.duty_count
             FROM session s WHERE s.class_id = ? ORDER BY s.day_of_week, s.period`, [classId]
        ))[0].filter(s => week.matchesWeeks(s.weeks, wk, s.week_rule));
        /*
         * 需求 D：无课次时**必须报错**，不能静默返回 0 条。
         * 原先没有这道守卫 —— 本班没有课程表（无 session 骨架）时会走正常返回路径，
         * 前端提示「生成成功」而值日表依旧空白，属「点了没反应」类缺陷。
         * 对照：buildCleaningPlan 早有 `if (!sessions.length) return { created: 0, rows: [] }`，
         * aiPlan 也早有 41002 —— 只有 generate 是漏的。抛出即回滚（此时尚未写入任何行）。
         */
        if (!sessions.length) {
          throw new BizError(41002, '本班尚未录入课程表，无法生成值日安排（请等教务系统接入或联系超级管理员录入课次）');
        }
        // 临时调课：conn 也有 .query，直接当 pool 用，保证与本次事务同一个快照
        const shifts = await week.loadSessionShifts(conn);

        // ── 本轮轮转池：duty_count 即「本轮已排次数」标记，0 = 本轮尚未安排 ──
        const [memRows] = await conn.query(
          "SELECT id, student_no, group_tag, duty_count FROM member WHERE class_id = ? AND status = 'ACTIVE' AND group_tag <> 'X' AND duty_off = 0", [classId]
        );
        // 本周已有的 AUTO 值日马上会被下面的 DELETE 删掉，所以算轮转位置时必须先扣掉它们，
        // 否则「重新生成同一周」会把这些人误判成本轮已排过（换一批人 + 标记重复累加）。
        const ownAuto = await loadWeekAutoCounts(conn, wk, null, classId);
        const roster = memRows.map(m => ({
          id: m.id,
          group: m.group_tag,
          seq: seqOf(m.student_no),
          mark: Math.max(0, (Number(m.duty_count) || 0) - (ownAuto.get(Number(m.id)) || 0))
        }));
        roster.sort((a, b) => (a.seq - b.seq) || (a.id - b.id));
        // 补齐序号断层：清空某周后那批人的标记掉回 0，但后面还有人带着标记，
        // 不补的话 rotationPick 会把「01 号」当成本轮还没排过而倒回 1 号重排
        // （2026-09-26 用户反馈：第 3 周排到 48，第 4 周却从 1 号开始）。详见 repairRoundMarks。
        roundFix = repairRoundMarks(roster);
        /*
         * ⚠️ v0.7.23 删掉了这里原有的「全员 mark > 0 → 全班 duty_count 清零，从 1 号重开」。
         * 两个理由：
         *
         * ① 它与「分级取人」的数学性质重复。
         *    一轮 = 序号 01→56 各排一次。本轮排满时，rotationPick 的取人顺序是
         *    「标记最小档 + 序号升序」→ 取到的正是本轮**最早**排的那批（= 序号最小那批）
         *    → 天然就从 1 号开始，根本不需要把标记真的清零。
         *    （check-round-robin.js 第 1 部分已经把这个等价性钉死了。）
         *
         * ② 更致命：**「全员 mark > 0」并不等于「一轮刚排满」**，它还覆盖「已经多排了
         *    新一轮开头几个人」的跨轮态 —— 而这恰恰是清零最不该发生的时候。
         *    线上实锤（2026-09-27 用户第三次反馈「10 月 12 日怎么又从 1 号开始排」）：
         *      第 4 周把 49~56 排完（一轮结束）后又多排了 01~08 号（新一轮开了个头），
         *      duty_count 成了「01~08 = 2、09~56 = 1」—— 全员都 > 0。
         *      清零一执行，01~08 的「已值 2 次」连同「新一轮已走到 08」这个位置信息
         *      一起被抹平 → 第 5 周又从 01 号重排，与第 4 周**重复排了那 8 个人**。
         *    不清零时同一份数据会走 tier② 取 mark 最小的 09~56 → 正确地接续到 09 号。
         *
         * 另外：cron-weekly（周日 20:00 自动生成）从建立起就没有这段清零，两条链路
         * 在跨轮态给出的名单因而不一致。删掉它同时也修好了这个不一致。
         *
         * 铁律：轮转位置只由 `member.duty_count` 的**相对大小**决定，任何人任何路径
         * 都不要把它整体归零（同理见 schedule.clear 的按周回滚、schedule-core.js 顶部
         * 的反面教材）。真需要「重置」时由 rotationPick 的分档自然完成。
         * 该约束由 scripts/check-round-robin.js 第 5 部分守着（含变异自证）。
         */

        // 沿用上周：上周 session -> member 映射
        let carryMap = {};
        if (payload.fromWeek) {
          const [prev] = await conn.query(
            `SELECT d.session_id, d.member_id, d.status FROM duty d WHERE d.class_id = ? AND d.week = ? AND d.status != 'SWAPPED_OUT'`,
            [classId, Number(payload.fromWeek)]
          );
          prev.forEach(p => {
            if (!carryMap[p.session_id]) carryMap[p.session_id] = [];
            carryMap[p.session_id].push(p.member_id);
          });
        }

        await conn.query("DELETE FROM duty WHERE class_id = ? AND week = ? AND source = 'AUTO'", [classId, wk]);
        // v0.7.25：作废全部悬空申请（§73 —— 引用的 duty 已不存在的待确认申请永远无法确认）
        await conn.query(
          `UPDATE swap_request SET status = 'CANCELLED'
            WHERE status IN ('PENDING_PEER','PENDING_ADMIN')
              AND NOT EXISTS (SELECT 1 FROM duty d WHERE d.id = duty_id)`
        );
        const [manualDuties] = await conn.query(
          "SELECT DISTINCT class_date, member_id FROM duty WHERE class_id = ? AND week = ? AND source = 'MANUAL'", [classId, wk]
        );
        const assignedByDate = {};
        /**
         * 本周已经值过日的人（含手动排班）。轮转时要把他们排除掉，保证
         * 「一轮里每人最多排一次」——否则同一个人会在周一、周三各值一次。
         */
        const assignedWeek = new Set();
        manualDuties.forEach(m => {
          const date = String(m.class_date).slice(0, 10);
          (assignedByDate[date] = assignedByDate[date] || new Set()).add(m.member_id);
          assignedWeek.add(m.member_id);
        });

        /* ① 先把每个课次「实际上课的日期」算出来（含临时调课 MOVE 的落位与法定假日跳过） */
        const rotatePlan = [];
        for (const s of sessions) {
          // 临时调课优先：OFF → 本周这节课不上，不排值日；
          // MOVE → 用调课后的星期 / 节次算日期。
          const slot = week.resolveSlot(s.id, s.day_of_week, s.period, wk, shifts);
          if (!slot) { shiftSkipped += 1; continue; }
          // 法定假日当天不上课 → 不排值日；有调课记录 → 用调课后的日期
          const classDate = week.classDateOf(cfg, wk, slot.day, cal);
          if (!classDate) { holidaySkipped += 1; continue; }
          rotatePlan.push({ s, slot, classDate });
        }
        /* ② 轮转取人顺序 = **实际上课日期**顺序（同日再按节次、课次 id）。
         * ⚠️ 不能按 SQL 的 day_of_week 顺序迭代：调休（MOVE）只是把「周三的课」挪到周六上，
         * session 行的 day_of_week 仍是 3 —— 按 星期几 迭代会让调来的那天（如 10/10）
         * 排在 10/8、10/9 **前面**被分配轮转序号（2026-10-05 用户实锤：
         * 国庆调休 10/7→10/10 后，序号轮转顺序变成 10 号、8 号、9 号）。
         * 与 aiPlan 的 plan.sort(date, period) 同一口径；buildCleaningPlan 同步修复。 */
        rotatePlan.sort((a, b) => (
          a.classDate < b.classDate ? -1
            : a.classDate > b.classDate ? 1
              : (Number(a.slot.period) - Number(b.slot.period)) || (a.s.id - b.s.id)
        ));
        for (const { s, slot, classDate } of rotatePlan) {
          const n = s.duty_count || 1;
          const blocks = await loadDayBlocks(conn, classDate);
          const inBatch = assignedByDate[classDate] || new Set();

          // 沿用上周：先尝试把上周同课次的人原样带过来
          let chosen = [];
          const exclude = new Set();
          if (payload.fromWeek && carryMap[s.id]) {
            const byId = new Map(roster.map(r => [r.id, r]));
            carryMap[s.id].forEach(id => {
              const m = byId.get(id);
              if (!m || exclude.has(m.id)) return;
              if (s.group_scope && m.group !== s.group_scope) return;
              if (blocks.onLeave.has(m.id)) return;
              if (assignedWeek.has(m.id)) return;          // 本周已经值过日，不再重复
              if (rules.avoidSameDay && (blocks.busy.has(m.id) || inBatch.has(m.id))) return;
              chosen.push(m);
              exclude.add(m.id);
            });
            chosen.forEach(m => { m.mark += 1; });
          }
          if (chosen.length < n) {
            // 自动排班 = 按序号连续轮转（1→56 排完自动开新一轮）
            const picked = rotationPick(
              roster, s.group_scope, n - chosen.length, blocks, rules.avoidSameDay, inBatch, exclude, assignedWeek
            );
            if (picked.wrapped) roundReset = true;
            chosen = chosen.concat(picked.chosen);
            if (picked.short > 0) {
              warnings.push({
                type: 'SHORTAGE',
                sessionId: s.id,
                dayOfWeek: slot.day,
                period: slot.period,
                need: n,
                left: picked.left,
                message: '周' + (DAY_TEXT[slot.day - 1] || '?') + '第' + slot.period + '节候选不足（还需 ' + picked.short + ' 人）'
              });
            }
          }
          // 本周已经值过日的人：后续课次不再重复排（一轮里每人最多排一次）
          chosen.forEach(m => { assignedWeek.add(m.id); });
          for (const m of chosen) {
            try {
              await conn.query(
                `INSERT IGNORE INTO duty (class_id, session_id, week, class_date, member_id, status, source)
                 VALUES (?, ?, ?, ?, ?, 'PENDING', 'AUTO')`,
                [classId, s.id, wk, classDate, m.id]
              );
              await conn.query('UPDATE member SET last_duty_at = ? WHERE id = ?', [classDate, m.id]);
              await conn.query(
                'INSERT INTO duty_log (duty_id, operator_id, action, to_member) VALUES ((SELECT id FROM duty WHERE class_id=? AND session_id=? AND week=? AND member_id=?), ?, ?, ?)',
                [classId, s.id, wk, m.id, ctx.member.id, 'CREATE', m.id]
              );
              created += 1;
              (assignedByDate[classDate] = assignedByDate[classDate] || new Set()).add(m.id);
            } catch (e) {
              // UNIQUE 冲突跳过（幂等）
            }
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
      console.log(JSON.stringify({ fn: 'schedule', action: 'generate', member: ctx.member.id, classId, week: wk, created, roundReset, holidaySkipped, shiftSkipped, roundFixed: roundFix.filled.length, warnings: warnings.length }));
      const resetPublish = await toDraftIfPublished(pool, wk, classId);
      return { created, warnings, roundReset, holidaySkipped, shiftSkipped, resetPublish, roundFixed: roundFix.filled.length };
    }
  },

  /* ---------------- AI 排班（DeepSeek） ---------------- */

  /**
   * 自检（超级管理员排障用）：
   * ① 走代理时有出口函数负责探测：给出「函数能否访问外网」「出口有没有配密钥」；
   * ② 直连模式则用一次不含密钥的探测，只要拿到 HTTP 状态码就说明能出网；
   * ③ payload.probe=true 时再跑一次真实的极短对话，端到端验证。
   * 只回报布尔与状态码，绝不回传任何密钥。
   */
  aiCheck: {
    auth: { scheduleAuth: true },
    handler: async (payload, ctx) => {
      const out = {
        route: AI_PROXY ? ('proxy:' + AI_PROXY) : 'direct',
        base: AI_BASE, model: AI_MODEL,
        egress: 'skip', httpStatus: 0, hasKey: aiAvailable(), error: '', reply: '',
        hasSeqOf: typeof week.seqOf === 'function',
        env: {
          DB_HOST: !!process.env.DB_HOST,
          DB_USER: !!process.env.DB_USER,
          DB_PWD: !!process.env.DB_PWD,
          WX_APPID: !!process.env.WX_APPID,
          AI_PROXY_TOKEN: !!process.env.AI_PROXY_TOKEN
        }
      };
      if (AI_PROXY) {
        try {
          const res = await cloud.callFunction({ name: AI_PROXY, data: { action: 'ping' }, timeout: 20000 });
          const r = (res && res.result) || {};
          if (r.errCode !== 0) { out.egress = 'fail'; out.hasKey = false; out.error = r.errMsg || '出口函数调用失败'; return out; }
          const d = r.data || {};
          out.egress = d.egress || 'fail';
          out.httpStatus = d.httpStatus || 0;
          out.hasKey = !!d.hasKey;
          out.error = d.error || '';
          if (out.egress !== 'ok') {
            out.hasKey = false;
            out.error = '出口函数无法访问 ' + (d.base || AI_BASE) + '：' + (d.error || '未知原因');
          }
        } catch (e) {
          out.egress = 'fail';
          out.hasKey = false;
          out.error = '调用出口函数失败：' + String((e && e.message) || e).slice(0, 200);
          return out;
        }
      } else {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10000);
        try {
          const res = await fetch(AI_BASE + '/models', {
            headers: { Authorization: 'Bearer ' + (process.env.DEEPSEEK_API_KEY || 'probe') },
            signal: ctrl.signal
          });
          out.egress = 'ok';
          out.httpStatus = res.status;
        } catch (e) {
          out.egress = 'fail';
          out.error = '无法访问 ' + AI_BASE + '：' + String((e && e.message) || e).slice(0, 200);
        } finally {
          clearTimeout(timer);
        }
      }

      // 真实往返：验证「schedule → 出口函数 → DeepSeek → 回来」整条链
      if (payload && payload.probe) {
        try {
          const t0 = Date.now();
          const r = await callAi([
            { role: 'system', content: '你是测试助手。' },
            { role: 'user', content: '请只回复一个 JSON：{"ok":true}' }
          ], 45000, await resolveAiCfg(getPool(), ctx));
          out.reply = String(r.content || '').slice(0, 80);
          out.probeMs = Date.now() - t0;
        } catch (e) {
          out.error = (out.error ? out.error + ' | ' : '') +
            '真实往返失败：' + String((e && e.errMsg) || (e && e.message) || e).slice(0, 200);
        }
      }
      return out;
    }
  },

  /** 返回默认提示词（供客户端展示 / 编辑） */
  aiPrompt: {
    auth: { scheduleAuth: true },
    handler: async () => ({
      prompt: DEFAULT_AI_PROMPT,
      hasKey: aiAvailable(),
      model: AI_MODEL,
      route: AI_PROXY ? ('proxy:' + AI_PROXY) : 'direct'
    })
  },

  /**
   * AI 生成排班（只算不写库）。
   * payload: { week, text, prompt? }
   * 返回计划 + 校验告警；由前端确认后再调 aiApply 落库。
   */
  aiPlan: {
    auth: { scheduleAuth: true },
    handler: async (payload, ctx) => {
      const wk = Number(payload.week);
      if (!wk) throw new BizError(41001, '参数错误');
      const text = String(payload.text || '').trim().slice(0, 600);
      const t0 = Date.now();
      try {
        // 部署自检：common/week 是同步进去的副本，漏了 seqOf 会变成
        // 一个「无 errCode 的 TypeError」，被顶层兜底成「服务开小差了」，
        // 极难排查。这里提前给出明确原因。
        if (typeof week.seqOf !== 'function') {
          throw new BizError(40008, '部署包里的 common/week.js 缺少 seqOf，请重新执行 sync-common 并部署 schedule');
        }
        const pool = getPool();
        const ctx2 = await buildAiContext(pool, wk, guard.classIdOf(ctx));
        if (!ctx2.sessions.length) throw new BizError(41002, '本周没有需要值日的课次（可能整周放假）');

        const prompt = String(payload.prompt || '').trim() || DEFAULT_AI_PROMPT;
        // 只喂必要字段：名册不带姓名（validatePlan 用不到，能省一大截 token）
        const modelPayload = {
          week: wk,
          weekStart: ctx2.weekStart,
          sessions: ctx2.sessions,
          roster: ctx2.roster.map(r => ({
            seq: r.seq,
            group: r.group,
            dutyCountThisRound: r.dutyCountThisRound
          }))
        };
        const userMsg = [
          '【使用者要求】',
          text || '（没有特别要求，请按硬性规则给出最公平的排班）',
          '',
          '【本周上下文 JSON】',
          JSON.stringify(modelPayload),
          '',
          // DeepSeek 的 json_object 模式要求对话里必须出现 "json" 字样，
          // 使用者可能把提示词改得没有这个词，这里兜一句，避免 400。
          '请只回复符合上述结构的 JSON，不要输出任何其他文字。'
        ].join('\n');

        const r = await callAi([
          { role: 'system', content: prompt },
          { role: 'user', content: userMsg }
        ], undefined, await resolveAiCfg(pool, ctx));

        let raw;
        try { raw = parseJsonLoose(r.content); } catch (e) {
          throw new BizError(40010, 'AI 返回的不是合法 JSON，请重试或把描述写得更明确');
        }
        const v = validatePlan(ctx2, raw);
        // 保洁不进 AI 上下文（避免模型把它当普通课次调动），但预览里必须能看到它，
        // 否则用户会以为「没有安排打扫 410」。这里 dryRun 复算一次应用后的保洁结果。
        const cleaningRows = await previewCleaning(pool, wk, ctx2, v);
        console.log(JSON.stringify({
          fn: 'schedule', action: 'aiPlan', week: wk, ms: Date.now() - t0,
          sessions: ctx2.sessions.length, kept: v.plan.filter(p => p.kept).length,
          skip: v.skipSeqs.length, tokens: (r.usage && r.usage.total_tokens) || 0,
          warnings: v.warnings.length, cleaning: cleaningRows.length
        }));
        return {
          plan: v.plan,
          cleaningPlan: cleaningRows,
          warnings: v.warnings,
          notes: v.notes,
          skipSeqs: v.skipSeqs,
          promptUsed: prompt,
          model: AI_MODEL,
          usage: r.usage
        };
      } catch (e) {
        if (e && e.errCode) {
          console.error('[schedule] aiPlan biz fail', e.errCode, e.errMsg);
          throw e;
        }
        // 关键：把真实原因带出去，别让前端只看到「服务开小差了」
        const msg = String((e && e.message) || e).slice(0, 200);
        console.error('[schedule] aiPlan unhandled after ' + (Date.now() - t0) + 'ms', msg, (e && e.stack) || '');
        throw new BizError(40011, 'AI 排班失败：' + msg);
      }
    }
  },

  /** 把 AI（或手工编辑过）的计划落库：替换本周全部自动排班，保留手动值日 */
  aiApply: {
    auth: { scheduleAuth: true },
    handler: async (payload, ctx) => {
      const wk = Number(payload.week);
      if (!wk) throw new BizError(41001, '参数错误');
      const incoming = Array.isArray(payload.plan) ? payload.plan : [];
      if (!incoming.length) throw new BizError(41001, '没有可应用的排班');
      try {
        const pool = getPool();
        const classId = guard.classIdOf(ctx);
        const built = await buildAiContext(pool, wk, classId);
        // 服务端二次校验：客户端传来的序号必须重新过一遍硬规则
        const v = validatePlan(built, {
          assignments: incoming.map(p => ({ sessionId: p.sessionId, memberSeqs: p.memberSeqs || [] })),
          // 「保持原样」由服务端重新判定（客户端传的 kept 标志不可信）
          unchanged: Array.isArray(payload.unchanged)
            ? payload.unchanged
            : incoming.filter(p => p.kept).map(p => p.sessionId),
          skipSeqs: Array.isArray(payload.skipSeqs) ? payload.skipSeqs : [],
          notes: ''
        });
        const created = await writePlan(pool, wk, built, v.plan, v.skipSeqs, ctx.member.id);
        // 保洁不在 AI 计划里，但共用同一轮转池 —— 落完 AI 计划后把本周保洁补齐。
        // 起点跟着 AI 计划：只有计划真正开始排的那天 / 节次之后的保洁才补，
        // 否则会与「从周四第二节开始排」这类要求自相矛盾。
        const startFrom = planStartBoundary(v.plan);
        const cleanCreated = await fillCleaningByRotation(pool, wk, ctx.member.id, startFrom, classId);
        const resetPublish = await toDraftIfPublished(pool, wk, classId);
        console.log(JSON.stringify({
          fn: 'schedule', action: 'aiApply', member: ctx.member.id, week: wk,
          created, cleanCreated, kept: v.plan.filter(p => p.kept).length, resetPublish
        }));
        return { created: created + cleanCreated, warnings: v.warnings, resetPublish };
      } catch (e) {
        if (e && e.errCode) throw e;
        const msg = String((e && e.message) || e).slice(0, 200);
        console.error('[schedule] aiApply unhandled', msg, (e && e.stack) || '');
        throw new BizError(40012, '写入值日表失败：' + msg);
      }
    }
  },

  /**
   * AI 智能调课（只算不写库）。
   * payload: { week, text, prompt? }
   * 返回「操作清单 + 预览 + 告警」，由前端确认后调 course.shiftSet 落库。
   *
   * 为什么放在 schedule 而不是 course：DeepSeek 的调用链（ai-proxy 出口、
   * 超时预算、密钥）都在这边，搬过去要复制一整套。这里只产出计划，不碰数据。
   */
  aiShiftPlan: {
    auth: { scheduleAuth: true },
    handler: async (payload, ctx) => {
      const wk = Number(payload.week);
      if (!wk) throw new BizError(41001, '参数错误');
      const text = String(payload.text || '').trim().slice(0, 600);
      if (!text) throw new BizError(41001, '请先说说要怎么调课');
      const t0 = Date.now();
      try {
        if (typeof week.resolveSlot !== 'function') {
          throw new BizError(40008, '部署包里的 common/week.js 缺少 resolveSlot，请重新执行 sync-common 并部署 schedule');
        }
        const pool = getPool();
        const ctx2 = await buildShiftContext(pool, wk, guard.classIdOf(ctx));
        if (!ctx2.sessions.length) throw new BizError(41002, '这一周没有课次（可能整周放假）');

        const prompt = String(payload.prompt || '').trim() || DEFAULT_SHIFT_PROMPT;
        const modelPayload = {
          week: wk,
          weekStart: week.weekStart(ctx2.cfg.termStart, wk),
          sessions: ctx2.sessions.map(s => ({
            sessionId: s.sessionId,
            dayText: s.dayText,
            dayOfWeek: s.dayOfWeek,
            period: s.period,
            course: s.course,
            room: s.room,
            groupScope: s.groupScope,
            date: s.date,
            off: s.off
          }))
        };
        const userMsg = [
          '【使用者要求】',
          text,
          '',
          '【本周课次 JSON】',
          JSON.stringify(modelPayload),
          '',
          '请只回复符合上述结构的 JSON，不要输出任何其他文字。'
        ].join('\n');

        const r = await callAi([
          { role: 'system', content: prompt },
          { role: 'user', content: userMsg }
        ], 45000, await resolveAiCfg(pool, ctx));

        let raw;
        try { raw = parseJsonLoose(r.content); } catch (e) {
          throw new BizError(40010, 'AI 返回的不是合法 JSON，请把要求写得更明确后重试');
        }
        const v = validateShiftPlan(ctx2, raw);
        console.log(JSON.stringify({
          fn: 'schedule', action: 'aiShiftPlan', week: wk, ms: Date.now() - t0,
          sessions: ctx2.sessions.length, ops: v.operations.length,
          items: v.preview.length, tokens: (r.usage && r.usage.total_tokens) || 0
        }));
        return {
          week: wk,
          operations: v.operations,
          preview: v.preview,
          warnings: v.warnings,
          notes: v.notes,
          promptUsed: prompt,
          model: AI_MODEL,
          usage: r.usage
        };
      } catch (e) {
        if (e && e.errCode) {
          console.error('[schedule] aiShiftPlan biz fail', e.errCode, e.errMsg);
          throw e;
        }
        const msg = String((e && e.message) || e).slice(0, 200);
        console.error('[schedule] aiShiftPlan unhandled after ' + (Date.now() - t0) + 'ms', msg, (e && e.stack) || '');
        throw new BizError(40013, 'AI 调课失败：' + msg);
      }
    }
  },

  /** 返回「临时调课」的默认提示词（供客户端展示 / 编辑） */
  aiShiftPrompt: {
    auth: { scheduleAuth: true },
    handler: async () => ({
      prompt: DEFAULT_SHIFT_PROMPT,
      hasKey: aiAvailable(),
      model: AI_MODEL,
      route: AI_PROXY ? ('proxy:' + AI_PROXY) : 'direct'
    })
  },

  /**
   * 手动换人（超级管理员）：**直接替换，不提交申请、不需要对方确认**。
   * **原地替换** —— 直接改这条 duty 的 member_id，不新建行、也不把原行标成 SWAPPED_OUT，
   * 一个课次永远只有一条值日记录。同时写一条 duty_reassign 记录（保留操作留痕），
   * 供「换错了能一键还原」（见下面的 reassignUndo）。
   */
  reassign: {
    auth: { scheduleAuth: true },
    handler: async (payload, ctx) => {
      const dutyId = Number(payload.dutyId);
      const toMemberId = Number(payload.toMemberId);
      const pool = getPool();
      const classId = guard.classIdOf(ctx);
      const [duties] = await pool.query(
        `SELECT d.*, s.group_scope, s.id AS sid FROM duty d JOIN session s ON s.id = d.session_id WHERE d.id = ? AND d.class_id = ?`, [dutyId, classId]
      );
      const duty = duties[0];
      if (!duty) throw new BizError(41001, '值日不存在');
      if (!['PENDING', 'ONGOING', 'EXPIRED'].includes(duty.status)) throw new BizError(41001, '该值日当前不可换人');
      const [targets] = await pool.query('SELECT * FROM member WHERE id = ? AND class_id = ?', [toMemberId, classId]);
      const target = targets[0];
      // 测试账号（status=LEAVE）也允许当替补 —— 需求④：登进测试账号验证换班通知链路
      if (!target || (target.status !== 'ACTIVE' && !isTestNo(target.student_no))) throw new BizError(41001, '替补不可用');
      if (duty.group_scope && target.group_tag !== duty.group_scope) throw new BizError(41001, '替补与该课次分组不符');
      const classDate = String(duty.class_date).slice(0, 10);
      const [busy] = await pool.query(
        "SELECT id FROM duty WHERE class_id = ? AND class_date = ? AND member_id = ? AND status != 'SWAPPED_OUT'", [classId, classDate, toMemberId]
      );
      if (busy.length) throw new BizError(41001, '该同学当天已有值日');
      const [leaves] = await pool.query(
        "SELECT id FROM leave_request WHERE class_id = ? AND member_id = ? AND status = 'APPROVED' AND start_date <= ? AND end_date >= ?",
        [classId, toMemberId, classDate, classDate]
      );
      if (leaves.length) throw new BizError(41001, '该同学当天已请假');

      /**
       * **原地换人**：直接改这条值日的 member_id —— 不新建行、也不把原行标成 SWAPPED_OUT。
       * 旧做法是「原行 → SWAPPED_OUT + 插一条 MANUAL」，同一个课次会同时出现
       * 「旧人（标记换班）」和「新人」两条记录，看起来像是排重了（用户 2026-09-25 反馈要求合并成一条）。
       * 原地改的好处：duty.id 不变 → 值日详情、duty_log 操作记录、导出全部不断链，
       * 一个课次永远只有一条值日记录，换过几次人都只是一条。
       */
      try {
        await pool.query(
          "UPDATE duty SET member_id = ?, source = 'MANUAL', status = 'PENDING', done_at = NULL WHERE id = ?",
          [toMemberId, dutyId]
        );
      } catch (e) {
        // 撞 uq_duty(session_id, week, member_id)：该同学本周在这个课次已经有一条值日了
        throw new BizError(41001, '该同学本周已有此课次值日');
      }
      await pool.query('UPDATE member SET duty_count = duty_count + 1, last_duty_at = ? WHERE id = ?', [classDate, toMemberId]);
      await pool.query('UPDATE member SET duty_count = GREATEST(duty_count - 1, 0) WHERE id = ?', [duty.member_id]);
      await pool.query(
        'INSERT INTO duty_log (duty_id, operator_id, action, from_member, to_member) VALUES (?,?,?,?,?)',
        [dutyId, ctx.member.id, 'SWAP', duty.member_id, toMemberId]
      );
      // 记录本次换人（供还原）。new_duty_id 与 duty_id 相同 —— 原地替换后只有这一条。
      const [rec] = await pool.query(
        `INSERT INTO duty_reassign (duty_id, new_duty_id, session_id, week, from_member, to_member, operator_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [dutyId, dutyId, duty.session_id, duty.week, duty.member_id, toMemberId, ctx.member.id]
      );
      return { reassignId: rec.insertId, dutyId };
    }
  },

  /**
   * 还原换人（超级管理员）：把 reassign 的结果原样回滚 —— 人换回被换下的那位。
   * 原地替换后「还原」就是再一次原地改人，不涉及增删行。
   * 幂等：同一记录只能还原一次（undone 标记），重复点击返回明确错误。
   */
  reassignUndo: {
    auth: { scheduleAuth: true },
    handler: async (payload, ctx) => {
      const reassignId = Number(payload.reassignId);
      const dutyId = Number(payload.dutyId);   // 允许「从这条值日反查最近一次未还原的换人」
      if (!reassignId && !dutyId) throw new BizError(41001, '参数错误');
      const pool = getPool();
      const sql = reassignId
        ? 'SELECT * FROM duty_reassign WHERE id = ? LIMIT 1'
        : 'SELECT * FROM duty_reassign WHERE duty_id = ? AND undone = 0 ORDER BY id DESC LIMIT 1';
      const [rows] = await pool.query(sql, [reassignId || dutyId]);
      const rec = rows[0];
      if (!rec) throw new BizError(41001, '没有可还原的换人记录');
      if (rec.undone) throw new BizError(41001, '这次换人已经还原过了');

      const [cur] = await pool.query('SELECT * FROM duty WHERE id = ?', [rec.duty_id]);
      const duty = cur[0];
      if (!duty) throw new BizError(41001, '该值日已被删除，无法还原');
      // 只有当前确实还是「换上来的那个人」才允许还原，否则会覆盖掉之后的操作
      if (duty.member_id !== rec.to_member) throw new BizError(41001, '这条值日后来又被改过，无法还原这次换人');

      try {
        await pool.query(
          "UPDATE duty SET member_id = ?, status = 'PENDING', done_at = NULL WHERE id = ?",
          [rec.from_member, rec.duty_id]
        );
      } catch (e) {
        throw new BizError(41001, '被换下的同学本周已有此课次值日，无法还原');
      }
      // 次数回滚：换上来的人 -1，被换下的人 +1
      await pool.query('UPDATE member SET duty_count = GREATEST(duty_count - 1, 0) WHERE id = ?', [rec.to_member]);
      await pool.query('UPDATE member SET duty_count = duty_count + 1 WHERE id = ?', [rec.from_member]);
      await pool.query(
        'INSERT INTO duty_log (duty_id, operator_id, action, from_member, to_member) VALUES (?,?,?,?,?)',
        [rec.duty_id, ctx.member.id, 'UNDO', rec.to_member, rec.from_member]
      );
      await pool.query('UPDATE duty_reassign SET undone = 1, undone_at = ? WHERE id = ?', [week.nowStamp(), rec.id]);
      return { dutyId: rec.duty_id, restoredMemberId: rec.from_member };
    }
  },

  /**
   * 空槽手动添加（超级管理员）：把某成员安排到某节课值日。
   * 与 reassign 共用同一套硬规则——分组课只在对应组内、同一天不重复、请假不排，
   * 否则手动排班就成了绕过规则的漏洞（自动生成与 AI 排班都会遵守这些规则）。
   */
  addManual: {
    auth: { scheduleAuth: true },
    handler: async (payload, ctx) => {
      const sessionId = Number(payload.sessionId);
      const wk = Number(payload.week);
      const memberId = Number(payload.memberId);
      if (!sessionId || !wk || !memberId) throw new BizError(41001, '参数错误');
      const pool = getPool();
      const classId = guard.classIdOf(ctx);
      const cfg = await week.getConfig(pool, classId);
      const cal = await week.loadCalendar(pool);
      const [sessions] = await pool.query('SELECT * FROM session WHERE id = ? AND class_id = ?', [sessionId, classId]);
      const s = sessions[0];
      if (!s) throw new BizError(41001, '课次不存在');

      const [targets] = await pool.query('SELECT * FROM member WHERE id = ? AND class_id = ?', [memberId, classId]);
      const target = targets[0];
      // 测试账号（status=LEAVE）也允许被手动安排 —— 需求④：排进课次后再登进去发起换班
      if (!target || (target.status !== 'ACTIVE' && !isTestNo(target.student_no))) throw new BizError(41001, '该同学当前不可安排');
      if (s.group_scope && target.group_tag !== s.group_scope) {
        throw new BizError(41001, '此课次是 ' + s.group_scope + ' 组的分组课，只能安排 ' + s.group_scope + ' 组同学');
      }

      // 与 generate 一致：临时调课优先，然后才是放假跳过 / 按天调课
      const shifts = await week.loadSessionShifts(pool);
      const slot = week.resolveSlot(s.id, s.day_of_week, s.period, wk, shifts);
      if (!slot) throw new BizError(41001, '该课次本周已临时取消，不需要安排值日');
      const classDate = week.classDateOf(cfg, wk, slot.day, cal);
      if (!classDate) throw new BizError(41001, '该日放假不上课，无需安排值日');

      const [existing] = await pool.query(
        'SELECT id, status FROM duty WHERE class_id = ? AND session_id = ? AND week = ? AND member_id = ? LIMIT 1',
        [classId, sessionId, wk, memberId]
      );
      if (existing.length && existing[0].status !== 'SWAPPED_OUT') {
        throw new BizError(41001, '该同学本周已在此课次值日');
      }

      const [busy] = await pool.query(
        "SELECT id FROM duty WHERE class_id = ? AND class_date = ? AND member_id = ? AND status != 'SWAPPED_OUT'",
        [classId, classDate, memberId]
      );
      if (busy.length) throw new BizError(41001, '该同学当天已有其他值日，同一天不能重复安排');

      const [leaves] = await pool.query(
        "SELECT id FROM leave_request WHERE class_id = ? AND member_id = ? AND status = 'APPROVED' AND start_date <= ? AND end_date >= ?",
        [classId, memberId, classDate, classDate]
      );
      if (leaves.length) throw new BizError(41001, '该同学当天已请假');

      let dutyId;
      if (existing.length) {
        // 曾被换出过：直接恢复这一条，避免撞 (session, week, member) 唯一键
        await pool.query("UPDATE duty SET status = 'PENDING', source = 'MANUAL', class_date = ? WHERE id = ?", [classDate, existing[0].id]);
        dutyId = existing[0].id;
      } else {
        const [ins] = await pool.query(
          `INSERT INTO duty (class_id, session_id, week, class_date, member_id, status, source)
           VALUES (?, ?, ?, ?, ?, 'PENDING', 'MANUAL')`, [classId, sessionId, wk, classDate, memberId]
        );
        dutyId = ins.insertId;
      }
      await pool.query(
        'INSERT INTO duty_log (duty_id, operator_id, action, to_member) VALUES (?,?,?,?)',
        [dutyId, ctx.member.id, 'CREATE', memberId]
      );
      // 手动加人也算「本轮已排」，避免后续自动生成时被重复安排
      await pool.query('UPDATE member SET duty_count = duty_count + 1, last_duty_at = ? WHERE id = ?', [classDate, memberId]);
      return {};
    }
  },

  /** 取消值日 */
  remove: {
    auth: { scheduleAuth: true },
    handler: async (payload, ctx) => {
      const dutyId = Number(payload.dutyId);
      const pool = getPool();
      const classId = guard.classIdOf(ctx);
      const [rows] = await pool.query('SELECT * FROM duty WHERE id = ? AND class_id = ?', [dutyId, classId]);
      if (!rows.length) throw new BizError(41001, '值日不存在');
      // v0.7.25：删除前先作废引用该值日的待确认申请（§73）
      await pool.query(
        `UPDATE swap_request SET status = 'CANCELLED'
          WHERE status IN ('PENDING_PEER','PENDING_ADMIN') AND duty_id = ?`,
        [dutyId]
      );
      await pool.query('DELETE FROM duty WHERE id = ? AND class_id = ?', [dutyId, classId]);
      await pool.query(
        'INSERT INTO duty_log (duty_id, operator_id, action, from_member) VALUES (?,?,?,?)',
        [dutyId, ctx.member.id, 'CANCEL', rows[0].member_id]
      );
      /*
       * v0.7.16（需求③「取消值日生」）：移除值日要回滚该成员的轮转标记 duty_count（-1），
       * 否则这一轮轮转池会「少排一个人」却被记成已排过。duty_count 只在 0 以上才减。
       *
       * ⚠️ v0.7.26 修正：旧版写成 `if (rows[0].source === 'AUTO')`，与写入侧不对称：
       *   · `addManual`（手动加人）**无条件** `duty_count + 1`（注释原话「手动加人也算本轮已排」）；
       *   · `reassign`（换人）把该行 source 改成 'MANUAL'，并给换上的人 `+1`。
       *   于是「手动加人 → 取消」这条再普通不过的操作，每次都会让该成员游标**永久 +1**。
       *   2026-09-27 线上实锤（用户报「第 6 周为什么没有 1 号」）：
       *     1 号 宋艾霖 `duty_count` = 3，而 02~54 号是 2 → 按
       *     `(duty_count ASC, 序号 ASC)` 取人时被排到 56 人队列的**队尾**；
       *     第 6 周只有 48 个名额，取到 47 号就满了 → 1 号整周消失。
       *     旁证：1 号全班唯一有 3 条 CANCEL（CANCEL 只由本路由写出），
       *     且它的 `last_duty_at` 停在 2026-09-28（第 3 周周一）却没有任何第 3 周存活行 ——
       *     那正是「手动加进第 3 周某课次 → 又取消」留下的化石。
       *
       * 现行口径：**只要这一行占过轮转标记，删掉就回滚**。
       * 唯一例外是 status = 'SWAPPED_OUT' 的历史行 —— 它在换出时已经回滚过（见 reassign）。
       * 该不变量由 scripts/check-duty-marker-symmetry.js 守着（含变异自证）。
       */
      if (rows[0].status !== 'SWAPPED_OUT') {
        await pool.query(
          'UPDATE member SET duty_count = duty_count - 1 WHERE id = ? AND duty_count > 0',
          [rows[0].member_id]
        );
      }
      return {};
    }
  },

  /** 清空本周：删除全部值日（含手动）与对应日志，并回滚【本周】消耗的轮转标记。
   *  ⚠️ 只回滚本周涉及的人、每次减去本周占用数 —— 绝不能全班清零！
   *  2026-09-26 实测踩坑：旧实现 `UPDATE member SET duty_count = 0 WHERE class_id=?`
   *  把其它周已推进的轮转进度一起抹掉（清空第 1/2 周测试后，第 4 周生成从 1 号重排，
   *  而不是接续第 3 周的 49/50 号）。想要「整个轮转池归零」，把每一周都清空即可 ——
   *  每周各自回滚，合起来就是全量归零，不会误伤仍保留的周。 */
  clear: {
    auth: { scheduleAuth: true },
    handler: async (payload, ctx) => {
      const wk = Number(payload.week);
      if (!wk) throw new BizError(41001, '参数错误');
      const pool = getPool();
      const classId = guard.classIdOf(ctx);
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        // ① 先数清楚本周每个人占用了几个标记（AUTO + MANUAL 都算；SWAPPED_OUT 旧行不占）
        const [used] = await conn.query(
          "SELECT member_id, COUNT(*) AS n FROM duty WHERE class_id = ? AND week = ? AND status <> 'SWAPPED_OUT' GROUP BY member_id",
          [classId, wk]
        );
        // ② 再删日志与值日（此时 duty 行仍在，日志才能跟着删干净）
        // v0.7.25：清空整周值日前先作废引用这些值日的待确认申请（§73 —— 这正是「值日页清空值日表」路径，
        // 不处理会让申请悬空成幽灵，永远无法确认却一直计入提醒；与 generate / cron-weekly 同口径）
        await conn.query(
          `UPDATE swap_request SET status = 'CANCELLED'
            WHERE status IN ('PENDING_PEER','PENDING_ADMIN')
              AND duty_id IN (SELECT id FROM duty WHERE class_id = ? AND week = ?)`,
          [classId, wk]
        );
        await conn.query('DELETE FROM duty_log WHERE duty_id IN (SELECT id FROM duty WHERE class_id = ? AND week = ?)', [classId, wk]);
        await conn.query('DELETE FROM duty WHERE class_id = ? AND week = ?', [classId, wk]);
        // ③ 逐人回滚：duty_count 减去本周占用数（跨周进度保留）；
        //    last_duty_at 重算为「剩余值日里最近的一次」，没有剩余则为 NULL（TDSQL 一次一条）
        for (const r of used) {
          const mid = Number(r.member_id);
          await conn.query('UPDATE member SET duty_count = GREATEST(duty_count - ?, 0) WHERE id = ?', [Number(r.n) || 0, mid]);
          await conn.query(
            'UPDATE member SET last_duty_at = (SELECT MAX(d.class_date) FROM duty d WHERE d.member_id = ?) WHERE id = ?',
            [mid, mid]
          );
        }
        await conn.commit();
        console.log(JSON.stringify({ fn: 'schedule', action: 'clear', member: ctx.member.id, classId, week: wk, affected: used.length }));
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
      return {};
    }
  },

  /** 发布草稿给全班 */
  publish: {
    auth: { scheduleAuth: true },
    handler: async (payload, ctx) => {
      const wk = Number(payload.week);
      const pool = getPool();
      const classId = guard.classIdOf(ctx);
      const [count] = await pool.query('SELECT COUNT(*) AS n FROM duty WHERE class_id = ? AND week = ?', [classId, wk]);
      if (!count[0].n) throw new BizError(41001, '本周还没有排班，请先生成');
      await pool.query(
        `INSERT INTO schedule_publish (class_id, week, status, published_at, published_by) VALUES (?, ?, 'PUBLISHED', ?, ?)
         ON DUPLICATE KEY UPDATE status = 'PUBLISHED', published_at = VALUES(published_at), published_by = VALUES(published_by)`,
        [classId, wk, week.nowStamp(), ctx.member.id]
      );
      console.log(JSON.stringify({ fn: 'schedule', action: 'publish', member: ctx.member.id, classId, week: wk }));
      // 订阅消息：无模板 ID 时静默跳过（43101 静默）
      try {
        if (process.env.TEMPLATE_PUBLISH) {
          const cloud = require('wx-server-sdk');
          const [members] = await pool.query("SELECT openid FROM member WHERE class_id = ? AND status = 'ACTIVE' AND openid IS NOT NULL AND group_tag <> 'X' AND student_no NOT LIKE '2608057499%' LIMIT 60", [classId]);
          for (const m of members) {
            try {
              await cloud.openapi.subscribeMessage.send({
                touser: m.openid,
                templateId: process.env.TEMPLATE_PUBLISH,
                page: 'pages/duty/index',
                data: {}
              });
            } catch (e) { /* 43101 静默 */ }
          }
        }
      } catch (e) { console.error('[schedule] subscribe send skipped', e && e.errMsg); }
      return {};
    }
  },

  /**
   * 撤回发布（2026-10-05 需求：不限发布后时长）
   * 旧版曾限制「发布后 24h 内才能撤回」—— 实际场景里管理员常在发布后才发现排错、
   * 甚至先清空了值日表再想撤回（此时 24h 早过了），被 40008 卡死只能干瞪眼。
   * 现在只要还是 PUBLISHED 且不是历史周，随时可撤；撤回只把状态回 DRAFT，不动 duty 行。
   */
  unpublish: {
    auth: { scheduleAuth: true },
    handler: async (payload, ctx) => {
      const wk = Number(payload.week);
      const pool = getPool();
      const classId = guard.classIdOf(ctx);
      const cfg = await week.getConfig(pool, classId);
      const pub = await loadPublish(pool, wk, classId);
      if (!pub || pub.status !== 'PUBLISHED' || !pub.published_at) throw new BizError(40008, '本周未发布，无需撤回');
      // 24 小时限制已按需求移除；保留「历史周不可撤」—— 已开始的过去周是事实记录，撤了会破坏历史视图
      if (wk < week.currentWeek(cfg)) throw new BizError(40008, '本周已开始，不能撤回');
      await pool.query("UPDATE schedule_publish SET status = 'DRAFT', published_at = NULL WHERE class_id = ? AND week = ?", [classId, wk]);
      return {};
    }
  },

  getRules: {
    auth: { needAdmin: true },
    handler: async (payload, ctx) => loadRules(getPool(), guard.classIdOf(ctx))
  },

  setRules: {
    auth: { scheduleAuth: true },
    handler: async (payload, ctx) => {
      const pool = getPool();
      const classId = guard.classIdOf(ctx);
      const r = payload.rules || {};
      const b = v => (v === true || v === 1 || v === '1') ? 1 : 0;
      // 多班级：每班一行 schedule_rules（id 无业务含义，按 class_id 定位）
      await pool.query(
        `INSERT INTO schedule_rules (class_id, sort_by_count, avoid_same_day, avoid_back_to_back, cron_enabled, cron_weekday, cron_hour)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE sort_by_count=VALUES(sort_by_count), avoid_same_day=VALUES(avoid_same_day),
           avoid_back_to_back=VALUES(avoid_back_to_back), cron_enabled=VALUES(cron_enabled),
           cron_weekday=VALUES(cron_weekday), cron_hour=VALUES(cron_hour)`,
        [classId, b(r.sortByCount), b(r.avoidSameDay), b(r.avoidBackToBack), b(r.cronEnabled), Number(r.cronWeekday) || 0, Number(r.cronHour) || 20]
      );
      return loadRules(pool, classId);
    }
  },

  /* ---------------- AI 设置（需求 D：各班自带密钥） ----------------
   * 权限按**排班域**（超管 | 本班生活委员）：谁能排班，谁就该能配本班的 AI。
   * ⚠️ 密钥明文在库里只存一次，故**接口永不回传明文**（只回掩码）——
   *    前端保存时用「覆盖写入」语义，不需要也不应该拿到明文。
   */

  /** 读取**本人**的 AI 配置（密钥只回掩码） */
  aiSettingGet: {
    auth: { scheduleAuth: true },
    handler: async (payload, ctx) => {
      const s = await loadAiSetting(getPool(), ctx.member && ctx.member.id);
      return {
        configured: !!(s && s.api_key),
        enabled: !!(s && s.enabled),
        provider: (s && s.provider) || 'deepseek',
        baseUrl: (s && s.base_url) || '',
        model: (s && s.model) || '',
        keyMask: maskKey(s && s.api_key),
        updatedAt: (s && s.updated_at) || '',
        // 平台那一份密钥只能由超管借用，生活委员必须自带
        canFallback: !!guard.isSuper(ctx.member || ctx.realMember)
      };
    }
  },

  /**
   * 保存**本人**的 AI 配置。
   * 字段缺省 = **不改**（保留原值）；`clear: true` = 清空密钥与启用标记。
   * 地址在这里做一次快拦，ai-proxy 出口还会再做一次 DNS 级终拦。
   */
  aiSettingSave: {
    auth: { scheduleAuth: true },
    handler: async (payload, ctx) => {
      const pool = getPool();
      const me = ctx.member;
      const memberId = me && me.id;
      const cur = await loadAiSetting(pool, memberId);
      const str = (v, d) => (v === undefined || v === null ? d : String(v).trim());

      const baseUrl = str(payload.baseUrl, (cur && cur.base_url) || '');
      if (baseUrl) assertBaseUrlLite(baseUrl);
      const model = str(payload.model, (cur && cur.model) || '');
      const provider = str(payload.provider, (cur && cur.provider) || 'deepseek') || 'deepseek';

      let apiKey = (cur && cur.api_key) || '';
      if (payload.clear === true) apiKey = '';
      else if (payload.apiKey !== undefined && str(payload.apiKey, '')) apiKey = str(payload.apiKey, '');

      // 平台密钥仅超管可借用：没配自带密钥的生活委员保存时直接拦下
      if (!apiKey && !guard.isSuper(me)) {
        throw new BizError(40009, '请填写你自己的密钥；平台密钥仅超级管理员可用');
      }
      const enabled = payload.enabled === undefined ? (apiKey ? 1 : 0) : (payload.enabled ? 1 : 0);

      await pool.query(
        `INSERT INTO ai_setting (member_id, provider, base_url, api_key, model, enabled)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE provider = VALUES(provider), base_url = VALUES(base_url),
           api_key = VALUES(api_key), model = VALUES(model), enabled = VALUES(enabled)`,
        [memberId, provider, baseUrl, apiKey, model, enabled]
      );
      return { configured: !!apiKey, enabled: !!enabled, keyMask: maskKey(apiKey), baseUrl, model, provider };
    }
  },

  /** 连通性测试：用（待保存的）本班配置 ping 一次出口，不消耗额度 */
  aiSettingTest: {
    auth: { scheduleAuth: true },
    handler: async (payload, ctx) => {
      const pool = getPool();
      const s = await loadAiSetting(pool, ctx.member && ctx.member.id);
      const baseUrl = payload.baseUrl === undefined
        ? ((s && s.base_url) || '') : String(payload.baseUrl || '').trim();
      let apiKey = payload.apiKey === undefined
        ? ((s && s.api_key) || '') : String(payload.apiKey || '').trim();
      if (baseUrl) assertBaseUrlLite(baseUrl);
      if (!apiKey && !guard.isSuper(ctx.member || ctx.realMember)) {
        throw new BizError(40009, '请先填写你自己的密钥再测试；平台密钥仅超级管理员可用');
      }
      if (!AI_PROXY) throw new BizError(40009, '未配置 AI 出口函数（AI_PROXY）');
      const res = await cloud.callFunction({
        name: AI_PROXY,
        data: { action: 'ping', baseUrl, apiKey },
        timeout: 30000
      });
      const r = (res && res.result) || {};
      if (r.errCode !== 0) throw new BizError(r.errCode || 40010, r.errMsg || '连通性测试失败');
      return r.data || {};
    }
  },

  /**
   * 列出接口的可用模型（输入密钥后点「获取」调用）。
   * 走 ai-proxy 的 /models（OpenAI 兼容），只回模型 id 列表，**不消耗额度**。
   * 与 aiSettingTest 同理：用（待保存的）本班自带配置，未配密钥的非超管被拦下。
   */
  aiSettingModels: {
    auth: { scheduleAuth: true },
    handler: async (payload, ctx) => {
      const pool = getPool();
      const s = await loadAiSetting(pool, ctx.member && ctx.member.id);
      const baseUrl = payload.baseUrl === undefined
        ? ((s && s.base_url) || '') : String(payload.baseUrl || '').trim();
      let apiKey = payload.apiKey === undefined
        ? ((s && s.api_key) || '') : String(payload.apiKey || '').trim();
      if (baseUrl) assertBaseUrlLite(baseUrl);
      if (!apiKey && !guard.isSuper(ctx.member || ctx.realMember)) {
        throw new BizError(40009, '请先填写你自己的密钥再获取模型；平台密钥仅超级管理员可用');
      }
      if (!AI_PROXY) throw new BizError(40009, '未配置 AI 出口函数（AI_PROXY）');
      const res = await cloud.callFunction({
        name: AI_PROXY,
        data: { action: 'models', baseUrl, apiKey },
        timeout: 30000
      });
      const r = (res && res.result) || {};
      if (r.errCode !== 0) throw new BizError(r.errCode || 40010, r.errMsg || '获取模型列表失败');
      return r.data || {};
    }
  },

  /**
   * 清空**本人**的 AI 配置。
   * ⚠️ 密钥明文只存一次 → 清掉**不可逆**（没人能再读出来），需重新填写。
   * 所以只在这里（本人显式操作）清；**撤销「生活委员」职位不得级联清行**
   * （职位会被频繁调整，手滑一次就要人家重新申请密钥），
   * 仅当「成员被移出班级」时才由 member 侧清理。
   */
  aiSettingClear: {
    auth: { scheduleAuth: true },
    handler: async (payload, ctx) => {
      const pool = getPool();
      await pool.query('DELETE FROM ai_setting WHERE member_id = ?', [ctx.member && ctx.member.id]);
      return { configured: false, keyMask: '' };
    }
  }
};

/**
 * 需求 D：会调用外部大模型的 AI 路由集合。
 * 这批路由禁止在「切换测试账号」模拟态下调用 —— ai_setting 按**生效身份**读取，
 * 模拟态下会消耗被模拟者本人的 key 额度（操作还记在他名下）。非 AI 的排班路由
 * 不受此限。用集合而非逐路由打标记，便于门禁按名字断言。
 */
const AI_ACTIONS = new Set([
  'aiCheck', 'aiPrompt', 'aiPlan', 'aiApply', 'aiShiftPlan', 'aiShiftPrompt',
  // 连通性测试 / 列出模型都会真的打一次外部接口（用被模拟者的配置），
  // 模拟态下禁用，避免消耗被模拟者本人的额度与配置
  'aiSettingTest', 'aiSettingModels'
]);

exports.main = async (event) => {
  let action;
  let ctxMember = null; // 提到 catch 外层：未过鉴权就抛错时也能判定「能不能看诊断」
  try {
    action = event && event.action;
    const route = routes[action];
    if (!route) return fail(41001, '未知操作');
    const payload = (event && event.payload) || {};
    const ctx = await guard.getContext();
    ctxMember = ctx.member;
    if (route.auth && route.auth.needBind) guard.requireBind(ctx);
    if (route.auth && route.auth.needAdmin) guard.requireAdmin(ctx);
    if (route.auth && route.auth.needSuper) guard.requireSuper(ctx);
    // 排班域（需求 D）：超管（可跨班）/ 生活委员（仅本班，班级来自 classIdOf）
    if (route.auth && route.auth.scheduleAuth) guard.requireScheduleAuth(ctx);
    if (ctx.impersonated && AI_ACTIONS.has(action)) {
      throw new BizError(40003, '模拟态下不可调用 AI 排班，请先「恢复本人」');
    }
    const data = await route.handler(payload, ctx);
    return ok(data);
  } catch (e) {
    if (e && e.errCode) return fail(e.errCode, e.errMsg, e.data);
    console.error('[schedule] unhandled', action, e);
    /*
     * v0.7.22 需求①：未预期错误一律「服务器开小差了」会把真实根因藏起来——
     * 用户看到的只有一句无法行动的话（本次 50000 实测就是连接被静默断开）。
     * 只对**超级管理员**透出错误码 / 消息片段（generate / aiCheck 等路由本就 needSuper，
     * 普通成员看不到这些路由，不存在泄露面扩大），排障时不用再上控制台翻日志。
     */
    if (ctxMember && guard.isSuper(ctxMember)) {
      const detail = String((e && (e.code || e.errCode || e.message)) || e || 'unknown')
        .replace(/\s+/g, ' ').slice(0, 120);
      return fail(50000, '服务开小差了，请稍后重试（' + detail + '）');
    }
    return fail(50000, '服务开小差了，请稍后重试');
  }
};
