/**
 * 抖音用户信息查询 - 通过 secUid 获取用户资料
 *
 * a_bogus 算法：随机 27 位字符串（AG + 25 chars from SYMB 表），
 * 服务端验证较宽松，失败时重试即可。
 */
const fs = require('fs');
const path = require('path');

/** a_bogus 字符表 */
const SYMB = 'Dkdpgh4ZKsQB80/Mfvw36XI1R25+WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe=';

/** 生成随机 a_bogus */
function randomABogus() {
  let s = 'AG';
  for (let i = 0; i < 25; i++) s += SYMB[Math.floor(Math.random() * 64)];
  return s;
}

/** 获取完整 cookie */
function getFullCookieStr() {
  const yaml = fs.readFileSync(path.join(__dirname, 'config.yaml'), 'utf-8');
  const match = yaml.match(/douyin:\s*'([^']+)'/);
  return match ? match[1] : '';
}

/** 通过 secUid 查询用户信息（随机 a_bogus + 重试） */
async function fetchUserBySecUid(secUid) {
  const fullCookie = getFullCookieStr();
  if (!fullCookie) { console.error('[douyin-user] 无 cookie'); return null; }

  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  const maxRetries = 20;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const ab = randomABogus();
    const url = `https://www.douyin.com/aweme/v1/web/user/profile/other/?sec_user_id=${secUid}&a_bogus=${ab}`;

    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': userAgent,
          'Referer': 'https://www.douyin.com/',
          'Cookie': fullCookie,
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        }
      });

      const text = await res.text();
      if (!text || text.length < 10) continue; // empty body → retry (bad a_bogus)

      const data = JSON.parse(text);
      if (!data || data.status_code !== 0) {
        // status_code != 0 是 API 错误（如用户不存在），不用重试
        return null;
      }

      const u = data.user || data.user_info || {};
      const avatarObj = u.avatar_larger || u.avatar_168x168 || u.avatar_thumb || {};
      const avatarUrl = Array.isArray(avatarObj.url_list) ? avatarObj.url_list[0]
        : (typeof avatarObj === 'string' ? avatarObj : '');

      return {
        sec_uid: secUid,
        nickname: u.nickname || '',
        display_id: u.display_id || '',
        short_id: u.short_id || '',
        unique_id: u.unique_id || '',
        avatar: avatarUrl,
        follower_count: u.follower_count || 0,
        following_count: u.following_count || 0,
        signature: u.signature || '',
      };
    } catch (e) {
      // 网络错误等，继续重试
      if (attempt === maxRetries - 1) {
        console.error('[douyin-user] 请求失败 (尝试' + maxRetries + '次):', e.message);
      }
    }
  }

  return null;
}

// ========== CLI ==========

if (require.main === module) {
  const secUid = process.argv[2];
  if (!secUid) { console.log('用法: node douyin-user.js <secUid>'); process.exit(1); }

  fetchUserBySecUid(secUid).then(user => {
    if (user) {
      console.log(JSON.stringify(user, null, 2));
    } else {
      console.log('查询失败：用户不存在或已被删除');
    }
  }).catch(e => console.error(e));
}

module.exports = { fetchUserBySecUid };
