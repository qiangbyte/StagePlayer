// AI 伴奏分离进度：浮层面板 + 折叠后的角标

import { listen } from './util.js';

const $ = (id) => document.getElementById(id);

function stemPhaseTitle(phase) {
  return ({
    start: '准备中',
    download: '下载模型',
    split: 'AI 分离',
    write: '写出分轨',
    mix: '合成伴奏',
    done: '完成',
    error: '失败',
    busy: '进行中',
  })[phase] || 'AI 伴奏';
}

let stemPanelCollapsed = false;
let stemLastProgress = null;
let stemHideTimer = null;

function showStemProgressChip(pct) {
  const chip = $('stem-progress-chip');
  const chipPct = $('stem-progress-chip-pct');
  if (!chip) return;
  chip.classList.remove('hidden');
  if (chipPct) chipPct.textContent = Math.round(pct) + '%';
}

export function hideStemProgressChip() {
  $('stem-progress-chip')?.classList.add('hidden');
}

export function showStemProgressPanel(p = {}) {
  const box = $('stem-progress');
  if (!box) return;
  stemLastProgress = p;
  let pct = Math.max(0, Math.min(100, Number(p.percent) || 0));
  if (p.phase === 'download' && p.bytesTotal > 0 && p.bytesDone != null) {
    pct = Math.max(0, Math.min(100, (Number(p.bytesDone) / Number(p.bytesTotal)) * 100));
  }

  // 收起后只更新小条百分比，不强制弹回大面板
  if (stemPanelCollapsed && p.phase !== 'error' && p.phase !== 'done') {
    showStemProgressChip(pct);
    return;
  }

  stemPanelCollapsed = false;
  hideStemProgressChip();
  if (stemHideTimer) {
    clearTimeout(stemHideTimer);
    stemHideTimer = null;
  }
  box.classList.remove('hidden', 'is-hiding');
  box.classList.toggle('is-error', p.phase === 'error');
  box.classList.toggle('is-done', p.phase === 'done');
  const phaseEl = $('stem-progress-phase');
  const titleEl = $('stem-progress-title');
  const songEl = $('stem-progress-song');
  const fill = $('stem-progress-fill');
  const pctEl = $('stem-progress-pct');
  const detail = $('stem-progress-detail');
  if (phaseEl) {
    phaseEl.textContent =
      p.phase === 'download' ? '模型下载' :
      p.phase === 'split' || p.phase === 'write' || p.phase === 'mix' ? '人声分离' :
      'AI 伴奏';
  }
  if (titleEl) titleEl.textContent = stemPhaseTitle(p.phase);
  const name = p.path ? (p.path.split(/[/\\]/).pop() || p.path) : '—';
  if (songEl) songEl.textContent = name;
  if (fill) fill.style.width = pct.toFixed(1) + '%';
  if (pctEl) pctEl.textContent = Math.round(pct) + '%';
  if (detail) detail.textContent = p.message || '';
}

export function hideStemProgressPanel(delayMs = 0, { collapse = false } = {}) {
  const box = $('stem-progress');
  if (!box) return;
  const finish = () => {
    box.classList.add('hidden');
    box.classList.remove('is-hiding');
    if (collapse) {
      stemPanelCollapsed = true;
      const pct = Number(stemLastProgress?.percent) || 0;
      showStemProgressChip(pct);
    } else {
      stemPanelCollapsed = false;
      hideStemProgressChip();
    }
  };
  const start = () => {
    box.classList.add('is-hiding');
    setTimeout(finish, 160);
  };
  if (stemHideTimer) clearTimeout(stemHideTimer);
  if (delayMs > 0) stemHideTimer = setTimeout(start, delayMs);
  else start();
}

/** 绑定面板按钮与后端进度事件（initAudio 调用一次） */
export function initStemProgressUi() {
  $('stem-progress-hide')?.addEventListener('click', () => {
    hideStemProgressPanel(0, { collapse: true });
  });
  $('stem-progress-chip')?.addEventListener('click', () => {
    stemPanelCollapsed = false;
    hideStemProgressChip();
    if (stemLastProgress) showStemProgressPanel(stemLastProgress);
  });
  listen('sp-stem-progress', (e) => {
    const p = e?.payload || e;
    if (!p) return;
    showStemProgressPanel(p);
    if (p.phase === 'done') {
      stemPanelCollapsed = false;
      hideStemProgressPanel(1800);
    }
    if (p.phase === 'error') {
      stemPanelCollapsed = false;
      hideStemProgressChip();
    }
  });
}
