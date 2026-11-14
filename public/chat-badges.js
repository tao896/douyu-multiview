// 聊天窗弹幕行的身份标识：等级、贵族/至尊、粉丝牌、房管、钻粉、VIP、头像（样式参考 danmu-helper.cn）
// 图片均为斗鱼 CDN 上的官方素材；1–69 级用 CSS 画描边徽章，避免白底雪碧图在深色背景上发白
const SHARK = 'https://shark2.douyucdn.cn/front-publish/live-master/assets/images/';

// 粉丝牌底图 0–49 级：SHARK + `${lv}_${hash}.png`
const FANS_HASH = ('135d70b c07aa22 9b854b2 af8309d cb3ff7e 532527c 5e906ee d254011 3a3778f ad44e05 '
  + '7e9b00f 2f6ebce 71799a1 2a59ae3 f8a1ac4 35c7421 27ad0b3 d7d7e74 dff808c c4deff5 '
  + 'f651aab 65cc6db ff87867 19ff29b 94f40fa 3668710 ca2405b 31aadfb 62caffc fecc236 '
  + '996b523 71f9d4d 8ee4425 db08206 92dbed2 cb82729 aeb0481 573f948 fe61796 99bbe93 '
  + '5f7e491 e90a755 9b3c500 08b80e5 23e4ffe aa25963 381dc35 9ad8303 24d51b4 6cfe05c').split(' ');

// 70–150 级动态等级图：SHARK + `${lv}_${hash}.gif`
const HIGH_LEVEL_HASH = ('9e0c4a3 431b41a cc0f0ae 390e75f e930944 8db9f1c 6a754d2 511a43e 96cf2a1 bf8ea41 '
  + 'a683067 8cfeb3c 57f581a 2c123e2 67c820a 548fb0d 4c2afa2 29587ae 791591e 145b015 '
  + 'ac42a06 46d07df b569c59 70b6f7c 0923bd9 46a80a0 1a30913 5f8ab40 51d1efa 9e017b4 '
  + 'fd726ff 5a3e32d f1992fe 28f0900 264e6d6 d937408 240f6f6 be332d1 1ed704b ae6c0da '
  + 'de935d9 79ef6ed 4038d2e 1aefeaf 2363630 19bb4b7 c375daf 6fc53b6 a6903f1 489ae63 '
  + '469ea68 f6b138d b591b57 3af17a6 fdca954 13114e2 f506766 c068b8b 179bb75 18f4c34 '
  + '16ddd18 8983332 db75dff 8614495 67ff2bf 16a4d3e 72e7e9a e1906b6 5b16b5b b446a3c '
  + 'ad26d3e ba41504 bf3d140 71d2074 878240c bf7c511 2e078be 76309a7 66c157a d0aada4 ac3023f').split(' ');
const HIGH_LEVEL_MIN = 70;

const NOBLE_RES = 'https://res.douyucdn.cn/resource/2018/';
const NOBLES = {
  1: ['骑士', '06/21/common/1b45cf2fb1c6cddbbd95a569f399b26e.png'],
  2: ['子爵', '06/22/common/a54f50c3e6a853bef02d35395f5798ab.png'],
  3: ['伯爵', '06/22/common/ad8828ca9b9a85be571b3b28706047ed.png'],
  4: ['公爵', '06/22/common/988709683569f83cefb69dfe1703f710.png'],
  5: ['国公', '06/22/common/098f64b26aab4307f0943ce188b962b8.png'],
  6: ['皇帝', '06/21/common/fd2b69eb629abcd703fa152c66faae52.gif'],
  7: ['游侠', '06/22/common/93e7f66facdaaa30cf5634f92560e351.png'],
  8: ['超级皇帝', '06/22/common/3d994a081e5384de14689d1d8b94c5.gif'],
  9: ['幻神', '06/15/common/4e85776071ffbae2867bb9d116e9a43c.gif'],
};

const SUPREME_RES = 'https://sta-op.douyucdn.cn/front-publish/static-file-master/supreme/levelInfo/icon28/';
const SUPREMES = {
  10: ['白银至尊', '10.01cd7d8eab1046425047acfd07aa1950.5301.png'],
  20: ['黄金至尊', '20.bb3ade50537447ba8e381b823c041bd3.5309.png'],
  30: ['铂金至尊', '30.6ad42f66b4c72a8f2ce0c1224227e572.5396.png'],
  40: ['紫金至尊', '40.6b0426f8178852f67cb60277151f349f.5447.png'],
  50: ['星耀至尊', '50.5bb8c3d0570486d2c0d890bfbea5d1a0.5384.png'],
  60: ['超凡至尊', '60.c24f6a93602291f0ecc88e50cb1bff05.5480.png'],
  70: ['王者至尊', '70.a65641682c6afdec90687d3100937945.5469.png'],
};

const ROOM_ADMIN_ICON = 'https://shark2.douyucdn.cn/front-publish/live-player-aside-master/assets/fonts/room-admin_abc5a2e.svg';
const DIAMOND_ICON = 'https://shark2.douyucdn.cn/front-publish/live-next-player-aside-master/assets/images/diamond-icon_640dd0b.png';

// 粉丝特权弹幕颜色（chatmsg 的 col），7 是钻粉渐变色，由 CSS 处理
const TEXT_COLORS = {
  1: 'rgb(255, 0, 0)', 2: 'rgb(30, 135, 240)', 3: 'rgb(122, 200, 75)',
  4: 'rgb(255, 127, 0)', 5: 'rgb(155, 57, 244)', 6: 'rgb(255, 105, 180)',
};
export const DIAMOND_TEXT_COLOR = 7;

export function chatTextColor(col) {
  return TEXT_COLORS[col] || '';
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// loading 必须在 src 之前设置，否则图片已经开始下载
function img(className, src, title = '', { lazy = false } = {}) {
  const node = el('img', className);
  if (lazy) node.loading = 'lazy';
  node.alt = title;
  if (title) node.title = title;
  node.decoding = 'async';
  node.referrerPolicy = 'no-referrer';
  node.addEventListener('error', () => node.remove(), { once: true });
  node.src = src;
  return node;
}

// 1–14 浅金、15–29 橙、30–49 绿、50–69 青，与斗鱼等级图的配色分档一致
function levelTier(level) {
  if (level >= 50) return 4;
  if (level >= 30) return 3;
  if (level >= 15) return 2;
  return 1;
}

export function levelBadge(level) {
  const lv = Math.floor(Number(level) || 0);
  if (lv <= 0) return null;
  const hash = HIGH_LEVEL_HASH[lv - HIGH_LEVEL_MIN];
  if (hash) return img('chat-lv-img', `${SHARK}${lv}_${hash}.gif`, `等级 ${lv}`);
  const badge = el('span', `chat-lv t${levelTier(lv)}`, `LV ${lv}`);
  badge.title = `等级 ${lv}`;
  return badge;
}

// 至尊（新贵族体系）优先于旧贵族
function nobleBadge(chat) {
  const supreme = SUPREMES[chat.supremeLevel];
  if (supreme) return img('chat-noble', SUPREME_RES + supreme[1], supreme[0]);
  const noble = NOBLES[chat.nobleLevel];
  if (noble) return img('chat-noble', NOBLE_RES + noble[1], noble[0]);
  return null;
}

// 有底图时显示官方粉丝牌，底图缺失或加载失败时退回文字徽章
function fansMedal(chat) {
  if (!chat.fansName) return null;
  const lv = Math.max(0, Math.floor(chat.fansLevel || 0));
  const hash = FANS_HASH[lv];
  const title = `粉丝牌 ${chat.fansName} · ${lv} 级`;
  const text = el('span', 'chat-fans-text', `${chat.fansName}·${lv}`);
  text.title = title;
  if (!hash) return text;
  const medal = el('span', 'chat-fans');
  medal.title = title;
  const image = img('', `${SHARK}${lv}_${hash}.png`);
  image.addEventListener('error', () => medal.replaceWith(text), { once: true });
  medal.append(image, el('span', 'chat-fans-name', chat.fansName));
  return medal;
}

// 用户名之前的标识，顺序与斗鱼网页端一致：等级、贵族、粉丝牌、房管、钻粉、头像、VIP
export function chatIdentity(chat) {
  const nodes = [levelBadge(chat.level), nobleBadge(chat), fansMedal(chat)];
  if (chat.roomAdmin) nodes.push(img('chat-icon', ROOM_ADMIN_ICON, '房管'));
  if (chat.diamond) nodes.push(img('chat-icon chat-diamond', DIAMOND_ICON, '钻粉'));
  if (chat.avatar) nodes.push(img('chat-avatar', chat.avatar, '', { lazy: true }));
  if (chat.vip) nodes.push(el('span', 'chat-tag vip', 'VIP'));
  return nodes.filter(Boolean);
}
