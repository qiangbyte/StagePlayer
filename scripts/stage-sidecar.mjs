// 把 release 编出来的 lyric-asr-sidecar 复制成 Tauri externalBin 需要的名字：
//   binaries/lyric-asr-sidecar-<target-triple>[.exe]
// Windows / macOS 通用；目标三元组优先取 TAURI_ENV_TARGET_TRIPLE，否则取本机 rustc 的 host。
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcTauri = path.join(root, 'src-tauri');

function hostTriple() {
  try {
    const out = execSync('rustc -vV', { encoding: 'utf8' });
    const m = /^host:\s*(\S+)/m.exec(out);
    if (m) return m[1];
  } catch {
    /* 没有 rustc 时回退到 Windows，保持旧行为 */
  }
  return 'x86_64-pc-windows-msvc';
}

const triple = process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
const ext = triple.includes('windows') ? '.exe' : '';
const built = `lyric-asr-sidecar${ext}`;
const outName = `lyric-asr-sidecar-${triple}${ext}`;
const destDir = path.join(srcTauri, 'binaries');
const dest = path.join(destDir, outName);

const candidates = [];
if (process.env.CARGO_TARGET_DIR) {
  candidates.push(path.join(process.env.CARGO_TARGET_DIR, 'release', built));
}
candidates.push(
  path.join(srcTauri, 'target', 'release', built),
  path.join(root, 'target', 'release', built),
);

const src = candidates.find((p) => fs.existsSync(p));
if (!src) {
  console.error(`找不到 ${built}（release）。候选路径：`);
  for (const p of candidates) console.error(' -', p);
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
if (ext !== '.exe') fs.chmodSync(dest, 0o755);
// 同步一份不带 triple 的名字，方便本地直接运行
fs.copyFileSync(src, path.join(destDir, built));
console.log(`staged sidecar (${triple}): ${src} -> ${dest}`);
