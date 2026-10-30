// 节目单 · 空白歌曲页 / 整首歌词组 添加面板

import { pickFiles, fileName, toast, IMAGE_EXT } from './util.js';
import { createBlankItem, buildSongBlankSet } from './blank-page.js';

const $ = (id) => document.getElementById(id);

// 由 program.js 注入的宿主回调（避免与 program.js 循环引用）
let curEvent, renderItems, save, updateNowBar;

export function bindBlankHost(h) {
  ({ curEvent, renderItems, save, updateNowBar } = h);
}

export function hideBlankPanels() {
  $('pg-blank-panel')?.classList.add('hidden');
  $('pg-songset-panel')?.classList.add('hidden');
  $('pg-bible-panel')?.classList.add('hidden');
  $('pg-add-blank')?.classList.remove('active');
  $('pg-add-songset')?.classList.remove('active');
  $('pg-add-bible')?.classList.remove('active');
}

export function hideLobbyPanel() {
  $('pg-lobby-panel')?.classList.add('hidden');
  $('pg-lobby-toggle')?.classList.remove('active');
}

function syncBlankKindFields() {
  const kind = $('pg-blank-kind')?.value || 'title';
  const isLyric = kind === 'lyric';
  $('pg-blank-sub-wrap')?.classList.toggle('hidden', isLyric);
  $('pg-blank-body-wrap')?.classList.toggle('hidden', !isLyric);
}

function readBlankForm() {
  return {
    blankKind: $('pg-blank-kind')?.value === 'lyric' ? 'lyric' : 'title',
    title: ($('pg-blank-title')?.value || '').trim(),
    subtitle: ($('pg-blank-sub')?.value || '').trim(),
    body: ($('pg-blank-body')?.value || '').trim(),
    accent: $('pg-blank-accent')?.value || '#e8c56a',
    bgPreset: $('pg-blank-preset')?.value || 'auto',
    bgImage: $('pg-blank-bgimg')?.dataset.path || '',
  };
}

function addBlankFromForm() {
  const ev = curEvent();
  if (!ev) return;
  const f = readBlankForm();
  if (!f.title) {
    toast('请填写主标题 / 歌名');
    return;
  }
  if (f.blankKind === 'lyric' && !f.body) {
    toast('请填写这一段歌词正文');
    return;
  }
  const item = createBlankItem(f);
  ev.items.push(item);
  save();
  renderItems();
  updateNowBar();
  toast(`已加入空白页：${item.name}`);
}

function addSongSetFromForm() {
  const ev = curEvent();
  if (!ev) return;
  const title = ($('pg-songset-title')?.value || '').trim();
  if (!title) {
    toast('请填写歌名');
    return;
  }
  const items = buildSongBlankSet({
    title,
    subtitle: ($('pg-songset-sub')?.value || '').trim(),
    lyrics: $('pg-songset-lyrics')?.value || '',
    accent: $('pg-songset-accent')?.value || '#e8c56a',
    bgPreset: $('pg-songset-preset')?.value || 'auto',
    bgImage: $('pg-songset-bgimg')?.dataset.path || '',
  });
  if (items.length <= 1) {
    toast('未检测到歌词段落（请用空行分段）；已加入歌名片');
  }
  ev.items.push(...items);
  save();
  renderItems();
  updateNowBar();
  toast(`已加入 ${items.length} 页（歌名片 + 歌词）`);
  $('pg-songset-panel')?.classList.add('hidden');
  $('pg-add-songset')?.classList.remove('active');
}

async function pickBlankBg(inputId) {
  const files = await pickFiles([{ name: '图片', extensions: IMAGE_EXT }], '选择空白页背景图');
  if (!files.length) return;
  const el = $(inputId);
  if (!el) return;
  el.dataset.path = files[0];
  el.value = fileName(files[0]);
}

function clearBlankBg(inputId) {
  const el = $(inputId);
  if (!el) return;
  el.dataset.path = '';
  el.value = '';
}

export function initBlankPanels() {
  $('pg-add-blank')?.addEventListener('click', () => {
    const panel = $('pg-blank-panel');
    if (!panel) return;
    const show = panel.classList.contains('hidden');
    hideLobbyPanel();
    hideBlankPanels();
    panel.classList.toggle('hidden', !show);
    $('pg-add-blank')?.classList.toggle('active', show);
    if (show) syncBlankKindFields();
  });
  $('pg-add-songset')?.addEventListener('click', () => {
    const panel = $('pg-songset-panel');
    if (!panel) return;
    const show = panel.classList.contains('hidden');
    hideLobbyPanel();
    hideBlankPanels();
    panel.classList.toggle('hidden', !show);
    $('pg-add-songset')?.classList.toggle('active', show);
  });
  $('pg-blank-kind')?.addEventListener('change', syncBlankKindFields);
  $('pg-blank-cancel')?.addEventListener('click', () => {
    $('pg-blank-panel')?.classList.add('hidden');
    $('pg-add-blank')?.classList.remove('active');
  });
  $('pg-blank-add')?.addEventListener('click', () => addBlankFromForm());
  $('pg-blank-bgimg-pick')?.addEventListener('click', () => pickBlankBg('pg-blank-bgimg'));
  $('pg-blank-bgimg-clear')?.addEventListener('click', () => clearBlankBg('pg-blank-bgimg'));
  $('pg-songset-cancel')?.addEventListener('click', () => {
    $('pg-songset-panel')?.classList.add('hidden');
    $('pg-add-songset')?.classList.remove('active');
  });
  $('pg-songset-add')?.addEventListener('click', () => addSongSetFromForm());
  $('pg-songset-bgimg-pick')?.addEventListener('click', () => pickBlankBg('pg-songset-bgimg'));
  $('pg-songset-bgimg-clear')?.addEventListener('click', () => clearBlankBg('pg-songset-bgimg'));
  syncBlankKindFields();
}
