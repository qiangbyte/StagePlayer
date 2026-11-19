#!/usr/bin/env bash
# 在 Apple 芯片（M1/M2/M3…）的 Mac 上打包 .dmg：
#   bash scripts/build-mac.sh
# 需要先装：Xcode 命令行工具（xcode-select --install）、Node 20+、Rust（https://rustup.rs）
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "这个脚本只能在 macOS 上运行。" >&2
  exit 1
fi

rustup target add aarch64-apple-darwin >/dev/null 2>&1 || true

# src-tauri/.cargo/config.toml 里写的是 Windows 版 sherpa-onnx 本地压缩包路径，
# 在 Mac 上会让构建去找一个不存在的文件，所以打包期间临时挪开
CFG="src-tauri/.cargo/config.toml"
if [[ -f "$CFG" ]]; then
  mv "$CFG" "$CFG.bak"
  trap 'mv "$CFG.bak" "$CFG"' EXIT
fi

npm install
npm run sidecar:release
npm run sidecar:stage
npx tauri build --bundles dmg --target aarch64-apple-darwin

echo
echo "完成。安装包在："
ls -1 src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/*.dmg
