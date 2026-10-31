// 斗鱼部分 44.1kHz 流约每秒插入一个只含 FIL/END、没有声道数据的 AAC 帧。
// mpegts 仍按 1024 个采样给它分配时间，Chrome 解码却得到 0 个采样，
// 声音因此每秒比画面快约 23ms，一直累积到下次跳转或重连。送进 mpegts 之前把这种 tag 去掉。
const FLV_SIGNATURE = [0x46, 0x4c, 0x56];
const HEADER_SIZE = 13;
const TAG_HEADER_SIZE = 11;
const PREVIOUS_TAG_SIZE = 4;
const EMPTY = new Uint8Array(0);

// raw_data_block 中是否含有声道元素（SCE/CPE/CCE/LFE）。PCE 之后无法继续解析，按有处理。
export function aacHasAudio(frame) {
  let bit = 0;
  const total = frame.length * 8;
  const read = (count) => {
    let value = 0;
    for (let i = 0; i < count; i++, bit++) value = (value << 1) | ((frame[bit >> 3] >> (7 - (bit & 7))) & 1);
    return value;
  };
  while (bit + 3 <= total) {
    const id = read(3);
    if (id <= 3 || id === 5) return true;
    if (id === 7) return false;
    if (id === 4) { // DSE
      read(4);
      const aligned = read(1);
      let count = read(8);
      if (count === 255) count += read(8);
      if (aligned) bit = (bit + 7) & ~7;
      bit += count * 8;
    } else { // FIL
      let count = read(4);
      if (count === 15) count += read(8) - 1;
      bit += count * 8;
    }
  }
  return false;
}

function concat(parts) {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

// 逐块接收 FLV 字节流，原样输出除"无声 AAC 帧"之外的所有 tag。
// 只有音频 tag 需要整块缓存后判断；视频等大 tag 边收边转发，不额外占用内存。
export class FlvAudioFilter {
  constructor() {
    this.mode = 'header';
    this.pending = EMPTY;
    this.passBytes = 0;
    this.dropped = 0;
  }

  push(chunk) {
    let data = this.pending.length ? concat([this.pending, chunk]) : chunk;
    this.pending = EMPTY;
    const out = [];
    let p = 0;
    if (this.mode === 'header') {
      // 已收到的字节一旦对不上 FLV 签名就整个透传，不做任何处理。
      if (FLV_SIGNATURE.some((byte, i) => i < data.length && data[i] !== byte)) this.mode = 'raw';
      else if (data.length < HEADER_SIZE) { this.pending = data; return EMPTY; }
      else this.mode = 'tags';
      if (this.mode === 'raw') return data;
      out.push(data.subarray(0, HEADER_SIZE));
      p = HEADER_SIZE;
    }
    if (this.mode === 'raw') return data;
    while (p < data.length) {
      if (this.passBytes) {
        const take = Math.min(this.passBytes, data.length - p);
        out.push(data.subarray(p, p + take));
        this.passBytes -= take;
        p += take;
        continue;
      }
      if (data.length - p < TAG_HEADER_SIZE) { this.pending = data.slice(p); break; }
      const type = data[p];
      const total = TAG_HEADER_SIZE + ((data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]) + PREVIOUS_TAG_SIZE;
      if (type !== 8) { this.passBytes = total; continue; }
      if (data.length - p < total) { this.pending = data.slice(p); break; }
      const body = p + TAG_HEADER_SIZE;
      // SoundFormat 10 = AAC，AACPacketType 1 = 原始帧
      const silent = (data[body] >> 4) === 10 && data[body + 1] === 1
        && !aacHasAudio(data.subarray(body + 2, p + total - PREVIOUS_TAG_SIZE));
      if (silent) this.dropped++;
      else out.push(data.subarray(p, p + total));
      p += total;
    }
    return out.length ? concat(out) : EMPTY;
  }
}
