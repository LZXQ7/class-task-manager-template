/**
 * 鉴权中间件（开发文档 8.1 / 铁律 2 / 第 9 章）
 * - 取 getWXContext() 校验 openid / APPID
 * - 解析 member.openid 得 session，按 action 声明校验角色
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { getPool } = require('./db');
const { BizError } = require('./resp');

const ADMIN_ROLES = ['ADMIN', 'MONITOR'];

/**
 * 身份上下文：
 * - realMember  openid 真实绑定的成员（切换账号时也始终是本人，超管校验用这个）
 * - member      生效身份 —— 存在 impersonation 映射时被替换为目标测试账号（模拟视角）
 * - impersonated 是否处于「切换账号」模拟态
 * 每次多一条 impersonation 查询（该表最多几行，代价可忽略）。
 */
async function getContext() {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  if (!openid) throw new BizError(40001, '无法获取用户身份，请重新进入小程序');
  if (process.env.WX_APPID && wxContext.APPID && wxContext.APPID !== process.env.WX_APPID) {
    throw new BizError(40001, '调用来源校验失败');
  }
  const pool = getPool();
  const [rows] = await pool.query('SELECT * FROM member WHERE openid = ? LIMIT 1', [openid]);
  let real = rows[0] || null;
  let member = real;
  let impersonated = false;
  if (real) {
    const [imp] = await pool.query('SELECT member_id FROM impersonation WHERE openid = ? LIMIT 1', [openid]);
    if (imp.length && imp[0].member_id !== real.id) {
      const [r2] = await pool.query('SELECT * FROM member WHERE id = ? LIMIT 1', [imp[0].member_id]);
      if (r2.length) { member = r2[0]; impersonated = true; }
    }
  }
  return { openid, appid: wxContext.APPID || '', member, realMember: real, impersonated };
}

function requireBind(ctx) {
  if (!ctx.member) throw new BizError(40001, '未绑定班级');
  return ctx.member;
}

function requireAdmin(ctx) {
  const m = requireBind(ctx);
  if (!ADMIN_ROLES.includes(m.role)) throw new BizError(40003, '仅管理员可操作');
  return m;
}

function isAdmin(member) {
  return !!member && ADMIN_ROLES.includes(member.role);
}

/** 超级管理员：最高权限（解绑账号、安排值日表）。role=ADMIN 且 is_super=1 */
function isSuper(member) {
  return !!(member && member.role === 'ADMIN' && member.is_super === 1);
}

/** 仅超级管理员可操作；非超级管理员（含普通管理员）一律拒绝 */
function requireSuper(ctx) {
  const m = requireBind(ctx);
  if (!isSuper(m)) throw new BizError(40003, '仅超级管理员可操作');
  return m;
}

/* ---------------- 需求 D：权限下放（排班域 / 名册域） ----------------
 *
 * 授权字段是 member.position（白名单见 utils/util.js 的 POSITIONS，云函数侧
 * 由 member/index.js 的 POSITIONS 逐字对齐，有 check-positions-sync.js 守）。
 * position 原为纯展示字段，本批升格为授权依据 —— 因此它的**授予权必须比使用
 * 权更严**（否则辅导员任命一个生活委员就等于间接授予排班权），见 requirePositionGrant。
 *
 * 身份口径：必须同时满足 position 命中 **且** group_tag <> 'X' —— 教职工
 * （X 组）不是学生班委，不能靠改职位混进学生权限（setPosition 也拒绝改 X 组）。
 */

/** 职位常量：与 utils/util.js 的 POSITIONS 逐字一致，勿改字面 */
const POSITION_DUTY_ADMIN = '生活委员';
const POSITION_MONITOR = '班长兼团支书';
/** 副班长（2026-10-06 个人课表功能）：与班长同属「课表发布到全班」授权人 */
const POSITION_VICE_MONITOR = '副班长';

/** 生活委员（本班排班负责人）：position='生活委员' 且非教职工 */
function isDutyAdmin(member) {
  return !!member && member.group_tag !== 'X'
    && String(member.position || '') === POSITION_DUTY_ADMIN;
}

/** 班长（本班名册录入人）：position='班长兼团支书' 且非教职工 */
function isMonitor(member) {
  return !!member && member.group_tag !== 'X'
    && String(member.position || '') === POSITION_MONITOR;
}

/** 副班长：position='副班长' 且非教职工 */
function isViceMonitor(member) {
  return !!member && member.group_tag !== 'X'
    && String(member.position || '') === POSITION_VICE_MONITOR;
}

/**
 * 课表「发布到全班」守卫：超管 / 班长 / 副班长（**仅本班**）。
 *
 * 为什么不用 requireRosterEdit：那条是「名册增改不含删」，把辅导员也放进来；
 * 而发布课表会**覆盖全班 session**（影响所有人的课表与后续值日排班），
 * 授权面必须更窄 —— 辅导员与各委员都没有这个权限。
 */
function requireTimetablePublish(ctx) {
  const m = requireBind(ctx);
  if (isSuper(m) || isMonitor(m) || isViceMonitor(m)) return m;
  throw new BizError(40003, '仅超级管理员、班长或副班长可发布课表到全班');
}

/**
 * 排班域守卫：超管（可跨班）/ 生活委员（**仅本班**）。
 *
 * ⚠️ 本函数只判「能否进入该动作」，**不判班级** —— 班级隔离由各 handler 的
 *    `guard.classIdOf(ctx)` / `guard.resolveClassId(...)` 保证：
 *    非超管、非辅导员的 classIdOf 恒为本班且忽略传入的 classId（防伪造越权）。
 *    新增排班域路由时**必须**沿用这两个取班方式，不得直接采信 payload.classId。
 */
function requireScheduleAuth(ctx) {
  const m = requireBind(ctx);
  if (isSuper(m) || isDutyAdmin(m)) return m;
  throw new BizError(40003, '仅超级管理员或本班生活委员可操作');
}

/**
 * 名册录入守卫（**增改不含删**）：超管 / 辅导员（可跨班）/ 班长（仅本班）。
 *
 * 只覆盖「新增、导入、改姓名与分组」——删除成员、停用、设班委、解绑、
 * 教职工名册一律**不**走这里，仍由 requireSuper / requireSuperOrCounselor 把守。
 */
function requireRosterEdit(ctx) {
  const m = requireBind(ctx);
  if (isSuper(m) || isCounselor(m) || isMonitor(m)) return m;
  throw new BizError(40003, '仅超级管理员、辅导员或班长可操作');
}

/**
 * 授予 / 撤销「生活委员」「班长兼团支书」两个职位 → **仅超管**。
 *
 * 为什么单独一格：这两个职位是排班权与名册编辑权的授权来源，谁能任命就等于
 * 谁能发权限。原先 setPosition 由 requireSuperOrCounselor 把守 ⇒ 辅导员可
 * 自行任命，等于间接授予排班权，与「成员管理仍归超管」的产品口径冲突。
 * 其余 5 个职位（副班长 / 学习委员 / 组织宣传委员 / 文体委员 / 心理委员）
 * 不含授权语义，维持超管 + 辅导员。
 */
function requirePositionGrant(ctx) {
  const m = requireBind(ctx);
  if (isSuper(m)) return m;
  throw new BizError(40003, '该职位由超级管理员任命');
}

/** 该职位名是否带授权语义（需要超管授予） */
function isGrantedPosition(position) {
  const p = String(position || '').trim();
  return p === POSITION_DUTY_ADMIN || p === POSITION_MONITOR;
}

/**
 * 当前生效身份的班级 id（多班级隔离 §43）。
 * 生效身份未绑定 → 回退 1（存量数据 / 未绑定前不感知班级，与旧行为一致）。
 * ⚠️ 教职工（X 组，v0.7.16）：主班可为 0（不落任何单班），**绝不回退 1** ——
 *    回退 1 会让没绑班级的教职工越权看到 示例班级C；其可见范围走 staffClassIds()。
 */
function classIdOf(ctx) {
  const m = ctx && (ctx.member || ctx.realMember);
  if (m && m.group_tag === 'X') return Number(m.class_id) || 0;
  return Number(m && m.class_id) || 1;
}

/** 辅导员：group_tag = 'X'（教职工，不参与 A/B 轮转）。独立于 ADMIN/MEMBER 角色。 */
function isCounselor(member) {
  return !!member && member.group_tag === 'X';
}

/**
 * 教职工（X 组）可管理的班级 id 集合（v0.7.16 staff_class 多对多）。
 *   有映射行   → 映射集合（多班）；
 *   无映射行   → 回退主班 class_id（存量单班教职工兼容，如 id=72）；
 *   都没有     → 空集（什么都看不到，前端引导找超管绑定）。
 * 非教职工 → [本班]（保持原语义，调用方无需区分）。
 * @returns {Promise<number[]>}
 */
async function staffClassIds(pool, member) {
  const m = member || {};
  if (!m || m.group_tag !== 'X') return [Number(m && m.class_id) || 1];
  const [rows] = await pool.query(
    'SELECT class_id FROM staff_class WHERE staff_id = ? ORDER BY class_id',
    [Number(m.id) || 0]
  );
  const ids = rows.map(r => Number(r.class_id)).filter(Boolean);
  if (ids.length) return ids;
  const main = Number(m.class_id) || 0;
  return main ? [main] : [];
}

/**
 * 学生班委：role ∈ {ADMIN, MONITOR} **且非教职工**（group_tag <> 'X'）。
 *
 * ⚠️ 与 isAdmin 的区别（别混用）：`isAdmin` 只看 role —— 辅导员（group_tag='X'）
 *    也是 isAdmin；但「请假登记」是**学生班委**的职责，必须额外排除 X 组
 *    （口径与 check-committee.js 的「班委 = role ∈ {ADMIN,MONITOR} 且 group_tag<>'X' 且非测试」一致）。
 */
function isCommittee(member) {
  return !!member && member.group_tag !== 'X' && ADMIN_ROLES.includes(member.role);
}

/**
 * 班委守卫（2026-10-06 权限收敛）：超管 / 学生班委。
 * 用于「临时调课」「查看 A/B 组课表」等——普通成员无此权。
 * 口径与 isCommittee 完全一致（超管 role=ADMIN 已包含在班委内）。
 */
function requireCommittee(ctx) {
  const m = requireBind(ctx);
  if (isSuper(m) || isCommittee(m)) return m;
  throw new BizError(40003, '仅班委可操作');
}

/**
 * 请假登记守卫（2026-09-29 需求④）：超管 / 本班**学生班委**。
 *
 * 覆盖「替他人登记请假」与「撤销请假」两个动作。班级隔离仍由 handler 的
 * `guard.classIdOf(ctx)` 保证（非超管恒本班、忽略传入 classId）。
 */
function requireLeaveRegister(ctx) {
  const m = requireBind(ctx);
  if (isSuper(m) || isCommittee(m)) return m;
  throw new BizError(40003, '仅班委可登记请假');
}

/**
 * 请假**看板查看权**（2026-09-29 追加，需求①②）：超管 / 学生班委 / 教职工（含辅导员）。
 *
 * 与 `requireLeaveRegister` 的区别：**教职工只看不改** —— 辅导员不参与值日轮转，
 * 但要跨班掌握「哪个班今天有多少人请假、都是谁」，所以给他看板权而不给登记/撤销权。
 */
function requireLeaveView(ctx) {
  const m = requireBind(ctx);
  if (isSuper(m) || isCommittee(m) || isCounselor(m)) return m;
  throw new BizError(40003, '仅班委或辅导员可查看请假信息');
}

/**
 * 本次请求生效的班级（v0.7.16：教职工多班化的统一收口）。
 *   普通成员   → 恒本班（忽略传入的 classId，防伪造越权）；
 *   超管       → 可传任意**活动**班级；
 *   教职工     → 可传 classId，但必须在 staffClassIds 集合内；
 *   都不传     → 自己的 classIdOf。
 * 需要跨班**管理**（增删成员/排班）的旧路由继续用 member 本地的 targetClassId
 * （那里已按同一规则收紧）；本函数给「跨班**查看**」类路由用（listWeek / member.list…）。
 * @returns {Promise<number>}
 */
async function resolveClassId(pool, ctx, payload) {
  const me = (ctx && (ctx.member || ctx.realMember)) || {};
  const own = classIdOf(ctx);
  const req = Number(payload && payload.classId) || 0;
  if (!req || req === own) return own;
  if (isSuper(me)) {
    const [rows] = await pool.query('SELECT id FROM `class` WHERE id = ? AND is_active = 1 LIMIT 1', [req]);
    if (!rows.length) throw new BizError(40003, '班级不存在或已停用');
    return req;
  }
  if (isCounselor(me)) {
    const ids = await staffClassIds(pool, me);
    if (!ids.includes(req)) throw new BizError(40003, '该班级不在你的教职工绑定范围内');
    return req;
  }
  return own;
}

module.exports = { getContext, requireBind, requireAdmin, isAdmin, isSuper, requireSuper, classIdOf, isCounselor, staffClassIds, resolveClassId, ADMIN_ROLES, isDutyAdmin, isMonitor, isViceMonitor, requireTimetablePublish, requireScheduleAuth, requireRosterEdit, requirePositionGrant, isGrantedPosition, POSITION_DUTY_ADMIN, POSITION_MONITOR, POSITION_VICE_MONITOR, isCommittee, requireCommittee, requireLeaveRegister, requireLeaveView };
