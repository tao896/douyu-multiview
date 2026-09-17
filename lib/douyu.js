// 斗鱼取流：复刻 web-encrypt 的签名流程
// getEncryption 拿密钥 → 多轮 MD5 算 auth → POST getH5PlayV1 拿 FLV 地址
import crypto from 'node:crypto';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ORIGIN = 'https://www.douyu.com';
const UPSTREAM_TIMEOUT_MS = 12_000;
const ROOM_CACHE_MS = 5_000;
const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

export class DouyuError extends Error {
  constructor(message, { code, status = 502 } = {}) {
    super(message);
    this.name = 'DouyuError';
    this.code = code;
    this.status = status;
  }
}

function createLimiter(limit) {
  let active = 0;
  const queue = [];
  const drain = () => {
    while (active < limit && queue.length) {
      const { task, resolve, reject } = queue.shift();
      active++;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          active--;
          drain();
        });
    }
  };
  return (task) => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    drain();
  });
}

const limitRoomInfo = createLimiter(4);
const limitStream = createLimiter(3);

async function upstreamFetch(url, options = {}) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new DouyuError('上游请求超时', { status: 504 });
    }
    throw new DouyuError(`上游网络请求失败：${error?.message || error}`, { status: 502 });
  }
}

// 取流 token 与 did 绑定，进程内保持稳定
export const DID = crypto.randomBytes(16).toString('hex');

const headers = (rid) => ({
  'User-Agent': UA,
  Referer: rid ? `${ORIGIN}/${rid}` : ORIGIN,
});

// —— 加密密钥：自带 expire_at，进程内缓存复用 ——
let keyCache = null;
let keyPromise = null;

async function getKey() {
  if (keyCache && keyCache.expire_at * 1000 > Date.now() + 5_000) return keyCache;
  if (keyPromise) return keyPromise;
  keyPromise = (async () => {
    const r = await upstreamFetch(`${ORIGIN}/wgapi/livenc/liveweb/websec/getEncryption?did=${DID}`, {
      headers: headers(),
    });
    if (!r.ok) throw new DouyuError(`获取密钥失败 HTTP ${r.status}`);
    const j = await r.json().catch(() => null);
    if (!j || Number(j.error) !== 0) {
      throw new DouyuError(`获取密钥失败${j ? ` error=${j.error} ${j.msg || ''}` : '：响应解析失败'}`);
    }
    keyCache = j.data;
    return keyCache;
  })();
  try {
    return await keyPromise;
  } finally {
    keyPromise = null;
  }
}

// rand_str 迭代 enc_time 轮 MD5，末轮再拼上 rid+ts
function signStream(key, rid, ts) {
  const salt = key.is_special === 1 ? '' : `${rid}${ts}`;
  let auth = key.rand_str;
  for (let i = 0; i < key.enc_time; i++) auth = md5(`${auth}${key.key}`);
  return md5(`${auth}${key.key}${salt}`);
}

const ERRORS = {
  '-3': '房间不存在',
  '-5': '主播未开播',
  '-6': '房间已被封禁',
  '-8': '房间需要密码',
  '-9': '房间未开放',
};

const streamPromises = new Map();

async function fetchStream(rid, rate = 0) {
  const key = await getKey();
  const ts = Math.floor(Date.now() / 1000);
  // hevc=0：强制 H.264，mpegts.js 不解 H.265
  const body = new URLSearchParams({
    enc_data: key.enc_data,
    tt: String(ts),
    did: DID,
    auth: signStream(key, rid, ts),
    cdn: '',
    ver: 'Douyu_new',
    rate: String(rate),
    hevc: '0',
    fa: '0',
    ive: '0',
  });
  const r = await upstreamFetch(`${ORIGIN}/lapi/live/getH5PlayV1/${rid}`, {
    method: 'POST',
    headers: { ...headers(rid), 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await r.json().catch(() => ({ error: -1, msg: '响应解析失败' }));
  const code = Number(j.error);
  if (code !== 0) {
    // 非业务错误多半是密钥过期，丢缓存下次重取
    if (!(String(code) in ERRORS)) keyCache = null;
    const err = new DouyuError(ERRORS[String(code)] || j.msg || `取流失败 (${code})`, {
      code,
      status: code === -3 ? 404 : 502,
    });
    throw err;
  }
  const d = j.data || {};
  const url = d.is_mixed ? `${d.mixed_url}/${d.mixed_live}` : `${d.rtmp_url}/${d.rtmp_live}`;
  return {
    url,
    rate: Number(d.rate) || 0,
    rates: (d.multirates || []).map(({ name, rate: v, bit }) => ({ name, rate: Number(v), bit })),
  };
}

export function getStream(rid, rate = 0) {
  const key = `${rid}:${rate}`;
  if (streamPromises.has(key)) return streamPromises.get(key);
  const promise = limitStream(() => fetchStream(rid, rate));
  streamPromises.set(key, promise);
  promise.finally(() => {
    if (streamPromises.get(key) === promise) streamPromises.delete(key);
  }).catch(() => {});
  return promise;
}

// —— 房间信息 ——
const roomInfoCache = new Map();

export function getRoomInfo(rid) {
  const now = Date.now();
  const cached = roomInfoCache.get(rid);
  if (cached?.value && cached.expiresAt > now) return Promise.resolve(cached.value);
  if (cached?.promise) return cached.promise;

  const promise = limitRoomInfo(async () => {
    const r = await upstreamFetch(`${ORIGIN}/betard/${rid}`, { headers: headers(rid) });
    if (!r.ok) {
      throw new DouyuError(`房间信息获取失败 HTTP ${r.status}`, {
        status: r.status === 404 ? 404 : 502,
      });
    }
    // 房间不存在时斗鱼返回错误页 HTML 而非 JSON
    const j = await r.json().catch(() => null);
    if (!j?.room) throw new DouyuError('房间不存在或暂不可用', { status: 404 });
    const room = j.room;
    return {
      rid: String(room.room_id || rid),
      title: room.room_name || `房间 ${rid}`,
      nickname: room.nickname || '',
      avatar: room.avatar_mid || room.avatar_small || '',
      // show_status 1=开播 2=未开播；videoLoop 1=轮播录像
      live: Number(room.show_status) === 1,
      loop: Number(room.videoLoop) === 1,
    };
  });
  roomInfoCache.set(rid, { promise });
  promise.then(
    (value) => roomInfoCache.set(rid, { value, expiresAt: Date.now() + ROOM_CACHE_MS }),
    () => {
      if (roomInfoCache.get(rid)?.promise === promise) roomInfoCache.delete(rid);
    }
  );
  return promise;
}

// —— 输入解析：房间号 / 直播间链接 / 主题页链接 ——
export async function resolveRid(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new DouyuError('请输入直播间地址或房间号', { status: 400 });
  if (raw.length > 2048) throw new DouyuError('输入内容过长', { status: 400 });
  if (/^\d{1,12}$/.test(raw)) return raw;

  let u;
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new DouyuError('无法识别的地址', { status: 400 });
  }
  if (!/(^|\.)douyu\.com$/i.test(u.hostname)) {
    throw new DouyuError('仅支持 douyu.com 的链接', { status: 400 });
  }

  const qs = u.searchParams.get('rid') || u.searchParams.get('roomId');
  if (qs && /^\d{1,12}$/.test(qs)) return qs;

  const last = u.pathname.split('/').filter(Boolean).pop() || '';
  if (/^\d{1,12}$/.test(last)) return last;

  // 主题页/短链：从页面 HTML 里抠房间号
  const response = await upstreamFetch(u.toString(), { headers: headers() });
  if (!response.ok) throw new DouyuError(`地址解析失败 HTTP ${response.status}`);
  const html = await response.text();
  const m =
    html.match(/data-room-id="(\d+)"/) ||
    html.match(/window\.room_id\s*=\s*(\d+)/) ||
    html.match(/"room_id"\s*:\s*(\d+)/);
  if (m) return m[1];
  throw new DouyuError('未能从该地址解析出房间号', { status: 404 });
}

// 仅供测试隔离进程内缓存；生产代码不调用。
export function resetDouyuCachesForTest() {
  keyCache = null;
  keyPromise = null;
  roomInfoCache.clear();
  streamPromises.clear();
}
