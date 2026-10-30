// 输出推送 + 主控预览

import { OUTPUT_EVENT, renderOutput, applyFitMode } from './output-core.js';
import { emit, lsGet } from './util.js';

let previewEl = null;
let current = { kind: 'clear' };
let frozen = false;
/** 快速切条时只采纳最新一次输出 */
let outputSeq = 0;

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

export function renderCurrent() {
  if (previewEl) {
    renderOutput(previewEl, current, { muted: true });
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
