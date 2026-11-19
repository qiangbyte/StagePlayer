// 歌词投屏模块：歌词库 + 逐行控制 + 段落快速跳转（副歌 / 主歌 / 桥段 …）
// 敬拜现场领唱随时可能转副歌：一个键就能切过去，大屏平滑滚动

import {
  pickFiles, esc, fileName, lsGet, lsSet, toast, convertFileSrc, invoke, listen, IMAGE_EXT, VIDEO_EXT,
} from './util.js';
import { pushToOutput, claimOutputSeq, getCurrentOutput } from './output-main.js';
import { renderOutput } from './output-core.js';
import { pushUndo } from './undo.js';
import { readPect } from './pect-import.js';
import {
  parseLyricSheet, paletteFromColor, hslToHex, LSHOW_SWATCHES, defaultLshowBg,
} from './lyrics-show-render.js';

const LS_SONGS = 'sp.lyrics.songs';
const LS_STYLE = 'sp.lyrics.style';
const LS_CUR = 'sp.lyrics.current';
const LS_AUTO = 'sp.lyrics.autoPlay';
const LS_MIC = 'sp.lyrics.micDevice';
const LS_MIC_CH = 'sp.lyrics.micChannel';
const LS_MIC_REF = 'sp.lyrics.refChannel';

const $ = (id) => document.getElementById(id);
const genId = () => 'ly' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/** scroll 一句一句滚动 / stanza 整段显示逐句高亮 / page 一段一页，按段翻 */
const VIEWS = ['scroll', 'stanza', 'page'];
const isPage = () => style.view === 'page';

const SEC_KEYS = { chorus: 'C', verse: 'V', bridge: 'Q', pre: 'P', ending: 'E' };

let songs = (lsGet(LS_SONGS, []) || []).filter((s) => s && s.id);
let style = { view: 'scroll', step: 1, scale: 1, font: 'fzchs', anim: 'fade', showLabel: true, showTitle: false, ...(lsGet(LS_STYLE, {}) || {}) };
// 旧的「整段显示，逐句高亮」并入「一段一段」：整段显示就整段全亮、按段切换
if (style.view === 'stanza') style = { ...style, view: 'page', step: 1 };
let curId = lsGet(LS_CUR, null);
/** 正在控制的歌（可能来自节目单快照，不在歌词库里） */
let song = null;
let sheet = { lines: [], times: [], secOf: [], sections: [] };
let active = 0;
let filter = '';

/** 自动播放：优先语音跟词（FunASR-Nano 歌词模型）；失败则回退字数/时间轴 */
let autoPlay = !!lsGet(LS_AUTO, false);
let autoArmed = false;
let autoLineStartedAt = 0;
let autoDwellMs = 4000;
let autoRaf = 0;
let autoManualHoldUntil = 0;
let autoAsrMode = false; // true = 正在用麦克风 ASR 跟词
let autoAsrText = '';
let autoFollowUnlisten = null;
/** off | open | wait | live | hear */
let autoMicState = 'off';
let autoMicName = '';
let autoRmsDb = null;
let autoMicPct = 0;

function saveSongs() { lsSet(LS_SONGS, songs); }
function saveStyle() { lsSet(LS_STYLE, style); }
function libSong(id) { return songs.find((s) => s.id === id) || null; }
function lastBg() {
  const s = [...songs].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  return { ...defaultLshowBg(), ...(s?.bg || {}) };
}

// ---------- 载入 / 导航 ----------

function loadSong(s, at = 0) {
  song = s;
  sheet = parseLyricSheet(s?.text || '');
  active = Math.min(Math.max(0, at), Math.max(0, sheet.lines.length - 1));
  if (s && libSong(s.id)) {
    curId = s.id;
    lsSet(LS_CUR, curId);
  }
  renderList();
  renderEditor();
  renderLines();
  renderMini();
  resetAutoClock();
  paintAutoUi();
}

function isLive() {
  const out = getCurrentOutput();
  return out?.kind === 'lyricshow' && !!song && out.songId === song.id;
}

function previewIndex() {
  if (!sheet.lines.length) return -1;
  if (isPage()) {
    const ns = sheet.sections[(sheet.secOf[active] | 0) + 1];
    return ns ? ns.start : -1;
  }
  if (style.step === 2) {
    const sec = secAt(active);
    const n = active + 2;
    if (sec && n < sec.end) return n;
    const ns = sheet.sections[(sheet.secOf[active] | 0) + 1];
    if (ns) return ns.start;
    return sheet.lines.length ? 0 : -1;
  }
  if (active + 1 < sheet.lines.length) return active + 1;
  return sheet.lines.length ? 0 : -1;
}

function payload() {
  const preview = previewIndex();
  return {
    kind: 'lyricshow',
    songId: song.id,
    title: song.title || '',
    lines: sheet.lines,
    secOf: sheet.secOf,
    sections: sheet.sections,
    active,
    preview,
    autoPlay: autoPlay && autoArmed,
    step: style.step === 2 ? 2 : 1,
    view: VIEWS.includes(style.view) ? style.view : 'scroll',
    bg: { ...defaultLshowBg(), ...(song.bg || {}) },
    style: { scale: style.scale, font: style.font, anim: style.anim, showLabel: style.showLabel, showTitle: style.showTitle },
  };
}

/** 当前句停留时长：有 LRC 用时间差；否则按字数估算，并略早挂起「预计下一句」 */
function dwellForActive() {
  const times = sheet.times || [];
  const t0 = times[active];
  const next = previewIndex();
  if (t0 != null && next >= 0 && times[next] != null && times[next] > t0) {
    return Math.min(12000, Math.max(1800, (times[next] - t0) * 1000));
  }
  // 一段一页：按整段字数
  if (isPage()) {
    const sec = secAt(active);
    const text = sec ? sheet.lines.slice(sec.start, sec.end).join('') : (sheet.lines[active] || '');
    const chars = [...text].length;
    return Math.min(14000, Math.max(3500, 2800 + chars * 220));
  }
  const line = sheet.lines[active] || '';
  const chars = [...line].length;
  return Math.min(9000, Math.max(2200, 1800 + chars * 360));
}

function resetAutoClock() {
  autoArmed = false;
  autoLineStartedAt = performance.now();
  autoDwellMs = dwellForActive();
}

function stopAutoLoop() {
  if (autoRaf) {
    cancelAnimationFrame(autoRaf);
    autoRaf = 0;
  }
}

function micChLabel() {
  const ch = selectedMicChannel();
  return `Ch${ch + 1}`;
}

function micStateLabel() {
  if (!autoPlay) return '未听干声';
  if (!autoAsrMode) return '时间轴模式（未听干声）';
  const ch = micChLabel();
  if (autoMicState === 'open') {
    return autoMicName ? `已开输入 · ${autoMicName} · ${ch}` : `正在打开输入… · ${ch}`;
  }
  if (autoMicState === 'wait') {
    return autoMicName ? `已接 · 等待干声（${autoMicName} · ${ch}）` : `已接 · 等待干声 · ${ch}`;
  }
  if (autoMicState === 'live') return `干声有电平 · ${ch} · 等待识别`;
  if (autoMicState === 'hear') return `正在听唱 · ${ch} · ${autoAsrText || '…'}`;
  return '语音跟词中';
}

function paintMicUi() {
  const dot = $('lshow-auto-mic-dot');
  const state = $('lshow-auto-mic-state');
  const fill = $('lshow-auto-mic-fill');
  const dbEl = $('lshow-auto-mic-db');
  const row = $('lshow-auto-mic');
  if (state) state.textContent = micStateLabel();
  if (dot) dot.dataset.state = autoAsrMode ? autoMicState : 'off';
  if (fill) fill.style.width = autoAsrMode ? `${Math.max(2, autoMicPct).toFixed(0)}%` : '0%';
  if (dbEl) {
    dbEl.textContent = autoAsrMode && autoRmsDb != null
      ? `${autoRmsDb.toFixed(0)} dB`
      : '—';
  }
  row?.classList.toggle('is-live', autoMicState === 'live' || autoMicState === 'hear');
  row?.classList.toggle('is-wait', autoMicState === 'wait' || autoMicState === 'open');
}

function fillMicChannels(maxCh) {
  const chSel = $('lshow-auto-mic-ch');
  const refSel = $('lshow-auto-mic-ref');
  const n = Math.max(1, Math.min(64, parseInt(maxCh, 10) || 1));
  if (chSel) {
    const saved = lsGet(LS_MIC_CH, 0);
    const cur = chSel.value !== '' ? parseInt(chSel.value, 10) : NaN;
    chSel.innerHTML = Array.from({ length: n }, (_, i) =>
      `<option value="${i}">${i + 1}</option>`
    ).join('');
    const prefer = Number.isFinite(cur) ? cur : (Number.isFinite(+saved) ? +saved : 0);
    chSel.value = String(Math.max(0, Math.min(n - 1, prefer)));
  }
  if (refSel) {
    const savedRef = lsGet(LS_MIC_REF, null);
    const curRef = refSel.value !== '' ? parseInt(refSel.value, 10) : NaN;
    refSel.innerHTML = '<option value="">无</option>' + Array.from({ length: n }, (_, i) =>
      `<option value="${i}">${i + 1}</option>`
    ).join('');
    if (Number.isFinite(curRef) && curRef >= 0 && curRef < n) {
      refSel.value = String(curRef);
    } else if (savedRef != null && savedRef !== '' && Number.isFinite(+savedRef)) {
      const v = Math.max(0, Math.min(n - 1, +savedRef));
      refSel.value = String(v);
    } else {
      refSel.value = '';
    }
  }
}

async function refreshMicDevices() {
  const sel = $('lshow-auto-mic-dev');
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
    fillMicChannels(sel.selectedOptions[0]?.dataset?.ch || 1);
  } catch {
    sel.innerHTML = '<option value="" data-ch="1">系统默认输入</option>';
    fillMicChannels(1);
  }
}

function selectedMicIndex() {
  const v = $('lshow-auto-mic-dev')?.value;
  if (v === '' || v == null) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function selectedMicChannel() {
  const n = parseInt($('lshow-auto-mic-ch')?.value, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** @returns {number|null} 参考声道；无则 null */
function selectedRefChannel() {
  const v = $('lshow-auto-mic-ref')?.value;
  if (v === '' || v == null) return null;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  // 与干声相同则视为关闭
  if (n === selectedMicChannel()) return null;
  return n;
}

async function restartAsrMic(msg) {
  if (!(autoPlay && autoAsrMode)) return;
  try {
    await startAsrFollow();
    if (msg) toast(msg);
  } catch (err) {
    toast('切换输入失败：' + (err?.message || err));
  }
}

function paintAutoUi() {
  const btn = $('lshow-auto');
  const bar = $('lshow-auto-bar');
  btn?.classList.toggle('is-on', autoPlay);
  btn && (btn.textContent = autoPlay ? (autoAsrMode ? '语音跟词中' : '自动中') : '自动播放');
  if (!bar) return;
  bar.classList.toggle('hidden', !autoPlay || !song || !sheet.lines.length);
  bar.classList.toggle('is-armed', autoArmed);
  bar.classList.toggle('is-asr', autoAsrMode);
  const cur = $('lshow-auto-cur');
  const nxt = $('lshow-auto-next');
  const timer = $('lshow-auto-timer');
  const fill = $('lshow-auto-fill');
  if (cur) {
    cur.textContent = autoAsrText
      ? `${sheet.lines[active] || '—'}  · 听：${autoAsrText}`
      : (sheet.lines[active] || '—');
  }
  const pi = previewIndex();
  if (nxt) {
    if (pi >= 0) {
      nxt.textContent = autoArmed ? sheet.lines[pi] : `（将预告）${sheet.lines[pi]}`;
    } else if (autoPlay && sheet.lines.length) {
      nxt.textContent = `（再唱 → ${sheet.lines[0] || '开头'}）`;
    } else {
      nxt.textContent = '（已到末句）';
    }
  }
  paintMicUi();
  if (autoAsrMode) {
    if (timer) {
      if (autoMicState === 'wait' || autoMicState === 'open') timer.textContent = '等干声';
      else if (autoArmed) timer.textContent = '换气抢跑中';
      else if (autoMicState === 'hear') timer.textContent = '听唱匹配中';
      else timer.textContent = '干声已接入';
    }
    if (fill) {
      fill.style.width = autoArmed ? '85%'
        : autoMicState === 'hear' ? '55%'
          : autoMicState === 'live' ? '40%'
            : '18%';
    }
    return;
  }
  const elapsed = performance.now() - autoLineStartedAt;
  const pct = Math.max(0, Math.min(100, (elapsed / Math.max(1, autoDwellMs)) * 100));
  const left = Math.max(0, autoDwellMs - elapsed);
  if (timer) {
    timer.textContent = autoPlay
      ? (autoArmed ? `预告中 · ${(left / 1000).toFixed(1)}s` : `${(left / 1000).toFixed(1)}s`)
      : '—';
  }
  if (fill) fill.style.width = pct.toFixed(1) + '%';
}

function autoTick() {
  autoRaf = 0;
  // 语音跟词模式下不走时间轴推进
  if (!autoPlay || !song || !sheet.lines.length || autoAsrMode) {
    paintAutoUi();
    return;
  }
  if (performance.now() < autoManualHoldUntil) {
    paintAutoUi();
    autoRaf = requestAnimationFrame(autoTick);
    return;
  }
  const elapsed = performance.now() - autoLineStartedAt;
  const armAt = autoDwellMs * 0.72;
  if (!autoArmed && previewIndex() >= 0 && elapsed >= armAt) {
    autoArmed = true;
    paintLines();
    if (isLive()) push();
  }
  if (elapsed >= autoDwellMs) {
    const before = active;
    const wrapping =
      (isPage()
        ? (sheet.secOf[active] | 0) >= sheet.sections.length - 1
        : active + (style.step === 2 ? 2 : 1) >= sheet.lines.length);
    next({ fromAuto: true });
    if (active === before) {
      setAutoPlay(false);
      toast('自动播放已到末句');
    } else if (wrapping && active < before) {
      toast('再唱一遍：回到开头');
    }
  }
  paintAutoUi();
  if (autoPlay && !autoAsrMode) autoRaf = requestAnimationFrame(autoTick);
}

async function stopAsrFollow() {
  autoAsrMode = false;
  autoAsrText = '';
  autoMicState = 'off';
  autoMicName = '';
  autoRmsDb = null;
  autoMicPct = 0;
  try { await invoke('lyric_follow_stop'); } catch { /* ignore */ }
  if (autoFollowUnlisten) {
    try { autoFollowUnlisten(); } catch { /* ignore */ }
    autoFollowUnlisten = null;
  }
}

async function startAsrFollow() {
  await stopAsrFollow();
  await refreshMicDevices();
  let st = await invoke('lyric_asr_status');
  if (!st?.ready) {
    toast('首次使用需下载跟词模型（约 1GB+，混合实时+歌词纠偏）…');
    st = await invoke('lyric_asr_ensure_model');
  }
  if (!st?.ready) throw new Error(st?.message || '模型未就绪');

  const lines = sheet.lines.map((text, i) => {
    const sec = sheet.sections[sheet.secOf[i] | 0];
    return {
      text,
      songId: 1,
      isTitle: false,
      sectionType: sec?.type || '',
    };
  });
  autoMicState = 'open';
  autoFollowUnlisten = await listen('sp-lyric-follow', (e) => {
    const p = e?.payload || e;
    if (!p || !autoPlay) return;
    if (p.kind === 'input') {
      autoMicName = p.text || '';
      autoMicState = 'wait';
      paintAutoUi();
    }
    if (p.kind === 'level') {
      if (p.rmsDb != null) autoRmsDb = Number(p.rmsDb);
      if (p.percent != null) autoMicPct = Number(p.percent);
      if (autoAsrText) autoMicState = 'hear';
      else if (autoRmsDb != null && autoRmsDb > -48) autoMicState = 'live';
      else autoMicState = 'wait';
      paintMicUi();
      const timer = $('lshow-auto-timer');
      if (timer && autoAsrMode && !autoArmed) {
        timer.textContent = autoMicState === 'wait' ? '等干声'
          : autoMicState === 'live' ? '干声已接入'
            : '听唱匹配中';
      }
    }
    if (p.kind === 'partial' && p.text) {
      autoAsrText = p.text;
      autoMicState = 'hear';
      paintAutoUi();
    }
    if (p.kind === 'start') {
      if (autoMicState === 'open') autoMicState = 'wait';
      paintAutoUi();
    }
    if (p.kind === 'download' && p.message) {
      const timer = $('lshow-auto-timer');
      if (timer) timer.textContent = p.message;
      if (p.percent != null && $('lshow-auto-fill')) {
        $('lshow-auto-fill').style.width = Math.min(100, Number(p.percent)) + '%';
      }
    }
    if (p.kind === 'armed') {
      autoArmed = true;
      paintLines();
      paintAutoUi();
      if (isLive()) push();
    }
    if (p.kind === 'jump' && p.index != null) {
      const prev = active;
      autoArmed = false;
      go(p.index | 0, { fromAuto: true });
      // 末句循环回开头时给个轻提示
      if ((p.index | 0) < prev && /循环回开头|再唱一遍|回到/.test(p.message || '')) {
        toast(p.message || '再唱一遍：回到开头');
      }
      paintAutoUi();
    }
    if (p.kind === 'error') {
      toast('语音跟词：' + (p.message || '失败') + '，已改用时间轴');
      autoAsrMode = false;
      autoMicState = 'off';
      resetAutoClock();
      paintAutoUi();
      autoRaf = requestAnimationFrame(autoTick);
    }
    if (p.kind === 'stop') {
      autoAsrMode = false;
      autoMicState = 'off';
      paintAutoUi();
    }
  });

  const deviceIndex = selectedMicIndex();
  const channel = selectedMicChannel();
  const refChannel = selectedRefChannel();
  lsSet(LS_MIC, deviceIndex);
  lsSet(LS_MIC_CH, channel);
  lsSet(LS_MIC_REF, refChannel);
  await invoke('lyric_follow_start', {
    lines,
    startIndex: active,
    deviceIndex,
    channel,
    refChannel,
  });
  autoAsrMode = true;
  autoArmed = false;
  paintAutoUi();
}

async function setAutoPlay(on, { toastOn = true } = {}) {
  autoPlay = !!on;
  lsSet(LS_AUTO, autoPlay);
  stopAutoLoop();
  await stopAsrFollow();
  if (autoPlay) {
    if (!song || !sheet.lines.length) {
      autoPlay = false;
      lsSet(LS_AUTO, false);
      toast('请先选一首有歌词的歌');
      paintAutoUi();
      return;
    }
    resetAutoClock();
    if (!isLive()) push();
    try {
      await startAsrFollow();
      if (toastOn) toast('已开启语音跟词：看下方电平，有跳动才算干声接入');
    } catch (err) {
      autoAsrMode = false;
      autoMicState = 'off';
      autoRaf = requestAnimationFrame(autoTick);
      if (toastOn) toast('语音跟词暂不可用，已用时间轴：' + (err?.message || err));
    }
  } else if (toastOn) {
    toast('已关闭自动播放');
  }
  paintAutoUi();
  paintLines();
  if (isLive()) push();
}

function push(seq) {
  if (!song || !sheet.lines.length) {
    toast('这首歌还没有歌词');
    return false;
  }
  return pushToOutput(payload(), seq ?? claimOutputSeq()) !== false;
}

function go(i, { send = true, fromAuto = false } = {}) {
  if (!sheet.lines.length) return false;
  active = Math.min(Math.max(0, i), sheet.lines.length - 1);
  if (!fromAuto) {
    autoManualHoldUntil = performance.now() + 1800;
    if (autoAsrMode) invoke('lyric_follow_sync', { index: active }).catch(() => {});
  }
  resetAutoClock();
  paintLines();
  paintAutoUi();
  renderMini();
  if (send) push();
  return true;
}

function secAt(i) { return sheet.sections[sheet.secOf[i] | 0]; }

function next({ fromAuto = false } = {}) {
  if (!sheet.lines.length) return false;
  const opt = { fromAuto };
  const wrapToStart = () => {
    if (!fromAuto) return go(active, opt);
    // 自动播放到末句：循环回开头，方便整首再唱一遍
    if (isPage() && sheet.sections.length) return go(sheet.sections[0].start, opt);
    return go(0, opt);
  };
  if (isPage()) {
    const ns = sheet.sections[(sheet.secOf[active] | 0) + 1];
    return ns ? go(ns.start, opt) : wrapToStart();
  }
  if (style.step === 2) {
    const sec = secAt(active);
    const n = active + 2;
    if (sec && n < sec.end) return go(n, opt);
    const ns = sheet.sections[(sheet.secOf[active] | 0) + 1];
    return ns ? go(ns.start, opt) : wrapToStart();
  }
  if (active + 1 < sheet.lines.length) return go(active + 1, opt);
  return wrapToStart();
}

function prev() {
  if (!sheet.lines.length) return false;
  if (isPage()) {
    const ps = sheet.sections[(sheet.secOf[active] | 0) - 1];
    return ps ? go(ps.start) : go(secAt(active)?.start ?? 0);
  }
  if (style.step === 2) {
    const sec = secAt(active);
    if (sec && active - 2 >= sec.start) return go(active - 2);
    const ps = sheet.sections[(sheet.secOf[active] | 0) - 1];
    if (!ps) return go(sec ? sec.start : 0);
    return go(ps.start + Math.floor((ps.end - ps.start - 1) / 2) * 2);
  }
  return go(active - 1);
}

/** 跳到下一个该类型的段落（连按依次轮换），没有则提示 */
function jumpType(type) {
  const idx = sheet.sections.map((s, i) => (s.type === type ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) {
    const label = { chorus: '副歌', verse: '主歌', bridge: '桥段', pre: '预副歌', ending: '尾声' }[type] || type;
    toast(`这首歌没有标记「${label}」段落`);
    return false;
  }
  const cur = sheet.secOf[active] | 0;
  const target = idx.find((i) => i > cur) ?? idx[0];
  return go(sheet.sections[target].start);
}

function jumpSection(n) {
  const s = sheet.sections[n];
  return s ? go(s.start) : false;
}

// ---------- 快捷键 ----------

function letterJump(e) {
  const k = e.key.length === 1 ? e.key.toUpperCase() : '';
  const type = Object.keys(SEC_KEYS).find((t) => SEC_KEYS[t] === k);
  if (type) return jumpType(type), true;
  if (/^[1-9]$/.test(e.key)) return jumpSection(+e.key - 1), true;
  return false;
}

/** 歌词模块里的按键；处理了返回 true */
export function lyricsHandleKey(e) {
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  switch (e.key) {
    case 'ArrowDown': case 'ArrowRight': case 'PageDown': case ' ':
      next(); return true;
    case 'ArrowUp': case 'ArrowLeft': case 'PageUp':
      prev(); return true;
    case 'Home':
      go(0); return true;
    case 'Enter':
      push(); return true;
    default:
      return letterJump(e);
  }
}

/** 节目单里当前条是歌词时：↑/↓ 换行、字母键跳段落（←/→/Enter 仍是走台） */
export function lyricsProgramKey(e) {
  if (e.ctrlKey || e.altKey || e.metaKey || !isLive()) return false;
  if (e.key === 'ArrowDown') return next(), true;
  if (e.key === 'ArrowUp') return prev(), true;
  return letterJump(e);
}

/** 节目单播放歌词条目：优先用歌词库里的最新版本，否则用条目里的快照 */
export function playLyricsItem(item, seq) {
  const s = libSong(item.songId) || {
    id: item.songId || item.id, title: item.name || '', text: item.text || '', bg: item.bg,
  };
  loadSong(s, 0);
  return push(seq);
}

// ---------- 渲染 ----------

/** 「显示模式」下拉 ⇄ 样式里的 view / step */
const MODES = {
  line: { view: 'scroll', step: 1 },
  line2: { view: 'scroll', step: 2 },
  page: { view: 'page', step: 1 },
};
function modeOf(st) {
  if (st.view === 'page') return 'page';
  return st.step === 2 ? 'line2' : 'line';
}

/** 字体是否装在本机：与等宽兜底字体比字宽，宽度不同即说明命中了该字体 */
const fontCache = {};
function fontInstalled(name) {
  if (name in fontCache) return fontCache[name];
  const g = document.createElement('canvas').getContext('2d');
  const probe = '敬拜赞美永远歌唱主恩 Aa1';
  return (fontCache[name] = ['monospace', 'serif'].some((base) => {
    g.font = `40px ${base}`;
    const w0 = g.measureText(probe).width;
    g.font = `40px "${name}", ${base}`;
    return g.measureText(probe).width !== w0;
  }));
}

function renderList() {
  const box = $('lyrics-songs');
  if (!box) return;
  const q = filter.trim().toLowerCase();
  const list = songs.filter((s) => !q || (s.title || '').toLowerCase().includes(q) || (s.text || '').toLowerCase().includes(q));
  box.innerHTML = list.length
    ? list.map((s) => `
      <div class="file-item ${song && s.id === song.id ? 'active' : ''}" data-id="${s.id}">
        <span class="fi-icon">词</span>
        <span class="fi-name" title="${esc(s.title)}">${esc(s.title || '未命名')}</span>
      </div>`).join('')
    : `<div class="empty-tip">${songs.length ? '没有匹配的歌' : '点「＋新歌」或「导入」添加歌词'}</div>`;
}

function renderEditor() {
  const has = !!song;
  $('lshow-editor')?.classList.toggle('is-empty', !has);
  const t = $('lshow-title');
  if (t && document.activeElement !== t) t.value = song?.title || '';
  const ta = $('lshow-text');
  if (ta && document.activeElement !== ta) ta.value = song?.text || '';
  const bg = { ...defaultLshowBg(), ...(song?.bg || {}) };
  $('lshow-bg-mode').value = bg.mode;
  $('lshow-bg-color').value = bg.color;
  $('lshow-bg-anim').checked = bg.anim !== false;
  $('lshow-bg-speed').value = String(bg.speed);
  $('lshow-bg-dim').value = String(bg.dim);
  $('lshow-bg-file').textContent = bg.mode === 'image' ? (bg.image ? fileName(bg.image) : '未选择图片')
    : bg.mode === 'video' ? (bg.video ? fileName(bg.video) : '未选择视频') : '';
  document.querySelectorAll('#lshow-swatches .lshow-swatch').forEach((el) => {
    el.classList.toggle('active', el.dataset.color === bg.color);
  });
  $('lshow-mode').value = modeOf(style);
  $('lshow-scale').value = String(style.scale);
  $('lshow-font').value = style.font || 'fzchs';
  $('lshow-anim').value = style.anim || 'fade';
  $('lshow-font-tip')?.classList.toggle('hidden', (style.font || 'fzchs') !== 'fzchs' || fontInstalled('方正粗黑宋简体'));
  $('lshow-show-label').checked = style.showLabel !== false;
  $('lshow-show-title').checked = !!style.showTitle;
}

function renderLines() {
  const secBar = $('lshow-secs');
  const box = $('lshow-lines');
  if (!secBar || !box) return;
  if (!song) {
    secBar.innerHTML = '';
    box.innerHTML = '<div class="empty-tip">从左侧选一首歌，或点「＋新歌」粘贴歌词</div>';
    return;
  }
  secBar.innerHTML = sheet.sections.map((s, i) => {
    const key = i < 9 ? i + 1 : '';
    return `<button type="button" class="lshow-secbtn t-${s.type}" data-sec="${i}" title="快捷键 ${key}${SEC_KEYS[s.type] ? ' / ' + SEC_KEYS[s.type] : ''}">
      <span class="k mono">${key}</span>${esc(s.name)}</button>`;
  }).join('');
  if (!sheet.lines.length) {
    box.innerHTML = '<div class="empty-tip">在右侧「歌词」里输入或粘贴歌词</div>';
    return;
  }
  box.innerHTML = sheet.sections.map((s, si) => `
    <div class="lshow-sec t-${s.type}">
      <div class="lshow-sechead" data-sec="${si}">${esc(s.name)}</div>
      ${sheet.lines.slice(s.start, s.end).map((t, k) => `<div class="lshow-row" data-i="${s.start + k}">${esc(t)}</div>`).join('')}
    </div>`).join('');
  paintLines(true);
}

function paintLines(instant = false) {
  const box = $('lshow-lines');
  if (!box) return;
  const lit = new Set([active]);
  if (isPage()) {
    const sec = secAt(active);
    if (sec) for (let i = sec.start; i < sec.end; i++) lit.add(i);
  } else if (style.step === 2 && sheet.secOf[active + 1] === sheet.secOf[active] && active + 1 < sheet.lines.length) lit.add(active + 1);
  const pi = previewIndex();
  const showNext = autoPlay && autoArmed && pi >= 0 && !lit.has(pi);
  let first = null;
  box.querySelectorAll('.lshow-row').forEach((el) => {
    const i = +el.dataset.i;
    const on = lit.has(i);
    el.classList.toggle('active', on);
    el.classList.toggle('is-next', showNext && i === pi);
    if (on && !first) first = el;
  });
  const si = sheet.secOf[active] | 0;
  document.querySelectorAll('#lshow-secs .lshow-secbtn').forEach((el) => el.classList.toggle('active', +el.dataset.sec === si));
  $('lshow-live')?.classList.toggle('on', isLive());
  if (first) first.scrollIntoView({ block: 'center', behavior: instant ? 'auto' : 'smooth' });
}

/** 设置区的小预览（不论是否已投屏都能看到效果） */
function renderMini() {
  const el = $('lshow-mini');
  if (!el) return;
  if (!song || !sheet.lines.length) {
    el.innerHTML = '<div class="empty-tip">预览</div>';
    el.dataset.outKind = '';
    return;
  }
  renderOutput(el, payload(), { muted: true, videoPoster: true });
}

// ---------- 编辑 ----------

function touchSong(mut) {
  const s = song && libSong(song.id);
  if (!s) return;
  mut(s);
  s.updatedAt = Date.now();
  saveSongs();
}

let textTimer = 0;
function onTextInput() {
  clearTimeout(textTimer);
  textTimer = setTimeout(() => {
    if (!song) return;
    const wasLive = isLive();
    touchSong((s) => { s.text = $('lshow-text').value; });
    song = libSong(song.id) || song;
    const keep = active;
    sheet = parseLyricSheet(song.text);
    active = Math.min(keep, Math.max(0, sheet.lines.length - 1));
    renderLines();
    renderMini();
    if (wasLive && sheet.lines.length) push();
  }, 300);
}

function setBg(patch) {
  if (!song) return;
  const wasLive = isLive();
  const bg = { ...defaultLshowBg(), ...(song.bg || {}), ...patch };
  if (libSong(song.id)) touchSong((s) => { s.bg = bg; });
  song = libSong(song.id) || { ...song, bg };
  renderEditor();
  renderMini();
  if (wasLive) push();
}

function setStyle(patch) {
  const wasLive = isLive();
  style = { ...style, ...patch };
  saveStyle();
  paintLines();
  renderMini();
  if (wasLive) push();
}

function newSong(title = '新歌', text = '') {
  const s = { id: genId(), title, text, bg: lastBg(), updatedAt: Date.now() };
  songs.unshift(s);
  saveSongs();
  loadSong(s);
  return s;
}

/** 文本文件解码：UTF-8 优先，失败按 GBK（国内常见的 .txt / .lrc） */
async function readTextFile(path) {
  const buf = await (await fetch(convertFileSrc(path))).arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('gbk').decode(buf);
  }
}

/**
 * 批量加入歌词库（.pect 导入用），按原顺序排在最前；同名同词的歌复用已有的（更新背景）。
 * 返回对应的歌曲对象（顺序与传入一致）
 */
export function addLyricSongs(list) {
  const out = [];
  const fresh = [];
  for (const it of list) {
    let s = songs.find((x) => x.title === it.title && x.text === it.text);
    if (s) {
      s.bg = it.bg;
      s.updatedAt = Date.now();
    } else {
      s = { id: genId(), title: it.title, text: it.text, bg: it.bg, updatedAt: Date.now() };
      fresh.push(s);
    }
    out.push(s);
  }
  songs.unshift(...fresh);
  saveSongs();
  renderList();
  // 大屏正在投别的歌时不切换当前歌（否则下一次 ↑↓ 会把刚导入的歌推上大屏）
  if (out[0] && !isLive()) loadSong(out[0]);
  return out;
}

async function importFiles() {
  const files = await pickFiles([{ name: '歌词 / 诗歌演示', extensions: ['txt', 'lrc', 'pect'] }], '导入歌词');
  let n = 0;
  for (const p of files) {
    try {
      if (/\.pect$/i.test(p)) {
        const { songs: list } = await readPect(p);
        n += addLyricSongs(list).length;
        continue;
      }
      const text = await readTextFile(p);
      newSong(fileName(p).replace(/\.[^.]+$/, ''), text);
      n += 1;
    } catch (err) {
      toast(`读取失败：${fileName(p)}（${err}）`, 5000);
    }
  }
  if (n) toast(`已导入 ${n} 首歌词`);
}

/** 从背景图取主色（经 Rust 生成的缩略图，避免跨域画布受限） */
async function colorFromImage(path) {
  const url = await invoke('make_image_thumb', { path }).catch(() => null);
  if (!url) return null;
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = c.height = 48;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, 48, 48);
  const px = ctx.getImageData(0, 0, 48, 48).data;
  // 按色相分 24 桶，以饱和度×亮度适中加权，取最显著的色相
  const bins = new Array(24).fill(0);
  const sat = new Array(24).fill(0);
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (d < 0.08) continue;
    let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
    const l = (max + min) / 2;
    const s = d / (1 - Math.abs(2 * l - 1) || 1);
    const w = s * (1 - Math.abs(l - 0.5) * 1.6);
    const k = Math.floor(h / 15) % 24;
    bins[k] += w;
    sat[k] += s;
  }
  let best = 0;
  for (let k = 1; k < 24; k++) if (bins[k] > bins[best]) best = k;
  if (!bins[best]) return null;
  return hslToHex(best * 15 + 7, Math.min(80, (sat[best] / Math.max(1, bins[best])) * 60 + 30), 50);
}

function addToProgram() {
  if (!song) return toast('请先选择一首歌');
  const detail = {
    fn: (ev) => {
      ev.items.push({
        id: genId(), type: 'lyrics', songId: song.id, name: song.title || '歌词',
        text: song.text || '', bg: song.bg, path: '', note: '',
      });
    },
  };
  document.dispatchEvent(new CustomEvent('sp:program-mutate', { detail }));
  if (detail.ok) toast(`已把「${song.title}」加入当前节目单`);
}

// ---------- 初始化 ----------

export function initLyricsShow() {
  $('lshow-swatches').innerHTML = LSHOW_SWATCHES.map((w) => {
    const [c1, c2, c3] = paletteFromColor(w.color).colors;
    return `<button type="button" class="lshow-swatch" data-color="${w.color}" title="${w.name}"
      style="background:linear-gradient(135deg, ${c1}, ${c2}, ${c3})"><span>${w.name}</span></button>`;
  }).join('');

  $('lyrics-songs')?.addEventListener('click', (e) => {
    const it = e.target.closest('.file-item');
    const s = it && libSong(it.dataset.id);
    if (s) loadSong(s);
  });
  $('lyrics-search')?.addEventListener('input', (e) => { filter = e.target.value; renderList(); });
  $('lyrics-new')?.addEventListener('click', () => {
    newSong();
    $('lshow-title')?.select();
  });
  document.addEventListener('sp:import-lyrics', importFiles);

  $('lshow-title')?.addEventListener('input', (e) => {
    touchSong((s) => { s.title = e.target.value.trim() || '未命名'; });
    if (song) song = libSong(song.id) || song;
    renderList();
  });
  $('lshow-text')?.addEventListener('input', onTextInput);
  // 编辑框里按 Esc 退出编辑，回到键盘控制
  for (const id of ['lshow-text', 'lshow-title']) {
    $(id)?.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.target.blur(); } });
  }
  $('lshow-del')?.addEventListener('click', () => {
    if (!song || !libSong(song.id)) return;
    const removed = song;
    const at = songs.findIndex((s) => s.id === removed.id);
    songs = songs.filter((s) => s.id !== removed.id);
    saveSongs();
    song = null;
    loadSong(songs[0] || null);
    pushUndo(`删除歌词「${removed.title}」`, () => {
      if (libSong(removed.id)) return;
      songs.splice(Math.min(at, songs.length), 0, removed);
      saveSongs();
      loadSong(removed);
    });
  });
  $('lshow-push')?.addEventListener('click', () => push());
  $('lshow-auto')?.addEventListener('click', () => { setAutoPlay(!autoPlay); });
  $('lshow-auto-mic-dev')?.addEventListener('change', async () => {
    const v = $('lshow-auto-mic-dev')?.value;
    lsSet(LS_MIC, v === '' ? null : parseInt(v, 10));
    fillMicChannels($('lshow-auto-mic-dev')?.selectedOptions?.[0]?.dataset?.ch || 1);
    await restartAsrMic(`已切换干声设备 · ${micChLabel()}`);
  });
  $('lshow-auto-mic-ch')?.addEventListener('change', async () => {
    const ch = selectedMicChannel();
    lsSet(LS_MIC_CH, ch);
    await restartAsrMic(`已切换干声声道 · Ch${ch + 1}`);
  });
  $('lshow-auto-mic-ref')?.addEventListener('change', async () => {
    const ref = selectedRefChannel();
    lsSet(LS_MIC_REF, ref);
    await restartAsrMic(ref == null ? '已关闭参考声道' : `已切换参考声道 · Ch${ref + 1}`);
  });
  refreshMicDevices();
  $('lshow-to-program')?.addEventListener('click', addToProgram);

  $('lshow-secs')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sec]');
    if (b) jumpSection(+b.dataset.sec);
  });
  $('lshow-lines')?.addEventListener('click', (e) => {
    const row = e.target.closest('.lshow-row');
    if (row) return go(+row.dataset.i);
    const head = e.target.closest('.lshow-sechead');
    if (head) jumpSection(+head.dataset.sec);
  });

  // 背景
  $('lshow-bg-mode')?.addEventListener('change', (e) => setBg({ mode: e.target.value }));
  $('lshow-bg-color')?.addEventListener('input', (e) => setBg({ color: e.target.value }));
  $('lshow-swatches')?.addEventListener('click', (e) => {
    const b = e.target.closest('.lshow-swatch');
    if (b) setBg({ color: b.dataset.color });
  });
  $('lshow-bg-random')?.addEventListener('click', () => {
    setBg({ color: hslToHex(Math.random() * 360, 55 + Math.random() * 25, 48) });
  });
  $('lshow-bg-anim')?.addEventListener('change', (e) => setBg({ anim: e.target.checked }));
  $('lshow-bg-speed')?.addEventListener('change', (e) => setBg({ speed: +e.target.value }));
  $('lshow-bg-dim')?.addEventListener('change', (e) => setBg({ dim: +e.target.value }));
  $('lshow-bg-pick')?.addEventListener('click', async () => {
    if (!song) return;
    const mode = $('lshow-bg-mode').value === 'video' ? 'video' : 'image';
    const files = await pickFiles([{ name: mode === 'video' ? '视频' : '图片', extensions: mode === 'video' ? VIDEO_EXT : IMAGE_EXT }],
      mode === 'video' ? '选择背景视频' : '选择背景图片');
    if (files[0]) setBg({ mode, [mode]: files[0] });
  });
  $('lshow-bg-from-img')?.addEventListener('click', async () => {
    const img = song?.bg?.image;
    if (!img) return toast('请先选择一张背景图片');
    const c = await colorFromImage(img).catch(() => null);
    if (c) { setBg({ color: c }); toast('已按图片主色生成渐变'); } else toast('这张图片取不到明显的主色');
  });

  // 显示
  $('lshow-mode')?.addEventListener('change', (e) => {
    setStyle(MODES[e.target.value] || MODES.line);
    const sec = secAt(active);
    if (!sec) return;
    // 一段一页：回到段首；两句两句：对齐到「段首 + 偶数行」
    if (isPage()) go(sec.start, { send: isLive() });
    else if (style.step === 2) go(sec.start + Math.floor((active - sec.start) / 2) * 2, { send: isLive() });
  });
  $('lshow-scale')?.addEventListener('change', (e) => setStyle({ scale: +e.target.value }));
  $('lshow-anim')?.addEventListener('change', (e) => setStyle({ anim: e.target.value }));
  $('lshow-font')?.addEventListener('change', (e) => { setStyle({ font: e.target.value }); renderEditor(); });
  $('lshow-show-label')?.addEventListener('change', (e) => setStyle({ showLabel: e.target.checked }));
  $('lshow-show-title')?.addEventListener('change', (e) => setStyle({ showTitle: e.target.checked }));

  // 改完设置立即交还焦点，键盘上下继续控制歌词
  $('lshow-editor')?.addEventListener('change', (e) => {
    if (e.target.matches('select, input[type=range], input[type=checkbox], input[type=color]')) e.target.blur();
  });

  // 输出被别的内容替换后刷新「投屏中」状态
  document.addEventListener('sp:module-change', (e) => {
    if (e.detail === 'lyrics') {
      paintLines(true);
      renderMini();
      paintAutoUi();
    }
  });

  loadSong(libSong(curId) || songs[0] || null);
  // 冷启动不要自动抢麦 / 下 ASR 模型，否则顶栏按钮会像「按不动」
  if (autoPlay && song && sheet.lines.length) {
    autoAsrMode = false;
    resetAutoClock();
    autoRaf = requestAnimationFrame(autoTick);
  }
  paintAutoUi();
}
