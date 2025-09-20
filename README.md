# Subtitle Stream Overlay

## 簡介
Subtitle Stream Overlay 是一套以 Electron 建構的字幕疊加工具，內建 HTTP/WS 伺服器與 SubtitlesOctopus 渲染器，能將 ASS/SRT 字幕輸出為綠幕或透明背景，方便串流或錄影軟體直接套用，提供方便的KTV字幕或是直播字幕播放服務。

## 功能特色
- **整合式疊加伺服器**：提供 `/overlay` 頁面、`/state` API 以及字幕/字型資源路徑，可在瀏覽器或串流軟體內直接讀取。
  
- **彈性的字幕樣式**：可輸出透明背景或綠幕、調整對齊方式與設定最大寬度，並根據字幕檔的畫面大小進行等比縮放；可載入內建或使用者上傳的字型。
  
- **本地與線上字幕來源**：介面支援匯入 ASS/SRT/VTT/SSA 字幕，並自動轉換成 ASS；也支持從快取直接讀入。
  
- **影片/字幕快取管理與預覽**：所有下載或匯入的媒體會被存放於應用程式資料夾，使用者可從清單選擇項目、於內建播放器預覽並與疊加畫面同步時間軸。
    
- **YouTube 下載整合**：透過 yt-dlp 與 FFmpeg 取得影片、音訊或字幕，並提供語言選擇、進度回報與快取註冊，方便離線準備素材。
  
- **自動安裝必要工具**：若偵測不到 yt-dlp 或 FFmpeg，系統會提示並自動下載 Windows 版本執行檔與解壓縮，免去手動配置。


## 使用流程
![image](https://github.com/Nekofoxmiu/subtitle-stream-overlay/blob/main/showcase_pic/showcase_1.png?raw=true)
![image](https://github.com/Nekofoxmiu/subtitle-stream-overlay/blob/main/showcase_pic/showcase_2.png?raw=true)
  
- 影片所有者：角蓮Caren(@Caren_surfdemon)  
- 影片來源：[強風オールバック／Yukopi｜cover by 角蓮Caren](https://www.youtube.com/watch?v=OAWxCekrGEI)  
- 此外感謝角蓮的發想，雖然並不是多複雜的程式，但確實算是具有特色以及目前似乎沒有看見同類功能的應用。
  
1. **首次檢查工具**：開啟應用時若缺少 yt-dlp 或 FFmpeg，介面會提示是否自動下載並顯示進度；完成後即可在上方狀態列看到可用的提示。
     
2. **匯入或下載素材**：
   - 點選「選取字幕」匯入本地檔案，會自動轉為 ASS 並儲存至快取。
     
   - 輸入 YouTube 連結後可選擇下載只下載字幕或下載影片/音訊同時下載字幕，支援語言選擇與進度回報。(因此其實理論上這個也可以當作一個YT下載GUI來用就是)
      
   - 亦可匯入本地影片檔或直接使用快取中的檔案於內建播放器預覽。
     
3. **設定樣式與字型**：在「輸出設定」區域調整背景色、對齊與最大寬度，或匯入字型以還原字幕排版。每次更新都會即時同步至疊加畫面並永久儲存。
    ![image](https://github.com/Nekofoxmiu/subtitle-stream-overlay/blob/main/showcase_pic/showcase_6.png?raw=true)
4. **開啟疊加畫面**：
   - 預設可於瀏覽器開啟 `http://localhost:59837/overlay`
   - 或於 OBS 等軟體建立瀏覽器來源指向該 URL；若在設定中調整連接埠，伺服器會自動重新啟動。
   ![image](https://github.com/Nekofoxmiu/subtitle-stream-overlay/blob/main/showcase_pic/showcase_3.png?raw=true)
   ![image](https://github.com/Nekofoxmiu/subtitle-stream-overlay/blob/main/showcase_pic/showcase_5.png?raw=true)
   - 於REALESE有提供HTML可以於OBS匯入，可以自動偵測應用開啟，否則在應用開啟後須手動重新整理網頁
   ![image](https://github.com/Nekofoxmiu/subtitle-stream-overlay/blob/main/showcase_pic/showcase_4.png?raw=true)
       
5. **播放與同步**：內建播放器播放本地影片時會透過 WebSocket 定期推送時間軸，確保疊加畫面與預覽同步。享受你娛樂的影片字幕或是KTV體驗！


## 設定與資料儲存
應用設定透過 `electron-store` 儲存在使用者資料夾，預設值包含輸出連接埠、背景模式、最大寬度、字型清單與播放器音量等，重新啟動後仍會保留先前的調整。


## 手動從源安裝步驟
需求：
- Node.js 21 以上（建議使用 LTS 版本）
- Windows 使用者可直接利用自動安裝的 yt-dlp/FFmpeg；其他平台需手動提供對應的二進位檔案，因預設下載的是 `.exe`。
1. 下載或複製本專案。
2. 安裝相依套件：
   ```bash
   npm install
   ```
3. 啟動開發版應用：
   ```bash
   npm run start
   ```
   應用會啟動主介面並開啟疊加伺服器（預設連接埠 59837）。

如需打包或建立安裝檔，可使用：
- `npm run package` 生成平台專屬的打包檔案。
- `npm run make` 依據 forge 設定建立安裝器或壓縮檔。

## 疊加伺服器端點
- `GET /overlay`：回傳可直接嵌入的字幕疊加頁面。
- `GET /state`：取得目前字幕、字型與樣式設定。
- `WS /`：在連線後收到完整狀態，並於後續廣播字幕更新或時間同步事件。
- `GET /video-cache/*`：提供快取的影片/音訊檔案給 `<video>` 播放。
- `GET /assets/suboct/*`、`GET /assets/fonts/*`：提供 SubtitlesOctopus worker 與內建字型資源。

## 授權
本專案以 MIT 授權釋出，歡迎自由使用與修改。
