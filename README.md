# 🎥 douyin-live — 抖音直播监控

> 抖音直播间常驻监控 + 自动报告。后台守护进程持续运行，自动检测开播/下播，下播后生成分析报告并通过飞书推送。

![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![Platform](https://img.shields.io/badge/platform-linux%20%7C%20amd64-blue)

---

## 功能

- **实时监控** — WebSocket 连接 douyinLive 代理，监听弹幕/礼物/进场/在线人数
- **自动录制** — 检测到开播自动开始记录，下播自动保存
- **数据持久化** — 每 10 秒直写 MySQL，弹幕、礼物、进场记录完整
- **图片报告** — Playwright 截图生成可视化直播报告
- **飞书推送** — 开播提醒、下播报告自动推送到飞书群
- **任意切换房间** — 改配置重启即可切换监控目标

## 架构

```
抖音直播间 ←WebSocket→ douyinLive代理(二进制, 1088端口)
                               ↓
                    monitor.js (常驻守护进程)
                    ├─ dbFlush() 每10秒 → MySQL
                    │   ├─ streamers     主播信息
                    │   ├─ sessions      直播场次/统计
                    │   ├─ danmaku       弹幕记录
                    │   ├─ gifts         礼物记录
                    │   ├─ members       进场记录
                    │   └─ online_records 在线人数时序
                    │
                    └─ 报告推送 → report-image.js(Playwright截图)
                                    ↓
                          feishu-send.js → 飞书群
```

## 快速开始

### 前置条件

- Node.js ≥ 18
- MySQL 数据库
- Chromium（report-image.js 截图用，Playwright 自动安装）

### 安装

```bash
# 克隆仓库
git clone https://github.com/haoanlan/douyinlive-openclaw-skill.git
cd douyinlive-openclaw-skill

# 安装依赖
npm install

# 安装 Playwright 浏览器
npx playwright install chromium
```

### 配置

#### 1. douyin cookie

复制 `config.example.yaml` 为 `config.yaml`，填入抖音 cookie：

```yaml
cookie:
  douyin: "你的抖音登录cookie"
port: "1088"
monitor:
  poll_interval: 15s
  notify_interval: 30s
```

> cookie 获取方式：浏览器登录抖音网页版 → F12 → Application → Cookies → 复制完整 cookie 字符串

#### 2. MySQL 数据库

在 `db-mysql.js` 顶部配置数据库连接：

```js
const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '密码',
  database: 'douyinlive',
  waitForConnections: true,
  connectionLimit: 10,
  timezone: '+08:00',
});
```

表结构会在首次启动时自动创建。

#### 3. 房间号

编辑 `runtime-config.json`：

```json
{
  "room_id": "72288034336",
  "check_interval_seconds": 30,
  "reconnect_delay_seconds": 10,
  "save_json": false,
  "exclude_hosts": [],
  "feishu": {
    "chat_id": "oc_xxx"
  }
}
```

#### 4. 飞书推送（可选）

`feishu-send.js` 使用飞书 Open API（tenant_access_token）发送图片消息。需在 `openclaw.json` 配置飞书应用的 `app_id` / `app_secret`。

## 使用

```bash
# 启动守护
node monitor.js

# 停止守护
node monitor.js stop

# 查看状态
node monitor.js status

# 手动生成报告（发到飞书群）
node report-image.js

# 手动生成报告（保存到本地）
node report-image.js --output

# 查看某人的礼物榜单
node report-image.js --to "主播名" --output

# 查看全场礼物榜单
node report-image.js --all --output

# 生成用户身份卡片
node user-card.js <secUid> --output

# WS 消息调试
node ws-debug.js <room_id>
```

## 消息处理

| 消息类型 | 处理方式 |
|---------|---------|
| `WebcastChatMessage` | 弹幕 → `danmaku` 表 |
| `WebcastGiftMessage` | 礼物 → `gifts` 表（含连击去重） |
| `WebcastMemberMessage` | 进场 → `members` 表 |
| `WebcastLikeMessage` | 点赞计数 |
| `WebcastSocialMessage` | 关注计数 |
| `WebcastRoomStatsMessage` | 在线人数时序 |
| `WebcastScreenChatMessage` | 飘屏弹幕（标记 `[飘屏]` 前缀） |
| `WebcastPrivilegeScreenChatMessage` | 特权飘屏（标记 `[飘屏]` 前缀） |
| `WebcastFansclubMessage` | 粉丝团状态通知（不记礼物） |

## 数据表

### gifts

| 字段 | 说明 |
|------|------|
| nickname | 送礼人 |
| gift_name | 礼物名（含限定版前缀自动合并） |
| diamond_count | 单价（钻） |
| total_diamonds | 总价 = 单价 × 数量 |
| to_nickname | 收礼人 |
| combo_count | 连击数 |
| repeat_end | 连击终结标记 |

礼物数据在加载时做连击去重，原始全量数据保留在 MySQL。

## 切换房间

```bash
node monitor.js stop
# 编辑 runtime-config.json 修改 room_id
node monitor.js
```

## 致谢

- [douyinLive](https://github.com/飘渺/fork) — WebSocket 代理二进制

## License

MIT
