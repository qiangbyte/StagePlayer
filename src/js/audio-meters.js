// 音频监视器：28 段频谱（Goertzel）+ M32 风格 VU 表

const $ = (id) => document.getElementById(id);

const BANDS = 28;
const FFT_N = 1024;
let specData = new Float32Array(BANDS);
let specPeak = new Float32Array(BANDS);
// analyze() 每帧复用，避免 60fps 分配
const fftSlice = new Float32Array(FFT_N);
const bandRaw = new Float32Array(BANDS);
let bandColors = [];
let vuLevel = 0;
let vuRmsDb = -120;
let vuPeakDb = -120;
let vuPeakHoldDb = -120;
let vuPeakHoldAt = 0;
let vuClip = false;

// 由 audio.js 注入：当前播放状态快照、读数刷新
let meterState, syncMeterReadout;

export function bindMetersHost(h) {
  ({ meterState, syncMeterReadout } = h);
}

/** 切歌时清零表头 */
export function resetMeters() {
  vuLevel = 0;
  specData = new Float32Array(BANDS);
  specPeak = new Float32Array(BANDS);
}

/** 点击 CLIP 灯：清除过载并把峰值保持拉回当前峰值 */
export function resetClip() {
  vuClip = false;
  vuPeakHoldDb = vuPeakDb;
}

export function meterReadings() {
  return { rmsDb: vuRmsDb, peakHoldDb: vuPeakHoldDb, clip: vuClip };
}

function goertzel(data, sr, freq) {
  const N = data.length;
  const k = Math.round((N * freq) / sr);
  const w = (2 * Math.PI * k) / N;
  const coeff = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < N; i++) {
    const s = data[i] + coeff * s1 - s2;
    s2 = s1; s1 = s;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2)) / (N / 2);
}

function initBandColors() {
  if (bandColors.length) return;
  for (let i = 0; i < BANDS; i++) {
    const t = i / (BANDS - 1);
    const hue = 195 - 195 * t;
    bandColors.push(`hsl(${hue}, 90%, 55%)`);
  }
}

export function analyze() {
  const { mono, monoSr, pos, playing, engineVol } = meterState();
  if (!mono || !monoSr) {
    if (!playing) {
      vuRmsDb = -120;
      vuPeakDb = -120;
      vuLevel *= 0.85;
    }
    return;
  }
  const start = Math.floor(pos * monoSr);
  const slice = fftSlice;
  for (let i = 0; i < FFT_N; i++) slice[i] = mono[start + i] || 0;
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < FFT_N; i++) {
    const s = slice[i];
    sum += s * s;
    const a = Math.abs(s);
    if (a > peak) peak = a;
  }
  const rms = Math.sqrt(sum / FFT_N);
  // 文件样本 dBFS + 软件推子 ≈ 输出电平估计（控台参考）
  const volLin = Math.max(1e-6, engineVol);
  const rmsDb = 20 * Math.log10(rms * volLin + 1e-12);
  const peakDb = 20 * Math.log10(peak * volLin + 1e-12);
  vuRmsDb = rmsDb;
  vuPeakDb = peakDb;
  if (peakDb >= vuPeakHoldDb - 0.1) {
    vuPeakHoldDb = peakDb;
    vuPeakHoldAt = performance.now();
  } else if (performance.now() - vuPeakHoldAt > 1200) {
    vuPeakHoldDb = Math.max(peakDb, vuPeakHoldDb - 0.35);
  }
  vuClip = peakDb > -0.3;
  // M32 段位映射（近 0dB 分辨率更高）
  const seg = dbToM32Index(rmsDb);
  const level = Math.max(0, (seg + 1) / M32_METER_DB.length);
  vuLevel = playing ? Math.max(level, vuLevel * 0.82) : vuLevel * 0.88;

  const raw = bandRaw;
  for (let b = 0; b < BANDS; b++) {
    const f = 50 * Math.pow(16000 / 50, b / (BANDS - 1));
    const mag = goertzel(slice, monoSr, f);
    const db = 20 * Math.log10(mag * volLin + 1e-9);
    raw[b] = Math.max(0, Math.min(1, (db + 58) / 52));
  }
  for (let b = 0; b < BANDS; b++) {
    const t = playing ? raw[b] : raw[b] * 0.55;
    specData[b] = t > specData[b] ? t : specData[b] * 0.82 + t * 0.18;
    specPeak[b] = Math.max(specData[b], specPeak[b] - 0.012);
  }
}

export function drawSpectrum() {
  const cv = $('audio-spec');
  if (!cv || !cv.parentElement) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.parentElement.clientWidth;
  const H = cv.parentElement.clientHeight;
  if (W < 10 || H < 10) return;
  if (cv.width !== Math.floor(W * dpr) || cv.height !== Math.floor(H * dpr)) {
    cv.width = Math.floor(W * dpr);
    cv.height = Math.floor(H * dpr);
  }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#050507';
  g.fillRect(0, 0, W, H);
  g.strokeStyle = '#101318';
  g.lineWidth = 1;
  g.beginPath();
  for (let x = 0; x < W; x += 32) { g.moveTo(x + .5, 0); g.lineTo(x + .5, H); }
  for (let y = 0; y < H; y += 32) { g.moveTo(0, y + .5); g.lineTo(W, y + .5); }
  g.stroke();

  initBandColors();
  const gap = 3;
  const bw = W / BANDS;
  for (let b = 0; b < BANDS; b++) {
    const h = Math.max(2, specData[b] * (H - 6));
    const x = b * bw + gap / 2;
    g.fillStyle = bandColors[b];
    g.fillRect(x, H - h, bw - gap, h);
    const py = H - Math.max(4, specPeak[b] * (H - 6));
    g.fillStyle = '#e8e8e8';
    g.fillRect(x, py - 2, bw - gap, 2);
  }
}

/** M32/X32 主表风格刻度（dBFS）：低段疏、近 0 密；绿≤-18 / 黄≤-9 / 红＞-9 / CLIP≈0 */
const M32_METER_DB = [
  -60, -54, -48, -42, -36, -30, -27, -24, -21, -18,
  -15, -12, -9, -6, -3, -2, -1, 0,
];

function m32SegColor(db, on) {
  if (db >= -1) return on ? '#ff2a2a' : '#3a1212';
  if (db >= -9) return on ? '#ff3b3b' : '#3a1414';
  if (db >= -18) return on ? '#ffcc33' : '#3a3210';
  return on ? '#3dd66a' : '#123a18';
}

function dbToM32Index(db) {
  if (!Number.isFinite(db) || db < -60) return -1;
  let lit = -1;
  for (let i = 0; i < M32_METER_DB.length; i++) {
    if (db >= M32_METER_DB[i]) lit = i;
  }
  return lit;
}

export function drawVU() {
  const cv = $('audio-vu');
  if (!cv || !cv.parentElement) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const wrap = cv.parentElement;
  const cssW = Math.max(160, wrap.clientWidth || 220);
  const cssH = 30;
  const tw = Math.round(cssW * dpr);
  const th = Math.round(cssH * dpr);
  if (cv.width !== tw || cv.height !== th) {
    cv.width = tw;
    cv.height = th;
  }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = cssW;
  const H = cssH;
  g.fillStyle = '#07070a';
  g.fillRect(0, 0, W, H);

  const SEGS = M32_METER_DB.length;
  const gap = 1.5;
  const bw = (W - gap * (SEGS - 1)) / SEGS;
  const rmsLit = dbToM32Index(vuRmsDb);
  const peakLit = dbToM32Index(vuPeakHoldDb);
  for (let i = 0; i < SEGS; i++) {
    const db = M32_METER_DB[i];
    const on = i <= rmsLit;
    g.fillStyle = m32SegColor(db, on);
    g.fillRect(i * (bw + gap), 4, bw, H - 12);
  }
  if (peakLit >= 0) {
    const px = peakLit * (bw + gap) + bw / 2;
    g.fillStyle = '#ffffff';
    g.fillRect(px - 1, 2, 2, H - 8);
  }
  if (vuClip) {
    g.fillStyle = '#ff3030';
    g.fillRect(W - 10, 2, 8, H - 8);
  }
  syncMeterReadout();
}
