import { LiveStreamLoader } from './live-stream-loader.js';

// mpegts.js 封装：FLV 直播播放 + 卡死自愈
// 流地址带 wsAuth token 会过期，出错或长时间不推进就重新签名换地址
const STALL_MS = 15_000;
const STABLE_PLAYBACK_MS = 30_000;
const MAX_FORWARD_BUFFER_SECONDS = 30;
const STALE_LATENCY_SECONDS = 3;
const FRAME_STALL_MS = 6_000;
const RECOVERY_COOLDOWN_MS = 15_000;
const SAMPLE_GRACE_MS = 6_000;
const STALE_LATENCY_SAMPLES = 2;
const FRAME_SAMPLE_MS = 333;
// 音画偏差取音频、视频两个 SourceBuffer 缓冲尾部之差。mpegts 遇到时间戳断档时
// 视频会压缩空档、音频会补静音帧，两条时间线由此错开，且 seek 无法修正，只能重建 remuxer。
const SYNC_OBSERVE_MS = 1000;
const SYNC_GRACE_MS = 5_000;
const SYNC_BASELINE_SAMPLES = 5;
const SYNC_WARN_SECONDS = 0.2;
const SYNC_REBUILD_SECONDS = 0.35;
const SYNC_REBUILD_SAMPLES = 5;
const SYNC_REBUILD_COOLDOWN_MS = 30_000;
// 渲染滞后：解码/合成跟不上时，已呈现帧的 mediaTime 落后于音频驱动的 currentTime。
// 取近 3 秒中位数，仅在诊断面板展示。
const RENDER_LAG_WINDOW = 9;
// Chrome 的音频时钟按已播放采样数推进，不按时间戳重新对齐：音频解码器因配置切换重建、
// 或时间线出现断档后，声音会领先画面且不会自愈，只有 seek/重载能重新锚定（flv.js #241）。
// 这种偏移在 currentTime 内部，前面两种测量都看不到，因此按事件和定期两种方式重新锚定。
const REANCHOR_COOLDOWN_MS = 30_000;
const REANCHOR_INTERVAL_MS = 120_000;
const REANCHOR_SETTLE_SECONDS = 0.5;
const REANCHOR_LEAD_MS = 30;
const REANCHOR_TOLERANCE_SECONDS = 0.3;
const REANCHOR_MIN_BUFFER_SECONDS = 0.3;
const AUDIO_GAP_MS = 2;
// 延迟对齐：各窗口按本地缓冲积压追到同一档低延迟。只能消除浏览器端积压，
// 主播推流和 CDN 本身的延迟差无法测量，也无法对齐。
// 积压超过 CHASE_START 时微调倍速追帧，回到 CHASE_STOP 以下恢复 1×；
// 超过 STALE_LATENCY_SECONDS 仍由看门狗跳到缓冲尾部。
const CHASE_START_SECONDS = 1.5;
const CHASE_STOP_SECONDS = 0.8;
const CHASE_RATE = 1.1;
// 跳到最新关键帧时，关键帧之后至少要有这么多已缓冲数据，避免落点后立刻卡顿
const CHASE_MIN_TAIL_SECONDS = 0.5;

const filteredConsoleMethods = new WeakSet();
const AUDIO_OVERLAP_WARNING = /^\[MP4Remuxer\] > Dropping 1 audio frame .*due to dtsCorrection: .* overlap\.?$/;
const AUDIO_TIMESTAMP_GAP_WARNING = /^\[MP4Remuxer\] > Large audio timestamp gap detected\b/;

const STARTUP_STALL_WARNING = /^\[StartupStallJumper\] > Playback seems stuck at \d+(?:\.\d+)?, seek to \d+(?:\.\d+)?$/;
const EARLY_EOF_WARNING = /(?:Fetch stream meet Early-EOF|UnrecoverableEarlyEof)/i;
const UNCONSUMED_DATA_WARNING = /^\[IOController\] > \d+ bytes unconsumed data remain when flush buffer, dropped$/;
// mpegts.js 的正常初始化日志会在多路直播中高速累积，保留它们会让 DevTools 控制台本身持续占用内存。
const ROUTINE_INFO_LOG = /^\[(?:MSEController|FLVDemuxer)\] > (?:MediaSource onSourceOpen|Parsed onMetaData|Parsed AudioSpecificConfig|Parsed AVCDecoderConfigurationRecord|Received Initialization Segment, mimeType:)/;
// SourceBuffer 的异步 error 在 mpegts 1.8.2 中仅记录日志；可恢复事件由看门狗
// 观察，真正的媒体解码失败由 video.error 和 MediaMSEError 强制重建播放器。
const SOURCE_BUFFER_EVENT_ERROR = /^\[MSEController\] > SourceBuffer Error: \[object Event\]$/;
const SOURCE_BUFFER_APPEND_ERROR = /^\[MSEController\] > Failed to execute 'appendBuffer' on 'SourceBuffer':/;
// 流地址过期或 CDN 切换时，mpegts 会先输出 404，再由播放器重新签名重连。
// 这属于已处理的瞬态事件，避免 Chrome 控制台显示为未捕获错误。
const LOADER_404_ERROR = /^\[(?:IOController|TransmuxingController)\] > (?:Loader error, code = 404, msg = Not Found|IOException: type = HttpStatusCodeInvalid, code = 404, msg = Not Found)$/;
// mpegts 1.8.x can report these teardown races after the player has already
// been replaced. They are internal, recoverable noise and must not flood the
// extension page console while the watchdog rebuilds the stream.
const TEARDOWN_RACE_ERROR = /(?:Maximum call stack size exceeded|Cannot read properties of null \(reading '(?:emit|notifyBufferedPositionChanged)'\)|Aborting asynchronous remove\(\) operation is disallowed)/i;
const HANDLED_STREAM_ERROR = /^\[(?:IOController|TransmuxingController)\] > (?:Loader error, code = -1, msg = (?:network error|Live stream ended)|IOException: type = Exception, code = -1, msg = network error)$/;
const FETCH_FAILURE_ERROR = /^\[(?:IOController|TransmuxingController)\] > (?:Loader error, code = -1, msg = Failed to fetch|IOException: type = Exception, code = -1, msg = Failed to fetch)$/;
const AUDIO_CONFIG_UPDATE = /^\[FLVDemuxer\] > AudioSpecificConfig has been changed, re-generate initialization segment$/;

const STREAM_UPDATE_WARNINGS = new Set([
  '[FLVDemuxer] > AVCDecoderConfigurationRecord has been changed, re-generate initialization segment',
  '[FLVDemuxer] > Found another onMetaData tag!',
]);

// 识别播放器内部自行处理的时间戳、启动跳转和流信息更新提示。
function isRoutinePlaybackWarning(message) {
  return AUDIO_OVERLAP_WARNING.test(message) || AUDIO_TIMESTAMP_GAP_WARNING.test(message)
    || STARTUP_STALL_WARNING.test(message) || STREAM_UPDATE_WARNINGS.has(message)
    || EARLY_EOF_WARNING.test(message) || UNCONSUMED_DATA_WARNING.test(message)
    || SOURCE_BUFFER_EVENT_ERROR.test(message) || SOURCE_BUFFER_APPEND_ERROR.test(message) || LOADER_404_ERROR.test(message) || ROUTINE_INFO_LOG.test(message) || TEARDOWN_RACE_ERROR.test(message) || HANDLED_STREAM_ERROR.test(message) || FETCH_FAILURE_ERROR.test(message) || AUDIO_CONFIG_UPDATE.test(message);
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
  customLoader: LiveStreamLoader,
  // 应用层统一追帧，避免库和看门狗同时 seek。
  liveBufferLatencyChasing: false,
  lazyLoad: false,
  stashInitialSize: 128,
  autoCleanupSourceBuffer: true,
  autoCleanupMaxBackwardDuration: 30,
  autoCleanupMinBackwardDuration: 15,
};

export class Player {
  constructor(video, { getUrl, onState, onStreamData, isRecording, random = Math.random } = {}) {
    this.onStreamData = onStreamData || null; // 录制旁路，收到加载器过滤后的 FLV 字节
    this.isRecording = isRecording || (() => false);
    // 后台录制时 Chrome 暂停了静音视频：保持下载只写录制文件，不再送入 mpegts，
    // 否则未播放的缓冲会无限增长。回到页面后重新连接恢复画面。
    this.recordOnly = false;
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
    this.onMediaError = () => {
      if (!this.mp || this.destroyed || !video.error) return;
      this.fail(`媒体播放失败 (${video.error.code})${video.error.message ? ': ' + video.error.message : ''}`, { force: true });
    };
    video.addEventListener('error', this.onMediaError);
    // playing 只在「暂停→播放」时触发。画面没停过、只是抛了个非致命错误的场景收不到它，
    // timeupdate 只说明媒体时钟推进；视频呈现异常由独立帧采样处理。
    this.onTimeUpdate = () => {
      if (this.destroyed || !this.mp || this.video.paused) return;
      if (this.video.currentTime > this.lastTime + 0.05) {
        const now = Date.now();
        if (!this.stableSince || now - this.lastMove > STALL_MS) this.stableSince = now;
        this.lastTime = this.video.currentTime;
        this.lastMove = now;
        if (!this.retryForce && now - this.stableSince >= STABLE_PLAYBACK_MS) this.retry = 0;
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
    this.stableSince = 0;
    this.staleLatencySamples = 0;
    this.destroyed = false;
    this.loading = false;
    this.generation = 0;
    this.loadController = null;
    this.pageVisible = !document.hidden;
    this.pageHiddenAt = this.pageVisible ? 0 : Date.now();
    this.online = navigator.onLine !== false;
    this.waitingForOnline = false;
    this.waitingForVisible = false;
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
    this.visibilityRecoveryCount = 0;
    this.lastVisibilityRecoveryAt = -Infinity;
    this.lastVisibilityRecoveryReason = '';
    this.syncEvents = [];
    this.latencyChase = false;
    this.chasing = false;
    this.liveJumpCount = 0;
    this.syncTimer = 0;
    this.syncRebuildCount = 0;
    this.lastSyncRebuildAt = -Infinity;
    this.reanchorTimer = 0;
    this.reanchorCount = 0;
    this.lastReanchorAt = -Infinity;
    this.audioConfigChanges = 0;
    this.audioGapMs = 0;
    this.resetSyncSamples();
    this.onSeeking = () => {
      this.resetFrameSamples();
      // 任何 seek（追帧、切页恢复、重新锚定）都会让 Chrome 重新对齐音视频时钟。
      this.lastAnchorAt = Date.now();
      if (this.pendingReanchorAt != null && this.video.currentTime > this.pendingReanchorAt) this.pendingReanchorAt = null;
    };
    this.onProgress = () => {
      if (this.pendingAlignment && this.alignRecoveredMedia()) this.pendingAlignment = false;
    };
    // 缓冲耗尽和开关声音都可能与不同步有关，记入诊断时间线。
    this.onWaiting = () => {
      if (this.mp && !this.destroyed) this.recordSyncEvent('waiting');
    };
    this.lastMuted = video.muted;
    this.onVolumeChange = () => {
      if (video.muted === this.lastMuted) return;
      this.lastMuted = video.muted;
      this.recordSyncEvent(video.muted ? 'audio-off' : 'audio-on');
      // 静音期间不做定期重新锚定；开声后在下一个关键帧重新对齐，避免带着静音期累积的偏移出声。
      if (!video.muted && this.mp) this.pendingReanchorAt = video.currentTime;
    };
    video.addEventListener('seeking', this.onSeeking);
    video.addEventListener('progress', this.onProgress);
    video.addEventListener('loadeddata', this.onProgress);
    video.addEventListener('waiting', this.onWaiting);
    video.addEventListener('volumechange', this.onVolumeChange);
    this.resetFrameSamples();
  }

  emit(state, message = '') {
    this.state = state;
    if (state === 'error' || state === 'retrying') this.lastError = message;
    this.onState({ state, message, retry: this.retry });
  }

  // reason 标明是谁触发了加载（窗口层传入）；播放器自身的出错重连不传，记为 reconnect。
  async load({ initialUrl, signal, reason } = {}) {
    if (this.destroyed) return;
    const generation = ++this.generation;
    this.loading = true;
    const recovering = this.generation > 1;
    const wasMuted = this.video.muted;
    const wasVolume = this.video.volume;
    this.teardown();
    this.waitingForVisible = false;
    const loadReason = reason || (recovering ? 'reconnect' : 'initial');
    const controller = new AbortController();
    this.loadController = controller;
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    this.emit('loading');
    try {
      const url = initialUrl || await this.getUrl({ signal: controller.signal });
      if (this.destroyed || generation !== this.generation || controller.signal.aborted) return;
      // 记下 CDN 节点，便于和官网所用线路、出问题的连接对照。
      let host = '';
      try { host = new URL(url).host; } catch {}
      this.recordSyncEvent('load', host ? `${loadReason} ${host}` : loadReason);
      if (!window.mpegts?.isSupported()) throw new Error('当前浏览器不支持 MSE 播放');

      configureLogging(window.mpegts);
      // 每条连接单独统计加载器去掉的无声 AAC 帧。
      this.audioFilterStats = { dropped: 0 };
      this.silentAacReported = false;
      // 只转发当前连接的数据，避免已替换的旧加载器尾包混进录制。
      let mp = null;
      // 返回 true 时加载器丢弃这块数据，不送入 mpegts（仅录制模式）。
      const recordTap = (chunk, token) => {
        if (!mp || this.mp !== mp) return false;
        this.onStreamData?.(chunk, token);
        return this.recordOnly;
      };
      mp = mpegts.createPlayer({ type: 'flv', isLive: true, url }, { ...CONFIG, audioFilterStats: this.audioFilterStats, recordTap });
      this.mp = mp;
      this.pendingAlignment = recovering;
      this.startFrameMonitor();
      mp.attachMediaElement(this.video);
      this.observeTimeline(mp);
      this.video.muted = wasMuted;
      this.video.volume = wasVolume;
      this.chasing = false;
      this.video.playbackRate = 1;
      this.startSyncMonitor();

      mp.on(mpegts.Events.ERROR, (type, detail, info) => {
        if (this.mp !== mp) return;
        // HTTP failures terminate the loader even while old buffered frames still play.
        // Fetch a fresh signed URL rather than treating that buffer as network recovery.
        const httpFailure = detail === 'HttpStatusCodeInvalid';
        const status = httpFailure && info?.code ? ` (HTTP ${info.code})` : '';
        this.recordSyncEvent('mpegts-error', `${type}${detail ? ': ' + detail : ''}${status}`);
        this.fail(`${type}${detail ? ': ' + detail : ''}${status}`, {
            force: httpFailure || detail === 'MediaMSEError' || detail === 'Exception' || isEarlyEofError(type, detail),
        });
      });
      // 流中途再次出现 onMetaData，通常说明 CDN 重连了上游；拼接处音视频可能已经错开。
      let metadataCount = 0;
      mp.on(mpegts.Events.METADATA_ARRIVED, () => {
        if (this.mp === mp && ++metadataCount > 1) this.recordSyncEvent('metadata-repeat', `#${metadataCount}`);
      });
      mp.on(mpegts.Events.MEDIA_INFO, () => {
        if (this.mp !== mp) return;
        // 重连会复用同一个 video 元素；从新流的缓冲尾部重新建立音视频共同时间基准。
        if (recovering) this.onProgress();
        this.lastTime = this.video.currentTime;
        this.lastMove = Date.now();
        this.emit('playing');
        this.recordSyncEvent('media-info');
      });

      mp.load();
      if (this.mp !== mp) return;
      // play() 可能一直等待媒体数据，等待期间也要防止下载缓冲无限增长。
      this.startWatchdog();
      // 自动播放策略：必须静音起播，音量由用户交互后再开
      let blocked = false;
      await mp.play().catch(() => {
        blocked = true;
      });
      if (this.destroyed || generation !== this.generation || controller.signal.aborted) return;
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
    this.renderLagSamples = [];
    this.renderLagSeconds = null;
  }

  // ct 为事件发生时的播放位置，便于和用户发现不同步的时刻对照。
  recordSyncEvent(type, detail = '') {
    const ct = Number.isFinite(this.video.currentTime) ? Number(this.video.currentTime.toFixed(2)) : null;
    this.syncEvents.push({ type, detail, at: new Date().toISOString(), ct });
    if (this.syncEvents.length > 40) this.syncEvents.shift();
  }

  // 每条新流（新 remuxer）都重新建立基线。
  resetSyncSamples() {
    this.syncAfter = Date.now() + SYNC_GRACE_MS;
    this.syncBaselineSamples = [];
    this.syncBaselineSeconds = null;
    this.syncTrackSkewSeconds = null;
    this.syncOffsetSeconds = null;
    this.syncStatus = 'unmeasurable';
    this.syncDriftSamples = 0;
    this.syncSamples = 0;
    clearTimeout(this.reanchorTimer);
    this.reanchorTimer = 0;
    this.audioInitSeen = false;
    this.videoInitSeen = false;
    this.fpsWindow = null;
    this.videoFps = null;
    this.audioEndDts = null;
    this.pendingReanchorAt = null;
    this.keyframeTimes = [];
    this.lastAnchorAt = Date.now();
  }

  isAudible() {
    return !this.video.muted && this.video.volume > 0;
  }

  // 在实例上包一层 MSE 追加入口，观察真正送进 Chrome 的音频时间线与关键帧。
  observeTimeline(mp) {
    const mse = mp?._player_engine?._mse_controller;
    if (!mse || typeof mse.appendInitSegment !== 'function' || typeof mse.appendMediaSegment !== 'function') return;
    const appendInit = mse.appendInitSegment;
    const appendMedia = mse.appendMediaSegment;
    mse.appendInitSegment = (segment, replay) => {
      // replay=true 是 SourceOpen 后补发首个初始化段，不算配置切换。
      if (this.mp === mp && !replay && segment?.type === 'audio') {
        if (this.audioInitSeen) {
          this.audioConfigChanges++;
          this.recordSyncEvent('audio-config-change');
          this.pendingReanchorAt = this.audioEndDts == null ? this.video.currentTime : this.audioEndDts / 1000;
        }
        this.audioInitSeen = true;
      }
      if (this.mp === mp && !replay && segment?.type === 'video') {
        if (this.videoInitSeen) this.recordSyncEvent('video-config-change');
        this.videoInitSeen = true;
      }
      return appendInit.call(mse, segment, replay);
    };
    mse.appendMediaSegment = (segment) => {
      if (this.mp === mp) this.observeMediaSegment(segment);
      return appendMedia.call(mse, segment);
    };
  }

  observeMediaSegment(segment) {
    const info = segment?.info;
    if (!info) return;
    if (segment.type === 'video') {
      for (const point of info.syncPoints || []) {
        if (Number.isFinite(point?.pts)) this.keyframeTimes.push(point.pts / 1000);
      }
      if (this.keyframeTimes.length > 30) this.keyframeTimes.splice(0, this.keyframeTimes.length - 30);
      this.trackVideoFps(info, segment.sampleCount);
      return;
    }
    if (segment.type !== 'audio' || !Number.isFinite(info.beginDts) || !Number.isFinite(info.endDts)) return;
    // mpegts 正常输出的音频是首尾相接的；出现断档或重叠时，Chrome 的采样计数时钟会偏离时间戳。
    if (this.audioEndDts != null) {
      const gap = info.beginDts - this.audioEndDts;
      if (Math.abs(gap) > AUDIO_GAP_MS) {
        this.audioGapMs += Math.abs(gap);
        this.recordSyncEvent('audio-timeline-gap', `${Math.round(gap)}ms`);
        this.pendingReanchorAt = Math.max(this.pendingReanchorAt ?? 0, info.beginDts / 1000);
      }
    }
    this.audioEndDts = info.endDts;
  }

  // 按 10 秒窗口统计实际收到的视频帧率。同一路流曾出现过 30/60 帧两种编码并存，
  // 记录下来以便判断不同步的连接是否拿到了另一种编码。
  trackVideoFps(info, samples) {
    if (!Number.isFinite(info.beginDts) || !Number.isFinite(info.endDts) || !samples) return;
    this.fpsWindow ??= { start: info.beginDts, frames: 0 };
    this.fpsWindow.frames += samples;
    const span = info.endDts - this.fpsWindow.start;
    if (span < 10_000) return;
    const fps = Math.round(this.fpsWindow.frames * 1000 / span);
    if (this.videoFps == null) this.recordSyncEvent('video-fps', String(fps));
    else if (Math.abs(fps - this.videoFps) > 5) this.recordSyncEvent('video-fps-change', `${this.videoFps}→${fps}`);
    this.videoFps = fps;
    this.fpsWindow = null;
  }

  // 由同步定时器每秒调用：断点之后的声音开始播放、或距上次锚定过久时，为有声窗口安排重新锚定。
  maintainAnchor() {
    const v = this.video;
    if (this.destroyed || !this.mp || this.retryTimer || this.reanchorTimer) return;
    if (!this.pageVisible || !this.isAudible() || v.paused || v.seeking || v.readyState < 2) return;
    const now = Date.now();
    if (now - this.lastReanchorAt < REANCHOR_COOLDOWN_MS) return;
    const breakPassed = this.pendingReanchorAt != null && v.currentTime >= this.pendingReanchorAt + REANCHOR_SETTLE_SECONDS;
    if (breakPassed) this.scheduleReanchor('音频时间线切换或开声后重新锚定');
    else if (now - this.lastAnchorAt >= REANCHOR_INTERVAL_MS) this.scheduleReanchor('定期重新锚定音画时钟');
  }

  // 只在播放即将到达关键帧时 seek 到该关键帧：Chrome 从关键帧起解码，无需预滚。
  // 落在非关键帧会先解码整个 GOP 才恢复，多路负载下画面和声音会一起停住数秒。
  scheduleReanchor(reason) {
    const current = this.video.currentTime;
    const keyframe = this.keyframeTimes.find((time) => time > current + 0.05);
    // 下一个关键帧还没收到：下一秒再看，绝不退回到非关键帧 seek。
    if (keyframe == null) return;
    const mp = this.mp;
    this.reanchorTimer = setTimeout(() => {
      this.reanchorTimer = 0;
      const v = this.video;
      if (this.mp !== mp || this.destroyed || v.paused || v.seeking || !this.isAudible()) return;
      // 定时器可能早到或晚到；只在关键帧附近 seek（回退到刚过的关键帧同样无需预滚），否则等下一个。
      if (Math.abs(keyframe - v.currentTime) > REANCHOR_TOLERANCE_SECONDS) return;
      if (this.bufferedAfter(keyframe) < REANCHOR_MIN_BUFFER_SECONDS) return;
      this.reanchor(keyframe + 0.001, reason);
    }, Math.max(0, (keyframe - current) * 1000 - REANCHOR_LEAD_MS));
  }

  setLatencyChase(enabled) {
    this.latencyChase = !!enabled;
    if (!this.latencyChase) this.setChasing(false);
    else this.jumpToLive('开启延迟对齐');
  }

  setChasing(on) {
    if (this.chasing === on) return;
    this.chasing = on;
    try { this.video.playbackRate = on ? CHASE_RATE : 1; } catch {}
  }

  // 由同步定时器每秒调用：开启延迟对齐时用倍速把缓冲积压收回到低延迟档位。
  maintainLatency() {
    const v = this.video;
    const blocked = !this.latencyChase || this.destroyed || !this.mp || this.retryTimer || this.reanchorTimer ||
      !this.pageVisible || v.paused || v.seeking || v.readyState < 3;
    if (blocked) return this.setChasing(false);
    const latency = this.liveLatency();
    if (latency > CHASE_START_SECONDS) this.setChasing(true);
    else if (latency < CHASE_STOP_SECONDS) this.setChasing(false);
  }

  // 跳到缓冲区里最新的关键帧：只落在关键帧上，Chrome 无需预滚整个 GOP，多路时不会集体卡顿。
  // 返回是否真的跳了；积压不足以跳过一个关键帧时由倍速追帧处理。
  jumpToLive(reason = '跳到最新画面') {
    const v = this.video;
    if (this.destroyed || !this.mp || this.retryTimer || v.seeking || v.readyState < 2) return false;
    const current = v.currentTime;
    const keyframe = this.keyframeTimes.findLast?.((time) => time > current + CHASE_STOP_SECONDS &&
      this.bufferedAfter(time) >= CHASE_MIN_TAIL_SECONDS);
    if (keyframe == null) return false;
    this.liveJumpCount++;
    this.reanchor(keyframe + 0.001, reason);
    return true;
  }

  // time 所在缓冲区间在 time 之后还有多少秒数据。
  bufferedAfter(time) {
    const ranges = this.video.buffered;
    try {
      for (let i = 0; i < (ranges?.length || 0); i++) {
        if (time >= ranges.start(i) && time < ranges.end(i)) return ranges.end(i) - time;
      }
    } catch {}
    return 0;
  }

  reanchor(target, reason) {
    const now = Date.now();
    this.lastReanchorAt = now;
    this.lastAnchorAt = now;
    this.lastRecoveryAt = now;
    this.pendingReanchorAt = null;
    this.reanchorCount++;
    this.recoveryCount++;
    this.lastRecoveryReason = reason;
    this.recordSyncEvent('reanchor', reason);
    try {
      this.video.currentTime = target;
    } catch {}
    this.resetFrameSamples();
  }

  // 音频缓冲尾部减视频缓冲尾部；> 0 表示视频时间戳被前移（画面领先声音）。
  trackSkew() {
    const buffers = this.mp?._player_engine?._mse_controller?._sourceBuffers;
    const end = (sb) => {
      try {
        const ranges = sb?.buffered;
        return ranges?.length ? ranges.end(ranges.length - 1) : null;
      } catch {
        return null;
      }
    };
    const audio = end(buffers?.audio);
    const video = end(buffers?.video);
    return audio == null || video == null ? null : audio - video;
  }

  sampleSync() {
    if (this.destroyed || !this.mp || this.retryTimer || this.video.readyState < 2) return;
    if (Date.now() < this.syncAfter) return;
    const skew = this.trackSkew();
    if (!Number.isFinite(skew)) return;
    this.syncTrackSkewSeconds = skew;
    this.syncSamples++;
    // 编码端音视频交错会带来固定差值，取开播初期的中位数作基线，只追踪之后的漂移。
    if (this.syncBaselineSeconds == null) {
      this.syncBaselineSamples.push(skew);
      if (this.syncBaselineSamples.length < SYNC_BASELINE_SAMPLES) return;
      const sorted = [...this.syncBaselineSamples].sort((a, b) => a - b);
      this.syncBaselineSeconds = sorted[Math.floor(sorted.length / 2)];
      this.syncBaselineSamples = [];
      this.recordSyncEvent('sync-baseline', `${(this.syncBaselineSeconds * 1000).toFixed(0)}ms`);
    }
    const offset = skew - this.syncBaselineSeconds;
    const magnitude = Math.abs(offset);
    this.syncOffsetSeconds = offset;
    this.syncStatus = magnitude < SYNC_WARN_SECONDS ? 'normal' : offset > 0 ? 'video-leading' : 'audio-leading';
    // 追加未完成时两个缓冲尾部会短暂错开，要求连续多次超阈值才判定为漂移。
    this.syncDriftSamples = magnitude >= SYNC_REBUILD_SECONDS ? this.syncDriftSamples + 1 : 0;
    if (this.syncDriftSamples < SYNC_REBUILD_SAMPLES) return;
    const now = Date.now();
    if (now - this.lastSyncRebuildAt < SYNC_REBUILD_COOLDOWN_MS) return;
    this.lastSyncRebuildAt = now;
    this.lastRecoveryAt = now;
    this.syncRebuildCount++;
    this.recoveryCount++;
    this.lastRecoveryReason = `音画偏差 ${(offset * 1000).toFixed(0)}ms，重建播放器`;
    this.recordSyncEvent('sync-rebuild', `${(offset * 1000).toFixed(0)}ms`);
    this.fail(this.lastRecoveryReason, { force: true });
  }
  startSyncMonitor() {
    clearInterval(this.syncTimer);
    this.syncTimer = setInterval(() => {
      if (!this.silentAacReported && this.audioFilterStats?.dropped > 0) {
        this.silentAacReported = true;
        this.recordSyncEvent('silent-aac-filtered', '流中含无声 AAC 帧，已在送入 mpegts 前去掉');
      }
      this.sampleSync();
      this.maintainAnchor();
      this.maintainLatency();
    }, SYNC_OBSERVE_MS);
  }

  // lag > 0 表示画面落后于媒体时钟（声音领先）。
  recordRenderLag(lag) {
    this.renderLagSamples.push(lag);
    if (this.renderLagSamples.length > RENDER_LAG_WINDOW) this.renderLagSamples.shift();
    if (this.renderLagSamples.length < RENDER_LAG_WINDOW) return;
    const sorted = [...this.renderLagSamples].sort((a, b) => a - b);
    // 仅用于诊断：解码跟不上时原地 seek 要先预滚整个 GOP，会让播放停住数秒，得不偿失；
    // 大幅落后仍由帧异常恢复兜底。
    this.renderLagSeconds = sorted[Math.floor(sorted.length / 2)];
  }

  startFrameMonitor() {
    this.resetFrameSamples();
    if (!this.video.requestVideoFrameCallback) return;
    const epoch = ++this.frameEpoch;
    const sample = (_now, metadata) => {
      if (epoch !== this.frameEpoch || this.destroyed || !this.mp) return;
      const now = Date.now();
      if (this.pageVisible && this.frameVisible && !this.video.seeking && !this.video.paused
        && now - (this.lastFrameSampleAt || 0) >= FRAME_SAMPLE_MS) {
        this.lastFrameSampleAt = now;
        if (metadata.mediaTime !== this.lastFrameMediaTime) this.lastFrameAt = Date.now();
        this.lastFrameMediaTime = metadata.mediaTime;
        // 这是呈现时间线偏差线索，并非音频输出时间戳或精确音画差。
        this.frameSkewSeconds = Number.isFinite(metadata.mediaTime)
          ? Math.abs(this.video.currentTime - metadata.mediaTime) : null;
        if (now >= this.sampleAfter && Number.isFinite(metadata.mediaTime)) {
          this.recordRenderLag(this.video.currentTime - metadata.mediaTime);
        }
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
      this.recordSyncEvent('catch-up', this.lastRecoveryReason);
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
      if (this.destroyed || !this.mp) return;
      if (this.recordOnly) {
        // 录制停止后不再需要后台下载，按原逻辑断开等页面回到前台。
        if (!this.isRecording()) this.suspendUntilVisible();
        return;
      }
      // 页面在后台时 Chrome 会暂停静音视频，重连后的新流也会立刻被暂停。
      // 此时断开下载、等页面回到前台再连，而不是每 30 秒重连一次；录制中则只保留下载。
      if (!this.pageVisible && this.video.paused && this.liveLatency() > MAX_FORWARD_BUFFER_SECONDS) {
        if (this.isRecording()) this.enterRecordOnly();
        else this.suspendUntilVisible();
        return;
      }
      // 后向清理无法释放尚未播放的内容；后台、暂停及解码卡死也必须检查。
      if (this.liveLatency() > MAX_FORWARD_BUFFER_SECONDS) {
        this.fail('未播放缓冲超过 30 秒，释放流后重连', { force: true });
        return;
      }
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
    this.stableSince = 0;
    if (!this.online) {
      this.waitingForOnline = true;
      this.teardown();
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
    if (this.retryTimer) {
      this.retryForce ||= force;
      return;
    }
    clearInterval(this.watchdog);
    const baseDelay = Math.min(1500 * 2 ** this.retry, 20_000);
    const delay = Math.round(baseDelay * (0.8 + this.random() * 0.4));
    this.retry++;
    // 强制恢复时立即停止下载，不在退避期间继续积压数据。
    if (force) this.teardown();
    this.retryForce = force;
    this.recordSyncEvent('retry', reason);
    this.emit('retrying', `${reason}，${Math.round(delay / 1000)}s 后重连`);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = 0;
      // 等待期间可能已经自己恢复了，别去 teardown 一个正在播的播放器
      const forceReload = this.retryForce;
      this.retryForce = false;
      if (!forceReload && this.isHealthy()) {
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

  stop(reason = '') {
    if (this.mp || this.loading) this.recordSyncEvent('stop', reason);
    this.waitingForVisible = false;
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
    const next = !!visible;
    if (next === this.pageVisible) return;
    if (!next) {
      this.pageVisible = false;
      this.pageHiddenAt = Date.now();
      this.resetFrameSamples();
      this.recordSyncEvent('page-hidden');
      return;
    }

    this.recordSyncEvent('page-visible', `${Math.round((Date.now() - this.pageHiddenAt) / 1000)}s`);
    this.pageVisible = true;
    this.pageHiddenAt = 0;
    this.resetFrameSamples();
    // 仅录制期间 mpegts 缺了一段数据，必须换新连接；录制本身会在关键帧处无缝接上。
    if (this.recordOnly) {
      this.retry = 0;
      this.load({ reason: 'page-visible' });
      return;
    }
    if (this.waitingForVisible) {
      this.waitingForVisible = false;
      this.retry = 0;
      this.load({ reason: 'page-visible' });
      return;
    }
    if (!this.mp || this.retryTimer || this.waitingForOnline) return;
    if (this.video.paused && this.video.readyState >= 2) {
      this.video.play().catch(() => {});
    }
    // 切回页面时优先复用现有流；若后台期间缓冲积压，则让音视频一起追到尾部。
    if (this.liveLatency() > STALE_LATENCY_SECONDS) {
      if (this.alignRecoveredMedia()) {
        this.visibilityRecoveryCount++;
        this.lastVisibilityRecoveryAt = Date.now();
        this.lastVisibilityRecoveryReason = '切回页面后追到最新缓冲位置';
        this.recordSyncEvent('catch-up', this.lastVisibilityRecoveryReason);
      }
    }
    this.lastTime = this.video.currentTime;
    this.lastMove = Date.now();
    this.startWatchdog();
  }

  enterRecordOnly() {
    this.recordOnly = true;
    this.recordSyncEvent('record-only', '页面在后台，暂停画面，继续录制');
  }

  suspendUntilVisible() {
    this.recordSyncEvent('stop', 'hidden-paused');
    this.teardown();
    this.waitingForVisible = true;
    this.emit('suspended', '页面在后台，回到页面后自动恢复');
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
      visibilityRecoveryCount: this.visibilityRecoveryCount,
      lastVisibilityRecoveryReason: this.lastVisibilityRecoveryReason,
      state: this.state,
      retry: this.retry,
      lastError: this.lastError,
      width: this.video.videoWidth || 0,
      height: this.video.videoHeight || 0,
      bufferSeconds,
      totalFrames: quality?.totalVideoFrames || 0,
      droppedFrames: quality?.droppedVideoFrames || 0,
      currentTime: this.video.currentTime || 0,
      syncStatus: this.syncStatus,
      syncTrackSkewSeconds: this.syncTrackSkewSeconds,
      syncBaselineSeconds: this.syncBaselineSeconds,
      syncRebuildCount: this.syncRebuildCount,
      renderLagSeconds: this.renderLagSeconds,
      reanchorCount: this.reanchorCount,
      latencyChase: this.latencyChase,
      chasing: this.chasing,
      liveJumpCount: this.liveJumpCount,
      audioConfigChanges: this.audioConfigChanges,
      audioGapMs: this.audioGapMs,
      videoFps: this.videoFps,
      silentAacDropped: this.audioFilterStats?.dropped || 0,
      syncOffsetSeconds: this.syncOffsetSeconds,
      syncSamples: this.syncSamples,
      syncEvents: this.syncEvents.slice(-30),
    };
  }

  teardown() {
    this.recordOnly = false;
    this.stableSince = 0;
    this.frameEpoch++;
    if (this.frameCallback !== null) this.video.cancelVideoFrameCallback?.(this.frameCallback);
    this.frameCallback = null;
    this.pendingAlignment = false;
    // 升级阶段只对同一条连接有意义；新连接开头的 GOP 缓存积压应先正常追帧。
    this.recoveryStage = 0;
    this.resetFrameSamples();
    clearInterval(this.watchdog);
    clearInterval(this.syncTimer);
    this.syncTimer = 0;
    this.resetSyncSamples();
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
      this.chasing = false;
      this.video.playbackRate = 1;
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
    } catch {}
  }

  destroy() {
    this.video.removeEventListener('playing', this.onPlaying);
    this.video.removeEventListener('error', this.onMediaError);
    this.video.removeEventListener('timeupdate', this.onTimeUpdate);
    this.video.removeEventListener('seeking', this.onSeeking);
    this.video.removeEventListener('progress', this.onProgress);
    this.video.removeEventListener('loadeddata', this.onProgress);
    this.video.removeEventListener('waiting', this.onWaiting);
    this.video.removeEventListener('volumechange', this.onVolumeChange);
    this.destroyed = true;
    this.generation++;
    this.teardown();
  }
}
