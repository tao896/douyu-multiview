// 今日统计：与「斗鱼助手」油猴脚本默认数据源相同，来自第三方站 dy.roozj.com（多直播间实时流水大榜单）。
// 该站只统计收录的直播间；接口允许跨域，网页版和扩展版都直接请求。
import { fetchJson } from './net.js';

const STATS_API = 'https://dy.roozj.com/api/ranking/anchors';
export const STATS_SOURCE = 'dy.roozj.com';

// 统计日按北京时间切换
export function statsDate(now = new Date()) {
  return now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

function amount(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function normalizeRoomStats(rid, data, date) {
  const item = (Array.isArray(data?.data) ? data.data : []).find((row) => String(row?.room_id) === String(rid));
  if (!item) return null;
  return {
    rid: String(rid),
    date,
    income: amount(item.total_income),
    paid: amount(item.paid_fans),
    givers: amount(item.total_fans),
    gifts: amount(item.total_gifts),
    vipPeak: amount(item.peak_vip),
    danmaku: amount(item.danmu_count),
    danmakuUsers: amount(item.danmu_users),
    liveMins: amount(item.live_duration_mins),
    diamond: amount(item.diamond_count),
  };
}

// 返回 null 表示数据站未收录该直播间
export async function fetchRoomStats(rid, { signal, now = new Date() } = {}) {
  const date = statsDate(now);
  const params = new URLSearchParams({ startDate: date, endDate: date, clubName: 'all', search: String(rid), limit: '20' });
  const data = await fetchJson(`${STATS_API}?${params}`, { signal, timeout: 15_000 });
  if (Number(data?.code) !== 0) throw new Error(data?.msg || '数据格式异常');
  return normalizeRoomStats(rid, data, date);
}
