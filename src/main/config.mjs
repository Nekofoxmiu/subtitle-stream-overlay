import Store from 'electron-store';

export const store = new Store({
  name: 'config',
  defaults: {
    bins: { ytDlpPath: '', ffmpegPath: '' },
    output: {
      mode: 'http',
      port: 1976,
      background: 'transparent',
      maxWidth: 1920,
      align: 'center',
      wrapStyle: 2
    },
    // 新增：cookies 路徑（Netscape cookies.txt）
    cookiesPath: '',
    downloads: []
  }
});

export const getConfig = () => store.store;
export const setConfig = (patch) => store.set(patch);
