// 波形 + 频谱用单声道：优先 Rust 原生解码，WebAudio 兜底

import { convertFileSrc, invoke } from './util.js';

let audioCtx = null;

/** Rust 侧解码：返回 peaks + 低采样率单声道（二进制，见 src-tauri/src/wave.rs） */
export async function decodeWaveNative(path) {
  const buf = await invoke('audio_wave', { path });
  const dv = new DataView(buf);
  const duration = dv.getFloat64(0, true);
  const sampleRate = dv.getUint32(8, true);
  const monoSr = dv.getUint32(12, true);
  const nPeaks = dv.getUint32(16, true);
  const nMono = dv.getUint32(20, true);
  return {
    duration,
    sampleRate,
    monoSr,
    // 拷贝出来：peaks 进长期缓存，不能拖着整块 mono 缓冲区
    peaks: new Float32Array(buf, 24, nPeaks).slice(),
    mono: new Float32Array(buf, 24 + nPeaks * 4, nMono),
  };
}

/** 回退：WebAudio 整首解码（内存占用大，仅原生不支持的格式使用） */
export async function decodeWaveWeb(path, isStale) {
  const resp = await fetch(convertFileSrc(path));
  if (isStale()) return null;
  const buf = await resp.arrayBuffer();
  if (isStale()) return null;
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') await audioCtx.resume().catch(() => {});
  const audio = await audioCtx.decodeAudioData(buf);
  if (isStale()) return null;
  const ch0 = audio.getChannelData(0);
  const ch1 = audio.numberOfChannels > 1 ? audio.getChannelData(1) : null;

  const n = 900;
  const block = Math.max(1, Math.floor(ch0.length / n));
  const peaks = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    const s = i * block;
    for (let j = 0; j < block; j += 24) {
      const v = Math.abs((ch0[s + j] + (ch1 ? ch1[s + j] : 0)) / (ch1 ? 2 : 1) || 0);
      if (v > m) m = v;
    }
    peaks[i] = Math.min(1, m * 1.4);
  }
  const sr = audio.sampleRate;
  const dec = Math.max(1, Math.floor(sr / 11025));
  const outLen = Math.floor(ch0.length / dec);
  const mono = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const s = i * dec;
    mono[i] = ch1 ? (ch0[s] + ch1[s]) / 2 : ch0[s];
  }
  return { duration: audio.duration, sampleRate: sr, monoSr: Math.floor(sr / dec), peaks, mono };
}
