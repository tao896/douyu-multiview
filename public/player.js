// mpegts.js 封装：FLV 直播播放 + 卡死自愈
// 流地址带 wsAuth token 会过期，出错或长时间不推进就重新签名换地址
const STALL_MS = 15_000;
const MAX_RETRY = 6;

const filteredConsoleMethods = new WeakSet();
const AUDIO_OVERLAP_WARNING = /^\[MP4Remuxer\] > Dropping 1 audio frame .*due to dtsCorrection: .* overlap\.?$/;
const AUDIO_TIMESTAMP_GAP_WARNING = /^\[MP4Remuxer\] > Large audio timestamp gap detected\b/;

const STARTUP_STALL_WARNING = /^\[StartupStallJumper\] > Playback seems stuck at \d+(?:\.\d+)?, seek to \d+(?:\.\d+)?$/;

const STREAM_UPDATE_WARNINGS = new Set([
  '[FLVDemuxer] > AVCDecoderConfigurationRecord has been changed, re-generate initialization segment',
  '[FLVDemuxer] > Found another onMetaData tag!',
]);

// 识别播放器内部自行处理的时间戳、启动跳转和流信息更新提示。
function isRoutinePlaybackWarning(message) {
  return AUDIO_OVERLAP_WARNING.test(message) || AUDIO_TIMESTAMP_GAP_WARNING.test(message)
    || STARTUP_STALL_WARNING.test(message) || STREAM_UPDATE_WARNINGS.has(message);
}

// 仅过滤已知自愈提示，保留其他警告和错误。
function filterRoutinePlaybackConsole(consoleRef = globalThis.console) {
  if (!consoleRef) return;
  for (const method of ['warn', 'error', 'log']) {
    const original = consoleRef[method];
    if (typeof original !== 'function' || filteredConsoleMethods.has(original)) continue;
    // 保留非目标日志的原始参数与调用上下文。
    const filtered = function (...args) {
      const message = args.map((arg) => String(arg)).join(' ');
      // 库会自行修正时间戳、跳转缓冲起点或更新流信息；过滤不影响处理逻辑。
      if (isRoutinePlaybackWarning(message)) return;
      return original.apply(this, args);
    };
    try {
      consoleRef[method] = filtered;
      filteredConsoleMethods.add(filtered);
    } catch {}
  }
}

// 安装日志过滤器，多播放器重复初始化时不会重复包装。
function configureLogging(mpegts) {
  filterRoutinePlaybackConsole();
}

const CONFIG = {
  enableWorker: false,
  liveBufferLatencyChasing: true,
  liveBufferLatencyMaxLatency: 3.0,
  liveBufferLatencyMinRemain: 0.4,
  lazyLoad: false,
  stashInitialSize: 128,
  autoCleanupSourceBuffer: true,
};

export class Player {
  constructor(video, { getUrl, onState, random = Math.random } = {}) {
    this.video = video;
    this.getUrl = getUrl;             // () => Promise<string>
    this.onState = onState || (() => {});
    this.random = random;
    // 用户手动起播后即时收掉遮罩
    video.addEventListener('playing', () => {
      if (this.mp && !this.destroyed) this.emit('playing');
    });
    // playing 只在「暂停→播放」时触发。画面没停过、只是抛了个非致命错误的场景收不到它，
    // 所以另外用 timeupdate 当恢复信号：只要还在推进就说明是好的。
    video.addEventListener('timeupdate', () => {
      if (this.destroyed || !this.mp || this.video.paused) return;
      this.lastTime = this.video.currentTime;
      this.lastMove = Date.now();
      this.state = 'playing';
      this.onState({ state: 'progress', message: '', retry: this.retry });
    });
    this.mp = null;
    this.retry = 0;
    this.retryTimer = 0;
    this.watchdog = 0;
    this.lastTime = 0;
    this.lastMove = 0;
    this.destroyed = false;
    this.loading = false;
    this.generation = 0;
    this.loadController = null;
    this.pageVisible = !document.hidden;
    this.online = navigator.onLine !== false;
    this.waitingForOnline = false;
    this.state = 'offline';
    this.lastError = '';
  }

  emit(state, message = '') {
    this.state = state;
    if (state === 'error' || state === 'retrying') this.lastError = message;
    this.onState({ state, message, retry: this.retry });
  }

  async load({ initialUrl, signal } = {}) {
    if (this.destroyed) return;
    const generation = ++this.generation;
    this.loading = true;
    this.teardown();
    const controller = new AbortController();
    this.loadController = controller;
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    this.emit('loading');
    try {
      const url = initialUrl || await this.getUrl({ signal: controller.signal });
      if (this.destroyed || generation !== this.generation) return;
      if (!window.mpegts?.isSupported()) throw new Error('当前浏览器不支持 MSE 播放');

      configureLogging(window.mpegts);
      const mp = mpegts.createPlayer({ type: 'flv', isLive: true, url }, CONFIG);
      this.mp = mp;
      mp.attachMediaElement(this.video);

      mp.on(mpegts.Events.ERROR, (type, detail) => {
        if (this.mp !== mp) return;
        // 网络错误多半是 token 过期，重新取流即可
        this.fail(`${type}${detail ? ': ' + detail : ''}`);
      });
      mp.on(mpegts.Events.MEDIA_INFO, () => {
        if (this.mp !== mp) return;
        this.retry = 0;
        this.emit('playing');
      });

      mp.load();
      // 自动播放策略：必须静音起播，音量由用户交互后再开
      let blocked = false;
      await mp.play().catch(() => {
        blocked = true;
      });
      if (this.destroyed || generation !== this.generation) return;
      // 即使 play() 没抛，也可能被策略拦下来停在 paused
      if (blocked || this.video.paused) this.emit('blocked');
      this.startWatchdog();
    } catch (e) {
      if (e?.name !== 'AbortError' && !this.destroyed && generation === this.generation) {
        this.fail(e.message || String(e));
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (this.loadController === controller) this.loadController = null;
      if (generation === this.generation) this.loading = false;
    }
  }

  // 画面是否确实在正常播放。用于把 mpegts 的非致命 ERROR 和真故障区分开。
  isHealthy() {
    const v = this.video;
    if (v.paused || v.ended || v.readyState < 3) return false;
    // 比看门狗上次采样又前进了，说明此刻正在播
    if (v.currentTime > this.lastTime + 0.05) {
      this.lastTime = v.currentTime;
      this.lastMove = Date.now();
      return true;
    }
    // 看门狗每 3 秒采一次，lastMove 会滞后，容忍到停滞阈值
    return this.lastMove > 0 && Date.now() - this.lastMove < STALL_MS;
  }

  startWatchdog() {
    clearInterval(this.watchdog);
    this.lastTime = this.video.currentTime;
    this.lastMove = Date.now();
    this.watchdog = setInterval(() => {
      if (this.destroyed) return;
      if (!this.pageVisible) {
        this.lastTime = this.video.currentTime;
        this.lastMove = Date.now();
        return;
      }
      const t = this.video.currentTime;
      if (t > this.lastTime + 0.05) {
        this.lastTime = t;
        this.lastMove = Date.now();
        return;
      }
      // UI 里没有暂停按钮，所以 paused 一定是意外（多为 DOM 移动导致），先尝试续播
      if (this.video.paused) {
        if (this.video.readyState >= 2) this.video.play().catch(() => {});
        return;
      }
      if (Date.now() - this.lastMove > STALL_MS) this.fail('画面卡住');
    }, 3000);
  }

  fail(reason) {
    if (this.destroyed) return;
    if (!this.online) {
      this.waitingForOnline = true;
      clearInterval(this.watchdog);
      clearTimeout(this.retryTimer);
      this.retryTimer = 0;
      this.emit('suspended', '网络已断开，恢复后自动重连');
      return;
    }
    // mpegts 会抛可自愈的非致命 ERROR（网络抖动等），此时画面仍在从缓冲区正常播放。
    // 这种情况不能弹遮罩、更不能 teardown——否则等于亲手把一路好流掐断。
    // 交给看门狗判定：真卡住了它会再调一次 fail()，那时 currentTime 不再推进。
    if (this.isHealthy()) {
      this.startWatchdog();
      return;
    }
    // 一次失败常会连续抛出多个底层事件；同一退避窗口只计为一次重试。
    if (this.retryTimer) return;
    clearInterval(this.watchdog);
    if (this.retry >= MAX_RETRY) {
      this.emit('error', `${reason}（已重试 ${this.retry} 次）`);
      return;
    }
    const baseDelay = Math.min(1500 * 2 ** this.retry, 20_000);
    const delay = Math.round(baseDelay * (0.8 + this.random() * 0.4));
    this.retry++;
    this.emit('retrying', `${reason}，${Math.round(delay / 1000)}s 后重连`);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = 0;
      // 等待期间可能已经自己恢复了，别去 teardown 一个正在播的播放器
      if (this.isHealthy()) {
        this.retry = 0;
        this.emit('playing');
        this.startWatchdog();
        return;
      }
      this.load();
    }, delay);
  }

  reload(options) {
    this.retry = 0;
    clearTimeout(this.retryTimer);
    this.retryTimer = 0;
    return this.load(options);
  }

  stop() {
    this.generation++;
    this.retry = 0;
    this.loading = false;
    this.teardown();
  }

  setPageVisible(visible) {
    this.pageVisible = !!visible;
    if (this.pageVisible && this.mp) {
      this.lastTime = this.video.currentTime;
      this.lastMove = Date.now();
      this.startWatchdog();
    }
  }

  setOnline(online) {
    this.online = !!online;
    if (this.online && this.waitingForOnline) {
      this.waitingForOnline = false;
      this.retry = 0;
      this.load();
    }
  }

  setExternalState(state, message = '') {
    this.emit(state, message);
  }

  diagnostics() {
    const quality = this.video.getVideoPlaybackQuality?.();
    const buffered = this.video.buffered;
    let bufferSeconds = 0;
    if (buffered?.length) bufferSeconds = Math.max(0, buffered.end(buffered.length - 1) - this.video.currentTime);
    return {
      state: this.state,
      retry: this.retry,
      lastError: this.lastError,
      width: this.video.videoWidth || 0,
      height: this.video.videoHeight || 0,
      bufferSeconds,
      totalFrames: quality?.totalVideoFrames || 0,
      droppedFrames: quality?.droppedVideoFrames || 0,
      currentTime: this.video.currentTime || 0,
    };
  }

  teardown() {
    clearInterval(this.watchdog);
    clearTimeout(this.retryTimer);
    this.retryTimer = 0;
    this.loadController?.abort();
    this.loadController = null;
    if (this.mp) {
      try {
        this.mp.pause();
        this.mp.unload();
        this.mp.detachMediaElement();
        this.mp.destroy();
      } catch {}
      this.mp = null;
    }
  }

  destroy() {
    this.destroyed = true;
    this.generation++;
    this.teardown();
  }
}
