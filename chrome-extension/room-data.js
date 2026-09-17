// 直接展示在看直播的今日概览，登录和数据口径由原站处理。
export class RoomDataDialog {
  constructor(dialog) {
    this.dialog = dialog;
    this.title = dialog.querySelector('[data-data-title]');
    this.room = dialog.querySelector('[data-data-room]');
    this.host = dialog.querySelector('[data-data-frame]');
    this.status = dialog.querySelector('[data-data-status]');
    this.link = dialog.querySelector('[data-data-link]');
    this.timer = 0;
    this.url = '';
    dialog.querySelector('[data-data-close]').addEventListener('click', () => this.close());
    dialog.querySelector('[data-data-refresh]').addEventListener('click', () => this.load());
    dialog.addEventListener('close', () => this.clear());
  }

  open(state) {
    const rid = String(state.rid);
    if (!/^\d{1,12}$/.test(rid)) return;
    this.url = `https://www.doseeing.com/data/room/${rid}?type=overview&dt=0`;
    this.title.textContent = `今日数据 · ${state.nickname || state.title || `房间 ${rid}`}`;
    this.room.textContent = `房间 ${rid} · 当天概览`;
    this.link.href = this.url;
    if (!this.dialog.open) this.dialog.showModal();
    this.load();
  }

  load() {
    if (!this.dialog.open || !this.url) return;
    this.clear();
    this.status.hidden = false;
    this.status.textContent = '正在加载今日数据…';
    const frame = document.createElement('iframe');
    frame.title = this.title.textContent;
    // 第三方页面保留登录与链接功能，但不能自动跳走同屏页面。
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox');
    frame.referrerPolicy = 'no-referrer';
    frame.addEventListener('load', () => {
      if (!this.host.contains(frame)) return;
      clearTimeout(this.timer);
      this.status.hidden = true;
    });
    frame.addEventListener('error', () => this.showUnavailable(frame));
    frame.src = this.url;
    this.host.replaceChildren(frame);
    this.timer = setTimeout(() => this.showUnavailable(frame), 15_000);
  }

  showUnavailable(frame) {
    if (!this.host.contains(frame)) return;
    clearTimeout(this.timer);
    this.status.hidden = false;
    this.status.textContent = '数据页暂未加载完成，可刷新重试，或在新标签页打开。';
  }

  clear() {
    clearTimeout(this.timer);
    this.host.replaceChildren();
    this.status.hidden = true;
  }

  close() {
    this.dialog.close();
    this.clear();
  }
}
