// 人声消除导出（Rust 原生流式处理，不受 WebView 内存限制）
// out = (L - R) 侧向信号（消除中置人声）+ 110Hz 以下低频（贝斯）从中间信号混回

use hound::{SampleFormat, WavSpec, WavWriter};
use rodio::Source;
use std::io::BufReader;
use tauri::{AppHandle, Emitter};

#[tauri::command]
pub async fn vocal_cancel_export(
    app: AppHandle,
    path: String,
    save_path: String,
    duration: f64,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || run_export(&app, &path, &save_path, duration))
        .await
        .map_err(|e| e.to_string())?
}

fn run_export(app: &AppHandle, path: &str, save_path: &str, duration: f64) -> Result<(), String> {
    let file = std::fs::File::open(path).map_err(|e| format!("无法打开音频: {e}"))?;
    let reader = BufReader::new(file);
    let decoder = rodio::Decoder::new(reader).map_err(|e| format!("无法解码该音频格式: {e}"))?;

    let channels = decoder.channels() as usize;
    let sr = decoder.sample_rate();
    if channels != 2 {
        return Err("单声道音频没有左右声道信息，无法消除人声".into());
    }

    let spec = WavSpec {
        channels: 2,
        sample_rate: sr,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };
    let mut writer =
        WavWriter::create(save_path, spec).map_err(|e| format!("无法创建文件: {e}"))?;

    let alpha = 1.0f32 - (-2.0 * std::f32::consts::PI * 110.0 / sr as f32).exp();
    let mut lp = 0.0f32;
    let mut pending_l: Option<f32> = None;
    let mut frames: u64 = 0;
    let total_frames = if duration > 0.0 { (duration * sr as f64) as u64 } else { 0 };
    let mut last_pct: i64 = -1;

    for sample in decoder {
        let r = sample as f32 / 32768.0;
        let l = match pending_l.take() {
            Some(l) => l,
            None => {
                pending_l = Some(r);
                continue;
            }
        };

        let mid = (l + r) * 0.5;
        lp += alpha * (mid - lp);
        let v = ((l - r) * 0.5 + 0.75 * lp) * 0.92;
        let v = v.clamp(-1.0, 1.0);
        let q = (v * 32767.0) as i16;
        writer.write_sample(q).map_err(|e| e.to_string())?;
        writer.write_sample(q).map_err(|e| e.to_string())?;

        frames += 1;
        if total_frames > 0 && frames % (sr as u64) == 0 {
            let pct = ((frames as f64 / total_frames as f64) * 100.0) as i64;
            if pct != last_pct && pct <= 100 {
                last_pct = pct;
                let _ = app.emit("karaoke-progress", pct);
            }
        }
    }

    writer.finalize().map_err(|e| e.to_string())?;
    let _ = app.emit("karaoke-progress", 100);
    Ok(())
}
