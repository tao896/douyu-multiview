export const STORAGE_VERSION = 3;
export const STORAGE_KEY_V1 = 'douyu-multiview-v1';
export const STORAGE_KEY_V2 = 'douyu-multiview-v2';
export const STORAGE_KEY_V3 = 'douyu-multiview-v3';
export const BACKUP_FORMAT = 'douyu-multiview-backup';
export const BACKUP_VERSION = 1;

export const ROOM_STATE_KEYS = [
  'rid',
  'title',
  'nickname',
  'avatar',
  'rate',
  'volume',
  'muted',
  'danmaku',
  'opacity',
  'expanded',
  'notifyOnLive',
];

const VALID_COLS = new Set(['auto', '1', '2', '3', '4', '5']);
const VALID_DANMAKU_SPEEDS = new Set([0.5, 0.75, 1, 1.25, 1.5, 2]);

export function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeRoomState(state = {}) {
  const out = {};
  for (const key of ROOM_STATE_KEYS) {
    if (state[key] !== undefined) out[key] = state[key];
  }
  out.rid = String(out.rid ?? '').trim();
  if (!/^\d{1,12}$/.test(out.rid)) return null;
  if (out.title !== undefined) out.title = String(out.title || '').slice(0, 300);
  if (out.nickname !== undefined) out.nickname = String(out.nickname || '').slice(0, 100);
  if (out.avatar !== undefined) out.avatar = String(out.avatar || '').slice(0, 2048);
  if (out.rate !== undefined) {
    const rate = Number(out.rate);
    out.rate = Number.isInteger(rate) && rate >= 0 && rate <= 10_000 ? rate : 0;
  }
  if (out.volume !== undefined) out.volume = Math.max(0, Math.min(100, Number(out.volume) || 0));
  if (out.opacity !== undefined) out.opacity = Math.max(0.1, Math.min(1, Number(out.opacity) || 1));
  if (out.muted !== undefined) out.muted = !!out.muted;
  if (out.danmaku !== undefined) out.danmaku = !!out.danmaku;
  if (out.expanded !== undefined) out.expanded = !!out.expanded;
  out.notifyOnLive = !!out.notifyOnLive;
  return out;
}

export function normalizeWorkspace(raw = {}, index = 0) {
  const seen = new Set();
  const rooms = [];
  for (const candidate of Array.isArray(raw.rooms) ? raw.rooms : []) {
    const room = normalizeRoomState(candidate);
    if (!room || seen.has(room.rid)) continue;
    seen.add(room.rid);
    rooms.push(room);
  }

  const openRids = [];
  const openSeen = new Set();
  for (const rid of Array.isArray(raw.openRids) ? raw.openRids : []) {
    const value = String(rid);
    if (!seen.has(value) || openSeen.has(value)) continue;
    openSeen.add(value);
    openRids.push(value);
  }

  const name = String(raw.name || '').trim().slice(0, 40) || `方案 ${index + 1}`;
  return {
    id: String(raw.id || createId()),
    name,
    cols: VALID_COLS.has(String(raw.cols)) ? String(raw.cols) : 'auto',
    sidebarCollapsedDesktop: !!raw.sidebarCollapsedDesktop,
    sidebarHiddenDesktop: !!raw.sidebarHiddenDesktop,
    toolbarHidden: !!raw.toolbarHidden,
    hideOfflineWindows: !!raw.hideOfflineWindows,
    layoutMode: raw.layoutMode === 'focus' ? 'focus' : 'grid',
    focusedRid: seen.has(String(raw.focusedRid)) ? String(raw.focusedRid) : '',
    danmakuSpeed: VALID_DANMAKU_SPEEDS.has(Number(raw.danmakuSpeed))
      ? Number(raw.danmakuSpeed)
      : 1,
    ecoMode: !!raw.ecoMode,
    rooms,
    openRids,
  };
}

export function createWorkspace(name = '默认方案', overrides = {}) {
  return normalizeWorkspace({ id: createId(), name, rooms: [], openRids: [], ...overrides });
}

export function cloneWorkspace(workspace, id = createId()) {
  return normalizeWorkspace({
    ...workspace,
    id,
    name: `${workspace.name} 副本`,
    rooms: workspace.rooms.map((room) => ({ ...room })),
    openRids: [...workspace.openRids],
  });
}

export function normalizeAppState(current, previous = null, legacy = null) {
  const candidate = [current, previous].find((value) =>
    (value?.version === STORAGE_VERSION || value?.version === 2) &&
    Array.isArray(value.workspaces) && value.workspaces.length
  );
  if (candidate) {
    const ids = new Set();
    const workspaces = candidate.workspaces.map((item, index) => {
      const workspace = normalizeWorkspace(item, index);
      if (ids.has(workspace.id)) workspace.id = createId();
      ids.add(workspace.id);
      return workspace;
    });
    const activeWorkspaceId = ids.has(String(candidate.activeWorkspaceId))
      ? String(candidate.activeWorkspaceId)
      : workspaces[0].id;
    return { version: STORAGE_VERSION, activeWorkspaceId, workspaces };
  }

  const legacyState = legacy || (previous?.version ? null : previous);
  const oldRooms = Array.isArray(legacyState?.rooms)
    ? legacyState.rooms
    : Array.isArray(legacyState?.tiles)
      ? legacyState.tiles
      : [];
  const oldOpen = Array.isArray(legacyState?.open)
    ? legacyState.open.map(String)
    : Array.isArray(legacyState?.tiles)
      ? legacyState.tiles.map((room) => String(room?.rid || ''))
      : [];
  const workspace = createWorkspace('默认方案', {
    cols: legacyState?.cols,
    sidebarCollapsedDesktop: legacyState?.sidebarCollapsed,
    rooms: oldRooms,
    openRids: oldOpen,
  });
  return {
    version: STORAGE_VERSION,
    activeWorkspaceId: workspace.id,
    workspaces: [workspace],
  };
}

export function createBackup(state, now = new Date()) {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    state: normalizeAppState(state),
  };
}

export function parseBackup(raw) {
  let backup;
  try {
    backup = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new Error('备份文件不是有效的 JSON');
  }
  if (backup?.format !== BACKUP_FORMAT || backup?.version !== BACKUP_VERSION) {
    throw new Error('不是受支持的斗鱼同屏备份文件');
  }
  if (!Array.isArray(backup?.state?.workspaces) || !backup.state.workspaces.length) {
    throw new Error('备份中没有有效的观看方案');
  }
  const rawWorkspaceCount = backup.state.workspaces.length;
  const rawRoomCount = backup.state.workspaces.reduce(
    (sum, workspace) => sum + (Array.isArray(workspace?.rooms) ? workspace.rooms.length : 0),
    0
  );
  const state = normalizeAppState(backup.state);
  const roomCount = state.workspaces.reduce((sum, workspace) => sum + workspace.rooms.length, 0);
  return {
    state,
    stats: {
      workspaceCount: state.workspaces.length,
      roomCount,
      invalidCount: Math.max(0, rawRoomCount - roomCount) +
        Math.max(0, rawWorkspaceCount - state.workspaces.length),
    },
  };
}

function importedName(name, used) {
  const base = `${String(name || '方案').slice(0, 34)} 导入`;
  let candidate = base;
  let index = 2;
  while (used.has(candidate)) candidate = `${base} ${index++}`;
  used.add(candidate);
  return candidate;
}

export function prepareImportedWorkspaces(importedState, existingNames = []) {
  const used = new Set(existingNames.map(String));
  return importedState.workspaces.map((workspace) => normalizeWorkspace({
    ...workspace,
    id: createId(),
    name: importedName(workspace.name, used),
    rooms: workspace.rooms.map((room) => ({ ...room })),
    openRids: [...workspace.openRids],
  }));
}

export function parseBatchInput(raw) {
  const parts = String(raw ?? '')
    .split(/[\s,，]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const items = [];
  const seen = new Set();
  let duplicateCount = 0;
  for (const item of parts) {
    if (seen.has(item)) {
      duplicateCount++;
      continue;
    }
    seen.add(item);
    items.push(item);
  }
  return { items, duplicateCount };
}

export async function mapWithConcurrency(items, limit, worker) {
  const source = Array.from(items || []);
  const results = new Array(source.length);
  let cursor = 0;
  const count = Math.max(1, Math.min(source.length || 1, Math.floor(limit) || 1));
  const runners = Array.from({ length: count }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= source.length) return;
      results[index] = await worker(source[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export function roomMatches(room, query, filter, isOpen = false) {
  if (filter === 'live' && room.live !== true) return false;
  if (filter === 'offline' && room.live !== false) return false;
  if (filter === 'open' && !isOpen) return false;
  const needle = String(query || '').trim().toLocaleLowerCase('zh-CN');
  if (!needle) return true;
  const state = room.s || room;
  return [state.rid, state.title, state.nickname]
    .some((value) => String(value || '').toLocaleLowerCase('zh-CN').includes(needle));
}

// 拖动排序：把 moved 插到 target 的前/后。筛选时只看得见部分房间，
// 但这里操作的是完整数组，因此未显示的房间仍保持原有相对顺序。
export function reorderRooms(rooms, moved, target, position = 'after') {
  const source = Array.from(rooms || []);
  const from = source.indexOf(moved);
  if (from < 0 || moved === target) return source;
  const next = source.filter((item) => item !== moved);
  const at = next.indexOf(target);
  if (at < 0) return source;
  next.splice(position === 'before' ? at : at + 1, 0, moved);
  return next;
}

// 指针落在行的上半还是下半，决定插到目标房间之前还是之后。
export function dropPositionForPoint(pointerY, top, height) {
  if (!(height > 0)) return 'after';
  return pointerY < top + height / 2 ? 'before' : 'after';
}

// 靠近列表上下边缘时的自动滚动速度：越靠边越快，返回 0 表示不滚动。
export function autoScrollDelta(pointerY, top, bottom, margin = 52, maxSpeed = 16) {
  const height = bottom - top;
  if (!(height > 0) || margin <= 0 || maxSpeed <= 0) return 0;
  const edge = Math.min(margin, height / 2);
  if (pointerY < top + edge) {
    const ratio = Math.min(1, (top + edge - pointerY) / edge);
    return -Math.ceil(ratio * maxSpeed);
  }
  if (pointerY > bottom - edge) {
    const ratio = Math.min(1, (pointerY - (bottom - edge)) / edge);
    return Math.ceil(ratio * maxSpeed);
  }
  return 0;
}
