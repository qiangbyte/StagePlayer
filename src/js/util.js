// 基础工具：封装 Tauri API（withGlobalTauri 模式）

export const invoke = (cmd, args = {}) => window.__TAURI__.core.invoke(cmd, args);
export const listen = (event, handler) => window.__TAURI__.event.listen(event, handler);
export const emit = (event, payload) => window.__TAURI__.event.emit(event, payload);
/** 兼容旧调用：emit 本身已返回 Promise */
export const emitAsync = emit;
export const convertFileSrc = (p) => window.__TAURI__.core.convertFileSrc(p);

export async function pickFiles(extensions, title = '选择文件') {
  // extensions: 字符串数组 或 [{ extensions: [...] }] 混合形式
  const flat = (extensions || [])
    .flatMap((e) => (typeof e === 'string' ? [e] : (e.extensions || [])));
  try {
    const r = await invoke('pick_files', { title, extensions: flat });
    return Array.isArray(r) ? r : [];
  } catch (err) {
    toast('打开文件选择器失败：' + err);
    return [];
  }
}

/** 底部提示条 */
export function toast(msg, ms = 4000) {
  let box = document.getElementById('sp-toast-box');
  if (!box) {
    box = document.createElement('div');
    box.id = 'sp-toast-box';
    document.body.appendChild(box);
  }
  const t = document.createElement('div');
  t.className = 'sp-toast';
  t.textContent = String(msg);
  box.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

export function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function fmtTimeLong(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function fileName(p) {
  return String(p).replace(/\\/g, '/').split('/').pop() || p;
}

export function fileExt(p) {
  const n = fileName(p);
  const i = n.lastIndexOf('.');
  return i < 0 ? '' : n.slice(i + 1).toLowerCase();
}

export function lsGet(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

const lsMemo = new Map(); // key → { raw, val }

/**
 * 同 lsGet，但原始字符串未变时复用上次解析结果（定时器热路径用，避免反复 JSON.parse 整个节目单）
 * 返回值是共享对象：调用方只读，需要修改请先拷贝
 */
export function lsGetCached(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const hit = lsMemo.get(key);
    if (hit && hit.raw === raw) return hit.val;
    const val = JSON.parse(raw);
    lsMemo.set(key, { raw, val });
    return val;
  } catch {
    return fallback;
  }
}

/** @returns {boolean} 是否写入成功 */
export function lsSet(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
    return true;
  } catch (err) {
    const name = err?.name || '';
    if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') {
      console.warn('[lsSet] QuotaExceeded', key);
    }
    return false;
  }
}

/** 估算 localStorage 已用字符数（粗略） */
export function lsApproxBytes() {
  let n = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      n += (k?.length || 0) + (localStorage.getItem(k)?.length || 0);
    }
  } catch { /* ignore */ }
  return n * 2; // UTF-16
}

export const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'wma', 'opus'];
export const VIDEO_EXT = ['mp4', 'webm', 'm4v', 'mov', 'mkv', 'avi'];
export const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'];
export const PPT_EXT = ['pptx'];
export const PDF_EXT = ['pdf'];

/** 根据扩展名判断节目类型 */
export function detectMediaType(path) {
  const ext = fileExt(path);
  if (AUDIO_EXT.includes(ext)) return 'audio';
  if (VIDEO_EXT.includes(ext)) return 'video';
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (PPT_EXT.includes(ext)) return 'ppt';
  if (PDF_EXT.includes(ext)) return 'pdf';
  return null;
}
