import { handleApiPath } from './api.js';

const APP_URL = chrome.runtime.getURL('index.html');
const STORE = 'douyu-live-reminders';
const ALARM = 'douyu-live-check';
const NOTIFICATION_PREFIX = 'douyu-live-';

// 页面同步、定时检查、页面上报开播都会读改写同一份存储，串行执行避免互相覆盖。
let storeQueue = Promise.resolve();
function serial(task) {
  storeQueue = storeQueue.then(task, task).catch(() => {});
  return storeQueue;
}
async function readReminders() { return (await chrome.storage.local.get(STORE))[STORE] || {}; }

function showLiveNotification(rid, title) {
  // 每次开播使用新的 id：同 id 通知在系统通知中心里可能被静默替换而不弹出。
  chrome.notifications.create(`${NOTIFICATION_PREFIX}${rid}-${Date.now()}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: '斗鱼直播已开播',
    message: `${title || `房间 ${rid}`}（房间 ${rid}）`,
    priority: 2,
  });
}

function checkReminders() {
  return serial(async () => {
    const state = await readReminders();
    await Promise.all(Object.entries(state).map(async ([rid, room]) => {
      try {
        const info = await handleApiPath(`/api/room?rid=${encodeURIComponent(rid)}`);
        const live = !!info.live;
        // 状态未知（null）时只记录基线，避免把"本来就在播"误报为开播。
        if (room.live === false && live) showLiveNotification(rid, room.title);
        state[rid] = { ...room, live };
      } catch {}
    }));
    await chrome.storage.local.set({ [STORE]: state });
  });
}

function syncReminders(rooms) {
  return serial(async () => {
    const previous = await readReminders();
    const next = {};
    for (const [rid, room] of Object.entries(rooms || {})) {
      const known = typeof previous[rid]?.live === 'boolean' ? previous[rid].live : null;
      // 后台持续轮询得到的状态优先，页面只为新加入的房间提供初始状态。
      const pageLive = typeof room?.live === 'boolean' ? room.live : null;
      next[rid] = { title: room?.title || '', avatar: room?.avatar || '', live: known ?? pageLive };
    }
    await chrome.storage.local.set({ [STORE]: next });
  }).then(checkReminders);
}

// 页面先检测到开播时上报：记录状态，避免后台下次轮询重复通知；仅在页面不可见时弹系统通知。
function handlePageLive(rid, title, show) {
  return serial(async () => {
    const state = await readReminders();
    const room = state[rid];
    if (room?.live === true) return;
    if (room) {
      state[rid] = { ...room, live: true };
      await chrome.storage.local.set({ [STORE]: state });
    }
    if (show) showLiveNotification(rid, title || room?.title);
  });
}

function ensureAlarm() {
  chrome.alarms.get(ALARM).then((alarm) => {
    if (!alarm) chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  });
}
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === ALARM) checkReminders(); });
ensureAlarm();

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: APP_URL });
});

function serializeError(error) {
  return {
    error: error?.message || '请求失败',
    status: Number(error?.status) || 502,
    code: error?.code,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'douyu-auth-status') {
    chrome.cookies.get({ url: 'https://www.douyu.com/', name: 'acf_did' }, (cookie) => {
      sendResponse({ loggedIn: !!cookie });
    });
    return true;
  }
  if (message?.type === 'douyu-sync-reminders') { syncReminders(message.rooms); return; }
  if (message?.type === 'douyu-api') {
    handleApiPath(message.path)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, ...serializeError(error) }));
    return true;
  }

  if (message?.type === 'douyu-notification') {
    handlePageLive(String(message.rid), message.title, message.show !== false);
  }
});

chrome.notifications.onClicked.addListener((notificationId) => {
  const rid = notificationId.match(/^douyu-live-(\d+)/)?.[1];
  if (!rid) return;
  chrome.tabs.query({}, (tabs) => {
    const tab = tabs.find((t) => t.url?.startsWith(APP_URL));
    const url = `${APP_URL}?room=${encodeURIComponent(rid)}`;
    if (tab?.id) { chrome.tabs.update(tab.id, { active: true, url }); chrome.windows.update(tab.windowId, { focused: true }); }
    else chrome.tabs.create({ url });
  });
  chrome.notifications.clear(notificationId);
});
