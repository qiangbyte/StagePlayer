// 录音转文字：本地 SenseVoice 离线转写（Rust 后端）+ DeepSeek / 千问总结（流式，可切换）
// 记录存 localStorage（sp.transcribe.records）；DeepSeek Key 只在 Rust 侧保存，前端拿不到明文。

import { esc, lsGet, lsSet, toast, invoke, listen, pickFiles } from './util.js';
import { renderMarkdown } from './markdown.js';

const KEY = 'sp.transcribe.records';
const LS_LANG = 'sp.transcribe.lang';
const LS_PRESET = 'sp.transcribe.preset';
const LS_PROMPT = 'sp.transcribe.prompt';
const AUDIO_PICK_EXT = ['m4a', 'mp3', 'wav', 'flac', 'aac', 'ogg', 'm4b', 'mp4', 'mka', 'webm'];
const $ = (id) => document.getElementById(id);

const PRESETS = {
  sermon: [
    '请把文稿整理成「讲道/讲座笔记」，严格按下面的结构和格式输出（Markdown）：',
    '',
    '# 〈用一个短语概括本次主题〉',
    '',
    '> 〈一句话概括本次内容的核心〉',
    '',
    '## 一、📌 基本信息',
    '- **主题**：……',
    '- **时间**：使用下方「本次记录时间」；若文稿中明确提到日期则以文稿为准',
    '- **参与者推测**：讲道者 / 主持人 / 听众等（只依据文稿推测）',
    '',
    '## 二、🎙️ 讲道背景与目的',
    '说明本次内容面向谁、针对什么问题、要达到什么目的（一段话）。',
    '',
    '## 三、📝 内容解读',
    '按讲述的逻辑划分为若干主题，每个主题用 `### 1. 标题` 开头，下设 `#### 1.1 小标题`。',
    '每个小节用要点列表写清论证过程，关键结论用 **加粗**；做对比时用 Markdown 表格；',
    '重要的金句或结论用引用块 `>` 单独列出。',
    '',
    '## 四、✅ 待办事项',
    '列出文稿中明确提到的行动或作业；没有则写“暂无明确待办事项”。',
    '',
    '## 五、💡 洞察',
    '1. **💎 核心发现**：2–3 条，提炼最有说服力的论点或最值得记住的判断。',
    '2. **🛠 实用价值**：2–3 条，说明如何在实际中应用、如何回应常见质疑。',
    '3. **💭 延伸思考**：1–2 条，指出论证中可能的跳跃、未展开之处或值得留意的风险。',
    '',
    '要求：',
    '- 只依据文稿，不添加文稿之外的事实、经文或数据；文稿没有提到的内容不要写。',
    '- 人名、经文出处、术语若明显是语音识别错误，按上下文更正；无法确定时保持原样。',
    '- 保持原意，表达精炼；“基本信息”“待办事项”等固定栏目即使内容较少也要保留。',
  ].join('\n'),
  meeting: [
    '请把下面的录音整理成会议纪要，使用 Markdown：',
    '1. **会议主题与参与者**（能识别则写）',
    '2. **讨论要点**（按议题分条）',
    '3. **决议事项**',
    '4. **待办事项**（负责人 / 事项 / 时间，未提及的留空）',
    '5. **待确认问题**',
  ].join('\n'),
  brief: '请用不超过 200 字概括这段内容的主旨和最重要的 3 个要点。',
};

let records = []; // 在 initTranscribe 里加载（loadRecords 依赖后面定义的常量）
let curId = null;
let running = false;
let summarizing = false;
let busyKind = ''; // summarizing 为 true 时：'summary'（总结）| 'refine'（精修）
const HISTORY_MAX = 8; // 每条记录最多保留的可撤销版本数
let saveTimer = 0;

function genId() {
  return 'tr' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function pad2(n) {
  return String(n).padStart(2, '0');
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

const VENDOR_LABEL = { deepseek: 'DeepSeek', qwen: '千问' };
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

function setProgress(pct, text, state = '') {
  const box = $('tr-progress');
  const fill = $('tr-fill');
  const t = $('tr-progress-text');
  if (!box || !fill || !t) return;
  box.classList.toggle('is-done', state === 'done');
  box.classList.toggle('is-error', state === 'error');
  fill.style.width = `${Math.max(0, Math.min(100, Number(pct) || 0))}%`;
  t.textContent = text || '';
}

function paintButtons() {
  const busy = running || summarizing;
  $('tr-start').disabled = busy;
  $('tr-pick').disabled = busy;
  $('tr-cancel').classList.toggle('hidden', !running);
  $('tr-sum').disabled = busy;
  $('tr-sum-stop').classList.toggle('hidden', !summarizing);
  $('tr-text').readOnly = running;
  $('tr-summary').readOnly = summarizing;
  const n = curSum()?.history?.length || 0;
  const go = $('tr-refine-go');
  if (go) go.disabled = busy;
  const undo = $('tr-undo');
  if (undo) undo.disabled = busy || !n;
  const ver = $('tr-ver');
  if (ver) ver.textContent = n ? `可撤销 ${n} 步` : '';
  const doing = busyKind === 'refine' ? '精修中…' : '总结中…';
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
        pane.innerHTML = `<header class="tr-vcol-head"><span class="tr-vcol-title"></span><button type="button" class="mini-btn" data-copy="1">复制</button></header>
          <div class="tr-vscroll" tabindex="0"><div class="tr-viewer-content"></div></div>`;
      }
      pane.querySelector('.tr-vcol-title').textContent = c.title;
      pane.querySelector('.tr-viewer-content').className = `tr-viewer-content${c.md ? ' tr-md' : ''}`;
      wrap.appendChild(pane);
    });
  wrap.dataset.n = String(wrap.children.length);
  refreshViewer();
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
  r.updatedAt = Date.now();
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

async function pickAudio() {
  const files = await pickFiles(AUDIO_PICK_EXT, '选择要转写的录音');
  if (files?.length) {
    $('tr-path').value = files[0];
    const r = cur();
    if (r && !r.text.trim()) {
      r.path = files[0];
      if (!r.title || r.title === '新转写') r.title = baseName(files[0]);
      persist();
      paintList();
    }
  }
}

async function startTranscribe() {
  if (running || summarizing) return;
  const path = cleanPath($('tr-path').value);
  if (!path) return toast('先选择录音文件，或粘贴文件路径');
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
  setProgress(0, '准备中…');
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
      toast('没有识别到语音内容（可能是静音或语种不对）');
    } else {
      toast(`转写完成：音频 ${fmtDur(res.durationSec)}，用时 ${fmtDur(res.elapsedSec)}`, 6000);
    }
  } catch (err) {
    const msg = String(err?.message || err);
    const rec = records.find((x) => x.id === r.id);
    if (rec) {
      rec.text = $('tr-text').value.trim();
      persist();
    }
    if (msg !== '已取消') toast('转写失败：' + msg, 8000);
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
  menu.innerHTML = ['deepseek', 'qwen']
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
  setProgress(2, `连接 ${label}…`);
  let ok = false;
  try {
    const full = await invoke('ai_summarize', { text, prompt, vendor });
    setSummary(full);
    ok = true;
    toast(addVendor ? `${label} 的总结已加入，可点「放大」并排对比` : '总结完成');
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg !== '已取消') toast('总结失败：' + msg, 9000);
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
  setProgress(2, `连接 ${label}…`);
  let ok = false;
  try {
    const full = await invoke('ai_refine', { text, summary: before, instruction, vendor });
    setSummary(full);
    ok = true;
    toast('精修完成；不满意可点「撤销」回到上一版');
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg !== '已取消') toast('精修失败：' + msg, 9000);
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
  if (!summarizing || !p) return;
  switch (p.kind) {
    case 'delta':
      appendSummary(p.text || '');
      break;
    case 'start':
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
      setProgress(0, '已停止', 'error');
      break;
    default:
      break;
  }
}

function applyPreset(name) {
  const sel = $('tr-preset');
  if (sel) sel.value = name;
  lsSet(LS_PRESET, name);
  if (name === 'custom') {
    $('tr-prompt').value = lsGet(LS_PROMPT, '') || PRESETS.sermon;
  } else {
    $('tr-prompt').value = PRESETS[name] || PRESETS.sermon;
  }
}

// ───────────────────────── 初始化 ─────────────────────────

export function initTranscribe() {
  if (!$('panel-transcribe')) return;

  $('tr-lang').value = lsGet(LS_LANG, 'auto') || 'auto';
  const preset = lsGet(LS_PRESET, 'sermon');
  applyPreset(PRESETS[preset] || preset === 'custom' ? preset : 'sermon');

  records = loadRecords();
  curId = records[0]?.id || null;
  paintList();
  paintEditor();

  $('tr-pick').addEventListener('click', () => pickAudio());
  $('tr-start').addEventListener('click', () => startTranscribe());
  $('tr-cancel').addEventListener('click', () => {
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

  $('tr-text').addEventListener('input', schedulePersist);
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
    if (!e.target.closest('[data-copy]')) return;
    const key = e.target.closest('.tr-vcol')?.dataset.key;
    const col = viewerColumns().find((c) => c.key === key);
    if (!col) return;
    if (col.md) copyText(colSource(col), '已复制总结');
    else copyText(stripStamps(colSource(col)), '已复制转写文字（不含时间点）');
  });

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
  $('tr-sum-stop').addEventListener('click', () => invoke('ai_cancel').catch(() => {}));
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
  $('tr-preset').addEventListener('change', () => applyPreset($('tr-preset').value));
  $('tr-prompt').addEventListener('input', () => {
    // 改了提示词就视为自定义，下次打开仍是这份
    lsSet(LS_PROMPT, $('tr-prompt').value);
    lsSet(LS_PRESET, 'custom');
    $('tr-preset').value = 'custom';
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
