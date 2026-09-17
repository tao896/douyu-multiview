import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKUP_FORMAT,
  cloneWorkspace,
  createBackup,
  mapWithConcurrency,
  moveByIndex,
  normalizeAppState,
  normalizeRoomState,
  parseBackup,
  parseBatchInput,
  prepareImportedWorkspaces,
  roomMatches,
} from '../public/state.js';

test('migrates legacy rooms, settings, layout and open order', () => {
  const state = normalizeAppState(null, {
    cols: '3',
    sidebarCollapsed: true,
    rooms: [
      { rid: 1, volume: 27, muted: false, danmaku: false },
      { rid: '1', title: 'duplicate' },
      { rid: 'bad' },
      { rid: '2', opacity: 0.5 },
    ],
    open: ['2', 'missing', '1', '2'],
  });
  const workspace = state.workspaces[0];
  assert.equal(state.version, 3);
  assert.equal(workspace.name, '默认方案');
  assert.equal(workspace.cols, '3');
  assert.equal(workspace.sidebarCollapsedDesktop, true);
  assert.equal(workspace.sidebarHiddenDesktop, false);
  assert.equal(workspace.toolbarHidden, false);
  assert.equal(workspace.hideOfflineWindows, false);
  assert.equal(workspace.danmakuSpeed, 1);
  assert.deepEqual(workspace.rooms.map((room) => room.rid), ['1', '2']);
  assert.deepEqual(workspace.openRids, ['2', '1']);
  assert.equal(workspace.rooms[0].volume, 27);
});

test('migrates v2 workspaces to v3 defaults', () => {
  const state = normalizeAppState({
    version: 2,
    activeWorkspaceId: 'old',
    workspaces: [{ id: 'old', name: '旧方案', rooms: [{ rid: '1' }], openRids: ['1'] }],
  });
  assert.equal(state.version, 3);
  assert.equal(state.workspaces[0].layoutMode, 'grid');
  assert.equal(state.workspaces[0].focusedRid, '');
  assert.equal(state.workspaces[0].ecoMode, false);
  assert.equal(state.workspaces[0].rooms[0].notifyOnLive, false);
});

test('exports, parses and prepares isolated imported workspaces', () => {
  const source = normalizeAppState({
    version: 3,
    activeWorkspaceId: 'a',
    workspaces: [{
      id: 'a', name: '比赛', layoutMode: 'focus', focusedRid: '1', danmakuSpeed: 1.5,
      sidebarHiddenDesktop: true, toolbarHidden: true, ecoMode: true, hideOfflineWindows: true,
      rooms: [{ rid: '1', notifyOnLive: true }, { rid: 'bad' }], openRids: ['1'],
    }],
  });
  const backup = createBackup(source, new Date('2026-01-02T03:04:05.000Z'));
  assert.equal(backup.format, BACKUP_FORMAT);
  const parsed = parseBackup(JSON.stringify(backup));
  assert.equal(parsed.stats.workspaceCount, 1);
  assert.equal(parsed.stats.roomCount, 1);
  assert.equal(parsed.state.workspaces[0].layoutMode, 'focus');
  assert.equal(parsed.state.workspaces[0].danmakuSpeed, 1.5);
  assert.equal(parsed.state.workspaces[0].sidebarHiddenDesktop, true);
  assert.equal(parsed.state.workspaces[0].toolbarHidden, true);
  assert.equal(parsed.state.workspaces[0].hideOfflineWindows, true);
  const imported = prepareImportedWorkspaces(parsed.state, ['比赛 导入']);
  assert.notEqual(imported[0].id, 'a');
  assert.equal(imported[0].name, '比赛 导入 2');
  assert.equal(imported[0].rooms[0].notifyOnLive, true);
  assert.equal(imported[0].hideOfflineWindows, true);
});

test('rejects malformed and unrelated backup files', () => {
  assert.throws(() => parseBackup('{'), /JSON/);
  assert.throws(() => parseBackup({ format: 'other', version: 1 }), /受支持/);
});

test('bounds imported room strings and rejects invalid rates', () => {
  const room = normalizeRoomState({
    rid: '1', title: 'x'.repeat(500), nickname: 'n'.repeat(200), avatar: 'a'.repeat(3000), rate: Infinity,
  });
  assert.equal(room.title.length, 300);
  assert.equal(room.nickname.length, 100);
  assert.equal(room.avatar.length, 2048);
  assert.equal(room.rate, 0);
});

test('normalizes corrupt v2 state and chooses a valid active workspace', () => {
  const state = normalizeAppState({
    version: 2,
    activeWorkspaceId: 'missing',
    workspaces: [
      { id: 'a', name: '', cols: '9', rooms: [{ rid: '3' }, { rid: '3' }], openRids: ['3'] },
    ],
  });
  assert.equal(state.activeWorkspaceId, 'a');
  assert.equal(state.workspaces[0].name, '方案 1');
  assert.equal(state.workspaces[0].cols, 'auto');
  assert.equal(state.workspaces[0].rooms.length, 1);
});

test('clones workspaces without sharing room or open arrays', () => {
  const source = { id: 'a', name: '比赛', cols: '2', rooms: [{ rid: '1' }], openRids: ['1'] };
  const clone = cloneWorkspace(source, 'b');
  assert.equal(clone.id, 'b');
  assert.equal(clone.name, '比赛 副本');
  clone.rooms[0].title = 'changed';
  clone.openRids.pop();
  assert.equal(source.rooms[0].title, undefined);
  assert.deepEqual(source.openRids, ['1']);
});

test('parses batch input and counts exact duplicates', () => {
  assert.deepEqual(parseBatchInput('1, 2，https://www.douyu.com/3\n1  2'), {
    items: ['1', '2', 'https://www.douyu.com/3'],
    duplicateCount: 2,
  });
});

test('limits async worker concurrency and preserves result order', async () => {
  let active = 0;
  let peak = 0;
  const result = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return value * 2;
  });
  assert.equal(peak, 2);
  assert.deepEqual(result, [2, 4, 6, 8, 10]);
});

test('filters rooms without changing source order', () => {
  const rooms = [
    { s: { rid: '1', title: '春季赛', nickname: '主播甲' }, live: true },
    { s: { rid: '2', title: '闲聊', nickname: '主播乙' }, live: false },
  ];
  assert.deepEqual(rooms.filter((room) => roomMatches(room, '甲', 'all')), [rooms[0]]);
  assert.deepEqual(rooms.filter((room) => roomMatches(room, '', 'offline')), [rooms[1]]);
  assert.deepEqual(rooms.filter((room) => roomMatches(room, '', 'open', room === rooms[1])), [rooms[1]]);
  assert.deepEqual(moveByIndex(rooms, 0, 1), [rooms[1], rooms[0]]);
  assert.deepEqual(rooms[0].s.rid, '1');
});
