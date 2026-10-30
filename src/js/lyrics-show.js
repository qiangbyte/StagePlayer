// 歌词投屏模块：歌词库 + 逐行控制 + 段落快速跳转（副歌 / 主歌 / 桥段 …）
// 敬拜现场领唱随时可能转副歌：一个键就能切过去，大屏平滑滚动

import {
  pickFiles, esc, fileName, lsGet, lsSet, toast, convertFileSrc, invoke, IMAGE_EXT, VIDEO_EXT,
} from './util.js';
import { pushToOutput, claimOutputSeq, getCurrentOutput } from './output-main.js';
import { renderOutput } from './output-core.js';
import {
  parseLyricSheet, paletteFromColor, hslToHex, LSHOW_SWATCHES, defaultLshowBg,
} from './lyrics-show-render.js';

const LS_SONGS = 'sp.lyrics.songs';
const LS_STYLE = 'sp.lyrics.style';
const LS_CUR = 'sp.lyrics.current';

const $ = (id) => document.getElementById(id);
const genId = () => 'ly' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const SEC_KEYS = { chorus: 'C', verse: 'V', bridge: 'Q', pre: 'P', ending: 'E' };

let songs = (lsGet(LS_SONGS, []) || []).filter((s) => s && s.id);
let style = { view: 'scroll', step: 1, scale: 1, showLabel: true, showTitle: false, ...(lsGet(LS_STYLE, {}) || {}) };
let curId = lsGet(LS_CUR, null);
/** 正在控制的歌（可能来自节目单快照，不在歌词库里） */
let song = null;
let sheet = { lines: [], secOf: [], sections: [] };
let active = 0;
let filter = '';

function saveSongs() { lsSet(LS_SONGS, songs); }
function saveStyle() { lsSet(LS_STYLE, style); }
function libSong(id) { return songs.find((s) => s.id === id) || null; }
function lastBg() {
  const s = [...songs].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  return { ...defaultLshowBg(), ...(s?.bg || {}) };
}

// ---------- 载入 / 导航 ----------

function loadSong(s, at = 0) {
  song = s;
  sheet = parseLyricSheet(s?.text || '');
  active = Math.min(Math.max(0, at), Math.max(0, sheet.lines.length - 1));
  if (s && libSong(s.id)) {
    curId = s.id;
    lsSet(LS_CUR, curId);
  }
  renderList();
  renderEditor();
  renderLines();
  renderMini();
}

function isLive() {
  const out = getCurrentOutput();
  return out?.kind === 'lyricshow' && !!song && out.songId === song.id;
}

function payload() {
  return {
    kind: 'lyricshow',
    songId: song.id,
    title: song.title || '',
    lines: sheet.lines,
    secOf: sheet.secOf,
    sections: sheet.sections,
    active,
    step: style.step === 2 ? 2 : 1,
    view: style.view === 'stanza' ? 'stanza' : 'scroll',
    bg: { ...defaultLshowBg(), ...(song.bg || {}) },
    style: { scale: style.scale, showLabel: style.showLabel, showTitle: style.showTitle },
  };
}

function push(seq) {
  if (!song || !sheet.lines.length) {
    toast('这首歌还没有歌词');
    return false;
  }
  return pushToOutput(payload(), seq ?? claimOutputSeq()) !== false;
}

function go(i, { send = true } = {}) {
  if (!sheet.lines.length) return false;
  active = Math.min(Math.max(0, i), sheet.lines.length - 1);
  paintLines();
  renderMini();
  if (send) push();
  return true;
}

function secAt(i) { return sheet.sections[sheet.secOf[i] | 0]; }

function next() {
  if (!sheet.lines.length) return false;
  if (style.step === 2) {
    const sec = secAt(active);
    const n = active + 2;
    if (sec && n < sec.end) return go(n);
    const ns = sheet.sections[(sheet.secOf[active] | 0) + 1];
    return ns ? go(ns.start) : go(active);
  }
  return go(active + 1);
}

function prev() {
  if (!sheet.lines.length) return false;
  if (style.step === 2) {
    const sec = secAt(active);
    if (sec && active - 2 >= sec.start) return go(active - 2);
    const ps = sheet.sections[(sheet.secOf[active] | 0) - 1];
    if (!ps) return go(sec ? sec.start : 0);
    return go(ps.start + Math.floor((ps.end - ps.start - 1) / 2) * 2);
  }
  return go(active - 1);
}

/** 跳到下一个该类型的段落（连按依次轮换），没有则提示 */
function jumpType(type) {
  const idx = sheet.sections.map((s, i) => (s.type === type ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) {
    const label = { chorus: '副歌', verse: '主歌', bridge: '桥段', pre: '预副歌', ending: '尾声' }[type] || type;
    toast(`这首歌没有标记「${label}」段落`);
    return false;
  }
  const cur = sheet.secOf[active] | 0;
  const target = idx.find((i) => i > cur) ?? idx[0];
  return go(sheet.sections[target].start);
}

function jumpSection(n) {
  const s = sheet.sections[n];
  return s ? go(s.start) : false;
}

// ---------- 快捷键 ----------

function letterJump(e) {
  const k = e.key.length === 1 ? e.key.toUpperCase() : '';
  const type = Object.keys(SEC_KEYS).find((t) => SEC_KEYS[t] === k);
  if (type) return jumpType(type), true;
  if (/^[1-9]$/.test(e.key)) return jumpSection(+e.key - 1), true;
  return false;
}

/** 歌词模块里的按键；处理了返回 true */
export function lyricsHandleKey(e) {
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  switch (e.key) {
    case 'ArrowDown': case 'ArrowRight': case 'PageDown': case ' ':
      next(); return true;
    case 'ArrowUp': case 'ArrowLeft': case 'PageUp':
      prev(); return true;
    case 'Home':
      go(0); return true;
    case 'Enter':
      push(); return true;
    default:
      return letterJump(e);
  }
}

/** 节目单里当前条是歌词时：↑/↓ 换行、字母键跳段落（←/→/Enter 仍是走台） */
export function lyricsProgramKey(e) {
  if (e.ctrlKey || e.altKey || e.metaKey || !isLive()) return false;
  if (e.key === 'ArrowDown') return next(), true;
  if (e.key === 'ArrowUp') return prev(), true;
  return letterJump(e);
}

/** 节目单播放歌词条目：优先用歌词库里的最新版本，否则用条目里的快照 */
export function playLyricsItem(item, seq) {
  const s = libSong(item.songId) || {
    id: item.songId || item.id, title: item.name || '', text: item.text || '', bg: item.bg,
  };
  loadSong(s, 0);
  return push(seq);
}

// ---------- 渲染 ----------

function renderList() {
  const box = $('lyrics-songs');
  if (!box) return;
  const q = filter.trim().toLowerCase();
  const list = songs.filter((s) => !q || (s.title || '').toLowerCase().includes(q) || (s.text || '').toLowerCase().includes(q));
  box.innerHTML = list.length
    ? list.map((s) => `
      <div class="file-item ${song && s.id === song.id ? 'active' : ''}" data-id="${s.id}">
        <span class="fi-icon">词</span>
        <span class="fi-name" title="${esc(s.title)}">${esc(s.title || '未命名')}</span>
      </div>`).join('')
    : `<div class="empty-tip">${songs.length ? '没有匹配的歌' : '点「＋新歌」或「导入」添加歌词'}</div>`;
}

function renderEditor() {
  const has = !!song;
  $('lshow-editor')?.classList.toggle('is-empty', !has);
  const t = $('lshow-title');
  if (t && document.activeElement !== t) t.value = song?.title || '';
  const ta = $('lshow-text');
  if (ta && document.activeElement !== ta) ta.value = song?.text || '';
  const bg = { ...defaultLshowBg(), ...(song?.bg || {}) };
  $('lshow-bg-mode').value = bg.mode;
  $('lshow-bg-color').value = bg.color;
  $('lshow-bg-anim').checked = bg.anim !== false;
  $('lshow-bg-speed').value = String(bg.speed);
  $('lshow-bg-dim').value = String(bg.dim);
  $('lshow-bg-file').textContent = bg.mode === 'image' ? (bg.image ? fileName(bg.image) : '未选择图片')
    : bg.mode === 'video' ? (bg.video ? fileName(bg.video) : '未选择视频') : '';
  document.querySelectorAll('#lshow-swatches .lshow-swatch').forEach((el) => {
    el.classList.toggle('active', el.dataset.color === bg.color);
  });
  $('lshow-view').value = style.view;
  $('lshow-step').value = String(style.step);
  $('lshow-scale').value = String(style.scale);
  $('lshow-show-label').checked = style.showLabel !== false;
  $('lshow-show-title').checked = !!style.showTitle;
}

function renderLines() {
  const secBar = $('lshow-secs');
  const box = $('lshow-lines');
  if (!secBar || !box) return;
  if (!song) {
    secBar.innerHTML = '';
    box.innerHTML = '<div class="empty-tip">从左侧选一首歌，或点「＋新歌」粘贴歌词</div>';
    return;
  }
  secBar.innerHTML = sheet.sections.map((s, i) => {
    const key = i < 9 ? i + 1 : '';
    return `<button type="button" class="lshow-secbtn t-${s.type}" data-sec="${i}" title="快捷键 ${key}${SEC_KEYS[s.type] ? ' / ' + SEC_KEYS[s.type] : ''}">
      <span class="k mono">${key}</span>${esc(s.name)}</button>`;
  }).join('');
  if (!sheet.lines.length) {
    box.innerHTML = '<div class="empty-tip">在右侧「歌词」里输入或粘贴歌词</div>';
    return;
  }
  box.innerHTML = sheet.sections.map((s, si) => `
    <div class="lshow-sec t-${s.type}">
      <div class="lshow-sechead" data-sec="${si}">${esc(s.name)}</div>
      ${sheet.lines.slice(s.start, s.end).map((t, k) => `<div class="lshow-row" data-i="${s.start + k}">${esc(t)}</div>`).join('')}
    </div>`).join('');
  paintLines(true);
}

function paintLines(instant = false) {
  const box = $('lshow-lines');
  if (!box) return;
  const lit = new Set([active]);
  if (style.step === 2 && sheet.secOf[active + 1] === sheet.secOf[active] && active + 1 < sheet.lines.length) lit.add(active + 1);
  let first = null;
  box.querySelectorAll('.lshow-row').forEach((el) => {
    const on = lit.has(+el.dataset.i);
    el.classList.toggle('active', on);
    if (on && !first) first = el;
  });
  const si = sheet.secOf[active] | 0;
  document.querySelectorAll('#lshow-secs .lshow-secbtn').forEach((el) => el.classList.toggle('active', +el.dataset.sec === si));
  $('lshow-live')?.classList.toggle('on', isLive());
  if (first) first.scrollIntoView({ block: 'center', behavior: instant ? 'auto' : 'smooth' });
}

/** 设置区的小预览（不论是否已投屏都能看到效果） */
function renderMini() {
  const el = $('lshow-mini');
  if (!el) return;
  if (!song || !sheet.lines.length) {
    el.innerHTML = '<div class="empty-tip">预览</div>';
    el.dataset.outKind = '';
    return;
  }
  renderOutput(el, payload(), { muted: true, videoPoster: true });
}

// ---------- 编辑 ----------

function touchSong(mut) {
  const s = song && libSong(song.id);
  if (!s) return;
  mut(s);
  s.updatedAt = Date.now();
  saveSongs();
}

let textTimer = 0;
function onTextInput() {
  clearTimeout(textTimer);
  textTimer = setTimeout(() => {
    if (!song) return;
    const wasLive = isLive();
    touchSong((s) => { s.text = $('lshow-text').value; });
    song = libSong(song.id) || song;
    const keep = active;
    sheet = parseLyricSheet(song.text);
    active = Math.min(keep, Math.max(0, sheet.lines.length - 1));
    renderLines();
    renderMini();
    if (wasLive && sheet.lines.length) push();
  }, 300);
}

function setBg(patch) {
  if (!song) return;
  const wasLive = isLive();
  const bg = { ...defaultLshowBg(), ...(song.bg || {}), ...patch };
  if (libSong(song.id)) touchSong((s) => { s.bg = bg; });
  song = libSong(song.id) || { ...song, bg };
  renderEditor();
  renderMini();
  if (wasLive) push();
}

function setStyle(patch) {
  const wasLive = isLive();
  style = { ...style, ...patch };
  saveStyle();
  paintLines();
  renderMini();
  if (wasLive) push();
}

function newSong(title = '新歌', text = '') {
  const s = { id: genId(), title, text, bg: lastBg(), updatedAt: Date.now() };
  songs.unshift(s);
  saveSongs();
  loadSong(s);
  return s;
}

/** 文本文件解码：UTF-8 优先，失败按 GBK（国内常见的 .txt / .lrc） */
async function readTextFile(path) {
  const buf = await (await fetch(convertFileSrc(path))).arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('gbk').decode(buf);
  }
}

async function importFiles() {
  const files = await pickFiles([{ name: '歌词', extensions: ['txt', 'lrc'] }], '导入歌词');
  let n = 0;
  for (const p of files) {
    try {
      const text = await readTextFile(p);
      newSong(fileName(p).replace(/\.[^.]+$/, ''), text);
      n += 1;
    } catch (err) {
      toast(`读取失败：${fileName(p)}（${err}）`, 5000);
    }
  }
  if (n) toast(`已导入 ${n} 首歌词`);
}

/** 从背景图取主色（经 Rust 生成的缩略图，避免跨域画布受限） */
async function colorFromImage(path) {
  const url = await invoke('make_image_thumb', { path }).catch(() => null);
  if (!url) return null;
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = c.height = 48;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, 48, 48);
  const px = ctx.getImageData(0, 0, 48, 48).data;
  // 按色相分 24 桶，以饱和度×亮度适中加权，取最显著的色相
  const bins = new Array(24).fill(0);
  const sat = new Array(24).fill(0);
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (d < 0.08) continue;
    let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
    const l = (max + min) / 2;
    const s = d / (1 - Math.abs(2 * l - 1) || 1);
    const w = s * (1 - Math.abs(l - 0.5) * 1.6);
    const k = Math.floor(h / 15) % 24;
    bins[k] += w;
    sat[k] += s;
  }
  let best = 0;
  for (let k = 1; k < 24; k++) if (bins[k] > bins[best]) best = k;
  if (!bins[best]) return null;
  return hslToHex(best * 15 + 7, Math.min(80, (sat[best] / Math.max(1, bins[best])) * 60 + 30), 50);
}

function addToProgram() {
  if (!song) return toast('请先选择一首歌');
  const detail = {
    fn: (ev) => {
      ev.items.push({
        id: genId(), type: 'lyrics', songId: song.id, name: song.title || '歌词',
        text: song.text || '', bg: song.bg, path: '', note: '',
      });
    },
  };
  document.dispatchEvent(new CustomEvent('sp:program-mutate', { detail }));
  if (detail.ok) toast(`已把「${song.title}」加入当前节目单`);
}

// ---------- 初始化 ----------

export function initLyricsShow() {
  $('lshow-swatches').innerHTML = LSHOW_SWATCHES.map((w) => {
    const [c1, c2, c3] = paletteFromColor(w.color).colors;
    return `<button type="button" class="lshow-swatch" data-color="${w.color}" title="${w.name}"
      style="background:linear-gradient(135deg, ${c1}, ${c2}, ${c3})"><span>${w.name}</span></button>`;
  }).join('');

  $('lyrics-songs')?.addEventListener('click', (e) => {
    const it = e.target.closest('.file-item');
    const s = it && libSong(it.dataset.id);
    if (s) loadSong(s);
  });
  $('lyrics-search')?.addEventListener('input', (e) => { filter = e.target.value; renderList(); });
  $('lyrics-new')?.addEventListener('click', () => {
    newSong();
    $('lshow-title')?.select();
  });
  document.addEventListener('sp:import-lyrics', importFiles);

  $('lshow-title')?.addEventListener('input', (e) => {
    touchSong((s) => { s.title = e.target.value.trim() || '未命名'; });
    if (song) song = libSong(song.id) || song;
    renderList();
  });
  $('lshow-text')?.addEventListener('input', onTextInput);
  // 编辑框里按 Esc 退出编辑，回到键盘控制
  for (const id of ['lshow-text', 'lshow-title']) {
    $(id)?.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.target.blur(); } });
  }
  $('lshow-del')?.addEventListener('click', () => {
    if (!song || !libSong(song.id)) return;
    if (!window.confirm(`删除歌词「${song.title}」？`)) return;
    songs = songs.filter((s) => s.id !== song.id);
    saveSongs();
    song = null;
    loadSong(songs[0] || null);
  });
  $('lshow-push')?.addEventListener('click', () => push());
  $('lshow-to-program')?.addEventListener('click', addToProgram);

  $('lshow-secs')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sec]');
    if (b) jumpSection(+b.dataset.sec);
  });
  $('lshow-lines')?.addEventListener('click', (e) => {
    const row = e.target.closest('.lshow-row');
    if (row) return go(+row.dataset.i);
    const head = e.target.closest('.lshow-sechead');
    if (head) jumpSection(+head.dataset.sec);
  });

  // 背景
  $('lshow-bg-mode')?.addEventListener('change', (e) => setBg({ mode: e.target.value }));
  $('lshow-bg-color')?.addEventListener('input', (e) => setBg({ color: e.target.value }));
  $('lshow-swatches')?.addEventListener('click', (e) => {
    const b = e.target.closest('.lshow-swatch');
    if (b) setBg({ color: b.dataset.color });
  });
  $('lshow-bg-random')?.addEventListener('click', () => {
    setBg({ color: hslToHex(Math.random() * 360, 55 + Math.random() * 25, 48) });
  });
  $('lshow-bg-anim')?.addEventListener('change', (e) => setBg({ anim: e.target.checked }));
  $('lshow-bg-speed')?.addEventListener('change', (e) => setBg({ speed: +e.target.value }));
  $('lshow-bg-dim')?.addEventListener('change', (e) => setBg({ dim: +e.target.value }));
  $('lshow-bg-pick')?.addEventListener('click', async () => {
    if (!song) return;
    const mode = $('lshow-bg-mode').value === 'video' ? 'video' : 'image';
    const files = await pickFiles([{ name: mode === 'video' ? '视频' : '图片', extensions: mode === 'video' ? VIDEO_EXT : IMAGE_EXT }],
      mode === 'video' ? '选择背景视频' : '选择背景图片');
    if (files[0]) setBg({ mode, [mode]: files[0] });
  });
  $('lshow-bg-from-img')?.addEventListener('click', async () => {
    const img = song?.bg?.image;
    if (!img) return toast('请先选择一张背景图片');
    const c = await colorFromImage(img).catch(() => null);
    if (c) { setBg({ color: c }); toast('已按图片主色生成渐变'); } else toast('这张图片取不到明显的主色');
  });

  // 显示
  $('lshow-view')?.addEventListener('change', (e) => setStyle({ view: e.target.value }));
  $('lshow-step')?.addEventListener('change', (e) => {
    setStyle({ step: +e.target.value === 2 ? 2 : 1 });
    if (style.step === 2) {
      // 对齐到「段首 + 偶数行」
      const sec = secAt(active);
      if (sec) go(sec.start + Math.floor((active - sec.start) / 2) * 2, { send: isLive() });
    }
  });
  $('lshow-scale')?.addEventListener('change', (e) => setStyle({ scale: +e.target.value }));
  $('lshow-show-label')?.addEventListener('change', (e) => setStyle({ showLabel: e.target.checked }));
  $('lshow-show-title')?.addEventListener('change', (e) => setStyle({ showTitle: e.target.checked }));

  // 改完设置立即交还焦点，键盘上下继续控制歌词
  $('lshow-editor')?.addEventListener('change', (e) => {
    if (e.target.matches('select, input[type=range], input[type=checkbox], input[type=color]')) e.target.blur();
  });

  // 输出被别的内容替换后刷新「投屏中」状态
  document.addEventListener('sp:module-change', (e) => { if (e.detail === 'lyrics') { paintLines(true); renderMini(); } });

  loadSong(libSong(curId) || songs[0] || null);
}
