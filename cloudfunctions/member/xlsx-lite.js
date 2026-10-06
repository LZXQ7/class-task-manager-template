/**
 * 极简 xlsx 读取（零第三方依赖）
 * ------------------------------------------------------------
 * 为什么不用第三方库：云函数依赖在部署时安装/打包，多一个依赖就多一层失败面；
 * xlsx 本质是 zip（deflate）+ XML，Node 自带的 zlib 够用。
 *
 * 输入：xlsx 文件的 Buffer
 * 输出：[{ name: 工作表名, rows: [[cell, cell, ...], ...] }]
 *
 * 支持：sharedStrings（t="s"）、inlineStr、str、布尔、数值、公式的缓存值 <v>
 * 不支持：.xls（旧二进制格式）、宏、ZIP64、加密工作簿
 */
const zlib = require('zlib');

/* ---------------- ZIP ---------------- */
function findEOCD(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function readEntries(buf) {
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error('不是有效的 xlsx（找不到 zip 结尾）');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    out.push({ name, method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function readEntry(buf, entry) {
  const lo = entry.localOff;
  if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== 0x04034b50) throw new Error('zip 本地头损坏');
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const raw = buf.slice(start, start + entry.compSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error('不支持的压缩方式: ' + entry.method);
}

/* ---------------- XML ---------------- */
function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');   // 必须最后：否则 &amp;lt; 会被二次解码
}

function colIndex(ref) {
  const m = /^([A-Z]+)/.exec(String(ref || ''));
  if (!m) return 0;
  let c = 0;
  for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
  return c - 1;
}

function allText(inner) {
  let text = '';
  const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let t;
  while ((t = tRe.exec(inner))) text += decodeXml(t[1]);
  return text;
}

function parseShared(xml) {
  const out = [];
  if (!xml) return out;
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) out.push(allText(m[1]));
  return out;
}

function parseSheet(xml, shared) {
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const inner = rm[1];
    const cells = [];
    const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cRe.exec(inner))) {
      const attrs = cm[1] || '';
      const body = cm[2] || '';
      const rMatch = /r="([A-Z]+\d+)"/.exec(attrs);
      const ci = rMatch ? colIndex(rMatch[1]) : cells.length;
      const tMatch = /t="([^"]+)"/.exec(attrs);
      const type = tMatch ? tMatch[1] : '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(body);
      let val = '';
      if (type === 's') {
        val = v ? (shared[Number(v[1])] || '') : '';
      } else if (type === 'inlineStr') {
        val = allText(body);
      } else if (type === 'b') {
        val = (v && v[1] === '1') ? 'TRUE' : 'FALSE';
      } else if (type === 'str') {
        val = v ? decodeXml(v[1]) : allText(body);
      } else {
        val = v ? decodeXml(v[1]) : '';
      }
      cells[ci] = val;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    rows.push(cells);
  }
  return rows;
}

/** 工作表名 + 目标路径（来自 workbook.xml 的 r:id → workbook.xml.rels） */
function parseWorkbook(wbXml, relsXml) {
  const sheets = [];
  const rels = {};
  let m;
  const relRe = /<Relationship\b([^>]*?)\/?>/g;
  while ((m = relRe.exec(relsXml))) {
    const id = (/Id="([^"]*)"/.exec(m[1]) || [])[1] || '';
    const target = (/Target="([^"]*)"/.exec(m[1]) || [])[1] || '';
    if (id) rels[id] = target;
  }
  const shRe = /<sheet\b([^>]*?)\/?>/g;
  while ((m = shRe.exec(wbXml))) {
    const attrs = m[1];
    const name = (/name="([^"]*)"/.exec(attrs) || [])[1] || '';
    const rid = (/r:id="([^"]*)"/.exec(attrs) || [])[1] || '';
    let target = rels[rid] || '';
    if (target) {
      if (target.charAt(0) === '/') target = target.slice(1);
      else target = 'xl/' + target;
    }
    sheets.push({ name: decodeXml(name), path: target });
  }
  return sheets;
}

/**
 * @param {Buffer} buf xlsx 文件内容
 * @returns {Array<{name:string, rows:Array<Array<string>>}>}
 */
function parseXlsx(buf) {
  if (!buf || !buf.length) throw new Error('空文件');
  const entries = readEntries(buf);
  const byName = {};
  entries.forEach(e => { byName[e.name] = e; });
  const read = (n) => (byName[n] ? readEntry(buf, byName[n]).toString('utf8') : '');
  const shared = parseShared(read('xl/sharedStrings.xml'));
  const infos = parseWorkbook(read('xl/workbook.xml'), read('xl/_rels/workbook.xml.rels'));
  const sheets = [];
  for (const s of infos) {
    if (!s.path) continue;
    const xml = read(s.path);
    if (!xml) continue;
    sheets.push({ name: s.name, rows: parseSheet(xml, shared) });
  }
  if (!sheets.length) throw new Error('工作簿里没有可读的工作表');
  return sheets;
}

/** 工作表 → 纯文本（每行用 \t 连接，便于复用名单解析器；空行丢弃） */
function sheetToText(sheet) {
  if (!sheet) return '';
  return (sheet.rows || [])
    .map(r => r.map(c => String(c == null ? '' : c).replace(/[\t\r\n]/g, ' ')).join('\t'))
    .filter(line => line.replace(/[\t\s]/g, '') !== '')
    .join('\n');
}

module.exports = { parseXlsx, sheetToText };
