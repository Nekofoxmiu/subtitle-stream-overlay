const { contextBridge, ipcRenderer } = require('electron');

// Preload runs in a restricted renderer context. Keep this file CommonJS only.
console.log('[preload] injected (CJS)');

// Expose a safe API surface to renderer. Only use ipcRenderer here.
contextBridge.exposeInMainWorld('api', {
  ensureBins: () => ipcRenderer.invoke('bins:ensure'),
  getBins: () => ipcRenderer.invoke('bins:get'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  openFiles: (options) => ipcRenderer.invoke('dialog:openFiles', options),
  fetchSubsFromYt: (payload) => ipcRenderer.invoke('ytdlp:fetchSubs', payload),
  convertToAss: (payload) => ipcRenderer.invoke('subs:convertToAss', payload),
  notifyOverlay: (patch) => ipcRenderer.send('overlay:update', patch),
  readTextFile: (filePath) => ipcRenderer.invoke('file:readText', filePath),
  readBinaryBase64: (filePath) => ipcRenderer.invoke('file:readBinaryBase64', filePath),
  listCacheEntries: () => ipcRenderer.invoke('cache:list'),
  importLocalToCache: (payload) => ipcRenderer.invoke('cache:importLocal', payload),
  ytdlpDownloadVideo: (payload) => ipcRenderer.invoke('ytdlp:downloadVideo', payload),
  ytdlpDownloadAudio: (payload) => ipcRenderer.invoke('ytdlp:downloadAudio', payload),
  ytdlpCancel: (jobId) => ipcRenderer.invoke('ytdlp:cancel', { jobId }),
  onYtProgress: (cb) => ipcRenderer.on('ytdlp:progress', (_e, data) => cb?.(data)),
  onBinProgress: (cb) => ipcRenderer.on('bins:progress', (_e, data) => cb?.(data)),


  // Subscribe to overlay state updates from main. Returns an unsubscribe fn.
  onOverlayState: (handler) => {
    if (typeof handler !== 'function') return () => { };
    const channel = 'overlay:state';
    const wrapped = (_e, patch) => {
      try { handler(patch); } catch (err) {
        // swallow handler errors to avoid crashing renderer
        console.error('api.onOverlayState handler error', err);
      }
    };
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  }
});

// Note: Do NOT import main-process-only modules (like ipcMain or main.mjs) here.
// Preload should only communicate via ipcRenderer. The main process (e.g. ipc.mjs)
// must register listeners for channels like 'overlay:update' and forward
// 'overlay:state' as needed.
