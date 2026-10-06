/**
 * 小程序端可配置常量（唯一来源）。
 * 改动这里即可，不要在页面里各写一份，否则上线时容易漏改。
 */

/**
 * 订阅消息模板 ID（值日提醒）。
 *
 * 当前模板：「日程提醒」（类目：信息查询）
 *   日程主题 {{thing1.DATA}} · 备注 {{thing5.DATA}} · 课程名称 {{thing8.DATA}}
 * 云函数 cron-weekly / media 经 env 映射一致（TEMPLATE_REMIND_F_TITLE=thing1 / F_DIGEST=thing5 / F_COURSE=thing8，已配）。
 * 云函数侧还要单独设环境变量 TEMPLATE_REMIND = 同一个模板 ID，见
 * docs/微信订阅消息接入指引.md。
 *
 * ⚠️ 留空时：所有「开启微信提醒」入口自动降级为提示文案，不会报错、不会弹授权框。
 */
const SUBSCRIBE_TEMPLATE_ID = '';

/** 被提醒的消息要跳转到的小程序页面 */
const SUBSCRIBE_PAGE = 'pages/duty/index';

/**
 * 订阅消息模板 ID（班级通知）。
 *
 * 与上面的「日程提醒」是两个模板：值日提醒是每日定时的日程类，
 * 班级通知是「谁发了什么」，需要在公众平台另选一个通知/公告类模板。
 * 选定后把 ID 填在这里，并在云函数 media 里配同一个值到环境变量 TEMPLATE_NOTICE，
 * 关键词字段名用 TEMPLATE_NOTICE_F_TITLE / _F_CONTENT / _F_COURSE / _F_TIME 覆盖（默认 thing1/thing5/thing8，
 * 与 REMIND 共用同一模板 YOUR_SUBSCRIBE_TEMPLATE_ID，须与模板关键词一致否则 47003）。
 *
 * ⚠️ 留空时：发布通知照常成功、成员也能在「首页 → 查看通知」里看到，
 *    只是不会弹微信服务通知；「开启通知提醒」入口自动降级，不会报错。
 */
const NOTICE_TEMPLATE_ID = '';

/** 通知提醒点开后落到的小程序页面 */
const NOTICE_PAGE = 'pages/notice/index';

/**
 * 对外版本号（唯一来源，发版前先改这里）。
 * 「我的 → 关于」弹层展示（pages/mine）；超管「发送更新公告」的版本号也自动取此值。
 * 此前硬编码在 index.wxml，属双源隐患，已收编于此。
 * 口径（2026-09-28 定）：**`1.0.4.1` 为开发批次**（囊括 v0.7.25 收尾之后的全部改动；其**后端已在线上生效，但前端此前一直未上传**）；
 * **`1.0.4.2` 为合并发布版** —— 一并把 1.0.4.1 的前端随版上传，并叠加本批新增（AI 接口预设 / 获取模型列表 / 设置弹层按钮并排 / 输入框与获取按钮观感修复）；
 * **`1.0.4.3`** 为后续功能新增版（整页递进载入动画封顶放宽至 st-7 + 「我的」页统计可点开值日明细「duty.myList」），已随本版部署 `duty` + 上传前端。
 * **`1.0.4.4`** 为体验修复版（2026-09-28）：课次时间按 5 班统一写入（DB 修正）；修「我的」页 myList 排序（按 day_of_week/period）；值日状态机补全「已值日 / 进行中」自动态（`common/week.js` `effectiveStatus`）；值日页同课次多人合并一行 + 移除导出（#27）；换班同意后值日页 / 首页 / 我的实时刷新（#28，脏标记 + onShow 强刷）。已随本版重部署 duty/schedule/adjust/export/course + 上传前端。后续**新加功能**时再 bump（1.0.5、1.0.6…）。热修小补丁用 `1.0.x.y` 三段式。
 * **`1.0.5`** = 新功能版（2026-09-29）：需求④「班委请假登记 + 在位统计」（adjust 三路由 leaveBoard/addLeave/cancelLeave、
 *   学生班委能力位 `canLeave`、`leave_request` 显式写 class_id、「成员与分组」页新增统计行与请假弹层）；
 *   同批修复①②③：安卓底栏贴屏幕底（无安全区兜底 32px）、`bottom-sheet` 内联 style 拼接漏 `;` 导致四个传 height 的弹层
 *   固定高度失效 / 长列表滚不动、`duty.myStats` 与 `myList` 口径分叉（「待值日 4 / 已结束 0」→ 与明细同源）。
 * 热修小补丁用 `1.0.x.y` 三段式。
 * 注意：对外版本号与 CHANGELOG 的内部迭代号（v0.7.x）是两套口径。
 */
const APP_VERSION = '1.0.0';

/**
 * 本地固化课表所属的班级（class_id）。
 * 课表数据写在 data/timetable.js，只有该班渲染真实课表；其余班一律走「课表待接入教务系统」空态。
 * 当前 = 示例班级C（用户口中的「3 班」，见 scripts/check-roster-parse.js 的 id↔name 映射）。
 *
 * ⚠️ 2026-10-06：随 class_id 重排迁移由 1 改为 3。
 * 旧值 1 是因为「小教示例班级C」当时占 class_id=1；重排后（学号段↔id 对齐）它是 class_id=3。
 * 本值必须与 `class` 表里 示例班级C的 id 一致，否则课表页会误判「本班无课表」而走空态
 * ——数据其实还在库里，只是被这道门挡住（症状：课表页只显示「课表待接入教务系统」）。
 * 改 class_id 前务必同步这里。
 */
const TIMETABLE_CLASS_ID = 3;

const ENV_ID = 'YOUR_CLOUDBASE_ENV_ID';

module.exports = { ENV_ID, SUBSCRIBE_TEMPLATE_ID, SUBSCRIBE_PAGE, NOTICE_TEMPLATE_ID, NOTICE_PAGE, APP_VERSION, TIMETABLE_CLASS_ID };
