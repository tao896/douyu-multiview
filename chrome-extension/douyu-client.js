// 斗鱼房间信息与取流签名：Node 服务端（lib/douyu.js）与扩展后台（extension/douyu.js）共用。
// 取流复刻 web-encrypt 流程：getEncryption 拿密钥 → 多轮 MD5 算 auth → POST getH5PlayV1 拿 FLV 地址。
// 两端只在请求头上不同：浏览器不允许设置 User-Agent / Referer，由各自的适配文件注入。
import { md5 } from './md5.js';

const ORIGIN = 'https://www.douyu.com';
const UPSTREAM_TIMEOUT_MS = 12_000;
const ROOM_CACHE_MS = 5_000;
const AVATAR_CDN = 'https://apic.douyucdn.cn/';

const ERRORS = {
  '-3': '房间不存在',
  '-5': '主播未开播',
  '-6': '房间已被封禁',
  '-8': '房间需要密码',
  '-9': '房间未开放',
};

export function normalizeAvatarUrl(value) {
  const avatar = String(value || '').trim();
  if (!avatar) return '';
  if (/^https?:\/\//i.test(avatar)) return avatar;
  return `${AVATAR_CDN}${avatar.replace(/^\/+/, '')}`;
}

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

function randomHex(bytes) {
  const data = globalThis.crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(data, (value) => value.toString(16).padStart(2, '0')).join('');
}

// rand_str 迭代 enc_time 轮 MD5，末轮再拼上 rid+ts
export function signStream(key, rid, timestamp) {
  const salt = key.is_special === 1 ? '' : `${rid}${timestamp}`;
  let auth = key.rand_str;
  for (let index = 0; index < key.enc_time; index++) auth = md5(`${auth}${key.key}`);
  return md5(`${auth}${key.key}${salt}`);
}

// 请求 hevc=1 时主地址仍是 H.264，H.265 流单独放在 player_1（文件名带 h 后缀，FLV codecId 12）。
// 没有 H.265 转码的房间 player_1 为空，回落到 H.264。
export function streamFromPlayData(data, { hevc = false } = {}) {
  const stream = data || {};
  const avcUrl = stream.is_mixed
    ? `${stream.mixed_url}/${stream.mixed_live}`
    : `${stream.rtmp_url}/${stream.rtmp_live}`;
  const hevcUrl = hevc && /^https?:\/\//i.test(String(stream.player_1 || '')) ? stream.player_1 : '';
  return {
    url: hevcUrl || avcUrl,
    codec: hevcUrl ? 'hevc' : 'avc',
    rate: Number(stream.rate) || 0,
    rates: (stream.multirates || []).map(({ name, rate: value, bit }) => ({
      name,
      rate: Number(value),
      bit,
    })),
  };
}

function extractPageRid(html) {
  const match =
    html.match(/data-room-id="(\d+)"/) ||
    html.match(/window\.room_id\s*=\s*(\d+)/) ||
    html.match(/"room_id"\s*:\s*(\d+)/);
  if (match) return match[1];
  throw new DouyuError('未能从该地址解析出房间号', { status: 404 });
}

// headers(rid) 返回额外请求头；取流 token 与 did 绑定，每个客户端实例保持同一个 did。
export function createDouyuClient({ headers = () => ({}) } = {}) {
  const DID = randomHex(16);
  const limitRoomInfo = createLimiter(4);
  const limitStream = createLimiter(3);
  const streamPromises = new Map();
  const roomInfoCache = new Map();
  let keyCache = null;
  let keyPromise = null;

  async function upstreamFetch(url, { rid, ...options } = {}) {
    const merged = { ...headers(rid), ...options.headers };
    try {
      return await fetch(url, { ...options, headers: merged, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new DouyuError('上游请求超时', { status: 504 });
      }
      throw new DouyuError(`上游网络请求失败：${error?.message || error}`, { status: 502 });
    }
  }

  // 加密密钥自带 expire_at，进程内缓存复用
  async function getKey() {
    if (keyCache && keyCache.expire_at * 1000 > Date.now() + 5_000) return keyCache;
    if (keyPromise) return keyPromise;
    keyPromise = (async () => {
      const response = await upstreamFetch(`${ORIGIN}/wgapi/livenc/liveweb/websec/getEncryption?did=${DID}`);
      if (!response.ok) throw new DouyuError(`获取密钥失败 HTTP ${response.status}`);
      const data = await response.json().catch(() => null);
      if (!data || Number(data.error) !== 0) {
        throw new DouyuError(`获取密钥失败${data ? ` error=${data.error} ${data.msg || ''}` : '：响应解析失败'}`);
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

  async function fetchStream(rid, rate, hevc) {
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
      hevc: hevc ? '1' : '0',
      fa: '0',
      ive: '0',
    });
    const response = await upstreamFetch(`${ORIGIN}/lapi/live/getH5PlayV1/${rid}`, {
      rid,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = await response.json().catch(() => ({ error: -1, msg: '响应解析失败' }));
    const code = Number(data.error);
    if (code !== 0) {
      // 非业务错误多半是密钥过期，丢缓存下次重取
      if (!(String(code) in ERRORS)) keyCache = null;
      throw new DouyuError(ERRORS[String(code)] || data.msg || `取流失败 (${code})`, {
        code,
        status: code === -3 ? 404 : 502,
      });
    }
    return streamFromPlayData(data.data, { hevc });
  }

  // hevc：请求 H.265 流；房间没有 H.265 转码时返回 H.264，以返回值的 codec 为准。
  function getStream(rid, rate = 0, { hevc = false } = {}) {
    const cacheKey = `${rid}:${rate}:${hevc ? 1 : 0}`;
    if (streamPromises.has(cacheKey)) return streamPromises.get(cacheKey);
    const promise = limitStream(() => fetchStream(rid, rate, hevc));
    streamPromises.set(cacheKey, promise);
    promise.finally(() => {
      if (streamPromises.get(cacheKey) === promise) streamPromises.delete(cacheKey);
    }).catch(() => {});
    return promise;
  }

  function getRoomInfo(rid) {
    const cached = roomInfoCache.get(rid);
    if (cached?.value && cached.expiresAt > Date.now()) return Promise.resolve(cached.value);
    if (cached?.promise) return cached.promise;

    const promise = limitRoomInfo(async () => {
      const fetchRoom = async (roomId) => {
        const response = await upstreamFetch(`${ORIGIN}/betard/${roomId}`, { rid: roomId });
        if (!response.ok && response.status !== 404) {
          throw new DouyuError(`房间信息获取失败 HTTP ${response.status}`);
        }
        return response.ok ? response.json().catch(() => null) : null;
      };
      let data = await fetchRoom(rid);
      if (!data?.room) {
        // 靓号不能直接用于 betard；从直播页解析真实房间号后重试一次。
        const canonicalRid = await resolvePageRid(`${ORIGIN}/${rid}`);
        if (canonicalRid !== String(rid)) data = await fetchRoom(canonicalRid);
      }
      if (!data?.room) throw new DouyuError('房间不存在或暂不可用', { status: 404 });
      const room = data.room;
      return {
        rid: String(room.room_id || rid),
        title: room.room_name || `房间 ${rid}`,
        nickname: room.nickname || '',
        avatar: normalizeAvatarUrl(room.avatar_mid || room.avatar_small),
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

  async function resolvePageRid(url) {
    const response = await upstreamFetch(url);
    if (!response.ok) throw new DouyuError(`地址解析失败 HTTP ${response.status}`);
    return extractPageRid(await response.text());
  }

  // 输入解析：房间号 / 直播间链接 / 主题页链接
  async function resolveRid(input) {
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
    return resolvePageRid(url.toString());
  }

  // 仅供测试隔离缓存；生产代码不调用。
  function resetDouyuCachesForTest() {
    keyCache = null;
    keyPromise = null;
    roomInfoCache.clear();
    streamPromises.clear();
  }

  return { DID, getStream, getRoomInfo, resolveRid, resetDouyuCachesForTest };
}
