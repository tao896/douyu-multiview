export class DanmakuFilter {
  constructor({ keywords = [], enabled = true, dedupe = true, windowMs = 3000, maxEntries = 500 } = {}) {
    this.maxEntries = maxEntries; this.configure({ keywords, enabled, dedupe, windowMs }); this.seen = new Map();
  }
  configure({ keywords = [], enabled = true, dedupe = true, windowMs = 3000 } = {}) {
    this.keywords = [...new Set((keywords || []).map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
    this.enabled = !!enabled; this.dedupe = !!dedupe; this.windowMs = Math.max(0, Number(windowMs) || 0);
  }
  accept(text, now = Date.now()) {
    const value = String(text || '').trim(); if (!value) return false;
    if (this.enabled && this.keywords.some((k) => value.toLowerCase().includes(k))) return false;
    if (this.dedupe && this.windowMs > 0) {
      for (const [key, at] of this.seen) if (now - at > this.windowMs) this.seen.delete(key);
      const at = this.seen.get(value); if (at !== undefined && now - at <= this.windowMs) return false;
      this.seen.set(value, now); while (this.seen.size > this.maxEntries) this.seen.delete(this.seen.keys().next().value);
    }
    return true;
  }
}
