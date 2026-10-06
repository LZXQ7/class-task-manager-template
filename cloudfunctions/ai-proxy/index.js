/**
 * 云函数：ai-proxy —— 访问公网大模型 API 的唯一出口
 * ============================================================
 * 为什么必须单独一个函数：
 *   本环境的主函数（course / schedule / duty …）都绑定了 VPC，而该 VPC 的路由表
 *   里没有任何 0.0.0.0/0 路由（也没有 NAT 网关），所以**绑定 VPC 的函数访问不了公网**。
 *   本函数刻意不绑定 VPC，自带公网出口，只负责把请求转发给 DeepSeek。
 *
 * 安全约定：
 *   ① 只有 ping 允许匿名调用，且只返回连通性结论，绝不回传密钥；
 *   ② chat 必须带上与 AI_PROXY_TOKEN 一致的共享令牌，令牌由 schedule 侧下发；
 *   ③ 密钥只存在于本函数的 DEEPSEEK_API_KEY 环境变量，任何响应都不包含它。
 *
 * 环境变量：
 *   DEEPSEEK_API_KEY    必填，DeepSeek 官方密钥（sk-…），作为「未自带密钥」时的兜底
 *   AI_PROXY_TOKEN      必填，与调用方 schedule 一致的共享令牌
 *   DEEPSEEK_BASE_URL   选填，默认 https://api.deepseek.com
 *   AI_TIMEOUT_MS       选填，默认 45000
 *
 * 需求 D（2026-09-27）：各班可自带密钥与接口地址。
 *   本函数**不绑 VPC ⇒ 连不到数据库**，所以 `ai_setting` 由 schedule 读出后
 *   通过 event.baseUrl / event.apiKey 传进来；本函数只负责**校验后使用**。
 *   ⚠️ 本函数是全环境**唯一有公网出口**的函数，任何「把上游响应原样回传」的行为
 *      都是一条**可被借道的内网探测通道** —— 自定义地址一律不回显响应体（闸③）。
 */

const DEFAULT_BASE = String(process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 45000);

/** 自定义接口地址允许的端口：只放行常见 HTTP(S) 端口，避免借道非常规端口 */
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);

const dns = require('dns').promises;

function ok(data) { return { errCode: 0, data }; }
function fail(errCode, errMsg) { return { errCode, errMsg, data: null }; }

/* ---------------- 在线文档标题检测（title action） ---------------- */

const TITLE_TIMEOUT_MS = 8000;   // 抓网页标题给短超时，别占满整个函数调用
const MAX_HTML_BYTES = 256 * 1024;

/** IPv4 是否内网 / 回环 / 链路本地 */
function isPrivateIp(ip) {
  if (ip === '::1' || ip === '::') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/** SSRF 基本防护：仅 http/https，且目标不得是内网 / 回环（IP 字面量直接判，域名解析后再判） */
async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch (e) { throw new Error('链接格式不正确'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('仅支持 http/https 链接');
  const host = u.hostname;
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) throw new Error('不允许访问内网地址');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    if (isPrivateIp(host)) throw new Error('不允许访问内网地址');
    return u;
  }
  let resolved;
  try {
    resolved = await dns.lookup(host);
  } catch (e) {
    throw new Error('域名解析失败');
  }
  if (isPrivateIp(resolved.address)) throw new Error('不允许访问内网地址');
  return u;
}

/**
 * 解析本次请求要用的接口地址（需求 D 三道闸，缺一不可）。
 *
 * 闸① 公网校验：复用 assertPublicUrl（仅 http/https + 内网 / 回环 / 链路本地直判
 *     + 域名 DNS 解析后复判）。
 * 闸② 禁带 query / hash：若允许 `?key=…`，密钥会进入 URL，而 fetch 失败时
 *     Node 会把完整 URL 写进 error.message，本函数又会把 e.message 打进日志
 *     ⇒ 等于把密钥写进日志。所以自定义地址一律不接受参数。
 * 闸③ （在调用处）自定义地址**不回显上游响应体**，只回状态码。
 *
 * @returns {{base:string, custom:boolean}} custom=true 表示用的是班级自带地址
 */
async function resolveEndpoint(raw) {
  const s = String(raw || '').trim().replace(/\/+$/, '');
  if (!s) return { base: DEFAULT_BASE, custom: false };
  if (/[?#]/.test(s)) throw new Error('接口地址不能带参数（? 或 #）—— 密钥拼在地址里会被日志记下');
  const u = await assertPublicUrl(s);
  if (!ALLOWED_PORTS.has(u.port)) throw new Error('接口端口不被允许（仅 80 / 443 / 8080 / 8443）');
  // 保留路径：兼容 `https://host/v1` 这类 OpenAI 兼容端点（拼接 /chat/completions）
  return { base: u.origin + (u.pathname && u.pathname !== '/' ? u.pathname : ''), custom: true };
}

/** 抓取网页并提取 <title>（只读前 256KB；拿到标题就提前停止） */
async function fetchDocTitle(raw) {
  const u = await assertPublicUrl(raw);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TITLE_TIMEOUT_MS);
  try {
    const res = await fetch(u.href, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClassAssist/1.0; +title-fetch)' },
      redirect: 'follow',
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error('链接返回 HTTP ' + res.status);
    const ct = String(res.headers.get('content-type') || '');
    if (ct && !/text\/html|application\/xhtml/i.test(ct)) {
      throw new Error('链接不是网页（' + ct.slice(0, 60) + '）');
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder('utf-8', { stream: true });
    let text = '';
    let total = 0;
    while (total < MAX_HTML_BYTES) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.length;
      text += dec.decode(chunk.value, { stream: true });
      // 必须等到闭合标签到齐再停 —— 只判断 <title 会在流块边界把 <title>…</title> 拦腰截断
      if (/<\/title\s*>/i.test(text)) break;
    }
    try { reader.cancel().catch(() => {}); } catch (e) { /* 忽略 */ }
    const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
    if (!m) throw new Error('页面里没有标题');
    const title = m[1].replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!title) throw new Error('标题为空');
    return title;
  } finally {
    clearTimeout(timer);
  }
}

/** 出网探测：只报告能否拿到 HTTP 响应，不泄露密钥（可带班级自带地址与密钥） */
async function ping(baseUrl, apiKey) {
  const ep = await resolveEndpoint(baseUrl);
  const key = String(apiKey || '').trim() || process.env.DEEPSEEK_API_KEY || '';
  const out = { base: ep.base, custom: ep.custom, hasKey: !!key, egress: 'fail', httpStatus: 0, error: '' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(ep.base + '/models', {
      headers: { Authorization: 'Bearer ' + (key || 'probe') },
      signal: ctrl.signal,
      redirect: ep.custom ? 'manual' : 'follow'
    });
    // 跟随跳转会绕过「解析后复判」的 SSRF 检查，自定义地址一律不接受跳转
    if (ep.custom && res.status >= 300 && res.status < 400) {
      out.error = '接口地址发生了跳转（HTTP ' + res.status + '），请直接填写最终地址';
      return out;
    }
    out.egress = 'ok';
    out.httpStatus = res.status;
  } catch (e) {
    out.error = String((e && e.message) || e).slice(0, 240);
  } finally {
    clearTimeout(timer);
  }
  return out;
}

/**
 * 列出接口的可用模型（OpenAI 兼容的 /models 端点）。
 * 用途：用户在「AI 排班设置」里填好密钥后点「获取」，把服务商提供的模型名拉回来选，
 *       避免手敲模型名拼写错。
 * 安全：同样走 resolveEndpoint（三道闸 + 禁跳转）；响应只取模型 id 列表，
 *       **不消耗额度、不泄露密钥**。自定义地址出错仍不回显响应体（闸③）。
 */
async function listModels(baseUrl, apiKey) {
  const ep = await resolveEndpoint(baseUrl);
  const key = String(apiKey || '').trim() || process.env.DEEPSEEK_API_KEY || '';
  const out = { base: ep.base, custom: ep.custom, models: [], count: 0, error: '' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(ep.base + '/models', {
      headers: { Authorization: 'Bearer ' + (key || 'probe') },
      signal: ctrl.signal,
      redirect: ep.custom ? 'manual' : 'follow'
    });
    // 跟随跳转会绕过「解析后复判」的 SSRF 检查，自定义地址一律不接受跳转
    if (ep.custom && res.status >= 300 && res.status < 400) {
      out.error = '接口地址发生了跳转（HTTP ' + res.status + '），请直接填写最终地址';
      return out;
    }
    if (!res.ok) {
      /*
       * 闸③（关键）：自定义地址**绝不回显上游响应体**。
       * 模型列表本身不敏感，但出错时把自定义地址的响应原文回传 = 开放内网探测通道。
       */
      if (ep.custom) {
        out.error = '接口返回 HTTP ' + res.status + '（自定义地址不回显响应内容，请核对地址与密钥）';
        return out;
      }
      out.error = '接口返回 HTTP ' + res.status + '：' + (await res.text()).slice(0, 180);
      return out;
    }
    let data;
    try { data = await res.json(); } catch (e) { out.error = '接口未返回合法 JSON'; return out; }
    const list = Array.isArray(data && data.data) ? data.data : [];
    const ids = list.map(m => (m && m.id) || '').filter(Boolean);
    // 去重 + 排序 + 限长（有的服务商会列出几百个，选择列表拖垮渲染）
    out.models = Array.from(new Set(ids)).sort().slice(0, 200);
    out.count = out.models.length;
  } catch (e) {
    if (e && e.name === 'AbortError') out.error = '接口响应超时';
    else out.error = (ep.custom ? '访问接口失败：' : '访问接口失败：') + String((e && e.message) || e).slice(0, 180);
  } finally {
    clearTimeout(timer);
  }
  return out;
}

exports.main = async (event) => {
  const action = event && event.action;

  if (action === 'ping') {
    try {
      return ok(await ping(event && event.baseUrl, event && event.apiKey));
    } catch (e) {
      return fail(41002, '接口地址校验未通过：' + String((e && e.message) || e).slice(0, 120));
    }
  }

  // 列出可用模型（输入密钥后点「获取」）：同样过三道闸，只回 id 列表
  if (action === 'models') {
    try {
      return ok(await listModels(event && event.baseUrl, event && event.apiKey));
    } catch (e) {
      return fail(41002, '接口地址校验未通过：' + String((e && e.message) || e).slice(0, 120));
    }
  }

  // 在线文档标题检测：发布通知粘贴链接时自动回填显示名。
  // 不走 AI_PROXY_TOKEN —— 它不调大模型，只做受 SSRF 防护保护的网页标题抓取。
  if (action === 'title') {
    const url = String((event && event.payload && event.payload.url) || '').trim();
    if (!url) return fail(41002, '缺少链接');
    try {
      return ok({ title: await fetchDocTitle(url) });
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (e && e.name === 'AbortError') return fail(41002, '链接响应超时');
      return fail(41002, '检测标题失败：' + msg.slice(0, 120));
    }
  }

  if (action !== 'chat') return fail(41001, '未知操作');

  // ---- 令牌校验 ----
  const expect = String(process.env.AI_PROXY_TOKEN || '');
  if (!expect) return fail(41003, 'AI 代理未配置共享令牌（AI_PROXY_TOKEN）');
  if (String((event && event.token) || '') !== expect) return fail(40003, '无权调用 AI 代理');
  // 接口地址与密钥：班级自带优先，缺省回落到平台环境变量。
  // 「能否回落」由 schedule 侧按身份决定（超管才可借平台额度），本函数只做兜底。
  let ep;
  try {
    ep = await resolveEndpoint(event && event.baseUrl);
  } catch (e) {
    return fail(41002, '接口地址校验未通过：' + String((e && e.message) || e).slice(0, 120));
  }
  const apiKey = String((event && event.apiKey) || '').trim() || process.env.DEEPSEEK_API_KEY || '';
  if (!apiKey) {
    return fail(41004, ep.custom ? '未配置密钥' : 'AI 代理未配置密钥（DEEPSEEK_API_KEY）');
  }

  // 兜底限长：调用方漏传 max_tokens 时不能放任上游用默认 4096 —— 函数间调用
  // 只有 55s，长回答必超时。调用方显式传了就尊重调用方。
  const body = Object.assign({ max_tokens: 2000 }, (event && event.body) || {});
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ep.base + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
      // 跟随跳转会绕过「DNS 解析后复判」的 SSRF 检查（可 302 到内网），自定义地址一律不跟
      redirect: ep.custom ? 'manual' : 'follow'
    });
    if (ep.custom && res.status >= 300 && res.status < 400) {
      return fail(40010, '接口地址发生了跳转（HTTP ' + res.status + '），请直接填写最终地址');
    }
    const text = await res.text();
    if (!res.ok) {
      /*
       * 闸③（关键）：自定义地址**绝不回显上游响应体**。
       * 本函数是全环境唯一有公网出口的函数，若把自定义地址的响应原文回传给调用方，
       * 就等于开放了一条「任意地址请求 + 内容回显」的内网探测通道。
       * 官方域名保留回显 —— 排查「密钥无效 / 模型名写错」必须看到上游提示。
       */
      if (ep.custom) {
        console.error('[ai-proxy] upstream(custom)', res.status, '(响应体已按安全策略省略)');
        return fail(40010, '接口返回 HTTP ' + res.status + '（自定义地址不回显响应内容，请核对地址与密钥）');
      }
      console.error('[ai-proxy] upstream', res.status, text.slice(0, 300));
      return fail(40010, 'DeepSeek HTTP ' + res.status + '：' + text.slice(0, 180));
    }
    let data;
    try { data = JSON.parse(text); } catch (e) { return fail(40010, 'DeepSeek 返回不是合法 JSON'); }
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) return fail(40010, 'DeepSeek 返回内容为空');
    return ok({ content, usage: data.usage || null, model: data.model || body.model || '' });
  } catch (e) {
    if (e && e.name === 'AbortError') return fail(40010, ep.custom ? '接口响应超时' : 'DeepSeek 响应超时');
    console.error('[ai-proxy] failed', e && e.message);
    return fail(40010, (ep.custom ? '访问接口失败：' : '访问 DeepSeek 失败：') + String((e && e.message) || e).slice(0, 180));
  } finally {
    clearTimeout(timer);
  }
};
