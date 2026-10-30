// 节目单 · 圣经经文选择与加入面板

import { esc, toast } from './util.js';
import {
  ensureBible,
  getBooks,
  getBook,
  chapterCount,
  verseCount,
  parseReference,
  searchKeyword,
  getVerses,
  formatRefFull,
} from './bible-data.js';
import { buildBibleItems } from './bible-page.js';
import { hideBlankPanels, hideLobbyPanel } from './program-blank.js';

const $ = (id) => document.getElementById(id);

// 由 program.js 注入的宿主回调（避免与 program.js 循环引用）
let activate, curEvent, renderItems, save, updateNowBar;

export function bindBibleHost(h) {
  ({ activate, curEvent, renderItems, save, updateNowBar } = h);
}

function biblePreviewEl() {
  return $('pg-bible-preview');
}

function setBiblePreviewText(htmlOrText, isHtml = false) {
  const el = biblePreviewEl();
  if (!el) return;
  if (isHtml) el.innerHTML = htmlOrText;
  else el.textContent = htmlOrText;
}

async function fillBibleBookSelect() {
  const sel = $('pg-bible-book');
  if (!sel || sel.dataset.ready === '1') return;
  try {
    await ensureBible();
  } catch (err) {
    toast('圣经数据加载失败：' + err, 6000);
    return;
  }
  const books = getBooks();
  const ot = books.filter((b) => !b.nt);
  const nt = books.filter((b) => b.nt);
  sel.innerHTML = '';
  const gOt = document.createElement('optgroup');
  gOt.label = '旧约';
  for (const b of ot) {
    const o = document.createElement('option');
    o.value = String(b.sn);
    o.textContent = `${b.short} ${b.name}`;
    gOt.appendChild(o);
  }
  const gNt = document.createElement('optgroup');
  gNt.label = '新约';
  for (const b of nt) {
    const o = document.createElement('option');
    o.value = String(b.sn);
    o.textContent = `${b.short} ${b.name}`;
    gNt.appendChild(o);
  }
  sel.appendChild(gOt);
  sel.appendChild(gNt);
  sel.dataset.ready = '1';
  // 默认约翰福音
  sel.value = '43';
  syncBibleChapterOptions();
}

function syncBibleChapterOptions() {
  const sn = +($('pg-bible-book')?.value || 0);
  const chSel = $('pg-bible-chapter');
  const vsFrom = $('pg-bible-from');
  const vsTo = $('pg-bible-to');
  if (!chSel || !sn) return;
  const n = chapterCount(sn) || 1;
  const cur = +chSel.value || 1;
  chSel.innerHTML = '';
  for (let i = 1; i <= n; i++) {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = String(i);
    chSel.appendChild(o);
  }
  chSel.value = String(Math.min(Math.max(1, cur), n));
  syncBibleVerseOptions();
  if (vsFrom) vsFrom.value = '1';
  if (vsTo) vsTo.value = '1';
  refreshBibleRangePreview();
}

function syncBibleVerseOptions() {
  const sn = +($('pg-bible-book')?.value || 0);
  const ch = +($('pg-bible-chapter')?.value || 1);
  const max = verseCount(sn, ch) || 1;
  for (const id of ['pg-bible-from', 'pg-bible-to']) {
    const el = $(id);
    if (!el) continue;
    el.max = String(max);
    el.min = '1';
    if (+el.value > max) el.value = String(max);
    if (+el.value < 1) el.value = '1';
  }
}

function readBibleRange() {
  const sn = +($('pg-bible-book')?.value || 0);
  const chapter = +($('pg-bible-chapter')?.value || 1);
  let from = +($('pg-bible-from')?.value || 1);
  let to = +($('pg-bible-to')?.value || from);
  if (!sn) return null;
  if (to < from) [from, to] = [to, from];
  return { sn, chapter, from, to };
}

function refreshBibleRangePreview() {
  const range = readBibleRange();
  if (!range) {
    setBiblePreviewText('请选择书卷与章节');
    return;
  }
  const book = getBook(range.sn);
  const verses = getVerses(range.sn, range.chapter, range.from, range.to);
  if (!verses.length) {
    setBiblePreviewText('该范围没有经文');
    return;
  }
  const head = formatRefFull(book, range.chapter, range.from, range.to);
  const body = verses.map((v) => `${v.n} ${v.text}`).join('\n');
  setBiblePreviewText(`${head}\n\n${body}`);
}

async function applyBibleQuickRef() {
  const input = $('pg-bible-quick');
  const raw = input?.value?.trim() || '';
  if (!raw) {
    toast('请输入经文，如：约3:16 或 约翰福音 3:16-18');
    return false;
  }
  try {
    await ensureBible();
    await fillBibleBookSelect();
  } catch (err) {
    toast('圣经数据加载失败：' + err);
    return false;
  }
  const hit = parseReference(raw);
  if (!hit) {
    toast('无法识别经文引用，请用「约3:16」或「约翰福音 3:16-18」');
    return false;
  }
  const bookSel = $('pg-bible-book');
  if (bookSel) bookSel.value = String(hit.book.sn);
  syncBibleChapterOptions();
  const chSel = $('pg-bible-chapter');
  if (chSel) chSel.value = String(hit.chapter);
  syncBibleVerseOptions();
  const max = verseCount(hit.book.sn, hit.chapter) || 1;
  const from = Math.min(hit.from, max);
  const to = Math.min(hit.to, max);
  if ($('pg-bible-from')) $('pg-bible-from').value = String(from);
  if ($('pg-bible-to')) $('pg-bible-to').value = String(to);
  refreshBibleRangePreview();
  toast(`已定位：${formatRefFull(hit.book, hit.chapter, from, to)}`);
  return true;
}

async function runBibleKeywordSearch() {
  const q = $('pg-bible-kw')?.value?.trim() || '';
  const box = $('pg-bible-hits');
  if (!box) return;
  if (!q) {
    box.innerHTML = '<div class="empty-tip">输入关键字后搜索，点击结果可定位</div>';
    return;
  }
  try {
    await ensureBible();
  } catch (err) {
    toast('圣经数据加载失败：' + err);
    return;
  }
  const hits = searchKeyword(q, 36);
  if (!hits.length) {
    box.innerHTML = '<div class="empty-tip">没有匹配经文</div>';
    return;
  }
  box.innerHTML = hits.map((h) => `
    <button type="button" class="pg-bible-hit" data-sn="${h.sn}" data-ch="${h.chapter}" data-vs="${h.verse}">
      <span class="pg-bible-hit-ref">${esc(h.short)}${h.chapter}:${h.verse}</span>
      <span class="pg-bible-hit-text">${esc(h.text)}</span>
    </button>`).join('');
}

async function addBibleToProgram({ play = false } = {}) {
  const ev = curEvent();
  if (!ev) {
    toast('请先新建一场演出');
    return;
  }
  const range = readBibleRange();
  if (!range) {
    toast('请选择书卷章节');
    return;
  }
  try {
    await ensureBible();
    const accent = $('pg-bible-accent')?.value || '#e8c56a';
    const items = await buildBibleItems({ ...range, accent });
    ev.items.push(...items);
    save();
    renderItems({ soft: false });
    updateNowBar();
    toast(`已加入 ${items.length} 页：${items[0]?.refFull || items[0]?.ref}`);
    if (play && items[0]) await activate(items[0]);
    // 保持面板打开，方便继续查
  } catch (err) {
    toast('加入失败：' + err, 5000);
  }
}

export function initBiblePanel() {
  $('pg-add-bible')?.addEventListener('click', async () => {
    const panel = $('pg-bible-panel');
    if (!panel) return;
    const show = panel.classList.contains('hidden');
    hideLobbyPanel();
    hideBlankPanels();
    panel.classList.toggle('hidden', !show);
    $('pg-add-bible')?.classList.toggle('active', show);
    if (show) {
      toast('正在加载和合本…', 1200);
      await fillBibleBookSelect();
      refreshBibleRangePreview();
      $('pg-bible-quick')?.focus();
    }
  });
  $('pg-bible-cancel')?.addEventListener('click', () => {
    $('pg-bible-panel')?.classList.add('hidden');
    $('pg-add-bible')?.classList.remove('active');
  });
  $('pg-bible-book')?.addEventListener('change', () => syncBibleChapterOptions());
  $('pg-bible-chapter')?.addEventListener('change', () => {
    syncBibleVerseOptions();
    if ($('pg-bible-from')) $('pg-bible-from').value = '1';
    if ($('pg-bible-to')) $('pg-bible-to').value = '1';
    refreshBibleRangePreview();
  });
  $('pg-bible-from')?.addEventListener('change', () => {
    syncBibleVerseOptions();
    const from = +($('pg-bible-from')?.value || 1);
    const toEl = $('pg-bible-to');
    if (toEl && +toEl.value < from) toEl.value = String(from);
    refreshBibleRangePreview();
  });
  $('pg-bible-to')?.addEventListener('change', () => {
    syncBibleVerseOptions();
    refreshBibleRangePreview();
  });
  $('pg-bible-quick-go')?.addEventListener('click', () => applyBibleQuickRef());
  $('pg-bible-quick')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      applyBibleQuickRef();
    }
  });
  $('pg-bible-kw-go')?.addEventListener('click', () => runBibleKeywordSearch());
  $('pg-bible-kw')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runBibleKeywordSearch();
    }
  });
  $('pg-bible-hits')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.pg-bible-hit');
    if (!btn) return;
    const sn = +btn.dataset.sn;
    const ch = +btn.dataset.ch;
    const vs = +btn.dataset.vs;
    const bookSel = $('pg-bible-book');
    if (bookSel) bookSel.value = String(sn);
    syncBibleChapterOptions();
    if ($('pg-bible-chapter')) $('pg-bible-chapter').value = String(ch);
    syncBibleVerseOptions();
    if ($('pg-bible-from')) $('pg-bible-from').value = String(vs);
    if ($('pg-bible-to')) $('pg-bible-to').value = String(vs);
    refreshBibleRangePreview();
  });
  $('pg-bible-add')?.addEventListener('click', () => addBibleToProgram({ play: false }));
  $('pg-bible-add-play')?.addEventListener('click', () => addBibleToProgram({ play: true }));
}
