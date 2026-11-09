// 节目单导出 / 导入（单场演出 → .json 文件，换电脑或备份用）

import { invoke, pickFiles, toast } from './util.js';
import { normalizeItem } from './program-store.js';
import { flushStore } from './store-sync.js';
import { readPect } from './pect-import.js';
import { addLyricSongs } from './lyrics-show.js';

const FORMAT = 'stageplayer-show';
const VERSION = 1;

/** 去掉运行时字段（下划线开头、已触发标记等），正文保持内联 */
function cleanItem(it) {
  const out = {};
  for (const [k, v] of Object.entries(it)) {
    if (k.startsWith('_') || k === 'cueFired') continue;
    out[k] = v;
  }
  return out;
}

function safeFileName(s) {
  return String(s || '演出').replace(/[\/:*?"<>|]+/g, '_').trim().slice(0, 80) || '演出';
}

export async function exportEvent(ev) {
  if (!ev) return toast('没有可导出的演出');
  await flushStore();
  const path = await invoke('pick_save_path', {
    defaultName: `${safeFileName(ev.name)}.json`,
    extensions: ['json'],
  }).catch((err) => { toast('打开保存对话框失败：' + err); return null; });
  if (!path) return;
  const { id: _id, ...rest } = ev;
  const doc = {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    event: { ...rest, items: (ev.items || []).map(cleanItem) },
  };
  try {
    await invoke('write_text_file', { path, text: JSON.stringify(doc, null, 2) });
    toast(`已导出「${ev.name}」（${doc.event.items.length} 条）`);
  } catch (err) {
    toast('导出失败：' + err, 6000);
  }
}

/** .pect 诗歌演示 → 一场新演出：每首歌进歌词库，节目单里按原顺序排好 */
async function importPectEvent(path, genId) {
  let pect;
  try {
    pect = await readPect(path);
  } catch (err) {
    toast('读取 .pect 失败：' + err, 6000);
    return null;
  }
  if (!pect.songs.length) {
    toast('这个文件里没有歌词', 5000);
    return null;
  }
  const lib = addLyricSongs(pect.songs);
  const items = lib.map((s) => normalizeItem({
    id: genId(), type: 'lyrics', songId: s.id, name: s.title, text: s.text, bg: s.bg, path: '', note: '',
  }));
  toast(`已导入「${pect.name}」（${items.length} 首歌，已同时加入歌词库）`, 5000);
  return { id: genId(), name: pect.name, items };
}

/**
 * 选择文件导入为一场新演出；返回规范化后的演出对象（失败 / 取消返回 null）
 * @param {() => string} genId
 */
export async function importEvent(genId) {
  const files = await pickFiles([{ name: '节目单 / 诗歌演示', extensions: ['json', 'pect'] }], '导入节目单');
  if (!files.length) return null;
  if (/\.pect$/i.test(files[0])) return importPectEvent(files[0], genId);
  let doc;
  try {
    doc = JSON.parse(await invoke('read_show_file', { path: files[0] }));
  } catch (err) {
    toast('读取节目单失败：' + err, 6000);
    return null;
  }
  const src = doc?.format === FORMAT ? doc.event : null;
  if (!src || !Array.isArray(src.items)) {
    toast('不是演出播放器导出的节目单文件', 6000);
    return null;
  }
  const items = src.items
    .map((it) => normalizeItem({ ...cleanItem(it), id: genId() }))
    .filter(Boolean);
  const ev = { ...src, id: genId(), name: src.name || '导入的演出', items };

  // 提示本机缺失的媒体（换电脑时路径常常不同）
  const paths = [...new Set(items.flatMap((it) => [it.path, it.bgImage]).filter(Boolean))];
  if (paths.length) {
    const have = new Set(await invoke('existing_files', { paths }).catch(() => paths));
    const missing = paths.filter((p) => !have.has(p)).length;
    if (missing) toast(`已导入「${ev.name}」，其中 ${missing} 个媒体文件在本机找不到，请检查路径`, 7000);
    else toast(`已导入「${ev.name}」（${items.length} 条）`);
  } else {
    toast(`已导入「${ev.name}」（${items.length} 条）`);
  }
  return ev;
}
