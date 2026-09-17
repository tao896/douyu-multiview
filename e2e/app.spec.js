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

test('opens one stream, exposes focus/diagnostics, notification and backup controls', async ({ page }) => {
  const counts = await mockApplication(page);
  await page.goto('/');
  await page.getByRole('textbox', { name: '添加直播间' }).fill('100');
  await page.getByRole('button', { name: '添加' }).click();

  await expect(page.getByRole('link', { name: /测试直播间 100/ })).toBeVisible();
  await expect(page.getByText('直播中', { exact: true })).toBeVisible();
  expect(counts.resolve).toBe(2); // infoOnly + 带初始流地址的 resolve
  expect(counts.stream).toBe(0); // 首播不能紧接着重复调用 /api/stream

  await page.getByRole('button', { name: '设为焦点画面' }).click();
  await expect(page.getByRole('button', { name: '网格布局' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '取消焦点画面' }).click();
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
  await tile.hover();
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
  await secondTile.hover();
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
  await firstTile.hover();
  await firstTile.getByRole('button', { name: '设为焦点画面' }).click();
  await firstTile.hover();
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
  await tiles.first().hover();
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
