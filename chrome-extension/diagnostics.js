// 连接与性能诊断：把各窗口的 diagnostics() 汇总成计数、面板行文字和可复制的纯文本。

export const STATE_LABELS = {
  loading: '缓冲中', playing: '播放中', blocked: '待播放', retrying: '重连中',
  suspended: '已暂停', offline: '未开播', error: '出错',
};

export function diagnosticSummary(items) {
  const count = (states) => items.filter((item) => states.includes(item.state)).length;
  return {
    playing: count(['playing']),
    pending: count(['loading', 'blocked', 'retrying', 'suspended']),
    offline: count(['offline']),
    error: count(['error']),
    total: items.length,
  };
}

// 诊断面板一行显示的各列文字，第一列是房间标题
export function diagnosticCells(item) {
  return [
    item.title,
    STATE_LABELS[item.state] || item.state,
    item.rateName || '未知清晰度',
    item.width && item.height ? `${item.width}×${item.height}` : '分辨率未知',
    `缓冲 ${item.bufferSeconds.toFixed(1)}s · 丢帧 ${item.droppedFrames}/${item.totalFrames}`,
    `近期丢帧 ${(item.recentDroppedRatio * 100).toFixed(1)}% · 帧检测 ${item.frameMonitoring === 'unsupported' ? '不支持' : item.frameMonitoring === 'suspended' ? '采样暂停' : item.frameAnomaly ? '异常' : '正常'} · 自动恢复 ${item.recoveryCount} 次`,
    `音画同步 ${item.syncStatus === 'audio-leading' ? '声音领先' : item.syncStatus === 'video-leading' ? '画面领先' : item.syncStatus === 'normal' ? '正常' : '无法测量'}${item.syncOffsetSeconds == null ? '' : ` (${(item.syncOffsetSeconds * 1000).toFixed(0)}ms)`}${item.syncRebuildCount ? ` · 偏差重建 ${item.syncRebuildCount} 次` : ""}${item.renderLagSeconds == null ? "" : ` · 画面滞后 ${(item.renderLagSeconds * 1000).toFixed(0)}ms`}${item.reanchorCount ? ` · 重新锚定 ${item.reanchorCount} 次` : ""}${item.audioConfigChanges ? ` · 音频配置切换 ${item.audioConfigChanges} 次` : ""}${item.audioGapMs ? ` · 音频断档 ${Math.round(item.audioGapMs)}ms` : ""}`,
    item.lastRecoveryReason ? `最近恢复：${item.lastRecoveryReason}` : '尚未自动校正',
    item.latencyChase ? `延迟对齐 ${item.chasing ? '追帧中 1.1×' : '已对齐'}${item.liveJumpCount ? ` · 跳到最新 ${item.liveJumpCount} 次` : ''}` : '延迟对齐关闭',
    item.visibilityRecoveryCount ? `切页追帧 ${item.visibilityRecoveryCount} 次 · ${item.lastVisibilityRecoveryReason}` : '尚未因切页追帧',
    item.lastCheckedAt ? `检查 ${new Date(item.lastCheckedAt).toLocaleTimeString('zh-CN')}` : '尚未检查',
  ];
}

export function diagnosticsText(items) {
  const summary = diagnosticSummary(items);
  return [
    `斗鱼同屏诊断 ${new Date().toISOString()}`,
    `播放 ${summary.playing} / 总计 ${summary.total}，缓冲/重连 ${summary.pending}，未开播 ${summary.offline}，出错 ${summary.error}`,
    ...items.map((item) =>
      `[${item.rid}] ${item.title} | ${STATE_LABELS[item.state] || item.state} | ${item.rateName || '-'} | ` +
      `${item.width || 0}x${item.height || 0} | buffer=${item.bufferSeconds.toFixed(1)}s | ` +
      `dropped=${item.droppedFrames}/${item.totalFrames} | recentDropped=${(item.recentDroppedRatio * 100).toFixed(1)}% | retry=${item.retry} | ` +
      `frameMonitoring=${item.frameMonitoring} | frameSkew=${item.frameSkewSeconds == null ? 'unknown' : item.frameSkewSeconds.toFixed(3)}s | frameAnomaly=${item.frameAnomaly} | recoveries=${item.recoveryCount} | recoveryReason=${item.lastRecoveryReason || '-'} | ` +
      `latencyChase=${item.latencyChase ? (item.chasing ? 'chasing' : 'on') : 'off'} | liveJumps=${item.liveJumpCount || 0} | visibilityRecoveries=${item.visibilityRecoveryCount} | visibilityRecoveryReason=${item.lastVisibilityRecoveryReason || '-'} | ` +
      `syncStatus=${item.syncStatus} | syncOffset=${item.syncOffsetSeconds == null ? 'unknown' : item.syncOffsetSeconds.toFixed(3)}s | syncSamples=${item.syncSamples} | syncRebuilds=${item.syncRebuildCount || 0} | renderLag=${item.renderLagSeconds == null ? "unknown" : item.renderLagSeconds.toFixed(3)}s | reanchors=${item.reanchorCount || 0} | audioConfigChanges=${item.audioConfigChanges || 0} | audioGapMs=${Math.round(item.audioGapMs || 0)} | videoFps=${item.videoFps ?? 'unknown'} | silentAacDropped=${item.silentAacDropped || 0} |syncEvents=${JSON.stringify(item.syncEvents || [])} | ` +
      `checked=${item.lastCheckedAt ? new Date(item.lastCheckedAt).toISOString() : 'never'}` +
      (item.lastError ? ` | error=${item.lastError}` : '')
    ),
  ].join('\n');
}
