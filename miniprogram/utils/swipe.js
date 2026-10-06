/**
 * 页面级横向滑动（左右滑动切周）—— 值日页 / 手动排班页共用。
 * ------------------------------------------------------------
 * 为什么只在 touchend 判一次方向，不做「跟手位移」：
 *   这两页都是**页面级纵向滚动**，如果实时跟手就要每帧抢方向判定，
 *   稍微斜一点的滑动都会被误判成换周，反而更难受；而且换周要重新拉云函数数据，
 *   属于重操作，跟手拖动会让用户在中途反复触发。
 *   只在松手时判一次，配合「横向位移足够大 + 横向明显大于纵向」两道门槛，
 *   既能用，又不会误触。
 *
 * 用法（页面 · 手势版：值日页 / 手动排班页）：
 *   const swipe = require('../../utils/swipe');
 *   onSwipeStart(e) { swipe.begin(this, e); },
 *   onSwipeEnd(e) {
 *     // 弹层打开时不响应（弹层 DOM 在页面根节点里，touch 会冒泡上来）
 *     if (this.data.sheetShow) return;
 *     const dir = swipe.end(this, e);
 *     if (dir === 'prev') this._shiftWeek(-1);
 *     else if (dir === 'next') this._shiftWeek(1);
 *   }
 *   // 换周统一过 swipe.shift（带方向性动画），箭头 / 周次选择器也走同一条路：
 *   onWeekChange(e) {
 *     const wk = Number(e.detail.week);
 *     if (wk < 1 || wk > this.data.totalWeeks) return;
 *     const delta = wk - Number(this.data.week);
 *     if (!delta) return;
 *     swipe.shift(this, delta, (w) => this._applyWeek(w));
 *   }
 *   onUnload() { swipe.cancel(this); }   // 二级页会被销毁，定时器必须清
 * 模板：在页面根节点上 bindtouchstart / bindtouchend；
 *       数据区（骨架 / 空态 / 列表）套一层 <view class="wk-swipe {{swipeCls}}">。
 *
 * 用法（页面 · 动画版：课表页，v0.7.20）：
 *   只 require + shift/cancel，**不挂 bindtouch\***（课表是 scroll-x，挂手势会抢横向滚动）：
 *   onWeekChange(e) { const wk = …; const delta = wk - this.data.week; if (!delta) return;
 *                     swipe.shift(this, delta, (w) => this._applyWeek(w)); }
 *   onUnload() { swipe.cancel(this); }
 *   `_applyWeek` 必须**同步**改数据（课表页 load() 是纯本地渲染，无网络等待），
 *   否则入场动画播的还是旧内容、新数据在半路才落下来。
 * ------------------------------------------------------------
 * ⚠️ **课表页只借动画、不借手势**（v0.7.20 起）：课表主体本身就是 `scroll-x`，横向手势另有归属，
 *    所以课表页只调 `shift()` / `cancel()`，**绝不**调 `begin()` / `end()`，也不挂 `onSwipeStart`。
 *    （由 scripts/check-week-swipe.js 守着 —— 102 行断言课表页不得出现 onSwipeStart）
 */

/** 最小横向位移（px）：太小容易被「手指抖一下」触发 */
const MIN_X = 50;
/** 横向必须大于纵向的倍数：斜滑以纵向滚动为主时让给页面 */
const RATIO = 1.4;

/* ---------------- 切换动画（v0.7.11） ----------------
 * 三段，全部只动 transform / opacity（GPU 属性，不触发布局）：
 *   out  160ms 离场加速 cubic-bezier(0.7, 0, 0.84, 0)：内容朝手指方向滑走并淡出
 *   in   220ms 入场减速 cubic-bezier(0.16, 1, 0.3, 1)：新内容从反方向滑入并淡入
 *   edge 220ms 到头回弹：已经在第 1 周 / 最后一周时，短促探一下再弹回，
 *        给「滑不动了」一个看得见的反馈（原先是静默无反应）
 * 对应的 CSS 在 app.wxss（两个页面共用，避免各写一份）。
 * ⚠️ 动画容器里不能放 fixed 元素：transform 会把它变成包含块，fixed 会跟着一起动。
 *    值日页的离屏 canvas、手动排班页的底部固定条都在容器外（由 check-week-swipe 守着）。
 */
const OUT_MS = 160;
const IN_MS = 220;
const EDGE_MS = 220;

const KEY_X = '__swipeStartX';
const KEY_Y = '__swipeStartY';
const KEY_TIMER = '__swipeTimer';

/** 记下起点 */
function begin(page, e) {
  if (!page) return;
  const t = (e && e.touches && e.touches[0]) || {};
  page[KEY_X] = Number(t.clientX);
  page[KEY_Y] = Number(t.clientY);
}

/**
 * 判方向。
 * @returns {'prev'|'next'|''} prev = 右滑（上一周），next = 左滑（下一周），'' = 不算滑动
 */
function end(page, e) {
  if (!page) return '';
  const t = (e && e.changedTouches && e.changedTouches[0]) || {};
  const x0 = page[KEY_X];
  const y0 = page[KEY_Y];
  page[KEY_X] = null;
  page[KEY_Y] = null;
  if (!Number.isFinite(x0) || !Number.isFinite(y0)) return '';
  const dx = Number(t.clientX) - x0;
  const dy = Number(t.clientY) - y0;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return '';
  if (Math.abs(dx) < MIN_X) return '';
  if (Math.abs(dx) < Math.abs(dy) * RATIO) return '';   // 纵向为主 → 让给页面滚动
  return dx < 0 ? 'next' : 'prev';
}

/* ---------------- 方向 → 动画 class ---------------- */

/** 离场：内容朝手指方向滑走（next = 左滑 → 向左） */
function animOut(dir) { return dir === 'next' ? 'wk-out-left' : 'wk-out-right'; }

/** 入场：新内容从反方向滑入（next = 下一周 → 从右边进来） */
function animIn(dir) { return dir === 'next' ? 'wk-in-right' : 'wk-in-left'; }

/** 到头回弹：next 到头朝左探一下，prev 到头朝右探一下 */
function animEdge(dir) { return dir === 'next' ? 'wk-edge-left' : 'wk-edge-right'; }

/** 清掉上一次的定时器（连续快滑时，后一次必须接管前一次） */
function cancel(page) {
  if (!page) return;
  if (page[KEY_TIMER]) { clearTimeout(page[KEY_TIMER]); page[KEY_TIMER] = null; }
}

/**
 * 带动画地切换（滑动、点箭头、周次选择器都走这里）。
 *
 * @param {Object}   page  页面实例（用 page.data.week / data.totalWeeks 判断，setData 写 swipeCls）
 * @param {number}   delta +1 = 下一周，-1 = 上一周（绝对值 >1 也按同向处理）
 * @param {Function} go    真正换数据的回调，收到目标周次（页面里一般是 setData week + load）
 * @returns {boolean} 是否真的切换了；false = 越界（此时只播回弹，不调 go）
 */
function shift(page, delta, go) {
  if (!page || !page.data || typeof page.setData !== 'function') return false;
  const total = Number(page.data.totalWeeks) || 0;
  const cur = Number(page.data.week) || 0;
  const wk = cur + Number(delta);
  const dir = Number(delta) > 0 ? 'next' : 'prev';
  cancel(page);

  // 越界：第 1 周还往右滑 / 最后一周还往左滑 —— 不换数据，只回弹一下
  if (!total || !Number.isFinite(wk) || wk < 1 || wk > total) {
    page.setData({ swipeCls: animEdge(dir) });
    page[KEY_TIMER] = setTimeout(() => {
      page.setData({ swipeCls: '' });
      page[KEY_TIMER] = null;
    }, EDGE_MS);
    return false;
  }

  // 先让旧内容滑走，再换数据 —— 反过来会「先白一下再动」，比不动还难看
  page.setData({ swipeCls: animOut(dir) });
  page[KEY_TIMER] = setTimeout(() => {
    page.setData({ swipeCls: animIn(dir) });
    page[KEY_TIMER] = null;
    if (typeof go === 'function') go(wk);
  }, OUT_MS);
  return true;
}

module.exports = {
  begin, end, shift, cancel,
  animOut, animIn, animEdge,
  MIN_X, RATIO, OUT_MS, IN_MS, EDGE_MS
};
