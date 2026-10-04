export const GIFT_CONFIG_URLS = [
  'https://webconf.douyucdn.cn/resource/common/prop_gift_list/prop_gift_config.json',
  'https://webconf.douyucdn.cn/resource/common/gift/gift_template/20003.json',
];

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

export async function resolveGift(gift) {
  const config = (await loadGiftConfig()).get(String(gift.id));
  return { ...gift, giftName: config?.name || gift.giftName, image: config?.image || gift.image || '', value: config?.exp == null ? gift.value : config.exp / 10 };
}
