/* ---------------- Overlay 時間同步 ---------------- */
import { dom } from './dom.mjs';
import state from './state.mjs';
import { showDownloadProgress, updateDownloadStatus } from './downloads.mjs';
import {
  applySubtitleOffsetForSelection,
  collectStyle,
  persistStyle,
  notifyOverlayWithCurrentFonts,
  persistPlayerConfig,
  getCurrentPort,
  getRemoteMediaKey
} from './style.mjs';
import { refreshCustomSelect } from './custom-select.mjs';
import { sanitizeRemoteIdentity, normalizeRemoteStatus, normalizeRemoteUrl } from './remote-utils.mjs';
import { appendLog } from './logger.mjs';

function initializeCacheControls() {
  const videoCacheControls = createCacheSelector(dom.videoFile?.closest('.row'), {
    label: undefined,
    searchPlaceholder: '搜尋影片或音訊...',
    hint: undefined
  });
  dom.videoCacheSelect = videoCacheControls?.select || null;
  dom.videoCacheSearch = videoCacheControls?.search || null;

  const subsCacheControls = createCacheSelector(dom.pickSubs?.closest('.row'), {
    label: undefined,
    searchPlaceholder: '搜尋字幕...',
    hint: undefined
  });
  dom.subsCacheSelect = subsCacheControls?.select || null;
  dom.subsCacheSearch = subsCacheControls?.search || null;
}

const OVERLAY_READY_TIMEOUT_MS = 8000;
const OVERLAY_READY_INTERVAL_MS = 200;
const OVERLAY_READY_RETRY_DELAY_MS = 400;
let portChangeToken = 0;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForOverlayServerReady(port, {
  timeoutMs = OVERLAY_READY_TIMEOUT_MS,
  intervalMs = OVERLAY_READY_INTERVAL_MS
} = {}) {
  const normalizedTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : OVERLAY_READY_TIMEOUT_MS;
  const normalizedInterval = Number.isFinite(intervalMs) && intervalMs > 0
    ? intervalMs
    : OVERLAY_READY_INTERVAL_MS;
  if (window?.api?.waitForOverlayReady) {
    try {
      return await window.api.waitForOverlayReady({
        port,
        timeoutMs: normalizedTimeout,
        intervalMs: normalizedInterval
      });
    } catch {
      // fall back to direct polling
    }
  }
  const normalizedPort = Number.parseInt(port, 10);
  if (!Number.isInteger(normalizedPort) || normalizedPort <= 0) return false;
  const url = `http://localhost:${normalizedPort}/state`;
  const deadline = Date.now() + normalizedTimeout;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { method: 'GET', cache: 'no-store', mode: 'no-cors' });
      return true;
    } catch {
      // retry until timeout
    }
    await wait(normalizedInterval);
  }
  return false;
}

async function waitForOverlayServerReadyUntil(port, changeToken) {
  while (changeToken === portChangeToken) {
    const ready = await waitForOverlayServerReady(port);
    if (changeToken !== portChangeToken) return false;
    if (ready) return true;
    await wait(OVERLAY_READY_RETRY_DELAY_MS);
  }
  return false;
}

class OverlaySync {
  constructor(videoEl) {
    this.ws = null;
    this.timer = null;
    this.port = 59837;
    this.video = videoEl;
    this.pendingTime = null;
    this.nowPlayingHandler = null;
    this.remoteSessionsHandler = null;
    this.pendingSessionKey = null;
    this.reconnectTimer = null;
    this.allowReconnect = true;
    this.reconnectDelay = 900;

    this.handleWsOpen = this.handleWsOpen.bind(this);
    this.handleWsClose = this.handleWsClose.bind(this);
    this.handleWsError = this.handleWsError.bind(this);
    this.handleWsMessage = this.handleWsMessage.bind(this);
  }
  clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
  scheduleReconnect() {
    if (!this.allowReconnect) return;
    if (this.reconnectTimer) return;
    const targetPort = this.port;
    if (!Number.isInteger(targetPort) || targetPort <= 0) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.allowReconnect) return;
      this.connect(targetPort);
    }, this.reconnectDelay);
  }
  setNowPlayingHandler(handler) {
    this.nowPlayingHandler = typeof handler === 'function' ? handler : null;
  }
  setRemoteSessionsHandler(handler) {
    this.remoteSessionsHandler = typeof handler === 'function' ? handler : null;
  }
  preparePortSwitch(port) {
    const parsed = Number.parseInt(port, 10);
    const targetPort = Number.isFinite(parsed) && parsed > 0 ? parsed : this.port;
    this.clearReconnectTimer();
    this.port = targetPort;
    if (this.ws) {
      this.detachWs(this.ws);
      try { this.ws.close(); } catch { /* noop */ }
      this.ws = null;
    }
  }
  connect(port) {
    const parsed = Number.parseInt(port, 10);
    const targetPort = Number.isFinite(parsed) && parsed > 0 ? parsed : this.port;
    const samePort = this.ws && this.port === targetPort;
    this.clearReconnectTimer();
    if (this.ws && samePort) {
      const ready = this.ws.readyState;
      if (ready === 1 || ready === 0) {
        this.port = targetPort;
        return;
      }
      this.detachWs(this.ws);
      try { this.ws.close(); } catch { /* noop */ }
    } else if (this.ws) {
      this.detachWs(this.ws);
      try { this.ws.close(); } catch { /* noop */ }
    }
    this.port = targetPort;
    const ws = new WebSocket(`ws://localhost:${targetPort}`);
    this.ws = ws;
    this.attachWs(ws);
  }
  attachWs(ws) {
    ws.addEventListener('open', this.handleWsOpen);
    ws.addEventListener('close', this.handleWsClose);
    ws.addEventListener('error', this.handleWsError);
    ws.addEventListener('message', this.handleWsMessage);
  }
  detachWs(ws) {
    ws.removeEventListener('open', this.handleWsOpen);
    ws.removeEventListener('close', this.handleWsClose);
    ws.removeEventListener('error', this.handleWsError);
    ws.removeEventListener('message', this.handleWsMessage);
  }
  handleWsOpen() {
    if (this.pendingTime != null) {
      const time = this.pendingTime;
      this.pendingTime = null;
      this.sendTime(time);
    }
    if (this.pendingSessionKey != null) {
      const key = this.pendingSessionKey;
      this.pendingSessionKey = null;
      this.setActiveSessionKey(key);
    }
  }
  handleWsClose(event) {
    if (event?.target) this.detachWs(event.target);
    if (event?.target === this.ws) {
      this.ws = null;
      this.scheduleReconnect();
    }
  }
  handleWsError(event) {
    if (event?.target === this.ws) {
      this.scheduleReconnect();
    }
    // suppress connection errors to keep renderer logs quiet
  }
  handleWsMessage(event) {
    if (!event?.data) return;
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (!data || typeof data !== 'object') return;
    if (data.type === 'nowPlaying' && data.payload) {
      this.nowPlayingHandler?.(data.payload);
    } else if (data.type === 'remoteSessions') {
      const payload = data.payload && typeof data.payload === 'object' ? data.payload : {};
      this.remoteSessionsHandler?.(payload);
    } else if (!data.type && looksLikeNowPlayingPayload(data)) {
      this.nowPlayingHandler?.(data);
    }
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const t = Number(this.video?.currentTime || 0);
      if (!Number.isFinite(t)) return;
      this.sendTime(t);
    }, 33);
  }
  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
  sendTime(time) {
    if (typeof time !== 'number' || !Number.isFinite(time)) return;
    const ws = this.ws;
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'setTime', payload: { t: time } }));
    } else {
      this.pendingTime = time;
    }
  }
  setActiveSessionKey(key) {
    const normalized = typeof key === 'string' ? key : '';
    const ws = this.ws;
    const message = JSON.stringify({ type: 'setActiveSession', payload: { key: normalized } });
    if (ws && ws.readyState === 1) {
      try { ws.send(message); } catch { /* noop */ }
      this.pendingSessionKey = null;
    } else {
      this.pendingSessionKey = normalized;
    }
  }
  dispose() {
    this.allowReconnect = false;
    this.clearReconnectTimer();
    this.stop();
    if (this.ws) {
      this.detachWs(this.ws);
      try { this.ws.close(); } catch { /* noop */ }
      this.ws = null;
    }
    this.pendingTime = null;
    this.pendingSessionKey = null;
  }
}

const overlaySync = new OverlaySync(dom.video);
overlaySync.setNowPlayingHandler(handleRemoteNowPlaying);
overlaySync.setRemoteSessionsHandler(handleRemoteSessionsUpdate);
function looksLikeNowPlayingPayload(raw) {
  if (!raw || typeof raw !== 'object') return false;
  if (typeof raw.progress === 'number' || typeof raw.progressMs === 'number') return true;
  if (typeof raw.duration === 'number' || typeof raw.durationMs === 'number') return true;
  if (typeof raw.guid === 'string' && raw.guid) return true;
  if (typeof raw.title === 'string' && raw.title) return true;
  return false;
}

function normalizeNowPlayingPayload(raw) {
  if (!looksLikeNowPlayingPayload(raw)) return null;
  const toPositiveNumber = (value) => {
    const num = Number(value);
    return Number.isFinite(num) && num >= 0 ? num : 0;
  };
  const progressMs = toPositiveNumber(raw.progress ?? raw.progressMs);
  const durationMs = toPositiveNumber(raw.duration ?? raw.durationMs);
  const clampedProgress = durationMs > 0 ? Math.min(progressMs, durationMs) : progressMs;
  const normalizeStr = (value) => (typeof value === 'string' ? value.trim() : '');
  const status = normalizeRemoteStatus(raw.status);
  const artists = Array.isArray(raw.artists)
    ? raw.artists.map((name) => normalizeStr(name)).filter(Boolean)
    : [];
  const normalizedSongLink = normalizeRemoteUrl(raw.song_link ?? raw.songLink);
  return {
    guid: normalizeStr(raw.guid),
    cover: normalizeStr(raw.cover),
    title: normalizeStr(raw.title),
    artists,
    status,
    progressMs: clampedProgress,
    progressSeconds: clampedProgress / 1000,
    durationMs,
    durationSeconds: durationMs / 1000,
    songLink: normalizedSongLink,
    platform: normalizeStr(raw.platform),
    isLive: raw.is_live === true,
    receivedAt: Date.now(),
    reset: raw.reset === true
  };
}

function handleRemoteNowPlaying(raw) {
  const payload = normalizeNowPlayingPayload(raw);
  if (!payload) return;
  if (payload.reset) {
    state.remoteNowPlaying = null;
    state.remoteMediaKey = '';
    state.remoteLastGuid = '';
    state.remoteLastUpdate = Date.now();
    stopRemoteProgressTimer();
    if (state.useRemoteTimeline) {
      clearRemoteCover();
      if (dom.video) {
        dom.video.dataset.remoteStatus = 'unknown';
        dom.video.classList.remove('is-remote-playing', 'is-remote-paused');
      }
      applyRemoteMediaUiState();
      updateVideoCacheSelect(state.remoteSelectedKey || state.remoteActiveSessionKey);
    }
    updateRemotePlayerUi();
    updateActiveCacheInfo();
    if (state.useRemoteTimeline) {
      applySubtitleOffsetForSelection({ videoId: state.activeVideoId, subsId: state.activeSubsId });
    }
    return;
  }
  const previousKey = state.remoteMediaKey || '';
  const derivedKey = getRemoteMediaKey(payload) || '';
  state.remoteNowPlaying = payload;
  if (payload.guid) state.remoteLastGuid = payload.guid;
  state.remoteLastUpdate = Number.isFinite(payload.receivedAt)
    ? payload.receivedAt
    : Date.now();
  if (derivedKey) state.remoteMediaKey = derivedKey;
  if (state.useRemoteTimeline) {
    const keyChanged = derivedKey && derivedKey !== previousKey;
    applyRemoteTimeline(payload);
    if (keyChanged && state.activeSubsId) {
      applySubtitleOffsetForSelection({ subsId: state.activeSubsId, notify: true });
    }
    applyRemoteMediaUiState();
    updateVideoCacheSelect(state.remoteSelectedKey || state.remoteActiveSessionKey);
  }
  updateRemotePlayerUi(payload);
  const effectiveStatus = getRemotePlaybackStatus(payload);
  if (state.useRemoteTimeline && effectiveStatus === 'playing') {
    startRemoteProgressTimer();
  } else {
    stopRemoteProgressTimer();
  }
  updateActiveCacheInfo();
}

function clearRemoteTimelineMonitor({ resetSessions = true } = {}) {
  state.remoteNowPlaying = null;
  state.remoteMediaKey = '';
  state.remoteLastGuid = '';
  state.remoteLastUpdate = Date.now();
  if (resetSessions) {
    state.remoteSessions = [];
    state.remoteSelectedKey = '';
    state.remoteActiveSessionKey = '';
  }
  stopRemoteProgressTimer();
  clearRemoteCover();
  if (dom.video) {
    dom.video.dataset.remoteStatus = 'unknown';
    dom.video.classList.remove('is-remote-playing', 'is-remote-paused');
  }
  updateRemotePlayerUi();
  updateActiveCacheInfo();
  if (state.useRemoteTimeline) {
    applyRemoteMediaUiState();
    updateVideoCacheSelect(state.remoteSelectedKey || state.remoteActiveSessionKey);
    applySubtitleOffsetForSelection({ videoId: state.activeVideoId, subsId: state.activeSubsId });
  }
}


function handleRemoteSessionsUpdate(payload = {}) {
  const previousActiveKey = state.remoteActiveSessionKey;
  const previousSelectedKey = state.remoteSelectedKey;
  const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
  const normalized = [];
  for (const item of sessions) {
    const entry = normalizeRemoteSession(item);
    if (entry) normalized.push(entry);
  }
  normalized.sort((a, b) => {
    const playA = Number(a?.lastPlayTs) || 0;
    const playB = Number(b?.lastPlayTs) || 0;
    if (playA !== playB) return playB - playA;
    const updateA = Number(a?.lastUpdate) || 0;
    const updateB = Number(b?.lastUpdate) || 0;
    if (updateA !== updateB) return updateB - updateA;
    const statusA = (a?.status || '').toLowerCase();
    const statusB = (b?.status || '').toLowerCase();
    if (statusA !== statusB) {
      const rank = { playing: 2, paused: 1 };
      const scoreA = rank[statusA] || 0;
      const scoreB = rank[statusB] || 0;
      if (scoreA !== scoreB) return scoreB - scoreA;
    }
    return a.key.localeCompare(b.key);
  });
  state.remoteSessions = normalized;
  const activeKey = typeof payload.activeKey === 'string' ? payload.activeKey : '';
  const selectedKey = typeof payload.selectedKey === 'string' ? payload.selectedKey : '';
  state.remoteActiveSessionKey = normalized.some((session) => session.key === activeKey) ? activeKey : '';
  state.remoteSelectedKey = normalized.some((session) => session.key === selectedKey) ? selectedKey : '';
  if (state.useRemoteTimeline) {
    const targetKey = state.remoteSelectedKey || state.remoteActiveSessionKey || '';
    updateVideoCacheSelect(targetKey);
    if (previousActiveKey !== state.remoteActiveSessionKey || previousSelectedKey !== state.remoteSelectedKey) {
      applySubtitleOffsetForSelection({ videoId: state.activeVideoId, subsId: state.activeSubsId });
    }
  }
}

function applyRemoteTimeline(payload) {
  if (!payload) return;
  if (!dom.video) return;
  const status = getRemotePlaybackStatus(payload);
  dom.video.dataset.remoteStatus = status || 'unknown';
  dom.video.classList.toggle('is-remote-playing', status === 'playing');
  dom.video.classList.toggle('is-remote-paused', status === 'paused');
}


function updateRemotePlayerVisibility() {
  const usingRemote = Boolean(state.useRemoteTimeline);
  if (dom.previewArea) {
    dom.previewArea.classList.toggle('remote-active', usingRemote);
  }
  if (dom.remoteHud) {
    dom.remoteHud.hidden = !usingRemote;
    dom.remoteHud.setAttribute('aria-hidden', usingRemote ? 'false' : 'true');
  }
  if (dom.video) {
    dom.video.classList.toggle('remote-mock', usingRemote);
    dom.video.style.pointerEvents = usingRemote ? 'none' : '';
    if (usingRemote) {
      dom.video.removeAttribute('controls');
      dom.video.controls = false;
      dom.video.setAttribute('data-remote-active', 'true');
      try { dom.video.pause(); } catch { /* noop */ }
    } else {
      dom.video.setAttribute('controls', '');
      dom.video.controls = true;
      dom.video.removeAttribute('data-remote-active');
      dom.video.removeAttribute('data-remote-status');
      delete dom.video.dataset.remoteStatus;
      dom.video.classList.remove('is-remote-playing', 'is-remote-paused');
      clearRemoteCover();
    }
  }
}

function formatClockTime(seconds) {
  if (!Number.isFinite(seconds)) return '--:--';
  const clamped = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const secs = clamped % 60;
  const mm = String(minutes).padStart(hours > 0 ? 2 : 1, '0');
  const ss = String(secs).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

function getRemotePayloadTimestamp(info = state.remoteNowPlaying) {
  if (info && Number.isFinite(info.receivedAt)) return info.receivedAt;
  if (info === state.remoteNowPlaying && Number.isFinite(state.remoteLastUpdate)) {
    return state.remoteLastUpdate;
  }
  return 0;
}

function getRemotePlaybackStatus(info = state.remoteNowPlaying) {
  if (!info || typeof info !== 'object') return 'unknown';
  return normalizeRemoteStatus(info.status);
}


function getRemoteProgressEstimate(info = state.remoteNowPlaying) {
  if (!info || typeof info !== 'object') {
    return { progress: null, duration: null };
  }
  const progressBase = Number.isFinite(info.progressSeconds)
    ? info.progressSeconds
    : (Number.isFinite(info.progressMs) ? info.progressMs / 1000 : null);
  const duration = Number.isFinite(info.durationSeconds)
    ? Math.max(0, info.durationSeconds)
    : (Number.isFinite(info.durationMs) ? Math.max(0, info.durationMs / 1000) : null);
  let progress = progressBase != null ? Math.max(0, progressBase) : null;
  const status = getRemotePlaybackStatus(info);
  const baseTs = getRemotePayloadTimestamp(info);
  if (progress != null && status === 'playing' && baseTs > 0) {
    const elapsed = Math.max(0, (Date.now() - baseTs) / 1000);
    progress += elapsed;
  }
  if (progress != null && duration != null && duration > 0) {
    progress = Math.min(progress, duration);
  }
  return { progress, duration };
}

function updateRemoteProgressDisplay(info = state.remoteNowPlaying) {
  if (!dom.remoteHudCurrent || !dom.remoteHudDuration || !dom.remoteHudProgressFill) return;
  const { progress, duration } = getRemoteProgressEstimate(info);
  const currentText = progress != null ? formatClockTime(progress) : '0:00';
  dom.remoteHudCurrent.textContent = currentText;
  const isLive = info?.isLive === true;
  if (isLive) {
    dom.remoteHudDuration.textContent = 'LIVE';
    dom.remoteHudDuration.classList.add('is-live');
  } else {
    dom.remoteHudDuration.classList.remove('is-live');
    dom.remoteHudDuration.textContent = (duration != null && duration > 0)
      ? formatClockTime(duration)
      : '--:--';
  }
  const ratio = (progress != null && duration != null && duration > 0)
    ? Math.min(1, Math.max(0, progress / duration))
    : 0;
  dom.remoteHudProgressFill.style.width = `${(ratio * 100).toFixed(2)}%`;
}

function getRemoteStatusLabel(info = state.remoteNowPlaying) {
  if (!info || typeof info !== 'object') return '等待播放';
  const status = getRemotePlaybackStatus(info);
  const isLive = info.isLive === true;
  if (status === 'playing') return isLive ? '直播中' : '播放中';
  if (status === 'paused') return isLive ? '直播暫停' : '已暫停';
  if (status === 'unknown') return isLive ? '直播結束' : '已停止';
  return info.title || info.artists?.length ? '已連線' : '等待播放';
}

function updateRemotePlayerUi(info = state.remoteNowPlaying) {
  if (!dom.remoteHud) return;
  const remote = info && typeof info === 'object' ? info : null;
  const hasRemote = Boolean(remote);
  const title = remote?.title || '外部時間軸';
  const artists = Array.isArray(remote?.artists) && remote.artists.length
    ? remote.artists.join(', ')
    : '';
  const platform = remote?.platform ? `@${remote.platform}` : '';
  const subtitleParts = [artists, platform].filter(Boolean);
  if (dom.remoteHudTitle) dom.remoteHudTitle.textContent = title;
  if (dom.remoteHudSubtitle) {
    dom.remoteHudSubtitle.textContent = subtitleParts.length
      ? subtitleParts.join(' · ')
      : (hasRemote ? '外部時間軸已啟用' : '等待外部播放資訊...');
  }
  if (dom.remoteHudStatus) dom.remoteHudStatus.textContent = getRemoteStatusLabel(remote);

  if (state.useRemoteTimeline) {
    applyRemoteCoverImage(remote?.cover || '');
  }

  const status = getRemotePlaybackStatus(remote);
  dom.remoteHud.classList.toggle('is-playing', status === 'playing');
  dom.remoteHud.classList.toggle('is-paused', status === 'paused');
  dom.remoteHud.classList.toggle('is-stopped', !status || status === 'unknown');

  updateRemoteProgressDisplay(remote);
}

function startRemoteProgressTimer() {
  updateRemoteProgressDisplay();
  if (state.remoteProgressTimer != null) return;
  state.remoteProgressTimer = window.setInterval(() => {
    if (!state.useRemoteTimeline) {
      stopRemoteProgressTimer();
      return;
    }
    updateRemoteProgressDisplay();
    if (getRemotePlaybackStatus() !== 'playing') {
      if (state.useRemoteTimeline && state.remoteNowPlaying) {
        applyRemoteTimeline(state.remoteNowPlaying);
      }
      updateRemotePlayerUi();
      stopRemoteProgressTimer();
    }
  }, 500);
}

function stopRemoteProgressTimer() {
  if (state.remoteProgressTimer != null) {
    window.clearInterval(state.remoteProgressTimer);
    state.remoteProgressTimer = null;
  }
}

function revokeRemoteCoverObjectUrl() {
  if (state.remoteCoverObjectUrl) {
    try { URL.revokeObjectURL(state.remoteCoverObjectUrl); } catch { /* noop */ }
    state.remoteCoverObjectUrl = '';
  }
}

function clearRemoteCover() {
  if (!dom.video) return;
  if (state.remoteCoverAbort) {
    try { state.remoteCoverAbort.abort(); } catch { /* noop */ }
    state.remoteCoverAbort = null;
  }
  state.remoteCoverToken += 1;
  revokeRemoteCoverObjectUrl();
  state.remoteCoverSource = '';
  dom.video.removeAttribute('data-remote-cover');
  if (dom.video.hasAttribute('poster')) {
    dom.video.removeAttribute('poster');
  }
}

async function applyRemoteCoverImage(rawUrl) {
  const video = dom.video;
  if (!video) return;
  const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!url) {
    clearRemoteCover();
    return;
  }
  if (state.remoteCoverSource === url) return;
  state.remoteCoverSource = url;
  state.remoteCoverToken += 1;
  const token = state.remoteCoverToken;
  if (state.remoteCoverAbort) {
    try { state.remoteCoverAbort.abort(); } catch { /* noop */ }
  }
  const controller = new AbortController();
  state.remoteCoverAbort = controller;
  try {
    const response = await fetch(url, {
      mode: 'cors',
      credentials: 'omit',
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    if (!/^image\//i.test(blob.type || '')) throw new Error('非圖片資源');
    const objectUrl = URL.createObjectURL(blob);
    if (state.remoteCoverToken !== token) {
      try { URL.revokeObjectURL(objectUrl); } catch { /* noop */ }
      return;
    }
    revokeRemoteCoverObjectUrl();
    state.remoteCoverObjectUrl = objectUrl;
    video.setAttribute('data-remote-cover', 'object');
    video.poster = objectUrl;
  } catch (err) {
    if (state.remoteCoverToken !== token) return;
    console.warn('[remote] 無法透過 fetch 載入封面，改用原網址', err);
    revokeRemoteCoverObjectUrl();
    video.setAttribute('data-remote-cover', 'direct');
    video.poster = url;
  } finally {
    if (state.remoteCoverToken === token) {
      state.remoteCoverAbort = null;
    }
  }
}


function updateRemoteToggleUI() {
  if (!dom.useRemoteTimelineToggle) return;
  dom.useRemoteTimelineToggle.checked = Boolean(state.useRemoteTimeline);
  dom.useRemoteTimelineToggle.setAttribute('aria-checked', state.useRemoteTimeline ? 'true' : 'false');
}

function applyRemoteMediaUiState() {
  const usingRemote = Boolean(state.useRemoteTimeline);
  if (dom.videoCacheSearch) {
    const input = dom.videoCacheSearch;
    input.disabled = false;
    input.classList.toggle('is-remote-disabled', usingRemote);
    if (!input.dataset.placeholderVideo) {
      input.dataset.placeholderVideo = input.placeholder || '';
    }
    if (!input.dataset.placeholderRemote) {
      input.dataset.placeholderRemote = '搜尋外部播放來源...';
    }
    input.placeholder = usingRemote
      ? input.dataset.placeholderRemote
      : (input.dataset.placeholderVideo || '');
  }
  if (dom.pickVideo) {
    dom.pickVideo.disabled = usingRemote;
    dom.pickVideo.classList.toggle('is-remote-disabled', usingRemote);
  }
  const select = dom.videoCacheSelect;
  if (!select) return;
  select.classList.toggle('is-remote-disabled', usingRemote);
}

function setRemoteTimelineEnabled(enabled, { persist = false } = {}) {
  const enablingRemote = Boolean(enabled);
  state.useRemoteTimeline = enablingRemote;
  state.remoteMediaKey = enablingRemote ? (getRemoteMediaKey() || state.remoteMediaKey || '') : '';
  updateRemoteToggleUI();
  overlaySync.connect(getCurrentPort());
  if (state.useRemoteTimeline) {
    overlaySync.stop();
    if (state.activeVideoId) {
      state.activeVideoId = '';
      loadVideoEntry(null);
    }
    if (state.remoteNowPlaying) applyRemoteTimeline(state.remoteNowPlaying);
  } else {
    overlaySync.start();
  }
  if (persist) {
    persistPlayerConfig();
  }
  updateActiveCacheInfo();
  applyRemoteMediaUiState();
  updateRemotePlayerVisibility();
  if (state.useRemoteTimeline) {
    updateRemotePlayerUi();
    if (getRemotePlaybackStatus() === 'playing') {
      startRemoteProgressTimer();
    } else {
      stopRemoteProgressTimer();
    }
  } else {
    stopRemoteProgressTimer();
    updateRemotePlayerUi();
  }
  if (state.useRemoteTimeline) {
    updateVideoCacheSelect(state.remoteSelectedKey || state.remoteActiveSessionKey);
  } else {
    updateVideoCacheSelect(state.activeVideoId);
  }
  const canApplyOffset = state.activeSubsId && (!state.useRemoteTimeline || state.remoteMediaKey);
  if (canApplyOffset) {
    applySubtitleOffsetForSelection({ videoId: state.activeVideoId, subsId: state.activeSubsId });
  }
}

function handleRemoteTimelineToggle(event) {
  const next = event?.target?.checked === true;
  setRemoteTimelineEnabled(next, { persist: true });
}

function setVideoPlaceholder(active) {
  if (!dom.video) return;
  dom.video.classList.toggle('placeholder', Boolean(active));
}

function updateBinStatusIndicator(ev) {
  const iconEl = ev?.id === 'yt-dlp'
    ? dom.binStatusYt
    : ev?.id === 'ffmpeg'
      ? dom.binStatusFfmpeg
      : null;
  if (!iconEl) return;

  const stage = ev?.stage;
  const status = ev?.status;

  if (stage === 'update') {
    if (status === 'error') {
      applyBinStatus(iconEl, { available: true, pending: false, tooltip: ev.message || '' });
      return;
    }
    if (status === 'done') {
      applyBinStatus(iconEl, { available: true, pending: false, tooltip: ev.message || '' });
      return;
    }
    if (status === 'start' || status === 'progress') {
      applyBinStatus(iconEl, { available: true, pending: true, tooltip: ev.message || '' });
      return;
    }
  }

  if (status === 'error') {
    applyBinStatus(iconEl, { available: false, pending: false, tooltip: ev.message || '' });
    return;
  }

  if (status === 'start' || status === 'progress' || (status === 'done' && stage !== 'ready')) {
    applyBinStatus(iconEl, { available: false, pending: true });
    return;
  }

  if (status === 'done' && stage === 'ready') {
    applyBinStatus(iconEl, { available: true, pending: false });
  }
}

async function handleDownloadDone(payload) {
  showDownloadProgress(false);
  state.jobId = null;
  state.activeDownloadMode = null;
  const mode = typeof payload === 'object' ? payload?.mode : null;
  const label = mode === 'audio' ? '音訊' : '影片';
  const doneLabel = label ? `${label}下載完成` : '下載完成';
  updateDownloadStatus(doneLabel);
  state.downloadProgressStarted = true;
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
    let activeVideoEntry = getEntryById(state.activeVideoId);
    let activeSubsEntry = getEntryById(state.activeSubsId);
    if (state.useRemoteTimeline) {
      updateVideoCacheSelect(state.remoteSelectedKey || state.remoteActiveSessionKey);
    } else if (merged?.hasVideo && merged.videoFilename) {
      state.activeVideoId = merged.id;
      updateVideoCacheSelect(merged.id);
      await loadVideoEntry(merged);
      activeVideoEntry = merged;
    } else {
      updateVideoCacheSelect(state.activeVideoId);
    }
    if (merged?.hasSubs && merged.subsPath) {
      state.activeSubsId = merged.id;
      updateSubsCacheSelect(merged.id);
      await loadSubtitleEntry(merged);
      activeSubsEntry = merged;
    } else {
      updateSubsCacheSelect(state.activeSubsId);
    }
    updateActiveCacheInfo({ video: activeVideoEntry, subs: activeSubsEntry });
    applySubtitleOffsetForSelection({ videoId: state.activeVideoId, subsId: state.activeSubsId });
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
  return `${base} (${markers.join(' / ')}) `;
}

function updateVideoCacheSelect(selectedId) {
  const select = dom.videoCacheSelect;
  if (!select) return;
  applyRemoteMediaUiState();
  if (state.useRemoteTimeline) {
    const searchTerm = (state.videoSearch || '').toLowerCase();
    const targetKey = typeof selectedId === 'string'
      ? selectedId
      : (state.remoteSelectedKey || state.remoteActiveSessionKey || '');
    populateRemoteSessionSelect(select, {
      selectedKey: targetKey,
      searchTerm
    });
    return;
  }
  const effectiveSelectedId = typeof selectedId === 'string' ? selectedId : state.activeVideoId;
  const searchTerm = (state.videoSearch || '').toLowerCase();
  const entries = state.cachedEntries
    .filter((entry) => entry?.hasVideo && entry.videoFilename && matchesEntrySearch(entry, searchTerm));
  populateSelect(select, entries, {
    selectedId: effectiveSelectedId,
    placeholder: '選擇影片或音訊',
    emptyLabel: state.videoSearch ? '（沒有符合的媒體）' : '（尚未匯入媒體）',
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
    refreshCustomSelect(select, { rebuildOptions: true });
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
  refreshCustomSelect(select, { rebuildOptions: true });
}

function normalizeRemoteSession(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const key = typeof raw.key === 'string' ? raw.key.trim() : '';
  if (!key) return null;
  const host = typeof raw.host === 'string' ? raw.host : '';
  const status = normalizeRemoteStatus(raw.status);
  const lastUpdateRaw = Number(raw.lastUpdate);
  const lastUpdate = Number.isFinite(lastUpdateRaw) ? lastUpdateRaw : 0;
  const lastPlayTsRaw = Number(raw.lastPlayTs);
  const lastPlayTs = Number.isFinite(lastPlayTsRaw) ? lastPlayTsRaw : 0;
  const connected = raw.connected !== false;
  let nowPlaying = null;
  if (raw.nowPlaying && typeof raw.nowPlaying === 'object') {
    const artists = Array.isArray(raw.nowPlaying.artists)
      ? raw.nowPlaying.artists.map((name) => (typeof name === 'string' ? name.trim() : '')).filter(Boolean)
      : [];
    nowPlaying = {
      title: typeof raw.nowPlaying.title === 'string' ? raw.nowPlaying.title : '',
      artists,
      status: normalizeRemoteStatus(raw.nowPlaying.status || status),
      songLink: typeof raw.nowPlaying.songLink === 'string' ? raw.nowPlaying.songLink : '',
      platform: typeof raw.nowPlaying.platform === 'string' ? raw.nowPlaying.platform : '',
      isLive: raw.nowPlaying.isLive === true
    };
  }
  const resolvedStatus = normalizeRemoteStatus(nowPlaying?.status || status || 'unknown');
  if (resolvedStatus === 'unknown') return null;
  const searchParts = [key, host];
  if (nowPlaying) {
    if (nowPlaying.title) searchParts.push(nowPlaying.title);
    if (nowPlaying.artists.length) searchParts.push(nowPlaying.artists.join(' '));
    if (nowPlaying.platform) searchParts.push(nowPlaying.platform);
    if (nowPlaying.songLink) searchParts.push(nowPlaying.songLink);
  }
  const searchText = searchParts
    .filter(Boolean)
    .map((value) => String(value).toLowerCase())
    .join(' ');
  return { key, host, status: resolvedStatus || 'unknown', lastUpdate, lastPlayTs, connected, nowPlaying, searchText };
}

function matchesRemoteSessionSearch(session, term) {
  if (!term) return true;
  return (session?.searchText || '').includes(term);
}

function formatRemoteSessionOptionLabel(session) {
  if (!session) return '';
  const nowPlaying = session.nowPlaying || null;
  const host = session.host || '';
  const title = nowPlaying?.title || '';
  const artists = Array.isArray(nowPlaying?.artists) && nowPlaying.artists.length
    ? nowPlaying.artists.join(', ')
    : '';
  const platform = nowPlaying?.platform || '';
  const statusSource = nowPlaying?.status || session.status;
  const parts = [];
  if (host) parts.push(host);
  if (title) parts.push(title);
  else if (artists) parts.push(artists);
  let label = parts.length ? parts.join(' · ') : (platform || session.key);
  const statusLabel = getRemoteStatusLabel({
    status: statusSource,
    isLive: nowPlaying?.isLive,
    title: nowPlaying?.title,
    artists: nowPlaying?.artists
  });
  if (statusLabel) {
    label += ` (${statusLabel}) `;
  }
  return label;
}

function populateRemoteSessionSelect(select, { selectedKey = '', searchTerm = '' } = {}) {
  const normalizedTerm = typeof searchTerm === 'string' ? searchTerm : '';
  const sessions = state.remoteSessions.filter((session) => matchesRemoteSessionSearch(session, normalizedTerm));
  select.innerHTML = '';
  if (!sessions.length) {
    const emptyLabel = state.remoteSessions.length
      ? '（沒有符合的外部來源）'
      : '（沒有外部播放來源）';
    const option = new Option(emptyLabel, '');
    option.disabled = true;
    option.selected = true;
    select.add(option);
    select.disabled = true;
    refreshCustomSelect(select, { rebuildOptions: true });
    return;
  }
  select.disabled = false;
  const placeholder = new Option('選擇要追蹤的頁面', '', !selectedKey, !selectedKey);
  select.add(placeholder);
  sessions.forEach((session) => {
    const option = new Option(formatRemoteSessionOptionLabel(session), session.key, false, session.key === selectedKey);
    const tooltipParts = [];
    if (session.nowPlaying?.artists?.length) tooltipParts.push(session.nowPlaying.artists.join(', '));
    if (session.nowPlaying?.platform) tooltipParts.push(session.nowPlaying.platform);
    if (session.host && session.host !== session.nowPlaying?.platform) tooltipParts.push(session.host);
    if (session.nowPlaying?.songLink) {
      option.title = session.nowPlaying.songLink;
    } else if (tooltipParts.length) {
      option.title = tooltipParts.join(' · ');
    }
    select.add(option);
  });
  let finalValue = selectedKey;
  if (!sessions.some((session) => session.key === finalValue)) {
    const fallback = state.remoteActiveSessionKey;
    if (fallback && sessions.some((session) => session.key === fallback)) {
      finalValue = fallback;
    } else {
      finalValue = '';
    }
  }
  select.value = finalValue;
  refreshCustomSelect(select, { rebuildOptions: true });
}

function handleVideoCacheSearch() {
  state.videoSearch = (dom.videoCacheSearch?.value || '').trim();
  if (state.useRemoteTimeline) {
    updateVideoCacheSelect(state.remoteSelectedKey || state.remoteActiveSessionKey);
  } else {
    updateVideoCacheSelect(state.activeVideoId);
  }
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
  if (state.useRemoteTimeline) {
    state.remoteSelectedKey = id;
    overlaySync.setActiveSessionKey(id);
    refreshCustomSelect(dom.videoCacheSelect);
    applySubtitleOffsetForSelection({ videoId: state.activeVideoId, subsId: state.activeSubsId });
    return;
  }
  state.activeVideoId = id;
  const entry = getEntryById(id);
  loadVideoEntry(entry);
  updateActiveCacheInfo({ video: entry, subs: getEntryById(state.activeSubsId) });
  applySubtitleOffsetForSelection({ videoId: id, subsId: state.activeSubsId });
}

function handleSubsCacheSelectChange() {
  const id = dom.subsCacheSelect?.value || '';
  state.activeSubsId = id;
  const entry = getEntryById(id);
  loadSubtitleEntry(entry);
  updateActiveCacheInfo({ video: getEntryById(state.activeVideoId), subs: entry });
  applySubtitleOffsetForSelection({ videoId: state.activeVideoId, subsId: id });
}

async function loadVideoEntry(entry) {
  if (!entry || !entry.hasVideo || !entry.videoFilename) {
    releaseObjectUrl();
    if (dom.video) {
      dom.video.removeAttribute('src');
      try { dom.video.load(); } catch { /* noop */ }
    }
    setVideoPlaceholder(true);
    setPickedLabel(dom.videoPicked, { label: '', tooltip: '' });
    return;
  }
  releaseObjectUrl();
  const url = buildCacheUrl(entry.videoFilename);
  setVideoPlaceholder(true);
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

function describeRemoteNowPlaying(info) {
  const target = info || state.remoteNowPlaying;
  if (!target) return '';
  const pieces = [];
  if (target.title) pieces.push(target.title);
  if (Array.isArray(target.artists) && target.artists.length) pieces.push(target.artists.join(', '));
  if (target.platform) pieces.push(`@${target.platform}`);
  return pieces.join(' / ');
}

function updateActiveCacheInfo({ video = getEntryById(state.activeVideoId), subs = getEntryById(state.activeSubsId) } = {}) {
  if (!dom.activeCacheInfo) return;
  const videoLabel = video ? describeVideoEntry(video) : '（未選擇）';
  const subsLabel = subs ? describeSubtitleEntry(subs) : '（未選擇）';
  let infoText = '影片/音訊：' + videoLabel + '\n字幕：' + subsLabel;
  if (state.useRemoteTimeline && state.remoteNowPlaying) {
    const remoteLabel = describeRemoteNowPlaying(state.remoteNowPlaying);
    if (remoteLabel) infoText += '\n外部時間軸：' + remoteLabel;
  }
  dom.activeCacheInfo.textContent = infoText;
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
        applySubtitleOffsetForSelection({ videoId: state.activeVideoId, subsId: state.activeSubsId });
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
      applySubtitleOffsetForSelection({ videoId: state.activeVideoId, subsId: state.activeSubsId });
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
  state.overlayRefreshSeq += 1;
  const refreshToken = `subs-${Date.now()}-${state.overlayRefreshSeq}`;
  notifyOverlayWithCurrentFonts({
    style,
    subContent: state.currentAssText,
    refreshToken
  });
  syncOverlayConnection();
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
    if (state.useRemoteTimeline) {
      updateVideoCacheSelect(state.remoteSelectedKey || state.remoteActiveSessionKey);
    } else if (merged?.hasVideo && merged.videoFilename) {
      state.activeVideoId = merged.id;
      updateVideoCacheSelect(merged.id);
      await loadVideoEntry(merged);
      updateActiveCacheInfo({ video: merged, subs: getEntryById(state.activeSubsId) });
    } else {
      updateVideoCacheSelect(state.activeVideoId);
    }
    applySubtitleOffsetForSelection({ videoId: state.activeVideoId, subsId: state.activeSubsId });
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
    dom.activeCacheInfo.textContent = `影片/音訊：本地媒體：${file.name}\n字幕：${subsLabel}`;
  }
  playVideo(url);
  setPickedLabel(dom.videoPicked, { label: file.name || '', tooltip: filePath || file.name || '' });
  applySubtitleOffsetForSelection({ videoId: state.activeVideoId, subsId: state.activeSubsId });
  ev.target.value = '';
}

function handleBinProgress(ev) {
  if (!ev || !ev.id || !(state.binProgress instanceof Map)) return;
  updateBinStatusIndicator(ev);
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
    if (ev.stage === 'ready') {
      scheduleBinInfoRefresh();
    }
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

function scheduleBinInfoRefresh(delay = 200) {
  if (state.binInfoRefreshTimer) clearTimeout(state.binInfoRefreshTimer);
  state.binInfoRefreshTimer = setTimeout(async () => {
    state.binInfoRefreshTimer = null;
    try {
      const bins = await window.api.getBins?.();
      setBinInfo(bins || null);
    } catch (err) {
      console.error('[bins] 無法更新工具狀態', err);
    }
  }, delay);
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

function playVideo(url, { autoPlay = false } = {}) {
  if (!url) {
    setVideoPlaceholder(true);
    if (dom.video) {
      dom.video.removeAttribute('src');
      try { dom.video.load(); } catch { /* noop */ }
    }
    return;
  }
  setVideoPlaceholder(true);
  dom.video.src = url;
  if (autoPlay) {
    dom.video.play().catch(() => { /* ignore autoplay error */ });
  } else {
    dom.video.pause();
    try { dom.video.currentTime = 0; } catch { /* noop */ }
  }
  syncOverlayConnection();
}

function captureVideoResumeState() {
  const video = dom.video;
  if (!video) return null;
  const time = Number(video.currentTime);
  return {
    time: Number.isFinite(time) ? time : 0,
    wasPlaying: !video.paused && !video.ended
  };
}

function resumeVideoPlayback(snapshot) {
  if (!snapshot) return;
  const video = dom.video;
  if (!video) return;
  const expectedSrc = video.src;
  const applyResume = () => {
    if (expectedSrc && video.src !== expectedSrc) return;
    let target = snapshot.time;
    if (Number.isFinite(video.duration) && video.duration > 0) {
      target = Math.min(target, Math.max(0, video.duration - 0.05));
    }
    if (Number.isFinite(target) && target > 0) {
      try { video.currentTime = target; } catch { /* noop */ }
    }
    if (snapshot.wasPlaying) {
      video.play().catch(() => { /* ignore autoplay error */ });
    }
  };

  if (video.readyState >= 1) {
    applyResume();
    return;
  }
  const handleReady = () => {
    video.removeEventListener('loadedmetadata', handleReady);
    video.removeEventListener('loadeddata', handleReady);
    applyResume();
  };
  video.addEventListener('loadedmetadata', handleReady);
  video.addEventListener('loadeddata', handleReady);
}

function releaseObjectUrl() {
  if (!state.objectUrl) return;
  try { URL.revokeObjectURL(state.objectUrl); } catch { /* ignore */ }
  state.objectUrl = '';
}

function syncOverlayConnection({ delay = 0 } = {}) {
  overlaySync.connect(getCurrentPort());
  if (state.useRemoteTimeline) {
    overlaySync.stop();
    if (state.remoteNowPlaying) applyRemoteTimeline(state.remoteNowPlaying);
  } else {
    overlaySync.start();
  }
}

async function handlePortChange({ previousPort, nextPort } = {}) {
  const prev = Number.parseInt(previousPort, 10);
  const next = Number.parseInt(nextPort, 10);
  const portChanged = Number.isInteger(prev) && Number.isInteger(next) ? prev !== next : true;

  if (!portChanged) {
    syncOverlayConnection();
    return;
  }

  const changeToken = ++portChangeToken;

  const initialVideoEntry = getEntryById(state.activeVideoId);
  const initialSubsEntry = getEntryById(state.activeSubsId);
  const hasInitialVideo = Boolean(initialVideoEntry && initialVideoEntry.hasVideo && initialVideoEntry.videoFilename);
  const hasInitialSubs = Boolean(initialSubsEntry && initialSubsEntry.hasSubs && initialSubsEntry.subsPath);
  const targetPort = Number.isInteger(next) && next > 0 ? next : getCurrentPort();
  overlaySync.preparePortSwitch(targetPort);
  clearRemoteTimelineMonitor({ resetSessions: true });
  const shouldWaitForServer = hasInitialVideo || hasInitialSubs || Boolean(state.currentAssText);
  if (shouldWaitForServer) {
    const ready = await waitForOverlayServerReadyUntil(targetPort, changeToken);
    if (!ready || changeToken !== portChangeToken) return;
  }

  const videoEntry = getEntryById(state.activeVideoId);
  const subsEntry = getEntryById(state.activeSubsId);
  const hasVideo = Boolean(videoEntry && videoEntry.hasVideo && videoEntry.videoFilename);
  const hasSubs = Boolean(subsEntry && subsEntry.hasSubs && subsEntry.subsPath);
  const resumeSnapshot = hasVideo ? captureVideoResumeState() : null;

  if (hasVideo && dom.video) {
    try { dom.video.pause(); } catch { /* noop */ }
    dom.video.removeAttribute('src');
    try { dom.video.load(); } catch { /* noop */ }
    setVideoPlaceholder(true);
  }

  let synced = false;

  if (hasVideo) {
    await loadVideoEntry(videoEntry);
    resumeVideoPlayback(resumeSnapshot);
    synced = true;
  }

  if (hasSubs) {
    await loadSubtitleEntry(subsEntry);
    applySubtitleOffsetForSelection({ videoId: state.activeVideoId, subsId: state.activeSubsId });
    synced = true;
  } else if (state.currentAssText) {
    const style = collectStyle();
    state.overlayRefreshSeq += 1;
    const refreshToken = `subs-${Date.now()}-${state.overlayRefreshSeq}`;
    notifyOverlayWithCurrentFonts({
      style,
      subContent: state.currentAssText,
      refreshToken
    });
    syncOverlayConnection();
    synced = true;
  }

  if (!synced) {
    syncOverlayConnection();
  }

  updateActiveCacheInfo({ video: videoEntry || null, subs: subsEntry || null });
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
    applySubtitleOffsetForSelection({ videoId: state.activeVideoId, subsId: state.activeSubsId });
  } catch (err) {
    console.error('[cache] 無法載入快取清單', err);
  }
}

/* ---------------- 樣式設定 ---------------- */
function createCacheSelector(rowEl, { label, searchPlaceholder, hint } = {}) {
  if (!rowEl || !rowEl.parentElement) return null;
  const container = document.createElement('div');
  container.className = 'row';
  if (label) {
    const labelEl = document.createElement('label');
    labelEl.textContent = label || '';
    container.appendChild(labelEl);
  }
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.placeholder = searchPlaceholder || '';
  searchInput.style.width = '100%';
  container.appendChild(searchInput);
  const select = document.createElement('select');
  select.style.minWidth = '260px';
  select.dataset.customSelectPlacement = 'dropup';
  select.disabled = true;
  container.appendChild(select);
  if (hint) {
    const hintEl = document.createElement('small');
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
    console.error('[cache] 讀取檔案失敗', err);
    return null;
  }
}

window.addEventListener('beforeunload', () => {
  if (state.remoteCoverAbort) {
    try { state.remoteCoverAbort.abort(); } catch { /* noop */ }
    state.remoteCoverAbort = null;
  }
  revokeRemoteCoverObjectUrl();
  overlaySync.dispose();
});

export {
  overlaySync,
  handleRemoteTimelineToggle,
  setRemoteTimelineEnabled,
  setVideoPlaceholder,
  updateVideoCacheSelect,
  updateSubsCacheSelect,
  handleVideoCacheSearch,
  handleSubsCacheSearch,
  handleVideoCacheSelectChange,
  handleSubsCacheSelectChange,
  refreshCachedEntries,
  handleFetchSubsOnly,
  handlePickSubs,
  handlePickVideo,
  handleBinProgress,
  handleLocalFileSelected,
  handleDownloadDone,
  handleCheckBins,
  renderBinProgress,
  setBinInfo,
  syncOverlayConnection,
  handlePortChange,
  updateActiveCacheInfo,
  initializeCacheControls
};






