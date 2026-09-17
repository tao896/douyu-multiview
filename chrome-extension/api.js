import { getRoomInfo, getStream, resolveRid } from './douyu.js';

function parseRid(value) {
  const rid = String(value || '');
  if (!/^\d{1,12}$/.test(rid)) {
    const error = new Error('房间号非法');
    error.status = 400;
    throw error;
  }
  return rid;
}

function parseRate(value) {
  if (value == null || value === '') return 0;
  const rate = Number(value);
  if (!Number.isInteger(rate) || rate < 0 || rate > 10_000) {
    const error = new Error('清晰度参数非法');
    error.status = 400;
    throw error;
  }
  return rate;
}

export async function handleApiPath(path) {
  const url = new URL(String(path || ''), 'https://extension.invalid');
  if (!url.pathname.startsWith('/api/')) {
    const error = new Error('请求地址非法');
    error.status = 400;
    throw error;
  }

  if (url.pathname === '/api/resolve') {
    const rid = await resolveRid(url.searchParams.get('input'));
    const rate = parseRate(url.searchParams.get('rate'));
    const info = await getRoomInfo(rid);
    if (url.searchParams.get('infoOnly') === '1') return info;
    if (!info.live) return { ...info, stream: null, reason: '主播未开播' };
    return { ...info, stream: await getStream(info.rid, rate) };
  }

  if (url.pathname === '/api/stream') {
    const rid = parseRid(url.searchParams.get('rid'));
    const rate = parseRate(url.searchParams.get('rate'));
    return { rid, stream: await getStream(rid, rate) };
  }

  if (url.pathname === '/api/room') {
    return getRoomInfo(parseRid(url.searchParams.get('rid')));
  }

  const error = new Error('接口不存在');
  error.status = 404;
  throw error;
}
