// PDF 播放模块：pdf.js 渲染缩略图 + 输出高清页

import * as pdfjsLib from '../lib/pdfjs/pdf.min.mjs';
import { pickFiles, esc, fileName, convertFileSrc, lsGet, lsSet, toast } from './util.js';
import { pushToOutput, clearOutput, currentOutputSeq } from './output-main.js';
import {
  renderDirList, filterByFolder, folderTitle, addFolder, renameFolder, removeFolder,
  assignPath, listFolders, getSelectedFolder, FOLDER_ALL, FOLDER_UNCAT,
  getDisplayName, promptRenameMedia, setDisplayName, getViewSize, bindViewZoom,
} from './media-library.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../lib/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

const LS_KEY = 'sp.pdf.paths';

let docs = [];          // [{ name, path, pdfDoc, numPages, thumbs, ratios }]
let currentDoc = -1;
let currentPage = -1;
let showSeq = 0;
/** path#page → dataUrl，节目单连翻时避免每页重渲 */
const pageCache = new Map();
/** path → 正在加载的 Promise，避免并发重复解析同一本 PDF（旧实例会泄漏） */
const loading = new Map();

const $ = (id) => document.getElementById(id);

function docItems() {
  return docs.map((d) => ({ path: d.path, name: d.name }));
}

function visibleDocs() {
  return filterByFolder('pdf', docItems());
}

/** 释放单页渲染资源（cleanup 返回布尔值，非 Promise） */
function releasePage(page) {
  try { page.cleanup(); } catch { /* ignore */ }
}

/** 销毁 pdf.js 文档并清掉该路径的页缓存 */
function destroyDoc(d) {
  if (!d) return;
  if (d.pdfDoc) {
    d.pdfDoc.destroy().catch(() => {});
    d.pdfDoc = null;
  }
  const prefix = `${d.path}#`;
  for (const k of [...pageCache.keys()]) {
    if (k.startsWith(prefix)) pageCache.delete(k);
  }
}

function pageCacheKey(path, pageIndex) {
  return `${path}#${pageIndex}`;
}

function rememberPage(path, pageIndex, dataUrl) {
  pageCache.set(pageCacheKey(path, pageIndex), dataUrl);
  while (pageCache.size > 24) {
    pageCache.delete(pageCache.keys().next().value);
  }
}

function ensureVisibleDocSelected() {
  const vis = visibleDocs();
  if (!vis.length) {
    if (currentDoc >= 0) {
      currentDoc = -1;
      currentPage = -1;
      const grid = $('pdf-grid');
      if (grid) grid.innerHTML = '<div class="empty-tip">此目录暂无文档</div>';
      const info = $('pdf-info');
      if (info) info.textContent = '';
    }
    return;
  }
  const still = currentDoc >= 0 && vis.some((d) => d.path === docs[currentDoc]?.path);
  if (still) return;
  const i = docs.findIndex((d) => d.path === vis[0].path);
  if (i >= 0) selectDoc(i).catch(() => {});
}

function renderDocs() {
  renderDirList($('pdf-dirs'), 'pdf', docItems(), () => {
    renderDocs();
    ensureVisibleDocSelected();
  });
  const title = $('pdf-folder-title');
  if (title) title.textContent = folderTitle('pdf');

  const sel = $('pdf-doc-select');
  const vis = visibleDocs();
  const countEl = $('pdf-docs-count');
  if (countEl) countEl.textContent = String(vis.length);

  if (sel) {
    sel.innerHTML = vis.length
      ? vis.map((d) => {
        const i = docs.findIndex((x) => x.path === d.path);
        const pages = docs[i]?.pdfDoc ? `${docs[i].numPages}页` : '待加载';
        return `<option value="${i}" ${i === currentDoc ? 'selected' : ''}>${esc(d.name)} · ${pages}</option>`;
      }).join('')
      : '<option value="">此目录暂无文档</option>';
  }

  const move = $('pdf-move-folder');
  if (move) {
    move.innerHTML = `<option value="">移入目录…</option>`
      + `<option value="${FOLDER_UNCAT}">未分类</option>`
      + listFolders('pdf').map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('');
  }

  // 左侧列出当前目录下的文档（数量与角标一致）
  const docList = $('pdf-docs');
  if (docList) {
    docList.innerHTML = vis.length
      ? vis.map((d) => {
        const i = docs.findIndex((x) => x.path === d.path);
        const doc = docs[i];
        const pages = doc?.pdfDoc ? `${doc.numPages}页` : '待加载';
        return `
      <div class="file-item ${i === currentDoc ? 'active' : ''}" data-i="${i}" title="${esc(d.path)}">
        <span class="fi-icon">PDF</span>
        <span class="fi-name">${esc(d.name)}</span>
        <span class="fi-badge">${pages}</span>
      </div>`;
      }).join('')
      : '<div class="empty-tip">此目录暂无文档</div>';
  }
}

function renderGrid(d) {
  const grid = $('pdf-grid');
  const info = $('pdf-info');
  if (!grid || !d) return;
  grid.innerHTML = '';
  const total = d.numPages || (d.thumbs || []).length;
  for (let i = 0; i < total; i++) {
    const src = d.thumbs?.[i] || '';
    const cell = document.createElement('div');
    cell.className = 'thumb-cell' + (i === currentPage ? ' active' : '');
    cell.dataset.i = i;
    const img = document.createElement('img');
    if (src) img.src = src;
    else {
      img.alt = '加载中';
      img.style.background = '#1a1a22';
      img.style.minHeight = '80px';
    }
    img.draggable = false;
    const num = document.createElement('div');
    num.className = 'thumb-num';
    num.textContent = i + 1;
    cell.appendChild(img);
    cell.appendChild(num);
    grid.appendChild(cell);
  }
  if (info) {
    info.textContent = currentPage >= 0
      ? `${currentPage + 1} / ${d.numPages}`
      : `共 ${d.numPages} 页`;
  }
}

function thumbTargetWidth() {
  return getViewSize('pdf', 180);
}

async function selectDoc(i) {
  if (i < 0 || i >= docs.length) return;
  currentDoc = i;
  currentPage = -1;
  renderDocs();
  try {
    await openPdf(docs[i].path);
  } catch (err) {
    toast(`打开失败：${fileName(docs[i].path)} — ${err}`, 6000);
    $('pdf-grid').innerHTML = '<div class="empty-tip big">无法打开该 PDF</div>';
    return;
  }
  const d = docs[i];
  renderDocs();
  // 先出空格子，缩略图按需渲染，避免启动/切文档卡死
  if (!d.thumbs) {
    d.thumbs = Array(d.numPages).fill('');
    renderGrid(d);
    renderThumbsLazy(d).catch(() => {});
  } else {
    renderGrid(d);
  }
}

/** 逐页补缩略图，可被快速切文档打断 */
async function renderThumbsLazy(d) {
  if (!d?.pdfDoc) return;
  d.ratios = d.ratios || [];
  const tw = thumbTargetWidth();
  for (let n = 1; n <= d.numPages; n++) {
    if (docs[currentDoc] !== d) return;
    if (d.thumbs[n - 1]) continue;
    try {
      const page = await d.pdfDoc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      d.ratios[n - 1] = base.width / base.height;
      const vp = page.getViewport({ scale: tw / base.width });
      const canvas = document.createElement('canvas');
      canvas.width = vp.width;
      canvas.height = vp.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      releasePage(page);
      d.thumbs[n - 1] = canvas.toDataURL('image/jpeg', 0.8);
      if (docs[currentDoc] === d && currentModule() === 'pdf') {
        const cell = $('pdf-grid')?.querySelector(`.thumb-cell[data-i="${n - 1}"] img`);
        if (cell) cell.src = d.thumbs[n - 1];
      }
    } catch { /* 单页失败不影响其余 */ }
    await new Promise((r) => requestAnimationFrame(() => r()));
  }
}

function refreshPdfThumbsForZoom() {
  if (currentDoc < 0) return;
  const d = docs[currentDoc];
  if (!d?.pdfDoc) return;
  d.thumbs = Array(d.numPages).fill('');
  renderGrid(d);
  renderThumbsLazy(d).catch(() => {});
}

function highlightPdfPage(i) {
  const grid = $('pdf-grid');
  const info = $('pdf-info');
  if (grid) {
    grid.querySelectorAll('.thumb-cell').forEach((c) => {
      c.classList.toggle('active', +c.dataset.i === i);
    });
  }
  if (info && currentDoc >= 0) {
    const d = docs[currentDoc];
    info.textContent = i >= 0 ? `${i + 1} / ${d.numPages}` : `共 ${d.numPages} 页`;
  }
}

async function renderPageDataUrl(d, pageIndex) {
  const cached = pageCache.get(pageCacheKey(d.path, pageIndex));
  if (cached) return cached;
  const page = await d.pdfDoc.getPage(pageIndex + 1);
  const base = page.getViewport({ scale: 1 });
  // 输出足够清晰，比原先 1920×3 轻量，切换更顺
  const scale = Math.min(1600 / base.width, 2.4);
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = vp.width;
  canvas.height = vp.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  releasePage(page);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
  rememberPage(d.path, pageIndex, dataUrl);
  return dataUrl;
}

/** opts.stay：节目单连翻，不重建 PDF 页缩略图网格 */
async function showPage(i, opts = {}) {
  if (currentDoc < 0) return false;
  const d = docs[currentDoc];
  if (!d?.pdfDoc || i < 0 || i >= d.numPages) return false;
  const seq = ++showSeq;
  // 渲染需要时间：记下当前输出世代，期间手动黑屏则不再推送
  const outSeq = opts.outputSeq ?? currentOutputSeq();
  try {
    const dataUrl = await renderPageDataUrl(d, i);
    if (seq !== showSeq) return false; // 已被更快的下一条取代
    currentPage = i;
    if (!opts.stay && currentModule() === 'pdf') {
      if (d.thumbs?.length) highlightPdfPage(i);
      else renderGrid(d);
    } else if (currentModule() === 'pdf' && d.thumbs?.length) {
      highlightPdfPage(i);
    }
    const ok = pushToOutput({ kind: 'pdf', dataUrl, index: i, total: d.numPages }, outSeq);
    if (ok === false) return false;
    // 预热相邻页，连按 Enter 更顺
    const warm = [i + 1, i - 1].filter((p) => p >= 0 && p < d.numPages && !pageCache.has(pageCacheKey(d.path, p)));
    for (const p of warm) {
      renderPageDataUrl(d, p).catch(() => {});
    }
    return true;
  } catch {
    return false;
  }
}

function persistPaths() {
  lsSet(LS_KEY, docs.map((d) => ({ path: d.path, name: d.name })));
}

function currentModule() {
  return document.querySelector('.tab.active')?.dataset.module;
}

function defaultDocName(path) {
  return getDisplayName(path, fileName(path).replace(/\.pdf$/i, ''));
}

function renameCurrentDoc() {
  if (currentDoc < 0) return toast('请先选择文档');
  const d = docs[currentDoc];
  const n = promptRenameMedia(d.path, d.name);
  if (n == null) return;
  if (n === false) return toast('名称不能为空');
  d.name = n;
  persistPaths();
  renderDocs();
  toast('已重命名');
}

function registerStub(path, name) {
  const existing = docs.findIndex((d) => d.path === path);
  if (existing >= 0) {
    if (name) docs[existing].name = name;
    return existing;
  }
  docs.push({
    name: name || defaultDocName(path),
    path,
    pdfDoc: null,
    numPages: 0,
  });
  return docs.length - 1;
}

function openPdf(path) {
  const existing = docs.findIndex((d) => d.path === path);
  if (existing >= 0 && docs[existing].pdfDoc) return Promise.resolve(existing);
  let p = loading.get(path);
  if (!p) {
    p = loadPdf(path).finally(() => loading.delete(path));
    loading.set(path, p);
  }
  return p;
}

async function loadPdf(path) {
  const resp = await fetch(convertFileSrc(path));
  if (!resp.ok) throw new Error('无法读取文件');
  const data = new Uint8Array(await resp.arrayBuffer());
  const pdfDoc = await pdfjsLib.getDocument({ data }).promise;
  const existing = docs.findIndex((d) => d.path === path);
  const keepName = existing >= 0 ? docs[existing].name : defaultDocName(path);
  const entry = {
    name: keepName || defaultDocName(path),
    path,
    pdfDoc,
    numPages: pdfDoc.numPages,
  };
  if (existing >= 0) {
    docs[existing] = { ...docs[existing], ...entry };
    persistPaths();
    return existing;
  }
  docs.push(entry);
  persistPaths();
  return docs.length - 1;
}

export function initPdf() {
  const grid = $('pdf-grid');
  const docList = $('pdf-docs');
  const btnPrev = $('pdf-prev');
  const btnNext = $('pdf-next');

  btnPrev.addEventListener('click', () => navigate(-1));
  btnNext.addEventListener('click', () => navigate(1));

  docList?.addEventListener('click', (e) => {
    const item = e.target.closest('.file-item');
    if (item) selectDoc(+item.dataset.i);
  });
  $('pdf-doc-select')?.addEventListener('change', (e) => {
    const i = +e.target.value;
    if (Number.isFinite(i) && i >= 0) selectDoc(i).catch(() => {});
  });
  $('pdf-dir-add')?.addEventListener('click', () => {
    const name = window.prompt('新建目录名称', '查经讲义');
    if (name == null) return;
    if (addFolder('pdf', name)) { renderDocs(); toast('已创建目录'); }
    else toast('目录名无效或已存在');
  });
  $('pdf-dir-rename')?.addEventListener('click', () => {
    const id = getSelectedFolder('pdf');
    if (id === FOLDER_ALL || id === FOLDER_UNCAT) return toast('请先选中自定义目录');
    const cur = listFolders('pdf').find((f) => f.id === id);
    const name = window.prompt('重命名目录', cur?.name || '');
    if (name == null) return;
    if (renameFolder('pdf', id, name)) renderDocs();
  });
  $('pdf-dir-del')?.addEventListener('click', () => {
    const id = getSelectedFolder('pdf');
    if (id === FOLDER_ALL || id === FOLDER_UNCAT) return toast('请先选中自定义目录');
    if (!window.confirm('删除此目录？文档会回到未分类')) return;
    removeFolder('pdf', id);
    renderDocs();
  });
  $('pdf-move-folder')?.addEventListener('change', (e) => {
    const fid = e.target.value;
    if (!fid || currentDoc < 0) { e.target.value = ''; return; }
    assignPath('pdf', docs[currentDoc].path, fid === FOLDER_UNCAT ? null : fid);
    e.target.value = '';
    renderDocs();
    toast('已移动到目录');
  });
  $('pdf-rename-doc')?.addEventListener('click', () => renameCurrentDoc());
  bindViewZoom('pdf', { def: 180, onChange: () => refreshPdfThumbsForZoom() });

  grid.addEventListener('click', (e) => {
    const cell = e.target.closest('.thumb-cell');
    if (cell) showPage(+cell.dataset.i);
  });

  document.addEventListener('sp:import-pdf', async () => {
    const files = await pickFiles([{ name: 'PDF', extensions: ['pdf'] }], '导入 PDF');
    if (!files.length) return;
    for (const f of files) {
      try {
        const di = await openPdf(f);
        if (currentDoc < 0) await selectDoc(di);
      } catch (err) {
        toast(`打开失败：${fileName(f)} — ${err}`, 6000);
      }
    }
    renderDocs();
  });

  document.addEventListener('sp:clear-list', () => {
    if (currentModule() !== 'pdf') return;
    docs.forEach(destroyDoc);
    docs = [];
    pageCache.clear();
    currentDoc = -1;
    currentPage = -1;
    persistPaths();
    clearOutput();
    renderDocs();
    $('pdf-grid').innerHTML = '<div class="empty-tip big">导入 PDF 文件开始播放</div>';
    $('pdf-info').textContent = '';
  });

  // 启动只恢复路径，点开/节目单需要时再打开（避免全量渲缩略图卡住开场）
  const saved = lsGet(LS_KEY, []);
  if (Array.isArray(saved) && saved.length) {
    for (const p of saved) {
      if (typeof p === 'string' && p) {
        registerStub(p);
      } else if (p?.path) {
        registerStub(p.path, p.name);
        if (p.name) setDisplayName(p.path, p.name);
      }
    }
    persistPaths();
    renderDocs();
    // 启动不自动打开文档（避免启动即渲全页缩略图导致 OOM）；点左侧列表再加载
    if (docs.length) {
      const grid = $('pdf-grid');
      if (grid) {
        grid.innerHTML = '<div class="empty-tip big">点击左侧文档列表打开预览</div>';
      }
      toast(`已恢复 ${docs.length} 个 PDF（点左侧打开）`);
    }
  } else {
    renderDocs();
  }
}

function navigate(delta) {
  if (currentDoc < 0) return false;
  const start = currentPage < 0 ? (delta > 0 ? -1 : 0) : currentPage;
  showPage(start + delta);
  return true;
}

/** 键盘翻页 */
export function pdfNavigate(delta) {
  return navigate(delta);
}

/** 返回 PDF 页数（节目单按页展开用） */
export async function getPageCount(path) {
  const di = await openPdf(path);
  return docs[di].numPages;
}

/** 把某一页缩略图画进容器（节目单小图/大图） */
export async function mountPdfPreview(container, path, pageIndex = 0) {
  if (!container) return false;
  const di = await openPdf(path);
  const d = docs[di];
  if (pageIndex < 0 || pageIndex >= d.numPages) return false;
  const page = await d.pdfDoc.getPage(pageIndex + 1);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(320 / base.width, 2.2);
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = vp.width;
  canvas.height = vp.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  // 仅释放该页的渲染资源；不 cleanup 整本文档（会导致下一条节目整本重解析：内存抖动 + 并发竞态）
  releasePage(page);
  container.innerHTML = '';
  canvas.className = 'pg-thumb-canvas';
  canvas.style.width = '100%';
  canvas.style.height = 'auto';
  container.appendChild(canvas);
  return true;
}

/** 播放指定页（0-based）；节目单 stay 时不拉全本缩略图、不切 Tab */
export async function playPage(path, pageIndex = 0, opts = {}) {
  if (!opts.stay) {
    document.dispatchEvent(new CustomEvent('sp:switch-module', { detail: 'pdf' }));
  }
  const di = await openPdf(path);
  if (opts.stay) {
    currentDoc = di;
    const ok = await showPage(pageIndex, { stay: true, outputSeq: opts.outputSeq });
    if (!ok) throw new Error(`页码越界：${pageIndex + 1}`);
    return;
  }
  await selectDoc(di);
  const ok = await showPage(pageIndex, { outputSeq: opts.outputSeq });
  if (!ok) throw new Error(`页码越界：${pageIndex + 1}`);
}

/** 节目单/外部调用；opts.stay=true 时不切换 Tab */
export async function playByPath(path, opts = {}) {
  const page = Number.isInteger(opts.page) ? opts.page : 0;
  try {
    await playPage(path, page, opts);
  } catch (err) {
    toast(`打开失败：${fileName(path)} — ${err}`, 6000);
    throw err;
  }
}
