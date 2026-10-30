// 波形 + 频谱用低采样率单声道：在 Rust 侧流式解码
// 替代 WebView decodeAudioData（整首解成 32bit 双声道 PCM，5 分钟歌约 100MB+，易 OOM）

use rodio::Source;
use std::io::BufReader;

/// 波形柱数（与前端绘制一致）
const PEAKS: usize = 900;
/// 频谱分析用单声道目标采样率
const MONO_SR: u32 = 11025;

/// 返回二进制：
/// [f64 duration][u32 sample_rate][u32 mono_sr][u32 n_peaks][u32 n_mono][f32 × n_peaks][f32 × n_mono]
/// 头部 24 字节，后续 f32 数组 4 字节对齐，前端可直接 Float32Array 视图读取
#[tauri::command]
pub async fn audio_wave(path: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || build(&path))
        .await
        .map_err(|e| e.to_string())?
        .map(tauri::ipc::Response::new)
}

fn build(path: &str) -> Result<Vec<u8>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("无法打开音频: {e}"))?;
    let decoder =
        rodio::Decoder::new(BufReader::new(file)).map_err(|e| format!("无法解码: {e}"))?;
    let channels = decoder.channels().max(1) as usize;
    let sr = decoder.sample_rate().max(1);
    let dec = (sr / MONO_SR).max(1) as usize;

    let mut mono: Vec<f32> = Vec::new();
    let mut frames: u64 = 0;
    let mut acc = 0.0f32;
    let mut ch = 0usize;
    for s in decoder {
        acc += s as f32 / 32768.0;
        ch += 1;
        if ch < channels {
            continue;
        }
        if frames % dec as u64 == 0 {
            mono.push(acc / channels as f32);
        }
        frames += 1;
        acc = 0.0;
        ch = 0;
    }
    if frames == 0 {
        return Err("音频为空".into());
    }

    let block = (mono.len() / PEAKS).max(1);
    let peaks: Vec<f32> = (0..PEAKS)
        .map(|i| {
            let start = (i * block).min(mono.len());
            let end = (start + block).min(mono.len());
            let m = mono[start..end].iter().fold(0.0f32, |m, v| m.max(v.abs()));
            (m * 1.4).min(1.0)
        })
        .collect();

    let duration = frames as f64 / sr as f64;
    let mono_sr = sr / dec as u32;
    let mut out = Vec::with_capacity(24 + (peaks.len() + mono.len()) * 4);
    out.extend_from_slice(&duration.to_le_bytes());
    out.extend_from_slice(&sr.to_le_bytes());
    out.extend_from_slice(&mono_sr.to_le_bytes());
    out.extend_from_slice(&(peaks.len() as u32).to_le_bytes());
    out.extend_from_slice(&(mono.len() as u32).to_le_bytes());
    for v in peaks.iter().chain(mono.iter()) {
        out.extend_from_slice(&v.to_le_bytes());
    }
    Ok(out)
}
