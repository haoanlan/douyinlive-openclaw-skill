const mysql = require('mysql2/promise');
const fs = require('fs');

async function main() {
  const sessionIds = [246, 247, 248];
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '1Panel-mysql-aF5P', port: 3306, user: process.env.DB_USER || 'douyinlive',
    password: process.env.DB_PASSWORD || 'bYcxn7wFwDjed5jD', database: process.env.DB_NAME || 'douyinlive',
    timezone: '+08:00', connectTimeout: 3000
  });

  const [sessions] = await conn.query(
    'SELECT * FROM sessions WHERE id IN (?) ORDER BY id', [sessionIds]
  );
  if (!sessions.length) { console.log('No sessions found'); return; }

  const base = sessions[0];
  const startTime = new Date(base.start_time);
  const endTime = sessions[sessions.length - 1].end_time ? new Date(sessions[sessions.length - 1].end_time) : null;

  let allDanmaku = [], allGifts = [], allMembers = [], allOnline = [];
  let totalStatsLike = 0, totalStatsFollow = 0, totalStatsSocial = 0;
  let onlinePeak = 0, totalGiftDiamonds = 0, totalDurationSec = 0;

  for (const s of sessions) {
    const [danmaku] = await conn.query(
      'SELECT nickname, avatar, content, create_time FROM danmaku WHERE session_id = ? ORDER BY create_time', [s.id]);
    const [gifts] = await conn.query(
      'SELECT id, nickname, avatar, to_nickname, to_avatar, to_user_display_id, to_user_sec_uid, gift_name, diamond_count, total_diamonds, repeat_count, create_time, user_display_id, user_sec_uid, trace_id, repeat_end, combo_count, send_type FROM gifts WHERE session_id = ? ORDER BY id', [s.id]);
    const [members] = await conn.query(
      'SELECT nickname, avatar, user_sec_uid, create_time FROM members WHERE session_id = ? ORDER BY create_time', [s.id]);
    const [online] = await conn.query(
      'SELECT count, recorded_at FROM online_records WHERE session_id = ? ORDER BY recorded_at', [s.id]);

    totalStatsLike += (s.stats_like || 0);
    totalStatsFollow += (s.stats_follow || 0);
    totalStatsSocial += (s.stats_social || 0);

    allDanmaku = allDanmaku.concat(danmaku);
    allGifts = allGifts.concat(gifts);
    allMembers = allMembers.concat(members);
    allOnline = allOnline.concat(online);

    // 累加实际直播时长（每场各自持续时间，不含休息间隔）
    totalDurationSec += s.duration_seconds || 0;
    // 从在线记录表取真实峰值（sessions.online_peak 字段可能不准）
    for (const g of gifts) totalGiftDiamonds += (g.total_diamonds || 0);
  }

  // 从 online_records 计算真实峰值
  onlinePeak = allOnline.length > 0 ? Math.max(...allOnline.map(o => o.count)) : 0;

  // Build avatar cache
  const avatarCache = {};
  for (const g of allGifts) {
    if (g.nickname && g.avatar) avatarCache[g.nickname] = g.avatar;
  }
  for (const g of allGifts) {
    if (g.to_nickname && g.to_avatar) avatarCache[g.to_nickname] = g.to_avatar;
  }

  // Store raw gifts with all fields so comboDedupGifts works correctly
  const gRaw = allGifts.map(g => ({
    id: g.id, nickname: g.nickname, avatar: g.avatar || '', gift_name: g.gift_name || '',
    to_nickname: g.to_nickname || '', to_avatar: g.to_avatar || '',
    to_user_display_id: g.to_user_display_id || '', to_user_sec_uid: g.to_user_sec_uid || '',
    user_display_id: g.user_display_id || '', user_sec_uid: g.user_sec_uid || '',
    diamonds: g.diamond_count || 0, total_diamonds: g.total_diamonds || 0,
    count: g.repeat_count || 1, combo_count: g.combo_count || 1,
    repeat_end: g.repeat_end, send_type: g.send_type,
    create_time: g.create_time instanceof Date ? g.create_time.toISOString() : g.create_time,
    describe: ''
  }));

  // Danmaku with time as ISO string
  const dMapped = allDanmaku.map(d => ({
    nickname: d.nickname, avatar: d.avatar || '', content: d.content,
    create_time: d.create_time instanceof Date ? d.create_time.toISOString() : d.create_time
  }));
  const mMapped = allMembers.map(m => ({
    nickname: m.nickname, avatar: m.avatar || '', user_sec_uid: m.user_sec_uid || '',
    create_time: m.create_time instanceof Date ? m.create_time.toISOString() : m.create_time
  }));

  const data = {
    id: sessions.length === 1 ? base.id : `${sessionIds[0]}-${sessionIds[sessionIds.length-1]}`,
    streamer_id: base.streamer_id,
    start_time: startTime.toISOString(),
    end_time: endTime ? endTime.toISOString() : null,
    room_title: base.room_title,
    room_id: base.room_id,
    room_author: '林语巷',
    room_avatar: base.streamer_avatar || 'https://p26.douyinpic.com/aweme/100x100/aweme-avatar/tos-cn-avt-0015_dc2750b7a5025d564f1a67d3d81b710a.jpeg?from=3067671334',
    duration_seconds: totalDurationSec,
    online_peak: onlinePeak,
    stats: {
      danmaku: dMapped.length,
      gift: gRaw.length,
      like: totalStatsLike,
      member: mMapped.length,
      follow: totalStatsFollow,
      social: totalStatsSocial,
      online: onlinePeak
    },
    gifts: gRaw,
    danmaku: dMapped,
    members: mMapped,
    online: allOnline.map(o => ({ count: o.count, time: o.recorded_at })),
    rawMessages: [],
    _avatarCache: avatarCache,
    gift_diamonds: totalGiftDiamonds,
    gift_count: allGifts.length
  };

  const outPath = '/tmp/merged_sessions_220_222.json';
  // Add the dedup result count for reference
  const { comboDedupGifts: dedup } = (() => {
    // inline the dedup function
    function comboDedupGifts(gifts) {
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
        let seq = [items[0]];
        const sequences = [];
        for (let i = 1; i < items.length; i++) {
          const prev = seq[seq.length - 1];
          const curr = items[i];
          const pc = parseInt(String(prev.combo_count || 1), 10);
          const cc = parseInt(String(curr.combo_count || 1), 10);
          if (cc === pc + 1 || (cc === pc && curr.repeat_end === 1)) {
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
    return { comboDedupGifts };
  })();

  const dedupedCount = dedup(gRaw).length;
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(`Written! Gifts: ${gRaw.length} (deduped: ${dedupedCount})`);
  console.log(`Danmaku:${dMapped.length} Members:${mMapped.length}`);
  console.log(`Like:${totalStatsLike} Follow:${totalStatsFollow} Peak:${onlinePeak} Diamonds:${totalGiftDiamonds}`);

  await conn.end();
}

main().catch(e => console.error(e));
