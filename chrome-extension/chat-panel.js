// 右侧聊天窗：显示所选已打开直播间的实时弹幕；扩展版可用浏览器登录的斗鱼账号发弹幕
import { isExtensionPage, sendExtensionMessage } from './net.js';

const MAX_MESSAGES = 200;
const LOGIN_URL = 'https://www.douyu.com/';
const $ = (id) => document.getElementById(id);

export class ChatPanel {
  constructor({ onSelect = () => {} } = {}) {
    this.onSelect = onSelect;
    this.select = $('chatRoomSelect');
    this.list = $('chatList');
    this.empty = $('chatEmpty');
    this.form = $('chatForm');
    this.input = $('chatInput');
    this.sendBtn = $('chatSendBtn');
    this.auth = $('chatAuth');
    this.hint = $('chatHint');
    this.extension = isExtensionPage();
    this.rooms = [];
    this.roomsKey = '';
    this.rid = '';
    this.preferredRid = '';
    this.visible = false;
    this.account = null;
    this.sending = false;
    this.queue = [];
    this.flushRaf = 0;
    this.hintTimer = 0;

    this.select.addEventListener('change', () => {
      this.preferredRid = '';
      this.selectRoom(this.select.value);
    });
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submit();
    });
    window.addEventListener('focus', () => { if (this.visible) this.refreshAuth(); });
    this.renderAuth();
    this.syncInput();
  }

  // 方案恢复时指定上次选择的房间；该房间打开后自动选中
  setPreferredRid(rid) {
    this.preferredRid = String(rid || '');
  }

  get selectedRid() {
    return this.rid || this.preferredRid;
  }

  // rooms: [{ rid, label }]，按播放窗口顺序
  setRooms(rooms) {
    const key = rooms.map((room) => `${room.rid}\u0000${room.label}`).join('\u0001');
    const rids = new Set(rooms.map((room) => room.rid));
    let next = this.rid;
    if (this.preferredRid && rids.has(this.preferredRid)) {
      next = this.preferredRid;
      this.preferredRid = '';
    } else if (!rids.has(next)) {
      next = rooms[0]?.rid || '';
    }
    if (key !== this.roomsKey) {
      this.roomsKey = key;
      this.rooms = rooms;
      this.select.replaceChildren(...rooms.map((room) => new Option(room.label, room.rid)));
      this.select.disabled = !rooms.length;
    }
    if (next !== this.rid) this.selectRoom(next);
    this.select.value = this.rid;
    this.empty.hidden = !!rooms.length;
  }

  selectRoom(rid) {
    const value = String(rid || '');
    if (value === this.rid) return;
    this.rid = value;
    this.queue = [];
    this.list.replaceChildren();
    const room = this.rooms.find((item) => item.rid === value);
    if (room) this.appendSystem(`已切换到 ${room.label}，显示之后收到的弹幕`);
    this.syncInput();
    this.onSelect(value);
  }

  push(rid, chat) {
    if (!this.visible || String(rid) !== this.rid) return;
    this.queue.push(chat);
    if (this.queue.length > MAX_MESSAGES) this.queue.splice(0, this.queue.length - MAX_MESSAGES);
    if (!this.flushRaf) this.flushRaf = requestAnimationFrame(() => this.flush());
  }

  // 热门房间每秒几十条弹幕，按帧批量写入 DOM
  flush() {
    this.flushRaf = 0;
    if (!this.queue.length) return;
    const stick = this.isNearBottom();
    const fragment = document.createDocumentFragment();
    for (const chat of this.queue.splice(0)) fragment.appendChild(this.renderChat(chat));
    this.list.appendChild(fragment);
    this.trim();
    if (stick) this.list.scrollTop = this.list.scrollHeight;
  }

  renderChat(chat) {
    const item = document.createElement('div');
    item.className = 'chat-item';
    if (chat.level > 0) {
      const level = document.createElement('span');
      level.className = 'chat-level';
      level.textContent = `Lv${chat.level}`;
      item.appendChild(level);
    }
    const user = document.createElement('span');
    user.className = 'chat-user';
    user.textContent = `${chat.user || '匿名用户'}：`;
    const text = document.createElement('span');
    text.className = 'chat-text';
    text.textContent = chat.text || '';
    item.append(user, text);
    return item;
  }

  appendSystem(message) {
    const item = document.createElement('div');
    item.className = 'chat-item chat-system';
    item.textContent = message;
    this.list.appendChild(item);
    this.trim();
    this.list.scrollTop = this.list.scrollHeight;
  }

  trim() {
    while (this.list.childElementCount > MAX_MESSAGES) this.list.firstElementChild.remove();
  }

  isNearBottom() {
    return this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 40;
  }

  setVisible(visible) {
    this.visible = !!visible;
    if (this.visible) this.refreshAuth();
    else {
      this.queue = [];
      cancelAnimationFrame(this.flushRaf);
      this.flushRaf = 0;
    }
  }

  async refreshAuth() {
    if (!this.extension) return;
    try {
      const status = await sendExtensionMessage({ type: 'douyu-auth-status' }, { timeout: 5_000 });
      this.account = status?.loggedIn ? { uid: status.uid, nickname: status.nickname } : null;
    } catch {
      this.account = null;
    }
    this.renderAuth();
    this.syncInput();
  }

  renderAuth() {
    if (!this.extension) {
      this.auth.textContent = '网页版只能查看弹幕；发送弹幕请使用 Chrome 扩展版';
      return;
    }
    if (this.account) {
      this.auth.textContent = `当前账号：${this.account.nickname}`;
      return;
    }
    const link = document.createElement('a');
    link.href = LOGIN_URL;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = '去斗鱼登录';
    this.auth.replaceChildren('未登录斗鱼，', link, '后即可发弹幕');
  }

  syncInput() {
    const ready = this.extension && !!this.account && !!this.rid;
    this.input.disabled = !ready || this.sending;
    this.sendBtn.disabled = !ready || this.sending;
    if (!this.extension) this.input.placeholder = '网页版不支持发送弹幕';
    else if (!this.account) this.input.placeholder = '登录斗鱼后可发弹幕';
    else if (!this.rid) this.input.placeholder = '先打开一个直播间';
    else this.input.placeholder = '发个弹幕吧，回车发送';
  }

  showHint(message, { error = false, duration = 4000 } = {}) {
    clearTimeout(this.hintTimer);
    this.hint.textContent = message;
    this.hint.classList.toggle('error', error);
    this.hint.hidden = false;
    this.hintTimer = setTimeout(() => { this.hint.hidden = true; }, duration);
  }

  async submit() {
    const text = this.input.value.replace(/\s+/g, ' ').trim();
    if (!text || this.sending || !this.rid) return;
    this.sending = true;
    this.syncInput();
    try {
      const result = await sendExtensionMessage({ type: 'douyu-send-danmaku', rid: this.rid, text });
      if (result?.ok) {
        this.input.value = '';
        this.showHint('已发送', { duration: 1500 });
      } else {
        this.showHint(result?.error || '弹幕发送失败', { error: true });
        if (result?.relogin) this.refreshAuth();
      }
    } catch (error) {
      this.showHint(error?.message || '弹幕发送失败', { error: true });
    } finally {
      this.sending = false;
      this.syncInput();
      if (!this.input.disabled) this.input.focus();
    }
  }
}
