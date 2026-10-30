use rodio::{Decoder, OutputStream, OutputStreamHandle, Sink, Source};
use serde::Serialize;
use std::fs::File;
use std::io::BufReader;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

use cpal::traits::{DeviceTrait, HostTrait};

/// 一阶低通状态（可串联成更陡的滚降）
#[derive(Clone, Copy, Default)]
struct OnePoleLp {
    a: f32,
    z: f32,
}

impl OnePoleLp {
    fn new(fc: f32, sr: f32) -> Self {
        let a = 1.0 - (-2.0 * std::f32::consts::PI * fc / sr.max(1.0)).exp();
        Self {
            a: a.clamp(0.0005, 0.5),
            z: 0.0,
        }
    }

    #[inline]
    fn process(&mut self, x: f32) -> f32 {
        self.z += self.a * (x - self.z);
        self.z
    }

    fn reset(&mut self) {
        self.z = 0.0;
    }
}

/// 立体声消人声闸门：始终包一层，运行时用 AtomicBool 无缝开关（不重开解码）。
///
/// 强力三刀：
/// 1) 中置只保留 ~95Hz 以下低音（人声带中置全部丢掉）
/// 2) 伴奏走侧链 (L−R)，有人声时按包络压侧链（打掉混响/叠轨泄漏）
/// 3) 再减一刀中置人声带，收残留
struct VocalCancelGate<S> {
    input: S,
    channels: u16,
    pending: Option<f32>,
    enabled: Arc<AtomicBool>,
    bass_lp: [OnePoleLp; 4],
    vocal_hp: [OnePoleLp; 3],
    vocal_lp: [OnePoleLp; 3],
    /// 侧链里人声频段（宽声像人声/混响）
    side_hp: [OnePoleLp; 2],
    side_lp: [OnePoleLp; 2],
    env: f32,
    env_atk: f32,
    env_rel: f32,
}

impl<S> VocalCancelGate<S>
where
    S: Source<Item = f32>,
{
    fn new(input: S, enabled: Arc<AtomicBool>) -> Self {
        let channels = input.channels();
        let sr = input.sample_rate().max(1) as f32;
        // 包络：起音快、释放稍慢，跟人声句切
        let env_atk = 1.0 - (-1.0 / (0.003 * sr)).exp();
        let env_rel = 1.0 - (-1.0 / (0.12 * sr)).exp();
        Self {
            input,
            channels,
            pending: None,
            enabled,
            bass_lp: [
                OnePoleLp::new(95.0, sr),
                OnePoleLp::new(95.0, sr),
                OnePoleLp::new(95.0, sr),
                OnePoleLp::new(95.0, sr),
            ],
            vocal_hp: [
                OnePoleLp::new(110.0, sr),
                OnePoleLp::new(110.0, sr),
                OnePoleLp::new(110.0, sr),
            ],
            vocal_lp: [
                OnePoleLp::new(7500.0, sr),
                OnePoleLp::new(7500.0, sr),
                OnePoleLp::new(7500.0, sr),
            ],
            side_hp: [OnePoleLp::new(250.0, sr), OnePoleLp::new(250.0, sr)],
            side_lp: [OnePoleLp::new(5000.0, sr), OnePoleLp::new(5000.0, sr)],
            env: 0.0,
            env_atk: env_atk.clamp(0.01, 0.5),
            env_rel: env_rel.clamp(0.0001, 0.05),
        }
    }

    #[inline]
    fn steep_lp(filt: &mut [OnePoleLp], x: f32) -> f32 {
        let mut y = x;
        for f in filt.iter_mut() {
            y = f.process(y);
        }
        y
    }

    #[inline]
    fn steep_hp(filt: &mut [OnePoleLp], x: f32) -> f32 {
        x - Self::steep_lp(filt, x)
    }

    #[inline]
    fn bandpass(
        hp: &mut [OnePoleLp],
        lp: &mut [OnePoleLp],
        x: f32,
    ) -> f32 {
        Self::steep_lp(lp, Self::steep_hp(hp, x))
    }
}

impl<S> Iterator for VocalCancelGate<S>
where
    S: Source<Item = f32>,
{
    type Item = f32;

    fn next(&mut self) -> Option<Self::Item> {
        if self.channels < 2 {
            return self.input.next();
        }
        if let Some(s) = self.pending.take() {
            return Some(s);
        }
        let l = self.input.next()?;
        let r = self.input.next().unwrap_or(l);
        if self.enabled.load(Ordering::Relaxed) {
            let mid = (l + r) * 0.5;
            let side = (l - r) * 0.5;

            let bass = Self::steep_lp(&mut self.bass_lp, mid);
            let vocal = Self::bandpass(&mut self.vocal_hp, &mut self.vocal_lp, mid);

            // 人声包络 → 有唱时强压侧链（混响/和声常在侧链）
            let v = vocal.abs();
            if v > self.env {
                self.env += self.env_atk * (v - self.env);
            } else {
                self.env += self.env_rel * (v - self.env);
            }
            // env 约 0~0.4 常见；放大后钳位
            let vocal_amt = (self.env * 5.0).clamp(0.0, 1.0);
            // 有人声时侧链可压到 12%，句间恢复
            let duck = 0.12 + 0.88 * (1.0 - vocal_amt);

            // 侧链再拆：人声频段跟包络强压；其它频段只轻压，保住吉他/键盘声像
            let side_v = Self::bandpass(&mut self.side_hp, &mut self.side_lp, side);
            let side_else = side - side_v;
            let side_out =
                side_else * (0.55 + 0.80 * duck) + side_v * (0.05 + 0.40 * duck);

            // 中置人声不进总线；再减一刀收残留
            let out_l = (bass * 1.7 + side_out * 1.25 - vocal * 1.0).clamp(-1.0, 1.0);
            let out_r = (bass * 1.7 - side_out * 1.25 - vocal * 1.0).clamp(-1.0, 1.0);
            self.pending = Some(out_r);
            Some(out_l)
        } else {
            let mid = (l + r) * 0.5;
            let side = (l - r) * 0.5;
            let _ = Self::steep_lp(&mut self.bass_lp, mid);
            let _ = Self::bandpass(&mut self.vocal_hp, &mut self.vocal_lp, mid);
            let _ = Self::bandpass(&mut self.side_hp, &mut self.side_lp, side);
            self.env *= 0.995;
            self.pending = Some(r);
            Some(l)
        }
    }
}

impl<S> Source for VocalCancelGate<S>
where
    S: Source<Item = f32>,
{
    fn current_frame_len(&self) -> Option<usize> {
        self.input.current_frame_len()
    }

    fn channels(&self) -> u16 {
        self.channels.max(1)
    }

    fn sample_rate(&self) -> u32 {
        self.input.sample_rate()
    }

    fn total_duration(&self) -> Option<Duration> {
        self.input.total_duration()
    }

    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        self.pending = None;
        self.env = 0.0;
        for f in &mut self.bass_lp {
            f.reset();
        }
        for f in &mut self.vocal_hp {
            f.reset();
        }
        for f in &mut self.vocal_lp {
            f.reset();
        }
        for f in &mut self.side_hp {
            f.reset();
        }
        for f in &mut self.side_lp {
            f.reset();
        }
        self.input.try_seek(pos)
    }
}

/// 枚举当前主机的输出设备（过滤掉纯输入设备）
fn output_devices(host: &cpal::Host) -> Result<Vec<cpal::Device>, String> {
    Ok(host
        .devices()
        .map_err(|e| e.to_string())?
        .filter(|d| {
            d.supported_output_configs()
                .map(|mut f| f.next().is_some())
                .unwrap_or(false)
        })
        .collect())
}

#[derive(Serialize, Clone)]
pub struct AudioDeviceInfo {
    pub index: usize,
    pub name: String,
    pub is_default: bool,
}

#[derive(Serialize, Clone)]
pub struct AudioState {
    pub exists: bool,
    pub playing: bool,
    pub paused: bool,
    pub position: f64,
    /// 当前已加载的音频路径（用于前端判断 resume 还是切歌重播）
    pub path: Option<String>,
    pub vocal_cancel: bool,
}

enum AudioCmd {
    Play {
        path: String,
        device_index: Option<usize>,
        start_at: Option<f64>,
        vocal_cancel: bool,
        reply: Sender<Result<(), String>>,
    },
    Pause,
    Resume,
    Stop,
    Volume(f32),
    Seek {
        t: f64,
        reply: Sender<Result<(), String>>,
    },
    SetVocalCancel(bool),
    State {
        reply: Sender<AudioState>,
    },
}

/// 音频控制句柄（管理到 Tauri 全局状态）
pub struct AudioHandle {
    tx: Mutex<Sender<AudioCmd>>,
}

impl AudioHandle {
    pub fn new(app: AppHandle) -> Self {
        let (tx, rx) = channel();
        std::thread::spawn(move || {
            // 音频线程守护：解码/设备异常导致 panic 时重启循环，而不是让整个演出程序退出
            loop {
                let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run_loop(&rx, &app)));
                match r {
                    Ok(()) => break, // 通道关闭，正常退出
                    Err(_) => {
                        let _ = app.emit("sp-audio-ended", ());
                        std::thread::sleep(Duration::from_millis(200));
                    }
                }
            }
        });
        AudioHandle { tx: Mutex::new(tx) }
    }

    /// 发送命令；锁中毒时仍取出 Sender（Sender 本身无可破坏的状态）
    fn send(&self, cmd: AudioCmd) -> Result<(), String> {
        self.tx
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .send(cmd)
            .map_err(|e| e.to_string())
    }
}

fn open_stream(device_index: Option<usize>) -> Result<(OutputStream, OutputStreamHandle), String> {
    match device_index {
        Some(i) => {
            let host = cpal::default_host();
            let dev = output_devices(&host)?
                .into_iter()
                .nth(i)
                .ok_or("指定的音频设备不存在")?;
            OutputStream::try_from_device(&dev).map_err(|e| format!("无法打开音频设备: {e}"))
        }
        None => OutputStream::try_default().map_err(|e| format!("无法打开默认音频设备: {e}")),
    }
}

/// 打开并定位音源。
/// 关键：先在 Decoder 上原生 seek，再包消人声闸门（避免仅伴奏时逐采样跳还做中置消除）。
/// 返回 (sink, vocal_flag, position_offset)。
fn open_positioned(
    h: &OutputStreamHandle,
    path: &str,
    target_sec: f64,
    vocal_cancel: bool,
    volume: f32,
) -> Result<(Sink, Arc<AtomicBool>, f64), String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut decoder =
        Decoder::new(BufReader::new(file)).map_err(|e| format!("无法解码该音频格式: {e}"))?;

    let target = target_sec.max(0.0);
    let mut offset = 0.0;
    let mut need_skip = false;
    if target > 0.05 {
        if decoder.try_seek(Duration::from_secs_f64(target)).is_ok() {
            offset = target;
        } else {
            need_skip = true;
        }
    }

    let mut decoded = decoder.convert_samples::<f32>();
    // 兜底逐采样跳：必须在消人声闸门之前，否则仅伴奏会把每个丢弃采样都算一遍
    if need_skip {
        let sr = decoded.sample_rate().max(1) as f64;
        let ch = decoded.channels().max(1) as f64;
        let mut left = (target * sr * ch).round() as usize;
        while left > 0 {
            if decoded.next().is_none() {
                break;
            }
            left -= 1;
        }
        offset = target;
    }

    let flag = Arc::new(AtomicBool::new(vocal_cancel));
    let gated = VocalCancelGate::new(decoded, Arc::clone(&flag));
    let sk = Sink::try_new(h).map_err(|e| e.to_string())?;
    sk.append(gated);
    sk.set_volume(volume.clamp(0.0, 1.0));
    Ok((sk, flag, offset))
}

/// 音频专用线程：持有 OutputStream（非 Send/Sync，必须驻留单线程）
fn run_loop(rx: &std::sync::mpsc::Receiver<AudioCmd>, app: &AppHandle) {
    let mut stream: Option<OutputStream> = None;
    let mut handle: Option<OutputStreamHandle> = None;
    let mut bound_device: Option<Option<usize>> = None;
    let mut sink: Option<Sink> = None;
    let mut current_path: Option<String> = None;
    let mut vocal_flag: Option<Arc<AtomicBool>> = None;
    let mut last_volume: f32 = 1.0;
    // 解码器预定位后，Sink 内部计时从 0 起，需加上此前缀偏移
    let mut position_offset: f64 = 0.0;

    loop {
        // 检测播放结束
        let ended = sink
            .as_ref()
            .map(|s| !s.is_paused() && s.empty())
            .unwrap_or(false);
        if ended {
            sink = None;
            current_path = None;
            vocal_flag = None;
            position_offset = 0.0;
            // 保留输出流，下一首起播更快
            let _ = app.emit("sp-audio-ended", ());
        }

        let timeout = |rx: &std::sync::mpsc::Receiver<AudioCmd>| {
            rx.recv_timeout(Duration::from_millis(200)).ok()
        };

        let cmd = match timeout(rx) {
            Some(c) => c,
            None => continue,
        };

        match cmd {
            AudioCmd::Play {
                path,
                device_index,
                start_at,
                vocal_cancel,
                reply,
            } => {
                let res = (|| -> Result<(), String> {
                    // 同声卡复用 OutputStream，避免每次点播放都重新打开设备（卡顿主因之一）
                    let need_reopen = handle.is_none() || bound_device != Some(device_index);
                    if need_reopen {
                        sink = None;
                        let (s, h) = open_stream(device_index)?;
                        stream = Some(s);
                        handle = Some(h);
                        bound_device = Some(device_index);
                    } else {
                        sink = None;
                    }
                    let h = handle.as_ref().ok_or_else(|| "音频输出未就绪".to_string())?;
                    let at = start_at.unwrap_or(0.0).max(0.0);
                    let (sk, flag, offset) =
                        open_positioned(h, &path, at, vocal_cancel, last_volume)?;
                    sk.play();
                    sink = Some(sk);
                    current_path = Some(path);
                    vocal_flag = Some(flag);
                    position_offset = offset;
                    Ok(())
                })();
                if res.is_err() {
                    sink = None;
                    current_path = None;
                    vocal_flag = None;
                    position_offset = 0.0;
                }
                let _ = reply.send(res);
            }
            AudioCmd::Pause => {
                if let Some(sk) = sink.as_ref() {
                    sk.pause();
                }
            }
            AudioCmd::Resume => {
                if let Some(sk) = sink.as_ref() {
                    sk.play();
                }
            }
            AudioCmd::Stop => {
                sink = None;
                current_path = None;
                vocal_flag = None;
                position_offset = 0.0;
                // 保留 stream/handle，下次播放更顺
            }
            AudioCmd::Volume(v) => {
                last_volume = v.clamp(0.0, 1.0);
                if let Some(sk) = sink.as_ref() {
                    sk.set_volume(last_volume);
                }
            }
            AudioCmd::Seek { t, reply } => {
                let target = t.max(0.0);
                let path = current_path.clone();
                let cancel = vocal_flag
                    .as_ref()
                    .map(|f| f.load(Ordering::Relaxed))
                    .unwrap_or(false);
                let was_paused = sink.as_ref().map(|s| s.is_paused()).unwrap_or(false);
                let res = if let Some(path) = path {
                    // 跳转瞬间压音量，避免仅伴奏/重定位时的爆破音
                    if let Some(sk) = sink.as_ref() {
                        sk.set_volume(0.0);
                    }
                    // 1) 原地 try_seek（Symphonia 通常数毫秒）
                    let mut ok = false;
                    if let Some(sk) = sink.as_ref() {
                        if sk.try_seek(Duration::from_secs_f64(target)).is_ok() {
                            position_offset = 0.0;
                            sk.set_volume(last_volume);
                            ok = true;
                        }
                    }
                    if ok {
                        Ok(())
                    } else {
                        // 2) 重开：Decoder 先 seek 再包消人声（仅伴奏不再拖慢跳转）
                        sink = None;
                        let mut opened = handle
                            .as_ref()
                            .ok_or_else(|| "音频输出未就绪".to_string())
                            .and_then(|h| open_positioned(h, &path, target, cancel, last_volume));
                        if opened.is_err() {
                            match open_stream(bound_device.flatten()) {
                                Ok((s, h)) => {
                                    stream = Some(s);
                                    handle = Some(h);
                                    opened = open_positioned(
                                        handle.as_ref().unwrap(),
                                        &path,
                                        target,
                                        cancel,
                                        last_volume,
                                    );
                                }
                                Err(e2) => {
                                    opened = Err(format!(
                                        "{}; 重开设备也失败: {e2}",
                                        opened.err().unwrap_or_default()
                                    ));
                                }
                            }
                        }
                        match opened {
                            Ok((sk, flag, offset)) => {
                                if was_paused {
                                    sk.pause();
                                } else {
                                    sk.play();
                                }
                                sink = Some(sk);
                                vocal_flag = Some(flag);
                                position_offset = offset;
                                Ok(())
                            }
                            Err(e) => {
                                current_path = Some(path);
                                if let Some(sk) = sink.as_ref() {
                                    sk.set_volume(last_volume);
                                }
                                Err(e)
                            }
                        }
                    }
                } else {
                    Err("没有正在播放的音频".into())
                };
                let _ = reply.send(res);
            }
            AudioCmd::SetVocalCancel(on) => {
                if let Some(flag) = vocal_flag.as_ref() {
                    flag.store(on, Ordering::Relaxed);
                }
            }
            AudioCmd::State { reply } => {
                let vocal_cancel = vocal_flag
                    .as_ref()
                    .map(|f| f.load(Ordering::Relaxed))
                    .unwrap_or(false);
                let st = match sink.as_ref() {
                    Some(sk) => AudioState {
                        exists: true,
                        playing: !sk.empty() && !sk.is_paused(),
                        paused: sk.is_paused(),
                        position: sk.get_pos().as_secs_f64() + position_offset,
                        path: current_path.clone(),
                        vocal_cancel,
                    },
                    None => AudioState {
                        exists: false,
                        playing: false,
                        paused: false,
                        position: 0.0,
                        path: None,
                        vocal_cancel: false,
                    },
                };
                let _ = reply.send(st);
            }
        }
    }
}

/// 枚举系统音频输出设备（声卡）
#[tauri::command]
pub async fn list_audio_output_devices() -> Result<Vec<AudioDeviceInfo>, String> {
    let host = cpal::default_host();
    let default_name = host.default_output_device().and_then(|d| d.name().ok());
    let mut devices = Vec::new();
    for (i, d) in output_devices(&host)?.into_iter().enumerate() {
        let name = d.name().unwrap_or_else(|_| format!("设备 {}", i + 1));
        let is_default = default_name.as_ref().map(|n| *n == name).unwrap_or(false);
        devices.push(AudioDeviceInfo {
            index: i,
            name,
            is_default,
        });
    }
    Ok(devices)
}

/// 播放音频（可指定声卡；start_at 为起始秒数；vocal_cancel 为消人声/仅伴奏）
#[tauri::command]
pub async fn audio_play(
    path: String,
    device_index: Option<usize>,
    start_at: Option<f64>,
    vocal_cancel: Option<bool>,
    h: State<'_, AudioHandle>,
) -> Result<(), String> {
    let (reply_tx, reply_rx) = channel();
    h.send(AudioCmd::Play {
            path,
            device_index,
            start_at,
            vocal_cancel: vocal_cancel.unwrap_or(false),
            reply: reply_tx,
        })?;
    reply_rx.recv().map_err(|e| e.to_string())?
}

/// 运行时无缝切换消人声（不重开文件）
#[tauri::command]
pub fn audio_set_vocal_cancel(on: bool, h: State<'_, AudioHandle>) -> Result<(), String> {
    h.send(AudioCmd::SetVocalCancel(on))
}

#[tauri::command]
pub fn audio_pause(h: State<'_, AudioHandle>) -> Result<(), String> {
    h.send(AudioCmd::Pause)
}

#[tauri::command]
pub fn audio_resume(h: State<'_, AudioHandle>) -> Result<(), String> {
    h.send(AudioCmd::Resume)
}

#[tauri::command]
pub fn audio_stop(h: State<'_, AudioHandle>) -> Result<(), String> {
    h.send(AudioCmd::Stop)
}

#[tauri::command]
pub fn audio_set_volume(h: State<'_, AudioHandle>, v: f32) -> Result<(), String> {
    h.send(AudioCmd::Volume(v))
}

#[tauri::command]
pub async fn audio_seek(h: State<'_, AudioHandle>, t: f64) -> Result<(), String> {
    let (reply_tx, reply_rx) = channel();
    h.send(AudioCmd::Seek {
            t,
            reply: reply_tx,
        })?;
    reply_rx.recv().map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn audio_state(h: State<'_, AudioHandle>) -> Result<AudioState, String> {
    let (reply_tx, reply_rx) = channel();
    h.send(AudioCmd::State { reply: reply_tx })?;
    reply_rx.recv().map_err(|e| e.to_string())
}
