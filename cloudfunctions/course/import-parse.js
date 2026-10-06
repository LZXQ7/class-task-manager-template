/**
 * 青果课表 .xlsx 解析器（零依赖，仅用 SheetJS 读文件）
 * ------------------------------------------------------------
 * 输入：.xlsx 文件 Buffer + 本班 totalWeeks
 * 输出：{ courses:[{name,teacher,room}], sessions:[{courseIndex,name,teacher,room,
 *          dayOfWeek,period,weeks,weekRule,groupScope,courseType,kind,dutyCount}],
 *        warnings:[string], meta }
 *
 * 字段映射（grill-me B3 决议）：
 *  · 列 → day_of_week(1..7)，按位置映射（表头星期列与正文星期列可能错开一列，
 *    故不依赖列号相等，而用「节次列右侧 7 列按序映射 星期一..星期日」）。
 *  · 节次 + [x-y] → period 大节：由小节区间算 [ceil(start/2), floor(end/2)]，
 *    跨大节拆多条（如 [1-4] → period 1,2）；缺区间则回退节次标签。
 *  · 周次一律展开成显式 CSV 写 weeks、week_rule='ALL'（matchesWeeks 在 weeks
 *    非空时忽略 week_rule，展开最无奇偶陷阱）；超界周次 clamp 到 totalWeeks 并警告。
 *  · 同(课程名+教师)去重为一门 course（教室可能随周次变化，按课次分别记录）。
 *  · group_scope=null / courseType='ALL' / kind='COURSE' / dutyCount=2（沿用 upsert 默认）。
 *
 * 结构兼容：节次标签(一..六)在 .xlsx 里是跨多行的合并单元格，展开后整块都是同一
 *  标签值。一个节次块内每 4 行 = 一层 [课程名, 教师, 周次区间, 教室]；青果常把
 *  「同一天叠两门课」用 8 行(rowspan=8)表示，故逐层(步长 4)抽取而非固定 4 行。
 */
/**
 * ⚠️ xlsx（SheetJS）**惰性加载**（2026-10-05）。
 * 原因：xlsx 是本仓最大的依赖（解压后数 MB）。原先在模块顶层 require，
 * 而 index.js 顶层又 import 本模块 ⇒ **任何 course 动作（含课表页日常的
 * listWeek，毫秒级）冷启动都要把整个 SheetJS 载进内存**：
 *   · 日常课表页冷启动明显变慢；
 *   · 导入时再叠加「冷启 + 载 xlsx + 下载 + 解析整表」，极易撞上
 *     函数 timeout，表现为前端「网络异常，请稍后重试」
 *     （传输层 errCode -1，不是业务错误码 —— 平台超时打断，压根没返回 result）。
 * 现在改成首次真正解析时才 require，日常路径零开销；
 * Node 会缓存模块，同一次冷启动内重复调用只载一次。
 */
let _xlsx = null;
function loadXLSX() {
  if (!_xlsx) _xlsx = require('xlsx');
  return _xlsx;
}

const WEEK_NAMES = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];
const WEEK_CHAR = '一二三四五六日';
const SECTION_LABELS = ['一', '二', '三', '四', '五', '六'];

/** 把合并单元格展开进二维网格（被合并覆盖的格填左上角值） */
function expandMerges(aoa, merges) {
  if (!merges || !merges.length) return aoa;
  const out = aoa.map(r => (r || []).slice());
  for (const m of merges) {
    const top = out[m.s.r] && out[m.s.r][m.s.c];
    for (let r = m.s.r; r <= m.e.r; r++) {
      if (!out[r]) out[r] = [];
      for (let c = m.s.c; c <= m.e.c; c++) {
        if (out[r][c] === undefined || out[r][c] === '') out[r][c] = top;
      }
    }
  }
  return out;
}

/** 解析周次单元格文本 → { weeks: 'CSV'|'', period: [start,end]|null } */
function parseWeekSpec(weekText, totalWeeks, warnings, ctx) {
  const txt = String(weekText || '').trim();
  let period = null;
  const pm = /\[(\d+)\s*-\s*(\d+)\]/.exec(txt);
  if (pm) {
    const a = parseInt(pm[1], 10), b = parseInt(pm[2], 10);
    if (a > 0 && b >= a) period = [a, b];
  }
  const parity = /单/.test(txt) ? 'ODD' : (/双/.test(txt) ? 'EVEN' : null);
  let wkPart = txt.replace(/\[[^\]]*\]/g, '').replace(/[单双]/g, '').trim();
  wkPart = wkPart.replace(/[[\]()（）]/g, '').trim();
  const weeks = [];
  if (wkPart) {
    for (const tk of wkPart.split(/[,\s]+/).filter(Boolean)) {
      const rng = /^(\d+)\s*-\s*(\d+)$/.exec(tk);
      if (rng) {
        let lo = parseInt(rng[1], 10), hi = parseInt(rng[2], 10);
        if (lo > hi) [lo, hi] = [hi, lo];
        for (let n = lo; n <= hi; n++) weeks.push(n);
      } else if (/^\d+$/.test(tk)) {
        weeks.push(parseInt(tk, 10));
      }
    }
  }
  if (parity) {
    const wantOdd = parity === 'ODD';
    const filtered = weeks.filter(n => (n % 2 === 1) === wantOdd);
    // 若原无周次列表（仅写了 单/双），则展开成全学期对应奇偶周
    if (!weeks.length) {
      for (let n = 1; n <= totalWeeks; n++) if ((n % 2 === 1) === wantOdd) filtered.push(n);
    }
    weeks.length = 0;
    weeks.push(...filtered);
  }
  let set = Array.from(new Set(weeks.map(Number))).filter(n => Number.isInteger(n) && n >= 1);
  const clamped = [];
  for (const n of set.sort((a, b) => a - b)) {
    if (n <= totalWeeks) clamped.push(n);
    else warnings.push(ctx + ' 周次 ' + n + ' 超出本学期(' + totalWeeks + '周)，已忽略');
  }
  return { weeks: clamped.length ? clamped.join(',') : '', period };
}

function parseTimetableXlsx(buffer, totalWeeks) {
  totalWeeks = Number(totalWeeks) || 16;
  const XLSX = loadXLSX();
  const wb = XLSX.read(buffer, { type: 'buffer', cellHTML: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
  const grid = expandMerges(raw, ws['!merges'] || [])
    .map(row => (row || []).map(c => String(c == null ? '' : c).trim()));

  const warnings = [];

  // ① 表头行：含 星期一..星期日
  let headerRow = -1;
  for (let r = 0; r < grid.length; r++) {
    if (WEEK_NAMES.every(d => grid[r].includes(d))) { headerRow = r; break; }
  }
  if (headerRow < 0) throw new Error('未识别到课表表头（缺少 星期一..星期日），请确认文件为青果导出的教学安排表');

  // ② 节次列：正文里含 一..五 标签最多的列（同一文件内通常固定）
  let sectionCol = -1, best = -1;
  const colCount = Math.max(...grid.map(r => r.length));
  for (let c = 1; c < colCount; c++) {
    let cnt = 0;
    for (let r = headerRow + 1; r < grid.length; r++) if (SECTION_LABELS.includes(grid[r][c])) cnt++;
    if (cnt > best) { best = cnt; sectionCol = c; }
  }
  if (sectionCol < 0) throw new Error('未识别到节次列');

  const maxCol = colCount - 1;

  // ③ 遍历每个节次块：连续相同标签的行 = 一个块（标签的 rowspan 展开后占满整块）。
  //    块内每 4 行 = 一层 [课程名, 教师, 周次区间, 教室]，逐层抽取以兼容「同列叠两门课」。
  const courses = [];
  const courseMap = new Map();
  const sessions = [];
  let r = headerRow + 1;
  while (r < grid.length) {
    const label = grid[r][sectionCol];
    if (!SECTION_LABELS.includes(label)) { r++; continue; }
    // 仅在该标签与上一行不同（即块起点）时处理，跳过块内后续行
    if (r > headerRow + 1 && grid[r - 1][sectionCol] === label) { r++; continue; }
    const periodBase = SECTION_LABELS.indexOf(label) + 1; // 一→1

    // 块范围：向下直到标签变化（rowspan 展开后整块都是同一标签）
    let blockEnd = r;
    while (blockEnd + 1 < grid.length && grid[blockEnd + 1][sectionCol] === label) blockEnd++;

    // 星期列：节次列右侧按序取 7 列（位置映射，抗表头/正文列错开）
    const dayCols = [];
    for (let c = sectionCol + 1; c <= maxCol && dayCols.length < 7; c++) dayCols.push(c);
    if (dayCols.length !== 7) {
      warnings.push('节次' + label + ' 仅识别到 ' + dayCols.length + ' 个星期列（期望 7）');
    }

    // 逐层（每层 4 行）抽取
    for (let lr = r; lr + 3 <= blockEnd; lr += 4) {
      const nameRow = lr, teacherRow = lr + 1, weekRow = lr + 2, roomRow = lr + 3;
      for (let d = 0; d < dayCols.length; d++) {
        const col = dayCols[d];
        const name = (grid[nameRow][col] || '').trim();
        if (!name) continue;
        const teacher = (grid[teacherRow][col] || '').trim();
        const weekText = (grid[weekRow][col] || '').trim();
        const room = (grid[roomRow][col] || '').trim();
        const ctx = '节次' + label + ' 星期' + WEEK_CHAR[d];
        const { weeks, period } = parseWeekSpec(weekText, totalWeeks, warnings, ctx);
        let periods = [periodBase];
        if (period) {
          const ps = Math.ceil(period[0] / 2), pe = Math.floor(period[1] / 2);
          if (ps >= 1 && pe >= ps && pe <= 5) {
            periods = [];
            for (let p = ps; p <= pe; p++) periods.push(p);
          } else {
            warnings.push(ctx + ' 节次区间 [' + period[0] + '-' + period[1] + '] 越界，按节次 ' + periodBase + ' 处理');
          }
        } else {
          warnings.push(ctx + ' 缺少节次区间（如 [1-2]），按节次 ' + periodBase + ' 处理');
        }
        for (const p of periods) {
          // 同(课程名+教师)为一门课；教室可能随周次变化，按课次分别记录
          const key = name + ' ' + teacher;
          let ci = courseMap.get(key);
          if (ci === undefined) { ci = courses.length; courses.push({ name, teacher, room }); courseMap.set(key, ci); }
          sessions.push({
            courseIndex: ci, name, teacher, room,
            dayOfWeek: d + 1, period: p, weeks, weekRule: 'ALL',
            groupScope: null, courseType: 'ALL', kind: 'COURSE', dutyCount: 2
          });
        }
      }
    }
    r = blockEnd + 1;
  }

  if (!sessions.length) throw new Error('未解析到任何课次，请确认文件为青果导出的教学安排表');
  return { courses, sessions, warnings, meta: { sectionCol, headerRow } };
}

module.exports = { parseTimetableXlsx, parseWeekSpec, expandMerges, SECTION_LABELS, WEEK_NAMES };
