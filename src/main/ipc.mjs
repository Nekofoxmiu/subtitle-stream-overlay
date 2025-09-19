import { app, ipcMain, dialog } from 'electron';
import { execFile } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
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

function bufferFromIpcData(raw) {
  if (!raw) return null;
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  if (ArrayBuffer.isView(raw)) {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  }
  if (typeof raw === 'string') {
    return Buffer.from(raw, 'base64');
  }
  throw new Error('Unsupported file payload');
}

function normalizeIncomingFile(file) {
  if (!file || typeof file !== 'object') return null;
  const name = typeof file.name === 'string' ? file.name : '';
  let data = null;
  if ('data' in file) data = bufferFromIpcData(file.data);
  if (!data && 'buffer' in file) data = bufferFromIpcData(file.buffer);
  if (!data && 'content' in file) data = bufferFromIpcData(file.content);
  if (!data && file instanceof ArrayBuffer) data = bufferFromIpcData(file);
  if (!data) return null;
  return { name, data };
}

async function persistIncomingFileToCache(file, { dir, title, id, fallbackPrefix, defaultExt } = {}) {
  const normalized = normalizeIncomingFile(file);
  if (!normalized) return null;
  const { name, data } = normalized;
  const parsed = path.parse(name || '');
  const ext = parsed.ext || defaultExt || '';
  const baseName = sanitizeFilenameSegment(parsed.name || parsed.base);
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overlay-upload-'));
  const tmpName = baseName ? `${baseName}${ext || ''}` : `upload${ext || ''}`;
  const tmpPath = path.join(tmpRoot, tmpName || `upload_${Date.now()}`);
  await fs.writeFile(tmpPath, data);
  try {
    const { filename, filePath } = await ingestFileIntoCache(tmpPath, {
      dir,
      title,
      id,
      fallbackPrefix,
      defaultExt: ext || defaultExt,
      move: true,
      preserveBasename: true
    });
    return { filename, filePath, baseName };
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => { });
  }
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
  move = false,
  preserveBasename = false
} = {}) {
  if (!sourcePath) throw new Error('sourcePath is required');
  if (!dir) throw new Error('target dir is required');
  await ensureDir(dir);
  const resolvedSource = path.resolve(sourcePath);
  const stat = await fs.stat(resolvedSource);
  if (!stat.isFile()) throw new Error('sourcePath is not a file');
  // 若來源檔已在目標資料夾，且為移動且不要求保留原名 → 直接沿用 yt-dlp 產生的檔名，避免二次改名造成亂碼
  if (move && path.dirname(resolvedSource) === path.resolve(dir) && !preserveBasename) {
    return { filename: path.basename(resolvedSource), filePath: resolvedSource };
  }
  let ext = path.extname(resolvedSource);
  if (!ext && defaultExt) {
    ext = defaultExt.startsWith('.') ? defaultExt : `.${defaultExt}`;
  }
  const baseCandidates = [];
  const seen = new Set();
  const addCandidate = (baseName, baseExt) => {
    if (!baseName) return;
    const extVal = baseExt || '';
    const key = `${baseName}|${extVal}`;
    if (seen.has(key)) return;
    seen.add(key);
    baseCandidates.push({ base: baseName, ext: extVal });
  };

  if (preserveBasename) {
    const parsed = path.parse(resolvedSource);
    const originalBase = parsed.name || parsed.base;
    const originalExt = parsed.ext || ext;
    addCandidate(originalBase, originalExt);
  }

  const fallbackBase = buildCacheBasename({ title, id, fallbackPrefix });
  addCandidate(fallbackBase, ext);

  let lastError = null;
  for (const { base: candidateBase, ext: candidateExt } of baseCandidates) {
    const { filename, filePath } = await ensureUniqueFilename(dir, candidateBase, candidateExt, move ? resolvedSource : null);
    if (path.resolve(resolvedSource) === filePath) {
      return { filename, filePath };
    }

    let opError = null;
    if (move) {
      try {
        await fs.rename(resolvedSource, filePath);
      } catch (err) {
        try {
          await fs.copyFile(resolvedSource, filePath);
          await fs.unlink(resolvedSource).catch(() => { });
        } catch (copyErr) {
          opError = copyErr instanceof Error ? copyErr : err;
        }
      }
    } else {
      try {
        await fs.copyFile(resolvedSource, filePath);
      } catch (err) {
        opError = err instanceof Error ? err : new Error(String(err));
      }
    }

    if (!opError) {
      return { filename, filePath };
    }

    lastError = opError;
  }

  if (lastError) throw lastError;
  throw new Error('無法匯入檔案');
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
      id,                      // 保留原始 id 作為檔名參考，不加後綴
      fallbackPrefix: 'video',
      move: !keepSource
    });
    finalFilename = storedName;
  } else if (filename) {
    const existingPath = path.join(cacheDir, filename);
    const { filename: normalizedName } = await ingestFileIntoCache(existingPath, {
      dir: cacheDir,
      title,
      id,                      // 同上：僅作為檔名基底
      fallbackPrefix: 'video',
      move: true
    });
    finalFilename = normalizedName;
  } else {
    return null;
  }

  // 依副檔名判斷型別，並在條目 id 上加不互斥後綴
  const ext = path.extname(finalFilename).toLowerCase();
  const isAudio = AUDIO_EXTS.has(ext);

  // 先移除既有後綴再統一加正確後綴，避免重複
  const baseId = String(id || path.parse(finalFilename).name).replace(/#(?:audio|video)$/, '');
  const effectiveId = `${baseId}#${isAudio ? 'audio' : 'video'}`;

  const patch = {
    id: effectiveId,
    title,
    videoFilename: finalFilename
  };
  return upsertDownloadEntry(patch);
}


async function registerSubtitleDownload({ id, title, sourcePath, filename, keepSource = false }) {
  const subsDir = getSubsCacheDir();
  await ensureDir(subsDir);
  let finalFilename = filename;
  if (sourcePath) {
    const resolvedSource = path.resolve(sourcePath);
    const move = !keepSource && path.dirname(resolvedSource) === subsDir;
    const result = await ingestFileIntoCache(resolvedSource, {
      dir: subsDir,
      title,
      id,
      fallbackPrefix: 'subtitle',
      defaultExt: '.ass',
      move,
      preserveBasename: keepSource
    });
    finalFilename = result.filename;
  } else if (filename) {
    const existingPath = path.join(subsDir, filename);
    const result = await ingestFileIntoCache(existingPath, {
      dir: subsDir,
      title,
      id,
      fallbackPrefix: 'subtitle',
      defaultExt: '.ass',
      move: true
    });
    finalFilename = result.filename;
  } else {
    return null;
  }

  const patch = { subsFilename: finalFilename };
  if (id) patch.id = id;
  if (title) patch.title = title;
  return upsertDownloadEntry(patch);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 * 16, ...opts }, (error, stdout, stderr) => {
      if (error) {
        const message = typeof error === 'object' && error !== null && 'message' in error
          ? error.message
          : String(error);
        reject(new Error(stderr || stdout || message));
        return;
      }
      resolve({ code: 0, out: stdout ?? '', err: stderr ?? '' });
    });
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
    ? 'bestaudio[ext!=webm]/bestaudio/best'
    : 'bestvideo[ext!=webm]+bestaudio[ext!=webm]/bestvideo+bestaudio/best';
  const cookiesArgs = cookiesPath ? ['--cookies', cookiesPath] : [];
  const ffmpegArgs = ffmpegPath ? ['--ffmpeg-location', ffmpegPath] : [];
  const modeArgs = mode === 'audio'
    ? ['-f', formatSel, '--extract-audio', '--audio-quality', '0', ...(audioFmt ? ['--audio-format', audioFmt] : [])]
    : ['-f', formatSel, '--merge-output-format', mergeFmt];

  const args = [
    ...cookiesArgs,
    ...modeArgs,
    '--no-playlist',
    '--progress',
    '--newline',
    '--no-color',
    '--encoding', 'utf-8',
    '--embed-metadata',
    '--embed-thumbnail',
    ...ffmpegArgs,
    '--output', path.join(cacheDir, '%(title)s_%(id)s.%(ext)s'),
    url
  ];

  const child = execFile(ytDlpPath, args, { windowsHide: true, windowsVerbatimArguments: false, encoding: 'utf8', maxBuffer: 1024 * 1024 * 16 });
  running.set(jobId, child);

  const send = (payload) => {
    try { event.sender.send('ytdlp:progress', payload); } catch { }
  };

  let finalFile = '';
  let videoId = '';
  let videoTitle = '';
  // ===== 1) 既有：進度條維持不變 =====
  const reProg = /\[download\]\s+([\d.]+)%.*?at\s+([\d.]+\w+\/s).*?ETA\s+([\d:]+)/i;

  // ===== 2) 型別與副檔名白名單 =====
  const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.webm', '.mov', '.m4v']);
  const AUDIO_EXTS = new Set(['.m4a', '.mp3', '.flac', '.wav', '.ogg', '.opus', '.aac', '.mka']);

  // 中間檔（分離串流）排除片段：.401.ext / .f137.ext 等
  const INTERMEDIATE = String.raw`\.(?:f)?\d{2,4}\.`;

  // 根據任務型別產生對應 regex
  function makeRegexByMode(mode /* 'video' | 'audio' */) {
    const exts =
      mode === 'audio'
        ? '(?:m4a|mp3|flac|wav|ogg|opus|aac|mka)'
        : '(?:mp4|mkv|webm|mov|m4v)';

    // Destination: 僅接受對應型別的副檔名，並排除中間檔
    const reDest = new RegExp(
      `Destination:\\s+(?!.*${INTERMEDIATE}${exts}\\s*$)(.+\\.${exts})\\r?$`,
      'i'
    );

    // Video 的合併輸出
    const reMerging =
      mode === 'video'
        ? new RegExp(
          String.raw`\[Merger\]\s+Merging formats into\s+"(.+?\.(?:mp4|mkv|webm|mov|m4v))"\r?$`,
          'i'
        )
        : null;

    // Audio 的抽取輸出
    const reExtractDst =
      mode === 'audio'
        ? new RegExp(
          `\\[ExtractAudio\\]\\s+Destination:\\s+(?!.*${INTERMEDIATE}(?:m4a|mp3|flac|wav|ogg|opus|aac|mka)\\s*$)(.+\\.(?:m4a|mp3|flac|wav|ogg|opus|aac|mka))\\r?$`,
          'i'
        )
        : null;

    return { reDest, reMerging, reExtractDst };
  }
  
  const { reDest, reMerging, reExtractDst } = makeRegexByMode(mode);

  const considerChunk = (chunk, stream) => {
    const text = chunk.toString('utf8').replace(/\r(?!\n)/g, '\n'); // 將裸 CR 正規化成換行
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

  if (child.stdout) child.stdout.on('data', (d) => considerChunk(d, 'stdout'));
  if (child.stderr) child.stderr.on('data', (d) => considerChunk(d, 'stderr'));

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
      title,
      videoFile,
      subsFile
    } = payload || {};

    let videoPathStr = typeof videoPath === 'string' ? videoPath : '';
    let subsPathStr = typeof subsPath === 'string' ? subsPath : '';
    const hasIncomingVideoFile = Boolean(videoFile && !videoPathStr);
    const hasIncomingSubsFile = Boolean(subsFile && !subsPathStr);
    if (!videoPathStr && !subsPathStr && !hasIncomingVideoFile && !hasIncomingSubsFile) {
      throw new Error('缺少匯入檔案');
    }

    const normalize = (val) => (typeof val === 'string' ? val.trim() : '');
    const baseTitle = normalize(title);

    const existingRaw = id ? readDownloadStore().find((item) => item?.id === id) : null;
    let entryId = id || existingRaw?.id || generateEntryId('local');
    let effectiveTitle = normalize(existingRaw?.title) || baseTitle || '';
    let entry = null;

    let videoUpload = null;
    if (hasIncomingVideoFile) {
      videoUpload = await persistIncomingFileToCache(videoFile, {
        dir: getVideoCacheDir(),
        title: effectiveTitle || undefined,
        id: entryId,
        fallbackPrefix: 'video'
      });
      if (videoUpload) {
        videoPathStr = path.join(getVideoCacheDir(), videoUpload.filename);
      }
    }

    let subsUpload = null;
    if (hasIncomingSubsFile) {
      subsUpload = await persistIncomingFileToCache(subsFile, {
        dir: getSubsCacheDir(),
        title: effectiveTitle || undefined,
        id: entryId,
        fallbackPrefix: 'subtitle',
        defaultExt: '.ass'
      });
      if (subsUpload) {
        subsPathStr = path.join(getSubsCacheDir(), subsUpload.filename);
      }
    }

    const videoBaseTitle = normalize(videoTitle)
      || videoUpload?.baseName
      || (videoPathStr ? path.parse(videoPathStr).name : '');
    const subsBaseTitle = normalize(subsTitle)
      || subsUpload?.baseName
      || (subsPathStr ? path.parse(subsPathStr).name : '');
    if (!effectiveTitle) effectiveTitle = videoBaseTitle || subsBaseTitle;

    const hasVideoImport = Boolean(videoPathStr);
    const hasSubsImport = Boolean(subsPathStr);
    const decoupleSubs = !id && hasVideoImport && hasSubsImport;

    if (hasVideoImport) {
      const titleForVideo = effectiveTitle || videoBaseTitle || subsBaseTitle;
      try {
        if (videoUpload) {
          entry = await registerVideoDownload({
            id: entryId,
            title: titleForVideo || undefined,
            filename: videoUpload.filename
          });
        } else {
          entry = await registerVideoDownload({
            id: entryId,
            title: titleForVideo || undefined,
            sourcePath: videoPathStr,
            keepSource: true
          });
        }
        if (entry?.id) entryId = entry.id;
        if (entry?.title) effectiveTitle = entry.title;
      } catch (err) {
        throw new Error(`匯入媒體失敗：${err?.message || err}`);
      }
    }

    if (hasSubsImport) {
      const titleForSubs = effectiveTitle || subsBaseTitle || videoBaseTitle;
      const subsEntryId = decoupleSubs ? generateEntryId('local_sub') : entryId;
      try {
        if (subsUpload) {
          entry = await registerSubtitleDownload({
            id: subsEntryId,
            title: titleForSubs || undefined,
            filename: subsUpload.filename
          });
        } else {
          entry = await registerSubtitleDownload({
            id: subsEntryId,
            title: titleForSubs || undefined,
            sourcePath: subsPathStr,
            keepSource: true
          });
        }
        if (!decoupleSubs && entry?.id) entryId = entry.id;
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
  ipcMain.handle('ytdlp:fetchSubs', async (event, { url, langs } = {}) => {
    if (!url) throw new Error('缺少 URL');

    const { ytDlpPath, ffmpegPath } = getBinPaths();
    if (!ytDlpPath) throw new Error('yt-dlp 未設定');

    const cfg = getConfig();
    const cookiesPath = cfg.cookiesPath || '';
    const cookiesArgs = cookiesPath ? ['--cookies', cookiesPath] : [];
    const ffmpegArgs = ffmpegPath ? ['--ffmpeg-location', ffmpegPath] : [];

    // 1) 若未指定語言 → 先探測可用字幕並以彈窗請使用者選擇
    let selectedLangs = langs;
    let useAuto = false; // 新增：標記是否使用自動字幕
    if (!selectedLangs) {
      const probeArgs = [
        ...cookiesArgs, '--no-playlist', '-J', url
      ];
      const { out } = await run(ytDlpPath, probeArgs);
      let info = null;
      try { info = JSON.parse(out); } catch { /* 忽略解析失敗 */ }

      const manual = info?.subtitles ? Object.keys(info.subtitles) : [];
      const auto = info?.automatic_captions ? Object.keys(info.automatic_captions) : [];

      //過濾掉'live_chat'因為其為Json格式無法轉換成字幕檔
      const liveChatIdx = manual.indexOf('live_chat');
      if (liveChatIdx > -1) manual.splice(liveChatIdx, 1);

      // 無任何字幕
      if (manual.length === 0 && auto.length === 0) {
        await dialog.showMessageBox(event.sender.getOwnerBrowserWindow(), {
          type: 'info',
          buttons: ['確定'],
          title: '沒有可用字幕',
          message: '此影片沒有可用字幕（含自動字幕）。'
        });
        throw new Error('此影片沒有可用字幕');
      }

      // 語言偏好排序 + 截斷
      const pref = (s) =>
        s.startsWith('zh-Hant') || s.startsWith('zh-TW') ? 0 :
          s.startsWith('zh-Hans') || s.startsWith('zh-CN') ? 1 :
            s === 'zh' || s.startsWith('zh-') ? 2 :
              s === 'en' || s.startsWith('en-') ? 3 :
                s === 'ja' || s.startsWith('ja-') ? 4 : 9;
      const sortAndTrim = (arr) => [...new Set(arr)]
        .sort((a, b) => pref(a) - pref(b) || a.localeCompare(b))
        .slice(0, 12);

      let candidates = [];
      if (manual.length > 0) {
        // 僅列出人工字幕（避免把所有自動語言列出）
        candidates = sortAndTrim(manual);
      } else {
        // 沒有人工字幕 → 先詢問是否改抓自動字幕
        const confirm = await dialog.showMessageBox(event.sender.getOwnerBrowserWindow(), {
          type: 'warning',
          buttons: ['使用自動字幕', '取消'],
          defaultId: 0,
          cancelId: 1,
          title: '沒有人工字幕',
          message: '此影片沒有人工字幕。',
          detail: '僅提供自動產生字幕（辨識品質可能較差）。是否改為下載自動字幕？'
        });
        if (confirm.response !== 0) throw new Error('使用者取消選擇字幕語言');
        useAuto = true;
        candidates = sortAndTrim(auto);
      }

      const r = await dialog.showMessageBox(event.sender.getOwnerBrowserWindow(), {
        type: 'question',
        buttons: candidates,
        cancelId: -1,
        title: '選擇字幕語言',
        message: useAuto ? '請選擇自動字幕語言：' : '請選擇字幕語言：',
        detail: candidates.join('  ')
      });
      if (r.response < 0) throw new Error('使用者取消選擇字幕語言');
      selectedLangs = candidates[r.response];
    }

    // 2) 建構 yt-dlp 下載字幕參數（人工 vs 自動分流）
    const subsDir = getSubsCacheDir();
    await ensureDir(subsDir);
    const outTpl = path.join(subsDir, '%(title)s_%(id)s.%(ext)s');

    const args = [
      ...cookiesArgs,
      '--no-playlist',
      '--skip-download',
      ...(useAuto ? ['--write-auto-sub'] : ['--write-subs']), // 這行為重點：自動字幕才用 --write-auto-sub
      '--progress',
      '--newline',
      '--no-color',
      '--encoding', 'utf-8',
      '--sub-langs', selectedLangs,       // 例如 'zh-Hant' 或 'en'
      '--convert-subs', 'ass',
      ...ffmpegArgs,
      '--output', outTpl,
      url
    ];


    // 3) 串流標準輸出至前端（與下載進度相同事件通道）
    const send = (payload) => { try { event.sender.send('ytdlp:progress', payload); } catch { } };
    const child = execFile(ytDlpPath, args, {
      windowsHide: true,
      windowsVerbatimArguments: false,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 16,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        NO_COLOR: '1',
        ...(process.platform === 'win32' ? {} : { LANG: process.env.LANG || 'en_US.UTF-8', LC_ALL: process.env.LC_ALL || 'en_US.UTF-8' })
      }
    });

    if (child.stdout) child.stdout.on('data', (d) => String(d).split(/\r?\n/).forEach(line => line && send({ type: 'log', stream: 'stdout', line })));
    if (child.stderr) child.stderr.on('data', (d) => String(d).split(/\r?\n/).forEach(line => line && send({ type: 'log', stream: 'stderr', line })));

    const { code, out, err } = await new Promise((resolve) => {
      let so = '', se = '';
      if (child.stdout) child.stdout.on('data', (d) => { so += d.toString(); });
      if (child.stderr) child.stderr.on('data', (d) => { se += d.toString(); });
      child.on('close', (c) => resolve({ code: c ?? 0, out: so, err: se }));
    });
    if (code !== 0) throw new Error(err || out || `yt-dlp 退出碼 ${code}`);

    // 4) 找出此次輸出的 .ass，因為改為 title_id 模板 → 以「包含 id」比對
    const meta = await (async () => {
      // 直接用 -J 取回 id/title，與輸出名對齊
      const { out: j } = await run(ytDlpPath, [...cookiesArgs, '--no-playlist', '-J', url]);
      try { const info = JSON.parse(j); return { id: info?.id || '', title: info?.title || '' }; } catch { return { id: '', title: '' }; }
    })();

    let list = await fs.readdir(subsDir);
    list = list.filter(name => name.toLowerCase().endsWith('.ass') && (!meta.id || name.includes(meta.id)));
    const assPaths = list.map(name => path.join(subsDir, name));

    // 5) 登記快取（維持既有介面）
    const entries = [];
    for (const assPath of assPaths) {
      const entry = await registerSubtitleDownload({ id: meta.id || path.parse(assPath).name, title: meta.title, sourcePath: assPath });
      if (entry) entries.push(entry);
    }
    const normalizedFiles = entries.map(e => e?.subsPath).filter(Boolean);
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

