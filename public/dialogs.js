// 通用对话框：以 Promise 返回 <dialog> 关闭时的 returnValue。
import { toast } from './toast.js';

const $ = (id) => document.getElementById(id);

export function dialogResult(dialog) {
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true });
  });
}

export async function confirmAction(message, { title = '请确认', confirmLabel = '确认', danger = false } = {}) {
  $('confirmTitle').textContent = title;
  $('confirmMessage').textContent = message;
  const submit = $('confirmSubmit');
  submit.textContent = confirmLabel;
  submit.classList.toggle('danger', danger);
  return (await dialogResult($('confirmDialog'))) === 'confirm';
}

// 返回去掉首尾空白、最多 40 字的名称；取消或为空时返回 null。
export async function askWorkspaceName(title, value) {
  $('workspaceNameTitle').textContent = title;
  const input = $('workspaceNameInput');
  input.value = value;
  const result = dialogResult($('workspaceNameDialog'));
  requestAnimationFrame(() => input.select());
  if ((await result) !== 'confirm') return null;
  const name = input.value.trim().slice(0, 40);
  if (!name) {
    toast('方案名称不能为空');
    return null;
  }
  return name;
}
