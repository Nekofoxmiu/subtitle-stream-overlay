import { app, ipcMain, dialog } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { checkAndOfferDownload, getBinPaths } from './binManager.mjs';
import { getConfig, setConfig, store } from './config.mjs';
import { updateOverlayState } from './main.mjs';

let dlSeq = 0;
const running = new Map(); // jobId -> child

const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.opus', '.wma']);

const getVideoCacheDir = () => path.join(app.getPath('userData'), 'video-cache');
const getSubsCacheDir = () => path.join(app.getPath('userData'), 'subs-cache');

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function readDownloadStore() {
  const downloads = store.get('downloads');
  return Array.isArray(downloads) ? downloads : [];
}

function writeDownloadStore(entries) {
  store.set('downloads', entries);
}

async function buildDownloadEntry(raw) {
  if (!raw) return null;
  const videoDir = getVideoCacheDir();
  const subsDir = getSubsCacheDir();
  const addedAt = raw.addedAt || Date.now();
  const updatedAt = raw.updatedAt || addedAt;
  let id = raw.id || '';
  const videoFilename = raw.videoFilename || '';
  const subsFilename = raw.subsFilename || '';
  if (!id) id = videoFilename || subsFilename || `entry_${addedAt}`;
  const title = raw.title || '';

  let videoPath = '';
  let hasVideo = false;
  if (videoFilename) {
    const p = path.join(videoDir, videoFilename);
    try {
      const st = await fs.stat(p);
      if (st.isFile()) {
        videoPath = p;
        hasVideo = true;
      }
    } catch { }
  }

  let subsPath = '';
  let hasSubs = false;
  if (subsFilename) {
    const p = path.join(subsDir, subsFilename);
    try {
      const st = await fs.stat(p);
      if (st.isFile()) {
        subsPath = p;
        hasSubs = true;
      }
    } catch { }
  }

  let mediaKind = 'video';
  if (hasVideo) {
    const ext = path.extname(videoFilename).toLowerCase();
    if (AUDIO_EXTS.has(ext)) mediaKind = 'audio';
  }

  const displayTitle = title || (hasVideo
    ? path.parse(videoFilename).name
    : hasSubs
      ? path.parse(subsFilename).name
      : id);

  return {
    id,
    title,
    displayTitle,
    addedAt,
    updatedAt,
    videoFilename,
    subsFilename,
    videoPath,
    subsPath,
    hasVideo,
    hasSubs,
    mediaKind
  };
}

async function listDownloadEntries() {
  const entries = await Promise.all(readDownloadStore().map(buildDownloadEntry));
  return entries
    .filter((item) => item && (item.hasVideo || item.hasSubs))
    .sort((a, b) => (a?.addedAt || 0) - (b?.addedAt || 0));
}

async function upsertDownloadEntry(patch = {}) {
  const now = Date.now();
  const downloads = readDownloadStore();
  let idx = -1;
  if (patch.id) idx = downloads.findIndex(item => item?.id === patch.id);
  if (idx < 0 && patch.videoFilename) {
    idx = downloads.findIndex(item => item?.videoFilename === patch.videoFilename);
  }
  if (idx < 0 && patch.subsFilename) {
    idx = downloads.findIndex(item => item?.subsFilename === patch.subsFilename);
  }
  const base = idx >= 0 ? downloads[idx] : {};
  const id = patch.id || base.id || patch.videoFilename || patch.subsFilename || `entry_${now}`;
  const addedAt = base.addedAt || now;
  const merged = {
    ...base,
    ...patch,
    id,
    addedAt,
    updatedAt: now
  };
  if (idx >= 0) downloads[idx] = merged;
  else downloads.push(merged);
  writeDownloadStore(downloads);
  return buildDownloadEntry(merged);
}

async function registerVideoDownload({ id, title, filename }) {
  if (!filename) return null;
  await ensureDir(getVideoCacheDir());
  return upsertDownloadEntry({ id, title, videoFilename: filename });
}

async function registerSubtitleDownload({ id, title, sourcePath }) {
  if (!sourcePath) return null;
  const subsDir = getSubsCacheDir();
  await ensureDir(subsDir);
  const ext = path.extname(sourcePath) || '.ass';
  const normalizedName = id ? `${id}${ext}` : path.basename(sourcePath);
  const targetPath = path.join(subsDir, normalizedName);
  try {
    if (path.resolve(sourcePath) !== targetPath) {
      await fs.copyFile(sourcePath, targetPath);
      await fs.unlink(sourcePath).catch(() => { });
    } else if (path.basename(sourcePath) !== normalizedName) {
      await fs.rename(sourcePath, targetPath);
    }
  } catch { }
  return upsertDownloadEntry({ id, title, subsFilename: path.basename(targetPath) });
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, ...opts });
    let out = '', err = '';
    p.stdout.on('data', d => out += d.toString());
    p.stderr.on('data', d => err += d.toString());
    p.on('close', code => code === 0 ? resolve({ code, out, err }) : reject(new Error(err || `exit ${code}`)));
  });
}

export function setupIpc(mainWindow) {

  // 讀取文字檔（UTF-8）
  ipcMain.handle('file:readText', async (_e, filePath) => {
    if (!filePath) throw new Error('filePath is required');
    const buf = await fs.readFile(filePath);
    // 嘗試 UTF-8；若編碼不明日後可加入 iconv
    return buf.toString('utf8');
  });

  // 讀取二進位→base64（字型等）
  ipcMain.handle('file:readBinaryBase64', async (_e, filePath) => {
    if (!filePath) throw new Error('filePath is required');
    const buf = await fs.readFile(filePath);
    return buf.toString('base64');
  });

  ipcMain.handle('bins:ensure', async () => {
    return await checkAndOfferDownload(mainWindow);
  });

  ipcMain.handle('bins:get', async () => getBinPaths());

  ipcMain.handle('config:get', async () => getConfig());
  ipcMain.handle('config:set', async (_e, patch) => { setConfig(patch); return getConfig(); });

  ipcMain.handle('dialog:openFiles', async (_e, options) => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'], ...options });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle('cache:list', async () => listDownloadEntries());

  // 下載 YouTube 字幕（不抓影片）
  ipcMain.handle('ytdlp:fetchSubs', async (_e, { url, langs = 'zh-Hant,zh-Hans,zh-TW,zh,en.*' }) => {
    const { ytDlpPath } = getBinPaths();
    if (!ytDlpPath) throw new Error('yt-dlp 未設定');
    const cfg = getConfig();
    const cookiesPath = cfg.cookiesPath || '';
    const outDir = getSubsCacheDir();
    await ensureDir(outDir);
    const metaPrefix = '__meta__';
    const args = [
      ...(cookiesPath ? ['--cookies', cookiesPath] : []),
      '--write-subs',
      '--sub-langs', langs,
      '--skip-download',
      '--convert-subs', 'ass',
      '--no-overwrites',
      '--print', `${metaPrefix}id=%(id)s`,
      '--print', `${metaPrefix}title=%(title)s`,
      '-o', path.join(outDir, '%(id)s.%(ext)s'),
      url
    ];
    const { out, err } = await run(ytDlpPath, args, { cwd: outDir });
    const combined = `${out}\n${err}`;
    const meta = {};
    combined.split(/\r?\n/).forEach((line) => {
      if (!line) return;
      if (!line.startsWith(metaPrefix)) return;
      const rest = line.slice(metaPrefix.length);
      const eq = rest.indexOf('=');
      if (eq <= 0) return;
      const key = rest.slice(0, eq);
      const value = rest.slice(eq + 1);
      meta[key] = value;
    });
    const files = await fs.readdir(outDir);
    const assPaths = files
      .filter(f => f.toLowerCase().endsWith('.ass'))
      .map(f => path.join(outDir, f))
      .filter((p) => {
        if (!meta.id) return true;
        const base = path.basename(p);
        return base.startsWith(meta.id);
      });
    const entries = [];
    for (const assPath of assPaths) {
      const entry = await registerSubtitleDownload({ id: meta.id || path.parse(assPath).name, title: meta.title, sourcePath: assPath });
      if (entry) entries.push(entry);
    }
    const normalizedFiles = entries.map((entry) => entry?.subsPath).filter(Boolean);
    return { log: out + err, files: normalizedFiles.length ? normalizedFiles : assPaths, entries, meta };
  });

  // 轉字幕為 ASS
  ipcMain.handle('subs:convertToAss', async (_e, { inputPath }) => {
    const { ffmpegPath } = getBinPaths();
    if (!ffmpegPath) throw new Error('ffmpeg 未設定');
    const outPath = inputPath.replace(/\.[^.]+$/i, '.ass');
    const args = ['-y', '-i', inputPath, outPath];
    // 若可能有編碼問題，可考慮接 -sub_charenc UTF-8 或使用外部偵測
    const { out, err } = await run(ffmpegPath, args);
    return { out, err, outPath };
  });


  ipcMain.on('overlay:update', (_e, patch) => {
    try {
      updateOverlayState(patch);
      // 可選：除錯輸出
      if (patch?.subContent) console.log('[overlay:update] subContent len =', patch.subContent.length);
    } catch (err) {
      console.error('[overlay:update] failed:', err);
    }
  });


  ipcMain.handle('ytdlp:downloadVideo', async (e, { url, format = 'mp4' }) => {
    if (!url) throw new Error('缺少 URL');
    const { ytDlpPath, ffmpegPath } = getBinPaths();
    if (!ytDlpPath) throw new Error('yt-dlp 未設定');

    const cfg = getConfig();
    const cookiesPath = cfg.cookiesPath || '';

    const jobId = `job_${Date.now()}_${++dlSeq}`;
    const cacheDir = getVideoCacheDir();
    await ensureDir(cacheDir);

    // 盡量拿到 h264+aac 的 mp4；取不到再交由 yt-dlp fallback
    const formatSel = "bv*[vcodec~='^(avc1|h264)']+ba/best";

    // 優先用 --print after_move:filepath 拿最終輸出路徑（舊版不支援會忽略）
    const metaPrefix = '__meta__';
    const args = [
      ...(cookiesPath ? ['--cookies', cookiesPath] : []),
      '-f', formatSel,
      '--merge-output-format', format,
      '--no-playlist',
      ...(ffmpegPath ? ['--ffmpeg-location', ffmpegPath] : []),
      '--output', path.join(cacheDir, '%(id)s.%(ext)s'),
      '--print', `${metaPrefix}id=%(id)s`,
      '--print', `${metaPrefix}title=%(title)s`,
      '--print', 'after_move:filepath',   // 新：合併/移動後的最終檔路徑
      url
    ];

    const child = spawn(ytDlpPath, args, { windowsHide: true, shell: false });
    running.set(jobId, child);

    const send = (payload) => { try { e.sender.send('ytdlp:progress', payload); } catch { } };

    let finalFile = '';
    let videoId = '';
    let videoTitle = '';
    const reProg = /\[download\]\s+([\d.]+)%.*?at\s+([\d.]+\w+\/s).*?ETA\s+([\d:]+)/i;
    const reDest = /Destination:\s+(.+)\r?$/i;
    const reMerging = /\[Merger\]\s+Merging formats into\s+"(.+)"\r?$/i;
    const reExtractDst = /\[ExtractAudio\]\s+Destination:\s+(.+)\r?$/i;

    const considerChunk = (chunk, stream) => {
      const text = chunk.toString();
      text.split(/\r?\n/).forEach((lineRaw) => {
        if (!lineRaw) return;
        const trimmed = lineRaw.trim();
        if (!trimmed) return;
        if (trimmed.startsWith(metaPrefix)) {
          const rest = trimmed.slice(metaPrefix.length);
          const eq = rest.indexOf('=');
          if (eq > 0) {
            const key = rest.slice(0, eq);
            const value = rest.slice(eq + 1);
            if (key === 'id' && !videoId) videoId = value;
            if (key === 'title' && !videoTitle) videoTitle = value;
          }
          return;
        }

        const mP = lineRaw.match(reProg);
        if (mP) {
          send({ jobId, type: 'progress', percent: Number(mP[1]), speed: mP[2], eta: mP[3] });
        }

        const m1 = lineRaw.match(reMerging) || lineRaw.match(reExtractDst) || lineRaw.match(reDest);
        if (m1 && !finalFile) finalFile = m1[1];

        if (!finalFile && trimmed.length > 0) {
          if (trimmed.startsWith(cacheDir) || /^[A-Za-z]:\\/.test(trimmed) || trimmed.startsWith('/')) {
            finalFile = trimmed;
          }
        }

        send({ jobId, type: 'log', stream, line: lineRaw });
      });
    };

    child.stdout.on('data', (d) => considerChunk(d, 'stdout'));
    child.stderr.on('data', (d) => considerChunk(d, 'stderr'));

    child.on('close', async (code) => {
      running.delete(jobId);
      if (code === 0) {
        // 若仍無 finalFile，嘗試以「最近修改檔」推斷
        if (!finalFile) {
          try {
            const list = await fs.readdir(cacheDir);
            const stats = await Promise.all(list.map(async f => {
              const p = path.join(cacheDir, f);
              const st = await fs.stat(p);
              return { p, mtime: st.mtimeMs, isFile: st.isFile() };
            }));
            const cand = stats.filter(x => x.isFile).sort((a, b) => b.mtime - a.mtime)[0];
            if (cand) finalFile = cand.p;
          } catch { }
        }
        if (finalFile) {
          const filename = path.basename(finalFile);
          let entry = null;
          try {
            entry = await registerVideoDownload({
              id: videoId || path.parse(filename).name,
              title: videoTitle,
              filename
            });
          } catch (err) {
            console.error('[ytdlp:downloadVideo] registerVideoDownload failed', err);
          }
          send({ jobId, type: 'done', filename, entry });
        } else {
          send({ jobId, type: 'error', message: '下載完成但無法定位輸出檔案（可能為舊版 yt-dlp 異常輸出）' });
        }
      } else {
        send({ jobId, type: 'error', message: `yt-dlp 退出碼 ${code}` });
      }
    });

    return { jobId };
  });

  ipcMain.handle('ytdlp:cancel', async (_e, { jobId }) => {
    const child = running.get(jobId);
    if (child) {
      try { child.kill('SIGINT'); } catch { }
      running.delete(jobId);
    }
    return { ok: true };
  });


}

