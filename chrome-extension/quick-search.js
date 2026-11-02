import { fetchJson } from './net.js';

export function bindQuickSearch({ panel, input, results, status, onOpen }) {
  let timer, controller, version = 0, candidates = [], selected = -1, composing = false;
  const direct = value => /^\d{1,12}$/.test(value) || /^(?:https?:\/\/)?(?:www\.|m\.)?douyu\.com\//i.test(value);
  function cancel() {
    clearTimeout(timer);
    controller?.abort();
    controller = null;
    version++;
  }
  function render() {
    results.replaceChildren(...candidates.map((room, index) => {
      const row = document.createElement('div');
      row.id = `quick-room-${index}`;
      row.className = 'quick-search-option';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(index === selected));
      if (room.avatar) {
        const image = document.createElement('img');
        image.src = room.avatar; image.alt = ''; image.referrerPolicy = 'no-referrer';
        row.append(image);
      }
      const label = document.createElement('div');
      label.textContent = `${room.nickname} · ${room.rid} · ${room.live ? '直播中' : '未开播'}`;
      row.append(label);
      row.addEventListener('pointerdown', event => event.preventDefault());
      row.addEventListener('click', () => choose(room.rid));
      return row;
    }));
    input.setAttribute('aria-expanded', String(candidates.length > 0));
    if (selected >= 0) input.setAttribute('aria-activedescendant', `quick-room-${selected}`);
    else input.removeAttribute('aria-activedescendant');
  }
  function close() { cancel(); panel.hidden = true; candidates = []; selected = -1; render(); }
  function open() {
    cancel(); panel.hidden = false; composing = false;
    input.value = ''; status.textContent = ''; candidates = []; selected = -1; render(); input.focus();
  }
  function choose(value) { close(); onOpen(value); }
  function search() {
    cancel(); candidates = []; selected = -1; render(); status.textContent = '';
    const query = input.value.trim();
    if (composing || !query || direct(query) || panel.hidden) return;
    const requestVersion = version;
    status.textContent = '正在搜索…';
    timer = setTimeout(async () => {
      controller = new AbortController();
      try {
        const data = await fetchJson(`/api/search?keyword=${encodeURIComponent(query)}`, { signal: controller.signal });
        if (version !== requestVersion || panel.hidden) return;
        candidates = data.rooms; selected = candidates.length ? 0 : -1;
        status.textContent = candidates.length ? '' : '没有找到匹配的主播';
        render();
      } catch (error) {
        if (version !== requestVersion || panel.hidden) return;
        status.textContent = `搜索失败：${error.message}，请修改关键词重试`;
      }
    }, 300);
  }
  input.addEventListener('input', search);
  input.addEventListener('compositionstart', () => { composing = true; cancel(); candidates = []; selected = -1; render(); status.textContent = ''; });
  input.addEventListener('compositionend', () => { composing = false; search(); });
  input.addEventListener('keydown', event => {
    if (composing || event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (['ArrowUp', 'ArrowDown'].includes(event.key) && candidates.length) {
      event.preventDefault();
      selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + candidates.length) % candidates.length;
      render(); document.getElementById(`quick-room-${selected}`)?.scrollIntoView({ block: 'nearest' });
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const value = input.value.trim();
      if (direct(value)) choose(value);
      else if (selected >= 0) choose(candidates[selected].rid);
    }
  });
  return { open, close };
}
