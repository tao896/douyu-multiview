import { test, expect } from '@playwright/test';

const MPEGT_STUB = `
window.mpegts = {
  Events: { ERROR: 'error', MEDIA_INFO: 'media' },
  isSupported: () => true,
  createPlayer: () => {
    const handlers = {};
    let video;
    const player = {
      attachMediaElement(element) {
        video = element;
        try { Object.defineProperty(video, 'paused', { configurable: true, get: () => false }); } catch {}
      },
      on(name, handler) { handlers[name] = handler; },
      emit(name, ...args) { handlers[name]?.(...args); },
      load() { setTimeout(() => handlers.media?.(), 0); },
      play() { return Promise.resolve(); },
      pause() {}, unload() {}, detachMediaElement() {}, destroy() {},
    };
    (window.__mpegtsPlayers ||= []).push(player);
    return player;
  },
};`;

async function mockApplication(page, { maliciousRate = false } = {}) {
  const counts = { resolve: 0, stream: 0, room: 0 };
  const rates = [
    { name: maliciousRate ? '<img src=x onerror=window.__rateXss=1>' : '原画', rate: 0, bit: 8000 },
    { name: '高清', rate: 2, bit: 2000 },
  ];
  await page.route('**/vendor/mpegts.js', (route) => route.fulfill({
    status: 200,
    contentType: 'text/javascript',
    body: MPEGT_STUB,
  }));
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const rid = url.searchParams.get('rid') || url.searchParams.get('input') || '100';
    const info = {
      rid: String(rid).replace(/\D/g, '') || '100',
      title: `测试直播间 ${rid}`,
      nickname: '测试主播',
      avatar: '',
      live: true,
      loop: false,
    };
    let body;
    if (url.pathname === '/api/resolve') {
      counts.resolve++;
      body = url.searchParams.get('infoOnly') === '1'
        ? info
        : {
            ...info,
            stream: {
              url: 'https://stream.invalid/live.flv',
              rate: 0,
              rates,
            },
          };
    } else if (url.pathname === '/api/stream') {
      counts.stream++;
      body = {
        rid: info.rid,
        stream: {
          url: 'https://stream.invalid/reload.flv',
          rate: Number(url.searchParams.get('rate')) || 0,
          rates,
        },
      };
    } else {
      counts.room++;
      body = info;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return counts;
}

async function hoverEdgeReveal(page, locator, edge) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  if (edge === 'top') {
    await page.mouse.move(box.x + box.width / 2, Math.max(1, box.y + box.height - 2));
  } else {
    await page.mouse.move(Math.max(1, box.x + box.width - 2), box.y + box.height / 2);
  }
  await expect(locator).toHaveCSS('opacity', '1');
}

// 窗口工具栏默认隐藏，操作前先把鼠标移进画面唤出上下工具栏
async function revealTileControls(tile) {
  await tile.locator('.stage').hover();
  await expect(tile).toHaveClass(/controls-visible/);
}

// 用鼠标把侧栏某一行的拖动把手拖到另一行；返回是否真正发生了位移
async function dragRoomRow(page, fromRow, toRow, { position = 'after' } = {}) {
  const handle = fromRow.locator('[data-side-drag]');
  const fromBox = await handle.boundingBox();
  const toBox = await toRow.boundingBox();
  expect(fromBox).not.toBeNull();
  expect(toBox).not.toBeNull();
  const targetY = position === 'before'
    ? toBox.y + 4
    : toBox.y + toBox.height - 4;
  await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
  await page.mouse.down();
  // 分几步移动，超过拖动阈值后再落点，模拟真实拖动
  await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2 + 12, { steps: 3 });
  await page.mouse.move(toBox.x + toBox.width / 2, targetY, { steps: 8 });
  await page.mouse.up();
}

async function roomRids(page) {
  return page.locator('#roomList .room-row').evaluateAll((rows) => rows.map((row) => row.dataset.rid));
}

test('reconnects after Early-EOF, escalates persistent buffering', async ({ page }) => {
  test.setTimeout(60_000);
  const counts = await mockApplication(page);
  await page.goto('/');
  await page.getByRole('textbox', { name: '添加直播间' }).fill('100');
  await page.getByRole('button', { name: '添加' }).click();
  await expect(page.locator('article.tile')).toBeVisible();

  await page.evaluate(() => window.__mpegtsPlayers[0].emit('error', 'NetworkError', 'UnrecoverableEarlyEof'));
  await expect.poll(() => counts.stream, { timeout: 5_000 }).toBeGreaterThan(0);
  const streamCount = counts.stream;
  await page.locator('video').evaluate((video) => {
    Object.defineProperty(video, 'readyState', { configurable: true, get: () => 4 });
    Object.defineProperty(video, 'requestVideoFrameCallback', { configurable: true, value: undefined });
    Object.defineProperty(video, 'buffered', {
      configurable: true,
      get: () => ({ length: 1, start: () => 0, end: () => video.currentTime + 9 }),
    });
  });
  // 首次持续积压只 seek；冷却后仍持续积压才重建播放器。
  await expect.poll(() => page.locator('video').evaluate(video => video.currentTime), { timeout: 12_000 }).toBeGreaterThan(0);
  expect(counts.stream).toBe(streamCount);
  await expect.poll(() => counts.stream, { timeout: 25_000 }).toBeGreaterThan(streamCount);
});

for (const bufferedEnd of [2, 12]) {
  test(`keeps the stream and audio settings after backgrounding with buffer ${bufferedEnd}s`, async ({ page }) => {
    const counts = await mockApplication(page);
    await page.goto('/');
    await page.getByRole('textbox', { name: '添加直播间' }).fill('100');
    await page.getByRole('button', { name: '添加' }).click();
    await expect(page.getByText('直播中', { exact: true })).toBeVisible();
    const streamCount = counts.stream;
    const before = await page.evaluate(() => window.__mpegtsPlayers.length);
    await page.evaluate((end) => {
      const video = document.querySelector('video');
      window.__originalVideo = video;
      video.volume = 0.37;
      video.muted = false;
      video.currentTime = 1;
      Object.defineProperty(video, 'readyState', { configurable: true, get: () => 4 });
      Object.defineProperty(video, 'buffered', {
        configurable: true, get: () => ({ length: 1, start: () => 0, end: () => end }),
      });
      let now = Date.now();
      Date.now = () => now;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
      now += 300_000;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    }, bufferedEnd);
    await expect.poll(() => page.locator('video').evaluate(v => v.currentTime)).toBe(bufferedEnd === 12 ? 11 : 1);
    expect(await page.evaluate(() => ({
      sameVideo: document.querySelector('video') === window.__originalVideo,
      players: window.__mpegtsPlayers.length,
      volume: document.querySelector('video').volume,
      muted: document.querySelector('video').muted,
      paused: document.querySelector('video').paused,
    }))).toEqual({ sameVideo: true, players: before, volume: 0.37, muted: false, paused: false });
    expect(counts.stream).toBe(streamCount);
    await expect(page.getByText('直播中', { exact: true })).toBeVisible();
  });
}

test('sound-enabled tile has a green border and only title text is linked', async ({ page }) => {
  await mockApplication(page);
  await page.goto('/');
  await page.getByRole('textbox', { name: '添加直播间' }).fill('100');
  await page.getByRole('button', { name: '添加' }).click();

  const tile = page.locator('article.tile');
  const title = page.getByRole('link', { name: /测试直播间 100/ });
  await expect(tile).not.toHaveClass(/audio-active/);
  await revealTileControls(tile);
  await expect.poll(async () => title.evaluate((link) => {
    const meta = link.parentElement;
    return link.getBoundingClientRect().width < meta.getBoundingClientRect().width;
  })).toBe(true);

  await tile.getByRole('button', { name: '静音 / 取消静音' }).click();
  await expect(tile).toHaveClass(/audio-active/);
  await expect(tile).toHaveCSS('border-color', 'rgb(43, 182, 115)');

  await revealTileControls(tile);
  await tile.getByRole('button', { name: '静音 / 取消静音' }).click();
  await expect(tile).not.toHaveClass(/audio-active/);
});

test('imports a backup as a new workspace', async ({ page }) => {
  await mockApplication(page);
  await page.goto('/');
  const backup = {
    format: 'douyu-multiview-backup',
    version: 1,
    exportedAt: '2026-01-01T00:00:00.000Z',
    state: {
      version: 3,
      activeWorkspaceId: 'imported',
      workspaces: [{
        id: 'imported', name: '赛事', cols: '2', layoutMode: 'grid', ecoMode: false,
        rooms: [{ rid: '200', title: '导入房间' }], openRids: [],
      }],
    },
  };
  await page.locator('#importFile').setInputFiles({
    name: 'backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  const dialog = page.getByRole('dialog', { name: '导入配置' });
  await expect(dialog).toContainText('1 个观看方案、1 个房间');
  await dialog.getByRole('button', { name: '导入' }).click();
  await expect(page.getByRole('combobox', { name: '当前观看方案' })).toHaveValue(/.+/);
  await expect(page.getByRole('option', { name: '赛事 导入' })).toBeAttached();
  await expect(page.getByRole('button', { name: /房间 200/ })).toBeVisible();
});

test('renders upstream quality names as text instead of HTML', async ({ page }) => {
  await mockApplication(page, { maliciousRate: true });
  await page.goto('/');
  await page.getByRole('textbox', { name: '添加直播间' }).fill('100');
  await page.getByRole('button', { name: '添加' }).click();
  await expect(page.getByRole('option', { name: '<img src=x onerror=window.__rateXss=1>' })).toHaveCount(2);
  expect(await page.evaluate(() => window.__rateXss)).toBeUndefined();
});

test('batch room management, solo audio, shortcuts and workspace cloning remain functional', async ({ page }) => {
  await mockApplication(page);
  await page.goto('/');
  await page.getByRole('textbox', { name: '添加直播间' }).fill('100 200');
  await page.getByRole('button', { name: '添加' }).click();
  await expect(page.getByRole('navigation', { name: '直播间快捷入口' }).getByRole('button', { name: /房间 100/ })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '直播间快捷入口' }).getByRole('button', { name: /房间 200/ })).toBeVisible();

  await page.getByRole('button', { name: '批量' }).click();
  await page.getByRole('button', { name: '选择已开播' }).click();
  await expect(page.getByText('已选 2 个')).toBeVisible();
  await page.getByRole('button', { name: '打开所选' }).click();
  await expect(page.locator('article.tile')).toHaveCount(2);
  await page.getByRole('button', { name: '完成' }).click();

  const secondTile = page.locator('article.tile').nth(1);
  await revealTileControls(secondTile);
  await secondTile.getByRole('button', { name: '独听', exact: true }).click();
  await expect(page.getByText('正在独听：')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('m');
  await expect(page.getByRole('button', { name: '全部静音' })).toBeVisible();

  await page.getByRole('button', { name: '复制' }).click();
  await expect(page.getByRole('option', { name: '默认方案 副本' })).toBeAttached();
  await expect(page.locator('article.tile')).toHaveCount(2);
});

test('mobile room drawer opens and closes without covering the permanent layout', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApplication(page);
  await page.goto('/');
  await expect(page.locator('body')).not.toHaveClass(/mobile-sidebar-open/);
  await page.getByRole('button', { name: '直播间', exact: true }).click();
  await expect(page.locator('body')).toHaveClass(/mobile-sidebar-open/);
  await page.getByRole('button', { name: '关闭直播间抽屉' }).click({ force: true });
  await expect(page.locator('body')).not.toHaveClass(/mobile-sidebar-open/);
});

test('focus close exits focus mode, danmaku speed persists and sidebar can be fully hidden', async ({ page }) => {
  await mockApplication(page);
  await page.goto('/');
  await page.getByRole('textbox', { name: '添加直播间' }).fill('100 200');
  await page.getByRole('button', { name: '添加' }).click();
  await page.getByRole('button', { name: '批量' }).click();
  await page.getByRole('button', { name: '选择已开播' }).click();
  await page.getByRole('button', { name: '打开所选' }).click();
  await page.getByRole('button', { name: '完成' }).click();

  const firstTile = page.locator('article.tile').first();
  await revealTileControls(firstTile);
  await firstTile.getByRole('button', { name: '设为焦点画面' }).click();
  await revealTileControls(firstTile);
  await firstTile.getByRole('button', { name: '关闭窗口' }).click();
  await expect(page.locator('#grid')).toHaveAttribute('data-layout', 'grid');
  await expect(page.locator('article.tile.focus-main')).toHaveCount(0);

  await page.getByRole('combobox', { name: '全局弹幕速度' }).selectOption('1.5');
  await expect(page.getByRole('combobox', { name: '全局弹幕速度' })).toHaveValue('1.5');

  await page.getByRole('button', { name: '完全隐藏直播间列表' }).click();
  await expect(page.locator('#workspace')).toHaveClass(/sidebar-hidden/);
  const sidebarReveal = page.getByRole('button', { name: '显示直播间列表' });
  await expect(sidebarReveal).toBeVisible();
  await expect(sidebarReveal).toHaveCSS('opacity', '0');
  await hoverEdgeReveal(page, sidebarReveal, 'left');
  await page.mouse.move(400, 400);
  await expect(sidebarReveal).toHaveCSS('opacity', '0');
  await hoverEdgeReveal(page, sidebarReveal, 'left');
  await sidebarReveal.click();
  await expect(page.locator('#workspace')).not.toHaveClass(/sidebar-hidden/);

  await page.reload();
  await expect(page.getByRole('combobox', { name: '全局弹幕速度' })).toHaveValue('1.5');
});

test('focus layout uses a 2x2 hero with right and bottom slots, and toolbar can be fully hidden', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1100 });
  await mockApplication(page);
  await page.goto('/');
  await page.getByRole('textbox', { name: '添加直播间' }).fill('101 102 103 104 105 106');
  await page.getByRole('button', { name: '添加' }).click();

  await page.getByRole('button', { name: '批量' }).click();
  await page.getByRole('button', { name: '选择已开播' }).click();
  await expect(page.getByText('已选 6 个')).toBeVisible();
  await page.getByRole('button', { name: '打开所选' }).click();
  await expect(page.locator('article.tile')).toHaveCount(6);
  await page.getByRole('button', { name: '完成' }).click();

  const tiles = page.locator('article.tile');
  await revealTileControls(tiles.first());
  await tiles.first().getByRole('button', { name: '设为焦点画面' }).click();
  await expect(page.locator('#grid')).toHaveAttribute('data-layout', 'focus');

  const boxes = await tiles.evaluateAll((nodes) => nodes.map((node) => {
    const { x, y, width, height } = node.getBoundingClientRect();
    return { x, y, width, height };
  }));
  expect(boxes[0].width).toBeGreaterThan(boxes[1].width * 1.9);
  expect(Math.abs(boxes[0].y - boxes[1].y)).toBeLessThan(2);
  expect(boxes[1].x).toBeGreaterThan(boxes[0].x + boxes[0].width);
  expect(Math.abs(boxes[1].x - boxes[2].x)).toBeLessThan(2);
  expect(boxes[2].y).toBeGreaterThan(boxes[1].y + boxes[1].height);
  expect(boxes[3].y).toBeGreaterThan(boxes[0].y + boxes[0].height);
  expect(Math.abs(boxes[3].y - boxes[4].y)).toBeLessThan(2);
  expect(Math.abs(boxes[4].y - boxes[5].y)).toBeLessThan(2);
  expect(boxes[3].x).toBeLessThan(boxes[4].x);
  expect(boxes[4].x).toBeLessThan(boxes[5].x);

  await page.getByRole('button', { name: '完全隐藏头部工具栏' }).click();
  await expect(page.locator('body')).toHaveClass(/toolbar-hidden/);
  await expect(page.locator('#topToolbar')).toBeHidden();
  const toolbarReveal = page.getByRole('button', { name: '显示头部工具栏' });
  await expect(toolbarReveal).toBeVisible();
  await expect(toolbarReveal).toHaveCSS('opacity', '0');
  await hoverEdgeReveal(page, toolbarReveal, 'top');
  await page.mouse.move(800, 550);
  await expect(toolbarReveal).toHaveCSS('opacity', '0');
  await expect(page.locator('#roomSidebar')).toHaveCSS('top', '0px');

  await page.reload();
  await expect(page.locator('body')).toHaveClass(/toolbar-hidden/);
  await expect(toolbarReveal).toHaveCSS('opacity', '0');
  await hoverEdgeReveal(page, toolbarReveal, 'top');
  await toolbarReveal.click();
  await expect(page.locator('body')).not.toHaveClass(/toolbar-hidden/);
  await expect(page.locator('#topToolbar')).toBeVisible();
});

test('reorders sidebar rooms independently of open tiles and persists after reload', async ({ page }) => {
  await mockApplication(page);
  await page.goto('/');
  await page.getByRole('textbox', { name: '添加直播间' }).fill('301 302 303 304');
  await page.getByRole('button', { name: '添加' }).click();
  const rows = page.locator('#roomList .room-row');
  await expect(rows).toHaveCount(4);
  expect(await roomRids(page)).toEqual(['301', '302', '303', '304']);

  // 打开全部窗口，验证侧栏排序不会改变画面顺序
  await page.getByRole('button', { name: '批量' }).click();
  await page.getByRole('button', { name: '选择已开播' }).click();
  await page.getByRole('button', { name: '打开所选' }).click();
  await page.getByRole('button', { name: '完成' }).click();
  await expect(page.locator('article.tile')).toHaveCount(4);
  expect(await page.locator('article.tile').evaluateAll((nodes) => nodes.map((n) => n.dataset.rid)))
    .toEqual(['301', '302', '303', '304']);

  // 把首行拖到末行之后，拖动不应误触打开房间
  await dragRoomRow(page, rows.first(), rows.last());
  await expect.poll(() => roomRids(page)).toEqual(['302', '303', '304', '301']);
  expect(await page.locator('article.tile').evaluateAll((nodes) => nodes.map((n) => n.dataset.rid)))
    .toEqual(['301', '302', '303', '304']);

  // 把末行拖回最前
  await dragRoomRow(page, page.locator('#roomList .room-row').last(), page.locator('#roomList .room-row').first(), { position: 'before' });
  await expect.poll(() => roomRids(page)).toEqual(['301', '302', '303', '304']);

  // 键盘排序同样不应改变窗口顺序，刷新后分别恢复两套顺序。
  await rows.first().locator('[data-side-drag]').press('ArrowDown');
  await expect.poll(() => roomRids(page)).toEqual(['302', '301', '303', '304']);
  expect(await page.locator('article.tile').evaluateAll((nodes) => nodes.map((n) => n.dataset.rid)))
    .toEqual(['301', '302', '303', '304']);

  await page.reload();
  await expect.poll(() => roomRids(page)).toEqual(['302', '301', '303', '304']);
  expect(await page.locator('article.tile').evaluateAll((nodes) => nodes.map((n) => n.dataset.rid)))
    .toEqual(['301', '302', '303', '304']);
});

test('dropping a dragged room on a filtered list keeps hidden rooms in relative order', async ({ page }) => {
  await mockApplication(page);
  await page.goto('/');
  await page.getByRole('textbox', { name: '添加直播间' }).fill('301 302 303 304');
  await page.getByRole('button', { name: '添加' }).click();
  await expect(page.locator('#roomList .room-row')).toHaveCount(4);

  // 搜索只保留 301、303 两行，隐藏的 302、304 必须保持相对顺序
  await page.getByRole('searchbox', { name: '搜索直播间' }).fill('30');
  await page.getByRole('combobox', { name: '筛选直播间状态' }).selectOption('all');
  await page.getByRole('searchbox', { name: '搜索直播间' }).fill('301');
  await expect(page.locator('#roomList .room-row:visible')).toHaveCount(1);
  await page.getByRole('searchbox', { name: '搜索直播间' }).fill('303');
  await expect(page.locator('#roomList .room-row:visible')).toHaveCount(1);

  // 让 301 与 303 同时可见：按房间号精确搜索不支持多值，改用全部筛选后拖到 303 之后
  await page.getByRole('searchbox', { name: '搜索直播间' }).fill('');
  await page.getByRole('combobox', { name: '筛选直播间状态' }).selectOption('all');
  const rows = page.locator('#roomList .room-row');
  await expect(rows).toHaveCount(4);

  // 拖动 301 到 303 之后：302 被夹在中间，相对顺序仍为 302 在 304 之前
  await dragRoomRow(page, rows.nth(0), rows.nth(2));
  await expect.poll(() => roomRids(page)).toEqual(['302', '303', '301', '304']);
  await page.reload();
  await expect.poll(() => roomRids(page)).toEqual(['302', '303', '301', '304']);
});

test('tile toolbars hide after one idle second or immediately on mouse leave, per window', async ({ page }) => {
  await mockApplication(page);
  await page.goto('/');
  await page.getByRole('textbox', { name: '添加直播间' }).fill('501 502');
  await page.getByRole('button', { name: '添加' }).click();
  await page.getByRole('button', { name: '批量' }).click();
  await page.getByRole('button', { name: '选择已开播' }).click();
  await page.getByRole('button', { name: '打开所选' }).click();
  await page.getByRole('button', { name: '完成' }).click();
  const tiles = page.locator('article.tile');
  await expect(tiles).toHaveCount(2);

  const first = tiles.first();
  const second = tiles.nth(1);
  await expect(first).not.toHaveClass(/controls-visible/);

  // 鼠标进入即显示
  await first.locator('.stage').hover();
  await expect(first).toHaveClass(/controls-visible/);
  // 窗口内静止 1 秒后自动隐藏，且两个窗口互不影响
  await expect(first).not.toHaveClass(/controls-visible/, { timeout: 4_000 });

  // 移动重新显示，连续操作会重新计时
  await first.locator('.stage').hover();
  await expect(first).toHaveClass(/controls-visible/);
  await page.mouse.move(0, 0);
  // 移出后立即移除显示状态，不等待原来的一秒计时器。
  expect(await first.evaluate((el) => el.classList.contains('controls-visible'))).toBe(false);

  // 点击画面唤出工具栏，鼠标留在窗口内仍按 1 秒规则隐藏
  const stageBox = await first.locator('.stage').boundingBox();
  await page.mouse.click(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2);
  await expect(first).toHaveClass(/controls-visible/);
  await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2);
  await expect(first).not.toHaveClass(/controls-visible/, { timeout: 4_000 });

  // 第二个窗口保持独立
  await second.locator('.stage').hover();
  await expect(second).toHaveClass(/controls-visible/);
  await expect(first).not.toHaveClass(/controls-visible/);
});

test('holding a tile control keeps its toolbar visible until released', async ({ page }) => {
  await mockApplication(page);
  await page.goto('/');
  await page.getByRole('textbox', { name: '添加直播间' }).fill('601');
  await page.getByRole('button', { name: '添加' }).click();
  const tile = page.locator('article.tile').first();
  await revealTileControls(tile);

  const range = tile.locator('input[type="range"]').first();
  // hover 会等待控件动画结束并稳定，避免拿到过渡途中的坐标
  await range.hover();
  await page.mouse.down();
  // 按住不放超过 2 秒，工具栏应保持显示
  await page.waitForTimeout(2_600);
  await expect(tile).toHaveClass(/controls-visible/);
  await page.mouse.up();
  // 松开后重新计时并隐藏
  await expect(tile).not.toHaveClass(/controls-visible/, { timeout: 4_000 });
});

test('hiding the focused toolbar transfers focus to a visible control', async ({ page }) => {
  const warnings = [];
  page.on('console', message => {
    if (message.text().includes('Blocked aria-hidden')) warnings.push(message.text());
  });
  await mockApplication(page);
  await page.goto('/');
  const hide = page.locator('#toolbarHideBtn');
  const reveal = page.locator('#toolbarRevealBtn');
  await hide.focus();
  await hide.press('Enter');
  await expect(reveal).toBeFocused();
  await expect(page.locator('#topToolbar')).toHaveJSProperty('inert', true);
  await reveal.press('Enter');
  await expect(hide).toBeFocused();
  await expect(page.locator('#topToolbar')).toHaveJSProperty('inert', false);
  expect(warnings).toEqual([]);
});


test('keyboard activity does not pin focused tile controls', async ({ page }) => {
  await mockApplication(page);
  await page.goto('/');
  await page.getByRole('textbox', { name: '添加直播间' }).fill('601');
  await page.getByRole('button', { name: '添加' }).click();
  const tile = page.locator('article.tile').first();
  await revealTileControls(tile);
  const range = tile.locator('input[type="range"]').first();
  await range.click();
  for (const key of ['Meta', 'ArrowLeft', 'Tab']) {
    await page.keyboard.press(key);
    await expect(tile).toHaveClass(/controls-visible/);
    await expect(tile).not.toHaveClass(/controls-visible/, { timeout: 4_000 });
  }
});

for (const failure of ['mse', 'decode']) {
  test(`reconnects after ${failure} failure despite healthy buffered playback`, async ({ page }) => {
    const counts = await mockApplication(page);
    await page.goto('/');
    await page.getByRole('textbox', { name: '添加直播间' }).fill('601');
    await page.getByRole('button', { name: '添加' }).click();
    await expect(page.locator('video')).toBeVisible();
    await page.evaluate((failure) => {
      const video = document.querySelector('video');
      Object.defineProperty(video, 'readyState', { configurable: true, get: () => 4 });
      if (failure === 'mse') {
        window.__mpegtsPlayers[0].emit('error', 'MediaError', 'MediaMSEError');
      } else {
        Object.defineProperty(video, 'error', { configurable: true, value: { code: 3, message: 'Decode failed' } });
        video.dispatchEvent(new Event('error'));
      }
      video.dispatchEvent(new Event('timeupdate'));
    }, failure);
    await expect.poll(() => counts.stream, { timeout: 5_000 }).toBe(1);
  });
}

test('filters known SourceBuffer event diagnostics but preserves unrelated errors', async ({ page }) => {
  await mockApplication(page);
  await page.goto('/');
  await page.getByRole('textbox', { name: '添加直播间' }).fill('601');
  await page.getByRole('button', { name: '添加' }).click();
  await expect.poll(() => page.evaluate(() => window.__mpegtsPlayers?.length || 0)).toBe(1);
  const errors = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.evaluate(() => {
    console.error('[MSEController] > SourceBuffer Error: [object Event]');
    console.error('unrelated diagnostic');
  });
  expect(errors).toEqual(['unrelated diagnostic']);
});

test('hides the tile when reconnect finds the stream offline (-5) while room info still says live', async ({ page }) => {
  await mockApplication(page);
  await page.goto('/');
  await page.getByRole('textbox', { name: '添加直播间' }).fill('100');
  await page.getByRole('button', { name: '添加' }).click();
  const tile = page.locator('article.tile');
  await expect(tile).toBeVisible();
  await page.locator('#hideOfflineBtn').click();
  await expect(tile).toBeVisible();

  // 刚下播：房间接口仍报开播，取流接口已返回 -5。后注册的路由优先匹配。
  await page.route('**/api/stream**', (route) => route.fulfill({
    status: 502,
    contentType: 'application/json',
    body: JSON.stringify({ error: '主播未开播', code: -5 }),
  }));
  await page.evaluate(() => window.__mpegtsPlayers[0].emit('error', 'NetworkError', 'UnrecoverableEarlyEof'));
  await expect(tile).toBeHidden({ timeout: 8_000 });
  await expect(page.locator('#emptyTitle')).toHaveText('未开播窗口已隐藏');
});

test('H.265 toggle requests hevc streams, shows the codec and persists', async ({ page }) => {
  // 测试用 Chromium 不带 HEVC 解码器，这里假装支持，只验证取流参数与界面
  await page.addInitScript(() => {
    const original = MediaSource.isTypeSupported.bind(MediaSource);
    MediaSource.isTypeSupported = (type) => /hvc1|hev1/.test(type) || original(type);
  });
  await mockApplication(page);
  const requests = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/resolve' || url.pathname === '/api/stream') {
      requests.push(`${url.pathname.slice(5)}:${url.searchParams.get('hevc') === '1' ? 'hevc' : 'avc'}`);
    }
  });
  await page.route('**/api/stream**', (route) => {
    const hevc = new URL(route.request().url()).searchParams.get('hevc') === '1';
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      rid: '100',
      stream: { url: `https://stream.invalid/${hevc ? 'hevc' : 'avc'}.flv`, codec: hevc ? 'hevc' : 'avc', rate: 0, rates: [] },
    }) });
  });
  await page.goto('/');
  await expect(page.locator('#followImportBtn')).toBeHidden(); // 网页版没有扩展后台，不能导入关注
  await page.getByRole('textbox', { name: '添加直播间' }).fill('100');
  await page.getByRole('button', { name: '添加' }).click();
  await expect(page.getByRole('link', { name: /测试直播间 100/ })).toBeVisible();

  const hevcButton = page.locator('#hevcBtn');
  await expect(hevcButton).toHaveAttribute('aria-pressed', 'false');
  await hevcButton.click();
  await expect(hevcButton).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => requests.filter((item) => item.startsWith('stream'))).toEqual(['stream:hevc']);

  await page.getByRole('button', { name: /^状态 / }).click();
  await expect(page.getByRole('dialog', { name: '连接与性能诊断' }).getByText(/H\.265/)).toBeVisible();
  await page.getByRole('button', { name: '关闭', exact: true }).click();

  await hevcButton.click();
  await expect(hevcButton).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => requests.filter((item) => item.startsWith('stream'))).toEqual(['stream:hevc', 'stream:avc']);

  await hevcButton.click();
  await expect.poll(() => requests.filter((item) => item.startsWith('stream')).length).toBe(3);
  requests.length = 0;
  await page.reload();
  await expect(hevcButton).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => requests.some((item) => item.endsWith(':hevc'))).toBe(true);
});

test('auto quality lowers secondary windows, keeps the focus window high and locks manual picks', async ({ page }) => {
  test.setTimeout(60_000);
  await mockApplication(page);
  // 每个房间最近一次 /api/stream 请求的档位
  const lastRate = {};
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/stream') lastRate[url.searchParams.get('rid')] = url.searchParams.get('rate');
  });
  await page.goto('/');
  for (const rid of ['100', '200']) {
    await page.getByRole('textbox', { name: '添加直播间' }).fill(rid);
    await page.getByRole('button', { name: '添加' }).click();
  }
  await expect(page.locator('article.tile')).toHaveCount(2);
  const [first, second] = [page.locator('article.tile[data-rid="100"]'), page.locator('article.tile[data-rid="200"]')];
  const rateOf = (tile) => tile.locator('[data-rate]');

  const button = page.locator('#autoQualityBtn');
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await expect(rateOf(first).locator('option[value="auto"]')).toHaveCount(0);
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(rateOf(first)).toHaveValue('auto');
  await expect(rateOf(first)).toHaveClass(/\brate-auto\b/);

  // 两个都不是主窗口：目标稳定 10 秒后降到较低档
  await expect.poll(() => [lastRate['100'], lastRate['200']], { timeout: 25_000 }).toEqual(['2', '2']);
  await expect(rateOf(first).locator('option[value="auto"]')).toHaveText('自动·高清');

  // 设为焦点后很快升回最高档
  await revealTileControls(first);
  await first.getByRole('button', { name: '设为焦点画面' }).click();
  await expect.poll(() => lastRate['100'], { timeout: 6_000 }).toBe('0');
  await expect(rateOf(first)).toHaveAttribute('title', /主窗口优先高清/);

  // 手动选档会锁定，刷新后仍保持
  await revealTileControls(second);
  await rateOf(second).selectOption('0');
  await expect.poll(() => lastRate['200']).toBe('0');
  await expect(rateOf(second)).toHaveValue('0');
  await expect(rateOf(second)).toHaveClass(/\brate-locked\b/);
  await expect(rateOf(second)).toHaveAttribute('title', /已锁定/);

  await page.reload();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(rateOf(second)).toHaveValue('0');
  await expect(rateOf(second)).toHaveClass(/\brate-locked\b/);

  // 批量「全部自动」解除锁定
  await page.locator('#batchRateSelect').selectOption('__auto__');
  await expect(rateOf(second)).toHaveValue('auto');
  await expect(rateOf(second)).not.toHaveClass(/\brate-locked\b/);

  // 关闭后去掉「自动」选项，各窗口保持当前档位
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await expect(rateOf(second).locator('option[value="auto"]')).toHaveCount(0);
});

// 模拟扩展页面：API 请求经 douyu-api 消息转回被 mock 的 /api，关注列表直接返回给定结果
async function stubExtensionRuntime(page, followResponse) {
  await page.addInitScript((follow) => {
    const runtime = {
      id: 'e2e-extension',
      lastError: undefined,
      sendMessage(message, callback) {
        const reply = (value) => setTimeout(() => callback?.(value), 0);
        if (message?.type === 'douyu-api') {
          fetch(message.path).then((response) => response.json())
            .then((data) => reply({ ok: true, data }), (error) => reply({ ok: false, error: String(error) }));
        } else if (message?.type === 'douyu-follow-list') {
          window.__followRequests = (window.__followRequests || 0) + 1;
          reply(follow);
        } else reply({ ok: false, error: '测试未模拟' });
      },
    };
    Object.defineProperty(window, 'chrome', { configurable: true, value: { runtime } });
  }, followResponse);
}

test('extension imports picked rooms from the Douyu follow list', async ({ page }) => {
  await stubExtensionRuntime(page, { ok: true, rooms: [
    { rid: '300', nickname: '离线主播', title: '休息中', avatar: '', live: false },
    { rid: '100', nickname: '测试主播', title: '已添加', avatar: '', live: true },
    { rid: '200', nickname: '开播主播', title: '正在直播', avatar: '', live: true },
  ] });
  await mockApplication(page);
  await page.goto('/');
  await page.getByRole('textbox', { name: '添加直播间' }).fill('100');
  await page.getByRole('button', { name: '添加' }).click();
  await expect(page.getByRole('link', { name: /测试直播间 100/ })).toBeVisible();

  await page.getByRole('button', { name: '导入关注' }).click();
  const dialog = page.getByRole('dialog', { name: '导入斗鱼关注' });
  await expect(dialog.getByRole('status')).toHaveText('共关注 3 个直播间，2 个直播中，1 个已在当前方案。');
  // 直播中的排在前面；已在方案中的不能再勾选
  await expect(dialog.locator('.follow-text strong')).toHaveText(['测试主播', '开播主播', '离线主播']);
  await expect(dialog.getByRole('checkbox').first()).toBeDisabled();
  await dialog.getByRole('button', { name: '只选直播中' }).click();
  await dialog.getByRole('button', { name: '添加 1 个' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => roomRids(page)).toEqual(['100', '200']);
  await expect(page.locator('.toast')).toContainText('已导入 1 个直播间');
});

test('follow import explains how to log in when the extension has no Douyu session', async ({ page }) => {
  await stubExtensionRuntime(page, { ok: false, error: '请先在浏览器中登录斗鱼', relogin: true });
  await mockApplication(page);
  await page.goto('/');
  await page.getByRole('button', { name: '导入关注' }).click();
  const dialog = page.getByRole('dialog', { name: '导入斗鱼关注' });
  await expect(dialog.getByRole('status')).toContainText('请先在浏览器中登录斗鱼');
  await expect(dialog.getByRole('link', { name: '打开斗鱼登录' })).toHaveAttribute('href', 'https://www.douyu.com/');
  await expect(dialog.getByRole('button', { name: '添加' })).toBeDisabled();
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(dialog).toBeHidden();
});
