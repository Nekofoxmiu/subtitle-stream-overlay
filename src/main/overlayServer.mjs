import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import path from 'node:path';
import { processAssForOverlay, DEFAULT_PLAY_RES } from './assUtils.mjs';
import { store } from './config.mjs';

const WS_READY_STATE_OPEN = 1;
const EMPTY_ASS_META = Object.freeze({ alignmentApplied: false, styleUpdated: false, overridesRemoved: 0 });

function mergeStyles(currentStyle, patchStyle) {
  const base = (currentStyle && typeof currentStyle === 'object') ? currentStyle : {};
  const patch = (patchStyle && typeof patchStyle === 'object') ? patchStyle : {};
  return { ...base, ...patch };
}

function clonePlayRes(playRes = DEFAULT_PLAY_RES) {
  return { x: playRes.x, y: playRes.y };
}

export class OverlayServer {
  constructor({ rendererDir, assetsDir, userDataPath } = {}) {
    this.rendererDir = rendererDir;
    this.assetsDir = assetsDir;
    this.userDataPath = userDataPath;
    this.rawSubContent = '';

    const persistedFonts = store.get('fonts');
    const fontBuffers = Array.isArray(persistedFonts)
      ? persistedFonts
          .filter((font) => font && typeof font === 'object')
          .map((font) => {
            const normalized = {};
            if (typeof font.name === 'string' && font.name) normalized.name = font.name;
            if (typeof font.data === 'string' && font.data) normalized.data = font.data;
            if (typeof font.url === 'string' && font.url) normalized.url = font.url;
            return normalized;
          })
          .filter((font) => font.data || font.url)
      : [];

    this.state = {
      subContent: '',
      rawSubContent: '',
      fontBuffers,
      style: store.get('output'),
      playRes: clonePlayRes(),
      assMeta: EMPTY_ASS_META
    };
    this.app = express();
    this.server = http.createServer(this.app);
    this.server.on('error', (err) => {
      if (!this.server.listening) return;
      console.error('[overlayServer] server error', err);
    });
    this.wss = new WebSocketServer({ server: this.server });
    this.setupRoutes();
    this.setupWs();
  }

  setupRoutes() {
    // Serve renderer static files (overlay.mjs, overlay.html resources, etc.)
    if (this.rendererDir) this.app.use(express.static(this.rendererDir));
    // 提供影片快取供 <video> 播放
    this.app.use('/video-cache', express.static(
      path.join(this.userDataPath, 'video-cache')
    ));
    this.app.get('/state', (_req, res) => res.json(this.state));
    this.app.get('/overlay', (_req, res) => {
      res.sendFile(path.join(this.rendererDir, 'overlay.html'));
    });
    this.app.get('/assets/suboct/:file', (req, res) => {
      res.sendFile(path.join(this.assetsDir, 'subtitles-octopus', req.params.file));
    });
    this.app.get('/assets/fonts/:file', (req, res) => {
      res.sendFile(path.join(this.assetsDir, 'fonts', req.params.file));
    });
  }

  setupWs() {
    this.wss.on('connection', ws => {
      ws.send(JSON.stringify({ type: 'state', payload: this.state }));
      ws.on('message', msg => {
        try {
          const { type, payload } = JSON.parse(msg);
          if (type === 'setTime') {
            // 保留：外部時間軸（之後接 YouTube）
            this.broadcast({ type: 'setTime', payload });
          }
        } catch { }
      });
    });
  }

  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const client of this.wss.clients) {
      if (client.readyState === WS_READY_STATE_OPEN) client.send(s);
    }
  }

  updateState(patch = {}) {
    const prevSubContent = this.state?.subContent;
    const mergedStyle = mergeStyles(this.state?.style, patch.style);
    const nextState = {
      ...this.state,
      ...patch,
      style: mergedStyle
    };

    let rawSub = this.rawSubContent;
    if (typeof patch.subContent === 'string') {
      rawSub = patch.subContent;
    } else if (typeof patch.rawSubContent === 'string') {
      rawSub = patch.rawSubContent;
    } else if (typeof nextState.rawSubContent === 'string') {
      rawSub = nextState.rawSubContent;
    }

    let processed = '';
    let playRes = clonePlayRes();
    let assMeta = EMPTY_ASS_META;

    if (rawSub) {
      const result = processAssForOverlay({ assText: rawSub, alignKey: mergedStyle?.align });
      processed = result.text ?? '';
      playRes = result.playRes ? clonePlayRes(result.playRes) : clonePlayRes();
      assMeta = {
        alignmentApplied: Boolean(result.alignmentApplied),
        styleUpdated: Boolean(result.styleUpdated),
        overridesRemoved: Number.isFinite(result.overridesRemoved) ? result.overridesRemoved : 0
      };
    }

    nextState.rawSubContent = rawSub;
    nextState.subContent = processed;
    nextState.playRes = playRes;
    nextState.assMeta = assMeta;

    this.rawSubContent = rawSub;
    this.state = nextState;

    if (typeof processed === 'string' && processed !== prevSubContent) {
      console.log('[overlayServer] subContent len =', processed.length);
    }

    this.broadcast({ type: 'state', payload: this.state });
  }


  listen(port) {
    return new Promise((resolve, reject) => {
      const normalizedPort = typeof port === 'number' ? port : Number.parseInt(port, 10);
      if (!Number.isInteger(normalizedPort) || normalizedPort < 0 || normalizedPort > 65535) {
        reject(new Error('Invalid port value: ' + port));
        return;
      }
      const handleServerError = (err) => {
        this.server.removeListener('error', handleServerError);
        reject(err);
      };
      this.server.once('error', handleServerError);
      this.server.listen(normalizedPort, () => {
        this.server.removeListener('error', handleServerError);
        resolve();
      });
    });
  }
  close() {
    // Ensure WebSocketServer is closed and return a promise that resolves
    // once the underlying HTTP server is closed.
    return new Promise((resolve) => {
      try {
        if (this.wss) {
          try { this.wss.close(); } catch (err) { /* swallow */ }
        }
      } catch (err) { /* noop */ }
      try {
        if (this.server && this.server.close) {
          this.server.close(() => resolve());
          // In case of error during close, resolve anyway after a short timeout
          this.server.on('error', () => setTimeout(resolve, 10));
        } else {
          resolve();
        }
      } catch (err) {
        // If close throws, resolve to avoid blocking shutdown
        resolve();
      }
    });
  }
}

