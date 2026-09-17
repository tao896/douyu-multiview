import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppServer } from '../server.js';
import { resetDouyuCachesForTest } from '../lib/douyu.js';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('server returns semantic statuses and HEAD responses without bodies', async () => {
  const originalFetch = globalThis.fetch;
  resetDouyuCachesForTest();
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/betard/123')) {
      return new Response(JSON.stringify({
        room: { room_id: 123, room_name: '测试房间', nickname: '主播', show_status: 2 },
      }), { status: 200 });
    }
    throw new Error(`unexpected upstream URL ${url}`);
  };
  const server = createAppServer();
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  try {
    const bad = await originalFetch(`${base}/api/room?rid=bad`);
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, '房间号非法');

    const room = await originalFetch(`${base}/api/room?rid=123`);
    assert.equal(room.status, 200);
    assert.equal((await room.json()).title, '测试房间');

    const missingApi = await originalFetch(`${base}/api/missing`);
    assert.equal(missingApi.status, 404);

    const method = await originalFetch(`${base}/api/room?rid=123`, { method: 'POST' });
    assert.equal(method.status, 405);

    const head = await originalFetch(`${base}/`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.ok(Number(head.headers.get('content-length')) > 0);

    const missingHead = await originalFetch(`${base}/missing`, { method: 'HEAD' });
    assert.equal(missingHead.status, 404);
    assert.equal(await missingHead.text(), '');

    const malformed = await originalFetch(`${base}/%E0%A4%A`);
    assert.equal(malformed.status, 400);

    const traversal = await originalFetch(`${base}/%2e%2e/server.js`);
    assert.notEqual(traversal.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    globalThis.fetch = originalFetch;
    resetDouyuCachesForTest();
  }
});
