import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import fontManagerModule from 'font-scanner';
import { processAssForOverlay, DEFAULT_PLAY_RES } from './assUtils.mjs';
import { store } from './config.mjs';

const fontManager = fontManagerModule?.default ?? fontManagerModule;
const FONT_LOOKUP_AVAILABLE = Boolean(fontManager?.findFontsSync);

const WS_READY_STATE_OPEN = 1;
const EMPTY_ASS_META = Object.freeze({ alignmentApplied: false, styleUpdated: false, overridesRemoved: 0, defaultFontReplaced: false });

const DEFAULT_FONT_NAME = 'NotoSans-Regular.woff2';
const DEFAULT_FONT_URL = '/assets/fonts/NotoSans-Regular.woff2';
const DEFAULT_FONT_FAMILY = 'Noto Sans CJK SC';

const FONT_WEIGHT_PATTERNS = [
  { regex: /\bextra[- ]?(thin|light)\b/gi, weight: 200 },
  { regex: /\bultra[- ]?(thin|light)\b/gi, weight: 200 },
  { regex: /\bthin\b/gi, weight: 100 },
  { regex: /\blight\b/gi, weight: 300 },
  { regex: /\bregular\b/gi, weight: 400 },
  { regex: /\bbook\b/gi, weight: 400 },
  { regex: /\bnormal\b/gi, weight: 400 },
  { regex: /\bmedium\b/gi, weight: 500 },
  { regex: /\bsemi[- ]?bold\b/gi, weight: 600 },
  { regex: /\bdemi[- ]?bold\b/gi, weight: 600 },
  { regex: /\bbold\b/gi, weight: 700 },
  { regex: /\bextra[- ]?bold\b/gi, weight: 800 },
  { regex: /\bultra[- ]?bold\b/gi, weight: 800 },
  { regex: /\bheavy\b/gi, weight: 900 },
  { regex: /\bblack\b/gi, weight: 900 }
];
const FONT_ITALIC_PATTERNS = [/\bitalic\b/gi, /\boblique\b/gi];

function mergeStyles(currentStyle, patchStyle) {
  const base = (currentStyle && typeof currentStyle === 'object') ? currentStyle : {};
  const patch = (patchStyle && typeof patchStyle === 'object') ? patchStyle : {};
  const merged = { ...base, ...patch };
  const normalizedFamily = typeof merged.defaultFontFamily === 'string' ? merged.defaultFontFamily.trim() : '';
  merged.defaultFontFamily = normalizedFamily || DEFAULT_FONT_FAMILY;
  if (typeof patch.forceDefaultFont === 'boolean') {
    merged.forceDefaultFont = patch.forceDefaultFont;
  } else if (typeof merged.forceDefaultFont !== 'boolean') {
    merged.forceDefaultFont = Boolean(merged.forceDefaultFont);
  }
  return merged;
}

function clonePlayRes(playRes = DEFAULT_PLAY_RES) {
  return { x: playRes.x, y: playRes.y };
}

function normalizeFontBuffer(font) {
  if (!font || typeof font !== 'object') return null;
  const normalized = {};
  if (typeof font.name === 'string' && font.name) normalized.name = font.name;
  if (typeof font.data === 'string' && font.data) normalized.data = font.data;
  if (typeof font.url === 'string' && font.url) normalized.url = font.url;
  return (normalized.data || normalized.url) ? normalized : null;
}

function normalizeFontBufferList(list) {
  const input = Array.isArray(list) ? list : [];
  const sanitized = [];
  for (const font of input) {
    const normalized = normalizeFontBuffer(font);
    if (!normalized) continue;
    if (isDefaultFontEntry(normalized)) continue;
    sanitized.push(normalized);
  }
  return [createDefaultFontEntry(), ...sanitized];
}

function createDefaultFontEntry() {
  return { name: DEFAULT_FONT_NAME, url: DEFAULT_FONT_URL };
}

function isDefaultFontEntry(font) {
  if (!font || typeof font !== 'object') return false;
  const url = typeof font.url === 'string' ? font.url : '';
  const name = typeof font.name === 'string' ? font.name : '';
  const lowerUrl = url ? url.toLowerCase() : '';
  const lowerName = name ? name.toLowerCase() : '';
  if (lowerUrl && lowerUrl.endsWith(DEFAULT_FONT_NAME.toLowerCase())) return true;
  if (lowerName) {
    if (lowerName === DEFAULT_FONT_NAME.toLowerCase()) return true;
    if (lowerName === DEFAULT_FONT_FAMILY.toLowerCase()) return true;
    const trimmed = lowerName.replace(/\.[^.]+$/, '');
    if (trimmed === DEFAULT_FONT_NAME.replace(/\.[^.]+$/, '').toLowerCase()) return true;
  }
  return false;
}

function analyseFontName(name) {
  if (typeof name !== 'string') {
    return { original: '', baseFamily: '', weight: null, italic: null };
  }
  const original = name.trim();
  if (!original) {
    return { original: '', baseFamily: '', weight: null, italic: null };
  }
  let working = original.replace(/^@+/, '');
  let italic = null;
  for (const pattern of FONT_ITALIC_PATTERNS) {
    if (pattern.test(working)) {
      italic = true;
      working = working.replace(pattern, ' ');
    }
  }
  let weight = null;
  for (const { regex, weight: value } of FONT_WEIGHT_PATTERNS) {
    if (regex.test(working)) {
      if (weight == null) weight = value;
      working = working.replace(regex, ' ');
    }
  }
  const baseFamily = working.replace(/\s+/g, ' ').trim();
  return {
    original,
    baseFamily: baseFamily || original,
    weight,
    italic: italic === true ? true : null
  };
}

function buildFontQueries(meta) {
  const queries = [];
  const families = [];
  if (meta.original) families.push(meta.original);
  if (meta.baseFamily && meta.baseFamily.toLowerCase() !== meta.original.toLowerCase()) {
    families.push(meta.baseFamily);
  }
  if (meta.baseFamily && !families.includes(meta.baseFamily)) {
    families.push(meta.baseFamily);
  }
  const seen = new Set();
  for (const family of families) {
    const trimmed = family.replace(/\s+/g, ' ').trim();
    if (!trimmed) continue;
    const specificQuery = {};
    specificQuery.family = trimmed;
    if (typeof meta.weight === 'number') specificQuery.weight = meta.weight;
    if (typeof meta.italic === 'boolean') specificQuery.italic = meta.italic;
    const generalQuery = { family: trimmed };
    for (const query of [specificQuery, generalQuery]) {
      const sanitized = {};
      if (query.family) sanitized.family = query.family;
      if (typeof query.weight === 'number') sanitized.weight = query.weight;
      if (typeof query.italic === 'boolean') sanitized.italic = query.italic;
      const key = JSON.stringify(sanitized);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      queries.push(sanitized);
    }
  }
  return queries;
}

function pickBestFontMatch(matches, meta) {
  if (!Array.isArray(matches) || !matches.length) return null;
  const targetFamily = meta.baseFamily?.toLowerCase() || '';
  const desiredWeight = typeof meta.weight === 'number' ? meta.weight : null;
  const wantsItalic = meta.italic === true;
  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const font of matches) {
    if (!font || !font.path) continue;
    let score = 0;
    if (targetFamily) {
      const fontFamily = (font.family || '').toLowerCase();
      if (fontFamily !== targetFamily) score += 5;
    }
    if (wantsItalic) {
      score += font.italic ? 0 : 2;
    }
    if (desiredWeight != null) {
      const weightDiff = Math.abs((font.weight ?? 400) - desiredWeight);
      score += weightDiff / 100;
    }
    if (score < bestScore) {
      bestScore = score;
      best = font;
    }
  }
  return best || matches[0] || null;
}

function findSystemFont(fontName) {
  if (!FONT_LOOKUP_AVAILABLE) return null;
  const meta = analyseFontName(fontName);
  const queries = buildFontQueries(meta);
  for (const query of queries) {
    let matches = [];
    try {
      matches = fontManager.findFontsSync(query);
      console.log('[overlayServer] font-scanner query', query, '=>', matches.length, 'matches');
    } catch (err) {
      console.warn('[overlayServer] font-scanner query failed', query, err);
      continue;
    }
    if (!Array.isArray(matches) || matches.length === 0) continue;
    const best = pickBestFontMatch(matches, meta);
    if (best) return { font: best, meta };
  }
  return null;
}

export class OverlayServer {
  constructor({ rendererDir, assetsDir, userDataPath } = {}) {
    this.rendererDir = rendererDir;
    this.assetsDir = assetsDir;
    this.userDataPath = userDataPath;
    this.rawSubContent = '';

    this.fontLookupEnabled = FONT_LOOKUP_AVAILABLE;
    if (!this.fontLookupEnabled) {
      console.warn('[overlayServer] font-scanner unavailable; system font auto-loading disabled');
    }

    this.fontCache = new Map();
    this.lastFontKey = '';
    this.missingFonts = new Set();

    const persistedFonts = store.get('fonts');
    this.manualFontBuffers = normalizeFontBufferList(persistedFonts);
    this.autoFontBuffers = [];

    this.state = {
      subContent: '',
      rawSubContent: '',
      fontBuffers: this.combineFontPayloads(this.autoFontBuffers),
      style: store.get('output'),
      playRes: clonePlayRes(),
      assMeta: EMPTY_ASS_META
    };
    this.app = express();
    this.server = http.createServer(this.app);
    this.server.on('error', (err) => {
      if (!this.server.listening) return;
      console.error('[overlayServer] server error', err);
    });
    this.wss = new WebSocketServer({ server: this.server });
    this.setupRoutes();
    this.setupWs();
  }

  combineFontPayloads(autoFonts = []) {
    const manualFonts = Array.isArray(this.manualFontBuffers) ? this.manualFontBuffers : [];
    return [...autoFonts, ...manualFonts];
  }

  readFontAsBase64(fontPath) {
    if (!fontPath) return null;
    const normalizedPath = path.normalize(fontPath);
    if (this.fontCache.has(normalizedPath)) return this.fontCache.get(normalizedPath);
    try {
      const data = fs.readFileSync(normalizedPath);
      const base64 = data.toString('base64');
      this.fontCache.set(normalizedPath, base64);
      return base64;
    } catch (err) {
      console.warn('[overlayServer] failed to read font file', normalizedPath, err);
      this.fontCache.set(normalizedPath, null);
      return null;
    }
  }

  loadSystemFonts(fontNames = []) {
    if (!this.fontLookupEnabled) return [];
    const normalizedNames = Array.isArray(fontNames)
      ? fontNames.map((name) => typeof name === 'string' ? name.trim() : '').filter(Boolean)
      : [];
    if (!normalizedNames.length) {
      this.lastFontKey = '';
      return [];
    }
    const key = normalizedNames.map((name) => name.toLowerCase()).join('||');
    if (this.lastFontKey === key && this.autoFontBuffers.length) {
      return this.autoFontBuffers;
    }
    this.lastFontKey = key;

    const autoFonts = [];
    const seenPaths = new Set();
    for (const name of normalizedNames) {
      const match = findSystemFont(name);
      if (!match || !match.font || !match.font.path) {
        const lower = name.toLowerCase();
        if (!this.missingFonts.has(lower)) {
          console.warn(`[overlayServer] system font not found: ${name}`);
          this.missingFonts.add(lower);
        }
        continue;
      }
      this.missingFonts.delete(name.toLowerCase());
      const resolvedPath = path.normalize(match.font.path);
      if (seenPaths.has(resolvedPath)) continue;
      const data = this.readFontAsBase64(resolvedPath);
      if (!data) continue;
      seenPaths.add(resolvedPath);
      autoFonts.push({ name, data });
    }

    return autoFonts;
  }

  setupRoutes() {
    // Serve renderer static files (overlay.mjs, overlay.html resources, etc.)
    if (this.rendererDir) this.app.use(express.static(this.rendererDir));
    // 提供影片快取供 <video> 播放
    this.app.use('/video-cache', express.static(
      path.join(this.userDataPath, 'video-cache')
    ));
    this.app.get('/state', (_req, res) => res.json(this.state));
    this.app.get('/overlay', (_req, res) => {
      res.sendFile(path.join(this.rendererDir, 'overlay.html'));
    });
    this.app.get('/assets/suboct/:file', (req, res) => {
      res.sendFile(path.join(this.assetsDir, 'subtitles-octopus', req.params.file));
    });
    this.app.get('/assets/fonts/:file', (req, res) => {
      res.sendFile(path.join(this.assetsDir, 'fonts', req.params.file));
    });
  }

  setupWs() {
    this.wss.on('connection', ws => {
      ws.send(JSON.stringify({ type: 'state', payload: this.state }));
      ws.on('message', msg => {
        try {
          const { type, payload } = JSON.parse(msg);
          if (type === 'setTime') {
            // 保留：外部時間軸（之後接 YouTube）
            this.broadcast({ type: 'setTime', payload });
          }
        } catch { }
      });
    });
  }

  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const client of this.wss.clients) {
      if (client.readyState === WS_READY_STATE_OPEN) client.send(s);
    }
  }

  updateState(patch = {}) {
    const prevSubContent = this.state?.subContent;

    const sanitizedPatch = { ...patch };
    if (Array.isArray(sanitizedPatch.fontBuffers)) {
      this.manualFontBuffers = normalizeFontBufferList(sanitizedPatch.fontBuffers);
    }
    delete sanitizedPatch.fontBuffers;

    const mergedStyle = mergeStyles(this.state?.style, sanitizedPatch.style);
    const nextState = {
      ...this.state,
      ...sanitizedPatch,
      style: mergedStyle
    };

    let rawSub = this.rawSubContent;
    if (typeof sanitizedPatch.subContent === 'string') {
      rawSub = sanitizedPatch.subContent;
    } else if (typeof sanitizedPatch.rawSubContent === 'string') {
      rawSub = sanitizedPatch.rawSubContent;
    } else if (typeof nextState.rawSubContent === 'string') {
      rawSub = nextState.rawSubContent;
    }

    let processed = '';
    let playRes = clonePlayRes();
    let assMeta = EMPTY_ASS_META;
    let fontNames = [];

    if (rawSub) {
      const result = processAssForOverlay({
        assText: rawSub,
        alignKey: mergedStyle?.align,
        defaultFontFamily: mergedStyle?.defaultFontFamily || DEFAULT_FONT_FAMILY,
        forceDefaultFont: mergedStyle?.forceDefaultFont
      });
      processed = result.text ?? '';
      playRes = result.playRes ? clonePlayRes(result.playRes) : clonePlayRes();
      fontNames = Array.isArray(result.fontNames) ? result.fontNames : [];
      assMeta = {
        alignmentApplied: Boolean(result.alignmentApplied),
        styleUpdated: Boolean(result.styleUpdated),
        overridesRemoved: Number.isFinite(result.overridesRemoved) ? result.overridesRemoved : 0,
        fontNames,
        defaultFontReplaced: Boolean(result.defaultFontReplaced)
      };
    } else {
      this.lastFontKey = '';
      this.autoFontBuffers = [];
    }

    if (fontNames.length && this.fontLookupEnabled) {
      const autoFonts = this.loadSystemFonts(fontNames);
      this.autoFontBuffers = autoFonts;
    } else {
      this.autoFontBuffers = [];
    }

    nextState.rawSubContent = rawSub;
    nextState.subContent = processed;
    nextState.playRes = playRes;
    nextState.assMeta = assMeta;
    nextState.fontBuffers = this.combineFontPayloads(this.autoFontBuffers);

    this.rawSubContent = rawSub;
    this.state = nextState;

    if (typeof processed === 'string' && processed !== prevSubContent) {
      console.log('[overlayServer] subContent len =', processed.length);
    }

    this.broadcast({ type: 'state', payload: this.state });
  }


  listen(port) {
    return new Promise((resolve, reject) => {
      const normalizedPort = typeof port === 'number' ? port : Number.parseInt(port, 10);
      if (!Number.isInteger(normalizedPort) || normalizedPort < 0 || normalizedPort > 65535) {
        reject(new Error('Invalid port value: ' + port));
        return;
      }
      const handleServerError = (err) => {
        this.server.removeListener('error', handleServerError);
        reject(err);
      };
      this.server.once('error', handleServerError);
      this.server.listen(normalizedPort, () => {
        this.server.removeListener('error', handleServerError);
        resolve();
      });
    });
  }
  close() {
    // Ensure WebSocketServer is closed and return a promise that resolves
    // once the underlying HTTP server is closed.
    return new Promise((resolve) => {
      try {
        if (this.wss) {
          try { this.wss.close(); } catch (err) { /* swallow */ }
        }
      } catch (err) { /* noop */ }
      try {
        if (this.server && this.server.close) {
          this.server.close(() => resolve());
          // In case of error during close, resolve anyway after a short timeout
          this.server.on('error', () => setTimeout(resolve, 10));
        } else {
          resolve();
        }
      } catch (err) {
        // If close throws, resolve to avoid blocking shutdown
        resolve();
      }
    });
  }
}

