// 极薄后端：只做斗鱼签名取流（该接口无 CORS 头，浏览器无法直连）+ 静态文件托管
// 播放（FLV 带 access-control-allow-origin: *）与弹幕（WSS 不校验 Origin）均由前端直连
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getStream, getRoomInfo, resolveRid } from './lib/douyu.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const VENDOR = path.join(ROOT, 'node_modules', 'mpegts.js', 'dist');
const PORT = Number(process.env.PORT) || 8787;
// 默认只监听本机：服务无鉴权，不要直接暴露到公网
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

function sendJson(res, status, data, head = false) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(head ? undefined : body);
}

async function sendFile(res, file, head = false) {
  const data = head ? null : await fs.readFile(file);
  const stat = head ? await fs.stat(file) : null;
  if (stat && !stat.isFile()) {
    const error = new Error('不是文件');
    error.code = 'EISDIR';
    throw error;
  }
  const size = head ? stat.size : data.length;
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': size,
    'Cache-Control': 'no-cache',
  });
  res.end(head ? undefined : data);
}

// 限制在指定目录内，挡掉 ../ 穿越
function safeJoin(base, urlPath) {
  const target = path.join(base, path.normalize(decodeURIComponent(urlPath)));
  const rel = path.relative(base, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return target;
}

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

async function handleApi(req, res, url) {
  const head = req.method === 'HEAD';
  // 解析输入 → 房间号 + 房间信息 + 首个流地址
  if (url.pathname === '/api/resolve') {
    const rid = await resolveRid(url.searchParams.get('input'));
    const rate = parseRate(url.searchParams.get('rate'));
    const info = await getRoomInfo(rid);
    // 仅添加到侧栏时只需要房间资料和开播状态，不做取流签名。
    if (url.searchParams.get('infoOnly') === '1') return sendJson(res, 200, info, head);
    // 未开播时不取流，避免无意义的报错重试
    if (!info.live) {
      return sendJson(res, 200, { ...info, stream: null, reason: '主播未开播' }, head);
    }
    const stream = await getStream(info.rid, rate);
    return sendJson(res, 200, { ...info, stream }, head);
  }

  // 刷新流地址：wsAuth token 会过期，播放出错时重新签名
  if (url.pathname === '/api/stream') {
    const rid = parseRid(url.searchParams.get('rid'));
    const rate = parseRate(url.searchParams.get('rate'));
    return sendJson(res, 200, { rid, stream: await getStream(rid, rate) }, head);
  }

  if (url.pathname === '/api/room') {
    const rid = parseRid(url.searchParams.get('rid'));
    return sendJson(res, 200, await getRoomInfo(rid), head);
  }

  return sendJson(res, 404, { error: '接口不存在' }, head);
}

export function createAppServer() {
  return http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      return sendJson(res, 400, { error: '请求地址非法' }, req.method === 'HEAD');
    }
    const head = req.method === 'HEAD';

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: '只支持 GET' }, head);
    }

    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(req, res, url);
      } catch (e) {
        const status = Number(e.status) || 502;
        return sendJson(res, status, { error: e.message || '请求失败', code: e.code }, head);
      }
    }

    try {
      // mpegts.js 从 node_modules 直接托管，不必手动拷贝
      if (url.pathname.startsWith('/vendor/')) {
        const file = safeJoin(VENDOR, url.pathname.slice('/vendor/'.length));
        if (!file) return sendJson(res, 403, { error: '路径非法' }, head);
        return await sendFile(res, file, head);
      }
      const rel = url.pathname === '/' ? 'index.html' : url.pathname;
      const file = safeJoin(PUBLIC, rel);
      if (!file) return sendJson(res, 403, { error: '路径非法' }, head);
      return await sendFile(res, file, head);
    } catch (e) {
      if (e instanceof URIError) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(head ? undefined : '400 Bad Request');
      }
      if (e.code === 'ENOENT' || e.code === 'EISDIR') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(head ? undefined : '404 Not Found');
      }
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(head ? undefined : '500 Internal Error');
    }
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const server = createAppServer();
  server.listen(PORT, HOST, () => {
    console.log(`斗鱼多房间同屏  →  http://${HOST}:${PORT}`);
    console.log('（服务无鉴权，默认仅监听本机；如需局域网访问请设置 HOST=0.0.0.0）');
  });
}
