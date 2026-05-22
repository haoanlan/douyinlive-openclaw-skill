/**
 * 抖音用户身份卡片 — 查神秘人/用户信息
 * 用法: node user-card.js <secUid> [数据库昵称]
 *       数据库昵称可选，用于显示"原昵称"标签（如神秘人954409）
 */
const { fetchUserBySecUid } = require('./douyin-user.js');
const { chromium } = require('playwright');
const fs = require('fs');
const feishu = require('./feishu-send.js');

function fmtNum(n) { return (parseInt(n,10)||0).toLocaleString(); }

(async () => {
  const secUid = process.argv[2];
  if (!secUid) { console.log('用法: node user-card.js <secUid> [数据库昵称]'); process.exit(1); }
  const origNick = process.argv[3]; // 数据库里的原昵称（神秘人XXX）

  const u = await fetchUserBySecUid(secUid);
  if (!u) { console.log('查询失败'); process.exit(1); }

  const theme = {
    primary: '#FF6B9D', accent: '#FFD93D',
    bg: 'linear-gradient(135deg, #1a0a2e 0%, #16213e 50%, #0f3460 100%)',
    cardBg: 'rgba(255,255,255,0.07)'
  };

  const douyinId = u.unique_id || u.display_id || (u.short_id && u.short_id !== '0' ? u.short_id : '') || '无';

  const icoFans = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
  const icoHeart = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>';

  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<style>
@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;600;700;800;900&display=swap');
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Noto Sans SC',sans-serif;background:${theme.bg};min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.wrap{width:540px;min-height:200px;background:${theme.bg};padding:24px}
.card{width:492px;background:${theme.cardBg};backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,0.10);border-radius:24px;overflow:hidden;box-shadow:0 25px 60px rgba(0,0,0,0.5)}
.hero{text-align:center;padding:36px 28px 22px;background:linear-gradient(180deg,rgba(108,99,255,0.20) 0%,transparent 100%)}
.avatar-frame{width:96px;height:96px;border-radius:50%;margin:0 auto 14px;background:linear-gradient(135deg,${theme.primary}66,${theme.accent}66);display:flex;align-items:center;justify-content:center}
.avatar{width:90px;height:90px;border-radius:50%;object-fit:cover;display:block}
.nickname{font-size:26px;font-weight:800;color:#fff;margin-bottom:4px}
.orig-tag{display:inline-block;background:rgba(255,255,255,0.08);padding:3px 12px;border-radius:12px;font-size:12px;color:rgba(255,255,255,0.45);margin-bottom:8px}
.displayid{font-size:13px;color:rgba(255,255,255,0.35)}
.stats{display:flex;justify-content:center;gap:40px;padding:18px 28px;border-top:1px solid rgba(255,255,255,0.06)}
.stat-item{display:flex;align-items:center;gap:4px;color:rgba(255,255,255,0.5);font-size:13px}
.stat-icon{display:flex;align-items:center}
.stat-val{font-weight:700;color:${theme.primary};font-size:16px}
.extra{padding:14px 28px 24px;border-top:1px solid rgba(255,255,255,0.06)}
.extra-item{display:flex;justify-content:space-between;font-size:13px;color:rgba(255,255,255,0.4);padding:4px 0}
.extra-item span:last-child{color:rgba(255,255,255,0.6);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}
.footer{text-align:center;padding:10px 28px 16px;font-size:10px;color:rgba(255,255,255,0.2)}
</style></head><body>
<div class="wrap">
<div class="card">
  <div class="hero">
    <div class="avatar-frame"><img class="avatar" src="${u.avatar}" onerror="this.outerHTML='<span style=font-size:36px>👤</span>'"></div>
    <div class="nickname">${u.nickname || '未知'}</div>
    ${origNick ? `<div class="orig-tag">${origNick}</div>` : ''}
    <div class="displayid">抖音号: ${douyinId}</div>
  </div>
  <div class="stats">
    <div class="stat-item"><span class="stat-icon">${icoFans}</span><span class="stat-val">${fmtNum(u.follower_count)}</span><span>粉丝</span></div>
    <div class="stat-item"><span class="stat-icon">${icoHeart}</span><span class="stat-val">${fmtNum(u.following_count)}</span><span>关注</span></div>
  </div>
  ${u.signature ? `<div class="extra"><div class="extra-item"><span>个签</span><span>${u.signature}</span></div></div>` : ''}
  <div class="footer">由 404 · 抖音直播监控 生成</div>
</div>
</div>
</body></html>`;

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 600, height: 800 }, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: 'networkidle' });
  await new Promise(r => setTimeout(r, 500));
  const el = await page.$('.wrap');
  const imgPath = '/tmp/user_card_' + Date.now() + '.jpg';
  await el.screenshot({ path: imgPath, type: 'jpeg', quality: 90 });
  await browser.close();

  if (process.argv.includes('--output')) { console.log(imgPath); return; }

  const chatId = 'oc_3eda7639e779aaa5f74493c09d2a1881';
  const ok = await feishu.sendImage(chatId, imgPath);
  console.log(ok ? '卡片已发送 ✅' : '发送失败');
  fs.unlinkSync(imgPath);
})().catch(e => { console.error(e); process.exit(1); });
