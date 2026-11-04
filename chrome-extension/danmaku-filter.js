export class DanmakuFilter {
  constructor({ keywords = [], enabled = true, dedupe = true, windowMs = 3000, minLevel = 0, maxEntries = 500 } = {}) {
    this.maxEntries = maxEntries; this.configure({ keywords, enabled, dedupe, windowMs, minLevel }); this.seen = new Map();
  }
  configure({ keywords = [], enabled = true, dedupe = true, windowMs = 3000, minLevel = 0 } = {}) {
    this.keywords = [...new Set((keywords || []).map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
    this.enabled = !!enabled; this.dedupe = !!dedupe; this.windowMs = Math.max(0, Number(windowMs) || 0);
    this.minLevel = Math.max(0, Math.floor(Number(minLevel) || 0));
  }
  // level 缺失（0）时无法判断等级，不按等级屏蔽
  accept(text, now = Date.now(), level = 0) {
    const value = String(text || '').trim(); if (!value) return false;
    if (this.minLevel > 0 && level > 0 && level < this.minLevel) return false;
    if (this.enabled && this.keywords.some((k) => value.toLowerCase().includes(k))) return false;
    if (this.dedupe && this.windowMs > 0) {
      for (const [key, at] of this.seen) if (now - at > this.windowMs) this.seen.delete(key);
      const at = this.seen.get(value); if (at !== undefined && now - at <= this.windowMs) return false;
      this.seen.set(value, now); while (this.seen.size > this.maxEntries) this.seen.delete(this.seen.keys().next().value);
    }
    return true;
  }
}
