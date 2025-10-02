import assParser from 'ass-parser';
import assStringify from 'ass-stringify';

const ALIGN_OVERRIDE_TAG_REGEX = /\\{\\\\an\\d\\}/gi;
const FONT_OVERRIDE_TAG_REGEX = /\\fn([^\\}]*?)(?=\\|}|$)/gi;
const FONT_OVERRIDE_COMMAND_REGEX = /\\fn[^\\})]*?(?=[\\})]|$)/gi;
const STYLE_SECTION_NAMES = new Set(['V4 Styles', 'V4+ Styles']);
export const DEFAULT_PLAY_RES = Object.freeze({ x: 1920, y: 1080 });
const ALIGN_KEY_TO_CODE = {
  'bottom-left': 1,
  'bottom-center': 2,
  'bottom-right': 3,
  'middle-left': 4,
  'middle-center': 5,
  'middle-right': 6,
  'top-left': 7,
  'top-center': 8,
  'top-right': 9
};

function createFontCollector() {
  const fonts = new Map();
  return {
    add(value) {
      if (typeof value !== 'string') return;
      let normalized = value.replace(/\u0000/g, '').trim();
      if (!normalized) return;
      if ((normalized.startsWith('"') && normalized.endsWith('"')) ||
          (normalized.startsWith('\'') && normalized.endsWith('\''))) {
        normalized = normalized.slice(1, -1).trim();
      }
      const key = normalized.toLowerCase();
      if (!key || fonts.has(key)) return;
      fonts.set(key, normalized);
    },
    toArray() {
      return Array.from(fonts.values());
    }
  };
}

function collectFontsFromOverrides(collector, text) {
  if (typeof text !== 'string' || !text) return;
  FONT_OVERRIDE_TAG_REGEX.lastIndex = 0;
  let match;
  while ((match = FONT_OVERRIDE_TAG_REGEX.exec(text))) {
    if (match[1] != null) collector.add(match[1]);
  }
}

function collectFontsFromStyles(collector, ast) {
  if (!Array.isArray(ast)) return;
  for (const section of ast) {
    const sectionName = String(section?.section || '').trim();
    if (!STYLE_SECTION_NAMES.has(sectionName)) continue;
    for (const descriptor of section.body || []) {
      if (descriptor?.key !== 'Style') continue;
      const value = descriptor.value;
      if (!value || typeof value !== 'object') continue;
      const fontName = value.Fontname ?? value.FontName ?? value.fontname ?? value.fontName ?? null;
      if (typeof fontName === 'string') collector.add(fontName);
    }
  }
}

function collectFontsFromEvents(collector, ast) {
  if (!Array.isArray(ast)) return;
  for (const section of ast) {
    const sectionName = String(section?.section || '').trim().toLowerCase();
    if (sectionName !== 'events') continue;
    for (const descriptor of section.body || []) {
      if (!descriptor || (descriptor.key !== 'Dialogue' && descriptor.key !== 'Comment')) continue;
      const dialog = descriptor.value;
      if (!dialog || typeof dialog !== 'object') continue;
      collectFontsFromOverrides(collector, dialog.Text);
    }
  }
}

function collectFontsFromRawStyles(collector, text = '') {
  if (!text) return;
  const styleLineRegex = /^\s*Style\s*:\s*[^,]*,\s*([^,]+)/gim;
  let match;
  while ((match = styleLineRegex.exec(text))) {
    collector.add(match[1]);
  }
}

function extractFontNames(ast, text = '') {
  const collector = createFontCollector();
  collectFontsFromStyles(collector, ast);
  collectFontsFromEvents(collector, ast);
  collectFontsFromRawStyles(collector, text);
  collectFontsFromOverrides(collector, text);
  return collector.toArray();
}

function clonePlayRes(value = DEFAULT_PLAY_RES) {
  return { x: value.x, y: value.y };
}

function parseAssSafe(text = '') {
  try {
    return assParser(text, { comments: true });
  } catch (err) {
    console.warn('[ass] failed to parse ASS document', err);
    return null;
  }
}

function sanitizePlayResValue(raw, fallback) {
  const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function extractPlayResFromAst(ast) {
  if (!Array.isArray(ast)) return clonePlayRes();
  let resX = null;
  let resY = null;
  for (const section of ast) {
    const name = String(section?.section || '').trim().toLowerCase();
    if (name !== 'script info') continue;
    for (const descriptor of section.body || []) {
      const key = String(descriptor?.key || '').trim().toLowerCase();
      if (!key) continue;
      if (key === 'playresx') {
        resX = sanitizePlayResValue(descriptor.value, resX ?? DEFAULT_PLAY_RES.x);
      } else if (key === 'playresy') {
        resY = sanitizePlayResValue(descriptor.value, resY ?? DEFAULT_PLAY_RES.y);
      }
    }
  }
  const x = sanitizePlayResValue(resX, DEFAULT_PLAY_RES.x);
  const y = sanitizePlayResValue(resY, DEFAULT_PLAY_RES.y);
  return { x, y };
}

function extractPlayResFallback(text = '') {
  const rx = /PlayResX\s*:\s*(\d+)/i.exec(text);
  const ry = /PlayResY\s*:\s*(\d+)/i.exec(text);
  const x = rx ? parseInt(rx[1], 10) : DEFAULT_PLAY_RES.x;
  const y = ry ? parseInt(ry[1], 10) : DEFAULT_PLAY_RES.y;
  return (x > 0 && y > 0) ? { x, y } : clonePlayRes();
}

function applyOriginalNewlines(originalText, nextText) {
  if (!originalText || !nextText) return nextText;
  if (!originalText.includes('\r\n')) return nextText.replace(/\r\n/g, '\n');
  const normalized = nextText.replace(/\r\n/g, '\n');
  return normalized.replace(/\n/g, '\r\n');
}

function rewriteAlignment(ast, alignCode, { forceDefaultFont = false, defaultFontFamily = '' } = {}) {
  let styleUpdated = false;
  let defaultStyleSeen = false;
  let defaultStyleAlignMatches = false;
  let overridesRemoved = 0;
  let overridesRemaining = false;
  let defaultFontUpdated = false;

  if (!Array.isArray(ast)) {
    return { styleUpdated, overridesRemoved, alignmentSatisfied: false, defaultFontUpdated: false };
  }

  const shouldApplyAlign = Number.isFinite(alignCode);
  const shouldStripFontOverrides = Boolean(forceDefaultFont && defaultFontFamily);

  for (const section of ast) {
    const sectionName = String(section?.section || '').trim();
    if (STYLE_SECTION_NAMES.has(sectionName)) {
      for (const descriptor of section.body || []) {
        if (descriptor?.key !== 'Style') continue;
        const styleValue = descriptor.value;
        if (!styleValue || typeof styleValue !== 'object') continue;
        const styleNameRaw = styleValue.Name ?? styleValue.name;
        const styleName = typeof styleNameRaw === 'string' ? styleNameRaw.trim() : '';
        if (styleName !== 'Default') continue;
        defaultStyleSeen = true;

        if (shouldApplyAlign) {
          const rawAlign = String(styleValue.Alignment ?? styleValue.alignment ?? '').trim();
          const currentAlign = Number.parseInt(rawAlign, 10);
          if (!Number.isFinite(currentAlign) || currentAlign !== alignCode) {
            styleValue.Alignment = String(alignCode);
            styleUpdated = true;
            defaultStyleAlignMatches = true;
          } else {
            defaultStyleAlignMatches = true;
          }
        }

        if (forceDefaultFont && defaultFontFamily) {
          const currentFont = String(
            styleValue.Fontname ??
            styleValue.FontName ??
            styleValue.fontname ??
            styleValue.fontName ??
            ''
          ).trim();
          if (currentFont !== defaultFontFamily) {
            styleValue.Fontname = defaultFontFamily;
            styleValue.FontName = defaultFontFamily;
            styleValue.fontname = defaultFontFamily;
            styleValue.fontName = defaultFontFamily;
            styleUpdated = true;
            defaultFontUpdated = true;
          }
        }
      }
      continue;
    }

    if (!shouldApplyAlign && !shouldStripFontOverrides) continue;

    if (String(sectionName).toLowerCase() === 'events') {
      for (const descriptor of section.body || []) {
        if (descriptor?.key !== 'Dialogue') continue;
        const value = descriptor.value;
        if (!value || typeof value !== 'object') continue;
        const styleName = typeof value.Style === 'string' ? value.Style.trim() : '';
        if (styleName && styleName !== 'Default') continue;
        if (typeof value.Text !== 'string') {
          if (shouldApplyAlign) overridesRemaining = true;
          continue;
        }

        if (shouldApplyAlign) {
          const cleaned = value.Text.replace(ALIGN_OVERRIDE_TAG_REGEX, '');
          if (cleaned !== value.Text) {
            value.Text = cleaned;
            overridesRemoved += 1;
          }
        }

        if (shouldStripFontOverrides && /\\fn/i.test(value.Text)) {
          const withoutFontOverrides = value.Text.replace(FONT_OVERRIDE_COMMAND_REGEX, '');
          const normalized = withoutFontOverrides.replace(/\{\s*\}/g, '');
          if (normalized !== value.Text) {
            value.Text = normalized;
            overridesRemoved += 1;
            defaultFontUpdated = true;
          }
        }
      }
    }
  }

  const alignmentSatisfied = shouldApplyAlign
    ? (defaultStyleSeen && defaultStyleAlignMatches && !overridesRemaining)
    : false;

  return { styleUpdated, overridesRemoved, alignmentSatisfied, defaultFontUpdated };
}

export function processAssForOverlay({ assText = '', alignKey = 'off', defaultFontFamily = '', forceDefaultFont = false } = {}) {
  if (!assText) {
    return {
      text: '',
      playRes: clonePlayRes(),
      alignmentApplied: false,
      styleUpdated: false,
      overridesRemoved: 0,
      fontNames: [],
      defaultFontReplaced: false
    };
  }

  const normalizedKey = typeof alignKey === 'string' ? alignKey.trim().toLowerCase() : 'off';
  const alignCode = ALIGN_KEY_TO_CODE[normalizedKey] ?? null;
  const normalizedFontFamily = typeof defaultFontFamily === 'string' ? defaultFontFamily.trim() : '';
  const shouldForceFont = Boolean(forceDefaultFont && normalizedFontFamily);

  const ast = parseAssSafe(assText);
  const fontNames = extractFontNames(ast, assText);
  if (!ast) {
    return {
      text: assText,
      playRes: extractPlayResFallback(assText),
      alignmentApplied: false,
      styleUpdated: false,
      overridesRemoved: 0,
      fontNames,
      defaultFontReplaced: false
    };
  }

  const playRes = extractPlayResFromAst(ast);

  if (alignCode == null && !shouldForceFont) {
    return {
      text: assText,
      playRes,
      alignmentApplied: false,
      styleUpdated: false,
      overridesRemoved: 0,
      fontNames,
      defaultFontReplaced: false
    };
  }

  const { styleUpdated, overridesRemoved, alignmentSatisfied, defaultFontUpdated } = rewriteAlignment(
    ast,
    alignCode,
    { forceDefaultFont: shouldForceFont, defaultFontFamily: normalizedFontFamily }
  );
  const alignmentApplied = styleUpdated || overridesRemoved > 0 || alignmentSatisfied;
  const defaultFontReplaced = Boolean(defaultFontUpdated);

  if (!styleUpdated && !defaultFontReplaced && overridesRemoved === 0) {
    return {
      text: assText,
      playRes,
      alignmentApplied,
      styleUpdated,
      overridesRemoved,
      fontNames,
      defaultFontReplaced
    };
  }

  const stringified = assStringify(ast);
  const normalized = applyOriginalNewlines(assText, stringified);

  return {
    text: normalized,
    playRes,
    alignmentApplied,
    styleUpdated,
    overridesRemoved,
    fontNames,
    defaultFontReplaced
  };
}
