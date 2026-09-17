const DEFAULT_INTERVAL = 60_000;

export class RoomStatusScheduler {
  constructor({
    getRooms,
    isOpen = () => false,
    check,
    onError = () => {},
    concurrency = 3,
    intervalMs = DEFAULT_INTERVAL,
    jitterMs = 10_000,
    freshMs = 15_000,
    random = Math.random,
    now = Date.now,
    documentRef = globalThis.document,
    navigatorRef = globalThis.navigator,
  }) {
    this.getRooms = getRooms;
    this.isOpen = isOpen;
    this.check = check;
    this.onError = onError;
    this.concurrency = concurrency;
    this.intervalMs = intervalMs;
    this.jitterMs = jitterMs;
    this.freshMs = freshMs;
    this.random = random;
    this.now = now;
    this.documentRef = documentRef;
    this.navigatorRef = navigatorRef;
    this.active = 0;
    this.timer = 0;
    this.started = false;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => this.pump(), 1_000);
    this.pump();
  }

  stop() {
    this.started = false;
    clearInterval(this.timer);
    this.timer = 0;
    for (const room of this.getRooms()) this.cancel(room);
  }

  init(room, { immediate = false } = {}) {
    room.lastCheckedAt ||= 0;
    room.nextCheckAt = immediate
      ? 0
      : this.now() + this.intervalMs + this.jitter();
  }

  markChecked(room, at = this.now()) {
    room.lastCheckedAt = at;
    room.nextCheckAt = at + this.intervalMs + this.jitter();
  }

  refresh({ force = false } = {}) {
    const now = this.now();
    for (const room of this.getRooms()) {
      if (force || now - (room.lastCheckedAt || 0) >= this.freshMs) room.nextCheckAt = 0;
    }
    this.pump();
  }

  cancel(room) {
    room.statusController?.abort();
    room.statusController = null;
    room.checking = false;
  }

  jitter() {
    return Math.round((this.random() * 2 - 1) * this.jitterMs);
  }

  eligible(room, now) {
    if (room.checking || (room.nextCheckAt || 0) > now) return false;
    if (this.navigatorRef?.onLine === false) return false;
    if (this.documentRef?.hidden && !this.isOpen(room) && !room.s?.notifyOnLive) return false;
    return true;
  }

  pump() {
    if (!this.started || this.active >= this.concurrency) return;
    const now = this.now();
    const candidates = this.getRooms()
      .filter((room) => this.eligible(room, now))
      .sort((a, b) => (a.nextCheckAt || 0) - (b.nextCheckAt || 0));
    while (this.active < this.concurrency && candidates.length) this.run(candidates.shift());
  }

  async run(room) {
    if (room.checking) return;
    const controller = new AbortController();
    room.statusController = controller;
    room.checking = true;
    this.active++;
    try {
      await this.check(room, { signal: controller.signal });
      this.markChecked(room);
    } catch (error) {
      if (error?.name !== 'AbortError') this.onError(room, error);
      room.nextCheckAt = this.now() + Math.min(this.intervalMs, 15_000) + this.jitter();
    } finally {
      if (room.statusController === controller) room.statusController = null;
      room.checking = false;
      this.active--;
      this.pump();
    }
  }
}
