import { app, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { pipeline } from 'node:stream';
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

async function downloadTo(fileUrl, outPath, label) {
  const res = await fetch(fileUrl);
  if (!res.ok) throw new Error(`${label} 下載失敗：${res.status} ${res.statusText}`);
  await streamPipeline(res.body, fs.createWriteStream(outPath));
  return outPath;
}

export async function checkAndOfferDownload(mainWindow) {
  await ensureDir(BIN_DIR);
  let { ytDlpPath, ffmpegPath } = getBinPaths();

  const missing = [];
  if (!ytDlpPath || !fs.existsSync(ytDlpPath)) missing.push('yt-dlp.exe');
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) missing.push('ffmpeg.exe');

  if (missing.length === 0) return getBinPaths();

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
    await downloadTo(URLS.ytDlpExe, out, 'yt-dlp');
    ytDlpPath = out;
  }

  // ffmpeg release essentials zip
  if (missing.includes('ffmpeg.exe')) {
    const zipPath = path.join(BIN_DIR, 'ffmpeg-release-essentials.zip');
    await downloadTo(URLS.ffmpegZip, zipPath, 'ffmpeg');
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
    if (!found) throw new Error('解壓後未找到 ffmpeg.exe');
    ffmpegPath = found;
  }

  store.set('bins', { ytDlpPath, ffmpegPath });
  return { ytDlpPath, ffmpegPath };
}
