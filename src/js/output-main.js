// 输出推送 + 主控预览

import {
  OUTPUT_EVENT, VIDEO_TIME_EVENT, renderOutput, applyFitMode, paintVideoTime,
} from './output-core.js';
import { emit, listen, lsGet } from './util.js';

let previewEl = null;
let current = { kind: 'clear' };
let frozen = false;
/** 快速切条时只采纳最新一次输出 */
let outputSeq = 0;
/** 输出窗口最近一次回报的视频进度 { path, t, d, paused, ended, at } */
let lastVideoReport = null;

listen(VIDEO_TIME_EVENT, (e) => {
  const rep = e.payload;
  if (!rep || current.kind !== 'video' || rep.path !== current.path) return;
  lastVideoReport = { ...rep, at: performance.now() };
  paintVideoTime(previewEl, rep);
  document.dispatchEvent(new CustomEvent('sp:output-video-time', { detail: lastVideoReport }));
}).catch(() => {});

/** 输出窗口正在放的视频进度（无回报 / 已换内容时为 null） */
export function getOutputVideoReport() {
  if (!lastVideoReport || current.kind !== 'video' || lastVideoReport.path !== current.path) return null;
  return lastVideoReport;
}

export function fitMode() {
  return lsGet('sp.output.fit', 'contain');
}

export function setPreviewEl(el) {
  previewEl = el;
  renderCurrent();
}

export function getCurrentOutput() {
  return current;
}

export function isOutputFrozen() {
  return frozen;
}

export function setOutputFrozen(v) {
  frozen = !!v;
  emit('output:freeze', { frozen });
  // 解冻时把主控当前画面重新推给输出窗口
  if (!frozen) {
    emit(OUTPUT_EVENT, current);
  }
}

/** 声明新的输出世代；旧的异步 push 会被丢弃 */
export function claimOutputSeq() {
  return ++outputSeq;
}

export function currentOutputSeq() {
  return outputSeq;
}

/**
 * 手动黑屏 / 恢复。先声明新世代：仍在路上的异步推送（如找完歌词才到的标题卡）会被丢弃，
 * 否则刚按下的黑屏会被晚到的画面顶掉
 */
export function toggleBlack() {
  const seq = claimOutputSeq();
  return pushToOutput(current.kind === 'black' ? { kind: 'clear' } : { kind: 'black' }, seq);
}

/** 手动清屏（同样作废在途的异步推送） */
export function clearOutput() {
  return pushToOutput({ kind: 'clear' }, claimOutputSeq());
}

export function renderCurrent() {
  if (previewEl) {
    renderOutput(previewEl, current, { muted: true, videoPoster: true });
    applyFitMode(previewEl, fitMode());
  }
}

/**
 * 推送到输出窗口并更新预览（冻结时仅更新预览，不改输出）
 * @param {object} payload
 * @param {number} [seq] 传入时必须等于当前 outputSeq，否则忽略（防乱序）
 */
export function pushToOutput(payload, seq) {
  if (seq != null && seq !== outputSeq) return false;
  current = payload;
  renderCurrent();
  if (!frozen) emit(OUTPUT_EVENT, payload);
  return true;
}

/** 强制把当前内容同步到输出窗口（打开窗口后调用） */
export function resyncOutput() {
  emit(OUTPUT_EVENT, current);
  emit('output:config', { fitMode: fitMode() });
  emit('output:freeze', { frozen });
}

/** 推送适配模式设置到输出窗口 */
export function pushFitMode(mode) {
  emit('output:config', { fitMode: mode });
  if (previewEl) applyFitMode(previewEl, mode);
}

/** 视频控制 */
export function sendVideoControl(action, value) {
  if (!frozen) emit('output:video', { action, value });
  if (previewEl) {
    const v = previewEl.querySelector('video');
    if (v) {
      switch (action) {
        case 'play': v.play().catch(() => {}); break;
        case 'pause': v.pause(); break;
        case 'seek':
          if (typeof value === 'number') {
            try { v.currentTime = value; } catch { /* ignore */ }
          }
          break;
        case 'volume':
          // 预览始终静音，不改预览音量
          break;
      }
    }
  }
}
