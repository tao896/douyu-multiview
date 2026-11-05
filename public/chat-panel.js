// 右侧聊天窗：显示所选已打开直播间的实时弹幕；扩展版可用浏览器登录的斗鱼账号发弹幕
import { isExtensionPage, sendExtensionMessage } from './net.js';
import { ChatRanks } from './chat-ranks.js';
import { DANMAKU_LEVEL_OPTIONS } from './state.js';

const MAX_MESSAGES = 200;
const LOGIN_URL = 'https://www.douyu.com/';
const $ = (id) => document.getElementById(id);
// 悬浮模式用 Document Picture-in-Picture：聊天窗移到始终置顶的独立小窗，DOM 与事件监听原样保留
const FLOAT_SUPPORTED = typeof window !== 'undefined' && 'documentPictureInPicture' in window;
const FLOAT_SIZE = { width: 340, height: 640 };

// 小窗是空白文档，复制本页样式表和图标，保证外观一致
function copyPageAssets(target) {
  for (const sheet of document.styleSheets) {
    try {
      const style = target.document.createElement('style');
      style.textContent = [...sheet.cssRules].map((rule) => rule.cssText).join('\n');
      target.document.head.append(style);
    } catch {
      if (!sheet.href) continue;
      const link = target.document.createElement('link');
      link.rel = 'stylesheet';
      link.href = sheet.href;
      target.document.head.append(link);
    }
  }
  const sprite = document.querySelector('.icon-sprite');
  if (sprite) target.document.body.append(sprite.cloneNode(true));
}

export class ChatPanel {
  constructor({
    onSelect = () => {},
    onFilter = () => {},
    onMinLevel = () => {},
    onToggleDanmaku = () => {},
    onToggleGifts = () => {},
    onStatsMode = () => {},
    onPartyRefresh = () => {},
    onFloatChange = () => {},
  } = {}) {
    this.onSelect = onSelect;
    this.onStatsMode = onStatsMode;
    this.onFloatChange = onFloatChange;
    this.ranks = new ChatRanks($('chatRanks'), { onPartyRefresh });
    this.tools = {
      level: $('chatLevelSelect'),
      danmaku: $('chatDanmakuBtn'),
      gift: $('chatGiftBtn'),
      statsMode: $('chatStatsModeBtn'),
      float: $('chatFloatBtn'),
    };
    this.panel = $('chatPanel');
    this.pipWindow = null;
    this.statsMode = 'room';
    this.tools.statsMode.addEventListener('click', () => {
      this.setStatsMode(this.statsMode === 'party' ? 'room' : 'party');
      this.onStatsMode(this.statsMode);
    });
    if (!FLOAT_SUPPORTED) {
      this.tools.float.disabled = true;
      this.tools.float.title = '当前浏览器不支持悬浮模式（需要 Chrome / Edge 116 及以上的桌面版）';
    }
    this.tools.float.addEventListener('click', () => this.setFloating(!this.floating));
    this.tools.level.replaceChildren(...DANMAKU_LEVEL_OPTIONS.map((level) =>
      new Option(level ? `屏蔽 Lv${level} 以下` : '等级不屏蔽', String(level))));
    this.tools.level.addEventListener('change', () => onMinLevel(Number(this.tools.level.value) || 0));
    $('chatFilterBtn').addEventListener('click', () => onFilter());
    this.tools.danmaku.addEventListener('click', () => { if (this.rid) onToggleDanmaku(this.rid); });
    this.tools.gift.addEventListener('click', () => { if (this.rid) onToggleGifts(this.rid); });
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
    this.setTools();
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
    this.ranks.setRoom(value);
    this.syncInput();
    this.onSelect(value);
  }

  // tools: { minLevel, danmaku, gifts }；danmaku / gifts 为 null 表示没有选中的直播间
  setTools({ minLevel = 0, danmaku = null, gifts = null } = {}) {
    this.tools.level.value = String(minLevel);
    for (const [button, on] of [[this.tools.danmaku, danmaku], [this.tools.gift, gifts]]) {
      button.disabled = on == null;
      button.classList.toggle('on', !!on);
      button.setAttribute('aria-pressed', String(!!on));
    }
  }

  setRanks(rid, ranks) {
    if (String(rid) === this.rid) this.ranks.setRanks(ranks);
  }

  push(rid, chat) {
    if (!this.visible || String(rid) !== this.rid) return;
    this.queue.push(chat);
    if (this.queue.length > MAX_MESSAGES) this.queue.splice(0, this.queue.length - MAX_MESSAGES);
    this.scheduleFlush();
  }

  // 悬浮时按小窗的帧调度：主页面切到后台后小窗仍要继续刷新
  scheduleFlush() {
    if (this.flushRaf) return;
    this.flushWin = this.pipWindow || window;
    this.flushRaf = this.flushWin.requestAnimationFrame(() => this.flush());
  }

  cancelFlush() {
    if (this.flushRaf) this.flushWin?.cancelAnimationFrame(this.flushRaf);
    this.flushRaf = 0;
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
    this.ranks.setVisible(this.visible);
    if (this.visible) this.refreshAuth();
    else {
      this.queue = [];
      this.cancelFlush();
    }
  }

  get floating() {
    return !!this.pipWindow;
  }

  setStatsMode(mode) {
    this.statsMode = mode === 'party' ? 'party' : 'room';
    const party = this.statsMode === 'party';
    const button = this.tools.statsMode;
    button.classList.toggle('on', party);
    button.setAttribute('aria-pressed', String(party));
    button.setAttribute('aria-label', party ? '切换到房间统计' : '切换到聚会统计');
    button.title = party
      ? '切换到房间统计：显示当前直播间的今日统计与榜单'
      : '切换到聚会统计：汇总所有已打开直播间的今日流水、贵宾、钻粉';
    this.ranks.setMode(this.statsMode);
  }

  // rooms: [{ rid, label, vip, diamond }]
  setPartyRooms(rooms) {
    this.ranks.setPartyRooms(rooms);
  }

  async setFloating(on) {
    if (!FLOAT_SUPPORTED || on === this.floating || this.floatPending) return;
    if (!on) {
      this.pipWindow.close(); // pagehide 里放回原位
      return;
    }
    this.floatPending = true;
    let pip;
    try {
      pip = await window.documentPictureInPicture.requestWindow(FLOAT_SIZE);
    } catch (error) {
      this.showHint(`悬浮窗打开失败：${error?.message || error}`, { error: true });
      return;
    } finally {
      this.floatPending = false;
    }
    pip.document.title = '聊天窗 - 斗鱼同屏';
    pip.document.documentElement.lang = document.documentElement.lang;
    pip.document.body.classList.add('chat-float-body');
    copyPageAssets(pip);
    this.cancelFlush();
    this.placeholder = document.createComment('chat-panel');
    this.panel.before(this.placeholder);
    this.panel.classList.add('floating');
    pip.document.body.append(this.panel);
    this.pipWindow = pip;
    pip.addEventListener('pagehide', () => this.dock(), { once: true });
    this.syncFloatButton();
    if (this.queue.length) this.scheduleFlush();
    this.list.scrollTop = this.list.scrollHeight;
    this.onFloatChange(true);
  }

  dock() {
    if (!this.pipWindow) return;
    this.cancelFlush();
    this.pipWindow = null;
    this.panel.classList.remove('floating');
    this.placeholder.replaceWith(this.panel);
    this.placeholder = null;
    this.syncFloatButton();
    if (this.queue.length) this.scheduleFlush();
    this.list.scrollTop = this.list.scrollHeight;
    this.onFloatChange(false);
  }

  syncFloatButton() {
    const button = this.tools.float;
    const on = this.floating;
    button.classList.toggle('on', on);
    button.setAttribute('aria-pressed', String(on));
    button.setAttribute('aria-label', on ? '退出悬浮模式' : '悬浮模式');
    button.title = on ? '退出悬浮模式：聊天窗放回网页右侧' : '悬浮模式：把聊天窗分离成置顶小窗，节省网页显示空间';
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
