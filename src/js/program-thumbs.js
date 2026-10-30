// 节目单 · 网格缩略图（图片/视频/PPT/PDF/空白页/经文），限并发 + LRU 缓存

import { esc, convertFileSrc, invoke } from './util.js';
import { mountSlidePreview } from './ppt.js';
import { mountPdfPreview } from './pdf.js';
import { mountBlankPreview } from './blank-page.js';
import { mountBiblePreview } from './bible-page.js';

const $ = (id) => document.getElementById(id);

let thumbToken = 0;
/** 节目缩略图缓存（LRU），避免切换/重绘时重复解码 */
const thumbCache = new Map();
const THUMB_CONCURRENCY = 2; // 2 路并发：兼顾速度与内存

/** 作废进行中的缩略图任务（列表清空/切换视图时） */
export function cancelThumbs() {
  thumbToken++;
}

// 由 program.js 注入的宿主回调（避免与 program.js 循环引用）
let TYPE_META, curEvent, syncCueCountdowns, syncItemRemain, viewMode;

export function bindThumbsHost(h) {
  ({ TYPE_META, curEvent, syncCueCountdowns, syncItemRemain, viewMode } = h);
}

function thumbCacheKey(item) {
  if (item.type === 'blank') {
    return [
      'blank', item.id, item.blankKind, item.title, item.subtitle,
      (item.body || '').slice(0, 48), item.accent, item.bgPreset, item.bgImage || '',
    ].join('|');
  }
  if (item.type === 'bible') {
    return [
      'bible', item.id, item.ref, (item.body || '').slice(0, 48), item.accent,
      item.pageIndex, item.pageTotal,
    ].join('|');
  }
  return `${item.type}|${item.path}|${item.page ?? 0}`;
}

function rememberThumb(key, value) {
  thumbCache.set(key, value);
  while (thumbCache.size > 64) {
    thumbCache.delete(thumbCache.keys().next().value);
  }
}

async function captureVideoThumb(path) {
  const key = `video|${path}|0`;
  if (thumbCache.has(key)) return thumbCache.get(key);
  // 系统缩略图（Rust 侧，不在 WebView 里加载视频）；无系统解码器时回退截帧
  const url = await invoke('make_video_thumb', { path }).catch(() => null)
    || await captureVideoFrame(path);
  if (url) rememberThumb(key, url);
  return url || null;
}

/** 回退：用 <video> 加载并截取开头一帧 */
function captureVideoFrame(path) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.src = convertFileSrc(path);
    let settled = false;
    const finish = (url) => {
      if (settled) return;
      settled = true;
      try { v.removeAttribute('src'); v.load(); } catch { /* ignore */ }
      v.remove();
      resolve(url || null);
    };
    const timer = setTimeout(() => finish(null), 4000);
    v.addEventListener('seeked', () => {
      try {
        const w = 320;
        const h = 180;
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        c.getContext('2d').drawImage(v, 0, 0, w, h);
        const url = c.toDataURL('image/jpeg', 0.72);
        clearTimeout(timer);
        finish(url);
      } catch {
        clearTimeout(timer);
        finish(null);
      }
    }, { once: true });
    v.addEventListener('loadeddata', () => {
      try { v.currentTime = Math.min(0.25, (v.duration || 1) * 0.05); } catch {
        clearTimeout(timer);
        finish(null);
      }
    }, { once: true });
    v.addEventListener('error', () => {
      clearTimeout(timer);
      finish(null);
    }, { once: true });
  });
}

export async function fillItemThumbs() {
  const token = ++thumbToken;
  const box = $('pg-items');
  if (!box || viewMode() !== 'grid') return;
  const thumbs = [...box.querySelectorAll('.pg-thumb')];
  const byId = new Map((curEvent()?.items || []).map((i) => [i.id, i]));
  let cursor = 0;
  const worker = async () => {
    while (cursor < thumbs.length) {
      if (token !== thumbToken || viewMode() !== 'grid') return;
      const el = thumbs[cursor++];
      const row = el.closest('.pg-item');
      const id = row?.dataset.id;
      const item = byId.get(id);
      if (!item || thumbReady(el, item)) continue;
      try {
        await mountItemThumb(el, item, token);
      } catch {
        if (token !== thumbToken) return;
        restoreThumbFallback(el, item);
      }
      // 让出主线程，切换列表时不卡死
      await new Promise((r) => requestAnimationFrame(() => r()));
    }
  };
  const n = Math.min(THUMB_CONCURRENCY, thumbs.length || 1);
  await Promise.all(Array.from({ length: n }, () => worker()));
  if (token === thumbToken) {
    syncItemRemain();
    syncCueCountdowns();
  }
}

function restoreThumbFallback(el, item) {
  const keep = [...el.querySelectorAll('.pg-corner-num, .pg-corner-tag, .pg-hover-bar, .pg-remain, .pg-cue')];
  el.innerHTML = `<span class="pg-thumb-ph">${TYPE_META[item.type]?.icon || '▪'}</span>`;
  for (const node of keep) el.appendChild(node);
}

/** 填充预览时保留角标与悬停操作条 */
function preserveThumbChrome(el, fillFn) {
  const keep = [...el.querySelectorAll('.pg-corner-num, .pg-corner-tag, .pg-hover-bar, .pg-remain, .pg-cue')];
  fillFn();
  for (const node of keep) el.appendChild(node);
}

function captureThumbChrome(el) {
  return [...el.querySelectorAll('.pg-corner-num, .pg-corner-tag, .pg-hover-bar, .pg-remain, .pg-cue')];
}

function applyThumbChrome(el, keep) {
  for (const node of keep) el.appendChild(node);
}

function putThumbImage(el, url, alt = '') {
  preserveThumbChrome(el, () => {
    el.innerHTML = '';
    const img = document.createElement('img');
    img.className = 'pg-thumb-img';
    img.src = url;
    img.draggable = false;
    img.alt = alt;
    el.appendChild(img);
  });
}

async function captureImageThumb(path) {
  const key = `image|${path}|0`;
  if (thumbCache.has(key)) return thumbCache.get(key);
  try {
    // 由 Rust 原生生成小图 dataURL，避免渲染进程解码原图 OOM
    const url = await invoke('make_image_thumb', { path });
    if (url) rememberThumb(key, url);
    return url || null;
  } catch {
    return null;
  }
}

/** 该格子已画好当前版本的缩略图（复用行无需重画） */
function thumbReady(el, item) {
  return el.dataset.thumbKey === thumbCacheKey(item)
    && !!el.querySelector('.pg-thumb-img, .slide-canvas, .pg-blank-thumb, .pg-bible-thumb, .pg-thumb-audio');
}

async function mountItemThumb(el, item, token = thumbToken) {
  if (!el || !item || token !== thumbToken) return;
  if (thumbReady(el, item)) return;
  const key = thumbCacheKey(item);

  if (item.type === 'image') {
    let url = thumbCache.get(key);
    if (!url) url = await captureImageThumb(item.path);
    if (token !== thumbToken || viewMode() !== 'grid') return;
    if (url) {
      putThumbImage(el, url, item.name || '');
      el.dataset.thumbKey = key;
      return;
    }
    restoreThumbFallback(el, item);
    return;
  }
  if (item.type === 'video') {
    let url = thumbCache.get(key);
    if (!url) url = await captureVideoThumb(item.path);
    if (token !== thumbToken || viewMode() !== 'grid') return;
    if (url) {
      putThumbImage(el, url, item.name || '');
      el.dataset.thumbKey = key;
      return;
    }
    restoreThumbFallback(el, item);
    return;
  }
  if (item.type === 'blank') {
    const cached = thumbCache.get(key);
    if (cached?.nodeType === 1) {
      preserveThumbChrome(el, () => {
        el.innerHTML = '';
        el.appendChild(cached.cloneNode(true));
      });
      el.dataset.thumbKey = key;
      return;
    }
    mountBlankPreview(el, item);
    const stage = el.querySelector('.pg-blank-thumb');
    if (stage) rememberThumb(key, stage.cloneNode(true));
    el.dataset.thumbKey = key;
    return;
  }
  if (item.type === 'bible') {
    const cached = thumbCache.get(key);
    if (cached?.nodeType === 1) {
      preserveThumbChrome(el, () => {
        el.innerHTML = '';
        el.appendChild(cached.cloneNode(true));
      });
      el.dataset.thumbKey = key;
      return;
    }
    mountBiblePreview(el, item);
    const stage = el.querySelector('.pg-bible-thumb');
    if (stage) rememberThumb(key, stage.cloneNode(true));
    el.dataset.thumbKey = key;
    return;
  }
  // PPT：缓存克隆的 slide-canvas，避免每次重解析/重渲
  if (item.type === 'ppt') {
    const cached = thumbCache.get(key);
    if (cached?.nodeType === 1) {
      preserveThumbChrome(el, () => {
        el.innerHTML = '';
        const node = cached.cloneNode(true);
        node.style.width = '100%';
        node.style.height = '100%';
        node.style.aspectRatio = 'auto';
        el.appendChild(node);
      });
      el.dataset.thumbKey = key;
      return;
    }
    const ok = await mountSlidePreview(el, item.path, item.page ?? 0);
    if (token !== thumbToken || viewMode() !== 'grid') return;
    const canvas = el.querySelector('.slide-canvas');
    if (!ok || !canvas) {
      restoreThumbFallback(el, item);
      return;
    }
    rememberThumb(key, canvas.cloneNode(true));
    el.dataset.thumbKey = key;
    return;
  }
  if (item.type === 'pdf') {
    let url = thumbCache.get(key);
    if (!url) {
      const holder = document.createElement('div');
      holder.style.cssText = 'position:fixed;left:-10000px;top:0;width:320px;height:180px;overflow:hidden;pointer-events:none';
      document.body.appendChild(holder);
      try {
        await mountPdfPreview(holder, item.path, item.page ?? 0);
        if (token !== thumbToken) return;
        const canvas = holder.querySelector('canvas');
        if (canvas) {
          url = canvas.toDataURL('image/jpeg', 0.72);
          rememberThumb(key, url);
        }
      } finally {
        holder.remove();
      }
    }
    if (token !== thumbToken || viewMode() !== 'grid') return;
    if (url) {
      putThumbImage(el, url, item.name || '');
      el.dataset.thumbKey = key;
      return;
    }
    const keep = captureThumbChrome(el);
    await mountPdfPreview(el, item.path, item.page ?? 0);
    if (token !== thumbToken) return;
    applyThumbChrome(el, keep);
    el.dataset.thumbKey = key;
    return;
  }
  // audio / fallback
  const meta = TYPE_META[item.type] || { icon: '♪', label: '音乐', color: '#3dd55f' };
  preserveThumbChrome(el, () => {
    el.innerHTML = `<div class="pg-thumb-audio" style="--c:${meta.color}"><span>${meta.icon}</span><em>${esc(meta.label)}</em></div>`;
  });
  el.dataset.thumbKey = key;
}
