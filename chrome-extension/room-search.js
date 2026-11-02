// Shared by the Node server and extension service worker.
export async function searchRooms(keyword, fetchImpl = fetch) {
  const query = String(keyword || '').trim();
  if (!query) return { rooms: [] };
  if (query.length > 100) throw Object.assign(new Error('搜索词最多 100 个字符'), { status: 400 });
  const url = new URL('https://www.douyu.com/japi/search/api/searchUser');
  url.search = new URLSearchParams({ kw: query, page: '1', pageSize: '10' });
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`搜索服务异常 HTTP ${response.status}`);
  const payload = await response.json();
  if ((payload.error != null && Number(payload.error) !== 0) || !Array.isArray(payload.data?.relateUser)) {
    throw new Error('搜索服务返回异常');
  }
  const rooms = [], seen = new Set();
  for (const entry of payload.data.relateUser) {
    const info = entry.anchorInfo;
    const rid = String(info?.rid || '');
    if (!/^[1-9]\d{0,11}$/.test(rid) || seen.has(rid)) continue;
    seen.add(rid);
    rooms.push({ rid, nickname: String(info.nickName || rid), avatar: /^https?:\/\//i.test(info.avatar || '') ? info.avatar : '', live: Number(info.isLive) === 1 });
    if (rooms.length === 10) break;
  }
  return { rooms };
}
