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
  pickVideo: $('#pickVideo'),
  videoPicked: $('#videoPicked'),
  ytUrl: $('#ytUrl'),
  subsPicked: $('#subsPicked'),
  fontsPicked: $('#fontsPicked'),
  pickCookies: $('#pickCookies'),
  clearCookies: $('#clearCookies'),
  checkBins: $('#checkBins'),
  pickSubs: $('#pickSubs'),
  pickFonts: $('#pickFonts'),
  ytDownload: $('#ytDownload'),
  ytDownloadAudio: $('#ytDownloadAudio'),
  ytCancel: $('#ytCancel'),
  ytFetch: $('#ytFetch'),
  background: $('#background'),
  align: $('#align'),
  maxWidth: $('#maxWidth'),
  applyToOverlay: $('#applyToOverlay'),
  activeCacheInfo: $('#activeCacheInfo'),
  toggleAdvanced: $('#toggleAdvanced'),
  closeAdvanced: $('#closeAdvanced'),
  advancedSidebar: $('#advancedSidebar'),
  sidebarOverlay: $('#sidebarOverlay'),
  binProgressWrap: $('#binProgressWrap'),
  binProgressBar: $('#binProgressBar'),
  binProgressLabel: $('#binProgressLabel'),
  binStatusYt: $('#binStatusYtIcon'),
  binStatusFfmpeg: $('#binStatusFfmpegIcon')
};

const videoCacheControls = createCacheSelector(dom.videoFile?.closest('.row'), {
  label: '快取媒體：',
  searchPlaceholder: '搜尋影片或音訊...',
  hint: '（快取的影片 / 音訊會列在此，可搜尋）'
});
dom.videoCacheSelect = videoCacheControls?.select || null;
dom.videoCacheSearch = videoCacheControls?.search || null;

const subsCacheControls = createCacheSelector(dom.pickSubs?.closest('.row'), {
  label: '快取字幕：',
  searchPlaceholder: '搜尋字幕...',
  hint: '（快取的字幕會列在此，可搜尋）'
});
dom.subsCacheSelect = subsCacheControls?.select || null;
dom.subsCacheSearch = subsCacheControls?.search || null;

const state = {
  currentAssText: '',
  currentFonts: [],
  jobId: null,
  activeDownloadMode: null,
  cachedEntries: [], // { id, title, videoFilename, subsFilename, ... }
  activeVideoId: '',
  activeSubsId: '',
  videoSearch: '',
  subsSearch: '',
  objectUrl: '',
  binProgress: new Map()
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
  await loadBinInfo();
  await refreshCachedEntries();
  window.api.onYtProgress(handleYtProgress);
  window.api.onBinProgress(handleBinProgress);
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

async function loadBinInfo() {
  try {
    const bins = await window.api.getBins?.();
    setBinInfo(bins || null);
  } catch (err) {
    console.error('[bins] 載入工具資訊失敗', err);
  }
}


async function refreshCachedEntries({ activeVideoId = state.activeVideoId, activeSubsId = state.activeSubsId } = {}) {
  try {
    const entries = await window.api.listCacheEntries();
    state.cachedEntries = Array.isArray(entries) ? entries.slice() : [];
    state.cachedEntries.sort((a, b) => (a?.addedAt || 0) - (b?.addedAt || 0));
    const videoEntry = state.cachedEntries.find((item) => item.id === activeVideoId && item.hasVideo && item.videoFilename);
    const subsEntry = state.cachedEntries.find((item) => item.id === activeSubsId && item.hasSubs && item.subsPath);
    state.activeVideoId = videoEntry ? videoEntry.id : '';
    state.activeSubsId = subsEntry ? subsEntry.id : '';
    updateVideoCacheSelect(state.activeVideoId);
    updateSubsCacheSelect(state.activeSubsId);
    updateActiveCacheInfo({ video: videoEntry || null, subs: subsEntry || null });
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
  }, 120);

  
  dom.pickCookies?.addEventListener('click', handlePickCookies);
  dom.clearCookies?.addEventListener('click', handleClearCookies);
  dom.checkBins?.addEventListener('click', handleCheckBins);
  dom.pickVideo?.addEventListener('click', handlePickVideo);
  dom.pickSubs?.addEventListener('click', handlePickSubs);
  dom.pickFonts?.addEventListener('click', handlePickFonts);
  dom.ytFetch?.addEventListener('click', handleFetchSubsOnly);
  dom.ytDownload?.addEventListener('click', handleDownloadVideo);
  dom.ytDownloadAudio?.addEventListener('click', handleDownloadAudio);
  dom.ytCancel?.addEventListener('click', handleCancelDownload);
  dom.videoFile?.addEventListener('change', handleLocalFileSelected);
  dom.videoCacheSelect?.addEventListener('change', handleVideoCacheSelectChange);
  dom.subsCacheSelect?.addEventListener('change', handleSubsCacheSelectChange);
  dom.videoCacheSearch?.addEventListener('input', handleVideoCacheSearch);
  dom.subsCacheSearch?.addEventListener('input', handleSubsCacheSearch);

  dom.toggleAdvanced?.addEventListener('click', () => setSidebarOpen(true));
  dom.closeAdvanced?.addEventListener('click', () => setSidebarOpen(false));
  dom.sidebarOverlay?.addEventListener('click', () => setSidebarOpen(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setSidebarOpen(false);
  });

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

function setSidebarOpen(open) {
  const action = open ? 'add' : 'remove';
  dom.advancedSidebar?.classList[action]('open');
  dom.sidebarOverlay?.classList[action]('visible');
  document.body.classList[action]('sidebar-open');
}

async function startYtDownload({ type = 'video' } = {}) {
  const url = dom.ytUrl?.value.trim();
  if (!url) {
    alert('請輸入 YouTube 連結');
    return;
  }
  showDownloadProgress(true);
  try {
    const fn = type === 'audio' ? window.api.ytdlpDownloadAudio : window.api.ytdlpDownloadVideo;
    const { jobId } = await fn({ url });
    state.jobId = jobId;
    state.activeDownloadMode = type;
  } catch (err) {
    state.activeDownloadMode = null;
    showDownloadProgress(false);
    alert(err?.message || String(err));
  }
}

async function handleDownloadVideo() {
  await startYtDownload({ type: 'video' });
}

async function handleDownloadAudio() {
  await startYtDownload({ type: 'audio' });
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
    state.activeDownloadMode = null;
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
    if (dom.dlTxt) {
      const base = `${(ev.percent || 0).toFixed(1)}% ${ev.speed || ''} ${ev.eta || ''}`.trim();
      if (state.activeDownloadMode) {
        const label = state.activeDownloadMode === 'audio' ? '音訊' : '影片';
        dom.dlTxt.textContent = `[${label}] ${base}`;
      } else {
        dom.dlTxt.textContent = base;
      }
    }
  } else if (ev.type === 'done') {
    handleDownloadDone(ev);
  } else if (ev.type === 'error') {
    showDownloadProgress(false);
    state.jobId = null;
    state.activeDownloadMode = null;
    alert('下載失敗：' + (ev.message || '未知錯誤'));
  }
}

function handleBinProgress(ev) {
  if (!ev || !ev.id || !(state.binProgress instanceof Map)) return;
  const label = ev.label || ev.id;
  const existing = state.binProgress.get(ev.id) || {};
  const next = { ...existing, ...ev, label, updatedAt: Date.now() };
  let message = existing.message || `${label}`;
  let percent = ev.percent != null ? ev.percent : existing.percent ?? null;
  let done = false;
  let hideDelay = 2400;

  switch (ev.status) {
    case 'start':
      if (ev.stage === 'download') {
        message = `${label} 下載準備中...`;
        percent = ev.percent != null ? ev.percent : 0;
      } else if (ev.stage === 'extract') {
        message = `${label} 解壓縮中...`;
        percent = null;
      } else {
        message = `${label} 處理中...`;
      }
      break;
    case 'progress': {
      const percentText = ev.percent != null ? `${ev.percent.toFixed(1)}%` : '';
      if (ev.stage === 'download') {
        message = `${label} 下載中 ${percentText}`.trim();
      } else {
        message = `${label} ${percentText}`.trim();
      }
      percent = ev.percent != null ? ev.percent : percent;
      break;
    }
    case 'done':
      if (ev.message) {
        message = ev.message;
      } else if (ev.stage === 'extract') {
        message = `${label} 解壓縮完成`;
        percent = null;
      } else if (ev.stage === 'download' || ev.stage === 'ready') {
        message = `${label} 已完成下載`;
        percent = 100;
      } else {
        message = `${label} 完成`;
      }
      done = true;
      break;
    case 'error':
      message = ev.message ? `${label}：${ev.message}` : `${label} 發生錯誤`;
      percent = null;
      done = true;
      hideDelay = 6000;
      break;
    default:
      break;
  }

  next.message = message;
  next.percent = percent;
  next.done = done;
  next.hideAfter = done ? Date.now() + hideDelay : null;
  state.binProgress.set(ev.id, next);
  renderBinProgress();

  if (done) {
    const targetHide = next.hideAfter;
    setTimeout(() => {
      const current = state.binProgress.get(ev.id);
      if (!current) return;
      if (current.hideAfter && targetHide === current.hideAfter) {
        state.binProgress.delete(ev.id);
        renderBinProgress();
      }
    }, hideDelay);
  }
}

function renderBinProgress() {
  if (!dom.binProgressWrap) return;
  const entries = Array.from(state.binProgress.values());
  if (!entries.length) {
    dom.binProgressWrap.classList.add('hidden');
    if (dom.binProgressBar) {
      dom.binProgressBar.value = 0;
      dom.binProgressBar.removeAttribute('value');
    }
    if (dom.binProgressLabel) dom.binProgressLabel.textContent = '';
    return;
  }

  dom.binProgressWrap.classList.remove('hidden');
  const active = entries.find((item) => !item.done) || entries[entries.length - 1];
  if (dom.binProgressLabel) dom.binProgressLabel.textContent = active.message || '';
  if (!dom.binProgressBar) return;
  if (active.percent == null) {
    dom.binProgressBar.removeAttribute('value');
  } else {
    dom.binProgressBar.max = 100;
    dom.binProgressBar.value = Math.max(0, Math.min(100, active.percent));
  }
}

function handleDownloadDone(payload) {
  showDownloadProgress(false);
  state.jobId = null;
  state.activeDownloadMode = null;
  const mode = typeof payload === 'object' ? payload?.mode : null;
  const label = mode === 'audio' ? '音訊' : '影片';
  const filename = typeof payload === 'string' ? payload : payload?.filename;
  const entry = typeof payload === 'object' ? payload?.entry : null;
  if (filename) {
    appendLog(`[done:${label}] ${filename}`);
  } else if (entry) {
    const summary = entry.hasVideo
      ? describeVideoEntry(entry)
      : entry.hasSubs
        ? describeSubtitleEntry(entry)
        : (entry.title || entry.displayTitle || entry.id || '');
    appendLog(`[done:${label}] ${summary}`);
  }
  if (entry) {
    const merged = upsertCacheEntry(entry);
    if (merged?.hasVideo && merged.videoFilename) {
      state.activeVideoId = merged.id;
      updateVideoCacheSelect(merged.id);
      loadVideoEntry(merged);
    } else {
      updateVideoCacheSelect(state.activeVideoId);
    }
    updateActiveCacheInfo({ video: getEntryById(state.activeVideoId), subs: getEntryById(state.activeSubsId) });
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

function describeVideoEntry(entry) {
  if (!entry) return '';
  const base = entry.title || entry.displayTitle || entry.id || '';
  const markers = [entry.mediaKind === 'audio' ? '音訊' : '影片'];
  if (entry.hasSubs) markers.push('含字幕');
  return markers.length ? `${base}（${markers.join(' / ')}）` : base;
}

function describeSubtitleEntry(entry) {
  if (!entry) return '';
  const base = entry.title || entry.displayTitle || entry.id || '';
  const markers = ['字幕'];
  if (entry.hasVideo) markers.push(entry.mediaKind === 'audio' ? '含音訊' : '含影片');
  return `${base}（${markers.join(' / ')}）`;
}

function matchesEntrySearch(entry, term) {
  if (!term) return true;
  const haystack = [
    entry.title,
    entry.displayTitle,
    entry.id,
    entry.videoFilename,
    entry.subsFilename,
    entry.videoPath,
    entry.subsPath
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(term);
}

function formatVideoOptionLabel(entry) {
  if (!entry) return '';
  const base = entry.title || entry.displayTitle || entry.id || '';
  const markers = [entry.mediaKind === 'audio' ? '音訊' : '影片'];
  if (entry.hasSubs) markers.push('含字幕');
  return markers.length ? `${base}（${markers.join(' / ')}）` : base;
}

function formatSubtitleOptionLabel(entry) {
  if (!entry) return '';
  const base = entry.title || entry.displayTitle || entry.id || '';
  const markers = ['字幕'];
  if (entry.hasVideo) markers.push(entry.mediaKind === 'audio' ? '含音訊' : '含影片');
  return `${base}（${markers.join(' / ')}）`;
}

function updateVideoCacheSelect(selectedId = state.activeVideoId) {
  const select = dom.videoCacheSelect;
  if (!select) return;
  const searchTerm = (state.videoSearch || '').toLowerCase();
  const entries = state.cachedEntries
    .filter((entry) => entry?.hasVideo && entry.videoFilename && matchesEntrySearch(entry, searchTerm));
  populateSelect(select, entries, {
    selectedId,
    placeholder: '選擇影片或音訊',
    emptyLabel: state.videoSearch ? '（沒有符合的媒體）' : '（尚無快取媒體）',
    buildLabel: formatVideoOptionLabel,
    buildTitle: (entry) => entry.videoPath || entry.videoFilename || ''
  });
}

function updateSubsCacheSelect(selectedId = state.activeSubsId) {
  const select = dom.subsCacheSelect;
  if (!select) return;
  const searchTerm = (state.subsSearch || '').toLowerCase();
  const entries = state.cachedEntries
    .filter((entry) => entry?.hasSubs && entry.subsPath && matchesEntrySearch(entry, searchTerm));
  populateSelect(select, entries, {
    selectedId,
    placeholder: '選擇字幕',
    emptyLabel: state.subsSearch ? '（沒有符合的字幕）' : '（尚無快取字幕）',
    buildLabel: formatSubtitleOptionLabel,
    buildTitle: (entry) => entry.subsPath || entry.subsFilename || ''
  });
}

function populateSelect(select, entries, {
  selectedId,
  placeholder,
  emptyLabel,
  buildLabel,
  buildTitle
}) {
  select.innerHTML = '';
  if (!entries.length) {
    const option = new Option(emptyLabel, '');
    option.selected = true;
    option.disabled = true;
    select.add(option);
    select.disabled = true;
    return;
  }
  select.disabled = false;
  const placeholderOption = new Option(placeholder, '', !selectedId, !selectedId);
  select.add(placeholderOption);
  entries.forEach((entry) => {
    const option = new Option(buildLabel(entry), entry.id, false, entry.id === selectedId);
    option.title = buildTitle(entry);
    select.add(option);
  });
  if (selectedId && entries.some((entry) => entry.id === selectedId)) {
    select.value = selectedId;
  } else {
    select.value = '';
  }
}

function handleVideoCacheSearch() {
  state.videoSearch = (dom.videoCacheSearch?.value || '').trim();
  updateVideoCacheSelect(state.activeVideoId);
}

function handleSubsCacheSearch() {
  state.subsSearch = (dom.subsCacheSearch?.value || '').trim();
  updateSubsCacheSelect(state.activeSubsId);
}

function getEntryById(id) {
  if (!id) return null;
  return state.cachedEntries.find((item) => item.id === id) || null;
}

function handleVideoCacheSelectChange() {
  const id = dom.videoCacheSelect?.value || '';
  state.activeVideoId = id;
  const entry = getEntryById(id);
  loadVideoEntry(entry);
  updateActiveCacheInfo({ video: entry, subs: getEntryById(state.activeSubsId) });
}

function handleSubsCacheSelectChange() {
  const id = dom.subsCacheSelect?.value || '';
  state.activeSubsId = id;
  const entry = getEntryById(id);
  loadSubtitleEntry(entry);
  updateActiveCacheInfo({ video: getEntryById(state.activeVideoId), subs: entry });
}

async function loadVideoEntry(entry) {
  if (!entry || !entry.hasVideo || !entry.videoFilename) {
    releaseObjectUrl();
    setPickedLabel(dom.videoPicked, { label: '', tooltip: '' });
    return;
  }
  releaseObjectUrl();
  const url = buildCacheUrl(entry.videoFilename);
  dom.video.src = url;
  dom.video.pause();
  try { dom.video.currentTime = 0; } catch { /* noop */ }
  const label = getVideoEntryLabel(entry);
  const tooltip = entry.videoPath || entry.videoFilename || '';
  setPickedLabel(dom.videoPicked, { label, tooltip });
  syncOverlayConnection();
}

async function loadSubtitleEntry(entry) {
  if (!entry || !entry.hasSubs || !entry.subsPath) {
    setPickedLabel(dom.subsPicked, { label: '', tooltip: '' });
    return;
  }
  try {
    await loadAssIntoOverlay(entry.subsPath);
    const label = getSubtitleEntryLabel(entry);
    setPickedLabel(dom.subsPicked, { label, tooltip: entry.subsPath });
  } catch (err) {
    console.error('[cache] 載入字幕失敗', err);
    alert('載入快取字幕失敗：' + (err?.message || err));
  }
}

function updateActiveCacheInfo({ video = getEntryById(state.activeVideoId), subs = getEntryById(state.activeSubsId) } = {}) {
  if (!dom.activeCacheInfo) return;
  const videoLabel = video ? describeVideoEntry(video) : '（未選擇）';
  const subsLabel = subs ? describeSubtitleEntry(subs) : '（未選擇）';
  dom.activeCacheInfo.textContent = `影片/音訊：${videoLabel} | 字幕：${subsLabel}`;
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
      let firstSubs = null;
      entries.forEach((entry) => {
        const merged = upsertCacheEntry(entry);
        if (!firstSubs && merged?.hasSubs && merged.subsPath) {
          firstSubs = merged;
        }
      });
      if (firstSubs) {
        state.activeSubsId = firstSubs.id;
        updateSubsCacheSelect(firstSubs.id);
        await loadSubtitleEntry(firstSubs);
        updateActiveCacheInfo({ video: getEntryById(state.activeVideoId), subs: firstSubs });
        setPickedLabel(dom.subsPicked, {
          label: getSubtitleEntryLabel(firstSubs),
          tooltip: firstSubs.subsPath || ''
        });
      } else {
        updateSubsCacheSelect(state.activeSubsId);
      }
    } else {
      const assPath = files.find((f) => f.toLowerCase().endsWith('.ass')) || files[0];
      await loadAssIntoOverlay(assPath);
      setPickedLabel(dom.subsPicked, {
        label: extractFileName(assPath),
        tooltip: assPath || ''
      });
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
      const convertedName = extractFileName(path);
      setPickedLabel(dom.subsPicked, {
        label: convertedName ? `${convertedName}（已轉 ASS）` : '（已轉 ASS）',
        tooltip: path || ''
      });
    } catch (err) {
      alert('轉 ASS 失敗：' + (err?.message || err));
      return;
    }
  } else {
    setPickedLabel(dom.subsPicked, {
      label: extractFileName(path),
      tooltip: path || ''
    });
  }
  const subsTitle = stripFileExtension(path.split(/[\\/]/).pop() || '');
  const payload = { subsPath: path };
  if (subsTitle) payload.subsTitle = subsTitle;
  if (subsTitle) payload.title = subsTitle;

  try {
    const entry = await window.api.importLocalToCache(payload);
    if (entry) {
      const merged = upsertCacheEntry(entry);
      if (merged?.hasSubs && merged.subsPath) {
        state.activeSubsId = merged.id;
        updateSubsCacheSelect(merged.id);
        await loadSubtitleEntry(merged);
        updateActiveCacheInfo({ video: getEntryById(state.activeVideoId), subs: merged });
        setPickedLabel(dom.subsPicked, {
          label: getSubtitleEntryLabel(merged),
          tooltip: merged.subsPath || ''
        });
      } else {
        updateSubsCacheSelect(state.activeSubsId);
      }
      return;
    }
  } catch (err) {
    console.error('[cache] 匯入字幕失敗', err);
    alert('匯入字幕失敗：' + (err?.message || err));
  }

  setPickedLabel(dom.subsPicked, {
    label: extractFileName(path),
    tooltip: path || ''
  });
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
    if (state.binProgress instanceof Map) {
      state.binProgress.clear();
      renderBinProgress();
    }
    setBinInfo(null);
    const bins = await window.api.ensureBins();
    setBinInfo(bins);
  } catch (err) {
    alert(err?.message || String(err));
  }
}

function setBinInfo(bins) {
  applyBinStatus(dom.binStatusYt, {
    available: Boolean(bins?.ytDlpPath),
    pending: !bins,
    tooltip: bins?.ytDlpPath || ''
  });
  applyBinStatus(dom.binStatusFfmpeg, {
    available: Boolean(bins?.ffmpegPath),
    pending: !bins,
    tooltip: bins?.ffmpegPath || ''
  });
}

function applyBinStatus(iconEl, { available = false, pending = false, tooltip = '' } = {}) {
  if (!iconEl) return;
  const wrapper = iconEl.closest('.bin-status-item');
  if (wrapper) {
    if (pending) wrapper.dataset.state = 'pending';
    else wrapper.dataset.state = available ? 'ok' : 'fail';
    if (tooltip) wrapper.setAttribute('title', tooltip);
    else wrapper.removeAttribute('title');
  }
  if (pending) {
    iconEl.textContent = '–';
  } else if (available) {
    iconEl.textContent = '✓';
  } else {
    iconEl.textContent = '✕';
  }
}

/* ---------------- 本地影片 ---------------- */
function handlePickVideo(event) {
  event?.preventDefault();
  if (!dom.videoFile) return;
  try { dom.videoFile.value = ''; } catch { /* noop */ }
  dom.videoFile.click();
}

async function handleLocalFileSelected(ev) {
  const file = ev.target.files?.[0];
  if (!file) return;
  const filePath = typeof file.path === 'string' ? file.path : '';
  const title = stripFileExtension(file.name || '');

  const attemptImport = async ({ useFilePayload }) => {
    const payload = {
      videoTitle: title || file.name || '',
      title: title || file.name || ''
    };
    if (filePath && !useFilePayload) payload.videoPath = filePath;
    if (useFilePayload) {
      const fileData = await buildFilePayload(file);
      if (fileData) payload.videoFile = fileData;
    }
    if (!payload.videoPath && !payload.videoFile) return null;
    return await window.api.importLocalToCache(payload);
  };

  let entry = null;
  let importError = null;
  try {
    if (filePath) entry = await attemptImport({ useFilePayload: false });
  } catch (err) {
    importError = err;
  }

  if (!entry) {
    try {
      entry = await attemptImport({ useFilePayload: true });
    } catch (err) {
      importError = err;
    }
  }

  if (entry) {
    const merged = upsertCacheEntry(entry);
    if (merged?.hasVideo && merged.videoFilename) {
      state.activeVideoId = merged.id;
      updateVideoCacheSelect(merged.id);
      await loadVideoEntry(merged);
      updateActiveCacheInfo({ video: merged, subs: getEntryById(state.activeSubsId) });
    } else {
      updateVideoCacheSelect(state.activeVideoId);
    }
    ev.target.value = '';
    return;
  }

  if (importError) {
    console.error('[cache] 匯入本地媒體失敗', importError);
    alert('匯入本地媒體失敗：' + (importError?.message || importError));
  }

  const url = URL.createObjectURL(file);
  releaseObjectUrl();
  state.objectUrl = url;
  state.activeVideoId = '';
  updateVideoCacheSelect('');
  if (dom.activeCacheInfo) {
    const subsLabel = describeSubtitleEntry(getEntryById(state.activeSubsId)) || '（未選擇）';
    dom.activeCacheInfo.textContent = `影片/音訊：本地媒體：${file.name} | 字幕：${subsLabel}`;
  }
  playVideo(url);
  setPickedLabel(dom.videoPicked, { label: file.name || '', tooltip: filePath || file.name || '' });
  ev.target.value = '';
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

function createCacheSelector(rowEl, { label, searchPlaceholder, hint } = {}) {
  if (!rowEl || !rowEl.parentElement) return null;
  const container = document.createElement('div');
  container.className = 'row';
  const labelEl = document.createElement('label');
  labelEl.textContent = label || '';
  container.appendChild(labelEl);
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.placeholder = searchPlaceholder || '';
  searchInput.style.width = '200px';
  searchInput.style.marginRight = '8px';
  container.appendChild(searchInput);
  const select = document.createElement('select');
  select.style.minWidth = '260px';
  select.disabled = true;
  container.appendChild(select);
  if (hint) {
    const hintEl = document.createElement('small');
    hintEl.style.marginLeft = '8px';
    hintEl.textContent = hint;
    container.appendChild(hintEl);
  }
  const parent = rowEl.parentElement;
  if (parent) {
    if (rowEl.nextSibling) parent.insertBefore(container, rowEl.nextSibling);
    else parent.appendChild(container);
  }
  return { container, search: searchInput, select };
}

function extractFileName(path = '') {
  if (!path) return '';
  const normalized = String(path).split(/[\\/]/);
  if (!normalized.length) return '';
  return normalized[normalized.length - 1] || '';
}

function setPickedLabel(element, { label = '', tooltip = '' } = {}) {
  if (!element) return;
  element.textContent = label;
  if (tooltip) element.title = tooltip;
  else element.removeAttribute('title');
}

function getVideoEntryLabel(entry) {
  if (!entry) return '';
  return entry.title || entry.displayTitle || entry.videoFilename || extractFileName(entry.videoPath) || '';
}

function getSubtitleEntryLabel(entry) {
  if (!entry) return '';
  return entry.subsFilename || entry.title || entry.displayTitle || extractFileName(entry.subsPath) || '';
}

function stripFileExtension(name = '') {
  if (!name) return '';
  const idx = name.lastIndexOf('.');
  if (idx <= 0) return name;
  return name.slice(0, idx);
}

async function buildFilePayload(file) {
  if (!file) return null;
  try {
    const data = await file.arrayBuffer();
    return { name: file.name || '', data };
  } catch (err) {
    console.error('[cache] 讀取本地媒體失敗', err);
    return null;
  }
}
