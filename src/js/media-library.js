// 媒体库目录：音频/视频/PPT/PDF 共用「左目录 · 中列表」

import { lsGet, lsSet, esc, fileName } from './util.js';

const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const ALL = '__all__';
const UNCAT = '__uncat__';
const LABELS_KEY = 'sp.media.labels';
const NOTES_KEY = 'sp.media.notes';

export { ALL as FOLDER_ALL, UNCAT as FOLDER_UNCAT };

/** 显示名（不改磁盘）；优先自定义标签 */
export function getDisplayName(path, fallback = '') {
  if (!path) return fallback || '';
  const labels = lsGet(LABELS_KEY, {}) || {};
  const n = labels[path];
  if (n != null && String(n).trim()) return String(n).trim();
  if (fallback) return fallback;
  return fileName(path).replace(/\.[^.]+$/, '');
}

export function setDisplayName(path, name) {
  if (!path) return false;
  const labels = { ...(lsGet(LABELS_KEY, {}) || {}) };
  const n = String(name || '').trim();
  if (!n) delete labels[path];
  else labels[path] = n;
  return lsSet(LABELS_KEY, labels);
}

/** 媒体备注（音频/视频开播提示等） */
export function getMediaNote(path) {
  if (!path) return '';
  const notes = lsGet(NOTES_KEY, {}) || {};
  const n = notes[path];
  return n != null ? String(n) : '';
}

export function setMediaNote(path, note) {
  if (!path) return false;
  const notes = { ...(lsGet(NOTES_KEY, {}) || {}) };
  const n = String(note || '').trim();
  if (!n) delete notes[path];
  else notes[path] = n;
  return lsSet(NOTES_KEY, notes);
}

/** @returns {string|null|false} 新名 / 取消 / 空名 */
export function promptRenameMedia(path, currentName) {
  const cur = currentName || getDisplayName(path);
  const name = window.prompt('重命名（仅改显示名，不改磁盘文件）', cur);
  if (name == null) return null;
  const n = String(name).trim();
  if (!n) return false;
  setDisplayName(path, n);
  return n;
}

function sizeKey(kind) {
  return `sp.ui.${kind}Size`;
}

/** PPT/PDF 缩略图列宽、视频预览高度 */
export function getViewSize(kind, def = 180) {
  return Math.min(420, Math.max(120, Number(lsGet(sizeKey(kind), def)) || def));
}

export function applyViewSize(kind, n) {
  const size = n ?? getViewSize(kind);
  if (kind === 'ppt') {
    document.getElementById('ppt-grid')?.style.setProperty('--slide-thumb-min', `${size}px`);
  } else if (kind === 'pdf') {
    document.getElementById('pdf-grid')?.style.setProperty('--slide-thumb-min', `${size}px`);
  } else if (kind === 'video') {
    document.querySelector('#panel-video .video-wrap')?.style.setProperty('--video-preview-h', `${size}px`);
  } else if (kind === 'videoCard') {
    document.getElementById('video-song-list')?.style.setProperty('--audio-card-w', `${size}px`);
  } else if (kind === 'audio') {
    document.getElementById('audio-song-list')?.style.setProperty('--audio-card-w', `${size}px`);
  }
  const idBase = kind === 'videoCard' ? 'video-card' : kind;
  const val = document.getElementById(`${idBase}-zoom-val`);
  if (val) val.textContent = String(size);
  const range = document.getElementById(`${idBase}-zoom`);
  if (range && +range.value !== size) range.value = String(size);
  return size;
}

export function setViewSize(kind, v, def = 180) {
  const n = Math.min(420, Math.max(120, Number(v) || def));
  lsSet(sizeKey(kind), n);
  applyViewSize(kind, n);
  return n;
}

/** 绑定大小滑条；onChange 在松手/停顿后触发（便于 PDF 重渲） */
export function bindViewZoom(kind, { def = 180, onChange } = {}) {
  const idBase = kind === 'videoCard' ? 'video-card' : kind;
  const range = document.getElementById(`${idBase}-zoom`);
  applyViewSize(kind, getViewSize(kind, def));
  if (!range) return;
  range.min = '120';
  range.max = '420';
  range.value = String(getViewSize(kind, def));
  let t = 0;
  range.addEventListener('input', () => {
    applyViewSize(kind, +range.value);
    clearTimeout(t);
    t = setTimeout(() => {
      const n = setViewSize(kind, +range.value, def);
      onChange?.(n);
    }, 140);
  });
}

function keyOf(kind) {
  return `sp.lib.${kind}`;
}

function load(kind) {
  const raw = lsGet(keyOf(kind), null);
  if (raw && Array.isArray(raw.folders)) {
    return {
      folders: raw.folders,
      assign: raw.assign && typeof raw.assign === 'object' ? raw.assign : {},
      selected: raw.selected || ALL,
    };
  }
  return { folders: [], assign: {}, selected: ALL };
}

function save(kind, state) {
  return lsSet(keyOf(kind), {
    folders: state.folders,
    assign: state.assign,
    selected: state.selected,
  });
}

/** @returns {{ folders, assign, selected }} */
export function getLib(kind) {
  return load(kind);
}

export function getSelectedFolder(kind) {
  return load(kind).selected || ALL;
}

export function setSelectedFolder(kind, folderId) {
  const st = load(kind);
  st.selected = folderId || ALL;
  save(kind, st);
  return st.selected;
}

export function listFolders(kind) {
  return load(kind).folders.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export function addFolder(kind, name) {
  const st = load(kind);
  const n = String(name || '').trim() || `目录 ${st.folders.length + 1}`;
  if (st.folders.some((f) => f.name === n)) return null;
  const folder = { id: genId(), name: n, order: st.folders.length };
  st.folders.push(folder);
  st.selected = folder.id;
  save(kind, st);
  return folder;
}

export function renameFolder(kind, folderId, name) {
  const st = load(kind);
  const f = st.folders.find((x) => x.id === folderId);
  if (!f) return false;
  const n = String(name || '').trim();
  if (!n) return false;
  f.name = n;
  save(kind, st);
  return true;
}

export function removeFolder(kind, folderId) {
  const st = load(kind);
  st.folders = st.folders.filter((f) => f.id !== folderId);
  for (const [path, fid] of Object.entries(st.assign)) {
    if (fid === folderId) delete st.assign[path];
  }
  if (st.selected === folderId) st.selected = ALL;
  save(kind, st);
  return true;
}

export function assignPath(kind, path, folderId) {
  const st = load(kind);
  if (!path) return false;
  if (!folderId || folderId === UNCAT || folderId === ALL) {
    delete st.assign[path];
  } else {
    st.assign[path] = folderId;
  }
  save(kind, st);
  return true;
}

export function folderOfPath(kind, path) {
  return load(kind).assign[path] || null;
}

/** 按当前选中目录过滤条目；items 需含 path */
export function filterByFolder(kind, items) {
  const st = load(kind);
  const sel = st.selected || ALL;
  const list = Array.isArray(items) ? items : [];
  if (sel === ALL) return list;
  if (sel === UNCAT) return list.filter((it) => !st.assign[it.path]);
  return list.filter((it) => st.assign[it.path] === sel);
}

export function countInFolder(kind, folderId, items) {
  const st = load(kind);
  const list = Array.isArray(items) ? items : [];
  if (folderId === ALL) return list.length;
  if (folderId === UNCAT) return list.filter((it) => !st.assign[it.path]).length;
  return list.filter((it) => st.assign[it.path] === folderId).length;
}

/**
 * 渲染左侧目录
 * @param {HTMLElement} el
 * @param {string} kind
 * @param {object[]} items 含 path
 * @param {(folderId:string)=>void} onSelect
 */
export function renderDirList(el, kind, items, onSelect) {
  if (!el) return;
  const st = load(kind);
  const sel = st.selected || ALL;
  const folders = listFolders(kind);
  const rows = [];

  rows.push({
    id: ALL,
    label: '全部',
    icon: '▣',
    count: countInFolder(kind, ALL, items),
  });
  for (const f of folders) {
    rows.push({
      id: f.id,
      label: f.name,
      icon: '📁',
      count: countInFolder(kind, f.id, items),
      folder: true,
    });
  }
  rows.push({
    id: UNCAT,
    label: '未分类',
    icon: '○',
    count: countInFolder(kind, UNCAT, items),
  });

  el.innerHTML = rows.map((r) => `
    <div class="dir-item ${r.id === sel ? 'active' : ''}" data-folder="${esc(r.id)}" title="${esc(r.label)} · ${r.count} 个文件">
      <span class="dir-icon">${r.icon}</span>
      <span class="dir-name">${esc(r.label)}</span>
      <span class="dir-count" title="文件数（不是页数）">${r.count}</span>
    </div>`).join('');

  el.querySelectorAll('.dir-item').forEach((node) => {
    node.addEventListener('click', () => {
      const id = node.dataset.folder;
      setSelectedFolder(kind, id);
      onSelect?.(id);
    });
  });
}

export function folderTitle(kind) {
  const st = load(kind);
  if (st.selected === ALL) return '全部';
  if (st.selected === UNCAT) return '未分类';
  return st.folders.find((f) => f.id === st.selected)?.name || '全部';
}
