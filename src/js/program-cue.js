// 节目单 · 定时开播：设定开播时刻、列表倒计时、到点自动播放

import { toast } from './util.js';
import { isOutputFrozen } from './output-main.js';

// 由 program.js 注入的宿主回调（避免与 program.js 循环引用）
let activate, curEvent, renderItems, save;

export function bindCueHost(h) {
  ({ activate, curEvent, renderItems, save } = h);
}

let cueFiring = false;

function pad2(n) {
  return String(n).padStart(2, '0');
}

export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function tomorrowStr() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 节目开播时间点 → 毫秒时间戳 */
function cueStartAtMs(item) {
  if (!item?.cueTime) return 0;
  const date = item.cueDate || todayStr();
  const [y, m, d] = date.split('-').map(Number);
  const parts = String(item.cueTime).split(':').map(Number);
  if (!y || !m || !d) return 0;
  return new Date(y, m - 1, d, parts[0] || 0, parts[1] || 0, parts[2] || 0, 0).getTime();
}

function fmtCueClock(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`;
  return `${m}:${pad2(s)}`;
}

/** 设定本条节目的开播时刻（到点自动播放 + 倒计时） */
export function editItemCue(item) {
  if (!item) return;
  const display = item.cueTime
    ? (item.cueTime.length >= 8 && item.cueTime.endsWith(':00') ? item.cueTime.slice(0, 5) : item.cueTime)
    : '';
  const v = window.prompt(
    '开播时间（今天 HH:mm，如 09:35）\n到点后自动播放本条；留空清除定时',
    display,
  );
  if (v === null) return;
  const t = v.trim();
  if (!t) {
    item.cueTime = '';
    item.cueDate = '';
    item.cueFired = false;
    save({ soft: true });
    renderItems({ soft: true });
    toast('已清除开播定时');
    return;
  }
  const m = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) {
    toast('格式应为 09:35 或 09:35:00');
    return;
  }
  const hh = +m[1];
  const mm = +m[2];
  const ss = m[3] != null ? +m[3] : 0;
  if (hh > 23 || mm > 59 || ss > 59) {
    toast('时间无效');
    return;
  }
  item.cueTime = `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}`;
  item.cueDate = todayStr();
  item.cueFired = false;
  let at = cueStartAtMs(item);
  if (at <= Date.now()) {
    item.cueDate = tomorrowStr();
    at = cueStartAtMs(item);
    toast(`该时刻已过，已排到明天 ${item.cueTime.slice(0, 5)} 开播`);
  } else {
    toast(`已设定 ${item.cueTime.slice(0, 5)} 开播，将自动倒计时`);
  }
  save({ soft: true });
  renderItems({ soft: true });
  syncCueCountdowns();
}

export function syncCueCountdowns() {
  const ev = curEvent();
  const nodes = document.querySelectorAll('.pg-cue');
  if (!nodes.length) return;
  const byId = new Map((ev?.items || []).map((i) => [i.id, i]));
  nodes.forEach((el) => {
    const id = el.closest('.pg-item')?.dataset.id;
    const item = byId.get(id);
    if (!item?.cueTime) {
      if (!el.classList.contains('hidden')) el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');
    const at = cueStartAtMs(item);
    const remain = Math.floor((at - Date.now()) / 1000);
    const atEl = el.querySelector('.pg-cue-at');
    const cdEl = el.querySelector('.pg-cue-cd');
    const label = item.cueTime.slice(0, 5);
    if (atEl && atEl.textContent !== `开播 ${label}`) atEl.textContent = `开播 ${label}`;
    if (item.cueFired || remain <= 0) {
      el.classList.remove('is-live', 'is-urgent');
      el.classList.add('is-due');
      const dueText = item.cueFired ? '已开播' : '到点';
      if (cdEl && cdEl.textContent !== dueText) cdEl.textContent = dueText;
      el.dataset.sec = '';
      return;
    }
    el.classList.add('is-live');
    el.classList.remove('is-due');
    el.classList.toggle('is-urgent', remain <= 60);
    // 仅秒数变化时写 DOM，避免 250ms 空转
    if (cdEl && el.dataset.sec !== String(remain)) {
      el.dataset.sec = String(remain);
      cdEl.textContent = fmtCueClock(remain);
    }
  });
}

export async function tickCueAutoPlay() {
  if (cueFiring) return;
  const ev = curEvent();
  if (!ev?.items?.length) return;
  const now = Date.now();
  for (const it of ev.items) {
    if (!it.cueTime || it.cueFired) continue;
    if (it._cueRetryAt && now < it._cueRetryAt) continue;
    const at = cueStartAtMs(it);
    if (!at || now < at) continue;
    // 冻结时不抢标「已开播」，解冻后重试，避免扩展屏没换页
    if (isOutputFrozen()) {
      it._cueRetryAt = now + 2000;
      if (!it._cueFrozenTip) {
        it._cueFrozenTip = true;
        toast('输出已冻结：定时到点但扩展屏未换页，解冻后将自动重试', 5000);
      }
      continue;
    }
    cueFiring = true;
    toast(`⏰ 定时开播：${it.name}`);
    try {
      const ok = await activate(it);
      if (ok && !isOutputFrozen()) {
        it.cueFired = true;
        delete it._cueRetryAt;
        delete it._cueFrozenTip;
        save({ soft: true });
        syncCueCountdowns();
      } else if (ok && isOutputFrozen()) {
        it._cueRetryAt = now + 2000;
        toast('输出冻结中，扩展屏未更新，解冻后重试', 4000);
      } else {
        it._cueRetryAt = now + 3000;
        toast(`定时开播失败，将稍后重试：${it.name}`, 4000);
      }
    } finally {
      cueFiring = false;
    }
    break;
  }
}
