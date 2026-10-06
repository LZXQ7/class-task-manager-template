/**
 * 页面数据的内存缓存（仅本次运行有效，**不落 storage**）
 * ------------------------------------------------------------
 * 解决的问题：切回 Tab / 再进二级页时要重新等一次云函数。
 *
 *   首次进入 → 正常拉取，顺手写缓存；
 *   再次进入 → 先用缓存**同步渲染**（不闪骨架、不白屏），再后台静默刷新。
 *
 * 缓存放 `app.globalData._mem`，App 重启即清空 —— 班务数据不在小程序本地留副本，
 * 与 `utils/notice.js` 的策略一致。
 *
 * ⚠️ 键里必须带**数据归属**（日期 / 周次等）。跨天、跨周时键自然不同 → 自动失效，
 * 不会拿昨天的值日当今天的渲染。
 * ⚠️ 写入后视为**只读**：读出来的对象不要在页面里原地改（页面装饰数据时都是
 * `Object.assign({}, x)` 生成新对象，保持这个习惯）。
 */

function slot() {
  const app = (typeof getApp === 'function') ? getApp() : null;
  if (!app) return null;
  const g = app.globalData || (app.globalData = {});
  if (!g._mem) g._mem = {};
  return g._mem;
}

/** 读缓存；没有则返回 null */
function read(key) {
  const s = slot();
  if (!s || !key) return null;
  return Object.prototype.hasOwnProperty.call(s, key) ? s[key] : null;
}

/** 写缓存（undefined 归一成 null） */
function write(key, data) {
  const s = slot();
  if (!s || !key) return;
  s[key] = data === undefined ? null : data;
}

/**
 * 清缓存。key 省略/为空 = 整体清空（保留对象引用，方便其它读取者继续持有）。
 * 在「数据被改动、不能再用旧值」的写操作之后调用（如发布值日表、调课、换人）。
 */
function clear(key) {
  const s = slot();
  if (!s) return;
  if (key) { delete s[key]; return; }
  Object.keys(s).forEach(k => { delete s[k]; });
}

/**
 * 缓存键构造器 —— **唯一来源**。
 * 页面读的键和 `app.js` 后台预热写的键必须完全一致，否则「预热了但页面读不到」，
 * 表现为预热形同不存在（而且不会报错）。所以键的形状只在这里定义一次。
 */
const keys = {
  /** 首页：按**日期**归属，跨天自动失效 */
  home: (dateStr) => 'home:' + dateStr,
  /** 值日页：按**周次**归属，跨周自动失效 */
  duty: (week) => 'duty:' + week,
  /** 手动排班（二级页）：按周次归属 */
  manual: (week) => 'manual:' + week,
  /** 成员与分组（二级页）：按**班级 + 搜索词**归属（v0.7.32 问题①：同班回访秒开） */
  roster: (classId, kw) => 'roster:' + (Number(classId) || 0) + ':' + (kw || '')
};

/**
 * 值日表被改动 → 作废所有依赖它的缓存（值日页 + 手动排班页）。
 * **每次成功的写操作（生成 / 发布 / 撤回 / 清空 / 加人 / 换人 / 移除 / 调课）之后都要调**，
 * 否则用户改完回到另一个页面，那页会先拿旧名单渲染一屏再刷新 —— 值日看错是真会误事的。
 */
function invalidateSchedule(week) {
  clear(keys.duty(week));
  clear(keys.manual(week));
}

module.exports = { read, write, clear, keys, invalidateSchedule };
