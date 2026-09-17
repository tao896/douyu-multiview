// Browser/service-worker version of the Douyu API client. Cross-origin
// access is granted by manifest host_permissions; media stays direct-to-CDN.
import { md5 } from './md5.js';

const ORIGIN = 'https://www.douyu.com';
const UPSTREAM_TIMEOUT_MS = 12_000;
const ROOM_CACHE_MS = 5_000;

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

function randomHex(bytes) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(data, (value) => value.toString(16).padStart(2, '0')).join('');
}

// The token and did are bound together, so keep a stable did for this worker.
export const DID = randomHex(16);

let keyCache = null;
let keyPromise = null;

async function getKey() {
  if (keyCache && keyCache.expire_at * 1000 > Date.now() + 5_000) return keyCache;
  if (keyPromise) return keyPromise;
  keyPromise = (async () => {
    const response = await upstreamFetch(
      `${ORIGIN}/wgapi/livenc/liveweb/websec/getEncryption?did=${DID}`
    );
    if (!response.ok) throw new DouyuError(`获取密钥失败 HTTP ${response.status}`);
    const data = await response.json().catch(() => null);
    if (!data || Number(data.error) !== 0) {
      throw new DouyuError(
        `获取密钥失败${data ? ` error=${data.error} ${data.msg || ''}` : '：响应解析失败'}`
      );
    }
    keyCache = data.data;
    return keyCache;
  })();
  try {
    return await keyPromise;
  } finally {
    keyPromise = null;
  }
}

function signStream(key, rid, timestamp) {
  const salt = key.is_special === 1 ? '' : `${rid}${timestamp}`;
  let auth = key.rand_str;
  for (let index = 0; index < key.enc_time; index++) auth = md5(`${auth}${key.key}`);
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
  const timestamp = Math.floor(Date.now() / 1000);
  const body = new URLSearchParams({
    enc_data: key.enc_data,
    tt: String(timestamp),
    did: DID,
    auth: signStream(key, rid, timestamp),
    cdn: '',
    ver: 'Douyu_new',
    rate: String(rate),
    hevc: '0',
    fa: '0',
    ive: '0',
  });
  const response = await upstreamFetch(`${ORIGIN}/lapi/live/getH5PlayV1/${rid}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await response.json().catch(() => ({ error: -1, msg: '响应解析失败' }));
  const code = Number(data.error);
  if (code !== 0) {
    if (!(String(code) in ERRORS)) keyCache = null;
    throw new DouyuError(ERRORS[String(code)] || data.msg || `取流失败 (${code})`, {
      code,
      status: code === -3 ? 404 : 502,
    });
  }
  const stream = data.data || {};
  const url = stream.is_mixed
    ? `${stream.mixed_url}/${stream.mixed_live}`
    : `${stream.rtmp_url}/${stream.rtmp_live}`;
  return {
    url,
    rate: Number(stream.rate) || 0,
    rates: (stream.multirates || []).map(({ name, rate: value, bit }) => ({
      name,
      rate: Number(value),
      bit,
    })),
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

const roomInfoCache = new Map();

export function getRoomInfo(rid) {
  const cached = roomInfoCache.get(rid);
  if (cached?.value && cached.expiresAt > Date.now()) return Promise.resolve(cached.value);
  if (cached?.promise) return cached.promise;

  const promise = limitRoomInfo(async () => {
    const response = await upstreamFetch(`${ORIGIN}/betard/${rid}`);
    if (!response.ok) {
      throw new DouyuError(`房间信息获取失败 HTTP ${response.status}`, {
        status: response.status === 404 ? 404 : 502,
      });
    }
    const data = await response.json().catch(() => null);
    if (!data?.room) throw new DouyuError('房间不存在或暂不可用', { status: 404 });
    const room = data.room;
    return {
      rid: String(room.room_id || rid),
      title: room.room_name || `房间 ${rid}`,
      nickname: room.nickname || '',
      avatar: room.avatar_mid || room.avatar_small || '',
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

export async function resolveRid(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new DouyuError('请输入直播间地址或房间号', { status: 400 });
  if (raw.length > 2048) throw new DouyuError('输入内容过长', { status: 400 });
  if (/^\d{1,12}$/.test(raw)) return raw;

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new DouyuError('无法识别的地址', { status: 400 });
  }
  if (!/(^|\.)douyu\.com$/i.test(url.hostname)) {
    throw new DouyuError('仅支持 douyu.com 的链接', { status: 400 });
  }

  const queryRid = url.searchParams.get('rid') || url.searchParams.get('roomId');
  if (queryRid && /^\d{1,12}$/.test(queryRid)) return queryRid;
  const lastSegment = url.pathname.split('/').filter(Boolean).pop() || '';
  if (/^\d{1,12}$/.test(lastSegment)) return lastSegment;

  const response = await upstreamFetch(url.toString());
  if (!response.ok) throw new DouyuError(`地址解析失败 HTTP ${response.status}`);
  const html = await response.text();
  const match =
    html.match(/data-room-id="(\d+)"/) ||
    html.match(/window\.room_id\s*=\s*(\d+)/) ||
    html.match(/"room_id"\s*:\s*(\d+)/);
  if (match) return match[1];
  throw new DouyuError('未能从该地址解析出房间号', { status: 404 });
}

export function resetDouyuCachesForTest() {
  keyCache = null;
  keyPromise = null;
  roomInfoCache.clear();
  streamPromises.clear();
}
