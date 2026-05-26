/**
 * 抖音直播报告 → 精美图片生成
 * 读取 current_session.json，生成 HTML 并用 Playwright 截图为 PNG
 * 支持 --user 指定用户生成专属礼物榜单
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const SESSION_FILE = path.join(__dirname, 'current_session.json');
const DATA_DIR = __dirname;

// SVG 图标常量（Tabler Icons / 开源矢量图标库，纤巧线性风格）
const ICO = {
  diamond: '<span style="font-weight:700">钻</span>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="#FFD54F" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" style="vertical-align:middle;flex-shrink:0"><path d="M12 17.75l-6.172 3.245l1.179 -6.873l-5 -4.867l6.9 -1l3.086 -6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873z"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="#42A5F5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" style="vertical-align:middle;flex-shrink:0"><path d="M8 9h8"/><path d="M8 13h6"/><path d="M9 18h-3a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-3l-3 3l-3 -3z"/></svg>',
  gift: '<svg viewBox="0 0 24 24" fill="none" stroke="#EF5350" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" style="vertical-align:middle;flex-shrink:0"><path d="M3 8m0 1a1 1 0 0 1 1 -1h16a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-16a1 1 0 0 1 -1 -1z"/><path d="M12 8l0 13"/><path d="M19 12v7a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0 -5a4.8 8 0 0 1 4.5 5a4.8 8 0 0 1 4.5 -5a2.5 2.5 0 0 1 0 5"/></svg>',
  crown: '<svg viewBox="0 0 24 24" fill="none" stroke="#FFD700" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12" style="vertical-align:middle;margin-right:2px"><path d="M12 6l4 6l5 -4l-2 10h-14l-2 -10l5 4z"/></svg>',
  heart: '<svg viewBox="0 0 24 24" fill="none" stroke="#EC407A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12" style="vertical-align:middle"><path d="M19.5 12.572l-7.5 7.428l-7.5 -7.428a5 5 0 1 1 7.5 -6.566a5 5 0 1 1 7.5 6.572"/></svg>',
  // 排名奖牌
  gold: '<svg viewBox="0 0 24 24" width="18" height="18" style="vertical-align:middle"><circle cx="12" cy="12" r="11" fill="#FFD700"/><text x="12" y="17" text-anchor="middle" font-size="14" font-weight="bold" fill="#1a0a2e">1</text></svg>',
  silver: '<svg viewBox="0 0 24 24" width="18" height="18" style="vertical-align:middle"><circle cx="12" cy="12" r="11" fill="#C0C0C0"/><text x="12" y="17" text-anchor="middle" font-size="14" font-weight="bold" fill="#1a0a2e">2</text></svg>',
  bronze: '<svg viewBox="0 0 24 24" width="18" height="18" style="vertical-align:middle"><circle cx="12" cy="12" r="11" fill="#CD7F32"/><text x="12" y="17" text-anchor="middle" font-size="14" font-weight="bold" fill="#fff">3</text></svg>',

};

function loadJson() {
  // 先试默认路径（可能是软链）
  if (fs.existsSync(SESSION_FILE)) {
    try {
      const raw = fs.readFileSync(SESSION_FILE, 'utf-8');
      const data = JSON.parse(raw);
      if (data.room_author) {
        patchSessionData(data);
        data.gifts = comboDedupGifts(data.gifts || []);
        return data;
      }
    } catch(e) { /* 忽略损坏文件 */ }
  }
  // 兜底：遍历所有 streamer 目录，找最大最新的 current_session.json
  const streamersDir = path.join(DATA_DIR, 'streamers');
  if (fs.existsSync(streamersDir)) {
    let best = null, bestSize = 0;
    for (const dir of fs.readdirSync(streamersDir)) {
      const fp = path.join(streamersDir, dir, 'current_session.json');
      try {
        const st = fs.statSync(fp);
        if (st.size > bestSize) {
          const raw = fs.readFileSync(fp, 'utf-8');
          const d = JSON.parse(raw);
          if (d.room_author && (d.gifts || []).length > 0) {
            d.gifts = comboDedupGifts(d.gifts || []);
            best = d; bestSize = st.size;
          }
        }
      } catch(e) { /* 跳过 */ }
    }
    if (best) { patchSessionData(best); return best; }
  }
  return null;
}

/** 从 MySQL 加载数据，需传 dbConfig */
async function loadFromDb(sessionId) {
  const mysql = require('mysql2/promise');
  const pool = mysql.createPool({
    host: '1Panel-mysql-aF5P', port: 3306, user: 'douyinlive',
    password: 'bYcxn7wFwDjed5jD', database: 'douyinlive',
    timezone: '+08:00', connectionLimit: 2
  });
  try {
    const [sessions] = await pool.query(`
      SELECT sess.*, s.name as streamer_name, s.room_id, s.avatar as streamer_avatar
      FROM sessions sess JOIN streamers s ON sess.streamer_id = s.id WHERE sess.id = ?
    `, [sessionId]);
    if (!sessions.length) return null;
    const sess = sessions[0];

    const [danmaku] = await pool.query('SELECT nickname, avatar, content, create_time FROM danmaku WHERE session_id = ? ORDER BY create_time', [sessionId]);
    const [gifts] = await pool.query('SELECT id, nickname, avatar, to_nickname, to_avatar, to_user_display_id, to_user_sec_uid, gift_name, diamond_count, total_diamonds, repeat_count, create_time, user_display_id, user_sec_uid, trace_id, repeat_end, combo_count, send_type FROM gifts WHERE session_id = ? ORDER BY id', [sessionId]);
    const [members] = await pool.query('SELECT nickname, avatar, user_sec_uid, create_time FROM members WHERE session_id = ? ORDER BY create_time', [sessionId]);

    // 连击去重
    const deduped = comboDedupGifts(gifts);

    const dMapped = danmaku.map(d => ({
      nickname: d.nickname, avatar: d.avatar || '',
      content: d.content, create_time: d.create_time instanceof Date ? d.create_time.toISOString() : d.create_time
    }));
    const gMapped = deduped.map(g => ({
      nickname: g.nickname, avatar: g.avatar || '', gift_name: g.gift_name || '',
      to_nickname: g.to_nickname || '',
      to_avatar: g.to_avatar || '',
      to_user_display_id: g.to_user_display_id || '',
      to_user_sec_uid: g.to_user_sec_uid || '',
      user_display_id: g.user_display_id || '',
      user_sec_uid: g.user_sec_uid || '',
      diamonds: g.diamond_count || 0, total_diamonds: g.total_diamonds || 0,
      count: g.repeat_count || 1,
      create_time: g.create_time instanceof Date ? g.create_time.toISOString() : g.create_time, describe: ''
    }));
    const mMapped = members.map(m => ({
      nickname: m.nickname,
      avatar: m.avatar || '',
      user_sec_uid: m.user_sec_uid || '',
      create_time: m.create_time instanceof Date ? m.create_time.toISOString() : m.create_time
    }));
    // 从 online_records 表查询在线记录
    const [onlineRecords] = await pool.query(
      'SELECT count, recorded_at FROM online_records WHERE session_id = ? ORDER BY recorded_at', [sessionId]
    );
    const onlinePeak = onlineRecords.length > 0
      ? Math.max(...onlineRecords.map(o => o.count))
      : (sess.online_peak || 0);

    // 只查被送礼人（主播）的头像，送礼人的已有
    const avatarCache = {};
    const hostSecUids = new Set();
    gMapped.forEach(g => {
      if (g.to_user_sec_uid) hostSecUids.add(g.to_user_sec_uid);
    });
    if (hostSecUids.size > 0) {
      const { fetchUserBySecUid } = require('./douyin-user.js');
      const batch = Array.from(hostSecUids).slice(0, 20);
      const results = await Promise.allSettled(batch.map(uid => fetchUserBySecUid(uid)));
      results.forEach((res, i) => {
        if (res.status === 'fulfilled' && res.value) {
          avatarCache[batch[i]] = res.value.avatar;
          // 同时用昵称索引，方便 findAvatar 查找
          avatarCache[res.value.nickname] = res.value.avatar;
        }
      });
    }

    const data = {
      room_author: sess.streamer_name,
      room_title: sess.room_title,
      room_avatar: sess.streamer_avatar,
      start_time: sess.start_time instanceof Date ? sess.start_time.toISOString() : sess.start_time,
      end_time: sess.end_time instanceof Date ? sess.end_time.toISOString() : (sess.end_time || null),
      stats: {
        danmaku: dMapped.length,
        gift: gMapped.length,
        like: sess.stats_like || 0,
        member: mMapped.length,
        follow: sess.stats_follow || 0,
        social: sess.stats_social || 0,
        online: onlinePeak
      },
      gifts: gMapped, danmaku: dMapped, members: mMapped,
      online: onlineRecords.map(o => ({ count: o.count, time: o.recorded_at })),
      rawMessages: [],
      _avatarCache: avatarCache
    };
    return data;
  } finally { await pool.end(); }
}

/** 获取最新的直播 session ID */
async function getLatestSessionId(roomId) {
  const mysql = require('mysql2/promise');
  const pool = mysql.createPool({
    host: '1Panel-mysql-aF5P', port: 3306, user: 'douyinlive',
    password: 'bYcxn7wFwDjed5jD', database: 'douyinlive', connectionLimit: 2
  });
  try {
    if (roomId) {
      // 有 roomId 时：优先找该 room 的 active session，否则找最新的
      const [live] = await pool.query(
        'SELECT id FROM sessions WHERE end_time IS NULL AND room_id = ? ORDER BY id DESC LIMIT 1',
        [roomId]
      );
      if (live.length) return live[0].id;
      const [last] = await pool.query(
        'SELECT id FROM sessions WHERE room_id = ? ORDER BY id DESC LIMIT 1',
        [roomId]
      );
      if (last.length) return last[0].id;
    }
    // 无 roomId 或该 room 无记录：直接取最新的 session（不论是否结束）
    const [latest] = await pool.query("SELECT id FROM sessions ORDER BY id DESC LIMIT 1");
    if (latest.length) return latest[0].id;
    return null;
  } finally { await pool.end(); }
}

/** 默认加载方式：先试 MySQL（可按 roomId 过滤），失败则 JSON */
async function load(roomId) {
  try {
    const sid = await getLatestSessionId(roomId);
    if (sid) {
      const data = await loadFromDb(sid);
      if (data) return data;
    }
  } catch(e) {
    console.error('[load] MySQL 失败，回退 JSON:', e.message);
  }
  const json = loadJson();
  if (json) {
    patchSessionData(json);
    return json;
  }
  return null;
}

function formatDuration(sec) {
  if (sec < 60) return `${sec}秒`;
  const m = Math.floor(sec / 60);
  const ss = sec % 60;
  if (m < 60) return `${m}分${ss > 0 ? ss + '秒' : ''}`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}小时${rm > 0 ? rm + '分' : ''}`;
}

function calcDuration(start, end) {
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const sec = Math.round((e - s) / 1000);
  if (sec < 60) return `${sec}秒`;
  const m = Math.floor(sec / 60);
  const ss = sec % 60;
  if (m < 60) return `${m}分${ss > 0 ? ss + '秒' : ''}`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}小时${rm > 0 ? rm + '分' : ''}`;
}

function fmtNum(n) {
  return (parseInt(n, 10) || 0).toLocaleString();
}

function rankBadge(i) {
  if (i === 0) return ICO.gold;
  if (i === 1) return ICO.silver;
  if (i === 2) return ICO.bronze;
  const n = i + 1;
  return `<svg viewBox="0 0 24 24" width="18" height="18" style="vertical-align:middle"><circle cx="12" cy="12" r="10" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.15)" stroke-width="1"/><text x="12" y="16" text-anchor="middle" font-size="12" font-weight="bold" fill="rgba(255,255,255,0.5)">${n}</text></svg>`;
}

/** 用户头像 HTML：有 URL 则用 img，否则 emoji 占位 */
function avatarImg(url, size, nickname) {
  if (!url && nickname) return placeholderAvatarHTML(nickname, size || 28);
  if (!url) return '<span class="av-f" style="display:inline-flex;width:'+(size||28)+'px;height:'+(size||28)+'px;border-radius:50%;background:rgba(255,255,255,0.08);align-items:center;justify-content:center;font-size:'+Math.round((size||28)*0.5)+'px;color:rgba(255,255,255,0.35)">?</span>';
  return `<img class="av-i" src="${url}" width="${size}" height="${size}" onerror="this.outerHTML='<span class=av-f style=display:inline-flex;width:${size}px;height:${size}px;border-radius:50%;background:rgba(255,255,255,0.08);align-items:center;justify-content:center;font-size:${Math.round((size||28)*0.5)}px;color:rgba(255,255,255,0.35)>?</span>'">`;
}

/** 从礼物数据中查找某个用户的第一张头像 */
function avatarFromGifts(gifts, nickname) {
  if (!nickname) return '';
  const g = (gifts||[]).find(g => g.nickname === nickname && g.avatar);
  return g ? g.avatar : '';
}

/** 从礼物/弹幕数据中查找某个用户的第一张头像 */
/** 特殊用户头像覆盖（用户手动指定的） */
const SPECIAL_AVATARS = {
  '萱萱': 'https://p3.douyinpic.com/aweme/100x100/aweme-avatar/tos-cn-i-0813_oA9suPwIGDIAikDATEQAZAJPjkAIIlTBi8xVT.jpeg?from=3067671334'
};

function findAvatar(data, nickname) {
  if (!nickname || !data) return '';
  // 0. 特殊用户覆盖
  if (SPECIAL_AVATARS[nickname]) return SPECIAL_AVATARS[nickname];
  // 1. 送礼人头像（精确匹配）
  const g = (data.gifts||[]).find(g => g.nickname === nickname && g.avatar);
  if (g && g.avatar) return g.avatar;
  // 2. 收礼人头像：toUserAvatars（API 缓存）
  const avatars = data.toUserAvatars || {};
  for (const [name, url] of Object.entries(avatars)) {
    if (name.includes(nickname) || nickname.includes(name)) if (url) return url;
  }
  // 3. 收礼人头像：to_avatar（完全匹配）
  const g2 = (data.gifts||[]).find(g => g.to_nickname === nickname && g.to_avatar);
  if (g2 && g2.to_avatar) return g2.to_avatar;
  // 4. 弹幕头像（完全匹配）
  const d = (data.danmaku||[]).find(d => d.nickname === nickname && d.avatar);
  if (d && d.avatar) return d.avatar;
  // 5. API 缓存
  if (data._avatarCache) {
    for (const url of Object.values(data._avatarCache)) if (url) return url;
  }
  return '';
}

/** 从 members 表按 secUid 找头像 */
function findAvatarBySecUid(data, secUid) {
  if (!secUid || !data) return '';
  const m = (data.members||[]).find(m => m.user_sec_uid === secUid && m.avatar);
  if (m && m.avatar) return m.avatar;
  return '';
}

/** 清理不常见Unicode字符，保留可读文本（数学手写体→普通字母，象形文字→空）*/
function cleanDisplayName(name) {
  if (!name) return name;
  const result = [];
  let i = 0;
  while (i < name.length) {
    const code = name.codePointAt(i);
    const len = code > 0xFFFF ? 2 : 1;
    if (code >= 0x1D400 && code <= 0x1D7FF) {
      // Mathematical Alphanumeric Symbols → 普通字母
      const base = code - 0x1D400;
      const idx = base % 52;
      if (idx < 26) result.push(String.fromCharCode(65 + idx));
      else result.push(String.fromCharCode(97 + idx - 26));
    } else if ((code >= 0x13000 && code <= 0x1342F) || (code >= 0x1F000 && code <= 0x1FFFF)) {
      // 埃及象形文字/Emoji → 跳过
    } else {
      result.push(String.fromCodePoint(code));
    }
    i += len;
  }
  const cleaned = result.join('');
  // 如果清理后为空（纯表情名字如 👻🔥），保留原始名称
  return cleaned || name;
}

/** 生成占位头像 HTML（首字符圆圈）*/
function placeholderAvatarHTML(nickname, size) {
  const char = (nickname||'?')[0];
  const s = size || 28;
  const fontSize = Math.round(s * 0.5);
  return '<span style="display:inline-flex;width:'+s+'px;height:'+s+'px;border-radius:50%;background:rgba(255,255,255,0.08);align-items:center;justify-content:center;font-size:'+fontSize+'px;color:rgba(255,255,255,0.35);flex-shrink:0">'+char+'</span>';
}

/** 修补旧数据：从 rawMessages 提取房间/弹幕头像，给缺失 avatar 的礼物设默认值 */
/** 连击去重：按(uid, gift_name)分组，comboCount 连续递增视为同一连击，每组只留最终帧 */
function comboDedupGifts(gifts) {
  // 按 (uid, gift_name, 收礼人) 三分组，不同收礼人不混在一起
  const rawGroups = {};
  for (const g of gifts) {
    const uid = g.user_display_id || g.nickname;
    const toKey = g.to_user_sec_uid || g.to_user_display_id || g.to_nickname || '';
    const key = uid + '\x00' + g.gift_name + '\x00' + toKey;
    if (!rawGroups[key]) rawGroups[key] = [];
    rawGroups[key].push(g);
  }

  const deduped = [];
  for (const [, items] of Object.entries(rawGroups)) {
    if (items.length === 1) { deduped.push(items[0]); continue; }
    items.sort((a, b) => a.id - b.id);

    // 在组内识别连续连击序列
    let seq = [items[0]];
    const sequences = [];
    for (let i = 1; i < items.length; i++) {
      const prev = seq[seq.length - 1];
      const curr = items[i];
      const pc = parseInt(String(prev.combo_count || 1), 10);
      const cc = parseInt(String(curr.combo_count || 1), 10);
      if (cc > pc || (cc === pc && curr.repeat_end === 1)) {
        seq.push(curr);
      } else {
        sequences.push(seq);
        seq = [curr];
      }
    }
    sequences.push(seq);

    for (const s of sequences) {
      if (s.length === 1) {
        deduped.push(s[0]);
      } else {
        const best = s.reduce((a, b) => {
          const ac = parseInt(String(a.combo_count || 1), 10);
          const bc = parseInt(String(b.combo_count || 1), 10);
          if (bc !== ac) return bc > ac ? b : a;
          return b.repeat_end === 1 ? b : a;
        });
        deduped.push(best);
      }
    }
  }
  return deduped;
}

function patchSessionData(data) {
  if (!data) return;
  // 主播头像：从 rawMessages 找 avatarThumb
  if (!data.room_avatar && data.rawMessages) {
    for (const m of data.rawMessages) {
      if (m.data && m.data.avatarThumb) {
        data.room_avatar = m.data.avatarThumb;
        break;
      }
    }
  }
  // 礼物头像：如果缺失 avatar 字段，设空字符串
  if (data.gifts) {
    for (const g of data.gifts) {
      if (g.avatar === undefined) g.avatar = '';
    }
  }
  // 弹幕头像回填：从礼物记录或 rawMessages 补弹幕的头像
  if (data.danmaku) {
    // 构建昵称→头像映射（从已有头像的数据源）
    const avatarMap = {};
    if (data.gifts) {
      for (const g of data.gifts) {
        if (g.nickname && g.avatar) avatarMap[g.nickname] = g.avatar;
      }
    }
    if (data.rawMessages) {
      for (const m of data.rawMessages) {
        const d = m.data || m;
        const u = d.user || d.userValue?.user;
        if (u && u.nickname && u.avatarThumb?.urlList?.[0]) {
          avatarMap[u.nickname] = u.avatarThumb.urlList[0];
        }
      }
    }
    // 遍历弹幕补头像
    for (const dm of data.danmaku) {
      if (!dm.avatar && dm.nickname && avatarMap[dm.nickname]) {
        dm.avatar = avatarMap[dm.nickname];
      }
    }
  }
}

// ────────── 直播报告图片 ──────────

/** 从礼物数据生成主播排名（团播） */
function buildHostRanking(data) {
  // 读取排除列表（监控账号自身的主播名）
  let excludeHosts = [];
  try {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'runtime-config.json'), 'utf-8'));
    if (config.exclude_hosts) excludeHosts = config.exclude_hosts;
  } catch(e) { /* ignore */ }

  const hostStats = {};
  for (const g of data.gifts || []) {
    const toNick = g.to_nickname || '';
    if (!toNick) continue;
    // 排除监控账号自身的礼物
    if (excludeHosts.includes(toNick)) continue;
    // 优先用 secUid/displayId 去重，防同名；匿名直播间才用昵称
    const hostKey = g.to_user_sec_uid || g.to_user_display_id || toNick;
    if (!hostStats[hostKey]) hostStats[hostKey] = { diamonds: 0, gifts: 0, name: toNick, displayId: g.to_user_display_id || '', secUid: g.to_user_sec_uid || '' };
    const d = parseInt(String(g.total_diamonds || 0), 10) || 0;
    hostStats[hostKey].diamonds += d;
    hostStats[hostKey].gifts += 1;
  }

  const sorted = Object.entries(hostStats)
    .sort((a, b) => b[1].diamonds - a[1].diamonds);

  if (sorted.length < 1) return '';

  function makeRows(arr, startIndex) {
    return arr.map(([key, s], j) => {
      const i = startIndex + j;
      const displayName = s.name || key;
      const isTop3 = i < 3;
      const top3cls = isTop3 ? ` class="row-top3 row-${['1st','2nd','3rd'][i]}"` : '';
      return `<tr${top3cls}><td class="rank">${rankBadge(i)}</td><td class="name"><span class="name-wrap"><span class="name-text host-text" title="${displayName}">${displayName}</span></span></td><td class="diamonds"><span class="d-wrap"><span class="d-val">${fmtNum(s.diamonds)}</span><span class="d-unit">${ICO.diamond}</span></span></td></tr>`;
    }).join('');
  }

  const use2Cols = sorted.length >= 10;

  if (use2Cols) {
    const half = Math.ceil(sorted.length / 2);
    const left = sorted.slice(0, half);
    const right = sorted.slice(half);
    const leftRows = makeRows(left, 0);
    const rightRows = makeRows(right, half);
    return `<div class="ranking-grid" style="padding-top:4px;margin-bottom:6px">
      <div class="ranking-col" style="grid-column:1/-1">
        <div class="section-title">${ICO.star} 主播排名（共 ${sorted.length} 位）</div>
      </div>
      <div class="ranking-col">
        <table><tbody>${leftRows}</tbody></table>
      </div>
      <div class="ranking-col">
        <table><tbody>${rightRows}</tbody></table>
      </div>
    </div>`;
  } else {
    const rows = makeRows(sorted, 0);
    return `<div class="ranking-grid" style="padding-top:4px;margin-bottom:6px">
      <div class="ranking-col" style="grid-column:1/-1">
        <div class="section-title">${ICO.star} 主播排名（共 ${sorted.length} 位）</div>
        <table><tbody>${rows}</tbody></table>
      </div>
    </div>`;
  }
}

// ────────── 直播报告图片 ──────────

function generateHTML(data) {
  const duration = data.duration_seconds ? formatDuration(data.duration_seconds) : calcDuration(data.start_time, data.end_time);
  const onlinePeak = data.online?.length ? Math.max(...data.online.map(o => o.count)) : (data.stats?.online || 0);
  const danmakuCount = data.stats?.danmaku || 0;
  const likeCount = data.stats?.like || 0;
  const memberCount = data.stats?.member || 0;
  const followCount = data.stats?.follow || 0;
  const totalDiamonds = (data.gifts || []).reduce((s, g) => s + (parseInt(String(g.total_diamonds || 0), 10) || 0), 0);
  const cny = Math.round(totalDiamonds / 10);

  const giftStats = {};
  for (const g of data.gifts || []) {
    // 优先用 secUid 去重，匿名直播间用昵称兜底
    const userKey = g.user_sec_uid || g.user_display_id || g.nickname;
    if (!giftStats[userKey]) giftStats[userKey] = { diamonds: 0, name: g.nickname };
    giftStats[userKey].diamonds += parseInt(String(g.total_diamonds), 10) || 0;
  }
  const topGift = Object.entries(giftStats).sort((a, b) => b[1].diamonds - a[1].diamonds).slice(0, 10)
    .map(([key, s]) => ({ name: s.name, diamonds: s.diamonds }));

  const dmStats = {};
  for (const dm of data.danmaku || []) dmStats[dm.nickname] = (dmStats[dm.nickname] || 0) + 1;
  const topDanmaku = Object.entries(dmStats).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([name, count]) => ({ name, count }));

  const startTime = new Date(data.start_time).toLocaleString('zh-CN', {
    month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai'
  });
  const endTime = data.end_time
    ? new Date(data.end_time).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' })
    : '直播中';

  // 提取代表性弹幕（按内容频率统计，取全场讨论最多的话题）
  const dmSamples = (() => {
    const dms = (data.danmaku || [])
      .filter(d => d.content && d.content.replace(/\[[^\]]+\]/g,'').trim().length > 2 && !d.content.startsWith('@') && !d.content.startsWith('/'));
    const freq = {};
    for (const d of dms) {
      const text = d.content.replace(/\[[^\]]+\]/g,'').trim().slice(0, 40);
      freq[text] = (freq[text] || 0) + 1;
    }
    return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([text, count]) => '「' + text + '」(' + count + '次)');
  })();
  const dmTag = dmSamples.length ? '观众聊到' + dmSamples.join('、') : '';

  let aiComment = `直播持续${duration}，累计${memberCount}人次进场，${danmakuCount}条弹幕。`;
  if (danmakuCount === 0 && memberCount < 50) {
    aiComment = '直播间较为冷清，观众以浏览为主，互动较少。可以考虑增加互动环节提升参与感。';
  } else if (danmakuCount > 50 || memberCount > 2000) {
    aiComment = '直播间热度很高！观众互动非常积极，进场人数众多，是一场高热的直播。';
    if (dmTag) aiComment += ' ' + dmTag;
  } else if (totalDiamonds > 0) {
    aiComment = '有忠实粉丝在支持，整体气氛热烈。感谢每一位到场的朋友！';
    if (dmTag) aiComment += ' ' + dmTag;
  } else if (likeCount > 10000) {
    aiComment = '点赞量很高，内容引起了不少观众共鸣。';
    if (dmTag) aiComment += ' ' + dmTag;
  } else if (dmTag) {
    aiComment += ' ' + dmTag;
  }

  const isHot = danmakuCount > 50 || memberCount > 2000;
  const theme = isHot
    ? { primary: '#FF6B6B', accent: '#FFD93D', bg: 'linear-gradient(135deg, #1a0a2e 0%, #16213e 50%, #0f3460 100%)', cardBg: 'rgba(255,255,255,0.07)' }
    : { primary: '#6C63FF', accent: '#FFD93D', bg: 'linear-gradient(135deg, #1a0a2e 0%, #16213e 50%, #0f3460 100%)', cardBg: 'rgba(255,255,255,0.07)' };

  const giftRows = topGift.map((u, i) => {
    const isTop3 = i < 3;
    const top3cls = isTop3 ? ` class="row-top3 row-${['1st','2nd','3rd'][i]}"` : '';
    const av = findAvatar(data, u.name);
    const dn = cleanDisplayName(u.name);
    return `<tr${top3cls}><td class="rank">${rankBadge(i)}</td><td class="name"><span class="name-wrap">${avatarImg(av, 24, dn)}<span class="name-text gift-text" title="${u.name}">${dn}</span></span></td><td class="diamonds"><span class="d-wrap"><span class="d-val">${fmtNum(u.diamonds)}</span><span class="d-unit">${ICO.diamond}</span></span></td></tr>`;
  }).join('');
  const dmRows = topDanmaku.map((u, i) => {
    const isTop3 = i < 3;
    const top3cls = isTop3 ? ` class="row-top3 row-${['1st','2nd','3rd'][i]}"` : '';
    const av = findAvatar(data, u.name);
    const dn2 = cleanDisplayName(u.name);
    return `<tr${top3cls}><td class="rank">${rankBadge(i)}</td><td class="name"><span class="name-wrap">${avatarImg(av, 24, dn2)}<span class="name-text dm-text" title="${u.name}">${dn2}</span></span></td><td class="diamonds"><span class="d-wrap"><span class="d-val">${u.count}</span><span class="d-unit"> 条</span></span></td></tr>`;
  }).join('');

  return htmlWrap(theme, `
<div class="bg-pattern"></div>
<div class="card">
<style>
/* main */
table{width:100%;border-collapse:collapse;table-layout:fixed}
tr{border-bottom:1px solid rgba(255,255,255,0.04);height:38px}
tr:last-child{border-bottom:none}
td{padding:0 6px;font-size:15px;color:rgba(255,255,255,0.85);vertical-align:middle!important;line-height:1.55}
td.rank{width:34px;text-align:center;font-size:15px;font-weight:600;vertical-align:middle!important;line-height:1}
td.diamonds{text-align:right;font-weight:600;color:${theme.primary}cc;white-space:nowrap;width:100px;font-size:15px;vertical-align:middle!important}
.d-val{display:inline-block;min-width:70px;text-align:right;font-variant-numeric:tabular-nums;vertical-align:middle}
.d-unit{display:inline-flex;align-items:center;vertical-align:middle}
.d-wrap{display:inline-flex;align-items:center;gap:2px;vertical-align:middle;justify-content:flex-end}
.row-1st{background:linear-gradient(90deg,rgba(255,215,0,0.10)0%,transparent 60%)}
.row-2nd{background:linear-gradient(90deg,rgba(200,200,255,0.06)0%,transparent 60%)}
.row-3rd{background:linear-gradient(90deg,rgba(232,160,96,0.07)0%,transparent 60%)}
.row-1st td.name{color:#FFE44D}.row-2nd td.name{color:#C8C8FF}.row-3rd td.name{color:#E8A060}
.row-1st td.diamonds{color:#FFE44D}.row-2nd td.diamonds{color:#C8C8FF}.row-3rd td.diamonds{color:#E8A060}
.row-1st td.rank{color:#FFE44D}.row-2nd td.rank{color:#C8C8FF}.row-3rd td.rank{color:#E8A060}
.row-top3 td{padding:6px 4px;color:#fff}
.host-section{padding:0 32px;margin-top:10px}
.host-card{background:rgba(255,255,255,0.03);border-radius:12px;padding:14px 10px}
td.name{white-space:nowrap;overflow:hidden;font-weight:700;vertical-align:middle!important}
.name-wrap{display:inline-flex;align-items:center;gap:4px;height:100%}
.name-text{vertical-align:middle;overflow:hidden;text-overflow:ellipsis;display:inline-block}.host-text{max-width:300px}
.ranking-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:0 32px}
.ranking-col table{table-layout:fixed;width:100%}
.ranking-col td{padding:0 4px;font-size:14px;vertical-align:middle!important;height:38px}
.ranking-col td.rank{width:30px;font-size:14px;vertical-align:middle!important;text-align:center}
.ranking-col td.name{white-space:nowrap;overflow:hidden;font-size:15px;display:flex;align-items:center}
.ranking-col td.name .name-wrap{display:contents}
.ranking-col td.diamonds{width:100px;font-size:15px;text-align:right;vertical-align:middle!important}
.ranking-col .d-wrap{display:flex;align-items:center;gap:2px}
.ranking-col .d-val{min-width:80px;text-align:right;display:inline-block;font-variant-numeric:tabular-nums;flex-shrink:0}
.ranking-col .d-unit{display:inline-flex;align-items:center;margin-left:auto}
.ranking-col .name-text{overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}.gift-text{max-width:240px}.dm-text{max-width:200px}
.ranking-col .row-top3 td{padding:0 4px}
.ranking-col .row-top10 td{padding:0 4px}
.ranking-col .row-highlight td{padding:0 4px}
.row-highlight td{padding:5px 3px;font-size:14px;color:#FFD93D;font-weight:700;background:rgba(255,217,61,0.08);border-radius:4px}
.row-highlight td.diamonds{color:#FFD93D}
.row-top10 td{padding:5px 3px;color:rgba(255,255,255,0.90)}
.row-top10 td.diamonds{color:${theme.primary}}
.row-high td.diamonds{color:${theme.accent}}
</style>
  <!-- 头部 -->
  <div class="hero-section">
    ${data.room_avatar ? `<div class="hero-avatar-frame"><img class="hero-avatar" src="${data.room_avatar}" width="60" height="60"></div>` : `<div class="hero-icon">📺</div>`}
    <div class="hero-name">${data.room_author || '直播间'}</div>
    <div class="hero-time">${startTime} ~ ${endTime}</div>
    <div class="hero-duration">🕒 ${duration}</div>
    ${data.room_title ? `<div class="room-title-tag">${data.room_title}</div>` : ''}
  </div>

  <!-- 六格数据 -->
  <div class="stats-grid">
    <div class="stat-item"><div class="s-icon"><svg viewBox="0 0 24 24" fill="none" stroke="#42A5F5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="22" height="22"><path d="M8 9h8" /><path d="M8 13h6" /><path d="M9 18h-3a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-3l-3 3l-3 -3z" /></svg></div><div class="s-value">${fmtNum(danmakuCount)}</div><div class="s-label">弹幕</div></div>
    <div class="stat-item"><div class="s-icon"><svg viewBox="0 0 24 24" fill="none" stroke="#EC407A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="22" height="22"><path d="M19.5 12.572l-7.5 7.428l-7.5 -7.428a5 5 0 1 1 7.5 -6.566a5 5 0 1 1 7.5 6.572" /></svg></div><div class="s-value">${fmtNum(likeCount)}</div><div class="s-label">点赞</div></div>
    <div class="stat-item"><div class="s-icon"><svg viewBox="0 0 24 24" fill="none" stroke="#AB47BC" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="22" height="22"><path d="M6 5h12l3 5l-8.5 9.5a.7 .7 0 0 1 -1 0l-8.5 -9.5l3 -5" /><path d="M10 12l-2 -2.2l.6 -1" /></svg></div><div class="s-value">${fmtNum(totalDiamonds)}</div><div class="s-label">钻石</div></div>
    <div class="stat-item"><div class="s-icon"><svg viewBox="0 0 24 24" fill="none" stroke="#66BB6A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="22" height="22"><path d="M8 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0" /><path d="M6 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2" /></svg></div><div class="s-value">${fmtNum(memberCount)}</div><div class="s-label">进场</div></div>
    <div class="stat-item"><div class="s-icon"><svg viewBox="0 0 24 24" fill="none" stroke="#FFA726" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="22" height="22"><path d="M3 17l6 -6l4 4l8 -8" /><path d="M14 7l7 0l0 7" /></svg></div><div class="s-value">${fmtNum(onlinePeak)}</div><div class="s-label">峰值</div></div>
    <div class="stat-item"><div class="s-icon"><svg viewBox="0 0 24 24" fill="none" stroke="#7E57C2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="22" height="22"><path d="M8 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0" /><path d="M16 19h6" /><path d="M19 16v6" /><path d="M6 21v-2a4 4 0 0 1 4 -4h4" /></svg></div><div class="s-value">${fmtNum(followCount)}</div><div class="s-label">关注</div></div>
  </div>

\n  <!-- 主播排名（取代词云） -->
  ${buildHostRanking(data)}
  <!-- 送礼 & 弹幕 双列排行 -->
  <div class="ranking-grid" style="padding-top: 10px;">
    ${topGift.length ? `
    <div class="ranking-col">
      <div class="section-title">${ICO.gift} 送礼 TOP${Math.min(10, topGift.length)}</div>
      <table><tbody>${giftRows}</tbody></table>
    </div>` : ''}
    ${topDanmaku.length ? `
    <div class="ranking-col">
      <div class="section-title">${ICO.chat} 弹幕活跃榜</div>
      <table><tbody>${dmRows}</tbody></table>
    </div>` : ''}
  </div>

  <!-- AI 总结 -->
  <div class="ai-section">
    <div class="ai-title">💡 直播总结</div>
    <div class="ai-text">${aiComment}</div>
  </div>

  <!-- 底部 -->
  <div class="footer">由 404 · 抖音直播监控 生成</div>
</div>`);
}

// ────────── 用户专属礼物榜单 ──────────

function generateUserCardHTML(data, nickname) {
  const userGifts = data.gifts.filter(g =>
    g.nickname && g.nickname.toLowerCase().includes(nickname.toLowerCase())
  );
  if (!userGifts.length) return null;

  const byName = {};
  for (const g of userGifts) {
    const name = g.gift_name || g.giftName || '🎁';
    if (!byName[name]) byName[name] = { count: 0, diamonds: 0 };
    byName[name].count += parseInt(g.count || g.repeatCount || 1, 10) || 1;
    byName[name].diamonds += parseInt(g.total_diamonds || 0, 10) || 0;
  }
  const sorted = Object.entries(byName).sort((a, b) => b[1].diamonds - a[1].diamonds);
  const totalDiamonds = sorted.reduce((s, [_, d]) => s + d.diamonds, 0);
  const totalCount = sorted.reduce((s, [_, d]) => s + d.count, 0);
  const cny = (totalDiamonds / 10).toFixed(0);

  const startTime = new Date(data.start_time).toLocaleString('zh-CN', {
    month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai'
  });

  const giftRows = sorted.map(([giftName, info]) => {
    const perUnit = Math.round(info.diamonds / info.count);
    const e = info.count > 1 ? ` ×${info.count}` : '';
    return `<tr><td class="gift-icon">${ICO.gift}</td><td class="gift-name">${giftName}${e}</td><td class="gift-price">${perUnit.toLocaleString()}${ICO.diamond}</td><td class="gift-total">${info.diamonds.toLocaleString()}${ICO.diamond}</td></tr>`;
  }).join('');

  const userFirst = userGifts.length > 0 ? userGifts[0] : null;
  const userAvatar = userFirst && userFirst.avatar ? userFirst.avatar : '';

  const theme = {
    primary: '#FF6B9D',
    accent: '#FFD93D',
    bg: 'linear-gradient(135deg, #1a0a2e 0%, #16213e 50%, #0f3460 100%)',
    cardBg: 'rgba(255,255,255,0.07)',
  };

  return htmlWrap(theme, `
<div class="card" style="max-width:520px">
  <div class="hero">
    ${userAvatar ? `<div class="hero-avatar-frame"><img class="hero-avatar" src="${userAvatar}" width="72" height="72"></div>` : `<div class="hero-avatar-fallback">${ICO.gift}</div>`}
    <div class="hero-name">${nickname}</div>
    <div class="hero-msg">感谢你的支持 ${ICO.heart}</div>
  </div>
  <div class="total-bar">
    <div class="total-item"><div class="total-val">${fmtNum(totalCount)}</div><div class="total-lbl">礼物数</div></div>
    <div class="total-item highlight"><div class="total-val">${fmtNum(totalDiamonds)}</div><div class="total-lbl">总钻石</div></div>
    <div class="total-item"><div class="total-val">≈¥${fmtNum(cny)}</div><div class="total-lbl">价值</div></div>
  </div>
  <div class="section-title" style="text-align:center;margin:24px 0 16px">${ICO.gift} <span class="accent">送出礼物 ${sorted.length} 种</span></div>
  <table class="gift-table">
    <thead><tr><th></th><th style="text-align:left">礼物</th><th style="text-align:right">单价</th><th style="text-align:right;color:${theme.primary}">总计</th></tr></thead>
    <tbody>${giftRows}</tbody>
  </table>
  <div class="divider"></div>
  <div style="text-align:center;font-size:13px;color:rgba(255,255,255,0.45);margin-top:16px">直播时间：${startTime} ｜ 主播：${data.room_author || ''}</div>
  <div class="footer">由 404 · 抖音直播监控 生成</div>
</div>`);
}

// ────────── 全部送礼人榜单 ──────────

function generateAllGiftRankingHTML(data, highlightName) {
  const gStats = {};
  for (const g of data.gifts || []) {
    const userKey = g.user_sec_uid || g.user_display_id || g.nickname;
    if (!gStats[userKey]) gStats[userKey] = { diamonds: 0, name: g.nickname };
    gStats[userKey].diamonds += parseInt(String(g.total_diamonds), 10) || 0;
  }
  const sorted = Object.entries(gStats).sort((a, b) => b[1].diamonds - a[1].diamonds);
  const totalPeople = sorted.length;
  const totalDiamonds = sorted.reduce((s, [_, d]) => s + d.diamonds, 0);
  const totalDonors = sorted.filter(([_, s]) => s.diamonds > 0).length;

  const startTime = new Date(data.start_time).toLocaleString('zh-CN', {
    month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai'
  });

  // Split into columns for compact display
  const perCol = Math.ceil(sorted.length / 2);
  const leftCol = sorted.slice(0, perCol);
  const rightCol = sorted.slice(perCol);

  function rowHTML(entries, offset) {
    return entries.map(([key, s], i) => {
      const rank = offset + i + 1;
      const displayName = s.name || key;
      const badge = rankBadge(rank - 1);
      const isHighlight = highlightName && displayName.toLowerCase().includes(highlightName.toLowerCase());
      const isTop3 = rank <= 3;
      const top3label = ['1st','2nd','3rd'][rank-1] || '';
      let cls = '';
      if (isHighlight) cls = ' class="row-highlight"';
      else if (isTop3) cls = ` class="row-top3 row-${top3label}"`;
      else if (rank <= 10) cls = ' class="row-top10"';
      else if (s.diamonds >= 1000) cls = ' class="row-high"';
      const av = findAvatar(data, displayName);
      const marker = isHighlight ? '${ICO.crown} ' : '';
      const cn = cleanDisplayName(displayName);
      return `<tr${cls}><td class="rank">${badge}</td><td class="name"><span class="name-wrap">${avatarImg(av, 28, cn)}<span class="name-text all-text" title="${displayName}">${marker}${cn}</span></span></td><td class="diamonds"><span class="d-wrap"><span class="d-val">${fmtNum(s.diamonds)}</span><span class="d-unit">${ICO.diamond}</span></span></td></tr>`;
    }).join('');
  }
  var hasHighlight = sorted.some(([n]) => highlightName && n.toLowerCase().includes(highlightName.toLowerCase()));

  const leftRows = rowHTML(leftCol, 0);
  const rightRows = rowHTML(rightCol, perCol);

  const theme = {
    primary: '#FF6B6B',
    accent: '#FFD93D',
    bg: 'linear-gradient(135deg, #0F2027 0%, #203A43 50%, #2C5364 100%)',
    cardBg: 'rgba(255,255,255,0.07)',
  };

  return htmlWrap(theme, `
<div class="card">
  <div class="header">
    <div class="emoji">${ICO.gift}</div>
    <h1>${data.room_author || '直播间'} · 送礼榜单</h1>
    <div class="subtitle">${startTime} ｜ 共 ${totalPeople} 位观众送出 ${ICO.diamond}${fmtNum(totalDiamonds)} 钻石</div>
    <div class="room-title">${data.room_title || ''}</div>
  </div>

  <div class="ranking-grid">
    <div class="ranking-col">
      <table>${leftRows}</table>
    </div>
    <div class="ranking-col">
      <table>${rightRows}</table>
    </div>
  </div>

  <div style="text-align:center;font-size:12px;color:rgba(255,255,255,0.3);margin-top:20px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.06)">
    ${hasHighlight ? '${ICO.crown} 标记 = ' + highlightName + '  · ' : ''}榜单完整 · 共计 ${totalPeople} 位送礼观众
  </div>
  <div class="footer">由 404 · 抖音直播监控 生成</div>
</div>`);
}

// ────────── HTML 模板封装 ──────────

function htmlWrap(theme, bodyContent) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;600;700;800;900&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Noto Sans SC', -apple-system, BlinkMacSystemFont, sans-serif;
    background: ${theme.bg};
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px;
    position: relative;
    overflow-x: hidden;
  }
  .bg-pattern {
    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    background-image:
      radial-gradient(circle at 20% 30%, rgba(108,99,255,0.08) 0%, transparent 50%),
      radial-gradient(circle at 80% 70%, rgba(255,107,157,0.06) 0%, transparent 50%);
    pointer-events: none;
  }

  /* 主卡片 */
  .card {
    width: 750px;
    max-width: 100%;
    background: rgba(255,255,255,0.07);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border: 1px solid rgba(255,255,255,0.10);
    border-radius: 24px;
    padding: 0;
    box-shadow: 0 25px 60px rgba(0,0,0,0.5);
    overflow: hidden;
    position: relative;
  }

  /* 全榜单头部 */
  .header {
    text-align: center;
    padding: 28px 32px 20px;
    background: linear-gradient(180deg, rgba(108,99,255,0.20) 0%, transparent 100%);
    position: relative;
  }
  .header .emoji { font-size: 52px; margin-bottom: 10px; }
  .header h1 { font-size: 28px; font-weight: 900; color: #fff; letter-spacing: 1px; margin: 0; }
  .header .subtitle { font-size: 14px; color: rgba(255,255,255,0.6); margin-top: 8px; }
  .header .room-title { font-size: 13px; color: rgba(255,255,255,0.4); margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .header::after {
    content: ''; position: absolute; bottom: 0; left: 8%; right: 8%;
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(255,255,255,0.12), transparent);
  }

  /* 头部渐变区域 */
  .hero-section {
    background: linear-gradient(180deg, rgba(108,99,255,0.25) 0%, rgba(255,255,255,0.03) 100%);
    text-align: center;
    padding: 28px 32px 16px;
    position: relative;
  }
  .hero-section::after {
    content: ''; position: absolute; bottom: 0; left: 10%; right: 10%;
    height: 1px; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.15), transparent);
  }
  .hero-icon { font-size: 42px; margin-bottom: 8px; }
  .hero-name { font-size: 32px; font-weight: 900; color: #fff; letter-spacing: 2px; }
  .hero-time { font-size: 14px; color: rgba(255,255,255,0.7); margin-top: 6px; }
  .hero-duration {
    display: inline-block; margin-top: 8px;
    padding: 4px 16px; background: rgba(255,255,255,0.08);
    border-radius: 20px; font-size: 14px; color: rgba(255,255,255,0.7);
  }

  .room-title-tag {
    text-align: center;
    padding: 0 32px;
    margin-top: 6px;
    font-size: 13px; color: rgba(255,255,255,0.65);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  /* 数据格子 */
  .stats-grid {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 8px;
    padding: 10px 32px 4px;
  }
  .stat-item {
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.04);
    border-radius: 12px;
    padding: 10px 6px;
    text-align: center;
  }
  .s-icon { font-size: 22px; display:flex; align-items:center; justify-content:center; opacity:1; color: #fff; }
  .s-value { font-size: 24px; font-weight: 800; color: #fff; margin-top: 4px; }
  .s-label { font-size: 13px; color: rgba(255,255,255,0.55); margin-top: 2px; font-weight: 700; }

  /* 分区 */
  .section-title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 14px;
    font-weight: 700;
    color: rgba(255,255,255,0.75);
    margin-bottom: 8px;
    letter-spacing: 0.5px;
  }

  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  tr { border-bottom: 1px solid rgba(255,255,255,0.04); height: 38px; }
  tr:last-child { border-bottom: none; }
  td { padding: 0 6px; font-size: 15px; color: rgba(255,255,255,0.85); vertical-align: middle !important; line-height: 1.55; }
  td.rank { width: 34px; text-align: center; font-size: 15px; font-weight: 600; vertical-align: middle !important; line-height: 1; }
  td.diamonds { text-align: right; font-weight: 600; color: ${theme.primary}cc; white-space: nowrap; width: 100px; font-size: 15px; vertical-align: middle !important; }
  .d-val { display: inline-block; min-width: 70px; text-align: right; font-variant-numeric: tabular-nums; vertical-align: middle; }
  .d-unit { display: inline-flex; align-items: center; vertical-align: middle; }
  .d-wrap { display: inline-flex; align-items: center; gap: 2px; vertical-align: middle; justify-content: flex-end; }

  /* ===== TOP 3 特殊样式（颜色区分，字号统一） ===== */
  .row-1st {
    background: linear-gradient(90deg, rgba(255,215,0,0.10) 0%, transparent 60%);
  }
  .row-2nd {
    background: linear-gradient(90deg, rgba(200,200,255,0.06) 0%, transparent 60%);
  }
  .row-3rd {
    background: linear-gradient(90deg, rgba(232,160,96,0.07) 0%, transparent 60%);
  }
  .row-1st td.name { color: #FFE44D; }
  .row-2nd td.name { color: #C8C8FF; }
  .row-3rd td.name { color: #E8A060; }
  .row-1st td.diamonds { color: #FFE44D; }
  .row-2nd td.diamonds { color: #C8C8FF; }
  .row-3rd td.diamonds { color: #E8A060; }
  .row-1st td.rank { color: #FFE44D; }
  .row-2nd td.rank { color: #C8C8FF; }
  .row-3rd td.rank { color: #E8A060; }
  .row-top3 td { padding: 6px 4px; color: #fff; }
  .row-top3 td.diamonds { }

  /* 主播排名样式 */
  .host-section {
    padding: 0 32px;
    margin-top: 10px;
  }
  .host-card {
    background: rgba(255,255,255,0.03);
    border-radius: 12px;
    padding: 14px 10px;
  }

  /* AI 总结背景框 */
  .ai-section {
    margin: 6px 32px 0;
    padding: 14px 18px;
    background: rgba(255,255,255,0.04);
    border-radius: 12px;
    border-left: 3px solid ${theme.primary};
  }
  .ai-title {
    font-size: 12px; color: rgba(255,255,255,0.5); font-weight: 700;
    margin-bottom: 6px; letter-spacing: 0.5px;
  }
  .ai-text {
    font-size: 13px; color: rgba(255,255,255,0.6); line-height: 1.6;
  }

  /* 底部 */
  .footer {
    text-align: center;
    margin-top: 10px;
    padding: 12px 32px 16px;
    font-size: 11px;
    color: rgba(255,255,255,0.45);
    line-height: 1.5;
    letter-spacing: 0.5px;
    border-top: 1px solid rgba(255,255,255,0.04);
  }

  /* ===== 双列排行布局（用于全榜单 & --to） ===== */
  .ranking-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    padding: 0 32px;
  }
  .ranking-col table {
    table-layout: fixed;
    width: 100%;
  }
  .ranking-col td {
    padding: 0 4px;
    font-size: 14px;
    vertical-align: middle !important;
    height: 36px;
  }
  .ranking-col td.rank { width: 30px; font-size: 14px; vertical-align: middle !important; text-align: center; }
  .ranking-col td.name { white-space: nowrap; overflow: hidden; font-size: 15px; vertical-align: middle !important; }
  .ranking-col td.name .name-wrap { display: inline-flex; align-items: center; gap: 4px; height: 100%; }
  .ranking-col td.diamonds { width: 100px; font-size: 16px; text-align: right; vertical-align: middle !important; }
  .ranking-col .d-wrap { display: flex; align-items: center; gap: 2px; }
  .ranking-col .d-val { min-width: 80px; text-align: right; display: inline-block; font-variant-numeric: tabular-nums; flex-shrink: 0; }
  .ranking-col .d-unit { display: inline-flex; align-items: center; margin-left: auto; flex-shrink: 0; }









  .row-highlight td { padding: 5px 3px; font-size: 14px; color: #FFD93D; font-weight: 700; background: rgba(255,217,61,0.08); border-radius: 4px; }
  .row-highlight td.rank { }
  .row-highlight td.diamonds { color: #FFD93D; }
  .row-top10 td { padding: 5px 3px; color: rgba(255,255,255,0.90); }
  .row-top10 td.diamonds { color: ${theme.primary}; }
  .row-high td.diamonds { color: ${theme.accent}; }

  /* ===== 头像 ===== */
  .av-i, .av-f {
    display: inline-block; border-radius: 50%; object-fit: cover; vertical-align: middle;
    margin-right: 8px; flex-shrink: 0;
  }
  .av-f {
    background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.4);
    display: inline-flex; align-items: center; justify-content: center;
    width: 26px; height: 26px; font-size: 14px; overflow: hidden;
  }
  td.name {
    white-space: nowrap; overflow: hidden;
    font-weight: 700; vertical-align: middle !important;
  }
  .name-wrap {
    display: inline-flex; align-items: center; gap: 4px; height: 100%;
  }
  .name-text {
    vertical-align: middle; overflow: hidden; text-overflow: ellipsis; max-width: 300px; display: inline-block;
  }


  /* 双列排行中的头像 */
  .ranking-col .av-i { width: 24px; height: 24px; }
  .ranking-col .av-f { width: 24px; height: 24px; font-size: 13px; overflow: hidden; }

  /* 主播头像 */
  .hero-avatar-frame {
    width: 68px; height: 68px; margin: 0 auto 8px;
    border-radius: 50%;
    background: linear-gradient(135deg, ${theme.primary}66, ${theme.accent}66);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .hero-avatar {
    width: 60px; height: 60px; border-radius: 50%; object-fit: cover; display: block;
  }

  /* ===== 用户专属 ===== */
  .hero { text-align: center; padding: 10px 0 24px; }
  .hero .hero-avatar-frame {
    width: 82px; height: 82px; margin: 0 auto 16px;
    border-radius: 50%;
    background: linear-gradient(135deg, ${theme.primary}44, ${theme.primary}22);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .hero .hero-avatar {
    width: 72px; height: 72px; border-radius: 50%; object-fit: cover; display: block;
  }
  .hero .hero-avatar-fallback {
    width: 80px; height: 80px; margin: 0 auto 16px;
    background: linear-gradient(135deg, ${theme.primary}44, ${theme.primary}22);
    border-radius: 50%; border: 2px solid ${theme.primary}66;
    display: flex; align-items: center; justify-content: center;
    font-size: 36px;
  }
  .hero-name { font-size: 30px; font-weight: 900; color: #fff; }
  .hero-msg { font-size: 15px; color: rgba(255,255,255,0.65); margin-top: 6px; }
  .total-bar { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; background: rgba(255,255,255,0.04); border-radius: 16px; padding: 22px; }
  .total-item { text-align: center; }
  .total-val { font-size: 24px; font-weight: 800; color: #fff; }
  .total-lbl { font-size: 12px; color: rgba(255,255,255,0.55); margin-top: 4px; }
  .total-item.highlight .total-val { color: ${theme.primary}; }
  .gift-table th { font-size: 12px; color: rgba(255,255,255,0.55); padding: 8px 4px; font-weight: 400; }
  .gift-table td { padding: 10px 4px; vertical-align: middle; font-size: 15px; }
  .gift-icon { width: 34px; text-align: center; font-size: 18px; }
  .gift-name { font-weight: 600; color: #fff; }
  .gift-price { text-align: right; color: rgba(255,255,255,0.5); font-size: 14px; white-space: nowrap; }
  .gift-total { text-align: right; font-weight: 700; color: ${theme.primary}; white-space: nowrap; font-size: 15px; }
</style>
</head>
<body>${bodyContent}</body>
</html>`;
}

// ────────── 截图 ──────────

async function screenshotHTML(html, outputPath) {
  const reportsDir = path.join(DATA_DIR, 'reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  const htmlPath = path.join(DATA_DIR, 'report_temp.html');
  fs.writeFileSync(htmlPath, html, 'utf-8');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 900, height: 1 }, deviceScaleFactor: 2 });
  await page.goto('file://' + htmlPath, { waitUntil: 'load', timeout: 60000 });
  const bodyHeight = await page.evaluate(() => document.body.scrollHeight);
  await page.setViewportSize({ width: 900, height: bodyHeight });
  await page.screenshot({ path: outputPath, fullPage: true, type: 'jpeg', quality: 90 });
  await browser.close();
  fs.unlinkSync(htmlPath);
  return outputPath;
}

async function generateImage(data) {
  patchSessionData(data);
  const html = generateHTML(data);
  return screenshotHTML(html, path.join(DATA_DIR, 'reports', 'report_image.jpg'));
}

async function generateUserImage(data, nickname) {
  patchSessionData(data);
  const html = generateUserCardHTML(data, nickname);
  if (!html) return null;
  return screenshotHTML(html, path.join(DATA_DIR, 'reports', `report_${nickname.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_')}.jpg`));
}

async function generateAllGiftRankingImage(data, highlightName) {
  patchSessionData(data);
  const html = generateAllGiftRankingHTML(data, highlightName);
  return screenshotHTML(html, path.join(DATA_DIR, 'reports', 'report_all_gifts.jpg'));
}

// ────────── 入口 ──────────

async function main() {
  const args = process.argv.slice(2);
  const useJson = args.includes('--json');
  const sessionIdx = args.indexOf('--session');
  let data = null;
  if (sessionIdx >= 0) {
    const sid = parseInt(args[sessionIdx + 1], 10);
    if (sid) data = await loadFromDb(sid);
  }
  if (!data) data = useJson ? loadJson() : await load();
  if (!data) { console.error('没有找到监控数据'); process.exit(1); }

  const userIdx = args.indexOf('--user');
  const nickname = userIdx >= 0 ? args[userIdx + 1] : null;
  const allGifts = args.includes('--all');
  const highlightIdx = args.indexOf('--highlight');
  const highlightName = highlightIdx >= 0 ? args[highlightIdx + 1] : null;
  const toIdx = args.indexOf('--to');
  const toName = toIdx >= 0 ? args[toIdx + 1] : null;
  const outputOnly = args.includes('--output');

  const feishu = require('./feishu-send.js');
  const chatId = 'oc_3eda7639e779aaa5f74493c09d2a1881';

  if (toName) {
    // 筛选送给某个人的礼物
    const toGifts = data.gifts.filter(g => g.to_nickname && g.to_nickname.includes(toName));
    if (!toGifts.length) {
      console.log('提示：当前数据中没有 to_nickname 字段，需要等下次直播采集新数据后可用');
      console.log('（已在 monitor.js 修复，下次直播会自动记录）');
      process.exit(1);
    }
    // 按送礼人统计（用 ID 去重，防同名）
    const fromStats = {};
    for (const g of toGifts) {
      const userKey = g.user_sec_uid || g.user_display_id || g.nickname;
      if (!fromStats[userKey]) fromStats[userKey] = { diamonds: 0, name: g.nickname };
      fromStats[userKey].diamonds += parseInt(g.total_diamonds, 10) || 0;
    }
    const allSorted = Object.entries(fromStats).sort((a,b) => b[1].diamonds - a[1].diamonds);
    const totalDiamonds = allSorted.reduce((s, [_,d]) => s + d.diamonds, 0);
    const sorted = allSorted.slice(0, 100);
    const startTime = new Date(data.start_time).toLocaleString('zh-CN',{month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'Asia/Shanghai'});
    const endTime = data.end_time
      ? new Date(data.end_time).toLocaleString('zh-CN',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Shanghai'})
      : '直播中';
    const perCol = Math.ceil(sorted.length / 2);

    function fmtNum(n) { return (parseInt(n,10)||0).toLocaleString(); }
    const theme = { primary: '#FF6B9D', accent: '#FFD93D', bg: 'linear-gradient(135deg, #1a0a2e 0%, #16213e 50%, #0f3460 100%)', cardBg: 'rgba(255,255,255,0.07)' };

    function colHTML(entries, offset) {
      return entries.map(([key, s], i) => {
        const rank = offset + i + 1;
        const rawName = s.name || key;
        const displayName = cleanDisplayName(rawName);
        const isTop3 = rank <= 3;
        const top3cls = isTop3 ? ` class="row-top3 row-${['1st','2nd','3rd'][rank-1]}"` : '';
        const av = findAvatar(data, rawName);
        return `<tr${top3cls}><td class="rank">${rankBadge(offset+i)}</td><td class="name"><span class="name-wrap">${avatarImg(av, 22, displayName)}<span class="name-text to-text" title="${rawName}">${displayName}</span></span></td><td class="diamonds"><span class="d-wrap"><span class="d-val">${fmtNum(s.diamonds)}</span><span class="d-unit">${ICO.diamond}</span></span></td></tr>`;
      }).join('');
    }
    const left = sorted.slice(0, perCol);
    const right = sorted.slice(perCol);

    // 行 HTML 生成函数（与主报告 buildHostRanking 一致）
    function makeRowHTML(entries, offset) {
      return entries.map(([key, s], j) => {
        const i = offset + j;
        const displayName = cleanDisplayName(s.name || key);
        const isTop3 = i < 3;
        const top3cls = isTop3 ? ` class="row-top3 row-${['1st','2nd','3rd'][i]}"` : '';
        const av = findAvatar(data, s.name || key);
        return `<tr${top3cls}><td class="rank">${rankBadge(i)}</td><td class="name"><span class="name-wrap">${avatarImg(av, 22, displayName)}<span class="name-text to-text" title="${s.name || key}">${displayName}</span></span></td><td class="diamonds"><span class="d-wrap"><span class="d-val">${fmtNum(s.diamonds)}</span><span class="d-unit">${ICO.diamond}</span></span></td></tr>`;
      }).join('');
    }

    // 查找被送礼人头像
    let toAvatar = '';
    // 1. 先用 secUid 查抖音 API 拿头像
    const toSecUid = data.gifts.find(g => g.to_nickname && g.to_nickname.includes(toName) && g.to_user_sec_uid);
    if (toSecUid && toSecUid.to_user_sec_uid) {
      try {
        const { execSync } = require('child_process');
        const result = execSync('node ' + __dirname + '/douyin-user.js "' + toSecUid.to_user_sec_uid + '"', { timeout: 10000, encoding: 'utf-8' });
        const user = JSON.parse(result);
        if (user && user.avatar) {
          toAvatar = user.avatar;
          if (!data.toUserAvatars) data.toUserAvatars = {};
          data.toUserAvatars[toSecUid.to_user_sec_uid] = user.avatar;
        }
      } catch(e) {}
    }
    // 2. API 查不到 → 从 members 表按 secUid 找头像
    if (!toAvatar && toSecUid && toSecUid.to_user_sec_uid) {
      toAvatar = findAvatarBySecUid(data, toSecUid.to_user_sec_uid);
    }
    // 3. 还是找不到 → findAvatar（特殊覆盖 / to_avatar / 弹幕）
    if (!toAvatar) toAvatar = findAvatar(data, toName);
    const toAvatarHTML = toAvatar
      ? `<div style="width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,${theme.primary}66,${theme.accent}66);display:flex;align-items:center;justify-content:center;flex-shrink:0"><img src="${toAvatar}" style="width:46px;height:46px;border-radius:50%;object-fit:cover;display:block"></div>`
      : placeholderAvatarHTML(toName, 52);

    const html = htmlWrap(theme, `<style>
/* 礼物榜单表格 */
table{width:100%;border-collapse:collapse;table-layout:fixed}
tr{border-bottom:1px solid rgba(255,255,255,0.04);height:38px}
tr:last-child{border-bottom:none}
td{padding:0 6px;font-size:15px;color:rgba(255,255,255,0.85);vertical-align:middle!important;line-height:1.55}
td.rank{width:34px;text-align:center;font-size:15px;font-weight:600;vertical-align:middle!important;line-height:1}
td.diamonds{text-align:right;font-weight:600;color:${theme.primary}cc;white-space:nowrap;width:100px;font-size:15px;vertical-align:middle!important}
.d-val{display:inline-block;min-width:70px;text-align:right;font-variant-numeric:tabular-nums;vertical-align:middle;flex-shrink:0}
.d-unit{display:inline-flex;align-items:center;vertical-align:middle;margin-left:auto;flex-shrink:0}
.d-wrap{display:flex;align-items:center;gap:2px;vertical-align:middle}
.row-1st td.name{color:#FFE44D}.row-2nd td.name{color:#C8C8FF}.row-3rd td.name{color:#E8A060}
.row-top3 td{padding:6px 4px;color:#fff}
td.name{white-space:nowrap;overflow:hidden;font-weight:700;vertical-align:middle!important}
.name-wrap{display:inline-flex;align-items:center;gap:4px;height:100%}
.name-text{vertical-align:middle;overflow:hidden;text-overflow:ellipsis;display:inline-block}.host-text{max-width:300px}
.to-text{max-width:180px}
/* 双列布局（和主报告一致） */
.ranking-grid{display:grid;gap:10px;padding:0}
.ranking-col td{padding:0 4px;font-size:15px;vertical-align:middle!important;height:38px}
.ranking-col td.rank{width:30px;font-size:15px;vertical-align:middle!important;text-align:center;line-height:1}
.ranking-col td.name{white-space:nowrap;overflow:hidden;font-size:15px;display:flex;align-items:center}
.ranking-col td.name .name-wrap{display:contents}
.ranking-col td.diamonds{width:90px;font-size:15px;text-align:right;vertical-align:middle!important}
.ranking-col .d-val{min-width:70px;text-align:right;display:inline-block;font-variant-numeric:tabular-nums;flex-shrink:0}
.ranking-col .d-unit{display:inline-flex;align-items:center;margin-left:auto;flex-shrink:0}
.ranking-col .d-wrap{display:flex;align-items:center;gap:2px}
.ranking-col .name-text{overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
.ranking-col .row-top3 td{padding:0 4px}
</style>
<div class="card" style="padding:0!important">
  <!-- 顶部主体栏 -->
  <div style="display:flex;align-items:center;gap:14px;padding:20px 24px;background:linear-gradient(180deg,rgba(255,107,157,0.06) 0%,transparent 100%);border-bottom:1px solid rgba(255,255,255,0.06)">
    ${toAvatarHTML}
    <div style="flex:1;min-width:0">
      <div style="font-size:18px;font-weight:700;color:#fff;line-height:1.3">${toName}</div>
      <div style="font-size:12px;color:rgba(255,255,255,0.35);margin-top:4px">${startTime} ~ ${endTime}</div>
    </div>
    <div style="text-align:right;flex-shrink:0">
      <div style="font-size:22px;font-weight:800;color:${theme.primary}">${ICO.diamond}${fmtNum(totalDiamonds)}</div>
      <div style="font-size:11px;color:rgba(255,255,255,0.35);margin-top:2px">共 ${allSorted.length} 人 · 榜单 TOP100</div>
    </div>
  </div>

  <!-- 榜单标题 -->
  <div style="font-size:13px;font-weight:700;color:rgba(255,255,255,0.5);padding:14px 24px 6px;letter-spacing:0.5px;border-bottom:1px solid rgba(255,255,255,0.03)">🎁 礼物榜单</div>

  <!-- 榜单主体（使用和主报告一致的双列 grid+col 方案） -->
  <div style="padding:6px 24px 14px">
    <div class="ranking-grid" style="grid-template-columns:1fr 1fr;gap:10px">
      <div class="ranking-col">
        <table style="width:100%;table-layout:fixed"><tbody>${makeRowHTML(left, 0)}</tbody></table>
      </div>
      <div class="ranking-col">
        <table style="width:100%;table-layout:fixed"><tbody>${makeRowHTML(right, perCol)}</tbody></table>
      </div>
    </div>
  </div>
  <div class="footer" style="text-align:center;padding:10px 24px 14px;font-size:10px;color:rgba(255,255,255,0.3);letter-spacing:0.5px">由 404 · 抖音直播监控 生成</div>
</div>`);

    const feishu = require('./feishu-send.js');
    const chatId = 'oc_3eda7639e779aaa5f74493c09d2a1881';
    const imgPath = await screenshotHTML(html, path.join(DATA_DIR, 'reports', 'report_to_gift.jpg'));
    if (outputOnly) { console.log(imgPath); return; }
    const ok = await feishu.sendImage(chatId, imgPath);
    if (ok) { console.log('送给「' + toName + '」的礼物榜单已发送 ✅'); fs.unlinkSync(imgPath); }
    else { console.error('发送失败'); }
  } else if (nickname) {
    const imgPath = await generateUserImage(data, nickname);
    if (!imgPath) { console.error(`未找到用户「${nickname}」的礼物数据`); process.exit(1); }
    if (outputOnly) { console.log(imgPath); return; }
    const ok = await feishu.sendImage(chatId, imgPath);
    if (ok) { console.log(`用户「${nickname}」礼物榜单已发送 ✅`); fs.unlinkSync(imgPath); }
    else { console.error('发送失败'); }
  } else if (allGifts) {
    const imgPath = await generateAllGiftRankingImage(data, highlightName);
    if (outputOnly) { console.log(imgPath); return; }
    const ok = await feishu.sendImage(chatId, imgPath);
    if (ok) { console.log('全部送礼榜单已发送 ✅'); fs.unlinkSync(imgPath); }
    else { console.error('发送失败'); }
  } else {
    const imgPath = await generateImage(data);
    if (outputOnly) { console.log(imgPath); return; }
    const ok = await feishu.sendImage(chatId, imgPath);
    if (ok) { console.log('报告图片已发送 ✅'); fs.unlinkSync(imgPath); }
    else { console.error('发送失败'); }
  }
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { generateImage, generateHTML, generateUserImage, generateUserCardHTML, generateAllGiftRankingImage, generateAllGiftRankingHTML, load, loadJson, loadFromDb, getLatestSessionId };