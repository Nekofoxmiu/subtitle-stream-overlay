# Subtitle Stream Overlay

## 簡介
Subtitle Stream Overlay 是一套以 Electron 建構的字幕疊加工具，內建 HTTP/WS 伺服器與 SubtitlesOctopus 渲染器，能將 ASS/SRT 字幕輸出為綠幕或透明背景，方便串流或錄影軟體直接套用。【F:src/main/main.mjs†L43-L58】【F:src/main/overlayServer.mjs†L39-L87】【F:src/renderer/overlay.mjs†L42-L178】

## 功能特色
- **整合式疊加伺服器**：應用啟動後會建置一個 Express + WebSocket 伺服器，提供 `/overlay` 頁面、`/state` API 以及字幕/字型資源路徑，可在同一台機器的瀏覽器或串流軟體內直接讀取。【F:src/main/main.mjs†L43-L58】【F:src/main/overlayServer.mjs†L39-L87】
- **彈性的字幕樣式**：疊加端會依據設定自動調整背景（透明或綠幕）、左右對齊與最大寬度，並根據字幕檔的 PlayRes 進行等比縮放；可載入內建或使用者上傳的字型以確保排版一致。【F:src/renderer/overlay.mjs†L42-L143】
- **本地與線上字幕來源**：介面支援匯入 ASS/SRT/VTT/SSA 字幕，必要時會自動轉換成 ASS；也能掃描快取清單並快速套用至疊加畫面。【F:src/renderer/app.mjs†L60-L76】【F:src/renderer/app.mjs†L971-L1056】
- **影片/字幕快取管理與預覽**：所有下載或匯入的媒體會被存放於應用程式資料夾，使用者可從清單選擇項目、於內建播放器預覽並與疊加畫面同步時間軸。【F:src/renderer/app.mjs†L60-L124】【F:src/renderer/app.mjs†L900-L1155】
- **YouTube 下載整合**：透過 yt-dlp 與 FFmpeg 取得影片、音訊或字幕，並提供語言選擇、進度回報與快取註冊，方便離線準備素材。【F:src/renderer/app.mjs†L922-L1100】【F:src/main/ipc.mjs†L456-L710】
- **自動安裝必要工具**：若偵測不到 yt-dlp 或 FFmpeg，系統會提示並自動下載 Windows 版本執行檔與解壓縮，免去手動配置。【F:src/main/binManager.mjs†L103-L170】

## 系統需求
- Node.js 18 以上（建議使用 LTS 版本）
- npm 9 以上
- Windows 使用者可直接利用自動安裝的 yt-dlp/FFmpeg；其他平台需手動提供對應的二進位檔案，因預設下載的是 `.exe`。【F:src/main/binManager.mjs†L108-L167】

## 安裝步驟
1. 下載或複製本專案。
2. 安裝相依套件：
   ```bash
   npm install
   ```
3. 啟動開發版應用：
   ```bash
   npm run start
   ```
   電子應用會啟動主介面並開啟疊加伺服器（預設連接埠 59777）。【F:package.json†L6-L9】【F:src/main/main.mjs†L50-L58】

如需打包或建立安裝檔，可使用：
- `npm run package` 生成平台專屬的打包檔案。
- `npm run make` 依據 forge 設定建立安裝器或壓縮檔。【F:package.json†L6-L9】

## 使用流程
1. **首次檢查工具**：開啟應用時若缺少 yt-dlp 或 FFmpeg，介面會提示是否自動下載並顯示進度；完成後即可在上方狀態列看到可用的路徑。【F:src/main/binManager.mjs†L103-L170】【F:src/renderer/app.mjs†L1059-L1104】
2. **匯入或下載素材**：
   - 點選「選取字幕」匯入本地檔案，必要時會自動轉為 ASS 並儲存至快取。【F:src/renderer/app.mjs†L971-L1015】
   - 輸入 YouTube 連結後可選擇下載字幕或影片/音訊，支援語言選擇與進度回報。【F:src/renderer/app.mjs†L922-L1100】【F:src/main/ipc.mjs†L471-L710】
   - 亦可匯入本地影片檔或直接使用快取中的檔案於內建播放器預覽。【F:src/renderer/app.mjs†L1105-L1155】
3. **設定樣式與字型**：在「輸出設定」區域調整背景色、對齊與最大寬度，或匯入字型以還原字幕排版。每次更新都會即時同步至疊加畫面並永久儲存。【F:src/renderer/app.mjs†L171-L185】【F:src/renderer/app.mjs†L1043-L1056】【F:src/main/config.mjs†L5-L22】
4. **開啟疊加畫面**：預設可於瀏覽器開啟 `http://localhost:59777/overlay`，或於 OBS 等軟體建立瀏覽器來源指向該 URL；若在設定中調整連接埠，伺服器會自動重新啟動。【F:src/main/main.mjs†L50-L85】【F:src/main/overlayServer.mjs†L39-L55】
5. **播放與同步**：內建播放器播放本地影片時會透過 WebSocket 定期推送時間軸，確保疊加畫面與預覽同步。【F:src/renderer/app.mjs†L91-L124】

## 疊加伺服器端點
- `GET /overlay`：回傳可直接嵌入的字幕疊加頁面。
- `GET /state`：取得目前字幕、字型與樣式設定。
- `WS /`：在連線後收到完整狀態，並於後續廣播字幕更新或時間同步事件。
- `GET /video-cache/*`：提供快取的影片/音訊檔案給 `<video>` 播放。
- `GET /assets/suboct/*`、`GET /assets/fonts/*`：提供 SubtitlesOctopus worker 與內建字型資源。【F:src/main/overlayServer.mjs†L39-L55】【F:src/main/overlayServer.mjs†L58-L87】

## 設定與資料儲存
應用設定透過 `electron-store` 儲存在使用者資料夾，預設值包含輸出連接埠、背景模式、最大寬度、字型清單與播放器音量等，重新啟動後仍會保留先前的調整。【F:src/main/config.mjs†L3-L26】

## 授權
本專案以 MIT 授權釋出，歡迎自由使用與修改。【F:package.json†L11-L12】
