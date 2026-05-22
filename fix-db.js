/**
 * 修复数据库礼物数据：根据 gift_debug.log 中的 displayText 修正礼物名和价格
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const DB = {
  host: '1Panel-mysql-aF5P',
  port: 3306,
  user: 'douyinlive',
  password: 'bYcxn7wFwDjed5jD',
  database: 'douyinlive',
  waitForConnections: true,
  connectionLimit: 5,
};

// 礼物价格修正映射（同 monitor.js 中的 GIFT_PRICE_MAP）
const GIFT_PRICE_MAP = {
  '闪烁星河': 99,
  '点点星光': 9,
  '星光闪耀': 9,
  '闪耀星辰': 99,
  '钻石跑车': 1500,
};

/** 从 displayText 中提取礼物名 */
function extractGiftNameFromDisplay(displayText) {
  if (!displayText?.pieces) return null;
  const pieces = displayText.pieces;
  const pattern = displayText.defaultPattern || '';
  if (pattern.includes('送给') && pieces.length > 3) {
    const p = pieces[3];
    if (p && p.type === 1 && p.stringValue) return p.stringValue;
  } else if (pattern.includes('送出') && pieces.length > 1) {
    const p = pieces[1];
    if (p && p.type === 1 && p.stringValue) return p.stringValue;
  }
  return null;
}

(async () => {
  // 步骤1: 遍历所有 gift_debug.log，提取 traceId → 正确礼物信息
  const streamersDir = path.join(__dirname, 'streamers');
  const dirs = fs.readdirSync(streamersDir).filter(d => fs.statSync(path.join(streamersDir, d)).isDirectory());
  const correctionMap = new Map(); // traceId → {correctName, correctPrice}

  for (const dir of dirs) {
    const logPath = path.join(streamersDir, dir, 'gift_debug.log');
    if (!fs.existsSync(logPath)) continue;
    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const j = JSON.parse(line);
        const traceId = j.traceId;
        if (!traceId) continue;

        // 从 displayText 取正确礼物名
        let correctName = extractGiftNameFromDisplay(j.common?.displayText) || '';
        const baseName = j.gift?.name || '';
        if (!correctName && !baseName) continue;
        if (correctName && baseName && !correctName.includes(baseName) && baseName !== '礼物') {
          // displayName 不包含基础名则合并（如"金色限定"+"跑车"="金色限定跑车"）
          correctName = correctName + baseName;
        }
        if (!correctName) correctName = baseName;
        if (!correctName) continue;

        // 价格：先看价格映射，否则用 diamondCount
        const mappedPrice = GIFT_PRICE_MAP[correctName];
        const correctPrice = mappedPrice !== undefined ? mappedPrice : (parseInt(String(j.gift?.diamondCount || 0), 10));

        // 原始值
        const origName = j.gift?.name || '';
        const origPrice = parseInt(String(j.gift?.diamondCount || 0), 10);

        // 只有需要修正时才记录
        if (correctName !== origName || correctPrice !== origPrice) {
          if (!correctionMap.has(traceId)) {
            correctionMap.set(traceId, { correctName, correctPrice, origName, origPrice });
          }
        }
      } catch(e) {}
    }
  }

  console.log(`从日志中提取到 ${correctionMap.size} 条需要修正的 traceId`);

  // 步骤2: 查询 MySQL 中所有"跑车"记录
  const pool = mysql.createPool(DB);
  const [gifts] = await pool.execute("SELECT id, trace_id, gift_name, diamond_count, repeat_count, nickname FROM gifts WHERE gift_name='跑车' ORDER BY create_time");
  console.log(`MySQL 中有 ${gifts.length} 条跑车记录`);

  // 步骤3: 匹配并修正
  let matched = 0;
  let updated = 0;
  const results = [];

  for (const g of gifts) {
    const corr = correctionMap.get(g.trace_id);
    if (!corr) continue;
    matched++;

    const shouldFixName = corr.correctName !== '跑车';
    const shouldFixPrice = corr.correctPrice !== 1200;
    if (!shouldFixName && !shouldFixPrice) continue;

    results.push({
      id: g.id,
      nickname: g.nickname,
      oldName: g.gift_name,
      oldPrice: g.diamond_count,
      newName: corr.correctName,
      newPrice: corr.correctPrice,
    });

    // 执行更新
    const updates = {};
    if (shouldFixName) updates.gift_name = corr.correctName;
    if (shouldFixPrice) updates.diamond_count = corr.correctPrice;

    // 同时更新 total_diamonds = price * repeat_count
    if (shouldFixPrice) {
      const newTotal = corr.correctPrice * g.repeat_count;
      await pool.execute(
        "UPDATE gifts SET gift_name = ?, diamond_count = ?, total_diamonds = ? WHERE id = ?",
        [corr.correctName, corr.correctPrice, newTotal, g.id]
      );
    } else {
      await pool.execute(
        "UPDATE gifts SET gift_name = ? WHERE id = ?",
        [corr.correctName, g.id]
      );
    }
    updated++;
  }

  console.log(`匹配到 ${matched} 条，已修正 ${updated} 条`);
  if (results.length > 0) {
    console.log('修正明细:');
    console.table(results);
  }

  await pool.end();
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
