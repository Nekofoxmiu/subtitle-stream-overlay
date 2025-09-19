import Store from 'electron-store';

export const store = new Store({
  name: 'config',
  defaults: {
    bins: { ytDlpPath: '', ffmpegPath: '' },
    output: {
      mode: 'http',
      port: 59777,
      background: 'transparent',
      maxWidth: 1920,
      align: 'center',
      wrapStyle: 2
    },
    player: {
      volume: 0.8
    },
    // 新增：cookies 路徑（Netscape cookies.txt）
    cookiesPath: '',
    downloads: [],
    fonts: []
  }
});

export const getConfig = () => store.store;
export const setConfig = (patch) => store.set(patch);
