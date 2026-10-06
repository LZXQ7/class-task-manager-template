> 中文文档。English version: [README.md](./README.md)

# 班级管理小程序模板（微信小程序 + CloudBase 云开发）

一个开箱即用的**班级管理**微信小程序框架，覆盖 **值班安排、排班（轮值/换班）、班级课表、成员与分组、班级通知** 等高频场景。后端基于 **CloudBase（微信云开发）** 的云函数 + 云数据库（TDSQL）+ 云存储，前端用原生微信小程序实现，无第三方框架依赖。

本仓库是**通用模板**：所有环境相关的敏感值（CloudBase 环境 ID、微信 AppID、云存储桶、订阅消息模板、真实班级/教师数据）均已脱敏为占位符，你可以替换成自己的部署。

---

## 功能特性

- **值班 / 值日**：按实际上课日期自动轮转、手动排班、临时调课、换班、本周值日折叠。
- **排班 / 轮值**：A/B 分组支持、轮转游标持久化、健康态阶梯接续。
- **班级课表**：本地内置示例课表（`data/timetable.js`，离线可用、断网也有），支持节假日 / 调课。
- **成员与分组**：绑定口令 / 邀请码加入、名册导入、A/B 分组、教职工隔离。
- **班级通知**：发布通知、订阅消息提醒（值日提醒 / 班级通知，模板 ID 可留空降级）。
- **权限模型**：超管 / 辅导员 / 班长 / 生活委员 / 班委 / 普通成员，前端 `app.canXxx()` + 后端 `guard` 双层门禁。
- **AI 接口（可选）**：云函数 `ai-proxy` 代理大模型，密钥走环境变量，缺省降级。

---

## 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | 原生微信小程序（WXML / WXSS / JS），无框架 |
| 后端 | 微信云开发 CloudBase 云函数（Node.js） |
| 数据库 | CloudBase 云数据库（MySQL/TDSQL 兼容，经 `common/db.js` 连接） |
| 存储 | CloudBase 云存储（图标等静态资源） |
| 鉴权 | 微信 openid 无感登录（`cloudfunctions/auth`） |

---

## 目录结构

```
class-task-manager-template/
├── miniprogram/                # 小程序前端
│   ├── app.js                  # 云开发初始化 + 登录；读 config.ENV_ID
│   ├── app.json / app.wxss
│   ├── project.config.json     # ⚠ 改 appid 为你的小程序 AppID
│   ├── utils/
│   │   ├── config.js           # ★ 主要配置（ENV_ID / 版本 / 课表班级 / 订阅模板）
│   │   ├── request.js          # 统一请求层（读 config.ENV_ID）
│   │   ├── icons.js            # 云存储图标引用（⚠ 改 cloud:// 前缀）
│   │   ├── data/timetable.js   # 示例课表数据（可改）
│   │   ├── guard / api / mem / notice / util / impersonate …
│   │   └── ...
│   ├── pages/                  # 页面：home/duty/roster/timetable/timetable-apply/classes/bind/mine/notice/manual/doc/webview
│   ├── components/             # 公共组件（bottom-sheet / spring-scroll / skeleton …）
│   └── custom-tab-bar/         # 自定义 TabBar
├── cloudfunctions/             # 12 个云函数
│   ├── adjust/ auth/ audit-receiver/ class/ common/ course/
│   ├── cron-weekly/ duty/ export/ member/ media/ poster/ schedule/
│   └── （每个函数右键「上传并部署：云端安装依赖」）
├── .gitignore
├── README.md
└── README.zh-CN.md
```

> `cloudfunctions/common/` 是各函数共享模块的“真源”，会被 `sync-common` 同步到各函数副本；模板里已是平铺副本，直接部署即可。

---

## 部署前置条件

1. 微信开发者工具（稳定版）。
2. 一个微信小程序账号，拿到 **AppID**（公众平台 → 开发 → 开发管理 → 开发设置）。
3. 开通 **CloudBase（云开发）** 环境，拿到 **环境 ID**（环境名称下方那串 `cloudbase-xxxx`）。
4. （可选）微信公众平台「订阅消息」模板，用于值日 / 通知提醒——不配也能跑，相关入口会自动降级。

---

## 快速开始

### 1. 导入项目

用微信开发者工具「导入项目」，目录选本仓库根目录。在 `project.config.json` 把：

```json
"appid": "touristappid"
```

改成你自己的小程序 **AppID**（保留 `touristappid` 也能以“游客模式”打开，但云能力需要真实 AppID）。

### 2. 配置前端常量

打开 `miniprogram/utils/config.js`，把占位符换成你的值：

```js
const ENV_ID = 'YOUR_CLOUDBASE_ENV_ID';   // ← 你的 CloudBase 环境 ID
const SUBSCRIBE_TEMPLATE_ID = '';         // ← 值日提醒订阅模板 ID（可留空）
const NOTICE_TEMPLATE_ID = '';            // ← 班级通知订阅模板 ID（可留空）
const APP_VERSION = '1.0.0';
const TIMETABLE_CLASS_ID = 3;             // ← 内置示例课表对应的 class_id
```

`ENV_ID` 已被 `app.js` / `request.js` 统一引用，改这一处即可。

### 3. 云存储图标前缀

`miniprogram/utils/icons.js` 里所有图标都是云存储文件 ID：

```js
"cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/tab-home-off.svg"
```

把 `YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN` 整体替换成你云存储桶的 `envId.suffix-envId-uin`（开发者工具「云开发 → 存储」里 bucket 名称即是）。你可以把本仓库 `icons.js` 引用的那些 SVG 上传到你自己的 `icons/` 目录，或改成自己的资源。

### 4. 部署云函数

对每个云函数目录（`cloudfunctions/*`）：在微信开发者工具里 **右键 → 上传并部署：云端安装依赖**。

然后在 **CloudBase 控制台 → 环境 → 云函数 → 环境变量**（或每个函数的 `config.json` 的 `envVariables`）设置数据库连接：

| 变量 | 说明 |
| --- | --- |
| `DB_NAME` | 你的 CloudBase 环境 ID（与 `ENV_ID` 一致） |
| `DB_PWD` | 数据库密码（在云开发控制台「数据库」处获取/设置） |

> `cloudfunctions/auth/config.json` 已内置 `DB_NAME` 占位；其余函数可通过控制台统一设置环境变量（对整个环境生效）。

### 5. 编译预览

开发者工具点「编译」，真机预览即可。首次使用在「我的 / 绑定」用口令或邀请码加入班级。

---

## 录入你自己的数据

- **班级 / 成员**：超管在「班级」页创建班级、生成绑定口令 / 邀请码；成员在「绑定」页输入加入。也可用「名册导入」批量录入（格式见排班页占位示例：`张三,20230101` 或 `专业B2002班,200105020201,李四,女`）。
- **值日 / 排班**：在「排班」页生成轮值、手动调整、发起换班。
- **课表**：修改 `miniprogram/data/timetable.js` 的 `SEED_SESSIONS`（字段：`id/cid/name/teacher/room/day/period/group/weeks`），并把 `config.js` 的 `TIMETABLE_CLASS_ID` 指向该班；`HOLIDAYS` / `SHIFTS` 为节假日与调课种子。

---

## 配置项速查（config.js）

| 字段 | 含义 |
| --- | --- |
| `ENV_ID` | CloudBase 环境 ID（前端唯一来源） |
| `SUBSCRIBE_TEMPLATE_ID` | 值日提醒订阅模板 ID，空 = 降级 |
| `NOTICE_TEMPLATE_ID` | 班级通知订阅模板 ID，空 = 降级 |
| `APP_VERSION` | 对外版本号，发版前改 |
| `TIMETABLE_CLASS_ID` | 内置课表对应的班级 id |

---

## License

MIT。可自由用于学习 / 二次开发，请保留原作者署名。
