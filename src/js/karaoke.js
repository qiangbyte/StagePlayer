// 人声消除导出（轻客户端）：
//  - 处理完全在 Rust 原生端（流式，不受 WebView 内存限制）
//  - 优先导出 AI 分离引擎的伴奏缓存（秒级）；否则用快速中置消除算法
//  - 进度通过 karaoke-progress 事件显示

import { getAudioSnapshot } from './audio.js';
import { invoke, listen, toast } from './util.js';

const $ = (id) => document.getElementById(id);

// ---------- 进度提示（单实例，不堆积） ----------
function setProg(text) {
  let box = document.getElementById('sp-toast-box');
  if (!box) {
    box = document.createElement('div');
    box.id = 'sp-toast-box';
    document.body.appendChild(box);
  }
  let el = document.getElementById('sp-progress');
  if (!el) {
    el = document.createElement('div');
    el.id = 'sp-progress';
    el.className = 'sp-toast';
    box.appendChild(el);
  }
  el.textContent = text;
}

function clearProg(delayMs = 0) {
  const el = document.getElementById('sp-progress');
  if (el) setTimeout(() => el.remove(), delayMs);
}

// ---------- 保存路径（Rust 命令优先，dialog 插件兜底） ----------
async function pickSavePath(defName) {
  try {
    return await invoke('pick_save_path', { defaultName: defName, extensions: ['wav'] });
  } catch (err) {
    const d = window.__TAURI__?.dialog;
    if (d?.save) {
      return await d.save({
        defaultPath: defName,
        filters: [{ name: 'WAV 音频', extensions: ['wav'] }],
      });
    }
    throw err;
  }
}

// ---------- 主流程 ----------
async function doExport() {
  const snap = getAudioSnapshot();
  if (!snap.path) {
    toast('请先选择音频');
    return;
  }

  const savePath = await pickSavePath(`${snap.name || 'audio'}-伴奏.wav`);
  if (!savePath) return;

  // 1) 优先：AI 分离引擎的伴奏缓存（无损复制，秒级完成）
  try {
    const info = await invoke('stem_get_instrumental', { path: snap.path });
    if (info?.ready && info.instrumentalPath) {
      setProg('⏳ 正在导出 AI 分离伴奏...');
      await invoke('copy_file', { src: info.instrumentalPath, dst: savePath });
      clearProg(300);
      toast(`✅ 伴奏（AI 分离）已导出：${savePath}`, 8000);
      return;
    }
  } catch { /* stem 引擎不可用时走快速算法 */ }

  // 2) 快速中置消除（Rust 流式处理）
  setProg('⏳ 正在消除人声... 0%');
  await invoke('vocal_cancel_export', {
    path: snap.path,
    savePath,
    duration: snap.duration || 0,
  });
  clearProg(300);
  toast(`✅ 伴奏已导出：${savePath}`, 8000);
}

export function initKaraoke() {
  $('audio-karaoke')?.addEventListener('click', () => {
    doExport().catch((err) => {
      clearProg();
      toast('导出失败：' + (err?.message || err), 6000);
    });
  });

  // Rust 端处理进度
  listen('karaoke-progress', (e) => {
    const pct = e.payload;
    if (typeof pct === 'number') setProg(`⏳ 正在消除人声... ${pct}%`);
  });
}
