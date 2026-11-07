// 侧栏拖动排序：只按当前可见行的中点判断插入位置。
// 筛选状态下把房间放到目标房间旁边，其余（含被筛掉的）房间保持原有相对顺序。
import { autoScrollDelta } from './state.js';

// entryEl(room) 返回侧栏行元素，dragHandle(room) 返回用于捕获指针的把手；
// onDrop(room, target, position) 在一次有效拖动结束时调用。
export function installRoomDrag({ list, visibleRooms, entryEl, dragHandle, onDrop }) {
  let roomDrag = null;

  function clearRoomDropMarks() {
    list.querySelectorAll('.drop-before, .drop-after')
      .forEach((node) => node.classList.remove('drop-before', 'drop-after'));
  }

  function resolveRoomDrop(clientY) {
    const visible = visibleRooms()
      .map((room) => ({ room, el: entryEl(room) }))
      .filter((item) => item.el && !item.el.hidden);
    if (!visible.length) return null;
    let target = visible[visible.length - 1];
    let position = 'after';
    for (const item of visible) {
      const rect = item.el.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        target = item;
        position = 'before';
        break;
      }
    }
    return { target: target.room, position };
  }

  function showRoomDropMark(target, position) {
    clearRoomDropMarks();
    entryEl(target)?.classList.add(position === 'before' ? 'drop-before' : 'drop-after');
  }

  function autoScrollRoomList() {
    if (!roomDrag) return;
    const rect = list.getBoundingClientRect();
    const delta = autoScrollDelta(roomDrag.y, rect.top, rect.bottom);
    if (!delta) return;
    const before = list.scrollTop;
    list.scrollTop += delta;
    return list.scrollTop !== before;
  }

  function updateRoomDrag(clientY) {
    if (!roomDrag) return;
    roomDrag.y = clientY;
    autoScrollRoomList();
    const drop = resolveRoomDrop(clientY);
    roomDrag.target = drop?.target || null;
    roomDrag.position = drop?.position || 'after';
    if (drop) showRoomDropMark(drop.target, drop.position);
    else clearRoomDropMarks();
  }

  function autoScrollTick() {
    if (!roomDrag) return;
    autoScrollRoomList();
    const drop = resolveRoomDrop(roomDrag.y);
    if (drop) {
      roomDrag.target = drop.target;
      roomDrag.position = drop.position;
      showRoomDropMark(drop.target, drop.position);
    }
    roomDrag.raf = requestAnimationFrame(autoScrollTick);
  }

  function endRoomDrag({ commit = true } = {}) {
    if (!roomDrag) return;
    cancelAnimationFrame(roomDrag.raf);
    const { room, target, position } = roomDrag;
    roomDrag = null;
    // 指针捕获由浏览器在 pointerup/pointercancel 时自动释放，无需手动 release
    document.body.classList.remove('room-dragging');
    entryEl(room)?.classList.remove('dragging');
    clearRoomDropMarks();
    if (!commit || !target || target === room) return;
    onDrop(room, target, position);
  }

  function startRoomDrag(room, event) {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    const el = entryEl(room);
    if (!el || el.hidden) return;
    // 这里既不 preventDefault 也不捕获指针：否则浏览器会把随后的 click 重定向到
    // 拖动把手上，行内“打开/定位”按钮永远收不到点击。只有指针真正移动超过阈值
    // 才进入拖动状态（见 beginRoomDrag），单击仍然走各自的 click 处理。
    roomDrag = {
      room,
      pointerId: event.pointerId,
      captureTarget: dragHandle(room),
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      target: null,
      position: 'after',
      raf: 0,
      moved: false,
    };
  }

  // 指针移动超过阈值后才算拖动：此时才阻止默认行为、捕获指针并显示拖动样式。
  function beginRoomDrag() {
    if (!roomDrag) return;
    const { room, pointerId, captureTarget } = roomDrag;
    roomDrag.moved = true;
    captureTarget?.setPointerCapture?.(pointerId);
    document.body.classList.add('room-dragging');
    entryEl(room)?.classList.add('dragging');
    roomDrag.raf = requestAnimationFrame(autoScrollTick);
  }

  function onRoomDragMove(event) {
    if (!roomDrag || event.pointerId !== roomDrag.pointerId) return;
    if (!roomDrag.moved) {
      if (Math.hypot(event.clientX - roomDrag.startX, event.clientY - roomDrag.startY) < 4) return;
      beginRoomDrag();
    }
    event.preventDefault();
    updateRoomDrag(event.clientY);
  }

  function onRoomDragEnd(event) {
    if (!roomDrag || event.pointerId !== roomDrag.pointerId) return;
    const moved = roomDrag.moved;
    endRoomDrag();
    // 拖动结束后浏览器可能补发一次 click（触屏尤其明显）；吞掉紧接着的那一次，
    // 避免拖动结束时误触打开房间、提醒或删除。下一次 pointerdown 会解除标记，
    // 因此不会影响随后的正常点击。
    if (moved) suppressNextRoomClick = true;
  }

  // 一次真实拖动后的 click 不应触发任何行内操作（打开、提醒、删除）
  let suppressNextRoomClick = false;

  document.addEventListener('pointerdown', () => { suppressNextRoomClick = false; }, true);
  document.addEventListener('click', (event) => {
    if (!suppressNextRoomClick) return;
    suppressNextRoomClick = false;
    if (!event.target.closest?.('.room-row')) return;
    event.stopPropagation();
    event.preventDefault();
  }, true);

  document.addEventListener('pointermove', onRoomDragMove, { passive: false });
  document.addEventListener('pointerup', onRoomDragEnd);
  document.addEventListener('pointercancel', () => endRoomDrag({ commit: false }));

  return { start: startRoomDrag };
}
