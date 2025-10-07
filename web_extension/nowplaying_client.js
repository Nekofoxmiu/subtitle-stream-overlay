var conn = null;
var transfer_interval = null;
var join_interval = null;
var hostname = window.location.hostname;
const FETCH_URL = 'ws://localhost:59837/';
var join_retry_time = 2000
var lastStatus = 'stopped';
var guid = generateGuid();


if (location.host === 'www.youtube.com') {
    chrome.runtime.sendMessage({ type: 'INJECT_YT_PROBE' }, () => { });
}

let ytLiveFlag = null;
let ytLiveDurationMs = null;

window.addEventListener('message', (e) => {
    if (e.source === window && e.data && e.data.type === 'YT_LIVE_STATUS') {
        ytLiveFlag = !!e.data.live;
        ytLiveDurationMs = (typeof e.data.durationMs === 'number' && e.data.durationMs >= 0)
            ? Math.floor(e.data.durationMs)
            : null;
    }
});

function join() {
    conn = new WebSocket(FETCH_URL);

    conn.addEventListener('open', function (event) {
        console.log('Connection to Now Playing server established');
        conn.send(`connected - ${hostname} (${guid})`);
        start_transfer();
        if (join_interval) {
            clearTimeout(join_interval);
            join_interval = null;
        };
    });

    conn.addEventListener('close', function () {
        clearTimeout(join_interval);
        clearInterval(transfer_interval);
        join_interval = setTimeout(function () { join() }, join_retry_time);
    });
};

// https://github.com/CyberJack/chrome_guid/blob/master/chrome_guid/src/guid_content.js
function generateGuid() {
    var uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
    return uuid;
}

function query(target, fun, alt = null) {
    var element = document.querySelector(target);
    if (element !== null) {
        return fun(element);
    }
    return alt;
};

function timestamp_to_ms(ts) {
    var splits = ts.split(':');
    if (splits.length == 2) {
        return splits[0] * 60 * 1000 + splits[1] * 1000;
    } else if (splits.length == 3) {
        return splits[0] * 60 * 60 * 1000 + splits[1] * 60 * 1000 + splits[2] * 1000;
    }
    return 0;
};

function normalizeStatus(status) {
    if (status === 'playing') {
        return 'playing';
    }
    if (status === null || status === undefined) {
        return null;
    }

    const normalized = String(status).toLowerCase();
    if (normalized === 'playing') {
        return 'playing';
    }
    if (normalized === 'paused' || normalized === 'stopped' || normalized === 'none') {
        return 'stopped';
    }

    return null;
};

function sendPlaybackUpdate(data) {
    const status = normalizeStatus(data.status);
    if (!status) {
        return;
    }

    if (!conn || conn.readyState !== WebSocket.OPEN) {
        return;
    }

    const payload = { ...data, status };

    if (status === 'playing') {
        lastStatus = 'playing';
        conn.send(JSON.stringify(payload));
        return;
    }

    if (lastStatus !== 'stopped') {
        lastStatus = 'stopped';
        conn.send(JSON.stringify(payload));
    }
};

function spotifyIsPlaying(el) {
    const pressed = el.getAttribute('aria-pressed');
    if (pressed !== null) return pressed === 'true';

    // 回退到 aria-label：支援多語系關鍵字
    const label = (el.getAttribute('aria-label') || '').trim().toLowerCase();
    // 「暫停/Pause」通常表示目前正在播放（按鈕動作是暫停）
    const pauseKeys = ['暫停', '暂停', 'pause', 'pausa', 'pausear'];
    const playKeys = ['播放', 'play', 'reproducir', 'lecture'];

    if (pauseKeys.some(k => label.includes(k))) return true;   // 正在播放
    if (playKeys.some(k => label.includes(k))) return false;  // 已暫停
    // 無法判斷時回傳 null 或自訂預設
    return null;
}

function start_transfer() {
    transfer_interval = setInterval(() => {
        // TODO: maybe add more?
        if (hostname === 'soundcloud.com') {
            let status = query('.playControl', e => e.classList.contains('playing') ? "playing" : "stopped", 'unknown');
            let cover = query('.playbackSoundBadge span.sc-artwork', e => e.style.backgroundImage.slice(5, -2).replace('t50x50', 't500x500'));
            let title = query('.playbackSoundBadge__titleLink', e => e.title);
            let artists = [query('.playbackSoundBadge__lightLink', e => e.title)];
            let progress = query('.playbackTimeline__timePassed span:nth-child(2)', e => timestamp_to_ms(e.textContent));
            let duration = query('.playbackTimeline__duration span:nth-child(2)', e => timestamp_to_ms(e.textContent));
            let song_link = ''

            if (document.getElementsByClassName('playbackSoundBadge__avatar').length > 0) {
                song_link = document.getElementsByClassName('playbackSoundBadge__avatar')[0].href.split('?')[0];
            }

            if (!title)
                return;

            sendPlaybackUpdate({ guid, cover, title, artists, status, progress, duration, song_link, platform: 'soundcloud', is_live: false });
        } else if (hostname === 'open.spotify.com') {
            let data = navigator.mediaSession;
            const playStatusEl = document.querySelector('button[data-testid="control-button-playpause"]');
            let status = playStatusEl ? (spotifyIsPlaying(playStatusEl) ? 'playing' : 'stopped') : 'stopped';
            let cover = ''
            let title = ''
            let artists = ''
            if (data.metadata != null) {
                cover = data.metadata.artwork[0].src;
                title = data.metadata.title
                artists = [data.metadata.artist]
            }
            const progressEl = document.querySelector('div[data-testid="playback-position"]');
            let progress = progressEl ? timestamp_to_ms(progressEl.textContent) : 0;
            const durationEl = document.querySelector('div[data-testid="playback-duration"]');
            let duration = durationEl ? timestamp_to_ms(durationEl.textContent) : 0;
            let song_link = ''
            if (document.querySelectorAll('a[aria-label][data-context-item-type="track"]').length > 0) {
                song_link = 'https://open.spotify.com/track/' + decodeURIComponent(document.querySelectorAll('a[aria-label][data-context-item-type="track"]')[0].href).split(':').slice(-1)[0];
            }

            if (title === '')
                return;

            sendPlaybackUpdate({ guid, cover, title, artists, status, progress, duration, song_link, platform: 'spotify', is_live: false });
        } else if (hostname === 'www.youtube.com') {
            if (!navigator.mediaSession.metadata) {
                return;
            }

            // 在主頁面
            if (window.location.href == 'https://www.youtube.com/') {
                return;
            }

            let title, artists, status, duration, progress, cover, song_link, is_live = false;

            title = navigator.mediaSession.metadata.title;

            if (!title || title === '')
                return;

            duration = query('video', e => e.duration * 1000);
            progress = query('video', e => e.currentTime * 1000);

            // 檢測觀看的影片是否正在直播中
            is_live = ytLiveFlag || false;

            //是直播且window.location.href不是shorts，由於從直播頁點shorts，直播頁面會在背景會誤顯示true
            const isShorts = /youtube\.com\/shorts\//.test(window.location.href);

            if (is_live && !isShorts) {
                if (ytLiveDurationMs != null) {
                    duration = ytLiveDurationMs;
                }
            }
            else {
                is_live = false
            }

            // 由於混亂的 shorts 機制，從直播切換到 shorts 的時候會導致網頁上出現兩個 <video>
            // 並且該兩個 <video> 的 baseURI 都會被改成 shorts 的
            // 但其中一個是假的錯誤的 live 殘餘容器問詢其會導致出現 duration 為 NaN 甚至是各種不可預期的值的狀況
            if ((!duration || !progress) && !is_live && isShorts) {
                const videos = document.querySelectorAll('video');
                for (const v of videos) {
                    if (v.duration > 0 && v.currentTime >= 0) {
                        duration = v.duration * 1000;
                        progress = v.currentTime * 1000;
                        break;
                    }
                }
            }

            // 改用 mediaSession 來獲取作者資訊
            artists = [navigator.mediaSession.metadata.artist];
            status = navigator.mediaSession.playbackState; // playbackState = playing, paused, none

            cover = navigator.mediaSession.metadata.artwork[0].src;
            song_link = window.location.href.split('&')[0];

            // regex get video id from url
            ///https?:\/\/(?:[\w-]+\.)?(?:youtu\.be\/|youtube(?:-nocookie)?\.com\S*[^\w\s-])([\w-]{11})(?=[^\w-]|$)(?![?=&+%\w.-]*(?:['""][^<>]*>|<\/a>))[?=&+%\w.-]*/gm
            let video_id = '';
            let regex = /https?:\/\/(?:[\w-]+\.)?(?:youtu\.be\/|youtube(?:-nocookie)?\.com\S*[^\w\s-])([\w-]{11})(?=[^\w-]|$)(?![?=&+%\w.-]*(?:['""][^<>]*>|<\/a>))[?=&+%\w.-]*/gm;
            let matches = regex.exec(window.location.href);
            if (matches && matches.length > 1) {
                video_id = matches[1];
            }
            if (video_id !== '') {
                song_link = 'https://www.youtube.com/watch?v=' + video_id;
            }

            title = title.replace("(Official Audio)", "");
            title = title.replace("(Official Music Video)", "");
            title = title.replace("(Original Video)", "");
            title = title.replace("(Original Mix)", "");

            if (status === 'playing' && progress <= 0) {
                return;
            }

            if (status === 'none') {
                status = 'playing';
            }

            const flooredProgress = Math.floor(progress);
            sendPlaybackUpdate({ guid, cover, title, artists, status, progress: flooredProgress, duration, song_link, platform: 'youtube', is_live });
        } else if (hostname === 'music.youtube.com') {
            if (!navigator.mediaSession.metadata)
                return;

            let title = query('.ytp-title-link', e => e.innerText);
            if (!title)
                return;

            let status = query('#play-pause-button', e => e === null ? 'stopped' : (e.getAttribute('aria-label') === 'Play' || e.getAttribute('aria-label') === 'Воспроизвести' || e.getAttribute('aria-label') === '播放' ? 'stopped' : 'playing'));
            let artists = [navigator.mediaSession.metadata.artist];
            let artwork = navigator.mediaSession.metadata.artwork;
            let cover = artwork[artwork.length - 1].src;

            let time = query('.ytmusic-player-bar.time-info', e => e.innerText.split(" / "));
            let progress = timestamp_to_ms(time[0]);
            let duration = timestamp_to_ms(time[1]);

            let query_link = new URL(query('.ytp-title-link', e => e.getAttribute('href')));
            let song_link = 'https://music.youtube.com/watch?v=' + query_link.searchParams.get('v');

            sendPlaybackUpdate({ guid, cover, title, artists, status, progress, duration, song_link, platform: 'youtube_music', is_live: false });
        }
        else if (hostname === 'www.bilibili.com') {
            if (!navigator.mediaSession.metadata)
                return;

            // 用 query 方式來獲取標題
            // 舊的 Query 方式: '#viewbox_report > div.video-info-title > div > h1'
            let title = query('div.video-info-title > div > h1', e => e.getAttribute('title'));
            if (!title)
                return;

            // 直接判段 player 裡面有沒有對應的 class
            let status = query('#bilibili-player > div > div', e => e.classList.contains('bpx-state-paused') ? 'stopped' : 'playing', 'stopped');

            let duration = query('video', e => e.duration * 1000, 1);
            let progress = query('video', e => e.currentTime * 1000, 0);

            // 有機會遇到 duration == null 的情況
            // 若遇到就把兩個數值設定為 1 跟 0 避免 Json 轉換失敗以及數值計算錯誤
            if (!duration) {
                duration = 1;
                progress = 0;
            }

            let cover = navigator.mediaSession.metadata.artwork[0].src;
            let song_link = document.location.href.split('?')[0];

            let artists = [];
            if (document.querySelector('.up-detail-top > a.up-name')) { // 只有一個作者
                artists.push(query('.up-detail-top > a.up-name', e => e.text, '').trim());
            }
            else if (document.querySelector('.members-info-container > div > div.container')) { // 聯合投稿
                query('.members-info-container > div > div.container', e => {
                    // 選取所有擁有 "staff-name" class 的元素
                    let staffNames = e.querySelectorAll('.staff-name');

                    // 將每個元素的文字內容提取出來，並加入 artists 陣列中
                    staffNames.forEach((element) => {
                        artists.push(element.textContent.trim());
                    });
                });
            }
            else {
                console.error('無法取得 Artists 資料');
            }

            sendPlaybackUpdate({ guid, cover, title, artists, status, progress, duration, song_link, platform: 'bilibili', is_live: false });
        }
    }, 500);
}

if (hostname === 'soundcloud.com' ||
    hostname === 'music.youtube.com' ||
    hostname === 'www.youtube.com' ||
    hostname === 'open.spotify.com' ||
    hostname === "www.bilibili.com") {
    join();
};

window.addEventListener('beforeunload', function () {
    if (conn && conn.readyState === WebSocket.OPEN) {
        conn.send(`closed - ${hostname} (${guid})`);
    }
});
