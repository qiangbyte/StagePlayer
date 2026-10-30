// 节目单 = 一场演出的时间轴（按顺序混排：音频/视频/图片/PPT页/PDF页，逐条播放）

import {
  pickFiles, esc, fileName, fileExt, lsGet, lsSet, toast, convertFileSrc, listen, lsApproxBytes,
  AUDIO_EXT, VIDEO_EXT, IMAGE_EXT, PPT_EXT, PDF_EXT, detectMediaType,
} from './util.js';
import { pushToOutput, claimOutputSeq, isOutputFrozen } from './output-main.js';
import {
  playByPath as audioPlay,
  getAudioSnapshot,
  seekAudio,
  cycleLoopMode,
  getLoopModeLabel,
  toggleAudio,
  stopAudio,
} from './audio.js';
import { playByPath as videoPlay } from './video.js';
import { getPageCount as pptPages, playPage as pptPlayPage } from './ppt.js';
import { getPageCount as pdfPages, playPage as pdfPlayPage } from './pdf.js';
import { blankToOutputPayload } from './blank-page.js';
import { bibleToOutputPayload } from './bible-page.js';
import {
  LS_BODIES, bodyStore, normalizeItem, normalizeEvents, countItems,
} from './program-store.js';
import { bindBlankHost, hideBlankPanels, initBlankPanels } from './program-blank.js';
import { bindBibleHost, initBiblePanel } from './program-bible.js';
import { bindThumbsHost, cancelThumbs, fillItemThumbs } from './program-thumbs.js';
import {
  bindCueHost, editItemCue, syncCueCountdowns, tickCueAutoPlay,
} from './program-cue.js';
import {
  bindLobbyHost, tickLobbyAutoStart, defaultLobby, ensureLobby, fillLobbyForm, readLobbyForm,
  syncLobbyRemain, pushLobbyPage,
} from './program-lobby.js';

const LS_EVENTS = 'sp.program.events';
const LS_CURRENT = 'sp.program.current';
const LS_VIEW = 'sp.program.view';
const LS_ZOOM = 'sp.program.zoom';

let events = normalizeEvents(lsGet(LS_EVENTS, []));
let currentId = lsGet(LS_CURRENT, null);
let activeItemId = null;
let activateSeq = 0; // 快速切条时只采纳最后一次
let seekingAudio = false;
const _savedView = lsGet(LS_VIEW, 'grid');
let viewMode = _savedView === 'list' ? 'list' : 'grid';
function initialCardZoom() {
  const z = Number(lsGet(LS_ZOOM, 260));
  if (!z || z < 140) return 260;
  return Math.min(420, Math.max(140, z));
}
let cardZoom = initialCardZoom();

const $ = (id) => document.getElementById(id);

const TYPE_META = {
  audio: { icon: '♪', label: '音乐', color: '#3dd55f' },
  video: { icon: '▶', label: '视频', color: '#4f8cff' },
  image: { icon: '图', label: '图片', color: '#e8a23a' },
  ppt: { icon: 'P', label: 'PPT', color: '#ff6b4a' },
  pdf: { icon: 'PDF', label: 'PDF', color: '#c45cff' },
  blank: { icon: '页', label: '空白页', color: '#e8c56a' },
  bible: { icon: '经', label: '圣经', color: '#c9a227' },
};

const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function initAudioFloat() {
  $('audio-float-toggle')?.addEventListener('click', () => {
    toggleAudio();
    syncAudioFloat();
  });
  $('audio-float-stop')?.addEventListener('click', async () => {
    await stopAudio();
    syncAudioFloat();
    syncAudioBar(true);
    syncPlayGoBtn();
    toast('已停止背景音乐');
  });
}

/** 音乐叠播其它节目时显示漂浮条（播放/暂停都保留，方便继续或关闭） */
function syncAudioFloat() {
  const dock = $('audio-float');
  if (!dock) return;
  const snap = getAudioSnapshot();
  const item = curEvent()?.items.find((i) => i.id === activeItemId);
  const onThisAudio = item?.type === 'audio' && snap.path && item.path === snap.path;
  // 有曲目且（在播 / 已开播过）且当前焦点不是这首歌 → 显示
  const live = !!(snap.path && (snap.playing || snap.pos > 0.2));
  const show = live && !onThisAudio;
  dock.classList.toggle('hidden', !show);
  if (!show) return;
  dock.classList.toggle('is-paused', !snap.playing);
  const title = $('audio-float-title');
  const sub = $('audio-float-sub');
  const btn = $('audio-float-toggle');
  if (title) title.textContent = snap.name || fileName(snap.path) || '音乐播放中';
  if (sub) {
    const state = snap.playing ? '' : '已暂停 · ';
    sub.textContent = `${state}${fmtClock(snap.pos)} / ${fmtClock(snap.duration)}`;
  }
  if (btn) {
    btn.textContent = snap.playing ? '⏸' : '▶';
    btn.title = snap.playing ? '暂停' : '继续';
  }
}

function curEvent() {
  return events.find((e) => e.id === currentId);
}

/** 把长歌词/圣经正文外置；bodies 失败时绝不把主表写成空正文（防重启空白） */
function persistEventsToStorage() {
  const bodies = { ...bodyStore() };
  const used = new Set();
  let needExternal = false;

  const slim = events.map((ev) => ({
    ...ev,
    items: (ev.items || []).map((it) => {
      if (it.type !== 'blank' && it.type !== 'bible') return it;
      const body = it.body || '';
      if (body.length < 64) {
        const { _bodyRef, ...rest } = it;
        return rest;
      }
      needExternal = true;
      const id = it.id;
      bodies[id] = body;
      used.add(id);
      const { body: _b, ...rest } = it;
      return { ...rest, body: '', _bodyRef: id };
    }),
  }));

  for (const k of Object.keys(bodies)) {
    if (!used.has(k)) delete bodies[k];
  }

  // 无需外置：直接写完整事件
  if (!needExternal) {
    return lsSet(LS_EVENTS, slim);
  }

  // 先写 bodies，成功才写瘦身主表；失败则主表保留完整正文
  const okBodies = lsSet(LS_BODIES, bodies);
  if (!okBodies) {
    return lsSet(LS_EVENTS, events);
  }
  const okEvents = lsSet(LS_EVENTS, slim);
  if (!okEvents) {
    // 主表失败时尽量回退写带正文的完整表，避免只剩空引用
    return lsSet(LS_EVENTS, events);
  }
  return true;
}

/** 内存为权威；写入失败时绝不回读旧 LS 覆盖节目
 *  opts.soft：UI 只做软刷新（不拆缩略图）
 */
function save(opts = {}) {
  const ok = persistEventsToStorage();
  lsSet(LS_CURRENT, currentId);
  if (!ok) {
    const kb = Math.round(lsApproxBytes() / 1024);
    toast(`节目单未能写入本地存储（约已用 ${kb}KB，空间可能不足），当前列表仍保留在内存中`, 7000);
  }
  document.dispatchEvent(new CustomEvent('sp:program-changed', {
    detail: { source: 'program', soft: !!opts.soft },
  }));
}

/** 仅在外部（如音频页）改 LS 时合并；禁止用更空的数据盖掉内存里的演出 */
function adoptFromStorage() {
  const next = normalizeEvents(lsGet(LS_EVENTS, null));
  if (!next.length && events.length) return;
  const memN = countItems(events);
  const lsN = countItems(next);
  if (lsN < memN) {
    // 外模块读到了过期空数据 — 把内存写回
    lsSet(LS_EVENTS, events);
    lsSet(LS_CURRENT, currentId);
    return;
  }
  events = next;
  const cid = lsGet(LS_CURRENT, null);
  if (cid) currentId = cid;
  if (!curEvent() && events.length) currentId = events[0].id;
}

function activeIndex() {
  const ev = curEvent();
  if (!ev || !activeItemId) return -1;
  return ev.items.findIndex((i) => i.id === activeItemId);
}

function fmtClock(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function initProgram() {
  // 拆出的子模块需要回调本模块
  bindBlankHost({ curEvent, renderItems, save, updateNowBar });
  bindBibleHost({ activate, curEvent, renderItems, save, updateNowBar });
  bindThumbsHost({ TYPE_META, curEvent, syncCueCountdowns, syncItemRemain, viewMode: () => viewMode });
  bindCueHost({ activate, curEvent, renderItems, save });
  bindLobbyHost({ activate, curEvent, save });
  if (!events.length) {
    events.push({ id: genId(), name: '本场演出', items: [] });
    currentId = events[0].id;
    save();
  }
  if (!curEvent()) {
    currentId = events[0].id;
    save();
  }
  // 圣经改为首次使用时再加载（启动预热易与 PDF/波形叠成 OOM）

  // 旧数据：整份 PPT/PDF 未按页展开时，启动时自动拆页
  expandLegacyDocs().finally(() => {
    renderEvents();
    renderItems();
    updateNowBar();
    syncAudioBar();
  });

  // 节目单内存权威：仅 source=storage 时才考虑合并 LS；自身 save 只刷新 UI
  document.addEventListener('sp:program-changed', (e) => {
    if (e.detail?.source === 'storage') adoptFromStorage();
    renderEvents();
    // soft：备注/定时等小改动；增删/重排由调用方显式 hard 刷新或 soft 失败回落
    renderItems({ soft: !!e.detail?.soft });
    updateNowBar();
    syncAudioBar();
    syncAudioFloat();
    if (!$('pg-lobby-panel')?.classList.contains('hidden')) fillLobbyForm();
    syncLobbyRemain();
  });

  initAudioFloat();

  // 供音频等模块改节目（避免它们直接读旧 LS 覆盖整场演出）
  document.addEventListener('sp:program-mutate', (e) => {
    const detail = e.detail || {};
    const ev = curEvent();
    if (!ev) {
      detail.ok = false;
      toast('请先在「节目单」新建一个活动');
      return;
    }
    try {
      if (typeof detail.fn === 'function') detail.fn(ev);
      save();
      detail.ok = true;
    } catch (err) {
      detail.ok = false;
      toast(`更新节目失败：${err}`, 5000);
    }
  });

  $('pg-new').addEventListener('click', () => {
    const ev = { id: genId(), name: `演出 ${events.length + 1}`, items: [], lobby: defaultLobby(`演出 ${events.length + 1}`) };
    events.push(ev);
    currentId = ev.id;
    activeItemId = null;
    save();
    renderEvents();
    renderItems();
    updateNowBar();
    syncAudioBar();
    fillLobbyForm();
    startRename();
  });

  $('pg-add-mixed')?.addEventListener('click', () => addMixed());
  $('pg-add-audio').addEventListener('click', () => addItems('audio'));
  $('pg-add-video').addEventListener('click', () => addItems('video'));
  $('pg-add-image')?.addEventListener('click', () => addItems('image'));
  $('pg-add-ppt').addEventListener('click', () => addItems('ppt'));
  $('pg-add-pdf').addEventListener('click', () => addItems('pdf'));
  initBlankPanels();
  initBiblePanel();

  $('pg-prev')?.addEventListener('click', () => programStep(-1));
  $('pg-go')?.addEventListener('click', () => programGo());
  $('pg-next')?.addEventListener('click', () => programStep(1));

  $('pg-view-list')?.addEventListener('click', () => setViewMode('list'));
  $('pg-view-grid')?.addEventListener('click', () => setViewMode('grid'));
  const zoom = $('pg-zoom');
  if (zoom) {
    zoom.value = String(cardZoom);
    zoom.addEventListener('input', () => setCardZoom(+zoom.value));
  }
  document.querySelectorAll('.pg-zoom-preset').forEach((btn) => {
    btn.addEventListener('click', () => setCardZoom(+btn.dataset.zoom));
  });
  syncViewToggle();
  applyCardZoom();

  initProgramDragDrop();

  $('pg-audio-loop')?.addEventListener('click', () => {
    cycleLoopMode();
    syncAudioBar(true);
  });

  const seek = $('pg-audio-seek');
  if (seek) {
    seek.addEventListener('pointerdown', () => { seekingAudio = true; });
    seek.addEventListener('pointerup', () => { seekingAudio = false; });
    seek.addEventListener('change', async () => {
      const snap = getAudioSnapshot();
      if (!snap.duration) return;
      const t = (+seek.value / 1000) * snap.duration;
      await seekAudio(t);
      seekingAudio = false;
      syncAudioBar(true);
    });
    seek.addEventListener('input', () => {
      const snap = getAudioSnapshot();
      if (!snap.duration) return;
      const t = (+seek.value / 1000) * snap.duration;
      const posEl = $('pg-audio-pos');
      if (posEl) posEl.textContent = fmtClock(t);
    });
  }

  setInterval(() => {
    try {
      syncAudioBar();
      if (programVisible()) {
        syncItemRemain();
        syncCueCountdowns();
      }
      syncPlayGoBtn();
      syncAudioFloat();
      syncLobbyRemain();
      tickLobbyAutoStart();
      tickCueAutoPlay();
    } catch (err) {
      console.warn('[program] tick', err);
    }
  }, 250);

  document.addEventListener('sp:audio-state', () => {
    syncPlayGoBtn();
    syncItemRemain();
    syncAudioBar();
    syncAudioFloat();
  });

  $('pg-lobby-toggle')?.addEventListener('click', () => {
    const panel = $('pg-lobby-panel');
    if (!panel) return;
    const show = panel.classList.contains('hidden');
    if (show) {
      hideBlankPanels();
      fillLobbyForm();
      panel.classList.remove('hidden');
      $('pg-lobby-toggle')?.classList.add('active');
    } else {
      panel.classList.add('hidden');
      $('pg-lobby-toggle')?.classList.remove('active');
    }
  });
  $('pg-lobby-save')?.addEventListener('click', () => {
    readLobbyForm(true);
    toast('开场页已保存');
  });
  $('pg-lobby-push')?.addEventListener('click', () => pushLobbyPage());
  $('pg-lobby-push2')?.addEventListener('click', () => pushLobbyPage());
  $('pg-lobby-bgimg-pick')?.addEventListener('click', async () => {
    const files = await pickFiles([{ name: '图片', extensions: IMAGE_EXT }], '选择开场背景图');
    if (!files.length) return;
    const ev = curEvent();
    if (!ev) return;
    ensureLobby(ev).bgImage = files[0];
    fillLobbyForm();
    readLobbyForm(true);
    toast('已设置开场背景图');
  });
  $('pg-lobby-bgimg-clear')?.addEventListener('click', () => {
    const ev = curEvent();
    if (!ev) return;
    ensureLobby(ev).bgImage = '';
    fillLobbyForm();
    readLobbyForm(true);
    toast('已清除背景图');
  });
  $('pg-lobby-autostart')?.addEventListener('change', () => readLobbyForm(true));
  ['pg-lobby-date', 'pg-lobby-time', 'pg-lobby-title', 'pg-lobby-sub',
    'pg-lobby-note', 'pg-lobby-kicker', 'pg-lobby-accent', 'pg-lobby-bg'].forEach((id) => {
    $(id)?.addEventListener('change', () => readLobbyForm(true));
    $(id)?.addEventListener('input', () => {
      if (id === 'pg-lobby-date' || id === 'pg-lobby-time') syncLobbyRemain();
    });
  });

  $('pg-rename').addEventListener('click', startRename);
  $('pg-rename-ok').addEventListener('click', applyRename);
  $('pg-rename-cancel').addEventListener('click', () => $('pg-rename-row').classList.add('hidden'));
  $('pg-rename-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyRename();
    if (e.key === 'Escape') $('pg-rename-row').classList.add('hidden');
  });

  $('pg-delete').addEventListener('click', () => {
    if (events.length <= 1) {
      curEvent().items = [];
      activeItemId = null;
      save();
      renderItems();
      updateNowBar();
      syncAudioBar();
      toast('至少保留一场演出，已清空节目内容');
      return;
    }
    events = events.filter((e) => e.id !== currentId);
    currentId = events[0].id;
    activeItemId = null;
    save();
    renderEvents();
    renderItems();
    updateNowBar();
    syncAudioBar();
  });

  // 双击左上角序号 → 快速改播放顺序
  $('pg-items').addEventListener('dblclick', (e) => {
    const numEl = e.target.closest('.pg-corner-num, .pg-num');
    if (!numEl) return;
    e.preventDefault();
    e.stopPropagation();
    const row = numEl.closest('.pg-item');
    const ev = curEvent();
    const item = ev?.items.find((i) => i.id === row?.dataset.id);
    if (item) editItemOrder(item);
  });

  $('pg-items').addEventListener('click', (e) => {
    const noteEl = e.target.closest('.pg-note');
    const numEl = e.target.closest('.pg-corner-num, .pg-num');
    const btn = e.target.closest('button[data-op]');
    const row = e.target.closest('.pg-item');
    if (!row) return;
    const ev = curEvent();
    const item = ev?.items.find((i) => i.id === row.dataset.id);
    if (!item) return;

    // 单击序号不播放（留给双击改序）
    if (numEl) {
      e.stopPropagation();
      return;
    }
    // 备注文字仅展示，避免误触；只能点「备」按钮编辑
    if (noteEl) {
      e.stopPropagation();
      return;
    }
    if (btn?.dataset.op === 'note') {
      e.stopPropagation();
      editItemNote(item);
      return;
    }
    if (btn?.dataset.op === 'cue' || e.target.closest('.pg-cue')) {
      e.stopPropagation();
      editItemCue(item);
      return;
    }

    if (btn) {
      const op = btn.dataset.op;
      const idx = ev.items.indexOf(item);
      if (op === 'play') {
        // 正在播同一首歌时点 ▶ 改为暂停
        if (item.type === 'audio') {
          const snap = getAudioSnapshot();
          if (snap.path === item.path && snap.playing) {
            toggleAudio();
            syncPlayGoBtn();
            return;
          }
        }
        activate(item);
      } else if (op === 'up' && idx > 0) {
        [ev.items[idx - 1], ev.items[idx]] = [ev.items[idx], ev.items[idx - 1]];
        save(); renderItems({ soft: false }); updateNowBar();
      } else if (op === 'down' && idx < ev.items.length - 1) {
        [ev.items[idx + 1], ev.items[idx]] = [ev.items[idx], ev.items[idx + 1]];
        save(); renderItems({ soft: false }); updateNowBar();
      } else if (op === 'del') {
        ev.items.splice(idx, 1);
        if (activeItemId === item.id) activeItemId = null;
        save(); renderItems({ soft: false }); updateNowBar(); syncAudioBar();
      }
      return;
    }
    // 点缩略图或卡片空白处播放；点文字标题也可
    activate(item);
  });

  $('program-events').addEventListener('click', (e) => {
    const item = e.target.closest('.file-item');
    if (!item) return;
    currentId = item.dataset.id;
    activeItemId = null;
    save();
    renderEvents();
    renderItems();
    updateNowBar();
    syncAudioBar();
    fillLobbyForm();
    syncLobbyRemain();
  });

  fillLobbyForm();
  syncLobbyRemain();
}

function syncAudioBar(forceLabel = false) {
  const bar = $('pg-audio-bar');
  if (!bar) return;
  const item = curEvent()?.items.find((i) => i.id === activeItemId);
  const isAudio = item?.type === 'audio';
  bar.classList.toggle('hidden', !isAudio);
  if (!isAudio) return;

  const snap = getAudioSnapshot();
  const same = snap.path && item.path === snap.path;
  const posEl = $('pg-audio-pos');
  const durEl = $('pg-audio-dur');
  const seek = $('pg-audio-seek');
  const loopBtn = $('pg-audio-loop');
  const dur = same ? snap.duration : 0;
  const pos = same ? snap.pos : 0;

  if (posEl && !seekingAudio) posEl.textContent = fmtClock(pos);
  if (durEl) durEl.textContent = fmtClock(dur);
  if (seek && !seekingAudio) {
    seek.disabled = !dur;
    seek.value = dur ? String(Math.round((pos / dur) * 1000)) : '0';
  }
  if (loopBtn && (forceLabel || loopBtn.dataset.mode !== snap.loopMode)) {
    loopBtn.textContent = getLoopModeLabel();
    loopBtn.dataset.mode = snap.loopMode;
  }
}

let expandLegacyGen = 0;

/** 按条目 id 原地拆页，避免 await 期间用户新加的节目被整表覆盖 */
async function expandLegacyDocs() {
  const gen = ++expandLegacyGen;
  let changed = false;

  for (const ev of events) {
    if (gen !== expandLegacyGen) return;
    if (!Array.isArray(ev.items) || !ev.items.length) continue;

    // 先收集需要拆的 id（快照），再逐个按 id 定位替换
    const legacyIds = ev.items
      .filter((it) => (it.type === 'ppt' || it.type === 'pdf') && (it.page == null || it.pages == null))
      .map((it) => it.id);

    for (const id of legacyIds) {
      if (gen !== expandLegacyGen) return;
      const idx = ev.items.findIndex((x) => x.id === id);
      if (idx < 0) continue; // 等待期间已被用户删除
      const it = ev.items[idx];
      if ((it.type !== 'ppt' && it.type !== 'pdf') || (it.page != null && it.pages != null)) continue;

      try {
        const pages = it.type === 'ppt' ? await pptPages(it.path) : await pdfPages(it.path);
        if (gen !== expandLegacyGen) return;
        // await 后再找一次位置
        const at = ev.items.findIndex((x) => x.id === id);
        if (at < 0) continue;
        if (!pages || pages < 1) continue;

        const base = (it.name || fileName(it.path)).replace(/\s*·\s*\d+\/\d+$/, '').replace(/\.[^.]+$/, '');
        const expanded = [];
        for (let i = 0; i < pages; i++) {
          expanded.push(normalizeItem({
            id: genId(),
            type: it.type,
            path: it.path,
            name: `${base} · ${i + 1}/${pages}`,
            page: i,
            pages,
            note: it.note || '',
            cueTime: it.cueTime || '',
            cueDate: it.cueDate || '',
          }));
        }
        ev.items.splice(at, 1, ...expanded);
        changed = true;
      } catch (err) {
        toast(`拆页失败：${it.name || fileName(it.path)} — ${err}`, 5000);
      }
      // 让出主线程，保持界面流畅
      await new Promise((r) => requestAnimationFrame(() => r()));
    }
  }
  if (changed && gen === expandLegacyGen) save();
}

async function addItems(type) {
  const ev = curEvent();
  if (!ev) return;
  const filters = {
    audio: [{ name: '音频', extensions: AUDIO_EXT }],
    video: [{ name: '视频', extensions: VIDEO_EXT }],
    image: [{ name: '图片', extensions: IMAGE_EXT }],
    ppt: [{ name: 'PowerPoint', extensions: PPT_EXT }],
    pdf: [{ name: 'PDF', extensions: PDF_EXT }],
  }[type];
  const files = await pickFiles(filters, '添加到节目单');
  if (!files.length) return;
  await appendFiles(ev, files, type);
}

async function addMixed() {
  const ev = curEvent();
  if (!ev) return;
  const all = [...AUDIO_EXT, ...VIDEO_EXT, ...IMAGE_EXT, ...PPT_EXT, ...PDF_EXT];
  const files = await pickFiles([{ name: '演出素材', extensions: all }], '混排导入（可多选）');
  if (!files.length) return;
  let n = 0;
  toast('正在导入并拆页…');
  for (const f of files) {
    const type = detectMediaType(f);
    if (!type) {
      toast(`跳过不支持的格式：${fileName(f)}`);
      continue;
    }
    n += await pushMedia(ev, f, type);
  }
  save();
  renderItems();
  updateNowBar();
  toast(`已按顺序加入 ${n} 条节目`);
}

async function appendFiles(ev, files, type) {
  toast(type === 'ppt' || type === 'pdf' ? '正在按页展开…' : '正在添加…');
  let n = 0;
  for (const f of files) n += await pushMedia(ev, f, type);
  save();
  renderItems();
  updateNowBar();
  toast(`已添加 ${n} 条${TYPE_META[type]?.label || ''}节目`);
}

async function pushMedia(ev, path, type) {
  if (type === 'ppt' || type === 'pdf') {
    try {
      const pages = type === 'ppt' ? await pptPages(path) : await pdfPages(path);
      const base = fileName(path).replace(/\.[^.]+$/, '');
      if (!pages) throw new Error('文档没有页面');
      for (let i = 0; i < pages; i++) {
        ev.items.push({
          id: genId(),
          type,
          path,
          name: `${base} · ${i + 1}/${pages}`,
          page: i,
          pages,
          note: '',
        });
      }
      return pages;
    } catch (err) {
      toast(`导入失败：${fileName(path)} — ${err}`, 6000);
      return 0;
    }
  }
  ev.items.push({
    id: genId(),
    type,
    path,
    name: fileName(path).replace(/\.[^.]+$/, ''),
    note: '',
  });
  return 1;
}

function editItemNote(item) {
  if (!item) return;
  const cur = item.note || '';
  const v = window.prompt('节目备注（如：第 2:30 切入 / 说完「欢迎」后起）', cur);
  if (v === null) return;
  item.note = v.trim();
  save({ soft: true });
  renderItems({ soft: true });
  updateNowBar();
  toast(item.note ? '备注已保存' : '已清除备注');
}

/** 双击序号：把本条快速移到指定位置（1-based） */
function editItemOrder(item) {
  const ev = curEvent();
  if (!ev?.items?.length || !item) return;
  const from = ev.items.findIndex((i) => i.id === item.id);
  if (from < 0) return;
  const total = ev.items.length;
  const v = window.prompt(
    `改播放顺序\n当前第 ${from + 1} 条 / 共 ${total} 条\n输入要移到的位置（1–${total}）`,
    String(from + 1),
  );
  if (v === null) return;
  const n = parseInt(String(v).trim(), 10);
  if (!Number.isFinite(n) || n < 1 || n > total) {
    toast(`请输入 1–${total} 之间的整数`);
    return;
  }
  moveItemToIndex(from, n - 1);
}

function moveItemToIndex(from, to) {
  const ev = curEvent();
  if (!ev?.items?.length) return;
  const len = ev.items.length;
  if (from < 0 || from >= len) return;
  to = Math.max(0, Math.min(len - 1, to));
  if (to === from) return;
  const [it] = ev.items.splice(from, 1);
  ev.items.splice(to, 0, it);
  save();
  renderItems();
  updateNowBar();
  toast(`已移到第 ${to + 1} 位`);
}

/** 节目单面板是否可见（列表上的倒计时等仅可见时刷新） */
function programVisible() {
  return !!$('panel-program')?.classList.contains('active');
}

function initProgramDragDrop() {
  const panel = $('panel-program');
  const box = $('pg-items');
  if (!panel || !box) return;

  let dragDepth = 0;
  const setActive = (on) => {
    if (!on) dragDepth = 0;
    panel.classList.toggle('pg-drop-active', on);
    box.classList.toggle('pg-drop-active', on);
  };
  const clearDropStyle = () => setActive(false);

  const ingestPaths = async (paths) => {
    const list = (paths || []).filter(Boolean);
    clearDropStyle();
    if (!list.length) return;
    const tab = document.querySelector('.tab.active')?.dataset.module;
    if (tab && tab !== 'program') {
      document.dispatchEvent(new CustomEvent('sp:switch-module', { detail: 'program' }));
    }
    const ev = curEvent();
    if (!ev) return;
    toast('正在导入拖入的文件…');
    let n = 0;
    try {
      for (const p of list) {
        const type = detectMediaType(p);
        if (!type) {
          toast(`跳过：${fileName(p)}`);
          continue;
        }
        n += await pushMedia(ev, p, type);
      }
      save();
      renderItems();
      updateNowBar();
      toast(n ? `拖拽导入 ${n} 条节目 · 双击左上角序号可改顺序` : '没有可导入的文件');
    } finally {
      clearDropStyle();
    }
  };

  ['dragenter', 'dragover'].forEach((type) => {
    panel.addEventListener(type, (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (type === 'dragenter') dragDepth += 1;
      setActive(true);
    });
  });
  panel.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0 || !panel.contains(e.relatedTarget)) clearDropStyle();
  });
  panel.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    clearDropStyle();
    const files = [...(e.dataTransfer?.files || [])];
    const paths = files.map((f) => f.path || f.name).filter((p) => p && /[\\/]/.test(p));
    // Tauri WebView 的 File 带 path；若只有文件名则等 tauri://drag-drop
    if (paths.length) await ingestPaths(paths);
  });
  // 系统拖放取消 / 失焦时也清掉高亮
  window.addEventListener('dragend', clearDropStyle);
  window.addEventListener('blur', clearDropStyle);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearDropStyle();
  });

  listen('tauri://drag-drop', (e) => {
    clearDropStyle();
    const paths = e.payload?.paths || [];
    if (paths.length) ingestPaths(paths);
  }).catch(() => {});
  listen('tauri://drag-enter', () => {
    if (document.querySelector('.tab.active')?.dataset.module === 'program') setActive(true);
  }).catch(() => {});
  listen('tauri://drag-leave', () => clearDropStyle()).catch(() => {});
  listen('tauri://drag-over', () => {
    if (document.querySelector('.tab.active')?.dataset.module === 'program') setActive(true);
  }).catch(() => {});
}

/** 只更新高亮，避免整表重绘 + 重刷缩略图（切换卡顿主因） */
function paintActiveState() {
  const box = $('pg-items');
  if (!box) return;
  const rows = box.querySelectorAll('.pg-item');
  if (!rows.length) {
    renderItems();
    return;
  }
  const aidx = activeIndex();
  rows.forEach((el, i) => {
    const on = el.dataset.id === activeItemId;
    el.classList.toggle('active', on);
    el.classList.toggle('done', aidx >= 0 && i < aidx);
  });
}

async function activate(item) {
  if (!item) return false;
  const seq = claimOutputSeq();
  activateSeq = seq;
  activeItemId = item.id;
  paintActiveState();
  updateNowBar();
  syncAudioBar(true);
  syncAudioFloat();
  syncPlayGoBtn();
  syncItemRemain();
  scrollActiveIntoView();

  const stay = { stay: true, outputSeq: seq };
  try {
    if (item.type === 'image') {
      if (!pushToOutput({ kind: 'image', src: convertFileSrc(item.path) }, seq)) return false;
    } else if (item.type === 'blank') {
      if (!pushToOutput(blankToOutputPayload(item), seq)) return false;
    } else if (item.type === 'bible') {
      if (!pushToOutput(bibleToOutputPayload(item), seq)) return false;
    } else if (item.type === 'ppt') {
      await pptPlayPage(item.path, item.page ?? 0, stay);
    } else if (item.type === 'pdf') {
      await pdfPlayPage(item.path, item.page ?? 0, stay);
    } else if (item.type === 'audio') {
      // 叠播：只出声，不推音频卡盖掉当前画面；需要标题卡可在音频页手动推
      await Promise.resolve(audioPlay(item.path, { ...stay, pushOutput: false }));
    } else if (item.type === 'video') {
      await Promise.resolve(videoPlay(item.path, stay));
    } else {
      throw new Error('未知类型：' + item.type);
    }
    if (seq !== activateSeq) return false;
    // 冻结时预览已更新但扩展屏未换——对 cue 视为未完成
    if (isOutputFrozen()) return true;
    return true;
  } catch (err) {
    if (seq === activateSeq) toast('播放失败：' + err);
    return false;
  } finally {
    if (seq === activateSeq) {
      syncAudioBar(true);
      syncAudioFloat();
    }
  }
}

/** 播放当前条；若还没选则播第一条。音乐正在播时改为暂停/继续 */
export function programGo() {
  const ev = curEvent();
  if (!ev?.items.length) {
    toast('请先添加节目内容');
    return false;
  }
  let idx = activeIndex();
  if (idx < 0) idx = 0;
  const item = ev.items[idx];
  if (item.type === 'audio') {
    const snap = getAudioSnapshot();
    if (snap.path === item.path) {
      toggleAudio();
      syncPlayGoBtn();
      syncItemRemain();
      return true;
    }
  }
  activate(item);
  return true;
}

function syncPlayGoBtn() {
  const go = $('pg-go');
  if (!go) return;
  const item = curEvent()?.items.find((i) => i.id === activeItemId);
  const snap = getAudioSnapshot();
  const live = item?.type === 'audio' && snap.path === item.path && snap.playing;
  go.textContent = live ? '⏸' : '▶';
  go.title = live ? '暂停（G / 空格）' : '播放当前（G）';
  go.classList.toggle('is-pause', live);
}

/** 列表行上的「还剩多久播完」LED 倒计时 */
function syncItemRemain() {
  const item = curEvent()?.items.find((i) => i.id === activeItemId);
  const snap = getAudioSnapshot();
  document.querySelectorAll('.pg-remain').forEach((el) => {
    const row = el.closest('.pg-item');
    const id = row?.dataset.id;
    const isActiveAudio = item?.type === 'audio' && id === item.id && snap.path === item.path && snap.duration > 0;
    if (!isActiveAudio) {
      if (el.classList.contains('hidden') && !el.dataset.sec) return;
      el.classList.add('hidden');
      el.classList.remove('is-live', 'is-urgent', 'is-paused');
      el.dataset.sec = '';
      return;
    }
    const remainSec = Math.floor(Math.max(0, snap.duration - snap.pos));
    const m = Math.floor(remainSec / 60);
    const s = remainSec % 60;
    el.classList.remove('hidden');
    el.classList.toggle('is-live', !!snap.playing);
    el.classList.toggle('is-paused', !snap.playing);
    el.classList.toggle('is-urgent', snap.playing && remainSec <= 30);
    if (el.dataset.sec === String(remainSec) && el.querySelector('.pg-r-num')) return;
    el.dataset.sec = String(remainSec);
    el.innerHTML = `<span class="pg-r-label">剩余</span><span class="pg-r-num">${m}</span><span class="pg-r-colon">:</span><span class="pg-r-num">${String(s).padStart(2, '0')}</span>`;
  });
}

/** 上一条 / 下一条并立即播放（演出走台核心） */
export function programStep(delta) {
  const ev = curEvent();
  if (!ev?.items.length) {
    toast('请先添加节目内容');
    return false;
  }
  let idx = activeIndex();
  if (idx < 0) idx = delta > 0 ? -1 : 0;
  const next = idx + delta;
  if (next < 0 || next >= ev.items.length) {
    return false;
  }
  activate(ev.items[next]);
  return true;
}

export function programHasItems() {
  return !!curEvent()?.items?.length;
}

export function programActiveType() {
  const ev = curEvent();
  const item = ev?.items.find((i) => i.id === activeItemId);
  return item?.type || null;
}

function updateNowBar() {
  const now = $('pg-now');
  const ev = curEvent();
  if (!now) return;
  if (!ev?.items.length) {
    now.innerHTML = '<span class="pg-now-empty">还没有节目 · 用「混排导入」按演出顺序一次加齐</span>';
    return;
  }
  const idx = activeIndex();
  const total = ev.items.length;
  if (idx < 0) {
    now.innerHTML = `<span class="pg-now-meta">共 ${total} 条</span>
      <span class="pg-now-title">准备就绪 · 点「播放」或按 Enter 开始第 1 条</span>`;
    return;
  }
  const it = ev.items[idx];
  const meta = TYPE_META[it.type] || { label: '?', color: '#888' };
  const next = ev.items[idx + 1];
  const pageHint = (it.type === 'ppt' || it.type === 'pdf') && it.pages
    ? ` · 第 ${(it.page ?? 0) + 1}/${it.pages} 页`
    : it.type === 'blank'
      ? (it.blankKind === 'lyric' ? ` · 歌词段${it.lyricIndex != null ? it.lyricIndex : ''}` : ' · 歌名片')
      : '';
  now.innerHTML = `
    <span class="pg-now-meta" style="color:${meta.color}">${idx + 1} / ${total} · ${meta.label}${pageHint}</span>
    <span class="pg-now-title">${esc(it.name)}</span>
    <span class="pg-now-next">${next ? '下一条：' + esc(next.name) : '（最后一条）'}</span>`;
}

function scrollActiveIntoView() {
  const el = document.querySelector('.pg-item.active');
  // auto：避免 smooth 与输出渲染叠在一起造成卡顿感
  el?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
}

function startRename() {
  const row = $('pg-rename-row');
  row.classList.remove('hidden');
  const input = $('pg-rename-input');
  input.value = curEvent()?.name || '';
  input.focus();
  input.select();
}

function applyRename() {
  const ev = curEvent();
  const v = $('pg-rename-input').value.trim();
  if (ev && v) {
    ev.name = v;
    save();
    renderEvents();
  }
  $('pg-rename-row').classList.add('hidden');
}

function renderEvents() {
  const box = $('program-events');
  if (!box) return;
  box.innerHTML = events.map((e) => `
    <div class="file-item ${e.id === currentId ? 'active' : ''}" data-id="${e.id}">
      <span class="fi-icon">📅</span>
      <span class="fi-name" title="${esc(e.name)}">${esc(e.name)}</span>
      <span class="fi-badge">${(e.items || []).length}项</span>
    </div>`).join('');
}

function setViewMode(mode) {
  if (mode !== 'list' && mode !== 'grid') return;
  if (mode === viewMode) {
    syncViewToggle();
    return;
  }
  // 先取消进行中的缩略图任务，避免旧任务写穿新 DOM
  cancelThumbs();
  viewMode = mode;
  lsSet(LS_VIEW, mode);
  syncViewToggle();
  renderItems({ soft: false });
}

function syncViewToggle() {
  $('pg-view-list')?.classList.toggle('active', viewMode === 'list');
  $('pg-view-grid')?.classList.toggle('active', viewMode === 'grid');
  const bar = $('pg-zoom-bar');
  if (bar) bar.classList.toggle('hidden', viewMode === 'list');
  const zoom = $('pg-zoom');
  if (zoom) zoom.value = String(cardZoom);
  const val = $('pg-zoom-val');
  if (val) val.textContent = String(cardZoom);
}

function setCardZoom(v) {
  cardZoom = Math.min(420, Math.max(140, Number(v) || 260));
  lsSet(LS_ZOOM, cardZoom);
  const zoom = $('pg-zoom');
  if (zoom) zoom.value = String(cardZoom);
  applyCardZoom();
}

function applyCardZoom() {
  const box = $('pg-items');
  if (!box) return;
  // 卡片实际宽度 = 滑条值，整体像右侧预览一样变大变小
  box.style.setProperty('--pg-card-w', `${cardZoom}px`);
  const val = $('pg-zoom-val');
  if (val) val.textContent = String(cardZoom);
  const nearest = [180, 260, 340].reduce((a, b) =>
    (Math.abs(b - cardZoom) < Math.abs(a - cardZoom) ? b : a), 260);
  document.querySelectorAll('.pg-zoom-preset').forEach((btn) => {
    btn.classList.toggle('active', +btn.dataset.zoom === nearest && Math.abs(nearest - cardZoom) < 12);
  });
}

/** 条目顺序未变时只改文案/状态，保留缩略图 DOM */
function trySoftRefreshItems() {
  const ev = curEvent();
  const box = $('pg-items');
  if (!box || !ev) return false;
  const items = Array.isArray(ev.items) ? ev.items : [];
  const rows = [...box.querySelectorAll('.pg-item')];
  if (!items.length || rows.length !== items.length) return false;
  if (!rows.every((r, i) => r.dataset.id === items[i].id)) return false;
  const isGrid = viewMode === 'grid';
  // 列表/网格 DOM 结构不同，不能软刷
  if (isGrid !== rows[0].classList.contains('card')) return false;

  const aidx = activeIndex();
  items.forEach((it, i) => {
    const row = rows[i];
    row.classList.toggle('active', it.id === activeItemId);
    row.classList.toggle('done', aidx >= 0 && i < aidx);
    const meta = TYPE_META[it.type] || { icon: '▪', label: '', color: '#888' };
    const pageBadge = itemPageBadge(it);
    const displayName = String(it.name ?? fileName(it.path || '') ?? '未命名');
    const noteText = (it.note || '').trim();
    const noteShow = noteText || '无备注';

    const numEl = row.querySelector('.pg-corner-num, .pg-num');
    if (numEl && numEl.textContent !== String(i + 1)) numEl.textContent = String(i + 1);

    const nameEl = row.querySelector('.pg-name');
    if (nameEl) {
      const short = isGrid && displayName.length > 28 ? `${displayName.slice(0, 26)}…` : displayName;
      if (nameEl.textContent !== short) nameEl.textContent = short;
      nameEl.title = isGrid
        ? `${displayName}${noteText ? ' · ' + noteText : ''}`
        : (it.path || displayName);
    }

    const noteEl = row.querySelector('.pg-note');
    if (noteEl) {
      noteEl.textContent = noteShow;
      noteEl.title = noteShow;
      noteEl.classList.toggle('has-text', !!noteText);
      noteEl.classList.toggle('is-empty', !noteText);
    }

    const tag = row.querySelector('.pg-corner-tag');
    if (tag) {
      tag.textContent = `${meta.label}${pageBadge ? ' · ' + pageBadge : ''}`;
      tag.style.color = meta.color;
    }
    const pageEl = row.querySelector('.pg-page');
    if (pageEl) pageEl.textContent = pageBadge || '';

    const cue = row.querySelector('.pg-cue');
    if (cue) cue.classList.toggle('hidden', !it.cueTime);
  });
  syncItemRemain();
  syncCueCountdowns();
  syncPlayGoBtn();
  return true;
}

function itemPageBadge(it) {
  if ((it.type === 'ppt' || it.type === 'pdf') && it.pages != null) {
    return `${(it.page ?? 0) + 1}/${it.pages}`;
  }
  if (it.type === 'blank') {
    return it.blankKind === 'lyric' ? `歌词${it.lyricIndex != null ? it.lyricIndex : ''}` : '歌名';
  }
  if (it.type === 'bible') {
    if (it.pageTotal > 1) return `${it.pageIndex || 1}/${it.pageTotal}`;
    return it.ref || '经文';
  }
  return fileExt(it.path);
}

/**
 * 单条节目的 HTML。序号/状态（active、done）与剩余时间由 patchRow / syncItemRemain 补，
 * 因此 itemRowHtml(it, 0, '') 可作为「内容签名」：签名不变的行直接复用 DOM（连同缩略图）
 */
function itemRowHtml(it, i, state, isGrid) {
  const meta = TYPE_META[it.type] || { icon: '▪', label: '', color: '#888' };
  const pageBadge = itemPageBadge(it);
  const noteText = (it.note || '').trim();
  const noteCls = noteText ? 'pg-note has-text' : 'pg-note is-empty';
  const noteShow = noteText || '无备注';
  const displayName = String(it.name ?? fileName(it.path || '') ?? '未命名');
  const remainSlot = it.type === 'audio'
    ? `<span class="pg-remain hidden" title="剩余播放时间"></span>`
    : '';
  const cueSlot = `<span class="pg-cue ${it.cueTime ? '' : 'hidden'}" title="开播倒计时">
      <span class="pg-cue-at"></span>
      <span class="pg-cue-cd"></span>
    </span>`;

  if (isGrid) {
    const shortName = displayName.length > 28 ? `${displayName.slice(0, 26)}…` : displayName;
    // 倒计时/定时放在标题区，避免被缩略图悬停条挡住
    return `
    <div class="pg-item card ${state}" data-id="${it.id}" title="${esc(displayName)}${noteText ? ' · ' + esc(noteText) : ''}">
      <div class="pg-thumb" data-thumb-for="${it.id}">
        <span class="pg-thumb-ph">${meta.icon || '▪'}</span>
        <span class="pg-corner-num" title="双击改顺序">${i + 1}</span>
        <span class="pg-corner-tag" style="color:${meta.color}">${meta.label}${pageBadge ? ' · ' + esc(pageBadge) : ''}</span>
        <div class="pg-hover-bar">
          <button type="button" data-op="play" class="primary" title="播放">▶ 播放</button>
          <button type="button" data-op="cue" title="定时开播">定时</button>
          <button type="button" data-op="note" title="备注">备注</button>
          <button type="button" data-op="up" title="上移">↑</button>
          <button type="button" data-op="down" title="下移">↓</button>
          <button type="button" data-op="del" class="danger" title="删除">删除</button>
        </div>
      </div>
      <div class="pg-caption">
        <div class="pg-caption-row">
          <span class="pg-name">${esc(shortName)}</span>
          ${remainSlot}
          ${cueSlot}
        </div>
        <span class="${noteCls}" title="${esc(noteShow)}">${esc(noteShow)}</span>
      </div>
    </div>`;
  }

  return `
  <div class="pg-item ${state}" data-id="${it.id}">
    <span class="pg-num" title="双击改顺序">${i + 1}</span>
    <span class="pg-type-badge" style="background:${meta.color}22;color:${meta.color};border-color:${meta.color}55">${meta.label}</span>
    <div class="pg-main">
      <span class="pg-name" title="${esc(it.path)}">${esc(displayName)}</span>
      <span class="${noteCls}">${esc(noteShow || '无备注')}</span>
    </div>
    ${cueSlot}
    ${remainSlot}
    <span class="pg-page mono">${esc(pageBadge)}</span>
    <div class="pg-toolbar inline">
      <button type="button" data-op="play" title="播放">▶</button>
      <button type="button" data-op="cue" title="设定开播时间">⏱</button>
      <button type="button" data-op="note" title="编辑备注">备</button>
      <button type="button" data-op="up" title="上移">↑</button>
      <button type="button" data-op="down" title="下移">↓</button>
      <button type="button" data-op="del" class="danger" title="移除">✕</button>
    </div>
  </div>`;
}

/** 只改序号与 active/done 状态（复用行在重排后调用） */
function patchRowPosition(row, it, i, aidx) {
  row.classList.toggle('active', it.id === activeItemId);
  row.classList.toggle('done', aidx >= 0 && i < aidx);
  const numEl = row.querySelector('.pg-corner-num, .pg-num');
  if (numEl && numEl.textContent !== String(i + 1)) numEl.textContent = String(i + 1);
}

function renderItems(opts = {}) {
  const ev = curEvent();
  const box = $('pg-items');
  if (!box) return;
  const items = Array.isArray(ev?.items) ? ev.items : [];
  box.classList.remove('view-list', 'view-grid', 'view-small', 'view-large');
  box.classList.add(`view-${viewMode}`);
  applyCardZoom();
  syncViewToggle();
  if (!ev || !items.length) {
    cancelThumbs();
    box.innerHTML = `<div class="empty-tip big">
      按演出时间顺序添加节目<br/>
      <span style="font-size:13px;opacity:.8">混排导入 · 或直接把音乐/图片/视频/PPT/PDF 拖进这里</span>
    </div>`;
    syncPlayGoBtn();
    return;
  }
  if (opts.soft !== false && trySoftRefreshItems()) return;

  const aidx = activeIndex();
  const isGrid = viewMode === 'grid';
  try {
    // 按 id 复用内容未变的行：增删/排序时不再整表重建，已出的缩略图保留
    const existing = new Map();
    box.querySelectorAll(':scope > .pg-item').forEach((r) => existing.set(r.dataset.id, r));
    const tpl = document.createElement('template');
    const nodes = items.map((it, i) => {
      const sig = itemRowHtml(it, 0, '', isGrid);
      const old = existing.get(it.id);
      if (old && old.dataset.sig === sig) return old;
      const state = it.id === activeItemId ? 'active' : (aidx >= 0 && i < aidx ? 'done' : '');
      tpl.innerHTML = itemRowHtml(it, i, state, isGrid).trim();
      const node = tpl.content.firstElementChild;
      node.dataset.sig = sig;
      return node;
    });
    box.replaceChildren(...nodes);
    items.forEach((it, i) => patchRowPosition(nodes[i], it, i, aidx));
  } catch (err) {
    console.error('renderItems failed', err);
    toast(`列表渲染异常：${err}`, 5000);
    // 保底列表，避免整页空白
    box.classList.remove('view-grid');
    box.classList.add('view-list');
    box.innerHTML = items.map((it, i) => `
      <div class="pg-item" data-id="${it.id}">
        <span class="pg-num">${i + 1}</span>
        <div class="pg-main"><span class="pg-name">${esc(it.name || it.path || '未命名')}</span></div>
      </div>`).join('');
  }
  syncItemRemain();
  syncCueCountdowns();
  syncPlayGoBtn();
  if (isGrid && viewMode === 'grid') fillItemThumbs();
}
