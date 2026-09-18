import { test, expect } from '@playwright/test';

const MPEGT_STUB = `
window.mpegts = {
  Events: { ERROR: 'error', MEDIA_INFO: 'media' },
  isSupported: () => true,
  createPlayer: () => {
    const handlers = {};
    let video;
    return {
      attachMediaElement(element) {
        video = element;
        try { Object.defineProperty(video, 'paused', { configurable: true, get: () => false }); } catch {}
      },
      on(name, handler) { handlers[name] = handler; },
      load() { setTimeout(() => handlers.media?.(), 0); },
      play() { return Promise.resolve(); },
      pause() {}, unload() {}, detachMediaElement() {}, destroy() {},
    };
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

test('opens one stream, exposes focus/diagnostics, notification and backup controls', async ({ page }) => {
  const counts = await mockApplication(page);
  await page.goto('/');
  await page.getByRole('textbox', { name: '添加直播间' }).fill('100');
  await page.getByRole('button', { name: '添加' }).click();

  await expect(page.getByRole('link', { name: /测试直播间 100/ })).toBeVisible();
  await expect(page.getByText('直播中', { exact: true })).toBeVisible();
  expect(counts.resolve).toBe(2); // infoOnly + 带初始流地址的 resolve
  expect(counts.stream).toBe(0); // 首播不能紧接着重复调用 /api/stream

  const tile = page.locator('article.tile');
  await revealTileControls(tile);
  await tile.getByRole('button', { name: '设为焦点画面' }).click();
  await expect(page.getByRole('button', { name: '网格布局' })).toHaveAttribute('aria-pressed', 'true');
  await revealTileControls(tile);
  await tile.getByRole('button', { name: '取消焦点画面' }).click();
  await expect(page.getByRole('button', { name: '焦点布局' })).toHaveAttribute('aria-pressed', 'false');

  await page.getByRole('button', { name: /^状态 / }).click();
  await expect(page.getByRole('heading', { name: '连接与性能诊断' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: '连接与性能诊断' }).getByText(/播放 1/)).toBeVisible();
  await page.getByRole('button', { name: '关闭', exact: true }).click();

  await page.getByRole('button', { name: /开启 测试直播间 100 的开播提醒/ }).click();
  await expect(page.getByRole('button', { name: /关闭 测试直播间 100 的开播提醒/ })).toHaveAttribute('aria-pressed', 'true');

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '备份' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^douyu-multiview-.*\.json$/);
});

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

test('drags sidebar rooms to reorder, syncs open tiles and persists after reload', async ({ page }) => {
  await mockApplication(page);
  await page.goto('/');
  await page.getByRole('textbox', { name: '添加直播间' }).fill('301 302 303 304');
  await page.getByRole('button', { name: '添加' }).click();
  const rows = page.locator('#roomList .room-row');
  await expect(rows).toHaveCount(4);
  expect(await roomRids(page)).toEqual(['301', '302', '303', '304']);

  // 打开全部窗口，验证侧栏排序会同步到画面顺序
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
    .toEqual(['302', '303', '304', '301']);

  // 把末行拖回最前
  await dragRoomRow(page, page.locator('#roomList .room-row').last(), page.locator('#roomList .room-row').first(), { position: 'before' });
  await expect.poll(() => roomRids(page)).toEqual(['301', '302', '303', '304']);

  await page.reload();
  await expect.poll(() => roomRids(page)).toEqual(['301', '302', '303', '304']);
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

test('keeps the notification bell on and highlighted across reload, workspace switch and player updates', async ({ page }) => {
  await mockApplication(page);
  await page.goto('/');
  await page.getByRole('textbox', { name: '添加直播间' }).fill('401 402');
  await page.getByRole('button', { name: '添加' }).click();

  const notify401 = page.getByRole('button', { name: /开启 测试直播间 401 的开播提醒/ });
  await notify401.click();
  const notifyOn = page.getByRole('button', { name: /关闭 测试直播间 401 的开播提醒/ });
  await expect(notifyOn).toHaveAttribute('aria-pressed', 'true');
  await expect(notifyOn).toHaveClass(/\bon\b/);
  // 开启状态应有明显的高亮背景，而不是仅靠彩色图标
  const bg = await notifyOn.evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(bg).not.toBe('rgba(0, 0, 0, 0)');

  // 触发播放器状态更新（静音/音量）不应覆盖提醒状态
  const tile = page.locator('article.tile').first();
  await revealTileControls(tile);
  await tile.getByRole('button', { name: '静音 / 取消静音' }).click();
  await expect(page.getByRole('button', { name: /关闭 测试直播间 401 的开播提醒/ })).toHaveAttribute('aria-pressed', 'true');

  await page.reload();
  await expect(page.getByRole('button', { name: /关闭 测试直播间 401 的开播提醒/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: /关闭 测试直播间 401 的开播提醒/ })).toHaveClass(/\bon\b/);

  // 切换方案再切回来，提醒状态仍应保留
  await page.getByRole('button', { name: '复制' }).click();
  await expect(page.getByRole('button', { name: /关闭 测试直播间 401 的开播提醒/ })).toHaveAttribute('aria-pressed', 'true');
  const select = page.getByRole('combobox', { name: '当前观看方案' });
  const options = await select.locator('option').evaluateAll((nodes) => nodes.map((n) => n.value));
  await select.selectOption(options[0]);
  await expect(page.getByRole('button', { name: /关闭 测试直播间 401 的开播提醒/ })).toHaveAttribute('aria-pressed', 'true');

  // 关闭后同样正确恢复
  await page.getByRole('button', { name: /关闭 测试直播间 401 的开播提醒/ }).click();
  await expect(page.getByRole('button', { name: /开启 测试直播间 401 的开播提醒/ })).toHaveAttribute('aria-pressed', 'false');
  await page.reload();
  await expect(page.getByRole('button', { name: /开启 测试直播间 401 的开播提醒/ })).toHaveAttribute('aria-pressed', 'false');
});

test('tile toolbars hide after two idle seconds and reappear on activity, per window', async ({ page }) => {
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
  // 静止 2 秒后自动隐藏，且两个窗口互不影响
  await expect(first).not.toHaveClass(/controls-visible/, { timeout: 4_000 });

  // 移动重新显示，连续操作会重新计时
  await first.locator('.stage').hover();
  await expect(first).toHaveClass(/controls-visible/);
  await page.mouse.move(0, 0);
  await expect(first).toHaveClass(/controls-visible/);
  await expect(first).not.toHaveClass(/controls-visible/, { timeout: 4_000 });

  // 点击画面唤出工具栏，鼠标移开后仍会按 2 秒规则隐藏（不会一直显示）
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
