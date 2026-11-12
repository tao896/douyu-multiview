// 「连接与性能诊断」对话框：打开期间每秒刷新，可复制纯文本、重试失败窗口。
import { diagnosticCells, diagnosticSummary, diagnosticsText } from './diagnostics.js';
import { toast } from './toast.js';

const $ = (id) => document.getElementById(id);

// collect() 返回各窗口的诊断数据；retryFailed() 重试出错窗口并返回重试个数。
export function installDiagnosticsPanel({ collect, retryFailed }) {
  const dialog = $('diagnosticsDialog');
  let timer = 0;

  function render() {
    const items = collect();
    const summary = diagnosticSummary(items);
    $('diagnosticsSummary').textContent =
      `播放 ${summary.playing} · 缓冲/重连 ${summary.pending} · 未开播 ${summary.offline} · 出错 ${summary.error}`;
    $('diagnosticsList').replaceChildren(...items.map((item) => {
      const row = document.createElement('div');
      row.className = `diagnostic-row${item.state === 'error' ? ' error' : ''}`;
      diagnosticCells(item).forEach((value, index) => {
        const node = document.createElement(index === 0 ? 'strong' : 'span');
        node.textContent = value;
        row.appendChild(node);
      });
      row.title = item.lastError || '';
      return row;
    }));
    $('retryFailedBtn').disabled = !items.some((item) => item.state === 'error');
  }

  function open() {
    render();
    if (!dialog.open) dialog.showModal();
    clearInterval(timer);
    timer = setInterval(render, 1_000);
  }

  $('diagnosticsBtn').addEventListener('click', open);
  dialog.addEventListener('close', () => {
    clearInterval(timer);
    timer = 0;
  });
  $('copyDiagnosticsBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(diagnosticsText(collect()));
      toast('诊断信息已复制');
    } catch {
      toast('复制失败，请检查浏览器剪贴板权限', 4200, true);
    }
  });
  $('retryFailedBtn').addEventListener('click', () => {
    toast(`正在重试 ${retryFailed()} 个失败窗口`);
    render();
  });

  // 窗口状态变化时只在对话框打开时重绘
  function refresh() {
    if (dialog.open) render();
  }

  return { open, refresh };
}
