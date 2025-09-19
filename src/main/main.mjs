import { app, BrowserWindow, shell } from 'electron';
import electronSquirrelStartup from 'electron-squirrel-startup';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
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

    await ensureDesktopShortcut();

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

async function ensureDesktopShortcut() {
  if (!app.isPackaged) return;

  if (process.platform === 'win32') {
    try {
      const desktopDir = app.getPath('desktop');
      await fs.promises.mkdir(desktopDir, { recursive: true }).catch(() => {});
      const shortcutPath = path.join(desktopDir, 'Subtitle Stream Overlay.lnk');
      if (fs.existsSync(shortcutPath)) return;
      const target = process.execPath;
      const options = {
        target,
        cwd: path.dirname(target),
        description: 'Subtitle Stream Overlay'
      };
      const iconCandidate = path.join(ASSETS_DIR, 'icon.ico');
      if (fs.existsSync(iconCandidate)) options.icon = iconCandidate;
      shell.writeShortcutLink(shortcutPath, 'create', options);
    } catch (err) {
      console.error('[shortcut] 無法建立桌面捷徑', err);
    }
    return;
  }

  if (process.platform === 'linux') {
    try {
      const desktopDir = app.getPath('desktop');
      await fs.promises.mkdir(desktopDir, { recursive: true }).catch(() => {});
      const shortcutPath = path.join(desktopDir, 'subtitle-stream-overlay.desktop');
      if (fs.existsSync(shortcutPath)) return;
      const execPath = process.execPath.replace(/"/g, '\\"');
      const iconCandidates = ['icon.png', 'icon.ico']
        .map((name) => path.join(ASSETS_DIR, name))
        .find((candidate) => fs.existsSync(candidate));
      const lines = [
        '[Desktop Entry]',
        'Type=Application',
        'Version=1.0',
        'Name=Subtitle Stream Overlay',
        'Comment=Subtitle Stream Overlay',
        `Exec="${execPath}"`,
        'Terminal=false',
        'Categories=AudioVideo;'
      ];
      if (iconCandidates) lines.push(`Icon=${iconCandidates}`);
      await fs.promises.writeFile(shortcutPath, `${lines.join('\n')}\n`, { mode: 0o755 });
      await fs.promises.chmod(shortcutPath, 0o755).catch(() => {});
    } catch (err) {
      console.error('[shortcut] 無法建立 Linux 桌面捷徑', err);
    }
  }
}
