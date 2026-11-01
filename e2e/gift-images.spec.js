import { test, expect } from '@playwright/test';

for (const source of ['public', 'chrome-extension', 'dist/chrome-extension']) {
  test(`${source}: missing and failed gift images remain valid after redraw`, async ({ page }) => {
    // Serve each shipped module tree, without starting players or live connections.
    const { readFile } = await import('node:fs/promises');
    await page.route('**/gift-test/**', async (route) => {
      const name = new URL(route.request().url()).pathname.split('/').pop();
      if (name === 'index.html') return route.fulfill({ contentType: 'text/html', body: '<template id="tileTpl"></template><div id="gifts"></div>' });
      if (name === 'broken.png') return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ contentType: 'text/javascript', body: await readFile(`${source}/${name}`, 'utf8') });
    });
    await page.goto('/gift-test/index.html');
    await page.evaluate(async () => {
      const { Tile } = await import('/gift-test/tile.js');
      window.tile = Object.assign(Object.create(Tile.prototype), {
        s: {}, giftsEnabled: true, $: { giftLog: document.querySelector('#gifts') },
        gifts: [
          { giftName: '探索礼包', meta: { image: '' } },
          { giftName: '星光棒', meta: { image: '/gift-test/broken.png' } },
        ],
      });
      window.tile.renderGifts();
    });
    const images = page.locator('.gift-image');
    await expect(images).toHaveCount(2);
    const valid = () => images.evaluateAll(nodes => nodes.every(n => n.complete && n.naturalWidth > 0 && n.src.startsWith('data:image/svg+xml,')));
    await expect.poll(valid).toBe(true);
    await page.evaluate(() => window.tile.renderGifts());
    await expect.poll(valid).toBe(true);
    await expect(page.locator('.gift-copy')).toHaveText(['匿名用户送出 探索礼包', '匿名用户送出 星光棒']);
  });
}

for (const source of ['public', 'chrome-extension', 'dist/chrome-extension']) {
  test(`${source}: gift updates preserve attached rows and animations`, async ({ page }) => {
    const { readFile } = await import('node:fs/promises');
    await page.route('**/gift-stability/**', async (route) => {
      const name = new URL(route.request().url()).pathname.split('/').pop();
      if (name === 'index.html') return route.fulfill({ contentType: 'text/html', body: '<link rel="stylesheet" href="style.css"><template id="tileTpl"></template><div class="gift-log" id="gifts"></div>' });
      if (name === 'gift-config.js') return route.fulfill({ contentType: 'text/javascript', body: 'export async function resolveGift(gift) { return gift; }' });
      return route.fulfill({ contentType: name.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(`${source}/${name}`, 'utf8') });
    });
    await page.goto('/gift-stability/index.html');
    await page.clock.install();
    await page.evaluate(async () => {
      const { Tile } = await import('/gift-stability/tile.js');
      window.tile = Object.assign(Object.create(Tile.prototype), {
        s: {}, giftsEnabled: true, giftNameFilter: [], giftValueFilter: null,
        giftRows: new Map(), giftExitTimers: new Map(), gifts: [],
        $: { giftLog: document.querySelector('#gifts') },
      });
      await tile.handleGift({ user: 'Alice', id: '1', giftName: '火箭', count: 1 });
      window.originalRow = document.querySelector('.gift-item');
      window.originalImage = originalRow.querySelector('.gift-image');
      window.originalAnimation = originalRow.getAnimations()[0];
      window.rowChanges = [];
      new MutationObserver(records => rowChanges.push(...records)).observe(tile.$.giftLog, { childList: true });
    });
    await page.clock.runFor(4100);
    await page.evaluate(async () => {
      await tile.handleGift({ user: 'Alice', id: '1', giftName: '火箭', count: 2 });
      tile.renderGifts();
    });
    await expect(page.locator('.gift-count')).toHaveText('×3');
    expect(await page.evaluate(() => ({
      sameRow: document.querySelector('.gift-item') === originalRow,
      sameImage: originalRow.querySelector('.gift-image') === originalImage,
      sameAnimation: originalRow.getAnimations()[0] === originalAnimation,
      mutations: rowChanges.length,
    }))).toEqual({ sameRow: true, sameImage: true, sameAnimation: true, mutations: 0 });
    const previousTop = await page.locator('.gift-item').evaluate(row => row.getBoundingClientRect().top);
    await page.evaluate(async () => {
      await tile.handleGift({ user: 'Bob', id: '2', giftName: '飞机', count: 1 });
    });
    await page.clock.runFor(300);
    await expect(page.locator('.gift-copy strong')).toHaveText(['Alice', 'Bob']);
    expect(await page.evaluate(() => ({
      attached: originalRow === document.querySelector('.gift-item'),
      sameImage: originalRow.querySelector('.gift-image') === originalImage,
      sameAnimation: originalRow.getAnimations()[0] === originalAnimation,
      removed: rowChanges.some(record => [...record.removedNodes].includes(originalRow)),
    }))).toEqual({ attached: true, sameImage: true, sameAnimation: true, removed: false });
    expect(await page.locator('.gift-item').first().evaluate(row => row.getBoundingClientRect().top)).toBeLessThan(previousTop);
    await page.evaluate(async () => {
      for (const user of ['C', 'D', 'E']) await tile.handleGift({ user, id: user, giftName: user, count: 1 });
    });
    await page.clock.runFor(300);
    await expect(page.locator('.gift-copy strong')).toHaveText(['Alice', 'Bob', 'C', 'D', 'E']);
    await page.clock.runFor(5000);
    await expect(page.locator('.gift-item')).toHaveCount(0);
  });
}

test('gift priority protects valuable gifts and fading rows never create a sixth slot', async ({ page }) => {
  const { readFile } = await import('node:fs/promises');
  await page.route('**/gift-policy/**', async route => {
    const name = new URL(route.request().url()).pathname.split('/').pop();
    if (name === 'index.html') return route.fulfill({ contentType: 'text/html', body: '<template id="tileTpl"></template><div id="one"></div><div id="two"></div>' });
    if (name === 'gift-config.js') return route.fulfill({ contentType: 'text/javascript', body: 'export async function resolveGift(gift) { return gift; }' });
    return route.fulfill({ contentType: 'text/javascript', body: await readFile(`public/${name}`, 'utf8') });
  });
  await page.goto('/gift-policy/index.html'); await page.clock.install();
  await page.evaluate(async () => {
    const { Tile } = await import('/gift-policy/tile.js');
    window.make = id => Object.assign(Object.create(Tile.prototype), { s: {}, gifts: [], giftsEnabled: true, giftNameFilter: [], giftValueFilter: null, giftRows: new Map(), giftExitTimers: new Map(), $: { giftLog: document.getElementById(id) } });
    window.a = make('one'); window.b = make('two');
    await a.handleGift({ id: 'rocket', value: 500, count: 2, durationMs: 20000 });
    for (let i = 0; i < 4; i++) await a.handleGift({ id: String(i), value: 10, durationMs: 1000 });
    await a.handleGift({ id: 'free', value: 0 });
    await b.handleGift({ id: 'independent', value: 0 });
  });
  await expect(page.locator('#one .gift-item')).toHaveCount(5);
  await expect(page.locator('#two .gift-item')).toHaveCount(1);
  expect(await page.evaluate(() => a.gifts.some(g => g.id === 'free'))).toBe(false);
  await page.clock.runFor(1000);
  await page.evaluate(async () => {
    for (let i = 0; i < 4; i++) {
      await a.handleGift({ id: `new${i}`, value: 20 });
      if (a.$.giftLog.children.length > 5) throw new Error('sixth visible row');
    }
    await a.handleGift({ id: 'bigger', value: 100 });
    if (a.$.giftLog.children.length > 5) throw new Error('sixth visible row');
  });
  await page.clock.runFor(6000);
  await expect(page.locator('#one .gift-item')).toHaveCount(1);
  await expect(page.locator('#two .gift-item')).toHaveCount(0);
  await page.clock.runFor(14000);
  await expect(page.locator('#one .gift-item')).toHaveCount(0);
});
