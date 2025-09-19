import { app, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { pipeline, Transform } from 'node:stream';
import { promisify } from 'node:util';
import extract from 'extract-zip';
import fetch from 'node-fetch';
import { store } from './config.mjs';

const streamPipeline = promisify(pipeline);
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

function emitBinProgress(mainWindow, payload) {
  if (!mainWindow || !mainWindow.webContents) return;
  try {
    mainWindow.webContents.send('bins:progress', payload);
  } catch (err) {
    console.error('[bins] emit progress failed', err);
  }
}

async function downloadTo(fileUrl, outPath, { label, mainWindow } = {}) {
  let res;
  try {
    res = await fetch(fileUrl);
  } catch (err) {
    emitBinProgress(mainWindow, { label, state: 'error', message: err?.message || String(err) });
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`${label} 下載失敗：${res.status} ${res.statusText}`);
    emitBinProgress(mainWindow, { label, state: 'error', message: err.message });
    throw err;
  }
  const total = Number(res.headers.get('content-length')) || 0;
  let downloaded = 0;
  emitBinProgress(mainWindow, { label, state: 'start', total });
  const progressStream = new Transform({
    transform(chunk, encoding, callback) {
      downloaded += chunk.length;
      emitBinProgress(mainWindow, {
        label,
        state: 'progress',
        downloaded,
        total
      });
      callback(null, chunk);
    }
  });
  try {
    await streamPipeline(res.body, progressStream, fs.createWriteStream(outPath));
    emitBinProgress(mainWindow, { label, state: 'downloaded', downloaded, total });
    return outPath;
  } catch (err) {
    emitBinProgress(mainWindow, { label, state: 'error', message: err?.message || String(err) });
    throw err;
  }
}

export async function checkAndOfferDownload(mainWindow) {
  await ensureDir(BIN_DIR);
  let { ytDlpPath, ffmpegPath } = getBinPaths();

  const missing = [];
  if (!ytDlpPath || !fs.existsSync(ytDlpPath)) missing.push('yt-dlp.exe');
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) missing.push('ffmpeg.exe');

  if (missing.length === 0) {
    emitBinProgress(mainWindow, { label: 'yt-dlp', state: 'ready', message: '已就緒', path: ytDlpPath });
    emitBinProgress(mainWindow, { label: 'ffmpeg', state: 'ready', message: '已就緒', path: ffmpegPath });
    return getBinPaths();
  }

  const r = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['下載', '取消'],
    defaultId: 0,
    cancelId: 1,
    title: '缺少元件',
    message: `偵測到缺少：${missing.join('、')}\n是否自動下載？（來源：yt-dlp GitHub releases；FFmpeg gyan.dev builds）`
  });
  if (r.response !== 0) throw new Error('使用者取消下載');

  // yt-dlp.exe
  if (missing.includes('yt-dlp.exe')) {
    const out = path.join(BIN_DIR, 'yt-dlp.exe');
    await downloadTo(URLS.ytDlpExe, out, { label: 'yt-dlp', mainWindow });
    emitBinProgress(mainWindow, { label: 'yt-dlp', state: 'done', message: '安裝完成' });
    ytDlpPath = out;
  }

  // ffmpeg release essentials zip
  if (missing.includes('ffmpeg.exe')) {
    const zipPath = path.join(BIN_DIR, 'ffmpeg-release-essentials.zip');
    await downloadTo(URLS.ffmpegZip, zipPath, { label: 'ffmpeg', mainWindow });
    emitBinProgress(mainWindow, { label: 'ffmpeg', state: 'processing', message: '解壓縮中…' });
    const unzipDir = path.join(BIN_DIR, 'ffmpeg');
    await ensureDir(unzipDir);
    await extract(zipPath, { dir: unzipDir });
    // 尋找 ffmpeg.exe
    const subdirs = await fs.promises.readdir(unzipDir);
    let found = '';
    for (const d of subdirs) {
      const p = path.join(unzipDir, d, 'bin', 'ffmpeg.exe');
      if (fs.existsSync(p)) { found = p; break; }
    }
    if (!found) {
      emitBinProgress(mainWindow, { label: 'ffmpeg', state: 'error', message: '解壓後未找到 ffmpeg.exe' });
      throw new Error('解壓後未找到 ffmpeg.exe');
    }
    ffmpegPath = found;
    emitBinProgress(mainWindow, { label: 'ffmpeg', state: 'done', message: '安裝完成' });
  }

  store.set('bins', { ytDlpPath, ffmpegPath });
  emitBinProgress(mainWindow, { label: 'yt-dlp', state: 'ready', message: '已就緒', path: ytDlpPath });
  emitBinProgress(mainWindow, { label: 'ffmpeg', state: 'ready', message: '已就緒', path: ffmpegPath });
  return { ytDlpPath, ffmpegPath };
}
