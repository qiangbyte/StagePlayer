import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcTauri = path.join(root, 'src-tauri');
const triple = process.env.TAURI_ENV_TARGET_TRIPLE || 'x86_64-pc-windows-msvc';
const outName = `lyric-asr-sidecar-${triple}.exe`;
const destDir = path.join(srcTauri, 'binaries');
const dest = path.join(destDir, outName);

const candidates = [];
if (process.env.CARGO_TARGET_DIR) {
  candidates.push(path.join(process.env.CARGO_TARGET_DIR, 'release', 'lyric-asr-sidecar.exe'));
}
candidates.push(
  path.join(srcTauri, 'target', 'release', 'lyric-asr-sidecar.exe'),
  path.join(root, 'target', 'release', 'lyric-asr-sidecar.exe'),
);

const src = candidates.find((p) => fs.existsSync(p));
if (!src) {
  console.error('找不到 lyric-asr-sidecar.exe（release）。候选路径：');
  for (const p of candidates) console.error(' -', p);
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
// 同步一份不带 triple 的名字，方便本地直接运行
fs.copyFileSync(src, path.join(destDir, 'lyric-asr-sidecar.exe'));
console.log(`staged sidecar: ${src} -> ${dest}`);
