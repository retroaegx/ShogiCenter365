// src/config/themeLoader.js
// Loads /board-theme/config.json at runtime with robust base handling.
//
// Multi-set support (config.json):
// - piece_sets: [{ name, displayName, pieces }]
// - background_sets: [{ name, displayName, ...everything except pieces... }]
//
// Selection is read from localStorage:
// - shogi_theme_piece_set
// - shogi_theme_background_set

let cachedConfig = null;

export const THEME_LS_KEYS = {
  pieceSet: 'shogi_theme_piece_set',
  backgroundSet: 'shogi_theme_background_set',
};

// Resolve base URL (supports Vite and CRA). Allow override via window.SHOGI_THEME_BASE
function getBase() {
  if (typeof window !== 'undefined' && window.SHOGI_THEME_BASE) return window.SHOGI_THEME_BASE;
  // Vite
  try {
    // Vite: access import.meta.env safely without 'typeof import.meta'
    if (import.meta && import.meta.env && import.meta.env.BASE_URL) {
      return import.meta.env.BASE_URL || '/';
    }
  } catch (e) {}

  // CRA or others: try document.baseURI
  if (typeof document !== 'undefined' && document.baseURI) {
    try {
      const u = new URL(document.baseURI);
      return u.pathname || '/';
    } catch {}
  }
  return '/';
}

function joinBase(path) {
  const base = getBase();
  if (/^https?:\/\//.test(path) || path.startsWith('/')) return path; // absolute
  // ensure single slash join
  return (base.endsWith('/') ? base : base + '/') + path.replace(/^\//, '');
}

function normalizeSample(sample) {
  if (!sample) return sample;
  if (typeof sample === 'string') {
    const s = String(sample).trim();
    if (!s) return '';
    return joinBase(s.replace(/^\//, ''));
  }
  if (typeof sample === 'object') {
    const out = JSON.parse(JSON.stringify(sample));
    if (out.image && typeof out.image === 'string') {
      out.image = joinBase(String(out.image).replace(/^\//, ''));
    }
    if (out.url && typeof out.url === 'string') {
      out.url = joinBase(String(out.url).replace(/^\//, ''));
    }
    return out;
  }
  return sample;
}

function normalizePiecesMap(pieces) {
  const p = pieces || {};
  const out = JSON.parse(JSON.stringify(p));
  if (out.sente || out.gote) {
    ['sente', 'gote'].forEach((side) => {
      const m = out[side] || {};
      Object.keys(m).forEach((k) => {
        if (m[k]) m[k] = joinBase(String(m[k]).replace(/^\//, ''));
      });
    });
  } else {
    Object.keys(out).forEach((k) => {
      if (out[k]) out[k] = joinBase(String(out[k]).replace(/^\//, ''));
    });
  }
  return out;
}

function normalizeBackgroundSet(bg) {
  const norm = JSON.parse(JSON.stringify(bg || {}));
  if (norm.background) norm.background = joinBase(String(norm.background).replace(/^\//, ''));

  // optional sample thumbnail
  if (norm.sample) norm.sample = normalizeSample(norm.sample);
  if (norm.sampleImage) norm.sampleImage = normalizeSample(norm.sampleImage);

  if (norm.coordinates && norm.coordinates.outside) {
    const o = norm.coordinates.outside;
    if (o.background_vertical) o.background_vertical = joinBase(String(o.background_vertical).replace(/^\//, ''));
    if (o.background_horizontal) o.background_horizontal = joinBase(String(o.background_horizontal).replace(/^\//, ''));
    // Optional: right-side vertical label background (when coordinates.outside.right is enabled)
    if (o.background_vertical_right) o.background_vertical_right = joinBase(String(o.background_vertical_right).replace(/^\//, ''));

    // Optional: dedicated corner fills behind the outside coordinate labels
    if (o.background_corner_left) o.background_corner_left = joinBase(String(o.background_corner_left).replace(/^\//, ''));
    if (o.background_corner_right) o.background_corner_right = joinBase(String(o.background_corner_right).replace(/^\//, ''));
  }
  return norm;
}

function normalizeMultiSetConfig(raw) {
  if (!raw || typeof raw !== 'object') {
    return { piece_sets: [], background_sets: [] };
  }

  // Backward compatibility: old single-theme schema
  if (raw.background && raw.pieces) {
    const oneBg = {
      name: 'default_background',
      displayName: 'theme.set.default',
      background: raw.background,
      coordinates: raw.coordinates,
      grid: raw.grid,
      board_region: raw.board_region,
    };
    const onePieces = {
      name: 'default_pieces',
      displayName: 'theme.set.default',
      pieces: raw.pieces,
    };
    const cfg = {
      background_sets: [normalizeBackgroundSet(oneBg)],
      piece_sets: [{ ...onePieces, pieces: normalizePiecesMap(onePieces.pieces) }],
    };
    return cfg;
  }

  const bgSets = Array.isArray(raw.background_sets) ? raw.background_sets : (Array.isArray(raw.backgroundSets) ? raw.backgroundSets : []);
  const pieceSets = Array.isArray(raw.piece_sets) ? raw.piece_sets : (Array.isArray(raw.pieceSets) ? raw.pieceSets : []);

  const normalizedBg = bgSets
    .filter((x) => x && typeof x === 'object')
    .map((x, i) => {
      const name = typeof x.name === 'string' && x.name.trim() ? x.name.trim() : `background_${i + 1}`;
      // displayName is an i18n key. If missing, keep empty (UI can render empty).
      const displayName = (typeof x.displayName === 'string' && x.displayName.trim()) ? x.displayName.trim() : '';
      return normalizeBackgroundSet({ ...x, name, displayName });
    });

  const normalizedPieces = pieceSets
    .filter((x) => x && typeof x === 'object')
    .map((x, i) => {
      const name = typeof x.name === 'string' && x.name.trim() ? x.name.trim() : `pieces_${i + 1}`;
      // displayName is an i18n key. If missing, keep empty (UI can render empty).
      const displayName = (typeof x.displayName === 'string' && x.displayName.trim()) ? x.displayName.trim() : '';
      const pieces = normalizePiecesMap(x.pieces || {});
      const sample = normalizeSample(x.sample);
      const sampleImage = normalizeSample(x.sampleImage);
      return { ...x, name, displayName, pieces, sample, sampleImage };
    });

  return {
    background_sets: normalizedBg,
    piece_sets: normalizedPieces,
  };
}

function readSelection() {
  try {
    const pieceSet = (typeof localStorage !== 'undefined') ? localStorage.getItem(THEME_LS_KEYS.pieceSet) : null;
    const backgroundSet = (typeof localStorage !== 'undefined') ? localStorage.getItem(THEME_LS_KEYS.backgroundSet) : null;
    return {
      pieceSet: pieceSet && String(pieceSet).trim() ? String(pieceSet).trim() : null,
      backgroundSet: backgroundSet && String(backgroundSet).trim() ? String(backgroundSet).trim() : null,
    };
  } catch {
    return { pieceSet: null, backgroundSet: null };
  }
}

function pickByNameOrFirst(list, name) {
  if (!Array.isArray(list) || list.length === 0) return null;
  if (name) {
    const found = list.find((x) => x && x.name === name);
    if (found) return found;
  }
  return list[0];
}

function buildTheme(backgroundSet, pieceSet) {
  const bg = backgroundSet || {};
  const ps = pieceSet || {};

  // Strip meta keys so the board logic only sees actual render config.
  // Keep unknown future keys on bg (except meta).
  const { name: _n1, displayName: _d1, ...bgRest } = bg;
  const { name: _n2, displayName: _d2, pieces } = ps;

  return {
    ...bgRest,
    pieces: pieces || {},
  };
}

export async function loadBoardThemeConfig() {
  if (cachedConfig) return cachedConfig;
  const candidates = ['board-theme/config.json', './board-theme/config.json', '/board-theme/config.json'].map(joinBase);

  let lastErr = null;
  for (const url of candidates) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      cachedConfig = normalizeMultiSetConfig(json);
      return cachedConfig;
    } catch (e) {
      lastErr = e;
    }
  }
  console.error('[themeLoader] Failed to load theme config:', lastErr);
  cachedConfig = { background_sets: [], piece_sets: [] };
  return cachedConfig;
}

export async function loadBoardTheme() {
  const cfg = await loadBoardThemeConfig();
  const sel = readSelection();
  const bg = pickByNameOrFirst(cfg.background_sets, sel.backgroundSet);
  const ps = pickByNameOrFirst(cfg.piece_sets, sel.pieceSet);
  return buildTheme(bg, ps);
}

export function clearBoardThemeCache() {
  cachedConfig = null;
}
