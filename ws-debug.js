/**
 * WebSocket 消息调试工具
 * 连接 douyinLive 代理，打印/保存所有接收到的原始消息
 * 
 * 用法:
 *   node ws-debug.js [room_id]                    # 只打印到终端
 *   node ws-debug.js [room_id] output.jsonl        # 打印 + 保存到文件
 *   node ws-debug.js [room_id] output.jsonl --full  # 保存完整原始 JSON（不截断）
 *
 * JSONL 格式: 每行一条完整消息，便于后续分析
 */
const fs = require('fs');
const path = require('path');
const { WebSocket } = require('ws');

const roomId = process.argv[2] || '72288034336';
const outputFile = process.argv[3] || '';
const fullMode = process.argv.includes('--full');

const wsUrl = `ws://127.0.0.1:1088/ws/${roomId}`;
const reportsDir = path.join(__dirname, 'reports');

// 自动生成输出文件名
const finalOutput = outputFile || (outputFile.includes(path.sep) ? outputFile : path.join(reportsDir, outputFile || ''));

let writeStream = null;
if (finalOutput) {
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  writeStream = fs.createWriteStream(finalOutput, { flags: 'a' });
  // 记录元数据头
  writeStream.write(JSON.stringify({ _meta: { type: 'session_start', roomId, time: new Date().toISOString() } }) + '\n');
  console.log(`📝 保存到: ${finalOutput}`);
}

console.log('🔌 连接:', wsUrl);
console.log('按 Ctrl+C 停止\n');

const ws = new WebSocket(wsUrl);
let msgCount = 0;
let live = false;

function log(msg) {
  console.log(msg);
  // 也写入文件，可选
}

ws.on('open', () => {
  console.log('✅ 已连接\n');
});

ws.on('message', (raw) => {
  msgCount++;
  const str = raw.toString();

  // 总是写入文件（完整原始 JSON，一行一条）
  if (writeStream) {
    writeStream.write(str + '\n');
  }

  try {
    const data = JSON.parse(str);

    // 跟踪直播状态
    if (data.type === 'system' && data.event === 'live_status') {
      live = !!data.live;
    }

    // 终端输出（精简版）
    const type = data.type || 'unknown';
    const method = data._method || data.method || '';
    const event = data.event || '';
    const key = method || event || type;

    if (type === 'system') {
      console.log(`[${msgCount}] 📋 ${event} | live=${!!data.live}${data.live ? ' 🔴' : ''}`);
      if (data.live) console.log(`    标题: ${data.title || ''} | 主播: ${data.livename || ''}`);
    } else {
      // WebSocket 消息
      let icon = '📡';
      if (key.includes('Gift')) icon = '🎁';
      else if (key.includes('Chat')) icon = '💬';
      else if (key.includes('Like')) icon = '❤️';
      else if (key.includes('Member')) icon = '🚪';
      else if (key.includes('RoomStats')) icon = '📊';
      else if (key.includes('RoomUserSeq')) icon = '🏆';
      else if (key.includes('Fansclub')) icon = '⭐';
      else if (key.includes('ScreenChat')) icon = '📺';
      else if (key.includes('Social')) icon = '👤';

      const cn = methodToCn(data._method || data.method || '');
      console.log(`[${msgCount}] ${icon} ${key} ${cn ? '(' + cn + ')' : ''}`);
      if (fullMode || !writeStream) {
        // 无文件模式 → 终端完整输出
        console.log(`  ${str.substring(0, fullMode ? str.length : 2000)}`);
        if (!fullMode && str.length > 2000) console.log(`  ... (${str.length} bytes, 用 --full 查看完整)`);
      }
    }
  } catch (e) {
    console.log(`[${msgCount}] ⚠️ 解析失败: ${str.substring(0, 200)}`);
  }
});

ws.on('close', (code) => {
  console.log(`\n❌ 断开连接 (code: ${code})`);
  console.log(`共接收 ${msgCount} 条消息`);
  if (writeStream) {
    writeStream.write(JSON.stringify({ _meta: { type: 'session_end', msgCount, roomId, time: new Date().toISOString() } }) + '\n');
    writeStream.end();
  }
  process.exit(0);
});

ws.on('error', (err) => {
  console.log(`❌ 错误: ${err.message}`);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n👋 停止调试');
  ws.close();
});

/** 消息类型中文名 */
function methodToCn(method) {
  const map = {
    'WebcastGiftMessage': '礼物',
    'WebcastChatMessage': '弹幕',
    'WebcastLikeMessage': '点赞',
    'WebcastMemberMessage': '进场',
    'WebcastFansclubMessage': '星守护',
    'WebcastScreenChatMessage': '飘屏弹幕',
    'WebcastPrivilegeScreenChatMessage': '特权飘屏',
    'WebcastSocialMessage': '关注',
    'WebcastRoomStatsMessage': '房间统计',
    'WebcastRoomUserSeqMessage': '在线排行',
    'WebcastRoomMessage': '房间信息',
    'WebcastRoomRankMessage': '房间排名',
    'WebcastRanklistHourEntranceMessage': '小时榜',
    'WebcastInRoomBannerMessage': '房间横幅',
    'WebcastGroupLiveContainerChangeMessage': '分组变化',
    'WebcastResidentGuestMessage': '常驻观众',
    'WebcastCommonCardAreaMessage': '通用卡片',
    'WebcastGiftDownloadMessage': '礼物下载',
    'WebcastUpdateFanTicketMessage': '粉丝票更新',
    'WebcastProfitInteractionScoreMessage': '互动分',
    'WebcastLiveIntroMessage': '直播介绍',
    'WebcastAudioChatMessage': '语音聊天',
    'WebcastLinkMicFanTicketMethod': '连麦粉丝票',
  };
  return map[method] || '';
}
