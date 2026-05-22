/**
 * douyin-live MySQL 数据库模块
 * 支持连接池，单例工厂模式
 */

const mysql = require('mysql2/promise');

// 数据库配置 — 优先从环境变量读取，否则使用默认值
const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'douyinlive',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'douyinlive',
  waitForConnections: true,
  connectionLimit: parseInt(process.env.DB_POOL || '5', 10),
  queueLimit: 0,
  timezone: '+08:00'
};

// 检查密码是否已配置
if (!DB_CONFIG.password) {
  console.warn('[db] ⚠️ 数据库密码未配置！请设置环境变量 DB_PASSWORD');
}

let pool = null;

/** 获取连接池 */
function getPool() {
  if (!pool) {
    pool = mysql.createPool(DB_CONFIG);
  }
  return pool;
}

/** 初始化建表 */
async function init() {
  const conn = await getPool().getConnection();
  try {
    const sqls = [
      `CREATE TABLE IF NOT EXISTS streamers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        room_id VARCHAR(100) DEFAULT NULL,
        avatar TEXT DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

      `CREATE TABLE IF NOT EXISTS sessions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        streamer_id INT NOT NULL,
        room_title VARCHAR(255) DEFAULT NULL,
        room_id VARCHAR(100) DEFAULT NULL,
        start_time DATETIME DEFAULT NULL,
        end_time DATETIME DEFAULT NULL,
        duration_seconds INT DEFAULT 0,
        stats_danmaku INT DEFAULT 0,
        stats_gift INT DEFAULT 0,
        stats_like INT DEFAULT 0,
        stats_member INT DEFAULT 0,
        stats_follow INT DEFAULT 0,
        stats_social INT DEFAULT 0,
        raw_messages_count INT DEFAULT 0,
        archived TINYINT DEFAULT 0,
        file_path VARCHAR(500) DEFAULT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (streamer_id) REFERENCES streamers(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

      `CREATE TABLE IF NOT EXISTS danmaku (
        id INT AUTO_INCREMENT PRIMARY KEY,
        session_id INT NOT NULL,
        msg_id VARCHAR(100) DEFAULT NULL,
        nickname VARCHAR(255) DEFAULT NULL,
        avatar TEXT DEFAULT NULL,
        content TEXT DEFAULT NULL,
        create_time BIGINT DEFAULT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        INDEX idx_danmaku_session (session_id),
        INDEX idx_danmaku_user (nickname(64))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

      `CREATE TABLE IF NOT EXISTS gifts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        session_id INT NOT NULL,
        msg_id VARCHAR(100) DEFAULT NULL,
        nickname VARCHAR(255) DEFAULT NULL,
        avatar TEXT DEFAULT NULL,
        to_nickname VARCHAR(255) DEFAULT NULL,
        to_avatar TEXT DEFAULT NULL,
        gift_name VARCHAR(255) DEFAULT NULL,
        diamond_count INT DEFAULT 0,
        repeat_count INT DEFAULT 1,
        total_diamonds INT DEFAULT 0,
        create_time BIGINT DEFAULT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        INDEX idx_gifts_session (session_id),
        INDEX idx_gifts_user (nickname(64))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

      `CREATE TABLE IF NOT EXISTS members (
        id INT AUTO_INCREMENT PRIMARY KEY,
        session_id INT NOT NULL,
        msg_id VARCHAR(100) DEFAULT NULL,
        nickname VARCHAR(255) DEFAULT NULL,
        avatar TEXT DEFAULT NULL,
        create_time BIGINT DEFAULT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        INDEX idx_members_session (session_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

      `CREATE TABLE IF NOT EXISTS online_records (
        id INT AUTO_INCREMENT PRIMARY KEY,
        session_id INT NOT NULL,
        count INT NOT NULL DEFAULT 0,
        recorded_at BIGINT DEFAULT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        INDEX idx_online_session_time (session_id, recorded_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    ];
    for (const sql of sqls) {
      await conn.query(sql);
    }
    // 给 gifts 表加新列（兼容已有数据库，忽略重复列错误）
    const alterSqls = [
      'ALTER TABLE gifts ADD COLUMN trace_id VARCHAR(64) DEFAULT NULL',
      'ALTER TABLE gifts ADD COLUMN combo_count INT DEFAULT 0',
      'ALTER TABLE gifts ADD COLUMN repeat_end TINYINT(1) DEFAULT NULL',
      'ALTER TABLE gifts ADD COLUMN group_count INT DEFAULT 1',
      'ALTER TABLE gifts ADD COLUMN send_type TINYINT(2) DEFAULT NULL',
    ];
    for (const sql of alterSqls) {
      try { await conn.query(sql); }
      catch (e) { if (!e.message.includes('Duplicate column')) throw e; }
    }
    console.log('[db] 表结构初始化完成');
  } finally {
    conn.release();
  }
}

/** 获取/创建主播 */
async function upsertStreamer(name, roomId, avatar) {
  const conn = await getPool().getConnection();
  try {
    // 先按 room_id 查找（防止同名主播不同 ID）
    if (roomId) {
      const [byRoom] = await conn.query('SELECT id FROM streamers WHERE room_id = ?', [roomId]);
      if (byRoom.length > 0) {
        const id = byRoom[0].id;
        if (name || avatar) {
          await conn.query('UPDATE streamers SET name = COALESCE(?, name), avatar = COALESCE(?, avatar) WHERE id = ?',
            [name || null, avatar || null, id]);
        }
        return id;
      }
    }
    // 次按 name 查找
    if (name) {
      const [byName] = await conn.query('SELECT id FROM streamers WHERE name = ?', [name]);
      if (byName.length > 0) {
        const id = byName[0].id;
        if (roomId || avatar) {
          await conn.query('UPDATE streamers SET room_id = COALESCE(?, room_id), avatar = COALESCE(?, avatar) WHERE id = ?',
            [roomId || null, avatar || null, id]);
        }
        return id;
      }
    }
    // 都没有则新建
    const [r] = await conn.query('INSERT INTO streamers (name, room_id, avatar) VALUES (?, ?, ?)',
      [name || roomId || '未知主播', roomId || null, avatar || null]);
    return r.insertId;
  } finally {
    conn.release();
  }
}

/** 创建新 session */
async function createSession(streamerId, roomTitle, roomId) {
  const conn = await getPool().getConnection();
  try {
    const [r] = await conn.query(
      'INSERT INTO sessions (streamer_id, room_title, room_id, start_time) VALUES (?, ?, ?, NOW())',
      [streamerId, roomTitle || null, roomId || null]);
    return r.insertId;
  } finally {
    conn.release();
  }
}

/** 获取当前直播 session（最新一条未结束的） */
async function getCurrentSession() {
  const [rows] = await getPool().query(
    'SELECT * FROM sessions WHERE end_time IS NULL ORDER BY start_time DESC LIMIT 1');
  return rows[0] || null;
}

/** 结束 session */
async function endSession(sessionId, durationSeconds, filePath) {
  await getPool().query(
    'UPDATE sessions SET end_time = NOW(), duration_seconds = ?, file_path = ?, archived = 1 WHERE id = ?',
    [durationSeconds || 0, filePath || null, sessionId]);
}

/** 更新 session 统计（增量） */
async function updateSessionStats(sessionId, stats) {
  if (!stats) return;
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(stats)) {
    if (['danmaku', 'gift', 'like', 'member', 'follow', 'social'].includes(k) && v != null) {
      sets.push(`stats_${k} = COALESCE(stats_${k}, 0) + ?`);
      vals.push(v);
    }
  }
  if (sets.length === 0) return;
  vals.push(sessionId);
  await getPool().query(`UPDATE sessions SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ?`, vals);
}

/** 批量写入弹幕 */
async function insertDanmaku(sessionId, items) {
  if (!items || items.length === 0) return;
  const conn = await getPool().getConnection();
  try {
    const stmt = 'INSERT IGNORE INTO danmaku (session_id, msg_id, nickname, avatar, content, user_display_id, user_sec_uid, create_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
    for (const item of items) {
      await conn.query(stmt, [sessionId, item.msgId || null, item.nickname || null, item.avatar || null,
        item.content || null, item.userDisplayId || null, item.userSecUid || null,
        item.createTime || null]);
    }
  } finally {
    conn.release();
  }
}

/** 批量写入礼物 */
async function insertGifts(sessionId, items) {
  if (!items || items.length === 0) return;
  const conn = await getPool().getConnection();
  try {
    const stmt = 'INSERT IGNORE INTO gifts (session_id, msg_id, nickname, avatar, to_nickname, to_avatar, to_user_display_id, to_user_sec_uid, gift_name, diamond_count, repeat_count, total_diamonds, user_display_id, user_sec_uid, create_time, trace_id, combo_count, repeat_end, group_count, send_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
    for (const item of items) {
      await conn.query(stmt, [sessionId, item.msgId || null, item.nickname || null, item.avatar || null,
        item.toNickname || null, item.toAvatar || null, item.toUserDisplayId || null, item.toUserSecUid || null,
        item.giftName || null, item.diamondCount || 0, item.repeatCount || 1,
        item.totalDiamonds || 0, item.userDisplayId || null, item.userSecUid || null,
        item.createTime || null, item.traceId || null, item.comboCount || 0, item.repeatEnd ?? null,
        item.groupCount || 1, item.sendType || null]);
    }
  } finally {
    conn.release();
  }
}

/** 批量写入进场 */
async function insertMembers(sessionId, items) {
  if (!items || items.length === 0) return;
  const conn = await getPool().getConnection();
  try {
    const stmt = 'INSERT IGNORE INTO members (session_id, msg_id, nickname, avatar, user_display_id, user_sec_uid, create_time) VALUES (?, ?, ?, ?, ?, ?, ?)';
    for (const item of items) {
      await conn.query(stmt, [sessionId, item.msgId || null, item.nickname || null, item.avatar || null,
        item.userDisplayId || null, item.userSecUid || null,
        item.createTime || null]);
    }
  } finally {
    conn.release();
  }
}

/** 礼物排行 */
async function getGiftRanking(sessionId, limit = 100) {
  const [rows] = await getPool().query(`
    SELECT nickname, MAX(avatar) as avatar,
      SUM(total_diamonds) as total_diamonds,
      SUM(gift_count) as gift_count,
      JSON_ARRAYAGG(
        JSON_OBJECT('name', gift_name, 'count', cnt, 'diamonds', td)
      ) as gifts_json
    FROM (
      SELECT nickname, gift_name, MAX(avatar) as avatar,
        SUM(total_diamonds) as total_diamonds,
        COUNT(*) as cnt,
        SUM(diamond_count * repeat_count) as td,
        COUNT(*) as gift_count
      FROM (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY COALESCE(trace_id, CONCAT('__no_trace_', id))
          ORDER BY repeat_end DESC
        ) AS rn
        FROM gifts WHERE session_id = ?
      ) deduped
      WHERE rn = 1
      GROUP BY nickname, gift_name
    ) t
    GROUP BY nickname
    ORDER BY total_diamonds DESC
    LIMIT ?
  `, [sessionId, limit]);

  return rows.map(r => ({
    ...r,
    gifts: typeof r.gifts_json === 'string' ? JSON.parse(r.gifts_json || '[]') : (Array.isArray(r.gifts_json) ? r.gifts_json : [])
  }));
}

/** 弹幕查询 */
async function getDanmaku(sessionId, { user = '', page = 1, limit = 100 } = {}) {
  let where = 'WHERE session_id = ?';
  const params = [sessionId];
  if (user) {
    where += ' AND nickname LIKE ?';
    params.push(`%${user}%`);
  }
  const [[{ cnt }]] = await getPool().query(`SELECT COUNT(*) as cnt FROM danmaku ${where}`, params);
  const offset = (page - 1) * limit;
  const [items] = await getPool().query(
    `SELECT * FROM danmaku ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]);
  return { items, total: cnt, page, limit };
}

/** 词云 */
async function getWordCloud(sessionId, limit = 100) {
  const [rows] = await getPool().query(`
    SELECT content as text, COUNT(*) as count
    FROM danmaku
    WHERE session_id = ? AND content IS NOT NULL AND content != ''
    GROUP BY content
    ORDER BY count DESC
    LIMIT ?
  `, [sessionId, limit]);
  return rows;
}

/** 团员排名 */
async function getMemberRanking(sessionId, page = 1, limit = 100) {
  const offset = (page - 1) * limit;
  const [[{ cnt }]] = await getPool().query(`
    SELECT COUNT(DISTINCT nickname) as cnt FROM (
      SELECT nickname FROM gifts WHERE session_id = ?
      UNION
      SELECT nickname FROM danmaku WHERE session_id = ?
    ) t
  `, [sessionId, sessionId]);
  const [items] = await getPool().query(`
    SELECT nicks.nickname,
      COALESCE(gf.total_diamonds, 0) as total_diamonds,
      COALESCE(dm.danmaku_count, 0) as danmaku_count,
      COALESCE(gf.gifts_json, '[]') as gifts_json,
      COALESCE(gf.avatar, dm.avatar) as avatar
    FROM (
      SELECT nickname FROM gifts WHERE session_id = ?
      UNION
      SELECT nickname FROM danmaku WHERE session_id = ?
    ) nicks
    LEFT JOIN (
      SELECT nickname, avatar, SUM(total_diamonds) as total_diamonds,
        JSON_ARRAYAGG(JSON_OBJECT('name', gift_name, 'count', cnt, 'diamonds', td)) as gifts_json
      FROM (
        SELECT nickname, avatar, gift_name,
          SUM(total_diamonds) as total_diamonds,
          COUNT(*) as cnt,
          SUM(diamond_count * repeat_count) as td
        FROM (
          SELECT *, ROW_NUMBER() OVER (
            PARTITION BY COALESCE(trace_id, CONCAT('__no_trace_', id))
            ORDER BY repeat_end DESC
          ) AS rn
          FROM gifts WHERE session_id = ?
        ) deduped
        WHERE rn = 1
        GROUP BY nickname, avatar, gift_name
      ) g1
      GROUP BY nickname, avatar
    ) gf ON nicks.nickname = gf.nickname
    LEFT JOIN (
      SELECT nickname, MAX(avatar) as avatar, COUNT(*) as danmaku_count FROM danmaku WHERE session_id = ? GROUP BY nickname
    ) dm ON nicks.nickname = dm.nickname
    ORDER BY total_diamonds DESC, danmaku_count DESC
    LIMIT ? OFFSET ?
  `, [sessionId, sessionId, sessionId, sessionId, limit, offset]);

  return {
    items: items.map(r => ({
      ...r,
      gifts: typeof r.gifts_json === 'string' ? JSON.parse(r.gifts_json || '[]') : (Array.isArray(r.gifts_json) ? r.gifts_json : [])
    })),
    total: cnt,
    page,
    limit
  };
}

/** 主播列表 */
async function getStreamers() {
  const [rows] = await getPool().query(`
    SELECT s.*,
      (SELECT room_title FROM sessions WHERE streamer_id = s.id AND end_time IS NULL ORDER BY start_time DESC LIMIT 1) as live_title,
      EXISTS(SELECT 1 FROM sessions WHERE streamer_id = s.id AND end_time IS NULL) as live
    FROM streamers s ORDER BY s.name
  `);
  return rows.map(r => ({ ...r, live: !!r.live }));
}

/** 主播场次列表 */
async function getSessions(streamerId) {
  const [rows] = await getPool().query(
    'SELECT * FROM sessions WHERE streamer_id = ? ORDER BY start_time DESC', [streamerId]);
  return rows;
}

/** 单场详情 */
async function getSession(sessionId) {
  const [rows] = await getPool().query('SELECT * FROM sessions WHERE id = ?', [sessionId]);
  return rows[0] || null;
}

async function updateStreamerName(sessionId, name, avatar) {
  const [sess] = await getPool().query('SELECT streamer_id FROM sessions WHERE id = ?', [sessionId]);
  if (!sess.length) return;
  const sid = sess[0].streamer_id;
  if (!name) {
    await getPool().query('UPDATE streamers SET avatar = COALESCE(?, avatar) WHERE id = ?', [avatar || null, sid]);
    return;
  }
  // 检查名字是否已被其他 streamer 占用
  const [existing] = await getPool().query('SELECT id FROM streamers WHERE name = ? AND id != ?', [name, sid]);
  if (existing.length) {
    // 名字已被占用 → 将当前 session 迁移到已存在的 streamer，删除旧的
    await getPool().query('UPDATE sessions SET streamer_id = ? WHERE streamer_id = ?', [existing[0].id, sid]);
    await getPool().query('DELETE FROM streamers WHERE id = ?', [sid]);
    console.log('[db] 流主播合并:', name, '#' + existing[0].id, '(原 #' + sid + ')');
  } else {
    await getPool().query('UPDATE streamers SET name = ?, avatar = COALESCE(?, avatar) WHERE id = ?', [name, avatar || null, sid]);
  }
}

async function updateStreamerAvatar(sessionId, avatar) {
  const [sess] = await getPool().query('SELECT streamer_id FROM sessions WHERE id = ?', [sessionId]);
  if (!sess.length) return;
  await getPool().query('UPDATE streamers SET avatar = ? WHERE id = ?', [avatar, sess[0].streamer_id]);
}

/** 关闭连接池 */
async function close() {
  if (pool) await pool.end();
}

module.exports = {
  init, getPool,
  upsertStreamer, createSession, getCurrentSession, endSession, updateSessionStats,
  insertDanmaku, insertGifts, insertMembers,
  getGiftRanking, getDanmaku, getWordCloud, getMemberRanking,
  getStreamers, getSessions, getSession, close,
  updateStreamerName, updateStreamerAvatar
};
