// 开播提醒：页面检测到「未开播 → 开播」时提示；扩展版另把提醒列表同步给后台持续轮询。
import { toast } from './toast.js';

function extensionRuntime() {
  const runtime = globalThis.chrome?.runtime;
  return runtime?.id ? runtime : null;
}

function sendToExtension(runtime, message) {
  try { Promise.resolve(runtime.sendMessage(message)).catch(() => {}); } catch {}
}

// 同一次开播只提醒一次；onOpen(room) 在点击系统通知时打开该房间。
export function handleRoomLiveTransition(room, previousLive, nextLive, { onOpen } = {}) {
  if (nextLive === false) room.notifiedLiveCycle = false;
  if (previousLive !== false || nextLive !== true || room.notifiedLiveCycle || !room.s.notifyOnLive) return;
  room.notifiedLiveCycle = true;
  const title = room.s.title || room.s.nickname || `房间 ${room.s.rid}`;
  toast(`${title} 已开播`);
  const runtime = extensionRuntime();
  if (runtime) {
    // 页面可见时也上报，让后台记下已开播，避免后台轮询再补发一次系统通知。
    sendToExtension(runtime, { type: 'douyu-notification', rid: String(room.s.rid), title, show: document.hidden });
  } else if (document.hidden && globalThis.Notification?.permission === 'granted') {
    const notification = new Notification('斗鱼直播已开播', {
      body: `${title}（房间 ${room.s.rid}）`,
      icon: room.s.avatar || undefined,
      tag: `douyu-live-${room.s.rid}`,
    });
    notification.onclick = () => {
      window.focus();
      onOpen?.(room);
      notification.close();
    };
  }
}

// 网页版首次开启提醒时请求通知权限；扩展版由 manifest 授权。
export async function requestNotificationPermission() {
  if (extensionRuntime() || globalThis.Notification?.permission !== 'default') return;
  try {
    await Notification.requestPermission();
  } catch {}
}

// 后台按整表替换提醒列表，所以必须汇总所有观看方案，而不只是当前方案。
// currentRooms 是当前方案的运行时房间（带检测到的 live），其他方案只有持久化的设置。
export function collectReminderRooms(workspaces, currentWorkspace, currentRooms) {
  const roomsToWatch = {};
  const watch = (state, live = null) => {
    if (!state?.notifyOnLive) return;
    const rid = String(state.rid);
    const known = roomsToWatch[rid]?.live;
    roomsToWatch[rid] = {
      title: state.title || state.nickname || `房间 ${rid}`,
      avatar: state.avatar || '',
      // 未检测到状态时传 null，后台会先记录基线，不会误判为“未开播→开播”。
      live: typeof live === 'boolean' ? live : known ?? null,
    };
  };
  for (const workspace of workspaces) {
    if (workspace !== currentWorkspace) workspace.rooms.forEach((state) => watch(state));
  }
  currentRooms.forEach((room) => watch(room.s, room.live));
  return roomsToWatch;
}

// 返回同步函数：内容没变时不重复发给后台。网页版没有后台，调用无效果。
export function createReminderSync() {
  let lastPayload = '';
  return (roomsToWatch) => {
    const runtime = extensionRuntime();
    if (!runtime) return;
    const payload = JSON.stringify(roomsToWatch);
    if (payload === lastPayload) return;
    lastPayload = payload;
    sendToExtension(runtime, { type: 'douyu-sync-reminders', rooms: roomsToWatch });
  };
}
