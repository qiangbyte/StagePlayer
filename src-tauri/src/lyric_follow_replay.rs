//! 语音跟词回放测试：把一段 16kHz 单声道 f32 原始音频按真实速度喂给 sidecar + FlipperEngine，
//! 打印每次识别 / 预告 / 翻行发生在音频的第几秒，用来评估「提前翻行」效果。
//!
//! 运行（默认忽略，需要手动指定）：
//!   set LF_AUDIO=xxx.f32 & set LF_LYRICS=lines.txt & cargo test -p stage-player replay -- --ignored --nocapture
//! 可选：LF_SIDECAR（默认 target/debug/lyric-asr-sidecar.exe）、LF_MODEL_DIR（默认本机模型缓存目录）

use super::*;

fn lines_of(texts: &[&str]) -> Vec<LyricLine> {
  let raw: Vec<LyricLineIn> = texts
    .iter()
    .map(|t| LyricLineIn { text: (*t).into(), song_id: 1, is_title: false })
    .collect();
  build_lines(&raw)
}

/// 逐字喂识别结果（模拟流式 partial），返回每喂一个字后的 (当前行, 预告行)
fn sing(e: &mut FlipperEngine, utterance: &str) -> Vec<(usize, Option<usize>)> {
  let chars: Vec<char> = utterance.chars().collect();
  (1..=chars.len())
    .map(|k| {
      e.on_asr_partial(&chars[..k].iter().collect::<String>());
      (e.curr, e.armed)
    })
    .collect()
}

#[test]
fn flips_before_line_ends_and_previews_at_half() {
  let mut e = FlipperEngine::new(lines_of(&["神呐我的心切慕你", "如鹿切慕溪水", "唯有你是我心所爱"]), 0);
  // 识别有错字（慕你→莫拟）也要跟上
  let steps = sing(&mut e, "神呐我的心切莫拟");
  assert_eq!(steps[3], (0, Some(1)), "唱到一半预告下一句");
  assert_eq!(e.curr, 1, "唱完前就翻到下一句");
  let first_flip = steps.iter().position(|s| s.0 == 1).unwrap();
  assert!(first_flip < 7, "8 个字的句子最晚第 7 个字时翻：{first_flip}");
}

#[test]
fn repeated_chorus_does_not_jump_back() {
  let mut e = FlipperEngine::new(
    lines_of(&[
      "神呐我的心切慕你",
      "如鹿切慕溪水",
      "唯有你是我心所爱",
      "我渴慕来敬拜你",
      "你是我的力量盾牌",
      "我心单单降服于你",
      "唯有你是我心所爱",
      "我渴慕来敬拜你",
    ]),
    5,
  );
  sing(&mut e, "我心单单降服于你");
  assert_eq!(e.curr, 6);
  sing(&mut e, "唯有你是我心所爱");
  assert_eq!(e.curr, 7, "第二次的「唯有你是我心所爱」不能跳回第 2 行");
}

#[test]
fn catches_up_when_singer_is_already_on_next_line() {
  let mut e = FlipperEngine::new(lines_of(&["车子缓缓的开你慢慢走来", "我车票都还在心却在窗外", "远远的看着你点点头"]), 0);
  sing(&mut e, "我车票都还");
  assert_eq!(e.curr, 1);
}

#[test]
fn breath_after_most_of_line_flips() {
  let mut e = FlipperEngine::new(lines_of(&["你经过花就开离开雨就来", "这里适合谈个恋爱"]), 0);
  // 唱到 ~70%（未到 75% 直接翻的线），然后换气
  sing(&mut e, "你经过花就开离开");
  assert_eq!(e.curr, 0);
  for _ in 0..15 {
    e.on_rms(-60.0, 20.0);
  }
  assert_eq!(e.curr, 1);
}

#[test]
fn lost_fallback_advances_only_with_voice() {
  let mut e = FlipperEngine::new(lines_of(&["你是我的力量盾牌", "我心单单降服于你", "唯有你是我心所爱"]), 0);
  // 前奏：有声音（乐队串音）但还没对上过主领 → 不动
  for _ in 0..1000 {
    e.on_rms(-20.0, 20.0);
  }
  assert_eq!(e.curr, 0, "前奏不能被兜底推走");
  sing(&mut e, "你是我");
  // 间奏（无人声）多久都不动
  for _ in 0..1000 {
    e.on_rms(-60.0, 20.0);
  }
  assert_eq!(e.curr, 0);
  // 一直有人声但对不上：超过估计时长 1.5 倍后推进
  for _ in 0..500 {
    e.on_rms(-20.0, 20.0);
  }
  assert_eq!(e.curr, 1);
}

#[test]
fn guessed_flip_is_corrected_back() {
  let mut e = FlipperEngine::new(lines_of(&["你是我的力量盾牌", "我心单单降服于你", "唯有你是我心所爱"]), 0);
  sing(&mut e, "你是");
  e.heard = true;
  for _ in 0..500 {
    e.on_rms(-20.0, 20.0);
  }
  assert_eq!(e.curr, 1, "兜底推到第 2 行");
  // 主领其实才唱到第 1 行中间
  sing(&mut e, "你是我的力");
  assert_eq!(e.curr, 0, "识别到主领还在第 1 行，退回");
}

#[test]
#[ignore]
fn replay() {
  let audio_path = std::env::var("LF_AUDIO").expect("LF_AUDIO");
  let lyrics_path = std::env::var("LF_LYRICS").expect("LF_LYRICS");
  let sidecar = std::env::var("LF_SIDECAR").unwrap_or_else(|_| {
    concat!(env!("CARGO_MANIFEST_DIR"), "/target/debug/lyric-asr-sidecar.exe").into()
  });
  let model_dir = std::env::var("LF_MODEL_DIR").map(PathBuf::from).unwrap_or_else(|_| {
    PathBuf::from(std::env::var("LOCALAPPDATA").unwrap())
      .join("com.stageplayer.app/asr-models")
      .join(MODEL_DIR_NAME)
  });

  // 与前端一致：去掉段落标签和空行
  let text = fs::read_to_string(&lyrics_path).unwrap();
  let raw: Vec<LyricLineIn> = text
    .lines()
    .map(|l| l.trim())
    .filter(|l| !l.is_empty() && !(l.starts_with('[') && l.ends_with(']')))
    .map(|l| LyricLineIn { text: l.into(), song_id: 1, is_title: false })
    .collect();
  for (i, l) in raw.iter().enumerate() {
    println!("L{i}: {}", l.text);
  }

  let bytes = fs::read(&audio_path).unwrap();
  let samples: Vec<f32> = bytes
    .chunks_exact(4)
    .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
    .collect();

  let mut child = Command::new(&sidecar)
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .spawn()
    .expect("spawn sidecar");
  let mut cin = child.stdin.take().unwrap();
  let cout = child.stdout.take().unwrap();
  let init = serde_json::json!({
    "encoder": model_dir.join("encoder.int8.onnx").to_string_lossy(),
    "decoder": model_dir.join("decoder.int8.onnx").to_string_lossy(),
    "tokens": model_dir.join("tokens.txt").to_string_lossy(),
  });
  write_frame(&mut cin, b"INIT", init.to_string().as_bytes()).unwrap();
  let (atx, arx) = mpsc::channel::<serde_json::Value>();
  thread::spawn(move || {
    for line in BufReader::new(cout).lines().flatten() {
      if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
        if atx.send(v).is_err() {
          break;
        }
      }
    }
  });
  loop {
    let v = arx.recv_timeout(Duration::from_secs(60)).expect("sidecar ready");
    if v["kind"] == "ready" {
      break;
    }
    assert_ne!(v["kind"], "error", "{v}");
  }

  let mut engine = FlipperEngine::new(build_lines(&raw), 0);
  println!("t=  0.00s  显示 L0");
  // 麦克风回调大约每 10ms 一块，这里用 20ms
  const CHUNK: usize = 320;
  let t0 = Instant::now();
  let mut last_partial = String::new();
  for (k, chunk) in samples.chunks(CHUNK).enumerate() {
    let due = Duration::from_secs_f64((k * CHUNK) as f64 / TARGET_SR as f64);
    if let Some(wait) = due.checked_sub(t0.elapsed()) {
      thread::sleep(wait);
    }
    let at = t0.elapsed().as_secs_f64();
    while let Ok(v) = arx.try_recv() {
      if v["kind"] == "partial" {
        let s = v["text"].as_str().unwrap_or("").to_string();
        let (c0, a0) = (engine.curr, engine.armed);
        engine.on_asr_partial(&s);
        if s != last_partial {
          println!("t={at:6.2}s  听到：{s}");
          last_partial = s;
        }
        report(at, &engine, c0, a0);
      } else if v["kind"] == "endpoint" {
        println!("t={at:6.2}s  （断句）");
        let (c0, a0) = (engine.curr, engine.armed);
        engine.on_endpoint();
        report(at, &engine, c0, a0);
      }
    }
    let (c0, a0) = (engine.curr, engine.armed);
    engine.on_rms(rms_db(chunk), chunk.len() as f32 * 1000.0 / TARGET_SR as f32);
    report(at, &engine, c0, a0);
    write_audio_frame(&mut cin, chunk).unwrap();
  }
  let _ = cin.write_all(b"STOP");
  let _ = child.kill();
}

fn report(at: f64, e: &FlipperEngine, c0: usize, a0: Option<usize>) {
  if e.curr != c0 {
    println!("t={at:6.2}s  ==> 翻到 L{}「{}」", e.curr, e.lines[e.curr].text);
  } else if e.armed != a0 {
    if let Some(a) = e.armed {
      println!("t={at:6.2}s  -- 预告 L{a}（等换气）");
    }
  }
}
