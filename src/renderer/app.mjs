const $ = (selector) => document.querySelector(selector);

const dom = {
  binInfo: $('#binInfo'),
  portInput: $('#port'),
  portView: $('#portView'),
  applyMsg: $('#applyMsg'),
  cookiesView: $('#cookiesView'),
  log: $('#ytLog'),
  dlProg: $('#dlProg'),
  dlTxt: $('#dlTxt'),
  video: $('#localVideo'),
  videoFile: $('#videoFile'),
  ytUrl: $('#ytUrl'),
  subsPicked: $('#subsPicked'),
  fontsPicked: $('#fontsPicked'),
  pickCookies: $('#pickCookies'),
  clearCookies: $('#clearCookies'),
  checkBins: $('#checkBins'),
  pickSubs: $('#pickSubs'),
  pickFonts: $('#pickFonts'),
  ytDownload: $('#ytDownload'),
  ytCancel: $('#ytCancel'),
  ytFetch: $('#ytFetch'),
  background: $('#background'),
  align: $('#align'),
  maxWidth: $('#maxWidth'),
  applyToOverlay: $('#applyToOverlay'),
  activeCacheInfo: $('#activeCacheInfo')
};

dom.downloadedSelect = createDownloadedSelect(dom.videoFile?.closest('.row'));

const state = {
  currentAssText: '',
  currentFonts: [],
  jobId: null,
  cachedEntries: [], // { id, title, videoFilename, subsFilename, ... }
  activeCacheId: '',
  objectUrl: ''
};

/* ---------------- Overlay 時間同步 ---------------- */
class OverlaySync {
  constructor(videoEl) {
    this.ws = null;
    this.timer = null;
    this.port = 1976;
    this.video = videoEl;
  }
  connect(port) {
    if (this.port === port && this.ws && this.ws.readyState === 1) return;
    this.port = port;
    if (this.ws) {
      try { this.ws.close(); } catch { /* noop */ }
    }
    this.ws = new WebSocket(`ws://localhost:${port}`);
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== 1) return;
      const t = Number(this.video.currentTime || 0);
      if (!Number.isFinite(t)) return;
      this.ws.send(JSON.stringify({ type: 'setTime', payload: { t } }));
    }, 33);
  }
  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

const overlaySync = new OverlaySync(dom.video);

/* ---------------- 初始化 ---------------- */
(async function init() {
  setupEventHandlers();
  await loadInitialConfig();
  await refreshCachedEntries();
  window.api.onYtProgress(handleYtProgress);
})();

async function loadInitialConfig() {
  const cfg = await window.api.getConfig();
  if (cfg?.output) {
    const { output } = cfg;
    if (output.port != null) dom.portInput.value = String(output.port);
    if (output.maxWidth != null) dom.maxWidth.value = String(output.maxWidth);
    if (output.align) dom.align.value = output.align;
    if (output.background) dom.background.value = output.background;
  }
  dom.portView.textContent = dom.portInput.value || '';
  dom.cookiesView.textContent = cfg?.cookiesPath ? cfg.cookiesPath : '(未設定)';
  overlaySync.connect(getCurrentPort());
}


async function refreshCachedEntries(activeId = state.activeCacheId) {
  try {
    const entries = await window.api.listCacheEntries();
    state.cachedEntries = Array.isArray(entries) ? entries.slice() : [];
    state.cachedEntries.sort((a, b) => (a?.addedAt || 0) - (b?.addedAt || 0));
    updateDownloadedSelect(activeId);
    if (activeId) {
      const current = state.cachedEntries.find((item) => item.id === activeId);
      if (!current && state.activeCacheId === activeId) {
        state.activeCacheId = '';
      }
      updateActiveCacheInfo(current || null);
    } else {
      updateActiveCacheInfo(null);
    }
  } catch (err) {
    console.error('[cache] 無法載入快取清單', err);
  }
}



function setupEventHandlers() {

  const debouncedSyncStyle = debounce(async () => {
    const style = collectStyle();
    await persistStyle(style);
    window.api.notifyOverlay({ style });
    syncOverlayConnection();
    const activeEntry = state.cachedEntries.find((item) => item.id === state.activeCacheId && item.hasVideo && item.videoFilename);
    if (!activeEntry) return;
    // 重新設定下載影片的連線位置
    const url = buildCacheUrl(activeEntry.videoFilename);
    dom.video.src = url;
  }, 120);
  dom.pickCookies?.addEventListener('click', handlePickCookies);
  dom.clearCookies?.addEventListener('click', handleClearCookies);
  dom.checkBins?.addEventListener('click', handleCheckBins);
  dom.pickSubs?.addEventListener('click', handlePickSubs);
  dom.pickFonts?.addEventListener('click', handlePickFonts);
  dom.ytFetch?.addEventListener('click', handleFetchSubsOnly);
  dom.ytDownload?.addEventListener('click', handleDownloadVideo);
  dom.ytCancel?.addEventListener('click', handleCancelDownload);
  dom.videoFile?.addEventListener('change', handleLocalFileSelected);
  dom.downloadedSelect?.addEventListener('change', handleDownloadedSelectChange);

  ['background', 'align', 'maxWidth', 'port'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', debouncedSyncStyle);
    if (el.tagName === 'INPUT') {
      el.addEventListener('input', debouncedSyncStyle);
    }
  });

  dom.portInput?.addEventListener('input', () => {
    dom.portView.textContent = dom.portInput.value || '';
  });

  dom.applyToOverlay?.addEventListener('click', async () => {
    const style = collectStyle();
    await persistStyle(style);
    window.api.notifyOverlay({
      style,
      subContent: state.currentAssText,
      fontBuffers: state.currentFonts
    });
    dom.applyMsg.textContent = `已更新。請以 OBS Browser Source 指向 http://localhost:${style.port}/overlay`;
    syncOverlayConnection();
  });
}

/* ---------------- Cookies ---------------- */
async function handlePickCookies() {
  const files = await window.api.openFiles({ filters: [{ name: 'Cookies', extensions: ['txt'] }] });
  if (!files.length) return;
  const cookiesPath = files[0];
  await window.api.setConfig({ cookiesPath });
  dom.cookiesView.textContent = cookiesPath;
  dom.applyMsg.textContent = '已設定 cookies';
}

async function handleClearCookies() {
  await window.api.setConfig({ cookiesPath: '' });
  dom.cookiesView.textContent = '(未設定)';
  dom.applyMsg.textContent = '已清除 cookies';
}

/* ---------------- yt-dlp 日誌/下載 ---------------- */
function appendLog(line) {
  const msg = line.endsWith('\n') ? line : `${line}\n`;
  dom.log.textContent += msg;
  dom.log.scrollTop = dom.log.scrollHeight;
}

function showDownloadProgress(show) {
  if (!dom.dlProg) return;
  dom.dlProg.style.display = show ? '' : 'none';
  if (!show) {
    dom.dlProg.value = 0;
    if (dom.dlTxt) dom.dlTxt.textContent = '';
  }
}

async function handleDownloadVideo() {
  const url = dom.ytUrl?.value.trim();
  if (!url) {
    alert('請輸入 YouTube 連結');
    return;
  }
  showDownloadProgress(true);
  try {
    const { jobId } = await window.api.ytdlpDownloadVideo({ url });
    state.jobId = jobId;
  } catch (err) {
    showDownloadProgress(false);
    alert(err?.message || String(err));
  }
}

async function handleCancelDownload() {
  if (!state.jobId) return;
  try {
    await window.api.ytdlpCancel(state.jobId);
    appendLog(`[cancel] 已取消 ${state.jobId}`);
  } catch (err) {
    alert(err?.message || String(err));
  } finally {
    state.jobId = null;
    showDownloadProgress(false);
  }
}

function handleYtProgress(ev) {
  if (!ev) return;
  if (ev.type === 'log') {
    appendLog(`[${ev.stream}] ${ev.line}`);
    return;
  }

  const matchesJob = !ev.jobId || !state.jobId || ev.jobId === state.jobId;
  if (!matchesJob && ['progress', 'done', 'error'].includes(ev.type)) {
    return;
  }

  if (ev.type === 'progress') {
    if (dom.dlProg) dom.dlProg.value = ev.percent || 0;
    if (dom.dlTxt) dom.dlTxt.textContent = `${(ev.percent || 0).toFixed(1)}% ${ev.speed || ''} ${ev.eta || ''}`.trim();
  } else if (ev.type === 'done') {
    handleDownloadDone(ev);
  } else if (ev.type === 'error') {
    showDownloadProgress(false);
    alert('下載失敗：' + (ev.message || '未知錯誤'));
  }
}

function handleDownloadDone(payload) {
  showDownloadProgress(false);
  state.jobId = null;
  const filename = typeof payload === 'string' ? payload : payload?.filename;
  if (filename) appendLog(`[done] ${filename}`);
  const entry = typeof payload === 'object' ? payload?.entry : null;
  if (entry) {
    const merged = upsertCacheEntry(entry);
    updateDownloadedSelect(merged?.id);
    activateCacheEntry(merged, { setSelectValue: true }).catch((err) => {
      console.error('[cache] 無法啟用快取影片', err);
    });
  } else {
    refreshCachedEntries().catch((err) => console.error('[cache] 重新整理快取失敗', err));
  }
}

function buildCacheUrl(filename) {
  const port = getCurrentPort();
  return `http://localhost:${port}/video-cache/${encodeURIComponent(filename)}`;
}

function upsertCacheEntry(entry) {
  if (!entry) return null;
  const idx = state.cachedEntries.findIndex((item) => item.id === entry.id);
  let merged = entry;
  if (idx >= 0) {
    merged = { ...state.cachedEntries[idx], ...entry };
    state.cachedEntries[idx] = merged;
  } else {
    state.cachedEntries.push(entry);
  }
  state.cachedEntries.sort((a, b) => (a?.addedAt || 0) - (b?.addedAt || 0));
  return merged;
}

function formatCacheEntryLabel(entry) {
  if (!entry) return '';
  const base = entry.title || entry.displayTitle || entry.id || '';
  const kinds = [];
  if (entry.hasVideo) kinds.push(entry.mediaKind === 'audio' ? '音訊' : '影片');
  if (entry.hasSubs) kinds.push('字幕');
  return kinds.length ? `${base}（${kinds.join(' + ')}）` : base;
}

function describeCacheEntry(entry) {
  if (!entry) return '';
  const base = entry.title || entry.displayTitle || entry.id || '';
  const kinds = [];
  if (entry.hasVideo) kinds.push(entry.mediaKind === 'audio' ? '音訊' : '影片');
  if (entry.hasSubs) kinds.push('字幕');
  const suffix = kinds.length ? `（${kinds.join(' + ')}）` : '';
  return `${base}${suffix}`.trim();
}

async function activateCacheEntry(entry, { setSelectValue = true } = {}) {
  if (!entry) {
    state.activeCacheId = '';
    if (setSelectValue && dom.downloadedSelect) {
      dom.downloadedSelect.value = '';
    }
    updateActiveCacheInfo(null);
    return;
  }

  state.activeCacheId = entry.id;
  if (setSelectValue && dom.downloadedSelect) {
    dom.downloadedSelect.value = entry.id;
  }
  updateActiveCacheInfo(entry);
  if (entry.hasSubs && entry.subsPath && dom.subsPicked) {
    dom.subsPicked.textContent = entry.subsPath;
  }

  if (entry.hasVideo && entry.videoFilename) {
    releaseObjectUrl();
    const url = buildCacheUrl(entry.videoFilename);
    dom.video.src = url;
    dom.video.pause();
    try { dom.video.currentTime = 0; } catch { /* noop */ }
  }

  if (entry.hasSubs && entry.subsPath) {
    try {
      await loadAssIntoOverlay(entry.subsPath);
    } catch (err) {
      console.error('[cache] 載入字幕失敗', err);
      alert('載入快取字幕失敗：' + (err?.message || err));
    }
  }

  syncOverlayConnection();
}

function updateActiveCacheInfo(entry) {
  if (!dom.activeCacheInfo) return;
  if (!entry) {
    dom.activeCacheInfo.textContent = state.activeCacheId ? '' : '（尚未選擇快取項目）';
    return;
  }
  dom.activeCacheInfo.textContent = `已選擇：${describeCacheEntry(entry)}`;
}

/* ---------------- 字幕處理 ---------------- */
async function handleFetchSubsOnly() {
  const url = dom.ytUrl?.value.trim();
  if (!url) {
    alert('請輸入連結');
    return;
  }
  try {
    const { files, entries } = await window.api.fetchSubsFromYt({ url });
    if (!files?.length) {
      alert('未取得字幕');
      return;
    }
    appendLog(`[subs] 已下載字幕：\n${files.join('\n')}`);
    if (Array.isArray(entries) && entries.length) {
      let first = null;
      entries.forEach((entry, idx) => {
        const merged = upsertCacheEntry(entry);
        if (idx === 0) first = merged;
      });
      updateDownloadedSelect(first?.id);
      dom.subsPicked.textContent = first?.subsPath || files[0];
      activateCacheEntry(first, { setSelectValue: true }).catch((err) => {
        console.error('[cache] 啟用字幕快取失敗', err);
      });
    } else {
      const assPath = files.find((f) => f.toLowerCase().endsWith('.ass')) || files[0];
      await loadAssIntoOverlay(assPath);
      dom.subsPicked.textContent = assPath;
      refreshCachedEntries().catch((err) => console.error('[cache] 重新整理快取失敗', err));
    }
  } catch (err) {
    appendLog(`[subs-error] ${err?.message || err}`);
    alert('下載字幕失敗：' + (err?.message || err));
  }
}

async function handlePickSubs() {
  const files = await window.api.openFiles({ filters: [{ name: 'Subtitles', extensions: ['ass', 'srt', 'vtt', 'ssa'] }] });
  if (!files.length) return;
  let path = files[0];
  if (!path.toLowerCase().endsWith('.ass')) {
    try {
      const { outPath } = await window.api.convertToAss({ inputPath: path });
      path = outPath;
      dom.subsPicked.textContent = `${path}（已轉 ASS）`;
    } catch (err) {
      alert('轉 ASS 失敗：' + (err?.message || err));
      return;
    }
  } else {
    dom.subsPicked.textContent = path;
  }
  try {
    await loadAssIntoOverlay(path);
  } catch (err) {
    alert('讀取 ASS 失敗：' + (err?.message || err));
  }
}

async function loadAssIntoOverlay(assPath) {
  const assText = await window.api.readTextFile(assPath);
  state.currentAssText = assText;
  const style = collectStyle();
  await persistStyle(style);
  window.api.notifyOverlay({ style, subContent: state.currentAssText, fontBuffers: state.currentFonts });
  syncOverlayConnection();
}

/* ---------------- 字型 ---------------- */
async function handlePickFonts() {
  const files = await window.api.openFiles({ filters: [{ name: 'Fonts', extensions: ['ttf', 'otf', 'woff2', 'woff'] }] });
  if (!files.length) return;
  state.currentFonts = [];
  const names = [];
  for (const filePath of files) {
    const base64 = await window.api.readBinaryBase64(filePath);
    const name = filePath.split(/[\\/]/).pop();
    state.currentFonts.push({ name, data: base64 });
    names.push(name);
  }
  dom.fontsPicked.textContent = names.join(', ');
  const style = collectStyle();
  await persistStyle(style);
  window.api.notifyOverlay({ style, fontBuffers: state.currentFonts });
}

/* ---------------- Binaries ---------------- */
async function handleCheckBins() {
  try {
    const bins = await window.api.ensureBins();
    setBinInfo(bins);
  } catch (err) {
    alert(err?.message || String(err));
  }
}

function setBinInfo(bins) {
  if (!bins) return;
  dom.binInfo.textContent = `yt-dlp: ${bins.ytDlpPath || '未設定'} | ffmpeg: ${bins.ffmpegPath || '未設定'}`;
}

/* ---------------- 本地影片 ---------------- */
function handleLocalFileSelected(ev) {
  const file = ev.target.files?.[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = url;
  state.activeCacheId = '';
  updateDownloadedSelect('');
  if (dom.activeCacheInfo) dom.activeCacheInfo.textContent = `本地媒體：${file.name}`;
  playVideo(url);
}

function handleDownloadedSelectChange() {
  const id = dom.downloadedSelect?.value;
  if (!id) {
    state.activeCacheId = '';
    updateActiveCacheInfo(null);
    return;
  }
  const entry = state.cachedEntries.find((item) => item.id === id);
  if (!entry) return;
  activateCacheEntry(entry, { setSelectValue: false }).catch((err) => {
    console.error('[cache] 無法載入選取的快取項目', err);
  });
}

function playVideo(url, { autoPlay = false } = {}) {
  if (!url) return;
  dom.video.src = url;
  if (autoPlay) {
    dom.video.play().catch(() => { /* ignore autoplay error */ });
  } else {
    dom.video.pause();
    try { dom.video.currentTime = 0; } catch { /* noop */ }
  }
  syncOverlayConnection();
}

function releaseObjectUrl() {
  if (!state.objectUrl) return;
  try { URL.revokeObjectURL(state.objectUrl); } catch { /* ignore */ }
  state.objectUrl = '';
}

function syncOverlayConnection() {
  overlaySync.connect(getCurrentPort());
  overlaySync.start();
}

/* ---------------- 樣式設定 ---------------- */
function getCurrentPort() {
  const port = parseInt(dom.portInput?.value, 10);
  return Number.isFinite(port) ? port : 1976;
}

function collectStyle() {
  return {
    port: getCurrentPort(),
    background: dom.background?.value || 'transparent',
    maxWidth: parseInt(dom.maxWidth?.value, 10) || 1920,
    align: dom.align?.value || 'center'
  };
}

async function persistStyle(style) {
  await window.api.setConfig({ output: style });
}

function debounce(fn, ms = 120) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function updateDownloadedSelect(selectedId = state.activeCacheId) {
  const select = dom.downloadedSelect;
  if (!select) return;
  select.innerHTML = '';
  if (!state.cachedEntries.length) {
    const option = new Option('（尚無快取項目）', '');
    option.selected = true;
    select.add(option);
    select.disabled = true;
    return;
  }
  select.disabled = false;
  const placeholder = new Option('選擇快取項目', '', !selectedId, !selectedId);
  select.add(placeholder);
  state.cachedEntries
    .slice()
    .sort((a, b) => (a?.addedAt || 0) - (b?.addedAt || 0))
    .forEach((entry) => {
      const label = formatCacheEntryLabel(entry);
      const option = new Option(label, entry.id, false, entry.id === selectedId);
      select.add(option);
    });
  if (selectedId) {
    select.value = selectedId;
  }
}

function createDownloadedSelect(rowEl) {
  if (!rowEl) return null;
  const select = document.createElement('select');
  select.id = 'downloadedVideos';
  select.style.marginLeft = '8px';
  select.disabled = true;
  rowEl.appendChild(select);
  const hint = document.createElement('small');
  hint.style.marginLeft = '8px';
  hint.textContent = '（快取的影片 / 字幕會出現在此，便於快速載入）';
  rowEl.appendChild(hint);
  return select;
}
