/**
 * mysql2 连接池单例（开发文档 附录 A / 7.0）
 * - timezone +08:00、dateStrings：全库时间以字符串（东八区墙钟）读写，避免服务器时区差异
 * - 每实例 connectionLimit: 5
 *
 * ⚠️ v0.7.22 需求①（「一键生成报 50000，几分钟后重试又成功」的根治）：
 * ----------------------------------------------------------------
 * 故障画像：SCF 容器在两次调用之间会被**冻结**；冻结期间池里的空闲 TCP 连接会被
 * VPC/NAT 的空闲回收**静默断开**。下一次调用从池里拿到的是一条**已死连接**——
 * 第一条 SQL 抛 PROTOCOL_CONNECTION_LOST / ECONNRESET，外层 catch 一律兜成
 * 「服务器开小差了」（50000）；再点一次时 mysql2 已把死连接踢出池、新建连接，
 * 于是「重试就好了」。这是 serverless + 连接池的经典组合缺陷，不是业务代码 Bug。
 *
 * 三层防御（都在本文件内，调用方零改动）：
 *   ① enableKeepAlive —— 缩短「空闲被回收」的窗口（短冻结直接救活）；
 *   ② pool.query 瞬时连接错误**重试一次**（先丢弃整池再建新池）——
 *      仅限「连接类」错误码（PROTOCOL_CONNECTION_LOST/ECONNRESET/ETIMEDOUT/EPIPE/
 *      ER_CON_COUNT_ERROR），SQL 类错误（ER_BAD_FIELD_ERROR 等）**绝不重试**；
 *   ③ getConnection 后先 `ping()` 验活再交出去 —— 事务（beginTransaction 起手）
 *      走的是 conn 而不是 pool.query，②罩不住它，必须在借出前验活；
 *      验活失败 → 丢弃整池重新借（最多 3 次）。
 *
 * 重试语义边界（为什么只重试 pool.query 一层）：
 *   · 事务体内的语句**不会**被自动重试 —— 连接在中途断掉后事务已回滚，
 *     盲目重放半段事务是错的；事务级别的重试必须由调用方按业务幂等性决定。
 *   · pool.query 的单语句重试只对「连接根本没建立/已断开」这类错误生效，
 *     此时语句**不可能已被服务端执行**（或执行结果未送达——本项目单语句写均幂等：
 *     INSERT IGNORE / 按 id UPDATE / 按唯一键 DELETE），风险可控。
 */
const mysql = require('mysql2/promise');

let raw = null; // 真·mysql2 池（模块级单例，跨调用复用）

/** 连接类（瞬时）错误判定：只有这类才允许重试，SQL 语义错误一律原样抛出 */
function isTransientConnError(e) {
  if (!e) return false;
  const code = e.code || '';
  if (
    code === 'PROTOCOL_CONNECTION_LOST' ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'EPIPE' ||
    code === 'ER_CON_COUNT_ERROR'
  ) return true;
  // 兜底：部分驱动版本不填 code，只在 message 里带「connection / socket」字样
  const msg = String(e.message || '');
  return /connection lost|socket (hang up|closed)|ECONN|ETIMEDOUT/i.test(msg);
}

function createRaw() {
  return mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PWD,
    database: process.env.DB_NAME,
    connectionLimit: 5,
    waitForConnections: true,
    charset: 'utf8mb4',
    timezone: '+08:00',
    dateStrings: true,
    // ① TCP 保活：容器冻结期间靠 keepalive 探测/维持连接，减少「拿到死连接」的概率
    enableKeepAlive: true,
    keepAliveInitialDelay: 8000,
    // ⚠️ connectTimeout 由 8000 降到 3000（2026-10-05 真机「网络异常」排查结论）。
    //   数据库在**同 VPC 内网**（172.17.0.15:3306），正常建连是百毫秒级；
    //   8s 是 mysql2 的保守默认值，在这里等于「一次坏连接要白等 8 秒」。
    //   而一次云函数调用要串行走 4~6 次查询（getContext → resolveClassId → getConfig
    //   → 写库），叠加 8s 超时 + 重试就顶满客户端 20s 上限（errCode -504005
    //   "invoking task timed out after 20 seconds" + 云端 FUNCTIONS_TIME_LIMIT_EXCEEDED）。
    //   3s 足够覆盖偶发慢，又能让失败快速暴露、走下方重试白名单快速重建连接池。
    //   ⚠️ 这里是**真源**（`cloudfunctions/common/db.js`），改完必须跑 `node scripts/sync-common.js`。
    connectTimeout: 3000
  });
}

/** 取当前池（懒建单例）；dropPool() 置空后下一次调用重建 */
function getRaw() {
  if (!raw) raw = createRaw();
  return raw;
}

/** 丢弃整池：里面的空闲连接已不可信；老池异步 end 兜底回收，不阻塞调用方 */
function dropPool() {
  const old = raw;
  raw = null;
  if (old && typeof old.end === 'function') {
    try { old.end().catch(() => {}); } catch (e) { /* 老池已死：忽略 */ }
  }
}

/**
 * 对外暴露的池。接口面与 mysql2 池一致（query / getConnection），
 * 上面包了两层瞬时错误防御；调用方（各云函数 / common/*）零改动。
 */
function getPool() {
  return {
    query: async (sql, args) => {
      try {
        return await getRaw().query(sql, args);
      } catch (e) {
        if (!isTransientConnError(e)) throw e;
        // ② 死连接重试一次：先丢整池再新建，保证重试用的必然是新连接
        dropPool();
        return getRaw().query(sql, args);
      }
    },
    getConnection: async () => {
      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        let conn = null;
        try {
          conn = await getRaw().getConnection();
        } catch (e) {
          lastErr = e;
          if (!isTransientConnError(e)) throw e;
          dropPool();
          continue;
        }
        try {
          // ③ 借出前验活：一条 ping 换「事务绝不开在死连接上」
          await conn.ping();
          return conn;
        } catch (e) {
          try { conn.release(); } catch (e2) { /* 连接已死：忽略 */ }
          lastErr = e;
          if (!isTransientConnError(e)) throw e;
          dropPool();
        }
      }
      throw lastErr;
    }
  };
}

module.exports = { getPool };
