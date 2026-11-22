// 录音转文字：本地 SenseVoice 离线转写（Rust 后端）+ DeepSeek / 千问总结（流式，可切换）
// 记录存 localStorage（sp.transcribe.records）；DeepSeek Key 只在 Rust 侧保存，前端拿不到明文。

import { esc, lsGet, lsSet, toast, invoke, listen, pickFiles, convertFileSrc, fileExt } from './util.js';
import { renderMarkdown } from './markdown.js';
import { extractPdfText, cancelPdfExtract } from './pdf-text.js';
import { BUILTIN_PRESETS as PRESETS, BUILTIN_LABELS } from './prompt-templates.js';

const KEY = 'sp.transcribe.records';
const LS_LANG = 'sp.transcribe.lang';
const LS_PRESET = 'sp.transcribe.preset';
const LS_PROMPT = 'sp.transcribe.prompt';
const LS_PROMPT_LIBRARY = 'sp.transcribe.promptLibrary';
const AUDIO_PICK_EXT = ['m4a', 'mp3', 'wav', 'flac', 'aac', 'ogg', 'm4b', 'mp4', 'mka', 'webm'];
const PDF_PICK_EXT = ['pdf'];
const $ = (id) => document.getElementById(id);

function isPdfPath(path) {
  return fileExt(path) === 'pdf';
}

let records = []; // 在 initTranscribe 里加载（loadRecords 依赖后面定义的常量）
let curId = null;
let running = false;
let summarizing = false;
let queuedPaths = [];
let busyKind = ''; // summarizing 为 true 时：'summary'（总结）| 'refine'（精修）
const HISTORY_MAX = 8; // 每条记录最多保留的可撤销版本数
let saveTimer = 0;
let auxiliaryAi = null;
let proofIssues = [];
let proofTextSnapshot = '';
let proofScan = null; // 正在检查的字符范围 {start,end}
let proofNote = ''; // 校对完成后的小结（显示在问题列表顶部）
let proofFollow = true; // 文本框是否跟着检查进度自动滚动
let proofCancel = false;
let proofChunks = []; // 校对中尚未处理 / 正在处理的区块（随用户编辑实时平移）
let proofSeq = 0;
let proofResume = 0; // 已检查到的位置（校对被中断时，下次可从这里继续）
let proofComplete = true; // 最近一次校对是否跑完
const proofDrafts = new Map(); // 疑点 id → 用户在“听后自己填”框里写了一半的内容
let proofPlay = null; // 正在试听的疑点 {id,start,end,label,ended}
let proofAudio = null;
let proofRate = 1;
let ppDragging = false;
const isProofing = () => summarizing && busyKind === 'proofread';

function genId() {
  return 'tr' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function fmtPage(n) {
  return `第${Math.max(1, Math.floor(n || 1))}页`;
}

function fmtTs(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${pad2(m)}:${pad2(s % 60)}`;
}

function fmtDur(sec) {
  const s = Math.round(sec || 0);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

function baseName(p) {
  const n = String(p || '').split(/[\\/]/).pop() || '';
  return n.replace(/\.[^.]+$/, '');
}

function dateStr(ts) {
  const d = new Date(ts || Date.now());
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// ───────────────────────── 多份总结（可用不同模型生成后对比） ─────────────────────────
// 记录里的 sums：[{ id, vendor, model, label, text, history[], at }]，active 是当前在编辑的那份。
// 旧版本的单份 summary / history 在读取时迁移成 sums[0]。

const VENDOR_LABEL = { deepseek: 'DeepSeek', qwen: '千问', chatgpt: 'ChatGPT' };
const SUMS_MAX = 3;
const LETTERS = 'ABC';

function cleanHistory(h) {
  return Array.isArray(h)
    ? h
        .filter((x) => x && typeof x.text === 'string' && x.text)
        .map((x) => ({ text: x.text, note: String(x.note || ''), at: Number(x.at) || 0 }))
        .slice(-HISTORY_MAX)
    : [];
}

function loadSums(r) {
  let sums = [];
  if (Array.isArray(r.sums)) {
    sums = r.sums
      .filter((s) => s && typeof s === 'object')
      .slice(0, SUMS_MAX)
      .map((s) => ({
        id: String(s.id || genId()),
        vendor: String(s.vendor || ''),
        model: String(s.model || ''),
        label: String(s.label || ''),
        text: String(s.text || ''),
        history: cleanHistory(s.history),
        at: Number(s.at) || 0,
      }));
  } else if (String(r.summary || '').trim()) {
    sums = [{ id: genId(), vendor: '', model: '', label: '', text: String(r.summary), history: cleanHistory(r.history), at: 0 }];
  }
  const active = Math.min(Math.max(0, Number(r.active) || 0), Math.max(0, sums.length - 1));
  return { sums, active };
}

function newSum(vendor) {
  const st = vendor ? aiState?.[vendor] : null;
  return {
    id: genId(),
    vendor: vendor || '',
    model: st ? st.model || st.defaultModel || '' : '',
    label: vendor ? VENDOR_LABEL[vendor] || st?.label || vendor : '',
    text: '',
    history: [],
    at: Date.now(),
  };
}

function curSum(r = cur()) {
  return r?.sums?.[r.active] || null;
}

function hasSummary(r) {
  return !!r?.sums?.some((s) => s.text.trim());
}

function sumName(s, i) {
  const who = s.label || VENDOR_LABEL[s.vendor] || '';
  return `${LETTERS[i] || i + 1}${who ? ' · ' + who : ''}`;
}

/** 读回保存的 AI 校对状态：位置对不上当前文稿的疑点丢弃 */
function cleanProof(p, text) {
  if (!p || typeof p !== 'object') return null;
  const issues = (Array.isArray(p.issues) ? p.issues : [])
    .filter((x) => x && Number.isInteger(x.start) && Number.isInteger(x.end) && typeof x.text === 'string'
      && x.start >= 0 && x.end > x.start && text.slice(x.start, x.end) === x.text)
    .map((x) => ({
      id: Number(x.id) || ++proofSeq,
      start: x.start,
      end: x.end,
      text: x.text,
      suggestion: String(x.suggestion || ''),
      reason: String(x.reason || ''),
      cands: (Array.isArray(x.cands) ? x.cands : [])
        .filter((c) => c && typeof c.text === 'string' && c.text)
        .slice(0, 3)
        .map((c) => ({ text: c.text, reason: String(c.reason || '') })),
      ok: x.ok === true,
    }));
  for (const x of issues) proofSeq = Math.max(proofSeq, x.id);
  const drafts = {};
  for (const [k, v] of Object.entries(p.drafts && typeof p.drafts === 'object' ? p.drafts : {})) {
    if (issues.some((x) => x.id === Number(k)) && typeof v === 'string' && v) drafts[k] = v.slice(0, 200);
  }
  const resumeAt = Number.isInteger(p.resumeAt) && p.resumeAt > 0 && p.resumeAt < text.length ? p.resumeAt : 0;
  if (!issues.length && !resumeAt && !p.note) return null;
  return { issues, drafts, note: String(p.note || ''), complete: p.complete !== false, resumeAt, at: Number(p.at) || 0 };
}

function loadRecords() {
  const raw = lsGet(KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r) => r && typeof r === 'object')
    .map((r, i) => ({
      id: String(r.id || `tr-${i}`),
      title: String(r.title || ''),
      path: String(r.path || ''),
      language: String(r.language || 'auto'),
      text: String(r.text || ''),
      proof: cleanProof(r.proof, String(r.text || '')),
      ...loadSums(r),
      durationSec: Number(r.durationSec) || 0,
      createdAt: Number(r.createdAt) || Date.now(),
      updatedAt: Number(r.updatedAt) || Date.now(),
    }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function persist() {
  lsSet(KEY, records);
}

function schedulePersist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const r = cur();
    if (r) readEditorInto(r);
    persist();
    paintList();
  }, 600);
}

function cur() {
  return records.find((r) => r.id === curId) || null;
}

function setStatus(text, on = false) {
  const el = $('tr-status');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('is-on', on);
}

function setProgress(pct, text, state = '', wait = false) {
  const box = $('tr-progress');
  const fill = $('tr-fill');
  const t = $('tr-progress-text');
  if (!box || !fill || !t) return;
  box.classList.toggle('is-done', state === 'done');
  box.classList.toggle('is-error', state === 'error');
  box.classList.toggle('is-wait', !!wait);
  fill.style.width = `${Math.max(0, Math.min(100, Number(pct) || 0))}%`;
  t.textContent = text || '';
}

// ───────── AI 流式反馈：阶段 + 用时 + 已生成字数 + 等待动画（不再是只会转圈的横条）─────────
const fb = { timer: 0, active: false, t0: 0, waitSince: 0, stage: '', step: '', pct: 0, chars: 0, expected: 0, waiting: true };

function fbRender() {
  if (!fb.active) return;
  const now = Date.now();
  const parts = [fb.stage];
  if (fb.step) parts.push(fb.step);
  if (fb.chars) parts.push(`已生成 ${fb.chars.toLocaleString()} 字`);
  parts.push(`用时 ${fmtTs((now - fb.t0) / 1000)}`);
  if (fb.waiting && now - fb.waitSince >= 8000) parts.push('模型还在处理，可随时停止');
  setProgress(fb.waiting ? Math.max(fb.pct, 6) : fb.pct, parts.join(' · '), '', fb.waiting);
}

function fbBegin(stage, expected = 0) {
  clearInterval(fb.timer);
  const now = Date.now();
  Object.assign(fb, { active: true, t0: now, waitSince: now, stage, step: '', pct: 2, chars: 0, expected, waiting: true });
  fb.timer = setInterval(fbRender, 500);
  fbRender();
}

function fbSet(patch) {
  if (!fb.active) return;
  if (patch.waiting && !fb.waiting) fb.waitSince = Date.now();
  Object.assign(fb, patch);
  fbRender();
}

/** 收到一段增量：按“预计输出字数”估算进度，越接近越慢，不会卡在固定百分比 */
function fbDelta(n) {
  fbChars(fb.chars + n);
}

function fbChars(total) {
  if (!fb.active) return;
  fb.chars = total;
  fb.waiting = false;
  if (fb.expected > 0) fb.pct = Math.max(fb.pct, Math.min(95, 8 + 87 * (1 - Math.exp((-1.6 * fb.chars) / fb.expected))));
  fbRender();
}

function fbEnd(state, text, pct) {
  if (!fb.active) return;
  clearInterval(fb.timer);
  fb.active = false;
  const used = fmtTs((Date.now() - fb.t0) / 1000);
  setProgress(pct ?? (state === 'done' ? 100 : 0), `${text} · 用时 ${used}`, state, false);
}

function stopAi() {
  proofCancel = true;
  invoke('ai_cancel').catch(() => {});
}

function paintButtons() {
  const busy = running || summarizing;
  $('tr-start').disabled = busy;
  $('tr-pick').disabled = busy;
  if ($('tr-pick-pdf')) $('tr-pick-pdf').disabled = busy;
  $('tr-cancel').classList.toggle('hidden', !running);
  $('tr-sum').disabled = busy;
  $('tr-sum-stop').classList.toggle('hidden', !summarizing);
  $('tr-progress-stop')?.classList.toggle('hidden', !summarizing);
  $('tr-progress')?.classList.toggle('has-stop', summarizing);
  if ($('tr-proofread')) $('tr-proofread').disabled = busy;
  $('tr-text').readOnly = running; // 校对期间也可以边查边改：区块和疑点位置会跟着编辑实时平移
  $('tr-summary').readOnly = summarizing;
  const n = curSum()?.history?.length || 0;
  const go = $('tr-refine-go');
  if (go) go.disabled = busy;
  const undo = $('tr-undo');
  if (undo) undo.disabled = busy || !n;
  const ver = $('tr-ver');
  if (ver) ver.textContent = n ? `可撤销 ${n} 步` : '';
  const doing = { refine: '精修中…', proofread: '校对中…', aux: 'AI 处理中…' }[busyKind] || '总结中…';
  setStatus(running ? '转写中…' : summarizing ? doing : '就绪', busy);
  paintTabs();
}

function paintList() {
  const box = $('tr-list');
  if (!box) return;
  const q = ($('tr-search')?.value || '').trim().toLowerCase();
  const list = records.filter((r) => {
    if (!q) return true;
    return `${r.title} ${r.path} ${r.text} ${r.sums.map((s) => s.text).join(' ')}`.toLowerCase().includes(q);
  });
  if (!list.length) {
    box.innerHTML = '<div class="empty-tip">还没有转写记录<br/><span style="font-size:12px;opacity:.75">选一个录音文件，点「开始转写」</span></div>';
    return;
  }
  box.innerHTML = list
    .map((r) => {
      const sub = [dateStr(r.updatedAt), r.durationSec ? fmtDur(r.durationSec) : '', hasSummary(r) ? (r.sums.length > 1 ? `${r.sums.length} 份总结` : '已总结') : '']
        .filter(Boolean)
        .join(' · ');
      const preview = (r.text || '').replace(/\[\d{1,2}:\d{2}(?::\d{2})?\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 42);
      return `<div class="file-item talk-item ${r.id === curId ? 'active' : ''}" data-id="${esc(r.id)}">
        <div class="talk-item-title">${esc(r.title || '（未命名）')}</div>
        <div class="talk-item-sub">${esc(sub)}</div>
        ${preview ? `<div class="talk-item-preview">${esc(preview)}</div>` : ''}
      </div>`;
    })
    .join('');
}

// ───────────────────────── 总结的格式化显示 + 放大查看 ─────────────────────────

let summaryMode = lsGet('sp.transcribe.sumMode', 'view'); // view（渲染）| source（编辑 Markdown 源码）
let sumRaf = 0;
let viewerOpen = false;
let viewerShow = new Set(); // 放大查看里当前显示的列（'text' 或总结 id）
let viewerFont = Number(lsGet('sp.transcribe.viewerFont', 20)) || 20;

function setSummary(v) {
  $('tr-summary').value = v || '';
  renderSummary();
}

function appendSummary(s) {
  const ta = $('tr-summary');
  ta.value += s;
  ta.scrollTop = ta.scrollHeight;
  scheduleRenderSummary();
}

// 流式输出很密，合并到每帧最多渲染一次
function scheduleRenderSummary() {
  if (sumRaf) return;
  sumRaf = requestAnimationFrame(() => {
    sumRaf = 0;
    renderSummary();
  });
}

function renderSummary() {
  const src = $('tr-summary').value;
  const view = $('tr-summary-view');
  const stick = view.scrollHeight - view.scrollTop - view.clientHeight < 80;
  view.innerHTML = src.trim()
    ? renderMarkdown(src)
    : '<div class="tr-md-empty">转写完成后点「AI 总结」，结果会按格式逐步显示在这里。</div>';
  if (summarizing && stick) view.scrollTop = view.scrollHeight;
  if (viewerOpen) refreshViewer(activeSumKey());
}

function applySummaryMode() {
  const source = summaryMode === 'source';
  $('tr-summary').classList.toggle('hidden', !source);
  $('tr-summary-view').classList.toggle('hidden', source);
  $('tr-sum-mode').textContent = source ? '预览格式' : '编辑源码';
  if (!source) renderSummary();
}

function textToHtml(t) {
  return String(t || '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/^\[(\d{1,2}:\d{2}(?::\d{2})?)\]/, '<span class="tr-ts">[$1]</span>')}</p>`)
    .join('');
}

// 放大查看可以并排显示：原文 + 每份总结（一份总结就只显示那一份）
function viewerColumns() {
  const r = cur();
  const cols = [{ key: 'text', title: '原文', md: false }];
  (r?.sums || []).forEach((s, i) => cols.push({ key: s.id, title: `总结 ${sumName(s, i)}`, md: true, sum: s }));
  return cols;
}

function colSource(col) {
  if (col.key === 'text') return $('tr-text').value;
  // 当前这份的最新内容在编辑框里（流式输出、手动修改都先落在这里）
  return col.sum === curSum() ? $('tr-summary').value : col.sum.text;
}

function colIsLive(col) {
  return col.key === 'text' ? running : summarizing && col.sum === curSum();
}

function paintPane(pane, col) {
  const scroller = pane.querySelector('.tr-vscroll');
  const box = pane.querySelector('.tr-viewer-content');
  const keepBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  const src = colSource(col);
  if (col.md) {
    box.innerHTML = src.trim() ? renderMarkdown(src) : '<div class="tr-md-empty">还没有总结内容</div>';
  } else {
    box.innerHTML = textToHtml(src) || '<div class="tr-md-empty">还没有转写文字</div>';
  }
  if (colIsLive(col) && keepBottom) scroller.scrollTop = scroller.scrollHeight;
}

// key 为空 = 刷新所有可见列；否则只刷新那一列（流式输出时避免整屏重绘）
function refreshViewer(key) {
  if (!viewerOpen) return;
  const cols = viewerColumns();
  $('tr-viewer-cols')
    .querySelectorAll('.tr-vcol')
    .forEach((pane) => {
      if (key && pane.dataset.key !== key) return;
      const col = cols.find((c) => c.key === pane.dataset.key);
      if (col) paintPane(pane, col);
    });
}

function activeSumKey() {
  return curSum()?.id || '';
}

// 按当前勾选的列重建布局
function buildViewer() {
  const cols = viewerColumns();
  viewerShow = new Set([...viewerShow].filter((k) => cols.some((c) => c.key === k)));
  if (!viewerShow.size) viewerShow.add(cols[cols.length > 1 ? 1 : 0].key);

  $('tr-viewer-tabs').innerHTML = cols
    .map(
      (c) =>
        `<button type="button" class="tr-vtab ${viewerShow.has(c.key) ? 'on' : ''}" data-key="${esc(c.key)}" title="显示 / 隐藏这一列">${esc(c.title)}</button>`
    )
    .join('');

  const wrap = $('tr-viewer-cols');
  const old = new Map([...wrap.querySelectorAll('.tr-vcol')].map((p) => [p.dataset.key, p]));
  wrap.innerHTML = '';
  cols
    .filter((c) => viewerShow.has(c.key))
    .forEach((c) => {
      const pane = old.get(c.key) || document.createElement('section');
      if (!pane.firstChild) {
        pane.className = 'tr-vcol';
        pane.dataset.key = c.key;
        pane.innerHTML = `<header class="tr-vcol-head"><span class="tr-vcol-title"></span><span class="tr-vcol-btns"><button type="button" class="mini-btn" data-copy="1">复制</button><button type="button" class="mini-btn" data-export="1" title="导出这一列">导出</button></span></header>
          <div class="tr-vscroll" tabindex="0"><div class="tr-viewer-content"></div></div>`;
      }
      pane.querySelector('.tr-vcol-title').textContent = c.title;
      pane.querySelector('.tr-viewer-content').className = `tr-viewer-content${c.md ? ' tr-md' : ''}`;
      wrap.appendChild(pane);
    });
  wrap.dataset.n = String(wrap.children.length);
  // 只显示一列时列头是隐藏的，复制 / 导出放到顶栏
  const single = wrap.children.length === 1;
  $('tr-viewer-copy').classList.toggle('hidden', !single);
  $('tr-viewer-export').classList.toggle('hidden', !single);
  refreshViewer();
}

function viewerCol(key) {
  return viewerColumns().find((c) => c.key === key) || null;
}

function copyViewerCol(col) {
  if (!col) return;
  if (col.md) copyText(colSource(col), '已复制总结');
  else copyText(stripStamps(colSource(col)), '已复制转写文字（不含时间点）');
}

function exportViewerCol(col) {
  if (!col) return;
  const r = cur();
  const base = safeName(r?.title || '转写');
  if (col.md) {
    const idx = (r?.sums || []).findIndex((s) => s === col.sum);
    const tag = r?.sums?.length > 1 ? `_总结${LETTERS[idx]}${col.sum?.label ? '_' + col.sum.label : ''}` : '_总结';
    exportTo(colSource(col), `${base}${tag}.md`, 'md');
  } else {
    exportTo(colSource(col), `${base}_转写.txt`, 'txt');
  }
}

function setViewerFont(n) {
  viewerFont = Math.max(14, Math.min(44, Math.round(n / 2) * 2));
  $('tr-viewer').style.setProperty('--tr-vfs', `${viewerFont}px`);
  $('tr-viewer-size').textContent = `${viewerFont}px`;
  lsSet('sp.transcribe.viewerFont', viewerFont);
}

// 放大查看打开期间：Esc 只关闭本层（不触发「关闭输出」）；其余按键不再冒泡成演出快捷键，
// 但不阻止默认行为，所以方向键 / PageUp / PageDown / 空格仍可滚动阅读
function viewerKeys(e) {
  if (!viewerOpen) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopImmediatePropagation();
    closeViewer();
    return;
  }
  if (e.ctrlKey || e.metaKey) return;
  e.stopPropagation();
}

// kind: 'text' = 只看原文；'summary' = 总结（有多份时和原文并排对比，只有一份就只看这一份）
function openViewer(kind) {
  const r = cur();
  const cols = viewerColumns();
  if (kind === 'text') viewerShow = new Set(['text']);
  else if (cols.length > 2) viewerShow = new Set(cols.map((c) => c.key));
  else viewerShow = new Set([cols[cols.length - 1].key]);
  viewerOpen = true;
  $('tr-viewer-title').textContent = r?.title || '未命名';
  $('tr-viewer').classList.remove('hidden');
  setViewerFont(viewerFont);
  buildViewer();
  $('tr-viewer-cols').querySelectorAll('.tr-vscroll').forEach((s) => (s.scrollTop = 0));
  $('tr-viewer-cols').querySelector('.tr-vscroll')?.focus();
  document.addEventListener('keydown', viewerKeys, true);
}

function closeViewer() {
  viewerOpen = false;
  $('tr-viewer').classList.add('hidden');
  document.removeEventListener('keydown', viewerKeys, true);
}

function paintEditor() {
  const r = cur();
  $('tr-path').value = r?.path || '';
  $('tr-text').value = r?.text || '';
  stopProofAudio();
  loadProofFrom(r);
  setSummary(curSum(r)?.text || '');
  paintTabs();
  if (r?.language) $('tr-lang').value = r.language;
  setProgress(0, '');
  paintButtons();
}

function readEditorInto(r) {
  if (!r) return;
  r.text = $('tr-text').value;
  const s = curSum(r);
  if (s) s.text = $('tr-summary').value;
  else if ($('tr-summary').value.trim()) {
    // 用户在没有总结的情况下直接粘贴了内容：当作一份手写总结
    r.sums.push({ ...newSum(''), text: $('tr-summary').value });
    r.active = r.sums.length - 1;
    paintTabs();
  }
  const p = $('tr-path').value.trim();
  if (p) r.path = p;
  r.language = $('tr-lang').value || 'auto';
  if (r.id === curId) r.proof = proofSnapshot(); // AI 校对的结果、进度、没填完的内容一并存本地
  r.updatedAt = Date.now();
}

/** 当前这条记录的 AI 校对状态（存进记录，关掉程序再打开还在） */
function proofSnapshot() {
  if (!proofIssues.length && !proofNote && !proofResume) return null;
  return {
    issues: proofIssues.map((p) => ({
      id: p.id, start: p.start, end: p.end, text: p.text, suggestion: p.suggestion, reason: p.reason,
      cands: p.cands || [], ok: p.ok === true,
    })),
    drafts: Object.fromEntries([...proofDrafts].filter(([, v]) => v)),
    note: proofNote,
    complete: proofComplete && !isProofing(),
    resumeAt: proofResume,
    at: Date.now(),
  };
}

/** 切换 / 打开记录时，把它保存的校对状态读回来 */
function loadProofFrom(r) {
  const p = r?.proof;
  proofIssues = p ? p.issues.map((x) => ({ ...x })) : [];
  proofDrafts.clear();
  for (const [k, v] of Object.entries(p?.drafts || {})) proofDrafts.set(Number(k), v);
  proofComplete = p ? p.complete !== false : true;
  proofResume = p?.resumeAt || 0;
  const len = Math.max(1, (r?.text || '').length);
  proofNote = !p ? '' : proofComplete ? p.note : `上次校对没跑完（已检查约 ${Math.round((proofResume / len) * 100)}%），可点「AI 校对」选择从中断处继续`;
  proofScan = null;
  proofChunks = [];
  proofTextSnapshot = $('tr-text')?.value || '';
  renderProofread();
}

function newRecord(path = '') {
  const r = {
    id: genId(),
    title: path ? baseName(path) : '新转写',
    path,
    language: $('tr-lang')?.value || 'auto',
    text: '',
    sums: [],
    active: 0,
    durationSec: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  records.unshift(r);
  curId = r.id;
  persist();
  paintList();
  paintEditor();
  return r;
}

function selectRecord(id) {
  if (running || summarizing) return toast('正在处理中，请先等待或取消');
  const r = cur();
  if (r) {
    readEditorInto(r);
    persist();
  }
  curId = id;
  paintList();
  paintEditor();
}

function deleteCurrent() {
  const r = cur();
  if (!r) return toast('没有可删的记录');
  if (running || summarizing) return toast('正在处理中，请先取消');
  if (!window.confirm(`删除「${r.title || '这条记录'}」？（不会删除原音频文件）`)) return;
  records = records.filter((x) => x.id !== r.id);
  curId = records[0]?.id || null;
  persist();
  paintList();
  paintEditor();
  toast('已删除');
}

async function copyText(text, okMsg) {
  const t = String(text || '');
  if (!t.trim()) return toast('没有可复制的内容');
  try {
    await navigator.clipboard.writeText(t);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = t;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(okMsg);
}

async function exportTo(text, defName, ext) {
  if (!String(text || '').trim()) return toast('没有可导出的内容');
  try {
    const dest = await invoke('pick_save_path', { defaultName: defName, extensions: [ext] });
    if (!dest) return;
    await invoke('write_text_file', { path: dest, text });
    toast('已导出：' + dest);
  } catch (err) {
    toast('导出失败：' + (err?.message || err));
  }
}

function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|]+/g, '_').trim() || '转写';
}

// ───────────────────────── 转写 ─────────────────────────

function cleanPath(p) {
  // 资源管理器「复制为路径」会带双引号
  return String(p || '').trim().replace(/^["']+|["']+$/g, '');
}

function assignPickedFiles(files, kindLabel) {
  if (!files?.length) return;
  if (files.length > 1) {
    if (running || summarizing) return toast('正在处理中，请完成或取消后再选择文件');
    const r = cur();
    if (r) { readEditorInto(r); persist(); }
    queuedPaths = [...files];
    $('tr-path').value = `已选 ${files.length} 个${kindLabel}，点击「开始转写」依次处理`;
    toast(`已加入 ${files.length} 个${kindLabel}，将按顺序逐个处理`);
    return;
  }
  queuedPaths = [];
  $('tr-path').value = files[0];
  const r = cur();
  if (r && !r.text.trim()) {
    r.path = files[0];
    if (!r.title || r.title === '新转写') r.title = baseName(files[0]);
    persist();
    paintList();
  }
}

async function pickAudio() {
  const files = await pickFiles(AUDIO_PICK_EXT, '选择要转写的录音');
  assignPickedFiles(files, '音频');
}

async function pickPdf() {
  const files = await pickFiles(PDF_PICK_EXT, '选择要转成文字的 PDF');
  assignPickedFiles(files, 'PDF');
}

async function startTranscribe() {
  if (running || summarizing) return;
  if (queuedPaths.length) {
    const paths = [...queuedPaths];
    queuedPaths = [];
    const failed = [];
    for (let i = 0; i < paths.length; i++) {
      const r = newRecord(paths[i]);
      $('tr-path').value = paths[i];
      const result = await transcribeOne(paths[i], r, `${i + 1}/${paths.length}`);
      if (result === 'cancelled') {
        queuedPaths = paths.slice(i + 1);
        if (queuedPaths.length) toast(`已停止，剩余 ${queuedPaths.length} 个文件未处理；点击「开始转写」可继续`);
        return;
      }
      if (result === 'failed') failed.push(baseName(paths[i]));
    }
    toast(failed.length
      ? `批量转写结束：成功 ${paths.length - failed.length} 个，失败 ${failed.length} 个（${failed.slice(0, 4).join('、')}${failed.length > 4 ? '…' : ''}；失败项已保留记录）`
      : `批量转写完成：${paths.length} 个文件`);
    return;
  }
  const path = cleanPath($('tr-path').value);
  if (!path) return toast('先选择录音或 PDF，或粘贴文件路径');
  $('tr-path').value = path;

  let r = cur();
  if (!r || r.text.trim() || hasSummary(r)) {
    if (r) {
      readEditorInto(r);
      persist();
    }
    r = newRecord(path);
  } else {
    r.path = path;
    if (!r.title || r.title === '新转写') r.title = baseName(path);
  }
  await transcribeOne(path, r);
}

async function transcribeOne(path, r, batchProgress = '') {
  if (isPdfPath(path)) return transcribePdfOne(path, r, batchProgress);
  r.path = path;
  r.language = $('tr-lang').value || 'auto';
  lsSet(LS_LANG, r.language);
  $('tr-text').value = '';
  setSummary('');
  r.text = '';
  r.sums = [];
  r.active = 0;
  paintTabs();
  persist();
  paintList();

  running = true;
  paintButtons();
  setProgress(0, batchProgress ? `批量转写 ${batchProgress}：准备中…` : '准备中…');
  try {
    const res = await invoke('transcribe_file', { path, language: r.language });
    const rec = records.find((x) => x.id === r.id);
    if (rec) {
      rec.text = $('tr-text').value.trim();
      rec.durationSec = res?.durationSec || 0;
      rec.updatedAt = Date.now();
    }
    persist();
    if (!res?.paragraphs?.length) {
      if (!batchProgress) toast('没有识别到语音内容（可能是静音或语种不对）');
    } else {
      if (!batchProgress) toast(`转写完成：音频 ${fmtDur(res.durationSec)}，用时 ${fmtDur(res.elapsedSec)}`, 6000);
    }
    return 'done';
  } catch (err) {
    const msg = String(err?.message || err);
    const rec = records.find((x) => x.id === r.id);
    if (rec) {
      rec.text = $('tr-text').value.trim();
      persist();
    }
    if (msg !== '已取消') {
      if (!batchProgress) toast('转写失败：' + msg, 8000);
      return 'failed';
    }
    return 'cancelled';
  } finally {
    running = false;
    paintButtons();
    paintList();
  }
}

async function transcribePdfOne(path, r, batchProgress = '') {
  r.path = path;
  r.language = $('tr-lang').value || 'auto';
  lsSet(LS_LANG, r.language);
  $('tr-text').value = '';
  setSummary('');
  r.text = '';
  r.sums = [];
  r.active = 0;
  paintTabs();
  persist();
  paintList();

  running = true;
  paintButtons();
  setProgress(0, batchProgress ? `批量 PDF ${batchProgress}：准备中…` : '正在打开 PDF…');
  const t0 = Date.now();
  try {
    const res = await extractPdfText(path, {
      onProgress: (p) => {
        if (!running || !p) return;
        if (p.phase === 'para' && p.text) {
          const ta = $('tr-text');
          ta.value += `[${fmtPage(p.start)}] ${p.text}\n\n`;
          ta.scrollTop = ta.scrollHeight;
          if (viewerOpen) refreshViewer('text');
        }
        if (p.phase === 'para' || p.phase === 'progress' || p.phase === 'prepare' || p.phase === 'done') {
          setProgress(
            p.percent || 0,
            p.message || (batchProgress ? `批量 PDF ${batchProgress}` : 'PDF 转文字中…'),
            p.phase === 'done' ? 'done' : undefined,
          );
        }
      },
    });
    const rec = records.find((x) => x.id === r.id);
    if (rec) {
      rec.text = $('tr-text').value.trim();
      rec.durationSec = res?.pages || 0;
      rec.updatedAt = Date.now();
    }
    persist();
    const elapsed = (Date.now() - t0) / 1000;
    if (!res?.paragraphs?.length) {
      if (!batchProgress) toast('没有抽出文字（可能是空页，或系统 OCR 语言包未安装）', 7000);
    } else if (!batchProgress) {
      toast(
        `PDF 完成：${res.pages} 页（文字层 ${res.textPages} / OCR ${res.ocrPages}），用时 ${fmtDur(elapsed)}`,
        7000,
      );
    }
    return 'done';
  } catch (err) {
    const msg = String(err?.message || err);
    const rec = records.find((x) => x.id === r.id);
    if (rec) {
      rec.text = $('tr-text').value.trim();
      persist();
    }
    if (msg === '已取消' || err?.code === 'cancelled') {
      setProgress(0, '已取消', 'error');
      return 'cancelled';
    }
    if (!batchProgress) toast('PDF 转文字失败：' + msg, 8000);
    return 'failed';
  } finally {
    running = false;
    paintButtons();
    paintList();
  }
}

function onTranscribeEvent(p) {
  if (!running || !p) return;
  switch (p.phase) {
    case 'para': {
      const ta = $('tr-text');
      ta.value += `[${fmtTs(p.start)}] ${p.text}\n\n`;
      ta.scrollTop = ta.scrollHeight;
      if (viewerOpen) refreshViewer('text');
      if (typeof p.percent === 'number') setProgress(p.percent, `转写中… ${Math.round(p.percent)}%`);
      break;
    }
    case 'prepare':
    case 'download':
    case 'progress':
      setProgress(p.percent || 0, p.message || '');
      break;
    case 'done':
      setProgress(100, p.message || '完成', 'done');
      break;
    case 'error':
      setProgress(0, p.message || '失败', 'error');
      break;
    case 'cancelled':
      setProgress(0, '已取消', 'error');
      break;
    default:
      break;
  }
}

// ───────────────────────── DeepSeek 总结 ─────────────────────────

// 服务商设置（Key 只在 Rust 侧读写，前端只拿到是否已保存 + 末尾几位）
// 「总结服务」下拉框同时决定：总结用哪家、设置区编辑哪家的 Key / 模型
let aiState = null;
const VENDOR_MODELS = {
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  qwen: ['qwen3.8-flash', 'qwen3.8-max', 'qwen3.7-plus'],
  chatgpt: ['gpt-6-luna', 'GPT-6-Luna', 'GPT-5.6-Terra'],
};

function curVendor() {
  return $('tr-provider')?.value || aiState?.provider || 'deepseek';
}

function paintAiLabels() {
  if (!aiState) return;
  const sum = aiState[aiState.provider];
  $('tr-sum').title = `把左侧文字发给 ${sum.label} 总结（仅发送文字，不发送音频）`;
  const el = $('tr-key-state');
  if (el) {
    el.textContent = `${sum.label}：${sum.hasKey ? '已保存 ' + sum.keyHint : '未设置 Key'}`;
    el.classList.toggle('is-ok', !!sum.hasKey);
  }
  $('tr-provider').value = aiState.provider;
  $('tr-hint').textContent =
    '转写始终在本机离线完成，音频不出电脑；总结只把文字发给所选的 AI。Key 只写入本机配置文件，不进入导出文件。';
}

// 切换服务商时才刷新 Key 输入框占位、模型名、模型建议
function paintVendorFields() {
  if (!aiState) return;
  const v = curVendor();
  const vs = aiState[v];
  if (!vs) return;
  $('tr-key').placeholder = `${vs.label} API Key（只保存在本机）`;
  $('tr-model').placeholder = `模型，默认 ${vs.defaultModel}`;
  $('tr-model').value = vs.model || vs.defaultModel;
  $('tr-model-list').innerHTML = (VENDOR_MODELS[v] || []).map((m) => `<option value="${m}"></option>`).join('');
}

async function loadKeyState() {
  try {
    aiState = await invoke('ai_settings_get');
  } catch {
    return;
  }
  paintAiLabels();
}

async function onProviderChange() {
  const p = $('tr-provider').value;
  try {
    aiState = await invoke('ai_settings_set', { input: { provider: p } });
  } catch (err) {
    toast('保存失败：' + (err?.message || err));
  }
  paintAiLabels();
  paintVendorFields();
}

async function saveKey() {
  const v = curVendor();
  const key = $('tr-key').value.trim();
  const model = $('tr-model').value.trim();
  try {
    aiState = await invoke('ai_settings_set', {
      input: { vendor: v, apiKey: key || null, model: model || null },
    });
    $('tr-key').value = '';
    paintAiLabels();
    paintVendorFields();
    toast(key ? `${aiState[v].label} API Key 已保存到本机` : '设置已保存');
  } catch (err) {
    toast('保存失败：' + (err?.message || err));
  }
}

async function clearKey() {
  const v = curVendor();
  const vs = aiState?.[v];
  if (!vs?.hasKey) return toast('当前服务没有已保存的 Key');
  if (!window.confirm(`从本机删除已保存的 ${vs.label} API Key？`)) return;
  try {
    aiState = await invoke('ai_settings_set', { input: { vendor: v, clearKey: true } });
    paintAiLabels();
    toast('已清除 Key');
  } catch (err) {
    toast('清除失败：' + (err?.message || err));
  }
}

// ───────────── 总结标签（A / B / C）─────────────

function paintTabs() {
  const box = $('tr-sum-tabs');
  if (!box) return;
  const r = cur();
  const sums = r?.sums || [];
  const busy = running || summarizing;
  const tabs = sums
    .map((s, i) => {
      const tip = [s.label || '手动输入', s.model].filter(Boolean).join(' · ');
      return `<button type="button" class="tr-stab ${i === r.active ? 'active' : ''}" data-i="${i}" title="${esc(tip)}">
        <b>${LETTERS[i] || i + 1}</b><span>${esc(s.label || '总结')}</span>${
          busy ? '' : `<i class="tr-stab-x" data-del="${i}" title="删除这份总结">×</i>`
        }</button>`;
    })
    .join('');
  const canAdd = !!r && sums.length < SUMS_MAX;
  box.innerHTML =
    tabs +
    (canAdd
      ? `<button type="button" class="tr-stab add" id="tr-sum-add" ${busy ? 'disabled' : ''} title="再用另一个模型生成一份总结，放在一起对比">＋ ${sums.length ? '对比' : '新总结'}</button>`
      : '');
  box.classList.toggle('is-empty', !sums.length);
  box.classList.toggle('hidden', !r);
}

function selectSum(i) {
  if (running || summarizing) return;
  const r = cur();
  if (!r || !r.sums[i] || i === r.active) return;
  readEditorInto(r);
  r.active = i;
  persist();
  setSummary(r.sums[i].text);
  paintTabs();
  paintButtons();
}

function deleteSum(i) {
  if (running || summarizing) return;
  const r = cur();
  const s = r?.sums[i];
  if (!s) return;
  readEditorInto(r);
  if (s.text.trim() && !window.confirm(`删除总结 ${sumName(s, i)}？`)) return;
  r.sums.splice(i, 1);
  r.active = Math.min(r.active > i ? r.active - 1 : r.active, Math.max(0, r.sums.length - 1));
  persist();
  setSummary(curSum(r)?.text || '');
  paintTabs();
  paintButtons();
  paintList();
}

// 「＋ 对比」弹出的小菜单：选一个模型再生成一份
function showAddMenu() {
  closeAddMenu();
  const anchor = $('tr-sum-add');
  if (!anchor) return;
  const menu = document.createElement('div');
  menu.className = 'tr-menu';
  menu.id = 'tr-add-menu';
  menu.innerHTML = ['deepseek', 'qwen', 'chatgpt']
    .map((v) => {
      const st = aiState?.[v];
      const model = st?.model || st?.defaultModel || '';
      return `<button type="button" data-v="${v}"><b>${esc(VENDOR_LABEL[v])}</b><small>${esc(model)}${
        st?.hasKey ? '' : ' · 未设置 Key'
      }</small></button>`;
    })
    .join('');
  anchor.parentElement.appendChild(menu);
  setTimeout(() => document.addEventListener('click', closeAddMenu, { once: true }), 0);
}

function closeAddMenu() {
  $('tr-add-menu')?.remove();
}

function stripStamps(text) {
  return String(text || '').replace(/^\s*\[\d{1,2}:\d{2}(?::\d{2})?\]\s*/gm, '').trim();
}

async function ensureKey(vendor) {
  await loadKeyState();
  const st = aiState?.[vendor];
  if (st?.hasKey) return true;
  const label = st?.label || VENDOR_LABEL[vendor] || 'AI';
  if ($('tr-provider')) {
    $('tr-provider').value = vendor;
    onProviderChange();
  }
  $('tr-settings').open = true;
  $('tr-key').focus();
  toast(`请先填写并保存 ${label} API Key`);
  return false;
}

/**
 * 生成总结。
 *  - 默认：重新生成当前这份（旧内容留作可撤销版本），用设置里选的服务商；
 *  - addVendor：新增一份，用指定的服务商，生成完可和已有的并排对比。
 */
async function summarize(addVendor = '') {
  if (running || summarizing) return;
  const text = stripStamps($('tr-text').value);
  if (text.length < 20) return toast('转写文字太少，先转写或粘贴要总结的内容');
  await loadKeyState();
  const vendor = addVendor || aiState?.provider || 'deepseek';
  if (!(await ensureKey(vendor))) return;
  const label = aiState?.[vendor]?.label || VENDOR_LABEL[vendor] || 'AI';
  if (text.length > 100000 && !window.confirm(`文稿约 ${Math.round(text.length / 1000)} 千字，会分段调用 ${label}，费用相应增加。继续？`)) return;

  const r = cur() || newRecord('');
  readEditorInto(r);
  if (addVendor && r.sums.length >= SUMS_MAX) return toast(`最多同时保留 ${SUMS_MAX} 份总结，请先删除一份`);

  const stamp = `${dateStr(r.createdAt)} ${pad2(new Date(r.createdAt).getHours())}:${pad2(new Date(r.createdAt).getMinutes())}:${pad2(new Date(r.createdAt).getSeconds())}`;
  const prompt = `${$('tr-prompt').value.trim()}\n\n本次记录时间：${stamp}`;

  // 目标这一份：新增 / 重新生成当前 / 还没有任何总结时新建
  const prevActive = r.active;
  let target;
  let created = false;
  if (addVendor || !curSum(r)) {
    target = newSum(vendor);
    r.sums.push(target);
    r.active = r.sums.length - 1;
    created = true;
  } else {
    target = curSum(r);
  }
  const prev = target.text;

  setSummary('');
  summarizing = true;
  busyKind = 'summary';
  paintTabs();
  paintButtons();
  fbBegin(`连接 ${label}…`, Math.min(6000, Math.max(1500, Math.round(text.length * 0.22))));
  let ok = false;
  try {
    const full = await invoke('ai_summarize', { text, prompt, vendor });
    setSummary(full);
    ok = true;
    toast(addVendor ? `${label} 的总结已加入，可点「放大」并排对比` : '总结完成');
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg !== '已取消') toast('总结失败：' + msg, 9000);
    fbEnd('error', msg === '已取消' ? '已停止' : msg);
  } finally {
    summarizing = false;
    busyKind = '';
    const rec = records.find((x) => x.id === r.id);
    if (rec) {
      const got = $('tr-summary').value;
      if (!ok && !got.trim()) {
        // 失败 / 停止且什么都没生成：新建的这份撤掉，重新生成的这份放回旧内容
        if (created) {
          rec.sums = rec.sums.filter((s) => s.id !== target.id);
          rec.active = Math.min(prevActive, Math.max(0, rec.sums.length - 1));
          setSummary(curSum(rec)?.text || '');
        } else {
          target.text = prev;
          setSummary(prev);
        }
      } else {
        // 重新生成会覆盖旧总结：把旧的留作一个可撤销的版本
        if (ok && !created && prev.trim() && prev !== got) pushHistory(target, prev, '');
        target.text = got;
        const st = aiState?.[vendor];
        target.vendor = vendor;
        target.label = VENDOR_LABEL[vendor] || st?.label || vendor;
        target.model = st?.model || st?.defaultModel || '';
        target.at = Date.now();
      }
      rec.updatedAt = Date.now();
      persist();
    }
    paintTabs();
    paintButtons();
    paintList();
  }
}

function pushHistory(sum, text, note) {
  sum.history = [...(sum.history || []), { text, note: note || '', at: Date.now() }].slice(-HISTORY_MAX);
}

/** 精修：按用户写的修改意见，在当前这份总结基础上让 AI 改一版 */
async function refine() {
  if (running || summarizing) return;
  const r = cur();
  const sum = curSum(r);
  const before = $('tr-summary').value;
  if (!sum || before.trim().length < 20) return toast('还没有总结，请先点「AI 总结」');
  const instruction = $('tr-refine-input').value.trim();
  if (!instruction) return toast('先写明哪里有问题、想怎么改（也可以点上面的快捷项）');
  await loadKeyState();
  // 用生成这份总结的那家来精修；手写的 / 旧数据没有记录就用设置里选的
  const vendor = sum.vendor || aiState?.provider || 'deepseek';
  if (!(await ensureKey(vendor))) return;
  const label = aiState?.[vendor]?.label || VENDOR_LABEL[vendor] || 'AI';
  const text = stripStamps($('tr-text').value);

  setSummary('');
  summarizing = true;
  busyKind = 'refine';
  paintTabs();
  paintButtons();
  fbBegin(`连接 ${label}…`, Math.min(8000, Math.max(800, Math.round(before.length * 1.05))));
  let ok = false;
  try {
    const full = await invoke('ai_refine', { text, summary: before, instruction, vendor });
    setSummary(full);
    ok = true;
    toast('精修完成；不满意可点「撤销」回到上一版');
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg !== '已取消') toast('精修失败：' + msg, 9000);
    fbEnd('error', msg === '已取消' ? '已停止' : msg);
    setSummary(before); // 失败 / 停止：保持精修前的内容不变
  } finally {
    summarizing = false;
    busyKind = '';
    const rec = records.find((x) => x.id === r.id);
    if (rec) {
      if (ok) {
        pushHistory(sum, before, instruction);
        $('tr-refine-input').value = '';
      }
      sum.text = $('tr-summary').value;
      rec.updatedAt = Date.now();
      persist();
    }
    paintTabs();
    paintButtons();
    paintList();
  }
}

/** 撤销：回到这份总结的上一版；如果那一版是精修出来的，把当时的修改意见放回输入框方便调整重试 */
function undoRefine() {
  if (running || summarizing) return;
  const r = cur();
  const sum = curSum(r);
  if (!sum?.history?.length) return toast('没有可撤销的版本');
  const h = sum.history.pop();
  setSummary(h.text);
  if (h.note) $('tr-refine-input').value = h.note;
  sum.text = h.text;
  r.updatedAt = Date.now();
  persist();
  paintButtons();
  paintList();
  toast(h.note ? '已撤销；上次的修改意见已放回输入框，可调整后重试' : '已回到上一版总结');
}

function onSummaryEvent(p) {
  if (!p) return;
  if (auxiliaryAi) {
    // 校对 / 改进提示词：进度由调用方自己的循环掌控，这里只收文本并通知“已开始出字”
    if (p.kind === 'delta') {
      auxiliaryAi.text += p.text || '';
      auxiliaryAi.onDelta?.(auxiliaryAi.text.length);
    }
    return;
  }
  if (!summarizing) return;
  switch (p.kind) {
    case 'delta':
      appendSummary(p.text || '');
      fbDelta((p.text || '').length);
      break;
    case 'start':
      fbSet({ stage: p.message || fb.stage });
      break;
    case 'progress':
      // 分段提炼等“还没出字”的阶段：显示阶段名 + 等待动画
      fbSet({ stage: p.message || fb.stage, pct: Math.max(fb.pct, p.percent || 0), waiting: true });
      break;
    case 'done':
      fbEnd('done', p.message || '完成');
      break;
    case 'error':
      fbEnd('error', p.message || '失败');
      break;
    case 'cancelled':
      fbEnd('error', '已停止');
      break;
    default:
      break;
  }
}

function applyPreset(name) {
  const sel = $('tr-preset');
  if (sel) sel.value = name;
  lsSet(LS_PRESET, name);
  const saved = name.startsWith('saved:') ? promptLibrary().find((p) => p.id === name.slice(6)) : null;
  if (saved) {
    $('tr-prompt').value = saved.text;
  } else if (name === 'custom') {
    $('tr-prompt').value = lsGet(LS_PROMPT, '') || PRESETS.deep || PRESETS.sermon;
  } else {
    $('tr-prompt').value = PRESETS[name] || PRESETS.deep || PRESETS.sermon;
  }
  $('tr-prompt-delete').disabled = !saved;
  lsSet(LS_PROMPT, $('tr-prompt').value);
}

function promptLibrary() {
  const a = lsGet(LS_PROMPT_LIBRARY, []);
  return Array.isArray(a) ? a.filter((p) => p && typeof p.text === 'string').map((p) => ({ id: String(p.id), name: String(p.name || '自定义提示词'), text: p.text })) : [];
}

function renderPromptOptions() {
  const sel = $('tr-preset');
  if (!sel) return;
  const selected = lsGet(LS_PRESET, 'deep');
  sel.querySelectorAll('option[data-saved]').forEach((o) => o.remove());
  const before = sel.querySelector('option[value="custom"]');
  for (const p of promptLibrary()) {
    const o = document.createElement('option');
    o.value = `saved:${p.id}`;
    o.textContent = p.name;
    o.dataset.saved = '1';
    sel.insertBefore(o, before);
  }
  if ([...sel.options].some((o) => o.value === selected)) sel.value = selected;
}

/** 模板维护弹窗当前选中：builtin:deep | saved:id | custom:draft */
let pmKey = 'builtin:deep';
let pmDirty = false;

function pmIsBuiltin() {
  return pmKey.startsWith('builtin:');
}
function pmIsSaved() {
  return pmKey.startsWith('saved:');
}
function pmBuiltinId() {
  return pmKey.slice('builtin:'.length);
}
function pmSavedId() {
  return pmKey.slice('saved:'.length);
}

function openPromptModal(focusKey) {
  const modal = $('tr-prompt-modal');
  if (!modal) return;
  document.body.appendChild(modal);
  const cur = $('tr-preset')?.value || lsGet(LS_PRESET, 'deep');
  if (focusKey) pmKey = focusKey;
  else if (cur.startsWith('saved:')) pmKey = cur;
  else if (cur === 'custom') pmKey = 'custom:draft';
  else pmKey = `builtin:${PRESETS[cur] ? cur : 'deep'}`;
  pmDirty = false;
  paintPromptModal();
  modal.classList.remove('hidden');
  $('tr-pm-text')?.focus();
}

function closePromptModal() {
  if (pmDirty && !window.confirm('有未保存的修改，确定关闭？')) return;
  $('tr-prompt-modal')?.classList.add('hidden');
  pmDirty = false;
}

function paintPromptModalList() {
  const box = $('tr-pm-list');
  if (!box) return;
  const rows = [];
  for (const id of Object.keys(PRESETS)) {
    rows.push({
      key: `builtin:${id}`,
      title: BUILTIN_LABELS[id] || id,
      sub: '内置',
    });
  }
  for (const p of promptLibrary()) {
    rows.push({
      key: `saved:${p.id}`,
      title: p.name,
      sub: '自定义',
    });
  }
  if (pmKey === 'custom:draft' || pmKey.startsWith('draft:')) {
    rows.push({ key: pmKey, title: $('tr-pm-name')?.value?.trim() || '未命名草稿', sub: '草稿' });
  }
  box.innerHTML = rows.map((r) => `
    <button type="button" class="tr-pm-item${r.key === pmKey ? ' active' : ''}" data-key="${esc(r.key)}">
      ${esc(r.title)}<small>${esc(r.sub)}</small>
    </button>`).join('');
}

function loadPromptModalEntry(key) {
  pmKey = key;
  const nameEl = $('tr-pm-name');
  const textEl = $('tr-pm-text');
  const badge = $('tr-pm-badge');
  const del = $('tr-pm-delete');
  if (key.startsWith('builtin:')) {
    const id = key.slice('builtin:'.length);
    nameEl.value = BUILTIN_LABELS[id] || id;
    nameEl.readOnly = true;
    textEl.value = PRESETS[id] || '';
    badge.textContent = '内置';
    badge.classList.remove('is-custom');
    del.disabled = true;
  } else if (key.startsWith('saved:')) {
    const p = promptLibrary().find((x) => x.id === key.slice(6));
    nameEl.value = p?.name || '';
    nameEl.readOnly = false;
    textEl.value = p?.text || '';
    badge.textContent = '自定义';
    badge.classList.add('is-custom');
    del.disabled = !p;
  } else {
    nameEl.readOnly = false;
    if (!nameEl.value) nameEl.value = '我的模板';
    badge.textContent = '草稿';
    badge.classList.add('is-custom');
    del.disabled = true;
  }
  pmDirty = false;
  paintPromptModalList();
}

function paintPromptModal() {
  loadPromptModalEntry(pmKey);
}

function savePromptLibrary(list) {
  lsSet(LS_PROMPT_LIBRARY, list);
  renderPromptOptions();
}

function pmSaveCurrent({ asNew } = {}) {
  const text = $('tr-pm-text').value.trim();
  if (!text) return toast('提示词不能为空');
  let name = $('tr-pm-name').value.trim() || '自定义模板';
  name = name.slice(0, 40);
  const list = promptLibrary();
  if (!asNew && pmIsSaved()) {
    const id = pmSavedId();
    const i = list.findIndex((p) => p.id === id);
    if (i < 0) return toast('找不到要保存的模板');
    list[i] = { ...list[i], name, text };
    savePromptLibrary(list);
    pmDirty = false;
    paintPromptModal();
    toast('已保存');
    return list[i];
  }
  // 内置 / 草稿 / 另存为 → 新建自定义
  if (asNew || pmIsBuiltin() || !pmIsSaved()) {
    const asked = window.prompt('给这套模板起个名字', name);
    if (!asked?.trim()) return null;
    name = asked.trim().slice(0, 40);
  }
  const id = genId();
  const item = { id, name, text };
  list.push(item);
  savePromptLibrary(list);
  pmKey = `saved:${id}`;
  pmDirty = false;
  paintPromptModal();
  toast('已保存为自定义模板');
  return item;
}

function pmApplyAndClose() {
  const text = $('tr-pm-text').value.trim();
  if (!text) return toast('提示词不能为空');
  $('tr-prompt').value = text;
  lsSet(LS_PROMPT, text);
  if (pmIsSaved()) {
    applyPreset(`saved:${pmSavedId()}`);
  } else if (pmIsBuiltin()) {
    applyPreset(pmBuiltinId());
    // 若用户改过内置正文，落到 custom，避免下次切回内置丢改动
    if (text !== (PRESETS[pmBuiltinId()] || '')) {
      $('tr-preset').value = 'custom';
      lsSet(LS_PRESET, 'custom');
      $('tr-prompt-delete').disabled = true;
    }
  } else {
    applyPreset('custom');
  }
  pmDirty = false;
  closePromptModal();
  toast('已应用当前模板');
}

function initPromptModal() {
  const modal = $('tr-prompt-modal');
  if (!modal) return;
  document.body.appendChild(modal);
  $('tr-prompt-manage')?.addEventListener('click', () => openPromptModal());
  $('tr-prompt-open')?.addEventListener('click', () => openPromptModal());
  $('tr-pm-close')?.addEventListener('click', () => closePromptModal());
  $('tr-pm-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-key]');
    if (!btn) return;
    if (pmDirty && !window.confirm('有未保存的修改，切换将丢弃，继续？')) return;
    loadPromptModalEntry(btn.dataset.key);
  });
  $('tr-pm-new')?.addEventListener('click', () => {
    if (pmDirty && !window.confirm('有未保存的修改，新建将丢弃，继续？')) return;
    pmKey = `draft:${Date.now().toString(36)}`;
    $('tr-pm-name').value = '我的模板';
    $('tr-pm-name').readOnly = false;
    $('tr-pm-text').value = '';
    $('tr-pm-badge').textContent = '草稿';
    $('tr-pm-badge').classList.add('is-custom');
    $('tr-pm-delete').disabled = true;
    pmDirty = false;
    paintPromptModalList();
    $('tr-pm-text').focus();
  });
  $('tr-pm-save')?.addEventListener('click', () => pmSaveCurrent({ asNew: false }));
  $('tr-pm-saveas')?.addEventListener('click', () => pmSaveCurrent({ asNew: true }));
  $('tr-pm-apply')?.addEventListener('click', () => pmApplyAndClose());
  $('tr-pm-delete')?.addEventListener('click', () => {
    if (!pmIsSaved()) return;
    if (!window.confirm('删除这套自定义模板？')) return;
    const id = pmSavedId();
    savePromptLibrary(promptLibrary().filter((p) => p.id !== id));
    if (($('tr-preset')?.value || '') === `saved:${id}`) {
      lsSet(LS_PRESET, 'deep');
      applyPreset('deep');
    }
    pmKey = 'builtin:deep';
    pmDirty = false;
    paintPromptModal();
    toast('已删除');
  });
  $('tr-pm-improve')?.addEventListener('click', async () => {
    const original = $('tr-pm-text').value.trim();
    if (!original) return toast('先填写提示词');
    // 临时同步到主框，复用 improvePrompt
    const prev = $('tr-prompt').value;
    $('tr-prompt').value = original;
    try {
      await improvePrompt();
      if ($('tr-prompt').value !== original) {
        $('tr-pm-text').value = $('tr-prompt').value;
        pmDirty = true;
      }
    } finally {
      // improvePrompt 已写入 tr-prompt；保持与弹窗一致
      $('tr-prompt').value = $('tr-pm-text').value;
      void prev;
    }
  });
  $('tr-pm-name')?.addEventListener('input', () => { pmDirty = true; });
  $('tr-pm-text')?.addEventListener('input', () => { pmDirty = true; });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('tr-prompt-modal') || $('tr-prompt-modal').classList.contains('hidden')) return;
    e.preventDefault();
    e.stopPropagation();
    closePromptModal();
  }, true);
}

/**
 * 渲染校对标记：文本框背后的镜像层画“正在检查的区块”（scan）和疑点波浪线（mark），
 * 下方是逐条问题列表。follow=true 时让文本框滚到正在检查的位置。
 */
function renderProofread(follow = false) {
  const ta = $('tr-text');
  const text = ta.value;
  const overlay = $('tr-text-highlight');
  const panel = $('tr-proofread-issues');
  if (!overlay || !panel) return;
  const live = isProofing();
  const spans = proofIssues
    .filter((p) => Number.isInteger(p.start) && Number.isInteger(p.end) && text.slice(p.start, p.end) === p.text)
    .map((p) => ({ start: p.start, end: p.end }))
    .sort((a, b) => a.start - b.start);
  const scan = proofScan && proofScan.end <= text.length ? proofScan : null;

  // 镜像层要和文本框同宽换行：补上滚动条占的宽度
  overlay.style.paddingRight = `${14 + Math.max(0, ta.offsetWidth - ta.clientWidth)}px`;

  const cuts = new Set([0, text.length]);
  if (scan) { cuts.add(scan.start); cuts.add(scan.end); }
  for (const s of spans) { cuts.add(s.start); cuts.add(s.end); }
  const pts = [...cuts].sort((a, b) => a - b);
  let html = '';
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    let seg = esc(text.slice(a, b));
    const hit = spans.find((s) => s.start <= a && s.end >= b);
    if (hit) seg = `<mark${hit.start === a ? ` data-s="${a}"` : ''}>${seg}</mark>`;
    if (scan && a >= scan.start && b <= scan.end) seg = `<span class="scan">${seg}</span>`;
    html += seg;
  }
  overlay.innerHTML = html + (text.endsWith('\n') ? ' ' : '');
  overlay.scrollTop = ta.scrollTop;

  if (follow && proofFollow && scan) {
    const el = overlay.querySelector('.scan');
    if (el) ta.scrollTo({ top: Math.max(0, el.offsetTop - ta.clientHeight * 0.2), behavior: 'smooth' });
  }

  if (!proofIssues.length && !proofNote && !live) { panel.classList.add('hidden'); panel.innerHTML = ''; return; }
  const keep = panel.scrollTop;
  // 重绘前记住“自己填”框的焦点和光标，重绘后还原（校对进行中每查完一块都会重绘）
  const act = document.activeElement;
  const focusId = act?.classList?.contains('tr-manual') && panel.contains(act) ? act.dataset.id : null;
  const caret = focusId ? [act.selectionStart, act.selectionEnd] : null;
  panel.classList.remove('hidden');
  const head = live
    ? `<span class="tr-proofread-status is-live">${esc(proofNote || '正在逐段检查…')}</span><span class="tr-proofread-count">待处理 ${proofIssues.length} 处</span>`
    : `<span class="tr-proofread-status">${proofIssues.length ? `${proofIssues.length} 处待确认` : '没有待确认的疑点'}${proofNote ? ' · ' + esc(proofNote) : ''}</span>
       ${proofIssues.length ? '<button class="mini-btn" type="button" data-head="export" title="把待确认的疑点（含时间点）导出成 Markdown 清单，方便对着音频慢慢核">导出清单</button>' : ''}
       <button class="mini-btn" type="button" data-head="clear">清除标记</button>`;
  const hasAudio = !!(cur()?.path || cleanPath($('tr-path').value));
  const recOff = summarizing ? ' disabled' : '';
  panel.innerHTML = `<div class="tr-proofread-head">${head}</div>` + proofIssues.map((p, i) => {
    const before = text.slice(Math.max(0, p.start - 24), p.start);
    const after = text.slice(p.end, Math.min(text.length, p.end + 24));
    const needCheck = !p.suggestion || p.suggestion === '请听原音核实';
    const seg = proofSegmentOf(text, p.start);
    const playing = proofPlay?.id === p.id && proofAudio && !proofAudio.paused;
    let extra = '';
    if (p.loading) {
      extra = '<div class="tr-proofread-cands"><span class="tr-proofread-wait">AI 正在重新推荐…</span></div>';
    } else if (p.ok) {
      extra = '<div class="tr-proofread-cands"><span class="tr-proofread-wait">AI 重新判断后认为这里没有问题，可以直接忽略。</span></div>';
    } else if (p.cands?.length) {
      extra = '<div class="tr-proofread-cands"><span class="tr-proofread-arrow">AI 推荐，点一个直接替换：</span>'
        + p.cands.map((c, k) => `<button class="tr-cand" type="button" data-action="cand" data-k="${k}" title="${esc(c.reason || '')}"><b>${esc(c.text)}</b>${c.reason ? `<small>${esc(c.reason)}</small>` : ''}</button>`).join('')
        + '</div>';
    }
    const listen = `<button class="mini-btn tr-listen${playing ? ' is-on' : ''}" type="button" data-action="listen"${hasAudio && seg ? '' : ' disabled'} title="${hasAudio ? (seg ? '播放这一段原音（可拖动、调速），听完再决定怎么改' : '这一段前面没有时间点，无法定位') : '这条记录没有关联的音频文件'}">${playing ? '⏸ 暂停' : '▶ 听这段'}${seg ? ` ${esc(seg.label)}` : ''}</button>`;
    return `<div class="tr-proofread-issue" data-i="${i}">
      <div class="tr-proofread-context" title="点击定位到原文">…${esc(before)}<b>${esc(p.text)}</b>${esc(after)}…</div>
      <div class="tr-proofread-choice"><span class="tr-proofread-arrow">${needCheck ? '建议' : '建议改为'}</span><strong>${esc(p.suggestion || '待核对')}</strong>
        <span class="tr-proofread-reason">${esc(p.reason || '')}</span>
      </div>
      <div class="tr-proofread-choice">
        ${listen}
        ${needCheck ? '' : '<button class="mini-btn primary" type="button" data-action="apply">采纳</button>'}
        <button class="mini-btn" type="button" data-action="recommend"${recOff} title="觉得这个建议不对？让 AI 结合上下文再推荐几种改法">${p.cands?.length || p.ok ? '再推荐' : 'AI 推荐'}</button>
        <button class="mini-btn" type="button" data-action="ignore">忽略</button>
        <input class="tr-manual" type="text" data-id="${p.id}" spellcheck="false" placeholder="听后自己填正确写法" value="${esc(proofDrafts.get(p.id) || '')}" />
        <button class="mini-btn" type="button" data-action="manual">替换</button>
      </div>${extra}
    </div>`;
  }).join('');
  panel.scrollTop = keep;
  if (focusId) {
    const el = panel.querySelector(`.tr-manual[data-id="${focusId}"]`);
    if (el) { el.focus({ preventScroll: true }); try { el.setSelectionRange(caret[0], caret[1]); } catch { /* ignore */ } }
  }
}

function scrollEditorTo(pos) {
  const el = $('tr-text-highlight')?.querySelector(`[data-s="${pos}"]`);
  const ta = $('tr-text');
  if (el) ta.scrollTo({ top: Math.max(0, el.offsetTop - ta.clientHeight * 0.35), behavior: 'smooth' });
}

function clearProofread() {
  proofIssues = [];
  proofNote = '';
  proofScan = null;
  proofResume = 0;
  proofComplete = true;
  proofDrafts.clear();
  proofTextSnapshot = $('tr-text')?.value || '';
  renderProofread();
  schedulePersist();
}

// ───────── 校对中边查边改：文稿被改动后，把待检查区块、疑点位置一起平移 ─────────

function shiftPos(pos, prefix, oldEnd, delta, isEnd) {
  if (pos <= prefix) return pos;
  if (pos >= oldEnd) return pos + delta;
  return isEnd ? oldEnd + delta : prefix; // 落在被改写区域内：区块起点退到改动前、终点推到改动后（这块会被重新检查）
}

/** 文稿里 [prefix, oldEnd) 被替换成了长度差为 delta 的内容 */
function shiftProofState(prefix, oldEnd, delta) {
  for (const c of proofChunks) {
    c.start = shiftPos(c.start, prefix, oldEnd, delta, false);
    c.end = shiftPos(c.end, prefix, oldEnd, delta, true);
  }
  if (proofResume > 0) proofResume = Math.min(shiftPos(proofResume, prefix, oldEnd, delta, false), $('tr-text').value.length);
  proofIssues = proofIssues
    .filter((x) => x.end <= prefix || x.start >= oldEnd)
    .map((x) => (x.start >= oldEnd ? { ...x, start: x.start + delta, end: x.end + delta } : x));
}

function reconcileProofreadAfterEdit() {
  const next = $('tr-text').value;
  const prev = proofTextSnapshot;
  if (prev !== next) {
    let prefix = 0;
    while (prefix < prev.length && prefix < next.length && prev[prefix] === next[prefix]) prefix++;
    let suffix = 0;
    while (suffix < prev.length - prefix && suffix < next.length - prefix && prev[prev.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
    const oldEnd = prev.length - suffix;
    const delta = next.length - suffix - oldEnd;
    shiftProofState(prefix, oldEnd, delta);
  }
  proofTextSnapshot = next;
  if (proofIssues.length || proofScan) renderProofread();
  schedulePersist();
}

/** 校对 / 改进提示词等“一次性 AI 调用”：只收文本，不动总结框。onDelta(n) 在模型开始出字时回调 */
async function runAuxAi(text, instruction, vendor, onDelta) {
  auxiliaryAi = { text: '', onDelta };
  const own = !summarizing;
  if (own) { summarizing = true; busyKind = 'aux'; paintButtons(); }
  try { return await invoke('ai_summarize', { text, prompt: instruction, vendor }); }
  finally {
    auxiliaryAi = null;
    if (own) { summarizing = false; busyKind = ''; paintButtons(); }
  }
}

const PROOF_PROMPT = '你是中文语音转写校对助手。下面是一小段语音识别文稿（行首的 [mm:ss] 是时间点，不是正文）。'
  + '只找有上下文依据的明显错别字、同音误识、人名/术语/经文名称错误、断句错误；不要润色正常表达，没有问题就返回空数组。'
  + '每条问题的 quote 必须是文稿里原样存在的一小段连续文字（2–20 字，不要含时间点和换行），context 是包含 quote 的原样上下文（前后各约 15 字）。'
  + '无法确定时 suggestion 写“请听原音核实”，不要猜。只返回 JSON，不要任何解释：'
  + '{"issues":[{"quote":"…","context":"…","suggestion":"建议改法","reason":"依据上下文的简短理由"}]}';
const PROOF_CHUNK_CHARS = 1000; // 每次只检查约 1000 字（3–6 段），结果马上出来，可看到“一条一条”往下扫

/** 按段落（行）聚合成约 target 字的小块；优先在换行 / 句末处断开 */
function splitProofChunks(text, target = PROOF_CHUNK_CHARS) {
  const spans = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + target);
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end - 1);
      if (nl >= start + target * 0.4) {
        end = nl + 1;
      } else {
        const nextNl = text.indexOf('\n', end);
        if (nextNl >= 0 && nextNl - start <= target * 1.5) {
          end = nextNl + 1;
        } else {
          const m = text.slice(start + Math.floor(target * 0.5), end).match(/[\s\S]*[。！？；!?;]/);
          if (m) end = start + Math.floor(target * 0.5) + m[0].length;
        }
      }
    }
    spans.push({ start, end });
    start = end;
  }
  // 结尾太短的碎片并入前一块
  if (spans.length > 1 && text.slice(spans[spans.length - 1].start).trim().length < 40) {
    const last = spans.pop();
    spans[spans.length - 1].end = last.end;
  }
  return spans.map((c) => ({ ...c, text: text.slice(c.start, c.end) })).filter((c) => c.text.trim().length >= 20);
}

function parseProofItems(raw) {
  const s = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const tryParse = (t) => { try { return JSON.parse(t); } catch { return undefined; } };
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  let obj = a >= 0 && b > a ? tryParse(s.slice(a, b + 1)) : undefined;
  if (obj === undefined) {
    const x = s.indexOf('[');
    const y = s.lastIndexOf(']');
    obj = x >= 0 && y > x ? tryParse(s.slice(x, y + 1)) : undefined;
  }
  if (Array.isArray(obj)) return obj;
  if (obj && Array.isArray(obj.issues)) return obj.issues;
  return null; // 解析失败
}

/** 把模型给的 quote 定位回这一块文稿里的精确位置；定位不上的丢弃（宁缺毋滥） */
function locateProofItem(chunk, item) {
  const quote = typeof item?.quote === 'string' ? item.quote : item?.text;
  if (typeof quote !== 'string' || quote.trim().length < 2 || /^[\s\d:\[\]]+$/.test(quote)) return null;
  const context = typeof item.context === 'string' ? item.context : '';
  let at = -1;
  if (context.includes(quote)) {
    const c = chunk.text.indexOf(context);
    if (c >= 0) at = c + context.indexOf(quote);
  }
  if (at < 0 || chunk.text.slice(at, at + quote.length) !== quote) at = chunk.text.indexOf(quote);
  if (at < 0) return null;
  const suggestion = String(item.suggestion || '请听原音核实').trim();
  if (suggestion === quote) return null;
  return {
    start: chunk.start + at,
    end: chunk.start + at + quote.length,
    text: quote,
    suggestion,
    reason: String(item.reason || '').trim(),
  };
}

/**
 * 逐段校对：每检查完一小块立刻标出疑点并滚到下一块；检查期间可以照常改文稿、采纳 / 忽略 / 试听，
 * 待检查的区块和已标出的疑点会随编辑实时平移。可随时停止，已标出的保留。
 */
async function proofreadTranscript() {
  if (running || summarizing) return;
  const ta = $('tr-text');
  const text = ta.value;
  if (text.trim().length < 20) return toast('转写内容太短，无法校对');
  await loadKeyState();
  const vendor = curVendor();
  if (!(await ensureKey(vendor))) return;
  const label = aiState?.[vendor]?.label || VENDOR_LABEL[vendor] || 'AI';
  // 上次没校对完：可以从中断处继续，已标出的疑点保留
  let from = 0;
  if (proofResume > 0 && proofResume < text.length - 20) {
    const pct = Math.round((proofResume / text.length) * 100);
    if (window.confirm(`上次校对在约 ${pct}% 处中断了（已标出 ${proofIssues.length} 处）。\n\n确定 = 从中断处继续\n取消 = 全部重新校对`)) from = proofResume;
  }
  if (!from && proofIssues.length && !window.confirm(`重新校对会清掉当前还没处理的 ${proofIssues.length} 处疑点。继续？`)) return;
  const chunks = splitProofChunks(text.slice(from)).map((c) => ({ start: c.start + from, end: c.end + from }));
  const total = chunks.length;
  if (!total) return toast('没有可校对的内容');
  if (total > 60 && !window.confirm(`文稿较长，将分 ${total} 段依次调用 ${label}，耗时和费用都会增加。继续？`)) return;

  proofCancel = false;
  proofFollow = true;
  if (!from) {
    proofIssues = [];
    proofDrafts.clear();
  }
  proofNote = '';
  proofComplete = false;
  proofResume = from;
  proofChunks = chunks;
  proofTextSnapshot = text;
  summarizing = true;
  busyKind = 'proofread';
  paintButtons();
  fbBegin(`${label} 校对 1/${total} 段`);
  const costs = [];
  let checked = 0;
  let foundCount = 0;
  let unparsed = 0;
  let failure = '';
  try {
    for (let c = 0; c < total; c++) {
      if (proofCancel) break;
      const chunk = chunks[c];
      const sent = ta.value.slice(chunk.start, chunk.end); // 取最新文稿（用户可能已改动）
      if (sent.trim().length < 20) { checked = c + 1; continue; }
      const avg = costs.length ? costs.reduce((x, y) => x + y, 0) / costs.length : 0;
      const eta = avg ? ` · 约剩 ${fmtTs(avg * (total - c))}` : '';
      proofScan = chunk; // 同一个对象：文稿被改动时跟着平移
      proofNote = `正在检查第 ${c + 1}/${total} 段${eta}`;
      fbSet({
        stage: `${label} 校对 ${c + 1}/${total} 段`,
        step: `已发现 ${foundCount} 处${eta}`,
        pct: (c / total) * 100,
        waiting: true,
      });
      renderProofread(true);
      const t0 = Date.now();
      let raw;
      try {
        raw = await runAuxAi(sent, PROOF_PROMPT, vendor, (n) => {
          fbSet({ waiting: false, pct: ((c + Math.min(0.9, n / 500)) / total) * 100 });
        });
      } catch (err) {
        if (proofCancel || String(err?.message || err) === '已取消') break;
        throw err;
      }
      costs.push((Date.now() - t0) / 1000);
      const items = parseProofItems(raw);
      if (!items) {
        unparsed++;
      } else {
        // 等待期间文稿可能被改过：对着“现在”的这个区块重新定位，对不上的丢弃
        const now = { start: chunk.start, end: chunk.end, text: ta.value.slice(chunk.start, chunk.end) };
        for (const item of items.slice(0, 15)) {
          const issue = locateProofItem(now, item);
          if (issue && !proofIssues.some((x) => issue.start < x.end && issue.end > x.start)) {
            issue.id = ++proofSeq;
            proofIssues.push(issue);
            foundCount++;
          }
        }
        proofIssues.sort((a, b) => a.start - b.start);
      }
      checked = c + 1;
      proofResume = chunk.end;
      renderProofread();
      schedulePersist(); // 每查完一块就存本地：中途关掉程序也不会丢
    }
  } catch (err) {
    failure = String(err?.message || err);
    toast('校对失败：' + failure, 8000);
  } finally {
    proofScan = null;
    proofChunks = [];
    summarizing = false;
    busyKind = '';
    const stopped = proofCancel;
    const tail = unparsed ? ` · ${unparsed} 段结果无法解析` : '';
    proofNote = failure
      ? `中断于第 ${checked + 1} 段：${failure}`
      : stopped
        ? `已停止，检查了 ${checked}/${total} 段，共发现 ${foundCount} 处${tail}`
        : `已检查全部 ${total} 段，共发现 ${foundCount} 处${tail}`;
    proofComplete = !failure && !stopped;
    if (proofComplete) proofResume = 0;
    paintButtons();
    renderProofread();
    schedulePersist();
    if (failure) fbEnd('error', `校对中断：${failure}`, (checked / total) * 100);
    else if (stopped) fbEnd('error', `已停止 · 检查 ${checked}/${total} 段 · 发现 ${foundCount} 处`, (checked / total) * 100);
    else {
      fbEnd('done', `校对完成 · ${total} 段 · ${foundCount ? `发现 ${foundCount} 处` : '没有发现明显疑点'}`);
      toast(foundCount ? `校对完成：发现 ${foundCount} 处，请在下方逐条确认` : '校对完成，没有找到明显疑点');
    }
  }
}

/** 只替换这一处（其他同词位置不动），其余疑点和待检查区块整体平移 */
function applyProofIssue(index, replacement) {
  const issue = proofIssues[index];
  if (!issue) return;
  const editor = $('tr-text');
  const current = editor.value;
  if (current.slice(issue.start, issue.end) !== issue.text) return toast('这处原文已变化，请重新运行校对');
  const delta = replacement.length - issue.text.length;
  editor.value = current.slice(0, issue.start) + replacement + current.slice(issue.end);
  proofDrafts.delete(issue.id);
  shiftProofState(issue.start, issue.end, delta);
  proofTextSnapshot = editor.value;
  schedulePersist();
  renderProofread();
  toast(`已改为「${replacement}」；其他同词位置保持不变`);
}

const RECOMMEND_PROMPT = '你是中文语音转写校对助手。下面给出一段语音识别文稿里被标为“疑点”的位置：前文、疑点原文、后文，'
  + '以及此前已被用户否决的建议。请结合上下文重新判断，给出最多 3 个更合理的“替换疑点原文”的写法（按可能性从高到低，只写替换后的那几个字，不要带前后文）。'
  + '人名、术语、经文名称要符合通行写法；拿不准就少给，不要硬凑。若你认为疑点原文其实没有问题，ok 设为 true，candidates 为空数组。'
  + '只返回 JSON，不要任何解释：{"ok":false,"candidates":[{"text":"替换后的文字","reason":"简短理由"}]}';

/** 用户觉得建议不对：让 AI 结合上下文再推荐几种改法，点哪个就换成哪个 */
async function recommendProofIssue(issue) {
  if (running || summarizing) return toast('AI 正在处理别的任务，等它结束后再点');
  await loadKeyState();
  const vendor = curVendor();
  if (!(await ensureKey(vendor))) return;
  const text = $('tr-text').value;
  if (text.slice(issue.start, issue.end) !== issue.text) return toast('这处原文已变化，请重新运行校对');
  const label = aiState?.[vendor]?.label || VENDOR_LABEL[vendor] || 'AI';
  const id = issue.id;
  const find = () => proofIssues.find((x) => x.id === id); // 等待期间用户可能改了别处，对象会被平移复制，所以按 id 找
  const rejected = [...new Set([issue.suggestion, ...(issue.cands || []).map((c) => c.text)].filter((s) => s && s !== '请听原音核实'))];
  const user = [
    `前文：${text.slice(Math.max(0, issue.start - 120), issue.start)}`,
    `疑点原文：「${issue.text}」`,
    `后文：${text.slice(issue.end, issue.end + 120)}`,
    issue.reason ? `之前标为疑点的理由：${issue.reason}` : '',
    rejected.length ? `已被否决的建议：${rejected.map((s) => `「${s}」`).join('、')}` : '',
  ].filter(Boolean).join('\n');
  issue.loading = true;
  issue.ok = false;
  fbBegin(`${label} 正在推荐改法…`);
  const task = runAuxAi(user, RECOMMEND_PROMPT, vendor, () => fbSet({ waiting: false, pct: 60 }));
  renderProofread(); // runAuxAi 已同步置忙：推荐按钮先置灰
  try {
    const raw = await task;
    const s = String(raw || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    let obj = null;
    try { obj = a >= 0 && b > a ? JSON.parse(s.slice(a, b + 1)) : null; } catch { obj = null; }
    if (!obj) throw new Error('AI 返回的格式无法解析，请再点一次');
    const seen = new Set(rejected.concat([issue.text]));
    const cands = [];
    for (const c of Array.isArray(obj.candidates) ? obj.candidates : []) {
      const t = String(typeof c === 'string' ? c : c?.text || '').trim();
      if (!t || t.length > 80 || seen.has(t)) continue;
      seen.add(t);
      cands.push({ text: t, reason: String(c?.reason || '').trim() });
      if (cands.length >= 3) break;
    }
    const it = find();
    if (it) {
      it.cands = cands;
      it.ok = !cands.length && obj.ok === true;
    }
    fbEnd('done', cands.length ? `已推荐 ${cands.length} 种改法` : obj.ok === true ? 'AI 认为原文没问题' : 'AI 没有更好的建议');
    if (!cands.length && obj.ok !== true) toast('AI 没有给出新的改法，可以听原音后自己填，或忽略这条');
  } catch (err) {
    const msg = String(err?.message || err);
    fbEnd('error', msg === '已取消' ? '已停止' : msg);
    if (msg !== '已取消') toast('推荐失败：' + msg, 7000);
  } finally {
    const it = find();
    if (it) it.loading = false;
    renderProofread();
    schedulePersist();
  }
}

// ───────── 听原音：定位疑点所在的那一段并试听 ─────────

function parseStamp(line) {
  const m = String(line).match(/^\s*\[(?:(\d+):)?(\d{1,2}):(\d{2})\]/);
  return m ? (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3]) : null;
}

function lineStartAt(text, i) {
  return i <= 0 ? 0 : text.lastIndexOf('\n', i - 1) + 1;
}

/** 疑点所在段落的起止秒数：起点 = 本行（或往上最近一行）的 [mm:ss]，终点 = 下一行时间点（没有就按 +30 秒） */
function proofSegmentOf(text, pos) {
  let cursor = lineStartAt(text, pos);
  let stamp = null;
  for (;;) {
    const le = text.indexOf('\n', cursor);
    stamp = parseStamp(text.slice(cursor, le < 0 ? text.length : le));
    if (stamp !== null || cursor === 0) break;
    cursor = lineStartAt(text, cursor - 1);
  }
  if (stamp === null) return null;
  let end = stamp + 30;
  let next = text.indexOf('\n', lineStartAt(text, pos));
  while (next >= 0 && next < text.length) {
    const from = next + 1;
    const le = text.indexOf('\n', from);
    const s = parseStamp(text.slice(from, le < 0 ? text.length : le));
    if (s !== null && s > stamp) { end = s; break; }
    next = le;
    if (le < 0) break;
  }
  return { start: stamp, end: Math.max(end, stamp + 2), label: fmtTs(stamp) };
}

function ppPaint() {
  const box = $('tr-proof-player');
  if (!box) return;
  if (!proofPlay || !proofAudio) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const a = proofAudio;
  $('tr-pp-label').textContent = `${proofPlay.label} 这一段`;
  const seek = $('tr-pp-seek');
  seek.min = String(proofPlay.start);
  seek.max = String(proofPlay.end);
  if (!ppDragging) seek.value = String(Math.min(proofPlay.end, Math.max(proofPlay.start, a.currentTime)));
  const pos = Math.max(0, a.currentTime - proofPlay.start);
  $('tr-pp-time').textContent = `${fmtTs(Math.min(pos, proofPlay.end - proofPlay.start))} / ${fmtTs(proofPlay.end - proofPlay.start)}`;
  $('tr-pp-toggle').textContent = proofPlay.ended ? '↺' : a.paused ? '▶' : '⏸';
  $('tr-pp-rate').textContent = `${proofRate}×`;
}

function ensureProofAudio() {
  if (proofAudio) return proofAudio;
  const a = new Audio();
  a.preload = 'auto';
  a.addEventListener('timeupdate', () => {
    if (proofPlay && !proofPlay.ended && a.currentTime >= proofPlay.end) {
      a.pause();
      proofPlay.ended = true;
      renderProofread();
    }
    ppPaint();
  });
  a.addEventListener('pause', () => { ppPaint(); });
  a.addEventListener('play', () => { if (proofPlay) proofPlay.ended = false; ppPaint(); });
  a.addEventListener('error', () => {
    if (!proofPlay) return;
    toast('无法播放这个音频：文件可能已被移动、删除，或格式不支持', 6000);
    stopProofAudio();
  });
  proofAudio = a;
  return a;
}

function stopProofAudio() {
  if (proofAudio) proofAudio.pause();
  proofPlay = null;
  ppPaint();
  if (!$('tr-proofread-issues')?.classList.contains('hidden')) renderProofread();
}

/** 播放（再点一次暂停）疑点所在的整段原音；播到这一段结束自动停下 */
function listenProofIssue(issue) {
  if (proofPlay?.id === issue.id && proofAudio) {
    if (proofAudio.paused) proofAudio.play().catch(() => {});
    else proofAudio.pause();
    renderProofread();
    return;
  }
  const path = cur()?.path || cleanPath($('tr-path').value);
  if (!path) return toast('这条记录没有关联的音频文件');
  const seg = proofSegmentOf($('tr-text').value, issue.start);
  if (!seg) return toast('这一段前面没有时间点，无法定位音频位置');
  const a = ensureProofAudio();
  const src = convertFileSrc(path);
  if (a.dataset.src !== src) { a.src = src; a.dataset.src = src; }
  a.playbackRate = proofRate;
  proofPlay = { id: issue.id, start: seg.start, end: seg.end, label: seg.label, ended: false };
  const begin = Math.max(0, seg.start - 0.3);
  const go = () => {
    a.currentTime = begin;
    a.play().catch((err) => { toast('播放失败：' + (err?.message || err)); stopProofAudio(); });
  };
  if (a.readyState >= 1) go();
  else a.addEventListener('loadedmetadata', go, { once: true });
  ppPaint();
  renderProofread();
}

function initProofPlayer() {
  $('tr-pp-toggle').addEventListener('click', () => {
    if (!proofPlay || !proofAudio) return;
    if (proofPlay.ended) {
      proofPlay.ended = false;
      proofAudio.currentTime = Math.max(0, proofPlay.start - 0.3);
      proofAudio.play().catch(() => {});
    } else if (proofAudio.paused) proofAudio.play().catch(() => {});
    else proofAudio.pause();
    renderProofread();
  });
  $('tr-pp-rate').addEventListener('click', () => {
    proofRate = proofRate === 1 ? 0.75 : proofRate === 0.75 ? 0.5 : 1;
    if (proofAudio) proofAudio.playbackRate = proofRate;
    ppPaint();
  });
  $('tr-pp-close').addEventListener('click', stopProofAudio);
  const seek = $('tr-pp-seek');
  seek.addEventListener('pointerdown', () => { ppDragging = true; });
  seek.addEventListener('pointerup', () => { ppDragging = false; });
  seek.addEventListener('input', () => {
    if (!proofAudio || !proofPlay) return;
    proofPlay.ended = false;
    proofAudio.currentTime = Number(seek.value);
  });
}

/** 把待确认的疑点（含时间点）导出成 Markdown 清单 */
function exportProofList() {
  if (!proofIssues.length) return toast('没有待确认的疑点');
  const text = $('tr-text').value;
  const r = cur();
  const lines = [`# ${r?.title || '转写'} · 校对清单`, '', `共 ${proofIssues.length} 处待确认（时间点对应音频位置，可对着原音核对）`, ''];
  proofIssues.forEach((p, i) => {
    const seg = proofSegmentOf(text, p.start);
    const before = text.slice(Math.max(0, p.start - 20), p.start).replace(/\s+/g, ' ');
    const after = text.slice(p.end, p.end + 20).replace(/\s+/g, ' ');
    lines.push(`## ${i + 1}. ${seg ? `[${seg.label}] ` : ''}${p.text}`);
    lines.push(`- 原文：…${before}**${p.text}**${after}…`);
    lines.push(`- 建议：${p.suggestion || '请听原音核实'}${p.reason ? `（${p.reason}）` : ''}`);
    if (p.cands?.length) lines.push(`- AI 另外推荐：${p.cands.map((c) => c.text).join(' / ')}`);
    lines.push('- 处理：☐ 采纳　☐ 另改为＿＿＿＿　☐ 忽略', '');
  });
  exportTo(lines.join('\n'), `${safeName(r?.title || '转写')}_校对清单.md`, 'md');
}

function handleProofreadChoice(e) {
  const head = e.target.closest('[data-head]')?.dataset.head;
  if (head === 'clear') {
    clearProofread();
    return;
  }
  if (head === 'export') {
    exportProofList();
    return;
  }
  const card = e.target.closest('.tr-proofread-issue');
  if (!card) return;
  const index = Number(card.dataset.i);
  const issue = proofIssues[index];
  if (!issue) return;
  const actionEl = e.target.closest('[data-action]');
  const action = actionEl?.dataset.action;
  if (action === 'ignore') {
    proofDrafts.delete(issue.id);
    proofIssues.splice(index, 1);
    renderProofread();
    schedulePersist();
    return;
  }
  if (action === 'apply') {
    if (!issue.suggestion || issue.suggestion === '请听原音核实') return toast('这条需要先听原音核实，未自动替换');
    applyProofIssue(index, issue.suggestion);
    return;
  }
  if (action === 'cand') {
    const c = issue.cands?.[Number(actionEl.dataset.k)];
    if (c?.text) applyProofIssue(index, c.text);
    return;
  }
  if (action === 'manual') {
    const v = (card.querySelector('.tr-manual')?.value || '').trim();
    if (!v) return toast('先在框里填上你听到的正确写法');
    if (v === issue.text) return toast('和原文一样，无需替换；没问题就点「忽略」');
    applyProofIssue(index, v);
    return;
  }
  if (action === 'listen') {
    listenProofIssue(issue);
    return;
  }
  if (action === 'recommend') {
    recommendProofIssue(issue);
    return;
  }
  // 点击上下文：定位到原文
  proofFollow = false;
  scrollEditorTo(issue.start);
  if (!isProofing()) {
    $('tr-text').focus({ preventScroll: true });
    $('tr-text').setSelectionRange(issue.start, issue.end);
  }
}

async function improvePrompt() {
  if (running || summarizing) return;
  const original = $('tr-prompt').value.trim();
  if (original.length < 20) return toast('提示词太短，请先写清楚用途和要求');
  await loadKeyState(); const vendor = curVendor();
  if (!(await ensureKey(vendor))) return;
  fbBegin('AI 正在改进提示词…', Math.max(300, Math.round(original.length * 1.3)));
  try {
    const improved = (await runAuxAi(original, '请改进下面这段 AI 提示词，让任务目标、输出结构、事实边界和格式要求更清楚、可执行。保留原意，只输出改进后的完整提示词，不要解释。', vendor, (n) => fbChars(n))).trim();
    fbEnd('done', '提示词已改进');
    if (!improved) return toast('AI 没有返回改进后的提示词');
    if (window.confirm('AI 已生成改进版。确定替换当前提示词吗？原版不会被覆盖，可先取消并另存。')) {
      $('tr-prompt').value = improved;
      $('tr-preset').value = 'custom'; lsSet(LS_PRESET, 'custom'); lsSet(LS_PROMPT, improved);
      toast('提示词已更新；需要长期保留请点“保存为提示词”');
    }
  } catch (err) {
    const msg = String(err?.message || err);
    fbEnd('error', msg === '已取消' ? '已停止' : msg);
    if (msg !== '已取消') toast('提示词改进失败：' + msg, 7000);
  }
}

// ───────────────────────── 初始化 ─────────────────────────

export function initTranscribe() {
  if (!$('panel-transcribe')) return;

  $('tr-lang').value = lsGet(LS_LANG, 'auto') || 'auto';
  renderPromptOptions();
  initPromptModal();
  const preset = lsGet(LS_PRESET, 'deep');
  const okPreset = PRESETS[preset] || preset === 'custom' || String(preset).startsWith('saved:')
    || [...($('tr-preset')?.options || [])].some((o) => o.value === preset);
  applyPreset(okPreset ? preset : 'deep');

  records = loadRecords();
  curId = records[0]?.id || null;
  paintList();
  paintEditor();

  $('tr-pick').addEventListener('click', () => pickAudio());
  $('tr-pick-pdf')?.addEventListener('click', () => pickPdf());
  $('tr-start').addEventListener('click', () => startTranscribe());
  $('tr-cancel').addEventListener('click', () => {
    cancelPdfExtract();
    invoke('transcribe_cancel').catch(() => {});
    setProgress(0, '正在取消…', 'error');
  });
  $('tr-path').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') startTranscribe();
  });
  $('tr-copy').addEventListener('click', () => copyText(stripStamps($('tr-text').value), '已复制转写文字（不含时间点）'));
  $('tr-export').addEventListener('click', () => {
    const r = cur();
    const name = `${safeName(r?.title || '转写')}_转写.txt`;
    exportTo($('tr-text').value, name, 'txt');
  });
  $('tr-export-md').addEventListener('click', () => {
    const r = cur();
    const body = $('tr-text').value.trim();
    if (!body) return toast('没有转写正文可导出');
    const title = r?.title || '转写';
    const audio = String(r?.path || '').split(/[\\/]/).pop() || '未记录';
    const md = `# ${title}\n\n- 音频：${audio}\n- 转写时间：${new Date().toLocaleString('zh-CN')}\n\n## 转写正文\n\n${body}`;
    exportTo(md, `${safeName(title)}_转写.md`, 'md');
  });
  $('tr-del').addEventListener('click', () => deleteCurrent());
  $('tr-new').addEventListener('click', () => {
    if (running || summarizing) return toast('正在处理中，请先等待或取消');
    const r = cur();
    if (r) {
      readEditorInto(r);
      persist();
    }
    newRecord('');
    $('tr-path').focus();
  });
  $('tr-search').addEventListener('input', () => paintList());
  $('tr-list').addEventListener('click', (e) => {
    const item = e.target.closest('.talk-item');
    if (item?.dataset.id) selectRecord(item.dataset.id);
  });

  $('tr-text').addEventListener('input', reconcileProofreadAfterEdit);
  $('tr-text').addEventListener('scroll', () => { $('tr-text-highlight').scrollTop = $('tr-text').scrollTop; });
  // 用户自己滚动 / 点击文本时，不再强行跟随检查进度
  for (const ev of ['wheel', 'mousedown', 'touchstart', 'keydown']) {
    $('tr-text').addEventListener(ev, () => { if (isProofing()) proofFollow = false; }, { passive: true });
  }
  $('tr-proofread').addEventListener('click', proofreadTranscript);
  $('tr-proofread-issues').addEventListener('click', handleProofreadChoice);
  // “听后自己填”：记住写了一半的内容（校对进行中面板会重绘），回车直接替换
  $('tr-proofread-issues').addEventListener('input', (e) => {
    const el = e.target.closest?.('.tr-manual');
    if (el) { proofDrafts.set(Number(el.dataset.id), el.value); schedulePersist(); }
  });
  // 关闭程序前把还没落盘的改动（含校对状态）立刻存下
  const flush = () => {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = 0;
    const r = cur();
    if (r) readEditorInto(r);
    persist();
  };
  window.addEventListener('beforeunload', flush);
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  $('tr-proofread-issues').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target.classList?.contains('tr-manual')) return;
    e.preventDefault();
    e.target.closest('.tr-proofread-issue')?.querySelector('[data-action="manual"]')?.click();
  });
  initProofPlayer();
  $('tr-text-export').addEventListener('click', () => $('tr-export').click());
  $('tr-preset').addEventListener('change', () => applyPreset($('tr-preset').value));
  $('tr-prompt-save').addEventListener('click', () => {
    const text = $('tr-prompt').value.trim(); if (!text) return toast('先填写提示词');
    const name = window.prompt('给这套模板起个名字', '我的模板');
    if (!name?.trim()) return;
    const list = promptLibrary();
    const id = genId();
    list.push({ id, name: name.trim().slice(0, 40), text });
    savePromptLibrary(list);
    applyPreset(`saved:${id}`);
    toast('已保存为自定义模板');
  });
  $('tr-prompt-delete').addEventListener('click', () => {
    const val = $('tr-preset').value; if (!val.startsWith('saved:')) return;
    lsSet(LS_PROMPT_LIBRARY, promptLibrary().filter(p => `saved:${p.id}` !== val));
    lsSet(LS_PRESET, 'deep'); renderPromptOptions(); applyPreset('deep'); toast('已删除这套提示词');
  });
  $('tr-prompt-improve').addEventListener('click', improvePrompt);
  $('tr-summary').addEventListener('input', () => {
    renderSummary();
    schedulePersist();
  });
  // 阅读渲染后的总结时，方向键 / 空格等只用于滚动，不触发演出快捷键
  $('tr-summary-view').addEventListener('keydown', (e) => {
    if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
  });
  $('tr-sum-mode').addEventListener('click', () => {
    summaryMode = summaryMode === 'source' ? 'view' : 'source';
    lsSet('sp.transcribe.sumMode', summaryMode);
    applySummaryMode();
  });

  // 放大查看（挂到 body，避免被面板的布局裁剪）
  document.body.appendChild($('tr-viewer'));
  $('tr-text-zoom').addEventListener('click', () => openViewer('text'));
  $('tr-sum-zoom').addEventListener('click', () => openViewer('summary'));
  $('tr-viewer-close').addEventListener('click', () => closeViewer());
  $('tr-viewer-bigger').addEventListener('click', () => setViewerFont(viewerFont + 2));
  $('tr-viewer-smaller').addEventListener('click', () => setViewerFont(viewerFont - 2));
  // 顶部标签：显示 / 隐藏某一列（至少保留一列）
  $('tr-viewer-tabs').addEventListener('click', (e) => {
    const key = e.target.closest('[data-key]')?.dataset.key;
    if (!key) return;
    if (viewerShow.has(key)) {
      if (viewerShow.size <= 1) return toast('至少要显示一列');
      viewerShow.delete(key);
    } else {
      viewerShow.add(key);
    }
    buildViewer();
  });
  // 每一列自己的「复制」
  $('tr-viewer-cols').addEventListener('click', (e) => {
    const key = e.target.closest('.tr-vcol')?.dataset.key;
    if (e.target.closest('[data-copy]')) copyViewerCol(viewerCol(key));
    else if (e.target.closest('[data-export]')) exportViewerCol(viewerCol(key));
  });
  const soleKey = () => $('tr-viewer-cols').querySelector('.tr-vcol')?.dataset.key;
  $('tr-viewer-copy').addEventListener('click', () => copyViewerCol(viewerCol(soleKey())));
  $('tr-viewer-export').addEventListener('click', () => exportViewerCol(viewerCol(soleKey())));

  // 总结标签：切换 / 删除 / 加一份对比
  $('tr-sum-tabs').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) return deleteSum(Number(del.dataset.del));
    if (e.target.closest('#tr-sum-add')) {
      e.stopPropagation();
      if ($('tr-add-menu')) return closeAddMenu();
      return showAddMenu();
    }
    const v = e.target.closest('#tr-add-menu [data-v]')?.dataset.v;
    if (v) {
      closeAddMenu();
      return summarize(v);
    }
    const tab = e.target.closest('.tr-stab[data-i]');
    if (tab) selectSum(Number(tab.dataset.i));
  });
  setViewerFont(viewerFont);
  applySummaryMode();

  $('tr-refine-go').addEventListener('click', () => refine());
  $('tr-undo').addEventListener('click', () => undoRefine());
  $('tr-refine-input').addEventListener('keydown', (e) => {
    // 输入修改意见时，按键不触发演出快捷键；Ctrl+Enter 直接提交
    if (!e.ctrlKey && !e.metaKey) return e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      refine();
    }
  });
  $('tr-refine-quick').addEventListener('click', (e) => {
    const q = e.target.closest('[data-q]')?.dataset.q;
    if (!q) return;
    const inp = $('tr-refine-input');
    const old = inp.value.trim();
    if (!old.includes(q)) inp.value = old ? `${old}\n${q}` : q;
    inp.focus();
  });

  $('tr-sum').addEventListener('click', () => summarize());
  $('tr-sum-stop').addEventListener('click', stopAi);
  $('tr-progress-stop').addEventListener('click', stopAi);
  $('tr-sum-copy').addEventListener('click', () => copyText($('tr-summary').value, '已复制总结'));
  $('tr-sum-export').addEventListener('click', () => {
    const r = cur();
    const s = curSum(r);
    const tag = r?.sums?.length > 1 ? `_总结${LETTERS[r.active]}${s?.label ? '_' + s.label : ''}` : '_总结';
    exportTo($('tr-summary').value, `${safeName(r?.title || '转写')}${tag}.md`, 'md');
  });

  $('tr-provider').addEventListener('change', () => onProviderChange());
  $('tr-key-save').addEventListener('click', () => saveKey());
  $('tr-key-clear').addEventListener('click', () => clearKey());
  $('tr-key').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveKey();
  });
  $('tr-prompt').addEventListener('input', () => {
    // 改了提示词就视为自定义，下次打开仍是这份
    lsSet(LS_PROMPT, $('tr-prompt').value);
    lsSet(LS_PRESET, 'custom');
    $('tr-preset').value = 'custom';
    $('tr-prompt-delete').disabled = true;
  });

  listen('sp-transcribe', (e) => onTranscribeEvent(e?.payload || e));
  listen('sp-summary', (e) => onSummaryEvent(e?.payload || e));
  // 首次使用时下载 SenseVoice 的进度走讲话记录频道
  listen('sp-dictation', (e) => {
    const p = e?.payload || e;
    if (running && p?.kind === 'download') setProgress(p.percent || 0, p.message || '下载模型…');
  });

  document.addEventListener('sp:module-change', (e) => {
    if (e.detail === 'transcribe') {
      paintList();
      loadKeyState();
    }
  });
  loadKeyState().then(() => paintVendorFields());
}
