// 圣经投屏页：2048×896，远距大字 + 引用眉题；一页装不下自动分页

import {
  ensureBible, getBook, getVerses, formatRef, formatRefFull,
} from './bible-data.js';

export const BIBLE_W = 2048;
export const BIBLE_H = 896;
export const BIBLE_RATIO = `${BIBLE_W} / ${BIBLE_H}`;

const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/**
 * 大屏容量估算（与 CSS 大字号/字距匹配）：
 * 宁少勿挤——约 15 字/行 × 3 行，超出自动进下一页，避免 overflow 切字
 */
const CHARS_PER_LINE = 15;
const LINES_PER_PAGE = 3;
const CHARS_PER_PAGE = CHARS_PER_LINE * LINES_PER_PAGE;
/** 单节过长时，优先在这些标点处拆到下一页 */
const BREAK_CHARS = /[，。；、：！？…—,\.!?;:]/;

export function bibleDisplayName(item) {
  return item?.ref || item?.name || '圣经';
}

function preferBreak(text, maxLen) {
  if (text.length <= maxLen) return text.length;
  const slice = text.slice(0, maxLen);
  let best = -1;
  for (let i = slice.length - 1; i >= Math.floor(maxLen * 0.35); i--) {
    if (BREAK_CHARS.test(slice[i])) {
      best = i + 1;
      break;
    }
  }
  return best > 0 ? best : maxLen;
}

/**
 * 将经文列表按视觉容量拆成多页；超长单节也会拆开续页
 * @returns {Array<{ from, to, lines: string[] }>}
 */
export function splitVersePages(verses) {
  const pages = [];
  let buf = [];
  let chars = 0;
  let pageFrom = null;

  const flush = () => {
    if (!buf.length) return;
    pages.push({
      from: pageFrom,
      to: buf[buf.length - 1].n,
      lines: buf.map((v) => (v.cont ? `   ${v.text}` : `${v.n}  ${v.text}`)),
    });
    buf = [];
    chars = 0;
    pageFrom = null;
  };

  for (const v of verses) {
    let rest = String(v.text || '').trim();
    if (!rest) continue;
    let firstChunk = true;

    while (rest.length) {
      // 本页几乎满了 → 先翻页
      if (buf.length && chars >= CHARS_PER_PAGE - 6) flush();

      const room = Math.max(8, CHARS_PER_PAGE - chars);
      // 节号占一点额度
      const prefixCost = firstChunk ? 3 : 0;
      const takeBudget = Math.max(8, room - prefixCost);
      const take = preferBreak(rest, Math.min(takeBudget, rest.length));
      const chunk = rest.slice(0, take).trim();
      rest = rest.slice(take).trim();
      if (!chunk) break;

      if (!buf.length) pageFrom = v.n;
      buf.push({ n: v.n, text: chunk, cont: !firstChunk });
      chars += chunk.length + prefixCost;
      firstChunk = false;

      // 本页已满且还有剩余 → 下一页续写
      if (rest.length && chars >= CHARS_PER_PAGE - 4) flush();
    }
  }
  flush();
  return pages.length ? pages : [{ from: 0, to: 0, lines: [] }];
}

/**
 * 根据书卷/章/节范围生成节目条目（可多页）
 */
export async function buildBibleItems({
  sn, chapter, from, to, accent = '#e8c56a',
} = {}) {
  await ensureBible();
  const book = getBook(sn);
  if (!book) throw new Error('未知书卷');
  const verses = getVerses(sn, chapter, from, to);
  if (!verses.length) throw new Error('该范围没有经文');

  const pages = splitVersePages(verses);
  const fullRef = formatRefFull(book, chapter, from, to);
  const shortRef = formatRef(book, chapter, from, to);

  return pages.map((pg, i) => {
    const pageRef = pages.length > 1
      ? formatRef(book, chapter, pg.from, pg.to)
      : shortRef;
    const pageFull = pages.length > 1
      ? formatRefFull(book, chapter, pg.from, pg.to)
      : fullRef;
    return {
      id: genId(),
      type: 'bible',
      sn: book.sn,
      bookName: book.name,
      bookShort: book.short,
      chapter: +chapter,
      verseFrom: pg.from,
      verseTo: pg.to,
      rangeFrom: +from,
      rangeTo: +to,
      ref: pageRef,
      refFull: pageFull,
      body: pg.lines.join('\n'),
      accent: accent || '#e8c56a',
      pageIndex: i + 1,
      pageTotal: pages.length,
      name: pages.length > 1 ? `${pageRef} (${i + 1}/${pages.length})` : pageRef,
      note: pages.length > 1 ? `续页 ${i + 1}/${pages.length}` : '',
      path: '',
      cueTime: '',
      cueDate: '',
    };
  });
}

export function bibleToOutputPayload(item) {
  return {
    kind: 'bible',
    ref: item.ref || '',
    refFull: item.refFull || item.ref || '',
    body: item.body || '',
    accent: item.accent || '#e8c56a',
    pageIndex: item.pageIndex || 1,
    pageTotal: item.pageTotal || 1,
  };
}

export function renderBibleInto(container, payload, opts = {}) {
  if (!container) return null;
  const p = payload || {};
  const wrap = document.createElement('div');
  wrap.className = 'out-bible';
  wrap.style.setProperty('--bible-accent', p.accent || '#e8c56a');
  wrap.style.aspectRatio = BIBLE_RATIO;
  if (p.pageTotal > 1) wrap.classList.add('is-multipage');

  wrap.innerHTML = `
    <div class="out-bible-kicker"></div>
    <div class="out-bible-ornament" aria-hidden="true"></div>
    <div class="out-bible-body"></div>
    <div class="out-bible-ornament out-bible-ornament-bottom" aria-hidden="true"></div>
    <div class="out-bible-foot"></div>`;

  const kicker = wrap.querySelector('.out-bible-kicker');
  const body = wrap.querySelector('.out-bible-body');
  const foot = wrap.querySelector('.out-bible-foot');
  kicker.textContent = p.refFull || p.ref || '圣经 · 和合本';
  body.textContent = p.body || '';
  // 行数少时字更大，多占屏幕
  const lines = String(p.body || '').split('\n').filter(Boolean).length;
  body.dataset.lines = String(Math.max(1, lines));
  if (p.pageTotal > 1) {
    foot.textContent = `${p.pageIndex || 1} / ${p.pageTotal}`;
  } else {
    foot.textContent = '和合本';
  }

  if (opts.replace !== false) {
    container.innerHTML = '';
    container.appendChild(wrap);
  }
  return wrap;
}

/** 节目单缩略图 */
export function mountBiblePreview(el, item) {
  if (!el || !item) return false;
  const keep = [...el.querySelectorAll('.pg-corner-num, .pg-corner-tag, .pg-hover-bar, .pg-remain, .pg-cue')];
  el.innerHTML = '';
  const stage = document.createElement('div');
  stage.className = 'pg-bible-thumb';
  renderBibleInto(stage, bibleToOutputPayload(item));
  el.appendChild(stage);
  for (const node of keep) el.appendChild(node);
  return true;
}

/** 就地更新（输出差分） */
export function updateBibleDom(wrap, payload) {
  if (!wrap || !wrap.classList.contains('out-bible')) return false;
  const p = payload || {};
  wrap.style.setProperty('--bible-accent', p.accent || '#e8c56a');
  wrap.classList.toggle('is-multipage', p.pageTotal > 1);
  const kicker = wrap.querySelector('.out-bible-kicker');
  const body = wrap.querySelector('.out-bible-body');
  const foot = wrap.querySelector('.out-bible-foot');
  if (kicker) kicker.textContent = p.refFull || p.ref || '圣经 · 和合本';
  if (body) {
    body.textContent = p.body || '';
    const lines = String(p.body || '').split('\n').filter(Boolean).length;
    body.dataset.lines = String(Math.max(1, lines));
  }
  if (foot) {
    foot.textContent = p.pageTotal > 1
      ? `${p.pageIndex || 1} / ${p.pageTotal}`
      : '和合本';
  }
  return true;
}
