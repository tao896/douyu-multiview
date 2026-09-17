import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { md5 } from '../extension/md5.js';
import { handleApiPath } from '../extension/api.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('extension MD5 matches Node for ASCII, Unicode and long input', () => {
  for (const value of ['', 'abc', '斗鱼同屏', 'x'.repeat(1000)]) {
    const expected = crypto.createHash('md5').update(value, 'utf8').digest('hex');
    assert.equal(md5(value), expected);
  }
});

test('extension API rejects malformed and unknown requests before fetching', async () => {
  await assert.rejects(handleApiPath('/api/room?rid=bad'), (error) => error.status === 400);
  await assert.rejects(handleApiPath('/api/missing'), (error) => error.status === 404);
  await assert.rejects(handleApiPath('/not-api'), (error) => error.status === 400);
});

test('extension manifest uses MV3 and only packaged scripts', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'extension', 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, '1.0.1');
  assert.equal(manifest.background.type, 'module');
  assert.match(manifest.content_security_policy.extension_pages, /script-src 'self'/);
  assert.ok(manifest.host_permissions.includes('https://*.douyu.com/*'));
  assert.ok(manifest.host_permissions.includes('https://www.doseeing.com/*'));
  assert.match(manifest.content_security_policy.extension_pages, /frame-src https:\/\/www\.doseeing\.com/);
});
