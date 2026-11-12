// 扩展版「导入关注」：后台用浏览器里的斗鱼登录 Cookie 拉取关注列表，用户勾选后加入当前方案。
// 网页版没有扩展后台，按钮保持隐藏。
import { isExtensionPage, sendExtensionMessage } from './net.js';
import { dialogResult } from './dialogs.js';
import { toast } from './toast.js';

const $ = (id) => document.getElementById(id);
const LOGIN_URL = 'https://www.douyu.com/';

// hasRoom(rid)：当前方案是否已有该房间；onImport(rooms) 返回实际新增的数量。
export function installFollowImport({ hasRoom, onImport }) {
  const button = $('followImportBtn');
  if (!button || !isExtensionPage()) return;
  button.hidden = false;
  const dialog = $('followDialog');
  const status = $('followStatus');
  const list = $('followList');
  const submit = $('followSubmit');
  const pickButtons = [...dialog.querySelectorAll('[data-follow-pick]')];
  let entries = [];
  let loadId = 0;

  function selectable() {
    return entries.filter((entry) => !entry.input.disabled);
  }

  function syncSubmit() {
    const count = selectable().filter((entry) => entry.input.checked).length;
    submit.disabled = count === 0;
    submit.textContent = count ? `添加 ${count} 个` : '添加';
  }

  function setStatus(text, { relogin = false } = {}) {
    status.replaceChildren(document.createTextNode(text));
    if (!relogin) return;
    const link = document.createElement('a');
    link.href = LOGIN_URL;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = '打开斗鱼登录';
    status.append(' ', link, '，登录后再点一次「导入关注」。');
  }

  function setPickEnabled(enabled) {
    pickButtons.forEach((pick) => (pick.disabled = !enabled));
  }

  function renderItem(room) {
    const added = hasRoom(room.rid);
    const item = document.createElement('li');
    const label = document.createElement('label');
    label.className = 'follow-item';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.disabled = added;
    input.checked = added;
    input.addEventListener('change', syncSubmit);
    // 与侧栏一致：没有头像或加载失败时显示昵称首字
    const avatar = document.createElement('span');
    avatar.className = 'follow-avatar';
    avatar.textContent = [...(room.nickname || '鱼')][0] || '鱼';
    if (room.avatar) {
      const image = document.createElement('img');
      image.alt = '';
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      image.src = room.avatar;
      image.addEventListener('error', () => image.remove());
      avatar.append(image);
    }
    const text = document.createElement('span');
    text.className = 'follow-text';
    const name = document.createElement('strong');
    name.textContent = room.nickname || `房间 ${room.rid}`;
    const title = document.createElement('small');
    title.textContent = `#${room.rid}${room.title ? ` · ${room.title}` : ''}`;
    text.append(name, title);
    const badge = document.createElement('span');
    badge.className = `follow-badge ${added ? 'added' : room.live ? 'live' : 'offline'}`;
    badge.textContent = added ? '已添加' : room.live ? '直播中' : '未开播';
    label.append(input, avatar, text, badge);
    item.append(label);
    return { room, input, item };
  }

  async function load() {
    const id = ++loadId;
    entries = [];
    list.replaceChildren();
    setPickEnabled(false);
    syncSubmit();
    setStatus('正在读取当前浏览器登录账号的关注列表…');
    let response;
    try {
      response = await sendExtensionMessage({ type: 'douyu-follow-list' }, { timeout: 30_000 });
    } catch (error) {
      response = { ok: false, error: error.message || '读取关注列表失败' };
    }
    if (id !== loadId || !dialog.open) return;
    if (!response?.ok) {
      setStatus(response?.error || '读取关注列表失败', { relogin: !!response?.relogin });
      return;
    }
    // 直播中的排在前面，其余保持斗鱼返回的顺序
    const rooms = [...(response.rooms || [])].sort((a, b) => Number(b.live) - Number(a.live));
    entries = rooms.map(renderItem);
    list.replaceChildren(...entries.map((entry) => entry.item));
    const liveCount = rooms.filter((room) => room.live).length;
    const addedCount = entries.length - selectable().length;
    setStatus(rooms.length
      ? `共关注 ${rooms.length} 个直播间，${liveCount} 个直播中，${addedCount} 个已在当前方案。`
      : '这个账号还没有关注任何直播间。');
    setPickEnabled(selectable().length > 0);
    syncSubmit();
  }

  for (const pick of pickButtons) {
    pick.addEventListener('click', () => {
      const mode = pick.dataset.followPick;
      for (const entry of selectable()) {
        entry.input.checked = mode === 'all' || (mode === 'live' && entry.room.live);
      }
      syncSubmit();
    });
  }

  button.addEventListener('click', async () => {
    const result = dialogResult(dialog);
    load();
    if ((await result) !== 'confirm') {
      loadId++;
      return;
    }
    const picked = selectable().filter((entry) => entry.input.checked).map((entry) => entry.room);
    if (!picked.length) return;
    const added = onImport(picked);
    const offline = picked.filter((room) => !room.live).length;
    toast(offline
      ? `已导入 ${added} 个直播间，其中 ${offline} 个未开播，可在筛选中切换到「全部」查看`
      : `已导入 ${added} 个直播间`);
  });
}
