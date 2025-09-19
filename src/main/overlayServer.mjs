import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import path from 'node:path';
import { store } from './config.mjs';

export class OverlayServer {
  constructor({ rendererDir, assetsDir, userDataPath } = {}) {
    this.rendererDir = rendererDir;
    this.assetsDir = assetsDir;
    this.userDataPath = userDataPath;

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
      fontBuffers,
      style: store.get('output')
    };
    this.app = express();
    this.server = http.createServer(this.app);
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
      if (client.readyState === 1) client.send(s);
    }
  }

  updateState(patch) {
    // 合併狀態
    this.state = { ...this.state, ...patch };
    // 可選：除錯輸出
    if (typeof patch?.subContent === 'string')
      console.log('[overlayServer] subContent len =', patch.subContent.length);
    this.broadcast({ type: 'state', payload: this.state });
  }


  listen(port) {
    return new Promise((resolve, reject) => {
      this.server.listen(port, () => resolve());
      this.server.on('error', reject);
    });
  }

  close() { this.server.close(); }
}
