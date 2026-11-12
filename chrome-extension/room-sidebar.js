// 侧栏房间列表的 DOM：每个房间一行。行内显示用的状态由 view 回调提供，按钮操作交给 actions。
// view: { isOpen(room), isVisible(room), isActive(room), batchMode() }
// actions: { open(room), remove(room), toggleNotify(room), startDrag(room, event), move(room, delta), select(room, checked) }
export function createRoomSidebar({ list, template, view, actions }) {
  const entries = new Map();

  function add(room) {
    const el = template.content.firstElementChild.cloneNode(true);
    const q = (selector) => el.querySelector(selector);
    const entry = {
      el,
      drag: q('[data-side-drag]'),
      selectWrap: q('.room-select'),
      select: q('[data-side-select]'),
      open: q('[data-side-open]'),
      remove: q('[data-side-delete]'),
      notify: q('[data-side-notify]'),
      dot: q('[data-side-dot]'),
      avatar: q('[data-side-avatar]'),
      initial: q('[data-side-initial]'),
      title: q('[data-side-title]'),
      state: q('[data-side-state]'),
      rid: q('[data-side-rid]'),
    };
    entry.avatar.addEventListener('error', () => (entry.avatar.hidden = true));
    entry.avatar.draggable = false;
    entry.open.addEventListener('click', () => actions.open(room));
    entry.remove.addEventListener('click', () => actions.remove(room));
    entry.notify.addEventListener('click', () => actions.toggleNotify(room));
    // 拖动把手和头像/名称区域都能排序；提醒、删除、选择按钮不参与拖动
    entry.drag.addEventListener('pointerdown', (event) => actions.startDrag(room, event));
    entry.open.addEventListener('pointerdown', (event) => actions.startDrag(room, event));
    // 原生图片拖拽会盖住指针事件，直接禁用
    el.addEventListener('dragstart', (event) => event.preventDefault());
    // 手柄是按钮，键盘用户也能用上下方向键调整顺序
    entry.drag.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowUp') actions.move(room, -1);
      else if (event.key === 'ArrowDown') actions.move(room, 1);
      else return;
      event.preventDefault();
    });
    entry.select.addEventListener('change', () => actions.select(room, entry.select.checked));
    entries.set(room, entry);
    list.appendChild(el);
    sync(room);
  }

  function sync(room) {
    const entry = entries.get(room);
    if (!entry) return;
    const open = view.isOpen(room);
    const batchMode = view.batchMode();
    // 左侧快捷入口以主播名作为主标题；昵称暂不可用时回退到直播间标题。
    const title = room.s.nickname || room.s.title || `房间 ${room.s.rid}`;
    const stateText = room.live === true ? '已开播' : room.live === false ? '未开播' : '检测中';
    const stateClass = room.live === true ? 'live' : room.live === false ? 'offline' : 'checking';
    const action = open ? '定位' : '打开';

    entry.el.hidden = !view.isVisible(room);
    entry.el.dataset.rid = room.s.rid;
    entry.el.classList.toggle('open', open);
    entry.el.classList.toggle('batch-mode', batchMode);
    entry.open.classList.toggle('active', view.isActive(room));
    entry.open.dataset.live = room.live == null ? 'unknown' : String(room.live);
    entry.open.title = `${action} ${title} · ${stateText} · 房间 ${room.s.rid}`;
    entry.open.setAttribute('aria-label', `${action} ${title}，${stateText}，房间 ${room.s.rid}`);
    entry.remove.setAttribute('aria-label', `从当前方案删除 ${title}`);
    entry.drag.setAttribute('aria-label', `拖动调整 ${title} 的顺序`);
    entry.drag.title = '拖动调整顺序';
    // 提醒开关的真实状态只以 room.s.notifyOnLive 为准，按钮高亮与提示始终同步
    const notifyOn = !!room.s.notifyOnLive;
    entry.notify.classList.toggle('on', notifyOn);
    entry.notify.setAttribute('aria-pressed', String(notifyOn));
    entry.notify.title = notifyOn ? '关闭开播提醒' : '开启开播提醒';
    entry.notify.setAttribute('aria-label', `${notifyOn ? '关闭' : '开启'} ${title} 的开播提醒`);
    entry.select.setAttribute('aria-label', `选择 ${title}`);
    entry.select.checked = room.selected;
    entry.selectWrap.hidden = !batchMode;
    entry.dot.className = `status-dot ${stateClass}`;
    entry.title.textContent = title;
    entry.state.textContent = stateText;
    entry.rid.textContent = `#${room.s.rid}`;
    entry.initial.textContent = [...(room.s.nickname || title || '鱼')][0] || '鱼';

    const avatar = room.s.avatar || '';
    if (entry.avatar.dataset.src !== avatar) {
      entry.avatar.dataset.src = avatar;
      entry.avatar.hidden = !avatar;
      if (avatar) entry.avatar.src = avatar;
      else entry.avatar.removeAttribute('src');
    }
  }

  // 只滚动房间列表，避免连带移动右侧正在观看的画面。
  function reveal(room) {
    requestAnimationFrame(() => {
      const el = entries.get(room)?.el;
      if (!el || el.hidden || !list.clientHeight) return;
      const listRect = list.getBoundingClientRect();
      const entryRect = el.getBoundingClientRect();
      if (entryRect.top < listRect.top) list.scrollTop += entryRect.top - listRect.top;
      else if (entryRect.bottom > listRect.bottom) list.scrollTop += entryRect.bottom - listRect.bottom;
    });
  }

  function remove(room) {
    entries.get(room)?.el.remove();
    entries.delete(room);
  }

  function clear() {
    entries.clear();
    list.replaceChildren();
  }

  // 按房间数组的顺序重排行元素
  function reorder(rooms) {
    rooms.forEach((room) => list.appendChild(entries.get(room).el));
  }

  return {
    add,
    sync,
    reveal,
    remove,
    clear,
    reorder,
    entryEl: (room) => entries.get(room)?.el,
    dragHandle: (room) => entries.get(room)?.drag,
  };
}
