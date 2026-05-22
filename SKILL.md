---
name: douyin-live
description: "抖音直播间常驻监控 + 自动报告。后台守护进程持续运行，自动检测开播/下播，下播后生成分析报告并通过飞书推送"
metadata:
  {
    "openclaw":
      {
        "emoji": "🎥",
        "requires": { "bins": ["node"] }
      }
  }
---
# douyin-live-monitor — 抖音直播监控 SKILL.md

## 概述

抖音直播间常驻监控 + 自动报告。后台守护进程持续运行，自动检测开播/下播，下播后生成分析报告并通过飞书推送。

## 当前架构

```
抖音直播间 ←WebSocket→ douyinLive服务(1088端口)
                               ↓
                    monitor.js (常驻守护进程, PID文件)
                    ├─ dbFlush() 每10秒 ← 数据直写 MySQL
                    │        ↓
                    │   MySQL 数据库 douyinlive
                    │   ├─ streamers     主播信息
                    │   ├─ sessions      直播场次/统计
                    │   ├─ danmaku       弹幕记录
                    │   ├─ gifts         礼物记录
                    │   ├─ members       进场记录
                    │   └─ online_records 在线人数时序
                    │
                    ├─ saveSession()   ← JSON 文件(可选, save_json)
                    │        ↓
                    │   current_session.json (symlink → streamers/<主播>/)
                    │
                    └─ 报告推送 → report-image.js(Playwright截图)
                                    ↓
                              feishu-send.js → 飞书群图片
```

## 数据流

```
实时: 抖音 → douyinLive → monitor.js
                          ├── dbFlush() 每10秒 → MySQL (主力)
                          └── saveSession() 仅 save_json=true → JSON文件

报告: report-image.js load()
      → 默认 MySQL (loadFromDb)
      → 可切 JSON (--json 参数)
      → Playwright 截图 → feishu-send.js → 飞书群
```

### 关键说明
- **数据持久化全靠 monitor.js 的 dbFlush()**，直接写 MySQL，无需中间层
- JSON 文件仅在 `runtime-config.json` 中 `save_json: true` 时写入，供备用查询
- `current_session.json` 是软链接，指向 `streamers/<主播名>/current_session.json`
- `report-image.js` 支持 `--json` 参数强制从 JSON 文件加载数据，不依赖 MySQL

## 核心文件

| 文件 | 用途 |
|------|------|
| `monitor.js` | 常驻守护进程，WebSocket 连接 douyinLive，dbFlush()直写 MySQL |
| `db-mysql.js` | MySQL 连接池 + 建表 + CRUD 操作封装 |
| `report-image.js` | Playwright 截图生成报告，默认 MySQL，支持 --json 回退 |
| `feishu-send.js` | 飞书图片上传/发送（tenant_access_token） |
| `douyin-user.js` | 通过 secUid 查抖音用户资料（抖音 API） |
| `user-card.js` | 生成用户身份卡片图片（神秘人查询用） |
| `runtime-config.json` | 房间号/检查间隔/save_json/飞书配置 |
| `douyinLive-linux-amd64` | WebSocket 代理二进制（1088端口） |
| `daemon.log` | 守护进程日志（心跳/开播/下播） |

## 工作流

1. **启动守护**：`node monitor.js`（从 runtime-config.json 读取 room_id）
2. **等待开播**：WebSocket 连接 douyinLive，监听 `live_status` 事件
3. **开播检测**：`live_status: true` → 创建 session，开始记录
4. **直播中**：monitor.js 收集数据至内存，每10秒 dbFlush() 直写 MySQL
5. **下播检测**：`live_status: false` → 30 秒延迟确认，期间有新数据（礼物/弹幕）自动取消 → 确认后结束 session → MySQL 标记结束
6. **WS 断线**：不立刻结束 session，重连后数据到达自动恢复录制
7. **报告推送**：确认下播后 monitor.js 调用 report-image.js → Playwright 生成图片 → feishu-send.js 发飞书群
8. **继续等待**：回到步骤 2

## 进程管理

| 操作 | 命令 | 说明 |
|------|------|------|
| 启动守护 | `node monitor.js` | 读取 runtime-config.json 的房间号 |
| 查看状态 | `node monitor.js status` | 返回 JSON：running, pid |
| 停止守护 | `node monitor.js stop` | 发送 SIGTERM，备份session文件 |
| 手动快照 | `node monitor.js snapshot` | 立即生成报告发飞书 |
| 手动图片 | `node monitor.js report-image` | 生成图片报告发飞书 |
| 日志查看 | `tail -f daemon.log` | 守护进程心跳/活动日志 |

### 开播心跳格式
```
[heartbeat] ⏺录制中=true ⏺已连接=true session=698/723
           └─正在录制    └─WS连接    └─弹幕/消息总数
```

### 未开播心跳格式
```
[daemon] 直播未开播，等待中... (直播间未开播)
```

## 房间切换

```bash
# 停止当前监控
node monitor.js stop
# 更新 runtime-config.json 中的 room_id
# 重启
node monitor.js
```

## MySQL 表结构

### streamers
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INT PK | |
| name | VARCHAR(255) UNIQUE | 主播名 |
| room_id | VARCHAR(100) | 房间号 |
| avatar | TEXT | 头像 URL |

### sessions
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INT PK | |
| streamer_id | INT FK | 关联 streamers |
| room_title | VARCHAR(255) | 直播标题 |
| start_time | DATETIME | 开播时间 |
| end_time | DATETIME NULL | 下播时间 |
| online_peak | INT | 在线人数峰值 |
| online_data | MEDIUMTEXT | 在线时序 JSON |

### gifts（完整字段）
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INT PK | |
| session_id | INT FK | 关联 sessions |
| msg_id | VARCHAR(100) | 消息去重 ID |
| nickname | VARCHAR(255) | 送礼人 |
| avatar | TEXT | 送礼人头像 |
| to_nickname | VARCHAR(255) | 收礼人 |
| to_avatar | TEXT | 收礼人头像 |
| to_user_display_id | VARCHAR(100) | 收礼人 displayId |
| to_user_sec_uid | VARCHAR(200) | 收礼人 secUid |
| gift_name | VARCHAR(255) | 礼物名 |
| diamond_count | INT | 单价 |
| repeat_count | INT | 数量 |
| total_diamonds | INT | 总价 |
| user_display_id | VARCHAR(100) | 送礼人 displayId |
| user_sec_uid | VARCHAR(200) | 送礼人 secUid |
| trace_id | VARCHAR(64) | 消息 traceId |
| combo_count | INT | 连击数 |
| repeat_end | TINYINT(1) | 终结帧标记 |
| group_count | INT | 分组数 |
| send_type | TINYINT(2) | 发送类型(1/4=连击 5=单次) |
| create_time | BIGINT | 时间戳 |

### danmaku
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INT PK | |
| session_id | INT FK | 关联 sessions |
| msg_id | VARCHAR(100) | 去重 ID |
| nickname | VARCHAR(255) | 用户名 |
| avatar | TEXT | 头像 |
| content | TEXT | 弹幕内容 |
| user_display_id | VARCHAR(100) | 用户 displayId |
| user_sec_uid | VARCHAR(200) | 用户 secUid |
| create_time | BIGINT | 时间戳 |

### members
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INT PK | |
| session_id | INT FK | 关联 sessions |
| nickname | VARCHAR(255) | 用户名 |
| avatar | TEXT | 头像 |
| user_display_id | VARCHAR(100) | 用户 displayId |
| user_sec_uid | VARCHAR(200) | 用户 secUid |
| create_time | BIGINT | 时间戳 |

## 飞书报告推送

使用 `feishu-send.js` 直接调用飞书 Open API（tenant_access_token）：
- 发送图片消息（`sendImage`）到飞书群
- 凭据从 `openclaw.json` 读取 app_id/app_secret
- 不经过 OpenClaw 的消息工具

## 房间/间隔配置

`runtime-config.json`：
```json
{
  "room_id": "72288034336",
  "check_interval_seconds": 30,
  "reconnect_delay_seconds": 10,
  "save_json": false,
  "feishu": { "chat_id": "oc_3eda7639e779aaa5f74493c09d2a1881" }
}
```

### douyinLive 二进制

WebSocket 代理服务 `douyinLive-linux-amd64`，独立运行（非 node.js）：
- 监听 1088 端口
- 接收 monitor.js 的连接请求：`ws://127.0.0.1:1088/ws/{room_id}`
- 配置 `config.yaml` 中的 cookie 和端口
- 注意：该二进制目前**不转发** `WebcastScreenChatMessage`（飘屏弹幕）、`WebcastPrivilegeScreenChatMessage`（特权飘屏）、`WebcastFansclubMessage`（星守护），需更新版本

## 礼物数据字段

douyinLive v2 WebSocket JSON 字段：
- `data.gift.diamond_count` — 每个礼物的钻石价格（⚠️ 核心！不是 `value`）
- `data.repeat_count` — 本次连击次数
- `data.gift.name` — 礼物名称

1 抖币 ≈ 0.1 元

## report-image.js CLI 用法（图片报告/榜单生成）

```bash
# 默认：生成当前 session 的直播报告，发飞书群
node report-image.js

# 生成送给某人的礼物榜单图片
node report-image.js --to "主播名"          # 发飞书群
node report-image.js --to "主播名" --output  # 仅保存图片，不发

# 生成某用户的礼物明细卡片
node report-image.js --user "用户名"        # 发飞书群
node report-image.js --user "用户名" --output

# 生成全场礼物榜单
node report-image.js --all
node report-image.js --all --highlight "用户名"  # 高亮某人

# 从 JSON 文件加载（而非 MySQL DB）
node report-image.js --json
```

> ⚠️ `--to` / `--all` / `--user` 默认从 MySQL 加载（`loadFromDb`），
> 会抓 `current_session.json` 对应 room 的最新 session。
> 如需指定 session，先用 `loadFromDb(sessionId)` 导出到 JSON 再加载。
>
> ⚠️ `feishu-send.js` 固定往飞书群发（`receive_id_type=chat_id`），不走 DM（open_id）。
> 需要发到当前对话（DM）时，用 `--output` 保存到文件，
> 再通过 `message` 工具（feishu channel）发送附件。

## user-card.js CLI 用法（神秘人查询/用户身份卡片）

```bash
# 查一个神秘人/用户，生成身份卡片发到飞书群
node user-card.js <secUid> [数据库昵称]

# 仅保存图片
node user-card.js <secUid> [数据库昵称] --output

# 示例
node user-card.js "MS4wLjABAAAAw8DUAThem2RNqRslz7IpLwJY0GzSJ-AG8VRSE4hQ77c" "神秘人954409" --output
```

卡片内容：头像 + 真名 + 原昵称标签 + 抖音号 + 粉丝/关注（SVG图标同行） + 签名

> 完整查神秘人流程见下方 Skill 命令表

## 连击去重逻辑（重要！）

礼物入库时**全量写入**（所有 WebSocket 帧都进 MySQL，不做任何过滤），
在**加载数据时**（`loadFromDb` / `loadJson`）做 combo 去重：

- 函数 `comboDedupGifts(gifts)`（位于 report-image.js）
- 按 `(user_display_id || nickname, gift_name)` 分组
- `comboCount` 连续递增(1→2→3) → 同一连击
- 同值+`repeatEnd` → 归入该组
- 每组只保留 comboCount 最大的那条（同值优先 repeatEnd）
- `--to` / `--user` / `--all` / 默认报告全部共享同一份 deduped 数据

## 礼物表字段（gifts）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INT PK | |
| session_id | INT FK | 关联 sessions |
| msg_id | VARCHAR(100) | 消息去重 ID |
| nickname | VARCHAR(255) | 送礼人 |
| avatar | TEXT | 送礼人头像 |
| to_nickname | VARCHAR(255) | 收礼人（连麦对打时有用） |
| gift_name | VARCHAR(255) | 礼物名 |
| diamond_count | INT | 单个礼物价格（钻） |
| repeat_count | INT | 本次连击次数 |
| total_diamonds | INT | 总价 = diamond × repeat |
| trace_id | VARCHAR(64) | 消息 traceId（去重 key） |
| combo_count | INT | 当前帧连击数 |
| repeat_end | TINYINT(1) | 是否连击终结帧 |
| group_count | INT | 礼物分组数 |
| send_type | TINYINT(2) | 发送类型（1/4=可连击 5=单次）|
| create_time | BIGINT | 消息时间戳 |

## Skill 命令（OpenClaw 交互）

| 用户说 | 触发动作 |
|--------|----------|
| "开监控" / "打开监控" | 启动守护进程（若未启动） |
| "停止监控" | 停止守护进程，结束当前 session |
| "监控状态" | 返回 MySQL 数据统计 + 进程状态 |
| "图片报告" | 生成 report-image 发飞书 |
| "XX的礼物榜单" / "XX的礼物榜" | 用 `--to "XX"` 生成收礼榜单（谁送给了XX） |
| "XX的礼物明细" / "XX的用户卡片" | 用 `--user "XX"` 生成用户送礼明细 |
| "全部礼物榜单" / "全场礼物榜" | 用 `--all` 生成全场礼物排名 |
| "查神秘人XXX" | ① 取 secUid：依次查 `gifts` → `danmaku` → `members` 三张表 `WHERE nickname LIKE '%XXX%'`，取最新一条非空 secUid → ② 汇总该 secUid 在数据库中的行为（送了啥/给谁/发了啥弹幕） → ③ `node user-card.js <secUid> "XXX" --output` → ④ message 工具发图片 + 行为摘要到当前对话 |
