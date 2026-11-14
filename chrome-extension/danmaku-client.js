// 斗鱼弹幕协议（STT）：浏览器直连 WSS，免登录进房
// 帧结构：len(4) + len(4) + type(2,689) + 保留(2) + 正文 + \0
import { md5 } from './md5.js';

const WS_URL = 'wss://danmuproxy.douyu.com:8506/';
const KEEPALIVE = 40_000;
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8');

function pack(str) {
  const body = enc.encode(str + '\0');
  const buf = new ArrayBuffer(12 + body.length);
  const dv = new DataView(buf);
  dv.setUint32(0, body.length + 8, true);
  dv.setUint32(4, body.length + 8, true);
  dv.setUint16(8, 689, true);
  new Uint8Array(buf).set(body, 12);
  return buf;
}

// 一帧里可能粘了多条消息，也可能拆到下一帧；返回未处理完的剩余字节
function splitFrames(pending, data, onMessage) {
  const chunk = new Uint8Array(data);
  const buf = new Uint8Array(pending.length + chunk.length);
  buf.set(pending, 0);
  buf.set(chunk, pending.length);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 0;
  while (off + 12 <= buf.length) {
    const len = dv.getUint32(off, true);
    if (len < 8 || len > 1 << 22) {
      off = buf.length; // 帧异常，丢掉重新同步
      break;
    }
    if (off + 4 + len > buf.length) break;
    onMessage(dec.decode(buf.subarray(off + 12, off + 4 + len)).replace(/\0+$/, ''));
    off += 4 + len;
  }
  return buf.slice(off);
}

// 斗鱼把 / 和 @ 转义成 @S / @A，反转义顺序不能颠倒
const unesc = (s) => String(s ?? '').replace(/@S/g, '/').replace(/@A/g, '@');

function parseFields(msg) {
  const out = {};
  for (const part of msg.split('/')) {
    const i = part.indexOf('@=');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 2);
  }
  return out;
}

// 弹幕里的头像是 avatar_v3/202610/xxx 这样的相对路径
export function avatarFromIc(ic) {
  const value = unesc(ic).trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  return `https://apic.douyucdn.cn/upload/${value.replace(/^\/+/, '')}_small.jpg`;
}

// chatmsg 帧 → 聊天窗显示所需的身份字段。字段含义参考斗鱼网页端：
// bnn/bl 粉丝牌名称与等级，nl 贵族等级（nc=1 表示贵族身份有效），sl 至尊等级，
// pg=5 超管，rg=4 房管，ail 含 453/454 为 VIP，diaf/cdiaf 钻粉（只认本房间的粉丝牌）
export function chatFromFields(f, rid = '') {
  const ail = unesc(f.ail);
  return {
    text: unesc(f.txt),
    user: unesc(f.nn),
    uid: String(f.uid || ''),
    color: Number(f.col) || 0,
    level: Number(f.level) || 0,
    avatar: avatarFromIc(f.ic),
    fansName: unesc(f.bnn),
    fansLevel: Number(f.bl) || 0,
    nobleLevel: Number(f.nl) || 0,
    noble: f.nc === '1',
    supremeLevel: Number(f.sl) || 0,
    superAdmin: f.pg === '5',
    roomAdmin: f.rg === '4',
    vip: /(^|\/)45[34]\//.test(ail),
    diamond: (Number(f.diaf) > 0 || Number(f.cdiaf) > 0) && String(f.brid || '') === String(rid),
  };
}

const DIAMOND_FAN_IMAGE ='https://shark2.douyucdn.cn/front-publish/live-player-aside-master/assets/images/diamonds_banner_logo_c077d7b.gif';
// 开通/续费钻粉：新版协议是 dfobc/dfrbc，旧版是 odfbc/rndfbc
export const DIAMOND_FAN_TYPES = { dfobc: '开通钻粉', odfbc: '开通钻粉', dfrbc: '续费钻粉', rndfbc: '续费钻粉' };

export function diamondFanGift(type, f) {
  const giftName = DIAMOND_FAN_TYPES[type];
  if (!giftName) return null;
  // 价值未知，不参与价值下限过滤；按名称过滤仍然生效
  return { id: '', giftName, image: DIAMOND_FAN_IMAGE, count: 1, value: null, user: unesc(f.nick || f.nn || f.unk || '匿名用户'), avatar: avatarFromIc(f.icon || f.ic || f.uic) };
}

// 帧内字段作为配置缺失时的回退；名称和图标由礼物配置补全。
export function giftFromFields(f) {
  const rawId = String(f.gfid || f.giftid || f.gift_id || f.giftId || '').trim();
  // 背包道具（陪伴印章、钻粉道具等）下发 gfid@=0，只能靠 pid 查道具配置
  const id = rawId === '0' ? '' : rawId;
  const pid = String(f.pid || '').trim();
  const propId = !id && /^[1-9]\d{0,11}$/.test(pid) ? pid : '';
  const count = Math.max(1, Number(f.gfcnt || f.gfc || f.gcnt || f.giftcount || f.gc || 1) || 1);
  const giftName = unesc(f.gn || f.gfn || f.gnme || f.gname || f.giftname || f.fname || f.gift_name || id || '礼物');
  const image = unesc(f.gifturl || f.gift_url || f.giftpic || f.gift_pic || f.giftimg || f.gift_img || '');
  // dgb 帧不带价格（gs 是展示样式，恒为 0），单价由礼物配置补全；未知时为 null，不参与价值过滤。
  // wbcstv2/abstv2 是展示样式档位，不是秒数；停留时长由 resolveGift 按礼物配置的 hitInterval 补全。
  return { id, ...(propId && { propId }), userId: String(f.uid || ''), giftName, image, count, value: null, user: unesc(f.nn || f.un || f.username || '匿名用户'), avatar: avatarFromIc(f.ic || f.avatar || f.useravatar) };
}

// 榜单列表是二层嵌套的 STT：先反转义出条目（/ 分隔），每个条目再反转义出字段
export function parseNestedList(raw) {
  return unesc(raw).split('/').filter(Boolean).map((item) => {
    const out = {};
    for (const [key, value] of Object.entries(parseFields(unesc(item)))) out[key] = unesc(value);
    return out;
  });
}

function rankUser(item, { badge = item.fbn } = {}) {
  return {
    uid: String(item.uid || ''),
    name: item.nn || item.nickname || item.nick || '匿名用户',
    avatar: avatarFromIc(item.icon),
    level: Number(item.lv || item.level || item.lev) || 0,
    badge: badge || '',
    badgeLevel: Number(item.fblv || item.flev) || 0,
    diamond: item.diaf === '1',
    noble: Number(item.ne) || 0,
    // 活跃榜贡献值，1000 = 1 元
    gold: item.gold == null ? null : Number(item.gold) || 0,
  };
}

// 在线榜、活跃榜（日榜）、贵宾、钻粉榜：弹幕连接订阅后只在变化时推送
export const RANK_TYPES = ['oul', 'dayrk', 'ovl', 'dfansrk'];
const RANK_SNAPSHOT_TYPES = new Set([...RANK_TYPES, 'dfnum']);

// 进房时的完整榜单：与斗鱼网页端一样，以游客身份登录网关后逐个 get（参考 common 包 ConnectServer.userLogin）
const GATEWAY_URLS = [6671, 6672, 6673, 6674, 6675].map((port) => `wss://wsproxy.douyu.com:${port}/`);
const VK_SALT = "r5*^5;}2#${XF[h+;'./.Q'1;,-]f'p[";
const SNAPSHOT_TIMEOUT = 6_000;
const SNAPSHOT_MIN_INTERVAL = 30_000;

function randomDid() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function visitorLoginRequest(rid, { now = Date.now(), devid = randomDid() } = {}) {
  const rt = Math.floor(now / 1000);
  // 游客登录：账号字段留空，网关分配 visitor 身份；vk 校验与登录账号相同
  return `type@=loginreq/roomid@=${rid}/dfl@=/username@=/password@=/ltkid@=/biz@=/stk@=/devid@=${devid}`
    + `/ct@=0/pt@=2/cvr@=0/tvr@=7/apd@=/jwt@=/rt@=${rt}/vk@=${md5(`${rt}${VK_SALT}${devid}`)}`
    + '/ver@=20220825/aver@=218101901/dmbt@=chrome/dmbv@=/';
}

// 消息里没有列表字段时返回 null（只更新人数），不能当成空榜覆盖已有列表
const rankList = (raw, options) => (raw == null ? null : parseNestedList(raw).map((item) => rankUser(item, options)));

export function rankFromMessage(type, f) {
  if (type === 'oul') return { type: 'online', count: f.un ?? null, list: rankList(f.ul) };
  if (type === 'oun') return f.un ? { type: 'online', count: f.un } : null;
  if (type === 'dayrk') return { type: 'active', list: rankList(f.list) };
  if (type === 'ranklist' && f.list_day) return { type: 'active', list: rankList(f.list_day) };
  if (type === 'ovl') {
    if (f.vl == null && f.nl == null) return f.vn ? { type: 'vip', count: f.vn } : null;
    // vl = VIP 贵宾席，nl = 贵族；同一用户可能同时在两边
    const seen = new Set();
    const list = [...parseNestedList(f.vl), ...parseNestedList(f.nl)]
      .filter((item) => item.uid && !seen.has(item.uid) && seen.add(item.uid))
      .map((item) => rankUser(item));
    return { type: 'vip', count: f.vn ?? null, list };
  }
  if (type === 'oni') return f.vn?.trim() ? { type: 'vip', count: f.vn } : null;
  if (type === 'dfansrk') return { type: 'diamond', count: f.dfc ?? null, list: rankList(f.list, { badge: f.bn }) };
  if (type === 'dfnum') return f.dfc ? { type: 'diamond', count: f.dfc } : null;
  return null;
}

export class DanmakuClient {
  constructor(rid, { onChat, onGift, onStatus, onStats, onRanks } = {}) {
    this.rid = String(rid);
    this.onChat = onChat || (() => {});
    this.onGift = onGift || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onStats = onStats || (() => {});
    this.onRanks = onRanks || (() => {});
    this.ranksWanted = false;
    this.ws = null;
    this.buf = new Uint8Array(0);
    this.timer = 0;
    this.retry = 0;
    this.reconnectTimer = 0;
    this.closed = false;
  }

  connect() {
    if (this.closed || this.ws) return;
    let ws;
    try {
      ws = new WebSocket(WS_URL);
    } catch {
      return this.scheduleReconnect();
    }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      this.retry = 0;
      this.buf = new Uint8Array(0);
      ws.send(pack(`type@=loginreq/roomid@=${this.rid}/`));
      ws.send(pack(`type@=joingroup/rid@=${this.rid}/gid@=-9999/`)); // -9999 = 全部弹幕组
      if (this.ranksWanted) {
        this.sendRankSubscription(true);
        this.fetchRankSnapshot();
      }
      this.timer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(pack('type@=mrkl/'));
      }, KEEPALIVE);
      this.onStatus({ type: 'open' });
    };

    ws.onmessage = (e) => this.feed(e.data);

    ws.onclose = () => {
      clearInterval(this.timer);
      this.ws = null;
      if (!this.closed) {
        this.onStatus({ type: 'close' });
        this.scheduleReconnect();
      }
    };

    ws.onerror = () => this.onStatus({ type: 'error' });
  }

  // 只有聊天窗当前选中的房间订阅榜单，其余房间不额外占流量
  setRanksWanted(wanted) {
    const next = !!wanted;
    if (next === this.ranksWanted) return;
    this.ranksWanted = next;
    this.sendRankSubscription(next);
    if (next && this.ws) this.fetchRankSnapshot();
  }

  sendRankSubscription(on) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    for (const mt of RANK_TYPES) this.ws.send(pack(`type@=${on ? 'sub' : 'unsub'}/mt@=${mt}/`));
  }

  scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    const delay = Math.min(1000 * 2 ** this.retry++, 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = 0;
      this.connect();
    }, delay);
  }

  feed(data) {
    this.buf = splitFrames(this.buf, data, (msg) => this.handle(msg));
  }

  // 网关连接只取榜单，拿到后（或超时）立即断开；网关心跳需要页面加密脚本，不长连
  fetchRankSnapshot() {
    if (this.closed || this.snapshotWs || Date.now() - (this.snapshotAt || 0) < SNAPSHOT_MIN_INTERVAL) return;
    this.snapshotAt = Date.now();
    const url = GATEWAY_URLS[Math.floor(Math.random() * GATEWAY_URLS.length)];
    let ws;
    try {
      ws = new WebSocket(url);
    } catch {
      return;
    }
    this.snapshotWs = ws;
    ws.binaryType = 'arraybuffer';
    let buf = new Uint8Array(0);
    const pending = new Set(RANK_SNAPSHOT_TYPES);
    const finish = () => {
      clearTimeout(timer);
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try { ws.close(); } catch {}
      if (this.snapshotWs === ws) this.snapshotWs = null;
    };
    const timer = setTimeout(finish, SNAPSHOT_TIMEOUT);
    ws.onopen = () => ws.send(pack(visitorLoginRequest(this.rid)));
    ws.onerror = ws.onclose = finish;
    ws.onmessage = (event) => {
      buf = splitFrames(buf, event.data, (msg) => {
        const type = /type@=([^/]*)/.exec(msg)?.[1];
        if (type === 'loginres') {
          for (const mt of RANK_SNAPSHOT_TYPES) ws.send(pack(`type@=get/msgtype@=${mt}/`));
        } else if (pending.delete(type)) {
          // 网关同样会下发弹幕、礼物，这里只处理榜单，避免重复
          this.handle(msg);
        }
      });
      if (!pending.size) finish();
    };
  }

  handle(msg) {
    const type = /type@=([^/]*)/.exec(msg)?.[1];
    if (type === 'chatmsg') {
      this.onChat(chatFromFields(parseFields(msg), this.rid));
    } else if (type === 'dgb' || type === 'uenter') {
      const f = parseFields(msg);
      if (type === 'dgb') {
        this.onGift(giftFromFields(f));
      }
    } else if (DIAMOND_FAN_TYPES[type]) {
      const f = parseFields(msg);
      // 只显示本房间的开通/续费，其他房间的广播丢弃
      const rid = f.rid && f.rid !== '0' ? f.rid : f.drid;
      if (!rid || rid === this.rid) this.onGift(diamondFanGift(type, f));
    } else if (type === 'rss') {
      // 开播状态变化
      const f = parseFields(msg);
      this.onStatus({ type: 'live', live: f.ss === '1' });
    } else if (type === 'oni') {
      const f = parseFields(msg);
      const noble = Number(f.vn);
      if (f.vn?.trim() && Number.isSafeInteger(noble) && noble >= 0) this.onStats({ type: 'noble', value: noble });
      const rank = rankFromMessage(type, f);
      if (rank) this.onRanks(rank);
    } else if (RANK_TYPES.includes(type) || type === 'oun' || type === 'ranklist' || type === 'dfnum') {
      const f = parseFields(msg);
      if (f.rid && f.rid !== this.rid) return;
      const rank = rankFromMessage(type, f);
      if (rank) this.onRanks(rank);
    } else if (type === 'error') {
      this.onStatus({ type: 'error', msg: parseFields(msg).code || '' });
    }
  }

  close() {
    this.closed = true;
    try { this.snapshotWs?.close(); } catch {}
    this.snapshotWs = null;
    clearInterval(this.timer);
    clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.onclose = null;
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  }
}
