// 输出窗口入口

import {
  OUTPUT_EVENT, VIDEO_CTRL_EVENT, VIDEO_TIME_EVENT, renderOutput, controlVideo, applyFitMode,
  reportVideoTime,
} from './output-core.js';
import { listen, emit, invoke, lsGet } from './util.js';

const stage = () => document.getElementById('output-stage');

let frozen = false;
let ctrlTimer = null;
let isFs = false;
let closing = false;

window.addEventListener('DOMContentLoaded', async () => {
  renderOutput(stage(), { kind: 'clear' });
  applyFitMode(stage(), lsGet('sp.output.fit', 'contain'));

  await listen(OUTPUT_EVENT, (e) => {
    if (frozen) return;
    renderOutput(stage(), e.payload);
    applyFitMode(stage(), lsGet('sp.output.fit', 'contain'));
    if (e.payload?.kind === 'video') {
      reportVideoTime(stage(), e.payload.path, (rep) => emit(VIDEO_TIME_EVENT, rep).catch(() => {}));
    }
  });
  await listen('output:config', (e) => {
    if (e.payload?.fitMode) applyFitMode(stage(), e.payload.fitMode);
  });
  await listen('output:freeze', (e) => {
    frozen = !!e.payload?.frozen;
    document.getElementById('output-freeze-badge').classList.toggle('show', frozen);
  });
  await listen(VIDEO_CTRL_EVENT, (e) => {
    if (frozen) return;
    controlVideo(e.payload.action, e.payload.value);
  });

  // 通知主控：输出窗口已就绪，请重推当前画面
  try { await emit('output:ready', {}); } catch { /* ignore */ }
  setTimeout(() => { emit('output:ready', {}).catch(() => {}); }, 300);

  const ctrls = document.getElementById('output-ctrls');
  const showCtrls = () => {
    ctrls.classList.add('show');
    clearTimeout(ctrlTimer);
    ctrlTimer = setTimeout(() => {
      // 鼠标仍在控制条上时不隐藏
      if (!ctrls.matches(':hover')) ctrls.classList.remove('show');
    }, 2800);
  };
  document.addEventListener('mousemove', showCtrls);
  ctrls.addEventListener('mouseenter', () => {
    clearTimeout(ctrlTimer);
    ctrls.classList.add('show');
  });
  ctrls.addEventListener('mouseleave', () => {
    clearTimeout(ctrlTimer);
    ctrlTimer = setTimeout(() => ctrls.classList.remove('show'), 800);
  });

  document.getElementById('oc-full').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleFs();
  });
  document.getElementById('oc-close').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeOutput();
  });

  document.addEventListener('dblclick', (e) => {
    if (e.target.closest('#output-ctrls')) return;
    toggleFs();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      // Esc：全屏时先退出全屏；非全屏则关闭窗口
      exitFsOrClose();
    }
    if (e.key === 'f' || e.key === 'F') { toggleFs(); return; }
    if (e.key === 'Escape' || e.ctrlKey || e.altKey || e.metaKey) return;
    // 其余按键（上下换行、翻页、黑屏、段落跳转…）交给主控处理
    if (e.key.length === 1 || /^(Arrow|Page|Home|End|Enter)/.test(e.key)) {
      e.preventDefault();
      emit('output:key', { key: e.key, shiftKey: e.shiftKey }).catch(() => {});
    }
  });

  try {
    const win = window.__TAURI__.window.getCurrentWindow();
    isFs = await win.isFullscreen();
  } catch { /* ignore */ }

  // 启动时短暂显示一次控制条，方便用户发现关闭按钮
  showCtrls();
});

async function currentWin() {
  return window.__TAURI__.window.getCurrentWindow();
}

async function toggleFs() {
  try {
    const win = await currentWin();
    const cur = await win.isFullscreen();
    await win.setFullscreen(!cur);
    isFs = !cur;
  } catch {
    try {
      await invoke('set_output_fullscreen', { fullscreen: !isFs });
      isFs = !isFs;
    } catch { /* ignore */ }
  }
}

async function exitFsOrClose() {
  try {
    const win = await currentWin();
    const cur = await win.isFullscreen();
    if (cur || isFs) {
      await win.setFullscreen(false);
      isFs = false;
      return;
    }
  } catch {
    try {
      await invoke('set_output_fullscreen', { fullscreen: false });
      isFs = false;
      return;
    } catch { /* ignore */ }
  }
  await closeOutput();
}

/** 可靠关闭：先退全屏/取消置顶，再用当前窗口 API 关闭 */
async function closeOutput() {
  if (closing) return;
  closing = true;
  try {
    const win = await currentWin();
    try { await win.setFullscreen(false); } catch { /* ignore */ }
    try { await win.setAlwaysOnTop(false); } catch { /* ignore */ }
    isFs = false;
    // 稍等状态落稳再关（Windows 全屏下直接 close 常会失败）
    await new Promise((r) => setTimeout(r, 60));
    await win.close();
  } catch {
    // 回退到后端命令
    try {
      await invoke('close_output_window');
    } catch (err) {
      closing = false;
      console.error('关闭输出窗口失败', err);
    }
  }
}
