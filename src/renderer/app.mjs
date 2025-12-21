import { dom } from './modules/dom.mjs';
import state from './modules/state.mjs';
import { setupCustomSelects, refreshCustomSelect } from './modules/custom-select.mjs';
import {
  normalizeAlignValue,
  normalizeFontBuffer,
  deriveDefaultFontFamily,
  updateFontsLabel,
  collectStyle,
  notifyOverlayWithCurrentFonts,
  setSubtitleOffsetState,
  setSubtitleOffsetControlsEnabled,
  resolveMediaKey,
  normalizeSubtitleOffsetMode,
  sanitizeSubtitleOffsetSeconds,
  normalizeSubtitleOffsetOverrides,
  clampVolume,
  persistVolumeSetting,
  syncSubtitleOffset,
  persistStyle,
  getCurrentPort,
  debounce
} from './modules/style.mjs';
import {
  setControlCollapsed,
  applyControlVisibility,
  setPreviewMaximized,
  applyPreviewMaximized,
  setSidebarOpen
} from './modules/layout.mjs';
import { handlePickCookies, handleClearCookies } from './modules/cookies.mjs';
import { handlePickFonts, handleClearFonts } from './modules/fonts.mjs';
import {
  handleDownloadVideo,
  handleDownloadAudio,
  handleCancelDownload,
  handleYtProgress
} from './modules/downloads.mjs';
import {
  overlaySync,
  handleRemoteTimelineToggle,
  setRemoteTimelineEnabled,
  setVideoPlaceholder,
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
  handleCheckBins,
  setBinInfo,
  handlePortChange,
  syncOverlayConnection,
  initializeCacheControls
} from './modules/media-library.mjs';
const STYLE_INPUT_IDS = ['background', 'align', 'maxWidth', 'maxHeight'];
const DEFAULT_PORT = 59837;

function setupEventHandlers() {
  const debouncedSyncStyle = debounce(async () => {
    const style = collectStyle();
    await persistStyle(style);
    window.api.notifyOverlay({ style });
    syncOverlayConnection();
  }, 120);

  const attachEnterBlur = (el) => {
    if (!el || el.dataset?.enterBlurAttached) return;
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === 'NumpadEnter') {
        ev.preventDefault();
        el.blur();
      }
    });
    if (el.dataset) el.dataset.enterBlurAttached = 'true';
  };

  const attachChangeBlur = (el) => {
    if (!el || el.dataset?.changeBlurAttached) return;
    let lastValue = el.value;
    let skipNextClick = false;

    const scheduleBlur = () => {
      requestAnimationFrame(() => {
        if (document.activeElement === el) el.blur();
      });
    };

    el.addEventListener('focus', () => {
      lastValue = el.value;
    });

    el.addEventListener('pointerdown', () => {
      skipNextClick = true;
    });

    el.addEventListener('keydown', (ev) => {
      if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter', ' ', 'Spacebar'].includes(ev.key)) {
        skipNextClick = true;
      }
      if (ev.key === 'Escape') {
        scheduleBlur();
      }
    });

    const handleValueCommit = () => {
      lastValue = el.value;
      skipNextClick = false;
      scheduleBlur();
    };

    el.addEventListener('change', handleValueCommit);
    el.addEventListener('input', handleValueCommit);

    el.addEventListener('click', () => {
      if (skipNextClick) {
        skipNextClick = false;
        return;
      }
      if (el.value === lastValue) {
        scheduleBlur();
      }
    });

    el.addEventListener('blur', () => {
      skipNextClick = false;
      lastValue = el.value;
    });

    if (el.dataset) el.dataset.changeBlurAttached = 'true';
  };

  dom.pickCookies?.addEventListener('click', handlePickCookies);
  dom.clearCookies?.addEventListener('click', handleClearCookies);
  dom.checkBins?.addEventListener('click', handleCheckBins);
  dom.pickVideo?.addEventListener('click', handlePickVideo);
  dom.useRemoteTimelineToggle?.addEventListener('change', handleRemoteTimelineToggle);
  dom.pickSubs?.addEventListener('click', handlePickSubs);
  dom.pickFonts?.addEventListener('click', handlePickFonts);
  dom.clearFonts?.addEventListener('click', handleClearFonts);
  dom.ytFetch?.addEventListener('click', handleFetchSubsOnly);
  dom.ytDownload?.addEventListener('click', handleDownloadVideo);
  dom.ytDownloadAudio?.addEventListener('click', handleDownloadAudio);
  dom.ytCancel?.addEventListener('click', handleCancelDownload);
  dom.videoFile?.addEventListener('change', handleLocalFileSelected);
  dom.videoCacheSelect?.addEventListener('change', handleVideoCacheSelectChange);
  dom.subsCacheSelect?.addEventListener('change', handleSubsCacheSelectChange);
  dom.videoCacheSearch?.addEventListener('input', handleVideoCacheSearch);
  dom.subsCacheSearch?.addEventListener('input', handleSubsCacheSearch);

  attachEnterBlur(dom.videoCacheSearch);
  attachEnterBlur(dom.subsCacheSearch);
  attachEnterBlur(dom.ytUrl);

  document.querySelectorAll('select').forEach(attachChangeBlur);
  attachChangeBlur(dom.align);
  attachChangeBlur(dom.background);

  const inputsWithHandlers = new Set(
    [dom.videoCacheSearch, dom.subsCacheSearch, dom.ytUrl, dom.subtitleOffsetSeconds, dom.portInput].filter(Boolean)
  );
  document.querySelectorAll('.sidebar input').forEach((input) => {
    if (inputsWithHandlers.has(input)) return;
    attachEnterBlur(input);
  });

  dom.toggleAdvanced?.addEventListener('click', () => setSidebarOpen(true));
  dom.closeAdvanced?.addEventListener('click', () => setSidebarOpen(false));
  dom.sidebarOverlay?.addEventListener('click', () => setSidebarOpen(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (state.previewMaximized) {
        setPreviewMaximized(false);
        dom.previewExpand?.focus();
        return;
      }
      setSidebarOpen(false);
    }
  });

  dom.controlToggle?.addEventListener('click', () => {
    const nextCollapsed = !state.controlCollapsed;
    setControlCollapsed(nextCollapsed);
    if (!nextCollapsed) {
      dom.controlToggle?.focus();
    }
  });
  dom.controlRestore?.addEventListener('click', () => {
    setControlCollapsed(false);
    dom.controlToggle?.focus();
  });

  dom.previewExpand?.addEventListener('click', () => {
    setPreviewMaximized(!state.previewMaximized);
    dom.previewExpand?.focus();
  });

  dom.video?.addEventListener('volumechange', () => {
    persistVolumeSetting(dom.video.volume);
  });

  dom.video?.addEventListener('loadstart', () => setVideoPlaceholder(true));
  dom.video?.addEventListener('loadeddata', () => setVideoPlaceholder(false));
  dom.video?.addEventListener('canplay', () => setVideoPlaceholder(false));
  dom.video?.addEventListener('loadedmetadata', () => setVideoPlaceholder(false));
  dom.video?.addEventListener('emptied', () => setVideoPlaceholder(true));
  dom.video?.addEventListener('error', () => setVideoPlaceholder(true));

  STYLE_INPUT_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', debouncedSyncStyle);
    if (el.tagName === 'INPUT') el.addEventListener('input', debouncedSyncStyle);
  });

  const portEl = dom.portInput;
  if (portEl) {
    if (!portEl.dataset.lastPort) {
      portEl.dataset.lastPort = portEl.value || String(DEFAULT_PORT);
    }
    const persistPortChange = async () => {
      const style = collectStyle();
      const nextPort = style.port;
      const prevPort = Number.parseInt(portEl.dataset.lastPort || String(nextPort), 10);
      const portChanged = Number.isInteger(prevPort) && Number.isInteger(nextPort) ? prevPort !== nextPort : true;
      if (portChanged) {
        overlaySync.stop();
        state.overlayRefreshSeq += 1;
        const clearToken = `port-change-${Date.now()}-${state.overlayRefreshSeq}`;
        window.api.notifyOverlay({ clearToken });
        window.api.notifyOverlay({ clearToken: null });
      }
      await persistStyle(style);
      window.api.notifyOverlay({ style });
      await handlePortChange({ previousPort: prevPort, nextPort });
      portEl.dataset.lastPort = String(nextPort);
    };
    const runPortSync = () => {
      void persistPortChange();
    };
    portEl.addEventListener('blur', runPortSync);
    portEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === 'NumpadEnter') {
        ev.preventDefault();
        portEl.blur();
      }
    });
    portEl.addEventListener('input', () => {
      const value = portEl.value || String(DEFAULT_PORT);
      dom.portView.textContent = value;
    });
  }

  dom.forceDefaultFontToggle?.addEventListener('change', async () => {
    state.forceDefaultFont = dom.forceDefaultFontToggle.checked;
    dom.forceDefaultFontToggle.setAttribute('aria-checked', state.forceDefaultFont ? 'true' : 'false');
    updateFontsLabel();
    const style = collectStyle();
    await persistStyle(style);
    notifyOverlayWithCurrentFonts({ style });
    dom.forceDefaultFontToggle.blur();
  });

  if (dom.subtitleOffsetToggle) {
    dom.subtitleOffsetToggle.addEventListener('click', async () => {
      const nextMode = state.subtitleOffsetMode === 'delay' ? 'advance' : 'delay';
      try {
        await syncSubtitleOffset({ mode: nextMode, refresh: true });
      } finally {
        dom.subtitleOffsetToggle.blur();
      }
    });
  }

  if (dom.subtitleOffsetSeconds) {
    const persistSubtitleSeconds = () => {
      void syncSubtitleOffset({ seconds: dom.subtitleOffsetSeconds.value, refresh: true });
    };
    dom.subtitleOffsetSeconds.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === 'NumpadEnter') {
        ev.preventDefault();
        dom.subtitleOffsetSeconds.blur();
      }
    });
    dom.subtitleOffsetSeconds.addEventListener('blur', persistSubtitleSeconds);
  }

  dom.applyToOverlay?.addEventListener('click', async () => {
    const style = collectStyle();
    await persistStyle(style);
    state.overlayRefreshSeq += 1;
    const refreshToken = `${Date.now()}-${state.overlayRefreshSeq}`;
    notifyOverlayWithCurrentFonts({
      style,
      subContent: state.currentAssText,
      refreshToken
    });
    dom.applyMsg.textContent = `已更新。請以 OBS Browser Source 指向 http://localhost:${style.port}/overlay 或使用REALESE 中的 HTML 檔案。`;
    syncOverlayConnection();
  });

  dom.clearOverlay?.addEventListener('click', () => {
    state.overlayRefreshSeq += 1;
    const clearToken = `clear-${Date.now()}-${state.overlayRefreshSeq}`;
    window.api.notifyOverlay({ clearToken });
    window.api.notifyOverlay({ clearToken: null });
    const port = getCurrentPort();
    dom.applyMsg.textContent = `已清除 Overlay 畫面，持續播放仍會顯示後續字幕。如需重新載入請使用 http://localhost:${port}/overlay。`;
    syncOverlayConnection();
  });
}

async function loadInitialConfig() {
  const cfg = await window.api.getConfig();
  const storedFonts = Array.isArray(cfg?.fonts) ? cfg.fonts.map(normalizeFontBuffer).filter(Boolean) : [];
  state.currentFonts = storedFonts;

  const output = cfg?.output || {};
  state.forceDefaultFont = output?.forceDefaultFont !== false;
  const storedDefaultFamilyRaw = typeof output?.defaultFontFamily === 'string' ? output.defaultFontFamily.trim() : '';
  const computedDefaultFamily = deriveDefaultFontFamily({ fonts: storedFonts, forceDefault: state.forceDefaultFont });
  state.defaultFontFamily = storedDefaultFamilyRaw || computedDefaultFamily;

  if (dom.forceDefaultFontToggle) {
    dom.forceDefaultFontToggle.checked = state.forceDefaultFont;
    dom.forceDefaultFontToggle.setAttribute('aria-checked', state.forceDefaultFont ? 'true' : 'false');
  }
  updateFontsLabel(storedFonts);

  const configuredPort = Number.parseInt(output.port, 10);
  const effectivePort = Number.isInteger(configuredPort) ? configuredPort : DEFAULT_PORT;
  if (dom.portInput) {
    dom.portInput.value = String(effectivePort);
    dom.portInput.dataset.lastPort = String(effectivePort);
  }
  if (output.maxWidth != null) dom.maxWidth.value = String(output.maxWidth);
  if (output.maxHeight != null) dom.maxHeight.value = String(output.maxHeight);

  if (dom.align) {
    dom.align.value = normalizeAlignValue(output.align ?? dom.align.value);
    refreshCustomSelect(dom.align);
  }
  if (output.background) dom.background.value = output.background;
  refreshCustomSelect(dom.background);

  const defaultModeRaw = output?.subtitleOffsetDefaults?.mode ?? output.subtitleOffsetMode;
  const defaultSecondsRaw = output?.subtitleOffsetDefaults?.seconds ?? output.subtitleOffsetSeconds;
  state.subtitleOffsetDefaults = {
    mode: normalizeSubtitleOffsetMode(defaultModeRaw),
    seconds: sanitizeSubtitleOffsetSeconds(defaultSecondsRaw)
  };
  state.subtitleOffsetOverrides = normalizeSubtitleOffsetOverrides(output?.subtitleOffsetOverrides, state.subtitleOffsetDefaults);
  setSubtitleOffsetState(state.subtitleOffsetDefaults);

  const hasMediaForOffset = Boolean(resolveMediaKey(state.activeVideoId));
  setSubtitleOffsetControlsEnabled(hasMediaForOffset && Boolean(state.activeSubsId));

  const remoteTimelineEnabled = cfg?.player?.useRemoteTimeline === true;
  setRemoteTimelineEnabled(remoteTimelineEnabled, { persist: false });

  const storedVolume = cfg?.player?.volume;
  const initialVolume = clampVolume(storedVolume != null ? storedVolume : dom.video?.volume ?? 1);
  state.playerVolume = initialVolume;
  if (dom.video) dom.video.volume = initialVolume;

  const portDisplayValue = dom.portInput?.value || String(DEFAULT_PORT);
  dom.portView.textContent = portDisplayValue;
  dom.cookiesView.textContent = cfg?.cookiesPath ? cfg.cookiesPath : '(未設定)';

  const style = collectStyle();
  notifyOverlayWithCurrentFonts({ style }, { includeWhenDisabled: true });
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

(async function init() {
  initializeCacheControls();
  setupCustomSelects();
  setupEventHandlers();
  applyControlVisibility();
  applyPreviewMaximized();
  setVideoPlaceholder(!dom.video?.currentSrc);

  await loadInitialConfig();
  await loadBinInfo();
  await refreshCachedEntries();

  window.api.onYtProgress(handleYtProgress);
  window.api.onBinProgress(handleBinProgress);
})();
