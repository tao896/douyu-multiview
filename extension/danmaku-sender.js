// 用浏览器中登录的斗鱼账号发弹幕：带 douyu.com 登录 Cookie 登录网关，再发 chatmessage。
// 协议对照斗鱼网页端 common 包中的 ConnectServer.userLogin / gatewayLogin / chatmessage。
import { md5 } from './md5.js';

const GATEWAY_API = 'https://www.douyu.com/lapi/live/gateway/web/';
const FALLBACK_URLS = [6671, 6672, 6673, 6674, 6675].map((port) => `wss://wsproxy.douyu.com:${port}/`);
const VK_SALT = "r5*^5;}2#${XF[h+;'./.Q'1;,-]f'p[";
const LOGIN_VERSION = '20220825';
const COUNT_VERSION = '218101901';
const DEFAULT_DID = '10000000000000000000000000001501';
const LOGIN_TIMEOUT = 8_000;
const SEND_CONFIRM_TIMEOUT = 3_000;
// 网关心跳需要页面内的加密脚本，这里不发心跳，空闲一段时间后主动断开，下次发送再登录。
const IDLE_CLOSE = 45_000;
export const MAX_DANMAKU_LENGTH = 50;

const SEND_ERRORS = {
  2: '您已被禁言',
  5: '您已被全站禁言',
  6: '主播设置了仅粉丝可发言',
  56: '弹幕连接异常，请重试',
  57: '弹幕连接异常，请重试',
  59: '账号在其他地方登录，弹幕连接已断开',
  60: '弹幕包含违禁内容',
  206: '非法操作',
  289: '请不要重复发言',
  290: '发言速度过快，请稍后再试',
  308: '弹幕发送失败',
  391: '账号存在安全风险，请先在斗鱼网页完成验证',
};

export class SendError extends Error {
  constructor(message, { code, relogin = false, fatal = false } = {}) {
    super(message);
    this.name = 'SendError';
    this.code = code;
    this.relogin = relogin;
    this.fatal = fatal;
  }
}

export function sendErrorText(code) {
  return SEND_ERRORS[Number(code)] || `弹幕发送失败（错误码 ${code}）`;
}

const escapeStt = (value) => String(value ?? '').replace(/@/g, '@A').replace(/\//g, '@S');
const unescapeStt = (value) => String(value ?? '').replace(/@S/g, '/').replace(/@A/g, '@');

export function encodeStt(fields) {
  return Object.entries(fields).map(([key, value]) => `${escapeStt(key)}@=${escapeStt(value)}/`).join('');
}

export function decodeStt(message) {
  const out = {};
  for (const part of String(message).split('/')) {
    const index = part.indexOf('@=');
    if (index > 0) out[unescapeStt(part.slice(0, index))] = unescapeStt(part.slice(index + 2));
  }
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

export function packFrame(fields) {
  const body = encoder.encode(`${encodeStt(fields)}\0`);
  const buffer = new ArrayBuffer(12 + body.length);
  const view = new DataView(buffer);
  view.setUint32(0, body.length + 8, true);
  view.setUint32(4, body.length + 8, true);
  view.setUint16(8, 689, true);
  new Uint8Array(buffer).set(body, 12);
  return buffer;
}

// 一帧可能粘多条消息，也可能拆到下一帧
export class FrameReader {
  constructor() { this.buffer = new Uint8Array(0); }

  push(data) {
    const chunk = new Uint8Array(data);
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);
    const view = new DataView(merged.buffer);
    const messages = [];
    let offset = 0;
    while (offset + 12 <= merged.length) {
      const length = view.getUint32(offset, true);
      if (length < 8 || length > 1 << 22) { offset = merged.length; break; }
      if (offset + 4 + length > merged.length) break;
      const text = decoder.decode(merged.subarray(offset + 12, offset + 4 + length)).replace(/\0+$/, '');
      messages.push(decodeStt(text));
      offset += 4 + length;
    }
    this.buffer = merged.slice(offset);
    return messages;
  }
}

function decodeCookie(value) {
  try { return decodeURIComponent(value || ''); } catch { return String(value || ''); }
}

const LOGIN_FIELDS = ['uid', 'ltkid', 'stk', 'nickname', 'username', 'auth_wl', 'biz', 'dmjwt_token', 'did'];
export const LOGIN_COOKIE_NAMES = [...LOGIN_FIELDS.map((name) => `acf_${name}`), 'dy_did'];

// cookies: { name: value }，取自 douyu.com 的 acf_ 前缀登录 Cookie
export function credentialsFromCookies(cookies = {}) {
  const get = (name) => decodeCookie(cookies[`acf_${name}`]);
  const uid = get('uid');
  const ltkid = get('ltkid');
  const stk = get('stk');
  if (!/^\d+$/.test(uid) || !ltkid || !stk) return null;
  return {
    uid,
    nickname: get('nickname') || get('username') || uid,
    username: get('username'),
    password: get('auth_wl'),
    ltkid,
    biz: get('biz'),
    stk,
    jwt: get('dmjwt_token'),
    did: get('did') || decodeCookie(cookies.dy_did) || DEFAULT_DID,
  };
}

export function buildLoginRequest(rid, credentials, { now = Date.now(), userAgent = globalThis.navigator?.userAgent || '' } = {}) {
  const rt = Math.floor(now / 1000);
  const devid = credentials.did;
  return {
    type: 'loginreq',
    roomid: String(rid),
    dfl: '',
    username: credentials.username,
    password: credentials.password,
    ltkid: credentials.ltkid,
    biz: credentials.biz,
    stk: credentials.stk,
    devid,
    ct: 0,
    pt: 2,
    cvr: '0',
    tvr: '7',
    apd: '',
    jwt: credentials.jwt,
    rt,
    vk: md5(`${rt}${VK_SALT}${devid}`),
    ver: LOGIN_VERSION,
    aver: COUNT_VERSION,
    dmbt: 'chrome',
    dmbv: /Chrome\/(\d+)/.exec(userAgent)?.[1] || '',
  };
}

export function normalizeDanmakuText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_DANMAKU_LENGTH);
}

export function buildChatMessage(text, credentials, { now = Date.now() } = {}) {
  return {
    type: 'chatmessage',
    // 网页端先把 \ 转义成 \\，发送前再统一替换成全角 ＼
    content: normalizeDanmakuText(text).replace(/\\/g, '＼'),
    col: 0,
    pe: 0,
    dy: credentials.did,
    sender: credentials.uid,
    ifs: 0,
    nc: 0,
    dat: 0,
    rev: 0,
    tts: 0,
    admzq: 0,
    cst: now,
  };
}

// 只接受斗鱼域名，避免把登录凭据发到接口返回的其他地址
export function gatewayUrls(data) {
  const urls = [];
  for (const item of Array.isArray(data?.wss) ? data.wss : []) {
    const host = String(item?.domain || '').toLowerCase();
    const port = Number(item?.port);
    if (!/^([a-z0-9-]+\.)*douyu\.com$/.test(host) || !Number.isInteger(port) || port <= 0 || port > 65535) continue;
    urls.push(`wss://${host}:${port}/`);
  }
  return urls;
}

async function fetchGatewayUrls(rid) {
  try {
    const response = await fetch(`${GATEWAY_API}${encodeURIComponent(rid)}?isH5=1`, {
      method: 'POST',
      signal: AbortSignal.timeout(LOGIN_TIMEOUT),
    });
    const json = await response.json();
    const urls = Number(json?.error) === 0 ? gatewayUrls(json.data) : [];
    if (urls.length) return urls;
  } catch {}
  return FALLBACK_URLS;
}

class GatewaySession {
  constructor(rid, credentials, { WebSocketImpl = globalThis.WebSocket, onClose = () => {} } = {}) {
    this.rid = String(rid);
    this.credentials = credentials;
    this.WebSocketImpl = WebSocketImpl;
    this.onClose = onClose;
    this.ws = null;
    this.ready = null;
    this.pending = null;
    this.idleTimer = 0;
    this.closed = false;
  }

  async open(urls) {
    let lastError = new SendError('无法连接斗鱼弹幕服务');
    for (const url of urls) {
      try {
        await this.connect(url);
        return;
      } catch (error) {
        lastError = error;
        if (error instanceof SendError && (error.relogin || error.fatal)) break;
      }
    }
    this.close();
    throw lastError;
  }

  connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new this.WebSocketImpl(url);
      const reader = new FrameReader();
      let loggedIn = false;
      const fail = (error) => {
        clearTimeout(timer);
        this.detach(ws);
        reject(error);
      };
      const timer = setTimeout(() => fail(new SendError('登录弹幕服务超时')), LOGIN_TIMEOUT);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => ws.send(packFrame(buildLoginRequest(this.rid, this.credentials)));
      ws.onerror = () => { if (!loggedIn) fail(new SendError('无法连接斗鱼弹幕服务')); };
      ws.onclose = () => {
        if (!loggedIn) return fail(new SendError('弹幕服务连接已断开'));
        this.handleClose(ws);
      };
      ws.onmessage = (event) => {
        for (const message of reader.push(event.data)) {
          if (loggedIn) { this.handleMessage(message); continue; }
          if (message.type === 'error') {
            fail(new SendError(sendErrorText(message.code), { code: Number(message.code), fatal: true }));
            return;
          }
          if (message.type !== 'loginres') continue;
          // Cookie 失效时网关会静默降级为游客，必须核对返回的用户 id
          if (String(message.userid) !== this.credentials.uid) {
            fail(new SendError('斗鱼登录已失效，请在浏览器中重新登录斗鱼', { relogin: true }));
            return;
          }
          loggedIn = true;
          clearTimeout(timer);
          this.ws = ws;
          this.touch();
          resolve();
        }
      };
    });
  }

  handleMessage(message) {
    const pending = this.pending;
    if (!pending) return;
    if (message.type === 'chatres') {
      const code = Number(message.res) || 0;
      if (code === 0) pending.resolve({ confirmed: true });
      else pending.reject(new SendError(sendErrorText(code), { code }));
    } else if (message.type === 'error') {
      const code = Number(message.code) || 0;
      pending.reject(new SendError(sendErrorText(code), { code }));
    }
  }

  // 同一会话内串行发送，chatres 才能对应到本次弹幕
  send(text) {
    const run = () => new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) {
        reject(new SendError('弹幕服务连接已断开', { code: 'CLOSED' }));
        return;
      }
      const finish = (callback) => (value) => {
        clearTimeout(timer);
        if (this.pending === entry) this.pending = null;
        callback(value);
      };
      // 正常发送多数情况下没有 chatres 回包，超时视为已发出
      const timer = setTimeout(() => entry.resolve({ confirmed: false }), SEND_CONFIRM_TIMEOUT);
      const entry = { resolve: finish(resolve), reject: finish(reject) };
      this.pending = entry;
      this.touch();
      this.ws.send(packFrame(buildChatMessage(text, this.credentials)));
    });
    const result = (this.queue || Promise.resolve()).then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), IDLE_CLOSE);
  }

  detach(ws) {
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try { ws.close(); } catch {}
  }

  handleClose(ws) {
    if (ws !== this.ws) return;
    this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idleTimer);
    if (this.ws) this.detach(this.ws);
    this.ws = null;
    this.pending?.reject(new SendError('弹幕服务连接已断开', { code: 'CLOSED' }));
    this.onClose(this);
  }
}

// 每个房间复用一条已登录的网关连接；连接断开后下次发送自动重新登录
export class DanmakuSender {
  constructor({ WebSocketImpl = globalThis.WebSocket, resolveUrls = fetchGatewayUrls } = {}) {
    this.WebSocketImpl = WebSocketImpl;
    this.resolveUrls = resolveUrls;
    this.sessions = new Map();
  }

  async session(rid, credentials) {
    const existing = this.sessions.get(rid);
    if (existing && existing.credentials.uid === credentials.uid && !existing.session.closed) return existing.ready;
    existing?.session.close();
    const session = new GatewaySession(rid, credentials, {
      WebSocketImpl: this.WebSocketImpl,
      onClose: (item) => { if (this.sessions.get(rid)?.session === item) this.sessions.delete(rid); },
    });
    const ready = this.resolveUrls(rid).then((urls) => session.open(urls)).then(() => session);
    this.sessions.set(rid, { session, credentials, ready });
    ready.catch(() => { if (this.sessions.get(rid)?.session === session) this.sessions.delete(rid); });
    return ready;
  }

  async send(rid, text, credentials) {
    const roomId = String(rid);
    if (!/^\d{1,12}$/.test(roomId)) throw new SendError('房间号非法');
    if (!normalizeDanmakuText(text)) throw new SendError('弹幕内容不能为空');
    if (!credentials) throw new SendError('请先在浏览器中登录斗鱼', { relogin: true });
    for (let attempt = 0; ; attempt++) {
      const session = await this.session(roomId, credentials);
      try {
        return await session.send(text);
      } catch (error) {
        // 空闲期间被服务端断开的旧连接，重新登录后重试一次
        if (error?.code !== 'CLOSED' || attempt > 0) throw error;
      }
    }
  }

  closeAll() {
    for (const { session } of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}
