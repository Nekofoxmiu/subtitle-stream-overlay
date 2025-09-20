import { app, BrowserWindow, dialog } from 'electron';
import electronSquirrelStartup from 'electron-squirrel-startup';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupIpc } from './ipc.mjs';
import { checkAndOfferDownload, updateYtDlpIfAvailable } from './binManager.mjs';
import { getConfig } from './config.mjs';
import { OverlayServer } from './overlayServer.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');          // <repo>/
const SRC_DIR = path.join(PROJECT_ROOT, 'src');               // <repo>/src
const RENDERER_DIR = path.join(SRC_DIR, 'renderer');               // <repo>/src/renderer
const PRELOAD_PATH = path.join(SRC_DIR, 'preload.cjs');             // <repo>/src/preload.mjs
const ASSETS_DIR = path.join(PROJECT_ROOT, 'assets');            // <repo>/assets

const DEFAULT_OVERLAY_PORT = 59837;

function normalizeOverlayPort(value) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535) return parsed;
  return DEFAULT_OVERLAY_PORT;
}

const isSquirrelEvent = electronSquirrelStartup;
if (isSquirrelEvent) {
  app.quit();
}

let mainWindow;

let overlayServer;
let overlayServerStartPromise = null;

let currentOverlayPort = null;

function createOverlayServerInstance() {
  return new OverlayServer({
    rendererDir: RENDERER_DIR,
    assetsDir: ASSETS_DIR,
    userDataPath: app.getPath('userData')
  });
}

async function waitForOverlayServerStart() {
  if (!overlayServerStartPromise) return;
  try {
    await overlayServerStartPromise;
  } catch {
    // swallow start errors so callers can retry
  }
}

async function stopOverlayServer() {
  await waitForOverlayServerStart();
  if (!overlayServer) return;
  const srv = overlayServer;
  overlayServer = null;
  currentOverlayPort = null;
  try {
    await srv.close();
  } catch {
    // best effort shutdown
  }
}

async function startOverlayServer(port) {
  const normalizedPort = normalizeOverlayPort(port);
  await waitForOverlayServerStart();
  if (overlayServer && currentOverlayPort === normalizedPort) return;
  if (overlayServer) await stopOverlayServer();
  const srv = createOverlayServerInstance();
  const pendingPromise = (async () => {
    try {
      await srv.listen(normalizedPort);
      overlayServer = srv;
      currentOverlayPort = normalizedPort;
    } catch (err) {
      await srv.close().catch(() => { });
      throw err;
    }
  })();
  overlayServerStartPromise = pendingPromise;
  try {
    await pendingPromise;
  } finally {
    if (overlayServerStartPromise === pendingPromise) overlayServerStartPromise = null;
    if (!overlayServer) currentOverlayPort = null;
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      preload: PRELOAD_PATH
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile(path.join(RENDERER_DIR, 'index.html'));
}

app.whenReady().then(async () => {
  if (!isSquirrelEvent) {
    createMainWindow();
    setupIpc(mainWindow);

    try { await checkAndOfferDownload(mainWindow); } catch { }
    try { await updateYtDlpIfAvailable(mainWindow); } catch { }

    const { output } = getConfig();
    const initialPort = normalizeOverlayPort(output?.port);
    try {
      await startOverlayServer(initialPort);
    } catch (err) {
      console.error('[main] failed to start overlayServer on port', initialPort, err);
      const message = err?.code === 'EADDRINUSE'
        ? `Port ${initialPort} is already in use. Pick another value in Settings and try again.`
        : (err?.message || String(err));
      try { dialog.showErrorBox('Unable to start overlay server', message); } catch { }
    }

  }
});

// Restart overlay server when config output.port changes.

app.on('config:changed', async (newConfig) => {
  try {
    const targetPort = normalizeOverlayPort(newConfig?.output?.port);
    const previousPort = currentOverlayPort;
    try {
      await startOverlayServer(targetPort);
      if (previousPort != null && previousPort !== currentOverlayPort) {
        console.log('[main] overlayServer restarted on port', currentOverlayPort);
      }
    } catch (err) {
      console.error('[main] failed to restart overlayServer:', err);
      const message = err?.code === 'EADDRINUSE'
        ? `Port ${targetPort} is already in use. Pick another value and try again.`
        : (err?.message || String(err));
      try { dialog.showErrorBox('Unable to restart overlay server', message); } catch { }
    }
  } catch (err) {
    console.error('[main] config:changed handler error', err);
  }
});


app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

export function updateOverlayState(patch) {
  if (overlayServer) overlayServer.updateState(patch);
}
