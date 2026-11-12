// 当前浏览器登录的斗鱼账号的关注列表，与斗鱼「我的关注」页使用同一接口。
// 只能在扩展后台请求：需要 www.douyu.com 的登录 Cookie，host_permissions 允许后台带上它。
import { normalizeAvatarUrl } from './douyu-client.js';

const FOLLOW_API = 'https://www.douyu.com/wgapi/livenc/liveweb/follow/list';
const PAGE_TIMEOUT_MS = 12_000;
// 官网每页 120 个；关注再多也只取前 30 页，防止接口异常时无限翻页。
const MAX_PAGES = 30;

export class FollowListError extends Error {
  constructor(message, { relogin = false } = {}) {
    super(message);
    this.name = 'FollowListError';
    this.relogin = relogin;
  }
}

// show_status 1=开播；与房间信息接口的判断保持一致。
export function normalizeFollowRoom(item) {
  const rid = String(item?.room_id ?? '').trim();
  if (!/^\d{1,12}$/.test(rid)) return null;
  return {
    rid,
    nickname: String(item.nickname || '').slice(0, 100),
    title: String(item.room_name || '').slice(0, 300),
    avatar: normalizeAvatarUrl(item.avatar_small),
    live: Number(item.show_status) === 1,
  };
}

// 接口返回 { error, msg, data: { list, nowPage, pageCount } }；官网用 GSON.parse 读 data，可能是字符串。
export function parseFollowPage(json) {
  const code = Number(json?.error);
  if (code !== 0) {
    throw new FollowListError(json?.msg || `获取关注列表失败（${json?.error ?? '响应异常'}）`, { relogin: code === -1 });
  }
  let data = json.data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { data = null; }
  }
  const list = Array.isArray(data?.list) ? data.list : [];
  return {
    rooms: list.map(normalizeFollowRoom).filter(Boolean),
    pageCount: Math.max(1, Math.min(MAX_PAGES, Math.floor(Number(data?.pageCount) || 1))),
  };
}

// 逐页拉取并按房间号去重。fetchImpl 便于测试替换。
export async function fetchFollowList({ fetchImpl = fetch } = {}) {
  const rooms = [];
  const seen = new Set();
  let pageCount = 1;
  for (let page = 1; page <= pageCount; page++) {
    const url = `${FOLLOW_API}?${new URLSearchParams({ sort: '0', cid1: '0', page: String(page) })}`;
    let json;
    try {
      const response = await fetchImpl(url, {
        credentials: 'include',
        cache: 'no-store',
        signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      });
      if (!response.ok) throw new FollowListError(`获取关注列表失败 HTTP ${response.status}`);
      json = await response.json();
    } catch (error) {
      if (error instanceof FollowListError) throw error;
      throw new FollowListError(`获取关注列表失败：${error?.message || error}`);
    }
    const result = parseFollowPage(json);
    pageCount = result.pageCount;
    for (const room of result.rooms) {
      if (seen.has(room.rid)) continue;
      seen.add(room.rid);
      rooms.push(room);
    }
  }
  return rooms;
}
