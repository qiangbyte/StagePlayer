// .pect 诗歌演示文件 → 歌词库歌曲
// 文件里每首歌是若干页（每页一段歌词），第一页通常是歌名页；背景可能是纯色、图片或视频（素材由后端解压到本机）

import { invoke } from './util.js';
import { defaultLshowBg } from './lyrics-show-render.js';

const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0);

/** 一页歌词：去掉 \r、行首尾空白（含全角空格）和空行 */
function pageText(verse) {
  return String(verse || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/^[\s　]+|[\s　]+$/g, ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * 读取 .pect：返回 { name, songs: [{ title, text, bg }] }
 * text 里每页之间空一行，歌词投屏按空行分段（重复的段自动认作副歌）
 */
export async function readPect(path) {
  const { index, files } = await invoke('import_pect', { path });
  const doc = JSON.parse(index);
  const songs = (doc.list || []).slice().sort(byOrder).map((it) => {
    const pages = (it.list || []).slice().sort(byOrder)
      .filter((s) => !s.isSongName)
      .map((s) => pageText(s.verse))
      .filter(Boolean);
    const bg = defaultLshowBg();
    const video = it.bgSrc && files[it.bgSrc];
    const image = it.bgImg && files[it.bgImg];
    if (video) Object.assign(bg, { mode: 'video', video, image: image || '', dim: 0.25 });
    else if (image) Object.assign(bg, { mode: 'image', image, dim: 0.25 });
    else if (/^#[0-9a-f]{6}$/i.test(it.bgColor || '')) bg.color = it.bgColor;
    return { title: String(it.name || '').trim() || '未命名', text: pages.join('\n\n'), bg };
  }).filter((s) => s.text);
  return { name: String(doc.name || '').trim() || '导入的诗歌', songs };
}
