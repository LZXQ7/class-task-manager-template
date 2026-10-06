/**
 * 排班轮转内核 —— 「按序号连续轮转」的唯一实现
 * ============================================================
 * 为什么单独抽一个文件：这条规则被两个入口共用
 *   · `cloudfunctions/schedule`  → 超管在值日页点「一键生成 / AI 生成」（手动触发）
 *   · `cloudfunctions/cron-weekly` → 每周日 20:00 的 `weekly` 触发器（自动生成草稿）
 * 之前两边各写了一套：schedule 用序号轮转，cron-weekly 用
 * 「duty_count 排序 + Math.random() 打破平局」，于是自动生成的那份会
 * 把同一个人排进多个课次（用户 2026-09-24 报的 bug）。现在统一在这里。
 *
 * ⚠️ 本文件是源，改完必须跑 `node scripts/sync-common.js` 再部署；
 *    各函数目录下的 `common/` 只是副本，会被静默覆盖。
 */

/**
 * 轮转取人。
 *
 * 规则（来自使用者的原话）：
 *   「按照需要一直往后排：这周排到 40 号，下周第一节课就从 41 号继续排。
 *     直到 56 人全部排完，重置标记再从 1 号开始。」
 * 也就是：一轮 = 全班每人各值一次；**一轮之内每人最多排一次**（跨天也算重复）。
 *
 * 实现方式 = 把候选分成四档，永远优先取没排过的，绝不回头重复：
 *   ① 本轮未排 + 本周未排 —— 正常路径，「一路往后排」
 *   ② 本轮已排 + 本周未排 —— 本轮全班排完了，开新一轮，按序号继续
 *   ③ 本轮未排 + 本周已排 —— 名额多于人数时的降级（只可能命中当天本来就有值日的人）
 *   ④ 本轮已排 + 本周已排 —— 最后手段
 * 档内按 `(已排次数 ASC, 序号 ASC)` 排；因为「减/加同一个常数不改变顺序」，
 * 所以「分级取人」天然等价于「连续取号 + 满一轮重置」。
 *
 * 反面教材（不要再写回去）：一旦发现「本轮未排的人不够」就
 * `roster.forEach(m => m.mark = 0)` 把所有人清零 —— 连本周已经值过日的人也被清零，
 * 于是下一个课次又会选到他。这就是线上重复安排事故的根因。
 *
 * @param {Array}  roster       [{id, seq, group, mark, name?}]，mark 会被就地累加
 * @param {string} scope        分组课传 'A'/'B'，全体课传 null
 * @param {number} n            本节课需要几个人
 * @param {object} blocks       {busy:Set(memberId), onLeave:Set(memberId)}
 * @param {boolean} avoidSameDay 是否禁止同日重复值日（schedule_rules.avoid_same_day）
 * @param {Set}    inBatch      当天已（在本批次里）排过的人 id
 * @param {Set}    [exclude]    本次绝对不用的人 id
 * @param {Set}    [inWeek]     本周（含本批次刚排的、手动排班的）已值过日的人 id
 * @returns {{chosen:Array, wrapped:boolean, left:number, short:number}}
 *          wrapped = 用到了「本轮已排过」的人（即已开新一轮）
 *          short   = 还差几个人没排满（候选真的不够）
 */
function rotationPick(roster, scope, n, blocks, avoidSameDay, inBatch, exclude, inWeek) {
  const ex = exclude || new Set();
  const week = inWeek || new Set();
  const ok = m => !ex.has(m.id)
    && (!scope || m.group === scope)
    && !blocks.onLeave.has(m.id)
    && (!avoidSameDay || (!blocks.busy.has(m.id) && !inBatch.has(m.id)));
  const byRound = (a, b) => (a.mark - b.mark) || (a.seq - b.seq);
  const pool = roster.filter(ok).sort(byRound);
  const fresh = pool.filter(m => m.mark === 0);   // 本轮还没排过
  const used = pool.filter(m => m.mark > 0);      // 本轮已排过（要开新一轮才会用上）
  const tiers = [
    fresh.filter(m => !week.has(m.id)),
    used.filter(m => !week.has(m.id)),
    fresh.filter(m => week.has(m.id)),
    used.filter(m => week.has(m.id))
  ];
  const chosen = [];
  const taken = new Set();
  let wrapped = false;
  for (let i = 0; i < tiers.length && chosen.length < n; i++) {
    for (const m of tiers[i]) {
      if (chosen.length >= n) break;
      if (taken.has(m.id)) continue;
      taken.add(m.id);
      chosen.push(m);
      if (i === 1 || i === 3) wrapped = true;   // 用到了「本轮已排过」的人 → 已开新一轮
    }
  }
  chosen.forEach(m => { m.mark += 1; });
  return { chosen, wrapped, left: pool.length, short: Math.max(0, n - chosen.length) };
}

/**
 * 修补「本轮已排」标记里的**序号断层**。
 *
 * 为什么需要它（2026-09-26 用户第二次反馈「一键生成还是从 1 号开始」）：
 * 轮转位置唯一存在 `member.duty_count` 这个「本轮已排次数」标记里。旧版
 * `schedule.clear` 会把**全班**标记清零，所以「清空第 1/2 周」之后，序号 01~24
 * 的标记掉了回去，而第 3 周刚排出来的 25~48 还带着标记。下一次生成时
 * `rotationPick` 取「标记最小 + 序号最小」，最小档里就混进了 01~24 ——
 * 于是又从 1 号重排，用户看到的「第 4 周没有从 49 号接续」。
 * 那两批人的 duty 行已经被删掉，标记没法从行数反推回来，只能按「连续段」推。
 *
 * 判据（只信连续段，不信孤点）：
 *   名册按序号排好后切出「连续已排段」（段内成员标记都 > 0，段间被未排的人隔开），
 *   取**最长**的一段，它的最大序号就是本轮游标 cursor；序号 ≤ cursor 的人统一补成
 *   「已排」（标记 = 1）。
 *   ⚠️ 段长 < 2 不作为依据：手工把 50 号加进某节课也会让 50 号的标记变 1
 *   （见 schedule.addManual，它会 `duty_count + 1`），若拿它当游标就会把
 *   41~49 误判成「已排过」而跳过。
 *   ⚠️ 多段等长时取**最靠右**的一段（轮转按序号单调往上，真游标必在右段末尾）。
 *
 * 与 `rotationPick` 的分工：本函数只修「标记」这一层，不参与选人；补完之后
 * rotationPick 的「取最小档 + 序号升序」自然等价于「接着 cursor 往下排」。
 *
 * @param {Array} roster [{id, seq, mark | dutyCountThisRound}]，会被就地修改
 * @returns {{cursor:number, filled:Array<number>}}
 *          cursor = 本轮游标（0 = 没找到可靠游标，按原样轮转）；
 *          filled = 被补成「已排」的成员**序号**（需要成员 id 时用 idBySeq 映射 —— 
 *          AI 上下文的名册里没有 id 字段，所以这里统一回序号）
 */
function repairRoundMarks(roster) {
  const out = { cursor: 0, filled: [] };
  if (!roster || !roster.length) return out;
  // 两条链路字段名不同（generate 用 mark，AI 上下文用 dutyCountThisRound），两个都认
  const getMark = r => Number(r.mark !== undefined ? r.mark : r.dutyCountThisRound) || 0;
  const setMark = r => {
    if (r.mark !== undefined) r.mark = 1;
    if (r.dutyCountThisRound !== undefined) r.dutyCountThisRound = 1;
  };
  const rows = roster.slice().sort((a, b) => (a.seq - b.seq) || (a.id - b.id));
  let len = 0, bestLen = 0, bestEnd = 0;
  for (const r of rows) {
    if (getMark(r) > 0) {
      len += 1;
      // ⚠️ 同长时取**靠右**那段（>= 而不是 >）：被清掉的中间块会把「已排区间」
      // 切成左右两段，而真正的游标永远在右段末尾（轮转是按序号单调往上的）。
      // 例：已排到 40 号，清掉 17~24 得到「01~16 已排 + 25~40 已排」两段等长，
      // 取左段会算成 cursor=16、从 17 号重排；取右段才是 cursor=40。
      if (len >= bestLen) { bestLen = len; bestEnd = Number(r.seq) || 0; }
    } else {
      len = 0;
    }
  }
  if (bestLen < 2) return out;
  out.cursor = bestEnd;
  for (const r of rows) {
    if ((Number(r.seq) || 0) <= bestEnd && getMark(r) === 0) {
      setMark(r);
      out.filled.push(Number(r.seq) || 0);
    }
  }
  return out;
}

/**
 * 当日已有的值日者 / 已请假者。
 * 与 rotationPick 放在一起：两个入口（手动生成 / 每周自动生成）都要用，
 * 且必须用同一份口径，否则「同日不重复」的判定会不一致。
 *
 * @param {object} conn      数据库连接（pool 或事务中的 conn 都可以）
 * @param {string} classDate 'YYYY-MM-DD'
 * @returns {{busy:Set, onLeave:Set}} 成员 id 集合
 */
async function loadDayBlocks(conn, classDate) {
  const [todayDuties] = await conn.query(
    "SELECT DISTINCT member_id FROM duty WHERE class_date = ? AND status <> 'SWAPPED_OUT'", [classDate]
  );
  const [leaves] = await conn.query(
    "SELECT member_id FROM leave_request WHERE status = 'APPROVED' AND start_date <= ? AND end_date >= ?",
    [classDate, classDate]
  );
  return {
    busy: new Set(todayDuties.map(d => Number(d.member_id))),
    onLeave: new Set(leaves.map(l => Number(l.member_id)))
  };
}

module.exports = { rotationPick, repairRoundMarks, loadDayBlocks };
