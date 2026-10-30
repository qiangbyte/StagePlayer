// 音频模块：波形 / 频谱 / LED 计时 + 活动目录绑定

import { pickFiles, esc, fileName, lsGet, lsGetCached, lsSet, invoke, listen, toast, AUDIO_EXT } from './util.js';
import { pushToOutput, getCurrentOutput } from './output-main.js';
import { loadLyricsFor, activeLyricIndex } from './lyrics.js';
import {
  renderDirList, filterByFolder, folderTitle, addFolder, renameFolder, removeFolder,
  assignPath, listFolders, getSelectedFolder, FOLDER_ALL, FOLDER_UNCAT,
  getDisplayName, promptRenameMedia, bindViewZoom, getMediaNote, setMediaNote,
} from './media-library.js';

let pendingOutputSeq = null;
let audioSearch = '';
let selectedSongPath = null;

const LS_DEVICE = 'sp.audio.device';

let currentPath = null;
/** 引擎实际在播的文件（仅伴奏时为 AI 缓存伴奏 wav） */
let playPath = null;
/** 源路径 → AI 伴奏缓存路径 */
const instrumentalBySource = Object.create(null);
let playing = false;
let deviceIndex = lsGet(LS_DEVICE, null);
let loopMode = 'all'; // all | one | none

/** 引擎当前音量（渐起渐弱过程中与滑条目标可能不同） */
let engineVol = 0.9;
let fadeGen = 0;
let fadeTimer = null;
let fadeOutStarted = false;

let peaks = null;
let waveDur = 0;
/** 波形悬停预览：{ xCss, t } */
let waveHover = null;
/** 跳转后短暂锁住进度轮询，避免红线被旧 position 拉回去 */
let seekGuardUntil = 0;
let sampleRate = 0;
let audioCtx = null;
let pos = 0;
let currentName = '';
/** path → 波形缓存，避免每次点播放都整曲 decode */
const waveCache = new Map();
/** path → 秒，卡片底栏时长 */
const durCache = new Map();
let waveBuildToken = 0;
let durProbeToken = 0;

let mono = null;
let monoSr = 0;
const BANDS = 28;
const FFT_N = 1024;
let specData = new Float32Array(BANDS);
let specPeak = new Float32Array(BANDS);
// analyze() 每帧复用，避免 60fps 分配
const fftSlice = new Float32Array(FFT_N);
const bandRaw = new Float32Array(BANDS);
let bandColors = [];
let vuLevel = 0;
let vuRmsDb = -120;
let vuPeakDb = -120;
let vuPeakHoldDb = -120;
let vuPeakHoldAt = 0;
let vuClip = false;

const $ = (id) => document.getElementById(id);
const convertSrc = (p) => window.__TAURI__.core.convertFileSrc(p);
const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function fmtHms(sec) {
  if (!isFinite(sec) || sec <= 0) return '--:--:--';
  const t = Math.floor(sec);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function cardLabel(it) {
  const base = it.name || getDisplayName(it.path, fileName(it.path).replace(/\.[^.]+$/, ''));
  if (/\.[a-z0-9]+$/i.test(base)) return base;
  const ext = (it.path.match(/\.[^.]+$/) || [''])[0];
  return base + ext;
}

function durationOf(path) {
  if (!path) return 0;
  if (durCache.has(path)) return durCache.get(path);
  const hit = waveCache.get(path);
  if (hit?.waveDur > 0) {
    durCache.set(path, hit.waveDur);
    return hit.waveDur;
  }
  return 0;
}

function paintCardDuration(path, sec) {
  const list = $('audio-song-list');
  if (!list || !path) return;
  list.querySelectorAll('.audio-card').forEach((card) => {
    if (card.dataset.path !== path) return;
    const el = card.querySelector('.audio-card-dur');
    if (el) el.textContent = fmtHms(sec);
  });
}

/** 空闲时探测时长，不挡起播 */
function scheduleDurProbe(paths) {
  const token = ++durProbeToken;
  const need = (paths || []).filter((p) => p && !durationOf(p));
  if (!need.length) return;
  let i = 0;
  const next = () => {
    if (token !== durProbeToken) return;
    if (i >= need.length) return;
    const path = need[i++];
    const a = new Audio();
    a.preload = 'metadata';
    const finish = () => {
      try {
        const d = a.duration;
        if (Number.isFinite(d) && d > 0) {
          durCache.set(path, d);
          paintCardDuration(path, d);
        }
      } catch { /* ignore */ }
      a.removeAttribute('src');
      a.load?.();
      const ric = window.requestIdleCallback || ((cb) => setTimeout(cb, 16));
      ric(() => next());
    };
    a.addEventListener('loadedmetadata', finish, { once: true });
    a.addEventListener('error', finish, { once: true });
    try { a.src = convertSrc(path); } catch { finish(); }
  };
  setTimeout(next, 0);
}

function fmtCs(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec % 1) * 100);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function currentEvent() {
  const evs = lsGetCached('sp.program.events', []);
  const cid = lsGetCached('sp.program.current', null);
  return evs.find((e) => e.id === cid) || evs[0] || null;
}

function eventAudioItems() {
  const ev = currentEvent();
  const items = ev ? ev.items.filter((i) => i.type === 'audio') : [];
  return items.map((it) => ({
    ...it,
    name: it.name || getDisplayName(it.path, fileName(it.path).replace(/\.[^.]+$/, '')),
  }));
}

function resolveItemName(path) {
  const it = eventAudioItems().find((i) => i.path === path);
  return it?.name || getDisplayName(path, fileName(path).replace(/\.[^.]+$/, ''));
}

function renameAudioItem(path) {
  if (!path) return;
  const n = promptRenameMedia(path, resolveItemName(path));
  if (n == null) return;
  if (n === false) return toast('名称不能为空');
  updateEvent((ev) => {
    for (const item of ev.items) {
      if (item.type === 'audio' && item.path === path) item.name = n;
    }
  });
  if (currentPath === path) {
    currentName = n;
    const titleEl = $('audio-title');
    if (titleEl) titleEl.textContent = n;
  }
  renderList();
  toast('已重命名');
}

/** 单曲：one=单曲循环；next=播完自动下一首（默认） */
function getItemLoopMode(path) {
  const it = eventAudioItems().find((i) => i.path === path);
  if (it?.loop === 'one') return 'one';
  if (it?.loop === 'next') return 'next';
  // 未单独设置时跟底部全局：one→单曲，其余→自动下一首
  return loopMode === 'one' ? 'one' : 'next';
}

function loopBtnMeta(mode) {
  if (mode === 'one') {
    return { icon: '🔂', title: '单曲循环中 · 再点改为自动下一首', cls: 'is-one' };
  }
  return { icon: '⏭', title: '自动下一首 · 再点改为单曲循环', cls: 'is-next' };
}

/** 本曲是否开启仅伴奏（AI 伴奏轨） */
function getItemVocalCancel(path) {
  const it = eventAudioItems().find((i) => i.path === path);
  return !!it?.vocalCancel;
}

function vocalBtnMeta(on) {
  if (on) {
    return { icon: '🎹', title: '仅伴奏中（AI）· 再点恢复原唱', cls: 'is-on' };
  }
  return { icon: '🎤', title: '原唱 · 再点仅播伴奏（AI 分离，首次较慢）', cls: '' };
}

function isEnginePath(enginePath) {
  if (!enginePath) return false;
  return enginePath === currentPath || enginePath === playPath;
}

/** 实际送去引擎的路径：仅伴奏且已有缓存 → 伴奏 wav */
function effectivePlayPath(srcPath = currentPath) {
  if (!srcPath) return null;
  if (getItemVocalCancel(srcPath) && instrumentalBySource[srcPath]) {
    return instrumentalBySource[srcPath];
  }
  return srcPath;
}

function paintVocalButtons(path) {
  const on = getItemVocalCancel(path);
  const list = $('audio-song-list');
  list?.querySelectorAll('.audio-card').forEach((card) => {
    if (card.dataset.path !== path) return;
    const btn = card.querySelector('[data-act="vocal"]');
    if (!btn) return;
    const m = vocalBtnMeta(on);
    btn.textContent = m.icon;
    btn.title = m.title;
    btn.classList.toggle('is-on', on);
    card.classList.toggle('vocal-on', on);
  });
}

/** 在相同进度切换原唱/伴奏文件 */
async function switchPlaybackFile(filePath, at, wasPlaying) {
  playPath = filePath;
  seekGuardUntil = Date.now() + 800;
  await invoke('audio_play', {
    path: filePath,
    deviceIndex,
    startAt: at > 0.05 ? at : null,
    vocalCancel: false,
  });
  setEngineVol(volume());
  pos = at;
  if (!wasPlaying) {
    await invoke('audio_pause');
    playing = false;
  } else {
    playing = true;
  }
  updatePlayBtn();
  paintSongActive();
}

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

function hideStemProgressChip() {
  $('stem-progress-chip')?.classList.add('hidden');
}

function showStemProgressPanel(p = {}) {
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

function hideStemProgressPanel(delayMs = 0, { collapse = false } = {}) {
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

async function toggleItemVocalCancel(path) {
  if (!path) return;
  const next = !getItemVocalCancel(path);

  if (next) {
    // 若已有任务：只打开进度面板，不再弹失败 toast
    try {
      const st = await invoke('stem_job_status');
      if (st?.busy) {
        showStemProgressPanel({
          phase: 'busy',
          percent: Number(st.percent) || 0,
          message: '已有分离任务在进行，请稍候…',
          path: st.path || path,
        });
        return;
      }
    } catch { /* ignore */ }

    showStemProgressPanel({
      phase: 'start',
      percent: 1,
      message: '首次约需下载 200MB 模型，之后会显示下载/分离进度',
      path,
    });

    let info;
    try {
      info = await invoke('stem_ensure_instrumental', { path });
    } catch (err) {
      const msg = String(err?.message || err || '');
      if (msg.includes('BUSY') || msg === 'BUSY') {
        showStemProgressPanel({
          phase: 'busy',
          percent: 0,
          message: '已有分离任务在进行，请看右下角进度',
          path,
        });
        return;
      }
      showStemProgressPanel({
        phase: 'error',
        percent: 0,
        message: msg,
        path,
      });
      return;
    }
    if (!info?.instrumentalPath) {
      showStemProgressPanel({
        phase: 'error',
        percent: 0,
        message: '未得到伴奏文件',
        path,
      });
      return;
    }
    instrumentalBySource[path] = info.instrumentalPath;
  }

  const ok = updateEvent((ev) => {
    for (const item of ev.items) {
      if (item.type === 'audio' && item.path === path) item.vocalCancel = next;
    }
  });
  if (!ok) return toast('无法保存伴奏设置');
  paintVocalButtons(path);

  if (path === currentPath) {
    const wasPlaying = playing;
    const at = pos;
    try {
      const file = effectivePlayPath(path);
      await switchPlaybackFile(file, at, wasPlaying);
    } catch (err) {
      toast('切换播放失败：' + (err?.message || err));
      return;
    }
  }
  if (next) {
    showStemProgressPanel({
      phase: 'done',
      percent: 100,
      message: '已切换到 AI 伴奏',
      path,
    });
    hideStemProgressPanel(2200);
  } else {
    hideStemProgressPanel(0);
    toast('已恢复原唱');
  }
}

function toggleItemLoopMode(path) {
  if (!path) return;
  const cur = getItemLoopMode(path);
  const next = cur === 'one' ? 'next' : 'one';
  const ok = updateEvent((ev) => {
    for (const item of ev.items) {
      if (item.type === 'audio' && item.path === path) item.loop = next;
    }
  });
  if (!ok) return toast('无法保存播放顺序');
  // 正在播这首时，同步底部按钮文案，避免误解
  if (path === currentPath) {
    loopMode = next === 'one' ? 'one' : 'all';
    const btnLoop = $('audio-loop');
    if (btnLoop) btnLoop.textContent = getLoopModeLabel();
  }
  paintSongActive();
  // 轻量刷图标；若列表刚建好也 OK
  const list = $('audio-song-list');
  list?.querySelectorAll('.audio-card').forEach((card) => {
    if (card.dataset.path !== path) return;
    const btn = card.querySelector('[data-act="loop"]');
    if (!btn) return;
    const m = loopBtnMeta(next);
    btn.textContent = m.icon;
    btn.title = m.title;
    btn.classList.toggle('is-one', next === 'one');
    btn.classList.toggle('is-next', next === 'next');
    card.classList.toggle('loop-one', next === 'one');
  });
  toast(next === 'one' ? '已设为单曲循环' : '已设为自动下一首');
}

/** 通过节目单模块改数据，避免直接写旧 LS 把内存里的整场演出冲掉 */
function updateEvent(fn) {
  const detail = { fn, ok: false };
  document.dispatchEvent(new CustomEvent('sp:program-mutate', { detail }));
  return !!detail.ok;
}

function volume() {
  return +($('audio-volume')?.value || 0.9);
}

function volToDb(v) {
  const x = Math.max(1e-6, Math.min(1, v));
  return 20 * Math.log10(x);
}

function fmtDb(db) {
  if (!Number.isFinite(db) || db <= -90) return '-∞';
  const n = Math.round(db * 10) / 10;
  return (n > 0 ? '+' : '') + n.toFixed(1);
}

function syncVolReadout() {
  const v = volume();
  const pct = Math.round(v * 100);
  const dbTxt = fmtDb(volToDb(v)) + ' dB';
  const pctEl = $('audio-vol-pct');
  const label = $('audio-vol-label');
  const dbEl = $('audio-vol-db');
  if (pctEl) pctEl.textContent = pct + '%';
  if (label) label.textContent = pct + '%';
  if (dbEl) dbEl.textContent = dbTxt;
}

function syncMeterReadout() {
  const rmsEl = $('audio-rms-db');
  const peakEl = $('audio-peak-db');
  const clipEl = $('audio-clip');
  if (rmsEl) rmsEl.textContent = fmtDb(vuRmsDb) + ' dB';
  if (peakEl) peakEl.textContent = fmtDb(vuPeakHoldDb) + ' dB';
  if (clipEl) clipEl.classList.toggle('hidden', !vuClip);
  syncVolReadout();
}

function cancelFade() {
  fadeGen += 1;
  if (fadeTimer) {
    clearInterval(fadeTimer);
    fadeTimer = null;
  }
}

function setEngineVol(v) {
  engineVol = Math.max(0, Math.min(1, v));
  // 演出稳定性：音量 IPC 失败不打断播放，仅静默重试一次
  invoke('audio_set_volume', { v: engineVol }).catch(() => {
    setTimeout(() => {
      invoke('audio_set_volume', { v: engineVol }).catch(() => {});
    }, 80);
  });
  syncVolReadout();
}

/** 音量渐变到目标；durationSec<=0 则立刻到位 */
function fadeTo(target, durationSec) {
  cancelFade();
  const gen = fadeGen;
  const to = Math.max(0, Math.min(1, target));
  if (!(durationSec > 0)) {
    setEngineVol(to);
    return Promise.resolve();
  }
  const from = engineVol;
  const steps = Math.max(6, Math.ceil(durationSec * 20));
  const dt = (durationSec * 1000) / steps;
  let i = 0;
  return new Promise((resolve) => {
    fadeTimer = setInterval(() => {
      if (gen !== fadeGen) {
        clearInterval(fadeTimer);
        fadeTimer = null;
        resolve();
        return;
      }
      i += 1;
      setEngineVol(from + (to - from) * (i / steps));
      if (i >= steps) {
        clearInterval(fadeTimer);
        fadeTimer = null;
        setEngineVol(to);
        resolve();
      }
    }, dt);
  });
}

/** @returns {{ startAt:number, fadeIn:number, fadeOut:number }} */
function getItemCue(path) {
  const it = eventAudioItems().find((i) => i.path === path) || {};
  const startAt = Math.max(0, Number(it.startAt) || 0);
  const fadeIn = Math.max(0, Math.min(60, Number(it.fadeIn) || 0));
  const fadeOut = Math.max(0, Math.min(60, Number(it.fadeOut) || 0));
  return { startAt, fadeIn, fadeOut };
}

function cueBadgeText(cue) {
  const bits = [];
  if (cue.startAt > 0) {
    const m = Math.floor(cue.startAt / 60);
    const s = Math.floor(cue.startAt % 60);
    bits.push(`${m}:${String(s).padStart(2, '0')}起`);
  }
  if (cue.fadeIn > 0) bits.push(`渐起${cue.fadeIn}s`);
  if (cue.fadeOut > 0) bits.push(`渐弱${cue.fadeOut}s`);
  return bits.join(' · ');
}

function resolveItemNote(path) {
  if (!path) return '';
  const it = eventAudioItems().find((i) => i.path === path);
  const fromItem = (it?.note || '').trim();
  if (fromItem) return fromItem;
  return getMediaNote(path).trim();
}

function fillCueBar(path) {
  const cue = path ? getItemCue(path) : { startAt: 0, fadeIn: 0, fadeOut: 0 };
  const minEl = $('audio-start-min');
  const secEl = $('audio-start-sec');
  const inEl = $('audio-fade-in');
  const outEl = $('audio-fade-out');
  if (minEl) minEl.value = String(Math.floor(cue.startAt / 60));
  if (secEl) secEl.value = String(Math.floor(cue.startAt % 60));
  if (inEl) inEl.value = String(cue.fadeIn || 0);
  if (outEl) outEl.value = String(cue.fadeOut || 0);
  const tip = $('audio-cue-tip');
  if (tip) tip.textContent = path ? (cueBadgeText(cue) || '未设置起播/渐变') : '先选一首歌';
  const noteEl = $('audio-note');
  if (noteEl) noteEl.value = path ? resolveItemNote(path) : '';
}

function saveAudioNote() {
  const path = selectedSongPath || currentPath;
  if (!path) return toast('请先选中一首歌');
  const note = ($('audio-note')?.value || '').trim();
  setMediaNote(path, note);
  const ok = updateEvent((ev) => {
    for (const item of ev.items) {
      if (item.type === 'audio' && item.path === path) item.note = note;
    }
  });
  if (!ok) return toast('备注未能写入节目单，已存本地');
  renderList();
  toast(note ? '备注已保存' : '已清除备注');
}

function saveCueFromBar() {
  const path = selectedSongPath || currentPath;
  if (!path) return toast('请先选中一首歌');
  const min = Math.max(0, Math.floor(Number($('audio-start-min')?.value) || 0));
  const sec = Math.max(0, Math.min(59, Math.floor(Number($('audio-start-sec')?.value) || 0)));
  const fadeIn = Math.max(0, Math.min(60, Number($('audio-fade-in')?.value) || 0));
  const fadeOut = Math.max(0, Math.min(60, Number($('audio-fade-out')?.value) || 0));
  const startAt = min * 60 + sec;
  const ok = updateEvent((ev) => {
    for (const item of ev.items) {
      if (item.type === 'audio' && item.path === path) {
        item.startAt = startAt;
        item.fadeIn = fadeIn;
        item.fadeOut = fadeOut;
      }
    }
  });
  if (!ok) return toast('保存失败');
  fillCueBar(path);
  renderList();
  const parts = [];
  if (startAt > 0) parts.push(`从 ${min}:${String(sec).padStart(2, '0')} 起播`);
  if (fadeIn > 0) parts.push(`渐起 ${fadeIn}s`);
  if (fadeOut > 0) parts.push(`渐弱 ${fadeOut}s`);
  toast(parts.length ? `已保存：${parts.join(' · ')}` : '已清除起播/渐变（从开头、无渐变）');
}

async function startPlayback(startAt = 0, opts = {}) {
  if (!currentPath) return;
  const cue = getItemCue(currentPath);
  // 显式传入优先；否则用本曲设置的起播点
  const at = Number.isFinite(startAt) && startAt > 0 ? startAt : (cue.startAt || 0);
  fadeOutStarted = false;
  cancelFade();

  // 仅伴奏：若已缓存则播 AI 伴奏；未缓存则先原曲（可再点按钮触发分离）
  if (getItemVocalCancel(currentPath) && !instrumentalBySource[currentPath]) {
    try {
      const info = await invoke('stem_get_instrumental', { path: currentPath });
      if (info?.ready && info.instrumentalPath) {
        instrumentalBySource[currentPath] = info.instrumentalPath;
      }
    } catch { /* ignore */ }
  }
  playPath = effectivePlayPath(currentPath);

  // audio_play 本身会换曲，无需先 stop（少一次 IPC）
  await invoke('audio_play', {
    path: playPath,
    deviceIndex,
    startAt: at > 0 ? at : null,
    vocalCancel: false,
  });
  pos = at;
  const target = volume();
  if (cue.fadeIn > 0 && !opts.noFade) {
    engineVol = 0;
    setEngineVol(0);
    fadeTo(target, cue.fadeIn);
  } else {
    setEngineVol(target);
  }
  playing = true;
  updatePlayBtn();
  fillCueBar(currentPath);
  // 起播路径默认不整表重渲，只刷高亮
  if (opts.skipList === false && currentModule() === 'audio') renderList();
  else paintSongActive();
}

async function play() {
  if (!currentPath) return;
  try {
    const st = await invoke('audio_state');
    // 仅当后端当前曲目就是本曲且已加载时才 resume，否则重新播放
    if (st.exists && isEnginePath(st.path) && st.paused) {
      await invoke('audio_resume');
      playing = true;
      // 续播不重做渐起，但保证音量回到目标
      if (!fadeTimer) setEngineVol(volume());
    } else if (st.exists && isEnginePath(st.path) && st.playing) {
      playing = true;
    } else {
      await startPlayback(0, { skipList: true });
      return;
    }
    updatePlayBtn();
    paintSongActive();
  } catch (err) {
    toast('播放失败：' + err);
  }
}

export async function toggleAudio() {
  if (!currentPath) {
    const first = eventAudioItems()[0];
    if (first) return loadFile(first.path, true, { skipList: true });
    toast('请先导入音频');
    return;
  }
  try {
    if (playing) {
      cancelFade();
      await invoke('audio_pause');
      playing = false;
    } else {
      await play();
      return;
    }
    updatePlayBtn();
    paintSongActive();
  } catch (err) {
    toast('操作失败：' + err);
  }
}

function updatePlayBtn() {
  const btn = $('audio-play');
  if (btn) btn.textContent = playing ? '⏸' : '▶';
  document.dispatchEvent(new CustomEvent('sp:audio-state', {
    detail: { playing, path: currentPath, pos, duration: waveDur },
  }));
}

/**
 * @param {string} path
 * @param {boolean} autoplay
 * @param {{ stay?: boolean, skipList?: boolean, pushOutput?: boolean }} [opts]
 */
function loadFile(path, autoplay = true, opts = {}) {
  const stay = !!opts.stay;
  const skipList = opts.skipList ?? stay;
  // stay（节目单叠播）默认不推音频卡，避免盖掉 PPT/经文画面
  const pushOutput = opts.pushOutput ?? (!stay && !!$('audio-auto-push')?.checked);

  currentPath = path;
  pos = 0;
  vuLevel = 0;
  specData = new Float32Array(BANDS);
  specPeak = new Float32Array(BANDS);
  currentName = resolveItemName(path);
  selectedSongPath = path;
  const titleEl = $('audio-title');
  if (titleEl) titleEl.textContent = currentName;

  fillCueBar(path);

  if (autoplay) {
    // ① 最先发 IPC 出声（含起播点 / 渐起），UI/波形全部让路
    playing = true;
    const playP = startPlayback(0, { skipList: true });
    updatePlayBtn();
    paintSongActive();
    // ② 出声后再刷波形缓存与 meta（避免抢主线程）
    queueMicrotask(() => {
      if (currentPath === path) applyWaveCache(path);
    });
    setTimeout(() => bindAudioMeta(path), 160);
    scheduleBuildWave(path);
    // 把播放结果返回给节目单 activate，避免 cue 误标「已开播」
    return playP
      .then(() => {
        if (pushOutput) pushCard().catch(() => {});
        paintSongActive();
      })
      .catch((err) => {
        playing = false;
        updatePlayBtn();
        paintSongActive();
        toast('播放失败：' + err);
        throw err;
      });
  }
  cancelFade();
  invoke('audio_stop').catch(() => {});
  playing = false;
  applyWaveCache(path);
  updatePlayBtn();
  paintSongActive();
  bindAudioMeta(path);
  if (!skipList) requestAnimationFrame(() => renderList());
  scheduleBuildWave(path);
  return Promise.resolve();
}

function bindAudioMeta(path) {
  const meta = $('audio-meta');
  if (!meta || currentPath !== path) return;
  if (meta.dataset.path === path) return;
  meta.dataset.path = path;
  meta.src = convertSrc(path);
}

function applyWaveCache(path) {
  const hit = waveCache.get(path);
  if (!hit) {
    peaks = null;
    waveDur = 0;
    sampleRate = 0;
    mono = null;
    monoSr = 0;
    return false;
  }
  peaks = hit.peaks;
  waveDur = hit.waveDur;
  sampleRate = hit.sampleRate;
  // 长期缓存不再含 mono；频谱仅当前曲 decode 时才有
  mono = hit.mono || null;
  monoSr = hit.monoSr || 0;
  updateTech();
  draw();
  return true;
}

function scheduleBuildWave(path) {
  if (waveCache.has(path)) return;
  const token = ++waveBuildToken;
  // 等播放 IPC 先走完，再在空闲时解码
  setTimeout(() => {
    if (token !== waveBuildToken || currentPath !== path) return;
    const ric = window.requestIdleCallback
      || ((cb) => setTimeout(() => cb({ didTimeout: true, timeRemaining: () => 0 }), 48));
    ric(() => {
      if (token !== waveBuildToken || currentPath !== path) return;
      buildWave(path, token);
    }, { timeout: 400 });
  }, 0);
}

function step(d) {
  const items = visibleAudioItems();
  if (!items.length) return false;
  const idx = items.findIndex((i) => i.path === currentPath);
  const next = items[(((idx < 0 ? 0 : idx) + d) % items.length + items.length) % items.length];
  loadFile(next.path, true);
  return true;
}

/** 键盘 ←/→ 切歌（main.js） */
export function audioStep(delta) {
  return step(delta);
}

function songTitleParts() {
  const parts = currentName.split(/\s*[-–—]\s*/);
  return {
    title: parts.length > 1 ? parts.slice(1).join(' - ') : currentName,
    sub: parts.length > 1 ? parts[0] : '',
  };
}

/** 推送扩展屏：有同名 .lrc/.txt 则滚歌词，否则标题卡 */
async function pushCard() {
  if (!currentPath) return;
  const { title, sub } = songTitleParts();
  try {
    const pack = await loadLyricsFor(currentPath, convertSrc);
    if (pack?.lines?.length) {
      const dur = waveDur || +($('audio-meta')?.duration) || 0;
      const active = activeLyricIndex(pack.lines, pos, pack.timed, dur);
      pushToOutput({
        kind: 'audio',
        mode: 'lyrics',
        title: pack.title || title,
        sub: pack.artist || sub,
        lines: pack.lines,
        timed: !!pack.timed,
        active,
        path: currentPath,
      }, pendingOutputSeq);
      return;
    }
  } catch {
    /* 无歌词文件则标题卡 */
  }
  pushToOutput({
    kind: 'audio',
    title,
    sub,
    path: currentPath,
  }, pendingOutputSeq);
}

function syncLyricsOutput() {
  const cur = getCurrentOutput();
  if (cur?.kind !== 'audio' || cur.mode !== 'lyrics') return;
  if (!currentPath || cur.path !== currentPath) return;
  if (!Array.isArray(cur.lines) || !cur.lines.length) return;
  const dur = waveDur || +($('audio-meta')?.duration) || 0;
  const active = activeLyricIndex(cur.lines, pos, cur.timed !== false, dur);
  if (active === (cur.active | 0)) return;
  pushToOutput({ ...cur, active }, pendingOutputSeq);
}

/** Rust 侧解码：返回 peaks + 低采样率单声道（二进制，见 src-tauri/src/wave.rs） */
async function decodeWaveNative(path) {
  const buf = await invoke('audio_wave', { path });
  const dv = new DataView(buf);
  const duration = dv.getFloat64(0, true);
  const sampleRate = dv.getUint32(8, true);
  const monoSr = dv.getUint32(12, true);
  const nPeaks = dv.getUint32(16, true);
  const nMono = dv.getUint32(20, true);
  return {
    duration,
    sampleRate,
    monoSr,
    // 拷贝出来：peaks 进长期缓存，不能拖着整块 mono 缓冲区
    peaks: new Float32Array(buf, 24, nPeaks).slice(),
    mono: new Float32Array(buf, 24 + nPeaks * 4, nMono),
  };
}

/** 回退：WebAudio 整首解码（内存占用大，仅原生不支持的格式使用） */
async function decodeWaveWeb(path, token) {
  const resp = await fetch(convertSrc(path));
  if (token !== waveBuildToken) return null;
  const buf = await resp.arrayBuffer();
  if (token !== waveBuildToken) return null;
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') await audioCtx.resume().catch(() => {});
  const audio = await audioCtx.decodeAudioData(buf);
  if (token !== waveBuildToken) return null;
  const ch0 = audio.getChannelData(0);
  const ch1 = audio.numberOfChannels > 1 ? audio.getChannelData(1) : null;

  const n = 900;
  const block = Math.max(1, Math.floor(ch0.length / n));
  const peaks = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    const s = i * block;
    for (let j = 0; j < block; j += 24) {
      const v = Math.abs((ch0[s + j] + (ch1 ? ch1[s + j] : 0)) / (ch1 ? 2 : 1) || 0);
      if (v > m) m = v;
    }
    peaks[i] = Math.min(1, m * 1.4);
  }
  const sr = audio.sampleRate;
  const dec = Math.max(1, Math.floor(sr / 11025));
  const outLen = Math.floor(ch0.length / dec);
  const mono = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const s = i * dec;
    mono[i] = ch1 ? (ch0[s] + ch1[s]) / 2 : ch0[s];
  }
  return { duration: audio.duration, sampleRate: sr, monoSr: Math.floor(sr / dec), peaks, mono };
}

async function buildWave(path, token = waveBuildToken) {
  if (waveCache.has(path)) {
    if (currentPath === path) applyWaveCache(path);
    return;
  }
  if (currentPath === path) {
    // 保留已有缓存展示；无缓存时先清空波形区但不阻塞
    if (!peaks) updateTech();
  }
  try {
    // 优先 Rust 原生解码（不占 WebView 内存）；不支持的格式回退到 WebAudio
    const w = await decodeWaveNative(path).catch(() => null) || await decodeWaveWeb(path, token);
    if (!w || token !== waveBuildToken) return;
    const arr = w.peaks;
    const dur = w.duration;
    const sr = w.sampleRate;
    // 频谱 mono 只留给「当前曲」，不进长期缓存（防 WebView OOM）
    const isCur = token === waveBuildToken && currentPath === path;
    const md = isCur ? w.mono : null;
    const mdSr = isCur ? w.monoSr : 0;
    // 缓存只存 peaks + 时长（约 4KB/首），不存整轨 PCM
    const pack = {
      peaks: arr,
      waveDur: dur,
      sampleRate: sr,
    };
    waveCache.set(path, pack);
    if (pack.waveDur > 0) {
      durCache.set(path, pack.waveDur);
      paintCardDuration(path, pack.waveDur);
    }
    while (waveCache.size > 6) {
      waveCache.delete(waveCache.keys().next().value);
    }
    if (token === waveBuildToken && currentPath === path) {
      peaks = pack.peaks;
      waveDur = pack.waveDur;
      sampleRate = pack.sampleRate;
      mono = md;
      monoSr = mdSr;
      updateTech();
      draw();
      document.dispatchEvent(new CustomEvent('sp:audio-state', {
        detail: { playing, path: currentPath, pos, duration: waveDur },
      }));
    }
  } catch {
    if (token === waveBuildToken && currentPath === path && !waveCache.has(path)) {
      peaks = null;
      mono = null;
      updateTech();
      draw();
    }
  }
}

function goertzel(data, sr, freq) {
  const N = data.length;
  const k = Math.round((N * freq) / sr);
  const w = (2 * Math.PI * k) / N;
  const coeff = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < N; i++) {
    const s = data[i] + coeff * s1 - s2;
    s2 = s1; s1 = s;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2)) / (N / 2);
}

function initBandColors() {
  if (bandColors.length) return;
  for (let i = 0; i < BANDS; i++) {
    const t = i / (BANDS - 1);
    const hue = 195 - 195 * t;
    bandColors.push(`hsl(${hue}, 90%, 55%)`);
  }
}

function analyze() {
  if (!mono || !monoSr) {
    if (!playing) {
      vuRmsDb = -120;
      vuPeakDb = -120;
      vuLevel *= 0.85;
    }
    return;
  }
  const start = Math.floor(pos * monoSr);
  const slice = fftSlice;
  for (let i = 0; i < FFT_N; i++) slice[i] = mono[start + i] || 0;
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < FFT_N; i++) {
    const s = slice[i];
    sum += s * s;
    const a = Math.abs(s);
    if (a > peak) peak = a;
  }
  const rms = Math.sqrt(sum / FFT_N);
  // 文件样本 dBFS + 软件推子 ≈ 输出电平估计（控台参考）
  const volLin = Math.max(1e-6, engineVol);
  const rmsDb = 20 * Math.log10(rms * volLin + 1e-12);
  const peakDb = 20 * Math.log10(peak * volLin + 1e-12);
  vuRmsDb = rmsDb;
  vuPeakDb = peakDb;
  if (peakDb >= vuPeakHoldDb - 0.1) {
    vuPeakHoldDb = peakDb;
    vuPeakHoldAt = performance.now();
  } else if (performance.now() - vuPeakHoldAt > 1200) {
    vuPeakHoldDb = Math.max(peakDb, vuPeakHoldDb - 0.35);
  }
  vuClip = peakDb > -0.3;
  // M32 段位映射（近 0dB 分辨率更高）
  const seg = dbToM32Index(rmsDb);
  const level = Math.max(0, (seg + 1) / M32_METER_DB.length);
  vuLevel = playing ? Math.max(level, vuLevel * 0.82) : vuLevel * 0.88;

  const raw = bandRaw;
  for (let b = 0; b < BANDS; b++) {
    const f = 50 * Math.pow(16000 / 50, b / (BANDS - 1));
    const mag = goertzel(slice, monoSr, f);
    const db = 20 * Math.log10(mag * volLin + 1e-9);
    raw[b] = Math.max(0, Math.min(1, (db + 58) / 52));
  }
  for (let b = 0; b < BANDS; b++) {
    const t = playing ? raw[b] : raw[b] * 0.55;
    specData[b] = t > specData[b] ? t : specData[b] * 0.82 + t * 0.18;
    specPeak[b] = Math.max(specData[b], specPeak[b] - 0.012);
  }
}

function drawSpectrum() {
  const cv = $('audio-spec');
  if (!cv || !cv.parentElement) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.parentElement.clientWidth;
  const H = cv.parentElement.clientHeight;
  if (W < 10 || H < 10) return;
  if (cv.width !== Math.floor(W * dpr) || cv.height !== Math.floor(H * dpr)) {
    cv.width = Math.floor(W * dpr);
    cv.height = Math.floor(H * dpr);
  }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#050507';
  g.fillRect(0, 0, W, H);
  g.strokeStyle = '#101318';
  g.lineWidth = 1;
  g.beginPath();
  for (let x = 0; x < W; x += 32) { g.moveTo(x + .5, 0); g.lineTo(x + .5, H); }
  for (let y = 0; y < H; y += 32) { g.moveTo(0, y + .5); g.lineTo(W, y + .5); }
  g.stroke();

  initBandColors();
  const gap = 3;
  const bw = W / BANDS;
  for (let b = 0; b < BANDS; b++) {
    const h = Math.max(2, specData[b] * (H - 6));
    const x = b * bw + gap / 2;
    g.fillStyle = bandColors[b];
    g.fillRect(x, H - h, bw - gap, h);
    const py = H - Math.max(4, specPeak[b] * (H - 6));
    g.fillStyle = '#e8e8e8';
    g.fillRect(x, py - 2, bw - gap, 2);
  }
}

/** M32/X32 主表风格刻度（dBFS）：低段疏、近 0 密；绿≤-18 / 黄≤-9 / 红＞-9 / CLIP≈0 */
const M32_METER_DB = [
  -60, -54, -48, -42, -36, -30, -27, -24, -21, -18,
  -15, -12, -9, -6, -3, -2, -1, 0,
];

function m32SegColor(db, on) {
  if (db >= -1) return on ? '#ff2a2a' : '#3a1212';
  if (db >= -9) return on ? '#ff3b3b' : '#3a1414';
  if (db >= -18) return on ? '#ffcc33' : '#3a3210';
  return on ? '#3dd66a' : '#123a18';
}

function dbToM32Index(db) {
  if (!Number.isFinite(db) || db < -60) return -1;
  let lit = -1;
  for (let i = 0; i < M32_METER_DB.length; i++) {
    if (db >= M32_METER_DB[i]) lit = i;
  }
  return lit;
}

function drawVU() {
  const cv = $('audio-vu');
  if (!cv || !cv.parentElement) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const wrap = cv.parentElement;
  const cssW = Math.max(160, wrap.clientWidth || 220);
  const cssH = 30;
  const tw = Math.round(cssW * dpr);
  const th = Math.round(cssH * dpr);
  if (cv.width !== tw || cv.height !== th) {
    cv.width = tw;
    cv.height = th;
  }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = cssW;
  const H = cssH;
  g.fillStyle = '#07070a';
  g.fillRect(0, 0, W, H);

  const SEGS = M32_METER_DB.length;
  const gap = 1.5;
  const bw = (W - gap * (SEGS - 1)) / SEGS;
  const rmsLit = dbToM32Index(vuRmsDb);
  const peakLit = dbToM32Index(vuPeakHoldDb);
  for (let i = 0; i < SEGS; i++) {
    const db = M32_METER_DB[i];
    const on = i <= rmsLit;
    g.fillStyle = m32SegColor(db, on);
    g.fillRect(i * (bw + gap), 4, bw, H - 12);
  }
  if (peakLit >= 0) {
    const px = peakLit * (bw + gap) + bw / 2;
    g.fillStyle = '#ffffff';
    g.fillRect(px - 1, 2, 2, H - 8);
  }
  if (vuClip) {
    g.fillStyle = '#ff3030';
    g.fillRect(W - 10, 2, 8, H - 8);
  }
  syncMeterReadout();
}

function updateTech() {
  const meta = $('audio-meta');
  const dur = waveDur || (meta?.duration || 0);
  const el = $('audio-tech');
  if (el) {
    el.textContent =
      `总时长 ${fmtCs(dur)} · 采样率 ${sampleRate ? (sampleRate / 1000).toFixed(1) + ' kHz' : '--'}`;
  }
}

function draw() {
  const cv = $('audio-wave');
  if (!cv || !cv.parentElement) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.parentElement.clientWidth;
  const H = cv.parentElement.clientHeight;
  if (W < 10 || H < 10) return;
  if (cv.width !== Math.floor(W * dpr) || cv.height !== Math.floor(H * dpr)) {
    cv.width = Math.floor(W * dpr);
    cv.height = Math.floor(H * dpr);
  }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#050507';
  g.fillRect(0, 0, W, H);

  const rulerH = 20;
  const waveH = H - rulerH;
  const mid = waveH / 2;

  g.strokeStyle = '#0e120e';
  g.lineWidth = 1;
  for (let x = 0; x < W; x += 48) {
    g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, waveH); g.stroke();
  }
  g.beginPath(); g.moveTo(0, mid + 0.5); g.lineTo(W, mid + 0.5); g.stroke();

  const meta = $('audio-meta');
  const dur = waveDur || (meta?.duration || 0);
  const px = dur ? Math.min(W, (pos / dur) * W) : 0;

  if (peaks && peaks.length) {
    const n = peaks.length;
    for (let x = 0; x < W; x++) {
      const v = peaks[Math.floor((x / W) * n)] * (waveH / 2 - 4);
      g.fillStyle = x <= px ? '#3dd55f' : '#82888f';
      g.fillRect(x, mid - v, 1, Math.max(1, v * 2));
    }
  } else {
    g.fillStyle = '#445';
    g.font = '13px sans-serif';
    g.textAlign = 'center';
    g.fillText(currentPath ? '该格式无法显示波形，播放不受影响' : '单击列表即可播放', W / 2, mid);
  }

  if (dur) {
    g.fillStyle = '#ff4040';
    g.fillRect(px - 1, 0, 2, waveH);
    g.fillStyle = 'rgba(255,64,64,.18)';
    g.fillRect(0, 0, px, waveH);

    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const stepV = steps.find((s) => W / (dur / s) >= 48) || 900;
    g.fillStyle = '#556';
    g.font = '10px Consolas, monospace';
    g.textAlign = 'left';
    for (let t = 0; t <= dur; t += stepV) {
      const x = (t / dur) * W;
      g.fillRect(x, waveH, 1, 5);
      const m = Math.floor(t / 60), s = Math.floor(t % 60);
      g.fillText(`${m}:${String(s).padStart(2, '0')}`, x + 3, H - 6);
    }

    // 悬停预览：竖线 + 目标秒数
    if (waveHover && Number.isFinite(waveHover.t)) {
      const hx = Math.max(0, Math.min(W, waveHover.xCss));
      g.strokeStyle = 'rgba(120, 190, 255, 0.95)';
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(hx + 0.5, 0);
      g.lineTo(hx + 0.5, waveH);
      g.stroke();
      g.fillStyle = 'rgba(120, 190, 255, 0.22)';
      g.fillRect(hx - 1, 0, 3, waveH);
    }
  }

  const tip = $('audio-wave-tip');
  if (tip) {
    if (waveHover && dur && Number.isFinite(waveHover.t)) {
      tip.textContent = fmtCs(waveHover.t);
      tip.classList.remove('hidden');
      const left = Math.max(8, Math.min(W - 88, waveHover.xCss - 40));
      tip.style.left = `${left}px`;
      tip.style.top = '8px';
    } else {
      tip.classList.add('hidden');
    }
  }
}

function visibleAudioItems() {
  let items = eventAudioItems();
  items = filterByFolder('audio', items);
  const q = audioSearch.trim().toLowerCase();
  if (q) items = items.filter((it) => (it.name || '').toLowerCase().includes(q) || (it.path || '').toLowerCase().includes(q));
  return items;
}

function refreshAudioDirs() {
  renderDirList($('audio-dirs'), 'audio', eventAudioItems(), () => {
    renderList();
  });
  const title = $('audio-folder-title');
  if (title) title.textContent = folderTitle('audio');
  fillAudioMoveSelect();
}

function fillAudioMoveSelect() {
  const sel = $('audio-move-folder');
  if (!sel) return;
  const folders = listFolders('audio');
  const cur = sel.value;
  sel.innerHTML = `<option value="">移入目录…</option>`
    + `<option value="${FOLDER_UNCAT}">未分类</option>`
    + folders.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('');
  if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
}

/** 只改高亮/状态，不重建整表（起播零卡顿关键） */
function paintSongActive() {
  const list = $('audio-song-list') || $('audio-list');
  if (!list) return;
  const volPct = Math.round(volume() * 100);
  const volTip = `推子 ${volPct}%（${fmtDb(volToDb(volume()))} dB）`;
  list.querySelectorAll('.audio-card, .song-row, .file-item').forEach((row) => {
    const path = row.dataset.path;
    if (!path) return;
    const on = path === currentPath;
    const sel = path === selectedSongPath || on;
    row.classList.toggle('active', sel);
    row.classList.toggle('playing', on && playing);
    const volEl = row.querySelector('.audio-card-vol');
    if (volEl) {
      volEl.textContent = `🔊 ${volPct}%`;
      volEl.title = volTip;
    }
    const loopBtn = row.querySelector('[data-act="loop"]');
    if (loopBtn) {
      const mode = getItemLoopMode(path);
      const m = loopBtnMeta(mode);
      loopBtn.textContent = m.icon;
      loopBtn.title = m.title;
      loopBtn.classList.toggle('is-one', mode === 'one');
      loopBtn.classList.toggle('is-next', mode === 'next');
      row.classList.toggle('loop-one', mode === 'one');
    }
    const vocalBtn = row.querySelector('[data-act="vocal"]');
    if (vocalBtn) {
      const on = getItemVocalCancel(path);
      const m = vocalBtnMeta(on);
      vocalBtn.textContent = m.icon;
      vocalBtn.title = m.title;
      vocalBtn.classList.toggle('is-on', on);
      row.classList.toggle('vocal-on', on);
    }
  });
  const title = $('audio-folder-title');
  if (title) title.textContent = folderTitle('audio');
  const count = $('audio-card-count');
  if (count) count.textContent = `[${visibleAudioItems().length}]`;
}

function renderList() {
  refreshAudioDirs();
  const list = $('audio-song-list') || $('audio-list');
  if (!list) return;
  const items = visibleAudioItems();
  const count = $('audio-card-count');
  if (count) count.textContent = `[${items.length}]`;
  if (!items.length) {
    list.innerHTML = `<div class="empty-tip">此目录暂无歌曲<br/><span style="font-size:12px;opacity:.75">导入音频，或切换左侧目录</span></div>`;
    return;
  }
  const volPct = Math.round(volume() * 100);
  const volTip = `推子 ${volPct}%（${fmtDb(volToDb(volume()))} dB）`;
  list.innerHTML = items.map((it) => {
    const on = it.path === currentPath;
    const sel = it.path === selectedSongPath || on;
    const dur = durationOf(it.path);
    const label = cardLabel(it);
    const mode = getItemLoopMode(it.path);
    const lm = loopBtnMeta(mode);
    const vocalOn = getItemVocalCancel(it.path);
    const vm = vocalBtnMeta(vocalOn);
    const cue = getItemCue(it.path);
    const badge = cueBadgeText(cue);
    const note = resolveItemNote(it.path);
    const tipBits = [label, badge, note, vocalOn ? '仅伴奏' : ''].filter(Boolean).join(' · ');
    return `
    <div class="audio-card ${sel ? 'active' : ''} ${on && playing ? 'playing' : ''} ${mode === 'one' ? 'loop-one' : ''} ${vocalOn ? 'vocal-on' : ''}" data-path="${esc(it.path)}" title="${esc(tipBits)}">
      <div class="audio-card-body">
        <span class="audio-card-vol" title="${esc(volTip)}">🔊 ${volPct}%</span>
        <button type="button" class="audio-card-rename" data-act="rename" title="重命名显示名">✎</button>
        <button type="button" class="audio-card-vocal ${vm.cls}" data-act="vocal" title="${esc(vm.title)}">${vm.icon}</button>
        <button type="button" class="audio-card-go ${lm.cls}" data-act="loop" title="${esc(lm.title)}">${lm.icon}</button>
        <div class="audio-card-name">${esc(label)}</div>
        ${note ? `<div class="audio-card-note" title="${esc(note)}">📝 ${esc(note)}</div>` : ''}
        ${badge ? `<div class="audio-card-cue">${esc(badge)}</div>` : ''}
        ${vocalOn ? '<div class="audio-card-vocal-badge">仅伴奏</div>' : ''}
      </div>
      <div class="audio-card-foot">
        <span class="audio-card-dur mono">${fmtHms(dur)}</span>
      </div>
    </div>`;
  }).join('');
  scheduleDurProbe(items.map((it) => it.path));
}

function currentModule() {
  return document.querySelector('.tab.active')?.dataset.module;
}

export function initAudio() {
  const meta = $('audio-meta');
  const list = $('audio-song-list') || $('audio-list');
  const cv = $('audio-wave');
  const vol = $('audio-volume');
  const btnLoop = $('audio-loop');
  const btnPush = $('audio-push-card');

  bindViewZoom('audio', { def: 176 });
  renderList();
  draw();

  // 底栏：本曲设置 / 监视器 可折叠，避免挡住波形与控件
  const LS_EXTRA = 'sp.audio.dock.extra';
  const LS_MONITOR = 'sp.audio.dock.monitor';
  const extra = $('audio-extra');
  const monitor = $('audio-monitor');
  const btnExtra = $('audio-extra-toggle');
  const btnMon = $('audio-monitor-toggle');
  function applyDockToggles() {
    const showExtra = !!lsGet(LS_EXTRA, false);
    const showMon = lsGet(LS_MONITOR, true) !== false;
    extra?.classList.toggle('hidden', !showExtra);
    monitor?.classList.toggle('is-collapsed', !showMon);
    btnExtra?.classList.toggle('is-on', showExtra);
    btnMon?.classList.toggle('is-on', showMon);
    btnExtra && (btnExtra.textContent = showExtra ? '收起设置' : '本曲设置');
    btnMon && (btnMon.textContent = showMon ? '监视器' : '显示监视器');
    // 折叠变化后重绘波形尺寸
    requestAnimationFrame(() => draw());
  }
  btnExtra?.addEventListener('click', () => {
    lsSet(LS_EXTRA, !lsGet(LS_EXTRA, false));
    applyDockToggles();
  });
  btnMon?.addEventListener('click', () => {
    const cur = lsGet(LS_MONITOR, true) !== false;
    lsSet(LS_MONITOR, !cur);
    applyDockToggles();
  });
  applyDockToggles();

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

  listen('sp-audio-ended', () => {
    playing = false;
    updatePlayBtn();
    const items = visibleAudioItems();
    if (!items.length) return;
    const idx = items.findIndex((i) => i.path === currentPath);
    const itemMode = currentPath ? getItemLoopMode(currentPath) : 'next';
    // 卡片单曲循环优先；否则跟全局 none（播完停）
    if (itemMode === 'one' && idx >= 0) return loadFile(items[idx].path, true);
    if (loopMode === 'none' && itemMode !== 'one' && (idx < 0 || idx >= items.length - 1)) {
      paintSongActive();
      return;
    }
    const next = items[(Math.max(0, idx) + 1) % items.length];
    if (next) loadFile(next.path, true);
  });

  document.addEventListener('sp:program-changed', renderList);

  let searchTimer = 0;
  $('audio-search')?.addEventListener('input', (e) => {
    audioSearch = e.target.value || '';
    // 连续输入只在停顿后重绘一次（曲库大时整表重建较重）
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderList, 120);
  });
  $('audio-dir-add')?.addEventListener('click', () => {
    const name = window.prompt('新建目录名称', '敬拜诗歌');
    if (name == null) return;
    if (addFolder('audio', name)) {
      renderList();
      toast('已创建目录');
    } else toast('目录名无效或已存在');
  });
  $('audio-dir-rename')?.addEventListener('click', () => {
    const id = getSelectedFolder('audio');
    if (id === FOLDER_ALL || id === FOLDER_UNCAT) {
      toast('请先选中一个自定义目录');
      return;
    }
    const cur = listFolders('audio').find((f) => f.id === id);
    const name = window.prompt('重命名目录', cur?.name || '');
    if (name == null) return;
    if (renameFolder('audio', id, name)) {
      renderList();
      toast('已重命名');
    }
  });
  $('audio-dir-del')?.addEventListener('click', () => {
    const id = getSelectedFolder('audio');
    if (id === FOLDER_ALL || id === FOLDER_UNCAT) {
      toast('请先选中一个自定义目录');
      return;
    }
    if (!window.confirm('删除此目录？歌曲会回到「未分类」，不会删除文件')) return;
    removeFolder('audio', id);
    renderList();
    toast('目录已删除');
  });
  $('audio-move-folder')?.addEventListener('change', (e) => {
    const fid = e.target.value;
    if (!fid) return;
    const path = selectedSongPath || currentPath;
    if (!path) {
      toast('请先选中一首歌');
      e.target.value = '';
      return;
    }
    assignPath('audio', path, fid === FOLDER_UNCAT ? null : fid);
    e.target.value = '';
    renderList();
    toast('已移动到目录');
  });

  // 切换声卡：无缝续播
  document.addEventListener('sp:audio-device-changed', async () => {
    deviceIndex = lsGet(LS_DEVICE, null);
    if (!currentPath) return;
    try {
      const st = await invoke('audio_state');
      const wasPlaying = st.playing || (st.exists && isEnginePath(st.path) && playing);
      const at = st.exists && isEnginePath(st.path) ? st.position : pos;
      cancelFade();
      fadeOutStarted = false;
      await invoke('audio_play', {
        path: currentPath,
        deviceIndex,
        startAt: at,
        vocalCancel: getItemVocalCancel(currentPath),
      });
      setEngineVol(volume());
      if (!wasPlaying) {
        await invoke('audio_pause');
        playing = false;
      } else {
        playing = true;
      }
      updatePlayBtn();
      toast('已切换音频输出设备');
    } catch (err) {
      toast('切换声卡失败：' + err);
    }
  });

  // 暂停后画面约 1 秒即收敛为静止：之后状态不变就不再每帧重算重绘
  let idleKey = '';
  let idleFrames = 0;
  function animLoop() {
    const panel = document.getElementById('panel-audio');
    if (panel && panel.classList.contains('active')) {
      const mon = $('audio-monitor');
      if (!mon?.classList.contains('is-collapsed')) {
        const box = $('audio-spec')?.parentElement;
        const key = playing ? '' : `${pos}|${engineVol}|${!!mono}|${box?.clientWidth}x${box?.clientHeight}`;
        if (playing || key !== idleKey) {
          idleKey = key;
          idleFrames = 0;
        }
        if (idleFrames < 90) {
          idleFrames++;
          analyze();
          drawSpectrum();
          drawVU();
        }
      }
    }
    requestAnimationFrame(animLoop);
  }
  requestAnimationFrame(animLoop);

  let lastReportedPlaying = null;
  let pollTick = 0;
  setInterval(async () => {
    pollTick++;
    // 暂停时进度不走：每 500ms 同步一次即可，减少 IPC
    if (currentPath && (playing || pollTick % 5 === 0)) {
      try {
        const st = await invoke('audio_state');
        if (st.exists && isEnginePath(st.path)) {
          playing = st.playing;
          if (Date.now() >= seekGuardUntil) pos = st.position;
        } else if (!st.exists && playing) {
          // 后端已结束，等 ended 事件
        }
      } catch { /* ignore */ }
    }
    const dur = waveDur || (meta.duration || 0);
    const el = $('audio-elapsed');
    const rem = $('audio-remain');
    if (el) el.textContent = fmtCs(pos);
    if (rem) rem.textContent = fmtCs(Math.max(0, dur - pos));
    // 扩展屏滚动歌词跟播放进度
    if (playing && currentPath) syncLyricsOutput();
    // 渐弱：剩余时间进入 fadeOut 窗口时自动压音量
    if (playing && currentPath && !fadeOutStarted) {
      const cue = getItemCue(currentPath);
      const dur = waveDur || (meta.duration || 0);
      if (cue.fadeOut > 0 && dur > 0) {
        const remain = dur - pos;
        if (remain <= cue.fadeOut + 0.05 && remain > 0.05) {
          fadeOutStarted = true;
          fadeTo(0, Math.min(cue.fadeOut, remain));
        }
      }
    }
    // 仅在播放态变化时刷按钮/浮条，避免每 100ms 派发事件造成卡顿
    if (playing !== lastReportedPlaying) {
      lastReportedPlaying = playing;
      updatePlayBtn();
      paintSongActive();
    }
    // 波形进度：仅音频页可见时重绘
    const panel = document.getElementById('panel-audio');
    if (panel?.classList.contains('active')) draw();
  }, 100);

  // 单击卡片即播；右上角切换 单曲循环 ↔ 自动下一首
  list?.addEventListener('click', (e) => {
    const item = e.target.closest('.audio-card, .song-row, .file-item');
    if (!item?.dataset.path) return;
    if (e.target.closest('[data-act="rename"]')) {
      renameAudioItem(item.dataset.path);
      return;
    }
    if (e.target.closest('[data-act="loop"]')) {
      toggleItemLoopMode(item.dataset.path);
      return;
    }
    if (e.target.closest('[data-act="vocal"]')) {
      toggleItemVocalCancel(item.dataset.path);
      return;
    }
    selectedSongPath = item.dataset.path;
    fillCueBar(item.dataset.path);
    if (item.dataset.path === currentPath && playing) {
      invoke('audio_pause').then(() => {
        playing = false;
        updatePlayBtn();
        paintSongActive();
      }).catch((err) => toast('暂停失败：' + err));
      return;
    }
    // skipList：先出声，不在起播前整表重渲
    loadFile(item.dataset.path, true, { skipList: true });
  });

  $('audio-play').addEventListener('click', () => toggleAudio());
  $('audio-prev').addEventListener('click', () => step(-1));
  $('audio-next').addEventListener('click', () => step(1));

  // 波形：悬停显示秒数；左键点/拖快速跳进度（绑在 wrap 上，避免浮层挡点击）
  const waveWrap = $('audio-wave-wrap') || cv.parentElement;
  let waveDragging = false;
  let waveSeekTimer = null;
  let waveSeekPending = null;
  let waveSeekBusy = false;

  function wavePosFromEvent(e) {
    const dur = waveDur || (meta.duration || 0);
    if (!dur || !currentPath) return null;
    const el = waveWrap || cv;
    const r = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width, e.clientX - r.left));
    return { xCss: x, t: (x / Math.max(1, r.width)) * dur, dur };
  }

  function setWaveHover(info) {
    waveHover = info ? { xCss: info.xCss, t: info.t } : null;
    draw();
  }

  let lastWaveSeekT = null;
  async function applyWaveSeek(t) {
    if (t == null || !currentPath || waveSeekBusy) return;
    // 同一次点击/拖动里重复同点不二次 IPC
    if (lastWaveSeekT != null && Math.abs(lastWaveSeekT - t) < 0.04) return;
    waveSeekBusy = true;
    lastWaveSeekT = t;
    pos = t;
    seekGuardUntil = Date.now() + 600;
    fadeOutStarted = false;
    cancelFade();
    draw();
    try {
      // 直接 seek，少一次 audio_state 往返
      await invoke('audio_seek', { t });
      pos = t;
      seekGuardUntil = Date.now() + 350;
      draw();
    } catch (err) {
      try {
        const wasPlaying = playing;
        await startPlayback(t, { noFade: true, skipList: true });
        if (!wasPlaying) {
          await invoke('audio_pause');
          playing = false;
          updatePlayBtn();
        }
        pos = t;
        seekGuardUntil = Date.now() + 350;
        draw();
      } catch (err2) {
        console.warn('audio seek', err2 || err);
        toast('跳转未成功，可再点一次波形');
      }
    } finally {
      waveSeekBusy = false;
    }
  }

  function scheduleWaveSeek(t) {
    waveSeekPending = t;
    pos = t;
    seekGuardUntil = Date.now() + 400;
    draw();
    if (waveSeekTimer) return;
    waveSeekTimer = setTimeout(async () => {
      waveSeekTimer = null;
      const next = waveSeekPending;
      waveSeekPending = null;
      if (next != null) await applyWaveSeek(next);
    }, 60);
  }

  const onWaveMove = (e) => {
    const info = wavePosFromEvent(e);
    if (!info) {
      if (waveHover) setWaveHover(null);
      return;
    }
    setWaveHover(info);
    if (waveDragging) scheduleWaveSeek(info.t);
  };
  const onWaveLeave = () => {
    if (!waveDragging) setWaveHover(null);
  };
  const onWaveDown = async (e) => {
    if (e.button != null && e.button !== 0) return;
    const info = wavePosFromEvent(e);
    if (!info) return;
    e.preventDefault();
    e.stopPropagation();
    waveDragging = true;
    setWaveHover(info);
    try { (waveWrap || cv).setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
    if (waveSeekTimer) {
      clearTimeout(waveSeekTimer);
      waveSeekTimer = null;
    }
    waveSeekPending = null;
    await applyWaveSeek(info.t);
  };
  const endWaveDrag = async (e) => {
    if (!waveDragging) return;
    waveDragging = false;
    try { (waveWrap || cv).releasePointerCapture?.(e.pointerId); } catch { /* ignore */ }
    if (waveSeekTimer) {
      clearTimeout(waveSeekTimer);
      waveSeekTimer = null;
    }
    const info = wavePosFromEvent(e);
    const t = info?.t ?? waveSeekPending;
    waveSeekPending = null;
    // 仅在拖动过程中有待跳位置、或终点与上次差较大时再跳，避免单击抬起二次 seek
    if (t != null && (lastWaveSeekT == null || Math.abs(lastWaveSeekT - t) >= 0.04)) {
      await applyWaveSeek(t);
    }
    lastWaveSeekT = null;
    if (info) setWaveHover(info);
    else setWaveHover(null);
  };

  const waveTarget = waveWrap || cv;
  waveTarget.addEventListener('pointermove', onWaveMove);
  waveTarget.addEventListener('pointerleave', onWaveLeave);
  waveTarget.addEventListener('pointerdown', onWaveDown);
  waveTarget.addEventListener('pointerup', endWaveDrag);
  waveTarget.addEventListener('pointercancel', endWaveDrag);

  meta.addEventListener('loadedmetadata', () => updateTech());
  // 推子：百分比 + dB 同步，并记住上次音量（开场前调好即可）
  const LS_VOL = 'sp.audio.volume';
  const savedVol = lsGet(LS_VOL, null);
  if (vol && savedVol != null && Number.isFinite(+savedVol)) {
    vol.value = Math.max(0, Math.min(1, +savedVol));
  }
  engineVol = volume();
  syncVolReadout();
  vol?.addEventListener('input', () => {
    cancelFade();
    setEngineVol(+vol.value);
    lsSet(LS_VOL, +vol.value);
    paintSongActive();
  });
  $('audio-vol-unity')?.addEventListener('click', () => {
    if (!vol) return;
    cancelFade();
    vol.value = '1';
    setEngineVol(1);
    lsSet(LS_VOL, 1);
    paintSongActive();
    toast('音量 100%（0 dB）');
  });
  $('audio-clip')?.addEventListener('click', () => {
    vuClip = false;
    vuPeakHoldDb = vuPeakDb;
    syncMeterReadout();
  });

  $('audio-cue-apply')?.addEventListener('click', () => saveCueFromBar());
  $('audio-note-save')?.addEventListener('click', () => saveAudioNote());
  $('audio-note')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveAudioNote();
    }
  });
  ['audio-start-min', 'audio-start-sec', 'audio-fade-in', 'audio-fade-out'].forEach((id) => {
    $(id)?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveCueFromBar();
    });
  });
  fillCueBar(currentPath);

  btnLoop.addEventListener('click', () => {
    cycleLoopMode();
  });

  btnPush.addEventListener('click', () => {
    if (currentPath) pushCard().catch(() => {});
    else toast('请先选择音频');
  });

  document.addEventListener('sp:import-audio', async () => {
    const files = await pickFiles([{ name: '音频', extensions: AUDIO_EXT }], '导入音频');
    if (!files.length) return;
    const ok = updateEvent((ev) => {
      for (const f of files) {
        if (ev.items.some((i) => i.type === 'audio' && i.path === f)) continue;
        ev.items.push({ id: genId(), type: 'audio', path: f, name: fileName(f).replace(/\.[^.]+$/, '') });
      }
    });
    if (!ok) return;
    renderList();
    toast(`已添加 ${files.length} 个音频到「${currentEvent()?.name || ''}」`);
    if (!currentPath) {
      const first = eventAudioItems()[0];
      if (first) loadFile(first.path, false);
    }
  });

  document.addEventListener('sp:clear-list', () => {
    if (currentModule() !== 'audio') return;
    updateEvent((ev) => {
      ev.items = ev.items.filter((i) => i.type !== 'audio');
    });
    invoke('audio_stop');
    currentPath = null;
    playPath = null;
    playing = false;
    pos = 0;
    peaks = null;
    waveDur = 0;
    $('audio-title').textContent = '未选择音频';
    updatePlayBtn();
    renderList();
    pushToOutput({ kind: 'clear' });
  });

  window.addEventListener('resize', () => { draw(); drawSpectrum(); drawVU(); });
}

/** 节目单/外部调用；opts.stay=true 时不切换 Tab，并优先出声 */
export async function playByPath(path, opts = {}) {
  if (!opts.stay) {
    document.dispatchEvent(new CustomEvent('sp:switch-module', { detail: 'audio' }));
  }
  pendingOutputSeq = opts.outputSeq != null ? opts.outputSeq : null;
  await loadFile(path, true, {
    stay: !!opts.stay,
    skipList: !!opts.stay,
    pushOutput: opts.pushOutput,
  });
}

/** 完全停止后台音乐（漂浮条「关闭」） */
export async function stopAudio() {
  cancelFade();
  fadeOutStarted = false;
  try {
    await invoke('audio_stop');
  } catch { /* ignore */ }
  playing = false;
  pos = 0;
  updatePlayBtn();
  if (currentModule() === 'audio') renderList();
}

/** 节目单进度条用 */
export function getAudioSnapshot() {
  const meta = $('audio-meta');
  const duration = waveDur || +(meta?.duration) || 0;
  return {
    path: currentPath,
    name: currentName,
    playing,
    pos,
    duration,
    loopMode,
  };
}

export async function seekAudio(t) {
  if (!currentPath || !Number.isFinite(t)) return;
  const dur = waveDur || +($('audio-meta')?.duration) || 0;
  const target = Math.max(0, dur ? Math.min(t, dur) : t);
  pos = target;
  fadeOutStarted = false;
  cancelFade();
  try {
    const st = await invoke('audio_state');
    if (st.exists && isEnginePath(st.path)) {
      await invoke('audio_seek', { t: target });
      setEngineVol(volume());
    } else {
      await startPlayback(target, { noFade: true, skipList: true });
    }
  } catch (err) {
    console.warn('seekAudio', err);
    try {
      await startPlayback(target, { noFade: true, skipList: true });
      setEngineVol(volume());
    } catch (err2) {
      toast('跳转未成功，可再试一次');
      console.warn('seekAudio fallback', err2);
    }
  }
}

export function cycleLoopMode() {
  loopMode = loopMode === 'all' ? 'one' : loopMode === 'one' ? 'none' : 'all';
  const label = getLoopModeLabel();
  const btnLoop = $('audio-loop');
  if (btnLoop) btnLoop.textContent = label;
  const pgLoop = $('pg-audio-loop');
  if (pgLoop) {
    pgLoop.textContent = label;
    pgLoop.dataset.mode = loopMode;
  }
  return loopMode;
}

export function getLoopModeLabel() {
  return { all: '列表循环', one: '单曲循环', none: '顺序播放' }[loopMode] || '顺序播放';
}
