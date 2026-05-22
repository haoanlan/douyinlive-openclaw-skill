#!/usr/bin/env node
/**
 * 查询用户礼物记录（带 comboDedupGifts 去重）
 *
 * 用法：
 *   node query-user-gifts.js <昵称关键词>
 *
 * 示例：
 *   node query-user-gifts.js suisui
 *   node query-user-gifts.js 萱萱
 *   node query-user-gifts.js 神秘人
 */
const mysql = require('mysql2/promise');

const DB_CONFIG = {
  host: '172.18.0.3',
  port: 3306,
  user: 'douyinlive',
  password: 'bYcxn7wFwDjed5jD',
  database: 'douyinlive',
  connectTimeout: 3000
};

/** 与 report-image.js 完全一致的去重逻辑 */
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

async function main() {
  const keyword = process.argv[2];
  if (!keyword) {
    console.error('用法: node query-user-gifts.js <昵称关键词>');
    process.exit(1);
  }

  const conn = await mysql.createConnection(DB_CONFIG);
  try {
    const [gifts] = await conn.query(
      'SELECT id, nickname, gift_name, diamond_count, repeat_count, total_diamonds, ' +
      'combo_count, repeat_end, send_type, create_time, user_display_id, user_sec_uid, ' +
      'to_nickname, to_user_display_id, to_user_sec_uid FROM gifts WHERE nickname LIKE ? ORDER BY id',
      [`%${keyword}%`]
    );

    if (gifts.length === 0) {
      console.log(`未找到昵称包含"${keyword}"的用户`);
      return;
    }

    const deduped = comboDedupGifts(gifts);
    deduped.sort((a, b) => b.create_time - a.create_time);

    console.log(`昵称: ${gifts[0].nickname}`);
    console.log(`原始记录: ${gifts.length} 条 → 去重后: ${deduped.length} 条\n`);

    let total = 0;
    for (const g of deduped) {
      const time = new Date(g.create_time).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'});
      total += g.total_diamonds;
      const toStr = g.to_nickname ? ' → ' + g.to_nickname : '';
      const detail = g.repeat_count > 1 ? ` ×${g.repeat_count} = 💎${g.total_diamonds}` : ` = 💎${g.total_diamonds}`;
      console.log(`${time}  ${g.gift_name}${detail}${toStr}`);
    }
    console.log(`\n💎 总计: ${total} 钻石 (≈ ¥${Math.round(total / 10)})`);
  } finally {
    await conn.end();
  }
}

main().catch(e => console.error('Error:', e.message));
