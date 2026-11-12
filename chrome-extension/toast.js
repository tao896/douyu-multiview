// 页面底部的轻提示；error 为 true 时用 alert 角色立即播报。
let toastTimer = 0;

export function toast(message, duration = 3200, error = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.toggle('error', !!error);
  el.setAttribute('role', error ? 'alert' : 'status');
  el.setAttribute('aria-live', error ? 'assertive' : 'polite');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), duration);
}
