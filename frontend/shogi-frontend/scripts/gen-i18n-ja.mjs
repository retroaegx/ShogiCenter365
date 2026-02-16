// scripts/gen-i18n-ja.mjs
// Generate locale dictionaries by extracting i18n *keys* only.
//
// Sources:
// - SPA (React): t("...") keys and explicit key literals under src/
// - Static pages: data-i18n* attribute values and explicit key literals under public/
//
// IMPORTANT:
// - Do NOT collect raw text nodes.
// - Do NOT collect human strings (Japanese/English) as keys.
// - Keys not present in dictionaries are allowed to render as empty.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const SRC_DIR = path.join(ROOT, 'src');
const PUBLIC_DIR = path.join(ROOT, 'public');

const OUT_SRC = path.join(SRC_DIR, 'i18n', 'locales', 'ja.json');
const OUT_PUBLIC = path.join(PUBLIC_DIR, 'i18n', 'ja.json');

const SOURCE_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx']);
const PUBLIC_EXTS = new Set(['.html', '.js']);

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

// Key format: ASCII + dot namespace. (Examples: ui.xxx, static.xxx)
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.[A-Za-z0-9_.-]+$/;

// Avoid common file-like strings being mistaken as keys.
const FILE_EXT_RE = /\.(js|jsx|ts|tsx|css|html|json|png|jpe?g|webp|svg|woff2?|ttf|mp3|wav|zip)$/i;

function normalizeKey(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/\s+/g, ' ').trim();
}

async function walk(dir, exts) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      out.push(...(await walk(full, exts)));
    } else if (e.isFile()) {
      const ext = path.extname(e.name);
      if (!exts || exts.has(ext)) out.push(full);
    }
  }
  return out;
}

function decodeStringLiteral(body) {
  const json = '"' + String(body).replace(/"/g, '\\"') + '"';
  try {
    return JSON.parse(json);
  } catch {
    return String(body);
  }
}

function isKey(s) {
  const k = normalizeKey(s);
  if (!k) return false;
  if (!KEY_RE.test(k)) return false;
  if (FILE_EXT_RE.test(k)) return false;
  return true;
}

function extractTKeys(source) {
  const keys = new Set();
  // Matches: t("...") or t('...') as the first argument.
  const re = /\bt\s*\(\s*(['"])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  let m;
  while ((m = re.exec(source))) {
    const raw = m[2] ?? '';
    const val = decodeStringLiteral(raw);
    if (isKey(val)) keys.add(normalizeKey(val));
  }
  return keys;
}

function extractKeyLiterals(source) {
  const keys = new Set();
  if (!source) return keys;
  // Find string literals that look like i18n keys.
  const re = /(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)")/g;
  let m;
  while ((m = re.exec(String(source)))) {
    const raw = m[1] ?? m[2] ?? '';
    const val = decodeStringLiteral(raw);
    if (isKey(val)) keys.add(normalizeKey(val));
  }
  return keys;
}

function extractDataI18nAttrKeys(htmlOrJs) {
  const keys = new Set();
  if (!htmlOrJs) return keys;
  const s = String(htmlOrJs);
  const re = /\bdata-i18n(?:-html|-title|-aria-label|-placeholder|-alt)?\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let m;
  while ((m = re.exec(s))) {
    const v = (m[1] ?? m[2] ?? '').trim();
    if (isKey(v)) keys.add(normalizeKey(v));
  }
  return keys;
}

async function readJsonSafe(p) {
  try {
    const s = await fs.readFile(p, 'utf-8');
    const j = JSON.parse(s);
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function buildLocale(base, keys) {
  const b = (base && typeof base === 'object') ? base : {};
  const out = { ...b };
  for (const k of keys) {
    if (!k) continue;
    if (!(k in out)) out[k] = '';
  }
  return out;
}

function sortObject(obj) {
  const entries = Object.entries(obj || {});
  entries.sort((a, b) => a[0].localeCompare(b[0], 'ja'));
  const out = {};
  for (const [k, v] of entries) out[k] = v;
  return out;
}

async function writeJson(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const json = JSON.stringify(sortObject(obj), null, 2) + '\n';
  await fs.writeFile(p, json, 'utf-8');
}

async function main() {
  const srcKeys = new Set();
  const publicKeys = new Set();

  // SPA keys
  const srcFiles = await walk(SRC_DIR, SOURCE_EXTS);
  for (const f of srcFiles) {
    const s = await fs.readFile(f, 'utf-8');
    for (const k of extractTKeys(s)) srcKeys.add(k);
    for (const k of extractKeyLiterals(s)) srcKeys.add(k);
  }

  // Static keys
  const pubFiles = await walk(PUBLIC_DIR, PUBLIC_EXTS);
  for (const f of pubFiles) {
    const rel = path.relative(PUBLIC_DIR, f).replace(/\\/g, '/');
    // best-effort skips
    if (rel.startsWith('board-theme/')) continue;
    if (rel.startsWith('sounds/')) continue;
    if (rel.startsWith('country/')) continue;
    if (rel.startsWith('assets/board-theme/')) continue;
    if (rel.startsWith('shogi-assets/images/')) continue;

    const s = await fs.readFile(f, 'utf-8');
    for (const k of extractDataI18nAttrKeys(s)) publicKeys.add(k);
    for (const k of extractTKeys(s)) publicKeys.add(k);
    for (const k of extractKeyLiterals(s)) publicKeys.add(k);
  }

  // Theme set displayName keys (data-driven)
  try {
    const themePath = path.join(PUBLIC_DIR, 'board-theme', 'config.json');
    const themeJson = JSON.parse(await fs.readFile(themePath, 'utf-8'));
    const bg = Array.isArray(themeJson?.background_sets) ? themeJson.background_sets : [];
    const ps = Array.isArray(themeJson?.piece_sets) ? themeJson.piece_sets : [];
    for (const x of [...bg, ...ps]) {
      const dn = (x && typeof x.displayName === 'string') ? x.displayName : '';
      if (isKey(dn)) {
        const k = normalizeKey(dn);
        srcKeys.add(k);
        publicKeys.add(k);
      }
    }
  } catch {}

  const srcBase = await readJsonSafe(OUT_SRC);
  const publicBase = await readJsonSafe(OUT_PUBLIC);

  await writeJson(OUT_SRC, buildLocale(srcBase, srcKeys));
  await writeJson(OUT_PUBLIC, buildLocale(publicBase, publicKeys));

  // eslint-disable-next-line no-console
  console.log(`[i18n] ja.json updated: src=${srcKeys.size} public=${publicKeys.size}`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[i18n] failed to generate ja.json', e);
  process.exit(1);
});
