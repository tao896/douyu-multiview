import test from 'node:test';
import assert from 'node:assert/strict';
import { getRoomInfo, getStream, resetDouyuCachesForTest } from '../lib/douyu.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

test('room info requests are coalesced and cached for a short period', async () => {
  const originalFetch = globalThis.fetch;
  resetDouyuCachesForTest();
  let calls = 0;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/betard\/123$/);
    calls++;
    await wait(5);
    return json({ room: { room_id: 123, room_name: '测试', show_status: 1 } });
  };
  try {
    const [a, b] = await Promise.all([getRoomInfo('123'), getRoomInfo('123')]);
    assert.equal(a.title, '测试');
    assert.deepEqual(a, b);
    await getRoomInfo('123');
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    resetDouyuCachesForTest();
  }
});

test('key acquisition is coalesced and stream signing concurrency is capped at three', async () => {
  const originalFetch = globalThis.fetch;
  resetDouyuCachesForTest();
  let keyCalls = 0;
  let activeStreams = 0;
  let peakStreams = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes('getEncryption')) {
      keyCalls++;
      await wait(5);
      return json({
        error: 0,
        data: { expire_at: Math.floor(Date.now() / 1000) + 60, rand_str: 'r', key: 'k', enc_time: 1, enc_data: 'e' },
      });
    }
    if (String(url).includes('getH5PlayV1')) {
      assert.equal(options.method, 'POST');
      activeStreams++;
      peakStreams = Math.max(peakStreams, activeStreams);
      await wait(8);
      activeStreams--;
      return json({
        error: 0,
        data: { rtmp_url: 'https://stream.example', rtmp_live: 'live.flv', rate: 0, multirates: [] },
      });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  try {
    const streams = await Promise.all(Array.from({ length: 7 }, (_, index) => getStream(String(index + 1), 0)));
    assert.equal(streams.length, 7);
    assert.equal(keyCalls, 1);
    assert.equal(peakStreams, 3);
  } finally {
    globalThis.fetch = originalFetch;
    resetDouyuCachesForTest();
  }
});
