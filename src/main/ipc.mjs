import { app, ipcMain, dialog } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { checkAndOfferDownload, getBinPaths } from './binManager.mjs';
import { getConfig, setConfig, store } from './config.mjs';
import { updateOverlayState } from './main.mjs';

let dlSeq = 0;
const running = new Map(); // jobId -> child

const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.opus', '.wma', '.webm']);

const INVALID_FILENAME_CHARS = /[\\/:*?"<>|]/g;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function sanitizeFilenameSegment(value = '') {
  if (!value) return '';
  return value
    .normalize('NFKC')
    .replace(CONTROL_CHARS, '')
    .replace(INVALID_FILENAME_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[\. ]+$/g, '')
    .trim()
    .slice(0, 180);
}

function buildCacheBasename({ title, id, fallbackPrefix = 'entry' } = {}) {
  const safeTitle = sanitizeFilenameSegment(title);
  const safeId = sanitizeFilenameSegment(id);
  let base = safeTitle;
  if (safeId) {
    base = base ? `${base} [${safeId}]` : safeId;
  }
  if (!base) {
    base = `${fallbackPrefix}_${Date.now()}`;
  }
  return base.slice(0, 200);
}

async function ensureUniqueFilename(dir, base, ext, currentPath = null) {
  const safeExt = ext ? (ext.startsWith('.') ? ext : `.${ext}`) : '';
  const initialBase = base && base.trim() ? base : 'entry';
  let candidateBase = initialBase;
  let index = 1;
  while (true) {
    const candidate = `${candidateBase}${safeExt}`;
    const targetPath = path.join(dir, candidate);
    if (currentPath && path.resolve(currentPath) === targetPath) {
      return { filename: candidate, filePath: targetPath };
    }
    try {
      await fs.access(targetPath);
      index += 1;
      candidateBase = `${initialBase} (${index})`;
    } catch {
      return { filename: candidate, filePath: targetPath };
    }
  }
}

async function ingestFileIntoCache(sourcePath, {
  dir,
  title,
  id,
  fallbackPrefix = 'entry',
  defaultExt = '',
  move = false
} = {}) {
  if (!sourcePath) throw new Error('sourcePath is required');
  if (!dir) throw new Error('target dir is required');
  await ensureDir(dir);
  const resolvedSource = path.resolve(sourcePath);
  const stat = await fs.stat(resolvedSource);
  if (!stat.isFile()) throw new Error('sourcePath is not a file');
  let ext = path.extname(resolvedSource);
  if (!ext && defaultExt) {
    ext = defaultExt.startsWith('.') ? defaultExt : `.${defaultExt}`;
  }
  const base = buildCacheBasename({ title, id, fallbackPrefix });
  const { filename, filePath } = await ensureUniqueFilename(dir, base, ext, move ? resolvedSource : null);
  if (path.resolve(resolvedSource) === filePath) {
    return { filename, filePath };
  }
  if (move) {
    try {
      await fs.rename(resolvedSource, filePath);
    } catch (err) {
      try {
        await fs.copyFile(resolvedSource, filePath);
        await fs.unlink(resolvedSource).catch(() => { });
      } catch (copyErr) {
        throw copyErr instanceof Error ? copyErr : err;
      }
    }
  } else {
    await fs.copyFile(resolvedSource, filePath);
  }
  return { filename, filePath };
}

function generateEntryId(prefix = 'entry') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

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

async function registerVideoDownload({ id, title, filename, sourcePath, keepSource = false }) {
  const cacheDir = getVideoCacheDir();
  await ensureDir(cacheDir);
  let finalFilename = filename;
  if (sourcePath) {
    const { filename: storedName } = await ingestFileIntoCache(sourcePath, {
      dir: cacheDir,
      title,
      id,
      fallbackPrefix: 'video',
      move: !keepSource
    });
    finalFilename = storedName;
  } else if (filename) {
    const existingPath = path.join(cacheDir, filename);
    const { filename: normalizedName } = await ingestFileIntoCache(existingPath, {
      dir: cacheDir,
      title,
      id,
      fallbackPrefix: 'video',
      move: true
    });
    finalFilename = normalizedName;
  } else {
    return null;
  }
  const patch = { videoFilename: finalFilename };
  if (id) patch.id = id;
  if (title) patch.title = title;
  return upsertDownloadEntry(patch);
}

async function registerSubtitleDownload({ id, title, sourcePath, keepSource = false }) {
  if (!sourcePath) return null;
  const subsDir = getSubsCacheDir();
  const resolvedSource = path.resolve(sourcePath);
  const move = !keepSource && path.dirname(resolvedSource) === subsDir;
  const { filename: storedName } = await ingestFileIntoCache(resolvedSource, {
    dir: subsDir,
    title,
    id,
    fallbackPrefix: 'subtitle',
    defaultExt: '.ass',
    move
  });
  const patch = { subsFilename: storedName };
  if (id) patch.id = id;
  if (title) patch.title = title;
  return upsertDownloadEntry(patch);
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

async function startYtDlpJob(event, {
  url,
  mode = 'video',
  mergeFormat = 'mp4',
  audioFormat = 'm4a'
} = {}) {
  if (!url) throw new Error('缺少 URL');
  const { ytDlpPath, ffmpegPath } = getBinPaths();
  if (!ytDlpPath) throw new Error('yt-dlp 未設定');

  const cfg = getConfig();
  const cookiesPath = cfg.cookiesPath || '';

  const mergeFmt = typeof mergeFormat === 'string' && mergeFormat.trim() ? mergeFormat.trim() : 'mp4';
  const audioFmt = typeof audioFormat === 'string' ? audioFormat.trim() : '';

  const jobId = `job_${Date.now()}_${++dlSeq}`;
  const cacheDir = getVideoCacheDir();
  await ensureDir(cacheDir);

  const metaPrefix = '__meta__';
  const formatSel = mode === 'audio'
    ? 'bestaudio/best'
    : "bv*[vcodec~='^(avc1|h264)']+ba/best";
  const cookiesArgs = cookiesPath ? ['--cookies', cookiesPath] : [];
  const ffmpegArgs = ffmpegPath ? ['--ffmpeg-location', ffmpegPath] : [];
  const modeArgs = mode === 'audio'
    ? ['-f', formatSel, '--extract-audio', '--audio-quality', '0', ...(audioFmt ? ['--audio-format', audioFmt] : [])]
    : ['-f', formatSel, '--merge-output-format', mergeFmt];

  const args = [
    ...cookiesArgs,
    ...modeArgs,
    '--no-playlist',
    ...ffmpegArgs,
    '--output', path.join(cacheDir, '%(id)s.%(ext)s'),
    '--print', `${metaPrefix}id=%(id)s`,
    '--print', `${metaPrefix}title=%(title)s`,
    '--print', 'after_move:filepath',
    url
  ];

  const child = spawn(ytDlpPath, args, { windowsHide: true, shell: false });
  running.set(jobId, child);

  const send = (payload) => {
    try { event.sender.send('ytdlp:progress', payload); } catch { }
  };

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
          console.error('[ytdlp] registerVideoDownload failed', err);
        }
        const normalizedName = entry?.videoFilename || filename;
        send({ jobId, type: 'done', filename: normalizedName, entry, mode });
      } else {
        send({ jobId, type: 'error', message: '下載完成但無法定位輸出檔案（可能為舊版 yt-dlp 異常輸出）' });
      }
    } else {
      send({ jobId, type: 'error', message: `yt-dlp 退出碼 ${code}` });
    }
  });

  return { jobId };
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

  ipcMain.handle('cache:importLocal', async (_e, payload = {}) => {
    const {
      id,
      videoPath,
      videoTitle,
      subsPath,
      subsTitle,
      title
    } = payload || {};

    const videoPathStr = typeof videoPath === 'string' ? videoPath : '';
    const subsPathStr = typeof subsPath === 'string' ? subsPath : '';
    if (!videoPathStr && !subsPathStr) {
      throw new Error('缺少匯入檔案');
    }

    const normalize = (val) => (typeof val === 'string' ? val.trim() : '');
    const baseTitle = normalize(title);
    const videoBaseTitle = normalize(videoTitle) || (videoPathStr ? path.parse(videoPathStr).name : '');
    const subsBaseTitle = normalize(subsTitle) || (subsPathStr ? path.parse(subsPathStr).name : '');

    const existingRaw = id ? readDownloadStore().find((item) => item?.id === id) : null;
    let entryId = id || existingRaw?.id || generateEntryId('local');
    let effectiveTitle = normalize(existingRaw?.title) || baseTitle || videoBaseTitle || subsBaseTitle;
    let entry = null;

    if (videoPathStr) {
      const titleForVideo = effectiveTitle || videoBaseTitle || subsBaseTitle;
      try {
        entry = await registerVideoDownload({
          id: entryId,
          title: titleForVideo || undefined,
          sourcePath: videoPathStr,
          keepSource: true
        });
        if (entry?.id) entryId = entry.id;
        if (entry?.title) effectiveTitle = entry.title;
      } catch (err) {
        throw new Error(`匯入媒體失敗：${err?.message || err}`);
      }
    }

    if (subsPathStr) {
      const titleForSubs = effectiveTitle || subsBaseTitle || videoBaseTitle;
      try {
        entry = await registerSubtitleDownload({
          id: entryId,
          title: titleForSubs || undefined,
          sourcePath: subsPathStr,
          keepSource: true
        });
        if (entry?.id) entryId = entry.id;
        if (entry?.title) effectiveTitle = entry.title;
      } catch (err) {
        throw new Error(`匯入字幕失敗：${err?.message || err}`);
      }
    }

    if (!entry && existingRaw) {
      entry = await buildDownloadEntry(existingRaw);
    }

    if (!entry) {
      const patch = { id: entryId };
      if (effectiveTitle) patch.title = effectiveTitle;
      entry = await upsertDownloadEntry(patch);
    } else if (effectiveTitle && entry.title !== effectiveTitle) {
      entry = await upsertDownloadEntry({ id: entry.id, title: effectiveTitle });
    }

    return entry;
  });

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


  ipcMain.handle('ytdlp:downloadVideo', (e, { url, format = 'mp4' } = {}) => {
    return startYtDlpJob(e, { url, mode: 'video', mergeFormat: format });
  });

  ipcMain.handle('ytdlp:downloadAudio', (e, { url, audioFormat = 'm4a' } = {}) => {
    return startYtDlpJob(e, { url, mode: 'audio', audioFormat });
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

