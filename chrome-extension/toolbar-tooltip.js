// 顶部工具栏图标按钮的悬停提示：共用一个浮层，按按钮位置摆放，避免超出窗口。
export function installToolbarTooltips(tooltip, buttons = document.querySelectorAll('.toolbar-icon-btn')) {
  let target = null;

  function position(button) {
    const gap = 8;
    const edge = 8;
    const buttonRect = button.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    let top = buttonRect.bottom + gap;
    if (top + tooltipRect.height > window.innerHeight - edge) top = buttonRect.top - tooltipRect.height - gap;
    const centered = buttonRect.left + (buttonRect.width - tooltipRect.width) / 2;
    const left = Math.min(Math.max(centered, edge), window.innerWidth - tooltipRect.width - edge);
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(Math.max(edge, top))}px`;
  }

  function show(button) {
    if (!button.dataset.tooltip) return;
    target = button;
    tooltip.textContent = button.dataset.tooltip;
    tooltip.hidden = false;
    position(button);
  }

  // 传入按钮时只在它是当前目标时才隐藏，避免移入新按钮后被旧按钮的 mouseleave 关掉。
  function hide(button) {
    if (button && target !== button) return;
    tooltip.hidden = true;
    target = null;
  }

  // 更新按钮的无障碍名称和提示文字；提示正显示在该按钮上时同步刷新。
  function setLabel(button, label, text = label) {
    button.setAttribute('aria-label', label);
    button.dataset.tooltip = text;
    if (target === button && !tooltip.hidden) {
      tooltip.textContent = text;
      position(button);
    }
  }

  buttons.forEach((button) => {
    button.addEventListener('mouseenter', () => show(button));
    button.addEventListener('mouseleave', () => hide(button));
    button.addEventListener('focus', () => show(button));
    button.addEventListener('blur', () => hide(button));
  });
  window.addEventListener('resize', () => hide());
  document.addEventListener('scroll', () => hide(), true);
  return { setLabel, hide };
}
