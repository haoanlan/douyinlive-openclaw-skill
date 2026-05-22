# douyinLive WebSocket 消息字段参考

> 从原始 log-1777821803058.json (59MB, 5000条消息, 16种消息类型) 提取
> 记录时间: 2026-05-12

## 通用结构

```
{
  "ts": "ISO 8601 时间戳 (UTC)",
  "data": {
    "common": {
      "method": "消息类型如 WebcastChatMessage",
      "msgId": "消息唯一ID",
      "roomId": "直播间ID",
      "createTime": "创建时间戳(毫秒)",
      "isShowMsg": true/false,
      "describe": "聊天栏显示文本",
      "displayText": { "key", "defaultPattern", "pieces": [...] },
      "appId": "应用ID"
    },
    "user": { /* 用户信息,见下方 */ },
    // + 各消息类型特有字段
    "livename": "主播昵称",
    "title": "直播间标题",
    "avatarThumb": { "urlList": [...] }
  }
}
```

## 用户信息字段 (user)

几乎所有消息都带此结构:

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | 用户ID |
| shortId | string | 短号 |
| nickname | string | **昵称** |
| displayId | string | 显示ID |
| gender | number | 1=男, 2=女 |
| avatarThumb | {urlList} | **头像URL** |
| followInfo | object | 关注信息 |
| followInfo.followingCount | string | 关注数 |
| followInfo.followerCount | string | 粉丝数 |
| followInfo.followStatus | string | 1=已关注 |
| payGrade.level | string | **荣誉等级** |
| payGrade.newLiveIcon | {urlList} | 等级图标 |
| fansClub.data.level | number | **粉丝团等级** |
| fansClub.data.anchorId | string | 主播ID |
| fansClub.data.userFansClubStatus | number | 粉丝团状态 |
| badgeImageList | array | 勋章列表(简) |
| badgeImageListV2 | array | 勋章列表(全) |
| publicAreaBadgeInfo | object | 公屏勋章详情 |
| desensitizedNickname | string | 脱敏昵称 |
| mysteryMan | number | 1=普通用户 |
| secUid | string | 安全UID |
| webcastUid | string | 直播UID |

## 消息类型列表

### 1. WebcastChatMessage (弹幕, 310条)

| 字段 | 说明 |
|------|------|
| content | **弹幕文本内容** (含emoji如`[捂脸]`) |
| eventTime | 时间戳 |
| rtfContentV2 | 富文本格式(数组,含表情图片链接) |

### 2. WebcastGiftMessage (礼物, 214条) ⭐最重要

| 字段 | 说明 |
|------|------|
| giftId | 礼物ID |
| repeatCount | 连击次数 |
| comboCount | 连击计数 |
| groupCount | 组连击数 |
| totalCount | **总数量** (连击总计) |
| sendType | 发送类型 (4=普通) |
| sendTime | 发送时间戳 |
| combo | boolean / string? |
| repeatEnd | 连击是否结束 |
| groupId | 组ID |
| traceId | 追踪ID |
| clientGiftSource | 客户端来源 |
| priority | 优先 |
| sendTogether | 同时发送 |
| videoLinkmicRoomId | 多直播间ID |
| useRoomMessage |  |
| roomHotInfo | 房间热度 |
| trayDisplayText | 托盘文本 |
| trayInfo | 托盘信息 |
| assetEffectMixInfo | 特效混合信息 |
| **gift** | **礼物详情对象** |
| gift.id | 礼物ID |
| gift.name | **礼物名称** |
| gift.diamondCount | **单价(钻石)** ⭐ 核心字段！ |
| gift.combo | boolean 是否支持连击 |
| gift.describe | 描述 |
| gift.type | 类型 |
| gift.image | {urlList, uri} 礼物图片 |
| gift.icon | {urlList, uri} 图标 |
| gift.webpImage | {urlList, uri} 动图 |
| gift.giftScene | **场景ID** (517/1653/5749/641/5/181等) |
| gift.itemType | 物品类型 |
| gift.forLinkmic | 是否连线直播 |
| gift.forFansclub |  |
| gift.forCustom |  |
| gift.duration | 动画时长 |
| gift.notify | 是否通知 |
| gift.primaryEffectId | 特效ID |
| gift.specialEffects | 特效配置 |
| gift.triggerWords | 触发词 |
| gift.giftLabelIcon | 标签图标 |
| gift.groupInfo | 连击文案组 [{groupCount, groupText}] |
| gift.giftPreviewInfo | 预览信息 |
| gift.reqExtraType | 请求额外类型 |
| gift.fansclubInfo | 粉丝团信息 |
| gift.afterSendAction | 发送后动作 |
| gift.assetIds | 资产ID |
| gift.bannerSchemeUrl | banner跳转 |
| gift.disableWishList | 禁用许愿单 |
| gift.isDisplayedOnPanel | 面板显示 |
| gift.appId | 应用ID |
| **toUser** | **收礼人信息** (to_nickname) |
| toUser.id | 用户ID |
| toUser.nickname | **收礼人昵称** |
| toUser.displayId | 显示ID |
| toUser.secUid | 安全UID |
| toUser.desensitizedNickname | 脱敏 |
| toUser.webcastUid | 直播UID |

**礼物计算:**
```
单次礼物总钻石 = gift.diamondCount × totalCount
连击礼物: repeatCount > 1 或 comboCount > 1 (本数据中 145/214 为连击)
礼物名称: data.gift.name (不要用 data.giftName)

饰品/scene对应 (示例数据):
- 517: 粉丝灯牌/闪耀星辰
- 1653: 小心心/你最好看/礼花筒
- 5749: 棒棒糖/加油鸭
- 5: 御龙·游侠/比心兔兔/为爱启航/真爱永恒
- 181: 抖音1号/嘉年华
- 629: 人气票
- 1029: 永恒之钻/黄桃罐头
- 641: 亲吻
- 753: 粉丝团灯牌
- 1157: 宝象传说
- 1781: 玫瑰
```

### 3. WebcastMemberMessage (进场, 2295条) 最多

| 字段 | 说明 |
|------|------|
| memberCount | 进场人数 |
| action | 动作 |
| anchorDisplayText | 主播显示文本 |
| enterEffectConfig | 进场特效配置 |
| userEnterTipType | 用户进提示类型 |
| anchorEnterTipType | 主播进提示类型 |
| buriedPoint | 埋点 |

### 4. WebcastLikeMessage (点赞, 1102条)

| 字段 | 说明 |
|------|------|
| count | **本次点赞数** |
| total | **总点赞数** |
| displayControlInfo | 显示控制 |

### 5. WebcastSocialMessage (关注/分享, 25条)

| 字段 | 说明 |
|------|------|
| action | 1=关注 |
| followCount | 主播当前粉丝数 |
| shareTarget | 分享目标 |
| shareTotalCount | 分享总数 |
| shareType | 分享类型 |

### 6. WebcastRoomStatsMessage (在线人数, 166条)

| 字段 | 说明 |
|------|------|
| displayShort | 简版人数 |
| displayMiddle | 中版 |
| displayLong | 完整文案 "xxx在线观众" |
| displayValue | 显示值 |
| total | 在线人数 |
| displayType | 显示类型 |

### 7. WebcastRoomUserSeqMessage (观众序列, 155条)

| 字段 | 说明 |
|------|------|
| ranks | 排行列表 |
| total | 总人数 |
| totalUser | 总用户 |
| totalUserStr | 总用户文本 |
| onlineUserForAnchor | 主播端在线 |
| totalPvForAnchor | 主播端总PV |

### 8. 其他消息类型

| 类型 | 说明 | 频率 |
|------|------|------|
| WebcastRanklistHourEntranceMessage | 小时榜入口 | 335 |
| WebcastGroupLiveContainerChangeMessage | 小组件变化 | 140 |
| WebcastChatLikeMessage | 弹幕点赞聚合 | 64 |
| WebcastInRoomBannerMessage | 房间banner | 168 |
| WebcastRoomRankMessage | 房间排行 | 17 |
| WebcastRoomMessage | 房间信息 | 5 |
| WebcastFansclubMessage | 粉丝团消息 | 2 |
| WebcastRoomNotifyMessage | 房间通知 | 1 |
| WebcastPrivilegeScreenChatMessage | 特权弹幕 | 1 |

## 当前 monitor.js 已记录的字段对比

| 类别 | 已记录 | 可扩展 (新字段) |
|------|--------|-----------------|
| 用户 | nickname, avatar | payGrade.level, fansClub.data.level, followInfo, gender |
| 礼物 | gift_name, diamond_per_unit, total_diamonds, count, to_nickname | giftScene, giftId, combo标记, repeatCount, gift.icon |
| 弹幕 | content, nickname | fansClub等级, 荣誉等级, rtfContentV2 |
| 在线 | count | displayLong(文案), total值 |
| 点赞 | total (增量) | 每个用户的count, 点赞趋势 |
| 进场 | memberCount | 特效类型, 用户等级 |
| 关注 | follow (计数) | 主播粉丝数变化趋势 |
| 房间 | room_title, room_author | 房间banner、活动信息 |

## 可用于扩展报告功能的数据

1. **用户等级分布** — 弹幕/礼物中提取 payGrade.level 做柱状图
2. **粉丝团等级分布** — 参与互动的粉丝团分布
3. **荣誉等级分布图** — 送礼用户等级分析
4. **礼物场景分类** — giftScene 区分不同场景的礼物
5. **送礼人 vs 收礼人分析** — toUser 字段识别
6. **弹幕富文本** — 提取表情符号频率
7. **小时榜数据** — WebcastRanklistHourEntranceMessage
8. **关注增长趋势** — followCount 时序
9. **连击率统计** — 连击礼物占比
