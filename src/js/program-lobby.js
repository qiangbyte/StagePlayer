// 节目单 · 大厅页：开场前倒计时画面、表单、到点自动开演

import { fileName, toast, convertFileSrc, fmtTimeLong } from './util.js';
import { pushToOutput, claimOutputSeq, getCurrentOutput, isOutputFrozen } from './output-main.js';
import { todayStr } from './program-cue.js';

const $ = (id) => document.getElementById(id);

// 由 program.js 注入的宿主回调（避免与 program.js 循环引用）
let activate, curEvent, save;

export function bindLobbyHost(h) {
  ({ activate, curEvent, save } = h);
}

let lobbyAutoArmed = false;
let lobbyAutoKey = null;

function armLobbyAutoStart(ev, L) {
  const startAt = lobbyStartAtMs(L);
  if (!L?.autoStart || !startAt || !ev) {
    lobbyAutoArmed = false;
    lobbyAutoKey = null;
    return;
  }
  lobbyAutoKey = `${ev.id}:${startAt}`;
  lobbyAutoArmed = true;
}

export function tickLobbyAutoStart() {
  if (!lobbyAutoArmed || !lobbyAutoKey) return;
  const ev = curEvent();
  if (!ev) return;
  const L = ensureLobby(ev);
  if (!L.autoStart) {
    lobbyAutoArmed = false;
    return;
  }
  const startAt = lobbyStartAtMs(L);
  if (`${ev.id}:${startAt}` !== lobbyAutoKey) return;
  if (Date.now() < startAt) return;
  // 仅在扩展屏仍显示开场页时自动开播（避免误触）
  if (getCurrentOutput()?.kind !== 'lobby') {
    lobbyAutoArmed = false;
    return;
  }
  // 冻结时保留 armed，解冻后下一 tick 再开播（与定时 cue 一致）
  if (isOutputFrozen()) return;
  lobbyAutoArmed = false;
  if (!ev.items?.length) {
    toast('到点了，但节目单还是空的');
    return;
  }
  toast('到点 · 自动播放第一条');
  activate(ev.items[0]);
}

export function defaultLobby(name) {
  return {
    date: todayStr(),
    time: '09:30',
    title: name || '本场演出',
    subtitle: '敬请入座 · 即将开始',
    note: '',
    kicker: 'STAGE',
    bg: 'radial-gradient(ellipse at 50% 28%, #2a1f3d 0%, #0c0c12 62%)',
    bgImage: '',
    accent: '#e8c56a',
    autoStart: true,
    countingText: '距离开始还有',
    startedText: '演出开始',
  };
}

export function ensureLobby(ev) {
  if (!ev) return defaultLobby('');
  if (!ev.lobby) ev.lobby = defaultLobby(ev.name);
  else ev.lobby = { ...defaultLobby(ev.name), ...ev.lobby };
  return ev.lobby;
}

function lobbyStartAtMs(lobby) {
  if (!lobby?.date || !lobby?.time) return 0;
  const [y, m, d] = lobby.date.split('-').map(Number);
  const parts = lobby.time.split(':').map(Number);
  const hh = parts[0] || 0;
  const mm = parts[1] || 0;
  if (!y || !m || !d) return 0;
  return new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
}

export function fillLobbyForm() {
  const ev = curEvent();
  if (!ev) return;
  const L = ensureLobby(ev);
  const set = (id, v) => { const el = $(id); if (el) el.value = v ?? ''; };
  set('pg-lobby-date', L.date || todayStr());
  set('pg-lobby-time', L.time || '09:30');
  set('pg-lobby-title', L.title || '');
  set('pg-lobby-sub', L.subtitle || '');
  set('pg-lobby-note', L.note || '');
  set('pg-lobby-kicker', L.kicker || '');
  set('pg-lobby-accent', L.accent || '#e8c56a');
  set('pg-lobby-bg', L.bg || '');
  set('pg-lobby-bgimg', L.bgImage ? fileName(L.bgImage) : '');
  const auto = $('pg-lobby-autostart');
  if (auto) auto.checked = L.autoStart !== false;
  syncLobbyRemain();
}

export function readLobbyForm(doSave = false, refreshOutput = true) {
  const ev = curEvent();
  if (!ev) return null;
  const L = ensureLobby(ev);
  const val = (id) => $(id)?.value?.trim() ?? '';
  L.date = val('pg-lobby-date') || todayStr();
  L.time = val('pg-lobby-time') || '09:30';
  L.title = val('pg-lobby-title') || ev.name || '本场演出';
  L.subtitle = val('pg-lobby-sub');
  L.note = val('pg-lobby-note');
  L.kicker = val('pg-lobby-kicker');
  L.accent = val('pg-lobby-accent') || '#e8c56a';
  L.bg = val('pg-lobby-bg') || defaultLobby(ev.name).bg;
  // bgImage 由选图按钮写入，此处保留
  L.autoStart = !!$('pg-lobby-autostart')?.checked;
  ev.lobby = L;
  if (doSave) save();
  syncLobbyRemain();
  // 若扩展屏正显示开场页，同步刷新文案，并按最新时间重武装自动开播
  if (refreshOutput && getCurrentOutput()?.kind === 'lobby') {
    pushToOutput(lobbyPayload(L, ev.name));
    armLobbyAutoStart(ev, L);
  }
  return L;
}

export function syncLobbyRemain() {
  const el = $('pg-lobby-remain');
  if (!el) return;
  const ev = curEvent();
  if (!ev) {
    el.textContent = '未选择演出';
    return;
  }
  const L = ensureLobby(ev);
  // 表单打开时优先用表单里的时间预览
  const date = $('pg-lobby-date')?.value || L.date;
  const time = $('pg-lobby-time')?.value || L.time;
  const startAt = lobbyStartAtMs({ date, time });
  if (!startAt) {
    el.textContent = '请设置开始日期与时间';
    return;
  }
  const remain = Math.floor((startAt - Date.now()) / 1000);
  if (remain <= 0) {
    el.textContent = `开始时间 ${date} ${time} · 已到点`;
    el.classList.add('is-due');
  } else {
    el.textContent = `开始时间 ${date} ${time} · 倒计时 ${fmtTimeLong(remain)}`;
    el.classList.remove('is-due');
  }
}

function lobbyPayload(L, evName) {
  const startAt = lobbyStartAtMs(L);
  const startLabel = L.date && L.time ? `开始时间 ${L.date} ${L.time}` : '';
  return {
    kind: 'lobby',
    startAt,
    startLabel,
    title: L.title || evName || '本场演出',
    subtitle: L.subtitle || '',
    note: L.note || '',
    kicker: L.kicker || '',
    bg: L.bg || defaultLobby('').bg,
    bgImage: L.bgImage ? convertFileSrc(L.bgImage) : '',
    accent: L.accent || '#e8c56a',
    countingText: L.countingText || '距离开始还有',
    startedText: L.startedText || '演出开始',
  };
}

/** 推送开场倒计时页到扩展屏；openOutput=true 时自动打开输出窗 */
export function pushLobbyPage(openOutput = true) {
  const ev = curEvent();
  if (!ev) {
    toast('请先选择一场演出');
    return false;
  }
  const L = readLobbyForm(true, false) || ensureLobby(ev);
  if (!lobbyStartAtMs(L)) {
    toast('请先设置开始日期和时间');
    return false;
  }
  pushToOutput(lobbyPayload(L, ev.name), claimOutputSeq());
  armLobbyAutoStart(ev, L);
  if (openOutput) {
    document.dispatchEvent(new CustomEvent('sp:open-output', { detail: { fullscreen: true } }));
  }
  const tip = L.autoStart
    ? (ev.items?.length ? '已推送开场页 · 到点将自动播第一条' : '已推送开场页 · 到点自动播需先添加节目')
    : '已推送开场倒计时到扩展屏';
  toast(tip);
  return true;
}
