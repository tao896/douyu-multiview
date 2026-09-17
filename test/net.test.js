import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchJson, RequestError } from '../public/net.js';

test('fetchJson returns parsed JSON and maps HTTP errors', async () => {
  const ok = await fetchJson('/ok', {
    fetchImpl: async () => new Response(JSON.stringify({ value: 42 }), { status: 200 }),
  });
  assert.equal(ok.value, 42);

  await assert.rejects(
    fetchJson('/bad', {
      fetchImpl: async () => new Response(JSON.stringify({ error: '上游失败', code: -1 }), { status: 502 }),
    }),
    (error) => error instanceof RequestError && error.status === 502 && error.retryable
  );
});

test('fetchJson times out and honours caller cancellation', async () => {
  const pendingFetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
  await assert.rejects(
    fetchJson('/slow', { fetchImpl: pendingFetch, timeout: 5 }),
    (error) => error instanceof RequestError && error.code === 'TIMEOUT'
  );

  const controller = new AbortController();
  const request = fetchJson('/cancel', { fetchImpl: pendingFetch, signal: controller.signal, timeout: 1000 });
  controller.abort();
  await assert.rejects(request, (error) => error.name === 'AbortError');
});
