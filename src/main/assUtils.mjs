import assParser from 'ass-parser';
import assStringify from 'ass-stringify';

const ALIGN_OVERRIDE_TAG_REGEX = /\\{\\\\an\\d\\}/gi;
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

function rewriteAlignment(ast, alignCode) {
  let styleUpdated = false;
  let defaultStyleSeen = false;
  let defaultStyleAlignMatches = false;
  let overridesRemoved = 0;
  let overridesRemaining = false;

  if (!Array.isArray(ast)) {
    return { styleUpdated, overridesRemoved, alignmentSatisfied: false };
  }

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
        const currentAlign = Number.parseInt(String(styleValue.Alignment ?? styleValue.alignment ?? '').trim(), 10);
        if (!Number.isFinite(currentAlign) || currentAlign !== alignCode) {
          styleValue.Alignment = String(alignCode);
          styleUpdated = true;
          defaultStyleAlignMatches = true;
        } else {
          defaultStyleAlignMatches = true;
        }
      }
      continue;
    }

    if (String(sectionName).toLowerCase() === 'events') {
      for (const descriptor of section.body || []) {
        if (descriptor?.key !== 'Dialogue') continue;
        const value = descriptor.value;
        if (!value || typeof value !== 'object') continue;
        const styleName = typeof value.Style === 'string' ? value.Style.trim() : '';
        if (styleName && styleName !== 'Default') continue;
        if (typeof value.Text !== 'string') {
          overridesRemaining = true;
          continue;
        }
        const cleaned = value.Text.replace(ALIGN_OVERRIDE_TAG_REGEX, '');
        if (cleaned !== value.Text) {
          value.Text = cleaned;
          overridesRemoved += 1;
        }
      }
    }
  }

  const alignmentSatisfied = defaultStyleSeen && defaultStyleAlignMatches && !overridesRemaining;
  return { styleUpdated, overridesRemoved, alignmentSatisfied };
}

export function processAssForOverlay({ assText = '', alignKey = 'off' } = {}) {
  if (!assText) {
    return {
      text: '',
      playRes: clonePlayRes(),
      alignmentApplied: false,
      styleUpdated: false,
      overridesRemoved: 0
    };
  }

  const normalizedKey = typeof alignKey === 'string' ? alignKey.trim().toLowerCase() : 'off';
  const alignCode = ALIGN_KEY_TO_CODE[normalizedKey] ?? null;

  const ast = parseAssSafe(assText);
  if (!ast) {
    return {
      text: assText,
      playRes: extractPlayResFallback(assText),
      alignmentApplied: false,
      styleUpdated: false,
      overridesRemoved: 0
    };
  }

  const playRes = extractPlayResFromAst(ast);

  if (alignCode == null) {
    return {
      text: assText,
      playRes,
      alignmentApplied: false,
      styleUpdated: false,
      overridesRemoved: 0
    };
  }

  const { styleUpdated, overridesRemoved, alignmentSatisfied } = rewriteAlignment(ast, alignCode);
  const alignmentApplied = styleUpdated || overridesRemoved > 0 || alignmentSatisfied;

  if (!styleUpdated && overridesRemoved === 0) {
    return {
      text: assText,
      playRes,
      alignmentApplied,
      styleUpdated,
      overridesRemoved
    };
  }

  const stringified = assStringify(ast);
  const normalized = applyOriginalNewlines(assText, stringified);

  return {
    text: normalized,
    playRes,
    alignmentApplied,
    styleUpdated,
    overridesRemoved
  };
}
