import { handleApiPath } from './api.js';

const APP_URL = chrome.runtime.getURL('index.html');
const STORE = 'douyu-live-reminders';
async function reminders() { return (await chrome.storage.local.get(STORE))[STORE] || {}; }
async function checkReminders() {
  const state = await reminders();
  for (const [rid, room] of Object.entries(state)) try {
    const info = await handleApiPath(`/api/room?rid=${encodeURIComponent(rid)}`);
    const was = room.live; state[rid] = { ...room, live: !!info.live };
    if (was === false && info.live) chrome.notifications.create(`douyu-live-${rid}`, { type: 'basic', iconUrl: 'icons/icon128.png', title: '斗鱼直播已开播', message: `${room.title || rid}（房间 ${rid}）` });
  } catch {}
  await chrome.storage.local.set({ [STORE]: state });
}
chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('douyu-live-check', { periodInMinutes: 1 }));
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'douyu-live-check') checkReminders(); });
chrome.alarms.get('douyu-live-check').then((a) => { if (!a) chrome.alarms.create('douyu-live-check', { periodInMinutes: 1 }); });

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
  if (message?.type === 'douyu-sync-reminders') { chrome.storage.local.set({ [STORE]: message.rooms || {} }).then(() => checkReminders()); return; }
  if (message?.type === 'douyu-api') {
    handleApiPath(message.path)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, ...serializeError(error) }));
    return true;
  }

  if (message?.type === 'douyu-notification') {
    chrome.notifications.create(`douyu-live-${message.rid}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: '斗鱼直播已开播',
      message: `${message.title}（房间 ${message.rid}）`,
    });
  }
});

chrome.notifications.onClicked.addListener((notificationId) => {
  if (!notificationId.startsWith('douyu-live-')) return;
  chrome.tabs.query({}, (tabs) => {
    const tab = tabs.find((t) => t.url?.startsWith(APP_URL));
    const url = `${APP_URL}?room=${encodeURIComponent(notificationId.slice('douyu-live-'.length))}`;
    if (tab?.id) { chrome.tabs.update(tab.id, { active: true, url }); chrome.windows.update(tab.windowId, { focused: true }); }
    else chrome.tabs.create({ url });
  });
  chrome.notifications.clear(notificationId);
});
