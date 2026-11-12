// 单直播间录制：旁路截取加载器已过滤的 FLV 字节，不重新编码，原样写成 .flv。
// 中途开始录制时补写 FLV 头、onMetaData 和音视频编码配置，并从下一个关键帧起录，
// 时间戳改为从 0 开始；断线重连后接着上一段的时间继续写，文件保持可连续播放。
const HEADER_SIZE = 13;
const TAG_HEADER_SIZE = 11;
const PREVIOUS_TAG_SIZE = 4;
const PEEK_SIZE = TAG_HEADER_SIZE + 5;
const FRAME_GAP = 40; // 重连拼接处两段之间留一帧左右的间隔（毫秒）
export const SEGMENT_MS = 30 * 60_000; // 录制中每 30 分钟在关键帧处换一个文件，已写完的文件可直接打开
export const FILE_START = Symbol('flv-file-start'); // push() 输出中的标记：其后的字节属于一个新文件

function concat(parts) {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

// 根据 tag 头和正文前几个字节分类。兼容传统 FLV 与 Enhanced RTMP（HEVC/AV1 等）。
export function classifyTag(peek) {
  const type = peek[0] & 0x1f;
  const size = (peek[1] << 16) | (peek[2] << 8) | peek[3];
  const b0 = size > 0 ? peek[TAG_HEADER_SIZE] : 0;
  const b1 = size > 1 ? peek[TAG_HEADER_SIZE + 1] : -1;
  if (type === 18) return 'meta';
  if (type === 9) {
    const frameType = (b0 >> 4) & 0x07;
    if (frameType === 5) return 'other'; // 视频信息/命令帧
    if (b0 & 0x80) { // Enhanced：低 4 位是 PacketType，0 = SequenceStart
      const packetType = b0 & 0x0f;
      if (packetType === 0) return 'video-config';
      return frameType === 1 ? 'video-key' : 'video';
    }
    const codec = b0 & 0x0f;
    if ((codec === 7 || codec === 12) && b1 === 0) return 'video-config';
    return frameType === 1 ? 'video-key' : 'video';
  }
  if (type === 8) {
    const format = b0 >> 4;
    if (format === 10 && b1 === 0) return 'audio-config';
    if (format === 9 && (b0 & 0x0f) === 0) return 'audio-config'; // Enhanced 音频 SequenceStart
    return 'audio';
  }
  return 'other';
}

function tagTime(tag) {
  return ((tag[7] << 24) | (tag[4] << 16) | (tag[5] << 8) | tag[6]) >>> 0;
}

// 只比较 tag 正文（去掉 11 字节头和 4 字节尾）：同一配置在不同连接里时间戳不同。
function sameTagBody(a, b) {
  if (a.length !== b.length) return false;
  for (let i = TAG_HEADER_SIZE; i < a.length - PREVIOUS_TAG_SIZE; i++) if (a[i] !== b[i]) return false;
  return true;
}

function withTime(tag, time) {
  const out = tag.slice();
  out[4] = (time >> 16) & 0xff;
  out[5] = (time >> 8) & 0xff;
  out[6] = time & 0xff;
  out[7] = (time >>> 24) & 0xff;
  return out;
}

// 逐块解析 FLV；不录制时只缓存头和编码配置，其余 tag 直接跳过。
// 每个输出文件都以 FILE_START 标记开头，文件内时间戳从 0 开始。
export class FlvRemuxer {
  constructor({ segmentMs = 0 } = {}) {
    this.segmentMs = segmentMs;
    this.token = null;
    this.recording = false;
    this.headerWritten = false;
    this.offset = 0;
    this.lastTime = -1;
    this.fileConfigs = null; // 当前文件里已写入的音视频编码配置
    this.splitReason = '';
    this.resetStream();
  }

  resetStream() {
    this.mode = 'header';
    this.pending = new Uint8Array(0);
    this.collect = null;   // { parts, left, kind }
    this.skip = 0;
    this.header = null;
    this.meta = this.videoConfig = this.audioConfig = null;
    this.base = -1;        // 当前段的起始时间戳；-1 表示等待关键帧
  }

  get unsupported() { return this.mode === 'raw'; }

  start() {
    this.recording = true;
    this.endFile();
  }

  stop() { this.recording = false; }

  // 结束当前文件（如下播）；保持录制状态，下一个关键帧开新文件。
  endFile() {
    this.headerWritten = false;
    this.offset = 0;
    this.lastTime = -1;
    this.base = -1;
    this.fileConfigs = null;
  }

  // 上一个文件为什么结束：reconfigure 表示新连接换了编码配置；其余为 split。
  takeSplitReason() {
    const reason = this.splitReason || 'split';
    this.splitReason = '';
    return reason;
  }

  // token 区分不同连接：每条新连接都从 FLV 头重新开始。
  push(chunk, token) {
    if (token !== this.token) {
      const continuing = this.recording && this.lastTime >= 0;
      this.token = token;
      this.resetStream();
      if (continuing) this.offset = this.lastTime + FRAME_GAP;
    }
    const out = [];
    let data = this.pending.length ? concat([this.pending, chunk]) : chunk;
    this.pending = new Uint8Array(0);
    let p = 0;
    if (this.mode === 'header') {
      if (data.length < HEADER_SIZE) { this.pending = data.slice(); return out; }
      if (data[0] !== 0x46 || data[1] !== 0x4c || data[2] !== 0x56) { this.mode = 'raw'; return out; }
      this.header = data.slice(0, HEADER_SIZE);
      this.mode = 'tags';
      p = HEADER_SIZE;
    }
    if (this.mode === 'raw') return out;
    while (p < data.length) {
      if (this.skip) {
        const take = Math.min(this.skip, data.length - p);
        this.skip -= take;
        p += take;
        continue;
      }
      if (this.collect) {
        const take = Math.min(this.collect.left, data.length - p);
        this.collect.parts.push(data.slice(p, p + take));
        this.collect.left -= take;
        p += take;
        if (!this.collect.left) {
          const { parts, kind } = this.collect;
          this.collect = null;
          this.handleTag(concat(parts), kind, out);
        }
        continue;
      }
      if (data.length - p < PEEK_SIZE) { this.pending = data.slice(p); break; }
      const total = TAG_HEADER_SIZE + ((data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]) + PREVIOUS_TAG_SIZE;
      const kind = classifyTag(data.subarray(p, p + PEEK_SIZE));
      if (this.wants(kind)) this.collect = { parts: [], left: total, kind };
      else this.skip = total;
    }
    return out;
  }

  wants(kind) {
    return kind === 'meta' || kind === 'video-config' || kind === 'audio-config'
      || (this.recording && kind !== 'other');
  }

  handleTag(tag, kind, out) {
    if (kind === 'meta') { this.meta = tag; return; }
    if (kind === 'video-config' || kind === 'audio-config') {
      this[kind === 'video-config' ? 'videoConfig' : 'audioConfig'] = tag;
      // 段内编码参数变化（如分辨率切换）需要把新配置也写进文件。
      if (this.recording && this.base >= 0) {
        out.push(withTime(tag, this.lastTime));
        if (this.fileConfigs) this.fileConfigs[kind === 'video-config' ? 'video' : 'audio'] = tag;
      }
      return;
    }
    if (!this.recording) return;
    if (this.base >= 0) {
      // 同一连接里时间戳大幅回退或跳跃（CDN 切换上游）时，从下一个关键帧开新段。
      const t = tagTime(tag) - this.base;
      const expected = this.lastTime - this.offset;
      if (t < expected - 1000 || t > expected + 10_000) {
        this.offset = this.lastTime + FRAME_GAP;
        this.base = -1;
      }
    }
    // 当前文件够长时，在关键帧（纯音频流则任一音频帧）处换新文件。
    if (this.base >= 0 && this.segmentMs && this.offset + tagTime(tag) - this.base >= this.segmentMs
      && kind === (this.header[4] & 0x01 ? 'video-key' : 'audio')) {
      this.endFile();
    }
    if (this.base < 0) {
      const hasVideo = !!(this.header[4] & 0x01);
      if (hasVideo ? kind !== 'video-key' : kind !== 'audio') return;
      this.beginSegment(tagTime(tag), out);
    }
    const t = tagTime(tag) - this.base;
    if (t < 0) return; // 关键帧之前的音频
    const time = this.offset + t;
    this.lastTime = Math.max(this.lastTime, time);
    out.push(withTime(tag, time));
  }

  beginSegment(time, out) {
    // 重连后编码配置变了（切清晰度、改用 H.265 等）：分辨率或编码不同的两段混在一个 FLV 里，
    // 很多播放器会花屏或无法拖动，因此不接在原文件后面，而是在这个关键帧处另起新文件。
    if (this.headerWritten && this.configChanged()) {
      this.endFile();
      this.splitReason = 'reconfigure';
    }
    this.base = time;
    if (!this.headerWritten) {
      this.headerWritten = true;
      out.push(FILE_START, this.header);
      if (this.meta) out.push(withTime(this.meta, 0));
    }
    if (this.videoConfig) out.push(withTime(this.videoConfig, this.offset));
    if (this.audioConfig) out.push(withTime(this.audioConfig, this.offset));
    this.fileConfigs = { video: this.videoConfig, audio: this.audioConfig };
    this.lastTime = Math.max(this.lastTime, this.offset);
  }

  // 新连接还没收到的配置不算变化，避免配置晚到时误拆文件。
  configChanged() {
    const written = this.fileConfigs;
    if (!written) return false;
    const differs = (next, previous) => !!next && !!previous && !sameTagBody(next, previous);
    return differs(this.videoConfig, written.video) || differs(this.audioConfig, written.audio);
  }
}

const FLUSH_BYTES = 1 << 20;
const FLUSH_MS = 2000;

export function recordingFileName(nickname, rid, date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  const name = String(nickname || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '').trim().slice(0, 40);
  return `${name ? name + '-' : ''}${rid}-${stamp}.flv`;
}

// 一个输出文件。open() 异步拿到可写流前收到的数据先排队，不丢字节。
// 没有目录句柄（浏览器不支持 File System Access）时存在内存，文件结束时下载。
export class RecordingSink {
  constructor(fileName, open = null) {
    this.fileName = fileName;
    this.blobs = [];
    this.parts = [];
    this.partBytes = 0;
    this.bytes = 0;
    this.lastFlush = Date.now();
    this.error = null;
    this.onError = null;
    this.writable = null;
    this.toDisk = !!open;
    this.queue = open ? Promise.resolve().then(open).then((writable) => { this.writable = writable; })
      .catch((error) => this.fail(error)) : Promise.resolve();
  }

  fail(error) {
    if (this.error) return;
    this.error = error;
    this.onError?.(error);
  }

  write(parts) {
    if (this.error) return;
    for (const part of parts) {
      this.parts.push(part);
      this.partBytes += part.length;
      this.bytes += part.length;
    }
    if (this.partBytes >= FLUSH_BYTES || Date.now() - this.lastFlush >= FLUSH_MS) this.flush();
  }

  flush() {
    this.lastFlush = Date.now();
    if (!this.parts.length) return this.queue;
    const blob = new Blob(this.parts, { type: 'video/x-flv' });
    this.parts = [];
    this.partBytes = 0;
    if (!this.toDisk) { this.blobs.push(blob); return this.queue; }
    this.queue = this.queue.then(() => this.error || this.writable.write(blob)).catch((error) => this.fail(error));
    return this.queue;
  }

  // 写盘模式必须 close() 才会把临时文件（.crswap）落成正式文件。
  async finish() {
    await this.flush();
    if (this.toDisk) {
      if (this.error) {
        await this.writable?.abort?.().catch(() => {});
        throw this.error;
      }
      await this.writable.close();
      return;
    }
    if (!this.bytes) return;
    const url = URL.createObjectURL(new Blob(this.blobs, { type: 'video/x-flv' }));
    this.blobs = [];
    const a = document.createElement('a');
    a.href = url;
    a.download = this.fileName;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

// reserved 记下本次已分配的文件名：几个文件可能在同一秒内并发打开，只查磁盘会撞名互相覆盖。
async function uniqueFile(dir, fileName, reserved) {
  const dot = fileName.lastIndexOf('.');
  for (let i = 1; i < 100; i++) {
    const name = i === 1 ? fileName : `${fileName.slice(0, dot)}-${i}${fileName.slice(dot)}`;
    if (reserved.has(name)) continue;
    reserved.add(name);
    try {
      await dir.getFileHandle(name);
    } catch (error) {
      if (error?.name === 'NotFoundError') return dir.getFileHandle(name, { create: true });
      reserved.delete(name);
      throw error;
    }
  }
  throw new Error('同名文件过多');
}

// 单个直播间的录制会话：用户开启后一直处于"待录"状态，直到手动停止。
// 有流就写文件，按 SEGMENT_MS 分段；下播结束当前文件，再开播自动新建文件继续录。
export class RoomRecorder {
  constructor({ getName, onEvent }) {
    this.getName = getName;      // () => ({ nickname, rid })
    this.onEvent = onEvent || (() => {});
    this.remuxer = new FlvRemuxer({ segmentMs: SEGMENT_MS });
    this.armed = false;
    this.arming = false;
    this.dir = null;
    this.sink = null;
    this.startedAt = 0;          // 本次开启录制的时间
    this.files = 0;              // 已开始的文件数
    this.bytes = 0;              // 已写入的总字节数（含已完成的文件）
    this.saving = new Set();
    this.reservedNames = new Set();
  }

  get unsupported() { return this.remuxer.unsupported; }

  // 必须在点击事件里同步调用：选目录对话框需要用户手势。
  async arm() {
    if (this.armed || this.arming) return;
    this.arming = true;
    try {
      if (typeof window.showDirectoryPicker === 'function') {
        this.dir = await window.showDirectoryPicker({ id: 'douyu-recordings', mode: 'readwrite', startIn: 'videos' });
      }
    } catch (error) {
      this.arming = false;
      if (error?.name !== 'AbortError') this.onEvent({ type: 'error', message: `录制失败：${error?.message || error}` });
      return;
    }
    this.arming = false;
    this.armed = true;
    this.startedAt = Date.now();
    this.files = 0;
    this.bytes = 0;
    this.remuxer.start();
    this.onEvent({ type: 'armed', dir: this.dir?.name || '' });
  }

  push(chunk, token) {
    const out = this.remuxer.push(chunk, token);
    if (this.remuxer.unsupported && this.armed) {
      this.onEvent({ type: 'error', message: '当前流不是 FLV 格式，无法录制' });
      this.disarm();
      return;
    }
    let start = 0;
    for (let i = 0; i <= out.length; i++) {
      if (i < out.length && out[i] !== FILE_START) continue;
      if (i > start) this.write(out.slice(start, i));
      if (i < out.length) {
        this.closeFile(this.remuxer.takeSplitReason());
        this.openFile();
      }
      start = i + 1;
    }
  }

  write(parts) {
    if (!this.sink) return;
    this.sink.write(parts);
    for (const part of parts) this.bytes += part.length;
  }

  openFile() {
    const { nickname, rid } = this.getName();
    const fileName = recordingFileName(nickname, rid);
    const dir = this.dir;
    const sink = new RecordingSink(fileName, dir ? async () => {
      const handle = await uniqueFile(dir, fileName, this.reservedNames);
      sink.fileName = handle.name;
      return handle.createWritable();
    } : null);
    sink.onError = (error) => {
      if (this.sink !== sink) return;
      this.onEvent({ type: 'error', message: `录制写入失败：${error?.message || error}` });
      this.disarm();
    };
    this.sink = sink;
    this.files++;
    this.onEvent({ type: 'file', fileName });
  }

  // reason: split（分段）/ reconfigure（清晰度或编码变化，另起新文件）/ offline（下播）/ stop（手动停止）
  closeFile(reason) {
    const sink = this.sink;
    if (!sink) return Promise.resolve();
    this.sink = null;
    const done = sink.finish().then(
      () => this.onEvent({ type: 'saved', reason, fileName: sink.fileName, bytes: sink.bytes, toDisk: sink.toDisk }),
      (error) => this.onEvent({ type: 'error', message: `录制保存失败：${error?.message || error}` }),
    ).finally(() => this.saving.delete(done));
    this.saving.add(done);
    return done;
  }

  // 下播：结束当前文件，保持待录；再开播时从第一个关键帧起写新文件。
  endSession() {
    if (!this.armed) return;
    this.remuxer.endFile();
    this.closeFile('offline');
  }

  async disarm() {
    if (!this.armed) return;
    this.armed = false;
    this.remuxer.stop();
    this.closeFile('stop');
    this.onEvent({ type: 'disarmed' });
    await Promise.all(this.saving);
  }
}
