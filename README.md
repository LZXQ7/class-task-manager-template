# Class Management Mini-Program Template (WeChat Mini-Program + CloudBase)

A ready-to-use **class-management** WeChat mini-program framework covering **duty rosters, scheduling (rotation / swap), class timetable, members & groups, and class notices**. The backend runs on **CloudBase (WeChat Cloud Development)** cloud functions + cloud database (TDSQL) + cloud storage; the frontend is a native WeChat mini-program (no UI framework).

This repository is a **generic template**: every environment-specific secret (CloudBase env ID, WeChat AppID, cloud-storage bucket, subscription template IDs, real class/teacher data) has been sanitized to a placeholder — replace them with your own deployment.

> 中文文档见 [README.zh-CN.md](./README.zh-CN.md).

---

## Features

- **Duty / chores** — auto-rotation by the actual class date, manual scheduling, temporary reschedule, swaps, and collapsing the finished current week.
- **Scheduling / rotation** — A/B group support, a persistent rotation cursor, and healthy staircase continuation.
- **Class timetable** — a built-in sample timetable (`data/timetable.js`, works offline / with no network); supports holidays and rescheduling.
- **Members & groups** — join via passcode / invite code, roster import, A/B groups, and staff isolation.
- **Class notices** — publish notices and optional subscription reminders (duty / notice); the template ID may be left empty and the feature degrades gracefully.
- **Permission model** — super-admin / counselor / monitor / life-monitor / committee / member, enforced by both the frontend `app.canXxx()` helpers and a backend `guard` layer.
- **AI (optional)** — the `ai-proxy` cloud function proxies an LLM; the key comes from an environment variable and degrades when absent.

---

## Tech Stack

| Layer | Technology |
| --- | --- |
| Frontend | Native WeChat mini-program (WXML / WXSS / JS), no framework |
| Backend | WeChat Cloud Development — CloudBase cloud functions (Node.js) |
| Database | CloudBase cloud database (MySQL / TDSQL compatible, via `common/db.js`) |
| Storage | CloudBase cloud storage (static assets such as icons) |
| Auth | WeChat openid silent login (`cloudfunctions/auth`) |

---

## Directory Structure

```
class-task-manager-template/
├── miniprogram/                # mini-program frontend
│   ├── app.js                  # cloud init + login; reads config.ENV_ID
│   ├── app.json / app.wxss
│   ├── project.config.json     # ⚠ replace appid with your mini-program AppID
│   ├── utils/
│   │   ├── config.js           # ★ main config (ENV_ID / version / timetable class / subscribe templates)
│   │   ├── request.js          # unified request layer (reads config.ENV_ID)
│   │   ├── icons.js            # cloud-storage icon references (⚠ replace cloud:// prefix)
│   │   ├── data/timetable.js   # sample timetable data (editable)
│   │   ├── guard / api / mem / notice / util / impersonate …
│   │   └── ...
│   ├── pages/                  # pages: home/duty/roster/timetable/timetable-apply/classes/bind/mine/notice/manual/doc/webview
│   ├── components/             # shared components (bottom-sheet / spring-scroll / skeleton …)
│   └── custom-tab-bar/         # custom TabBar
├── cloudfunctions/             # 12 cloud functions
│   ├── adjust/ auth/ audit-receiver/ class/ common/ course/
│   ├── cron-weekly/ duty/ export/ member/ media/ poster/ schedule/
│   └── (right-click each → "Upload and Deploy: Install Dependencies in the Cloud")
├── .gitignore
├── README.md
└── README.zh-CN.md
```

> `cloudfunctions/common/` is the "source of truth" for the shared module, synced into each function's copy. In this template it is already flattened — just deploy.

---

## Prerequisites

1. WeChat DevTools (stable channel).
2. A WeChat mini-program account, and its **AppID** (MP console → Development → Development Management → Development Settings).
3. An enabled **CloudBase (Cloud Development)** environment, and its **environment ID** (the `cloudbase-xxxx` string under the environment name).
4. (Optional) WeChat MP "Subscription Messages" templates for duty / notice reminders — the app still runs without them; related entries degrade gracefully.

---

## Quick Start

### 1. Import the project

Open the repo root in WeChat DevTools as a project. In `project.config.json`, change:

```json
"appid": "touristappid"
```

to your own mini-program **AppID** (keeping `touristappid` lets you open it in "tourist mode", but cloud features require a real AppID).

### 2. Configure frontend constants

Open `miniprogram/utils/config.js` and replace the placeholders:

```js
const ENV_ID = 'YOUR_CLOUDBASE_ENV_ID';   // ← your CloudBase environment ID
const SUBSCRIBE_TEMPLATE_ID = '';         // ← duty-reminder subscription template ID (may be empty)
const NOTICE_TEMPLATE_ID = '';            // ← class-notice subscription template ID (may be empty)
const APP_VERSION = '1.0.0';
const TIMETABLE_CLASS_ID = 3;             // ← class_id that the built-in sample timetable belongs to
```

`ENV_ID` is referenced by `app.js` / `request.js` centrally — change it in this one place.

### 3. Cloud-storage icon prefix

Every icon in `miniprogram/utils/icons.js` is a cloud-storage file ID:

```js
"cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/tab-home-off.svg"
```

Replace the whole `YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN` with your cloud-storage bucket's `envId.suffix-envId-uin` (the bucket name shown in DevTools → Cloud Development → Storage). Upload the SVGs referenced by `icons.js` into your own `icons/` directory, or point them at your own assets.

### 4. Deploy cloud functions

For each cloud-function directory (`cloudfunctions/*`): in WeChat DevTools, **right-click → Upload and Deploy: Install Dependencies in the Cloud**.

Then, in the **CloudBase console → Environment → Cloud Functions → Environment Variables** (or each function's `config.json` `envVariables`), set the database connection:

| Variable | Description |
| --- | --- |
| `DB_NAME` | your CloudBase environment ID (same as `ENV_ID`) |
| `DB_PWD` | database password (from the Cloud Development console → Database) |

> `cloudfunctions/auth/config.json` already contains a `DB_NAME` placeholder; the other functions can use the console-level environment variables (applied per environment).

### 5. Compile & preview

Click "Compile" in DevTools, then preview on a real device. On first use, join a class from "Mine / Bind" using a passcode or invite code.

---

## Enter your own data

- **Class / members**: a super-admin creates a class on the "Class" page and generates a join passcode / invite code; members join via "Bind". Bulk import is also supported (format shown in the scheduling page placeholder: `张三,20230101` or `专业B2002班,200105020201,李四,女`).
- **Duty / scheduling**: generate the rotation on the "Scheduling" page, adjust manually, or initiate a swap.
- **Timetable**: edit `miniprogram/data/timetable.js`'s `SEED_SESSIONS` (fields: `id/cid/name/teacher/room/day/period/group/weeks`), and point `config.js`'s `TIMETABLE_CLASS_ID` at that class; `HOLIDAYS` / `SHIFTS` are the holiday and reschedule seeds.

---

## Config reference (config.js)

| Field | Meaning |
| --- | --- |
| `ENV_ID` | CloudBase environment ID (the single source on the frontend) |
| `SUBSCRIBE_TEMPLATE_ID` | duty-reminder subscription template ID; empty = degrade |
| `NOTICE_TEMPLATE_ID` | class-notice subscription template ID; empty = degrade |
| `APP_VERSION` | public version number; bump before releasing |
| `TIMETABLE_CLASS_ID` | class id that the built-in timetable belongs to |

---

## License

MIT
