// 配置备份与导入：导出全部观看方案为 JSON；导入时可合并为新方案或替换全部（替换前自动备份）。
import { confirmAction } from './dialogs.js';
import { createBackup, parseBackup, prepareImportedWorkspaces } from './state.js';
import { toast } from './toast.js';

const $ = (id) => document.getElementById(id);
const MAX_BACKUP_BYTES = 5 * 1024 * 1024;

// getState() 返回已同步当前页面状态的 appState；onReplace / onMerge 接收整理好的方案列表。
export function installBackupUi({ getState, onReplace, onMerge }) {
  const dialog = $('importDialog');
  let pendingImport = null;

  function downloadBackup({ notify = true } = {}) {
    const backup = createBackup(getState());
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const stamp = backup.exportedAt.slice(0, 19).replace(/[:T]/g, '-');
    link.href = url;
    link.download = `douyu-multiview-${stamp}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    if (notify) toast('配置备份已下载');
  }

  $('backupBtn').addEventListener('click', () => downloadBackup());
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > MAX_BACKUP_BYTES) return toast('备份文件超过 5MB，已拒绝导入', 4500, true);
    try {
      pendingImport = parseBackup(await file.text());
      const { workspaceCount, roomCount, invalidCount } = pendingImport.stats;
      $('importSummary').textContent =
        `检测到 ${workspaceCount} 个观看方案、${roomCount} 个房间` +
        (invalidCount ? `，将忽略 ${invalidCount} 个无效条目。` : '。');
      dialog.querySelector('input[value="merge"]').checked = true;
      dialog.showModal();
    } catch (error) {
      pendingImport = null;
      toast(error.message || '备份解析失败', 5000, true);
    }
  });

  dialog.addEventListener('close', async () => {
    if (dialog.returnValue !== 'confirm' || !pendingImport) {
      pendingImport = null;
      return;
    }
    const mode = dialog.querySelector('input[name="importMode"]:checked')?.value || 'merge';
    const existingNames = mode === 'merge' ? getState().workspaces.map((workspace) => workspace.name) : [];
    const imported = prepareImportedWorkspaces(pendingImport.state, existingNames);
    pendingImport = null;
    if (mode === 'replace') {
      const ok = await confirmAction(
        '将替换全部现有观看方案。系统会先自动下载当前配置备份。',
        { title: '替换全部配置', confirmLabel: '备份并替换', danger: true }
      );
      if (!ok) return;
      downloadBackup({ notify: false });
      onReplace(imported);
    } else {
      onMerge(imported);
    }
    toast(`已导入 ${imported.length} 个观看方案`);
  });

  return { downloadBackup };
}
