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
