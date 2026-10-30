// 节目单数据：条目规范化、长正文外置存储

import { fileName, lsGet } from './util.js';

/** 空白页大段歌词外置，避免撑爆 localStorage */
export const LS_BODIES = 'sp.program.bodies';

export function bodyStore() {
  const m = lsGet(LS_BODIES, {});
  return m && typeof m === 'object' ? m : {};
}

function hydrateBlankBody(it) {
  if (!it || (it.type !== 'blank' && it.type !== 'bible')) return it;
  if (it.body) return it;
  const bodies = bodyStore();
  const ref = it._bodyRef || it.id;
  if (ref && bodies[ref]) it.body = bodies[ref];
  return it;
}

export function normalizeItem(it) {
  if (!it || typeof it !== 'object') return null;
  if (it.type === 'blank') {
    const blankKind = it.blankKind === 'lyric' ? 'lyric' : 'title';
    const title = (it.title || '').trim() || (blankKind === 'title' ? '歌曲名称' : '歌词');
    const name = (it.name != null && String(it.name))
      || (blankKind === 'lyric'
        ? `${title} · 歌词${it.lyricIndex != null ? ` ${it.lyricIndex}` : ''}`
        : `${title} · 歌名`);
    const item = {
      ...it,
      type: 'blank',
      blankKind,
      title,
      subtitle: it.subtitle || '',
      body: it.body || '',
      accent: it.accent || '#e8c56a',
      bgPreset: it.bgPreset || 'auto',
      bgImage: it.bgImage || '',
      path: it.path || '',
      name,
      note: it.note || '',
    };
    return hydrateBlankBody(item);
  }
  if (it.type === 'bible') {
    const ref = (it.ref || '').trim() || '圣经';
    const item = {
      ...it,
      type: 'bible',
      sn: +it.sn || 0,
      bookName: it.bookName || '',
      bookShort: it.bookShort || '',
      chapter: +it.chapter || 1,
      verseFrom: +it.verseFrom || 1,
      verseTo: +it.verseTo || +it.verseFrom || 1,
      rangeFrom: +it.rangeFrom || +it.verseFrom || 1,
      rangeTo: +it.rangeTo || +it.verseTo || 1,
      ref,
      refFull: it.refFull || ref,
      body: it.body || '',
      accent: it.accent || '#e8c56a',
      pageIndex: +it.pageIndex || 1,
      pageTotal: +it.pageTotal || 1,
      path: '',
      name: (it.name != null && String(it.name)) || ref,
      note: it.note || '',
    };
    return hydrateBlankBody(item);
  }
  const path = it.path || '';
  const name = (it.name != null && String(it.name))
    || (path ? fileName(path).replace(/\.[^.]+$/, '') : '')
    || '未命名';
  return { ...it, path, name, note: it.note || '' };
}

export function normalizeEvents(list) {
  if (!Array.isArray(list)) return [];
  return list.map((ev) => {
    if (!ev || typeof ev !== 'object') return null;
    const items = Array.isArray(ev.items)
      ? ev.items.map(normalizeItem).filter(Boolean)
      : [];
    return { ...ev, name: ev.name || '未命名演出', items };
  }).filter(Boolean);
}

export function countItems(list) {
  return (Array.isArray(list) ? list : []).reduce((n, e) => n + (e.items?.length || 0), 0);
}
