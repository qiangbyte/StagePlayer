// 歌词：同目录同名 .lrc / .txt 解析与当前行定位

/** @type {Map<string, { timed: boolean, lines: { t: number, text: string }[], title?: string, artist?: string }|null>} */
const cache = new Map();

function stripExt(p) {
  return String(p || '').replace(/\.[^.\\/]+$/, '');
}

function candidatesFor(audioPath) {
  const base = stripExt(audioPath);
  return [`${base}.lrc`, `${base}.LRC`, `${base}.txt`, `${base}.TXT`];
}

/** 解析 LRC；返回 null 表示不是有效 LRC */
export function parseLrc(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '');
  const lines = [];
  let title = '';
  let artist = '';
  const tagRe = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const row of raw.split(/\r?\n/)) {
    const s = row.trim();
    if (!s) continue;
    const meta = s.match(/^\[(ti|ar|al|by|offset):\s*(.*?)\s*\]$/i);
    if (meta) {
      const k = meta[1].toLowerCase();
      if (k === 'ti') title = meta[2];
      if (k === 'ar') artist = meta[2];
      continue;
    }
    const stamps = [];
    let m;
    tagRe.lastIndex = 0;
    while ((m = tagRe.exec(s))) {
      const mm = parseInt(m[1], 10) || 0;
      const ss = parseInt(m[2], 10) || 0;
      let frac = m[3] || '0';
      if (frac.length === 1) frac += '0';
      if (frac.length === 3) frac = frac.slice(0, 2); // 百分秒
      const cs = parseInt(frac, 10) || 0;
      stamps.push(mm * 60 + ss + cs / 100);
    }
    if (!stamps.length) continue;
    const text = s.replace(tagRe, '').trim();
    if (!text) continue;
    for (const t of stamps) lines.push({ t, text });
  }
  if (!lines.length) return null;
  lines.sort((a, b) => a.t - b.t);
  return { timed: true, lines, title, artist };
}

/** 纯文本：按行，无时间轴 */
export function parsePlainLyrics(text) {
  const lines = String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((text, i) => ({ t: i, text }));
  if (!lines.length) return null;
  return { timed: false, lines };
}

/**
 * @param {string} audioPath
 * @param {(p: string) => string} convertSrc
 */
export async function loadLyricsFor(audioPath, convertSrc) {
  if (!audioPath) return null;
  if (cache.has(audioPath)) return cache.get(audioPath);

  for (const p of candidatesFor(audioPath)) {
    try {
      const resp = await fetch(convertSrc(p));
      if (!resp.ok) continue;
      const text = await resp.text();
      if (!text || text.length < 2) continue;
      const lower = p.toLowerCase();
      let parsed = lower.endsWith('.lrc') ? parseLrc(text) : null;
      if (!parsed) parsed = parsePlainLyrics(text);
      if (parsed?.lines?.length) {
        cache.set(audioPath, parsed);
        return parsed;
      }
    } catch {
      /* 文件不存在等 */
    }
  }
  cache.set(audioPath, null);
  return null;
}

/** 根据播放进度取当前行下标 */
export function activeLyricIndex(lines, posSec, timed, durationSec) {
  if (!lines?.length) return 0;
  if (!timed) {
    const dur = Math.max(1, durationSec || lines.length);
    const i = Math.floor((Math.max(0, posSec) / dur) * lines.length);
    return Math.max(0, Math.min(lines.length - 1, i));
  }
  let idx = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].t <= posSec + 0.05) idx = i;
    else break;
  }
  return idx;
}

export function clearLyricsCache(path) {
  if (path) cache.delete(path);
  else cache.clear();
}
