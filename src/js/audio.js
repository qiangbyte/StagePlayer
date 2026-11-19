// 音频模块：波形 / 频谱 / LED 计时 + 活动目录绑定

import { pickFiles, esc, fileName, lsGet, lsGetCached, lsSet, invoke, listen, toast, AUDIO_EXT } from './util.js';
import {
  bindMetersHost, analyze, drawSpectrum, drawVU, resetMeters, resetClip, meterReadings,
} from './audio-meters.js';
import { decodeWaveNative, decodeWaveWeb } from './audio-wave.js';
import { pushUndo } from './undo.js';
import {
  initStemProgressUi, showStemProgressPanel, hideStemProgressPanel,
} from './audio-stem-ui.js';
import { pushToOutput, clearOutput, getCurrentOutput, currentOutputSeq } from './output-main.js';
import { loadLyricsFor, activeLyricIndex } from './lyrics.js';
import {
  renderDirList, filterByFolder, folderTitle, addFolder, renameFolder, removeFolder,
  assignPath, listFolders, getSelectedFolder, getLib, folderOfPath, FOLDER_ALL, FOLDER_UNCAT,
  getDisplayName, setDisplayName, promptRenameMedia, bindViewZoom, getViewSize, setViewSize,
  getMediaNote, setMediaNote,
} from './media-library.js';

let pendingOutputSeq = null;
let audioSearch = '';
let selectedSongPath = null;

const LS_DEVICE = 'sp.audio.device';
const LS_DEVICE_NAME = 'sp.audio.deviceName';

let currentPath = null;
/** 引擎实际在播的文件（仅伴奏时为 AI 缓存伴奏 wav） */
let playPath = null;
/** 源路径 → AI 伴奏缓存路径 */
const instrumentalBySource = Object.create(null);
let playing = false;
/** 声卡按名称选（旧设置只有序号时兼容传序号）；找不到时后端回落系统默认 */
function deviceArgs() {
  const name = lsGet(LS_DEVICE_NAME, null);
  if (name) return { deviceName: name, deviceIndex: null };
  const idx = lsGet(LS_DEVICE, null);
  return { deviceName: null, deviceIndex: idx == null ? null : +idx };
}
const LS_LOOP = 'sp.audio.loopMode';
let loopMode = ['all', 'one', 'none'].includes(lsGet(LS_LOOP, 'all')) ? lsGet(LS_LOOP, 'all') : 'all';
/** 文件已不在磁盘上的歌（卡片标红；自动续播时跳过） */
const missingPaths = new Set();
/** 当前曲的频谱用单声道数据：长期缓存不存它，单独留一份，重播 / 单曲循环时电平表不至于不动 */
let monoSlot = null;

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

/**
 * 音乐页自己的曲库，与节目单分开：音乐页导入只进曲库，节目单导入只进节目单。
 * 单曲设置（起播点 / 渐变 / 循环 / 伴奏 / 备注）各存各的
 */
const LS_LIB = 'sp.audio.library';
/** 全局默认推子（未设本曲音量的歌都用它；本曲预设绝不能写回这里） */
const LS_VOL = 'sp.audio.volume';
/** 当前这首由谁起播：节目单起播时，单曲设置与播完续播都按节目单 */
let playSource = 'library';

function withName(items) {
  return items.map((it) => ({
    ...it,
    name: it.name || getDisplayName(it.path, fileName(it.path).replace(/\.[^.]+$/, '')),
  }));
}

function programAudioItems() {
  const ev = currentEvent();
  return ev ? ev.items.filter((i) => i.type === 'audio') : [];
}

function libraryRaw() {
  const v = lsGetCached(LS_LIB, []);
  return Array.isArray(v) ? v : [];
}

/** 音乐页显示的歌曲 */
function eventAudioItems() {
  return withName(libraryRaw());
}

/** 这首歌的设置存在哪：节目单正在播的那首 → 节目单；否则曲库优先 */
function itemOwner(path) {
  const inProgram = programAudioItems().some((i) => i.path === path);
  if (playSource === 'program' && path === currentPath && inProgram) return 'program';
  if (libraryRaw().some((i) => i.path === path)) return 'library';
  return inProgram ? 'program' : 'library';
}

function libraryItemByPath(path) {
  return libraryRaw().find((i) => i.path === path) || null;
}

function findItem(path) {
  const owner = itemOwner(path);
  const primary = (owner === 'program' ? programAudioItems() : libraryRaw()).find((i) => i.path === path);
  if (owner !== 'program') return primary || null;
  // 节目单条目缺起播/渐变/循环/伴奏时，回落到曲库同路径设置
  const lib = libraryItemByPath(path);
  if (!primary) return lib;
  if (!lib) return primary;
  return {
    ...lib,
    ...primary,
    note: (primary.note || '').trim() || lib.note || '',
    startAt: primary.startAt != null ? primary.startAt : lib.startAt,
    fadeIn: primary.fadeIn != null ? primary.fadeIn : lib.fadeIn,
    fadeOut: primary.fadeOut != null ? primary.fadeOut : lib.fadeOut,
    volume: primary.volume != null ? primary.volume : lib.volume,
    loop: primary.loop || lib.loop,
    vocalCancel: primary.vocalCancel != null ? primary.vocalCancel : lib.vocalCancel,
  };
}

/** 改单曲设置：写回它所在的曲库或节目单 */
function updateItem(path, fn) {
  if (itemOwner(path) === 'program') {
    return updateEvent((ev) => {
      for (const item of ev.items) if (item.type === 'audio' && item.path === path) fn(item);
    });
  }
  return updateLibrary((items) => {
    for (const item of items) if (item.path === path) fn(item);
  });
}

function updateLibrary(fn) {
  const items = libraryRaw().map((i) => ({ ...i }));
  fn(items);
  return lsSet(LS_LIB, items);
}

/** 旧版音乐页直接显示节目单里的歌：首次升级时把它们复制进曲库，列表不至于变空 */
function migrateLibrary() {
  if (lsGet(LS_LIB, null) != null) return;
  const seen = new Set();
  const items = [];
  for (const ev of lsGet('sp.program.events', [])) {
    for (const it of ev.items || []) {
      if (it.type !== 'audio' || !it.path || seen.has(it.path)) continue;
      seen.add(it.path);
      items.push({ ...it, id: genId() });
    }
  }
  lsSet(LS_LIB, items);
}

function resolveItemName(path) {
  const it = findItem(path);
  return it?.name || getDisplayName(path, fileName(path).replace(/\.[^.]+$/, ''));
}

function renameAudioItem(path) {
  if (!path) return;
  const n = promptRenameMedia(path, resolveItemName(path));
  if (n == null) return;
  if (n === false) return toast('名称不能为空');
  updateItem(path, (item) => {
    item.name = n;
  });
  if (currentPath === path) {
    currentName = n;
    const titleEl = $('audio-title');
    if (titleEl) titleEl.textContent = n;
  }
  renderList();
  toast('已重命名');
}

/** 从音乐库移除一首（节目单里的同一首不受影响，电脑上的文件也不删） */
function removeAudioItem(path) {
  if (!path) return;
  const name = resolveItemName(path);
  const snap = libraryRaw().map((i) => ({ ...i }));
  updateLibrary((items) => {
    for (let i = items.length - 1; i >= 0; i--) if (items[i].path === path) items.splice(i, 1);
  });
  if (selectedSongPath === path) selectedSongPath = null;
  // 正在放的就是这首（音乐页起播的）：停下
  if (path === currentPath && playSource === 'library') {
    stopAudio();
    currentPath = null;
    playPath = null;
    $('audio-title').textContent = '未选择音频';
    fillCueBar(null);
  }
  renderList();
  pushUndo(`移除「${name}」`, () => restoreLibrary(snap));
}

/**
 * 撤销移除：只把快照里、当前曲库没有的歌放回原位置附近；
 * 删除之后新导入或改过的歌保持不动（不整表回滚）
 */
function restoreLibrary(snap) {
  updateLibrary((items) => {
    snap.forEach((it, k) => {
      if (items.some((i) => i.path === it.path)) return;
      const prev = k > 0 ? items.findIndex((i) => i.path === snap[k - 1].path) : -1;
      items.splice(prev + 1, 0, { ...it });
    });
  });
  renderList();
}

/** 收集音频打包所需设置（换机导入后恢复） */
function collectAudioPackSettings() {
  const paths = new Set(libraryRaw().map((i) => i.path).filter(Boolean));
  const allLabels = lsGet('sp.media.labels', {}) || {};
  const allNotes = lsGet('sp.media.notes', {}) || {};
  const labels = {};
  const notes = {};
  for (const p of paths) {
    if (allLabels[p] != null) labels[p] = allLabels[p];
    if (allNotes[p] != null) notes[p] = allNotes[p];
  }
  return {
    volume: Number(lsGet(LS_VOL, 0.9)) || 0.9,
    loopMode,
    deviceName: lsGet(LS_DEVICE_NAME, null),
    dockExtra: !!lsGet('sp.audio.dock.extra', false),
    dockMonitor: lsGet('sp.audio.dock.monitor', true) !== false,
    uiAudioSize: getViewSize('audio', 176),
    lib: getLib('audio'),
    labels,
    notes,
  };
}

async function exportAudioPack() {
  const items = libraryRaw();
  if (!items.length) return toast('曲库是空的，先导入几首歌');
  if (!window.confirm(`打包导出当前音乐库（${items.length} 首）及设置？\n换电脑后可用「打包导入」恢复。`)) return;
  const withStems = window.confirm('是否一并打包已缓存的「仅伴奏」音轨？\n（体积更大，换机可免再分离）');

  const dest = await invoke('pick_save_path', {
    defaultName: `演出音频库_${new Date().toISOString().slice(0, 10)}.spaudio`,
    extensions: ['spaudio'],
  });
  if (!dest) return;

  const library = items.map((it) => ({
    ...it,
    folderId: folderOfPath('audio', it.path) || null,
    note: (it.note || getMediaNote(it.path) || '').trim() || undefined,
    name: it.name || getDisplayName(it.path, fileName(it.path).replace(/\.[^.]+$/, '')),
  }));

  toast('正在打包，请稍候…');
  try {
    const msg = await invoke('audio_pack_export', {
      req: {
        dest,
        library,
        settings: collectAudioPackSettings(),
        includeStems: withStems,
      },
    });
    toast(msg || '打包完成');
  } catch (err) {
    toast('打包失败：' + (err?.message || err));
  } finally {
    restorePackTitle();
  }
}

async function importAudioPack() {
  const files = await pickFiles(
    [{ name: '音频打包', extensions: ['spaudio', 'zip'] }],
    '导入音频打包'
  );
  if (!files?.length) return;
  const src = files[0];
  if (!window.confirm('导入音频打包？\n将恢复曲库、目录、备注、起播/渐变等设置。')) return;
  const replace = window.confirm(
    '是否清空当前音乐库再导入？\n\n确定 = 清空后替换\n取消 = 合并进现有曲库'
  );

  toast('正在导入…');
  try {
    const res = await invoke('audio_pack_import', { path: src });
    const incoming = Array.isArray(res?.library) ? res.library : [];
    if (!incoming.length) return toast(res?.message || '包里没有可用音频');

    const snap = libraryRaw().map((i) => ({ ...i }));
    const snapLib = JSON.parse(JSON.stringify(getLib('audio')));
    updateLibrary((items) => {
      if (replace) items.length = 0;
      for (const it of incoming) {
        const row = { ...it, id: it.id || genId(), type: 'audio' };
        const idx = items.findIndex((x) => x.path === row.path);
        if (idx >= 0) items[idx] = { ...items[idx], ...row };
        else items.push(row);
      }
    });
    pushUndo(replace ? '替换音乐库（打包导入）' : '合并音乐库（打包导入）', () => {
      updateLibrary((items) => {
        items.length = 0;
        for (const it of snap) items.push(it);
      });
      lsSet('sp.lib.audio', snapLib);
      renderList();
    });

    applyAudioPackSettings(res.settings || {}, incoming, { replace });
    renderList();
    toast(res.message || `已导入 ${res.imported || incoming.length} 首`);
    if (!currentPath && incoming[0]?.path) {
      loadFile(incoming[0].path, false).catch(() => {});
    }
  } catch (err) {
    toast('导入失败：' + (err?.message || err));
  } finally {
    restorePackTitle();
  }
}

function restorePackTitle() {
  const tip = $('list-title');
  if (tip?.dataset?.packMsg) {
    tip.textContent = tip.dataset.packMsg;
    delete tip.dataset.packMsg;
  }
}

/** 导入后恢复设置；目录按 folderId 挂回 */
function applyAudioPackSettings(settings, items, opts = {}) {
  if (!settings || typeof settings !== 'object') return;
  const replace = !!opts.replace;
  const pathMap = settings.pathMap || {};

  if (settings.volume != null) {
    const v = Math.max(0, Math.min(1, Number(settings.volume) || 0.9));
    lsSet(LS_VOL, v);
    const vol = $('audio-volume');
    if (vol) vol.value = String(v);
    if (!playing) setEngineVol(v);
  }
  if (['all', 'one', 'none'].includes(settings.loopMode)) {
    loopMode = settings.loopMode;
    lsSet(LS_LOOP, loopMode);
    paintLoopMode();
  }
  if (settings.deviceName) {
    lsSet(LS_DEVICE_NAME, settings.deviceName);
  }
  if (settings.dockExtra != null) lsSet('sp.audio.dock.extra', !!settings.dockExtra);
  if (settings.dockMonitor != null) lsSet('sp.audio.dock.monitor', !!settings.dockMonitor);
  if (settings.uiAudioSize != null) setViewSize('audio', settings.uiAudioSize, 176);
  // 刷新底栏折叠状态
  const extra = $('audio-extra');
  const monitor = $('audio-monitor');
  const btnExtra = $('audio-extra-toggle');
  const btnMon = $('audio-monitor-toggle');
  const showExtra = !!lsGet('sp.audio.dock.extra', false);
  const showMon = lsGet('sp.audio.dock.monitor', true) !== false;
  extra?.classList.toggle('hidden', !showExtra);
  monitor?.classList.toggle('is-collapsed', !showMon);
  btnExtra?.classList.toggle('is-on', showExtra);
  btnMon?.classList.toggle('is-on', showMon);

  // 目录结构：替换时整库覆盖；合并时补文件夹并按 folderId 挂回
  const libIn = settings.lib;
  if (libIn && Array.isArray(libIn.folders)) {
    const cur = replace ? { folders: [], assign: {}, selected: FOLDER_ALL } : getLib('audio');
    const folders = (cur.folders || []).map((f) => ({ ...f }));
    for (const f of libIn.folders) {
      if (!f?.id) continue;
      if (!folders.some((x) => x.id === f.id)) folders.push({ ...f });
    }
    const assign = { ...(cur.assign || {}) };
    if (replace) {
      for (const k of Object.keys(assign)) delete assign[k];
    }
    for (const it of items) {
      const fid = it.folderId;
      if (fid && folders.some((f) => f.id === fid)) assign[it.path] = fid;
    }
    lsSet('sp.lib.audio', {
      folders,
      assign,
      selected: replace ? (libIn.selected || FOLDER_ALL) : (cur.selected || FOLDER_ALL),
    });
  } else {
    for (const it of items) {
      if (it.folderId) assignPath('audio', it.path, it.folderId);
    }
  }

  // 显示名 / 备注：按 pathMap 从原路径映射到新路径
  const labels = settings.labels || {};
  const notes = settings.notes || {};
  for (const [oldKey, newPath] of Object.entries(pathMap)) {
    const np = typeof newPath === 'string' ? newPath : '';
    if (!np) continue;
    if (labels[oldKey] != null) setDisplayName(np, labels[oldKey]);
    if (notes[oldKey] != null) setMediaNote(np, notes[oldKey]);
  }
  for (const it of items) {
    if (it.name) setDisplayName(it.path, it.name);
    if (it.note) setMediaNote(it.path, it.note);
  }

  // 声卡按名称匹配（换机序号会变）
  if (settings.deviceName) {
    invoke('list_audio_output_devices')
      .then((list) => {
        const hit = (list || []).find((d) => d?.name === settings.deviceName);
        if (hit && hit.index != null) lsSet(LS_DEVICE, hit.index);
      })
      .catch(() => {});
  }
}

/** 卡片上的本曲循环：只读本曲字段，不跟底部全局（避免一点全变） */
function getItemLoopMode(path) {
  const it = findItem(path);
  return it?.loop === 'one' ? 'one' : 'next';
}

/** 播完时是否重播本曲：本曲 one 优先；未设为 next 时才看底部「单曲循环」 */
function shouldRepeatCurrent(path) {
  const it = findItem(path);
  if (it?.loop === 'one') return true;
  if (it?.loop === 'next') return false;
  return loopMode === 'one';
}

function loopBtnMeta(mode) {
  if (mode === 'one') {
    return { icon: '🔂', title: '仅本曲循环中 · 再点改为播完下一首', cls: 'is-one' };
  }
  return { icon: '⏭', title: '本曲播完下一首 · 再点改为仅本曲循环', cls: 'is-next' };
}

/** 本曲是否开启仅伴奏（AI 伴奏轨） */
function getItemVocalCancel(path) {
  const it = findItem(path);
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
  engineVol = volume();
  // 暂停中切换：直接以暂停状态打开，不漏出一小段声音
  await invoke('audio_play', {
    path: filePath,
    ...deviceArgs(),
    startAt: at > 0.05 ? at : null,
    vocalCancel: false,
    volume: engineVol,
    paused: !wasPlaying,
  });
  syncVolReadout();
  pos = at;
  playing = !!wasPlaying;
  updatePlayBtn();
  paintSongActive();
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

  const ok = updateItem(path, (item) => {
    item.vocalCancel = next;
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
  const ok = updateItem(path, (item) => {
    item.loop = next;
  });
  if (!ok) return toast('无法保存本曲循环');
  // 只改这一首，不动底部「列表循环 / 单曲循环 / 顺序播放」
  paintSongActive();
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
  const name = cardLabel(findItem(path) || { path }) || '本曲';
  toast(next === 'one' ? `「${name}」仅本曲循环` : `「${name}」播完下一首`);
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
  const m = meterReadings();
  if (rmsEl) rmsEl.textContent = fmtDb(m.rmsDb) + ' dB';
  if (peakEl) peakEl.textContent = fmtDb(m.peakHoldDb) + ' dB';
  if (clipEl) clipEl.classList.toggle('hidden', !m.clip);
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

/** @returns {{ startAt:number, fadeIn:number, fadeOut:number, volume:number|null }} */
function getItemCue(path) {
  const it = findItem(path) || {};
  const startAt = Math.max(0, Number(it.startAt) || 0);
  const fadeIn = Math.max(0, Math.min(60, Number(it.fadeIn) || 0));
  const fadeOut = Math.max(0, Math.min(60, Number(it.fadeOut) || 0));
  return { startAt, fadeIn, fadeOut, volume: getItemVolume(path) };
}

/** 本曲预设音量 0–1；未设置返回 null（用全局默认推子） */
function getItemVolume(path) {
  if (!path) return null;
  const it = findItem(path);
  if (!it || it.volume == null || it.volume === '') return null;
  const v = Number(it.volume);
  if (!Number.isFinite(v)) return null;
  return Math.max(0, Math.min(1, v));
}

function globalDefaultVolume() {
  const n = Number(lsGet(LS_VOL, 0.9));
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.9;
}

function setGlobalDefaultVolume(v) {
  lsSet(LS_VOL, Math.max(0, Math.min(1, Number(v) || 0)));
}

/**
 * 按歌曲切换推子显示/引擎音量：
 * - 有本曲预设 → 只用预设（不写全局）
 * - 无预设 → 恢复全局默认
 */
function applySongVolumeToFader(path, { writeEngine = true } = {}) {
  const vol = $('audio-volume');
  if (!vol) return false;
  const preset = path ? getItemVolume(path) : null;
  const target = preset != null ? preset : globalDefaultVolume();
  vol.value = String(target);
  if (writeEngine) {
    cancelFade();
    setEngineVol(target);
  }
  syncVolReadout();
  return true;
}

/** 清除本曲音量预设，推子回到全局默认 */
function resetItemVolume(path) {
  if (!path) return toast('请先选中一首歌');
  const ok = updateItem(path, (item) => {
    delete item.volume;
  });
  if (!ok) return toast('重置失败');
  fillCueBar(path);
  applySongVolumeToFader(path);
  renderList();
  toast(`已清除本曲音量 · 恢复默认 ${Math.round(globalDefaultVolume() * 100)}%`);
}

/** 卡片角标：有预设显示百分比；无预设固定显示「默认」，绝不跟当前推子跑 */
function cardVolLabel(path) {
  const preset = getItemVolume(path);
  if (preset != null) {
    const pct = Math.round(preset * 100);
    return {
      text: `🔊 ${pct}%`,
      title: `本曲预设 ${pct}%`,
      preset: true,
    };
  }
  const defPct = Math.round(globalDefaultVolume() * 100);
  return {
    text: '🔊 默认',
    title: `未设本曲音量 · 开播用全局默认 ${defPct}%`,
    preset: false,
  };
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
  if (cue.volume != null) bits.push(`音量${Math.round(cue.volume * 100)}%`);
  return bits.join(' · ');
}

function resolveItemNote(path) {
  if (!path) return '';
  const it = findItem(path);
  const fromItem = (it?.note || '').trim();
  if (fromItem) return fromItem;
  return getMediaNote(path).trim();
}

function fillCueBar(path) {
  const cue = path ? getItemCue(path) : { startAt: 0, fadeIn: 0, fadeOut: 0, volume: null };
  const minEl = $('audio-start-min');
  const secEl = $('audio-start-sec');
  const inEl = $('audio-fade-in');
  const outEl = $('audio-fade-out');
  const volEl = $('audio-item-vol');
  if (minEl) minEl.value = String(Math.floor(cue.startAt / 60));
  if (secEl) secEl.value = String(Math.floor(cue.startAt % 60));
  if (inEl) inEl.value = String(cue.fadeIn || 0);
  if (outEl) outEl.value = String(cue.fadeOut || 0);
  if (volEl) volEl.value = cue.volume != null ? String(Math.round(cue.volume * 100)) : '';
  const tip = $('audio-cue-tip');
  if (tip) tip.textContent = path ? (cueBadgeText(cue) || '未设置起播/渐变/音量') : '先选一首歌';
  const noteEl = $('audio-note');
  if (noteEl) noteEl.value = path ? resolveItemNote(path) : '';
}

function saveAudioNote() {
  const path = selectedSongPath || currentPath;
  if (!path) return toast('请先选中一首歌');
  const note = ($('audio-note')?.value || '').trim();
  setMediaNote(path, note);
  const ok = updateItem(path, (item) => {
    item.note = note;
  });
  // 同步到节目单里同路径音频条目，便于现场播控直接看到
  try {
    document.dispatchEvent(new CustomEvent('sp:media-note-changed', {
      detail: { path, note, type: 'audio' },
    }));
  } catch { /* ignore */ }
  if (!ok) return toast('备注未能写入曲库，已存本地');
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
  const volRaw = ($('audio-item-vol')?.value ?? '').toString().trim();
  let volume = null;
  if (volRaw !== '') {
    const pct = Number(volRaw);
    if (Number.isFinite(pct)) volume = Math.max(0, Math.min(1, pct / 100));
  }
  const ok = updateItem(path, (item) => {
    item.startAt = startAt;
    item.fadeIn = fadeIn;
    item.fadeOut = fadeOut;
    if (volume == null) delete item.volume;
    else item.volume = volume;
  });
  if (!ok) return toast('保存失败');
  fillCueBar(path);
  // 正在看/播这首 → 立刻切到本曲预设或全局默认（不污染其它歌）
  if (path === currentPath || path === selectedSongPath) {
    applySongVolumeToFader(path);
  }
  renderList();
  const parts = [];
  if (startAt > 0) parts.push(`从 ${min}:${String(sec).padStart(2, '0')} 起播`);
  if (fadeIn > 0) parts.push(`渐起 ${fadeIn}s`);
  if (fadeOut > 0) parts.push(`渐弱 ${fadeOut}s`);
  if (volume != null) parts.push(`本曲音量 ${Math.round(volume * 100)}%`);
  else parts.push('音量用全局默认');
  toast(parts.length ? `已保存：${parts.join(' · ')}` : '已清除本曲设置');
}

async function startPlayback(startAt = 0, opts = {}) {
  if (!currentPath) return;
  const cue = getItemCue(currentPath);
  // 显式传入优先；否则用本曲设置的起播点
  const at = Number.isFinite(startAt) && startAt > 0 ? startAt : (cue.startAt || 0);
  fadeOutStarted = false;
  cancelFade();
  // 起播期间引擎里还是旧歌：先不认它，旧歌此时报的「播完」一律忽略
  playPath = null;

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
  if (
    getItemVocalCancel(currentPath)
    && playPath === currentPath
    && !instrumentalBySource[currentPath]
  ) {
    const tip = $('audio-cue-tip');
    if (tip) tip.textContent = '仅伴奏未就绪 · 先播原唱，可点卡片「仅伴奏」生成';
  }

  // audio_play 本身会换曲，无需先 stop（少一次 IPC）；起播音量随命令一起给，
  // 渐起时从 0 开始，不会先按旧音量响一下
  // 有本曲预设用预设；否则用全局默认（切歌时恢复，避免上一首预设粘住）
  applySongVolumeToFader(currentPath, { writeEngine: false });
  const target = cue.volume != null ? cue.volume : globalDefaultVolume();
  const withFade = cue.fadeIn > 0 && !opts.noFade;
  await invoke('audio_play', {
    path: playPath,
    ...deviceArgs(),
    startAt: at > 0 ? at : null,
    vocalCancel: false,
    volume: withFade ? 0 : target,
    paused: !!opts.paused,
  });
  missingPaths.delete(currentPath);
  pos = at;
  if (withFade) {
    engineVol = 0;
    syncVolReadout();
    fadeTo(target, cue.fadeIn);
  } else {
    engineVol = target;
    syncVolReadout();
  }
  playing = !opts.paused;
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
    if (first) return loadFile(first.path, true, { skipList: true }).catch(() => {});
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
  // 按下播放那一刻的输出世代：出声要等 IPC，期间按了黑屏/切走则标题卡不再推送
  const outSeq = pendingOutputSeq ?? currentOutputSeq();
  // 新歌打不开时用来回到原来那首（后端会让它继续放）
  const prev = { currentPath, playPath, playSource, currentName, selectedSongPath };

  playSource = opts.source || (stay ? 'program' : 'library');
  currentPath = path;
  pos = 0;
  resetMeters();
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
        if (pushOutput) pushCard(outSeq).catch(() => {});
        paintSongActive();
      })
      .catch(async (err) => {
        const msg = errText(err);
        if (/文件不存在/.test(msg)) {
          missingPaths.add(path);
          paintMissing();
        }
        const restored = await restoreAfterFailedLoad(path, prev);
        if (!restored && currentPath === path) {
          playing = false;
          updatePlayBtn();
          paintSongActive();
        }
        if (!opts.quietError) {
          toast(`无法播放：${msg}${restored ? '（原来的歌继续播放）' : ''}`, 6000);
        }
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

function errText(err) {
  return String(err?.message || err || '未知错误');
}

/**
 * 新歌没打开（文件丢失 / 格式不支持）：后端没动原来那首。
 * 若它还在引擎里，界面回到那首，别显示成「停了」
 */
async function restoreAfterFailedLoad(failedPath, prev) {
  if (!prev?.playPath || currentPath !== failedPath) return false;
  let st = null;
  try { st = await invoke('audio_state'); } catch { return false; }
  if (!st?.exists || st.path !== prev.playPath || currentPath !== failedPath) return false;
  currentPath = prev.currentPath;
  playPath = prev.playPath;
  playSource = prev.playSource;
  currentName = prev.currentName;
  selectedSongPath = prev.selectedSongPath;
  const titleEl = $('audio-title');
  if (titleEl) titleEl.textContent = currentName;
  fillCueBar(currentPath);
  applyWaveCache(currentPath);
  scheduleBuildWave(currentPath);
  bindAudioMeta(currentPath);
  playing = !!st.playing;
  pos = st.position;
  seekGuardUntil = 0;
  updatePlayBtn();
  paintSongActive();
  return true;
}

/** 卡片上标出「文件丢失」 */
function paintMissing() {
  const list = $('audio-song-list');
  list?.querySelectorAll('.audio-card').forEach((card) => {
    const miss = missingPaths.has(card.dataset.path);
    card.classList.toggle('is-missing', miss);
    let badge = card.querySelector('.audio-card-missing');
    if (miss && !badge) {
      badge = document.createElement('div');
      badge.className = 'audio-card-missing';
      badge.textContent = '文件丢失';
      badge.title = '电脑上找不到这个文件（被移动、改名或 U 盘没插）';
      card.querySelector('.audio-card-body')?.appendChild(badge);
    } else if (!miss && badge) {
      badge.remove();
    }
  });
}

let missingCheckToken = 0;
/** 列表渲染后检查文件是否还在（空闲时做，不挡交互） */
function checkMissing(paths) {
  const token = ++missingCheckToken;
  if (!paths.length) return;
  invoke('existing_files', { paths }).then((have) => {
    if (token !== missingCheckToken || !Array.isArray(have)) return;
    const ok = new Set(have);
    for (const p of paths) {
      if (ok.has(p)) missingPaths.delete(p);
      else missingPaths.add(p);
    }
    paintMissing();
  }).catch(() => {});
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
  // 长期缓存不含 mono；频谱数据单独留给当前曲（重播 / 单曲循环仍有电平表）
  const slot = monoSlot?.path === path ? monoSlot : null;
  mono = slot?.mono || null;
  monoSr = slot?.monoSr || 0;
  updateTech();
  draw();
  return true;
}

/** 波形已缓存且频谱数据也在手 → 不必再解码 */
function waveReady(path) {
  return waveCache.has(path) && monoSlot?.path === path;
}

function scheduleBuildWave(path) {
  if (waveReady(path)) return;
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
  loadFile(next.path, true).catch(() => {});
  return true;
}

/** 键盘 ←/→ 直接切歌播放。 */
export function audioStep(delta) {
  return step(delta);
}

/** A / D 只移动选中项；Enter 再确认播放。 */
export function audioSelectStep(delta) {
  const items = visibleAudioItems();
  if (!items.length) return false;
  let idx = items.findIndex((item) => item.path === selectedSongPath);
  if (idx < 0) idx = items.findIndex((item) => item.path === currentPath);
  if (idx < 0) idx = delta > 0 ? -1 : 0;
  const next = items[(idx + delta + items.length) % items.length];
  selectedSongPath = next.path;
  paintSongActive();
  const list = $('audio-song-list') || $('audio-list');
  const row = Array.from(list?.querySelectorAll('[data-path]') ?? [])
    .find((el) => el.dataset.path === next.path);
  row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  toast(`预选：${cardLabel(next)}（Enter 播放）`, 1400);
  return true;
}

/** Enter：播放当前选中歌曲。 */
export async function playSelectedAudio() {
  const items = visibleAudioItems();
  if (!items.length) return false;
  const path = items.some((item) => item.path === selectedSongPath)
    ? selectedSongPath
    : (items.some((item) => item.path === currentPath) ? currentPath : items[0].path);
  selectedSongPath = path;
  paintSongActive();
  if (path === currentPath) {
    if (!playing) await play();
  } else {
    await loadFile(path, true, { skipList: true });
  }
  return true;
}

function songTitleParts() {
  const parts = currentName.split(/\s*[-–—]\s*/);
  return {
    title: parts.length > 1 ? parts.slice(1).join(' - ') : currentName,
    sub: parts.length > 1 ? parts[0] : '',
  };
}

/** 推送扩展屏：有同名 .lrc/.txt 则滚歌词，否则标题卡 */
async function pushCard(seqAtPlay) {
  if (!currentPath) return;
  const { title, sub } = songTitleParts();
  // 找歌词要等文件读取：先记下当前世代，期间若手动黑屏/切走则不再推送
  const seq = seqAtPlay ?? pendingOutputSeq ?? currentOutputSeq();
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
      }, seq);
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
  }, seq);
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

async function buildWave(path, token = waveBuildToken) {
  if (waveReady(path)) {
    if (currentPath === path) applyWaveCache(path);
    return;
  }
  if (currentPath === path) {
    // 保留已有缓存展示；无缓存时先清空波形区但不阻塞
    if (!peaks) updateTech();
  }
  try {
    // 优先 Rust 原生解码（不占 WebView 内存）；不支持的格式回退到 WebAudio
    const w = await decodeWaveNative(path).catch(() => null) || await decodeWaveWeb(path, () => token !== waveBuildToken);
    if (!w || token !== waveBuildToken) return;
    const arr = w.peaks;
    const dur = w.duration;
    const sr = w.sampleRate;
    // 频谱 mono 只留给「当前曲」，不进长期缓存（防 WebView OOM）
    const isCur = token === waveBuildToken && currentPath === path;
    const md = isCur ? w.mono : null;
    const mdSr = isCur ? w.monoSr : 0;
    if (isCur && md) monoSlot = { path, mono: md, monoSr: mdSr };
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
  list.querySelectorAll('.audio-card, .song-row, .file-item').forEach((row) => {
    const path = row.dataset.path;
    if (!path) return;
    const on = path === currentPath;
    const sel = path === selectedSongPath || on;
    row.classList.toggle('active', sel);
    row.classList.toggle('keyboard-selected', path === selectedSongPath && !on);
    // current=已加载本曲（暂停也保留高亮）；playing=正在出声
    row.classList.toggle('current', on);
    row.classList.toggle('playing', on && playing);
    const volInfo = cardVolLabel(path);
    row.classList.toggle('has-vol-preset', volInfo.preset);
    let stateBadge = row.querySelector('.audio-card-paused-badge, .audio-card-playing-badge');
    if (on) {
      const cls = playing ? 'audio-card-playing-badge' : 'audio-card-paused-badge';
      const text = playing ? '播放中' : '已暂停';
      if (!stateBadge || !stateBadge.classList.contains(cls)) {
        stateBadge?.remove();
        stateBadge = document.createElement('div');
        stateBadge.className = cls;
        stateBadge.textContent = text;
        row.querySelector('.audio-card-body')?.appendChild(stateBadge);
      } else {
        stateBadge.textContent = text;
      }
    } else if (stateBadge) {
      stateBadge.remove();
    }
    const volEl = row.querySelector('.audio-card-vol');
    if (volEl) {
      volEl.textContent = volInfo.text;
      volEl.title = volInfo.title;
      volEl.classList.toggle('is-preset', volInfo.preset);
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
  list.innerHTML = items.map((it) => {
    const on = it.path === currentPath;
    const sel = it.path === selectedSongPath || on;
    const keyboardSel = it.path === selectedSongPath && !on;
    const dur = durationOf(it.path);
    const label = cardLabel(it);
    const mode = getItemLoopMode(it.path);
    const lm = loopBtnMeta(mode);
    const vocalOn = getItemVocalCancel(it.path);
    const vm = vocalBtnMeta(vocalOn);
    const cue = getItemCue(it.path);
    const badge = cueBadgeText(cue);
    const note = resolveItemNote(it.path);
    const volInfo = cardVolLabel(it.path);
    const tipBits = [label, badge, note, vocalOn ? '仅伴奏' : ''].filter(Boolean).join(' · ');
    return `
    <div class="audio-card ${sel ? 'active' : ''} ${keyboardSel ? 'keyboard-selected' : ''} ${on ? 'current' : ''} ${on && playing ? 'playing' : ''} ${mode === 'one' ? 'loop-one' : ''} ${vocalOn ? 'vocal-on' : ''} ${volInfo.preset ? 'has-vol-preset' : ''}" data-path="${esc(it.path)}" title="${esc(tipBits)}">
      <div class="audio-card-body">
        <span class="audio-card-vol ${volInfo.preset ? 'is-preset' : ''}" title="${esc(volInfo.title)}">${esc(volInfo.text)}</span>
        <button type="button" class="audio-card-rename" data-act="rename" title="重命名显示名">✎</button>
        <button type="button" class="audio-card-note-btn" data-act="note" title="编辑备注">📝</button>
        <button type="button" class="audio-card-vocal ${vm.cls}" data-act="vocal" title="${esc(vm.title)}">${vm.icon}</button>
        <button type="button" class="audio-card-go ${lm.cls}" data-act="loop" title="${esc(lm.title)}">${lm.icon}</button>
        <div class="audio-card-name">${esc(label)}</div>
        ${note ? `<div class="audio-card-note" title="${esc(note)}">${esc(note)}</div>` : ''}
        ${badge ? `<div class="audio-card-cue">${esc(badge)}</div>` : ''}
        ${vocalOn ? '<div class="audio-card-vocal-badge">仅伴奏</div>' : ''}
        ${on && !playing ? '<div class="audio-card-paused-badge">已暂停</div>' : ''}
        ${on && playing ? '<div class="audio-card-playing-badge">播放中</div>' : ''}
      </div>
      <div class="audio-card-foot">
        <span class="audio-card-dur mono">${fmtHms(dur)}</span>
        <button type="button" class="card-del" data-act="del" title="从列表移除（不删除电脑上的文件）">✕</button>
      </div>
    </div>`;
  }).join('');
  paintMissing();
  scheduleDurProbe(items.map((it) => it.path));
  checkMissing(items.map((it) => it.path));
}

function currentModule() {
  return document.querySelector('.tab.active')?.dataset.module;
}

export function initAudio() {
  migrateLibrary();
  bindMetersHost({
    meterState: () => ({ mono, monoSr, pos, playing, engineVol }),
    syncMeterReadout,
  });
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

  initStemProgressUi();

  listen('sp-audio-device-fallback', (e) => {
    const name = e?.payload || '';
    toast(`找不到声卡「${name}」，已改用系统默认输出。请检查连线或到设置里重选声卡`, 8000);
  });

  listen('sp-audio-ended', (e) => {
    // 迟到的结束事件：手动换了歌之后旧歌才报结束 → 不能再把新歌跳走
    const endedPath = e?.payload?.path;
    if (endedPath && endedPath !== playPath) return;
    playing = false;
    updatePlayBtn();
    const fromProgram = playSource === 'program';
    // 节目单：交给走台（更新高亮 / 不跳过中间非音频 / 默认不推屏）
    if (fromProgram) {
      if (currentPath && shouldRepeatCurrent(currentPath)) {
        loadFile(currentPath, true, {
          source: 'program',
          stay: true,
          pushOutput: false,
          skipList: true,
        }).catch(() => {});
        return;
      }
      document.dispatchEvent(new CustomEvent('sp:program-audio-ended', {
        detail: { path: currentPath },
      }));
      paintSongActive();
      return;
    }
    // 音乐页：在当前目录曲库内续播
    const items = visibleAudioItems();
    if (!items.length) return;
    const idx = items.findIndex((i) => i.path === currentPath);
    if (currentPath && shouldRepeatCurrent(currentPath) && idx >= 0) {
      loadFile(items[idx].path, true, { source: 'library', skipList: true }).catch(() => {});
      return;
    }
    if (loopMode === 'none' && idx < 0) {
      paintSongActive();
      return;
    }
    autoAdvance(items, idx, 0);
  });

  /** 播完续下一首；下一首丢失 / 打不开就提示并跳过，全都不行才停 */
  function autoAdvance(items, idx, tries) {
    const ni = Math.max(0, idx) + 1;
    if (tries >= items.length || (loopMode === 'none' && ni >= items.length)) {
      paintSongActive();
      return;
    }
    const next = items[ni % items.length];
    loadFile(next.path, true, { source: 'library', skipList: true, quietError: true }).catch((err) => {
      if (currentPath !== next.path) return; // 期间已手动换歌
      toast(`「${cardLabel(next)}」无法播放（${errText(err)}），已跳过`, 6000);
      autoAdvance(items, ni % items.length, tries + 1);
    });
  }

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

  // 切换声卡：与正常起播同一路径（含已生成的伴奏 wav）
  document.addEventListener('sp:audio-device-changed', async () => {
    if (!currentPath) return;
    try {
      const st = await invoke('audio_state');
      const loaded = st.exists && isEnginePath(st.path);
      // 当前没在引擎里（已停 / 播完）：只记设置，下次起播用新声卡
      if (!loaded) {
        toast('已切换音频输出设备（下次播放生效）');
        return;
      }
      const wasPlaying = st.playing;
      const at = st.position;
      cancelFade();
      fadeOutStarted = false;
      const file = effectivePlayPath(currentPath) || currentPath;
      playPath = file;
      engineVol = volume();
      await invoke('audio_play', {
        path: file,
        ...deviceArgs(),
        startAt: at > 0.05 ? at : null,
        vocalCancel: false,
        volume: engineVol,
        paused: !wasPlaying,
      });
      syncVolReadout();
      playing = !!wasPlaying;
      pos = at;
      seekGuardUntil = Date.now() + 500;
      updatePlayBtn();
      paintSongActive();
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
  let lastCardClick = { path: null, at: 0 };
  list?.addEventListener('click', (e) => {
    const item = e.target.closest('.audio-card, .song-row, .file-item');
    if (!item?.dataset.path) return;
    if (e.target.closest('[data-act="rename"]')) {
      renameAudioItem(item.dataset.path);
      return;
    }
    if (e.target.closest('[data-act="note"]')) {
      const path = item.dataset.path;
      selectedSongPath = path;
      fillCueBar(path);
      const cur = resolveItemNote(path);
      const v = window.prompt('歌曲备注（开播提示）', cur);
      if (v === null) return;
      const noteEl = $('audio-note');
      if (noteEl) noteEl.value = v.trim();
      saveAudioNote();
      return;
    }
    if (e.target.closest('[data-act="del"]')) {
      removeAudioItem(item.dataset.path);
      return;
    }
    if (e.target.closest('[data-act="loop"]')) {
      toggleItemLoopMode(item.dataset.path);
      e.target.closest('[data-act="loop"]')?.blur?.();
      return;
    }
    if (e.target.closest('[data-act="vocal"]')) {
      toggleItemVocalCancel(item.dataset.path);
      e.target.closest('[data-act="vocal"]')?.blur?.();
      return;
    }
    // 同一张卡片 400ms 内的第二下当手抖忽略（否则刚开播就被暂停）
    const now = Date.now();
    if (item.dataset.path === lastCardClick.path && now - lastCardClick.at < 400) return;
    lastCardClick = { path: item.dataset.path, at: now };
    selectedSongPath = item.dataset.path;
    fillCueBar(item.dataset.path);
    if (item.dataset.path === currentPath) {
      // 当前这首：播放中 → 暂停；暂停中 → 从原位置继续（不从头重播）
      if (playing) {
        cancelFade();
        invoke('audio_pause').then(() => {
          playing = false;
          updatePlayBtn();
          paintSongActive();
        }).catch((err) => toast('暂停失败：' + err));
      } else {
        play();
      }
      return;
    }
    // skipList：先出声，不在起播前整表重渲
    loadFile(item.dataset.path, true, { skipList: true }).catch(() => {});
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
        await startPlayback(t, { noFade: true, skipList: true, paused: !wasPlaying });
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
  // 推子：百分比 + dB 同步；全局默认与本曲预设分开
  if (vol) vol.value = String(globalDefaultVolume());
  engineVol = volume();
  syncVolReadout();
  // 若当前已加载带预设的歌，推子显示本曲值（不改全局默认）
  if (currentPath) applySongVolumeToFader(currentPath, { writeEngine: false });
  vol?.addEventListener('input', () => {
    const v = +vol.value;
    // 点在滑条轨道上会一下跳很多：大跳变用 0.15 秒滑过去，拖动时的小步照常即时跟手
    if (Math.abs(v - engineVol) > 0.1) fadeTo(v, 0.15);
    else {
      cancelFade();
      setEngineVol(v);
    }
    // 仅当「当前曲没有本曲预设」时，才把推子记成全局默认；有预设时只临时改这一次出声
    const path = currentPath || selectedSongPath;
    if (!path || getItemVolume(path) == null) {
      setGlobalDefaultVolume(v);
    }
    paintSongActive();
  });
  // 鼠标点完滑条 / 勾选 / 循环等按钮后清掉焦点：否则空格会点到「循环」而不是暂停
  $('panel-audio')?.addEventListener('pointerup', (e) => {
    const el = e.target.closest?.(
      'input[type="range"], input[type="checkbox"], button, select'
    );
    if (!el) return;
    setTimeout(() => {
      if (document.activeElement === el) el.blur();
    }, 0);
  });
  initSystemVolume();
  $('audio-vol-unity')?.addEventListener('click', () => {
    if (!vol) return;
    cancelFade();
    vol.value = '1';
    setEngineVol(1);
    const path = currentPath || selectedSongPath;
    if (!path || getItemVolume(path) == null) {
      setGlobalDefaultVolume(1);
      toast('默认音量 100%（0 dB）');
    } else {
      toast('已临时调到 100%（本曲仍有预设，可用「重置音量」清除）');
    }
    paintSongActive();
  });
  $('audio-clip')?.addEventListener('click', () => {
    resetClip();
    syncMeterReadout();
  });

  $('audio-cue-apply')?.addEventListener('click', () => saveCueFromBar());
  $('audio-vol-from-fader')?.addEventListener('click', () => {
    const volEl = $('audio-item-vol');
    if (!volEl) return;
    volEl.value = String(Math.round(volume() * 100));
    toast(`已填入推子 ${volEl.value}% · 再点保存写入本曲`);
  });
  $('audio-vol-reset')?.addEventListener('click', () => {
    resetItemVolume(selectedSongPath || currentPath);
  });
  $('audio-note-save')?.addEventListener('click', () => saveAudioNote());
  $('audio-note')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveAudioNote();
    }
  });
  ['audio-start-min', 'audio-start-sec', 'audio-fade-in', 'audio-fade-out', 'audio-item-vol'].forEach((id) => {
    $(id)?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveCueFromBar();
    });
  });
  fillCueBar(currentPath);

  btnLoop.addEventListener('click', () => {
    cycleLoopMode();
    btnLoop.blur();
  });
  // 记住上次的循环方式（重启后不再默默回到列表循环）
  paintLoopMode();

  btnPush.addEventListener('click', () => {
    if (currentPath) pushCard().catch(() => {});
    else toast('请先选择音频');
  });

  document.addEventListener('sp:import-audio', async () => {
    const files = await pickFiles([{ name: '音频', extensions: AUDIO_EXT }], '导入音频');
    if (!files.length) return;
    let added = 0;
    const ok = updateLibrary((items) => {
      for (const f of files) {
        if (items.some((i) => i.path === f)) continue;
        items.push({ id: genId(), type: 'audio', path: f, name: fileName(f).replace(/\.[^.]+$/, '') });
        added++;
      }
    });
    if (!ok) return toast('保存曲库失败');
    renderList();
    toast(added ? `已添加 ${added} 首到音乐库` : '这些歌已在音乐库里');
    if (!currentPath) {
      const first = eventAudioItems()[0];
      if (first) loadFile(first.path, false);
    }
  });

  $('audio-pack-export')?.addEventListener('click', () => exportAudioPack());
  $('audio-pack-import')?.addEventListener('click', () => importAudioPack());
  listen('sp-audio-pack', (e) => {
    const p = e?.payload || e;
    if (!p?.message) return;
    const tip = $('list-title');
    if (tip && currentModule() === 'audio') {
      if (!tip.dataset.packMsg) tip.dataset.packMsg = tip.textContent;
      tip.textContent = p.message;
    }
  });

  document.addEventListener('sp:clear-list', () => {
    if (currentModule() !== 'audio') return;
    // 只清音乐库，节目单里的歌不动
    const snap = libraryRaw().map((i) => ({ ...i }));
    if (!snap.length) return;
    updateLibrary((items) => { items.length = 0; });
    pushUndo(`清空音乐库（${snap.length} 首）`, () => restoreLibrary(snap));
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
    clearOutput();
  });

  window.addEventListener('resize', () => { draw(); drawSpectrum(); drawVU(); });
}

/**
 * 「系统」音量条：Windows 系统总音量（键盘 Fn+音量键调的就是它）。
 * 音乐页可见时每 0.4 秒读一次，按键改了系统音量这里跟着动；拖它则直接改系统音量。
 */
function initSystemVolume() {
  const wrap = $('sys-vol-wrap');
  const slider = $('sys-volume');
  const label = $('sys-vol-label');
  if (!wrap || !slider) return;
  let dragging = false;
  let setBusy = false;
  let setPending = null;
  let failCount = 0;

  const paint = (st) => {
    wrap.classList.remove('is-unavailable');
    wrap.classList.toggle('is-muted', !!st.muted);
    if (!dragging) slider.value = String(st.volume);
    const pct = Math.round(st.volume * 100);
    if (label) label.textContent = st.muted ? '静音' : `${pct}%`;
  };
  const unavailable = () => {
    wrap.classList.add('is-unavailable');
    if (label) label.textContent = '--';
  };

  async function refresh() {
    if (dragging || setBusy) return;
    try {
      paint(await invoke('system_volume_get'));
      failCount = 0;
    } catch {
      // 偶发失败（切换默认设备的瞬间）不立刻变灰
      if (++failCount >= 3) unavailable();
    }
  }

  // 拖动时只保留最新值，前一次设置完成再发下一次，不堆积
  async function pushSet() {
    if (setBusy || setPending == null) return;
    setBusy = true;
    const v = setPending;
    setPending = null;
    try {
      paint(await invoke('system_volume_set', { v }));
    } catch (err) {
      toast('无法设置系统音量：' + err);
    } finally {
      setBusy = false;
      if (setPending != null) pushSet();
    }
  }

  slider.addEventListener('pointerdown', () => { dragging = true; });
  const endDrag = () => { dragging = false; };
  slider.addEventListener('pointerup', endDrag);
  slider.addEventListener('pointercancel', endDrag);
  slider.addEventListener('input', () => {
    setPending = +slider.value;
    if (label && !wrap.classList.contains('is-muted')) label.textContent = `${Math.round(setPending * 100)}%`;
    pushSet();
  });

  refresh();
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    // Windows 音量键（Fn+音量）在系统层改变默认设备音量；持续读取，
    // 保证切到其他页面期间改过音量，回到音乐页时软件滑条也已同步。
    refresh();
  }, 400);
  // 切回音乐页时立刻刷新，不等下一拍
  document.addEventListener('visibilitychange', refresh);
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

/**
 * 键盘 ↑/↓ 调推子（main.js：音乐页，或节目单当前条是音乐时）。
 * 滑条、百分比、dB 一起变；用很短的渐变过去，按住连发也不爆音。
 * @returns {number|null} 调整后的音量 0~1
 */
export function nudgeAudioVolume(step) {
  const vol = $('audio-volume');
  if (!vol) return null;
  const v = Math.round(Math.max(0, Math.min(1, volume() + step)) * 100) / 100;
  vol.value = String(v);
  fadeTo(v, 0.08);
  const path = currentPath || selectedSongPath;
  if (!path || getItemVolume(path) == null) {
    setGlobalDefaultVolume(v);
  }
  paintSongActive();
  return v;
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
  lsSet(LS_LOOP, loopMode);
  paintLoopMode();
  return loopMode;
}

/** 底部循环按钮 + 节目单音乐条上的同款按钮 */
function paintLoopMode() {
  const label = getLoopModeLabel();
  const btnLoop = $('audio-loop');
  if (btnLoop) btnLoop.textContent = label;
  const pgLoop = $('pg-audio-loop');
  if (pgLoop) {
    pgLoop.textContent = label;
    pgLoop.dataset.mode = loopMode;
  }
}

export function getLoopModeLabel() {
  return { all: '列表循环', one: '单曲循环', none: '顺序播放' }[loopMode] || '顺序播放';
}
