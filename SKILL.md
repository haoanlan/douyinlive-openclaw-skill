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

> 更新: 2026-05-25

## 概述

抖音直播间常驻监控 + 自动报告。后台守护进程持续运行，自动检测开播/下播，下播后生成分析报告并通过飞书推送。

## 架构

```
抖音直播间 ←WS→ douyinLive二进制 (1088端口, protobuf→JSON)
                        ↓
              monitor.js (守护进程)
              ├─ dbFlush() 每10秒 → MySQL
              │   ├─ streamers        主播信息
              │   ├─ sessions         直播场次
              │   ├─ danmaku          弹幕记录
              │   ├─ gifts            礼物记录
              │   ├─ members          进场记录
              │   └─ online_records   在线人数
              │
              ├─ 报告 → report-image.js → feishu-send.js → 飞书群
              │
              └─ 日志 → logs/daemon.log (带时间戳)
```

## 数据流

```
实时: 抖音 → douyinLive → monitor.js → dbFlush() → MySQL
报告: report-image.js → loadFromDb() → Playwright截图 → feishu-send.js
```

## 项目文件

### 核心
| 文件 | 用途 |
|------|------|
| `monitor.js` | 守护进程：WS连接、消息路由、dbFlush、开播/下播检测 |
| `db-mysql.js` | MySQL 连接池 + 建表 + CRUD |
| `report-image.js` | Playwright 截图生成直播报告 |
| `feishu-send.js` | 飞书 Open API 图片上传/发送 |

### 报告/榜单
| 文件 | 用途 |
|------|------|
| `thanks-rank.js` | 园区充电榜（单主题，旧版） |
| `thanks-rank-all.js` | 园区充电榜（多主题批量，**主力**） |
| `query-user-gifts.js` | 查询用户送礼明细 |
| `user-card.js` | 生成用户身份卡片（神秘人查询） |
| `merge-sessions.js` | 合并多个 session 数据 |

### 配置/二进制
| 文件 | 用途 |
|------|------|
| `runtime-config.json` | 房间号、检查间隔、飞书群 |
| `.env` | 数据库密码等敏感配置 |
| `config.yaml` | douyinLive 二进制配置 |
| `douyinLive-linux-amd64` | WS 代理 (v2.0.15, 1088端口) |

## 工作流

1. **启动**: `node monitor.js` → 读 `runtime-config.json` → spawn `douyinLive` → 连 WS
2. **等待开播**: 监听 `live_status` 事件
3. **开播**: `live: true` → 创建 session → 开始录制
4. **直播中**: 消息路由 handleMessage() → 内存 buffer → 每10秒 dbFlush()
5. **下播**: `live: false` → 30秒延迟确认 → 结束 session → 生成报告
6. **WS 断线**: 不结束 session，重连后自动恢复
7. **报告**: report-image.js → feishu-send.js → 飞书群图片
8. **循环**: 回到步骤 2

## 消息路由 (handleMessage)

| 消息类型 | 处理 |
|---------|------|
| `WebcastGiftMessage` | → gifts 表 |
| `WebcastChatMessage` | → danmaku 表 |
| `WebcastMemberMessage` | → members 表 |
| `WebcastRoomStatsMessage` | → online_records |
| `WebcastGroupLiveContainerChangeMessage` | PK 头像提取 (break, 不写 DB) |
| `WebcastFansclubMessage` | 不转发 (二进制限制) |
| `WebcastScreenChatMessage` | 不转发 (二进制限制) |
| 未知类型 | 打一次日志 `[daemon] ❓ 未处理消息类型:` |

## 进程管理

| 操作 | 命令 |
|------|------|
| 启动 | `node monitor.js` |
| 状态 | `node monitor.js status` |
| 停止 | `node monitor.js stop` |
| 日志 | `tail -f logs/daemon.log` |

## 房间切换

```bash
# 编辑 runtime-config.json 的 room_id，重启
node monitor.js stop
node monitor.js
```

## MySQL 表结构

### streamers
id, name(UNIQUE), room_id, avatar

### sessions
id, streamer_id(FK), room_title, start_time, end_time, duration_seconds, stats_*, archived

### gifts
id, session_id(FK), msg_id, nickname, avatar, to_nickname, to_avatar, gift_name,
diamond_count, repeat_count, total_diamonds, user_display_id, user_sec_uid,
trace_id, combo_count, repeat_end, group_count, send_type, create_time

### danmaku
id, session_id(FK), msg_id, nickname, avatar, content, user_display_id, user_sec_uid, create_time

### members
id, session_id(FK), msg_id, nickname, avatar, user_display_id, user_sec_uid, create_time

### online_records
id, session_id(FK), count, recorded_at

## 礼物连击去重

入库全量写，**加载时去重** (`comboDedupGifts` in report-image.js):
- 按 `(user_display_id||nickname, gift_name, to_nickname)` 分组
- combo_count 连续递增(1→2→3) → 同一连击
- 同值 + repeat_end=1 → 归入该组
- 每组保留 combo_count 最大的一条

## 感谢榜 (thanks-rank-all.js)

多主题园区充电榜，Playwright 截图生成:
```
node thanks-rank-all.js   # 批量生成5主题 × 4张图
```

配置说明:
- 5 个主题: blue/pink/red/gold/green
- 每个主题有完整的颜色令牌 (LIGHT_TOKENS / DARK_TOKENS)
- 粉色有 CSS `::after` 花瓣装饰
- 主函数遍历 THEMES 对象，改 `for...of` 的范围控制生成哪些主题
- 图片输出到 `reports/thanks_rank_{theme}_p{1-4}.jpg`
- 500px 卡片宽度，600×800 截图

## douyinLive 二进制 (v2.0.15)

- 1088 端口，Go 编译
- WS 地址: `ws://127.0.0.1:1088/ws/{room_id}`
- 启动参数: `--unknown --log-level debug`
- `--unknown` 对未知消息**只打方法名+长度**，不输出 payload
- 配置文件: `config.yaml`

### 已知不支持的消息类型
- WebcastScreenChatMessage (飘屏)
- WebcastFansclubMessage (星守护)
- WebcastGroupLiveMemberChangeMessage (团播成员变更，需更新 proto)
- 等团播相关消息

## WS Dump 调试

monitor.js 内置 dump: `reports/ws_dump.jsonl`
- 过滤: Fansclub / ScreenChat / HotChat / GroupLiveContainer
- 用于排查未处理消息类型
- 全量 dump 已关闭（按需临时开启）

## report-image.js CLI

```bash
node report-image.js                    # 默认报告
node report-image.js --to "主播名"      # 收礼榜单
node report-image.js --user "用户名"    # 用户送礼明细
node report-image.js --all              # 全场礼物榜
node report-image.js --json             # 从 JSON 加载(非 MySQL)
```

## thanks-rank-all.js 配置

```js
// 主题切换: 改 activeTheme 或修改 main() 循环
const activeTheme = THEMES.pink;

// 只生成一个主题: 改 main() 里的 for 循环
for (const [tk, t] of [["pink", THEMES.pink]]) { ... }
```

## Skill 命令

| 用户说 | 动作 |
|--------|------|
| "开监控" | 启动守护进程 |
| "停监控" | 停止守护进程 |
| "监控状态" | MySQL 统计 + 进程状态 |
| "图片报告" | 生成 report-image 发飞书 |
| "XX的感谢榜" / "session XX的感谢榜" | 查 DB → 改 thanks-rank-all.js sessionId/target → 生成 4 张图 → 飞书 API 私发 |
| "查神秘人XXX" | 查 gifts/danmaku/members 取 secUid → user-card.js → 发飞书 |
| "XX的礼物榜单" | report-image.js --to "XX" |
