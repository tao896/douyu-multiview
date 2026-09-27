// mpegts.js 封装：FLV 直播播放 + 卡死自愈
// 流地址带 wsAuth token 会过期，出错或长时间不推进就重新签名换地址
const STALL_MS = 15_000;
const MAX_RETRY = 6;
const STALE_LATENCY_SECONDS = 3;
const FRAME_STALL_MS = 6_000;
const RECOVERY_COOLDOWN_MS = 15_000;
const SAMPLE_GRACE_MS = 6_000;
const STALE_LATENCY_SAMPLES = 2;

const filteredConsoleMethods = new WeakSet();
const AUDIO_OVERLAP_WARNING = /^\[MP4Remuxer\] > Dropping 1 audio frame .*due to dtsCorrection: .* overlap\.?$/;
const AUDIO_TIMESTAMP_GAP_WARNING = /^\[MP4Remuxer\] > Large audio timestamp gap detected\b/;

const STARTUP_STALL_WARNING = /^\[StartupStallJumper\] > Playback seems stuck at \d+(?:\.\d+)?, seek to \d+(?:\.\d+)?$/;
const EARLY_EOF_WARNING = /(?:Fetch stream meet Early-EOF|UnrecoverableEarlyEof)/i;
const UNCONSUMED_DATA_WARNING = /^\[IOController\] > \d+ bytes unconsumed data remain when flush buffer, dropped$/;
// Chrome reports a SourceBuffer error after a decoder rejects one malformed
// segment. mpegts.js emits the same condition through its ERROR event and the
// player already performs the retry, so avoid duplicating it as an uncaught
// console error (which otherwise obscures the actual recovery state).
const SOURCE_BUFFER_APPEND_ERROR = /^\[MSEController\] > Failed to execute 'appendBuffer' on 'SourceBuffer':/;

const STREAM_UPDATE_WARNINGS = new Set([
  '[FLVDemuxer] > AVCDecoderConfigurationRecord has been changed, re-generate initialization segment',
  '[FLVDemuxer] > Found another onMetaData tag!',
]);

// 识别播放器内部自行处理的时间戳、启动跳转和流信息更新提示。
function isRoutinePlaybackWarning(message) {
  return AUDIO_OVERLAP_WARNING.test(message) || AUDIO_TIMESTAMP_GAP_WARNING.test(message)
    || STARTUP_STALL_WARNING.test(message) || STREAM_UPDATE_WARNINGS.has(message)
    || EARLY_EOF_WARNING.test(message) || UNCONSUMED_DATA_WARNING.test(message)
    || SOURCE_BUFFER_APPEND_ERROR.test(message);
}

function isEarlyEofError(type, detail) {
  return EARLY_EOF_WARNING.test(`${type || ''} ${detail || ''}`);
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
  // mpegts.js 的 Blob Worker 不符合当前扩展 CSP，保留主线程回退路径。
  enableWorker: false,
  // 应用层统一追帧，避免库和看门狗同时 seek。
  liveBufferLatencyChasing: false,
  lazyLoad: false,
  stashInitialSize: 128,
  autoCleanupSourceBuffer: true,
  autoCleanupMaxBackwardDuration: 30,
  autoCleanupMinBackwardDuration: 15,
};

export class Player {
  constructor(video, { getUrl, onState, random = Math.random } = {}) {
    this.video = video;
    this.getUrl = getUrl;             // () => Promise<string>
    this.onState = onState || (() => {});
    this.random = random;
    // 用户手动起播后即时收掉遮罩
    this.onPlaying = () => {
      if (this.mp && !this.destroyed) {
        this.resetFrameSamples();
        if (!this.retryForce) this.emit('playing');
      }
    };
    video.addEventListener('playing', this.onPlaying);
    // playing 只在「暂停→播放」时触发。画面没停过、只是抛了个非致命错误的场景收不到它，
    // timeupdate 只说明媒体时钟推进；视频呈现异常由独立帧采样处理。
    this.onTimeUpdate = () => {
      if (this.destroyed || !this.mp || this.video.paused) return;
      if (this.video.currentTime > this.lastTime + 0.05) {
        this.lastTime = this.video.currentTime;
        this.lastMove = Date.now();
      }
      if (this.retryForce) return;
      this.state = 'playing';
      this.onState({ state: 'progress', message: '', retry: this.retry });
    };
    video.addEventListener('timeupdate', this.onTimeUpdate);
    this.mp = null;
    this.retry = 0;
    this.retryTimer = 0;
    this.retryForce = false;
    this.watchdog = 0;
    this.lastTime = 0;
    this.lastMove = 0;
    this.staleLatencySamples = 0;
    this.destroyed = false;
    this.loading = false;
    this.generation = 0;
    this.loadController = null;
    this.pageVisible = !document.hidden;
    this.online = navigator.onLine !== false;
    this.waitingForOnline = false;
    this.state = 'offline';
    this.lastError = '';
    this.frameVisible = true;
    this.frameCallback = null;
    this.frameEpoch = 0;
    this.recoveryCount = 0;
    this.lastRecoveryReason = '';
    this.lastRecoveryAt = -Infinity;
    this.recoveryStage = 0;
    this.pendingAlignment = false;
    this.onSeeking = () => this.resetFrameSamples();
    this.onProgress = () => {
      if (this.pendingAlignment && this.alignRecoveredMedia()) this.pendingAlignment = false;
    };
    video.addEventListener('seeking', this.onSeeking);
    video.addEventListener('progress', this.onProgress);
    video.addEventListener('loadeddata', this.onProgress);
    this.resetFrameSamples();
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
    const recovering = this.generation > 1;
    const wasMuted = this.video.muted;
    const wasVolume = this.video.volume;
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
      this.pendingAlignment = recovering;
      this.startFrameMonitor();
      mp.attachMediaElement(this.video);
      this.video.muted = wasMuted;
      this.video.volume = wasVolume;
      this.video.playbackRate = 1;

      mp.on(mpegts.Events.ERROR, (type, detail) => {
        if (this.mp !== mp) return;
        // 网络错误多半是 token 过期，重新取流即可
        this.fail(`${type}${detail ? ': ' + detail : ''}`, { force: isEarlyEofError(type, detail) });
      });
      mp.on(mpegts.Events.MEDIA_INFO, () => {
        if (this.mp !== mp) return;
        // 重连会复用同一个 video 元素；从新流的缓冲尾部重新建立音视频共同时间基准。
        if (recovering) this.onProgress();
        this.retry = 0;
        this.lastTime = this.video.currentTime;
        this.lastMove = Date.now();
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

  resetFrameSamples() {
    this.sampleAfter = Date.now() + SAMPLE_GRACE_MS;
    this.lastFrameAt = Date.now();
    this.lastFrameMediaTime = null;
    this.frameSkewSeconds = null;
    this.frameAnomaly = false;
    this.staleLatencySamples = 0;
    this.qualitySample = null;
    this.recentDroppedRatio = 0;
  }

  startFrameMonitor() {
    this.resetFrameSamples();
    if (!this.video.requestVideoFrameCallback) return;
    const epoch = ++this.frameEpoch;
    const sample = (_now, metadata) => {
      if (epoch !== this.frameEpoch || this.destroyed || !this.mp) return;
      if (this.pageVisible && !this.video.seeking && !this.video.paused) {
        if (metadata.mediaTime !== this.lastFrameMediaTime) this.lastFrameAt = Date.now();
        this.lastFrameMediaTime = metadata.mediaTime;
        // 这是呈现时间线偏差线索，并非音频输出时间戳或精确音画差。
        this.frameSkewSeconds = Number.isFinite(metadata.mediaTime)
          ? Math.abs(this.video.currentTime - metadata.mediaTime) : null;
      }
      this.frameCallback = this.video.requestVideoFrameCallback(sample);
    };
    this.frameCallback = this.video.requestVideoFrameCallback(sample);
  }

  alignRecoveredMedia() {
    const v = this.video;
    try {
      if (!v.buffered?.length) return false;
      const index = v.buffered.length - 1;
      const start = v.buffered.start(index);
      const end = v.buffered.end(index);
      if (end - start < 0.25) return false;
      const target = Math.max(start, end - 1);
      if (!Number.isFinite(target)) return false;
      v.currentTime = target;
      this.resetFrameSamples();
      return true;
    } catch {
      return false;
    }
  }

  checkPlaybackHealth() {
    const v = this.video;
    const now = Date.now();
    const quality = v.getVideoPlaybackQuality?.();
    if (quality) {
      const previous = this.qualitySample;
      const total = quality.totalVideoFrames - (previous?.totalVideoFrames ?? quality.totalVideoFrames);
      const dropped = quality.droppedVideoFrames - (previous?.droppedVideoFrames ?? quality.droppedVideoFrames);
      this.recentDroppedRatio = total > 0 ? Math.max(0, Math.min(1, dropped / total)) : 0;
      this.qualitySample = { totalVideoFrames: quality.totalVideoFrames, droppedVideoFrames: quality.droppedVideoFrames };
    }
    if (!this.pageVisible || !this.online || v.paused || v.seeking || v.readyState < 2 || now < this.sampleAfter) {
      this.staleLatencySamples = 0;
      this.frameAnomaly = false;
      return false;
    }
    const frameObservable = this.frameVisible || document.pictureInPictureElement === v;
    this.frameAnomaly = frameObservable && !!v.requestVideoFrameCallback &&
      (now - this.lastFrameAt > FRAME_STALL_MS || this.frameSkewSeconds > 0.75);
    const latency = this.liveLatency();
    const anomalous = this.frameAnomaly || latency > STALE_LATENCY_SECONDS;
    this.staleLatencySamples = anomalous ? this.staleLatencySamples + 1 : 0;
    if (!anomalous && now - this.lastRecoveryAt > 30_000) this.recoveryStage = 0;
    if (this.staleLatencySamples < STALE_LATENCY_SAMPLES || now - this.lastRecoveryAt < RECOVERY_COOLDOWN_MS) return false;
    this.lastRecoveryReason = this.frameAnomaly ? '视频帧呈现落后或停滞' : `播放缓冲积压（${latency.toFixed(1)}s）`;
    this.lastRecoveryAt = now;
    this.recoveryCount++;
    this.staleLatencySamples = 0;
    if (this.recoveryStage === 0 && this.alignRecoveredMedia()) {
      this.recoveryStage = 1;
    } else {
      this.recoveryStage = 0;
      this.fail(this.lastRecoveryReason, { force: true });
    }
    return true;
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
      }
      if (this.checkPlaybackHealth()) return;
      // UI 里没有暂停按钮，所以 paused 一定是意外（多为 DOM 移动导致），先尝试续播
      if (this.video.paused) {
        if (this.video.readyState >= 2) this.video.play().catch(() => {});
        return;
      }
      if (Date.now() - this.lastMove > STALL_MS) this.fail('画面卡住');
    }, 3000);
  }

  liveLatency() {
    const buffered = this.video.buffered;
    if (!buffered?.length) return 0;
    try {
      return Math.max(0, buffered.end(buffered.length - 1) - this.video.currentTime);
    } catch {
      return 0;
    }
  }

  fail(reason, { force = false } = {}) {
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
    if (!force && this.isHealthy()) {
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
    this.retryForce = force;
    this.emit('retrying', `${reason}，${Math.round(delay / 1000)}s 后重连`);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = 0;
      // 等待期间可能已经自己恢复了，别去 teardown 一个正在播的播放器
      const forceReload = this.retryForce;
      this.retryForce = false;
      if (!forceReload && this.isHealthy()) {
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
    this.retryForce = false;
    clearTimeout(this.retryTimer);
    this.retryTimer = 0;
    return this.load(options);
  }

  stop() {
    this.generation++;
    this.retry = 0;
    this.retryForce = false;
    this.loading = false;
    this.teardown();
  }

  setFrameVisible(visible) {
    this.frameVisible = !!visible;
    this.resetFrameSamples();
  }

  setPageVisible(visible) {
    this.pageVisible = !!visible;
    this.resetFrameSamples();
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
    const bufferSeconds = this.liveLatency();
    return {
      frameMonitoring: !this.video.requestVideoFrameCallback ? 'unsupported'
        : (!this.pageVisible || (!this.frameVisible && document.pictureInPictureElement !== this.video) || this.video.paused || this.video.seeking || this.video.readyState < 2 || Date.now() < this.sampleAfter) ? 'suspended' : 'active',
      frameSkewSeconds: this.frameSkewSeconds,
      frameAnomaly: this.frameAnomaly,
      recentDroppedRatio: this.recentDroppedRatio,
      recoveryCount: this.recoveryCount,
      lastRecoveryReason: this.lastRecoveryReason,
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
    this.frameEpoch++;
    if (this.frameCallback !== null) this.video.cancelVideoFrameCallback?.(this.frameCallback);
    this.frameCallback = null;
    this.pendingAlignment = false;
    this.resetFrameSamples();
    clearInterval(this.watchdog);
    clearTimeout(this.retryTimer);
    this.retryTimer = 0;
    this.loadController?.abort();
    this.loadController = null;
    if (this.mp) {
      const mp = this.mp;
      this.mp = null;
      // 某一步抛错也必须继续释放后续资源。
      for (const method of ['pause', 'unload', 'detachMediaElement', 'destroy']) {
        try { mp[method](); } catch {}
      }
    }
    // Detach/destroy mpegts before resetting the media element. Resetting the
    // element first can race a queued appendBuffer and leave Chrome with a
    // detached SourceBuffer (followed by a null.length exception).
    try {
      this.video.playbackRate = 1;
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
    } catch {}
  }

  destroy() {
    this.video.removeEventListener('playing', this.onPlaying);
    this.video.removeEventListener('timeupdate', this.onTimeUpdate);
    this.video.removeEventListener('seeking', this.onSeeking);
    this.video.removeEventListener('progress', this.onProgress);
    this.video.removeEventListener('loadeddata', this.onProgress);
    this.destroyed = true;
    this.generation++;
    this.teardown();
  }
}
