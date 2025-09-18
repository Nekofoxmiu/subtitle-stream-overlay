// --- 連線與全域狀態 ---
const ws = new WebSocket(`ws://${location.host}`);

let octopus = null;
let lastSub = '';
let lastTime = 0;
let lastFonts = [];                // overlay 端實際交給 Octopus 的字型 URL（包含 Blob URL 或公開 URL）
let fontBlobUrls = [];             // 僅記錄本次建立的 Blob URL，方便釋放
let currentPlayRes = { x: 1920, y: 1080 };
let currentStyle   = { maxWidth: 1920, align: 'center', background: 'transparent' };

const wrap   = document.getElementById('wrap');
const canvas = document.getElementById('overlay');

// 你若已固定 worker 檔名可直接用下行；若需自動偵測可改用 pickWorkerUrl()
const WORKER_URL = '/assets/suboct/subtitles-octopus-worker.js';

// --- 工具函式 ---
function disposeOctopus() {
  if (octopus) { try { octopus.dispose(); } catch {} }
  octopus = null;
  for (const u of fontBlobUrls) URL.revokeObjectURL(u);
  fontBlobUrls = [];
}

function extractPlayRes(assText) {
  const rx = /PlayResX\s*:\s*(\d+)/i.exec(assText);
  const ry = /PlayResY\s*:\s*(\d+)/i.exec(assText);
  const x = rx ? parseInt(rx[1], 10) : 1920;
  const y = ry ? parseInt(ry[1], 10) : 1080;
  return (x > 0 && y > 0) ? { x, y } : { x: 1920, y: 1080 };
}

function setBodyBg(mode) {
  document.body.classList.remove('gs-green', 'gs-transparent');
  document.body.classList.add(mode === 'green' ? 'gs-green' : 'gs-transparent');
}

/**
 * 等比套用樣式與畫布大小；回傳是否尺寸有變（需要重建/重繪）
 */
function applyStyleAndSize(style = {}, playRes = currentPlayRes) {
  currentStyle = { ...currentStyle, ...style };

  // 背景
  setBodyBg(currentStyle.background);

  // 對齊
  wrap.style.justifyContent =
    currentStyle.align === 'left'  ? 'flex-start' :
    currentStyle.align === 'right' ? 'flex-end'   : 'center';

  // 等比寬高
  const w   = Math.max(1, Number(currentStyle.maxWidth) || 1920);
  const prx = Number(playRes.x) || 1920;
  const pry = Number(playRes.y) || 1080;
  const h   = Math.max(1, Math.round(w * pry / prx));

  const changed = (canvas.width !== w) || (canvas.height !== h);

  // 視覺尺寸
  canvas.style.width  = w + 'px';
  canvas.style.height = h + 'px';
  // 位圖尺寸（會清空畫布）
  if (changed) { canvas.width = w; canvas.height = h; }

  return changed;
}

/**
 * 將 fontBuffers 轉成可供 Octopus 使用的 URL
 * 支援兩種輸入：
 *  - { url: '...' } 公開 URL（不需要 Blob）
 *  - { data: 'base64...' } 以 Blob URL 載入（會記錄到 fontBlobUrls 以供釋放）
 * 並提供至少一個內建字型避免 fallback 到 default.woff2
 */
function makeFontUrls(fontBuffers) {
  // 釋放上一輪 Blob
  for (const u of fontBlobUrls) URL.revokeObjectURL(u);
  fontBlobUrls = [];

  const urls = [];
  for (const f of (fontBuffers || [])) {
    if (f && typeof f.url === 'string') {
      urls.push(f.url);
    } else if (f && typeof f.data === 'string') {
      const bin = atob(f.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'font/ttf' }));
      fontBlobUrls.push(blobUrl);
      urls.push(blobUrl);
    }
  }
  // 保底：若使用者未提供字型，給一個內建公開字型
  if (!urls.length) urls.push('/assets/fonts/NotoSans-Regular.woff2');
  return urls;
}

// 若需自動偵測 worker 名稱，可改用此函式
async function pickWorkerUrl(base = '/assets/suboct') {
  for (const f of ['libassjs-worker.js', 'subtitles-octopus-worker.js']) {
    try { const r = await fetch(`${base}/${f}`, { method: 'HEAD' }); if (r.ok) return `${base}/${f}`; } catch {}
  }
  return WORKER_URL; // 退回固定值
}

// --- 重建與尺寸變更處理 ---
const rebuildDebounced = (() => {
  let t; return (fn) => { clearTimeout(t); t = setTimeout(fn, 120); };
})();

async function rebuildWithLast() {
  if (!lastSub.trim()) return;
  const workerUrl = WORKER_URL; // 或：await pickWorkerUrl();
  await makeOctopus(lastSub, lastFonts, workerUrl);
}

function onSizePossiblyChanged() {
  if (!octopus) return;
  // 尺寸變動後以重建確保渲染器感知新位圖大小
  rebuildDebounced(rebuildWithLast);
}

// --- 建立 Octopus ---
async function makeOctopus(subText, fontBuffers, workerUrl) {
  disposeOctopus();

  lastSub = (subText || '').trim();
  if (!lastSub) return;

  currentPlayRes = extractPlayRes(lastSub);
  applyStyleAndSize(currentStyle, currentPlayRes);

  lastFonts = makeFontUrls(fontBuffers);

  // eslint-disable-next-line no-undef
  octopus = new SubtitlesOctopus({
    canvas,
    subContent: lastSub,
    fonts: lastFonts,
    workerUrl
  });

  // 回到上次時間點（若有）
  if (typeof lastTime === 'number' && lastTime > 0) {
    try { octopus.setCurrentTime(lastTime); } catch {}
  }
}

// --- 訊息處理 ---
ws.onmessage = async (ev) => {
  const { type, payload } = JSON.parse(ev.data);
  if (type === 'state') {
    if (!payload) return;

    // 1) 先套樣式與尺寸；若尺寸改變，觸發重建
    const sizeChanged = applyStyleAndSize(payload.style || {}, currentPlayRes);
    if (sizeChanged) onSizePossiblyChanged();

    // 2) 決定是否需新建或更新字幕/字型
    const newSub   = (payload.subContent || '').trim();
    const hasFonts = Array.isArray(payload.fontBuffers) && payload.fontBuffers.length > 0;

    if (!octopus) {
      if (newSub) await makeOctopus(newSub, payload.fontBuffers, WORKER_URL);
    } else {
      if (hasFonts) {
        // 字型更換需重建
        await makeOctopus(newSub || lastSub, payload.fontBuffers, WORKER_URL);
      } else if (newSub) {
        // 只換字幕：更新比例→必要時調整尺寸→setTrack
        lastSub = newSub;
        currentPlayRes = extractPlayRes(lastSub);
        const changed = applyStyleAndSize(currentStyle, currentPlayRes);
        if (changed) onSizePossiblyChanged();
        try { octopus.setTrack(lastSub); } catch {}
      }
      // 若僅 style 變更且尺寸未變，不需任何動作
    }
  } else if (type === 'setTime') {
    if (octopus && typeof payload?.t === 'number') {
      lastTime = payload.t;
      try { octopus.setCurrentTime(lastTime); } catch {}
    }
  }
};
