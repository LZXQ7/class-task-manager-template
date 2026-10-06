/**
 * 通用工具：日期 / 文本 / 颜色 / 交互
 */

const WEEKDAY_CN = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const WEEKDAY_SHORT = ['一', '二', '三', '四', '五', '六', '日'];

/** 'YYYY-MM-DD' → Date（东八区安全） */
function parseDate(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(str || ''));
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function pad(n) { return n < 10 ? '0' + n : String(n); }

function fmtDate(d) {
  if (!d) return '';
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/** 学期起始日 + 周次 + 星期(1-7) → 'YYYY-MM-DD' */
function dateOfWeekDay(termStart, week, weekday) {
  const base = parseDate(termStart);
  if (!base) return '';
  base.setDate(base.getDate() + (Number(week) - 1) * 7 + (Number(weekday) - 1));
  return fmtDate(base);
}

/** 当前是第几周（1-based），越界返回 0 */
function currentWeek(termStart, totalWeeks) {
  const base = parseDate(termStart);
  if (!base) return 0;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.floor((today - base) / 86400000);
  const w = Math.floor(diff / 7) + 1;
  if (w < 1) return 0;
  if (totalWeeks && w > Number(totalWeeks)) return Number(totalWeeks);
  return w;
}

/** 'YYYY-MM-DD' → 'M月D日' */
function md(str) {
  const d = parseDate(str);
  return d ? (d.getMonth() + 1) + '月' + d.getDate() + '日' : '';
}

function weekdayCn(idx) { return WEEKDAY_CN[idx - 1] || ''; }
function weekdayShort(idx) { return WEEKDAY_SHORT[idx - 1] || ''; }

/** 'YYYY-MM-DD' → 星期几（1=周一 … 7=周日） */
function weekdayOfNum(str) {
  const d = parseDate(str);
  if (!d) return 1;
  const w = d.getDay();
  return w === 0 ? 7 : w;
}

/** 今天星期几（1=周一） */
function todayWeekday() {
  const w = new Date().getDay();
  return w === 0 ? 7 : w;
}

/** 相对时间：'刚刚' / '5分钟前' / '3小时前' / '昨天 14:30' / '09-12' */
function fromNow(str) {
  if (!str) return '';
  const s = String(str).replace('T', ' ').slice(0, 19);
  const t = new Date(s.replace(/-/g, '/'));
  if (isNaN(t.getTime())) return String(str).slice(5, 10);
  const diff = (Date.now() - t.getTime()) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + '分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + '小时前';
  if (diff < 172800) return '昨天 ' + pad(t.getHours()) + ':' + pad(t.getMinutes());
  return (t.getMonth() + 1 < 10 ? '0' : '') + (t.getMonth() + 1) + '-' + pad(t.getDate());
}

/** 日期时间 → 'MM-DD HH:mm' */
function fmtDateTime(str) {
  if (!str) return '';
  const s = String(str).replace('T', ' ').slice(0, 16);
  return s.slice(5);
}

/* ---------------- 文本 ---------------- */
/**
 * 序号 = 学号后两位（转数字）。示例班级C学号形如 2026CC01…2026CC56，
 * 后两位 01→1 … 56→56。规则：1-9 显示个位、10-56 显示两位，且与后端
 * common/week.js 的 seqOf 完全一致（单一真相，别在前端另写一份）。
 */
function seqOf(studentNo) {
  const s = String(studentNo == null ? '' : studentNo).replace(/\D/g, '');
  if (!s) return 0;
  const n = parseInt(s.slice(-2), 10);
  return isNaN(n) ? 0 : n;
}

function firstChar(name) {
  const s = String(name || '').trim();
  return s ? s.slice(0, 1) : '?';
}

function maskNo(no) {
  const s = String(no || '');
  return s.length <= 4 ? '****' : s.slice(0, s.length - 4) + '****';
}

/* ---------------- 头像色板（按姓名首字母稳定取色，无照片/无 emoji） ---------------- */
const AVATAR_COLORS = [
  '#3370FF', '#00B42A', '#FF7D00', '#7C5CFF', '#0AA5A8',
  '#F53F3F', '#245BDB', '#D46B08', '#009A29', '#5E3BE8'
];
function avatarColor(seed) {
  const s = String(seed || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

/* ---------------- 值日状态 → 文案 / 配色 ----------------
 * 本工具只做值日提醒（不打卡），所以文案是「待值日 / 已结束」这类排期口径，
 * 而不是「待完成 / 待补录」这类待办口径。 */
const DUTY_STATUS = {
  PENDING: { text: '待值日', color: '#86909C', bg: '#F2F3F5' },
  ONGOING: { text: '进行中', color: '#3370FF', bg: '#F0F5FF' },
  DONE: { text: '已值日', color: '#00B42A', bg: '#E8FFEA' },
  LEAVE: { text: '已请假', color: '#FF7D00', bg: '#FFF7E8' },
  SWAPPED_OUT: { text: '已换出', color: '#7C5CFF', bg: '#F3F0FF' },
  SWAPPED: { text: '已换出', color: '#7C5CFF', bg: '#F3F0FF' },
  EXPIRED: { text: '已结束', color: '#86909C', bg: '#F2F3F5' }
};
function dutyStatus(key) {
  return DUTY_STATUS[key] || DUTY_STATUS.PENDING;
}

/* ---------------- 课次时间文案 ----------------
 * 保洁课次（session.kind = 'CLEAN'，共 5 条：周一~周五各一条）挂在第 4 节上只是为了
 * 有个排班位；对外一律说「18点前」。学生看到「第 4 节打扫 410」会以为是去上课。
 * 唯一来源：所有页面/导出都调这里，别在 WXML 或各页里各写一份，否则改一处漏一处。
 */
const CLEAN_WHEN = '18点前';
function whenText(kind, period) {
  return kind === 'CLEAN' ? CLEAN_WHEN : ('第' + period + '节');
}

/* ---------------- 课程配色 S1–S5 ---------------- */
const COURSE_COLORS = [
  { bg: '#D6E0FF', fg: '#245BDB' },
  { bg: '#E6F7EE', fg: '#009A29' },
  { bg: '#FFF3E8', fg: '#D46B08' },
  { bg: '#F3F0FF', fg: '#5E3BE8' },
  { bg: '#E6F7F7', fg: '#0AA5A8' }
];
function courseColor(idx) {
  return COURSE_COLORS[(Number(idx) || 0) % COURSE_COLORS.length];
}

/* ---------------- 交互 ---------------- */
function toast(title, duration) {
  wx.showToast({ title: String(title).slice(0, 28), icon: 'none', duration: duration || 1800 });
}

/** 二次确认弹窗 */
function confirm(content, title) {
  return new Promise((resolve) => {
    wx.showModal({
      title: title || '提示',
      content: content,
      confirmColor: '#3370FF',
      success: (r) => resolve(!!r.confirm),
      fail: () => resolve(false)
    });
  });
}

/**
 * 二次确认（三态版）：confirm / cancel / fail。
 * ------------------------------------------------------------
 * 为什么需要它（2026-09-26 用户反馈「点『按序号轮转』没有任何反应」）：
 * 上面那个 `confirm()` 把「用户点了取消」和「弹窗根本没弹出来」压成了同一个
 * `false`，调用方一律 `if (!ok) return;` —— 于是弹窗失败（有别的弹层占着、
 * 系统弹窗配额用满、页面正在转场等）在界面上表现得和「点了没反应」一模一样，
 * 既不报错也没提示，排查时完全无从下手。
 * 这个版本把"没弹出来"单独回传，调用方必须给用户一句话。
 *
 * @returns {Promise<'confirm'|'cancel'|'fail'>}
 */
function confirmStrict(content, title) {
  return new Promise((resolve) => {
    wx.showModal({
      title: title || '提示',
      content: content,
      confirmColor: '#3370FF',
      success: (r) => resolve(r && r.confirm ? 'confirm' : 'cancel'),
      fail: () => resolve('fail')
    });
  });
}

/** 节流点击 */
let lastTap = 0;
function throttleTap(fn, gap) {
  return function (e) {
    const now = Date.now();
    if (now - lastTap < (gap || 500)) return;
    lastTap = now;
    fn && fn.call(this, e);
  };
}

/** 秒 → '0:05' */
function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m + ':' + (r < 10 ? '0' + r : String(r));
}

/** 生成随机云存储路径 */
function randPath(prefix, ext) {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return prefix + '/' + t + r + '.' + (ext || 'png');
}

/**
 * 班委职位（唯一取值集合，2026-09-26 需求②「设置班委」）。
 * ⚠️ 必须与云函数 `cloudfunctions/member/index.js` 的 `POSITIONS` 逐字一致 ——
 *    由门禁 `scripts/check-positions-sync.js` 强制比对。
 * 全前端只此一份：通知「按职位」预设（pages/home）与人员详情「设置班委」（pages/roster）
 * 都从这里取，避免两处各写一遍导致漂移。
 */
const POSITIONS = [
  '班长兼团支书', '副班长', '学习委员', '生活委员',
  '组织宣传委员', '文体委员', '心理委员'
];

/**
 * 「授权职位」（需求 D，2026-09-27）：担任这两个职位即获得**能力**，不只是头衔。
 *   · 生活委员（班长亦可）        → 排班域：生成 / 发布 / 调整值日表、处理换班申请
 *   · 班长兼团支书                → 名册录入域：添加 / 导入 / 调组（增改，不含移出与撤回）
 * ⚠️ 必须与云函数 `common/guard.js` 的 `POSITION_DUTY_ADMIN` / `POSITION_MONITOR` 逐字一致。
 * 前端只用它做**置灰**（授予权仅超管）——是否真的有权一律以后端 guard 判定为准。
 */
const GRANTED_POSITIONS = ['生活委员', '班长兼团支书'];

/**
 * 职位头衔分层（超管 / 班委 / 辅导员，三类颜色明显区分）。
 * 入参 m：{ isSuper, groupTag, role, position }（来自 memberList / 登录 profile）。
 * 返回 { text, tier } 或 null（普通成员不展示头衔）。
 *   tier=super     超管（金色）—— 最高权限：解绑账号、安排值日
 *   tier=counselor 辅导员（青色）—— groupTag='X' 的教职工，负责发布但不进轮转
 *   tier=committee 班委（蓝色）—— role=ADMIN 且非超管、非辅导员，展示所在职位头衔
 * 宋艾霖（id=13）既是超管又是生活委员：以超管身份优先，展示金色「超管」。
 */
function roleTag(m) {
  if (!m) return null;
  if (m.isSuper) return { text: '超管', tier: 'super' };
  if (m.groupTag === 'X') return { text: m.position || '辅导员', tier: 'counselor' };
  if (m.role === 'ADMIN' || m.role === 'MONITOR') return { text: m.position || '管理员', tier: 'committee' };
  return null;
}

/* ---------------- 班级统一排序（2026-10-04 需求） ----------------
 * 需求：全站班级列表按「示例专业A → 示例专业B → 示例专业C → 示例专业D → 示例专业E」排列。
 * 为什么不能靠后端：班级 id 序与此无关（id=1 是多班迁移时迁进来的 示例班级C），
 * staff_class 的 ORDER BY class_id 只能给出 id 序 —— 所以由前端统一排序。
 * 规则：① 专业优先级（小教/小学教育 → 英语 → 商务英语 → 其它）；
 *       ② 同组按班号数字（名称里第一个 4 位数）升序；
 *       ③ 再按名称字典序兜底。
 * ⚠️ 关键词必须「长词在前」：'商务英语' 包含 '英语'，先判 '英语' 会把商务英语误归组。
 * ⚠️ 班级名的字段名**两种都有**：`class.list` 返回 `name`，而 `leaveSummary` 辅导员分支返回
 *    的是 `className` —— 比较器必须两个都认，否则拿到 className 形状的数据时全部读成空串、
 *    排序静默变成空操作（2026-10-04 线上实踩：辅导员卡顺序没变就是这个原因）。
 * 唯一来源：所有渲染班级列表的页面（首页请假卡 / 查看班级 / 值日筛选 / 导入选班 / 发通知选班）
 * 都调 util.sortClasses，别在各页各写一份比较器。 */
const MAJOR_RULES = [
  ['商务英语', 2],
  ['小学教育', 0], ['小教', 0],
  ['英语', 1]
];
function classNameOf(c) {
  return String((c && (c.name || c.className)) || '');
}
function majorRank(name) {
  const n = String(name || '');
  for (let i = 0; i < MAJOR_RULES.length; i++) {
    if (n.indexOf(MAJOR_RULES[i][0]) >= 0) return MAJOR_RULES[i][1];
  }
  return 3;                                    // 未知专业排最后
}
function sortClasses(list) {
  return (list || []).slice().sort((a, b) => {
    const an = classNameOf(a);
    const bn = classNameOf(b);
    const ra = majorRank(an), rb = majorRank(bn);
    if (ra !== rb) return ra - rb;
    const ma = /(\d{4})/.exec(an), mb = /(\d{4})/.exec(bn);
    const na = ma ? Number(ma[1]) : Infinity, nb = mb ? Number(mb[1]) : Infinity;
    if (na !== nb) return na - nb;
    return an < bn ? -1 : (an > bn ? 1 : 0);
  });
}

module.exports = {
  WEEKDAY_CN, WEEKDAY_SHORT,
  parseDate, fmtDate, dateOfWeekDay, currentWeek, md, weekdayCn, weekdayShort, weekdayOfNum, todayWeekday,
  fromNow, fmtDateTime, fmtDuration,
  firstChar, maskNo, avatarColor, seqOf,
  dutyStatus, DUTY_STATUS, whenText, CLEAN_WHEN, courseColor, COURSE_COLORS,
  sortClasses, majorRank,
  toast, confirm, confirmStrict, throttleTap, randPath, pad, roleTag, POSITIONS, GRANTED_POSITIONS
};
