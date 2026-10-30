// 声压：A/C/Z 并行、RTA 频谱、曲线快照

import { invoke, listen, lsGet, lsSet, toast } from './util.js';

const $ = (id) => document.getElementById(id);
const CFG_KEY = 'sp.spl.config';
const SNAP_KEY = 'sp.spl.snapshots';
const SNAP_COLORS = ['#6ec8ff', '#e8c56a', '#9ad67a', '#e07a9a', '#b39ddb', '#80cbc4'];

let running = false;
let unlisten = null;
let lastTick = null;
let snapshots = [];
let hiddenSnapIds = new Set();

function defaultCfg() {
  return { deviceIndex: null, channel: 0, response: 'Fast', calOffset: 114 };
}

function loadCfg() {
  return { ...defaultCfg(), ...(lsGet(CFG_KEY, {}) || {}) };
}

function saveCfg(partial) {
  const next = { ...loadCfg(), ...partial };
  lsSet(CFG_KEY, next);
  return next;
}

function loadSnaps() {
  snapshots = Array.isArray(lsGet(SNAP_KEY, [])) ? lsGet(SNAP_KEY, []) : [];
}

function persistSnaps() {
  lsSet(SNAP_KEY, snapshots);
}

function fmt(n) {
  if (n == null || Number.isNaN(n)) return '--.-';
  return (Math.round(n * 10) / 10).toFixed(1);
}

function respLetter(r) {
  return (r || 'Fast').toLowerCase().startsWith('s') ? 'S' : 'F';
}

function paintBar(spl) {
  const canvas = $('spl-bar');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fillRect(0, 0, w, h);
  const min = 40;
  const max = 120;
  const t = Math.max(0, Math.min(1, ((spl ?? min) - min) / (max - min)));
  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, '#3d9a6a');
  grad.addColorStop(0.65, '#d4a017');
  grad.addColorStop(1, '#d64545');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, Math.round(w * t), h);
}

function xOfFreq(f, w, padL, padR) {
  const fMin = 20;
  const fMax = 20000;
  const t = Math.log(Math.max(f, fMin) / fMin) / Math.log(fMax / fMin);
  return padL + t * (w - padL - padR);
}

function yOfDb(db, h, padT, padB, dbMin, dbMax) {
  const t = (db - dbMin) / (dbMax - dbMin);
  return padT + (1 - Math.max(0, Math.min(1, t))) * (h - padT - padB);
}

/** 电平 → 蓝-青-绿-黄-红 */
function levelColor(db, dbMin, dbMax, alpha = 1) {
  const t = Math.max(0, Math.min(1, (db - dbMin) / (dbMax - dbMin)));
  const hue = 220 - t * 220; // 220蓝 → 0红
  const light = 42 + t * 18;
  return `hsla(${hue}, 92%, ${light}%, ${alpha})`;
}

function syncCurveCanvasSize() {
  const canvas = $('spl-curve');
  const wrap = canvas?.parentElement;
  if (!canvas || !wrap) return false;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = Math.max(320, wrap.clientWidth || 900);
  const cssH = Math.max(280, wrap.clientHeight || 420);
  const tw = Math.round(cssW * dpr);
  const th = Math.round(cssH * dpr);
  if (canvas.width !== tw || canvas.height !== th) {
    canvas.width = tw;
    canvas.height = th;
    return true;
  }
  return false;
}

function paintCurve(live) {
  const canvas = $('spl-curve');
  if (!canvas) return;
  syncCurveCanvasSize();
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const padL = 48 * dpr;
  const padR = 14 * dpr;
  const padT = 16 * dpr;
  const padB = 32 * dpr;
  const dbMin = 20;
  const dbMax = 110;
  const offset = parseFloat($('spl-offset')?.value) || 0;
  const baseY = h - padB;

  ctx.clearRect(0, 0, w, h);
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#14141a');
  bg.addColorStop(1, '#0a0a0e');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // 网格
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.fillStyle = 'rgba(255,255,255,0.38)';
  ctx.font = `${Math.round(11 * dpr)}px ui-monospace, Consolas, monospace`;
  ctx.lineWidth = Math.max(1, dpr * 0.6);
  [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].forEach((f) => {
    const x = xOfFreq(f, w, padL, padR);
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, baseY);
    ctx.stroke();
    const label = f >= 1000 ? `${f / 1000}k` : String(f);
    ctx.fillText(label, x - 10 * dpr, h - 10 * dpr);
  });
  for (let db = 30; db <= 100; db += 10) {
    const y = yOfDb(db, h, padT, padB, dbMin, dbMax);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    ctx.fillText(String(db), 8 * dpr, y + 3 * dpr);
  }

  const drawBars = (freqs, spectrum) => {
    if (!freqs?.length || !spectrum?.length) return;
    const n = Math.min(freqs.length, spectrum.length);
    const plotW = w - padL - padR;
    const gap = Math.max(1, (plotW / n) * 0.12);
    for (let i = 0; i < n; i++) {
      const db = spectrum[i] + offset;
      const x0 = i === 0 ? padL : (xOfFreq(freqs[i - 1], w, padL, padR) + xOfFreq(freqs[i], w, padL, padR)) / 2;
      const x1 = i === n - 1
        ? w - padR
        : (xOfFreq(freqs[i], w, padL, padR) + xOfFreq(freqs[i + 1], w, padL, padR)) / 2;
      const bw = Math.max(1.5 * dpr, x1 - x0 - gap);
      const y = yOfDb(db, h, padT, padB, dbMin, dbMax);
      const barH = Math.max(0, baseY - y);
      const grad = ctx.createLinearGradient(0, y, 0, baseY);
      grad.addColorStop(0, levelColor(db, dbMin, dbMax, 0.95));
      grad.addColorStop(0.55, levelColor(db - 8, dbMin, dbMax, 0.75));
      grad.addColorStop(1, levelColor(db - 25, dbMin, dbMax, 0.15));
      ctx.fillStyle = grad;
      ctx.fillRect(x0 + gap / 2, y, bw, barH);
      // 顶端亮条
      ctx.fillStyle = levelColor(db, dbMin, dbMax, 1);
      ctx.fillRect(x0 + gap / 2, y, bw, Math.max(2 * dpr, 2));
    }
  };

  const drawSeries = (freqs, spectrum, color, width) => {
    if (!freqs?.length || !spectrum?.length) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    let started = false;
    const n = Math.min(freqs.length, spectrum.length);
    for (let i = 0; i < n; i++) {
      const db = spectrum[i] + offset;
      const x = xOfFreq(freqs[i], w, padL, padR);
      const y = yOfDb(db, h, padT, padB, dbMin, dbMax);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };

  // 实时：彩色柱状 RTA
  if (live?.freqs?.length && live?.spectrum?.length) {
    drawBars(live.freqs, live.spectrum);
    drawSeries(live.freqs, live.spectrum, 'rgba(255,255,255,0.55)', 1.4 * dpr);
  }

  // 快照：彩色轮廓叠画
  snapshots.forEach((s, i) => {
    if (hiddenSnapIds.has(s.id)) return;
    drawSeries(s.freqs, s.spectrum, SNAP_COLORS[i % SNAP_COLORS.length], 2 * dpr);
  });
}

function renderSnapList() {
  const box = $('spl-snap-list');
  if (!box) return;
  if (!snapshots.length) {
    box.innerHTML = '<div class="spl-snap-empty">暂无快照。测量中点「保存快照」。</div>';
    return;
  }
  box.innerHTML = snapshots
    .map((s, i) => {
      const color = SNAP_COLORS[i % SNAP_COLORS.length];
      const on = !hiddenSnapIds.has(s.id);
      return `<div class="spl-snap-item${on ? '' : ' off'}" data-id="${s.id}">
        <button type="button" class="spl-snap-swatch" data-act="toggle" style="background:${color}" title="显示/隐藏"></button>
        <div class="spl-snap-meta">
          <div class="spl-snap-name">${escapeHtml(s.name)}</div>
          <div class="spl-snap-sub mono">A ${fmt(s.splA)} · C ${fmt(s.splC)} · Z ${fmt(s.splZ)}</div>
        </div>
        <button type="button" class="mini-btn danger spl-snap-del" data-act="del" title="删除">删</button>
      </div>`;
    })
    .join('');
}

function applyTick(t) {
  lastTick = t;
  // 面板隐藏时只记最新数据（快照/对比仍可用），不重绘
  if (!$('panel-spl')?.classList.contains('active')) return;
  const letter = respLetter(t.response);
  $('spl-a').textContent = fmt(t.splA);
  $('spl-c').textContent = fmt(t.splC);
  $('spl-z').textContent = fmt(t.splZ);
  $('spl-tag-a').textContent = `LA${letter}`;
  $('spl-tag-c').textContent = `LC${letter}`;
  $('spl-tag-z').textContent = `LZ${letter}`;
  $('spl-peak').textContent = fmt(t.peakSpl);
  $('spl-dbfs').textContent = fmt(t.dbfsZ);
  $('spl-overload').classList.toggle('hidden', !t.overload);
  paintBar(t.splA);
  paintCurve(t);
  if (running) {
    $('spl-status').textContent = `测量中 · ${t.sampleRate || 48000} Hz · RTA`;
  }
}

async function pushParams() {
  const response = $('spl-response').value;
  const calOffset = parseFloat($('spl-offset').value) || 0;
  saveCfg({ response, calOffset });
  try {
    await invoke('spl_set_params', { response, calOffset });
  } catch (e) {
    console.warn(e);
  }
  const letter = respLetter(response);
  $('spl-tag-a').textContent = `LA${letter}`;
  $('spl-tag-c').textContent = `LC${letter}`;
  $('spl-tag-z').textContent = `LZ${letter}`;
  if (lastTick) paintCurve(lastTick);
}

async function refreshDevices() {
  const sel = $('spl-device');
  const chSel = $('spl-channel');
  const cfg = loadCfg();
  try {
    const list = await invoke('spl_list_inputs');
    if (!list?.length) {
      sel.innerHTML = '<option value="">未找到输入设备</option>';
      toast('未找到麦克风/声卡输入');
      return;
    }
    sel.innerHTML = list
      .map(
        (d) =>
          `<option value="${d.index}" data-ch="${d.maxChannels || d.max_channels || 1}">${escapeHtml(d.name)}${d.isDefault || d.is_default ? '（默认）' : ''}</option>`
      )
      .join('');
    if (cfg.deviceIndex != null && list.some((d) => d.index === cfg.deviceIndex)) {
      sel.value = String(cfg.deviceIndex);
    } else {
      const def = list.find((d) => d.isDefault || d.is_default);
      sel.value = String(def ? def.index : list[0].index);
    }
    fillChannels();
    if (cfg.channel != null) chSel.value = String(cfg.channel);
  } catch (e) {
    sel.innerHTML = '<option value="">读取失败</option>';
    toast('读取输入设备失败：' + (e?.message || e), 6000);
  }
}

function fillChannels() {
  const sel = $('spl-device');
  const chSel = $('spl-channel');
  const opt = sel.selectedOptions[0];
  const n = Math.max(1, parseInt(opt?.dataset?.ch || '1', 10) || 1);
  chSel.innerHTML = Array.from({ length: n }, (_, i) => `<option value="${i}">${i + 1}</option>`).join('');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}

async function startMeasure() {
  const deviceIndex = $('spl-device').value === '' ? null : parseInt($('spl-device').value, 10);
  const channel = parseInt($('spl-channel').value, 10) || 0;
  saveCfg({ deviceIndex, channel });
  try {
    await invoke('audio_pause');
  } catch {
    /* ignore */
  }
  document.dispatchEvent(new CustomEvent('sp:audio-force-pause'));
  await pushParams();
  try {
    await invoke('spl_start', {
      deviceIndex: Number.isFinite(deviceIndex) ? deviceIndex : null,
      channel,
    });
  } catch (e) {
    toast('无法开始测量：' + (e?.message || e), 5000);
    return;
  }
  if (!unlisten) {
    unlisten = await listen('spl:tick', (ev) => applyTick(ev.payload));
  }
  running = true;
  $('spl-toggle').textContent = '停止测量';
  $('spl-toggle').classList.add('danger');
  $('spl-status').textContent = '测量中…';
  toast('已开始测量（音乐已暂停）');
}

async function stopMeasure() {
  try {
    await invoke('spl_stop');
  } catch {
    /* ignore */
  }
  running = false;
  $('spl-toggle').textContent = '开始测量';
  $('spl-toggle').classList.remove('danger');
  $('spl-status').textContent = '已停止';
  $('spl-overload').classList.add('hidden');
}

async function toggleMeasure() {
  if (running) await stopMeasure();
  else await startMeasure();
}

function calibrate94() {
  if (!lastTick) {
    toast('请先开始测量，并等待读数稳定');
    return;
  }
  const offset = 94 - lastTick.dbfsZ;
  $('spl-offset').value = (Math.round(offset * 10) / 10).toFixed(1);
  pushParams();
  toast(`已按 Z 校准：calOffset = ${$('spl-offset').value}`, 5000);
}

function saveSnapshot() {
  if (!lastTick?.freqs?.length || !lastTick?.spectrum?.length) {
    toast('请先开始测量，等曲线出现后再保存');
    return;
  }
  const n = snapshots.length + 1;
  const name = `快照 ${n} · ${new Date().toLocaleTimeString()}`;
  snapshots.unshift({
    id: `s_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name,
    at: Date.now(),
    freqs: [...lastTick.freqs],
    spectrum: [...lastTick.spectrum],
    splA: lastTick.splA,
    splC: lastTick.splC,
    splZ: lastTick.splZ,
    calOffset: parseFloat($('spl-offset').value) || 0,
  });
  if (snapshots.length > 12) snapshots.length = 12;
  persistSnaps();
  renderSnapList();
  paintCurve(lastTick);
  toast('已保存曲线快照');
}

function clearSnapshots() {
  if (!snapshots.length) return;
  if (!window.confirm('清空全部曲线快照？')) return;
  snapshots = [];
  hiddenSnapIds.clear();
  persistSnaps();
  renderSnapList();
  paintCurve(lastTick);
}

function restoreUi() {
  const cfg = loadCfg();
  $('spl-response').value = cfg.response || 'Fast';
  $('spl-offset').value = cfg.calOffset ?? 114;
  const letter = respLetter(cfg.response);
  $('spl-tag-a').textContent = `LA${letter}`;
  $('spl-tag-c').textContent = `LC${letter}`;
  $('spl-tag-z').textContent = `LZ${letter}`;
  loadSnaps();
  renderSnapList();
  paintBar(null);
  paintCurve(null);
}

export function initSpl() {
  restoreUi();
  refreshDevices();

  const curveWrap = $('spl-curve')?.parentElement;
  if (curveWrap && typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => paintCurve(lastTick));
    ro.observe(curveWrap);
  }
  window.addEventListener('resize', () => paintCurve(lastTick));

  $('spl-refresh')?.addEventListener('click', refreshDevices);
  $('spl-device')?.addEventListener('change', () => {
    fillChannels();
    saveCfg({ deviceIndex: parseInt($('spl-device').value, 10) });
  });
  $('spl-channel')?.addEventListener('change', () => {
    saveCfg({ channel: parseInt($('spl-channel').value, 10) || 0 });
  });
  $('spl-response')?.addEventListener('change', pushParams);
  $('spl-offset')?.addEventListener('change', pushParams);
  $('spl-toggle')?.addEventListener('click', () => toggleMeasure());
  $('spl-cal-94')?.addEventListener('click', calibrate94);
  $('spl-snap-save')?.addEventListener('click', saveSnapshot);
  $('spl-snap-clear')?.addEventListener('click', clearSnapshots);

  $('spl-snap-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    const item = e.target.closest('.spl-snap-item');
    if (!btn || !item) return;
    const id = item.dataset.id;
    if (btn.dataset.act === 'toggle') {
      if (hiddenSnapIds.has(id)) hiddenSnapIds.delete(id);
      else hiddenSnapIds.add(id);
      renderSnapList();
      paintCurve(lastTick);
    } else if (btn.dataset.act === 'del') {
      snapshots = snapshots.filter((s) => s.id !== id);
      hiddenSnapIds.delete(id);
      persistSnaps();
      renderSnapList();
      paintCurve(lastTick);
    }
  });

  document.addEventListener('sp:module-change', (e) => {
    if (e.detail !== 'spl' && running) stopMeasure();
  });
}

export function isSplRunning() {
  return running;
}
