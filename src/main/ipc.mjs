import { app, ipcMain, dialog } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { checkAndOfferDownload, getBinPaths } from './binManager.mjs';
import { getConfig, setConfig, store } from './config.mjs';
import { updateOverlayState } from './main.mjs';

let dlSeq = 0;
const running = new Map(); // jobId -> child

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

  // 下載 YouTube 字幕（不抓影片）
  ipcMain.handle('ytdlp:fetchSubs', async (_e, { url, langs = 'zh-Hant,zh-Hans,zh-TW,zh,en.*' }) => {
    const { ytDlpPath } = getBinPaths();
    if (!ytDlpPath) throw new Error('yt-dlp 未設定');
    const cfg = getConfig();
    const cookiesPath = cfg.cookiesPath || '';
    const outDir = path.join(os.tmpdir(), 'ytdlp_subs');
    await fs.mkdir(outDir, { recursive: true });
    const args = [
      ...(cookiesPath ? ['--cookies', cookiesPath] : []),
      '--write-subs',
      '--sub-langs', langs,
      '--skip-download',
      '--convert-subs', 'ass',
      '-o', path.join(outDir, '%(id)s.%(ext)s'),
      url
    ];
    const { out, err } = await run(ytDlpPath, args, { cwd: outDir });
    // 找出 .ass
    const files = await fs.readdir(outDir);
    const ass = files.filter(f => f.toLowerCase().endsWith('.ass'))
      .map(f => path.join(outDir, f));
    return { log: out + err, files: ass };
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
    const cacheDir = path.join(app.getPath('userData'), 'video-cache');
    await fs.mkdir(cacheDir, { recursive: true });

    // 盡量拿到 h264+aac 的 mp4；取不到再交由 yt-dlp fallback
    const formatSel = "bv*[vcodec~='^(avc1|h264)']+ba/best";

    // 優先用 --print after_move:filepath 拿最終輸出路徑（舊版不支援會忽略）
    const args = [
      ...(cookiesPath ? ['--cookies', cookiesPath] : []),
      '-f', formatSel,
      '--merge-output-format', format,
      '--no-playlist',
      ...(ffmpegPath ? ['--ffmpeg-location', ffmpegPath] : []),
      '--output', path.join(cacheDir, '%(id)s.%(ext)s'),
      '--print', 'after_move:filepath',   // 新：合併/移動後的最終檔路徑
      url
    ];

    const child = spawn(ytDlpPath, args, { windowsHide: true, shell: false });
    running.set(jobId, child);

    const send = (payload) => { try { e.sender.send('ytdlp:progress', payload); } catch { } };

    let finalFile = '';
    const reProg = /\[download\]\s+([\d.]+)%.*?at\s+([\d.]+\w+\/s).*?ETA\s+([\d:]+)/i;
    const reDest = /Destination:\s+(.+)\r?$/i;
    const reMerging = /\[Merger\]\s+Merging formats into\s+"(.+)"\r?$/i;
    const reExtractDst = /\[ExtractAudio\]\s+Destination:\s+(.+)\r?$/i;

    const considerLine = (s, stream) => {
      // 1) 進度
      const mP = s.match(reProg);
      if (mP) send({ jobId, type: 'progress', percent: Number(mP[1]), speed: mP[2], eta: mP[3] });

      // 2) 可能的最終路徑（多重 fallback）
      const m1 = s.match(reMerging) || s.match(reExtractDst) || s.match(reDest);
      if (m1 && !finalFile) finalFile = m1[1];

      // 3) --print after_move:filepath 輸出（整行就是最終路徑）
      if (!finalFile && s.trim().length > 0) {
        // 只要像是絕對路徑或 cacheDir 內的相對匹配就採用
        const t = s.trim();
        if (t.startsWith(cacheDir) || /^[A-Za-z]:\\/.test(t) || t.startsWith('/')) {
          finalFile = t;
        }
      }

      // 4) 完整日誌
      send({ jobId, type: 'log', stream, line: s });
    };

    child.stdout.on('data', (d) => considerLine(d.toString(), 'stdout'));
    child.stderr.on('data', (d) => considerLine(d.toString(), 'stderr'));

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
          send({ jobId, type: 'done', filename: path.basename(finalFile) });
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

