// 单个直播窗口：播放器 + 弹幕 + 独立音量/弹幕控制
import { Player } from './player.js';
import { DanmakuClient } from './danmaku-client.js';
import { DanmakuRenderer } from './danmaku-render.js';
import { DanmakuFilter } from './danmaku-filter.js';
import { RoomRecorder } from './flv-recorder.js';
import { fetchJson, isAbortError } from './net.js';

import { resolveGift } from './gift-config.js';
import { normalizeGiftValueFilter } from './state.js';

const FALLBACK_AVATAR = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"%3E%3Crect width="32" height="32" rx="16" fill="%233b5b86"/%3E%3Ccircle cx="16" cy="12" r="6" fill="%23d6e4f5"/%3E%3Cpath d="M5 30c2-10 20-10 22 0" fill="%23d6e4f5"/%3E%3C/svg%3E';
const FALLBACK_GIFT = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="32" height="32"%3E%3Ccircle cx="16" cy="16" r="15" fill="%23f06"/%3E%3Cpath d="M5 20 13 12 18 17 24 8 29 25H5Z" fill="%23ffd66b"/%3E%3C/svg%3E';

const tpl = document.getElementById('tileTpl');

// 斗鱼取流接口 error=-5 表示主播未开播（见 douyu.js 的 ERRORS）。
const STREAM_OFFLINE_CODE = -5;
function isStreamOfflineError(error) {
  return Number(error?.code) === STREAM_OFFLINE_CODE;
}

// 鼠标进入、移动或点击后显示工具栏，窗口内停止操作 1 秒隐藏，移出立即隐藏上下两条。
// 每个窗口独立计时，按住指针或键盘操作控件期间会不断续期，因此不会中途消失。
const CONTROLS_HIDE_DELAY = 1_000;
const CONTROLS_ACTIVITY_EVENTS = ['pointermove', 'pointerdown', 'click', 'wheel'];

export class Tile {
  // state: { rid, title, nickname, avatar, rate, volume, muted, danmaku, opacity, expanded }
  constructor(state, {
    onChange,
    onRemove,
    onInfo,
    onSolo,
    onState,
    onVisibility,
    onFocus,
    onDanmaku,
    onRates,
    onPiP,
    onAggregate,
    onRanks,
    onGifts,
    onRecord,
    danmakuConfig,
  }) {
    this.s = {
      rate: 0,
      volume: 60,
      muted: true,
      danmaku: true,
      opacity: 1,
      expanded: false,
      ...state,
    };
    // 直播状态必须以本次请求为准，不能使用 localStorage 里的旧值。
    delete this.s.live;
    this.onChange = onChange;
    this.onRemove = onRemove;
    this.onInfo = onInfo || (() => {});
    this.onSolo = onSolo || (() => {});
    this.onState = onState || (() => {});
    this.onVisibility = onVisibility || (() => {});
    this.onFocus = onFocus || (() => {});
    this.onDanmaku = onDanmaku || (() => {});
    this.onRates = onRates || (() => {});
    this.onPiP = onPiP || (() => {});
    this.onAggregate = onAggregate || (() => {});
    this.onRanks = onRanks || (() => {});
    this.onGifts = onGifts || (() => {});
    this.onRecord = onRecord || (() => {});
    this.recorder = new RoomRecorder({
      getName: () => ({ nickname: this.s.nickname, rid: this.s.rid }),
      onEvent: (event) => this.onRecorderEvent(event),
    });
    this.recordTimer = 0;
    // 最近一次收到的榜单，切回聊天窗时先显示，等待下一次推送更新
    this.ranks = {};
    this.ranksWanted = false;
    this.live = null;
    this.destroyed = false;
    this.loadSeq = 0;
    this.loadController = null;
    this.visible = true;
    this.availableRates = [];
    this.ecoSuspended = false;
    this.controlsTimer = 0;
    this.controlsVisible = false;
    this.pointerPressed = false;
    this.controlsAbort = null;

    this.el = tpl.content.firstElementChild.cloneNode(true);
    this.el.dataset.rid = this.s.rid;
    this.el.tabIndex = -1;
    const q = (sel) => this.el.querySelector(sel);
    this.$ = {
      avatar: q('[data-avatar]'),
      title: q('[data-title]'),
      nickname: q('[data-nickname]'),
      watermark: q('[data-watermark]'),
      stats: q('[data-stats]'),
      watermarkNoble: q('[data-watermark-noble]'),
      rid: q('[data-rid]'),
      status: q('[data-status]'),
      video: q('[data-video]'),
      canvas: q('[data-danmaku]'),
      giftLog: q('[data-gift-log]'),
      overlay: q('[data-overlay]'),
      overlayMsg: q('[data-overlay-msg]'),
      retryBtn: q('[data-retry-btn]'),
      playBtn: q('[data-play-btn]'),
      vol: q('[data-volume]'),
      volNum: q('[data-volnum]'),
      opacity: q('[data-opacity]'),
      rate: q('[data-rate]'),
      mute: q('[data-act="mute"]'),
      dan: q('[data-act="danmaku"]'),
      solo: q('[data-act="solo"]'),
      focus: q('[data-act="focus"]'),
      pip: q('[data-act="pip"]'),
      aggregate: q('[data-act="aggregate"]'),
      record: q('[data-act="record"]'),
      gift: q('[data-act="gift"]'),
    };
    this.updateTitleLink(this.s.title || '加载中…');
    this.$.nickname.textContent = this.s.nickname || '';
    this.$.watermark.textContent = this.s.nickname || '';
    this.$.watermark.hidden = !this.s.nickname?.trim();
    this.stats = { noble: null };
    this.gifts = [];
    this.giftRows = new Map();
    this.giftExitTimers = new Map();
    this.giftsEnabled = true;
    this.giftNameFilter = [];
    this.renderStats();
    this.$.rid.textContent = `房间 ${this.s.rid}`;
    if (this.s.avatar) this.$.avatar.src = this.s.avatar;
    this.$.avatar.addEventListener('error', () => (this.$.avatar.hidden = true));
    this.$.pip.hidden = !(document.pictureInPictureEnabled && this.$.video.requestPictureInPicture);

    this.renderer = new DanmakuRenderer(this.$.canvas);
    this.danmakuFilter = new DanmakuFilter(danmakuConfig);
    this.player = new Player(this.$.video, {
      getUrl: ({ signal } = {}) => this.fetchUrl({ signal }),
      onState: (e) => this.onPlayerState(e),
      onStreamData: (chunk, token) => this.onStreamData(chunk, token),
      isRecording: () => this.recorder.armed,
    });

    this.bindEvents();
    this.bindControlsAutoHide();
    this.applyAudio();
    this.applyDanmaku();
    if (this.s.expanded) this.el.classList.add('expanded');

    if ('IntersectionObserver' in window) {
      this.visibilityObserver = new IntersectionObserver(([entry]) => {
        const visible = !!entry?.isIntersecting;
        if (this.visible === visible) return;
        this.visible = visible;
        this.player.setFrameVisible(visible);
        this.renderer.setActive(visible && !document.hidden);
        this.onVisibility(this, visible);
      }); // 帧停滞检测需要真实视口可见性，不能把视口外预留区域算作可见。
      this.visibilityObserver.observe(this.el);
    }
  }

  bindEvents() {
    // 标题是外部链接，点击时不应启动标题栏的拖拽排序。
    this.$.title.addEventListener('mousedown', (e) => e.stopPropagation());
    this.el.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      const map = {
        remove: () => this.onRemove(this),
        reload: () => this.reload(),
        play: () => this.$.video.play().catch(() => {}),
        mute: () => this.setMuted(!this.s.muted),
        danmaku: () => this.setDanmaku(!this.s.danmaku),
        solo: () => this.onSolo(this),
        aggregate: () => this.onAggregate(this),
        record: () => this.toggleRecord(),
        gift: () => this.setGiftsEnabled(!this.giftsEnabled),
        focus: () => this.onFocus(this),
        pip: () => this.togglePictureInPicture(),
        expand: () => this.toggleExpand(),
        fullscreen: () => this.el.querySelector('[data-stage]').requestFullscreen?.(),
      };
      map[act]?.();
    });

    this.$.vol.addEventListener('input', () => this.setVolume(Number(this.$.vol.value)));
    this.$.opacity.addEventListener('input', () => this.setOpacity(Number(this.$.opacity.value) / 100));
    this.$.rate.addEventListener('change', () => {
      this.setRate(Number(this.$.rate.value));
      // 选完清晰度就交还焦点，否则下拉框会继续吞掉全局快捷键
      this.$.rate.blur();
    });
    // 点画面：没在播就起播，否则切静音（多窗口下最顺手的操作）
    this.$.video.addEventListener('click', () => {
      if (this.$.video.paused) this.$.video.play().catch(() => {});
      else this.setMuted(!this.s.muted);
    });
    this.$.video.addEventListener('enterpictureinpicture', () => {
      this.$.pip.classList.add('on');
      this.$.pip.setAttribute('aria-label', '退出画中画');
      this.onPiP(this, true);
    });
    this.$.video.addEventListener('leavepictureinpicture', () => {
      this.$.pip.classList.remove('on');
      this.$.pip.setAttribute('aria-label', '进入画中画');
      this.onPiP(this, false);
    });
  }

  // —— 上下工具栏的显示与自动隐藏 ——
  // 只有真实操作（移动、点击、滚轮、输入、按键）才会续期；悬停或焦点本身不算，
  // 否则点击后焦点留在按钮上会让工具栏永远不隐藏。
  bindControlsAutoHide() {
    this.controlsAbort = new AbortController();
    const { signal } = this.controlsAbort;
    for (const type of CONTROLS_ACTIVITY_EVENTS) {
      this.el.addEventListener(type, () => this.showControls(), { passive: true, signal });
    }
    this.el.addEventListener('mouseleave', () => this.hideControls(), { signal });
    this.el.addEventListener('pointerdown', () => {
      this.pointerPressed = true;
      this.showControls();
    }, { passive: true, signal });
    this.el.addEventListener('pointerup', () => {
      this.pointerPressed = false;
      this.keepControlsVisible();
    }, { signal });
    // 按住指针拖动滑块时不会持续触发 pointermove，靠 pointerPressed 保持显示
    this.el.addEventListener('input', () => this.keepControlsVisible(), { signal });
    this.el.addEventListener('change', () => this.keepControlsVisible(), { signal });
    this.el.addEventListener('keydown', () => {
      this.showControls();
    }, { signal });
    this.el.addEventListener('focusout', () => this.scheduleControlsHide(), { signal });
    // 指针在窗口外松开也要清掉按住状态，避免工具栏卡在显示状态
    document.addEventListener('pointerup', () => {
      if (!this.pointerPressed) return;
      this.pointerPressed = false;
      this.scheduleControlsHide();
    }, { signal });
  }

  showControls() {
    if (!this.controlsVisible) {
      this.controlsVisible = true;
      this.el.classList.add('controls-visible');
    }
    this.keepControlsVisible();
  }

  hideControls() {
    clearTimeout(this.controlsTimer);
    this.controlsTimer = 0;
    if (!this.controlsVisible) return;
    this.controlsVisible = false;
    this.el.classList.remove('controls-visible');
  }

  // 每次操作都重新计时；按住指针期间继续续期，键盘仅由实际按键续期。
  keepControlsVisible() {
    clearTimeout(this.controlsTimer);
    this.controlsTimer = setTimeout(() => {
      this.controlsTimer = 0;
      if (this.pointerPressed) {
        this.keepControlsVisible();
        return;
      }
      this.hideControls();
    }, CONTROLS_HIDE_DELAY);
  }

  scheduleControlsHide() {
    if (!this.controlsVisible) return;
    this.keepControlsVisible();
  }

  // —— 数据加载 ——
  async fetchUrl({ signal } = {}) {
    let j;
    try {
      j = await fetchJson(`/api/stream?rid=${this.s.rid}&rate=${this.s.rate}`, { signal });
    } catch (e) {
      // 下播后重连取流会得到 -5；按下播处理，否则只会无限重连且不会被自动隐藏。
      // showOffline 会让播放器换代，这次加载随后的失败会被忽略。
      if (isStreamOfflineError(e)) this.markStreamOffline();
      throw e;
    }
    // 每次取流都同步清晰度列表：斗鱼返回的 multirates 会变，首次可能为空
    this.fillRates(j.stream.rates, j.stream.rate);
    return j.stream.url;
  }

  // reason 记入播放器诊断，用来区分手动重载、开播通知、切清晰度等来源。
  async load(reason = 'initial') {
    const seq = ++this.loadSeq;
    this.loadController?.abort();
    const controller = new AbortController();
    this.loadController = controller;
    this.player.setExternalState('loading');
    try {
      const j = await fetchJson(
        `/api/resolve?input=${encodeURIComponent(this.s.rid)}&rate=${this.s.rate}`,
        { signal: controller.signal }
      );
      if (this.destroyed || seq !== this.loadSeq) return;

      this.updateRoomInfo(j);
      this.setRoomLive(j.live);

      this.connectDanmaku();

      if (!j.stream) {
        this.showOffline(j.reason);
        return;
      }
      this.fillRates(j.stream.rates, j.stream.rate);
      this.hideOverlay();
      // /api/resolve 已给出有效流地址，首播直接使用，避免紧接着再签一次 /api/stream。
      this.player.reload({ initialUrl: j.stream.url, signal: controller.signal, reason });
    } catch (e) {
      if (isAbortError(e)) return;
      if (this.destroyed || seq !== this.loadSeq) return;
      // 房间接口仍报开播、取流却已返回未开播（刚下播时常见），同样按下播处理。
      if (isStreamOfflineError(e)) {
        this.markStreamOffline();
        return;
      }
      this.player.setExternalState('error', e.message || '加载失败');
      this.onInfo(this);
    } finally {
      if (this.loadController === controller) this.loadController = null;
    }
  }

  updateRoomInfo(info) {
    let changed = false;
    for (const key of ['rid', 'title', 'nickname', 'avatar']) {
      const next = String(info[key] || '');
      if (next && this.s[key] !== next) {
        this.s[key] = next;
        changed = true;
      }
    }

    this.el.dataset.rid = this.s.rid;
    this.updateTitleLink(this.s.title || `房间 ${this.s.rid}`);
    this.$.nickname.textContent = this.s.nickname || '';
    this.$.watermark.textContent = this.s.nickname || '';
    this.$.watermark.hidden = !this.s.nickname?.trim();
    this.$.rid.textContent = `房间 ${this.s.rid}`;
    if (this.s.avatar && this.$.avatar.src !== this.s.avatar) this.$.avatar.src = this.s.avatar;

    if (changed) this.onChange();
    this.onInfo(this);
  }

  updateTitleLink(title) {
    this.$.title.textContent = title;
    this.$.title.href = `https://www.douyu.com/${encodeURIComponent(this.s.rid)}`;
    this.$.title.title = `${title}（在新标签页打开）`;
    this.$.title.setAttribute('aria-label', `${title}，在新标签页打开直播间`);
  }

  setRoomLive(live) {
    const next = !!live;
    if (this.live === next) return false;
    this.live = next;
    this.onInfo(this);
    return true;
  }

  markStreamOffline() {
    if (this.destroyed) return;
    this.setRoomLive(false);
    this.showOffline(undefined, { cancelLoad: true });
  }

  showOffline(message = '主播未开播', { cancelLoad = false } = {}) {
    if (cancelLoad) {
      this.loadSeq++;
      this.loadController?.abort();
    }
    this.player.stop('offline');
    this.recorder.endSession();
    this.player.setExternalState('offline', message);
    this.setStatus('未开播', 'err');
    this.showOverlay(message || '主播未开播');
  }

  applyRoomInfo(info) {
    if (this.destroyed) return;
    const wasLive = this.live;
    this.updateRoomInfo(info);
    this.setRoomLive(info.live);
    // 弹幕的 rss 事件并不保证每次都能收到，用房间接口兜底开/关播变化。
    if (info.live && wasLive === false && !this.ecoSuspended) this.load('live-poll');
    else if (!info.live && wasLive !== false) this.showOffline(undefined, { cancelLoad: true });
  }

  fillRates(rates, current) {
    if (!rates?.length) return;
    const sig = rates.map((r) => `${r.rate}:${r.name}`).join(',');
    if (sig === this.rateSig) return; // 列表没变就不重建，避免打断用户操作
    this.rateSig = sig;
    this.availableRates = rates.map((rate) => ({ ...rate, name: String(rate.name || '') }));
    this.$.rate.replaceChildren(...this.availableRates.map((rate) => {
      const option = document.createElement('option');
      option.value = String(rate.rate);
      option.textContent = rate.name;
      return option;
    }));
    // 记住的清晰度可能已不在列表里，回落到当前实际码率
    const want = String(this.s.rate);
    this.$.rate.value = [...this.$.rate.options].some((o) => o.value === want)
      ? want
      : String(current ?? 0);
    this.s.rate = Number(this.$.rate.value);
    this.onRates(this);
  }

  connectDanmaku() {
    if (this.dm) return;
    this.dm = new DanmakuClient(this.s.rid, {
      onChat: (c) => { if (this.danmakuFilter.accept(c.text, Date.now(), c.level)) this.handleDanmaku(c); },
      onGift: (gift) => this.handleGift(gift),
      onRanks: (rank) => this.handleRanks(rank),
      onStats: (stat) => {
        if (stat.type === 'noble') this.stats.noble = stat.value;
        if (stat.type === 'noble') this.renderStats();
      },
      onStatus: (e) => {
        if (e.type === 'open' || e.type === 'close') {
          this.stats.noble = null;
          this.renderStats();
        }
        if (e.type !== 'live') return;
        const changed = this.setRoomLive(e.live);
        if (!changed) return;
        if (e.live) this.load('live-notice');
        else this.showOffline(undefined, { cancelLoad: true });
      },
    });
    this.dm.setRanksWanted(this.ranksWanted);
    this.dm.connect();
  }

  // rank: { type, count?, list? }；只带人数的消息不覆盖已有列表
  handleRanks(rank) {
    const previous = this.ranks[rank.type] || {};
    this.ranks[rank.type] = {
      count: rank.count ?? previous.count ?? null,
      list: rank.list ?? previous.list ?? null,
      updatedAt: rank.list ? Date.now() : previous.updatedAt || 0,
    };
    this.onRanks(this, rank.type);
  }

  // 聚会统计用：取一次榜单快照更新贵宾 / 钻粉人数，客户端自带频率限制
  refreshRankSnapshot() {
    this.dm?.fetchRankSnapshot();
  }

  setRanksWanted(wanted) {
    this.ranksWanted = !!wanted;
    this.dm?.setRanksWanted(this.ranksWanted);
  }

  renderStats() {
    this.$.watermarkNoble.textContent = `贵宾数：${this.stats.noble ?? '--'}`;
  }

  handleDanmaku(chat) {
    this.onDanmaku(this, chat);
  }

  handleGift(gift) {
    // Preserve socket order even when gift metadata requests finish out of order.
    const resolved = resolveGift(gift, this.s.rid);
    const previous = this.giftPending || Promise.resolve();
    const pending = Promise.all([previous.catch(() => {}), resolved]).then(([, item]) => {
      if (!this.destroyed) this.acceptGift(item);
    });
    this.giftPending = pending;
    return pending;
  }

  acceptGift(gift) {
    if (this.giftNameFilter.some((name) => String(gift.giftName || '').includes(name))) return;
    if (this.giftValueFilter != null && Number.isFinite(gift.value) && gift.value < this.giftValueFilter) return;
    const now = Date.now();
    this.expireGifts(now);
    const key = JSON.stringify([gift.userId ? `uid:${gift.userId}` : `name:${gift.user || ''}`,
      gift.id ? `gift:${gift.id}` : gift.propId ? `prop:${gift.propId}` : `name:${gift.giftName || ''}`]);
    // 礼物最多停留 30 秒。
    const durationMs = Number.isFinite(gift.durationMs) && gift.durationMs > 0 ? Math.min(gift.durationMs, 30000) : 5000;
    const count = Number.isFinite(gift.count) && gift.count > 0 ? gift.count : 1;
    const existing = this.gifts.find((item) => item.key === key);
    if (existing) {
      existing.count += count;
      existing.value = gift.value ?? existing.value;
      existing.time = now;
      existing.durationMs = durationMs;
      existing.expiresAt = now + durationMs;
    } else {
      const item = { ...gift, key, count, time: now, createdAt: now, durationMs, expiresAt: now + durationMs, meta: { image: gift.image } };
      const value = entry => (Number.isFinite(entry.value) && entry.value > 0 ? entry.value : 0) * entry.count;
      if (this.gifts.length >= 5) {
        const lowest = this.gifts.reduce((a, b) => value(b) < value(a) ||
          (value(b) === value(a) && (b.createdAt ?? b.time) < (a.createdAt ?? a.time)) ? b : a);
        if (value(item) < value(lowest)) { this.renderGifts(); this.scheduleGiftExpiry(); return; }
        this.removeGiftRow(lowest.key);
        this.gifts = this.gifts.filter(entry => entry !== lowest);
      }
      // A fading row still occupies visual space. Release it before adding a sixth row.
      const activeKeys = new Set(this.gifts.map(entry => entry.key));
      for (const oldKey of this.giftRows?.keys() || []) {
        if (oldKey === key || (this.giftRows.size >= 5 && !activeKeys.has(oldKey))) this.removeGiftRow(oldKey);
      }
      this.gifts.push(item);
    }
    this.renderGifts();
    this.scheduleGiftExpiry();
  }

  removeGiftRow(key) {
    clearTimeout(this.giftExitTimers?.get(key));
    this.giftExitTimers?.delete(key);
    this.giftRows?.get(key)?.remove();
    this.giftRows?.delete(key);
  }

  expireGifts(now) {
    const deadline = item => item.expiresAt ?? item.time + 5000;
    this.gifts.filter(item => deadline(item) <= now).forEach(item => this.fadeGift(item));
    this.gifts = this.gifts.filter(item => deadline(item) > now);
  }

  scheduleGiftExpiry() {
    clearTimeout(this.giftHideTimer);
    this.giftHideTimer = 0;
    if (this.destroyed || !this.gifts.length) return;
    const delay = Math.max(0, Math.min(...this.gifts.map(item => item.expiresAt ?? item.time + 5000)) - Date.now());
    this.giftHideTimer = setTimeout(() => {
      if (this.destroyed) return;
      this.expireGifts(Date.now());
      this.renderGifts();
      this.scheduleGiftExpiry();
    }, delay);
  }

  renderGifts() {
    if (!this.$.giftLog) return;
    if (!this.giftRows) this.giftRows = new Map();
    const giftKey = (gift) => gift.key || `${gift.user || ''}|${gift.id || gift.giftName || ''}`;
    const activeKeys = new Set(this.gifts.map(giftKey));
    this.gifts.forEach((gift) => {
      const key = giftKey(gift);
      const exitTimer = this.giftExitTimers?.get(key);
      if (exitTimer) {
        clearTimeout(exitTimer);
        this.giftExitTimers.delete(key);
      }
      let row = this.giftRows.get(key);
      if (!row) {
        row = document.createElement('div');
        row.className = 'gift-item';
        this.giftRows.set(key, row);
      }
      row.classList.remove('gift-item-exit');
      if (!row.firstChild) {
      const avatar = document.createElement('img'); avatar.className = 'gift-avatar'; avatar.alt = ''; avatar.src = gift.avatar || this.s.avatar || FALLBACK_AVATAR;
      avatar.onerror = () => { avatar.onerror = null; avatar.src = FALLBACK_AVATAR; };
      const text = document.createElement('div'); text.className = 'gift-copy';
      const user = document.createElement('strong'); user.textContent = gift.user || '匿名用户';
      const name = document.createElement('span'); name.textContent = `送出 ${gift.giftName || '礼物'}`;
      text.append(user, name);
      const image = document.createElement('img'); image.className = 'gift-image'; image.alt = gift.giftName || '礼物';
      image.src = gift.meta?.image || FALLBACK_GIFT;
      if (!gift.meta?.image) image.classList.add('gift-image-fallback');
      image.onerror = () => {
        image.onerror = null;
        if (gift.meta) { gift.meta.image = ''; gift.meta.failed = true; }
        image.src = FALLBACK_GIFT;
        image.classList.add('gift-image-fallback');
      };
      const count = document.createElement('b'); count.className = 'gift-count'; count.textContent = `×${gift.count || 1}`;
      row.append(avatar, text, image, count);
      }
      const countText = `×${gift.count || 1}`;
      const countNode = row.querySelector('.gift-count');
      if (countNode.textContent !== countText) countNode.textContent = countText;
      // Existing rows stay attached so their entrance and image animations keep running.
      if (row.parentNode !== this.$.giftLog) this.$.giftLog.append(row);
    });
    [...this.giftRows].forEach(([key, row]) => {
      if (!activeKeys.has(key) && !row.classList.contains('gift-item-exit')) {
        row.remove();
        this.giftRows.delete(key);
      }
    });
    this.$.giftLog.hidden = !this.giftsEnabled || this.gifts.length === 0;
    this.$.gift?.classList.toggle('on', this.giftsEnabled);
  }

  fadeGift(gift) {
    if (!gift?.key) return;
    const row = this.giftRows?.get(gift.key);
    if (!row) return;
    row.classList.add('gift-item-exit');
    clearTimeout(this.giftExitTimers?.get(gift.key));
    if (!this.giftExitTimers) this.giftExitTimers = new Map();
    this.giftExitTimers.set(gift.key, setTimeout(() => {
      row.remove();
      this.giftRows.delete(gift.key);
      this.giftExitTimers.delete(gift.key);
    }, 300));
  }

  setGiftsEnabled(enabled) {
    this.giftsEnabled = !!enabled;
    this.renderGifts();
    this.onGifts(this);
  }

  setGiftNameFilter(value) {
    this.giftNameFilter = String(value || '').split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean);
  }

  setGiftValueFilter(value) {
    this.giftValueFilter = normalizeGiftValueFilter(value);
  }

  pushDanmaku(text, color) {
    this.renderer.push(text, color);
  }

  setAggregate(on) {
    const active = !!on;
    this.el.classList.toggle('aggregate-active', active);
    this.$.aggregate.classList.toggle('on', active);
    this.$.aggregate.setAttribute('aria-pressed', String(active));
    this.$.aggregate.title = active ? '关闭弹幕聚合' : '开启弹幕聚合';
    this.$.aggregate.setAttribute('aria-label', active ? '关闭弹幕聚合' : '开启弹幕聚合');
  }

  // —— 单直播间录制 ——
  // 开启后一直待录，直到手动停止：下播时结束当前文件，再开播自动新建文件。
  onStreamData(chunk, token) {
    this.recorder.push(chunk, token);
  }

  isRecording() {
    return this.recorder.armed;
  }

  // 必须在点击事件里同步调用：选目录对话框需要用户手势。
  toggleRecord() {
    if (this.recorder.armed) this.recorder.disarm();
    else if (this.recorder.unsupported) this.onRecord(this, { type: 'error', message: '当前流不是 FLV 格式，无法录制' });
    else this.recorder.arm();
  }

  onRecorderEvent(event) {
    if (event.type === 'armed') {
      clearInterval(this.recordTimer);
      this.recordTimer = setInterval(() => this.renderRecord(), 1000);
    } else if (event.type === 'disarmed') {
      clearInterval(this.recordTimer);
      this.recordTimer = 0;
    }
    this.renderRecord();
    if (this.destroyed && event.type !== 'saved' && event.type !== 'error') return;
    this.onRecord(this, event);
  }

  renderRecord() {
    const rec = this.recorder;
    const writing = rec.armed && !!rec.sink;
    const btn = this.$.record;
    btn.classList.toggle('recording', writing);
    btn.classList.toggle('record-waiting', rec.armed && !writing);
    btn.setAttribute('aria-pressed', String(rec.armed));
    const total = `${formatDuration(Date.now() - rec.startedAt)}，${formatBytes(rec.bytes)}，${rec.files} 个文件`;
    const label = !rec.armed ? '录制此直播间'
      : writing ? `录制中，点击停止（已开启 ${total}）`
        : `等待开播后自动录制，点击停止${rec.files ? `（已开启 ${total}）` : ''}`;
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }

  onPlayerState({ state, message }) {
    if (state === 'progress') {
      // 画面在推进就不该有任何遮罩。高频事件，只在遮罩真开着时才动 DOM
      if (!this.$.overlay.hidden) {
        this.hideOverlay();
        this.setStatus('直播中', 'live');
      }
      return;
    }
    if (state === 'playing') {
      this.setStatus('直播中', 'live');
      this.hideOverlay();
    } else if (state === 'loading') {
      this.setStatus('缓冲中', '');
    } else if (state === 'blocked') {
      // 浏览器拦了自动播放，给一个明确的点击入口
      this.setStatus('待播放', '');
      this.showOverlay('浏览器拦截了自动播放', { play: true });
    } else if (state === 'retrying') {
      this.setStatus('重连中', 'err');
      this.showOverlay(message);
    } else if (state === 'error') {
      this.setStatus('出错', 'err');
      this.showOverlay(message);
    } else if (state === 'suspended') {
      this.setStatus('已暂停', '');
      this.showOverlay(message || '已暂停');
    } else if (state === 'offline') {
      this.setStatus('未开播', 'err');
    }
    this.onState(this, { state, message });
  }

  setStatus(text, cls) {
    this.$.status.textContent = text;
    this.$.status.className = `badge${cls ? ' ' + cls : ''}`;
  }

  showOverlay(msg, { play = false } = {}) {
    this.$.overlayMsg.textContent = msg || '';
    this.$.playBtn.hidden = !play;
    this.$.retryBtn.hidden = play;
    this.$.overlay.hidden = false;
  }

  hideOverlay() {
    this.$.overlay.hidden = true;
  }

  // —— 独立控制 ——
  applyAudio() {
    const audioActive = !this.s.muted && this.s.volume > 0;
    this.$.video.muted = this.s.muted;
    this.$.video.volume = this.s.volume / 100;
    this.$.vol.value = String(this.s.volume);
    this.$.volNum.textContent = this.s.muted ? '0' : String(this.s.volume);
    this.$.mute.querySelector('use')?.setAttribute('href', this.s.muted ? '#icon-volume-off' : '#icon-volume');
    this.$.mute.classList.toggle('on', !this.s.muted);
    this.$.mute.setAttribute('aria-pressed', String(!this.s.muted));
    this.el.classList.toggle('audio-active', audioActive);
  }

  setMuted(muted) {
    this.s.muted = !!muted;
    // 从静音里出来时音量为 0，给个能听见的默认值
    if (!this.s.muted && this.s.volume === 0) this.s.volume = 50;
    this.applyAudio();
    this.onChange();
  }

  setVolume(v) {
    this.s.volume = Math.max(0, Math.min(100, v));
    if (this.s.volume > 0 && this.s.muted) this.s.muted = false;
    if (this.s.volume === 0) this.s.muted = true;
    this.applyAudio();
    this.onChange();
  }

  applyDanmaku() {
    this.renderer.setEnabled(this.s.danmaku);
    this.renderer.setOpacity(this.s.opacity);
    this.$.opacity.value = String(Math.round(this.s.opacity * 100));
    this.$.opacity.disabled = !this.s.danmaku;
    this.$.dan.classList.toggle('on', this.s.danmaku);
    this.$.dan.setAttribute('aria-pressed', String(this.s.danmaku));
  }

  setDanmaku(on) {
    this.s.danmaku = !!on;
    this.applyDanmaku();
    this.onChange();
  }

  setOpacity(v) {
    this.s.opacity = v;
    this.renderer.setOpacity(v);
    this.onChange();
  }

  setDanmakuSpeed(speed) {
    this.renderer.setSpeed(speed);
  }

  setSolo(on) {
    this.el.classList.toggle('solo-active', !!on);
    this.$.solo.classList.toggle('on', !!on);
    this.$.solo.textContent = on ? '独听中' : '独听';
    this.$.solo.setAttribute('aria-label', on ? '退出独听' : '独听');
    this.$.solo.setAttribute('aria-pressed', String(!!on));
  }

  async setRate(rate) {
    this.s.rate = rate;
    this.onChange();
    this.player.reload({ reason: 'rate' });
  }

  setRateByName(name) {
    const normalized = String(name || '').trim().toLocaleLowerCase('zh-CN');
    const rate = this.availableRates.find(
      (item) => item.name.trim().toLocaleLowerCase('zh-CN') === normalized
    );
    if (!rate) return false;
    if (Number(rate.rate) !== Number(this.s.rate)) this.setRate(Number(rate.rate));
    return true;
  }

  setFocused(on) {
    this.el.classList.toggle('focus-main', !!on);
    this.$.focus.classList.toggle('on', !!on);
    this.$.focus.setAttribute('aria-pressed', String(!!on));
    this.$.focus.title = on ? '取消焦点画面' : '设为焦点画面';
    this.$.focus.setAttribute('aria-label', on ? '取消焦点画面' : '设为焦点画面');
  }

  toggleExpand() {
    this.s.expanded = !this.s.expanded;
    this.el.classList.toggle('expanded', this.s.expanded);
    this.onChange();
  }

  reload() {
    this.ecoSuspended = false;
    this.el.classList.remove('eco-suspended');
    this.hideOverlay();
    this.load('manual');
  }

  suspendForEco() {
    if (this.destroyed || this.ecoSuspended || this.isPictureInPicture()) return;
    this.ecoSuspended = true;
    this.loadController?.abort();
    this.player.stop('eco');
    this.player.setExternalState('suspended', '已节能暂停');
    this.dm?.close();
    this.dm = null;
    this.stats.noble = null;
    this.renderStats();
    this.renderer.setActive(false);
    this.el.classList.add('eco-suspended');
    this.setStatus('节能暂停', '');
    this.showOverlay('已节能暂停，回到画面后自动恢复');
    this.onState(this, { state: 'suspended', message: '已节能暂停' });
  }

  resumeFromEco() {
    if (!this.ecoSuspended || this.destroyed) return;
    this.ecoSuspended = false;
    this.el.classList.remove('eco-suspended');
    this.renderer.setActive(this.visible && !document.hidden);
    this.load('eco-resume');
  }

  isPictureInPicture() {
    return document.pictureInPictureElement === this.$.video;
  }

  async togglePictureInPicture() {
    try {
      if (this.isPictureInPicture()) await document.exitPictureInPicture();
      else {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        await this.$.video.requestPictureInPicture();
      }
    } catch (error) {
      this.onState(this, { state: this.player.state, message: `画中画失败：${error?.message || error}` });
    }
  }

  setPageVisible(visible) {
    this.player.setPageVisible(visible);
    this.renderer.setActive(visible && this.visible);
  }

  setOnline(online) {
    this.player.setOnline(online);
  }

  diagnostics() {
    return {
      rid: this.s.rid,
      title: this.s.title || `房间 ${this.s.rid}`,
      rateName: this.$.rate.selectedOptions[0]?.textContent || '',
      ...this.player.diagnostics(),
    };
  }

  // 拖拽会把 video 元素移动到新父节点，浏览器会因此暂停播放，需要主动续上
  resume() {
    const v = this.$.video;
    if (v.paused && v.readyState >= 2) v.play().catch(() => {});
  }

  destroy() {
    this.destroyed = true;
    this.loadSeq++;
    this.loadController?.abort();
    clearTimeout(this.controlsTimer);
    clearTimeout(this.giftHideTimer);
    this.giftExitTimers?.forEach((timer) => clearTimeout(timer));
    this.controlsTimer = 0;
    this.controlsAbort?.abort();
    this.controlsAbort = null;
    this.visibilityObserver?.disconnect();
    if (this.isPictureInPicture()) document.exitPictureInPicture?.().catch(() => {});
    // 关窗时保存已录内容，不能丢弃。
    this.recorder.disarm();
    clearInterval(this.recordTimer);
    this.player.destroy();
    this.renderer.destroy();
    this.dm?.close();
    this.el.remove();
  }
}

function formatBytes(bytes) {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(2)} GB`;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function formatDuration(ms) {
  const total = Math.floor(ms / 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
}
