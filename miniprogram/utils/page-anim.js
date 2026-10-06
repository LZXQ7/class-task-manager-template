/**
 * Tab 页入场动画（v0.7.31 第 4 次定案：分块淡入 + 轻微上浮，**就绪后统一播**）
 * ------------------------------------------------------------
 * 七段历史，别再走回头路：
 *   ① 整页 opacity 0→1，每次 onShow 重播  → 2026-09-25 反馈「切页面闪一下」
 *   ② 改成只播一次、回访完全静止         → 2026-09-26 反馈「直接展示太生硬」
 *   ③ 内容分块依次上浮（st-1~st-4 错峰）  → 反馈「错峰太碎」
 *   ④ 单一整体节拍（整页 14px 上浮）      → 反馈「展开动画不好看」，要求全部删掉重做
 *   ⑤ 极简 cross-fade（零位移）           → 反馈「看不见；点击首页应该有进入动画」
 *   ⑥ v0.7.14（用户明确选择）：分块淡入 + 轻微上浮。错峰 20ms、位移 8px（回访 14ms / 5px），
 *      第 7 块起封顶 —— 相邻块咬得太紧。
 *   ⑦ v0.7.31（2026-09-29 用户反馈）：**「几乎一起出现」（错峰太弱）+「个别卡片晚出现」**。
 *      · 错峰 20 → **36ms**（回访 14 → 26ms），让「一片片来」看得出来；
 *        整段随之 300 → **396ms**（导航预算放宽，见 check-tab-enter ③）。
 *      · **就绪后统一播**：过去根节点一渲染就带 pa-first，`.st-item` 立刻开播；
 *        而「本班请假 / 我的·本学期统计」这类卡是 **wx:if 异步门控**的（要等身份 / 数据），
 *        首屏根本不在 DOM 里 → 等数据回来才被创建、那一刻才开播（还自带 st-N 延迟）
 *        → 表现就是「别的卡都出来了，它才冒出来」。
 *        现在未就绪时根节点挂 `pa-hold`（`.st-item` 透明），**等「身份 + 首屏数据」都就绪
 *        （或 READY_MS 兜底超时）再切成 pa-* 统一开播** —— 晚到的卡也在序列里。
 *
 * 口径（与 app.wxss 的 .pa-hold / .pa-first / .pa-lite-* 一一对应；改一处必须改另一处，
 *       由 scripts/check-tab-enter.js 逐项比对，不同步就报错）：
 *   未就绪： pa-hold               —— `.st-item` 透明（等就绪，最多 READY_MS）
 *   首次进入：pa-first              —— 单块 180ms / 上浮 8px / 块间 36ms（总 396ms）
 *   之后回访：pa-lite-a ↔ pa-lite-b —— 单块 140ms / 上浮 5px / 块间 26ms（总 296ms）
 *   两个 lite 名字轮换：class 名变了 CSS animation 才会重播（同名不会）。
 *   延迟封顶 ST_CAP 块：第 8 块及以后与第 7 块同拍，尾巴不再无限拉长。
 *   reduced-motion：CSS 去位移 + 去错峰，只留 80ms 淡入（paReduce，@media 内只引用不定义）。
 *
 * 用法（页面）：
 *   const pageAnim = require('../../utils/page-anim');
 *   Page({
 *     data: { animSeq: 0, paReady: false },   // animSeq: 0=首播，之后 1/2 轮换；paReady: 就绪标记
 *     onShow() { pageAnim.playReady(this, getApp()); ... }
 *   });
 *   <!-- 根节点：就绪前 pa-hold（透明），就绪后按 animSeq 选 pa-first / pa-lite-*；
 *        三个动画类名必须写全（别用 pa-{{n}} 插值），check-tab-enter 会逐字面量断言 -->
 *   <view class="page home {{paReady ? (animSeq === 0 ? 'pa-first' : (animSeq === 1 ? 'pa-lite-a' : 'pa-lite-b')) : 'pa-hold'}}">
 *   <!-- 需要入场的块标 st-item + 档位类 st-1~st-7 -->
 *   <view class="card mt16 st-item st-1">
 *
 * ⚠️ .st-item 只加在普通内容块上：nav-bar / FAB / 悬浮胶囊 / 离屏 canvas 不加，
 *    让标题栏与悬浮控件在换页时保持稳定。
 * ⚠️⚠️ 关键帧带 translateY，而 transform 会创建包含块 ——
 *    **position: fixed 元素绝不能待在 .st-item 内部**（动画那 180ms 里会被当成相对该块
 *    定位而飞走）；所有 .st-item 还必须互为兄弟（嵌套会让两层位移叠加成 16px）。
 *    这两条都由 scripts/check-tab-enter.js 逐页断言。
 * ⚠️ 错峰由 wxml 档位类 st-N 实现，页面 wxml **不需要** st-1~st-4 之外的写法。
 */

const FIRST_CLS = 'pa-first';
const LITE_CLS = ['pa-lite-a', 'pa-lite-b'];

/** 强度常量：app.wxss 里的数值必须与之相同（门禁比对） */
const FULL_MS = 180;      // 首次：单块动画时长
const LITE_MS = 140;      // 回访：单块动画时长（更短）
const FULL_Y = 8;         // 首次：上浮位移（px）
const LITE_Y = 5;         // 回访：上浮位移（px）
const ST_STEP_MS = 36;    // 首次：相邻块错峰（ms）
const LITE_STEP_MS = 26;  // 回访：相邻块错峰（ms）
const ST_CAP = 7;         // 错峰封顶块数：第 8 块及以后与第 7 块同拍
const FULL_TOTAL_MS = FULL_MS + (ST_CAP - 1) * ST_STEP_MS;   // 396
const LITE_TOTAL_MS = LITE_MS + (ST_CAP - 1) * LITE_STEP_MS; // 296

/** 「就绪」最长等待（ms）：到点无论如何都播，绝不把页面留在 pa-hold（空白）里 */
const READY_MS = 400;

/**
 * 每次 onShow 调一次（**旧的立即播**，保留给不需要就绪门控的场景 / 单测）。
 *
 * 首次只做标记、**不 setData**：根节点初始 data 就是 pa-first，元素创建那一刻
 * CSS animation 已经开播（animation 与 transition 不同，创建即播）；此时再 setData
 * 一次同名 class 不会重播，写别的值反而会打断刚播了几毫秒的动画（像卡了一下）。
 *
 * 回访才真的 setData：在两个 lite 名字之间轮换，靠换名字让动画重播。
 */
function play(page) {
  if (!page || !page.data) return;
  if (!page._animPlayedOnce) {
    page._animPlayedOnce = true;
    return;
  }
  // 回访才真的 setData：0 → 1 → 2 → 1 → 2 …，wxml 的三元把 1 / 2 映射到两个 lite 类名
  const seq = Number(page.data.animSeq) === 1 ? 2 : 1;
  page.setData({ animSeq: seq });
}

/**
 * 等页面首屏「加载中」状态结束（`data.loading === false`）。
 * 四个 Tab 页都有 loading 标记：true=首屏数据未到，false=已就绪（课表页本地渲染，天然同步）。
 * 轮询而非订阅 —— 不需要每个页面改自己的 load() 去回调，改动面最小。
 */
function whenIdle(page, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (!page || !page.data || page.data.loading === false || Date.now() - t0 >= timeoutMs) {
        resolve();
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

/**
 * **就绪后统一播**（v0.7.31 默认入口，替代页面里的 play(this)）。
 *   未就绪 → 根节点是 pa-hold（.st-item 透明），晚到的异步门控卡片也在这段里被创建；
 *   等「app.ready()（身份）+ 首屏数据（loading=false）」都就绪、或 READY_MS 兜底超时
 *   → setData({paReady:true}) 让根节点换成 pa-*，所有卡片按序递进。
 * @param {object} page 页面实例
 * @param {object} [app] getApp()（可选；用于等登录就绪。不传则只等数据）
 */
function playReady(page, app) {
  if (!page || !page.data) return;
  // 已经播过首场（回访）：直接按 animSeq 轮换重播
  if (page.data.paReady) { play(page); return; }
  let settled = false;
  const go = () => {
    if (settled) return;
    settled = true;
    if (!page.data.paReady) page.setData({ paReady: true });
    play(page);
  };
  // 兜底：到点无论身份 / 数据是否就绪都播，绝不把页面留在空白
  setTimeout(go, READY_MS);
  const auth = (app && typeof app.ready === 'function') ? app.ready() : Promise.resolve();
  const idle = whenIdle(page, READY_MS);
  Promise.all([auth, idle]).then(go, go);
}

module.exports = {
  play, playReady, whenIdle,
  FIRST_CLS, LITE_CLS,
  FULL_MS, LITE_MS, FULL_Y, LITE_Y,
  ST_STEP_MS, LITE_STEP_MS, ST_CAP,
  FULL_TOTAL_MS, LITE_TOTAL_MS,
  READY_MS
};
