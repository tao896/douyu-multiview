// 弹幕渲染：canvas 滚动弹幕，按窗口高度自动缩放字号与轨道数
const FONT = '600 %dpx -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
const COLORS = { 1: '#ff5c5c', 2: '#4d8cff', 3: '#5ec46a', 4: '#ff9c2e', 5: '#c86bff', 6: '#ff6bb5' };
const DURATION = 8;   // 一条弹幕横穿窗口的秒数
const MAX_ITEMS = 240; // 屏上上限，防弹幕刷屏拖垮渲染

export class DanmakuRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.items = [];
    this.tracks = [];
    this.enabled = false;
    this.opacity = 1;
    this.speed = 1;
    this.active = true;
    this.w = 0;
    this.h = 0;
    this.font = 16;
    this.lineH = 24;
    this.raf = 0;
    this.last = 0;
    // 观察父容器而不是 canvas 自身，避免「改 canvas 尺寸 → 又触发观察」的回环
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas.parentElement || canvas);
    this.resize();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = r.width;
    this.h = r.height;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.textBaseline = 'top';
    this.font = Math.max(12, Math.min(22, Math.round(r.height / 20)));
    this.lineH = Math.round(this.font * 1.5);
    // 弹幕只占上部 70%，不挡主播和字幕
    const n = Math.max(1, Math.floor((r.height * 0.7) / this.lineH));
    this.tracks = Array.from({ length: n }, (_, i) => this.tracks[i] ?? null);
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (on && this.active) this.start();
    else this.stop();
  }

  setActive(active) {
    this.active = !!active;
    if (this.active && this.enabled) this.start();
    else this.stop();
  }

  setOpacity(v) {
    this.opacity = Math.max(0.1, Math.min(1, v));
  }

  setSpeed(value) {
    const next = Math.max(0.5, Math.min(2, Number(value) || 1));
    const ratio = next / this.speed;
    this.speed = next;
    // 已经在画面上的弹幕也立即跟随全局速度，避免只对新弹幕生效。
    this.items.forEach((item) => {
      item.speed *= ratio;
    });
  }

  // 挑一条尾部已经走开的轨道；全占用就丢弃这条弹幕
  pickTrack(width) {
    for (let i = 0; i < this.tracks.length; i++) {
      const prev = this.tracks[i];
      if (!prev || prev.x + prev.width < this.w - 28) return i;
    }
    return -1;
  }

  push(text, colorId) {
    if (!this.enabled || !this.active || !this.w || !text) return;
    if (this.items.length >= MAX_ITEMS) return;
    const ctx = this.ctx;
    ctx.font = FONT.replace('%d', this.font);
    const width = ctx.measureText(text).width;
    const track = this.pickTrack(width);
    if (track < 0) return;
    const item = {
      text,
      color: COLORS[colorId] || '#ffffff',
      width,
      x: this.w,
      y: track * this.lineH + 4,
      speed: ((this.w + width) / DURATION) * this.speed,
    };
    this.items.push(item);
    this.tracks[track] = item;
    this.start();
  }

  start() {
    if (this.raf || !this.enabled || !this.active) return;
    this.last = performance.now();
    const loop = (now) => {
      const dt = Math.min((now - this.last) / 1000, 0.1); // 切后台回来不要一次跳太多
      this.last = now;
      this.raf = 0;
      this.tick(dt);
      if (this.enabled && this.active && this.items.length) this.raf = requestAnimationFrame(loop);
      else this.clear();
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.items.length = 0;
    this.tracks = this.tracks.map(() => null);
    this.clear();
  }

  clear() {
    this.ctx.clearRect(0, 0, this.w, this.h);
  }

  tick(dt) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.font = FONT.replace('%d', this.font);
    ctx.globalAlpha = this.opacity;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,.85)';
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.x -= it.speed * dt;
      if (it.x + it.width < 0) {
        this.items.splice(i, 1);
        continue;
      }
      ctx.strokeText(it.text, it.x, it.y); // 描边保证亮底也看得清
      ctx.fillStyle = it.color;
      ctx.fillText(it.text, it.x, it.y);
    }
    ctx.globalAlpha = 1;
  }

  destroy() {
    this.ro.disconnect();
    this.stop();
  }
}
