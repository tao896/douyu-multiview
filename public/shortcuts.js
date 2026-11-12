// 全局快捷键与长按 Ctrl。输入框、下拉框获得焦点或有对话框打开时不响应字母、数字键。

// 只有会消费字符按键的控件才拦截全局快捷键；滑块、复选框、按钮等点过后焦点会留在上面，
// 不能因此让快捷键失效。
const NON_TEXT_INPUT_TYPES = new Set([
  'range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file', 'image',
]);

export function isEditableTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.matches('textarea, select')) return true;
  return target instanceof HTMLInputElement && !NON_TEXT_INPUT_TYPES.has(target.type);
}

function hasOpenDialog() {
  return !!document.querySelector('dialog[open]');
}

function closeTopDialog() {
  const open = document.querySelector('dialog[open]');
  if (!open) return false;
  open.close('cancel');
  return true;
}

// keys：小写按键 → 处理函数；onDigit(n) 处理 1～9；onEscape 在没有对话框可关时调用。
export function installShortcuts({ keys, onDigit, onEscape }) {
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'Escape') {
      if (!closeTopDialog()) onEscape();
      return;
    }
    if (isEditableTarget(event.target) || hasOpenDialog()) return;
    const handler = keys[event.key.toLowerCase()];
    if (handler) handler();
    else if (/^[1-9]$/.test(event.key)) onDigit(Number(event.key));
    else return;
    event.preventDefault();
  });
}

// 按住 Ctrl 超过 delay 毫秒触发一次；cancel() 取消尚未触发的长按。
export function installCtrlLongPress({ onTrigger, delay = 300 }) {
  let timer = 0;
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Control' || event.repeat || event.metaKey) return;
    if (isEditableTarget(event.target) || hasOpenDialog()) return;
    timer = setTimeout(onTrigger, delay);
  });
  document.addEventListener('keyup', (event) => {
    if (event.key === 'Control') clearTimeout(timer);
  });
  return { cancel: () => { clearTimeout(timer); timer = 0; } };
}
