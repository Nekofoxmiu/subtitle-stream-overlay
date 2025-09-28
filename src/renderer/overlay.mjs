// --- 連線與全域狀態 ---
const ws = new WebSocket(`ws://${location.host}`);

let octopus = null;
let lastSub = '';
let lastRawSub   = '';
let lastAlignKey = 'off';
let lastTime = 0;
let lastFonts = [];                // overlay 端實際交給 Octopus 的字型 URL（包含 Blob URL 或公開 URL）
let lastRefreshToken = null;
let lastClearToken = null;
let manualClearHold = false;             // keep canvas blank after manual clear until playback resumes
let lastFontBuffers = null;
let fontBlobUrls = [];             // 僅記錄本次建立的 Blob URL，方便釋放
let currentPlayRes = { x: 1920, y: 1080 };
let currentStyle   = { maxWidth: 1920, maxHeight: 1080, align: 'off', background: 'transparent', subtitleOffsetSeconds: 0 };
const TIME_OFFSET_EPSILON = 1e-6;
let currentTimeOffset = 0;
let lastBaseTime = 0;

const wrap   = document.getElementById('wrap');
const canvas = document.getElementById('overlay');


const ALIGN_PRESETS = {
  'top-left': { justify: 'flex-start', align: 'flex-start', ass: 7 },
  'top-center': { justify: 'center', align: 'flex-start', ass: 8 },
  'top-right': { justify: 'flex-end', align: 'flex-start', ass: 9 },
  'middle-left': { justify: 'flex-start', align: 'center', ass: 4 },
  'middle-center': { justify: 'center', align: 'center', ass: 5 },
  'middle-right': { justify: 'flex-end', align: 'center', ass: 6 },
  'bottom-left': { justify: 'flex-start', align: 'flex-end', ass: 1 },
  'bottom-center': { justify: 'center', align: 'flex-end', ass: 2 },
  'bottom-right': { justify: 'flex-end', align: 'flex-end', ass: 3 }
};

const LEGACY_ALIGN_MAP = {
  left: 'bottom-left',
  center: 'bottom-center',
  right: 'bottom-right',
  off: 'off',
  none: 'off',
  disabled: 'off',
  default: 'off',
  centre: 'bottom-center',
  middle: 'middle-center',
  top: 'top-center',
  bottom: 'bottom-center'
};

function resolveAlignStyle(raw) {
  const value = raw == null ? '' : String(raw).trim().toLowerCase();
  if (!value || value === 'off' || value === 'none' || value === 'disabled') {
    return { key: 'off', justify: 'center', align: 'flex-end', ass: null };
  }
  const mapped = LEGACY_ALIGN_MAP[value] || value;
  if (mapped === 'off') {
    return { key: 'off', justify: 'center', align: 'flex-end', ass: null };
  }
  const key = Object.prototype.hasOwnProperty.call(ALIGN_PRESETS, mapped) ? mapped : 'bottom-center';
  return { key, ...ALIGN_PRESETS[key] };
}

function resolveDimension(raw, fallback) {
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return num;
}

function resolveViewportLimit(kind, fallback) {
  const size = kind === 'width' ? window.innerWidth : window.innerHeight;
  if (Number.isFinite(size) && size > 0) return size;
  const doc = document.documentElement;
  if (doc) {
    const docSize = kind === 'width' ? doc.clientWidth : doc.clientHeight;
    if (Number.isFinite(docSize) && docSize > 0) return docSize;
  }
  return fallback;
}

const DIALOGUE_PREFIX_REGEX = /^\\s*Dialogue\\s*:/i;
const ALIGN_OVERRIDE_TAG_REGEX = /\\{\\\\an\\d\\}/gi;

function applyDefaultAlignmentToAss(subText = '', alignKey = 'bottom-center') {
  if (!subText) return '';
  const normalizedKey = String(alignKey ?? '').trim().toLowerCase();
  if (!normalizedKey || normalizedKey === 'off' || normalizedKey === 'none' || normalizedKey === 'disabled') {
    console.debug('[overlay] align disabled (off); skipping ASS rewrite');
    return subText;
  }
  const preset = resolveAlignStyle(normalizedKey);
  const alignCode = (typeof preset.ass === 'number') ? preset.ass : null;
  if (alignCode == null) {
    console.debug(`[overlay] align ${normalizedKey} has no numeric keypad mapping; skipping ASS rewrite`);
    return subText;
  }

  const useCrlf = subText.includes('\r\n');
  const newline = useCrlf ? '\r\n' : '\n';
  const lines = subText.split(/\r?\n/);
  let inStylesSection = false;
  let styleUpdated = false;
  let overridesRemoved = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^\s*\[V4\+\s*Styles\]\s*$/i.test(line)) {
      inStylesSection = true;
      continue;
    }
    if (/^\s*\[Events\]\s*$/i.test(line)) {
      inStylesSection = false;
      continue;
    }

    if (inStylesSection && /^\s*Style\s*:/i.test(line)) {
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) continue;
      const head = line.slice(0, colonIndex + 1);
      const body = line.slice(colonIndex + 1);
      const parts = body.split(',');
      if (parts.length >= 19) {
        const styleName = (parts[0] || '').trim();
        if (styleName === 'Default') {
          const rawAlign = parts[18] == null ? '' : parts[18];
          const currentAlign = Number.parseInt(rawAlign.trim(), 10);
          if (!Number.isFinite(currentAlign) || currentAlign !== alignCode) {
            const leadingMatch = rawAlign.match(/^\s*/);
            const trailingMatch = rawAlign.match(/\s*$/);
            const leading = leadingMatch && leadingMatch[0] !== undefined ? leadingMatch[0] : '';
            const trailing = trailingMatch && trailingMatch[0] !== undefined ? trailingMatch[0] : '';
            parts[18] = leading + String(alignCode) + trailing;
            lines[i] = head + parts.join(',');
            styleUpdated = true;
          }
        }
      }
      continue;
    }

    if (/^\s*Dialogue\s*:/i.test(line)) {
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) continue;
      const prefix = line.slice(0, colonIndex + 1);
      const remainder = line.slice(colonIndex + 1);

      let commaCount = 0;
      let textStart = -1;
      for (let j = 0; j < remainder.length; j++) {
        if (remainder[j] === ',') {
          commaCount += 1;
          if (commaCount === 9) {
            textStart = j + 1;
            break;
          }
        }
      }
      if (textStart === -1) continue;

      const meta = remainder.slice(0, textStart);
      const metaFields = meta.split(',');
      const styleName = metaFields.length >= 4 ? (metaFields[3] || '').trim() : '';
      if (styleName && styleName !== 'Default') continue;

      const textPart = remainder.slice(textStart);
      const cleaned = textPart.replace(ALIGN_OVERRIDE_TAG_REGEX, '');
      if (cleaned !== textPart) {
        lines[i] = prefix + meta + cleaned;
        overridesRemoved += 1;
      }
    }
  }

  if (!styleUpdated && overridesRemoved === 0) {
    console.debug(`[overlay] align ${normalizedKey} (\\an${alignCode}) already satisfied`);
    return subText;
  }

  console.debug(`[overlay] align ${normalizedKey} (\\an${alignCode}) applied; styleUpdated=${styleUpdated}, overridesRemoved=${overridesRemoved}`);
  return lines.join(newline);
}
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


function normalizeOffsetSeconds(value) {
  const raw = typeof value === 'number' ? value : Number.parseFloat(String(value ?? '').trim());
  if (!Number.isFinite(raw) || Math.abs(raw) < TIME_OFFSET_EPSILON) return 0;
  return raw;
}


/**
 * 等比套用樣式與畫布大小；回傳是否尺寸有變（需要重建/重繪）
 */
function applyStyleAndSize(style = {}, playRes = currentPlayRes) {
  currentStyle = { ...currentStyle, ...style };

  // 背景
  setBodyBg(currentStyle.background);

  // 對齊
  const alignDisabled = currentStyle.align === 'off';
  if (alignDisabled) {
    wrap.style.justifyContent = 'center';
    wrap.style.alignItems = 'flex-end';
    if (currentStyle.align !== 'off') {
      console.debug('[overlay] wrap align disabled (off)');
    }
    currentStyle.align = 'off';
  } else {
    const alignPreset = resolveAlignStyle(currentStyle.align);
    wrap.style.justifyContent = alignPreset.justify;
    wrap.style.alignItems = alignPreset.align;
    if (currentStyle.align !== alignPreset.key) {
      console.debug(`[overlay] wrap align -> ${alignPreset.key}`);
    }
    currentStyle.align = alignPreset.key;
  }

  // 等比寬高並同時受限於最大尺寸與可視區域
  const prx = Math.max(1, Number(playRes.x) || 1920);
  const pry = Math.max(1, Number(playRes.y) || 1080);

  const desiredMaxWidth = resolveDimension(currentStyle.maxWidth, prx);
  const desiredMaxHeight = resolveDimension(currentStyle.maxHeight, pry);
  const viewportWidth = resolveViewportLimit('width', desiredMaxWidth);
  const viewportHeight = resolveViewportLimit('height', desiredMaxHeight);

  const widthLimit = Math.max(1, Math.min(desiredMaxWidth, viewportWidth));
  const heightLimit = Math.max(1, Math.min(desiredMaxHeight, viewportHeight));
  const widthScale = widthLimit / prx;
  const heightScale = heightLimit / pry;
  let scale = Math.min(widthScale, heightScale);
  if (!Number.isFinite(scale) || scale <= 0) {
    if (Number.isFinite(widthScale) && widthScale > 0) scale = widthScale;
    else if (Number.isFinite(heightScale) && heightScale > 0) scale = heightScale;
    else scale = 1;
  }

  const w = Math.max(1, Math.round(prx * scale));
  const h = Math.max(1, Math.round(pry * scale));
  currentStyle.maxWidth = desiredMaxWidth;
  currentStyle.maxHeight = desiredMaxHeight;

  const changed = (canvas.width !== w) || (canvas.height !== h);

  // 寫入尺寸並保持等比
  canvas.style.width  = w + 'px';
  canvas.style.height = h + 'px';
  // 調整畫布內部尺寸以維持畫質
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
  const fontsPayload = lastFontBuffers ?? lastFonts;

  await makeOctopus(lastSub, fontsPayload, workerUrl);
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

  const fontSource = Array.isArray(fontBuffers) ? fontBuffers : null;
  if (fontSource && (!fontSource.length || typeof fontSource[0] === 'object')) {
    lastFontBuffers = fontSource;
  }
  lastFonts = makeFontUrls(fontSource);

  // eslint-disable-next-line no-undef
  octopus = new SubtitlesOctopus({
    canvas,
    subContent: lastSub,
    fonts: lastFonts,
    workerUrl
  });

  // 回到上次時間點（若有）
  const targetTime = Math.max(0, lastBaseTime + currentTimeOffset);
  lastTime = targetTime;
  if (targetTime > 0) {
    try { octopus.setCurrentTime(targetTime); } catch {}
  }
  manualClearHold = false;
}

// --- 訊息處理 ---
ws.onmessage = async (ev) => {
  const { type, payload } = JSON.parse(ev.data);
  if (type === 'state') {
    if (!payload) return;

    const incomingTokenRaw = payload.refreshToken;
    const nextRefreshToken = incomingTokenRaw == null ? null : String(incomingTokenRaw);
    const refreshRequested = nextRefreshToken !== null && nextRefreshToken !== lastRefreshToken;
    if (refreshRequested) {
      manualClearHold = false;
      disposeOctopus();
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width || 0, canvas.height || 0);
    }
    lastRefreshToken = nextRefreshToken;

    const incomingClearTokenRaw = payload.clearToken;
    let shouldClearCanvas = false;
    if (incomingClearTokenRaw == null) {
      if (lastClearToken !== null) lastClearToken = null;
    } else {
      const nextClearToken = String(incomingClearTokenRaw);
      if (nextClearToken !== lastClearToken) {
        lastClearToken = nextClearToken;
        shouldClearCanvas = true;
      }
    }
    if (shouldClearCanvas) {
      manualClearHold = true;
      disposeOctopus();
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width || 0, canvas.height || 0);
    }

    // 1) 將樣式與畫布設定更新，包含對齊與尺寸
    const incomingStyle = payload.style || {};
    const prevAlignKey = lastAlignKey;
    const sizeChanged = applyStyleAndSize(incomingStyle, currentPlayRes);
    if (sizeChanged) onSizePossiblyChanged();

    let nextOffset = normalizeOffsetSeconds(incomingStyle.subtitleOffsetNetSeconds);
    if (nextOffset === 0) {
      const mode = incomingStyle.subtitleOffsetMode === 'delay' ? 'delay' : 'advance';
      const magnitude = normalizeOffsetSeconds(incomingStyle.subtitleOffsetSeconds);
      if (magnitude !== 0) nextOffset = mode === 'delay' ? -magnitude : magnitude;
    }
    if (nextOffset === 0 && (incomingStyle.subtitleAdvanceSeconds || incomingStyle.subtitleDelaySeconds)) {
      const adv = normalizeOffsetSeconds(incomingStyle.subtitleAdvanceSeconds);
      const delay = normalizeOffsetSeconds(incomingStyle.subtitleDelaySeconds);
      const diff = adv - delay;
      nextOffset = Math.abs(diff) < TIME_OFFSET_EPSILON ? 0 : diff;
    }
    const targetTime = Math.max(0, lastBaseTime + nextOffset);
    const offsetChanged = nextOffset !== currentTimeOffset;
    currentTimeOffset = nextOffset;
    lastTime = targetTime;
    if (offsetChanged && octopus) {
      try { octopus.setCurrentTime(targetTime); } catch {}
    }

    const alignChanged = currentStyle.align !== prevAlignKey;
    lastAlignKey = currentStyle.align;

    // 2) 決定是否需要重新套用字幕內容或字型
    const newSub = (payload.subContent || '').trim();
    const fontsUpdated = Array.isArray(payload.fontBuffers);
    const incomingFontBuffers = fontsUpdated ? payload.fontBuffers : null;

    if (newSub) {
      lastRawSub = newSub;
    }
    if (fontsUpdated) {
      lastFontBuffers = incomingFontBuffers;
    }

    const effectiveRawSub = newSub ? newSub : lastRawSub;
    const alignedSub = effectiveRawSub ? applyDefaultAlignmentToAss(effectiveRawSub, currentStyle.align) : '';
    const fontPayload = fontsUpdated ? incomingFontBuffers : lastFontBuffers;
    const hasAlignedSub = Boolean(alignedSub);
    const alignedChanged = hasAlignedSub && alignedSub !== lastSub;

    if (manualClearHold) {
      if (hasAlignedSub) {
        lastSub = alignedSub;
        currentPlayRes = extractPlayRes(lastSub);
        const changed = applyStyleAndSize(currentStyle, currentPlayRes);
        if (changed) onSizePossiblyChanged();
      }
      return;
    }

    if (!octopus) {
      if (hasAlignedSub) await makeOctopus(alignedSub, fontPayload, WORKER_URL);
      return;
    }

    if (fontsUpdated) {
      if (hasAlignedSub) await makeOctopus(alignedSub, fontPayload, WORKER_URL);
      return;
    }

    if (alignedChanged || (alignChanged && hasAlignedSub)) {
      lastSub = alignedSub;
      currentPlayRes = extractPlayRes(lastSub);
      const changed = applyStyleAndSize(currentStyle, currentPlayRes);
      if (changed) onSizePossiblyChanged();
      try { octopus.setTrack(lastSub); } catch {}
    }
  } else if (type === 'setTime') {
    if (typeof payload?.t === 'number') {
      const prevTime = lastTime;
      lastBaseTime = payload.t;
      const adjusted = Math.max(0, lastBaseTime + currentTimeOffset);
      lastTime = adjusted;
      if (manualClearHold && adjusted > prevTime + TIME_OFFSET_EPSILON && lastSub) {
        await rebuildWithLast();
      }
      if (octopus) {
        try { octopus.setCurrentTime(adjusted); } catch {}
      }
    }
  }
};




