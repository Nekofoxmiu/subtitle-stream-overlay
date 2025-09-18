const $ = (s) => document.querySelector(s);
const binInfo = $('#binInfo'), portView = $('#portView'), applyMsg = $('#applyMsg');

let currentAssText = '';
let currentFonts = []; // [{name, data(base64)}]
let currentJobId = null; // 目前 yt-dlp 下載工作 ID

/* ---------------- Overlay 時間同步 ---------------- */
class OverlaySync {
  constructor(videoEl) { this.ws = null; this.timer = null; this.port = 1976; this.video = videoEl; }
  connect(port) {
    if (this.port === port && this.ws && this.ws.readyState === 1) return;
    this.port = port;
    if (this.ws) try { this.ws.close(); } catch { }
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
  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}
const videoEl = $('#localVideo');
const overlaySync = new OverlaySync(videoEl);

/* ---------------- yt-dlp 下載並播放 ---------------- */
const cookiesView = $('#cookiesView');

// 初始化時一併載入 cookiesPath
(async () => {
  const cfg = await window.api.getConfig();
  $('#port').value = String(cfg.output.port);
  portView.textContent = String(cfg.output.port);
  cookiesView.textContent = cfg.cookiesPath ? cfg.cookiesPath : '(未設定)';
  overlaySync.connect(cfg.output.port);
})();

// 讓使用者選 cookies.txt
$('#pickCookies').onclick = async () => {
  const files = await window.api.openFiles({ filters: [{ name: 'Cookies', extensions: ['txt'] }] });
  if (!files.length) return;
  const cookiesPath = files[0];
  await window.api.setConfig({ cookiesPath });   // 儲存到 config
  cookiesView.textContent = cookiesPath;
  applyMsg.textContent = '已設定 cookies';
};

// 清除 cookies 設定
$('#clearCookies').onclick = async () => {
  await window.api.setConfig({ cookiesPath: '' });
  cookiesView.textContent = '(未設定)';
  applyMsg.textContent = '已清除 cookies';
};

const logEl = document.querySelector('#ytLog');
function appendLog(line) {
  logEl.textContent += line.endsWith('\n') ? line : (line + '\n');
  logEl.scrollTop = logEl.scrollHeight;
}

// 下載影片進度/日誌
window.api.onYtProgress((ev) => {
  if (ev.type === 'log') appendLog(`[${ev.stream}] ${ev.line}`);
  else if (ev.type === 'progress') {
    document.querySelector('#dlProg').style.display = '';
    document.querySelector('#dlProg').value = ev.percent || 0;
    document.querySelector('#dlTxt').textContent = `${(ev.percent||0).toFixed(1)}% ${ev.speed||''} ${ev.eta||''}`;
  } else if (ev.type === 'done') {
    document.querySelector('#dlProg').style.display = 'none';
    document.querySelector('#dlTxt').textContent = '';
    appendLog(`[done] ${ev.filename}`);
    const port = parseInt(document.querySelector('#port').value, 10);
    document.querySelector('#localVideo').src = `http://localhost:${port}/video-cache/${encodeURIComponent(ev.filename)}`;
    document.querySelector('#localVideo').play().catch(()=>{});
  } else if (ev.type === 'error') {
    document.querySelector('#dlProg').style.display = 'none';
    appendLog(`[error] ${ev.message || '未知錯誤'}`);
    alert('下載失敗：' + (ev.message || '未知錯誤'));
  }
});

// 下載字幕(ASS)
document.querySelector('#ytFetch').onclick = async () => {
  const url = document.querySelector('#ytUrl').value.trim();
  if (!url) return alert('請輸入連結');
  try {
    const { files } = await window.api.fetchSubsFromYt({ url }); // 你先前已有此 IPC；若名稱不同請對應
    if (!files?.length) return alert('未取得字幕');
    appendLog(`[subs] 已下載字幕：\n${files.join('\n')}`);
    // 自動載入第一個 .ass
    const ass = files.find(f=>f.toLowerCase().endsWith('.ass')) || files[0];
    const assText = await window.api.readTextFile(ass);
    currentAssText = assText;
    const style = collectStyle();
    await window.api.setConfig({ output: style });
    window.api.notifyOverlay({ style, subContent: currentAssText, fontBuffers: currentFonts });
    document.querySelector('#subsPicked').textContent = ass;
  } catch (e) {
    appendLog(`[subs-error] ${e.message || e}`);
    alert('下載字幕失敗：' + (e.message || e));
  }
};


function showDl(show) {
  $('#dlProg').style.display = show ? '' : 'none';
  if (!show) { $('#dlProg').value = 0; $('#dlTxt').textContent = ''; }
}

$('#ytDownload').onclick = async () => {
  const url = $('#ytUrl').value.trim();
  if (!url) return alert('請輸入 YouTube 連結');
  const { port } = collectStyle();
  showDl(true);
  try {
    const { jobId } = await window.api.ytdlpDownloadVideo({ url });
    currentJobId = jobId;
    window.api.onYtProgress((ev) => {
      if (ev?.jobId !== currentJobId) return;
      if (ev.type === 'progress') {
        $('#dlProg').value = ev.percent || 0;
        $('#dlTxt').textContent = `${(ev.percent || 0).toFixed(1)}% ${ev.speed || ''} ${ev.eta || ''}`;
      } else if (ev.type === 'done') {
        showDl(false);
        const fileUrl = `http://localhost:${port}/video-cache/${encodeURIComponent(ev.filename)}`;
        videoEl.src = fileUrl;
        videoEl.play().catch(() => { });
        overlaySync.connect(port);
        overlaySync.start();
      } else if (ev.type === 'error') {
        showDl(false);
        alert('下載失敗：' + (ev.message || '未知錯誤'));
      }
    });
  } catch (e) {
    showDl(false);
    alert(e.message);
  }
};

/* ---------------- 本地影片 ---------------- */
$('#videoFile').addEventListener('change', (ev) => {
  const f = ev.target.files?.[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  videoEl.src = url;
  const { port } = collectStyle();
  overlaySync.connect(port);
  overlaySync.start();
});

/* ---------------- bins / 字幕 / 字型 / 樣式 ---------------- */
function setBinInfo(bins) {
  binInfo.textContent = `yt-dlp: ${bins.ytDlpPath || '未設定'} | ffmpeg: ${bins.ffmpegPath || '未設定'}`;
}

async function loadAssIntoOverlay(assPath) {
  const assText = await window.api.readTextFile(assPath);
  currentAssText = assText;
  const style = collectStyle();
  await window.api.setConfig({ output: style });
  window.api.notifyOverlay({ style, subContent: currentAssText, fontBuffers: currentFonts });
}

$('#checkBins').onclick = async () => {
  try {
    const r = await window.api.ensureBins();
    setBinInfo(r);
  } catch (e) { alert(e.message); }
};

$('#pickSubs').onclick = async () => {
  const files = await window.api.openFiles({ filters: [{ name: 'Subtitles', extensions: ['ass', 'srt', 'vtt', 'ssa'] }] });
  if (!files.length) return;
  let p = files[0];
  if (!p.toLowerCase().endsWith('.ass')) {
    try {
      const { outPath } = await window.api.convertToAss({ inputPath: p });
      p = outPath;
      $('#subsPicked').textContent = `${p}（已轉 ASS）`;
    } catch (e) { alert('轉 ASS 失敗：' + e.message); return; }
  } else {
    $('#subsPicked').textContent = p;
  }
  try { await loadAssIntoOverlay(p); } catch (e) { alert('讀取 ASS 失敗：' + e.message); }
};

$('#pickFonts').onclick = async () => {
  const files = await window.api.openFiles({ filters: [{ name: 'Fonts', extensions: ['ttf', 'otf', 'woff2', 'woff'] }] });
  if (!files.length) return;
  currentFonts = [];
  const names = [];
  for (const p of files) {
    const base64 = await window.api.readBinaryBase64(p);
    currentFonts.push({ name: p.split(/[\\/]/).pop(), data: base64 });
    names.push(p.split(/[\\/]/).pop());
  }
  $('#fontsPicked').textContent = names.join(', ');
  const style = collectStyle();
  await window.api.setConfig({ output: style });
  window.api.notifyOverlay({ style, fontBuffers: currentFonts });
};

function collectStyle() {
  return {
    port: parseInt($('#port').value, 10),
    background: $('#background').value,
    maxWidth: parseInt($('#maxWidth').value, 10),
    align: $('#align').value
  };
}

const debounce = (fn, ms = 120) => { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; };

const syncStyle = debounce(async () => {
  const style = collectStyle();
  await window.api.setConfig({ output: style });
  window.api.notifyOverlay({ style });
  overlaySync.connect(style.port);
}, 120);

['background', 'align', 'maxWidth', 'port'].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('change', syncStyle);
  if (el.tagName === 'INPUT') el.addEventListener('input', syncStyle);
});

$('#port').addEventListener('input', () => portView.textContent = $('#port').value);

$('#applyToOverlay').onclick = async () => {
  const style = collectStyle();
  await window.api.setConfig({ output: style });
  window.api.notifyOverlay({ style, subContent: currentAssText, fontBuffers: currentFonts });
  applyMsg.textContent = `已更新。請以 OBS Browser Source 指向 http://localhost:${style.port}/overlay`;
};

// 初始化
(async () => {
  const cfg = await window.api.getConfig();
  $('#port').value = String(cfg.output.port);
  portView.textContent = String(cfg.output.port);
  overlaySync.connect(cfg.output.port);
})();
