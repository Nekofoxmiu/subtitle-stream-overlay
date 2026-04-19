import { app, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { pipeline, Transform } from 'node:stream';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import extract from 'extract-zip';
import fetch from 'node-fetch';
import { store } from './config.mjs';

const streamPipeline = promisify(pipeline);
const BIN_DIR = path.join(app.getPath('userData'), 'bin');

const URLS = {
  ytDlpExe: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
  ffmpegZip: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
  quickJsExe: 'https://github.com/quickjs-ng/quickjs/releases/latest/download/qjs-windows-x86_64.exe'
};

function resolveExistingPath(candidate = '') {
  return candidate && fs.existsSync(candidate) ? candidate : '';
}

function resolveBundledQuickJsPath() {
  const appPath = app.getAppPath();
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'bin', 'qjs.exe') : '',
    appPath ? path.join(appPath, 'vendor', 'quickjs', 'qjs.exe') : '',
    appPath && appPath.toLowerCase().endsWith('.asar')
      ? path.join(path.dirname(appPath), 'bin', 'qjs.exe')
      : ''
  ];
  for (const candidate of candidates) {
    const found = resolveExistingPath(candidate);
    if (found) return found;
  }
  return '';
}

export function getBinPaths() {
  const { bins } = store.store;
  const bundledQuickJsPath = resolveBundledQuickJsPath();
  const storedQuickJsPath = resolveExistingPath(bins.quickjsPath || '');
  return {
    ytDlpPath: bins.ytDlpPath || '',
    ffmpegPath: bins.ffmpegPath || '',
    quickjsPath: storedQuickJsPath || bundledQuickJsPath || ''
  };
}

function persistBinPaths(partial = {}) {
  const current = getBinPaths();
  const next = {
    ytDlpPath: Object.prototype.hasOwnProperty.call(partial, 'ytDlpPath')
      ? partial.ytDlpPath || ''
      : current.ytDlpPath || '',
    ffmpegPath: Object.prototype.hasOwnProperty.call(partial, 'ffmpegPath')
      ? partial.ffmpegPath || ''
      : current.ffmpegPath || '',
    quickjsPath: Object.prototype.hasOwnProperty.call(partial, 'quickjsPath')
      ? partial.quickjsPath || ''
      : current.quickjsPath || ''
  };
  store.set('bins', next);
  return next;
}

export function getYtDlpRuntimeArgs(binPaths = getBinPaths()) {
  const quickjsPath = resolveExistingPath(binPaths?.quickjsPath || '');
  if (!quickjsPath) return [];
  return ['--js-runtimes', `quickjs:${quickjsPath}`];
}

async function ensureDir(p) { await fs.promises.mkdir(p, { recursive: true }); }

function emitBinProgress(mainWindow, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send('bins:progress', payload);
  } catch (err) {
    console.error('[bins] 無法傳送進度', err);
  }
}

async function downloadTo(fileUrl, outPath, label, { mainWindow, id } = {}) {
  emitBinProgress(mainWindow, { id, label, stage: 'download', status: 'start' });
  const res = await fetch(fileUrl);
  if (!res.ok) {
    const message = `${label} 下載失敗：${res.status} ${res.statusText}`;
    emitBinProgress(mainWindow, { id, label, stage: 'download', status: 'error', message });
    throw new Error(message);
  }

  const total = Number(res.headers.get('content-length')) || 0;
  let downloaded = 0;
  let lastEmit = 0;
  const progressStream = new Transform({
    transform(chunk, encoding, callback) {
      downloaded += chunk.length;
      const now = Date.now();
      if (!total || now - lastEmit > 150) {
        lastEmit = now;
        const percent = total ? Math.min(100, (downloaded / total) * 100) : null;
        emitBinProgress(mainWindow, {
          id,
          label,
          stage: 'download',
          status: 'progress',
          downloaded,
          total,
          percent
        });
      }
      callback(null, chunk);
    }
  });

  try {
    await streamPipeline(res.body, progressStream, fs.createWriteStream(outPath));
  } catch (err) {
    emitBinProgress(mainWindow, { id, label, stage: 'download', status: 'error', message: err?.message || String(err) });
    throw err;
  }

  emitBinProgress(mainWindow, {
    id,
    label,
    stage: 'download',
    status: 'done',
    downloaded,
    total,
    percent: total ? 100 : null
  });
  return outPath;
}

export async function checkAndOfferDownload(mainWindow) {
  await ensureDir(BIN_DIR);
  let { ytDlpPath, ffmpegPath, quickjsPath } = getBinPaths();
  const bundledQuickJsPath = resolveBundledQuickJsPath();
  if (!resolveExistingPath(quickjsPath) && bundledQuickJsPath) {
    quickjsPath = bundledQuickJsPath;
    ({ ytDlpPath, ffmpegPath, quickjsPath } = persistBinPaths({ ytDlpPath, ffmpegPath, quickjsPath }));
  }

  const missing = [];
  if (!ytDlpPath || !fs.existsSync(ytDlpPath)) missing.push('yt-dlp.exe');
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) missing.push('ffmpeg.exe');
  if (!quickjsPath || !fs.existsSync(quickjsPath)) missing.push('qjs.exe');

  if (missing.length === 0) return persistBinPaths({ ytDlpPath, ffmpegPath, quickjsPath });

  const r = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['下載', '取消'],
    defaultId: 0,
    cancelId: 1,
    title: '缺少元件',
    message: `偵測到缺少：${missing.join('、')}\n是否自動下載？（來源：yt-dlp GitHub releases；FFmpeg gyan.dev builds；QuickJS-NG releases）`
  });
  if (r.response !== 0) throw new Error('使用者取消下載');

  const markReady = (id, label) => {
    emitBinProgress(mainWindow, {
      id,
      label,
      stage: 'ready',
      status: 'done',
      percent: 100,
      message: `${label} 已就緒`
    });
  };

  // yt-dlp.exe
  if (missing.includes('yt-dlp.exe')) {
    const out = path.join(BIN_DIR, 'yt-dlp.exe');
    await downloadTo(URLS.ytDlpExe, out, 'yt-dlp', { mainWindow, id: 'yt-dlp' });
    ytDlpPath = out;
    markReady('yt-dlp', 'yt-dlp');
    ({ ytDlpPath, ffmpegPath, quickjsPath } = persistBinPaths({ ytDlpPath, ffmpegPath, quickjsPath }));
  }

  // ffmpeg release essentials zip
  if (missing.includes('ffmpeg.exe')) {
    const zipPath = path.join(BIN_DIR, 'ffmpeg-release-essentials.zip');
    await downloadTo(URLS.ffmpegZip, zipPath, 'ffmpeg', { mainWindow, id: 'ffmpeg' });
    const unzipDir = path.join(BIN_DIR, 'ffmpeg');
    await ensureDir(unzipDir);
    emitBinProgress(mainWindow, { id: 'ffmpeg', label: 'ffmpeg', stage: 'extract', status: 'start' });
    await extract(zipPath, { dir: unzipDir });
    emitBinProgress(mainWindow, { id: 'ffmpeg', label: 'ffmpeg', stage: 'extract', status: 'done' });
    // 尋找 ffmpeg.exe
    const subdirs = await fs.promises.readdir(unzipDir);
    let found = '';
    for (const d of subdirs) {
      const p = path.join(unzipDir, d, 'bin', 'ffmpeg.exe');
      if (fs.existsSync(p)) { found = p; break; }
    }
    if (!found) {
      const message = '解壓後未找到 ffmpeg.exe';
      emitBinProgress(mainWindow, { id: 'ffmpeg', label: 'ffmpeg', stage: 'extract', status: 'error', message });
      throw new Error(message);
    }
    ffmpegPath = found;
    markReady('ffmpeg', 'ffmpeg');
    ({ ytDlpPath, ffmpegPath, quickjsPath } = persistBinPaths({ ytDlpPath, ffmpegPath, quickjsPath }));
  }

  // qjs.exe (QuickJS / QuickJS-NG runtime for yt-dlp EJS)
  if (missing.includes('qjs.exe')) {
    const out = path.join(BIN_DIR, 'qjs.exe');
    await downloadTo(URLS.quickJsExe, out, 'QuickJS', { mainWindow, id: 'quickjs' });
    quickjsPath = out;
    markReady('quickjs', 'QuickJS');
    ({ ytDlpPath, ffmpegPath, quickjsPath } = persistBinPaths({ ytDlpPath, ffmpegPath, quickjsPath }));
  }

  ({ ytDlpPath, ffmpegPath, quickjsPath } = persistBinPaths({ ytDlpPath, ffmpegPath, quickjsPath }));
  return { ytDlpPath, ffmpegPath, quickjsPath };
}

export async function updateYtDlpIfAvailable(mainWindow) {
  const { ytDlpPath } = getBinPaths();
  if (!ytDlpPath || !fs.existsSync(ytDlpPath)) return false;

  const id = 'yt-dlp';
  const label = 'yt-dlp';
  emitBinProgress(mainWindow, { id, label, stage: 'update', status: 'start' });

  const cwd = path.dirname(ytDlpPath);
  const stdoutChunks = [];
  const stderrChunks = [];

  const runUpdate = () => new Promise((resolve, reject) => {
    const proc = spawn(ytDlpPath, ['-U'], { cwd, windowsHide: true });
    proc.stdout.on('data', (chunk) => {
      if (!chunk) return;
      const textChunk = chunk.toString();
      stdoutChunks.push(textChunk);
      const trimmed = textChunk.trim();
      if (trimmed) console.log('[yt-dlp] ' + trimmed);
    });
    proc.stderr.on('data', (chunk) => {
      if (!chunk) return;
      const textChunk = chunk.toString();
      stderrChunks.push(textChunk);
      const trimmed = textChunk.trim();
      if (trimmed) console.error('[yt-dlp] ' + trimmed);
    });
    proc.once('error', reject);
    proc.once('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const stderrText = stderrChunks.join('').trim();
        const stdoutText = stdoutChunks.join('').trim();
        reject(new Error(stderrText || stdoutText || ('yt-dlp -U exited with code ' + code)));
      }
    });
  });

  try {
    await runUpdate();
    const stdoutText = stdoutChunks.join('');
    const normalized = stdoutText.toLowerCase();
    let message = 'yt-dlp 更新完成';
    if (normalized.includes('up to date') || normalized.includes('already up-to-date')) {
      message = 'yt-dlp 已是最新版本';
    }
    emitBinProgress(mainWindow, { id, label, stage: 'update', status: 'done', percent: 100, message });
    return true;
  } catch (err) {
    const baseMessage = err && typeof err.message === 'string' ? err.message : '';
    const message = baseMessage || 'yt-dlp 更新失敗';
    emitBinProgress(mainWindow, { id, label, stage: 'update', status: 'error', message });
    console.error('[bins] yt-dlp 更新失敗', err);
    return false;
  }
}
