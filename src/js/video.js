// 视频播放模块：目录 + 卡片网格 + 紧凑预览

import { pickFiles, esc, fileName, lsGet, lsSet, fmtTime, fmtTimeLong, toast, VIDEO_EXT } from './util.js';
import { pushToOutput, sendVideoControl, getCurrentOutput } from './output-main.js';
import {
  renderDirList, filterByFolder, folderTitle, addFolder, renameFolder, removeFolder,
  assignPath, listFolders, getSelectedFolder, FOLDER_UNCAT,
  getDisplayName, promptRenameMedia, bindViewZoom, getMediaNote, setMediaNote,
} from './media-library.js';

const LS_KEY = 'sp.video.list';

let videos = lsGet(LS_KEY, []);
let current = -1;
let videoSearch = '';
/** path → 秒 */
const durCache = new Map();
let durProbeToken = 0;

const $ = (id) => document.getElementById(id);
const convertSrc = (p) => window.__TAURI__.core.convertFileSrc(p);

function nameOf(p) {
  return getDisplayName(p, fileName(p).replace(/\.[^.]+$/, ''));
}

function cardLabel(path) {
  const base = nameOf(path);
  if (/\.[a-z0-9]+$/i.test(base)) return base;
  const ext = (path.match(/\.[^.]+$/) || [''])[0];
  return base + ext;
}

function videoItems() {
  return videos.map((path) => ({ path, name: nameOf(path) }));
}

function renameVideoItem(path) {
  if (!path) return;
  const n = promptRenameMedia(path, nameOf(path));
  if (n == null) return;
  if (n === false) return toast('名称不能为空');
  renderList();
  toast('已重命名');
}

function visibleVideos() {
  let items = filterByFolder('video', videoItems());
  const q = videoSearch.trim().toLowerCase();
  if (q) {
    items = items.filter((it) =>
      it.name.toLowerCase().includes(q)
      || it.path.toLowerCase().includes(q)
      || cardLabel(it.path).toLowerCase().includes(q));
  }
  return items;
}

function durationOf(path) {
  if (!path) return 0;
  return durCache.get(path) || 0;
}

function paintCardDuration(path, sec) {
  const list = $('video-song-list');
  if (!list || !path) return;
  list.querySelectorAll('.video-card').forEach((card) => {
    if (card.dataset.path !== path) return;
    const el = card.querySelector('.audio-card-dur');
    if (el) el.textContent = fmtTimeLong(sec);
  });
}

function scheduleDurProbe(paths) {
  const token = ++durProbeToken;
  const need = (paths || []).filter((p) => p && !durationOf(p));
  if (!need.length) return;
  let i = 0;
  const next = () => {
    if (token !== durProbeToken) return;
    if (i >= need.length) return;
    const path = need[i++];
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    const finish = () => {
      try {
        const d = v.duration;
        if (Number.isFinite(d) && d > 0) {
          durCache.set(path, d);
          paintCardDuration(path, d);
        }
      } catch { /* ignore */ }
      v.removeAttribute('src');
      v.load?.();
      const ric = window.requestIdleCallback || ((cb) => setTimeout(cb, 16));
      ric(() => next());
    };
    v.addEventListener('loadedmetadata', finish, { once: true });
    v.addEventListener('error', finish, { once: true });
    try { v.src = convertSrc(path); } catch { finish(); }
  };
  setTimeout(next, 0);
}

function fillMoveSelect() {
  const sel = $('video-move-folder');
  if (!sel) return;
  const folders = listFolders('video');
  sel.innerHTML = `<option value="">移入目录…</option>`
    + `<option value="${FOLDER_UNCAT}">未分类</option>`
    + folders.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('');
}

function volumePct() {
  return Math.round(+($('video-volume')?.value || 0.9) * 100);
}

function paintVideoActive() {
  const list = $('video-song-list') || $('video-list');
  if (!list) return;
  const preview = $('video-preview');
  const playing = preview && !preview.paused && current >= 0;
  const vol = volumePct();
  list.querySelectorAll('.video-card').forEach((card) => {
    const idx = +card.dataset.i;
    const on = idx === current;
    card.classList.toggle('active', on);
    card.classList.toggle('playing', on && playing);
    const volEl = card.querySelector('.audio-card-vol');
    if (volEl) volEl.textContent = `🔊 ${vol}`;
    const go = card.querySelector('.audio-card-go');
    if (go) go.textContent = on && playing ? '⏸' : '⇥';
  });
  const title = $('video-folder-title');
  if (title) title.textContent = folderTitle('video');
  const count = $('video-card-count');
  if (count) count.textContent = `[${visibleVideos().length}]`;
}

function renderList() {
  renderDirList($('video-dirs'), 'video', videoItems(), () => renderList());
  const title = $('video-folder-title');
  if (title) title.textContent = folderTitle('video');
  fillMoveSelect();

  const list = $('video-song-list') || $('video-list');
  if (!list) return;
  const items = visibleVideos();
  const count = $('video-card-count');
  if (count) count.textContent = `[${items.length}]`;
  if (!items.length) {
    list.innerHTML = '<div class="empty-tip">此目录暂无视频<br/><span style="font-size:12px;opacity:.75">点上方导入添加</span></div>';
    return;
  }
  const preview = $('video-preview');
  const playing = preview && !preview.paused && current >= 0;
  const vol = volumePct();
  list.innerHTML = items.map((it) => {
    const idx = videos.indexOf(it.path);
    const on = idx === current;
    const label = cardLabel(it.path);
    const dur = durationOf(it.path);
    const note = getMediaNote(it.path).trim();
    const tip = note ? `${label} · ${note}` : label;
    return `
    <div class="audio-card video-card ${on ? 'active' : ''} ${on && playing ? 'playing' : ''}"
         data-i="${idx}" data-path="${esc(it.path)}" title="${esc(tip)}">
      <div class="audio-card-body">
        <span class="audio-card-vol">🔊 ${vol}</span>
        <button type="button" class="audio-card-rename" data-act="rename" title="重命名显示名">✎</button>
        <button type="button" class="audio-card-go" data-push="${idx}" title="推送到输出">${on && playing ? '⏸' : '⇥'}</button>
        <div class="audio-card-name">${esc(label)}</div>
        ${note ? `<div class="audio-card-note" title="${esc(note)}">📝 ${esc(note)}</div>` : ''}
      </div>
      <div class="audio-card-foot">
        <span class="audio-card-dur mono">${dur > 0 ? fmtTimeLong(dur) : '--:--:--'}</span>
      </div>
    </div>`;
  }).join('');
  scheduleDurProbe(items.map((it) => it.path));
}

function setPreviewTitle(path) {
  const el = $('video-preview-title');
  if (!el) return;
  el.textContent = path ? cardLabel(path) : '未选择视频';
  el.title = path || '';
}

function fillVideoNote(path) {
  const el = $('video-note');
  if (!el) return;
  el.value = path ? getMediaNote(path) : '';
}

function saveVideoNote() {
  if (current < 0 || !videos[current]) return toast('请先选中一个视频');
  const path = videos[current];
  const note = ($('video-note')?.value || '').trim();
  setMediaNote(path, note);
  renderList();
  toast(note ? '备注已保存' : '已清除备注');
}

function loadInPreview(i, autoplay = false) {
  const preview = $('video-preview');
  if (!preview || i < 0 || i >= videos.length) return;
  current = i;
  setPreviewTitle(videos[i]);
  fillVideoNote(videos[i]);
  preview.src = convertSrc(videos[i]);
  preview.muted = true;
  if (autoplay) preview.play().catch(() => {});
  else preview.pause();
  updatePlayBtn();
  paintVideoActive();
  // 预览加载后补时长
  const onMeta = () => {
    const d = preview.duration;
    if (Number.isFinite(d) && d > 0) {
      durCache.set(videos[i], d);
      paintCardDuration(videos[i], d);
    }
  };
  preview.addEventListener('loadedmetadata', onMeta, { once: true });
}

function pushCurrent(outputSeq) {
  if (current < 0) return false;
  const preview = $('video-preview');
  const vol = $('video-volume');
  const ok = pushToOutput({
    kind: 'video',
    path: videos[current],
    autoplay: true,
    volume: vol ? +vol.value : 0.9,
    startAt: preview?.currentTime || 0,
  }, outputSeq) !== false;
  if (!ok) return false;
  const btnPush = $('video-push');
  if (btnPush) {
    btnPush.textContent = '已在输出播放';
    setTimeout(() => (btnPush.textContent = '推送到输出'), 1200);
  }
  if (preview) {
    preview.muted = true;
    preview.play().catch(() => {});
  }
  updatePlayBtn();
  paintVideoActive();
  return true;
}

let lastPreviewPlaying = null;
function updatePlayBtn() {
  const btn = $('video-play');
  const preview = $('video-preview');
  if (!btn || !preview) return;
  const playing = !preview.paused;
  btn.textContent = playing ? '⏸' : '▶';
  if (playing !== lastPreviewPlaying) {
    lastPreviewPlaying = playing;
    paintVideoActive();
  }
}

function currentModule() {
  return document.querySelector('.tab.active')?.dataset.module;
}

export function initVideo() {
  const preview = $('video-preview');
  const list = $('video-song-list') || $('video-list');
  const btnPlay = $('video-play');
  const btnPush = $('video-push');
  const btnStop = $('video-stop');
  const vol = $('video-volume');
  const bar = $('video-bar');
  const fill = $('video-bar-fill');
  const timeEl = $('video-time');

  // 旧版过小预览（如 120）自动抬到默认，避免监视器条太空
  const savedH = lsGet('sp.ui.videoSize', 200);
  if (typeof savedH === 'number' && savedH < 160) lsSet('sp.ui.videoSize', 200);
  bindViewZoom('video', { def: 200 });
  bindViewZoom('videoCard', { def: 176 });
  renderList();
  // 与 PPT/PDF 一致：有列表时自动选中第一条，避免「有数量却未选择」
  if (videos.length) {
    if (current < 0 || current >= videos.length) loadInPreview(0, false);
    else {
      setPreviewTitle(videos[current]);
      fillVideoNote(videos[current]);
    }
  } else {
    setPreviewTitle(null);
    fillVideoNote(null);
  }

  $('video-note-save')?.addEventListener('click', () => saveVideoNote());
  $('video-note')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveVideoNote();
    }
  });

  list?.addEventListener('click', (e) => {
    const pushBtn = e.target.closest('[data-push]');
    if (pushBtn) {
      const i = +pushBtn.dataset.push;
      loadInPreview(i, false);
      pushCurrent();
      e.stopPropagation();
      return;
    }
    const renameBtn = e.target.closest('[data-act="rename"]');
    const item = e.target.closest('.video-card, .song-row, .file-item');
    if (renameBtn && item?.dataset.path) {
      renameVideoItem(item.dataset.path);
      return;
    }
    if (item) loadInPreview(+item.dataset.i, true);
  });

  $('video-search')?.addEventListener('input', (e) => {
    videoSearch = e.target.value || '';
    renderList();
  });
  $('video-dir-add')?.addEventListener('click', () => {
    const name = window.prompt('新建目录名称', '宣教视频');
    if (name == null) return;
    if (addFolder('video', name)) { renderList(); toast('已创建目录'); }
    else toast('目录名无效或已存在');
  });
  $('video-dir-rename')?.addEventListener('click', () => {
    const id = getSelectedFolder('video');
    if (id === '__all__' || id === FOLDER_UNCAT) return toast('请先选中自定义目录');
    const cur = listFolders('video').find((f) => f.id === id);
    const name = window.prompt('重命名目录', cur?.name || '');
    if (name == null) return;
    if (renameFolder('video', id, name)) renderList();
  });
  $('video-dir-del')?.addEventListener('click', () => {
    const id = getSelectedFolder('video');
    if (id === '__all__' || id === FOLDER_UNCAT) return toast('请先选中自定义目录');
    if (!window.confirm('删除此目录？视频会回到未分类')) return;
    removeFolder('video', id);
    renderList();
  });
  $('video-move-folder')?.addEventListener('change', (e) => {
    const fid = e.target.value;
    if (!fid || current < 0) { e.target.value = ''; return; }
    assignPath('video', videos[current], fid === FOLDER_UNCAT ? null : fid);
    e.target.value = '';
    renderList();
  });

  preview.addEventListener('timeupdate', () => {
    timeEl.textContent = `${fmtTime(preview.currentTime)} / ${fmtTime(preview.duration || 0)}`;
    fill.style.width = (preview.duration ? (preview.currentTime / preview.duration) * 100 : 0) + '%';
    updatePlayBtn();
  });

  preview.addEventListener('play', () => {
    updatePlayBtn();
    if (getCurrentOutput().kind === 'video') sendVideoControl('play');
  });
  preview.addEventListener('pause', () => {
    updatePlayBtn();
    if (getCurrentOutput().kind === 'video' && !preview.ended) sendVideoControl('pause');
  });
  preview.addEventListener('ended', () => {
    updatePlayBtn();
    if (getCurrentOutput().kind === 'video') sendVideoControl('pause');
  });

  btnPlay.addEventListener('click', () => {
    if (current < 0 && videos.length) return loadInPreview(0, true);
    if (preview.paused) preview.play().catch(() => {});
    else preview.pause();
  });

  btnPush.addEventListener('click', () => pushCurrent());
  btnStop.addEventListener('click', () => {
    preview.pause();
    sendVideoControl('stop');
    pushToOutput({ kind: 'clear' });
    updatePlayBtn();
  });

  vol.addEventListener('input', () => {
    sendVideoControl('volume', +vol.value);
    paintVideoActive();
  });

  bar.addEventListener('click', (e) => {
    if (!preview.duration) return;
    const r = bar.getBoundingClientRect();
    const t = ((e.clientX - r.left) / r.width) * preview.duration;
    preview.currentTime = t;
    if (getCurrentOutput().kind === 'video') sendVideoControl('seek', t);
  });

  document.addEventListener('sp:import-video', async () => {
    const files = await pickFiles([{ name: '视频', extensions: VIDEO_EXT }], '导入视频');
    if (!files.length) return;
    videos.push(...files);
    lsSet(LS_KEY, videos);
    renderList();
    if (current < 0) loadInPreview(0, false);
  });

  document.addEventListener('sp:clear-list', () => {
    if (currentModule() !== 'video') return;
    videos = [];
    lsSet(LS_KEY, videos);
    preview.pause();
    preview.removeAttribute('src');
    preview.load();
    current = -1;
    setPreviewTitle(null);
    fillVideoNote(null);
    sendVideoControl('stop');
    pushToOutput({ kind: 'clear' });
    timeEl.textContent = '00:00 / 00:00';
    fill.style.width = '0%';
    updatePlayBtn();
    renderList();
  });
}

/** 节目单/外部调用；opts.stay=true 时不切换 Tab */
export function playByPath(path, opts = {}) {
  if (!opts.stay) {
    document.dispatchEvent(new CustomEvent('sp:switch-module', { detail: 'video' }));
  }
  let i = videos.indexOf(path);
  if (i < 0) {
    videos.push(path);
    lsSet(LS_KEY, videos);
    i = videos.length - 1;
  }
  loadInPreview(i, false);
  if (pushCurrent(opts.outputSeq) === false) {
    throw new Error('输出已被更新的节目取代');
  }
}
