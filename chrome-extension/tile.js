// 单个直播窗口：播放器 + 弹幕 + 独立音量/弹幕控制
import { Player } from './player.js';
import { DanmakuClient } from './danmaku-client.js';
import { DanmakuRenderer } from './danmaku-render.js';
import { fetchJson, isAbortError } from './net.js';

const tpl = document.getElementById('tileTpl');

// 鼠标进入、移动或点击后显示工具栏，停止操作 2 秒再同时隐藏上下两条。
// 每个窗口独立计时，按住指针或键盘操作控件期间会不断续期，因此不会中途消失。
const CONTROLS_HIDE_DELAY = 2_000;
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
    onData,
    onRates,
    onPiP,
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
    this.onData = onData || (() => {});
    this.onRates = onRates || (() => {});
    this.onPiP = onPiP || (() => {});
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
    this.keyboardMode = false;
    this.controlsAbort = null;

    this.el = tpl.content.firstElementChild.cloneNode(true);
    this.el.dataset.rid = this.s.rid;
    this.el.tabIndex = -1;
    const q = (sel) => this.el.querySelector(sel);
    this.$ = {
      avatar: q('[data-avatar]'),
      title: q('[data-title]'),
      nickname: q('[data-nickname]'),
      rid: q('[data-rid]'),
      status: q('[data-status]'),
      video: q('[data-video]'),
      canvas: q('[data-danmaku]'),
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
    };
    this.updateTitleLink(this.s.title || '加载中…');
    this.$.nickname.textContent = this.s.nickname || '';
    this.$.rid.textContent = `房间 ${this.s.rid}`;
    if (this.s.avatar) this.$.avatar.src = this.s.avatar;
    this.$.avatar.addEventListener('error', () => (this.$.avatar.hidden = true));
    this.$.pip.hidden = !(document.pictureInPictureEnabled && this.$.video.requestPictureInPicture);

    this.renderer = new DanmakuRenderer(this.$.canvas);
    this.player = new Player(this.$.video, {
      getUrl: ({ signal } = {}) => this.fetchUrl({ signal }),
      onState: (e) => this.onPlayerState(e),
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
        this.renderer.setActive(visible && !document.hidden);
        this.onVisibility(this, visible);
      }, { rootMargin: '100px' });
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
        focus: () => this.onFocus(this),
        data: () => this.onData(this),
        pip: () => this.togglePictureInPicture(),
        expand: () => this.toggleExpand(),
        fullscreen: () => this.el.querySelector('[data-stage]').requestFullscreen?.(),
      };
      map[act]?.();
    });

    this.$.vol.addEventListener('input', () => this.setVolume(Number(this.$.vol.value)));
    this.$.opacity.addEventListener('input', () => this.setOpacity(Number(this.$.opacity.value) / 100));
    this.$.rate.addEventListener('change', () => this.setRate(Number(this.$.rate.value)));
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
    this.el.addEventListener('pointerdown', () => {
      this.pointerPressed = true;
      this.keyboardMode = false;
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
      this.keyboardMode = true;
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

  // 每次操作都重新计时；按住指针或键盘操作控件期间继续续期。
  keepControlsVisible() {
    clearTimeout(this.controlsTimer);
    this.controlsTimer = setTimeout(() => {
      this.controlsTimer = 0;
      if (this.pointerPressed || (this.keyboardMode && this.el.contains(document.activeElement))) {
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
    const j = await fetchJson(`/api/stream?rid=${this.s.rid}&rate=${this.s.rate}`, { signal });
    // 每次取流都同步清晰度列表：斗鱼返回的 multirates 会变，首次可能为空
    this.fillRates(j.stream.rates, j.stream.rate);
    return j.stream.url;
  }

  async load() {
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
      this.player.reload({ initialUrl: j.stream.url, signal: controller.signal });
    } catch (e) {
      if (isAbortError(e)) return;
      if (this.destroyed || seq !== this.loadSeq) return;
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

  showOffline(message = '主播未开播', { cancelLoad = false } = {}) {
    if (cancelLoad) {
      this.loadSeq++;
      this.loadController?.abort();
    }
    this.player.stop();
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
    if (info.live && wasLive === false && !this.ecoSuspended) this.load();
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
      onChat: (c) => this.renderer.push(c.text, c.color),
      onStatus: (e) => {
        if (e.type !== 'live') return;
        const changed = this.setRoomLive(e.live);
        if (!changed) return;
        if (e.live) this.load();
        else this.showOffline(undefined, { cancelLoad: true });
      },
    });
    this.dm.connect();
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
    this.$.mute.textContent = this.s.muted ? '🔇' : '🔊';
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
    this.player.reload();
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
    this.load();
  }

  suspendForEco() {
    if (this.destroyed || this.ecoSuspended || this.isPictureInPicture()) return;
    this.ecoSuspended = true;
    this.loadController?.abort();
    this.player.stop();
    this.player.setExternalState('suspended', '已节能暂停');
    this.dm?.close();
    this.dm = null;
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
    this.load();
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
    this.controlsTimer = 0;
    this.controlsAbort?.abort();
    this.controlsAbort = null;
    this.visibilityObserver?.disconnect();
    if (this.isPictureInPicture()) document.exitPictureInPicture?.().catch(() => {});
    this.player.destroy();
    this.renderer.destroy();
    this.dm?.close();
    this.el.remove();
  }
}
