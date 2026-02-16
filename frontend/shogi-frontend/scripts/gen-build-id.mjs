import fs from 'node:fs';
import path from 'node:path';

// Generate a new build id for Vite HTML/env placeholders.
// Written into .env.local as VITE_BUILD_ID=...
// - Preserves other keys in .env.local
// - Updates VITE_BUILD_ID if present

function makeBuildId() {
  // YYYYMMDDHHMMSS (UTC)
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const y = d.getUTCFullYear();
  const mo = pad(d.getUTCMonth() + 1);
  const da = pad(d.getUTCDate());
  const h = pad(d.getUTCHours());
  const mi = pad(d.getUTCMinutes());
  const s = pad(d.getUTCSeconds());
  return `${y}${mo}${da}${h}${mi}${s}`;
}

const buildId = makeBuildId();
const envPath = path.resolve(process.cwd(), '.env.local');

let lines = [];
if (fs.existsSync(envPath)) {
  lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
}

let found = false;
lines = lines.map((line) => {
  if (line.startsWith('VITE_BUILD_ID=')) {
    found = true;
    return `VITE_BUILD_ID=${buildId}`;
  }
  return line;
});
if (!found) lines.push(`VITE_BUILD_ID=${buildId}`);

// Normalize trailing newline
const out = lines.filter((l, i) => !(l === '' && i === lines.length - 1)).join('\n') + '\n';
fs.writeFileSync(envPath, out, 'utf8');

console.log(`VITE_BUILD_ID=${buildId}`);
