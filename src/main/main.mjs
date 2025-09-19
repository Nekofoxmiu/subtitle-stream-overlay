import { app, BrowserWindow} from 'electron';
import electronSquirrelStartup from 'electron-squirrel-startup';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupIpc } from './ipc.mjs';
import { checkAndOfferDownload } from './binManager.mjs';
import { getConfig } from './config.mjs';
import { OverlayServer } from './overlayServer.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT   = path.resolve(__dirname, '..', '..');          // <repo>/
const SRC_DIR        = path.join(PROJECT_ROOT, 'src');               // <repo>/src
const RENDERER_DIR   = path.join(SRC_DIR, 'renderer');               // <repo>/src/renderer
const PRELOAD_PATH   = path.join(SRC_DIR, 'preload.cjs');             // <repo>/src/preload.mjs
const ASSETS_DIR     = path.join(PROJECT_ROOT, 'assets');            // <repo>/assets

const isSquirrelEvent = electronSquirrelStartup;
if (isSquirrelEvent) {
  app.quit();
}

let mainWindow;
let overlayServer;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
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

    try { await checkAndOfferDownload(mainWindow); } catch {}

    const { output } = getConfig();
    overlayServer = new OverlayServer({
      rendererDir: RENDERER_DIR,
      assetsDir: ASSETS_DIR,
      userDataPath: app.getPath('userData')
    });
    await overlayServer.listen(output.port);
  }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

export function updateOverlayState(patch) {
  if (overlayServer) overlayServer.updateState(patch);
}
