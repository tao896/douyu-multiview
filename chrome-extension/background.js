import { handleApiPath } from './api.js';

const APP_URL = chrome.runtime.getURL('index.html');

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
  chrome.tabs.create({ url: APP_URL });
  chrome.notifications.clear(notificationId);
});
