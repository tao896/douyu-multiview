// 播放窗口拖动换位：只能从标题栏把手拖起，放到另一个窗口上时两者互换位置，
// 其余窗口不动；结束后按网格中的 DOM 顺序回调 onReorder。
let dragging = null;

export function makeTileDraggable(tile, { grid, onReorder }) {
  const handle = tile.el.querySelector('[data-drag-handle]');
  handle.addEventListener('mousedown', () => (tile.el.draggable = true));
  handle.addEventListener('mouseup', () => (tile.el.draggable = false));
  tile.el.addEventListener('dragstart', (event) => {
    dragging = tile;
    tile.el.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', tile.s.rid);
  });
  tile.el.addEventListener('dragend', () => {
    tile.el.classList.remove('dragging');
    tile.el.draggable = false;
    dragging = null;
    grid.querySelectorAll('.drop-target').forEach((node) => node.classList.remove('drop-target'));
    onReorder([...grid.children].map((node) => node.dataset.rid));
  });
  tile.el.addEventListener('dragover', (event) => {
    if (!dragging || dragging === tile) return;
    event.preventDefault();
    tile.el.classList.add('drop-target');
  });
  tile.el.addEventListener('dragleave', () => tile.el.classList.remove('drop-target'));
  tile.el.addEventListener('drop', (event) => {
    if (!dragging || dragging === tile) return;
    event.preventDefault();
    tile.el.classList.remove('drop-target');
    // 用占位节点交换两个窗口，相邻或不相邻都适用
    const marker = document.createComment('');
    dragging.el.replaceWith(marker);
    tile.el.replaceWith(dragging.el);
    marker.replaceWith(tile.el);
  });
}
