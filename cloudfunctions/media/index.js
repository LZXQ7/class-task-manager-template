/**
 * 云函数：media —— 附件与内容安全（开发文档 8.2 #7 / 第 10、11、14 章）
 * action: attachList / deleteAttachment / markNoticeRead / publishNotice
 *         msgPublish / msgList / msgRead（班级文字通知：全体或指定成员、可选确认收到、在线文档链接）
 *         testRemind（向本人发一条值日提醒模板测试消息，验证订阅链路）
 *         appNoticePublish / appNoticeLatest / appNoticeSeen（更新公告：超管发、全员主页弹一次）
 * 校验链：云端魔数 → 大小 → 时长（音频）→ 异步送审（先审后显）
 *
 * 产品口径：值日照片凭证已下线（本工具只做值日提醒），故不再提供
 * registerUpload（照片登记）与 myPhotos（我的作品）。
 * attachList / deleteAttachment 保留，用于查看与清理历史遗留附件（含语音通知）。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const mm = require('music-metadata');
const { getPool } = require('./common/db');
const guard = require('./common/guard');
const week = require('./common/week');
const audit = require('./common/audit');
const { BizError, ok, fail } = require('./common/resp');

const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
const AUDIO_MAX_MS = Number(process.env.AUDIO_MAX_MS || 15000) + 2000; // 业务上限 15s + 2s 容差
const AUDIO_MIN_MS = 1000;

/** 魔数嗅探 */
function detectMime(buf) {
  if (!buf || buf.length < 12) return null;
  const b = buf;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (b.toString('ascii', 0, 3) === 'ID3') return 'audio/mpeg';
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) {
    if (b[1] === 0xf1 || b[1] === 0xf9) return 'audio/aac';
    return 'audio/mpeg';
  }
  if (b.toString('ascii', 4, 8) === 'ftyp') return 'audio/mp4';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
  return null;
}

async function downloadBuf(fileId) {
  const r = await cloud.downloadFile({ fileID: fileId });
  return r.fileContent;
}

async function tempUrl(fileId) {
  const res = await cloud.getTempFileURL({ fileIdList: [fileId] });
  const f = (res.fileList || [])[0];
  return (f && f.tempFileURL) || '';
}

/** 音频真实时长（music-metadata，最终裁决） */
async function audioDurationMs(buf) {
  try {
    const meta = await mm.parseBuffer(buf, null, { duration: true });
    if (meta && meta.format && meta.format.duration) return Math.round(meta.format.duration * 1000);
  } catch (e) {
    console.error('[media] parse duration failed', e && e.message);
  }
  return null;
}

const AUDIO_TYPES = ['audio/mpeg', 'audio/aac', 'audio/mp4', 'audio/wav'];

/* ------------------------------------------------------------
 * 通知图片（v0.7.14）：notice_msg.images JSON 列，最多 3 张、值为云存储 fileID。
 * 前端 chooseMedia 压缩后直传云存储（不走云函数中转，避开 60s 上限与 VPC 下载慢），
 * 云函数只收 fileID 白名单校验（必须 cloud:// 开头），防注入任意字符串/外链。
 * ------------------------------------------------------------ */
const NOTICE_MAX_IMAGES = 3;

/*
 * ⚠️ host 段必须允许「点号」（2026-09-26 修复）：真实 fileID 形如
 *    cloud://<envId>.636c-<envId>-<uin>/notice/1790…-0-2801.jpg
 * 环境串后面还有一段以 `.` 分隔的存储桶标识；早期写成 /^cloud:\/\/[\w-]+\/…/
 * 会让**每一张合法图片都判定为非法并静默丢弃**（images 存库为 NULL，
 * 前端「发布时有图、查看时无图」，且不报错）。
 * 现在的写法只要求：cloud:// 协议 + host（不含空白与斜杠）+ 至少一段路径。
 */
const FILEID_RE = /^cloud:\/\/[^\s/]+\/\S+$/;

/** payload.images → 存库值（JSON 字符串或 null）；非法项直接丢弃，超量报错 */
function normalizeNoticeImages(input) {
  if (input == null) return null;
  if (!Array.isArray(input)) throw new BizError(41001, '图片参数错误');
  if (input.length > NOTICE_MAX_IMAGES) throw new BizError(41001, '图片最多 ' + NOTICE_MAX_IMAGES + ' 张');
  const ids = input
    .map(s => String(s || '').trim())
    .filter(s => FILEID_RE.test(s));
  return ids.length ? JSON.stringify(ids) : null;
}

/** 库里的 images 值（JSON 字符串 / mysql2 已解析的数组 / NULL）→ fileID 数组 */
function parseNoticeImages(v) {
  if (!v) return [];
  try {
    const arr = typeof v === 'string' ? JSON.parse(v) : v;
    return Array.isArray(arr) ? arr.map(s => String(s)).filter(s => s.indexOf('cloud://') === 0).slice(0, NOTICE_MAX_IMAGES) : [];
  } catch (e) {
    return [];
  }
}

/* ============================================================
 * 班级通知（文字 + 在线文档链接 + 可选「确认收到」）
 * ------------------------------------------------------------
 * 与语音通知（notice 表）完全分开：那张表 audio_id NOT NULL、首页还在读未读语音，
 * 混在一起两边都会互相污染。这里用 notice_msg / notice_msg_target / notice_msg_read。
 * ============================================================ */

/** thing 类关键词上限 20 字符，超长整条消息会发失败（与 cron-weekly 同一套规则） */
function cut20(s) {
  const t = String(s == null ? '' : s);
  return t.length <= 20 ? t : t.slice(0, 19) + '…';
}

/* ------------------------------------------------------------
 * 通知「接收人」口径 —— 全模块唯一来源，四类 scope 一律套用同一组条件：
 *   · status = ACTIVE
 *   · NOT_COUNSELOR  辅导员（group_tag='X'）不接收通知（只负责发布）
 *   · NOT_TEST       测试账号（学号 99 段，id 69+）不接收通知、不计入接收人数
 *   · 发布者本人永远不是接收人（分母/推送/目标表三处都要减掉）
 * 2026-09-26 需求②③：此前 COMMITTEE（仅发班委）漏了 NOT_TEST ——
 * 「测试管理员」role=ADMIN、is_super=0、不是 X 组，于是被当成了真实班委收件人。
 * ------------------------------------------------------------ */
const TEST_NO_PREFIX = '2608057499';
const NOT_TEST = "student_no NOT LIKE '" + TEST_NO_PREFIX + "%'";
const IS_TEST = "student_no LIKE '" + TEST_NO_PREFIX + "%'";
const NOT_COUNSELOR = "group_tag <> 'X'";
const IS_COUNSELOR = "group_tag = 'X'";

/**
 * 通知模板的关键词字段名。必须与公众平台所选模板的关键词**数量与类型**一致，
 * 换模板只改环境变量、不动代码。
 *   TEMPLATE_NOTICE           订阅消息模板 ID（未配置 → 不推送，前端入口同步降级）
 *   TEMPLATE_NOTICE_F_TITLE   默认 thing1（通知标题，对应模板「日程主题」格）
 *   TEMPLATE_NOTICE_F_CONTENT 默认 thing5（通知内容，对应模板「备注」格）
 *   TEMPLATE_NOTICE_F_COURSE  默认 thing8（固定占位「班级通知」，对应模板「课程名称」格；微信要求覆盖全部关键词，缺格 47003）
 *   TEMPLATE_NOTICE_F_TIME    默认不传（模板带「时间」关键词才需要设，如 time3）
 */
const NOTICE_FIELDS = {
  title: process.env.TEMPLATE_NOTICE_F_TITLE || 'thing1',
  content: process.env.TEMPLATE_NOTICE_F_CONTENT || 'thing5',
  time: process.env.TEMPLATE_NOTICE_F_TIME || '',
  // 2026-09-27：通知与值日提醒共用同一模板（jU9_...，关键词 thing1/thing5/thing8）。
  // 微信要求 data 覆盖模板全部关键词，缺格直接 47003。通知没有课程，course 落固定占位「班级通知」。
  course: process.env.TEMPLATE_NOTICE_F_COURSE || 'thing8'
};

/**
 * 发布后逐个推送订阅消息。
 * 订阅消息是「一次性订阅」：用户同意一次 = 1 条额度，所以未授权 / 额度用尽（43101）
 * 是常态，静默计数即可，绝不能因此让发布本身失败。
 * @param {number[]} [classIds] 多班级：目标班级 id 列表（ALL/COMMITTEE 用）
 * @param {number} [excludeId] 排除的成员（发布者本人 —— 自己发的通知自己不接收）
 */
async function pushNoticeMsg(pool, title, content, scope, memberIds, classIds, excludeId) {
  const templateId = process.env.TEMPLATE_NOTICE;
  if (!templateId) return { skipped: true, reason: 'no template' };
  const args = [];
  let sql = "SELECT openid FROM member WHERE status = 'ACTIVE' AND openid IS NOT NULL";
  if (scope === 'PICK' || scope === 'COMMITTEE' || scope === 'POSITION') {
    if (!memberIds.length) return { skipped: true, reason: 'no receiver' };
    sql += ' AND id IN (' + memberIds.map(() => '?').join(',') + ')';
    args.push.apply(args, memberIds);
  } else {
    // 全班通知不推给辅导员（X 组）和测试账号（99 段）：辅导员负责发布不接收（2026-09-25 用户定）
    sql += ' AND ' + NOT_COUNSELOR + ' AND ' + NOT_TEST;
    // 多班级：ALL 限定目标班级
    if (Array.isArray(classIds) && classIds.length) {
      sql += ' AND class_id IN (' + classIds.map(() => '?').join(',') + ')';
      args.push.apply(args, classIds);
    }
  }
  // 发布者本人不接收自己发的通知（2026-09-26 需求②）
  if (Number(excludeId)) { sql += ' AND id <> ?'; args.push(Number(excludeId)); }
  const [rows] = await pool.query(sql, args);
  const f = NOTICE_FIELDS;
  let sent = 0, refused = 0, failed = 0;
  for (const r of rows) {
    const data = {};
    data[f.title] = { value: cut20(title) };
    data[f.content] = { value: cut20(content) };
    // 「课程名称」格：通知没有课程，必须覆盖全部关键词（缺格 47003），落固定占位
    if (f.course) data[f.course] = { value: cut20('班级通知') };
    if (f.time) data[f.time] = { value: week.nowStamp() };
    try {
      await cloud.openapi.subscribeMessage.send({
        touser: r.openid,
        templateId,
        page: process.env.TEMPLATE_NOTICE_PAGE || 'pages/notice/index',
        miniprogramState: process.env.TEMPLATE_NOTICE_STATE || 'formal',
        lang: 'zh_CN',
        data
      });
      sent += 1;
    } catch (e) {
      const code = Number((e && (e.errCode || e.errcode)) || 0);
      if (code === 43101) refused += 1;
      else {
        failed += 1;
        console.error('[media] notice push fail', code, String((e && e.errMsg) || e).slice(0, 160));
      }
    }
  }
  return { receivers: rows.length, sent, refused, failed };
}

const routes = {
  /** 附件列表（语音通知 / 历史遗留照片），签发临时 URL（7200s） */
  attachList: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const admin = guard.isAdmin(ctx.member);
      const bizType = payload.bizType === 'NOTICE_AUDIO' ? 'NOTICE_AUDIO' : 'DUTY_PHOTO';
      const bizId = Number(payload.bizId);
      const pool = getPool();
      const [atts] = await pool.query(
        `SELECT a.*, m.name AS uploaderName FROM attachment a JOIN member m ON m.id = a.uploader_id
          WHERE a.biz_type = ? AND a.biz_id = ? ORDER BY a.id`, [bizType, bizId]
      );
      const visible = atts.filter(a =>
        a.audit_status === 'PASS' ||
        (a.audit_status === 'AUDITING' && (admin || a.uploader_id === me.id))
      );
      if (!visible.length) return [];
      const res = await cloud.getTempFileURL({ fileIdList: visible.map(f => f.file_id) });
      const urlMap = {};
      (res.fileList || []).forEach(f => { urlMap[f.fileID] = f.tempFileURL || ''; });
      return visible.map(f => ({
        id: f.id,
        status: f.audit_status,
        url: urlMap[f.file_id] || '',
        durationMs: f.duration_ms,
        uploaderName: f.uploaderName,
        mine: f.uploader_id === me.id,
        createdAt: String(f.created_at).slice(0, 16)
      }));
    }
  },

  /** 删除附件：本人或管理员，DB + 云存储同步删（用于清理历史遗留附件） */
  deleteAttachment: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const admin = guard.isAdmin(ctx.member);
      const attachmentId = Number(payload.attachmentId);
      const pool = getPool();
      const [rows] = await pool.query('SELECT * FROM attachment WHERE id = ?', [attachmentId]);
      const att = rows[0];
      if (!att) throw new BizError(41001, '附件不存在');
      if (att.uploader_id !== me.id && !admin) throw new BizError(40003, '无权删除该附件');
      await pool.query('DELETE FROM attachment WHERE id = ?', [attachmentId]);
      try { await cloud.deleteFile({ fileList: [att.file_id] }); } catch (e) { /* 已删除则忽略 */ }
      return {};
    }
  },

  markNoticeRead: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const pool = getPool();
      await pool.query(
        'INSERT IGNORE INTO notice_read (notice_id, member_id) VALUES (?, ?)',
        [Number(payload.noticeId), me.id]
      );
      return {};
    }
  },

  /**
   * 测试提醒：向调用者本人发一条「值日提醒」模板的订阅消息，用于验证订阅链路。
   * 与 cron-weekly 的 remindDuty 用同一个模板（TEMPLATE_REMIND）和同一组关键词字段。
   * 发送结果（含 errCode）原样返回给前端，由前端弹窗回访「收到没」，未收到则引导重新授权。
   */
  testRemind: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      guard.requireBind(ctx);
      const templateId = process.env.TEMPLATE_REMIND;
      if (!templateId) return { sent: false, errCode: 0, errMsg: '模板未配置' };
      const f = {
        title: process.env.TEMPLATE_REMIND_F_TITLE || 'thing1',
        // 模板 YOUR_SUBSCRIBE_TEMPLATE_ID 实际含 thing1/thing5/thing8 三格：
        // 日程主题→thing1、备注→thing5、课程名称→thing8（由下方 env 把字段映射到对应关键词）。
        digest: process.env.TEMPLATE_REMIND_F_DIGEST || 'thing5',
        course: process.env.TEMPLATE_REMIND_F_COURSE || 'thing8'
      };
      const data = {};
      data[f.title] = { value: cut20('测试提醒') };
      data[f.digest] = { value: cut20('收到说明微信提醒已生效') };
      data[f.course] = { value: cut20('班级值日提醒') };
      try {
        await cloud.openapi.subscribeMessage.send({
          touser: ctx.openid,
          templateId,
          page: process.env.TEMPLATE_REMIND_PAGE || 'pages/duty/index',
          miniprogramState: process.env.TEMPLATE_REMIND_STATE || 'formal',
          lang: 'zh_CN',
          data
        });
        return { sent: true };
      } catch (e) {
        const code = Number((e && (e.errCode || e.errcode)) || 0);
        const raw = String((e && e.errMsg) || e || 'send fail');
        console.error('[media] testRemind fail', code, raw.slice(0, 200));
        // v0.7.25：把微信原始错误完整返回（之前 cut20 截成 20 字看不出原因）。
        // 最常见是 43101「用户未授权本模板」—— 换过模板 ID 后必须重新点「开启微信提醒」授权。
        return { sent: false, errCode: code, errMsg: raw.slice(0, 200) };
      }
    }
  },

  /** 管理员发布语音通知：录音 → 上传 → 校验（魔数+时长+大小）→ 建 notice */
  publishNotice: {
    auth: { needAdmin: true },
    handler: async (payload, ctx) => {
      const me = guard.requireAdmin(ctx);
      const fileId = String(payload.fileId || '');
      const clientDuration = Number(payload.durationMs) || 0;
      if (!fileId) throw new BizError(41001, '参数错误');
      const pool = getPool();
      const classId = guard.classIdOf(ctx);
      const cfg = await week.getConfig(pool, classId);

      let buf;
      try { buf = await downloadBuf(fileId); } catch (e) { throw new BizError(41002, '音频读取失败，请重录'); }
      if (buf.length > MAX_AUDIO_BYTES) {
        await cloud.deleteFile({ fileList: [fileId] });
        throw new BizError(41002, '语音文件超过 5MB 上限');
      }
      const realMime = detectMime(buf);
      if (!realMime || AUDIO_TYPES.indexOf(realMime) < 0) {
        await cloud.deleteFile({ fileList: [fileId] });
        throw new BizError(41002, '音频格式不符（仅支持小程序内录音的 mp3）');
      }
      const durationMs = (await audioDurationMs(buf)) || clientDuration;
      if (!durationMs || durationMs < AUDIO_MIN_MS) {
        await cloud.deleteFile({ fileList: [fileId] });
        throw new BizError(41004, '语音太短，请重新录制');
      }
      if (durationMs > AUDIO_MAX_MS) {
        await cloud.deleteFile({ fileList: [fileId] });
        throw new BizError(41003, '语音不能超过 ' + Math.round((AUDIO_MAX_MS - 2000) / 1000) + ' 秒');
      }

      const url = await tempUrl(fileId);
      const mc = await audit.mediaCheckAsync(ctx.openid, url, 1);
      const mode = audit.getMediaAuditMode();
      const status = mode === 'auto_pass' ? 'PASS' : 'AUDITING';
      const [att] = await pool.query(
        `INSERT INTO attachment (biz_type, biz_id, file_id, mime, real_mime, size, duration_ms, audit_status, audit_trace, uploader_id)
         VALUES ('NOTICE_AUDIO', 0, ?, 'audio/mpeg', ?, ?, ?, ?, ?, ?)`,
        [fileId, realMime, buf.length, durationMs, status, mc.traceId, me.id]
      );
      const [n] = await pool.query(
        'INSERT INTO notice (class_id, publisher_id, audio_id, duration_ms, week) VALUES (?, ?, ?, ?, ?)',
        [classId, me.id, att.insertId, durationMs, week.currentWeek({ term_start: cfg.termStart, total_weeks: cfg.totalWeeks })]
      );
      await pool.query('UPDATE attachment SET biz_id = ? WHERE id = ?', [n.insertId, att.insertId]);
      console.log(JSON.stringify({ fn: 'media', action: 'publishNotice', member: me.id, noticeId: n.insertId, durationMs }));
      return { noticeId: n.insertId, durationMs, auditStatus: status };
    }
  },

  /**
   * 发布班级通知（管理员）。
   *   scope=ALL       发给指定班级全体（默认本班；辅导员/超管可传 classIds 多班）
   *   scope=PICK      只发给指定成员（超管 / 普通班委[限本班]，写 notice_msg_target）
   *   scope=COMMITTEE 仅发班委（可传 classIds 选班；缺省=全部班级；超管 / 辅导员）
   *   scope=POSITION  按职位（positions，如 班长/副班长）跨班级（可传 classIds 限定；超管 / 辅导员）
   *   needAck=1       成员需在通知页点「收到」
   * 发布成功后逐个推订阅消息；没配模板 / 成员没授权都不影响发布结果。
   */
  msgPublish: {
    auth: { needAdmin: true },
    handler: async (payload, ctx) => {
      const me = guard.requireAdmin(ctx);
      const title = String(payload.title || '').trim().slice(0, 60);
      const content = String(payload.content || '').trim().slice(0, 2000);
      const linkUrl = String(payload.linkUrl || '').trim().slice(0, 500);
      const linkName = String(payload.linkName || '').trim().slice(0, 60);
      const needAck = payload.needAck ? 1 : 0;
      // 一次性弹窗（v1.0.5）：勾选后成员下次打开首页弹一次；每人每条一次，
      // 已读记在 notice_popup_seen（与超管的更新公告 app_notice_seen 完全隔离）。
      const popup = payload.popup ? 1 : 0;

      // 角色（§41 术语：管理员=ADMIN+SUPER；超管=仅 SUPER；辅导员=group_tag='X'）
      const isSuper = guard.isSuper(ctx.member);
      const isCounselor = ctx.member.group_tag === 'X';
      const isCommittee = !isSuper && !isCounselor && (ctx.member.role === 'ADMIN' || ctx.member.role === 'MONITOR');
      const myClassId = guard.classIdOf(ctx);

      let scope = payload.scope;
      if (!['PICK', 'COMMITTEE', 'POSITION'].includes(scope)) scope = 'ALL';
      // 权限口径（§41 重构）：
      //   超管：ALL/COMMITTEE/POSITION/PICK 全开放（可跨班）
      //   辅导员：ALL/COMMITTEE/POSITION（可跨班），不开放任意 PICK
      //   普通班委：仅本班，可发本班全体(ALL) 或 本班指定成员(PICK)，不可跨班 / 不可 COMMITTEE/POSITION
      if (isCommittee) {
        if (scope !== 'PICK') scope = 'ALL';
      } else if (isCounselor && scope === 'PICK') {
        scope = 'ALL';
      }

      const pool = getPool();
      /*
       * 目标班级（2026-09-26 需求④：「全体」= 发布者本班，绝不默认外溢到所有班级）
       *   · 普通班委：恒为本班，忽略 payload.classIds（防伪造越权）
       *   · 超管/辅导员：可跨班，但**必须由前端显式传 classIds**；缺省一律回退本班
       * 旧实现「classIds 缺省 = 全部启用班级」是本次事故根因 —— 前端默认 noticeAllClasses=true
       * 传空数组，后端就扩成了全体启用班级（截图里的「已选 2 个班级」）。
       * 现在要发多班，前端必须把「全部班级 / 各班」展开成显式 id 列表传过来。
       */
      let classIds = (Array.isArray(payload.classIds) ? payload.classIds : []).map(Number).filter(Boolean);
      const canCrossClass = isCounselor || isSuper;
      // v0.7.16：教职工只能发到自己被绑定的班级（staff_class），越界的 id 直接剔除
      if (isCounselor && !isSuper && classIds.length) {
        const allowed = await guard.staffClassIds(pool, ctx.member);
        classIds = classIds.filter(id => allowed.includes(id));
        if (!classIds.length) throw new BizError(40003, '目标班级不在你的教职工绑定范围内');
      }
      if (!canCrossClass || !classIds.length) classIds = [myClassId];
      // 无主班教职工（class_id=0）必须显式选班：兜底防「class_id IN (0)」空发
      if (isCounselor && !isSuper && !classIds[0]) throw new BizError(41001, '请先选择要发送的班级');
      // 校验班级存在，防止伪造 class_id 越权
      if (classIds.length) {
        const [valid] = await pool.query(
          'SELECT id FROM `class` WHERE is_active = 1 AND id IN (' + classIds.map(() => '?').join(',') + ')',
          classIds
        );
        classIds = valid.map(r => Number(r.id));
        if (!classIds.length) throw new BizError(41001, '没有可发送的班级');
      }

      let memberIds = (payload.memberIds || []).map(Number).filter(Boolean);

      // §42 隔离：测试账号（99 段）与辅导员（X 组）不接收通知。普通班委 PICK 再限本班，防越权选他班。
      // 前端 picker 已隐藏，后端再校验防绕过。
      if (scope === 'PICK' && memberIds.length) {
        const q = memberIds.map(() => '?').join(',');
        let badSql, badParams;
        if (isCommittee) {
          badSql = 'SELECT id FROM member WHERE id IN (' + q + ') AND (' + IS_COUNSELOR + ' OR ' + IS_TEST + ' OR class_id <> ?) LIMIT 1';
          badParams = memberIds.concat([myClassId]);
        } else {
          badSql = 'SELECT id FROM member WHERE id IN (' + q + ') AND (' + IS_COUNSELOR + ' OR ' + IS_TEST + ') LIMIT 1';
          badParams = memberIds;
        }
        const [bad] = await pool.query(badSql, badParams);
        if (bad.length) throw new BizError(41001, isCommittee ? '只能选择本班成员接收通知' : '测试账号与辅导员不接收通知，请重新选择');
      }

      // 「仅发班委」：role=ADMIN、非超管、非辅导员、非测试账号、已绑定、在职，可限定班级
      // 2026-09-26 需求③：补 NOT_TEST —— 此前漏了它，「测试管理员」(role=ADMIN, is_super=0, 非 X 组)
      // 被当成了真实班委收件人，出现在 target 表与接收人数里。
      if (scope === 'COMMITTEE') {
        const [cm] = await pool.query(
          "SELECT id FROM member WHERE role = 'ADMIN' AND is_super = 0 AND " + NOT_COUNSELOR + " AND " + NOT_TEST +
            " AND status = 'ACTIVE' AND openid IS NOT NULL AND class_id IN (" + classIds.map(() => '?').join(',') + ')',
          classIds
        );
        memberIds = cm.map(r => r.id);
      }

      // 「按职位」：positions 精确匹配职位（如 班长/副班长/学习委员…），可限定班级
      let positions = [];
      if (scope === 'POSITION') {
        positions = (Array.isArray(payload.positions) ? payload.positions : [])
          .map(s => String(s || '').trim()).filter(Boolean).slice(0, 20);
        if (!positions.length) throw new BizError(41001, '请选择职位');
        const phPos = positions.map(() => '?').join(',');
        const [pm] = await pool.query(
          "SELECT id FROM member WHERE status = 'ACTIVE' AND openid IS NOT NULL AND " + NOT_COUNSELOR + ' AND ' + NOT_TEST +
            ' AND position IN (' + phPos + ') AND class_id IN (' + classIds.map(() => '?').join(',') + ')',
          positions.concat(classIds)
        );
        memberIds = pm.map(r => r.id);
        if (!memberIds.length) throw new BizError(41001, '所选职位没有可接收的成员');
      }

      if (!content) throw new BizError(41001, '请填写通知内容');
      // 标题选填：订阅消息推送时若标题为空，用内容前 20 字或兜底文案
      const pushTitle = title || content.slice(0, 20) || '班级通知';
      if (linkUrl && !/^https:\/\//i.test(linkUrl)) throw new BizError(41001, '在线文档链接需要以 https:// 开头');
      if (scope === 'PICK' && !memberIds.length) throw new BizError(41001, '请至少选择一位接收成员');

      const cfg = await week.getConfig(pool, myClassId);
      // 单班通知 class_id = 该班（绝大多数情况 = 本班）；跨班 = 0（由 notice_msg_class 逐班记录）
      const noticeClassId = (scope !== 'PICK' && classIds.length === 1) ? classIds[0] : 0;
      const [ins] = await pool.query(
        `INSERT INTO notice_msg (class_id, publisher_id, title, content, images, link_url, link_name, scope, need_ack, popup, week)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [noticeClassId, me.id, title, content, normalizeNoticeImages(payload.images), linkUrl || null, linkName || null, scope, needAck, popup,
          week.currentWeek({ term_start: cfg.termStart, total_weeks: cfg.totalWeeks })]
      );
      const noticeId = ins.insertId;
      // 班级目标（ALL/COMMITTEE/POSITION 跨班时记录）
      if (scope !== 'PICK') {
        for (const cid of classIds) {
          await pool.query('INSERT IGNORE INTO notice_msg_class (notice_id, class_id) VALUES (?, ?)', [noticeId, cid]);
        }
      }
      if (scope === 'PICK' || scope === 'COMMITTEE' || scope === 'POSITION') {
        for (const mid of memberIds) {
          await pool.query('INSERT IGNORE INTO notice_msg_target (notice_id, member_id) VALUES (?, ?)', [noticeId, mid]);
        }
      }
      // 需求②：发布者本人不接收自己发的通知（订阅消息推送 + 接收人数分母都减掉自己）
      const push = await pushNoticeMsg(pool, pushTitle, content, scope, memberIds, scope === 'ALL' ? classIds : null, me.id);
      console.log(JSON.stringify({
        fn: 'media', action: 'msgPublish', member: me.id, classIds,
        role: isSuper ? 'super' : (isCounselor ? 'counselor' : (isCommittee ? 'committee' : 'admin')),
        noticeId, scope, positions, popup, push
      }));
      return { noticeId, push };
    }
  },

  /**
   * 通知列表：只返回「我可见的」（全体 + 指定到我），带「我是否已确认」与回执进度。
   *
   * 回执可见性（2026-09-25 需求②）：
   *   仅「发布这条通知的班委本人」与「超级管理员」可查看「多少人确认 + 确认人序号/名字」；
   *   其它班委（非发布人）与普通成员一律只看到内容（canSeeAck=false，ackList 为空）。
   *   这样「谁发的谁看回执」「超管看全部」，不会让无关班委窥到确认名单。
   *
   * 回执口径（2026-09-25 需求：发布者本人不计入回执）：
   *   确认按钮对发布者隐藏（isPublisher=true，前端不渲染），已收到统计的分母/分子
   *   都排除发布者本人 —— 56 人班级 → 显示 0/55。ackCount / recipientCount / ackList
   *   三处 SQL 都带 `member_id <> publisher_id`，历史数据（发布者点过确认）也一并纠正。
   */
  msgList: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const isSuper = guard.isSuper(ctx.member);
      const myClassId = guard.classIdOf(ctx);
      const isCounselor = guard.isCounselor(ctx.member);
      // 「仅发班委」通知对班委（role=ADMIN、非超管、非辅导员）与超管可见，且发布人自己恒可见
      const meIsCommittee = (ctx.member.role === 'ADMIN' && ctx.member.is_super !== 1 && ctx.member.group_tag !== 'X');
      const pool = getPool();
      // 多班级可见性：
      //   · 超管看全部；发布人看自己发的
      //   · scope=ALL → 班级命中（n.class_id=我的班，或 notice_msg_class 里含我的班）
      //   · scope=COMMITTEE/POSITION/PICK → notice_msg_target 里含我（COMMITTEE 兜底班委身份可看）
      // 辅导员例外（2026-09-26 需求②）：辅导员只负责发布、不接收通知，故**只看得见自己发的**。
      //   否则他 class_id=1，会被「本班全体」通知误伤（他本不该是收件人）。
      const counselorOnly = isCounselor ? 1 : 0;
      const [rows] = await pool.query(
        `SELECT n.id, n.title, n.content, n.images, n.link_url, n.link_name, n.scope, n.need_ack, n.popup, n.created_at,
                n.class_id, n.publisher_id,
                m.name AS publisherName,
                (r.member_id IS NOT NULL) AS acked,
                (ps.notice_id IS NOT NULL) AS popupSeen,
                (SELECT COUNT(*) FROM notice_msg_read x JOIN member xm ON xm.id = x.member_id
                  WHERE x.notice_id = n.id AND x.member_id <> n.publisher_id AND xm.group_tag <> 'X' AND xm.student_no NOT LIKE '2608057499%') AS ackCount,
          CASE n.scope
            WHEN 'ALL' THEN (SELECT COUNT(*) FROM member WHERE status = 'ACTIVE' AND id <> n.publisher_id AND group_tag <> 'X' AND student_no NOT LIKE '2608057499%' AND (class_id = n.class_id OR (n.class_id = 0 AND class_id IN (SELECT nc2.class_id FROM notice_msg_class nc2 WHERE nc2.notice_id = n.id))))
            WHEN 'COMMITTEE' THEN (SELECT COUNT(*) FROM member WHERE role = 'ADMIN' AND is_super = 0 AND group_tag <> 'X' AND student_no NOT LIKE '2608057499%' AND status = 'ACTIVE' AND openid IS NOT NULL AND id <> n.publisher_id)
            WHEN 'POSITION' THEN (SELECT COUNT(*) FROM notice_msg_target t WHERE t.notice_id = n.id AND t.member_id <> n.publisher_id)
            ELSE (SELECT COUNT(*) FROM notice_msg_target t WHERE t.notice_id = n.id AND t.member_id <> n.publisher_id)
          END AS recipientCount
     FROM notice_msg n
     JOIN member m ON m.id = n.publisher_id
     LEFT JOIN notice_msg_read r ON r.notice_id = n.id AND r.member_id = ?
     LEFT JOIN notice_popup_seen ps ON ps.notice_id = n.id AND ps.member_id = ?
    WHERE (? = 0 OR n.publisher_id = ?)
      AND (
            (? = 1)
            OR n.publisher_id = ?
            OR (n.scope = 'ALL' AND (n.class_id = ? OR n.class_id = 0 AND EXISTS (
                  SELECT 1 FROM notice_msg_class nc WHERE nc.notice_id = n.id AND nc.class_id = ?)))
            OR (n.scope IN ('COMMITTEE','POSITION','PICK') AND EXISTS (
                  SELECT 1 FROM notice_msg_target t WHERE t.notice_id = n.id AND t.member_id = ?))
            OR (n.scope = 'COMMITTEE' AND (? = 1))
          )
      AND NOT EXISTS (SELECT 1 FROM notice_msg_delete d WHERE d.notice_id = n.id AND d.member_id = ?)
      -- 只看「绑定之后」发布的通知：bind_time 是绑定时刻（存量成员上线时统一置基线），
      -- 发布早于绑定的（含历史测试通知）一律不显示（2026-09-25 用户定）
      AND n.created_at > COALESCE((SELECT bind_time FROM member WHERE id = ?), '2000-01-01')
    ORDER BY n.id DESC LIMIT 100`,
  [me.id, me.id, counselorOnly, me.id, isSuper ? 1 : 0, me.id, myClassId, myClassId, me.id, meIsCommittee ? 1 : 0, me.id, me.id]
);
      const out = [];
      for (const r of rows) {
        // 谁能看回执：发布人自己，或超级管理员
        const canSeeAck = (r.publisher_id === me.id) || isSuper;
        const isPublisher = r.publisher_id === me.id;
        let ackList = [];
        if (canSeeAck) {
          const [ackRows] = await pool.query(
            `SELECT mm.name, mm.student_no
               FROM notice_msg_read x JOIN member mm ON mm.id = x.member_id
              WHERE x.notice_id = ? AND x.member_id <> ? AND mm.group_tag <> 'X' AND mm.student_no NOT LIKE '2608057499%'
              ORDER BY mm.student_no`,
            [r.id, r.publisher_id]
          );
          ackList = ackRows.map(a => ({ name: a.name, seq: week.seqOf(a.student_no) }));
        }
        out.push({
          id: r.id,
          title: r.title,
          content: r.content,
          images: parseNoticeImages(r.images),
          linkUrl: r.link_url || '',
          linkName: r.link_name || '',
          scope: r.scope,
          needAck: !!r.need_ack,
          popup: !!r.popup,
          popupSeen: !!r.popupSeen,
          publisherName: r.publisherName,
          createdAt: String(r.created_at).slice(0, 16),
          acked: !!r.acked,
          ackCount: Number(r.ackCount) || 0,
          recipientCount: Number(r.recipientCount) || 0,
          canSeeAck: canSeeAck,
          isPublisher: isPublisher,
          ackList
        });
      }
      return out;
    }
  },

  /**
   * 删除「我收到的」某条通知（软删除，仅对自己生效）。
   * 仅能删除「我可见的」通知，防止越权标记他人删除。
   */
  msgDelete: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const noticeId = Number(payload.noticeId);
      if (!noticeId) throw new BizError(41001, '参数错误');
      const pool = getPool();
      const myClassId = guard.classIdOf(ctx);
      const isSuper = guard.isSuper(ctx.member);
      const [vis] = await pool.query(
        `SELECT n.id FROM notice_msg n
          WHERE n.id = ?
            AND ((? = 1)
                 OR n.publisher_id = ?
                 OR (n.scope = 'ALL' AND (n.class_id = ? OR (n.class_id = 0 AND EXISTS (
                       SELECT 1 FROM notice_msg_class nc WHERE nc.notice_id = n.id AND nc.class_id = ?))))
                 OR (n.scope IN ('COMMITTEE','POSITION','PICK') AND EXISTS (
                       SELECT 1 FROM notice_msg_target t WHERE t.notice_id = n.id AND t.member_id = ?)))`,
        [noticeId, isSuper ? 1 : 0, me.id, myClassId, myClassId, me.id]
      );
      if (!vis.length) throw new BizError(41001, '通知不存在或无权删除');
      await pool.query(
        'INSERT IGNORE INTO notice_msg_delete (notice_id, member_id) VALUES (?, ?)',
        [noticeId, me.id]
      );
      return {};
    }
  },

  /* ----------------------------------------------------------------
   * 回收站（2026-09-26 / v0.7.13 需求②）：删除是**软删除**（notice_msg_delete 加一行），
   * 所以「回收站」= 把这张表按 member_id 反查出来即可，**不需要再建表**；
   * 恢复 = 把这行删掉。全程只对「我自己」生效，不影响别人看不看得见。
   * ---------------------------------------------------------------- */

  /** 回收站列表：我删掉的通知（按删除时间倒序） */
  msgRecycleList: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const pool = getPool();
      const [rows] = await pool.query(
        `SELECT n.id, n.title, n.content, n.images, n.created_at, d.deleted_at, m.name AS publisherName
           FROM notice_msg_delete d
           JOIN notice_msg n ON n.id = d.notice_id
           JOIN member m ON m.id = n.publisher_id
          WHERE d.member_id = ?
            -- 与 msgList 同一道「绑定之后」过滤：发布早于绑定的，恢复出来也还是看不见，
            -- 放进回收站只会让人「恢复了却找不到」（2026-09-25 用户定的口径）
            AND n.created_at > COALESCE((SELECT bind_time FROM member WHERE id = ?), '2000-01-01')
          ORDER BY d.deleted_at DESC, n.id DESC LIMIT 50`,
        [me.id, me.id]
      );
      return rows.map(r => ({
        id: r.id,
        title: r.title,
        content: r.content,
        images: parseNoticeImages(r.images),
        publisherName: r.publisherName,
        createdAt: String(r.created_at).slice(0, 16),
        deletedAt: String(r.deleted_at).slice(0, 16)
      }));
    }
  },

  /** 恢复：删掉 notice_msg_delete 里那一行（只影响我自己） */
  msgRestore: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const noticeId = Number(payload.noticeId);
      if (!noticeId) throw new BizError(41001, '参数错误');
      const pool = getPool();
      const [r] = await pool.query(
        'DELETE FROM notice_msg_delete WHERE notice_id = ? AND member_id = ?',
        [noticeId, me.id]
      );
      if (!r.affectedRows) throw new BizError(41001, '这条通知不在回收站里');
      return {};
    }
  },

  /**
   * 清空回收站（v0.7.16 需求⑤）：删掉**我自己**的全部软删行 —— 恢复语义同 msgRestore，
   * 只是数量为全部；不影响其它成员的可见性（notice_msg_delete 是按 member_id 隔离的）。
   * 前端有二次确认；恢复窗口随清空一起消失（清了就再也恢复不了）。
   */
  msgRecycleClear: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const pool = getPool();
      const [r] = await pool.query('DELETE FROM notice_msg_delete WHERE member_id = ?', [me.id]);
      return { cleared: r.affectedRows || 0 };
    }
  },

  /** 确认收到（幂等；need_ack=0 的通知也能写，前端只是不给按钮） */
  msgRead: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const noticeId = Number(payload.noticeId);
      if (!noticeId) throw new BizError(41001, '参数错误');
      const pool = getPool();
      const myClassId = guard.classIdOf(ctx);
      const isSuper = guard.isSuper(ctx.member);
      const [vis] = await pool.query(
        `SELECT n.id FROM notice_msg n
          WHERE n.id = ?
            AND ((? = 1)
                 OR n.publisher_id = ?
                 OR (n.scope = 'ALL' AND (n.class_id = ? OR (n.class_id = 0 AND EXISTS (
                       SELECT 1 FROM notice_msg_class nc WHERE nc.notice_id = n.id AND nc.class_id = ?))))
                 OR (n.scope IN ('COMMITTEE','POSITION','PICK') AND EXISTS (
                       SELECT 1 FROM notice_msg_target t WHERE t.notice_id = n.id AND t.member_id = ?)))`,
        [noticeId, isSuper ? 1 : 0, me.id, myClassId, myClassId, me.id]
      );
      if (!vis.length) throw new BizError(41001, '通知不存在或无权查看');
      await pool.query('INSERT IGNORE INTO notice_msg_read (notice_id, member_id) VALUES (?, ?)', [noticeId, me.id]);
      return {};
    }
  },

  /**
   * 标记「一次性弹窗」已看过（v1.0.5）：写 notice_popup_seen（每人每条一次）。
   * 纯个人状态 —— 写错只影响自己还看不看得到那一次弹窗，不改任何人的回执，
   * 所以不像 msgRead / msgDelete 那样校验「这条通知对我可见」。幂等（INSERT IGNORE）。
   */
  msgPopupSeen: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const noticeId = Number(payload.noticeId);
      if (!noticeId) throw new BizError(41001, '参数错误');
      const pool = getPool();
      await pool.query('INSERT IGNORE INTO notice_popup_seen (notice_id, member_id) VALUES (?, ?)', [noticeId, me.id]);
      return {};
    }
  },

  /**
   * 清空全部历史通知（仅超管；2026-09-25）。
   * 场景：开发期发的大量测试通知污染了所有人的通知列表。msgList 已按 bind_time
   * 只显示绑定后发布的（历史通知天然隐身），本动作用来把测试数据连根清掉。
   * 必须前端二次确认（payload.confirm=true）才执行，删除四张表全部行、不可恢复。
   */
  clearNotices: {
    auth: { needSuper: true },
    handler: async (payload, ctx) => {
      if (payload.confirm !== true) throw new BizError(41001, '缺少确认参数');
      // 2026-09-25 需求：清空入口只保留在「测试超管」（99 段）——真实超管不可清，防误删线上通知
      if (!/^2608057499/.test(String(ctx.member.student_no || ''))) {
        throw new BizError(41001, '仅测试超管可清空通知');
      }
      const pool = getPool();
      const [cnt] = await pool.query('SELECT COUNT(*) AS n FROM notice_msg');
      const total = Number(cnt[0].n) || 0;
      await pool.query('DELETE FROM notice_msg_read');
      await pool.query('DELETE FROM notice_msg_target');
      await pool.query('DELETE FROM notice_msg_delete');
      await pool.query('DELETE FROM notice_msg');
      console.log(JSON.stringify({ fn: 'media', action: 'clearNotices', total, member: ctx.member.id }));
      return { cleared: total };
    }
  },

  /* ---------- 更新公告（v0.7.25）：超管发、全员主页弹一次 ----------
   * app_notice（id/version/title/content/created_by/created_at）+ member.app_notice_seen。
   * 「仅展示一次」口径：seen 记录已读到的最新公告 id，弹窗关闭时只增不减（GREATEST）；
   * 不做历史回看（需求确认 2026-09-27）。公告不进订阅消息（一次性订阅额度留给值日提醒）。 */

  /** 发布更新公告（仅超管）。version ≤32 / title ≤64 / content ≤2000（与建表一致）。 */
  appNoticePublish: {
    auth: { needSuper: true },
    handler: async (payload, ctx) => {
      const me = guard.requireSuper(ctx);
      const version = String(payload.version || '').trim().slice(0, 32);
      const title = String(payload.title || '').trim().slice(0, 64);
      const content = String(payload.content || '').trim().slice(0, 2000);
      if (!version || !content) throw new BizError(41001, '版本号与正文不能为空');
      const pool = getPool();
      const [r] = await pool.query(
        'INSERT INTO app_notice (version, title, content, created_by) VALUES (?, ?, ?, ?)',
        [version, title, content, me.id]
      );
      console.log(JSON.stringify({ fn: 'media', action: 'appNoticePublish', member: me.id, noticeId: r.insertId, version }));
      return { noticeId: r.insertId };
    }
  },

  /** 最新一条更新公告 + 是否已读（needBind；任何人都能收到）。无公告返回 { notice: null }。 */
  appNoticeLatest: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const pool = getPool();
      const [rows] = await pool.query('SELECT id, version, title, content, created_at FROM app_notice ORDER BY id DESC LIMIT 1');
      if (!rows.length) return { notice: null };
      const n = rows[0];
      return {
        notice: {
          id: Number(n.id),
          version: n.version,
          title: n.title,
          content: n.content,
          createdAt: String(n.created_at).slice(0, 16),
          seen: Number(me.app_notice_seen || 0) >= Number(n.id)
        }
      };
    }
  },

  /** 标记已读（needBind）：只增不减，防旧弹窗把新公告标记回退。 */
  appNoticeSeen: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const id = Number(payload.noticeId);
      if (!id) throw new BizError(41001, '参数错误');
      const pool = getPool();
      await pool.query(
        'UPDATE member SET app_notice_seen = GREATEST(app_notice_seen, ?) WHERE id = ?',
        [id, me.id]
      );
      return {};
    }
  }
};

exports.main = async (event) => {
  let action;
  try {
    action = event && event.action;
    const route = routes[action];
    if (!route) return fail(41001, '未知操作');
    const payload = (event && event.payload) || {};
    const ctx = await guard.getContext();
    if (route.auth && route.auth.needBind) guard.requireBind(ctx);
    if (route.auth && route.auth.needAdmin) guard.requireAdmin(ctx);
    const data = await route.handler(payload, ctx);
    return ok(data);
  } catch (e) {
    if (e && e.errCode) return fail(e.errCode, e.errMsg, e.data);
    console.error('[media] unhandled', action, e);
    return fail(50000, '服务开小差了，请稍后重试');
  }
};
