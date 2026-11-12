// 顶层：观看方案、房间列表、批量管理、网格布局、全局控制与持久化。
// 相对独立的界面拆在各自模块里，这里负责共享状态和把它们接起来。
import { bindQuickSearch } from './quick-search.js';
import { ChatPanel } from './chat-panel.js';
import { Tile } from './tile.js';
import { hevcPlaybackSupported } from './player.js';
import { createAutoQualityController } from './auto-quality.js';
import { fetchJson, isAbortError } from './net.js';
import { RoomStatusScheduler } from './room-scheduler.js';
import { installRoomDrag } from './room-drag.js';
import { createRoomSidebar } from './room-sidebar.js';
import { makeTileDraggable } from './tile-drag.js';
import { diagnosticSummary } from './diagnostics.js';
import { installDiagnosticsPanel } from './diagnostics-panel.js';
import { installBackupUi } from './backup-ui.js';
import { installFollowImport } from './follow-import.js';
import { askWorkspaceName, confirmAction } from './dialogs.js';
import { installCtrlLongPress, installShortcuts } from './shortcuts.js';
import { toast } from './toast.js';
import { installToolbarTooltips } from './toolbar-tooltip.js';
import {
  collectReminderRooms,
  createReminderSync,
  handleRoomLiveTransition as notifyLiveTransition,
  requestNotificationPermission,
} from './live-notify.js';
import {
  STORAGE_KEY_V1,
  STORAGE_KEY_V2,
  STORAGE_KEY_V3,
  cloneWorkspace,
  createWorkspace,
  mapWithConcurrency,
  normalizeAppState,
  normalizeGiftValueFilter,
  normalizeRoomState,
  parseBatchInput,
  reorderRooms,
  roomMatches,
} from './state.js';

const MOBILE_QUERY = '(max-width: 700px)';

const $ = (id) => document.getElementById(id);
const grid = $('grid');
const workspaceEl = $('workspace');
const roomList = $('roomList');
const mobileMedia = matchMedia(MOBILE_QUERY);
const toolbarTooltips = installToolbarTooltips($('toolbarTooltip'));

function setToolbarButtonLabel(buttonOrId, label, tooltip = label) {
  toolbarTooltips.setLabel(typeof buttonOrId === 'string' ? $(buttonOrId) : buttonOrId, label, tooltip);
}

// rooms 是当前方案中持久化的房间；tiles 只是当前打开的播放窗口。
const rooms = [];
const tiles = [];
let aggregateTile = null;
const tileRooms = new Map();
let activeSidebarRoom = null;
let sidebarQuery = '';
let sidebarFilter = 'live';
let batchMode = false;
let mobileSidebarOpen = false;
let savingBlocked = false;
let soloTile = null;
let soloSnapshot = new Map();
let scheduler = null;
const ecoTimers = new Map();
let ecoMode = false;
let latencyChase = false;
let preferHevc = false;
let autoQuality = false;
let hideOfflineWindows = false;
let preferredFocusRid = '';
let giftsEnabled = true;
let giftNameFilter = '';
let giftValueFilter = null;

// 自动清晰度：焦点、独听、画中画、全屏窗口算主窗口，优先最高档。
function isAutoQualityPriority(tile) {
  if (tile === soloTile || tile.isPictureInPicture()) return true;
  if (grid.dataset.layout === 'focus' && tile.el.classList.contains('focus-main')) return true;
  const fullscreen = document.fullscreenElement;
  return !!fullscreen && tile.el.contains(fullscreen);
}
const autoQualityController = createAutoQualityController({
  getTiles: () => tiles,
  isPriority: isAutoQualityPriority,
});

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

giftNameFilter = appState.workspaces.find((item) => item.id === appState.activeWorkspaceId)?.giftNameFilter || '';
giftValueFilter = appState.workspaces.find((item) => item.id === appState.activeWorkspaceId)?.giftValueFilter ?? null;

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
  current.chatPanelOpen = chatPanelPreferred;
  current.chatRid = chatPanel.selectedRid;
  current.chatStatsMode = chatPanel.statsMode;
  current.showRoomStats = !document.body.classList.contains('room-stats-hidden');
  current.hideOfflineWindows = hideOfflineWindows;
  current.layoutMode = grid.dataset.layout === 'focus' ? 'focus' : 'grid';
  current.layoutPreset = $('layoutPresetSelect').value;
  current.layoutRatios = (grid.dataset.ratios || '').split(',').map(Number).filter((value) => Number.isFinite(value) && value > 0);
  current.focusedRid = current.layoutMode === 'focus' ? preferredFocusRid : '';
  current.danmakuSpeed = Number($('danmakuSpeedSelect').value) || 1;
  current.ecoMode = ecoMode;
  current.latencyChase = latencyChase;
  current.preferHevc = preferHevc;
  current.autoQuality = autoQuality;
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
  // 删除房间、切换/导入/删除方案等都会经过保存，在此统一同步后台提醒列表。
  syncExtensionReminders();
}

const sendReminders = createReminderSync();
function syncExtensionReminders() {
  sendReminders(collectReminderRooms(appState.workspaces, activeWorkspace(), rooms));
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
  toolbarTooltips.hide();
  const moveFocus = next && bar.contains(document.activeElement);
  // Reveal the destination before focusing it: display:none buttons cannot receive focus.
  document.body.classList.toggle('toolbar-hidden', next);
  if (moveFocus) $('toolbarRevealBtn').focus({ preventScroll: true });
  // inert hides the subtree from accessibility APIs and prevents keyboard focus.
  bar.inert = next;
  bar.removeAttribute('aria-hidden');
  $('toolbarHideBtn').setAttribute('aria-expanded', String(!next));
  $('toolbarRevealBtn').setAttribute('aria-expanded', String(!next));
  syncBarHeight();
  if (focusControl && !next) requestAnimationFrame(() => $('toolbarHideBtn').focus());
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
  btn.querySelector('use')?.setAttribute('href', collapsed ? '#icon-chevron-right' : '#icon-chevron-left');
  btn.title = collapsed ? '展开直播间列表' : '收起直播间列表';
  if (!isMobile()) btn.setAttribute('aria-expanded', String(!collapsed));
  if (persist) save();
}

function setSidebarHidden(hidden, { persist = true } = {}) {
  const next = !!hidden;
  const visuallyHidden = !isMobile() && next;
  const sidebar = $('roomSidebar');
  // Move focus out before hiding the subtree; otherwise Chrome reports a
  // blocked aria-hidden ancestor when the hide button remains focused.
  if (visuallyHidden && sidebar.contains(document.activeElement)) {
    $('sidebarRevealBtn').focus({ preventScroll: true });
  }
  workspaceEl.classList.toggle('sidebar-hidden', next);
  sidebar.toggleAttribute('inert', visuallyHidden);
  // `inert` removes the hidden subtree from the accessibility tree and moves
  // focusability with it; aria-hidden here can race the click's focused button.
  sidebar.removeAttribute('aria-hidden');
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
// —— 右侧聊天窗 ——
const chatPanel = new ChatPanel({
  onSelect: () => {
    syncChatTools();
    save();
  },
  onFilter: () => openDanmakuSettings(),
  onMinLevel: (minLevel) => {
    const cfg = activeWorkspace().danmaku = { ...activeWorkspace().danmaku, minLevel };
    tiles.forEach((tile) => tile.danmakuFilter?.configure(cfg));
    save({ immediate: true });
  },
  onToggleDanmaku: (rid) => {
    const tile = findTileByRid(rid);
    if (tile) tile.setDanmaku(!tile.s.danmaku);
  },
  onToggleGifts: (rid) => {
    const tile = findTileByRid(rid);
    if (tile) tile.setGiftsEnabled(!tile.giftsEnabled);
  },
  onStatsMode: () => save(),
  // 聚会统计需要每个房间的钻粉人数，定时取一次榜单快照（不长期订阅）
  onPartyRefresh: () => tiles.forEach((tile) => tile.refreshRankSnapshot()),
  // 悬浮时网页右侧不再占位；小窗关闭后聊天窗回到右侧
  onFloatChange: () => applyChatPanelLayout(),
});

function findTileByRid(rid) {
  return tiles.find((tile) => String(tile.s.rid) === String(rid));
}

// 工具栏显示聊天窗所选直播间的开关状态；只有该房间订阅榜单
function syncChatTools() {
  const tile = findTileByRid(chatPanel.rid);
  chatPanel.setTools({
    minLevel: activeWorkspace()?.danmaku?.minLevel || 0,
    danmaku: tile ? tile.s.danmaku : null,
    gifts: tile ? tile.giftsEnabled : null,
  });
  const wanted = chatPanel.visible ? tile : null;
  tiles.forEach((item) => item.setRanksWanted(item === wanted));
  chatPanel.setRanks(chatPanel.rid, tile?.ranks || {});
  syncChatParty();
}

function chatRoomLabel(tile) {
  return tile.s.nickname || tile.s.title || `房间 ${tile.s.rid}`;
}

// 聚会统计：所有已打开直播间的贵宾 / 钻粉人数（今日流水由聊天窗自己请求）
function syncChatParty() {
  chatPanel.setPartyRooms(tiles.map((tile) => ({
    rid: String(tile.s.rid),
    label: chatRoomLabel(tile),
    vip: tile.ranks.vip?.count ?? tile.stats.noble ?? null,
    diamond: tile.ranks.diamond?.count ?? null,
  })));
}
// 用户最近一次选择的显示状态；窄屏下聊天窗以抽屉覆盖画面，恢复方案时默认收起。
let chatPanelPreferred = false;

let chatPanelOpen = false;

function setChatPanelOpen(open, { persist = true } = {}) {
  const next = !!open;
  const { panel } = chatPanel; // 悬浮时不在本页 DOM 里，不能按 id 查找
  if (persist) chatPanelPreferred = next;
  if (!next && panel.contains(document.activeElement)) document.activeElement.blur();
  chatPanelOpen = next;
  // 悬浮中关闭聊天窗时连同小窗一起关闭
  if (!next) chatPanel.setFloating(false);
  applyChatPanelLayout();
  const btn = $('chatToggleBtn');
  btn.classList.toggle('on', next);
  btn.setAttribute('aria-pressed', String(next));
  setToolbarButtonLabel(btn, next ? '隐藏聊天窗' : '显示聊天窗', `${next ? '隐藏' : '显示'}聊天窗（C）`);
  chatPanel.setVisible(next);
  syncChatTools();
  if (persist) save();
}

// 悬浮时聊天窗在独立小窗里，网页右侧不留空位
function applyChatPanelLayout() {
  const { panel } = chatPanel;
  workspaceEl.classList.toggle('chat-open', chatPanelOpen && !chatPanel.floating);
  panel.inert = !chatPanelOpen;
}

function toggleChatPanel() {
  setChatPanelOpen(!chatPanelOpen);
}

function syncChatRooms() {
  chatPanel.setRooms(tiles.map((tile) => ({
    rid: String(tile.s.rid),
    label: chatRoomLabel(tile),
  })));
  syncChatTools();
}

$('chatToggleBtn').addEventListener('click', toggleChatPanel);
$('chatHideBtn').addEventListener('click', () => setChatPanelOpen(false));

$('mobileRoomsBtn').addEventListener('click', () => setMobileSidebar(!mobileSidebarOpen));
$('sidebarBackdrop').addEventListener('click', () => setMobileSidebar(false));
mobileMedia.addEventListener('change', () => {
  setMobileSidebar(false);
  setSidebarHidden(activeWorkspace()?.sidebarHiddenDesktop, { persist: false });
  // 悬浮小窗不受网页宽度影响
  if (!chatPanel.floating) setChatPanelOpen(chatPanelPreferred && !isMobile(), { persist: false });
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

function setShowRoomStats(visible, { persist = true } = {}) {
  const enabled = visible !== false;
  document.body.classList.toggle('room-stats-hidden', !enabled);
  const button = $('roomStatsBtn');
  button.classList.toggle('on', enabled);
  button.setAttribute('aria-pressed', String(enabled));
  setToolbarButtonLabel(button, enabled ? '隐藏统计水印' : '显示统计水印');
  if (persist) save({ immediate: true });
}

$('roomStatsBtn').addEventListener('click', () =>
  setShowRoomStats(document.body.classList.contains('room-stats-hidden'))
);

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
  sidebar.add(room);
  syncEmpty();
  if (persist) save();
  return room;
}

function handleRoomLiveTransition(room, previousLive, nextLive) {
  notifyLiveTransition(room, previousLive, nextLive, { onOpen: openRoomFromSidebar });
}

async function toggleRoomNotification(room) {
  room.s.notifyOnLive = !room.s.notifyOnLive;
  // 权限弹窗可能一直等待用户操作，先保存提醒开关，避免此时刷新丢失。
  syncSidebarRoom(room);
  save({ immediate: true });
  toast(room.s.notifyOnLive ? '已开启开播提醒' : '已关闭开播提醒');
  if (room.s.notifyOnLive) await requestNotificationPermission();
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

// —— 侧栏房间列表（DOM 见 room-sidebar.js，拖动排序见 room-drag.js）——
const sidebar = createRoomSidebar({
  list: roomList,
  template: $('roomShortcutTpl'),
  view: {
    isOpen: (room) => !!getOpenTile(room),
    isVisible: isRoomVisible,
    isActive: (room) => activeSidebarRoom === room,
    batchMode: () => batchMode,
  },
  actions: {
    open: (room) => openRoomFromSidebar(room),
    remove: (room) => deleteRoom(room),
    toggleNotify: (room) => toggleRoomNotification(room),
    startDrag: (room, event) => roomDrag.start(room, event),
    move: (room, delta) => moveRoom(room, delta),
    select: (room, checked) => {
      room.selected = checked;
      syncBatchControls();
    },
  },
});

function syncSidebarRoom(room) {
  sidebar.sync(room);
}

function syncAllSidebarRooms() {
  rooms.forEach(syncSidebarRoom);
  syncEmpty();
  syncBatchControls();
}

function revealSidebarRoom(room) {
  sidebar.reveal(room);
}

function syncRoomListOrder() {
  sidebar.reorder(rooms);
  syncAllSidebarRooms();
}

function moveRoom(room, delta) {
  const from = rooms.indexOf(room);
  const target = rooms[from + delta];
  if (from < 0 || !target) return;
  applyRoomOrder(reorderRooms(rooms, room, target, delta < 0 ? 'before' : 'after'));
}

// 侧栏顺序独立于播放窗口顺序，只更新房间列表并持久化。
function applyRoomOrder(next) {
  if (next.length !== rooms.length || next.every((room, index) => rooms[index] === room)) return;
  rooms.splice(0, rooms.length, ...next);
  syncRoomListOrder();
  save();
}

// —— 侧栏拖动排序（见 room-drag.js）——
const roomDrag = installRoomDrag({
  list: roomList,
  visibleRooms,
  entryEl: sidebar.entryEl,
  dragHandle: sidebar.dragHandle,
  onDrop: (room, target, position) => applyRoomOrder(reorderRooms(rooms, room, target, position)),
});

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
  syncChatRooms();
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
      diagnosticsPanel.refresh();
    },
    onVisibility: (item) => {
      scheduleEco(item);
      autoQualityController.refresh();
    },
    onFocus: (item) => setFocusedTile(item),
    onDanmaku: (source, chat) => dispatchDanmaku(source, chat),
    onAggregate: (item) => toggleAggregate(item),
    onRates: () => syncBatchRates(),
    onPiP: (item) => {
      scheduleEco(item);
      autoQualityController.refresh();
    },
    onRanks: (item) => {
      if (String(item.s.rid) === chatPanel.rid) chatPanel.setRanks(chatPanel.rid, item.ranks);
      syncChatParty();
    },
    onGifts: (item) => {
      if (String(item.s.rid) === chatPanel.rid) syncChatTools();
    },
    onRecord: (item, event) => {
      const message = recordToast(item, event);
      if (message) toast(message, event.type === 'error' ? 5000 : 3600, event.type === 'error');
      // 录制中（含等待开播）的窗口不能被节能暂停，否则会断录或错过开播；
      // 也不被自动清晰度切档，结束录制后重新纳入。
      if (event.type === 'armed' || event.type === 'disarmed') {
        scheduleEco(item);
        autoQualityController.refresh();
      }
    },
    onAutoQuality: () => autoQualityController.refresh(),
    pickRate: (item) => autoQualityController.initialRate(item),
    danmakuConfig: activeWorkspace().danmaku,
  });
  tiles.push(tile);
  tileRooms.set(tile, room);
  tile.setDanmakuSpeed(Number($('danmakuSpeedSelect').value) || 1);
  tile.setGiftsEnabled(giftsEnabled);
  tile.setGiftNameFilter(giftNameFilter);
  tile.setGiftValueFilter(giftValueFilter);
  copyTileSettingsToRoom(tile, room);
  grid.appendChild(tile.el);
  makeDraggable(tile);
  scheduler?.markChecked(room);
  applyLayout();
  syncBatchRates();
  scheduleEco(tile);
  tile.player.setLatencyChase(latencyChase);
  tile.setPreferHevc(preferHevc, { reload: false });
  tile.setAutoQuality(autoQuality);
  syncSidebarRoom(room);
  syncEmpty();
  syncChatRooms();
  tile.load();
  if (persist) save();
  return tile;
}

function syncAggregateButtons() {
  tiles.forEach((tile) => tile.setAggregate(tile === aggregateTile));
}

function toggleAggregate(tile) {
  aggregateTile = aggregateTile === tile ? null : tile;
  syncAggregateButtons();
}

function dispatchDanmaku(source, chat) {
  // 聊天窗不受画面弹幕开关影响
  chatPanel.push(source.s.rid, chat);
  if (!source.s.danmaku || source.live !== true) return;
  const target = aggregateTile || source;
  const label = source.s.nickname || source.s.title || `房间 ${source.s.rid}`;
  const text = aggregateTile && source !== target ? `[${label}] ${chat.text}` : chat.text;
  target.pushDanmaku(text, chat.color);
}

function closeTile(tile, { persist = true, checkStatus = true } = {}) {
  const index = tiles.indexOf(tile);
  if (index < 0) return;
  const wasFocused = grid.dataset.layout === 'focus' &&
    (tile.el.classList.contains('focus-main') || String(tile.s.rid) === preferredFocusRid);
  const room = tileRooms.get(tile);
  if (aggregateTile === tile) aggregateTile = null;
  if (tile === soloTile) exitSolo({ persist: false });
  if (room) copyTileSettingsToRoom(tile, room);

  tiles.splice(index, 1);
  clearTimeout(ecoTimers.get(tile));
  ecoTimers.delete(tile);
  tileRooms.delete(tile);
  clearTimeout(tile.sidebarTargetTimer);
  tile.destroy();
  syncAggregateButtons();
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
  syncChatRooms();
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
  sidebar.remove(room);
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
  autoQualityController.refresh();
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
  exitSolo({ restore: false, persist: false });
  [...tiles].forEach((tile) => closeTile(tile, { persist: false, checkStatus: false }));
  rooms.forEach((room) => scheduler?.cancel(room));
  rooms.splice(0, rooms.length);
  sidebar.clear();
  activeSidebarRoom = null;
  sidebarQuery = '';
  sidebarFilter = 'live';
  $('roomSearch').value = '';
  $('roomFilter').value = sidebarFilter;
  setBatchMode(false);
}

function loadWorkspaceRuntime(current) {
  giftNameFilter = current.giftNameFilter || '';
  giftValueFilter = current.giftValueFilter ?? null;
  grid.dataset.cols = current.cols;
  grid.dataset.layout = current.layoutMode || 'grid';
  preferredFocusRid = current.focusedRid || '';
  setHideOfflineWindows(current.hideOfflineWindows, { persist: false });
  $('colsSelect').value = current.cols;
  $('layoutPresetSelect').value = current.layoutPreset || 'auto';
  grid.dataset.preset = current.layoutPreset || 'auto';
  grid.dataset.ratios = (current.layoutRatios || []).join(',');
  $('danmakuSpeedSelect').value = String(current.danmakuSpeed || 1);
  ecoMode = !!current.ecoMode;
  latencyChase = !!current.latencyChase;
  preferHevc = !!current.preferHevc;
  // 先开启控制器，随后打开的窗口首播就能直接取目标档位。
  autoQuality = !!current.autoQuality;
  autoQualityController.setEnabled(autoQuality);
  setToolbarHidden(current.toolbarHidden, { persist: false });
  setShowRoomStats(current.showRoomStats, { persist: false });
  setSidebarCollapsed(current.sidebarCollapsedDesktop, { persist: false });
  setSidebarHidden(current.sidebarHiddenDesktop, { persist: false });
  chatPanelPreferred = !!current.chatPanelOpen;
  // 打开页面时聊天框跟随布局：焦点布局显示焦点房间，网格布局显示排序第一个
  chatPanel.setPreferredRid(
    grid.dataset.layout === 'focus' && current.focusedRid ? current.focusedRid : current.openRids[0]
  );
  chatPanel.setStatsMode(current.chatStatsMode);
  setChatPanelOpen(chatPanelPreferred && !isMobile(), { persist: false });
  for (const state of current.rooms) addRoom(state, { persist: false });
  for (const rid of current.openRids) {
    const room = findRoom(rid);
    if (room) openRoom(room, { persist: false });
  }
  applyLayout(current.focusedRid);
  const chatTile = tiles.find((tile) => tile.el.classList.contains('focus-main')) ||
    tiles.find((tile) => !tile.el.hidden) || tiles[0];
  chatPanel.setPreferredRid(chatTile ? chatTile.s.rid : '');
  syncChatRooms();
  syncEcoButton();
  syncLatencyChaseButton();
  syncHevcButton();
  syncAutoQualityButton();
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

// 单行输入框粘贴时浏览器会直接删掉换行，多行房间号会粘成一串；先把换行换成空格再插入。
$('addInput').addEventListener('paste', (event) => {
  const text = event.clipboardData?.getData('text');
  if (!text || !/[\r\n]/.test(text)) return;
  event.preventDefault();
  const input = event.currentTarget;
  const flat = text.replace(/[\r\n]+/g, ' ').trim();
  input.setRangeText(flat, input.selectionStart, input.selectionEnd, 'end');
  input.dispatchEvent(new Event('input', { bubbles: true }));
});

// 礼物记录全局开关（记录仍保留在窗口内存中）
$('giftAllBtn')?.addEventListener('click', () => {
  giftsEnabled = !giftsEnabled;
  tiles.forEach((tile) => tile.setGiftsEnabled(giftsEnabled));
  const button = $('giftAllBtn');
  button.setAttribute('aria-pressed', String(giftsEnabled));
  button.setAttribute('aria-label', giftsEnabled ? '礼物记录全关' : '礼物记录全开');
  button.dataset.tooltip = giftsEnabled ? '礼物记录全关' : '礼物记录全开';
});
$('giftNameFilter')?.addEventListener('input', (event) => {
  giftNameFilter = event.target.value;
});
$('giftFilterBtn')?.addEventListener('click', () => {
  $('giftNameFilter').value = giftNameFilter;
  $('giftValueFilter').value = giftValueFilter ?? '';
  $('giftFilterDialog').showModal();
});
$('giftFilterForm')?.addEventListener('submit', (event) => {
  if (event.submitter?.value === 'cancel') return;
  giftNameFilter = $('giftNameFilter').value;
  giftValueFilter = normalizeGiftValueFilter($('giftValueFilter').value);
  activeWorkspace().giftNameFilter = giftNameFilter;
  activeWorkspace().giftValueFilter = giftValueFilter;
  tiles.forEach((tile) => { tile.setGiftNameFilter(giftNameFilter); tile.setGiftValueFilter(giftValueFilter); });
  save({ immediate: true });
});

// 长按 Ctrl 呼出快速打开框；框已打开时再次长按则关闭。
const quickSearch = $('quickSearch');
const quickInput = $('quickSearchInput');
const quickSearchController = bindQuickSearch({
  panel: quickSearch, input: quickInput, results: $('quickSearchResults'), status: $('quickSearchError'),
  onOpen(value) { $('addInput').value = value; $('addForm').requestSubmit(); },
});
const ctrlLongPress = installCtrlLongPress({
  onTrigger: () => {
    if (quickSearch.hidden) quickSearchController.open();
    else closeQuickSearch();
  },
});
function closeQuickSearch() {
  ctrlLongPress.cancel();
  quickSearchController.close();
}
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && quickSearch && !quickSearch.hidden) closeQuickSearch();
});
document.addEventListener('pointerdown', (event) => {
  if (quickSearch && !quickSearch.hidden && !quickSearch.contains(event.target)) closeQuickSearch();
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
  autoQualityController.refresh();
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

function syncEcoButton() {
  const enabled = ecoMode;
  $('ecoModeBtn').classList.toggle('on', enabled);
  $('ecoModeBtn').setAttribute('aria-pressed', String(enabled));
  setToolbarButtonLabel(
    'ecoModeBtn',
    enabled ? '关闭低负载' : '低负载',
    enabled ? '低负载模式已开启，点击关闭' : '开启低负载模式'
  );
  tiles.forEach(scheduleEco);
}

function recordToast(tile, event) {
  const name = tile.s.nickname || tile.s.rid;
  const size = (bytes) => bytes >= 1 << 30 ? `${(bytes / (1 << 30)).toFixed(2)} GB` : `${(bytes / (1 << 20)).toFixed(1)} MB`;
  switch (event.type) {
    case 'armed':
      if (!event.dir) return `${name}：开始录制，浏览器不支持选择目录，每段录完后自动下载`;
      return `${name}：开始录制到「${event.dir}」，每 30 分钟一个文件；下播后会在开播时自动续录`;
    case 'saved':
      // 分段换文件很频繁，不打扰；下播、手动停止和因换档另起文件时告知。
      if (event.reason === 'split') return '';
      if (event.reason === 'reconfigure') {
        return `${name}：清晰度或编码已变化，录制另起新文件（上一段 ${size(event.bytes)} 已保存）`;
      }
      return event.reason === 'offline'
        ? `${name} 已下播，录制文件已保存（${size(event.bytes)}），开播后自动继续录制`
        : `${name}：录制已停止，已保存 ${event.fileName}（${size(event.bytes)}）`;
    case 'error':
      return event.message;
    default:
      return '';
  }
}

// 写盘录制必须正常停止才会落成文件；录制中离开页面先提醒。
window.addEventListener('beforeunload', (event) => {
  if (!tiles.some((tile) => tile.isRecording())) return;
  event.preventDefault();
  event.returnValue = '';
});

function scheduleEco(tile) {
  if (!tile || !tiles.includes(tile)) return;
  clearTimeout(ecoTimers.get(tile));
  ecoTimers.delete(tile);
  // 后台维持现有连接，节能仅处理前台视口外的窗口。
  if (document.hidden) return;
  const protectedTile = !tile.s.muted || tile === soloTile || tile.isPictureInPicture() || tile.isRecording();
  const shouldSuspend = ecoMode && !protectedTile && (!document.hidden && !tile.visible);
  if (!shouldSuspend) {
    tile.resumeFromEco();
    return;
  }
  if (tile.ecoSuspended) return;
  const timer = setTimeout(() => {
    ecoTimers.delete(tile);
    const stillProtected = !tile.s.muted || tile === soloTile || tile.isPictureInPicture() || tile.isRecording();
    if (ecoMode && !stillProtected && (!document.hidden && !tile.visible)) tile.suspendForEco();
  }, 30_000);
  ecoTimers.set(tile, timer);
}

$('ecoModeBtn').addEventListener('click', () => {
  ecoMode = !ecoMode;
  syncEcoButton();
  save({ immediate: true });
});

// —— 延迟对齐 ——
// 开启后各窗口跳到最新关键帧，并用 1.1× 倍速把本地缓冲积压保持在 1.5 秒内。
// 只能对齐浏览器端积压；主播推流与 CDN 的延迟差无法消除。
function syncLatencyChaseButton() {
  const enabled = latencyChase;
  $('latencyChaseBtn').classList.toggle('on', enabled);
  $('latencyChaseBtn').setAttribute('aria-pressed', String(enabled));
  setToolbarButtonLabel(
    'latencyChaseBtn',
    enabled ? '关闭延迟对齐' : '延迟对齐',
    enabled ? '延迟对齐已开启，点击关闭' : '开启延迟对齐：各窗口追到最新画面并保持低延迟'
  );
  tiles.forEach((tile) => tile.player.setLatencyChase(enabled));
}

function toggleLatencyChase() {
  latencyChase = !latencyChase;
  syncLatencyChaseButton();
  save({ immediate: true });
  toast(latencyChase ? '已开启延迟对齐' : '已关闭延迟对齐');
}

$('latencyChaseBtn').addEventListener('click', toggleLatencyChase);

// —— H.265 省流 ——
// 开启后优先拉斗鱼的 H.265 转码流，同清晰度视频码率通常更低；没有 H.265 流的房间仍用 H.264。
// 只在浏览器能用 MSE 解 H.265（需要硬件解码）时显示开关。
const hevcSupported = hevcPlaybackSupported();

function syncHevcButton() {
  const button = $('hevcBtn');
  button.hidden = !hevcSupported;
  button.classList.toggle('on', preferHevc);
  button.setAttribute('aria-pressed', String(preferHevc));
  setToolbarButtonLabel(
    button,
    preferHevc ? '关闭 H.265 省流' : 'H.265 省流',
    preferHevc ? 'H.265 省流已开启，点击改回 H.264' : '开启 H.265 省流：同清晰度占用更少带宽，需要硬件解码'
  );
}

$('hevcBtn').addEventListener('click', () => {
  if (!hevcSupported) return;
  preferHevc = !preferHevc;
  syncHevcButton();
  tiles.forEach((tile) => tile.setPreferHevc(preferHevc));
  save({ immediate: true });
  toast(preferHevc ? '已开启 H.265 省流，正在为支持的直播间切换' : '已改回 H.264');
});

// —— 自动清晰度（策略见 auto-quality.js）——
// 手动选过清晰度的窗口会锁定；录制中的窗口保持当前档位，不被自动切换。
function syncAutoQualityButton() {
  const button = $('autoQualityBtn');
  button.classList.toggle('on', autoQuality);
  button.setAttribute('aria-pressed', String(autoQuality));
  setToolbarButtonLabel(
    button,
    autoQuality ? '关闭自动清晰度' : '自动清晰度',
    autoQuality
      ? '自动清晰度已开启：主窗口优先高清，其余按窗口大小和卡顿情况调整；点击关闭'
      : '开启自动清晰度：焦点/独听窗口优先高清，其余窗口按大小降档，丢帧或持续缓冲时逐级降低，稳定后再恢复'
  );
  tiles.forEach((tile) => tile.setAutoQuality(autoQuality));
  autoQualityController.setEnabled(autoQuality);
  syncBatchRates();
}

$('autoQualityBtn').addEventListener('click', () => {
  autoQuality = !autoQuality;
  syncAutoQualityButton();
  save({ immediate: true });
  toast(autoQuality
    ? '已开启自动清晰度；手动选择清晰度的窗口会锁定，录制中的窗口保持当前清晰度'
    : '已关闭自动清晰度，各窗口保持当前清晰度');
});

// 窗口尺寸、全屏变化都会改变目标档位
new ResizeObserver(() => autoQualityController.refresh()).observe(grid);
document.addEventListener('fullscreenchange', () => autoQualityController.refresh());

// —— 批量清晰度 ——
const BATCH_RATE_AUTO = '__auto__';

function syncBatchRates() {
  const select = $('batchRateSelect');
  const names = [...new Set(tiles.flatMap((tile) => tile.availableRates.map((rate) => rate.name)).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  select.replaceChildren(
    Object.assign(document.createElement('option'), { value: '', textContent: '批量清晰度' }),
    ...(autoQuality && names.length
      ? [Object.assign(document.createElement('option'), { value: BATCH_RATE_AUTO, textContent: '全部自动' })]
      : []),
    ...names.map((name) => Object.assign(document.createElement('option'), { value: name, textContent: name }))
  );
  select.disabled = names.length === 0;
}

$('batchRateSelect').addEventListener('change', (event) => {
  const name = event.target.value;
  if (!name) return;
  event.target.value = '';
  if (name === BATCH_RATE_AUTO) {
    const locked = tiles.filter((tile) => tile.s.rateLocked);
    locked.forEach((tile) => tile.setRateLocked(false));
    toast(locked.length ? `已解除 ${locked.length} 个窗口的清晰度锁定，交给自动清晰度` : '所有窗口都已是自动清晰度');
    return;
  }
  let success = 0;
  // 自动清晰度开启时，批量指定也算手动选择，会锁定这些窗口。
  for (const tile of tiles) if (tile.setRateByName(name, { lock: autoQuality })) success++;
  const skipped = tiles.length - success;
  toast(`已切换 ${success} 个窗口${skipped ? `，跳过 ${skipped} 个不支持窗口` : ''}${autoQuality && success ? '并锁定' : ''}`);
});

// —— 配置备份与导入（见 backup-ui.js）——
installBackupUi({
  getState: () => {
    snapshotActiveWorkspace();
    return appState;
  },
  onReplace: (imported) => {
    savingBlocked = true;
    clearRuntime();
    appState.workspaces.splice(0, appState.workspaces.length, ...imported);
    appState.activeWorkspaceId = imported[0].id;
    loadWorkspaceRuntime(imported[0]);
    savingBlocked = false;
    renderWorkspaceSelect();
    save({ immediate: true });
  },
  onMerge: (imported) => {
    snapshotActiveWorkspace();
    appState.workspaces.push(...imported);
    renderWorkspaceSelect();
    switchWorkspace(imported[0].id);
  },
});

// —— 导入斗鱼关注（仅扩展版，见 follow-import.js）——
installFollowImport({
  hasRoom: (rid) => !!findRoom(rid),
  onImport: (picked) => {
    let added = 0;
    for (const { rid, nickname, title, avatar, live } of picked) {
      if (findRoom(rid)) continue;
      if (addRoom({ rid, nickname, title, avatar }, { live, persist: false })) added++;
    }
    save({ immediate: true });
    return added;
  },
});

// —— 连接与性能诊断（见 diagnostics-panel.js）——
function collectDiagnostics() {
  return tiles.map((tile) => ({
    ...tile.diagnostics(),
    lastCheckedAt: tileRooms.get(tile)?.lastCheckedAt || 0,
  }));
}

const diagnosticsPanel = installDiagnosticsPanel({
  collect: collectDiagnostics,
  retryFailed: () => {
    const failed = tiles.filter((tile) => tile.player.state === 'error');
    failed.forEach((tile) => tile.reload());
    return failed.length;
  },
});

// —— 播放窗口拖动排序（见 tile-drag.js）——
function makeDraggable(tile) {
  makeTileDraggable(tile, {
    grid,
    onReorder: (order) => {
      tiles.sort((a, b) => order.indexOf(String(a.s.rid)) - order.indexOf(String(b.s.rid)));
      syncChatRooms();
      tiles.forEach((item) => item.resume());
      save();
    },
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
  const summary = diagnosticSummary(collectDiagnostics());
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
  tiles.forEach((tile) => tile.load('reload-all'));
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

// —— 快捷键（见 shortcuts.js）——
function revealRoomSearch() {
  if (isMobile()) setMobileSidebar(true);
  else if (workspaceEl.classList.contains('sidebar-hidden')) setSidebarHidden(false);
  else if (workspaceEl.classList.contains('sidebar-collapsed')) setSidebarCollapsed(false);
  $('roomSearch').focus();
}

function toggleSidebar() {
  if (isMobile()) setMobileSidebar(!mobileSidebarOpen);
  else if (workspaceEl.classList.contains('sidebar-hidden')) setSidebarHidden(false);
  else setSidebarCollapsed(!workspaceEl.classList.contains('sidebar-collapsed'));
}

installShortcuts({
  keys: {
    a: () => $('addInput').focus(),
    '/': revealRoomSearch,
    b: toggleSidebar,
    t: () => setToolbarHidden(!document.body.classList.contains('toolbar-hidden')),
    c: toggleChatPanel,
    m: toggleMuteAll,
    d: toggleDanmakuAll,
    r: reloadAll,
    l: toggleLatencyChase,
    '?': () => $('helpDialog').showModal(),
  },
  // 1～9 独听对应的可见窗口
  onDigit: (n) => {
    const tile = tiles.filter((item) => !item.el.hidden)[n - 1];
    if (tile) activateSolo(tile);
  },
  // 没有对话框可关时，依次收起移动端侧栏、退出批量模式、清空房间搜索
  onEscape: () => {
    if (mobileSidebarOpen) return setMobileSidebar(false);
    if (batchMode) return setBatchMode(false);
    if (!sidebarQuery) return;
    sidebarQuery = '';
    $('roomSearch').value = '';
    syncAllSidebarRooms();
  },
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
    ...activeWorkspace().danmaku,
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
  autoQualityController.setPageVisible(!document.hidden);
  if (!document.hidden) refreshRoomStates();
});
window.addEventListener('online', () => {
  tiles.forEach((tile) => tile.setOnline(true));
  refreshRoomStates();
});
window.addEventListener('offline', () => tiles.forEach((tile) => tile.setOnline(false)));
window.addEventListener('pagehide', () => flushSave());
