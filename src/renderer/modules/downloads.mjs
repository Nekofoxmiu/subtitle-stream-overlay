import { dom } from './dom.mjs';
import state from './state.mjs';
import { appendLog } from './logger.mjs';
import { handleDownloadDone } from './media-library.mjs';

export function showDownloadProgress(show) {
  if (!dom.dlProg) return;
  if (show) {
    dom.dlProg.style.display = 'block';
    dom.dlProg.max = 100;
    dom.dlProg.removeAttribute('value');
    state.downloadProgressStarted = false;
  } else {
    dom.dlProg.style.display = 'none';
    dom.dlProg.value = 0;
    dom.dlProg.removeAttribute('value');
    state.downloadProgressStarted = false;
  }
}

export function updateDownloadStatus(message = '') {
  const text = typeof message === 'string' ? message : '';
  state.downloadStatusMessage = text;
  if (dom.dlTxt) {
    dom.dlTxt.textContent = text;
    if (text) dom.dlTxt.setAttribute('title', text);
    else dom.dlTxt.removeAttribute('title');
  }
}

export async function startYtDownload({ type = 'video' } = {}) {
  const url = dom.ytUrl?.value.trim();
  if (!url) {
    alert('請輸入 YouTube 連結');
    return;
  }
  showDownloadProgress(true);
  updateDownloadStatus('正在請求下載...');
  try {
    const fn = type === 'audio' ? window.api.ytdlpDownloadAudio : window.api.ytdlpDownloadVideo;
    const { jobId } = await fn({ url });
    state.jobId = jobId;
    state.activeDownloadMode = type;
  } catch (err) {
    state.activeDownloadMode = null;
    showDownloadProgress(false);
    const message = err?.message || String(err);
    updateDownloadStatus(`下載失敗：${message}`);
    state.downloadProgressStarted = true;
    alert(message);
  }
}

export async function handleDownloadVideo() {
  await startYtDownload({ type: 'video' });
}

export async function handleDownloadAudio() {
  await startYtDownload({ type: 'audio' });
}

export async function handleCancelDownload() {
  if (!state.jobId) return;
  try {
    await window.api.ytdlpCancel(state.jobId);
    appendLog(`[cancel] 已取消 ${state.jobId}`);
  } catch (err) {
    alert(err?.message || String(err));
  } finally {
    state.jobId = null;
    state.activeDownloadMode = null;
    showDownloadProgress(false);
    updateDownloadStatus('下載已取消');
    state.downloadProgressStarted = true;
  }
}

export function handleYtProgress(ev) {
  if (!ev) return;
  if (ev.type === 'log') {
    appendLog(`[${ev.stream}] ${ev.line}`);
    if (!state.downloadProgressStarted) {
      const singleLine = typeof ev.line === 'string' ? ev.line.replace(/\s+/g, ' ').trim() : '';
      if (singleLine) updateDownloadStatus(singleLine);
    }
    return;
  }

  const matchesJob = !ev.jobId || !state.jobId || ev.jobId === state.jobId;
  if (!matchesJob && ['progress', 'done', 'error'].includes(ev.type)) return;

  if (ev.type === 'progress') {
    state.downloadProgressStarted = true;
    if (dom.dlProg) {
      const percent = typeof ev.percent === 'number' ? Math.max(0, Math.min(100, ev.percent)) : null;
      if (percent == null) dom.dlProg.removeAttribute('value');
      else {
        dom.dlProg.max = 100;
        dom.dlProg.value = percent;
        dom.dlProg.setAttribute('value', String(percent));
      }
    }
    const percentText = typeof ev.percent === 'number' ? `${ev.percent.toFixed(1)}%` : '';
    const parts = [];
    if (percentText) parts.push(percentText);
    if (ev.speed) parts.push(ev.speed);
    if (ev.eta) parts.push(ev.eta);
    const base = parts.join(' ');
    if (state.activeDownloadMode) {
      const label = state.activeDownloadMode === 'audio' ? '音訊' : '影片';
      const labelText = base ? `[${label}] ${base}` : `[${label}] 下載中...`;
      updateDownloadStatus(labelText);
    } else {
      updateDownloadStatus(base || '下載中...');
    }
  } else if (ev.type === 'done') {
    handleDownloadDone(ev).catch((err) => console.error('[yt-dlp] finalize error', err));
  } else if (ev.type === 'error') {
    showDownloadProgress(false);
    state.jobId = null;
    state.activeDownloadMode = null;
    const message = ev.message || '發生錯誤';
    updateDownloadStatus(`下載失敗：${message}`);
    state.downloadProgressStarted = true;
    alert('下載失敗：' + message);
  }
}
