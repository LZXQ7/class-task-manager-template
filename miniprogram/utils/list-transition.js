/**
 * 列表过渡公共模块（v0.7.21 需求⑤）
 * ============================================================
 * 解决的问题：**同一份数据、切换视图或筛选**时，列表从 A 种排法瞬间跳到 B 种排法 ——
 * 行会「闪现」到新位置、被筛掉的行凭空消失、新出现的行凭空冒出来。三个页面
 * （值日「按日 / 按人」、成员与分组「全班 / 仅班委」、课表「A 组 / B 组」）都是同一毛病。
 *
 * 本模块把三种过渡都收在一起，页面只需要给「选择器 + 稳定 key + 目标数组 + setData 补丁」：
 *
 *   ① FLIP（`flip`）：布局**整体换掉**时用（按日 ⇄ 按人、A 组 ⇄ B 组）。
 *      先量旧位置 → 换数据 →（同一帧内）量新位置 → 反向位移把元素「按」回原位
 *      → 下一帧放开过渡，元素自己飞回新位置。新增项从下方 16px 淡入。
 *
 *   ② 增删过渡（`filterSwap`）：布局**只增只减**时用（全班 ⇄ 仅班委）。
 *      被移除的行**渐隐与行高塌缩同步**（不是先渐隐、留一块空白再跳位），
 *      保留下来的行被布局连续带走 —— 它们是真的在「飞」，且不会和塌缩叠成两段运动；
 *      新出现的行从 0 高度展开 + 从下方 16px 淡入，把保留行连续撑下去。
 *      ⚠️ 离场必须**两阶段 setData**：先把起始高度写成内联样式钉住（此刻没有过渡属性，
 *        不会动），下一帧才挂上过渡 + 目标值，再等动画播完才真正从数组里删掉。
 *
 * 为什么两种都留着，而不是一律 FLIP：
 *   增删场景里，塌缩本身就在连续改变布局 —— 此时再给保留行叠一层反向位移，
 *   等于把同一段位移算两遍，行会先被按住再动，反而顿一下。选对机制比统一机制重要。
 *
 * 规格（需求⑤给定）：保留项飞行 ≈260ms ease-out、新增项 200ms、离场 240ms，
 *   全部落在 200~300ms 区间；可打断（重复触发时后一次覆盖前一次）；
 *   列表项必须有稳定 `wx:key`（由调用方保证）。
 *
 * 禁止项（需求⑤给定）：
 *   · 不做「整列表 opacity 0→1」—— 那是换页，不是换视图；
 *   · 离场必须真的塌缩高度，不留白再跳位；
 *   · 不做逐项错峰（stagger）—— 一列几十行错峰只会显得卡；
 *   · 切换期间**不锁点击**（纯 setData + CSS transition，随时能再点一次）；
 *   · 不用 cubic-bezier 伪造弹性曲线。
 *
 * ⚠️ 关于「收尾轻微过冲」：需求里既要「260ms ease-out + 收尾轻微过冲」，
 *   又明确禁止「用 cubic-bezier 模拟弹性」。在 WXSS 里唯一不违禁的做法是
 *   **把落位拆成两段位移**：主段 220ms 走完主要行程，尾段 70ms 再回一次
 *   （先越过目标 4px 再落回 0）。这样过冲是真实的两段运动，不是伪造的曲线。
 *   `SETTLE_MS = 0` 即可一键关掉尾段（总时长就是 220ms）。
 *
 * 用法：
 *   const lt = require('../../utils/list-transition');
 *
 *   // ① FLIP
 *   lt.flip(this, {
 *     sel: '.dt-row[data-id]', key: 'id', field: 'flip',
 *     rows: () => this.data.days.concat(...),      // 承载样式的对象（平铺数组）
 *     patch: (rows) => ({ days: this.data.days, persons: this.data.persons })
 *   });
 *
 *   // ② 增删
 *   lt.filterSwap(this, {
 *     sel: '.mb-row[data-id]', key: 'id', field: 'lt',
 *     cur: () => this.data.viewMembers,
 *     next: (cur) => this._filterRows(this.data.members, only),
 *     patch: (rows) => ({ viewMembers: rows })
 *   });
 */

/* ---------------- 时长与位移（唯一来源：页面不要各写一份） ---------------- */
const MS = {
  FLIP: 220,     // 保留项主飞行段
  SETTLE: 70,    // 保留项落位沉降段（0 = 关掉过冲）
  OUT: 240,      // 离场项「渐隐 + 行高塌缩」
  IN: 200        // 新增项淡入上移
};
const IN_Y = 16;        // 新增项入场起始位移（px）
const SETTLE_Y = 4;     // 落位过冲幅度（px）；只有行程够长才看得出来，短行程不补
const SETTLE_MIN = 24;  // 行程小于这个值就不做沉降（补了反而像抖一下）
const FLIP_EASE = 'cubic-bezier(.22,.61,.36,1)';   // 纯减速，不含过冲
const PLAIN_EASE = 'ease-out';
/** 两阶段之间的对齐间隔：下一帧再挂过渡，否则同一次样式计算里起点/过渡一起生效 = 不动 */
const FRAME_MS = 20;

/* ---------------- 系统「减弱动态效果」 ---------------- */
/**
 * 用户开了系统级「减弱动态效果」就直接换数据、不播过渡。
 * ⚠️ 必须 try 包住：`wx.getSystemSetting` 在低版本基础库 / 开发者工具里可能不存在，
 *    直接调用会抛错，把一次普通点击变成崩溃。
 */
function reduced() {
  let r = false;
  try {
    const s = wx.getSystemSetting && wx.getSystemSetting();
    r = !!(s && s.reducedMotion === 'enable');
  } catch (e) { r = false; }
  return r;
}

/* ---------------- 量位置 ---------------- */
/**
 * 量当前 DOM 里所有匹配项的位置与高度。
 * @param {Object}   page
 * @param {string}   sel  选择器（必须能读到 dataset[key]，例如 '.mb-row[data-id]'）
 * @param {string}   key  dataset 字段名（= 列表项的稳定 wx:key）
 * @param {Function} cb   ({ [key]: { top, h } })
 */
function measure(page, sel, key, cb) {
  const q = page.createSelectorQuery();
  q.selectAll(sel).fields({ rect: true, size: true, dataset: true });
  q.exec((res) => {
    const map = {};
    ((res && res[0]) || []).forEach((el) => {
      if (!el || !el.dataset) return;
      const k = el.dataset[key];
      if (k === undefined || k === null) return;
      map[String(k)] = { top: Number(el.top) || 0, h: Number(el.height) || 0 };
    });
    cb(map);
  });
}

/* ---------------- ① FLIP ---------------- */
/**
 * 布局整体换掉时的过渡。
 *
 * @param {Object}   page
 * @param {string}   o.sel     选择器（与 measure 同）
 * @param {string}   o.key     稳定 key 的 dataset 字段名
 * @param {string}   o.field   写到列表项对象上的样式字段名（wxml 用 style="{{item[field]}}"）
 * @param {Function} o.rows    返回**承载样式字段的对象数组**（平铺）
 * @param {Function} o.patch   入参为目标数组，返回要 setData 的补丁（必须包含 rows）
 * @param {Function} [o.onInvert] 反向位移**生效前**的最后一拍。
 *        收到的 newMap = 新位置的测量结果。用于「跟着同一拍一起播的、页面自己的东西」
 *        （比如值日页按日 ⇄ 按人时，新出现的日期头 / 学生名要在这一拍开始淡入）。
 *        给这些对象写样式时必须自带 transition，模块不会替它们加。
 * @param {Function} [o.guard] 每一拍开播前的闸门：返回 false 就**丢掉后续整条链**。
 *        这是「可打断」的实现方式 —— 页面在开始新一轮切换时把令牌自增，
 *        上一轮的 setTimeout 醒来发现令牌变了就自己退出，不会回来把新一轮的样式清掉。
 *        不传就等于不可打断（旧行为）。
 * @param {Function} [o.after] 全部动画播完后的回调（例如重新测量滚动高度）
 */
function flip(page, o) {
  if (!page || !o || typeof page.setData !== 'function') return;
  const rows = o.rows() || [];
  const ok = () => !(typeof o.guard === 'function') || o.guard();
  if (reduced()) { page.setData(o.patch(rows)); if (o.after) o.after(); return; }

  measure(page, o.sel, o.key, (oldMap) => {
    // 第一拍：先把数据换过去（DOM 顺序/位置变了，但此时还没有任何位移样式）
    page.setData(o.patch(rows), () => {
      measure(page, o.sel, o.key, (newMap) => {
        const moved = [];     // 需要「飞回去」的保留项
        const fresh = [];     // 新出现的项
        rows.forEach((r) => {
          if (!r) return;
          const k = String(r[o.key]);
          const a = oldMap[k];
          const b = newMap[k];
          if (a && b && Math.abs(a.top - b.top) > 1) {
            // 反向位移把元素「按」回旧位置（同时关掉过渡，否则这一下自己就动了）
            r[o.field] = 'transform:translateY(' + (a.top - b.top) + 'px);transition:none';
            moved.push({ r, dy: a.top - b.top });
          } else if (b && !a) {
            // 新增项：从下方 16px 淡入
            r[o.field] = 'opacity:0;transform:translateY(' + IN_Y + 'px);transition:none';
            fresh.push(r);
          } else {
            r[o.field] = '';
          }
        });
        // 页面自己的搭车动画（可选）：在这一拍把「新出现的分组标题」等的入场样式写进去，
        // 与反向位移同一次 setData 一起生效 —— 少一次渲染，也不会和行的飞行错位。
        if (typeof o.onInvert === 'function') o.onInvert(newMap);

        page.setData(o.patch(rows), () => {
          // 第二拍：放开过渡，回到真实位置
          setTimeout(() => {
            if (!ok()) return;
            moved.forEach((m) => {
              m.r[o.field] = 'transform:translateY(0);transition:transform ' + MS.FLIP + 'ms ' + FLIP_EASE;
            });
            fresh.forEach((r) => {
              r[o.field] = 'opacity:1;transform:translateY(0);transition:opacity ' + MS.IN + 'ms ' + PLAIN_EASE
                + ',transform ' + MS.IN + 'ms ' + PLAIN_EASE;
            });
            page.setData(o.patch(rows), () => {
              // 尾段（可关）：先越过目标 4px 再落回 —— 真实的第二段位移，不是伪弹性
              const need = MS.SETTLE > 0 ? moved.filter((m) => Math.abs(m.dy) >= SETTLE_MIN) : [];
              setTimeout(() => {
                if (!ok()) return;
                need.forEach((m) => {
                  m.r[o.field] = 'transform:translateY(' + (m.dy > 0 ? -SETTLE_Y : SETTLE_Y) + 'px);transition:transform '
                    + MS.SETTLE + 'ms ' + PLAIN_EASE;
                });
                if (need.length) page.setData(o.patch(rows));

                setTimeout(() => {
                  if (!ok()) return;
                  // 收尾：清掉内联样式（不写 transition，等于不播动画就归位）
                  moved.forEach((m) => { m.r[o.field] = ''; });
                  fresh.forEach((r) => { r[o.field] = ''; });
                  page.setData(o.patch(rows), () => { if (o.after) o.after(); });
                }, need.length ? MS.SETTLE : 0);
              }, MS.FLIP);
            });
          }, FRAME_MS);
        });
      });
    });
  });
}

/* ---------------- ② 增删过渡（筛选 / 视图切换） ---------------- */

/**
 * 「保留项 + 离场项 + 新增项」的并集 —— 阶段 A / B 都用它 setData，
 * 保证 DOM 顺序稳定（否则行会先重排一次再动，过渡白做）。
 *
 * 判据：
 *   · 只减不增（全班 → 仅班委）→ 并集 = 当前列表（离场项留在原位，边渐隐边塌缩）；
 *   · 只增不减（仅班委 → 全班）→ 并集 = 目标列表（新增项直接长在最终位置上）；
 *   · 既增又减 → 以当前列表为骨架，新增项插在「第一个离场项」之前。
 * 本项目三处用法都落在前两种，第三种只做兜底（不追求最优位置，只保证不崩、不跳）。
 */
function mergeUnion(cur, target, key) {
  const cset = {};
  cur.forEach((r) => { cset[String(r[key])] = true; });
  const hasExit = target.length < cur.length;
  const hasNew = (() => {
    const tset = {};
    target.forEach((r) => { tset[String(r[key])] = true; });
    return cur.some((r) => !tset[String(r[key])]);
  })();

  if (!hasExit) return target.slice();          // 只增不减
  if (!hasNew) return cur.slice();              // 只减不增
  const tset = {};
  target.forEach((r) => { tset[String(r[key])] = true; });
  const out = [];
  let inserted = false;
  cur.forEach((r) => {
    if (!inserted && !tset[String(r[key])]) {
      target.forEach((t) => { if (!cset[String(t[key])]) out.push(t); });
      inserted = true;
    }
    out.push(r);
  });
  if (!inserted) target.forEach((t) => { if (!cset[String(t[key])]) out.push(t); });
  return out;
}

/**
 * 筛选 / 视图切换：离场项渐隐 + 行高塌缩（同步），保留项被布局连续带走，新增项展开 + 淡入上移。
 *
 * @param {Object}   page
 * @param {string}   o.sel      选择器
 * @param {string}   o.key      稳定 key 的 dataset 字段名
 * @param {string}   o.field    承载样式字段的对象属性名（wxml 用 style="{{item[field]}}"）
 * @param {Function} o.cur      返回**当前屏幕上**的数组（就是要渲染的那份）
 * @param {Function} o.next     入参为当前数组，返回目标数组
 * @param {Function} o.patch    入参为要渲染的数组，返回 setData 补丁
 * @param {number}   [o.rowHeight] 行高（px）；不给则用保留项实测高度的中位数
 */
function filterSwap(page, o) {
  if (!page || !o || typeof page.setData !== 'function') return;
  const cur = o.cur() || [];
  const target = o.next(cur) || [];
  const ok = () => !(typeof o.guard === 'function') || o.guard();

  if (reduced()) { page.setData(o.patch(target)); return; }

  const tset = {};
  target.forEach((r) => { tset[String(r[o.key])] = true; });
  const cset = {};
  cur.forEach((r) => { cset[String(r[o.key])] = true; });
  const exiting = cur.filter((r) => !tset[String(r[o.key])]);
  const entering = target.filter((r) => !cset[String(r[o.key])]);
  // 没有增删（只是重新排了序）：不折腾，直接换数据
  if (!exiting.length && !entering.length) { page.setData(o.patch(target)); return; }

  const union = mergeUnion(cur, target, o.key);

  measure(page, o.sel, o.key, (now) => {
    if (!ok()) return;
    const hs = Object.keys(now).map((k) => now[k].h).filter((h) => h > 0).sort((a, b) => a - b);
    const unit = o.rowHeight || (hs.length ? Math.round(hs[Math.floor(hs.length / 2)]) : 64);

    // ── 阶段 A：把起点钉住（**不带 transition**，所以这一拍不会动）
    exiting.forEach((r) => {
      const m = now[String(r[o.key])];
      r[o.field] = 'max-height:' + Math.round((m && m.h) || unit) + 'px';
    });
    entering.forEach((r) => { r[o.field] = 'max-height:0px;opacity:0;transform:translateY(' + IN_Y + 'px)'; });

    page.setData(o.patch(union), () => {
      setTimeout(() => {
        if (!ok()) return;
        // ── 阶段 B：挂上过渡 + 目标值（离场塌缩、新增展开并淡入）
        exiting.forEach((r) => {
          r[o.field] = 'max-height:0px;opacity:0;padding-top:0;padding-bottom:0;margin-bottom:0;overflow:hidden;'
            + 'transition:max-height ' + MS.OUT + 'ms ' + PLAIN_EASE + ',opacity 180ms ' + PLAIN_EASE
            + ',padding ' + MS.OUT + 'ms ' + PLAIN_EASE + ',margin ' + MS.OUT + 'ms ' + PLAIN_EASE;
        });
        entering.forEach((r) => {
          r[o.field] = 'max-height:' + unit + 'px;opacity:1;transform:translateY(0);overflow:hidden;'
            + 'transition:max-height ' + MS.OUT + 'ms ' + PLAIN_EASE
            + ',opacity ' + MS.IN + 'ms ' + PLAIN_EASE + ',transform ' + MS.IN + 'ms ' + PLAIN_EASE;
        });
        page.setData(o.patch(union), () => {
          setTimeout(() => {
            if (!ok()) return;
            // ── 阶段 C：动画播完才真正删掉离场项 / 松开新增项的高度钳制
            entering.forEach((r) => { r[o.field] = 'max-height:none'; });
            exiting.forEach((r) => { r[o.field] = ''; });
            page.setData(o.patch(target), () => {
              entering.forEach((r) => { r[o.field] = ''; });
              page.setData(o.patch(target), () => { if (o.after) o.after(); });
            });
          }, MS.OUT + FRAME_MS);
        });
      }, FRAME_MS);
    });
  });
}

module.exports = { flip, filterSwap, measure, reduced, MS, IN_Y, SETTLE_Y, SETTLE_MIN, FRAME_MS };
