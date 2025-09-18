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
  applyToOverlay: $('#applyToOverlay')
};

dom.downloadedSelect = createDownloadedSelect(dom.videoFile?.closest('.row'));

const state = {
  currentAssText: '',
  currentFonts: [],
  jobId: null,
  downloadedVideos: [], // { filename, addedAt }
  activeDownloaded: '',
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
  updateDownloadedSelect();
  await loadInitialConfig();
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



function setupEventHandlers() {

  const debouncedSyncStyle = debounce(async () => {
    const style = collectStyle();
    await persistStyle(style);
    window.api.notifyOverlay({ style });
    syncOverlayConnection();
    if (!state.activeDownloaded) return;
    // 重新設定下載影片的連線位置
    const url = buildCacheUrl(state.activeDownloaded);
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
    handleDownloadDone(ev.filename);
  } else if (ev.type === 'error') {
    showDownloadProgress(false);
    alert('下載失敗：' + (ev.message || '未知錯誤'));
  }
}

function handleDownloadDone(filename) {
  showDownloadProgress(false);
  state.jobId = null;
  appendLog(`[done] ${filename}`);
  if (!filename) return;
  addDownloadedVideo(filename);
  playDownloadedVideo(filename);
}

function addDownloadedVideo(filename) {
  if (!filename) return;
  const exists = state.downloadedVideos.some((item) => item.filename === filename);
  if (!exists) {
    state.downloadedVideos.push({ filename, addedAt: Date.now() });
  }
  state.activeDownloaded = filename;
  updateDownloadedSelect(filename);
}

function playDownloadedVideo(filename) {
  if (!filename) return;
  releaseObjectUrl();
  const url = buildCacheUrl(filename);
  state.activeDownloaded = filename;
  updateDownloadedSelect(filename);
  playVideo(url);
}

function buildCacheUrl(filename) {
  const port = getCurrentPort();
  return `http://localhost:${port}/video-cache/${encodeURIComponent(filename)}`;
}

/* ---------------- 字幕處理 ---------------- */
async function handleFetchSubsOnly() {
  const url = dom.ytUrl?.value.trim();
  if (!url) {
    alert('請輸入連結');
    return;
  }
  try {
    const { files } = await window.api.fetchSubsFromYt({ url });
    if (!files?.length) {
      alert('未取得字幕');
      return;
    }
    appendLog(`[subs] 已下載字幕：\n${files.join('\n')}`);
    const assPath = files.find((f) => f.toLowerCase().endsWith('.ass')) || files[0];
    await loadAssIntoOverlay(assPath);
    dom.subsPicked.textContent = assPath;
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
  state.activeDownloaded = '';
  updateDownloadedSelect('');
  playVideo(url);
}

function handleDownloadedSelectChange() {
  const filename = dom.downloadedSelect?.value;
  if (!filename) {
    state.activeDownloaded = '';
    return;
  }
  playDownloadedVideo(filename);
}

function playVideo(url) {
  if (!url) return;
  dom.video.src = url;
  dom.video.play().catch(() => { /* ignore autoplay error */ });
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

function updateDownloadedSelect(selectedFilename = state.activeDownloaded) {
  const select = dom.downloadedSelect;
  if (!select) return;
  select.innerHTML = '';
  if (!state.downloadedVideos.length) {
    const option = new Option('（尚無下載影片）', '');
    option.selected = true;
    select.add(option);
    select.disabled = true;
    return;
  }
  select.disabled = false;
  const placeholder = new Option('選擇下載影片播放', '', !selectedFilename, !selectedFilename);
  select.add(placeholder);
  state.downloadedVideos
    .slice()
    .sort((a, b) => a.addedAt - b.addedAt)
    .forEach(({ filename }) => {
      const option = new Option(filename, filename, false, filename === selectedFilename);
      select.add(option);
    });
  if (selectedFilename) {
    select.value = selectedFilename;
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
  hint.textContent = '（下載完成的影片會出現在此）';
  rowEl.appendChild(hint);
  return select;
}
