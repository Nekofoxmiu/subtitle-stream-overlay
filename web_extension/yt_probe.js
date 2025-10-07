(function(){
  const pick = (o, p) => { try { return p.split('.').reduce((x,k)=>x&&x[k], o); } catch(_) { return undefined; } };

  function computeIsLive() {
    const flexy = document.querySelector('ytd-watch-flexy');
    const a = !!pick(flexy, 'playerData.videoDetails.isLive');
    const b = !!pick(flexy, 'playerData.microformat.playerMicroformatRenderer.liveBroadcastDetails.isLiveNow');
    const c = (() => {
      const m = document.querySelector('div.ytp-time-display.notranslate.ytp-live > span.ytp-time-wrapper > div > button');
      if (!m) return false;
      return true;
    })();
    return a || b || c;
  }

  function getStartTimestampISO() {
    const flexy = document.querySelector('ytd-watch-flexy');
    const mf = pick(flexy, 'playerData.microformat.playerMicroformatRenderer');
    return mf?.liveBroadcastDetails?.startTimestamp || null;
  }
  function getLiveElapsedMs() {
    const iso = getStartTimestampISO();
    if (!iso) return null;
    const start = Date.parse(iso); // UTC
    if (Number.isNaN(start)) return null;
    return Date.now() - start; // 毫秒
  }
  function computeDurationMs(isLive) {
    if (!isLive) return null;
    const ms = getLiveElapsedMs();
    return (ms != null && ms >= 0) ? ms : null;
  }

  function notify() {
    try {
      const live = computeIsLive();
      const durationMs = computeDurationMs(live);
      window.postMessage({ type: 'YT_LIVE_STATUS', live, durationMs }, '*');
    } catch (_) {}
  }

  const tick = () => { requestAnimationFrame(() => { Promise.resolve().then(notify); }); };
  notify();
  window.addEventListener('yt-page-data-updated', tick, { passive: true });
  window.addEventListener('yt-navigate-finish',   tick, { passive: true });
  window.addEventListener('yt-player-updated',    tick, { passive: true });
  setInterval(notify, 500);
})();
