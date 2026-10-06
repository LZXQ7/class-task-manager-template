/**
 * 业务 API 汇总（与 cloudfunctions/* 的 action 一一对应）
 */
const req = require('./request');

const C = (name, action) => (payload, opt) => req.call(name, action, payload, opt);

module.exports = {
  /* ---------- auth ---------- */
  login: () => req.call('auth', 'login', {}, { toast: false }),
  checkToken: C('auth', 'checkToken'),
  bind: C('auth', 'bind'),
  /** 教职工一次性绑定码绑定（2026-09-26）：不校验学号、不查名单，码即凭证 */
  bindStaff: C('auth', 'bindStaff'),
  unbind: C('auth', 'unbind'),
  updateAvatar: C('auth', 'updateAvatar'),
  switchAccount: C('auth', 'switchAccount'),
  setBindOpen: C('auth', 'setBindOpen'),
  resolveScene: C('auth', 'resolveScene'),

  /* ---------- member ---------- */
  memberList: C('member', 'list'),
  memberStats: C('member', 'stats'),
  importCsv: C('member', 'importCsv'),
  importExcel: C('member', 'importExcel'),
  importBatches: C('member', 'importBatches'),
  revertImport: C('member', 'revertImport'),
  addMember: C('member', 'addMember'),
  /** 添加教职工（v0.7.16 起仅超管）：建 X 组全局账号（class_id=0）+ 返回一次性绑定码（明文只此一次）；classIds 可选=建号同时绑班 */
  addStaff: C('member', 'addStaff'),
  /** 生成 / 重发教职工绑定码（超管；仅未绑定的 X 组账号） */
  staffCode: C('member', 'staffCode'),
  /** 教职工列表（超管）：全局账号 + 每人绑定的 classIds，只回码状态不回码本身 */
  staffList: C('member', 'staffList'),
  /** 覆写教职工班级绑定（超管）：classIds 全量替换 staff_class 映射 */
  staffBindClasses: C('member', 'staffBindClasses'),
  /** 解除教职工微信绑定（超管）：清 openid 与绑定码，账号与班级绑定保留 */
  staffUnbind: C('member', 'staffUnbind'),
  /** 删除教职工账号（超管）：需先解除微信绑定；级联清 staff_class，备注保留 */
  staffDelete: C('member', 'staffDelete'),
  removeMember: C('member', 'removeMember'),
  updateGroup: C('member', 'updateGroup'),
  setMemberStatus: C('member', 'setStatus'),
  /** 仅改 role（超管专属）——v0.7.9 起前端不再有独立入口，保留作后端兜底/脚本用；
   *  日常「设为班委」走下面的 setMemberPosition（同时写 role + position） */
  setMemberRole: C('member', 'setRole'),
  /** 设置 / 取消班委（超管 + 辅导员）：position 为空串 = 取消班委 */
  setMemberPosition: C('member', 'setPosition'),
  unbindMember: C('member', 'unbind'),
  /** 成员备注（v0.7.16，仅教职工 + 超管可见）：辅导员的学生信息 / 家庭情况管理记录 */
  noteList: C('member', 'noteList'),
  noteSave: C('member', 'noteSave'),
  noteDelete: C('member', 'noteDelete'),
  /** 主页关注的学生（v0.7.17 需求⑥，仅教职工 + 超管）：pinList 取列表 / pinToggle 关注或取消 */
  pinList: C('member', 'pinList'),
  pinToggle: C('member', 'pinToggle'),

  /* ---------- course ---------- */
  courseListWeek: C('course', 'listWeek'),
  courseUpsert: C('course', 'upsert'),
  courseDelete: C('course', 'delete'),
  courseCopyFrom: C('course', 'copyFrom'),

  /* ---------- 青果课表导入（需求 D-2） ---------- */
  importTimetable: C('course', 'importTimetable'),
  applyTimetable: C('course', 'applyTimetable'),
  getApplyList: C('course', 'getApplyList'),
  downloadApply: C('course', 'downloadApply'),
  handleApply: C('course', 'handleApply'),
  // 🔍 临时自诊断（2026-10-05 排查「网络异常/-504005」）：返回 course 各阶段耗时。
  // ⚠️ 定位完成后，连同 course 的 diag action + __lap 计时一起删除。
  courseDiag: C('course', 'diag'),

  /* ---------- 个人课表（2026-10-06）：人人可编辑自己的课表，仅自己可见 ---------- */
  myTimetableList: C('course', 'myList'),
  myTimetableSave: C('course', 'mySave'),
  myTimetableDelete: C('course', 'myDelete'),
  myTimetableClear: C('course', 'myClear'),
  /** 选文件导入（青果 .xlsx）→ 我的课表；commit=false 只预览 */
  myTimetableImport: C('course', 'myImport'),
  /** 【班委】把我的课表发布到全班（覆盖式，后端会回滚值日标记） */
  myTimetablePublish: C('course', 'publishToClass'),
  /** 【一键同步】把本班课表整份拷成我的课表（覆盖式，人人可用） */
  myTimetableSync: C('course', 'syncFromClass'),

  /* ---------- 校历：节假日 / 调休 / 调课 ---------- */
  calendarList: C('course', 'calendar'),
  saveHoliday: C('course', 'saveHoliday'),
  removeHoliday: C('course', 'removeHoliday'),
  saveShift: C('course', 'saveShift'),
  removeShift: C('course', 'removeShift'),

  /* ---------- 临时调课（按周生效的课次例外） ---------- */
  shiftList: C('course', 'shiftList'),
  shiftSet: C('course', 'shiftSet'),
  shiftRemove: C('course', 'shiftRemove'),

  /* ---------- schedule ---------- */
  scheduleListWeek: C('schedule', 'listWeek'),
  scheduleManualBoard: C('schedule', 'manualBoard'),
  scheduleGenerate: C('schedule', 'generate'),
  scheduleReassign: C('schedule', 'reassign'),
  scheduleReassignUndo: C('schedule', 'reassignUndo'),
  scheduleAddManual: C('schedule', 'addManual'),
  scheduleRemove: C('schedule', 'remove'),
  scheduleClear: C('schedule', 'clear'),
  schedulePublish: C('schedule', 'publish'),
  scheduleUnpublish: C('schedule', 'unpublish'),
  scheduleGetRules: C('schedule', 'getRules'),
  scheduleSetRules: C('schedule', 'setRules'),

  /* ---------- 一键生成 · AI（DeepSeek） ---------- */
  scheduleAiPrompt: C('schedule', 'aiPrompt'),
  scheduleAiPlan: C('schedule', 'aiPlan'),
  scheduleAiApply: C('schedule', 'aiApply'),
  scheduleAiCheck: C('schedule', 'aiCheck'),

  /* ---------- AI 智能调课（只算不写库，落库走 shiftSet） ---------- */
  aiShiftPrompt: C('schedule', 'aiShiftPrompt'),
  aiShiftPlan: C('schedule', 'aiShiftPlan'),

  /* ---------- AI 设置（需求 D：自带密钥，跟随本人） ---------- */
  aiSettingGet: C('schedule', 'aiSettingGet'),
  aiSettingSave: C('schedule', 'aiSettingSave'),
  aiSettingTest: C('schedule', 'aiSettingTest'),
  aiSettingClear: C('schedule', 'aiSettingClear'),
  /** 列出可用模型（输入密钥后点「获取」，走 ai-proxy 的 /models） */
  aiSettingModels: C('schedule', 'aiSettingModels'),

  /* ---------- duty ---------- */
  dutyToday: C('duty', 'today'),
  dutyMyStats: C('duty', 'myStats'),
  dutyDetail: C('duty', 'detail'),
  dutyMyList: C('duty', 'myList'),
  noticeAudio: C('duty', 'noticeAudio'),

  /* ---------- adjust ---------- */
  swapCandidates: C('adjust', 'swapCandidates'),
  applySwap: C('adjust', 'applySwap'),
  applyLeave: C('adjust', 'applyLeave'),
  adjustListMine: C('adjust', 'listMine'),
  adjustPending: C('adjust', 'pendingList'),
  adjustConfirm: C('adjust', 'confirm'),
  adjustCancel: C('adjust', 'cancel'),
  /* 1.0.5 需求④：班委「请假登记」（成员与分组页） */
  leaveBoard: C('adjust', 'leaveBoard'),
  leaveSummary: C('adjust', 'leaveSummary'),
  leaveAdd: C('adjust', 'addLeave'),
  leaveCancel: C('adjust', 'cancelLeave'),

  /* ---------- media（仅语音通知相关；值日照片凭证已下线） ---------- */
  attachList: C('media', 'attachList'),
  markNoticeRead: C('media', 'markNoticeRead'),
  publishNotice: C('media', 'publishNotice'),

  /* ---------- 班级通知（文字 + 在线文档链接 + 可选确认收到） ---------- */
  msgPublish: C('media', 'msgPublish'),
  msgList: C('media', 'msgList'),
  msgRead: C('media', 'msgRead'),
  /** 标记「发布通知」附带的一次性弹窗已看过（v1.0.5，写 notice_popup_seen） */
  msgPopupSeen: C('media', 'msgPopupSeen'),
  msgDelete: C('media', 'msgDelete'),
  /* 回收站（v0.7.13 需求②）：软删除的是 notice_msg_delete 一行 → 列出 / 恢复；
     v0.7.16 需求⑤：清空 = 删我自己全部软删行（彻底移除，不可再恢复） */
  msgRecycleList: C('media', 'msgRecycleList'),
  msgRestore: C('media', 'msgRestore'),
  /* ---------- 更新公告（v0.7.25）：超管发、全员主页弹一次 ---------- */
  appNoticePublish: C('media', 'appNoticePublish'),
  appNoticeLatest: C('media', 'appNoticeLatest'),
  appNoticeSeen: C('media', 'appNoticeSeen'),
  msgRecycleClear: C('media', 'msgRecycleClear'),

  /* ---------- 测试提醒（向本人发一条值日提醒模板消息，验证订阅链路） ---------- */
  testRemind: C('media', 'testRemind'),
  clearNotices: C('media', 'clearNotices'),

  /* ---------- 重新授权微信提醒后清掉「额度耗尽」标记（v0.7.15，只写自己的行） ---------- */
  remindReopen: C('member', 'remindReopen'),

  /* ---------- 在线文档标题检测（走 ai-proxy 的公网出口，ai-proxy 是唯一能出公网的函数） ---------- */
  linkTitle: C('ai-proxy', 'title'),

  /* ---------- poster ----------
   * 「邀请同学」海报页已删除（2026-09-29），getInviteCode 一并移除；
   * getQrcode 仍被「查看班级」页的入班码弹层使用（classes/index.js），必须保留。 */
  getQrcode: C('poster', 'getQrcode'),

  /* ---------- export ---------- */
  weekCsv: C('export', 'weekCsv'),

  /* ---------- class（多班级 §43） ---------- */
  classList: C('class', 'list'),
  classDetail: C('class', 'detail'),
  classCreate: C('class', 'create'),
  classUpdate: C('class', 'update'),
  classSetActive: C('class', 'setActive'),
  classRandomToken: C('class', 'randomToken'),
  classDelete: C('class', 'delete')
};
