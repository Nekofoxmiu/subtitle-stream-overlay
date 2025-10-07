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
const EMPTY_ASS_META = Object.freeze({ alignmentApplied: false, styleUpdated: false, overridesRemoved: 0 });

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
  return { ...base, ...patch };
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
  if (!Array.isArray(list)) return [];
  return list.map(normalizeFontBuffer).filter(Boolean);
}

function coerceNonNegativeNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : 0;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    const num = Number(trimmed);
    return Number.isFinite(num) && num >= 0 ? num : 0;
  }
  return 0;
}

function looksLikeNowPlayingPayload(raw) {
  if (!raw || typeof raw !== 'object') return false;
  if (typeof raw.guid === 'string' && raw.guid.trim()) return true;
  if (typeof raw.progress === 'number' || typeof raw.progressMs === 'number') return true;
  if (typeof raw.duration === 'number' || typeof raw.durationMs === 'number') return true;
  if (typeof raw.status === 'string' && raw.status.trim()) return true;
  if (typeof raw.title === 'string' && raw.title.trim()) return true;
  return false;
}

function normalizeNowPlayingPayload(raw) {
  if (!looksLikeNowPlayingPayload(raw)) return null;
  const progressMs = coerceNonNegativeNumber(raw?.progress ?? raw?.progressMs);
  const durationMs = coerceNonNegativeNumber(raw?.duration ?? raw?.durationMs);
  const clampProgress = durationMs > 0 ? Math.min(progressMs, durationMs) : progressMs;
  const normalizeStr = (value) => (typeof value === 'string' ? value.trim() : '');
  const status = normalizeRemoteStatus(raw?.status);
  const artists = Array.isArray(raw?.artists)
    ? raw.artists.map((name) => normalizeStr(name)).filter(Boolean)
    : [];
  const normalizedSongLink = normalizeRemoteUrl(raw?.song_link ?? raw?.songLink);
  return {
    guid: normalizeStr(raw?.guid),
    cover: normalizeStr(raw?.cover),
    title: normalizeStr(raw?.title),
    artists,
    status,
    progressMs: clampProgress,
    progressSeconds: clampProgress / 1000,
    durationMs,
    durationSeconds: durationMs / 1000,
    songLink: normalizedSongLink,
    platform: normalizeStr(raw?.platform),
    isLive: raw?.is_live === true,
    receivedAt: Date.now()
  };
}

function sanitizeRemoteIdentity(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sanitizeRemoteName(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeRemoteStatus(value) {
  const normalized = sanitizeRemoteName(value);
  if (!normalized) return 'unknown';
  if (normalized === 'playing' || normalized === 'play' || normalized === 'streaming') return 'playing';
  if (normalized === 'paused' || normalized === 'pause' || normalized === 'pausing' || normalized === 'stopped' || normalized === 'stop' || normalized === 'stopping') {
    return 'paused';
  }
  if (normalized === 'waiting' || normalized === 'buffering' || normalized === 'loading' || normalized === 'idle' || normalized === 'pending' || normalized === 'queued' || normalized === 'queue' || normalized === 'ready' || normalized === 'connecting') {
    return 'unknown';
  }
  if (normalized === 'finished' || normalized === 'ending' || normalized === 'ended' || normalized === 'complete' || normalized === 'completed') {
    return 'paused';
  }
  return normalized;
}

function normalizeRemoteUrl(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    url.hash = '';
    return url.toString();
  } catch {
    return trimmed;
  }
}

function buildGuidSessionKey(guid, songLink) {
  const normalizedGuid = sanitizeRemoteIdentity(guid);
  if (!normalizedGuid) return '';
  const normalizedSong = normalizeRemoteUrl(songLink);
  return normalizedSong ? `guid:${normalizedGuid}|song:${normalizedSong}` : `guid:${normalizedGuid}`;
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

    const initialStyle = store.get('output');
    this.state = {
      subContent: '',
      rawSubContent: '',
      fontBuffers: this.combineFontPayloads(this.autoFontBuffers, initialStyle),
      style: initialStyle,
      playRes: clonePlayRes(),
      assMeta: EMPTY_ASS_META
    };
    this.remoteSessions = new Map();
    this.activeSessionKey = '';
    this.selectedSessionKey = '';
    this.nowPlaying = null;

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

  combineFontPayloads(autoFonts = [], style = this.state?.style) {
    const manualFonts = Array.isArray(this.manualFontBuffers) ? this.manualFontBuffers : [];
    const shouldIncludeManual = Boolean(style?.forceDefaultFont);
    return shouldIncludeManual ? [...autoFonts, ...manualFonts] : [...autoFonts];
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
      if (this.nowPlaying) {
        try { ws.send(JSON.stringify({ type: 'nowPlaying', payload: this.nowPlaying })); } catch { /* noop */ }
      }
      this.sendRemoteSessions(ws);
      ws.on('message', msg => {
        let data = msg;
        if (Buffer.isBuffer(data)) {
          data = data.toString('utf8');
        } else if (ArrayBuffer.isView(data)) {
          const view = data;
          const buf = Buffer.from(view.buffer, view.byteOffset || 0, view.byteLength || view.buffer.byteLength);
          data = buf.toString('utf8');
        } else if (data instanceof ArrayBuffer) {
          data = Buffer.from(data).toString('utf8');
        }
        if (typeof data !== 'string') return;
        const trimmed = data.trim();
        if (!trimmed) return;
        const firstChar = trimmed[0];
        if (firstChar !== '{' && firstChar !== '[') {
          if (trimmed.startsWith('connected')) {
            this.handleRemoteClientHandshake(trimmed, { closed: false });
          } else if (trimmed.startsWith('closed')) {
            this.handleRemoteClientHandshake(trimmed, { closed: true });
          }
          return;
        }
        let parsed;
        try { parsed = JSON.parse(trimmed); } catch { return; }
        if (!parsed || typeof parsed !== 'object') return;
        const { type, payload } = parsed;
        if (type === 'setTime') {
          this.broadcast({ type: 'setTime', payload });
        } else if (type === 'setActiveSession') {
          this.setActiveSessionKey(payload?.key);
        } else if (type === 'nowPlaying' && payload) {
          this.updateNowPlaying(payload);
        } else if (looksLikeNowPlayingPayload(parsed)) {
          this.updateNowPlaying(parsed);
        }
      });
    });
  }
  findSessionKeyByGuid(guid, { excludeKey = '' } = {}) {
    const normalizedGuid = sanitizeRemoteIdentity(guid);
    if (!normalizedGuid) return '';
    for (const [key, session] of this.remoteSessions) {
      if (excludeKey && key === excludeKey) continue;
      if (sanitizeRemoteIdentity(session?.guid) === normalizedGuid) {
        return key;
      }
    }
    return '';
  }
  handleRemoteClientHandshake(message, { closed = false } = {}) {
    const match = /^(?:connected|closed)\s*-\s*(.+?)\s*\(([^)]+)\)(?:\s*\|\s*(.+))?\s*$/i.exec(message);
    if (!match) return;
    const host = (match[1] || '').trim();
    const guid = (match[2] || '').trim();
    if (!guid) return;
    const key = buildGuidSessionKey(guid);
    const now = Date.now();
    if (closed) {
      let sessionKey = key;
      let session = this.remoteSessions.get(sessionKey);
      if (!session) {
        const fallbackKey = this.findSessionKeyByGuid(guid, { excludeKey: sessionKey });
        if (fallbackKey) {
          sessionKey = fallbackKey;
          session = this.remoteSessions.get(fallbackKey);
        }
      }
      if (!session) return;
      const wasActive = this.activeSessionKey === sessionKey;
      const wasSelected = this.selectedSessionKey === sessionKey;
      this.remoteSessions.delete(sessionKey);
      if (wasActive) {
        this.activeSessionKey = '';
        this.nowPlaying = null;
      }
      if (wasSelected) {
        this.selectedSessionKey = '';
      }
      if (wasActive || wasSelected) {
        this.setActiveSessionKey(this.selectedSessionKey);
      } else {
        this.emitRemoteSessions();
      }
      return;
    }
    const existingKey = this.findSessionKeyByGuid(guid, { excludeKey: key });
    let session = this.remoteSessions.get(key) || null;
    if (!session && existingKey) {
      session = this.remoteSessions.get(existingKey) || null;
      if (session) {
        this.remoteSessions.delete(existingKey);
        if (this.activeSessionKey === existingKey) this.activeSessionKey = key;
        if (this.selectedSessionKey === existingKey) this.selectedSessionKey = key;
      }
    }
    if (!session) session = { lastPlayTs: 0, status: 'unknown' };
    session.host = host;
    session.guid = guid;
    session.connected = true;
    session.lastSeen = now;
    if (!session.lastUpdate) session.lastUpdate = now;
    this.remoteSessions.set(key, session);
    if (!this.selectedSessionKey) {
      this.selectedSessionKey = key;
    }
    this.emitRemoteSessions();
  }
  deriveSessionKey(payload) {
    if (!payload || typeof payload !== 'object') return 'unknown';
    const guidKey = buildGuidSessionKey(payload.guid, payload.songLink);
    if (guidKey) return guidKey;
    const songLink = normalizeRemoteUrl(payload.songLink);
    if (songLink) return `song:${songLink}`;
    const platform = typeof payload.platform === 'string' ? payload.platform.trim().toLowerCase() : '';
    const title = typeof payload.title === 'string' ? payload.title.trim().toLowerCase() : '';
    if (platform || title) return `meta:${platform}:${title}`;
    return 'unknown';
  }

  selectActiveSession({ preferSelected = true } = {}) {
    let selectedSession = null;
    if (this.selectedSessionKey) {
      selectedSession = this.remoteSessions.get(this.selectedSessionKey) || null;
      const status = normalizeRemoteStatus(selectedSession?.status);
      if (!selectedSession || status === 'unknown') {
        this.selectedSessionKey = '';
        selectedSession = null;
      }
    }
    if (preferSelected && this.selectedSessionKey && selectedSession) {
      return this.selectedSessionKey;
    }

    let activeSession = null;
    if (this.activeSessionKey) {
      activeSession = this.remoteSessions.get(this.activeSessionKey) || null;
      const status = normalizeRemoteStatus(activeSession?.status);
      if (!activeSession || status === 'unknown') {
        this.activeSessionKey = '';
        activeSession = null;
      }
    }

    let bestKey = '';
    let bestTs = -1;
    for (const [key, session] of this.remoteSessions) {
      const status = normalizeRemoteStatus(session?.status);
      if (status === 'unknown') continue;
      if (status === 'playing') {
        const ts = session.lastPlayTs ?? session.lastUpdate ?? 0;
        if (ts >= bestTs) {
          bestTs = ts;
          bestKey = key;
        }
      }
    }
    if (bestKey) return bestKey;
    if (this.activeSessionKey && activeSession) return this.activeSessionKey;

    let fallbackKey = '';
    let fallbackTs = -1;
    for (const [key, session] of this.remoteSessions) {
      const status = normalizeRemoteStatus(session?.status);
      if (status === 'unknown') continue;
      const ts = session.lastUpdate ?? 0;
      if (ts >= fallbackTs) {
        fallbackTs = ts;
        fallbackKey = key;
      }
    }
    return fallbackKey;
  }

  updateNowPlaying(raw) {
    const normalized = normalizeNowPlayingPayload(raw);
    if (!normalized) return;

    const previousSelected = this.selectedSessionKey;
    const previousActive = this.activeSessionKey;

    const sessionKey = this.deriveSessionKey(normalized);
    const now = Date.now();
    let existingKey = sessionKey;
    let existing = this.remoteSessions.get(sessionKey);
    if (!existing && normalized.guid) {
      const fallbackKey = this.findSessionKeyByGuid(normalized.guid, { excludeKey: sessionKey });
      if (fallbackKey) {
        existingKey = fallbackKey;
        existing = this.remoteSessions.get(fallbackKey);
      }
    }
    if (existing && existingKey && existingKey !== sessionKey) {
      this.remoteSessions.delete(existingKey);
      if (this.activeSessionKey === existingKey) this.activeSessionKey = sessionKey;
      if (this.selectedSessionKey === existingKey) this.selectedSessionKey = sessionKey;
    }
    const previousStatus = normalizeRemoteStatus(existing?.status);
    const status = normalized.status || 'unknown';

    const session = { ...(existing || {}) };
    session.nowPlaying = normalized;
    session.lastUpdate = now;
    session.status = status;
    session.connected = true;
    if (typeof session.lastPlayTs !== 'number' || !Number.isFinite(session.lastPlayTs)) {
      session.lastPlayTs = 0;
    }
    if (normalized.guid) session.guid = normalized.guid;
    if (!session.host && normalized.platform) session.host = normalized.platform;
    if (status === 'playing' && previousStatus !== 'playing') {
      session.lastPlayTs = now;
    }

    this.remoteSessions.set(sessionKey, session);

    if (this.selectedSessionKey && !this.remoteSessions.has(this.selectedSessionKey)) {
      this.selectedSessionKey = '';
    }
    if (status === 'unknown' && this.selectedSessionKey === sessionKey) {
      this.selectedSessionKey = '';
    }
    if (!this.selectedSessionKey && status !== 'unknown') {
      this.selectedSessionKey = sessionKey;
    }

    const nextActive = this.selectActiveSession();
    this.activeSessionKey = nextActive;
    const activeSession = nextActive ? this.remoteSessions.get(nextActive) : null;
    const activePayload = activeSession?.nowPlaying || null;

    if (activePayload) {
      const changed = previousActive !== nextActive || nextActive === sessionKey || this.nowPlaying !== activePayload;
      if (changed) {
        this.nowPlaying = activePayload;
        this.broadcast({ type: 'nowPlaying', payload: activePayload });
        const useRemoteTimeline = store.get('player.useRemoteTimeline') === true;
        if (useRemoteTimeline) {
          const t = Number.isFinite(activePayload.progressSeconds)
            ? activePayload.progressSeconds
            : (Number.isFinite(activePayload.progressMs) ? activePayload.progressMs / 1000 : null);
          if (t != null) {
            this.broadcast({ type: 'setTime', payload: { t } });
          }
        }
      }
    } else {
      this.nowPlaying = null;
    }

    const statusChanged = previousStatus !== status;
    const listShouldUpdate = statusChanged
      || previousActive !== this.activeSessionKey
      || previousSelected !== this.selectedSessionKey;
    if (listShouldUpdate) {
      this.emitRemoteSessions();
    }
  }

  buildRemoteSessionsPayload() {
    const sessions = [];
    for (const [key, session] of this.remoteSessions) {
      const status = normalizeRemoteStatus(session?.status);
      if (status === 'unknown') continue;
      const info = session?.nowPlaying || null;
      const infoStatus = normalizeRemoteStatus(info?.status);
      sessions.push({
        key,
        host: session?.host || '',
        status,
        lastUpdate: session?.lastUpdate || 0,
        lastPlayTs: session?.lastPlayTs || 0,
        connected: session?.connected !== false,
        guid: session?.guid || info?.guid || '',
        nowPlaying: info ? {
          title: info.title || '',
          artists: Array.isArray(info.artists) ? info.artists : [],
          status: infoStatus,
          progressMs: info.progressMs ?? null,
          durationMs: info.durationMs ?? null,
          songLink: info.songLink || '',
          platform: info.platform || '',
          isLive: info.isLive === true
        } : null
      });
    }
    sessions.sort((a, b) => {
      const playA = Number(a?.lastPlayTs) || 0;
      const playB = Number(b?.lastPlayTs) || 0;
      if (playA !== playB) return playB - playA;
      const updateA = Number(a?.lastUpdate) || 0;
      const updateB = Number(b?.lastUpdate) || 0;
      if (updateA !== updateB) return updateB - updateA;
      const statusA = normalizeRemoteStatus(a?.status);
      const statusB = normalizeRemoteStatus(b?.status);
      if (statusA !== statusB) {
        const rank = { playing: 2, paused: 1 };
        const scoreA = rank[statusA] || 0;
        const scoreB = rank[statusB] || 0;
        if (scoreA !== scoreB) return scoreB - scoreA;
      }
      return a.key.localeCompare(b.key);
    });
    const hasActive = this.activeSessionKey && sessions.some((session) => session.key === this.activeSessionKey);
    const hasSelected = this.selectedSessionKey && sessions.some((session) => session.key === this.selectedSessionKey);
    const activeKey = hasActive ? this.activeSessionKey : '';
    const selectedKey = hasSelected ? this.selectedSessionKey : '';
    return {
      type: 'remoteSessions',
      payload: {
        activeKey,
        selectedKey,
        sessions
      }
    };
  }

  emitRemoteSessions() {
    if (!this.wss?.clients?.size) return;
    const message = this.buildRemoteSessionsPayload();
    this.broadcast(message);
  }
  sendRemoteSessions(ws) {
    if (!ws || ws.readyState !== WS_READY_STATE_OPEN) return;
    const message = this.buildRemoteSessionsPayload();
    try { ws.send(JSON.stringify(message)); } catch { /* noop */ }
  }
  setActiveSessionKey(key) {
    const normalized = typeof key === 'string' ? key.trim() : '';
    const session = normalized ? this.remoteSessions.get(normalized) : null;
    const status = normalizeRemoteStatus(session?.status);
    const exists = Boolean(normalized && session && status !== 'unknown');
    const previousSelected = this.selectedSessionKey;
    this.selectedSessionKey = exists ? normalized : '';
    const previousActive = this.activeSessionKey;
    if (exists) {
      this.activeSessionKey = normalized;
    } else {
      this.activeSessionKey = this.selectActiveSession({ preferSelected: false });
    }
    const activeSession = this.activeSessionKey ? this.remoteSessions.get(this.activeSessionKey) : null;
    const activePayload = activeSession?.nowPlaying || null;
    if (activePayload) {
      const changed = previousActive !== this.activeSessionKey || this.nowPlaying !== activePayload;
      this.nowPlaying = activePayload;
      if (changed) {
        this.broadcast({ type: 'nowPlaying', payload: activePayload });
        const useRemoteTimeline = store.get('player.useRemoteTimeline') === true;
        if (useRemoteTimeline) {
          const t = Number.isFinite(activePayload.progressSeconds)
            ? activePayload.progressSeconds
            : (Number.isFinite(activePayload.progressMs) ? activePayload.progressMs / 1000 : null);
          if (t != null) {
            this.broadcast({ type: 'setTime', payload: { t } });
          }
        }
      }
    } else if (this.activeSessionKey && !activePayload) {
      this.nowPlaying = null;
    }
    if (previousSelected !== this.selectedSessionKey || previousActive !== this.activeSessionKey) {
      this.emitRemoteSessions();
    }
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
      const forceDefaultFont = Boolean(mergedStyle?.forceDefaultFont);
      const defaultFontFamily = forceDefaultFont ? (mergedStyle?.defaultFontFamily || '') : '';
      const result = processAssForOverlay({
        assText: rawSub,
        alignKey: mergedStyle?.align,
        forceDefaultFont,
        defaultFontFamily
      });
      processed = result.text ?? '';
      playRes = result.playRes ? clonePlayRes(result.playRes) : clonePlayRes();
      fontNames = Array.isArray(result.fontNames) ? result.fontNames : [];
      assMeta = {
        alignmentApplied: Boolean(result.alignmentApplied),
        styleUpdated: Boolean(result.styleUpdated),
        overridesRemoved: Number.isFinite(result.overridesRemoved) ? result.overridesRemoved : 0,
        fontNames
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
    nextState.fontBuffers = this.combineFontPayloads(this.autoFontBuffers, mergedStyle);

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

