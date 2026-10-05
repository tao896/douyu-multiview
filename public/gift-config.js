export const GIFT_CONFIG_URLS = [
  'https://webconf.douyucdn.cn/resource/common/prop_gift_list/prop_gift_config.json',
  'https://webconf.douyucdn.cn/resource/common/gift/gift_template/20003.json',
];

const ROOM_GIFT_TTL = 8 * 60 * 60 * 1000;
const roomSources = new Map();

export function parseGiftConfig(text) {
  // The CDN serves JSONP even though these resources have a .json suffix.
  const json = text.trim().replace(/^DYConfigCallback\s*\(([\s\S]*)\)\s*;?$/, '$1');
  const payload = JSON.parse(json);
  if (payload.error || !payload.data || typeof payload.data !== 'object') {
    throw new Error('Invalid gift configuration');
  }
  return new Map(Object.entries(payload.data).map(([key, gift]) => {
    const id = String(gift.id ?? key);
    const image = [gift.gift_pic, gift.cimg, gift.himg, gift.bimg]
      .find((url) => typeof url === 'string' && /^https?:\/\//i.test(url)) || '';
    const exp = Number(gift.exp);
    return [id, { name: gift.name || '', image, exp: Number.isFinite(exp) && exp >= 0 ? exp : null }];
  }));
}

function giftRecord(id, gift = {}, { prefix = '' } = {}) {
  const image = [gift.gift_pic, gift.cimg, gift.himg, gift.bimg, gift.pic, gift.basicInfo?.focusPic]
    .find((url) => typeof url === 'string' && url) || '';
  const price = Number(gift.exp ?? gift.pc ?? gift.priceInfo?.price);
  return [String(gift.id ?? id), {
    name: gift.name || gift.n || '',
    image: image && /^https?:\/\//i.test(image) ? image : (image ? `${prefix}${image}` : ''),
    exp: Number.isFinite(price) && price >= 0 ? price : null,
    svga: gift.svga || gift.effect_icon || '',
  }];
}

function parseRoomGift(payload) {
  const list = payload?.data?.giftList || payload?.giftList || [];
  const map = new Map();
  for (const gift of Array.isArray(list) ? list : []) {
    const [id, value] = giftRecord(gift.id, gift, { prefix: 'https://gfs-op.douyucdn.cn/dygift' });
    if (id) map.set(id, value);
  }
  return map;
}

function parseActivityGift(text) {
  const json = text.trim().replace(/^DYConfigCallback\s*\(([\s\S]*)\)\s*;?$/, '$1');
  const data = JSON.parse(json)?.data?.exchangeList || [];
  const map = new Map();
  for (const item of data) {
    const gift = item?.awardInfo;
    if (!gift || [96, 103].includes(Number(gift.awardType))) continue;
    const [id, value] = giftRecord(gift.cardId, { id: gift.cardId, name: gift.name, pic: gift.pic, pc: 1 });
    map.set(id, value);
  }
  return map;
}

async function fetchMap(url, parser) {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return parser(await response.text());
}

async function loadRoomGiftConfig(rid) {
  const key = String(rid || '').trim();
  if (!/^\d{1,12}$/.test(key)) return new Map();
  const previous = roomSources.get(key);
  if (previous && Date.now() - previous.time < ROOM_GIFT_TTL) return previous.promise;
  const promise = (async () => {
    const sources = await Promise.allSettled([
      fetch(`https://gift.douyucdn.cn/api/gift/v2/web/list?rid=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(8000) })
        .then(async (r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return parseRoomGift(await r.json()); }),
      fetch(`https://gift.douyucdn.cn/japi/reward/giftv2/preInfo/pc/v2?rid=${encodeURIComponent(key)}&userLevel=135&version=8.6.2.2`, { signal: AbortSignal.timeout(8000) })
        .then(async (r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
        .then(async (pre) => {
          const info = pre?.data?.giftPreInfo;
          if (!info) return new Map();
          const detail = await fetch(`https://gift.douyucdn.cn/japi/reward/giftv2/list/details/pc/v2?giftPreInfo=${encodeURIComponent(info)}&userLevel=150`, { signal: AbortSignal.timeout(8000) });
          if (!detail.ok) throw new Error(`HTTP ${detail.status}`);
          return parseRoomGift(await detail.json());
        }),
      fetchMap(`https://webconf.douyucdn.cn/resource/common/activity/actqzs${new Date().toISOString().slice(0, 7).replace('-', '')}_w.json`, parseActivityGift),
    ]);
    const merged = new Map();
    for (const result of sources) if (result.status === 'fulfilled') {
      for (const [id, gift] of result.value) merged.set(id, { ...merged.get(id), ...gift, name: gift.name || merged.get(id)?.name || '', image: gift.image || merged.get(id)?.image || '' });
    }
    return merged;
  })().catch(() => previous?.value || new Map());
  const entry = { time: Date.now(), promise, value: previous?.value || new Map() };
  roomSources.set(key, entry);
  promise.then((value) => { entry.value = value; });
  return promise;
}

const sources = new Map();
let lastResults;
let lastMerged;
export async function loadGiftConfig() {
  const results = await Promise.all(GIFT_CONFIG_URLS.map((url) => {
    let source = sources.get(url);
    if (!source || (source.retryAt && Date.now() >= source.retryAt)) {
      source = { retryAt: 0 };
      source.promise = fetch(url, { signal: AbortSignal.timeout(8000) })
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return parseGiftConfig(await response.text());
        })
        .catch(() => {
          source.retryAt = Date.now() + 60_000;
          return new Map();
        });
      sources.set(url, source);
    }
    return source.promise;
  }));
  if (lastResults?.every((result, index) => result === results[index])) return lastMerged;
  const merged = new Map();
  for (const entries of results) {
    for (const [id, gift] of entries) {
      const previous = merged.get(id);
      merged.set(id, { name: gift.name || previous?.name || '', image: gift.image || previous?.image || '', exp: gift.exp ?? previous?.exp ?? null });
    }
  }
  lastResults = results;
  lastMerged = merged;
  return merged;
}

export async function resolveGift(gift, rid = '') {
  const [globalConfig, roomConfig] = await Promise.all([loadGiftConfig(), loadRoomGiftConfig(rid)]);
  const config = roomConfig.get(String(gift.id)) || globalConfig.get(String(gift.id));
  return { ...gift, giftName: config?.name || gift.giftName, image: config?.image || gift.image || '', value: config ? (config.exp == null ? null : config.exp / 10) : gift.value, meta: config?.svga ? { svga: config.svga, image: config.image || gift.image || '' } : undefined };
}
