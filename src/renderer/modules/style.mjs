import { dom } from './dom.mjs';
import state from './state.mjs';
import { sanitizeRemoteIdentity, normalizeRemoteUrl } from './remote-utils.mjs';

export const ALIGN_OPTIONS = new Set([
  'top-left',
  'top-center',
  'top-right',
  'middle-left',
  'middle-center',
  'middle-right',
  'bottom-left',
  'bottom-center',
  'bottom-right'
]);

export const LEGACY_ALIGN_MAP = {
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

export const BUILTIN_DEFAULT_FONT_FAMILY = 'NotoSans-Regular';
export const FONT_MANAGEMENT_DISABLED_HINT = '請切換為 Default 模式才能管理字型';

export function normalizeAlignValue(raw) {
  if (raw == null) return 'off';
  const value = String(raw).trim().toLowerCase();
  if (!value || value === 'off' || value === 'none' || value === 'disabled') return 'off';
  const mapped = LEGACY_ALIGN_MAP[value] || value;
  if (mapped === 'off') return 'off';
  return ALIGN_OPTIONS.has(mapped) ? mapped : 'off';
}

export function normalizeDimension(raw, fallback) {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function clampVolume(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 1;
  if (num < 0) return 0;
  if (num > 1) return 1;
  return num;
}

export function debounce(fn, ms = 120) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function persistPlayerConfig({ volume = state.playerVolume, useRemoteTimeline = state.useRemoteTimeline } = {}) {
  if (!window?.api?.setConfig) return;
  const payload = {
    volume: clampVolume(volume),
    useRemoteTimeline: Boolean(useRemoteTimeline)
  };
  try {
    Promise.resolve(window.api.setConfig({ player: payload })).catch((err) => {
      console.error('[config] failed to save player config', err);
    });
  } catch (err) {
    console.error('[config] failed to save player config', err);
  }
}

export const persistVolumeSetting = debounce((volume) => {
  const normalized = clampVolume(volume);
  state.playerVolume = normalized;
  persistPlayerConfig({ volume: normalized });
}, 240);

export function normalizeFontBuffer(font) {
  if (!font || typeof font !== 'object') return null;
  const normalized = {};
  if (typeof font.name === 'string' && font.name) normalized.name = font.name;
  if (typeof font.data === 'string' && font.data) normalized.data = font.data;
  if (typeof font.url === 'string' && font.url) normalized.url = font.url;
  return normalized.data || normalized.url ? normalized : null;
}

export function describeFontName(font) {
  if (!font || typeof font !== 'object') return '';
  if (typeof font.name === 'string' && font.name) return font.name;
  if (typeof font.url === 'string' && font.url) {
    const parts = font.url.split(/[\\/]/);
    return parts[parts.length - 1] || font.url;
  }
  return '';
}

export function sanitizeFontFamilyName(rawName) {
  if (typeof rawName !== 'string') return '';
  const trimmed = rawName.trim();
  if (!trimmed) return '';
  const withoutExt = trimmed.replace(/\.[^.]+$/, '');
  return withoutExt.trim();
}

export function deriveDefaultFontFamily({ fonts = state.currentFonts, forceDefault = state.forceDefaultFont } = {}) {
  if (!forceDefault) return '';
  if (Array.isArray(fonts)) {
    for (const font of fonts) {
      const label = describeFontName(font) || font?.name || '';
      const sanitized = sanitizeFontFamilyName(label);
      if (sanitized) return sanitized;
    }
  }
  return BUILTIN_DEFAULT_FONT_FAMILY;
}

export function updateFontControlsAvailability() {
  const canManageFonts = state.forceDefaultFont !== false;
  const hasFonts = Array.isArray(state.currentFonts) && state.currentFonts.length > 0;

  if (dom.pickFonts) {
    dom.pickFonts.disabled = !canManageFonts;
    dom.pickFonts.setAttribute('aria-disabled', canManageFonts ? 'false' : 'true');
    if (!canManageFonts) {
      dom.pickFonts.title = FONT_MANAGEMENT_DISABLED_HINT;
    } else {
      dom.pickFonts.removeAttribute('title');
    }
  }

  if (dom.clearFonts) {
    const disabled = !canManageFonts || !hasFonts;
    dom.clearFonts.disabled = disabled;
    dom.clearFonts.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    if (!canManageFonts) {
      dom.clearFonts.title = FONT_MANAGEMENT_DISABLED_HINT;
    } else if (!hasFonts) {
      dom.clearFonts.title = '尚未匯入字型';
    } else {
      dom.clearFonts.removeAttribute('title');
    }
  }
}

export function updateFontsLabel(fonts = state.currentFonts) {
  if (!dom.fontsPicked) {
    updateFontControlsAvailability();
    return;
  }
  const list = Array.isArray(fonts) ? fonts : [];
  const names = [];
  for (const font of list) {
    const label = describeFontName(font);
    if (label) names.push(label);
  }
  if (names.length) {
    dom.fontsPicked.textContent = names.join(', ');
  } else if (state.forceDefaultFont) {
    dom.fontsPicked.textContent = `使用內建 ${BUILTIN_DEFAULT_FONT_FAMILY}`;
  } else {
    dom.fontsPicked.textContent = '尚未匯入字型';
  }
  updateFontControlsAvailability();
}

export function getFontPayloadForOverlay({ includeWhenDisabled = false } = {}) {
  if (!includeWhenDisabled && state.forceDefaultFont === false) return null;
  return Array.isArray(state.currentFonts) ? state.currentFonts : [];
}

export function notifyOverlayWithCurrentFonts(patch = {}, options = {}) {
  const fontPayload = getFontPayloadForOverlay(options);
  const message = { ...patch };
  if (fontPayload != null) {
    message.fontBuffers = fontPayload;
  }
  window.api.notifyOverlay(message);
}

export const OFFSET_EPSILON = 1e-6;
export const SUBTITLE_OFFSET_LABELS = {
  advance: '字幕提前',
  delay: '字幕延遲'
};

export function normalizeSubtitleOffsetMode(value) {
  return value === 'delay' ? 'delay' : 'advance';
}

export function sanitizeSubtitleOffsetSeconds(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return 0;
    return value;
  }
  const str = String(value ?? '').trim();
  if (!str) return 0;
  const normalized = str.replace(',', '.');
  const num = Number.parseFloat(normalized);
  if (!Number.isFinite(num) || num < 0) return 0;
  return num;
}

export function updateSubtitleOffsetUI() {
  const btn = dom.subtitleOffsetToggle;
  if (!btn) return;
  const labels = {
    advance: btn.dataset?.labelAdvance || SUBTITLE_OFFSET_LABELS.advance,
    delay: btn.dataset?.labelDelay || SUBTITLE_OFFSET_LABELS.delay
  };
  const mode = normalizeSubtitleOffsetMode(state.subtitleOffsetMode);
  state.subtitleOffsetMode = mode;
  const label = mode === 'delay' ? labels.delay : labels.advance;
  btn.textContent = label;
  btn.setAttribute('aria-pressed', mode === 'delay' ? 'true' : 'false');
  btn.setAttribute('aria-label', label);
}

export function setSubtitleOffsetState({ mode, seconds } = {}) {
  state.subtitleOffsetMode = normalizeSubtitleOffsetMode(mode);
  state.subtitleOffsetSeconds = sanitizeSubtitleOffsetSeconds(seconds);
  if (dom.subtitleOffsetSeconds) {
    dom.subtitleOffsetSeconds.value = String(state.subtitleOffsetSeconds);
  }
  updateSubtitleOffsetUI();
}

export function setSubtitleOffsetControlsEnabled(enabled) {
  const disabled = !enabled;
  if (dom.subtitleOffsetToggle) {
    dom.subtitleOffsetToggle.disabled = disabled;
    dom.subtitleOffsetToggle.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  }
  if (dom.subtitleOffsetSeconds) {
    dom.subtitleOffsetSeconds.disabled = disabled;
    dom.subtitleOffsetSeconds.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  }
}

export function offsetsEqual(a, b) {
  if (!a || !b) return false;
  const modeA = normalizeSubtitleOffsetMode(a.mode);
  const modeB = normalizeSubtitleOffsetMode(b.mode);
  const secondsA = sanitizeSubtitleOffsetSeconds(a.seconds);
  const secondsB = sanitizeSubtitleOffsetSeconds(b.seconds);
  return modeA === modeB && Math.abs(secondsA - secondsB) <= OFFSET_EPSILON;
}

export function getRemoteMediaKey(remote = state.remoteNowPlaying) {
  if (!state.useRemoteTimeline) return '';
  if (!remote || typeof remote !== 'object') return '';
  const guid = sanitizeRemoteIdentity(remote.guid);
  const link = normalizeRemoteUrl(remote.songLink);
  if (guid && link) return `remote:guid:${guid}|song:${link}`;
  if (link) return `remote:song:${link}`;
  if (guid) return `remote:guid:${guid}`;
  const platform = typeof remote.platform === 'string' ? remote.platform.trim().toLowerCase() : '';
  const title = typeof remote.title === 'string' ? remote.title.trim() : '';
  let secondary = title;
  if (!secondary && Array.isArray(remote.artists)) {
    secondary = remote.artists.map((name) => (typeof name === 'string' ? name.trim() : '')).filter(Boolean).join(', ');
  }
  const base = [platform, secondary].filter(Boolean).join(':');
  return base ? `remote:title:${base}` : '';
}

export function resolveMediaKey(videoId = state.activeVideoId) {
  if (videoId) return videoId;
  if (!state.useRemoteTimeline) return '';
  if (state.remoteMediaKey) return state.remoteMediaKey;
  const remoteKey = getRemoteMediaKey();
  if (remoteKey) {
    state.remoteMediaKey = remoteKey;
    return remoteKey;
  }
  return '';
}

export function buildSubtitleOffsetKey(mediaKey, subsId) {
  return [mediaKey || '', subsId || ''].join('::');
}

export function makeSubtitleOffsetKey(videoId = state.activeVideoId, subsId = state.activeSubsId) {
  const mediaKey = resolveMediaKey(videoId);
  return buildSubtitleOffsetKey(mediaKey, subsId);
}

export function normalizeSubtitleOffsetOverrides(raw, defaults = state.subtitleOffsetDefaults) {
  const normalizedDefaults = {
    mode: normalizeSubtitleOffsetMode(defaults?.mode),
    seconds: sanitizeSubtitleOffsetSeconds(defaults?.seconds)
  };
  const result = {};
  if (!raw || typeof raw !== 'object') return result;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== 'string' || !key || key === '::') continue;
    const normalized = {
      mode: normalizeSubtitleOffsetMode(value?.mode),
      seconds: sanitizeSubtitleOffsetSeconds(value?.seconds)
    };
    if (offsetsEqual(normalized, normalizedDefaults)) continue;
    result[key] = normalized;
  }
  return result;
}

export function resolveSubtitleOffset({ videoId = state.activeVideoId, subsId = state.activeSubsId } = {}) {
  const defaults = {
    mode: normalizeSubtitleOffsetMode(state.subtitleOffsetDefaults?.mode),
    seconds: sanitizeSubtitleOffsetSeconds(state.subtitleOffsetDefaults?.seconds)
  };
  const overrides = state.subtitleOffsetOverrides || {};
  const mediaKey = resolveMediaKey(videoId);
  const candidates = [];
  const fullKey = buildSubtitleOffsetKey(mediaKey, subsId);
  if (fullKey && fullKey !== '::') candidates.push(fullKey);
  if (mediaKey) candidates.push(buildSubtitleOffsetKey(mediaKey, ''));
  if (subsId) candidates.push(buildSubtitleOffsetKey('', subsId));
  const seen = new Set();
  for (const key of candidates) {
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const override = overrides[key];
    if (override) {
      return {
        mode: normalizeSubtitleOffsetMode(override.mode),
        seconds: sanitizeSubtitleOffsetSeconds(override.seconds)
      };
    }
  }
  return defaults;
}

export function applySubtitleOffsetForSelection({ videoId = state.activeVideoId, subsId = state.activeSubsId, notify = true } = {}) {
  const mediaKey = resolveMediaKey(videoId);
  const hasCompleteSelection = Boolean(mediaKey) && Boolean(subsId);
  setSubtitleOffsetControlsEnabled(hasCompleteSelection);
  const prevMode = state.subtitleOffsetMode;
  const prevSeconds = state.subtitleOffsetSeconds;
  const resolved = resolveSubtitleOffset({ videoId: mediaKey, subsId });
  setSubtitleOffsetState(resolved);
  const modeChanged = resolved.mode !== prevMode;
  const secondsChanged = Math.abs(resolved.seconds - prevSeconds) > OFFSET_EPSILON;
  if (notify && (modeChanged || secondsChanged)) {
    const style = collectStyle();
    window.api.notifyOverlay({ style });
  }
}

export async function syncSubtitleOffset({ mode = null, seconds = null, refresh = false } = {}) {
  const nextMode = normalizeSubtitleOffsetMode(mode ?? state.subtitleOffsetMode);
  const rawSeconds = seconds ?? (dom.subtitleOffsetSeconds ? dom.subtitleOffsetSeconds.value : state.subtitleOffsetSeconds);
  const nextSeconds = sanitizeSubtitleOffsetSeconds(rawSeconds);
  const prevMode = state.subtitleOffsetMode;
  const prevSeconds = state.subtitleOffsetSeconds;
  const modeChanged = nextMode !== prevMode;
  const secondsChanged = Math.abs(nextSeconds - prevSeconds) > OFFSET_EPSILON;

  state.subtitleOffsetMode = nextMode;
  state.subtitleOffsetSeconds = nextSeconds;

  if (dom.subtitleOffsetSeconds) {
    dom.subtitleOffsetSeconds.value = String(nextSeconds);
  }
  updateSubtitleOffsetUI();

  const shouldPersist = modeChanged || secondsChanged;
  const shouldRefresh = refresh || modeChanged || secondsChanged;

  if (shouldPersist) {
    const key = makeSubtitleOffsetKey();
    if (!state.subtitleOffsetOverrides || typeof state.subtitleOffsetOverrides !== 'object') {
      state.subtitleOffsetOverrides = {};
    }
    if (!state.subtitleOffsetDefaults || typeof state.subtitleOffsetDefaults !== 'object') {
      state.subtitleOffsetDefaults = { mode: nextMode, seconds: nextSeconds };
    }
    if (key === '::') {
      state.subtitleOffsetDefaults = { mode: nextMode, seconds: nextSeconds };
    } else {
      const override = { mode: nextMode, seconds: nextSeconds };
      if (offsetsEqual(override, state.subtitleOffsetDefaults)) {
        delete state.subtitleOffsetOverrides[key];
      } else {
        state.subtitleOffsetOverrides[key] = override;
      }
    }
  }

  if (!shouldPersist && !shouldRefresh) return;

  const style = collectStyle();
  if (shouldPersist) await persistStyle(style);
  const patch = { style };
  if (shouldRefresh) {
    state.overlayRefreshSeq += 1;
    patch.refreshToken = `offset-${Date.now()}-${state.overlayRefreshSeq}`;
  }
  window.api.notifyOverlay(patch);
}

export function collectStyle() {
  const mode = normalizeSubtitleOffsetMode(state.subtitleOffsetMode);
  const seconds = sanitizeSubtitleOffsetSeconds(state.subtitleOffsetSeconds);
  state.subtitleOffsetMode = mode;
  state.subtitleOffsetSeconds = seconds;

  const defaults = {
    mode: normalizeSubtitleOffsetMode(state.subtitleOffsetDefaults?.mode),
    seconds: sanitizeSubtitleOffsetSeconds(state.subtitleOffsetDefaults?.seconds)
  };
  state.subtitleOffsetDefaults = defaults;

  const overrides = normalizeSubtitleOffsetOverrides(state.subtitleOffsetOverrides, defaults);
  state.subtitleOffsetOverrides = overrides;

  const forceDefaultFont = state.forceDefaultFont !== false;
  const defaultFontFamily = deriveDefaultFontFamily({ fonts: state.currentFonts, forceDefault: forceDefaultFont });
  state.forceDefaultFont = forceDefaultFont;
  state.defaultFontFamily = defaultFontFamily;

  return {
    port: getCurrentPort(),
    background: dom.background?.value || 'transparent',
    maxWidth: normalizeDimension(dom.maxWidth?.value, 1920),
    maxHeight: normalizeDimension(dom.maxHeight?.value, 1080),
    align: normalizeAlignValue(dom.align?.value),
    subtitleOffsetMode: mode,
    subtitleOffsetSeconds: seconds,
    subtitleOffsetDefaults: defaults,
    subtitleOffsetOverrides: overrides,
    forceDefaultFont,
    defaultFontFamily
  };
}

export async function persistStyle(style) {
  await window.api.setConfig({ output: style });
}

export async function persistFonts(fonts) {
  await window.api.setConfig({ fonts });
}

export function getCurrentPort() {
  const port = parseInt(dom.portInput?.value, 10);
  return Number.isFinite(port) ? port : 59837;
}
