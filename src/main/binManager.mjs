import { app, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import extract from 'extract-zip';
import fetch from 'node-fetch';
import { store } from './config.mjs';

const BIN_DIR = path.join(app.getPath('userData'), 'bin');

const URLS = {
  ytDlpExe: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
  ffmpegZip: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
};

export function getBinPaths() {
  const { bins } = store.store;
  return {
    ytDlpPath: bins.ytDlpPath || '',
    ffmpegPath: bins.ffmpegPath || ''
  };
}

async function ensureDir(p) { await fs.promises.mkdir(p, { recursive: true }); }

function emitProgress(mainWindow, sessionId, payload = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send('bins:progress', { sessionId, ...payload });
  } catch (err) {
    console.warn('[bins] 無法傳送進度事件', err);
  }
}

async function downloadTo(fileUrl, outPath, label, { mainWindow, sessionId, target }) {
  emitProgress(mainWindow, sessionId, {
    target,
    stage: 'start',
    message: `準備下載 ${label}`
  });

  const res = await fetch(fileUrl);
  if (!res.ok || !res.body) {
    throw new Error(`${label} 下載失敗：${res.status} ${res.statusText}`);
  }

  await ensureDir(path.dirname(outPath));

  const total = Number(res.headers.get('content-length')) || 0;
  let downloaded = 0;

  await new Promise((resolve, reject) => {
    const fileStream = fs.createWriteStream(outPath);
    const onError = (err) => {
      if (res.body) {
        res.body.removeListener('data', onData);
        res.body.removeListener('error', onError);
      }
      fileStream.removeListener('error', onError);
      fileStream.removeListener('finish', onFinish);
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const onFinish = () => {
      if (res.body) {
        res.body.removeListener('data', onData);
        res.body.removeListener('error', onError);
      }
      fileStream.removeListener('error', onError);
      resolve();
    };
    const onData = (chunk) => {
      downloaded += chunk?.length || 0;
      emitProgress(mainWindow, sessionId, {
        target,
        stage: 'download',
        downloaded,
        total,
        percent: total > 0 ? (downloaded / total) * 100 : null
      });
    };

    res.body.on('data', onData);
    res.body.on('error', onError);
    fileStream.on('error', onError);
    fileStream.on('finish', onFinish);
    res.body.pipe(fileStream);
  });

  emitProgress(mainWindow, sessionId, {
    target,
    stage: 'done',
    downloaded,
    total,
    percent: total > 0 ? 100 : null,
    message: `${label} 下載完成`
  });

  return outPath;
}

export async function checkAndOfferDownload(mainWindow) {
  await ensureDir(BIN_DIR);
  let { ytDlpPath, ffmpegPath } = getBinPaths();
  const sessionId = Date.now();
  const send = (payload) => emitProgress(mainWindow, sessionId, payload);

  send({ target: 'overall', stage: 'checking', message: '正在檢查必要元件…' });

  const missing = [];
  if (!ytDlpPath || !fs.existsSync(ytDlpPath)) missing.push('yt-dlp.exe');
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) missing.push('ffmpeg.exe');

  if (missing.length === 0) {
    if (ytDlpPath) send({ target: 'yt-dlp', stage: 'ready', percent: 100, message: 'yt-dlp 已就緒' });
    if (ffmpegPath) send({ target: 'ffmpeg', stage: 'ready', percent: 100, message: 'ffmpeg 已就緒' });
    send({ target: 'overall', stage: 'ready', message: '元件已就緒。' });
    return getBinPaths();
  }

  send({ target: 'overall', stage: 'prompt', message: `偵測到缺少：${missing.join('、')}，是否要下載？` });

  const r = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['下載', '取消'],
    defaultId: 0,
    cancelId: 1,
    title: '缺少元件',
    message: `偵測到缺少：${missing.join('、')}\n是否自動下載？（來源：yt-dlp GitHub releases；FFmpeg gyan.dev builds）`
  });
  if (r.response !== 0) {
    send({ target: 'overall', stage: 'cancelled', message: '使用者取消下載' });
    throw new Error('使用者取消下載');
  }

  send({ target: 'overall', stage: 'start', message: '開始下載必要元件…' });

  // yt-dlp.exe
  if (missing.includes('yt-dlp.exe')) {
    const out = path.join(BIN_DIR, 'yt-dlp.exe');
    try {
      send({ target: 'overall', stage: 'download', message: '正在下載 yt-dlp…' });
      await downloadTo(URLS.ytDlpExe, out, 'yt-dlp', { mainWindow, sessionId, target: 'yt-dlp' });
      ytDlpPath = out;
      send({ target: 'yt-dlp', stage: 'ready', percent: 100, message: 'yt-dlp 已就緒' });
    } catch (err) {
      send({ target: 'yt-dlp', stage: 'error', message: err?.message || String(err) });
      send({ target: 'overall', stage: 'error', message: err?.message || String(err) });
      throw err;
    }
  } else if (ytDlpPath) {
    send({ target: 'yt-dlp', stage: 'ready', percent: 100, message: 'yt-dlp 已就緒' });
  }

  // ffmpeg release essentials zip
  if (missing.includes('ffmpeg.exe')) {
    const zipPath = path.join(BIN_DIR, 'ffmpeg-release-essentials.zip');
    try {
      send({ target: 'overall', stage: 'download', message: '正在下載 ffmpeg…' });
      await downloadTo(URLS.ffmpegZip, zipPath, 'ffmpeg', { mainWindow, sessionId, target: 'ffmpeg' });
      const unzipDir = path.join(BIN_DIR, 'ffmpeg');
      await ensureDir(unzipDir);
      send({ target: 'overall', stage: 'extract', message: '正在解壓縮 ffmpeg…' });
      send({ target: 'ffmpeg', stage: 'extract', message: '解壓縮中…' });
      await extract(zipPath, { dir: unzipDir });
      const subdirs = await fs.promises.readdir(unzipDir);
      let found = '';
      for (const d of subdirs) {
        const p = path.join(unzipDir, d, 'bin', 'ffmpeg.exe');
        if (fs.existsSync(p)) { found = p; break; }
      }
      if (!found) throw new Error('解壓後未找到 ffmpeg.exe');
      ffmpegPath = found;
      send({ target: 'ffmpeg', stage: 'ready', percent: 100, message: 'ffmpeg 已就緒' });
    } catch (err) {
      send({ target: 'ffmpeg', stage: 'error', message: err?.message || String(err) });
      send({ target: 'overall', stage: 'error', message: err?.message || String(err) });
      throw err;
    }
  } else if (ffmpegPath) {
    send({ target: 'ffmpeg', stage: 'ready', percent: 100, message: 'ffmpeg 已就緒' });
  }

  store.set('bins', { ytDlpPath, ffmpegPath });
  send({ target: 'overall', stage: 'done', message: '元件已就緒。' });
  return { ytDlpPath, ffmpegPath };
}
