// 敬拜 PPT / PPTX → 歌词库歌曲
// 约定：歌名页通常带「所属歌手 / 演唱 / 歌手」；其余每一页是一段歌词。
// 导入后按空行分段，重复出现的段落会被 parseLyricSheet 自动认作副歌。

import { invoke, fileName } from './util.js';
import { defaultLshowBg } from './lyrics-show-render.js';

const ARTIST_RE = /所属歌手|演唱者?|歌手\s*[：:]|^Artist\s*[：:]/i;

/** 一页上的文字：按文本框位置从上到下、从左到右拼行 */
export function slideLines(slide) {
  // Rust 侧字段是 text_boxes（snake_case）；兼容旧 camelCase
  const boxes = [...(slide?.text_boxes || slide?.textBoxes || [])].sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const lines = [];
  for (const box of boxes) {
    for (const ln of box.lines || []) {
      const raw = String(ln?.text || '').replace(/\u000b/g, '\n'); // PPT 里软换行有时是 VT
      for (const part of raw.split(/\r?\n/)) {
        const t = part.replace(/^[\s　]+|[\s　]+$/g, '');
        if (t) lines.push(t);
      }
    }
  }
  return lines;
}

export function isSongTitleSlide(lines) {
  return (lines || []).some((l) => ARTIST_RE.test(l));
}

export function titleFromSlide(lines) {
  const filtered = (lines || []).filter((l) => !ARTIST_RE.test(l) && !/^所属歌手\s*[：:]?\s*$/.test(l));
  const title = (filtered[0] || lines?.[0] || '未命名').replace(/^歌名\s*[：:]\s*/, '').trim();
  return title || '未命名';
}

/**
 * 把每一页的文字行编成若干首歌。
 * 遇到歌名页就开新歌；没有歌名页标记时整份 PPT 当作一首（歌名用文件名）。
 */
export function groupPptSongs(slideLineLists, fallbackTitle = '未命名') {
  const songs = [];
  let cur = null;
  const flush = () => {
    if (cur?.pages?.length) songs.push(cur);
    cur = null;
  };
  for (const lines of slideLineLists) {
    if (!lines?.length) continue;
    if (isSongTitleSlide(lines)) {
      flush();
      cur = { title: titleFromSlide(lines), pages: [] };
      continue;
    }
    if (!cur) cur = { title: fallbackTitle || '未命名', pages: [] };
    cur.pages.push(lines.join('\n'));
  }
  flush();
  return songs
    .filter((s) => s.pages.length)
    .map((s) => ({
      title: s.title,
      text: s.pages.join('\n\n'),
      bg: defaultLshowBg(),
    }));
}

/**
 * 读取 .ppt / .pptx：返回 { name, songs: [{ title, text, bg }] }
 * 旧版 .ppt 会先经本机 PowerPoint 转成 pptx（结果缓存在本机）。
 */
export async function readPptLyrics(path) {
  const pptxPath = await invoke('ensure_pptx', { path });
  const doc = await invoke('parse_pptx', { path: pptxPath });
  const base = fileName(path).replace(/\.[^.]+$/, '') || '导入的诗歌';
  const slides = (doc?.slides || []).map(slideLines);
  const songs = groupPptSongs(slides, base);
  if (!songs.length) throw new Error('没有识别到歌词文字（空白页或纯图片页会被跳过）');
  return { name: String(doc?.name || base).trim() || base, songs };
}
