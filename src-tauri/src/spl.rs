//! 实时声压级：A/C/Z 并行计权 + Fast/Slow + RTA 频谱

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Sample, SampleFormat, StreamConfig};
use realfft::RealFftPlanner;
use serde::Serialize;
use std::collections::VecDeque;
use std::f64::consts::PI;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU8, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

const FFT_SIZE: usize = 4096;
const SPEC_BINS: usize = 72; // 对数频带数，推前端体积可控

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SplInputDevice {
    pub index: usize,
    pub name: String,
    pub is_default: bool,
    pub max_channels: u16,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SplTick {
    pub dbfs_a: f32,
    pub dbfs_c: f32,
    pub dbfs_z: f32,
    pub spl_a: f32,
    pub spl_c: f32,
    pub spl_z: f32,
    pub peak_dbfs: f32,
    pub peak_spl: f32,
    pub response: String,
    pub sample_rate: u32,
    pub overload: bool,
    /// 对数频带中心频率 Hz
    pub freqs: Vec<f32>,
    /// 各频带电平 dBFS（未加 calOffset；前端加 offset 显示 dB SPL）
    pub spectrum: Vec<f32>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Response {
    Fast = 0,
    Slow = 1,
}

struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    z1: f64,
    z2: f64,
}

impl Biquad {
    fn new(b0: f64, b1: f64, b2: f64, a1: f64, a2: f64) -> Self {
        Self {
            b0,
            b1,
            b2,
            a1,
            a2,
            z1: 0.0,
            z2: 0.0,
        }
    }

    fn process(&mut self, x: f64) -> f64 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

fn a_weight_48k() -> Vec<Biquad> {
    vec![
        Biquad::new(
            0.23430179229951352,
            -0.46860358459902704,
            0.23430179229951352,
            -1.3433307489821639,
            0.4590265494657808,
        ),
        Biquad::new(1.0, -2.0, 1.0, -1.8586466886599748, 0.8644429529265023),
        Biquad::new(1.0, 2.0, 1.0, -0.18997680829803036, 0.004362462283557427),
    ]
}

fn c_weight_48k() -> Vec<Biquad> {
    vec![
        Biquad::new(
            0.9469696863165571,
            -1.8939393726331141,
            0.9469696863165571,
            -1.8890330793945284,
            0.8948743446168466,
        ),
        Biquad::new(1.0, 2.0, 1.0, -0.18997680829803036, 0.004362462283557427),
    ]
}

fn log_freqs(sr: f32) -> Vec<f32> {
    let f_min = 20.0_f32;
    let f_max = (sr * 0.45).min(20000.0);
    (0..SPEC_BINS)
        .map(|i| {
            let t = i as f32 / (SPEC_BINS - 1) as f32;
            f_min * (f_max / f_min).powf(t)
        })
        .collect()
}

struct SharedMeter {
    running: AtomicBool,
    dbfs_a: AtomicU32,
    dbfs_c: AtomicU32,
    dbfs_z: AtomicU32,
    peak_bits: AtomicU32,
    cal_offset_bits: AtomicU32,
    response: AtomicU8,
    sample_rate: AtomicU32,
    overload: AtomicBool,
    freqs: Mutex<Vec<f32>>,
    spectrum: Mutex<Vec<f32>>,
}

impl SharedMeter {
    fn new() -> Self {
        let freqs = log_freqs(48000.0);
        let n = freqs.len();
        Self {
            running: AtomicBool::new(false),
            dbfs_a: AtomicU32::new(f32::to_bits(-120.0)),
            dbfs_c: AtomicU32::new(f32::to_bits(-120.0)),
            dbfs_z: AtomicU32::new(f32::to_bits(-120.0)),
            peak_bits: AtomicU32::new(f32::to_bits(-120.0)),
            cal_offset_bits: AtomicU32::new(f32::to_bits(114.0)),
            response: AtomicU8::new(Response::Fast as u8),
            sample_rate: AtomicU32::new(48000),
            overload: AtomicBool::new(false),
            freqs: Mutex::new(freqs),
            spectrum: Mutex::new(vec![-120.0; n]),
        }
    }

    fn set_f32(slot: &AtomicU32, v: f32) {
        slot.store(v.to_bits(), Ordering::Relaxed);
    }

    fn get_f32(slot: &AtomicU32) -> f32 {
        f32::from_bits(slot.load(Ordering::Relaxed))
    }
}

enum SplCmd {
    Start {
        device_index: Option<usize>,
        channel: u16,
        reply: Sender<Result<(), String>>,
    },
    Stop {
        reply: Sender<()>,
    },
    SetParams {
        response: String,
        cal_offset: f32,
    },
}

pub struct SplHandle {
    tx: Mutex<Sender<SplCmd>>,
    shared: Arc<SharedMeter>,
}

impl SplHandle {
    pub fn new(app: AppHandle) -> Self {
        let (tx, rx) = channel();
        let shared = Arc::new(SharedMeter::new());
        let shared_emit = Arc::clone(&shared);
        thread::spawn(move || emit_loop(app, shared_emit));
        let shared_eng = Arc::clone(&shared);
        thread::spawn(move || engine_loop(rx, shared_eng));
        SplHandle {
            tx: Mutex::new(tx),
            shared,
        }
    }
}

fn make_tick(shared: &SharedMeter) -> SplTick {
    let offset = SharedMeter::get_f32(&shared.cal_offset_bits);
    let dbfs_a = SharedMeter::get_f32(&shared.dbfs_a);
    let dbfs_c = SharedMeter::get_f32(&shared.dbfs_c);
    let dbfs_z = SharedMeter::get_f32(&shared.dbfs_z);
    let peak = SharedMeter::get_f32(&shared.peak_bits);
    let r = if shared.response.load(Ordering::Relaxed) == 1 {
        "Slow"
    } else {
        "Fast"
    };
    let freqs = shared.freqs.lock().map(|g| g.clone()).unwrap_or_default();
    let spectrum = shared.spectrum.lock().map(|g| g.clone()).unwrap_or_default();
    SplTick {
        dbfs_a,
        dbfs_c,
        dbfs_z,
        spl_a: dbfs_a + offset,
        spl_c: dbfs_c + offset,
        spl_z: dbfs_z + offset,
        peak_dbfs: peak,
        peak_spl: peak + offset,
        response: r.into(),
        sample_rate: shared.sample_rate.load(Ordering::Relaxed),
        overload: shared.overload.load(Ordering::Relaxed),
        freqs,
        spectrum,
    }
}

fn emit_loop(app: AppHandle, shared: Arc<SharedMeter>) {
    loop {
        thread::sleep(Duration::from_millis(66));
        if !shared.running.load(Ordering::Relaxed) {
            continue;
        }
        // 只发主控窗口：输出窗口用不到，每秒 15 次广播是白白序列化
        let _ = app.emit_to("main", "spl:tick", make_tick(&shared));
    }
}

fn input_devices(host: &cpal::Host) -> Result<Vec<cpal::Device>, String> {
    Ok(host
        .devices()
        .map_err(|e| e.to_string())?
        .filter(|d| {
            d.supported_input_configs()
                .map(|mut c| c.next().is_some())
                .unwrap_or(false)
        })
        .collect())
}

fn engine_loop(rx: std::sync::mpsc::Receiver<SplCmd>, shared: Arc<SharedMeter>) {
    let mut _stream: Option<cpal::Stream> = None;

    while let Ok(cmd) = rx.recv() {
        match cmd {
            SplCmd::Stop { reply } => {
                shared.running.store(false, Ordering::Relaxed);
                shared.overload.store(false, Ordering::Relaxed);
                _stream = None;
                let _ = reply.send(());
            }
            SplCmd::SetParams {
                response,
                cal_offset,
            } => {
                let r = if response.eq_ignore_ascii_case("slow") {
                    Response::Slow
                } else {
                    Response::Fast
                };
                shared.response.store(r as u8, Ordering::Relaxed);
                SharedMeter::set_f32(&shared.cal_offset_bits, cal_offset);
            }
            SplCmd::Start {
                device_index,
                channel,
                reply,
            } => {
                shared.running.store(false, Ordering::Relaxed);
                _stream = None;

                let res = (|| -> Result<cpal::Stream, String> {
                    let host = cpal::default_host();
                    let devices = input_devices(&host)?;
                    let device = match device_index {
                        Some(i) => devices
                            .into_iter()
                            .nth(i)
                            .ok_or_else(|| "输入设备不存在".to_string())?,
                        None => host
                            .default_input_device()
                            .ok_or_else(|| "没有默认输入设备".to_string())?,
                    };

                    let config = device
                        .default_input_config()
                        .map_err(|e| format!("无法读取输入配置: {e}"))?;
                    let sample_format = config.sample_format();
                    let mut stream_config: StreamConfig = config.clone().into();
                    let want_48k = cpal::SampleRate(48000);
                    let can_48k = device
                        .supported_input_configs()
                        .map(|mut configs| {
                            configs.any(|r| {
                                r.min_sample_rate() <= want_48k && r.max_sample_rate() >= want_48k
                            })
                        })
                        .unwrap_or(false);
                    if can_48k {
                        stream_config.sample_rate = want_48k;
                    }
                    let channels = stream_config.channels;
                    let ch = (channel as usize).min(channels.saturating_sub(1) as usize);
                    let sr = stream_config.sample_rate.0;
                    shared.sample_rate.store(sr, Ordering::Relaxed);
                    if let Ok(mut f) = shared.freqs.lock() {
                        *f = log_freqs(sr as f32);
                    }
                    if let Ok(mut s) = shared.spectrum.lock() {
                        *s = vec![-120.0; SPEC_BINS];
                    }

                    let shared_cb = Arc::clone(&shared);
                    let err_fn = |e| eprintln!("spl input stream error: {e}");

                    let stream = match sample_format {
                        SampleFormat::F32 => device
                            .build_input_stream(
                                &stream_config,
                                move |data: &[f32], _| {
                                    process_interleaved(data, channels as usize, ch, &shared_cb)
                                },
                                err_fn,
                                None,
                            )
                            .map_err(|e| e.to_string())?,
                        SampleFormat::I16 => device
                            .build_input_stream(
                                &stream_config,
                                move |data: &[i16], _| {
                                    let buf: Vec<f32> =
                                        data.iter().map(|s| (*s).to_sample::<f32>()).collect();
                                    process_interleaved(&buf, channels as usize, ch, &shared_cb)
                                },
                                err_fn,
                                None,
                            )
                            .map_err(|e| e.to_string())?,
                        SampleFormat::U16 => device
                            .build_input_stream(
                                &stream_config,
                                move |data: &[u16], _| {
                                    let buf: Vec<f32> =
                                        data.iter().map(|s| (*s).to_sample::<f32>()).collect();
                                    process_interleaved(&buf, channels as usize, ch, &shared_cb)
                                },
                                err_fn,
                                None,
                            )
                            .map_err(|e| e.to_string())?,
                        other => return Err(format!("不支持的采样格式: {other:?}")),
                    };
                    stream.play().map_err(|e| e.to_string())?;
                    shared.running.store(true, Ordering::Relaxed);
                    Ok(stream)
                })();

                match res {
                    Ok(s) => {
                        _stream = Some(s);
                        let _ = reply.send(Ok(()));
                    }
                    Err(e) => {
                        shared.running.store(false, Ordering::Relaxed);
                        let _ = reply.send(Err(e));
                    }
                }
            }
        }
    }
}

struct ProcState {
    filt_a: Vec<Biquad>,
    filt_c: Vec<Biquad>,
    mean_a: f64,
    mean_c: f64,
    mean_z: f64,
    peak: f64,
    response: u8,
    fft_buf: VecDeque<f32>,
    hann: Vec<f32>,
    planner: RealFftPlanner<f32>,
    spectrum_smooth: Vec<f32>,
}

impl ProcState {
    fn new() -> Self {
        let mut hann = vec![0.0f32; FFT_SIZE];
        for (i, h) in hann.iter_mut().enumerate() {
            *h = (0.5 * (1.0 - (2.0 * PI * i as f64 / (FFT_SIZE - 1) as f64).cos())) as f32;
        }
        Self {
            filt_a: a_weight_48k(),
            filt_c: c_weight_48k(),
            mean_a: 0.0,
            mean_c: 0.0,
            mean_z: 0.0,
            peak: 0.0,
            response: 0,
            fft_buf: VecDeque::with_capacity(FFT_SIZE * 2),
            hann,
            planner: RealFftPlanner::<f32>::new(),
            spectrum_smooth: vec![-120.0; SPEC_BINS],
        }
    }
}

thread_local! {
    static PROC: std::cell::RefCell<ProcState> = std::cell::RefCell::new(ProcState::new());
}

fn process_interleaved(data: &[f32], channels: usize, channel: usize, shared: &SharedMeter) {
    if channels == 0 || data.is_empty() {
        return;
    }
    let resp = shared.response.load(Ordering::Relaxed);
    let sr = shared.sample_rate.load(Ordering::Relaxed).max(1) as f64;
    let tau = if resp == 1 { 1.0 } else { 0.125 };
    let alpha = 1.0 - (-1.0 / (tau * sr)).exp();

    PROC.with(|cell| {
        let mut st = cell.borrow_mut();
        if st.response != resp {
            st.response = resp;
        }

        let mut peak = st.peak * 0.995;
        let mut overload = false;
        let frames = data.len() / channels;
        for i in 0..frames {
            let z = data[i * channels + channel] as f64;
            if z.abs() > 0.99 {
                overload = true;
            }
            let a_abs = z.abs();
            if a_abs > peak {
                peak = a_abs;
            }

            let mut xa = z;
            for f in st.filt_a.iter_mut() {
                xa = f.process(xa);
            }
            let mut xc = z;
            for f in st.filt_c.iter_mut() {
                xc = f.process(xc);
            }

            st.mean_a += alpha * (xa * xa - st.mean_a);
            st.mean_c += alpha * (xc * xc - st.mean_c);
            st.mean_z += alpha * (z * z - st.mean_z);

            st.fft_buf.push_back(z as f32);
            if st.fft_buf.len() > FFT_SIZE * 2 {
                st.fft_buf.pop_front();
            }
        }
        st.peak = peak;

        let to_db = |ms: f64| (10.0 * ms.max(1e-20).log10()) as f32;
        SharedMeter::set_f32(&shared.dbfs_a, to_db(st.mean_a).clamp(-120.0, 6.0));
        SharedMeter::set_f32(&shared.dbfs_c, to_db(st.mean_c).clamp(-120.0, 6.0));
        SharedMeter::set_f32(&shared.dbfs_z, to_db(st.mean_z).clamp(-120.0, 6.0));
        SharedMeter::set_f32(
            &shared.peak_bits,
            (20.0 * peak.max(1e-20).log10() as f64) as f32,
        );
        shared.overload.store(overload, Ordering::Relaxed);

        // 攒满一帧做 FFT → 对数频带
        if st.fft_buf.len() >= FFT_SIZE {
            let mut mono = vec![0.0f32; FFT_SIZE];
            let start = st.fft_buf.len() - FFT_SIZE;
            for (i, sample) in st.fft_buf.iter().skip(start).take(FFT_SIZE).enumerate() {
                mono[i] = sample * st.hann[i];
            }
            // 半重叠推进
            for _ in 0..(FFT_SIZE / 2) {
                st.fft_buf.pop_front();
            }

            let r2c = st.planner.plan_fft_forward(FFT_SIZE);
            let mut spectrum = r2c.make_output_vec();
            if r2c.process(&mut mono, &mut spectrum).is_ok() {
                let freqs = shared.freqs.lock().ok();
                let Some(freqs) = freqs else { return };
                let n_bins = spectrum.len();
                let mut band = vec![-120.0f32; SPEC_BINS];
                for (bi, &fc) in freqs.iter().enumerate() {
                    let k = ((fc as f64) * FFT_SIZE as f64 / sr).round() as usize;
                    let k = k.min(n_bins.saturating_sub(1)).max(1);
                    // 邻域平均
                    let lo = k.saturating_sub(1);
                    let hi = (k + 1).min(n_bins - 1);
                    let mut acc = 0.0f64;
                    let mut cnt = 0usize;
                    for j in lo..=hi {
                        let c = spectrum[j];
                        acc += (c.re as f64).hypot(c.im as f64);
                        cnt += 1;
                    }
                    let mag = (acc / cnt.max(1) as f64) / (FFT_SIZE as f64);
                    band[bi] = (20.0 * mag.max(1e-12).log10()) as f32;
                }
                // 轻微平滑
                for i in 0..SPEC_BINS {
                    st.spectrum_smooth[i] =
                        st.spectrum_smooth[i] * 0.65 + band[i] * 0.35;
                }
                if let Ok(mut out) = shared.spectrum.lock() {
                    *out = st.spectrum_smooth.clone();
                }
            }
        }
    });
}

#[tauri::command]
pub async fn spl_list_inputs() -> Result<Vec<SplInputDevice>, String> {
    let host = cpal::default_host();
    let default_name = host.default_input_device().and_then(|d| d.name().ok());
    let mut out = Vec::new();
    for (i, d) in input_devices(&host)?.into_iter().enumerate() {
        let name = d.name().unwrap_or_else(|_| format!("输入 {i}"));
        let max_channels = d
            .default_input_config()
            .map(|c| c.channels())
            .unwrap_or(1);
        let is_default = default_name.as_ref() == Some(&name);
        out.push(SplInputDevice {
            index: i,
            name,
            is_default,
            max_channels,
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn spl_start(
    device_index: Option<usize>,
    channel: Option<u16>,
    h: State<'_, SplHandle>,
) -> Result<(), String> {
    let (reply_tx, reply_rx) = std::sync::mpsc::channel();
    h.tx.lock()
        .map_err(|_| "spl lock".to_string())?
        .send(SplCmd::Start {
            device_index,
            channel: channel.unwrap_or(0),
            reply: reply_tx,
        })
        .map_err(|_| "spl 引擎未运行".to_string())?;
    reply_rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "启动超时".to_string())?
}

#[tauri::command]
pub fn spl_stop(h: State<'_, SplHandle>) -> Result<(), String> {
    let (reply_tx, reply_rx) = std::sync::mpsc::channel();
    h.tx.lock()
        .map_err(|_| "spl lock".to_string())?
        .send(SplCmd::Stop { reply: reply_tx })
        .map_err(|_| "spl 引擎未运行".to_string())?;
    let _ = reply_rx.recv_timeout(Duration::from_secs(2));
    Ok(())
}

#[tauri::command]
pub fn spl_set_params(
    response: String,
    cal_offset: f32,
    h: State<'_, SplHandle>,
) -> Result<(), String> {
    h.tx.lock()
        .map_err(|_| "spl lock".to_string())?
        .send(SplCmd::SetParams {
            response,
            cal_offset,
        })
        .map_err(|_| "spl 引擎未运行".to_string())?;
    Ok(())
}

#[tauri::command]
pub fn spl_get_snapshot(h: State<'_, SplHandle>) -> Result<SplTick, String> {
    Ok(make_tick(&h.shared))
}
