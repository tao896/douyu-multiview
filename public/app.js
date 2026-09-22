// 顶层：观看方案、房间列表、批量管理、网格布局、全局控制与持久化
import { Tile } from './tile.js';
import { fetchJson, isAbortError } from './net.js';
import { RoomStatusScheduler } from './room-scheduler.js';
import { RoomDataDialog } from './room-data.js';
import {
  STORAGE_KEY_V1,
  STORAGE_KEY_V2,
  STORAGE_KEY_V3,
  autoScrollDelta,
  cloneWorkspace,
  createBackup,
  createWorkspace,
  dropPositionForPoint,
  mapWithConcurrency,
  normalizeAppState,
  normalizeRoomState,
  parseBatchInput,
  parseBackup,
  prepareImportedWorkspaces,
  reorderRooms,
  roomMatches,
} from './state.js';

const MOBILE_QUERY = '(max-width: 700px)';

const $ = (id) => document.getElementById(id);
const grid = $('grid');
const workspaceEl = $('workspace');
const roomList = $('roomList');
const mobileMedia = matchMedia(MOBILE_QUERY);
const toolbarTooltip = $('toolbarTooltip');
let toolbarTooltipTarget = null;

function setToolbarButtonLabel(buttonOrId, label, tooltip = label) {
  const button = typeof buttonOrId === 'string' ? $(buttonOrId) : buttonOrId;
  button.setAttribute('aria-label', label);
  button.dataset.tooltip = tooltip;
  if (toolbarTooltipTarget === button && !toolbarTooltip.hidden) {
    toolbarTooltip.textContent = tooltip;
    positionToolbarTooltip(button);
  }
}

function positionToolbarTooltip(button) {
  const gap = 8;
  const edge = 8;
  const buttonRect = button.getBoundingClientRect();
  const tooltipRect = toolbarTooltip.getBoundingClientRect();
  let top = buttonRect.bottom + gap;
  if (top + tooltipRect.height > window.innerHeight - edge) top = buttonRect.top - tooltipRect.height - gap;
  const centered = buttonRect.left + (buttonRect.width - tooltipRect.width) / 2;
  const left = Math.min(Math.max(centered, edge), window.innerWidth - tooltipRect.width - edge);
  toolbarTooltip.style.left = `${Math.round(left)}px`;
  toolbarTooltip.style.top = `${Math.round(Math.max(edge, top))}px`;
}

function showToolbarTooltip(button) {
  if (!button.dataset.tooltip) return;
  toolbarTooltipTarget = button;
  toolbarTooltip.textContent = button.dataset.tooltip;
  toolbarTooltip.hidden = false;
  positionToolbarTooltip(button);
}

function hideToolbarTooltip(button) {
  if (button && toolbarTooltipTarget !== button) return;
  toolbarTooltip.hidden = true;
  toolbarTooltipTarget = null;
}

document.querySelectorAll('.toolbar-icon-btn').forEach((button) => {
  button.addEventListener('mouseenter', () => showToolbarTooltip(button));
  button.addEventListener('mouseleave', () => hideToolbarTooltip(button));
  button.addEventListener('focus', () => showToolbarTooltip(button));
  button.addEventListener('blur', () => hideToolbarTooltip(button));
});
window.addEventListener('resize', () => hideToolbarTooltip());
document.addEventListener('scroll', () => hideToolbarTooltip(), true);

// rooms 是当前方案中持久化的房间；tiles 只是当前打开的播放窗口。
const rooms = [];
const tiles = [];
const roomEntries = new Map();
const tileRooms = new Map();
let activeSidebarRoom = null;
let sidebarQuery = '';
let sidebarFilter = 'live';
let batchMode = false;
let mobileSidebarOpen = false;
let savingBlocked = false;
let dragging = null;
let roomDrag = null;
let soloTile = null;
let soloSnapshot = new Map();
let scheduler = null;
const ecoTimers = new Map();
let diagnosticsTimer = 0;
let pendingImport = null;
let hideOfflineWindows = false;
let preferredFocusRid = '';
const roomDataDialog = new RoomDataDialog($('roomDataDialog'));

function readStored(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}

const appState = normalizeAppState(
  readStored(STORAGE_KEY_V3),
  readStored(STORAGE_KEY_V2),
  readStored(STORAGE_KEY_V1)
);

function activeWorkspace() {
  return appState.workspaces.find((item) => item.id === appState.activeWorkspaceId) || appState.workspaces[0];
}

function snapshotActiveWorkspace() {
  if (savingBlocked) return;
  const current = activeWorkspace();
  current.rooms = rooms.map((room) => normalizeRoomState(room.s)).filter(Boolean);
  current.openRids = tiles.map((tile) => String(tile.s.rid));
  current.cols = grid.dataset.cols || 'auto';
  current.sidebarCollapsedDesktop = workspaceEl.classList.contains('sidebar-collapsed');
  current.sidebarHiddenDesktop = workspaceEl.classList.contains('sidebar-hidden');
  current.toolbarHidden = document.body.classList.contains('toolbar-hidden');
  current.hideOfflineWindows = hideOfflineWindows;
  current.layoutMode = grid.dataset.layout === 'focus' ? 'focus' : 'grid';
  current.layoutPreset = $('layoutPresetSelect').value;
  current.layoutRatios = (grid.dataset.ratios || '').split(',').map(Number).filter((value) => Number.isFinite(value) && value > 0);
  current.focusedRid = current.layoutMode === 'focus' ? preferredFocusRid : '';
  current.danmakuSpeed = Number($('danmakuSpeedSelect').value) || 1;
  current.ecoMode = $('ecoModeBtn').classList.contains('on');
}

let saveTimer = 0;
let storageErrorShown = false;

function writeStoredState() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  try {
    localStorage.setItem(STORAGE_KEY_V3, JSON.stringify(appState));
  } catch {
    if (!storageErrorShown) {
      storageErrorShown = true;
      toast('配置保存失败；当前修改仅在本页有效', 5000, true);
    }
  }
}

function flushSave({ snapshot = true } = {}) {
  if (savingBlocked) return;
  if (snapshot) snapshotActiveWorkspace();
  writeStoredState();
}

function save({ immediate = false } = {}) {
  if (savingBlocked) return;
  snapshotActiveWorkspace();
  if (immediate) return writeStoredState();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeStoredState, 200);
}

let toastTimer = 0;
function toast(message, duration = 3200, error = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('error', !!error);
  el.setAttribute('role', error ? 'alert' : 'status');
  el.setAttribute('aria-live', error ? 'assertive' : 'polite');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), duration);
}

// 顶栏在窄屏会换行，用实际高度保证侧栏始终贴在顶栏下方。
const bar = document.querySelector('.bar');
const syncBarHeight = () => {
  const height = document.body.classList.contains('toolbar-hidden') ? 0 : bar.offsetHeight;
  document.documentElement.style.setProperty('--bar-height', `${height}px`);
};
new ResizeObserver(syncBarHeight).observe(bar);
syncBarHeight();

function setToolbarHidden(hidden, { persist = true, focusControl = false } = {}) {
  const next = !!hidden;
  hideToolbarTooltip();
  document.body.classList.toggle('toolbar-hidden', next);
  bar.setAttribute('aria-hidden', String(next));
  bar.inert = next;
  $('toolbarHideBtn').setAttribute('aria-expanded', String(!next));
  $('toolbarRevealBtn').setAttribute('aria-expanded', String(!next));
  syncBarHeight();
  if (focusControl) requestAnimationFrame(() => $(next ? 'toolbarRevealBtn' : 'toolbarHideBtn').focus());
  if (persist) save({ immediate: true });
}

$('toolbarHideBtn').addEventListener('click', () => setToolbarHidden(true, { focusControl: true }));
$('toolbarRevealBtn').addEventListener('click', () => setToolbarHidden(false, { focusControl: true }));

function isMobile() {
  return mobileMedia.matches;
}

function setSidebarCollapsed(collapsed, { persist = true } = {}) {
  workspaceEl.classList.toggle('sidebar-collapsed', !!collapsed);
  const btn = $('sidebarToggle');
  btn.textContent = collapsed ? '›' : '‹';
  btn.title = collapsed ? '展开直播间列表' : '收起直播间列表';
  if (!isMobile()) btn.setAttribute('aria-expanded', String(!collapsed));
  if (persist) save();
}

function setSidebarHidden(hidden, { persist = true } = {}) {
  const next = !!hidden;
  const visuallyHidden = !isMobile() && next;
  workspaceEl.classList.toggle('sidebar-hidden', next);
  $('roomSidebar').setAttribute('aria-hidden', String(visuallyHidden));
  $('sidebarRevealBtn').setAttribute('aria-expanded', String(!visuallyHidden));
  if (persist) save();
}

function setMobileSidebar(open) {
  mobileSidebarOpen = isMobile() && !!open;
  document.body.classList.toggle('mobile-sidebar-open', mobileSidebarOpen);
  $('mobileRoomsBtn').setAttribute('aria-expanded', String(mobileSidebarOpen));
  $('sidebarToggle').setAttribute('aria-expanded', String(mobileSidebarOpen));
}

$('sidebarToggle').addEventListener('click', () => {
  if (isMobile()) setMobileSidebar(false);
  else setSidebarCollapsed(!workspaceEl.classList.contains('sidebar-collapsed'));
});
$('sidebarHideBtn').addEventListener('click', () => {
  if (isMobile()) setMobileSidebar(false);
  else setSidebarHidden(true);
});
$('sidebarRevealBtn').addEventListener('click', () => setSidebarHidden(false));
$('mobileRoomsBtn').addEventListener('click', () => setMobileSidebar(!mobileSidebarOpen));
$('sidebarBackdrop').addEventListener('click', () => setMobileSidebar(false));
mobileMedia.addEventListener('change', () => {
  setMobileSidebar(false);
  setSidebarHidden(activeWorkspace()?.sidebarHiddenDesktop, { persist: false });
  syncBarHeight();
});

function findRoom(rid) {
  return rooms.find((room) => String(room.s.rid) === String(rid));
}

function getOpenTile(room) {
  for (const [tile, owner] of tileRooms) if (owner === room) return tile;
  return null;
}

function isRoomVisible(room) {
  return roomMatches(room, sidebarQuery, sidebarFilter, !!getOpenTile(room));
}

function visibleRooms() {
  return rooms.filter(isRoomVisible);
}

function syncEmpty() {
  syncWindowVisibility();
  const hasRooms = rooms.length > 0;
  const hasOpenTiles = tiles.length > 0;
  const hasVisibleTiles = tiles.some((tile) => !tile.el.hidden);
  $('empty').hidden = hasVisibleTiles;
  $('roomCount').textContent = String(rooms.length);

  const visibleCount = visibleRooms().length;
  $('roomListEmpty').hidden = hasRooms && visibleCount > 0;
  if (hasRooms && visibleCount === 0) $('roomListEmpty').textContent = '没有匹配的直播间';
  else $('roomListEmpty').textContent = '添加直播间后会显示在这里';

  if (hasOpenTiles && !hasVisibleTiles) {
    $('emptyTitle').textContent = '未开播窗口已隐藏';
    $('emptyHint').textContent = `已隐藏 ${tiles.length} 个窗口，检测到开播后会自动显示回来。`;
    $('emptyDetail').textContent = '点击顶部“显示所有窗口”可立即恢复查看。';
  } else if (!hasOpenTiles && hasRooms) {
    $('emptyTitle').textContent = '暂未打开直播间';
    $('emptyHint').textContent = '点击左侧直播间即可打开观看。关闭窗口后，房间仍会保留在当前方案中。';
    $('emptyDetail').textContent = '未打开的房间只检查开播状态，不会连接视频流或弹幕。';
  } else if (!hasOpenTiles) {
    $('emptyTitle').textContent = '还没有直播间';
    $('emptyHint').innerHTML =
      '在上方粘贴斗鱼直播间地址或直接输入房间号；也可以一次粘贴多个房间。';
    $('emptyDetail').textContent =
      '可添加多个房间同屏观看，每个窗口的音量和弹幕独立控制；拖动窗口标题栏可调整顺序。';
  }
  syncGlobalControls();
}

// 隐藏只影响布局：保留窗口、排序和状态监听，开播后可以原位恢复。
function syncWindowVisibility() {
  let changed = false;
  for (const tile of tiles) {
    const hidden = hideOfflineWindows && tileRooms.get(tile)?.live === false;
    if (tile.el.hidden === hidden) continue;
    const hadFocus = tile.el.contains(document.activeElement);
    tile.el.hidden = hidden;
    if (hidden && hadFocus) $('hideOfflineBtn').focus({ preventScroll: true });
    changed = true;
  }
  if (changed) applyLayout();
}

function setHideOfflineWindows(hidden, { persist = true } = {}) {
  hideOfflineWindows = !!hidden;
  const button = $('hideOfflineBtn');
  button.classList.toggle('on', hideOfflineWindows);
  button.setAttribute('aria-pressed', String(hideOfflineWindows));
  setToolbarButtonLabel(button,
    hideOfflineWindows ? '显示所有窗口' : '隐藏未开播窗口',
    hideOfflineWindows ? '显示所有窗口（关闭自动隐藏）' : '隐藏未开播窗口，开播后自动显示'
  );
  syncEmpty();
  if (persist) save({ immediate: true });
}

$('hideOfflineBtn').addEventListener('click', () => setHideOfflineWindows(!hideOfflineWindows));

function addRoom(state, { live = null, persist = true } = {}) {
  const normalized = normalizeRoomState(state);
  if (!normalized) return null;
  const existing = findRoom(normalized.rid);
  if (existing) return existing;
  const room = {
    s: normalized,
    live: typeof live === 'boolean' ? live : null,
    checking: false,
    selected: false,
    lastCheckedAt: 0,
    nextCheckAt: 0,
    statusController: null,
    notifiedLiveCycle: false,
  };
  rooms.push(room);
  scheduler?.init(room, { immediate: live == null });
  createSidebarEntry(room);
  syncEmpty();
  if (persist) save();
  return room;
}

function handleRoomLiveTransition(room, previousLive, nextLive) {
  if (nextLive === false) room.notifiedLiveCycle = false;
  if (previousLive !== false || nextLive !== true || room.notifiedLiveCycle || !room.s.notifyOnLive) return;
  room.notifiedLiveCycle = true;
  const title = room.s.title || room.s.nickname || `房间 ${room.s.rid}`;
  toast(`${title} 已开播`);
  const extensionRuntime = globalThis.chrome?.runtime;
  if (document.hidden && extensionRuntime?.id) {
    extensionRuntime.sendMessage({
      type: 'douyu-notification',
      rid: String(room.s.rid),
      title,
    });
  } else if (document.hidden && globalThis.Notification?.permission === 'granted') {
    const notification = new Notification('斗鱼直播已开播', {
      body: `${title}（房间 ${room.s.rid}）`,
      icon: room.s.avatar || undefined,
      tag: `douyu-live-${room.s.rid}`,
    });
    notification.onclick = () => {
      window.focus();
      openRoomFromSidebar(room);
      notification.close();
    };
  }
}

async function toggleRoomNotification(room) {
  room.s.notifyOnLive = !room.s.notifyOnLive;
  // 权限弹窗可能一直等待用户操作，先保存提醒开关，避免此时刷新丢失。
  syncSidebarRoom(room);
  save({ immediate: true });
  toast(room.s.notifyOnLive ? '已开启开播提醒' : '已关闭开播提醒');
  syncExtensionReminders();
  const isExtension = !!globalThis.chrome?.runtime?.id;
  if (!isExtension && room.s.notifyOnLive && globalThis.Notification?.permission === 'default') {
    try {
      await Notification.requestPermission();
    } catch {}
  }
}

function syncExtensionReminders() {
  const runtime = globalThis.chrome?.runtime;
  if (!runtime?.id) return;
  const roomsToWatch = Object.fromEntries(rooms.filter((room) => room.s.notifyOnLive).map((room) => [String(room.s.rid), { title: room.s.title || room.s.nickname || `房间 ${room.s.rid}`, avatar: room.s.avatar || '', live: room.live === true }]));
  try { Promise.resolve(runtime.sendMessage({ type: 'douyu-sync-reminders', rooms: roomsToWatch })).catch(() => {}); } catch {}
}

function updateRoomFromInfo(room, info, { previousLive = room.live } = {}) {
  let changed = false;
  for (const key of ['rid', 'title', 'nickname', 'avatar']) {
    if (info[key] === undefined) continue;
    const next = String(info[key] || '');
    if (room.s[key] !== next) {
      room.s[key] = next;
      changed = true;
    }
  }
  if (typeof info.live === 'boolean' && room.live !== info.live) {
    room.live = info.live;
    changed = true;
  }
  handleRoomLiveTransition(room, previousLive, room.live);
  syncSidebarRoom(room);
  syncEmpty();
  scheduler?.markChecked(room);
  if (changed) save();
}

function createSidebarEntry(room) {
  const el = $('roomShortcutTpl').content.firstElementChild.cloneNode(true);
  const q = (selector) => el.querySelector(selector);
  const entry = {
    el,
    drag: q('[data-side-drag]'),
    selectWrap: q('.room-select'),
    select: q('[data-side-select]'),
    open: q('[data-side-open]'),
    remove: q('[data-side-delete]'),
    notify: q('[data-side-notify]'),
    dot: q('[data-side-dot]'),
    avatar: q('[data-side-avatar]'),
    initial: q('[data-side-initial]'),
    title: q('[data-side-title]'),
    state: q('[data-side-state]'),
    rid: q('[data-side-rid]'),
  };
  entry.avatar.addEventListener('error', () => (entry.avatar.hidden = true));
  entry.avatar.draggable = false;
  entry.open.addEventListener('click', () => openRoomFromSidebar(room));
  entry.remove.addEventListener('click', () => deleteRoom(room));
  entry.notify.addEventListener('click', () => toggleRoomNotification(room));
  // 拖动把手和头像/名称区域都能排序；提醒、删除、选择按钮不参与拖动
  entry.drag.addEventListener('pointerdown', (event) => startRoomDrag(room, event));
  entry.open.addEventListener('pointerdown', (event) => startRoomDrag(room, event));
  // 原生图片拖拽会盖住指针事件，直接禁用
  el.addEventListener('dragstart', (event) => event.preventDefault());
  // 手柄是按钮，键盘用户也能用上下方向键调整顺序
  entry.drag.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowUp') moveRoom(room, -1);
    else if (event.key === 'ArrowDown') moveRoom(room, 1);
    else return;
    event.preventDefault();
  });
  entry.select.addEventListener('change', () => {
    room.selected = entry.select.checked;
    syncBatchControls();
  });
  roomEntries.set(room, entry);
  roomList.appendChild(el);
  syncSidebarRoom(room);
}

function syncSidebarRoom(room) {
  const entry = roomEntries.get(room);
  if (!entry) return;
  const openTile = getOpenTile(room);
  const title = room.s.title || room.s.nickname || `房间 ${room.s.rid}`;
  const stateText = room.live === true ? '已开播' : room.live === false ? '未开播' : '检测中';
  const stateClass = room.live === true ? 'live' : room.live === false ? 'offline' : 'checking';
  const action = openTile ? '定位' : '打开';

  entry.el.hidden = !isRoomVisible(room);
  entry.el.dataset.rid = room.s.rid;
  entry.el.classList.toggle('open', !!openTile);
  entry.el.classList.toggle('batch-mode', batchMode);
  entry.open.classList.toggle('active', activeSidebarRoom === room);
  entry.open.dataset.live = room.live == null ? 'unknown' : String(room.live);
  entry.open.title = `${action} ${title} · ${stateText} · 房间 ${room.s.rid}`;
  entry.open.setAttribute('aria-label', `${action} ${title}，${stateText}，房间 ${room.s.rid}`);
  entry.remove.setAttribute('aria-label', `从当前方案删除 ${title}`);
  entry.drag.setAttribute('aria-label', `拖动调整 ${title} 的顺序`);
  entry.drag.title = '拖动调整顺序';
  // 提醒开关的真实状态只以 room.s.notifyOnLive 为准，按钮高亮与提示始终同步
  const notifyOn = !!room.s.notifyOnLive;
  entry.notify.classList.toggle('on', notifyOn);
  entry.notify.setAttribute('aria-pressed', String(notifyOn));
  entry.notify.title = notifyOn ? '关闭开播提醒' : '开启开播提醒';
  entry.notify.setAttribute('aria-label', `${notifyOn ? '关闭' : '开启'} ${title} 的开播提醒`);
  entry.select.setAttribute('aria-label', `选择 ${title}`);
  entry.select.checked = room.selected;
  entry.selectWrap.hidden = !batchMode;
  entry.dot.className = `status-dot ${stateClass}`;
  entry.title.textContent = title;
  entry.state.textContent = stateText;
  entry.rid.textContent = `#${room.s.rid}`;
  entry.initial.textContent = [...(room.s.nickname || title || '鱼')][0] || '鱼';

  const avatar = room.s.avatar || '';
  if (entry.avatar.dataset.src !== avatar) {
    entry.avatar.dataset.src = avatar;
    entry.avatar.hidden = !avatar;
    if (avatar) entry.avatar.src = avatar;
    else entry.avatar.removeAttribute('src');
  }
}

function syncAllSidebarRooms() {
  rooms.forEach(syncSidebarRoom);
  syncEmpty();
  syncBatchControls();
}

function revealSidebarRoom(room) {
  requestAnimationFrame(() => {
    const entry = roomEntries.get(room)?.el;
    if (!entry || entry.hidden || !roomList.clientHeight) return;
    // 只滚动房间列表，避免连带移动右侧正在观看的画面。
    const listRect = roomList.getBoundingClientRect();
    const entryRect = entry.getBoundingClientRect();
    if (entryRect.top < listRect.top) {
      roomList.scrollTop += entryRect.top - listRect.top;
    } else if (entryRect.bottom > listRect.bottom) {
      roomList.scrollTop += entryRect.bottom - listRect.bottom;
    }
  });
}

function syncRoomListOrder() {
  rooms.forEach((room) => roomList.appendChild(roomEntries.get(room).el));
  syncAllSidebarRooms();
}

function clearRoomDropMarks() {
  roomList.querySelectorAll('.drop-before, .drop-after')
    .forEach((node) => node.classList.remove('drop-before', 'drop-after'));
}

function moveRoom(room, delta) {
  const from = rooms.indexOf(room);
  const target = rooms[from + delta];
  if (from < 0 || !target) return;
  applyRoomOrder(reorderRooms(rooms, room, target, delta < 0 ? 'before' : 'after'));
}

// 排序后同时更新侧栏、已打开的窗口顺序并持久化。
function applyRoomOrder(next) {
  if (next.length !== rooms.length || next.every((room, index) => rooms[index] === room)) return;
  rooms.splice(0, rooms.length, ...next);
  syncRoomListOrder();
  syncOpenTilesToRoomOrder();
  save();
}

// —— 侧栏拖动排序 ——
// 只按当前可见行的中点判断插入位置：筛选状态下把房间放到目标房间旁边，
// 其余（含被筛掉的）房间保持原有相对顺序。
function resolveRoomDrop(clientY) {
  const visible = visibleRooms()
    .map((room) => ({ room, el: roomEntries.get(room)?.el }))
    .filter((item) => item.el && !item.el.hidden);
  if (!visible.length) return null;
  let target = visible[visible.length - 1];
  let position = 'after';
  for (const item of visible) {
    const rect = item.el.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) {
      target = item;
      position = 'before';
      break;
    }
  }
  return { target: target.room, position };
}

function showRoomDropMark(target, position) {
  clearRoomDropMarks();
  roomEntries.get(target)?.el.classList.add(position === 'before' ? 'drop-before' : 'drop-after');
}

function autoScrollRoomList() {
  if (!roomDrag) return;
  const rect = roomList.getBoundingClientRect();
  const delta = autoScrollDelta(roomDrag.y, rect.top, rect.bottom);
  if (!delta) return;
  const before = roomList.scrollTop;
  roomList.scrollTop += delta;
  return roomList.scrollTop !== before;
}

function updateRoomDrag(clientY) {
  if (!roomDrag) return;
  roomDrag.y = clientY;
  autoScrollRoomList();
  const drop = resolveRoomDrop(clientY);
  roomDrag.target = drop?.target || null;
  roomDrag.position = drop?.position || 'after';
  if (drop) showRoomDropMark(drop.target, drop.position);
  else clearRoomDropMarks();
}

function autoScrollTick() {
  if (!roomDrag) return;
  autoScrollRoomList();
  const drop = resolveRoomDrop(roomDrag.y);
  if (drop) {
    roomDrag.target = drop.target;
    roomDrag.position = drop.position;
    showRoomDropMark(drop.target, drop.position);
  }
  roomDrag.raf = requestAnimationFrame(autoScrollTick);
}

function endRoomDrag({ commit = true } = {}) {
  if (!roomDrag) return;
  cancelAnimationFrame(roomDrag.raf);
  const { room, target, position } = roomDrag;
  roomDrag = null;
  // 指针捕获由浏览器在 pointerup/pointercancel 时自动释放，无需手动 release
  document.body.classList.remove('room-dragging');
  roomEntries.get(room)?.el.classList.remove('dragging');
  clearRoomDropMarks();
  if (!commit || !target || target === room) return;
  applyRoomOrder(reorderRooms(rooms, room, target, position));
}

function startRoomDrag(room, event) {
  if (event.button !== 0 && event.pointerType === 'mouse') return;
  const entry = roomEntries.get(room);
  if (!entry || entry.el.hidden) return;
  // 这里既不 preventDefault 也不捕获指针：否则浏览器会把随后的 click 重定向到
  // 拖动把手上，行内“打开/定位”按钮永远收不到点击。只有指针真正移动超过阈值
  // 才进入拖动状态（见 beginRoomDrag），单击仍然走各自的 click 处理。
  roomDrag = {
    room,
    pointerId: event.pointerId,
    captureTarget: entry.drag,
    startX: event.clientX,
    startY: event.clientY,
    x: event.clientX,
    y: event.clientY,
    target: null,
    position: 'after',
    raf: 0,
    moved: false,
  };
}

// 指针移动超过阈值后才算拖动：此时才阻止默认行为、捕获指针并显示拖动样式。
function beginRoomDrag() {
  if (!roomDrag) return;
  const { room, pointerId, captureTarget } = roomDrag;
  roomDrag.moved = true;
  captureTarget?.setPointerCapture?.(pointerId);
  document.body.classList.add('room-dragging');
  roomEntries.get(room)?.el.classList.add('dragging');
  roomDrag.raf = requestAnimationFrame(autoScrollTick);
}

function onRoomDragMove(event) {
  if (!roomDrag || event.pointerId !== roomDrag.pointerId) return;
  if (!roomDrag.moved) {
    if (Math.hypot(event.clientX - roomDrag.startX, event.clientY - roomDrag.startY) < 4) return;
    beginRoomDrag();
  }
  event.preventDefault();
  updateRoomDrag(event.clientY);
}

function onRoomDragEnd(event) {
  if (!roomDrag || event.pointerId !== roomDrag.pointerId) return;
  const moved = roomDrag.moved;
  endRoomDrag();
  // 拖动结束后浏览器可能补发一次 click（触屏尤其明显）；吞掉紧接着的那一次，
  // 避免拖动结束时误触打开房间、提醒或删除。下一次 pointerdown 会解除标记，
  // 因此不会影响随后的正常点击。
  if (moved) suppressNextRoomClick = true;
}

// 一次真实拖动后的 click 不应触发任何行内操作（打开、提醒、删除）
let suppressNextRoomClick = false;

document.addEventListener('pointerdown', () => { suppressNextRoomClick = false; }, true);
document.addEventListener('click', (event) => {
  if (!suppressNextRoomClick) return;
  suppressNextRoomClick = false;
  if (!event.target.closest?.('.room-row')) return;
  event.stopPropagation();
  event.preventDefault();
}, true);

document.addEventListener('pointermove', onRoomDragMove, { passive: false });
document.addEventListener('pointerup', onRoomDragEnd);
document.addEventListener('pointercancel', () => endRoomDrag({ commit: false }));

function syncOpenTilesToRoomOrder() {
  const desired = rooms.map(getOpenTile).filter(Boolean);
  if (desired.length !== tiles.length || desired.every((tile, index) => tiles[index] === tile)) return;
  tiles.splice(0, tiles.length, ...desired);
  tiles.forEach((tile) => grid.appendChild(tile.el));
  tiles.forEach((tile) => tile.resume());
}

function syncRoomOrderFromTiles() {
  const openOwners = tiles.map((tile) => tileRooms.get(tile));
  let cursor = 0;
  const reordered = rooms.map((room) => (getOpenTile(room) ? openOwners[cursor++] : room));
  rooms.splice(0, rooms.length, ...reordered);
  syncRoomListOrder();
}

function copyTileSettingsToRoom(tile, room) {
  // 提醒由侧栏管理；播放器持有创建时的副本，不能反向覆盖新的开关值。
  const next = normalizeRoomState({ ...tile.s, notifyOnLive: room.s.notifyOnLive });
  if (next) {
    // 独听是瞬时状态：持久化时继续保留进入独听前的静音值。
    if (soloSnapshot.has(next.rid)) next.muted = soloSnapshot.get(next.rid);
    Object.assign(room.s, next);
  }
}

function syncRoomFromTile(tile) {
  const room = tileRooms.get(tile);
  if (!room) return;
  const previousLive = room.live;
  copyTileSettingsToRoom(tile, room);
  if (tile.live !== null) room.live = tile.live;
  handleRoomLiveTransition(room, previousLive, room.live);
  syncSidebarRoom(room);
  syncEmpty();
  scheduleEco(tile);
  save();
}

function openRoom(room, { persist = true } = {}) {
  const existing = getOpenTile(room);
  if (existing) return existing;
  if (soloTile) {
    room.s.muted = true;
    soloSnapshot.set(String(room.s.rid), true);
  }

  let tile;
  tile = new Tile(room.s, {
    onChange: () => syncRoomFromTile(tile),
    onRemove: closeTile,
    onInfo: () => syncRoomFromTile(tile),
    onSolo: () => activateSolo(tile),
    onState: (_tile, event) => {
      if (event?.message?.startsWith('画中画失败')) toast(event.message, 4200, true);
      syncGlobalControls();
      if ($('diagnosticsDialog').open) renderDiagnostics();
    },
    onVisibility: (item) => scheduleEco(item),
    onFocus: (item) => setFocusedTile(item),
    onData: () => roomDataDialog.open(tile.s),
    onRates: () => syncBatchRates(),
    onPiP: (item) => scheduleEco(item),
    danmakuConfig: activeWorkspace().danmaku,
  });
  tiles.push(tile);
  tileRooms.set(tile, room);
  tile.setDanmakuSpeed(Number($('danmakuSpeedSelect').value) || 1);
  copyTileSettingsToRoom(tile, room);
  grid.appendChild(tile.el);
  makeDraggable(tile);
  scheduler?.markChecked(room);
  applyLayout();
  syncBatchRates();
  scheduleEco(tile);
  syncSidebarRoom(room);
  syncEmpty();
  tile.load();
  if (persist) save();
  return tile;
}

function closeTile(tile, { persist = true, checkStatus = true } = {}) {
  const index = tiles.indexOf(tile);
  if (index < 0) return;
  const wasFocused = grid.dataset.layout === 'focus' &&
    (tile.el.classList.contains('focus-main') || String(tile.s.rid) === preferredFocusRid);
  const room = tileRooms.get(tile);
  if (tile === soloTile) exitSolo({ persist: false });
  if (room) copyTileSettingsToRoom(tile, room);

  tiles.splice(index, 1);
  clearTimeout(ecoTimers.get(tile));
  ecoTimers.delete(tile);
  tileRooms.delete(tile);
  clearTimeout(tile.sidebarTargetTimer);
  tile.destroy();
  soloSnapshot.delete(String(tile.s.rid));
  if (activeSidebarRoom === room) activeSidebarRoom = null;
  if (room) syncSidebarRoom(room);
  if (wasFocused) {
    // 关闭焦点窗口就是退出焦点布局，不能把焦点悄悄继承给另一个窗口。
    grid.dataset.layout = 'grid';
    applyLayout('');
  } else {
    ensureFocusedTile();
  }
  syncBatchRates();
  syncEmpty();
  if (persist) {
    save({ immediate: true });
    if (room) revealSidebarRoom(room);
  }
  if (room && checkStatus) {
    room.nextCheckAt = 0;
    scheduler?.pump();
  }
}

function deleteRoom(room, { persist = true, notify = true } = {}) {
  if (!rooms.includes(room)) return;
  const title = room.s.title || `房间 ${room.s.rid}`;
  const tile = getOpenTile(room);
  if (tile) closeTile(tile, { persist: false, checkStatus: false });
  rooms.splice(rooms.indexOf(room), 1);
  scheduler?.cancel(room);
  roomEntries.get(room)?.el.remove();
  roomEntries.delete(room);
  if (activeSidebarRoom === room) activeSidebarRoom = null;
  syncAllSidebarRooms();
  if (persist) save();
  if (notify) toast(`已从当前方案删除：${title}`);
}

function openRoomFromSidebar(room) {
  if (!rooms.includes(room)) return;
  const tile = openRoom(room);
  const previous = activeSidebarRoom;
  activeSidebarRoom = room;
  if (previous && previous !== room) syncSidebarRoom(previous);
  syncSidebarRoom(room);
  revealSidebarRoom(room);
  if (tile.el.hidden) {
    toast('此房间尚未开播，窗口将在开播后自动显示；可点击顶部“显示所有窗口”查看');
    if (isMobile()) setMobileSidebar(false);
    return;
  }
  tile.el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
  tile.el.focus({ preventScroll: true });
  tile.el.classList.remove('sidebar-target');
  requestAnimationFrame(() => tile.el.classList.add('sidebar-target'));
  clearTimeout(tile.sidebarTargetTimer);
  tile.sidebarTargetTimer = setTimeout(() => tile.el.classList.remove('sidebar-target'), 1200);
  if (isMobile()) setMobileSidebar(false);
}

// —— 独听模式 ——
function syncSoloUi() {
  const active = !!soloTile && tiles.includes(soloTile);
  $('soloBar').hidden = !active;
  $('soloLabel').textContent = active
    ? soloTile.s.title || soloTile.s.nickname || `房间 ${soloTile.s.rid}`
    : '';
  tiles.forEach((tile) => tile.setSolo(active && tile === soloTile));
  syncGlobalControls();
}

function activateSolo(tile) {
  if (!tiles.includes(tile)) return;
  if (soloTile === tile) {
    exitSolo();
    return;
  }
  if (!soloTile) {
    soloSnapshot = new Map(tiles.map((item) => [String(item.s.rid), !!item.s.muted]));
  }
  soloTile = tile;
  tiles.forEach((item) => item.setMuted(item !== tile));
  syncSoloUi();
}

function exitSolo({ restore = true, persist = true } = {}) {
  if (!soloTile && !soloSnapshot.size) return;
  const snapshot = soloSnapshot;
  soloTile = null;
  soloSnapshot = new Map();
  if (restore) {
    tiles.forEach((tile) => {
      const rid = String(tile.s.rid);
      tile.setMuted(snapshot.has(rid) ? snapshot.get(rid) : true);
    });
  }
  syncSoloUi();
  if (persist) save();
}

$('soloExitBtn').addEventListener('click', () => exitSolo());

// —— 方案管理 ——
function renderWorkspaceSelect() {
  const select = $('workspaceSelect');
  select.replaceChildren(
    ...appState.workspaces.map((item) => {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.name;
      return option;
    })
  );
  select.value = appState.activeWorkspaceId;
  $('workspaceDeleteBtn').disabled = appState.workspaces.length <= 1;
}

function clearRuntime() {
  roomDataDialog.close();
  exitSolo({ restore: false, persist: false });
  [...tiles].forEach((tile) => closeTile(tile, { persist: false, checkStatus: false }));
  rooms.forEach((room) => scheduler?.cancel(room));
  rooms.splice(0, rooms.length);
  roomEntries.clear();
  roomList.replaceChildren();
  activeSidebarRoom = null;
  sidebarQuery = '';
  sidebarFilter = 'live';
  $('roomSearch').value = '';
  $('roomFilter').value = sidebarFilter;
  setBatchMode(false);
}

function loadWorkspaceRuntime(current) {
  grid.dataset.cols = current.cols;
  grid.dataset.layout = current.layoutMode || 'grid';
  preferredFocusRid = current.focusedRid || '';
  setHideOfflineWindows(current.hideOfflineWindows, { persist: false });
  $('colsSelect').value = current.cols;
  $('layoutPresetSelect').value = current.layoutPreset || 'auto';
  grid.dataset.preset = current.layoutPreset || 'auto';
  grid.dataset.ratios = (current.layoutRatios || []).join(',');
  $('danmakuSpeedSelect').value = String(current.danmakuSpeed || 1);
  $('ecoModeBtn').classList.toggle('on', !!current.ecoMode);
  $('ecoModeBtn').setAttribute('aria-pressed', String(!!current.ecoMode));
  setToolbarHidden(current.toolbarHidden, { persist: false });
  setSidebarCollapsed(current.sidebarCollapsedDesktop, { persist: false });
  setSidebarHidden(current.sidebarHiddenDesktop, { persist: false });
  for (const state of current.rooms) addRoom(state, { persist: false });
  for (const rid of current.openRids) {
    const room = findRoom(rid);
    if (room) openRoom(room, { persist: false });
  }
  applyLayout(current.focusedRid);
  syncEcoButton();
  syncBatchRates();
  rooms.forEach((room) => {
    if (getOpenTile(room)) scheduler?.markChecked(room);
    else room.nextCheckAt = 0;
  });
  syncAllSidebarRooms();
  scheduler?.pump();
}

function switchWorkspace(id, { snapshot = true } = {}) {
  if (id === appState.activeWorkspaceId) return;
  if (snapshot) {
    snapshotActiveWorkspace();
    flushSave({ snapshot: false });
  }
  const next = appState.workspaces.find((item) => item.id === id);
  if (!next) return;

  savingBlocked = true;
  clearRuntime();
  appState.activeWorkspaceId = next.id;
  loadWorkspaceRuntime(next);
  savingBlocked = false;
  renderWorkspaceSelect();
  save();
}

function dialogResult(dialog) {
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true });
  });
}

async function confirmAction(message, { title = '请确认', confirmLabel = '确认', danger = false } = {}) {
  const dialog = $('confirmDialog');
  $('confirmTitle').textContent = title;
  $('confirmMessage').textContent = message;
  const submit = $('confirmSubmit');
  submit.textContent = confirmLabel;
  submit.classList.toggle('danger', danger);
  return (await dialogResult(dialog)) === 'confirm';
}

async function askWorkspaceName(title, value) {
  const dialog = $('workspaceNameDialog');
  $('workspaceNameTitle').textContent = title;
  const input = $('workspaceNameInput');
  input.value = value;
  const result = dialogResult(dialog);
  requestAnimationFrame(() => input.select());
  if ((await result) !== 'confirm') return null;
  const name = input.value.trim().slice(0, 40);
  if (!name) {
    toast('方案名称不能为空');
    return null;
  }
  return name;
}

$('workspaceSelect').addEventListener('change', (event) => switchWorkspace(event.target.value));
$('workspaceNewBtn').addEventListener('click', async () => {
  const name = await askWorkspaceName('新建观看方案', '新方案');
  if (!name) return;
  snapshotActiveWorkspace();
  const created = createWorkspace(name);
  appState.workspaces.push(created);
  switchWorkspace(created.id);
});
$('workspaceCloneBtn').addEventListener('click', () => {
  snapshotActiveWorkspace();
  const cloned = cloneWorkspace(activeWorkspace());
  appState.workspaces.push(cloned);
  switchWorkspace(cloned.id);
  toast(`已复制方案：${cloned.name}`);
});
$('workspaceRenameBtn').addEventListener('click', async () => {
  const current = activeWorkspace();
  const name = await askWorkspaceName('重命名观看方案', current.name);
  if (!name) return;
  current.name = name;
  renderWorkspaceSelect();
  save();
});
$('workspaceDeleteBtn').addEventListener('click', async () => {
  if (appState.workspaces.length <= 1) {
    toast('至少保留一个观看方案');
    return;
  }
  snapshotActiveWorkspace();
  const current = activeWorkspace();
  if (current.rooms.length) {
    const ok = await confirmAction(
      `“${current.name}”包含 ${current.rooms.length} 个直播间。删除后无法恢复。`,
      { title: '删除观看方案', confirmLabel: '删除方案', danger: true }
    );
    if (!ok) return;
  }
  const index = appState.workspaces.indexOf(current);
  const next = index > 0 ? appState.workspaces[index - 1] : appState.workspaces[1];
  appState.workspaces.splice(index, 1);
  appState.activeWorkspaceId = current.id;
  switchWorkspace(next.id, { snapshot: false });
  toast(`已删除方案：${current.name}`);
});

// —— 批量添加 ——
async function resolveRoomInput(input) {
  try {
    const info = await fetchJson(`/api/resolve?input=${encodeURIComponent(input)}&infoOnly=1`);
    return { input, info };
  } catch (error) {
    return { input, error: error.message || '请求失败' };
  }
}

function showBatchResult({ successCount, duplicateCount, failures }) {
  $('batchResultSummary').textContent =
    `新增 ${successCount} 个，重复 ${duplicateCount} 个，失败 ${failures.length} 个。`;
  const details = $('batchFailureDetails');
  details.hidden = failures.length === 0;
  const list = $('batchFailureList');
  list.replaceChildren(
    ...failures.map(({ input, error }) => {
      const item = document.createElement('li');
      const code = document.createElement('code');
      code.textContent = input;
      item.append(code, document.createTextNode(`：${error}`));
      return item;
    })
  );
  $('batchResultDialog').showModal();
}

$('addForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('addInput');
  const parsed = parseBatchInput(input.value);
  if (!parsed.items.length) return;
  const button = $('addBtn');
  button.disabled = true;
  try {
    const results = await mapWithConcurrency(parsed.items, 3, resolveRoomInput);
    let successCount = 0;
    let duplicateCount = parsed.duplicateCount;
    let firstRoom = null;
    const failures = [];

    for (const result of results) {
      if (result.error) {
        failures.push(result);
        continue;
      }
      let room = findRoom(result.info.rid);
      if (room) {
        duplicateCount++;
        updateRoomFromInfo(room, result.info);
      } else {
        room = addRoom(result.info, { live: result.info.live, persist: false });
        successCount++;
      }
      if (!firstRoom) firstRoom = room;
    }

    if (firstRoom) {
      openRoomFromSidebar(firstRoom);
      input.value = '';
    }
    save({ immediate: true });
    const isBatch = parsed.items.length + parsed.duplicateCount > 1;
    if (isBatch) {
      toast(`批量添加完成：新增 ${successCount}，重复 ${duplicateCount}，失败 ${failures.length}`);
      if (failures.length || duplicateCount) showBatchResult({ successCount, duplicateCount, failures });
    } else if (failures.length) {
      toast(failures[0].error);
    } else if (duplicateCount) {
      toast(`房间 ${firstRoom.s.rid} 已在当前方案中，已打开对应窗口`);
    }
  } finally {
    button.disabled = false;
  }
});

$('addInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('addForm').requestSubmit();
  }
});

// —— 搜索、筛选和批量操作 ——
function syncBatchControls() {
  const selected = rooms.filter((room) => room.selected);
  $('batchCount').textContent = String(selected.length);
  $('batchBar').querySelectorAll('[data-batch-act="open"], [data-batch-act="close"], [data-batch-act="delete"]')
    .forEach((button) => (button.disabled = selected.length === 0));
}

function setBatchMode(on) {
  batchMode = !!on;
  if (!batchMode) rooms.forEach((room) => (room.selected = false));
  $('batchBar').hidden = !batchMode;
  $('batchToggleBtn').classList.toggle('on', batchMode);
  $('batchToggleBtn').setAttribute('aria-pressed', String(batchMode));
  $('batchToggleBtn').textContent = batchMode ? '完成' : '批量';
  syncAllSidebarRooms();
}

$('roomSearch').addEventListener('input', (event) => {
  sidebarQuery = event.target.value;
  syncAllSidebarRooms();
});
$('roomFilter').addEventListener('change', (event) => {
  sidebarFilter = event.target.value;
  syncAllSidebarRooms();
});
$('batchToggleBtn').addEventListener('click', () => setBatchMode(!batchMode));
$('batchBar').addEventListener('click', async (event) => {
  const action = event.target.closest('[data-batch-act]')?.dataset.batchAct;
  if (!action) return;
  if (action === 'visible') {
    const targets = visibleRooms();
    const allSelected = targets.length && targets.every((room) => room.selected);
    targets.forEach((room) => (room.selected = !allSelected));
  } else if (action === 'live') {
    rooms.forEach((room) => (room.selected = room.live === true));
  } else {
    const selected = rooms.filter((room) => room.selected);
    if (action === 'open') selected.forEach((room) => openRoom(room, { persist: false }));
    if (action === 'close') {
      selected.map(getOpenTile).filter(Boolean)
        .forEach((tile) => closeTile(tile, { persist: false }));
    }
    if (action === 'delete') {
      if (!selected.length) return;
      const ok = await confirmAction(
        `将从当前方案删除 ${selected.length} 个直播间，并关闭其中已打开的窗口。`,
        { title: '批量删除直播间', confirmLabel: `删除 ${selected.length} 个`, danger: true }
      );
      if (!ok) return;
      selected.forEach((room) => deleteRoom(room, { persist: false, notify: false }));
      toast(`已从当前方案删除 ${selected.length} 个直播间`);
    }
    save();
  }
  syncAllSidebarRooms();
});

// —— 所有房间共用一个状态调度器，避免恢复页面时同时打满上游接口 ——
async function checkRoomStatus(room, { signal } = {}) {
  const info = await fetchJson(`/api/room?rid=${encodeURIComponent(room.s.rid)}`, { signal });
  if (!rooms.includes(room)) return;
  const previousLive = room.live;
  const tile = getOpenTile(room);
  if (tile) tile.applyRoomInfo(info);
  updateRoomFromInfo(room, info, { previousLive });
}

scheduler = new RoomStatusScheduler({
  getRooms: () => rooms,
  isOpen: (room) => !!getOpenTile(room),
  check: checkRoomStatus,
  onError: (room, error) => {
    if (!isAbortError(error)) syncSidebarRoom(room);
  },
});
scheduler.start();

// —— 布局与低负载模式 ——
function applyLayout(preferredRid = preferredFocusRid) {
  const focusMode = grid.dataset.layout === 'focus';
  const visible = tiles.filter((tile) => !tile.el.hidden);
  // 焦点暂时隐藏时借用可见窗口，恢复后仍回到用户选择的房间。
  preferredFocusRid = focusMode ? String(preferredRid || visible[0]?.s.rid || '') : '';
  const focused = focusMode
    ? visible.find((tile) => String(tile.s.rid) === preferredFocusRid) || visible[0]
    : null;
  tiles.forEach((tile) => tile.setFocused(tile === focused));
  $('layoutModeBtn').classList.toggle('on', focusMode);
  $('layoutModeBtn').setAttribute('aria-pressed', String(focusMode));
  setToolbarButtonLabel(
    'layoutModeBtn',
    focusMode ? '网格布局' : '焦点布局',
    focusMode ? '切换到网格布局' : '切换到焦点布局'
  );
}

function installLayoutDivider() {
  grid.querySelector('.layout-divider')?.remove();
  if (grid.dataset.preset !== 'free' || tiles.filter((t) => !t.el.hidden).length < 2 || matchMedia(MOBILE_QUERY).matches) return;
  const divider = document.createElement('div'); divider.className = 'layout-divider'; divider.title = '拖动调整布局比例';
  const initial = Number((grid.dataset.ratios || '1,1').split(',')[0]) || 1;
  divider.style.left = `${(initial / (initial + 1)) * 100}%`;
  grid.appendChild(divider);
  let dragging = false;
  divider.addEventListener('pointerdown', (e) => { dragging = true; divider.setPointerCapture(e.pointerId); e.preventDefault(); });
  divider.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const rect = grid.getBoundingClientRect(); const ratio = Math.max(.25, Math.min(4, (e.clientX - rect.left) / Math.max(1, rect.width - (e.clientX - rect.left))));
    grid.dataset.ratios = `${ratio},1`; grid.style.setProperty('--layout-ratios', `${ratio}fr 1fr`); divider.style.left = `${(ratio / (ratio + 1)) * 100}%`; snapshotActiveWorkspace(); save();
  });
  divider.addEventListener('pointerup', () => { dragging = false; save({ immediate: true }); });
}

function setFocusedTile(tile) {
  if (!tiles.includes(tile)) return;
  if (grid.dataset.layout === 'focus' && tile.el.classList.contains('focus-main')) {
    grid.dataset.layout = 'grid';
    applyLayout('');
    save({ immediate: true });
    return;
  }
  grid.dataset.layout = 'focus';
  applyLayout(tile.s.rid);
  save({ immediate: true });
}

function ensureFocusedTile() {
  if (grid.dataset.layout !== 'focus') return applyLayout('');
  applyLayout();
}

$('layoutModeBtn').addEventListener('click', () => {
  grid.dataset.layout = grid.dataset.layout === 'focus' ? 'grid' : 'focus';
  applyLayout();
  save({ immediate: true });
});

function ecoModeEnabled() {
  return $('ecoModeBtn').classList.contains('on');
}

function syncEcoButton() {
  const enabled = ecoModeEnabled();
  $('ecoModeBtn').setAttribute('aria-pressed', String(enabled));
  setToolbarButtonLabel(
    'ecoModeBtn',
    enabled ? '关闭低负载' : '低负载',
    enabled ? '低负载模式已开启，点击关闭' : '开启低负载模式'
  );
  tiles.forEach(scheduleEco);
}

function scheduleEco(tile) {
  if (!tile || !tiles.includes(tile)) return;
  clearTimeout(ecoTimers.get(tile));
  ecoTimers.delete(tile);
  const protectedTile = !tile.s.muted || tile === soloTile || tile.isPictureInPicture();
  const shouldSuspend = ecoModeEnabled() && !protectedTile && (document.hidden || !tile.visible);
  if (!shouldSuspend) {
    tile.resumeFromEco();
    return;
  }
  if (tile.ecoSuspended) return;
  const timer = setTimeout(() => {
    ecoTimers.delete(tile);
    const stillProtected = !tile.s.muted || tile === soloTile || tile.isPictureInPicture();
    if (ecoModeEnabled() && !stillProtected && (document.hidden || !tile.visible)) tile.suspendForEco();
  }, 30_000);
  ecoTimers.set(tile, timer);
}

$('ecoModeBtn').addEventListener('click', () => {
  $('ecoModeBtn').classList.toggle('on');
  syncEcoButton();
  save({ immediate: true });
});

// —— 批量清晰度 ——
function syncBatchRates() {
  const select = $('batchRateSelect');
  const names = [...new Set(tiles.flatMap((tile) => tile.availableRates.map((rate) => rate.name)).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  select.replaceChildren(
    Object.assign(document.createElement('option'), { value: '', textContent: '批量清晰度' }),
    ...names.map((name) => Object.assign(document.createElement('option'), { value: name, textContent: name }))
  );
  select.disabled = names.length === 0;
}

$('batchRateSelect').addEventListener('change', (event) => {
  const name = event.target.value;
  if (!name) return;
  let success = 0;
  for (const tile of tiles) if (tile.setRateByName(name)) success++;
  const skipped = tiles.length - success;
  event.target.value = '';
  toast(`已切换 ${success} 个窗口${skipped ? `，跳过 ${skipped} 个不支持窗口` : ''}`);
});

// —— 配置备份与导入 ——
function downloadBackup({ notify = true } = {}) {
  snapshotActiveWorkspace();
  const backup = createBackup(appState);
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const stamp = backup.exportedAt.slice(0, 19).replace(/[:T]/g, '-');
  link.href = url;
  link.download = `douyu-multiview-${stamp}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  if (notify) toast('配置备份已下载');
}

$('backupBtn').addEventListener('click', () => downloadBackup());
$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) return toast('备份文件超过 5MB，已拒绝导入', 4500, true);
  try {
    pendingImport = parseBackup(await file.text());
    const { workspaceCount, roomCount, invalidCount } = pendingImport.stats;
    $('importSummary').textContent =
      `检测到 ${workspaceCount} 个观看方案、${roomCount} 个房间` +
      (invalidCount ? `，将忽略 ${invalidCount} 个无效条目。` : '。');
    $('importDialog').querySelector('input[value="merge"]').checked = true;
    $('importDialog').showModal();
  } catch (error) {
    pendingImport = null;
    toast(error.message || '备份解析失败', 5000, true);
  }
});

$('importDialog').addEventListener('close', async () => {
  const dialog = $('importDialog');
  if (dialog.returnValue !== 'confirm' || !pendingImport) {
    pendingImport = null;
    return;
  }
  const mode = dialog.querySelector('input[name="importMode"]:checked')?.value || 'merge';
  const imported = prepareImportedWorkspaces(
    pendingImport.state,
    mode === 'merge' ? appState.workspaces.map((workspace) => workspace.name) : []
  );
  pendingImport = null;
  if (mode === 'replace') {
    const ok = await confirmAction(
      '将替换全部现有观看方案。系统会先自动下载当前配置备份。',
      { title: '替换全部配置', confirmLabel: '备份并替换', danger: true }
    );
    if (!ok) return;
    downloadBackup({ notify: false });
    savingBlocked = true;
    clearRuntime();
    appState.workspaces.splice(0, appState.workspaces.length, ...imported);
    appState.activeWorkspaceId = imported[0].id;
    loadWorkspaceRuntime(imported[0]);
    savingBlocked = false;
    renderWorkspaceSelect();
    save({ immediate: true });
  } else {
    snapshotActiveWorkspace();
    appState.workspaces.push(...imported);
    renderWorkspaceSelect();
    switchWorkspace(imported[0].id);
  }
  toast(`已导入 ${imported.length} 个观看方案`);
});

// —— 连接与性能诊断 ——
const STATE_LABELS = {
  loading: '缓冲中', playing: '播放中', blocked: '待播放', retrying: '重连中',
  suspended: '已暂停', offline: '未开播', error: '出错',
};

function collectDiagnostics() {
  return tiles.map((tile) => ({
    ...tile.diagnostics(),
    lastCheckedAt: tileRooms.get(tile)?.lastCheckedAt || 0,
  }));
}

function diagnosticSummary(items = collectDiagnostics()) {
  const count = (states) => items.filter((item) => states.includes(item.state)).length;
  return {
    playing: count(['playing']),
    pending: count(['loading', 'blocked', 'retrying', 'suspended']),
    offline: count(['offline']),
    error: count(['error']),
    total: items.length,
  };
}

function renderDiagnostics() {
  const items = collectDiagnostics();
  const summary = diagnosticSummary(items);
  $('diagnosticsSummary').textContent =
    `播放 ${summary.playing} · 缓冲/重连 ${summary.pending} · 未开播 ${summary.offline} · 出错 ${summary.error}`;
  $('diagnosticsList').replaceChildren(...items.map((item) => {
    const row = document.createElement('div');
    row.className = `diagnostic-row${item.state === 'error' ? ' error' : ''}`;
    const values = [
      item.title,
      STATE_LABELS[item.state] || item.state,
      item.rateName || '未知清晰度',
      item.width && item.height ? `${item.width}×${item.height}` : '分辨率未知',
      `缓冲 ${item.bufferSeconds.toFixed(1)}s · 丢帧 ${item.droppedFrames}/${item.totalFrames}`,
      item.lastCheckedAt ? `检查 ${new Date(item.lastCheckedAt).toLocaleTimeString('zh-CN')}` : '尚未检查',
    ];
    values.forEach((value, index) => {
      const node = document.createElement(index === 0 ? 'strong' : 'span');
      node.textContent = value;
      row.appendChild(node);
    });
    row.title = item.lastError || '';
    return row;
  }));
  $('retryFailedBtn').disabled = !items.some((item) => item.state === 'error');
}

function diagnosticsText() {
  const summary = diagnosticSummary();
  return [
    `斗鱼同屏诊断 ${new Date().toISOString()}`,
    `播放 ${summary.playing} / 总计 ${summary.total}，缓冲/重连 ${summary.pending}，未开播 ${summary.offline}，出错 ${summary.error}`,
    ...collectDiagnostics().map((item) =>
      `[${item.rid}] ${item.title} | ${STATE_LABELS[item.state] || item.state} | ${item.rateName || '-'} | ` +
      `${item.width || 0}x${item.height || 0} | buffer=${item.bufferSeconds.toFixed(1)}s | ` +
      `dropped=${item.droppedFrames}/${item.totalFrames} | retry=${item.retry} | ` +
      `checked=${item.lastCheckedAt ? new Date(item.lastCheckedAt).toISOString() : 'never'}` +
      (item.lastError ? ` | error=${item.lastError}` : '')
    ),
  ].join('\n');
}

function openDiagnostics() {
  renderDiagnostics();
  if (!$('diagnosticsDialog').open) $('diagnosticsDialog').showModal();
  clearInterval(diagnosticsTimer);
  diagnosticsTimer = setInterval(renderDiagnostics, 1_000);
}

$('diagnosticsBtn').addEventListener('click', openDiagnostics);
$('diagnosticsDialog').addEventListener('close', () => {
  clearInterval(diagnosticsTimer);
  diagnosticsTimer = 0;
});
$('copyDiagnosticsBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(diagnosticsText());
    toast('诊断信息已复制');
  } catch {
    toast('复制失败，请检查浏览器剪贴板权限', 4200, true);
  }
});
$('retryFailedBtn').addEventListener('click', () => {
  const failed = tiles.filter((tile) => tile.player.state === 'error');
  failed.forEach((tile) => tile.reload());
  toast(`正在重试 ${failed.length} 个失败窗口`);
  renderDiagnostics();
});

// —— 拖拽排序 ——
function makeDraggable(tile) {
  const handle = tile.el.querySelector('[data-drag-handle]');
  handle.addEventListener('mousedown', () => (tile.el.draggable = true));
  handle.addEventListener('mouseup', () => (tile.el.draggable = false));
  tile.el.addEventListener('dragstart', (event) => {
    dragging = tile;
    tile.el.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', tile.s.rid);
  });
  tile.el.addEventListener('dragend', () => {
    tile.el.classList.remove('dragging');
    tile.el.draggable = false;
    dragging = null;
    grid.querySelectorAll('.drop-target').forEach((node) => node.classList.remove('drop-target'));
    const order = [...grid.children].map((node) => node.dataset.rid);
    tiles.sort((a, b) => order.indexOf(String(a.s.rid)) - order.indexOf(String(b.s.rid)));
    syncRoomOrderFromTiles();
    tiles.forEach((item) => item.resume());
    save();
  });
  tile.el.addEventListener('dragover', (event) => {
    if (!dragging || dragging === tile) return;
    event.preventDefault();
    tile.el.classList.add('drop-target');
  });
  tile.el.addEventListener('dragleave', () => tile.el.classList.remove('drop-target'));
  tile.el.addEventListener('drop', (event) => {
    if (!dragging || dragging === tile) return;
    event.preventDefault();
    tile.el.classList.remove('drop-target');
    const nodes = [...grid.children];
    const from = nodes.indexOf(dragging.el);
    const to = nodes.indexOf(tile.el);
    grid.insertBefore(dragging.el, from < to ? tile.el.nextSibling : tile.el);
  });
}

// —— 全局控制 ——
function syncGlobalControls() {
  const hasTiles = tiles.length > 0;
  const anyAudible = tiles.some((tile) => !tile.s.muted);
  const muteLabel = !hasTiles || anyAudible ? '全部静音' : '取消静音';
  setToolbarButtonLabel('muteAllBtn', muteLabel);
  $('muteAllBtn').disabled = !hasTiles;
  $('muteAllBtn').setAttribute('aria-pressed', String(!anyAudible));
  const anyDanmaku = tiles.some((tile) => tile.s.danmaku);
  const danmakuLabel = anyDanmaku ? '弹幕全关' : '弹幕全开';
  setToolbarButtonLabel('danmakuAllBtn', danmakuLabel);
  $('danmakuAllBtn').disabled = !hasTiles;
  $('reloadAllBtn').disabled = !hasTiles;
  $('danmakuAllBtn').setAttribute('aria-pressed', String(anyDanmaku));
  const summary = diagnosticSummary();
  setToolbarButtonLabel(
    'diagnosticsBtn',
    `状态 ${summary.playing}/${summary.total}`,
    `连接与性能诊断：播放 ${summary.playing}/${summary.total}`
  );
  $('diagnosticsBtn').classList.toggle('on', summary.error > 0 || summary.pending > 0);
}

function toggleMuteAll() {
  if (soloTile) exitSolo();
  const anyAudible = tiles.some((tile) => !tile.s.muted);
  tiles.forEach((tile) => tile.setMuted(anyAudible));
  syncGlobalControls();
}

function toggleDanmakuAll() {
  const anyOn = tiles.some((tile) => tile.s.danmaku);
  tiles.forEach((tile) => tile.setDanmaku(!anyOn));
  syncGlobalControls();
}

function reloadAll() {
  tiles.forEach((tile) => tile.load());
}

$('colsSelect').addEventListener('change', (event) => {
  grid.dataset.cols = event.target.value;
  save();
});
$('layoutPresetSelect').addEventListener('change', (event) => {
  grid.dataset.preset = event.target.value;
  if (event.target.value === 'free' && !grid.dataset.ratios) grid.dataset.ratios = '1fr,1fr';
  grid.style.setProperty('--layout-ratios', (grid.dataset.ratios || '').split(',').map((x) => `${Number(x) || 1}fr`).join(' '));
  save({ immediate: true });
});
$('danmakuSpeedSelect').addEventListener('change', (event) => {
  const speed = Number(event.target.value) || 1;
  tiles.forEach((tile) => tile.setDanmakuSpeed(speed));
  save({ immediate: true });
});
$('muteAllBtn').addEventListener('click', toggleMuteAll);
$('danmakuAllBtn').addEventListener('click', toggleDanmakuAll);
$('reloadAllBtn').addEventListener('click', reloadAll);

// —— 快捷键 ——
function isEditableTarget(target) {
  return target instanceof HTMLElement &&
    (target.matches('input, textarea, select') || target.isContentEditable);
}

function closeTopDialog() {
  const open = document.querySelector('dialog[open]');
  if (!open) return false;
  open.close('cancel');
  return true;
}

document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === 'Escape') {
    if (closeTopDialog()) return;
    if (mobileSidebarOpen) {
      setMobileSidebar(false);
      return;
    }
    if (batchMode) {
      setBatchMode(false);
      return;
    }
    if (sidebarQuery) {
      sidebarQuery = '';
      $('roomSearch').value = '';
      syncAllSidebarRooms();
    }
    return;
  }
  if (isEditableTarget(event.target) || document.querySelector('dialog[open]')) return;

  const key = event.key.toLowerCase();
  if (key === 'a') $('addInput').focus();
  else if (key === '/') {
    if (isMobile()) setMobileSidebar(true);
    else if (workspaceEl.classList.contains('sidebar-hidden')) setSidebarHidden(false);
    else if (workspaceEl.classList.contains('sidebar-collapsed')) setSidebarCollapsed(false);
    $('roomSearch').focus();
  }
  else if (key === 'b') {
    if (isMobile()) setMobileSidebar(!mobileSidebarOpen);
    else if (workspaceEl.classList.contains('sidebar-hidden')) setSidebarHidden(false);
    else setSidebarCollapsed(!workspaceEl.classList.contains('sidebar-collapsed'));
  } else if (key === 't') setToolbarHidden(!document.body.classList.contains('toolbar-hidden'));
  else if (key === 'm') toggleMuteAll();
  else if (key === 'd') toggleDanmakuAll();
  else if (key === 'r') reloadAll();
  else if (event.key === '?') $('helpDialog').showModal();
  else if (/^[1-9]$/.test(event.key)) {
    const tile = tiles.filter((item) => !item.el.hidden)[Number(event.key) - 1];
    if (tile) activateSolo(tile);
  } else return;
  event.preventDefault();
});

$('helpBtn').addEventListener('click', () => $('helpDialog').showModal());

function openDanmakuSettings() {
  const cfg = activeWorkspace().danmaku || { keywords: [], enabled: true, dedupe: true, windowMs: 3000 };
  $('danmakuFilterEnabled').checked = cfg.enabled !== false;
  $('danmakuDedupeEnabled').checked = cfg.dedupe !== false;
  $('danmakuKeywords').value = (cfg.keywords || []).join('\n');
  $('danmakuDedupeWindow').value = cfg.windowMs ?? 3000;
  $('danmakuSettingsDialog').showModal();
}
$('danmakuSettingsBtn').addEventListener('click', openDanmakuSettings);
$('danmakuSettingsForm').addEventListener('submit', (event) => {
  if (event.submitter?.value === 'cancel') return;
  const cfg = activeWorkspace().danmaku = {
    enabled: $('danmakuFilterEnabled').checked,
    dedupe: $('danmakuDedupeEnabled').checked,
    keywords: $('danmakuKeywords').value.split(/[\n,，]+/).map((x) => x.trim()).filter(Boolean),
    windowMs: Math.max(0, Math.min(60000, Number($('danmakuDedupeWindow').value) || 0)),
  };
  tiles.forEach((tile) => tile.danmakuFilter?.configure(cfg));
  save({ immediate: true });
});

// —— 启动与恢复 ——
renderWorkspaceSelect();
savingBlocked = true;
loadWorkspaceRuntime(activeWorkspace());
syncExtensionReminders();
const requestedRoom = new URLSearchParams(location.search).get('room');
if (requestedRoom) {
  const requested = findRoom(requestedRoom);
  if (requested) openRoom(requested);
}
savingBlocked = false;
setMobileSidebar(false);
syncEmpty();
save();

function refreshRoomStates() {
  scheduler.refresh();
}

document.addEventListener('visibilitychange', () => {
  tiles.forEach((tile) => tile.setPageVisible(!document.hidden));
  tiles.forEach(scheduleEco);
  if (!document.hidden) refreshRoomStates();
});
window.addEventListener('online', () => {
  tiles.forEach((tile) => tile.setOnline(true));
  refreshRoomStates();
});
window.addEventListener('offline', () => tiles.forEach((tile) => tile.setOnline(false)));
window.addEventListener('pagehide', () => flushSave());
