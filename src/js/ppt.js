// PPT 播放模块：解析 pptx → 幻灯片网格 → 输出同步

import { pickFiles, esc, fileName, invoke, lsGet, lsSet, toast } from './util.js';
import { pushToOutput } from './output-main.js';
import { renderSlide, makeSlideCanvas } from './slide-render.js';
import {
  renderDirList, filterByFolder, folderTitle, addFolder, renameFolder, removeFolder,
  assignPath, listFolders, getSelectedFolder, FOLDER_ALL, FOLDER_UNCAT,
  getDisplayName, promptRenameMedia, setDisplayName, bindViewZoom,
} from './media-library.js';

const LS_KEY = 'sp.ppt.paths';

let docs = [];          // [{ name, path, doc|null }] doc 惰性解析
let currentDoc = -1;
let currentSlide = -1;
/** path → 正在解析的 Promise，节目单并发取缩略图时只解析一次 */
const parsing = new Map();

const $ = (id) => document.getElementById(id);

function parseOnce(path) {
  let p = parsing.get(path);
  if (!p) {
    p = invoke('parse_pptx', { path }).finally(() => parsing.delete(path));
    parsing.set(path, p);
  }
  return p;
}

function docItems() {
  return docs.map((d) => ({ path: d.path, name: d.name }));
}

function visibleDocs() {
  return filterByFolder('ppt', docItems());
}

function ratio() {
  if (currentDoc < 0) return 16 / 9;
  const d = docs[currentDoc].doc;
  if (!d) return 16 / 9;
  return d.slide_width / d.slide_height || 16 / 9;
}

function ensureVisibleDocSelected() {
  const vis = visibleDocs();
  if (!vis.length) {
    if (currentDoc >= 0) {
      currentDoc = -1;
      currentSlide = -1;
      renderGrid();
    }
    return;
  }
  const still = currentDoc >= 0 && vis.some((d) => d.path === docs[currentDoc]?.path);
  if (still) return;
  const i = docs.findIndex((d) => d.path === vis[0].path);
  if (i >= 0) selectDoc(i).catch(() => {});
}

function renderDocs() {
  renderDirList($('ppt-dirs'), 'ppt', docItems(), () => {
    renderDocs();
    ensureVisibleDocSelected();
  });
  const title = $('ppt-folder-title');
  if (title) title.textContent = folderTitle('ppt');

  const sel = $('ppt-doc-select');
  const vis = visibleDocs();
  const countEl = $('ppt-docs-count');
  if (countEl) countEl.textContent = String(vis.length);

  if (sel) {
    sel.innerHTML = vis.length
      ? vis.map((d) => {
        const i = docs.findIndex((x) => x.path === d.path);
        const pages = docs[i]?.doc ? `${docs[i].doc.slides.length}页` : '待加载';
        return `<option value="${i}" ${i === currentDoc ? 'selected' : ''}>${esc(d.name)} · ${pages}</option>`;
      }).join('')
      : '<option value="">此目录暂无文稿</option>';
  }

  const move = $('ppt-move-folder');
  if (move) {
    move.innerHTML = `<option value="">移入目录…</option>`
      + `<option value="${FOLDER_UNCAT}">未分类</option>`
      + listFolders('ppt').map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('');
  }

  // 左侧列出当前目录下的文稿（数量与角标一致）
  const docList = $('ppt-docs');
  if (docList) {
    docList.innerHTML = vis.length
      ? vis.map((d) => {
        const i = docs.findIndex((x) => x.path === d.path);
        const doc = docs[i];
        const pages = doc?.doc ? `${doc.doc.slides.length}页` : '待加载';
        return `
      <div class="file-item ${i === currentDoc ? 'active' : ''}" data-i="${i}" title="${esc(d.path)}">
        <span class="fi-icon">P</span>
        <span class="fi-name">${esc(d.name)}</span>
        <span class="fi-badge">${pages}</span>
      </div>`;
      }).join('')
      : '<div class="empty-tip">此目录暂无文稿</div>';
  }
}

function renderGrid() {
  const grid = $('ppt-grid');
  const info = $('ppt-info');
  if (!grid) return;
  grid.innerHTML = '';
  if (currentDoc < 0) {
    grid.innerHTML = '<div class="empty-tip big">导入 .pptx 文件开始播放</div>';
    if (info) info.textContent = '';
    return;
  }
  const { doc } = docs[currentDoc];
  if (!doc) {
    grid.innerHTML = '<div class="empty-tip big">正在加载演示文稿…</div>';
    if (info) info.textContent = '';
    return;
  }
  const r = ratio();
  doc.slides.forEach((slide, i) => {
    const cell = document.createElement('div');
    cell.className = 'thumb-cell' + (i === currentSlide ? ' active' : '');
    cell.dataset.i = i;

    const num = document.createElement('div');
    num.className = 'thumb-num';
    num.textContent = i + 1;

    const canvas = makeSlideCanvas(r);
    renderSlide(canvas, slide);
    cell.appendChild(canvas);
    cell.appendChild(num);
    grid.appendChild(cell);
  });
  if (info) {
    info.textContent = currentSlide >= 0
      ? `${currentSlide + 1} / ${doc.slides.length}`
      : `共 ${doc.slides.length} 页`;
  }
}

async function ensureDocLoaded(i) {
  if (i < 0 || i >= docs.length) return -1;
  if (docs[i].doc) return i;
  const path = docs[i].path;
  const doc = await parseOnce(path);
  const j = docs.findIndex((d) => d.path === path);
  if (j < 0) return -1; // 解析期间列表被清空
  docs[j] = { name: docs[j].name || defaultDocName(path), path, doc };
  return j;
}

async function selectDoc(i) {
  if (i < 0 || i >= docs.length) return;
  currentDoc = i;
  currentSlide = -1;
  renderDocs();
  try {
    await ensureDocLoaded(i);
  } catch (err) {
    toast(`解析失败：${fileName(docs[i].path)} — ${err}`, 6000);
    renderGrid();
    return;
  }
  renderDocs();
  renderGrid();
}

/** 只改选中态，不重建整页缩略图网格 */
function highlightSlide(i) {
  const grid = $('ppt-grid');
  const info = $('ppt-info');
  if (grid) {
    const cells = grid.querySelectorAll('.thumb-cell');
    if (!cells.length) return false;
    cells.forEach((c) => c.classList.toggle('active', +c.dataset.i === i));
  }
  if (info && currentDoc >= 0 && docs[currentDoc].doc) {
    const total = docs[currentDoc].doc.slides.length;
    info.textContent = i >= 0 ? `${i + 1} / ${total}` : `共 ${total} 页`;
  }
  return true;
}

function goto(i, opts = {}) {
  if (currentDoc < 0) return false;
  const doc = docs[currentDoc].doc;
  if (!doc) return false;
  const slides = doc.slides;
  if (i < 0 || i >= slides.length) return false;
  currentSlide = i;
  if (!highlightSlide(i)) renderGrid();
  const ok = pushToOutput(
    { kind: 'ppt', slide: slides[i], index: i, total: slides.length },
    opts.outputSeq,
  );
  return ok !== false;
}

function persistPaths() {
  lsSet(LS_KEY, docs.map((d) => ({ path: d.path, name: d.name })));
}

function defaultDocName(path) {
  return getDisplayName(path, fileName(path).replace(/\.pptx$/i, ''));
}

function renameCurrentDoc() {
  if (currentDoc < 0) return toast('请先选择文稿');
  const d = docs[currentDoc];
  const n = promptRenameMedia(d.path, d.name);
  if (n == null) return;
  if (n === false) return toast('名称不能为空');
  d.name = n;
  persistPaths();
  renderDocs();
  toast('已重命名');
}

function currentModule() {
  return document.querySelector('.tab.active')?.dataset.module;
}

async function loadDoc(path, force = false) {
  const existing = docs.findIndex((d) => d.path === path);
  if (existing >= 0 && !force && docs[existing].doc) return existing;
  const doc = await parseOnce(path);
  const existingNow = docs.findIndex((d) => d.path === path);
  if (existingNow >= 0 && docs[existingNow].doc && !force) return existingNow;
  const keepName = existingNow >= 0 ? docs[existingNow].name : defaultDocName(path);
  const entry = { name: keepName || defaultDocName(path), path, doc };
  if (existingNow >= 0) {
    docs[existingNow] = entry;
    persistPaths();
    return existingNow;
  }
  docs.push(entry);
  persistPaths();
  return docs.length - 1;
}

/** 仅登记路径，不立刻解析（启动恢复用） */
function registerStub(path, name) {
  const existing = docs.findIndex((d) => d.path === path);
  if (existing >= 0) {
    if (name) docs[existing].name = name;
    return existing;
  }
  docs.push({ name: name || defaultDocName(path), path, doc: null });
  return docs.length - 1;
}

export function initPpt() {
  const grid = $('ppt-grid');
  const docList = $('ppt-docs');
  const btnPrev = $('ppt-prev');
  const btnNext = $('ppt-next');

  btnPrev.addEventListener('click', () => goto(currentSlide < 0 ? 0 : currentSlide - 1));
  btnNext.addEventListener('click', () => goto(currentSlide < 0 ? 0 : currentSlide + 1));

  docList?.addEventListener('click', (e) => {
    const item = e.target.closest('.file-item');
    if (item) selectDoc(+item.dataset.i).catch(() => {});
  });
  $('ppt-doc-select')?.addEventListener('change', (e) => {
    const i = +e.target.value;
    if (Number.isFinite(i) && i >= 0) selectDoc(i).catch(() => {});
  });
  $('ppt-dir-add')?.addEventListener('click', () => {
    const name = window.prompt('新建目录名称', '敬拜 PPT');
    if (name == null) return;
    if (addFolder('ppt', name)) { renderDocs(); toast('已创建目录'); }
    else toast('目录名无效或已存在');
  });
  $('ppt-dir-rename')?.addEventListener('click', () => {
    const id = getSelectedFolder('ppt');
    if (id === FOLDER_ALL || id === FOLDER_UNCAT) return toast('请先选中自定义目录');
    const cur = listFolders('ppt').find((f) => f.id === id);
    const name = window.prompt('重命名目录', cur?.name || '');
    if (name == null) return;
    if (renameFolder('ppt', id, name)) renderDocs();
  });
  $('ppt-dir-del')?.addEventListener('click', () => {
    const id = getSelectedFolder('ppt');
    if (id === FOLDER_ALL || id === FOLDER_UNCAT) return toast('请先选中自定义目录');
    if (!window.confirm('删除此目录？文稿会回到未分类')) return;
    removeFolder('ppt', id);
    renderDocs();
  });
  $('ppt-move-folder')?.addEventListener('change', (e) => {
    const fid = e.target.value;
    if (!fid || currentDoc < 0) { e.target.value = ''; return; }
    assignPath('ppt', docs[currentDoc].path, fid === FOLDER_UNCAT ? null : fid);
    e.target.value = '';
    renderDocs();
    toast('已移动到目录');
  });
  $('ppt-rename-doc')?.addEventListener('click', () => renameCurrentDoc());
  bindViewZoom('ppt', { def: 180 });

  grid.addEventListener('click', (e) => {
    const cell = e.target.closest('.thumb-cell');
    if (cell) goto(+cell.dataset.i);
  });

  document.addEventListener('sp:import-ppt', async () => {
    const files = await pickFiles([{ name: 'PowerPoint', extensions: ['pptx'] }], '导入 PPT');
    if (!files.length) return;
    for (const f of files) {
      try {
        const di = await loadDoc(f);
        if (currentDoc < 0) selectDoc(di);
      } catch (err) {
        toast(`解析失败：${fileName(f)} — ${err}`, 6000);
      }
    }
    renderDocs();
    renderGrid();
  });

  document.addEventListener('sp:clear-list', () => {
    if (currentModule() !== 'ppt') return;
    docs = [];
    currentDoc = -1;
    currentSlide = -1;
    persistPaths();
    pushToOutput({ kind: 'clear' });
    renderDocs();
    renderGrid();
  });

  // 启动只恢复路径列表，点开/节目单需要时再 parse（避免启动卡顿）
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
    // 启动不自动 parse 第一份（避免启动峰值内存）；点左侧文稿再加载
    if (docs.length) {
      renderGrid();
      const grid = $('ppt-grid');
      if (grid && currentDoc < 0) {
        grid.innerHTML = '<div class="empty-tip big">点击左侧文稿列表打开预览</div>';
      }
      toast(`已恢复 ${docs.length} 个 PPT（点左侧打开）`);
    } else {
      renderGrid();
    }
  } else {
    renderDocs();
    renderGrid();
  }
}

/** 键盘翻页（main.js 调用），返回是否消费了按键 */
export function pptNavigate(delta) {
  if (currentDoc < 0) return false;
  const start = currentSlide < 0 ? (delta > 0 ? -1 : 0) : currentSlide;
  return goto(start + delta);
}

/** 返回幻灯片页数（节目单按页展开用） */
export async function getPageCount(path) {
  const di = await loadDoc(path);
  return docs[di].doc.slides.length;
}

/** 把某一页缩略图画进容器（节目单小图/大图）——与输出预览同一套 HTML 幻灯片 */
export async function mountSlidePreview(container, path, pageIndex = 0) {
  if (!container) return false;
  const di = await loadDoc(path);
  const doc = docs[di].doc;
  const slide = doc.slides[pageIndex];
  if (!slide) return false;
  const r = doc.slide_width / doc.slide_height || 16 / 9;
  // 保留角标/悬停条（节目单缩略图）
  const keep = [...container.querySelectorAll('.pg-corner-num, .pg-corner-tag, .pg-hover-bar, .pg-remain, .pg-cue')];
  container.innerHTML = '';
  const canvas = makeSlideCanvas(r);
  if (container.classList.contains('pg-thumb')) {
    // 节目单缩略图：铺满 16:9 卡片（与右侧预览观感一致）
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.aspectRatio = 'auto';
  } else {
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
  }
  renderSlide(canvas, slide);
  container.appendChild(canvas);
  for (const node of keep) container.appendChild(node);
  return true;
}

/** 播放指定页（0-based）；opts.stay 时跳过 Tab 切换与整表网格重建 */
export async function playPage(path, pageIndex = 0, opts = {}) {
  if (!opts.stay) {
    document.dispatchEvent(new CustomEvent('sp:switch-module', { detail: 'ppt' }));
  }
  const di = await loadDoc(path);
  const slides = docs[di].doc.slides;
  if (pageIndex < 0 || pageIndex >= slides.length) {
    throw new Error(`页码越界：${pageIndex + 1}`);
  }
  if (opts.stay) {
    currentDoc = di;
    currentSlide = pageIndex;
    const ok = pushToOutput(
      { kind: 'ppt', slide: slides[pageIndex], index: pageIndex, total: slides.length },
      opts.outputSeq,
    );
    if (ok === false) throw new Error('输出已被更新的节目取代');
    if (currentModule() === 'ppt') {
      renderDocs();
      if (!highlightSlide(pageIndex)) renderGrid();
    }
    return;
  }
  await selectDoc(di);
  if (!goto(pageIndex, opts)) throw new Error(`页码越界或输出未采纳：${pageIndex + 1}`);
}

/** 节目单/外部调用；opts.stay=true 时不切换 Tab */
export async function playByPath(path, opts = {}) {
  const page = Number.isInteger(opts.page) ? opts.page : 0;
  try {
    await playPage(path, page, opts);
  } catch (err) {
    toast(`解析失败：${fileName(path)} — ${err}`, 6000);
    throw err;
  }
}
