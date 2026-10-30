// localStorage ⇄ 应用数据目录 store.json
// localStorage 是运行时缓存（同步读写快）；store.json 是真正的存档，带自动备份
// 启动：boot.js 先 hydrateFromFile()，再加载 main.js
import { invoke, setLsWriteHook } from './util.js';

const PREFIX = 'sp.';
/** 内部标记，不进存档 */
const SAVED_AT = 'sp.__savedAt';
const DIRTY = 'sp.__dirty';
const DEBOUNCE_MS = 800;
const VERSION = 1;

function isDataKey(k) {
  return k && k.startsWith(PREFIX) && !k.startsWith('sp.__');
}

function snapshotData() {
  const data = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (isDataKey(k)) data[k] = localStorage.getItem(k);
  }
  return data;
}

function hasLocalData() {
  for (let i = 0; i < localStorage.length; i++) {
    if (isDataKey(localStorage.key(i))) return true;
  }
  return false;
}

let lastSaved = '';
let timer = 0;
let saving = null;

async function saveNow({ backup = false } = {}) {
  clearTimeout(timer);
  timer = 0;
  const data = snapshotData();
  const body = JSON.stringify(data);
  if (body === lastSaved && !backup) {
    localStorage.removeItem(DIRTY);
    return;
  }
  const savedAt = Date.now();
  const json = `{"version":${VERSION},"savedAt":${savedAt},"data":${body}}`;
  try {
    await (saving = invoke('store_save', { json, backup }));
    lastSaved = body;
    localStorage.setItem(SAVED_AT, String(savedAt));
    localStorage.removeItem(DIRTY);
  } catch (err) {
    console.warn('[store] 保存失败', err);
  } finally {
    saving = null;
  }
}

function markDirty() {
  try {
    if (!localStorage.getItem(DIRTY)) localStorage.setItem(DIRTY, '1');
  } catch { /* ignore */ }
  clearTimeout(timer);
  timer = setTimeout(() => saveNow(), DEBOUNCE_MS);
}

/** 立即落盘（导出、关闭前） */
export function flushStore() {
  return timer || localStorage.getItem(DIRTY) ? saveNow() : saving || Promise.resolve();
}

/**
 * 启动时调用一次：
 * - 有未落盘的本地改动（上次异常退出）→ 本地为准，立即落盘
 * - 存档比本地新（换了安装方式 / WebView 数据被清）→ 用存档恢复本地；被覆盖的本地数据先备份
 * - 本地有旧版数据、从未同步过 → 迁移到存档（存档原有内容先备份），不删除任何旧数据
 */
export async function hydrateFromFile() {
  let file = null;
  try {
    const raw = await invoke('store_load');
    if (raw) file = JSON.parse(raw);
  } catch (err) {
    console.warn('[store] 读取失败', err);
  }
  const localAt = +localStorage.getItem(SAVED_AT) || 0;
  const dirty = !!localStorage.getItem(DIRTY);
  const fileAt = +file?.savedAt || 0;
  let action = 'none';

  if (!file?.data) {
    action = hasLocalData() ? 'migrate' : 'none';
  } else if (dirty) {
    action = 'local';
  } else if (!localAt && hasLocalData()) {
    // 旧版本留下的本地数据，从未写过存档：以本地为准，存档内容转为备份
    action = 'migrate';
  } else if (fileAt > localAt) {
    action = 'restore';
  }

  if (action === 'restore') {
    const local = snapshotData();
    if (Object.keys(local).length) {
      const json = `{"version":${VERSION},"savedAt":${localAt || Date.now()},"data":${JSON.stringify(local)}}`;
      await invoke('store_backup', { json, tag: 'local' }).catch(() => {});
    }
    for (const [k, v] of Object.entries(file.data)) {
      if (isDataKey(k) && typeof v === 'string') {
        try { localStorage.setItem(k, v); } catch (err) { console.warn('[store] 恢复失败', k, err); }
      }
    }
    localStorage.setItem(SAVED_AT, String(fileAt));
    lastSaved = JSON.stringify(snapshotData());
  } else if (action === 'none' && file?.data) {
    lastSaved = JSON.stringify(snapshotData());
  }

  setLsWriteHook(markDirty);
  if (action === 'migrate' || action === 'local') await saveNow({ backup: action === 'migrate' });

  // 关窗 / 切到后台时尽量落盘（主要依赖 800ms 防抖，这里兜底）
  const flush = () => { if (timer || localStorage.getItem(DIRTY)) saveNow(); };
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  return action;
}
