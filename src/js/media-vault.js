// 把外部拖入 / 导入的文件复制进应用数据目录，避免源文件被误删后播不了

import { invoke, toast, fileName } from './util.js';

/**
 * 确保文件在应用素材库里；已在库中则原样返回。
 * kind: audio | video | ppt | pdf | image | lyrics | other
 */
export async function ensureLocalMedia(path, kind = 'other') {
  const p = String(path || '').trim();
  if (!p) return p;
  return invoke('import_media', { path: p, kind });
}

/** 批量复制；失败的跳过并提示，返回成功后的本地路径列表 */
export async function ensureLocalMediaMany(paths, kind = 'other', { quiet } = {}) {
  const list = (paths || []).filter(Boolean);
  if (!list.length) return [];
  if (!quiet) toast(list.length > 1 ? `正在复制 ${list.length} 个文件到应用库…` : '正在复制到应用库…');
  const out = [];
  for (const p of list) {
    try {
      out.push(await ensureLocalMedia(p, kind));
    } catch (err) {
      toast(`复制失败：${fileName(p)}（${err?.message || err}）`, 6000);
    }
  }
  return out;
}
