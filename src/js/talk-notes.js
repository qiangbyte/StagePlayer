// 讲话记录：日期 / 主题 / 姓名 + 实时 ASR 听写，结束后保存

import { esc, lsGet, lsSet, toast, invoke, listen } from './util.js';

const KEY = 'sp.talk.notes';
const LS_MIC = 'sp.talk.micDevice';
const LS_MIC_CH = 'sp.talk.micChannel';
const $ = (id) => document.getElementById(id);

let records = loadRecords();
let curId = null;
let recording = false;
/** 仅用户点结束 / 致命错误时为 true；用于忽略后端误发的 stop */
let stopRequested = false;
let unlisten = null;
let committed = '';
let partial = '';
let dirty = false;
/** 本次开录前已有正文；定稿只能整理「本次新说的」，绝不能整篇覆盖清空历史 */
let sessionBase = '';
/** 本次开录后、定稿前的完整正文快照（含历史+本次流式），用于精修过短时回退 */
let preRefineSnapshot = '';

function todayStr() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function genId() {
  return 'tk' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function loadRecords() {
  const raw = lsGet(KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r) => r && typeof r === 'object')
    .map((r, i) => ({
      id: String(r.id || `tk-${i}`),
      date: String(r.date || todayStr()),
      topic: String(r.topic || ''),
      speaker: String(r.speaker || ''),
      content: String(r.content || ''),
      createdAt: Number(r.createdAt) || Date.now(),
      updatedAt: Number(r.updatedAt) || Date.now(),
    }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function persist() {
  lsSet(KEY, records);
}

function cur() {
  return records.find((r) => r.id === curId) || null;
}

function setStatus(text, on = false) {
  const el = $('talk-status');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('is-on', on);
}

function paintList() {
  const box = $('talk-list');
  if (!box) return;
  const q = ($('talk-search')?.value || '').trim().toLowerCase();
  const list = records.filter((r) => {
    if (!q) return true;
    const blob = `${r.date} ${r.topic} ${r.speaker} ${r.content}`.toLowerCase();
    return blob.includes(q);
  });
  if (!list.length) {
    box.innerHTML = '<div class="empty-tip">还没有讲话记录<br/><span style="font-size:12px;opacity:.75">点「＋新建」开始</span></div>';
    return;
  }
  box.innerHTML = list
    .map((r) => {
      const title = r.topic || '（无主题）';
      const sub = [r.date, r.speaker].filter(Boolean).join(' · ');
      const preview = (r.content || '').replace(/\s+/g, ' ').slice(0, 42);
      return `<div class="file-item talk-item ${r.id === curId ? 'active' : ''}" data-id="${esc(r.id)}">
        <div class="talk-item-title">${esc(title)}</div>
        <div class="talk-item-sub">${esc(sub || '未填姓名')}</div>
        ${preview ? `<div class="talk-item-preview">${esc(preview)}</div>` : ''}
      </div>`;
    })
    .join('');
}

function paintEditor() {
  const r = cur();
  const dateEl = $('talk-date');
  const topicEl = $('talk-topic');
  const speakerEl = $('talk-speaker');
  const live = $('talk-live');
  const partialEl = $('talk-partial');
  if (!r) {
    if (dateEl) dateEl.value = todayStr();
    if (topicEl) topicEl.value = '';
    if (speakerEl) speakerEl.value = '';
    if (live) live.textContent = '';
    if (partialEl) partialEl.textContent = '';
    committed = '';
    partial = '';
    setStatus('未选择记录');
    return;
  }
  if (dateEl) dateEl.value = r.date || todayStr();
  if (topicEl) topicEl.value = r.topic || '';
  if (speakerEl) speakerEl.value = r.speaker || '';
  committed = r.content || '';
  partial = '';
  if (live) live.textContent = committed;
  if (partialEl) partialEl.textContent = '';
  setStatus(recording ? '识别中…' : '已载入', recording);
  live?.scrollTo?.(0, live.scrollHeight);
}

function readMetaInto(r) {
  if (!r) return;
  r.date = $('talk-date')?.value || todayStr();
  r.topic = ($('talk-topic')?.value || '').trim();
  r.speaker = ($('talk-speaker')?.value || '').trim();
  const liveText = ($('talk-live')?.innerText || $('talk-live')?.textContent || '').trim();
  // 识别中以 committed+partial 为准；停录后允许手改 live
  r.content = recording
    ? [committed, partial].filter(Boolean).join(committed && partial ? '\n' : '')
    : liveText;
  r.updatedAt = Date.now();
}

function newRecord() {
  const r = {
    id: genId(),
    date: todayStr(),
    topic: '',
    speaker: '',
    content: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  records.unshift(r);
  curId = r.id;
  dirty = true;
  persist();
  paintList();
  paintEditor();
  $('talk-topic')?.focus();
  toast('已新建讲话记录');
}

function selectRecord(id) {
  if (recording) {
    toast('请先停止识别再切换记录');
    return;
  }
  if (curId && dirty) {
    const r = cur();
    if (r) {
      readMetaInto(r);
      persist();
    }
  }
  curId = id;
  dirty = false;
  paintList();
  paintEditor();
}

function saveCurrent({ toastOn = true } = {}) {
  let r = cur();
  if (!r) {
    newRecord();
    r = cur();
  }
  readMetaInto(r);
  // 停录时把 partial 也并进 content
  if (!recording && partial) {
    r.content = [committed, partial].filter(Boolean).join('\n');
    committed = r.content;
    partial = '';
    const live = $('talk-live');
    if (live) live.textContent = committed;
    const partialEl = $('talk-partial');
    if (partialEl) partialEl.textContent = '';
  }
  if (!r.topic && !r.speaker && !(r.content || '').trim()) {
    if (toastOn) toast('请至少填写主题、姓名或内容');
    return false;
  }
  r.updatedAt = Date.now();
  records = [r, ...records.filter((x) => x.id !== r.id)].sort(
    (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
  );
  persist();
  dirty = false;
  paintList();
  if (toastOn) toast('讲话记录已保存');
  return true;
}

function deleteCurrent() {
  const r = cur();
  if (!r) return toast('没有可删的记录');
  if (recording) return toast('请先停止识别');
  if (!window.confirm(`删除「${r.topic || r.date}」？`)) return;
  records = records.filter((x) => x.id !== r.id);
  curId = records[0]?.id || null;
  persist();
  paintList();
  paintEditor();
  toast('已删除');
}

function exportCurrent() {
  const r = cur();
  if (!r) return toast('没有可导出的记录');
  readMetaInto(r);
  const text = [
    `日期：${r.date || ''}`,
    `主题：${r.topic || ''}`,
    `姓名：${r.speaker || ''}`,
    '',
    r.content || '',
  ].join('\n');
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  const name = `${r.date || 'talk'}_${(r.topic || r.speaker || '讲话').replace(/[\\/:*?"<>|]+/g, '_')}.txt`;
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('已导出文本');
}

function fillChannels(maxCh) {
  const chSel = $('talk-mic-ch');
  if (!chSel) return;
  const n = Math.max(1, Math.min(64, parseInt(maxCh, 10) || 1));
  const saved = lsGet(LS_MIC_CH, 0);
  const cur = chSel.value !== '' ? parseInt(chSel.value, 10) : NaN;
  chSel.innerHTML = Array.from({ length: n }, (_, i) => `<option value="${i}">${i + 1}</option>`).join('');
  const prefer = Number.isFinite(cur) ? cur : (Number.isFinite(+saved) ? +saved : 0);
  chSel.value = String(Math.max(0, Math.min(n - 1, prefer)));
}

async function refreshDevices() {
  const sel = $('talk-mic-dev');
  if (!sel) return;
  try {
    const list = await invoke('spl_list_inputs');
    const saved = lsGet(LS_MIC, null);
    const cur = sel.value;
    sel.innerHTML = '<option value="" data-ch="1">系统默认输入</option>' + (list || []).map((d) => {
      const ch = d.maxChannels || d.max_channels || 1;
      return `<option value="${d.index}" data-ch="${ch}">${esc(d.name)}${d.isDefault ? '（默认）' : ''} · ${ch}ch</option>`;
    }).join('');
    const prefer = cur !== '' ? cur : (saved != null ? String(saved) : '');
    if (prefer !== '' && [...sel.options].some((o) => o.value === prefer)) sel.value = prefer;
    else sel.value = '';
    fillChannels(sel.selectedOptions[0]?.dataset?.ch || 1);
  } catch {
    sel.innerHTML = '<option value="" data-ch="1">系统默认输入</option>';
    fillChannels(1);
  }
}

function selectedDevice() {
  const v = $('talk-mic-dev')?.value;
  if (v === '' || v == null) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function selectedChannel() {
  const n = parseInt($('talk-mic-ch')?.value, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function paintMic(levelPct, db, stateText, state) {
  const fill = $('talk-mic-fill');
  const dbEl = $('talk-mic-db');
  const st = $('talk-mic-state');
  const dot = $('talk-mic-dot');
  if (fill) fill.style.width = `${Math.max(0, Math.min(100, levelPct || 0))}%`;
  if (dbEl) dbEl.textContent = db != null ? `${Number(db).toFixed(0)} dB` : '—';
  if (st && stateText) st.textContent = stateText;
  if (dot) dot.dataset.state = state || 'off';
}

function appendFinal(text) {
  const t = (text || '').trim();
  if (!t) return;
  committed = committed ? `${committed}\n${t}` : t;
  partial = '';
  const live = $('talk-live');
  if (live) {
    live.textContent = committed;
    live.scrollTop = live.scrollHeight;
  }
  const partialEl = $('talk-partial');
  if (partialEl) partialEl.textContent = '';
  dirty = true;
}

/**
 * @param {string} text
 * @param {string} [message]
 * @param {{ mode?: 'session' | 'all' }} [opts]
 *   session：本次精修结果接到开录前原文后面（默认，防清空历史）
 *   all：整篇替换（「润色文本」按钮）
 */
function applyRefined(text, message, opts = {}) {
  const mode = opts.mode || 'session';
  const incoming = (text || '').trim();
  if (!incoming && mode === 'all') return;

  const base = sessionBase.trim();
  const snap = (preRefineSnapshot || committed || '').trim();
  let next = '';

  if (mode === 'all') {
    next = incoming;
  } else {
    // 定稿结果只代表「这一次录音」；必须保留开录前已有内容
    if (base) {
      if (!incoming) next = snap || base;
      else if (incoming === base || incoming.startsWith(base + '\n') || incoming.startsWith(base)) {
        next = incoming;
      } else {
        next = `${base}\n${incoming}`;
      }
    } else {
      next = incoming || snap;
    }
    // 安全阀：精修稿异常过短（只剩一句）时，保留停录前完整识别稿
    if (snap.length > 80 && next.length < Math.max(40, snap.length * 0.35)) {
      next = snap;
      message = (message ? message + ' · ' : '') + '精修过短，已保留完整识别稿';
    }
  }

  next = next.trim();
  if (!next) return;

  committed = next;
  partial = '';
  const live = $('talk-live');
  if (live) {
    live.textContent = committed;
    live.scrollTop = live.scrollHeight;
  }
  const partialEl = $('talk-partial');
  if (partialEl) partialEl.textContent = '';
  dirty = true;
  const r = cur();
  if (r) {
    r.content = committed;
    r.updatedAt = Date.now();
    persist();
    paintList();
  }
  if (message) toast(message);
}

async function polishCurrentText() {
  const r = cur();
  if (!r) return toast('没有可润色的记录');
  // 录音中也可以润色「已落句」正文，不中断听写
  readMetaInto(r);
  const liveCommitted = (committed || '').trim();
  const src = (liveCommitted || r.content || '').trim();
  if (!src) return toast('内容为空');
  const keepRec = recording;
  setStatus(keepRec ? '润色中（继续听写）…' : '润色中…', true);
  try {
    const out = await invoke('dictation_polish_text', { text: src });
    if (!keepRec) {
      sessionBase = '';
      preRefineSnapshot = '';
    }
    applyRefined(out || src, keepRec ? '已润色落句文本（识别未停）' : '全文已润色（标点+热词）', {
      mode: 'all',
    });
    setStatus(keepRec ? '识别中…' : '已润色', keepRec);
  } catch (err) {
    toast('润色失败：' + (err?.message || err));
    setStatus(keepRec ? '识别中…' : '润色失败', keepRec);
  }
}

/** 后台预下载 SenseVoice / 标点模型，不挡实时识别 */
function ensureRefineModelBg() {
  invoke('dictation_ensure_refine_model').catch(() => {});
}

function showPartial(text) {
  partial = (text || '').trim();
  const partialEl = $('talk-partial');
  if (partialEl) partialEl.textContent = partial ? `… ${partial}` : '';
  dirty = true;
}

async function stopRec({ save = false } = {}) {
  stopRequested = true;
  recording = false;
  const btn = $('talk-rec');
  if (btn) {
    btn.textContent = '开始识别';
    btn.classList.remove('danger');
  }
  try {
    await invoke('dictation_stop');
  } catch { /* ignore */ }
  if (partial) appendFinal(partial);
  // 定稿前快照：含历史 + 本次流式全文，精修失败/过短时回退用
  preRefineSnapshot = (committed || '').trim();
  paintMic(0, null, '未听输入', 'off');
  setStatus('已停止，等待定稿…');
  if (save) saveCurrent({ toastOn: false });
  // 保留 unlisten，以便接收 refining / refined；稍后再卸
  setTimeout(() => {
    if (recording) return;
    if (unlisten) {
      try { unlisten(); } catch { /* ignore */ }
      unlisten = null;
    }
  }, 120000);
}

async function startRec() {
  if (recording) return stopRec({ save: false });
  if (!cur()) newRecord();
  readMetaInto(cur());
  // 记住开录前正文：后面定稿只追加本次，不覆盖历史
  sessionBase = (committed || cur()?.content || '').trim();
  preRefineSnapshot = '';

  try {
    let st = await invoke('lyric_asr_status');
    if (!st?.ready) {
      toast('首次使用需下载 ASR 模型…');
      st = await invoke('lyric_asr_ensure_model');
    }
    if (!st?.ready) throw new Error(st?.message || '模型未就绪');
  } catch (err) {
    toast('模型未就绪：' + (err?.message || err));
    return;
  }

  // 与歌词跟词互斥
  try { await invoke('lyric_follow_stop'); } catch { /* ignore */ }

  const deviceIndex = selectedDevice();
  const channel = selectedChannel();
  lsSet(LS_MIC, deviceIndex);
  lsSet(LS_MIC_CH, channel);

  if (unlisten) {
    try { unlisten(); } catch { /* ignore */ }
    unlisten = null;
  }
  unlisten = await listen('sp-dictation', (e) => {
    const p = e?.payload || e;
    if (!p) return;
    // 定稿事件在 stop 之后仍要接收
    if (p.kind === 'refining') {
      const pct = p.percent != null ? ` ${Math.round(Number(p.percent))}%` : '';
      setStatus((p.message || '定稿精修中…') + pct, true);
      return;
    }
    if (p.kind === 'download') {
      const pct = p.percent != null ? ` ${Math.min(100, Math.round(Number(p.percent)))}%` : '';
      let msg = p.message || '下载精修模型…';
      // 代理常见 520：文案说清楚是换源，避免以为卡死
      if (/HTTP\s*520|源站暂不可用/i.test(msg)) {
        msg = '镜像繁忙(520)，正在换源…';
      }
      setStatus(msg + pct, true);
      return;
    }
    if (p.kind === 'refined') {
      applyRefined(p.text || '', p.message || '定稿完成', { mode: 'session' });
      setStatus('定稿完成');
      saveCurrent({ toastOn: false });
      return;
    }
    if (p.kind === 'stop') {
      // 用户未点结束：会话中断则自动续接，不要当成「识别完就停」
      if (!stopRequested && recording) {
        setStatus('续接听写…', true);
        const deviceIndex = selectedDevice();
        const channel = selectedChannel();
        invoke('dictation_start', { deviceIndex, channel })
          .then(() => setStatus('识别中…', true))
          .catch((err) => {
            toast('听写中断：' + (err?.message || err));
            stopRequested = true;
            recording = false;
            const btn = $('talk-rec');
            if (btn) {
              btn.textContent = '开始识别';
              btn.classList.remove('danger');
            }
            setStatus('已停止');
            paintMic(0, null, '未听输入', 'off');
          });
        return;
      }
      recording = false;
      const btn = $('talk-rec');
      if (btn) {
        btn.textContent = '开始识别';
        btn.classList.remove('danger');
      }
      if (($('talk-status')?.textContent || '').includes('精修') ||
          ($('talk-status')?.textContent || '').includes('定稿')) {
        /* 保留定稿状态文案 */
      } else {
        setStatus('已停止');
      }
      paintMic(0, null, '未听输入', 'off');
      return;
    }
    if (!recording) return;
    if (p.kind === 'input') {
      paintMic(0, -90, p.message || '已开输入', 'wait');
      setStatus(p.message || '已开输入', true);
    }
    if (p.kind === 'level') {
      const live = p.rmsDb != null && p.rmsDb > -48;
      paintMic(p.percent || 0, p.rmsDb, p.message || '', live ? 'live' : 'wait');
    }
    if (p.kind === 'partial' && p.text) showPartial(p.text);
    if (p.kind === 'final' && p.text) {
      appendFinal(p.text);
      // 落句≠停录，状态保持「识别中」
      setStatus('识别中…', true);
    }
    if (p.kind === 'start') setStatus('识别中…', true);
    if (p.kind === 'error') {
      const msg = p.message || '失败';
      // 续接提示不弹 toast，避免打扰
      if (!/正在尝试续接/i.test(msg)) {
        toast('讲话识别：' + msg);
      }
      // 仅致命错误才停；短暂抖动 / 续接由后端与 stop 处理
      if (/连续失败|sidecar 失败|初始化|找不到输入|无 stdin|无 stdout|就绪超时|提前退出/i.test(msg)) {
        stopRec({ save: false });
      } else {
        setStatus('识别中…', true);
      }
    }
  });

  // 必须在 invoke 前就标记录音中，否则 ready/partial/final 会被丢弃，
  // 且误判为「识别完就结束」
  stopRequested = false;
  recording = true;
  const btn = $('talk-rec');
  if (btn) {
    btn.textContent = '结束并保存';
    btn.classList.add('danger');
  }
  setStatus('识别中…', true);

  try {
    await invoke('dictation_start', { deviceIndex, channel });
  } catch (err) {
    toast('无法开始识别：' + (err?.message || err));
    await stopRec({ save: false });
    return;
  }

  toast('开始识别：请对着干声说话（说完一句会自动落句，不会停录）');
  // 后台拉精修模型，停录时可二遍精修
  ensureRefineModelBg();
}

export function initTalkNotes() {
  if (!$('panel-talk')) return;
  paintList();
  if (records[0]) {
    curId = records[0].id;
    paintEditor();
  } else {
    paintEditor();
  }
  refreshDevices();

  $('talk-new')?.addEventListener('click', () => {
    if (recording) return toast('请先停止识别');
    newRecord();
  });
  $('talk-search')?.addEventListener('input', () => paintList());
  $('talk-list')?.addEventListener('click', (e) => {
    const row = e.target.closest('[data-id]');
    if (row) selectRecord(row.dataset.id);
  });
  $('talk-save')?.addEventListener('click', () => saveCurrent());
  $('talk-export')?.addEventListener('click', () => exportCurrent());
  $('talk-del')?.addEventListener('click', () => deleteCurrent());
  $('talk-polish')?.addEventListener('click', () => polishCurrentText());
  $('talk-rec')?.addEventListener('click', async () => {
    if (recording) await stopRec({ save: true });
    else await startRec();
  });
  // 进入模块时静默检查/预下载精修模型
  invoke('dictation_refine_status')
    .then((st) => {
      if (st && !st.senseVoiceReady) ensureRefineModelBg();
    })
    .catch(() => {});

  for (const id of ['talk-date', 'talk-topic', 'talk-speaker']) {
    $(id)?.addEventListener('input', () => {
      dirty = true;
      const r = cur();
      if (!r) return;
      readMetaInto(r);
      persist();
      paintList();
    });
  }
  $('talk-live')?.addEventListener('input', () => {
    if (recording) return;
    dirty = true;
    const r = cur();
    if (!r) return;
    r.content = ($('talk-live').innerText || '').trim();
    committed = r.content;
    r.updatedAt = Date.now();
    persist();
    paintList();
  });

  $('talk-mic-dev')?.addEventListener('change', () => {
    const v = $('talk-mic-dev')?.value;
    lsSet(LS_MIC, v === '' ? null : parseInt(v, 10));
    fillChannels($('talk-mic-dev')?.selectedOptions?.[0]?.dataset?.ch || 1);
  });
  $('talk-mic-ch')?.addEventListener('change', () => {
    lsSet(LS_MIC_CH, selectedChannel());
  });

  document.addEventListener('sp:module-change', (e) => {
    if (e.detail === 'talk') {
      refreshDevices();
      paintList();
    }
  });
}
