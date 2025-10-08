import { dom } from './dom.mjs';
import state from './state.mjs';
import {
  collectStyle,
  persistStyle,
  persistFonts,
  updateFontsLabel,
  updateFontControlsAvailability,
  notifyOverlayWithCurrentFonts
} from './style.mjs';

export async function handlePickFonts() {
  if (state.forceDefaultFont === false) {
    updateFontControlsAvailability();
    return;
  }
  const files = await window.api.openFiles({ filters: [{ name: 'Fonts', extensions: ['ttf', 'otf', 'woff2', 'woff'] }] });
  if (!files.length) return;
  state.currentFonts = [];
  for (const filePath of files) {
    const base64 = await window.api.readBinaryBase64(filePath);
    const name = filePath.split(/[\\/]/).pop();
    state.currentFonts.push({ name, data: base64 });
  }
  updateFontsLabel();
  const style = collectStyle();
  await persistFonts(state.currentFonts);
  await persistStyle(style);
  notifyOverlayWithCurrentFonts({ style }, { includeWhenDisabled: true });
}

export async function handleClearFonts() {
  if (state.forceDefaultFont === false) {
    updateFontControlsAvailability();
    return;
  }
  state.currentFonts = [];
  updateFontsLabel();
  try {
    await persistFonts(state.currentFonts);
  } catch (err) {
    console.error('[fonts] 無法儲存字型設定', err);
  }
  const style = collectStyle();
  await persistStyle(style);
  notifyOverlayWithCurrentFonts({ style }, { includeWhenDisabled: true });
}
