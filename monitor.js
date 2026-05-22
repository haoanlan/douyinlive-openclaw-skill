#!/usr/bin/env node
/**
 * 抖音直播间监控 - 常驻守护脚本
 * 
 * 模式：
 *   --daemon <room_id>   常驻监控（默认），自动检测开播/下播，下播自动出报告
 *   stop                 停止守护进程（写 PID 文件）
 *   status               查看守护进程状态
 * 
 * 工作流：
 *   1. 连接 douyinLive WebSocket
 *   2. 监听 live_status 事件
 *   3. 开播 → 创建新 session，记录数据
 *   4. 下播 → 结束 session → 生成报告 → 推送飞书
 *   5. 断线重连，无限循环
 */
const { WebSocket } = require('ws');
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const db = require('./db-mysql.js');
const reportImg = require('./report-image.js');
const feishu = require('./feishu-send.js');

const DATA_DIR = __dirname;
const PID_FILE = path.join(DATA_DIR, 'monitor.pid');
const CONFIG_FILE = path.join(DATA_DIR, 'runtime-config.json');

// session 目录：默认根目录，知道主播名后切换到 <主播名>/ 子目录
let SESSION_DIR = DATA_DIR;
let SESSION_FILE = path.join(DATA_DIR, 'current_session.json');
let REPORT_FILE = path.join(DATA_DIR, 'pending_report.json');

/** 返回北京时间 (UTC+8) 的 ISO 8601 字符串 (带 +08:00) */
function cstISO() {
  const now = new Date();
  // 手动转 +8:00 时区
  const cst = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const iso = cst.toISOString().replace('Z', '+08:00');
  return iso;
}

/** CST 时间戳用于文件名 (例: 2026-05-11T21-35-38) */
function cstFileTimestamp() {
  const now = new Date();
  const cst = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return cst.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/** 设置主播目录 */
function setStreamerDir(authorName) {
  if (!authorName) return;
  const streamersDir = path.join(DATA_DIR, 'streamers');
  if (!fs.existsSync(streamersDir)) fs.mkdirSync(streamersDir, { recursive: true });
  const dir = path.join(streamersDir, authorName.replace(/[\\/:*?"<>|]/g, '_'));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  SESSION_DIR = dir;
  SESSION_FILE = path.join(dir, 'current_session.json');
  REPORT_FILE = path.join(dir, 'pending_report.json');
  // 根目录 symlink 保证兼容性
  const rootLink = path.join(DATA_DIR, 'current_session.json');
  try { fs.unlinkSync(rootLink); } catch(e) {}
  try { fs.symlinkSync(SESSION_FILE, rootLink); } catch(e) {
    // symlink 失败时复制一份
    try { fs.copyFileSync(SESSION_FILE, rootLink); } catch(e2) {}
  }
}

// 运行时统计
const stats = {
  danmakuUsers: {},
  giftUsers: {},
};

let ws = null;
let monitorRoomId = null;
let session = null;
let isShuttingDown = false;
let isRecording = false;      // 当前是否在录制中
let lastDataTime = null;       // 最后收到直播数据的时间

// WebSocket 原始消息日志
let _liveStopTimer = null;    // 停播延迟确认定时器
let daemonLoopInterval = null;

// MySQL 同步追踪（记录已同步到哪个索引）
let dbSyncState = { danmaku: 0, gifts: 0, members: 0, online: 0 };

let dbSessionId = null;
let pendingDbUpdates = [];  // dbSessionId 就绪前缓存的更新

/** 执行挂起的 DB 更新 */
function flushPendingDbUpdates() {
  if (!dbSessionId) return;
  const updates = pendingDbUpdates;
  pendingDbUpdates = [];
  for (const fn of updates) {
    fn(dbSessionId);
  }
}

// ====== 配置 ======
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch (e) { /* ignore */ }
  return {
    room_id: '72288034336',
    check_interval_seconds: 30,
    reconnect_delay_seconds: 10,
    save_json: false,
    feishu: { chat_id: 'oc_3eda7639e779aaa5f74493c09d2a1881' },
  };
}

// ====== Session 管理 ======
function createSession(roomId) {
  // 重置运行时统计
  stats.danmakuUsers = {};
  stats.giftUsers = {};

  // 有主播名时自动切换到子目录
  SESSION_DIR = DATA_DIR;
  SESSION_FILE = path.join(DATA_DIR, 'current_session.json');
  REPORT_FILE = path.join(DATA_DIR, 'pending_report.json');

  const s = {
    room_id: roomId,
    room_title: '',
    room_author: '',
    room_avatar: '',
    start_time: cstISO(),
    end_time: null,
    duration_seconds: 0,
    stats: { danmaku: 0, gift: 0, like: 0, member: 0, follow: 0, social: 0 },
    online: [],
    danmaku: [],
    gifts: [],
    members: [],
    topDanmakuUsers: [],
    topGiftUsers: [],
    rawMessages: [],
    toUserAvatars: {},
    _seenMembers: new Set(),
  };
  return s;
}

function saveSession() {
  if (!session) return;
  session.duration_seconds = Math.round(
    (new Date(session.end_time || Date.now()) - new Date(session.start_time)) / 1000
  );
  // 写 JSON 可选
  if (loadConfig().save_json) {
    try {
      fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), 'utf-8');
    } catch(e) { /* 忽略 JSON 写入错误 */ }
  }
}

/** 将内存中新增数据批量写入 MySQL */
async function dbFlush() {
  if (!session || !dbSessionId) return;
  try {
    // 弹幕
    const newDanmaku = session.danmaku.slice(dbSyncState.danmaku);
    if (newDanmaku.length > 0) {
      await db.insertDanmaku(dbSessionId, newDanmaku.map(d => ({
        msg_id: d.uid + '_' + d.time,
        nickname: d.nickname,
        avatar: d.avatar || '',
        content: d.content,
        userDisplayId: d.user_display_id || null,
        userSecUid: d.user_sec_uid || null,
        createTime: new Date(d.time).getTime()
      })));
      dbSyncState.danmaku = session.danmaku.length;
    }
    // 礼物
    const newGifts = session.gifts.slice(dbSyncState.gifts);
    if (newGifts.length > 0) {
      await db.insertGifts(dbSessionId, newGifts.map(g => ({
        msgId: g.uid + '_' + g.time,
        nickname: g.nickname,
        avatar: g.avatar || '',
        toNickname: g.to_nickname || '',
        toAvatar: g.to_avatar || session.toUserAvatars[g.to_nickname] || '',
        toUserDisplayId: g.to_user_display_id || null,
        toUserSecUid: g.to_user_sec_uid || null,
        giftName: g.gift_name,
        diamondCount: g.diamond_per_unit || 0,
        repeatCount: g.count || 1,
        totalDiamonds: g.total_diamonds || 0,
        userDisplayId: g.user_display_id || null,
        userSecUid: g.user_sec_uid || null,
        createTime: new Date(g.time).getTime(),
        traceId: g.traceId || null,
        comboCount: g.comboCount || 0,
        repeatEnd: g.repeatEnd !== undefined && g.repeatEnd !== null ? g.repeatEnd : null,
        groupCount: g.groupCount || 1,
        sendType: g.sendType !== undefined && g.sendType !== null ? g.sendType : null
      })));
      dbSyncState.gifts = session.gifts.length;
    }
    // 进场
    const newMembers = session.members.slice(dbSyncState.members);
    if (newMembers.length > 0) {
      await db.insertMembers(dbSessionId, newMembers.map(m => ({
        nickname: m.nickname,
        avatar: m.avatar || null,
        userDisplayId: m.user_display_id || null,
        userSecUid: m.user_sec_uid || null,
        createTime: m.time ? new Date(m.time).getTime() : Date.now()
      })));
      dbSyncState.members = session.members.length;
    }
    // 在线记录
    const newOnline = session.online.slice(dbSyncState.online);
    if (newOnline.length > 0) {
      for (const o of newOnline) {
        const dt = o.time;  // 已经是 ISO 格式 "2026-05-12T22:14:00.000+08:00"
        if (dt) {
          await db.getPool().query(
            'INSERT INTO online_records (session_id, count, recorded_at) VALUES (?, ?, ?)',
            [dbSessionId, parseInt(String(o.count), 10) || 0, dt]
          );
        }
      }
      dbSyncState.online = session.online.length;
    }
    // 更新 session 统计
    if (newDanmaku.length > 0 || newGifts.length > 0 || newMembers.length > 0) {
      const peak = session.online.length > 0 ? Math.max(...session.online.map(o => parseInt(String(o.count), 10) || 0)) : 0;
      await db.updateSessionStats(dbSessionId, {
        danmaku: newDanmaku.length,
        gift: newGifts.length,
        member: newMembers.length
      });
      await db.getPool().query(
        'UPDATE sessions SET stats_like = ?, stats_follow = ?, stats_social = ?, online_peak = ? WHERE id = ?',
        [session.stats.like || 0, session.stats.follow || 0, session.stats.social || 0, peak, dbSessionId]
      );
    }
  } catch(e) {
    // 不因 DB 错误中断主流程
    if (e.code !== 'ER_DUP_ENTRY') {
      console.error('[dbFlush] 错误:', e.message);
    }
  }
}

function finalizeSession() {
  if (!session) return;

  // Top 弹幕用户
  session.topDanmakuUsers = Object.entries(stats.danmakuUsers)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([nickname, count]) => ({ nickname, count }));

  // Top 送礼用户
  session.topGiftUsers = Object.entries(stats.giftUsers)
    .sort((a, b) => b[1].totalDiamonds - a[1].totalDiamonds)
    .slice(0, 10)
    .map(([nickname, d]) => ({
      nickname,
      count: d.count,
      totalDiamonds: d.totalDiamonds,
      gifts: d.giftNames?.join('、') || '',
    }));

  session.rawMessages.forEach(m => delete m._uniq);
  session.end_time = cstISO();
  saveSession();

  // 刷新 MySQL session 结束
  if (dbSessionId) {
    const start = new Date(session.start_time);
    const end = new Date(session.end_time);
    const dur = Math.round((end - start) / 1000);
    db.endSession(dbSessionId, dur, session.file_path || '').catch(e => {});
  }

  // JSON 备份（仅在 save_json 开启时）
  if (loadConfig().save_json) {
    const ts = cstFileTimestamp();
    const bakFile = path.join(SESSION_DIR, `session_${ts}.json`);
    try {
      fs.copyFileSync(SESSION_FILE, bakFile);
      console.log(`[session] 已备份: ${bakFile}`);
    } catch(e) {}
  }
}

// ====== 图片报告 ======
async function generateAndSendReport() {
  try {
    const data = await reportImg.load(monitorRoomId);
    if (!data) {
      console.error('[report] 无法加载 session 数据');
      return;
    }
    const config = loadConfig();
    const chatId = config.feishu?.chat_id || 'oc_3eda7639e779aaa5f74493c09d2a1881';

    // 生成直播报告图片
    const pngPath = await reportImg.generateImage(data);
    const sent = await feishu.sendImage(chatId, pngPath);
    if (sent) {
      console.log('[report] 图片报告已发送');
    } else {
      // 发送失败时记录路径
      console.error('[report] 图片发送失败');
    }
    try { fs.unlinkSync(pngPath); } catch(e){}
  } catch (e) {
    console.error('[report] 生成报告失败:', e.message);
  }
}

// ====== 用户提取 ======
function extractUser(data) {
  const user = data.user || data.userValue?.user || {};
  return {
    id: user.id || '',
    nickname: user.nickname || '匿名',
    avatar: (user.avatarThumb?.urlList?.[0]) || '',
  };
}

// ====== 消息处理 ======
function handleMessage(data) {
  const _method = data.common?.method || data.method || data.type || '';
  // gift日志已关闭（占空间）

  const method = data.common?.method || data.method || data.type || '';

  // 收到任何直播数据 → 取消延迟停播
  // 注意：data.type 是 WebSocket 框架 type，不是业务 method，用 method 判断
  if (_liveStopTimer && method) {
    clearTimeout(_liveStopTimer);
    _liveStopTimer = null;
  }

  // 能到达 handleMessage 的都是直播数据消息，全部更新最后数据时间
  if (method) lastDataTime = Date.now();

  switch (method) {
    case 'WebcastChatMessage': {
      session.stats.danmaku++;
      const user = extractUser(data);
      const rawUser = data.user || data.userValue?.user || {};
      const userDispId = rawUser.displayId || rawUser.id || user.id || '';
      const userSec = rawUser.secUid || '';
      const content = extractTextContent(data) || data.content || '';
      if (content) {
        session.danmaku.push({
          time: cstISO(),
          uid: user.id,
          nickname: user.nickname,
          avatar: user.avatar,
          user_display_id: userDispId,
          user_sec_uid: userSec,
          content,
        });
        stats.danmakuUsers[user.nickname] = (stats.danmakuUsers[user.nickname] || 0) + 1;
      }
      break;
    }

    case 'WebcastGiftMessage': {
      lastDataTime = Date.now();
      // gift_debug日志已关闭
      const user = extractUser(data);
      // 优先用 common.displayText 中的展示名称（含限定词如钻石、金色、真爱等），
      // 两种消息模式，礼物名的位置不同：
      //   live_gift_send_message_to_anyone_v3（送给型）: pieces[3] = 礼物名
      //   webcast_aweme_gift_send_message_v3（送出型）: pieces[1] = 礼物名
      let displayName = '';
      if (data.common?.displayText?.pieces) {
        const pieces = data.common.displayText.pieces;
        const pattern = data.common.displayText.defaultPattern || '';
        if (pattern.includes('送给') && pieces.length > 3) {
          // 送给型: {0:user} 送给{1} {2}个 {3:string}{4:image}
          const giftPiece = pieces[3];
          if (giftPiece && giftPiece.type === 1 && giftPiece.stringValue) {
            displayName = giftPiece.stringValue;
          }
        } else if (pattern.includes('送出') && pieces.length > 1) {
          // 送出型: {0:user} 送出{1:string}{2:image} {3:string}
          const giftPiece = pieces[1];
          if (giftPiece && giftPiece.type === 1 && giftPiece.stringValue) {
            displayName = giftPiece.stringValue;
          }
        }
      }
      // displayName 若不包含基础礼物名，则合并（如"金色限定"+"跑车"="金色限定跑车"）
      const baseName = data.gift?.name || data.giftName || '礼物';
      let giftName = displayName || baseName;
      if (displayName && !displayName.includes(baseName) && baseName !== '礼物') {
        giftName = displayName + baseName;
      }
      let diamondPerUnit = parseInt(String(data.gift?.diamondCount || 0), 10);
      // 礼物价格修正映射（douyinLive 二进制 protobuf 解析可能不准）
      const GIFT_PRICE_MAP = {
        '闪烁星河': 99,
        '点点星光': 9,
        '星光闪耀': 9,
        '闪耀星辰': 99,
        // 限定版礼物（displayText 取的名称，与 diamondCount 不同）
        '钻石跑车': 1500,
      };
      const fixedPrice = GIFT_PRICE_MAP[giftName];
      if (fixedPrice !== undefined) {
        diamondPerUnit = fixedPrice;
      }
      const repeatCount = parseInt(String(data.repeatCount || '1'), 10);

      // 全量记录，不过滤连击
      session.stats.gift++;
      const giftCount = repeatCount;
      const totalDiamonds = diamondPerUnit * giftCount;
      const toUser = data.toUser;
      const to_nickname = toUser && toUser.nickname ? toUser.nickname : '';
      const to_avatar = toUser?.avatarThumb?.urlList?.[0] || '';
      const toUserDisplayId = toUser?.displayId || '';
      const toUserSecUid = toUser?.secUid || '';
      const rawUser = data.user || data.userValue?.user || {};
      const userDisplayId = rawUser.displayId || rawUser.id || user.id || '';
      const userSecUid = rawUser.secUid || '';
      const giftRecord = {
        time: cstISO(),
        uid: user.id,
        nickname: user.nickname,
        avatar: user.avatar,
        user_display_id: userDisplayId,
        user_sec_uid: userSecUid,
        gift_name: giftName,
        count: giftCount,
        diamond_per_unit: diamondPerUnit,
        total_diamonds: totalDiamonds,
        to_nickname: to_nickname,
        to_avatar: to_avatar,
        to_user_display_id: toUserDisplayId,
        to_user_sec_uid: toUserSecUid,
        traceId: data.traceId || null,
        comboCount: parseInt(String(data.comboCount || '1'), 10),
        repeatEnd: data.repeatEnd !== undefined ? data.repeatEnd : null,
        groupCount: parseInt(String(data.groupCount || '1'), 10),
        sendType: data.sendType !== undefined ? parseInt(data.sendType, 10) : null,
      };
      session.gifts.push(giftRecord);
      if (!stats.giftUsers[user.nickname]) {
        stats.giftUsers[user.nickname] = { count: 0, totalDiamonds: 0, giftNames: [] };
      }
      stats.giftUsers[user.nickname].count += giftCount;
      stats.giftUsers[user.nickname].totalDiamonds += totalDiamonds;
      if (!stats.giftUsers[user.nickname].giftNames.includes(giftName)) {
        stats.giftUsers[user.nickname].giftNames.push(giftName);
      }
      break;
    }

    case 'WebcastLikeMessage': {
      const total = parseInt(String(data.total || '0'), 10);
      const prev = session._totalLikes || 0;
      if (total > prev) { session.stats.like += (total - prev); session._totalLikes = total; }
      break;
    }

    case 'WebcastMemberMessage': {
      const user = extractUser(data);
      const rawUser = data.user || data.userValue?.user || {};
      const userDispId = rawUser.displayId || rawUser.id || user.id || '';
      const userSec = rawUser.secUid || '';
      // 用户头像
      const userAvatar = rawUser.avatarThumb?.urlList?.[0] || user.avatar || '';
      // WebcastMemberMessage 的 user.id 全是假值 "111111"，不能用
      // 退而求其次用 nickname 去重（虽然阉割但至少能在同 session 内区分不同用户）
      const key = user.nickname;
      if (key && !session._seenMembers.has(key)) {
        session._seenMembers.add(key);
        session.stats.member++;
        session.members.push({
          time: new Date().toISOString(),
          uid: user.id,
          nickname: user.nickname,
          avatar: userAvatar,
          user_display_id: userDispId,
          user_sec_uid: userSec,
        });
      }
      break;
    }

    case 'WebcastFansclubMessage': {
      // proto: FansclubMessage { common, action, content, user, upgrade_privilege, left_diamond, public_area_common }
      // action=1=升级, action=6=非团展示, action=7=星守护状态通知, 其他未知
      // 所有 action 均不带钻石消费信息，纯状态通知，忽略
      lastDataTime = Date.now();
      break;
    }

    case 'WebcastScreenChatMessage':
    case 'WebcastPrivilegeScreenChatMessage': {
      // 飘屏弹幕 / 特权飘屏弹幕 — 不走普通 WebcastChatMessage 通道
      lastDataTime = Date.now();
      session.stats.danmaku++;
      const scrUser = extractUser(data);
      const scrContent = extractTextContent(data) || data.content || '';
      if (scrContent) {
        session.danmaku.push({
          time: cstISO(),
          uid: scrUser.id,
          nickname: scrUser.nickname,
          avatar: scrUser.avatar,
          user_display_id: scrUser.displayId || data.user?.displayId || '',
          user_sec_uid: data.user?.secUid || scrUser.secUid || '',
          content: '[飘屏] ' + scrContent,
        });
      }
      break;
    }
    case 'WebcastSocialMessage': {
      session.stats.follow++;
      break;
    }

    case 'WebcastRoomStatsMessage': {
      const count = parseInt(data.total || data.displayValue || 0, 10);
      session.online.push({ time: cstISO(), count });
      if (session.online.length > 1000) session.online = session.online.slice(-500);
      break;
    }

    case 'WebcastResidentGuestMessage': {
      const updateRoom = (sid) => {
        if (data.title && session.room_title !== data.title) {
          session.room_title = data.title;
          if (sid) db.getPool().query('UPDATE sessions SET room_title = ? WHERE id = ? AND (room_title IS NULL OR room_title = "")', [data.title, sid]).catch(() => {});
        }
        if (data.livename && !session.room_author) {
          session.room_author = data.livename;
          setStreamerDir(data.livename);
          if (sid) db.updateStreamerName(sid, data.livename, data.avatarThumb || '').catch(() => {});
          // 如果之前开播提醒里只发了房间号，补发带名字的提醒
          console.log('[daemon] 🔴 主播名确认: ' + data.livename);
        }
        if (data.avatarThumb && !session.room_avatar) {
          session.room_avatar = data.avatarThumb;
          if (sid) db.updateStreamerAvatar(sid, data.avatarThumb).catch(() => {});
        }
      };
      updateRoom(dbSessionId);
      if (!dbSessionId) pendingDbUpdates.push(updateRoom);
      break;
    }

    case 'WebcastCommonCardAreaMessage':
    case 'WebcastGroupLiveContainerChangeMessage': {
      // 从 PK 对战消息提取参与者头像
      try {
        const container = data.data;
        if (container && Array.isArray(container)) {
          for (const item of container) {
            if (item.containerPayload) {
              const payload = JSON.parse(item.containerPayload);
              const users = payload.rl_user_base_info || [];
              for (const u of users) {
                if (u.nick_name && u.avatar && !session.toUserAvatars[u.nick_name]) {
                  session.toUserAvatars[u.nick_name] = u.avatar;
                }
              }
              // rl_user_base_info_v2 是嵌套格式
              const v2 = payload.rl_user_base_info_v2 || [];
              for (const team of v2) {
                const teamUsers = team.rl_user_base_info || [];
                for (const u of teamUsers) {
                  if (u.nick_name && u.avatar && !session.toUserAvatars[u.nick_name]) {
                    session.toUserAvatars[u.nick_name] = u.avatar;
                  }
                }
              }
            }
          }
        }
      } catch(e) { /* ignore parse errors */ }
      // fall through to default
    }

    default: {
      // 兜底：从任何带 avatarThumb 的消息提取主播头像
      if (!session.room_avatar && data.avatarThumb) {
        session.room_avatar = data.avatarThumb;
      }
      // 记录未处理的消息类型（每种最多打一次日志）
      if (!session._unseenMethods) session._unseenMethods = {};
      if (!session._unseenMethods[method]) {
        session._unseenMethods[method] = true;
        console.log('[daemon] ❓ 未处理消息类型:', method);
      }
      const uniq = method + (data.common?.msgId ? '_' + data.common.msgId.slice(-6) : '');
      if (!session.rawMessages.find(m => m._uniq === uniq)) {
        session.rawMessages.push({ _uniq: uniq, method, data });
        if (session.rawMessages.length > 50) session.rawMessages.shift();
      }
    }
  }
}

function extractTextContent(data) {
  if (data.displayText?.defaultPattern) {
    let text = data.displayText.defaultPattern;
    if (data.displayText.pieces) {
      data.displayText.pieces.forEach(p => {
        if (p.type === 11) {
          const name = p.userValue?.user?.nickname || '';
          text = text.replace('{0:user}', name);
        } else if (p.type === 1) {
          text = text.replace('{1:string}', p.stringValue || '');
        }
      });
    }
    text = text.replace(/\{[^}]+\}/g, '');
    return text;
  }
  return data.content || data.text || '';
}

// ====== douyinLive 二进制管理 ======
let binaryProcess = null;
let binaryCrashCount = 0;

function checkPort(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port }, () => {
      s.destroy();
      resolve(true);
    });
    s.on('error', () => { s.destroy(); resolve(false); });
    s.setTimeout(2000, () => { s.destroy(); resolve(false); });
  });
}

function startBinary() {
  const binaryPath = __dirname + '/douyinLive-linux-amd64';
  console.log('[binary] 启动 douyinLive 代理...');
  try {
    binaryProcess = spawn(binaryPath, ['--unknown'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
    const binaryLogFile = path.join(__dirname, 'binary_output.log');
    const binaryLogStream = fs.createWriteStream(binaryLogFile, { flags: 'a' });
    binaryProcess.stdout.pipe(binaryLogStream);
    binaryProcess.stderr.pipe(binaryLogStream);
    binaryProcess.on('exit', (code, sig) => {
      const reason = sig ? `信号 ${sig}` : `退出码 ${code}`;
      console.log(`[binary] 进程退出 (${reason})`);
      binaryProcess = null;
      binaryCrashCount++;
      const delay = Math.min(binaryCrashCount * 5000, 60000);
      if (binaryCrashCount <= 10) {
        console.log(`[binary] ${delay/1000}秒后自动重启...`);
        setTimeout(startBinary, delay);
      } else {
        console.log('[binary] 重试次数过多，不再自动重启');
      }
    });
    binaryProcess.on('error', (err) => {
      console.error('[binary] 启动失败:', err.message);
      binaryProcess = null;
    });
  } catch (e) {
    console.error('[binary] 启动异常:', e.message);
  }
}

async function ensureBinaryRunning() {
  const portOpen = await checkPort(1088);
  if (!portOpen && (!binaryProcess || binaryProcess.killed)) {
    console.log('[daemon] 1088 端口未响应，尝试启动二进制...');
    startBinary();
    await new Promise(r => setTimeout(r, 5000));
    const ok = await checkPort(1088);
    if (ok) {
      console.log('[daemon] 二进制启动成功');
      binaryCrashCount = 0;
    }
  }
}

// ====== WebSocket 连接 ======
function startConnection(roomId, config) {
  if (isShuttingDown) return;

  monitorRoomId = roomId;
  const wsUrl = `ws://127.0.0.1:1088/ws/${roomId}`;
  console.log(`[daemon] 连接: ${wsUrl}`);

  ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log('[daemon] 已连接，等待直播...');
  });

  ws.on('message', (raw) => {
    // WS 消息日志已关闭

    try {
      // 🔧 临时：原始 WS 消息全量 dump（删除这行即停）
      const str = raw.toString();
      if (str.includes('Fansclub') || str.includes('ScreenChat') || str.includes('HotChat')) {
        require('fs').appendFileSync(__dirname + '/reports/ws_dump.jsonl', str + '\n', 'utf8');
      }
      const data = JSON.parse(str);

      // ====== 系统消息（含 live_status） ======
      if (data.type === 'system') {
        const event = data.event || '';

        if (event === 'live_status') {
          // 打印 live_status 原始数据，方便排查
          console.log('[live_status] live=' + data.live + ' title=' + (data.title||'') + ' livename=' + (data.livename||''));
          const isLive = !!data.live;

          if (isLive && !isRecording) {
            // 🔴 开播
            console.log(`[daemon] 🔴 检测到开播！`);
            // 发开播通知（livename 可能为空，用房间号兜底）
            const chatId = config.feishu?.chat_id || 'oc_3eda7639e779aaa5f74493c09d2a1881';
            const liveName = data.livename || data.livenameAlias || '';
            const roomTag = roomId === '72288034336' ? '林语巷' : roomId;
            feishu.sendText(chatId, '🔴 ' + (liveName || roomTag) + ' 开播啦！\n' + (data.title || '')).catch(() => {});
            session = createSession(roomId);
            session.room_title = data.title || '';
            session.room_author = data.livename || '';
            // 标题为空时不处理（抖音 live/detail API 已下线）
            if (session.room_author) setStreamerDir(session.room_author);
            isRecording = true;
            saveSession();
            // 创建 MySQL session 记录（先关掉该房间旧的活跃 session，防重复）
            db.init().then(async () => {
              try {
                const pool = db.getPool();
                await pool.query('UPDATE sessions SET end_time = NOW() WHERE room_id = ? AND end_time IS NULL', [roomId]);
                const streamerId = await db.upsertStreamer(session.room_author || '', roomId, '');
                dbSessionId = await db.createSession(streamerId, session.room_title, roomId);
                dbSyncState = { danmaku: 0, gifts: 0, members: 0, online: 0 };
                console.log(`[db] session #${dbSessionId} 已创建`);
                flushPendingDbUpdates();
              } catch(e) {
                console.error('[db] 创建 session 失败:', e.message);
              }
            });
            console.log(`[daemon] 开始录制: ${data.title || ''}`);
          } else if (!isLive && isRecording) {
            // 🟢 可能下播 — 延迟30秒确认，期间有新数据则取消
            if (!_liveStopTimer) {
              _liveStopTimer = setTimeout(() => {
                _liveStopTimer = null;
                if (!isRecording) return;
                // 30秒后仍无新数据 → 确认下播
                console.log(`[daemon] 🟢 确认下播！`);
                isRecording = false;
                finalizeSession();
                console.log(`[daemon] session 已保存 (${session.stats.danmaku}条弹幕, ${session.stats.gift}个礼物)`);
                generateAndSendReport();
              }, 30000);
              console.log(`[daemon] 🟡 直播可能已结束，30秒后确认...`);
            }
          }

          // 更新状态
          if (!session) {
            if (!session) { /* first connection, not live */ }
          } else {
            session._liveStatus = isLive;
          }

          if (!isLive && !isRecording) {
            console.log(`[daemon] 直播未开播，等待中... (${data.message || ''})`);
          }
        } else {
          // 其他系统消息
          console.log(`[系统] ${data.message || JSON.stringify(data)}`);
        }
        return;
      }

      // ====== 直播数据消息 ======
      // 所有消息都可能携带主播信息（livename/title/avatarThumb），尽早提取
      if (session && isRecording) {
        if (data.livename && !session.room_author) {
          console.log('[daemon] 🏷️ 抓到主播名:', data.livename);
          session.room_author = data.livename;
          setStreamerDir(data.livename);
          const doUpdate = (sid) => {
            db.updateStreamerName(sid, data.livename, data.avatarThumb || '').catch(() => {});
          };
          if (dbSessionId) {
            doUpdate(dbSessionId);
          } else {
            pendingDbUpdates.push(doUpdate);
          }
        }
        if (data.title && !session.room_title) {
          session.room_title = data.title;
          if (dbSessionId) {
            db.getPool().query('UPDATE sessions SET room_title = ? WHERE id = ? AND (room_title IS NULL OR room_title = "")', [data.title, dbSessionId]).catch(() => {});
          }
        }
        if (data.avatarThumb && !session.room_avatar) {
          session.room_avatar = data.avatarThumb;
          if (dbSessionId) {
            db.updateStreamerAvatar(dbSessionId, data.avatarThumb).catch(() => {});
          }
        }
      }

      if (session) {
        // WS 重连后通过数据自动恢复录制
        if (!isRecording && dbSessionId) {
          isRecording = true;
          console.log('[daemon] 检测到新数据，恢复录制');
        }
        if (isRecording) {
          handleMessage(data);
          saveSession();
        }
      }
    } catch (e) {
      const method = (typeof data === 'object' && data) ? (data._method || data.method || data.event || '?') : '?';
      console.error('[daemon] 消息处理错误 [' + method + ']:', e.message);
    }
  });

  ws.on('close', (code) => {
    console.log(`[daemon] 连接断开 (code=${code})`);
    if (isShuttingDown) return;

    // code=1000 正常关闭 → 抖音主动断开，说明下播了
    if (code === 1000 && isRecording) {
      console.log('[daemon] 🟢 WS正常关闭(code=1000)，确认下播');
      isRecording = false;
      if (session) {
        session.end_time = new Date().toISOString();
        finalizeSession();
        console.log(`[daemon] session 已保存 (${session.stats.danmaku}条弹幕, ${session.stats.gift}个礼物)`);
        generateAndSendReport();
      }
      return;
    }

    // 非1000 → 网络波动/异常断开，重连
    const delay = config.reconnect_delay_seconds * 1000;
    console.log(`[daemon] ${config.reconnect_delay_seconds}秒后重连...`);
    setTimeout(async () => {
      await ensureBinaryRunning().catch(() => {});
      startConnection(roomId, config);
    }, delay);
  });

  ws.on('error', (err) => {
    console.log(`[daemon] WS错误: ${err.message}`);
    ensureBinaryRunning().catch(() => {});
  });
}

// ====== 守护进程管理 ======
function writePid() {
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');
}

function readPid() {
  try {
    if (fs.existsSync(PID_FILE)) {
      return parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    }
  } catch (e) { /* ignore */ }
  return null;
}

// ====== WS 消息日志 ======


async function stopDaemon() {
  isShuttingDown = true;
  if (daemonLoopInterval) clearInterval(daemonLoopInterval);
  if (binaryProcess && !binaryProcess.killed) {
    try { binaryProcess.kill('SIGTERM'); } catch(e) {}
  }

  // 刷新 MySQL
  try { await dbFlush(); } catch(e) {}

  // 保存当前 session
  if (isRecording && session) {
    isRecording = false;
    finalizeSession();
    console.log('[stop] session 已保存');
    // 生成并发送图片报告
    await generateAndSendReport();
  }

  if (ws) {
    try { ws.close(); } catch (e) { /* ignore */ }
  }

  // 关闭 MySQL 连接池
  try { await db.close(); } catch(e) {}

  // 删除 PID 文件
  try { fs.unlinkSync(PID_FILE); } catch (e) { /* ignore */ }

  console.log('[stop] 守护进程已停止');
  return session;
}

function daemonStatus() {
  return {
    roomId: monitorRoomId,
    running: process.pid === readPid(),
    connected: ws && ws.readyState === WebSocket.OPEN,
    recording: isRecording,
    liveStatus: session?._liveStatus ?? null,
    stats: session?.stats || null,
    pid: process.pid,
  };
}

// ====== 主入口 ======
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args[0] === 'stop') {
    // 停止守护进程
    const pid = readPid();
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 'SIGTERM');
        console.log('[stop] 已发送 SIGTERM 到进程', pid);
        // 删除 PID 文件
        setTimeout(() => { try { fs.unlinkSync(PID_FILE); } catch(e){} }, 1000);
      } catch (e) {
        console.error('[stop] 无法终止进程', pid, ':', e.message);
        try { fs.unlinkSync(PID_FILE); } catch(e){}
      }
    } else {
      console.log('[stop] 没有运行的守护进程');
      try { fs.unlinkSync(PID_FILE); } catch(e){}
    }
    process.exit(0);
  }

  if (args[0] === 'status') {
    const pid = readPid();
    if (pid) {
      try {
        process.kill(pid, 0); // 检查进程是否存在
        console.log(JSON.stringify({ running: true, pid }, null, 2));
      } catch (e) {
        console.log(JSON.stringify({ running: false, pid: null }, null, 2));
        try { fs.unlinkSync(PID_FILE); } catch(ex){}
      }
    } else {
      console.log(JSON.stringify({ running: false, pid: null }, null, 2));
    }
    process.exit(0);
  }


  if (args[0] === 'snapshot' || args[0] === '快照') {
    (async () => {
      try {
        const data = await reportImg.load(monitorRoomId);
        if (!data) {
          console.log(JSON.stringify({ type: 'snapshot', error: '暂无直播数据' }));
          process.exit(0);
        }
        const config = loadConfig();
        const chatId = config.feishu?.chat_id || 'oc_3eda7639e779aaa5f74493c09d2a1881';
        const pngPath = await reportImg.generateImage(data);
        const ok = await feishu.sendImage(chatId, pngPath);
        try { fs.unlinkSync(pngPath); } catch(e){}
        if (ok) {
          console.log(JSON.stringify({ type: 'snapshot', result: 'ok' }));
        } else {
          console.log(JSON.stringify({ type: 'snapshot', error: '图片发送失败' }));
        }
      } catch (e) {
        console.log(JSON.stringify({ type: 'snapshot', error: e.message }));
      }
      process.exit(0);
    })();
    return;
  }

  if (args[0] === 'report-image' || args[0] === '图片') {
    (async () => {
      try {
        const data = await reportImg.load(monitorRoomId);
        if (!data) {
          console.log(JSON.stringify({ type: 'image', error: '暂无直播数据' }));
          process.exit(0);
        }
        const config = loadConfig();
        const chatId = config.feishu?.chat_id || 'oc_3eda7639e779aaa5f74493c09d2a1881';
        const pngPath = await reportImg.generateImage(data);
        const ok = await feishu.sendImage(chatId, pngPath);
        if (ok) {
          console.log('图片报告已发送 ✅');
          try { fs.unlinkSync(pngPath); } catch(e){}
        } else {
          console.log('图片发送失败');
        }
      } catch (e) {
        console.log('生成图片失败:', e.message);
      }
      process.exit(0);
    })();
    return; // 不继续执行后续代码
  }

  // 启动守护进程
  const config = loadConfig();
  const roomId = config.room_id;

  // 初始化 MySQL 连接池
  db.init().catch(e => console.error('[db] 初始化失败:', e.message));

  // 定期将数据同步到 MySQL（仅录制时有效）
  setInterval(() => {
    if (isRecording && session) dbFlush().catch(e => console.error('[daemon] dbFlush 异常:', e.message));
  }, 5000);

  // 检查是否已有进程在运行
  const existingPid = readPid();
  if (existingPid) {
    try {
      process.kill(existingPid, 0);
      console.error(`[daemon] 已有守护进程在运行 (PID ${existingPid})`);
      console.error('运行 "node monitor.js stop" 先停止');
      process.exit(1);
    } catch (e) {
      // PID 已失效，继续
      console.log('[daemon] 清理过期 PID');
    }
  }

  writePid();
  console.log(`[daemon] 启动，PID=${process.pid}, 房间=${roomId}`);
  console.log(`[daemon] 检查间隔=${config.check_interval_seconds}秒`);

  // 检查二进制状态，必要时自动重启
  ensureBinaryRunning().then(() => {
    startConnection(roomId, config);
  }).catch(() => {
    startConnection(roomId, config);
  });

  // 信号处理
  // 全局异常保护，防止无日志闪退
  process.on('unhandledRejection', (reason) => {
    console.error('[daemon] 未处理的 Promise 拒绝:', reason?.message || reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[daemon] 未捕获异常:', err.message, err.stack);
  });
  process.on('SIGINT', async () => { console.log('\n[daemon] 收到 SIGINT'); await stopDaemon(); process.exit(0); });
  process.on('SIGTERM', async () => { console.log('[daemon] 收到 SIGTERM'); await stopDaemon(); process.exit(0); });

  // 定期输出心跳 + 二进制健康检查 + 数据超时检测
  // 定期心跳 + 二进制健康检查
  daemonLoopInterval = setInterval(() => {
    const st = daemonStatus();
    console.log(`[heartbeat] 录制中=${st.recording} 已连接=${st.connected} session=${st.stats?.danmaku||0}/${st.stats?.gift||0}`);
    // 如果 WS 断连，尝试恢复二进制
    if (!st.connected) {
      ensureBinaryRunning().catch(() => {});
    }
  }, 60000);

  process.stdin.resume();
}

module.exports = { daemonStatus, stopDaemon };
