const $ = (selector) => document.querySelector(selector);

const dom = {
  appShell: document.querySelector('.app-shell'),
  binInfo: $('#binInfo'),
  mainArea: document.querySelector('.main-area'),
  controlCard: $('#controlCard'),
  controlToggle: $('#controlCardToggle'),
  controlRestore: $('#controlCardRestore'),
  previewExpand: $('#previewExpand'),
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
  useRemoteTimelineToggle: $('#useRemoteTimelineToggle'),
  ytUrl: $('#ytUrl'),
  fontsPicked: $('#fontsPicked'),
  pickCookies: $('#pickCookies'),
  clearCookies: $('#clearCookies'),
  checkBins: $('#checkBins'),
  pickSubs: $('#pickSubs'),
  pickFonts: $('#pickFonts'),
  clearFonts: $('#clearFonts'),
  forceDefaultFontToggle: $('#forceDefaultFontToggle'),
  ytDownload: $('#ytDownload'),
  ytDownloadAudio: $('#ytDownloadAudio'),
  ytCancel: $('#ytCancel'),
  ytFetch: $('#ytFetch'),
  background: $('#background'),
  align: $('#align'),
  maxWidth: $('#maxWidth'),
  maxHeight: $('#maxHeight'),
  subtitleOffsetToggle: $('#subtitleOffsetToggle'),
  subtitleOffsetSeconds: $('#subtitleOffsetSeconds'),
  applyToOverlay: $('#applyToOverlay'),
  clearOverlay: $('#clearOverlay'),
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

const customSelectRegistry = new Map();

function setupCustomSelects(root = document) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  const selects = Array.from(root.querySelectorAll('select'));
  selects.forEach((select) => {
    if (!select || customSelectRegistry.has(select)) return;
    const controller = enhanceCustomSelect(select);
    if (controller) {
      customSelectRegistry.set(select, controller);
      controller.refresh({ rebuildOptions: true });
    }
  });
}

function refreshCustomSelect(select, { rebuildOptions = false } = {}) {
  if (!select) return;
  const controller = customSelectRegistry.get(select);
  if (controller) {
    controller.refresh({ rebuildOptions });
  }
}

function enhanceCustomSelect(select) {
  if (!select || select.dataset?.customSelect === 'enhanced') return null;
  const parent = select.parentElement;
  if (!parent) return null;

  const wrapper = document.createElement('div');
  wrapper.className = 'custom-select';
  const inlineStyle = select.getAttribute('style');
  if (inlineStyle) wrapper.setAttribute('style', inlineStyle);
  parent.insertBefore(wrapper, select);
  wrapper.appendChild(select);

  select.classList.add('custom-select__native');
  select.dataset.customSelect = 'enhanced';
  select.setAttribute('aria-hidden', 'true');
  select.tabIndex = -1;

  const uniqueKey = select.id || select.name || `custom-select-${customSelectRegistry.size + 1}`;
  const listId = `${uniqueKey}-listbox`;
  const displayId = `${uniqueKey}-value`;
  const triggerId = `${uniqueKey}-trigger`;

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'custom-select__trigger';
  trigger.id = triggerId;
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', listId);

  const display = document.createElement('span');
  display.className = 'custom-select__display';
  const marquee = document.createElement('span');
  marquee.className = 'custom-select__marquee';
  marquee.dataset.paused = 'false';
  const primaryText = document.createElement('span');
  primaryText.className = 'custom-select__text';
  primaryText.id = displayId;
  const cloneText = document.createElement('span');
  cloneText.className = 'custom-select__text custom-select__text--clone';
  marquee.append(primaryText, cloneText);
  display.appendChild(marquee);
  trigger.appendChild(display);

  const icon = document.createElement('span');
  icon.className = 'custom-select__icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="6 9 12 15 18 9"></polyline>
    </svg>
  `;
  trigger.appendChild(icon);

  const list = document.createElement('ul');
  list.className = 'custom-select__list';
  list.id = listId;
  list.setAttribute('role', 'listbox');
  list.tabIndex = -1;
  list.hidden = true;

  wrapper.appendChild(trigger);
  wrapper.appendChild(list);

  const labelIds = [];
  if (select.id) {
    const labels = document.querySelectorAll(`label[for="${select.id}"]`);
    labels.forEach((label, idx) => {
      if (!label.id) {
        label.id = `${uniqueKey}-label${idx ? `-${idx}` : ''}`;
      }
      label.addEventListener('click', (ev) => {
        ev.preventDefault();
        trigger.focus();
        openMenu();
      });
      labelIds.push(label.id);
    });
  }
  if (labelIds.length) {
    trigger.setAttribute('aria-labelledby', `${labelIds.join(' ')} ${displayId}`.trim());
  } else {
    trigger.setAttribute('aria-labelledby', displayId);
  }

  let optionButtons = [];
  let activeIndex = -1;
  let isOpen = false;
  let mirroredClasses = new Set();

  const hasResizeObserver = typeof ResizeObserver === 'function';
  const resizeObserver = hasResizeObserver
    ? new ResizeObserver(() => {
        updateMarquee();
      })
    : null;
  if (resizeObserver) {
    resizeObserver.observe(display);
    resizeObserver.observe(primaryText);
  } else {
    window.addEventListener('resize', updateMarquee, { passive: true });
  }

  const observer = new MutationObserver((mutations) => {
    let shouldRebuild = false;
    let shouldRefreshSelection = false;
    let shouldSyncMeta = false;
    for (const mutation of mutations) {
      if (mutation.type === 'childList' || mutation.type === 'characterData') {
        shouldRebuild = true;
        continue;
      }
      if (mutation.type === 'attributes') {
        const target = mutation.target;
        if (target === select) {
          if (mutation.attributeName === 'style') shouldSyncMeta = true;
          if (mutation.attributeName === 'class') shouldSyncMeta = true;
          if (mutation.attributeName === 'disabled') shouldSyncMeta = true;
        } else if (target instanceof HTMLOptionElement || target instanceof HTMLOptGroupElement) {
          if (mutation.attributeName === 'label' || mutation.attributeName === 'value') shouldRebuild = true;
          if (mutation.attributeName === 'disabled') shouldRebuild = true;
          if (mutation.attributeName === 'selected') shouldRefreshSelection = true;
        }
      }
    }
    if (shouldRebuild) {
      rebuildOptions();
      shouldRefreshSelection = false;
    }
    if (shouldRefreshSelection) {
      updateSelection({ preserveActive: isOpen });
    }
    if (shouldSyncMeta || shouldRebuild) {
      syncDisabledState();
      syncMirroredClasses();
      syncInlineStyle();
      updateMarquee();
    }
  });
  observer.observe(select, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true
  });

  const handleDocumentPointerDown = (event) => {
    if (!wrapper.contains(event.target)) {
      closeMenu();
    }
  };

  function findNextEnabledIndex(startIndex, step) {
    const options = select.options;
    if (!options.length) return -1;
    let index = startIndex;
    for (let i = 0; i < options.length; i += 1) {
      if (index < 0) index = options.length - 1;
      if (index >= options.length) index = 0;
      const option = options[index];
      if (option && !option.disabled) return index;
      index += step;
    }
    return -1;
  }

  function highlightActive({ scrollIntoView = false } = {}) {
    const options = select.options;
    optionButtons.forEach((btn, idx) => {
      const option = options[idx];
      const isActive = idx === activeIndex && option && !option.disabled;
      btn.classList.toggle('is-active', isActive);
    });
    if (isOpen && optionButtons[activeIndex]) {
      trigger.setAttribute('aria-activedescendant', optionButtons[activeIndex].id);
      if (scrollIntoView) {
        optionButtons[activeIndex].scrollIntoView({ block: 'nearest' });
      }
    } else {
      trigger.removeAttribute('aria-activedescendant');
    }
  }

  function setActiveIndex(index, { scrollIntoView = false } = {}) {
    const options = select.options;
    if (!options.length) {
      activeIndex = -1;
      highlightActive({ scrollIntoView: false });
      return;
    }
    let target = index;
    if (target < 0 || target >= options.length || options[target]?.disabled) {
      target = findNextEnabledIndex(index, 1);
      if (target === -1) target = findNextEnabledIndex(index, -1);
    }
    activeIndex = target;
    highlightActive({ scrollIntoView });
  }

  function updateSelection({ preserveActive = false } = {}) {
    const options = Array.from(select.options);
    let selectedIndex = select.selectedIndex;
    if (selectedIndex < 0) {
      selectedIndex = options.findIndex((option) => option?.selected);
    }
    optionButtons.forEach((btn, idx) => {
      const option = options[idx];
      const isSelected = option ? option.selected : false;
      btn.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    });
    const selectedOption = options[selectedIndex] || options.find((option) => option && !option.disabled) || null;
    const label = selectedOption ? (selectedOption.textContent || selectedOption.label || '') : '';
    primaryText.textContent = label;
    cloneText.textContent = label;
    if (selectedOption?.title) trigger.title = selectedOption.title;
    else trigger.removeAttribute('title');
    if (!preserveActive) {
      if (selectedIndex != null && selectedIndex >= 0 && options[selectedIndex] && !options[selectedIndex].disabled) {
        activeIndex = selectedIndex;
      } else {
        activeIndex = findNextEnabledIndex(0, 1);
      }
    }
    highlightActive({ scrollIntoView: false });
    updateMarquee();
  }

  function rebuildOptions() {
    optionButtons = [];
    list.innerHTML = '';
    Array.from(select.options).forEach((option, index) => {
      const optionEl = document.createElement('li');
      optionEl.className = 'custom-select__option';
      optionEl.setAttribute('role', 'option');
      optionEl.id = `${listId}-option-${index}`;
      optionEl.textContent = option?.textContent || option?.label || '';
      optionEl.dataset.index = String(index);
      optionEl.dataset.value = option?.value ?? '';
      if (option?.title) optionEl.title = option.title;
      if (option?.disabled) optionEl.setAttribute('aria-disabled', 'true');
      optionEl.setAttribute('aria-selected', option?.selected ? 'true' : 'false');
      optionEl.addEventListener('click', () => {
        if (option?.disabled) return;
        setActiveIndex(index, { scrollIntoView: false });
        commitIndex(index);
      });
      optionEl.addEventListener('pointerenter', () => {
        if (!isOpen || option?.disabled) return;
        setActiveIndex(index, { scrollIntoView: false });
      });
      optionButtons.push(optionEl);
      list.appendChild(optionEl);
    });
    updateSelection({ preserveActive: isOpen });
  }

  function syncDisabledState() {
    const disabled = select.disabled;
    trigger.disabled = disabled;
    trigger.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    wrapper.classList.toggle('is-disabled', disabled);
    if (disabled && isOpen) {
      closeMenu();
    }
  }

  function syncMirroredClasses() {
    const classes = Array.from(select.classList || []).filter((cls) => cls !== 'custom-select__native');
    const next = new Set(classes);
    Array.from(mirroredClasses).forEach((cls) => {
      if (!next.has(cls)) {
        wrapper.classList.remove(cls);
        mirroredClasses.delete(cls);
      }
    });
    next.forEach((cls) => {
      if (cls && !mirroredClasses.has(cls)) {
        wrapper.classList.add(cls);
        mirroredClasses.add(cls);
      }
    });
  }

  function syncInlineStyle() {
    const style = select.getAttribute('style');
    if (style) wrapper.setAttribute('style', style);
    else wrapper.removeAttribute('style');
  }

  function updateMarquee() {
    const containerWidth = display.offsetWidth;
    const textWidth = primaryText.scrollWidth;
    if (!containerWidth || !textWidth) {
      marquee.classList.remove('is-marquee');
      marquee.dataset.paused = 'false';
      cloneText.textContent = '';
      marquee.style.removeProperty('--marquee-distance');
      marquee.style.removeProperty('--marquee-duration');
      return;
    }
    if (textWidth > containerWidth + 2) {
      marquee.classList.add('is-marquee');
      cloneText.textContent = primaryText.textContent;
      const gapValue = (() => {
        const style = window.getComputedStyle(marquee);
        const gap = parseFloat(style.columnGap || style.gap || '0');
        return Number.isFinite(gap) ? gap : 0;
      })();
      const distance = textWidth + gapValue;
      const duration = Math.max(6, Math.min(30, distance / 36));
      marquee.style.setProperty('--marquee-distance', `${distance}px`);
      marquee.style.setProperty('--marquee-duration', `${duration}s`);
      marquee.dataset.paused = marquee.dataset.paused === 'true' ? 'true' : 'false';
    } else {
      marquee.classList.remove('is-marquee');
      marquee.dataset.paused = 'false';
      cloneText.textContent = '';
      marquee.style.removeProperty('--marquee-distance');
      marquee.style.removeProperty('--marquee-duration');
    }
  }

  function moveActive(step) {
    const options = select.options;
    if (!options.length) return;
    if (activeIndex < 0) {
      setActiveIndex(findNextEnabledIndex(step > 0 ? 0 : options.length - 1, step), { scrollIntoView: true });
      return;
    }
    let index = activeIndex;
    for (let i = 0; i < options.length; i += 1) {
      index = (index + step + options.length) % options.length;
      const option = options[index];
      if (option && !option.disabled) {
        setActiveIndex(index, { scrollIntoView: true });
        return;
      }
    }
  }

  function commitIndex(index) {
    const options = select.options;
    const option = options[index];
    if (!option || option.disabled) return;
    const previousValue = select.value;
    select.selectedIndex = index;
    const changed = select.value !== previousValue;
    updateSelection({ preserveActive: false });
    if (changed) {
      const inputEvent = new Event('input', { bubbles: true });
      select.dispatchEvent(inputEvent);
      const changeEvent = new Event('change', { bubbles: true });
      select.dispatchEvent(changeEvent);
    }
    closeMenu({ focusTrigger: true });
  }

  function openMenu() {
    if (isOpen || select.disabled) return;
    isOpen = true;
    wrapper.classList.add('is-open');
    trigger.setAttribute('aria-expanded', 'true');
    list.hidden = false;
    const initialIndex = select.selectedIndex >= 0 ? select.selectedIndex : findNextEnabledIndex(0, 1);
    setActiveIndex(initialIndex >= 0 ? initialIndex : 0, { scrollIntoView: true });
    document.addEventListener('pointerdown', handleDocumentPointerDown, true);
  }

  function closeMenu({ focusTrigger = false } = {}) {
    if (!isOpen) return;
    isOpen = false;
    wrapper.classList.remove('is-open');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-activedescendant');
    list.hidden = true;
    document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
    if (focusTrigger) {
      trigger.focus();
    }
  }

  trigger.addEventListener('click', () => {
    if (select.disabled) return;
    if (isOpen) closeMenu();
    else openMenu();
  });

  trigger.addEventListener('keydown', (event) => {
    switch (event.key) {
      case 'ArrowDown':
      case 'Down':
        event.preventDefault();
        if (!isOpen) openMenu();
        moveActive(1);
        break;
      case 'ArrowUp':
      case 'Up':
        event.preventDefault();
        if (!isOpen) openMenu();
        moveActive(-1);
        break;
      case 'Home':
        event.preventDefault();
        if (!isOpen) openMenu();
        setActiveIndex(findNextEnabledIndex(0, 1), { scrollIntoView: true });
        break;
      case 'End':
        event.preventDefault();
        if (!isOpen) openMenu();
        setActiveIndex(findNextEnabledIndex(select.options.length - 1, -1), { scrollIntoView: true });
        break;
      case ' ': // Space
      case 'Spacebar':
      case 'Enter':
        event.preventDefault();
        if (isOpen) {
          commitIndex(activeIndex >= 0 ? activeIndex : select.selectedIndex);
        } else {
          openMenu();
        }
        break;
      case 'Escape':
      case 'Esc':
        if (isOpen) {
          event.preventDefault();
          closeMenu({ focusTrigger: true });
        }
        break;
      case 'Tab':
        closeMenu();
        break;
      default:
        break;
    }
  });

  wrapper.addEventListener('focusout', (event) => {
    if (!wrapper.contains(event.relatedTarget)) {
      closeMenu();
    }
  });

  trigger.addEventListener('mouseenter', () => {
    if (marquee.classList.contains('is-marquee')) {
      marquee.dataset.paused = 'true';
    }
  });
  trigger.addEventListener('mouseleave', () => {
    marquee.dataset.paused = 'false';
  });

  select.addEventListener('change', () => {
    updateSelection({ preserveActive: isOpen });
    syncDisabledState();
    syncMirroredClasses();
  });
  select.addEventListener('input', () => {
    updateSelection({ preserveActive: isOpen });
    syncDisabledState();
    syncMirroredClasses();
  });

  const refreshController = ({ rebuildOptions: shouldRebuild = false } = {}) => {
    if (shouldRebuild) {
      rebuildOptions();
    } else {
      updateSelection({ preserveActive: isOpen });
    }
    syncDisabledState();
    syncMirroredClasses();
    syncInlineStyle();
    updateMarquee();
  };

  return {
    refresh: refreshController
  };
}

const videoCacheControls = createCacheSelector(dom.videoFile?.closest('.row'), {
  searchPlaceholder: '搜尋影片或音訊...'
});
dom.videoCacheSelect = videoCacheControls?.select || null;
dom.videoCacheSearch = videoCacheControls?.search || null;

const subsCacheControls = createCacheSelector(dom.pickSubs?.closest('.row'), {
  searchPlaceholder: '搜尋字幕...'
});
dom.subsCacheSelect = subsCacheControls?.select || null;
dom.subsCacheSearch = subsCacheControls?.search || null;

setupCustomSelects();

const state = {
  currentAssText: '',
  currentFonts: [],
  forceDefaultFont: true,
  defaultFontFamily: 'NotoSans-Regular',
  jobId: null,
  activeDownloadMode: null,
  cachedEntries: [], // { id, title, videoFilename, subsFilename, ... }
  activeVideoId: '',
  activeSubsId: '',
  videoSearch: '',
  subsSearch: '',
  objectUrl: '',
  binProgress: new Map(),
  binInfoRefreshTimer: null,
  controlCollapsed: false,
  previewMaximized: false,
  downloadProgressStarted: false,
  downloadStatusMessage: '',
  playerVolume: 1,
  useRemoteTimeline: false,
  remoteNowPlaying: null,
  remoteLastGuid: '',
  remoteLastUpdate: 0,
  remoteMediaKey: '',
  subtitleOffsetMode: 'advance',
  subtitleOffsetSeconds: 0,
  subtitleOffsetDefaults: { mode: 'advance', seconds: 0 },
  subtitleOffsetOverrides: {},
  overlayRefreshSeq: 0
};

const ALIGN_OPTIONS = new Set([
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

const BUILTIN_DEFAULT_FONT_FAMILY = 'NotoSans-Regular';
const FONT_MANAGEMENT_DISABLED_HINT = '需開啟強制覆蓋 Default 樣式字型後才能操作';

function normalizeAlignValue(raw) {
  if (raw == null) return 'off';
  const value = String(raw).trim().toLowerCase();
  if (!value || value === 'off' || value === 'none' || value === 'disabled') return 'off';
  const mapped = LEGACY_ALIGN_MAP[value] || value;
  if (mapped === 'off') return 'off';
  return ALIGN_OPTIONS.has(mapped) ? mapped : 'off';
}

function normalizeDimension(raw, fallback) {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function persistPlayerConfig({ volume = state.playerVolume, useRemoteTimeline = state.useRemoteTimeline } = {}) {
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

const persistVolumeSetting = debounce((volume) => {
  const normalized = clampVolume(volume);
  state.playerVolume = normalized;
  persistPlayerConfig({ volume: normalized });
}, 240);
/* ---------------- Overlay 時間同步 ---------------- */
class OverlaySync {
  constructor(videoEl) {
    this.ws = null;
    this.timer = null;
    this.port = 59837;
    this.video = videoEl;
    this.pendingTime = null;
    this.nowPlayingHandler = null;

    this.handleWsOpen = this.handleWsOpen.bind(this);
    this.handleWsClose = this.handleWsClose.bind(this);
    this.handleWsError = this.handleWsError.bind(this);
    this.handleWsMessage = this.handleWsMessage.bind(this);
  }
  setNowPlayingHandler(handler) {
    this.nowPlayingHandler = typeof handler === 'function' ? handler : null;
  }
  connect(port) {
    const parsed = Number.parseInt(port, 10);
    const targetPort = Number.isFinite(parsed) && parsed > 0 ? parsed : this.port;
    const samePort = this.ws?.url ? this.ws.url.endsWith(`:${targetPort}`) : false;
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
  }
  handleWsClose(event) {
    if (event?.target) this.detachWs(event.target);
    if (event?.target === this.ws) {
      this.ws = null;
    }
  }
  handleWsError() {
    // suppress connection errors to keep renderer logs quiet
  }
  handleWsMessage(event) {
    if (!this.nowPlayingHandler || !event?.data) return;
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (!data || typeof data !== 'object') return;
    if (data.type === 'nowPlaying' && data.payload) {
      this.nowPlayingHandler(data.payload);
    } else if (!data.type && looksLikeNowPlayingPayload(data)) {
      this.nowPlayingHandler(data);
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
}

const overlaySync = new OverlaySync(dom.video);
overlaySync.setNowPlayingHandler(handleRemoteNowPlaying);
const REMOTE_TIME_EPSILON = 0.25;

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
  const status = normalizeStr(raw.status).toLowerCase() || 'unknown';
  const artists = Array.isArray(raw.artists)
    ? raw.artists.map((name) => normalizeStr(name)).filter(Boolean)
    : [];
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
    songLink: normalizeStr(raw.song_link),
    platform: normalizeStr(raw.platform),
    isLive: raw.is_live === true,
    receivedAt: Date.now()
  };
}

function handleRemoteNowPlaying(raw) {
  const payload = normalizeNowPlayingPayload(raw);
  if (!payload) return;
  state.remoteNowPlaying = payload;
  if (payload.guid) state.remoteLastGuid = payload.guid;
  state.remoteLastUpdate = payload.receivedAt;
  const derivedKey = getRemoteMediaKey(payload) || '';
  const previousKey = state.remoteMediaKey || '';
  if (derivedKey) state.remoteMediaKey = derivedKey;
  if (state.useRemoteTimeline) {
    const keyChanged = derivedKey && derivedKey !== previousKey;
    applyRemoteTimeline(payload);
    if (keyChanged && state.activeSubsId) {
      applySubtitleOffsetForSelection({ subsId: state.activeSubsId, notify: true });
    }
    applyRemoteMediaUiState();
    updateVideoCacheSelect(state.activeVideoId);
  }
  updateActiveCacheInfo();
}

function applyRemoteTimeline(payload) {
  if (!payload) return;
  const video = dom.video;
  if (video && video.readyState >= 1) {
    if (Number.isFinite(payload.progressSeconds)) {
      const current = Number(video.currentTime || 0);
      if (!Number.isFinite(current) || Math.abs(current - payload.progressSeconds) > REMOTE_TIME_EPSILON) {
        try { video.currentTime = payload.progressSeconds; } catch { /* noop */ }
      }
    }
    if (payload.status === 'playing') {
      video.play().catch(() => { /* ignore autoplay errors */ });
    } else if (payload.status === 'paused' || payload.status === 'stopped') {
      try { video.pause(); } catch { /* noop */ }
    }
  }
}


function updateRemoteToggleUI() {
  if (!dom.useRemoteTimelineToggle) return;
  dom.useRemoteTimelineToggle.checked = Boolean(state.useRemoteTimeline);
  dom.useRemoteTimelineToggle.setAttribute('aria-checked', state.useRemoteTimeline ? 'true' : 'false');
}

function getRemoteMediaLabel(remote = state.remoteNowPlaying) {
  if (!remote || typeof remote !== 'object') return '外部時間軸已啟用';
  const parts = [];
  if (remote.title) parts.push(remote.title);
  if (Array.isArray(remote.artists) && remote.artists.length) parts.push(remote.artists.join(', '));
  if (!parts.length && remote.platform) parts.push(remote.platform);
  return parts.length ? parts.join(' - ') : '外部時間軸已啟用';
}

function applyRemoteMediaUiState() {
  const usingRemote = Boolean(state.useRemoteTimeline);
  if (dom.videoCacheSearch) {
    dom.videoCacheSearch.disabled = usingRemote;
    dom.videoCacheSearch.classList.toggle('is-remote-disabled', usingRemote);
  }
  if (dom.pickVideo) {
    dom.pickVideo.disabled = usingRemote;
    dom.pickVideo.classList.toggle('is-remote-disabled', usingRemote);
  }
  const select = dom.videoCacheSelect;
  if (!select) return;
  select.classList.toggle('is-remote-disabled', usingRemote);
  if (usingRemote) {
    const label = getRemoteMediaLabel();
    select.innerHTML = '';
    const option = new Option(label, '', true, true);
    option.disabled = true;
    select.add(option);
    select.disabled = true;
  } else {
    select.disabled = false;
  }
  refreshCustomSelect(select, { rebuildOptions: true });
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
  updateVideoCacheSelect(state.activeVideoId);
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

function normalizeFontBuffer(font) {
  if (!font || typeof font !== 'object') return null;
  const normalized = {};
  if (typeof font.name === 'string' && font.name) normalized.name = font.name;
  if (typeof font.data === 'string' && font.data) normalized.data = font.data;
  if (typeof font.url === 'string' && font.url) normalized.url = font.url;
  return normalized.data || normalized.url ? normalized : null;
}

function describeFontName(font) {
  if (!font || typeof font !== 'object') return '';
  if (typeof font.name === 'string' && font.name) return font.name;
  if (typeof font.url === 'string' && font.url) {
    const parts = font.url.split(/[\\/]/);
    return parts[parts.length - 1] || font.url;
  }
  return '';
}

function sanitizeFontFamilyName(rawName) {
  if (typeof rawName !== 'string') return '';
  const trimmed = rawName.trim();
  if (!trimmed) return '';
  const withoutExt = trimmed.replace(/\.[^.]+$/, '');
  return withoutExt.trim();
}

function deriveDefaultFontFamily({ fonts = state.currentFonts, forceDefault = state.forceDefaultFont } = {}) {
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

function updateFontControlsAvailability() {
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

function updateFontsLabel(fonts = state.currentFonts) {
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
    dom.fontsPicked.textContent = '未匯入字型';
  }
  updateFontControlsAvailability();
}

function getFontPayloadForOverlay({ includeWhenDisabled = false } = {}) {
  if (!includeWhenDisabled && state.forceDefaultFont === false) return null;
  return Array.isArray(state.currentFonts) ? state.currentFonts : [];
}

function notifyOverlayWithCurrentFonts(patch = {}, options = {}) {
  const fontPayload = getFontPayloadForOverlay(options);
  const message = { ...patch };
  if (fontPayload != null) {
    message.fontBuffers = fontPayload;
  }
  window.api.notifyOverlay(message);
}

const OFFSET_EPSILON = 1e-6;
const SUBTITLE_OFFSET_LABELS = {
  advance: '字幕提前',
  delay: '字幕延後'
};

function normalizeSubtitleOffsetMode(value) {
  return value === 'delay' ? 'delay' : 'advance';
}

function sanitizeSubtitleOffsetSeconds(value) {
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

function updateSubtitleOffsetUI() {
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

function setSubtitleOffsetState({ mode, seconds } = {}) {
  state.subtitleOffsetMode = normalizeSubtitleOffsetMode(mode);
  state.subtitleOffsetSeconds = sanitizeSubtitleOffsetSeconds(seconds);
  if (dom.subtitleOffsetSeconds) {
    dom.subtitleOffsetSeconds.value = String(state.subtitleOffsetSeconds);
  }
  updateSubtitleOffsetUI();
}

function setSubtitleOffsetControlsEnabled(enabled) {
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

function offsetsEqual(a, b) {
  if (!a || !b) return false;
  const modeA = normalizeSubtitleOffsetMode(a.mode);
  const modeB = normalizeSubtitleOffsetMode(b.mode);
  const secondsA = sanitizeSubtitleOffsetSeconds(a.seconds);
  const secondsB = sanitizeSubtitleOffsetSeconds(b.seconds);
  return modeA === modeB && Math.abs(secondsA - secondsB) <= OFFSET_EPSILON;
}

function getRemoteMediaKey(remote = state.remoteNowPlaying) {
  if (!state.useRemoteTimeline) return '';
  if (!remote || typeof remote !== 'object') return '';
  const link = typeof remote.songLink === 'string' ? remote.songLink.trim() : '';
  if (link) return `remote:song:${link}`;
  const guid = typeof remote.guid === 'string' ? remote.guid.trim() : '';
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

function resolveMediaKey(videoId = state.activeVideoId) {
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

function buildSubtitleOffsetKey(mediaKey, subsId) {
  return [mediaKey || '', subsId || ''].join('::');
}

function makeSubtitleOffsetKey(videoId = state.activeVideoId, subsId = state.activeSubsId) {
  const mediaKey = resolveMediaKey(videoId);
  return buildSubtitleOffsetKey(mediaKey, subsId);
}

function normalizeSubtitleOffsetOverrides(raw, defaults = state.subtitleOffsetDefaults) {
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

function resolveSubtitleOffset({ videoId = state.activeVideoId, subsId = state.activeSubsId } = {}) {
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

function applySubtitleOffsetForSelection({ videoId = state.activeVideoId, subsId = state.activeSubsId, notify = true } = {}) {
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

async function syncSubtitleOffset({ mode = null, seconds = null, refresh = false } = {}) {
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

/* ---------------- 初始化 ---------------- */
(async function init() {
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
  if (output.port != null) dom.portInput.value = String(output.port);
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
  dom.portView.textContent = dom.portInput.value || '';
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

  const inputsWithHandlers = new Set([
    dom.videoCacheSearch,
    dom.subsCacheSearch,
    dom.ytUrl,
    dom.subtitleOffsetSeconds,
    dom.portInput
  ].filter(Boolean));
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
    const volume = clampVolume(dom.video.volume);
    state.playerVolume = volume;
    persistVolumeSetting(volume);
  });

  dom.video?.addEventListener('loadstart', () => setVideoPlaceholder(true));
  dom.video?.addEventListener('loadeddata', () => setVideoPlaceholder(false));
  dom.video?.addEventListener('canplay', () => setVideoPlaceholder(false));
  dom.video?.addEventListener('loadedmetadata', () => setVideoPlaceholder(false));
  dom.video?.addEventListener('emptied', () => setVideoPlaceholder(true));
  dom.video?.addEventListener('error', () => setVideoPlaceholder(true));

  // Sync style on change for most controls, but handle `port` specially
  ['background', 'align', 'maxWidth', 'maxHeight'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', debouncedSyncStyle);
    if (el.tagName === 'INPUT') el.addEventListener('input', debouncedSyncStyle);
  });

  // Port should apply when the field loses focus or when the user presses Enter.
  const portEl = document.getElementById('port');
  if (portEl) {
    const persistPortChange = async () => {
      const style = collectStyle();
      await persistStyle(style);
      window.api.notifyOverlay({ style });
      syncOverlayConnection();
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
  }

  dom.portInput?.addEventListener('input', () => {
    dom.portView.textContent = dom.portInput.value || '';
  });

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

function setControlCollapsed(collapsed) {
  state.controlCollapsed = Boolean(collapsed);
  applyControlVisibility();
}

function applyControlVisibility() {
  const collapsed = state.controlCollapsed;
  const toggle = dom.controlToggle;
  const minimizeLabel = toggle?.dataset?.labelMinimize || '最小化控制區';
  const restoreLabel = toggle?.dataset?.labelRestore || '顯示控制區';
  if (dom.controlCard) {
    dom.controlCard.classList.toggle('card-collapsed', collapsed);
    dom.controlCard.style.display = collapsed ? 'none' : '';
  }
  dom.mainArea?.classList.toggle('controls-collapsed', collapsed);
  if (dom.controlRestore) {
    dom.controlRestore.textContent = restoreLabel;
    dom.controlRestore.setAttribute('aria-label', restoreLabel);
    dom.controlRestore.setAttribute('aria-controls', 'controlCard');
    dom.controlRestore.classList.toggle('visible', collapsed);
    dom.controlRestore.setAttribute('aria-hidden', collapsed ? 'false' : 'true');
    dom.controlRestore.title = restoreLabel;
    dom.controlRestore.disabled = !collapsed;
    dom.controlRestore.setAttribute('tabindex', collapsed ? '0' : '-1');
  }
  if (toggle) {
    const label = collapsed ? restoreLabel : minimizeLabel;
    toggle.textContent = label;
    toggle.setAttribute('aria-label', label);
    toggle.setAttribute('aria-controls', 'controlCard');
    toggle.setAttribute('aria-expanded', String(!collapsed));
  }
}

function setPreviewMaximized(maximized) {
  state.previewMaximized = Boolean(maximized);
  applyPreviewMaximized();
}

function applyPreviewMaximized() {
  const maximized = Boolean(state.previewMaximized);
  dom.appShell?.classList.toggle('preview-maximized', maximized);
  document.body.classList.toggle('preview-maximized', maximized);
  const btn = dom.previewExpand;
  if (btn) {
    const expandLabel = btn.dataset?.labelExpand || '最大化預覽';
    const collapseLabel = btn.dataset?.labelCollapse || '恢復預覽大小';
    const label = maximized ? collapseLabel : expandLabel;
    btn.textContent = label;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', String(maximized));
    btn.setAttribute('title', label);
  }
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
  if (show) {
    dom.dlProg.style.display = 'block';
    dom.dlProg.max = 100;
    dom.dlProg.removeAttribute('value');
    state.downloadProgressStarted = false;
  } else {
    dom.dlProg.style.display = 'none';
    dom.dlProg.value = 0;
    dom.dlProg.removeAttribute('value');
    state.downloadProgressStarted = false;
  }
}

function updateDownloadStatus(message = '') {
  const text = typeof message === 'string' ? message : '';
  state.downloadStatusMessage = text;
  if (dom.dlTxt) {
    dom.dlTxt.textContent = text;
    if (text) {
      dom.dlTxt.setAttribute('title', text);
    } else {
      dom.dlTxt.removeAttribute('title');
    }
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
  updateDownloadStatus('正在準備下載...');
  try {
    const fn = type === 'audio' ? window.api.ytdlpDownloadAudio : window.api.ytdlpDownloadVideo;
    const { jobId } = await fn({ url });
    state.jobId = jobId;
    state.activeDownloadMode = type;
  } catch (err) {
    state.activeDownloadMode = null;
    showDownloadProgress(false);
    const message = err?.message || String(err);
    updateDownloadStatus(`下載啟動失敗：${message}`);
    state.downloadProgressStarted = true;
    alert(message);
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
    updateDownloadStatus('下載已取消');
    state.downloadProgressStarted = true;
  }
}

function handleYtProgress(ev) {
  if (!ev) return;
  if (ev.type === 'log') {
    appendLog(`[${ev.stream}] ${ev.line}`);
    if (!state.downloadProgressStarted) {
      const singleLine = typeof ev.line === 'string' ? ev.line.replace(/\s+/g, ' ').trim() : '';
      if (singleLine) updateDownloadStatus(singleLine);
    }
    return;
  }

  const matchesJob = !ev.jobId || !state.jobId || ev.jobId === state.jobId;
  if (!matchesJob && ['progress', 'done', 'error'].includes(ev.type)) {
    return;
  }

  if (ev.type === 'progress') {
    state.downloadProgressStarted = true;
    if (dom.dlProg) {
      const percent = typeof ev.percent === 'number' ? Math.max(0, Math.min(100, ev.percent)) : null;
      if (percent == null) {
        dom.dlProg.removeAttribute('value');
      } else {
        dom.dlProg.max = 100;
        dom.dlProg.value = percent;
        dom.dlProg.setAttribute('value', String(percent));
      }
    }
    const percentText = typeof ev.percent === 'number' ? `${ev.percent.toFixed(1)}%` : '';
    const parts = [];
    if (percentText) parts.push(percentText);
    if (ev.speed) parts.push(ev.speed);
    if (ev.eta) parts.push(ev.eta);
    const base = parts.join(' ');
    if (state.activeDownloadMode) {
      const label = state.activeDownloadMode === 'audio' ? '音訊' : '影片';
      const labelText = base ? `[${label}] ${base}` : `[${label}] 下載中...`;
      updateDownloadStatus(labelText);
    } else {
      updateDownloadStatus(base || '下載中...');
    }
  } else if (ev.type === 'done') {
    handleDownloadDone(ev).catch((err) => {
      console.error('[yt-dlp] finalize error', err);
    });
  } else if (ev.type === 'error') {
    showDownloadProgress(false);
    state.jobId = null;
    state.activeDownloadMode = null;
    const message = ev.message || '未知錯誤';
    updateDownloadStatus(`下載失敗：${message}`);
    state.downloadProgressStarted = true;
    alert('下載失敗：' + message);
  }
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
    if (merged?.hasVideo && merged.videoFilename) {
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
  return `${base}（${markers.join(' / ')}）`;
}

function updateVideoCacheSelect(selectedId = state.activeVideoId) {
  const select = dom.videoCacheSelect;
  if (!select) return;
  applyRemoteMediaUiState();
  if (state.useRemoteTimeline) return;
  const searchTerm = (state.videoSearch || '').toLowerCase();
  const entries = state.cachedEntries
    .filter((entry) => entry?.hasVideo && entry.videoFilename && matchesEntrySearch(entry, searchTerm));
  populateSelect(select, entries, {
    selectedId,
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

/* ---------------- 字型 ---------------- */
async function handlePickFonts() {
  if (state.forceDefaultFont === false) {
    updateFontControlsAvailability();
    return;
  }
  const files = await window.api.openFiles({ filters: [{ name: 'Fonts', extensions: ['ttf', 'otf', 'woff2', 'woff'] }] });
  if (!files.length) return;
  state.currentFonts = [];
  for (const filePath of files) {
    const base64 = await window.api.readBinaryBase64(filePath);
    const name = filePath.split(/[\\/]/).pop();
    state.currentFonts.push({ name, data: base64 });
  }
  updateFontsLabel();
  const style = collectStyle();
  await persistFonts(state.currentFonts);
  await persistStyle(style);
  notifyOverlayWithCurrentFonts({ style }, { includeWhenDisabled: true });
}

async function handleClearFonts() {
  if (state.forceDefaultFont === false) {
    updateFontControlsAvailability();
    return;
  }
  state.currentFonts = [];
  updateFontsLabel();
  try {
    await persistFonts(state.currentFonts);
  } catch (err) {
    console.error('[fonts] 無法儲存字型設定', err);
  }
  const style = collectStyle();
  await persistStyle(style);
  notifyOverlayWithCurrentFonts({ style }, { includeWhenDisabled: true });
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

function releaseObjectUrl() {
  if (!state.objectUrl) return;
  try { URL.revokeObjectURL(state.objectUrl); } catch { /* ignore */ }
  state.objectUrl = '';
}

function syncOverlayConnection() {
  overlaySync.connect(getCurrentPort());
  if (state.useRemoteTimeline) {
    overlaySync.stop();
    if (state.remoteNowPlaying) applyRemoteTimeline(state.remoteNowPlaying);
  } else {
    overlaySync.start();
  }
}

function clampVolume(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 1;
  if (num < 0) return 0;
  if (num > 1) return 1;
  return num;
}

/* ---------------- 樣式設定 ---------------- */
function getCurrentPort() {
  const port = parseInt(dom.portInput?.value, 10);
  return Number.isFinite(port) ? port : 59837;
}

function collectStyle() {
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

async function persistStyle(style) {
  await window.api.setConfig({ output: style });
}

async function persistFonts(fonts) {
  await window.api.setConfig({ fonts });
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
    console.error('[cache] 讀取本地媒體失敗', err);
    return null;
  }
}

