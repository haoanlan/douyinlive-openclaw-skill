/**
 * 园区充电榜 v8 — 统一卡片大小 + TOP3 特殊展示(无称号文字) + 标题头修改
 */
const { chromium } = require('playwright');
const mysql = require('mysql2/promise');
const path = require('path');

const target = '萱萱🍋🍋🟩🍒🧸🛌林语巷';
const sessionId = 236;
const outputDir = path.join(__dirname, 'reports');
const TARGET_AVATAR = 'https://p3.douyinpic.com/aweme/100x100/aweme-avatar/tos-cn-i-0813_oA9suPwIGDIAikDATEQAZAJPjkAIIlTBi8xVT.jpeg?from=3067671334';

async function getData() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306, timezone: '+08:00',
    waitForConnections: true, connectionLimit: 5
  });
  const [rawGifts] = await pool.query(
    'SELECT * FROM gifts WHERE session_id=? AND to_nickname=? ORDER BY create_time ASC',
    [sessionId, target]
  );
  pool.end();
  const groups = {};
  for (const g of rawGifts) {
    const key = (g.user_display_id || g.nickname) + '|' + g.gift_name + '|' + (g.to_nickname || '');
    if (!groups[key]) groups[key] = [];
    groups[key].push(g);
  }
  const deduped = [];
  for (const items of Object.values(groups)) {
    items.sort((a, b) => a.create_time - b.create_time);
    const combos = [];
    let cur = [items[0]];
    for (let i = 1; i < items.length; i++) {
      const p = items[i - 1], c = items[i];
      const same = (c.combo_count === p.combo_count + 1) || (c.combo_count === p.combo_count && c.repeat_end === 1);
      if (same) cur.push(c);
      else { combos.push(cur); cur = [c]; }
    }
    combos.push(cur);
    for (const combo of combos) {
      let best = combo[0];
      for (const item of combo) {
        if (item.combo_count > best.combo_count || (item.combo_count === best.combo_count && item.repeat_end === 1 && best.repeat_end !== 1)) best = item;
      }
      deduped.push(best);
    }
  }
  const userMap = {};
  for (const g of deduped) {
    const key = g.user_display_id || g.nickname;
    if (!userMap[key]) userMap[key] = { nickname: g.nickname, displayId: g.user_display_id || '', avatar: g.avatar || '', diamonds: 0 };
    userMap[key].diamonds += g.total_diamonds;
    if (g.nickname) userMap[key].nickname = g.nickname;
    if (g.avatar) userMap[key].avatar = g.avatar;
  }
  return Object.values(userMap).sort((a, b) => b.diamonds - a.diamonds).slice(0, 100);
}

function cleanDisplayName(name) {
  if (!name) return name;
  const result = [];
  let i = 0;
  while (i < name.length) {
    const code = name.codePointAt(i);
    const len = code > 0xFFFF ? 2 : 1;
    if (code >= 0x1D400 && code <= 0x1D7FF) {
      const base = code - 0x1D400;
      const idx = base % 52;
      if (idx < 26) result.push(String.fromCharCode(65 + idx));
      else result.push(String.fromCharCode(97 + idx - 26));
    } else if ((code >= 0x13000 && code <= 0x1342F) || (code >= 0x1F000 && code <= 0x1FFFF)) {
    } else {
      result.push(String.fromCodePoint(code));
    }
    i += len;
  }
  return result.join("");
}

function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function rankBadge(i) {
  if (i === 0) return '<svg viewBox="0 0 24 24" width="18" height="18" style="vertical-align:middle"><circle cx="12" cy="12" r="11" fill="#FFD700"/><text x="12" y="17" text-anchor="middle" font-size="14" font-weight="bold" fill="#1a0a2e">1</text></svg>';
  if (i === 1) return '<svg viewBox="0 0 24 24" width="18" height="18" style="vertical-align:middle"><circle cx="12" cy="12" r="11" fill="#C0C0C0"/><text x="12" y="17" text-anchor="middle" font-size="14" font-weight="bold" fill="#1a0a2e">2</text></svg>';
  if (i === 2) return '<svg viewBox="0 0 24 24" width="18" height="18" style="vertical-align:middle"><circle cx="12" cy="12" r="11" fill="#CD7F32"/><text x="12" y="17" text-anchor="middle" font-size="14" font-weight="bold" fill="#fff">3</text></svg>';
  const n = i + 1;
  return `<svg viewBox="0 0 24 24" width="18" height="18" style="vertical-align:middle"><circle cx="12" cy="12" r="10" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.15)" stroke-width="1"/><text x="12" y="16" text-anchor="middle" font-size="12" font-weight="bold" fill="rgba(255,255,255,0.5)">${n}</text></svg>`;
}

function avatarImg(url, size, extra) {
  if (!url) return `<span style="display:inline-flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;border-radius:50%;background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.4);font-size:12px;flex-shrink:0;vertical-align:middle;margin-right:8px;${extra||''}">?</span>`;
  let u = url.startsWith('//') ? 'https:' + url : url;
  return `<img src="${u}" width="${size}" height="${size}" style="display:inline-block;border-radius:50%;object-fit:cover;vertical-align:middle;margin-right:8px;flex-shrink:0;${extra||''}" onerror="this.style.display='none'" />`;
}

function makeRowHTML(entries) {
  return entries.map(([rankIdx, s]) => {
    const displayName = s.name;
    const isTop3 = rankIdx < 3;
    const top3cls = isTop3 ? ` class="row-top3 row-${['1st','2nd','3rd'][rankIdx]}"` : '';
    return `<tr${top3cls}><td class="rank">${rankBadge(rankIdx)}</td><td class="name"><span class="name-wrap">${avatarImg(s.avatar, 22)}<span class="name-text to-text" title="${esc(cleanDisplayName(displayName))}">${esc(cleanDisplayName(displayName))}</span></span></td></tr>`;
  }).join('');
}

/* 前10图 — TOP3 卡片 + 4-10 列表 */
function genTop10HTML(users, pageLabel) {
  const top3 = users.slice(0, 3);
  const rest = users.slice(3);
  const colors = ['#FFD700', '#C0C0C0', '#CD7F32'];
  const bgGrads = [
    'linear-gradient(135deg,rgba(255,215,0,0.15),rgba(255,200,0,0.05))',
    'linear-gradient(135deg,rgba(200,200,255,0.12),rgba(200,200,255,0.03))',
    'linear-gradient(135deg,rgba(232,160,96,0.12),rgba(232,160,96,0.03))',
  ];
  const borderColors = ['rgba(255,215,0,0.3)', 'rgba(200,200,255,0.25)', 'rgba(232,160,96,0.25)'];

  function top3Avatar(url) {
    if (!url || url === '') return '<span style="display:inline-block;width:44px;height:44px;border-radius:50%;background:rgba(255,255,255,0.08)"></span>';
    let u = url.startsWith('//') ? 'https:' + url : url;
    return `<img src="${u}" width="44" height="44" style="display:block;border-radius:50%;object-fit:cover;width:44px;height:44px" onerror="this.style.display='none'" />`;
  }
  const top3Cards = top3.map((u, idx) => {
    return `<div style="display:flex;align-items:center;gap:14px;background:${bgGrads[idx]};border:1px solid ${borderColors[idx]};border-radius:16px;padding:14px 18px;margin-bottom:8px">
      <div style="width:48px;height:48px;border-radius:50%;background:${colors[idx]}22;display:flex;align-items:center;justify-content:center;flex-shrink:0;overflow:hidden">
        ${top3Avatar(u.avatar)}
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-size:17px;font-weight:800;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(cleanDisplayName(u.nickname || '未知'))}</div>
      </div>
      <div style="text-align:right;flex-shrink:0;display:flex;align-items:center">
        ${rankBadge(idx)}
      </div>
    </div>`;
  }).join('\n');

  const restRows = rest.map(u => {
    const rankIdx = u._rank - 1;
    return `<tr><td class="rank">${rankBadge(rankIdx)}</td><td class="name"><span class="name-wrap">${avatarImg(u.avatar, 22)}<span class="name-text to-text" title="${esc(cleanDisplayName(u.nickname||'未知'))}">${esc(cleanDisplayName(u.nickname||'未知'))}</span></span></td></tr>`;
  }).join('\n');

  const theme = { bg: 'linear-gradient(135deg, #1a0a2e 0%, #16213e 50%, #0f3460 100%)' };

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;600;700;800;900&display:swap');
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Noto Sans SC',-apple-system,BlinkMacSystemFont,sans-serif;background:${theme.bg};min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px}
.bg-pattern{position:fixed;top:0;left:0;width:100%;height:100%;background-image:radial-gradient(circle at 20% 30%,rgba(108,99,255,0.08) 0%,transparent 50%),radial-gradient(circle at 80% 70%,rgba(255,107,157,0.06) 0%,transparent 50%);pointer-events:none}
.card{width:540px;max-width:100%;background:rgba(255,255,255,0.07);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,0.10);border-radius:24px;padding:0;box-shadow:0 25px 60px rgba(0,0,0,0.5);overflow:hidden;position:relative}
table{width:100%;border-collapse:collapse;table-layout:fixed}
tr{border-bottom:1px solid rgba(255,255,255,0.04);height:38px}
tr:last-child{border-bottom:none}
td{padding:0 6px;font-size:15px;color:rgba(255,255,255,0.85);vertical-align:middle!important;line-height:1.55}
td.rank{width:34px;text-align:center;font-size:15px;font-weight:600;vertical-align:middle!important;line-height:1}
td.name{white-space:nowrap;overflow:hidden;font-weight:700;display:flex;align-items:center;height:38px}
.name-wrap{display:contents}
.name-text{vertical-align:middle;overflow:hidden;text-overflow:ellipsis;display:inline-block}
.to-text{max-width:400px}
.ranking-grid{display:grid;gap:10px;padding:0}
.ranking-col td{padding:0 4px;font-size:15px;vertical-align:middle!important;height:38px}
.ranking-col td.rank{width:30px;font-size:15px;text-align:center;vertical-align:middle!important;line-height:1}
.ranking-col td.name{white-space:nowrap;overflow:hidden;font-size:15px;display:flex;align-items:center;height:38px}
.ranking-col td.name .name-wrap{display:contents}
.ranking-col .name-text{overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
.footer{text-align:center;padding:10px 24px 14px;font-size:10px;color:rgba(255,255,255,0.3);letter-spacing:0.5px}
</style>
</head>
<body>
<div class="bg-pattern"></div>
<div class="card" style="padding:0!important">
  <div style="display:flex;align-items:center;gap:14px;padding:16px 20px;background:linear-gradient(180deg,rgba(255,107,157,0.06) 0%,transparent 100%);border-bottom:1px solid rgba(255,255,255,0.06)">
    <div style="width:44px;height:44px;border-radius:50%;background:linear-gradient(135deg,#FF6B9D66,#FFD93D66);display:flex;align-items:center;justify-content:center;flex-shrink:0"><img src="${TARGET_AVATAR}" style="width:40px;height:40px;border-radius:50%;object-fit:cover" /></div>
    <div style="flex:1;min-width:0">
      <div style="font-size:18px;font-weight:700;color:#fff;line-height:1.3">萱萱🍋🍋🟩🍒🧸🛌</div>
      <div style="font-size:12px;color:rgba(255,255,255,0.35);margin-top:4px">5月23日 周赛 · Session 236</div>
    </div>
    <div style="text-align:right;flex-shrink:0">
      <div style="font-size:15px;font-weight:800;color:rgba(255,255,255,0.85);letter-spacing:0.5px">🔋 园区充电榜</div>
    </div>
  </div>
  <div style="font-size:13px;font-weight:700;color:rgba(255,255,255,0.5);padding:14px 24px 6px;letter-spacing:0.5px;border-bottom:1px solid rgba(255,255,255,0.03)">🔋 园区充电榜 · ${pageLabel}</div>
  <div style="padding:14px 24px 32px">
    ${top3Cards}
    ${rest.length > 0 ? `<div style="font-size:12px;font-weight:700;color:rgba(255,255,255,0.4);margin:12px 0 6px;letter-spacing:0.5px">🏅 第4-10名</div><table>${restRows}</table>` : ''}
  </div>
  <div class="footer">由 404 · 抖音直播监控 生成</div>
</div>
</body>
</html>`;
}

/* 后3张 — 双列表格 */
function genHTML(users, pageLabel) {
  const perCol = Math.ceil(users.length / 2);
  const left = users.slice(0, perCol).map(u => [u._rank - 1, { name: u.nickname, avatar: u.avatar }]);
  const right = users.slice(perCol).map(u => [u._rank - 1, { name: u.nickname, avatar: u.avatar }]);

  const theme = { bg: 'linear-gradient(135deg, #1a0a2e 0%, #16213e 50%, #0f3460 100%)' };

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;600;700;800;900&display=swap');
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Noto Sans SC',-apple-system,BlinkMacSystemFont,sans-serif;background:${theme.bg};min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px}
.bg-pattern{position:fixed;top:0;left:0;width:100%;height:100%;background-image:radial-gradient(circle at 20% 30%,rgba(108,99,255,0.08) 0%,transparent 50%),radial-gradient(circle at 80% 70%,rgba(255,107,157,0.06) 0%,transparent 50%);pointer-events:none}
.card{width:540px;max-width:100%;background:rgba(255,255,255,0.07);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,0.10);border-radius:24px;padding:0;box-shadow:0 25px 60px rgba(0,0,0,0.5);overflow:hidden;position:relative}
table{width:100%;border-collapse:collapse;table-layout:fixed}
tr{border-bottom:1px solid rgba(255,255,255,0.04);height:38px}
tr:last-child{border-bottom:none}
td{padding:0 6px;font-size:15px;color:rgba(255,255,255,0.85);vertical-align:middle!important;line-height:1.55}
td.rank{width:34px;text-align:center;font-size:15px;font-weight:600;vertical-align:middle!important;line-height:1}
.row-1st td.name{color:#FFE44D}.row-2nd td.name{color:#C8C8FF}.row-3rd td.name{color:#E8A060}
.row-top3 td{padding:6px 4px;color:#fff}
td.name{white-space:nowrap;overflow:hidden;font-weight:700;vertical-align:middle!important}
.name-wrap{display:inline-flex;align-items:center;gap:4px;height:100%}
.name-text{vertical-align:middle;overflow:hidden;text-overflow:ellipsis;display:inline-block}
.to-text{max-width:180px}
.ranking-grid{display:grid;gap:10px;padding:0}
.ranking-col td{padding:0 4px;font-size:15px;vertical-align:middle!important;height:38px}
.ranking-col td.rank{width:30px;font-size:15px;vertical-align:middle!important;text-align:center;line-height:1}
.ranking-col td.name{white-space:nowrap;overflow:hidden;font-size:15px;display:flex;align-items:center}
.ranking-col td.name .name-wrap{display:contents}
.ranking-col .name-text{overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
.ranking-col .row-top3 td{padding:0 4px}
.footer{text-align:center;padding:10px 24px 14px;font-size:10px;color:rgba(255,255,255,0.3);letter-spacing:0.5px}
</style>
</head>
<body>
<div class="bg-pattern"></div>
<div class="card" style="padding:0!important">
  <div style="display:flex;align-items:center;gap:14px;padding:16px 20px;background:linear-gradient(180deg,rgba(255,107,157,0.06) 0%,transparent 100%);border-bottom:1px solid rgba(255,255,255,0.06)">
    <div style="width:44px;height:44px;border-radius:50%;background:linear-gradient(135deg,#FF6B9D66,#FFD93D66);display:flex;align-items:center;justify-content:center;flex-shrink:0"><img src="${TARGET_AVATAR}" style="width:40px;height:40px;border-radius:50%;object-fit:cover" /></div>
    <div style="flex:1;min-width:0">
      <div style="font-size:18px;font-weight:700;color:#fff;line-height:1.3">萱萱🍋🍋🟩🍒🧸🛌</div>
      <div style="font-size:12px;color:rgba(255,255,255,0.35);margin-top:4px">5月23日 周赛 · Session 236</div>
    </div>
    <div style="text-align:right;flex-shrink:0">
      <div style="font-size:15px;font-weight:800;color:rgba(255,255,255,0.85);letter-spacing:0.5px">🔋 园区充电榜</div>
    </div>
  </div>
  <div style="font-size:13px;font-weight:700;color:rgba(255,255,255,0.5);padding:14px 24px 6px;letter-spacing:0.5px;border-bottom:1px solid rgba(255,255,255,0.03)">🔋 园区充电榜 · ${pageLabel}</div>
  <div style="padding:6px 24px 14px">
    <div class="ranking-grid" style="grid-template-columns:1fr 1fr;gap:10px">
      <div class="ranking-col"><table style="width:100%;table-layout:fixed"><tbody>${makeRowHTML(left)}</tbody></table></div>
      <div class="ranking-col"><table style="width:100%;table-layout:fixed"><tbody>${makeRowHTML(right)}</tbody></table></div>
    </div>
  </div>
  <div class="footer">由 404 · 抖音直播监控 生成</div>
</div>
</body>
</html>`;
}

async function render(html, outPath) {
  const br = await chromium.launch({ headless: true });
  const page = await br.newPage({ viewport: { width: 600, height: 2000 }, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: 'networkidle' });
  const bodyHeight = await page.evaluate(() => document.body.scrollHeight);
  const y = Math.max(0, Math.floor((bodyHeight - 800) / 2));
  await page.screenshot({ path: outPath, clip: { x: 0, y, width: 600, height: 800 }, type: 'jpeg', quality: 92 });
  await br.close();
  console.log(`  ✅ ${path.basename(outPath)}`);
}

async function main() {
  console.log('📊 Loading data...');
  const users = await getData();
  console.log(`  ${users.length} users`);
  const total = users.slice(0, 100);
  total.forEach((u, i) => u._rank = i + 1);
  console.log(`  Total: ${total.length} users`);

  const n = total.length;
  const topN = Math.min(10, n);
  const restCount = n - topN;
  const perPage = Math.ceil(restCount / 3);

  console.log('🖼️  Image 1/4 (TOP ' + topN + ')...');
  await render(genTop10HTML(total.slice(0, topN), 'TOP ' + topN), path.join(outputDir, 'thanks_rank_p1.jpg'));

  const pages = [
    { start: topN, end: Math.min(topN + perPage, n), label: `第${topN+1}-${Math.min(topN+perPage, n)}名` },
    { start: Math.min(topN + perPage, n), end: Math.min(topN + perPage*2, n), label: `第${Math.min(topN+perPage, n)+1}-${Math.min(topN + perPage*2, n)}名` },
    { start: Math.min(topN + perPage*2, n), end: n, label: `第${Math.min(topN + perPage*2, n)+1}-${n}名` },
  ];

  for (let i = 0; i < 3; i++) {
    const p = pages[i];
    if (p.start >= p.end) continue;
    console.log(`🖼️  Image ${i+2}/4 (${p.label})...`);
    await render(genHTML(total.slice(p.start, p.end), p.label),
      path.join(outputDir, `thanks_rank_p${i+2}.jpg`));
  }
  console.log('\n✅ Done!');
}

main().catch(e => { console.error(e); process.exit(1); });
