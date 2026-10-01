// 斗鱼弹幕协议（STT）：浏览器直连 WSS，免登录进房
// 帧结构：len(4) + len(4) + type(2,689) + 保留(2) + 正文 + \0
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

export class DanmakuClient {
  constructor(rid, { onChat, onGift, onStatus, onStats } = {}) {
    this.rid = String(rid);
    this.onChat = onChat || (() => {});
    this.onGift = onGift || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onStats = onStats || (() => {});
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

  scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    const delay = Math.min(1000 * 2 ** this.retry++, 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = 0;
      this.connect();
    }, delay);
  }

  // 一帧里可能粘了多条消息，也可能拆到下一帧
  feed(data) {
    const chunk = new Uint8Array(data);
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    this.buf = merged;

    const dv = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    let off = 0;
    while (off + 12 <= this.buf.length) {
      const len = dv.getUint32(off, true);
      if (len < 8 || len > 1 << 22) {
        off = this.buf.length; // 帧异常，丢掉重新同步
        break;
      }
      if (off + 4 + len > this.buf.length) break;
      const msg = dec.decode(this.buf.subarray(off + 12, off + 4 + len)).replace(/\0+$/, '');
      off += 4 + len;
      this.handle(msg);
    }
    this.buf = this.buf.slice(off);
  }

  handle(msg) {
    const type = /type@=([^/]*)/.exec(msg)?.[1];
    if (type === 'chatmsg') {
      const f = parseFields(msg);
      this.onChat({
        text: unesc(f.txt),
        user: unesc(f.nn),
        color: Number(f.col) || 0,
        level: Number(f.level) || 0,
      });
    } else if (type === 'dgb' || type === 'uenter') {
      const f = parseFields(msg);
      if (type === 'dgb') {
        const count = Math.max(1, Number(f.gfc || f.gc || 1) || 1);
        // 斗鱼不同房间/版本使用 gs、gbc、dhb、dms 等字段表示鱼翅价值。
        const rawValue = Number(f.gbc || f.gs || f.dhb || f.dms || f.gift_score || f.score) || 0;
        const unitValue = rawValue;
        this.onGift({
        user: unesc(f.nn || f.un || '匿名用户'),
        giftName: unesc(f.gn || f.gfn || f.gnme || f.gname || f.giftname || f.fname || f.gfid || '礼物'),
        count,
        value: unitValue * count,
        });
      }
    } else if (type === 'rss') {
      // 开播状态变化
      const f = parseFields(msg);
      this.onStatus({ type: 'live', live: f.ss === '1' });
    } else if (type === 'oni') {
      const f = parseFields(msg);
      const noble = Number(f.vn);
      if (f.vn?.trim() && Number.isSafeInteger(noble) && noble >= 0) this.onStats({ type: 'noble', value: noble });
    } else if (type === 'error') {
      this.onStatus({ type: 'error', msg: parseFields(msg).code || '' });
    }
  }

  sendChat(text) {
    const value = String(text || '').trim();
    if (!value || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.onStatus({ type: 'send-error', msg: '弹幕连接尚未建立' });
      return false;
    }
    // 未登录连接会由斗鱼返回 error；登录态由浏览器/扩展提供。
    const content = value.replace(/@/g, '@A').replace(/\//g, '@S');
    this.ws.send(pack(`type@=chatmessage/receiver@=0/content@=${content}/scope@=1/ct@=1/`));
    return true;
  }

  close() {
    this.closed = true;
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
