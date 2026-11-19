//! StagePlayer ASR sidecar。
//! 协议（stdin 二进制帧 / stdout JSON 行）：
//!   INIT + u32_le(len) + utf8 JSON
//!     mode 缺省/online：流式 Paraformer {encoder,decoder,tokens}
//!     mode=funasr_nano：离线 FunASR-Nano + Silero VAD 模拟流式
//!       {encoder_adaptor,embedding,llm,tokenizer,vad, language?,hotwords?}
//!     mode=hybrid：流式 Paraformer（实时）+ FunASR（换气纠偏）
//!       同时需要 online 字段与 funasr 字段
//!     mode=sensevoice：离线 SenseVoice {model,tokens,language?,use_itn?}
//!     mode=punct：离线标点 {model}
//!   AUD0 + u32_le(n) + n * f32_le
//!   RST0（online：软重置当前流，不退出进程；讲话长会话用）
//!   FIN0（sensevoice：对当前缓冲解码一句）
//!   TEXT + u32_le(len) + utf8（punct：给一段文本加标点）
//!   STOP
//! stdout: {"kind":"ready"|"partial"|"endpoint"|"final"|"error", ...}
#![cfg_attr(windows, windows_subsystem = "windows")]
use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};
use std::process;
use std::time::{Duration, Instant};

#[derive(Deserialize)]
struct InitMsg {
  #[serde(default)]
  mode: String,
  encoder: Option<String>,
  decoder: Option<String>,
  tokens: Option<String>,
  model: Option<String>,
  language: Option<String>,
  #[serde(default = "default_true")]
  use_itn: bool,
  // FunASR Nano
  encoder_adaptor: Option<String>,
  embedding: Option<String>,
  llm: Option<String>,
  tokenizer: Option<String>,
  vad: Option<String>,
  hotwords: Option<String>,
  /// "dictation" = 讲话连续听写（尾静音更宽，换气不断场）
  #[serde(default)]
  endpoint_profile: String,
}

fn default_true() -> bool {
  true
}

#[derive(Serialize)]
struct OutMsg {
  kind: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  text: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  message: Option<String>,
}

fn emit(msg: &OutMsg) {
  let mut out = io::stdout().lock();
  if let Ok(line) = serde_json::to_string(msg) {
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
  }
}

fn read_exact(stdin: &mut impl Read, buf: &mut [u8]) -> io::Result<()> {
  stdin.read_exact(buf)
}

fn read_u32(stdin: &mut impl Read) -> io::Result<u32> {
  let mut b = [0u8; 4];
  read_exact(stdin, &mut b)?;
  Ok(u32::from_le_bytes(b))
}

fn strip_sv_tags(s: &str) -> String {
  let mut out = String::with_capacity(s.len());
  let mut chars = s.chars().peekable();
  while let Some(c) = chars.next() {
    if c == '<' && chars.peek() == Some(&'|') {
      while let Some(x) = chars.next() {
        if x == '>' {
          break;
        }
      }
      continue;
    }
    out.push(c);
  }
  out.split_whitespace().collect::<Vec<_>>().join(" ").trim().to_string()
}

fn decode_offline(recognizer: &sherpa_onnx::OfflineRecognizer, samples: &[f32]) -> String {
  if samples.is_empty() {
    return String::new();
  }
  let stream = recognizer.create_stream();
  stream.accept_waveform(16_000i32, samples);
  recognizer.decode(&stream);
  stream
    .get_result()
    .map(|r| r.text.trim().to_string())
    .unwrap_or_default()
}

struct FunAsrNanoEngine {
  recognizer: sherpa_onnx::OfflineRecognizer,
  vad: sherpa_onnx::VoiceActivityDetector,
  buffer: Vec<f32>,
  offset: usize,
  speech_started: bool,
  last_decode: Instant,
  last_text: String,
  /// false=只在换气切段时解码（混合模式：不挡实时流）
  interim: bool,
}

impl FunAsrNanoEngine {
  const WINDOW: usize = 512;
  const INTERIM_MS: u64 = 900;
  /// 中间结果只喂最近几秒，控制 LLM 延迟
  const INTERIM_TAIL: usize = 16_000 * 5;
  const PRE_ROLL: usize = 16_000 / 2; // 0.5s

  fn feed(&mut self, samples: &[f32]) {
    if samples.is_empty() {
      return;
    }
    self.buffer.extend_from_slice(samples);

    while self.offset + Self::WINDOW <= self.buffer.len() {
      self
        .vad
        .accept_waveform(&self.buffer[self.offset..self.offset + Self::WINDOW]);
      if !self.speech_started && self.vad.detected() {
        self.speech_started = true;
        self.last_decode = Instant::now();
      }
      self.offset += Self::WINDOW;
    }

    // 未起声时只留短预卷，避免缓冲膨胀
    if !self.speech_started && self.buffer.len() > Self::PRE_ROLL + Self::WINDOW * 4 {
      let keep = Self::PRE_ROLL + Self::WINDOW * 4;
      let trim = self.buffer.len() - keep;
      self.buffer.drain(..trim);
      self.offset = self.offset.saturating_sub(trim);
    }

    // 纯 FunASR 模式才做中间识别；混合模式交给 Paraformer 实时出字
    if self.interim
      && self.speech_started
      && self.last_decode.elapsed() >= Duration::from_millis(Self::INTERIM_MS)
      && self.buffer.len() >= Self::WINDOW * 2
    {
      let start = self.buffer.len().saturating_sub(Self::INTERIM_TAIL);
      let text = decode_offline(&self.recognizer, &self.buffer[start..]);
      self.last_decode = Instant::now();
      if !text.is_empty() && text != self.last_text {
        self.last_text = text.clone();
        emit(&OutMsg {
          kind: "partial".into(),
          text: Some(text),
          message: None,
        });
      }
    }

    // VAD 切出完整段：定稿；纯 FunASR 模式再发断句（混合模式断句由 Paraformer 负责）
    while !self.vad.is_empty() {
      let Some(seg) = self.vad.front() else {
        break;
      };
      let seg_samples = seg.samples().to_vec();
      self.vad.pop();
      let text = decode_offline(&self.recognizer, &seg_samples);
      if !text.is_empty() {
        self.last_text = text.clone();
        emit(&OutMsg {
          kind: "partial".into(),
          text: Some(text),
          message: None,
        });
      }
      if self.interim {
        emit(&OutMsg {
          kind: "endpoint".into(),
          text: None,
          message: None,
        });
      }
      self.buffer.clear();
      self.offset = 0;
      self.speech_started = false;
      self.last_text.clear();
      self.last_decode = Instant::now();
    }
  }
}

fn feed_online(
  recognizer: &sherpa_onnx::OnlineRecognizer,
  stream: &mut sherpa_onnx::OnlineStream,
  last_text: &mut String,
  samples: &[f32],
  emit_endpoint: bool,
) {
  stream.accept_waveform(16_000i32, samples);
  while recognizer.is_ready(stream) {
    recognizer.decode(stream);
  }
  if let Some(result) = recognizer.get_result(stream) {
    let text = result.text.trim().to_string();
    if !text.is_empty() && text != *last_text {
      *last_text = text.clone();
      emit(&OutMsg {
        kind: "partial".into(),
        text: Some(text),
        message: None,
      });
    }
  }
  if emit_endpoint && recognizer.is_endpoint(stream) {
    recognizer.reset(stream);
    last_text.clear();
    emit(&OutMsg {
      kind: "endpoint".into(),
      text: None,
      message: None,
    });
  }
}

fn create_online(
  encoder: String,
  decoder: String,
  tokens: String,
  hotwords: Option<String>,
  endpoint_profile: &str,
) -> Result<(sherpa_onnx::OnlineRecognizer, sherpa_onnx::OnlineStream), String> {
  let mut cfg = sherpa_onnx::OnlineRecognizerConfig::default();
  cfg.model_config.paraformer.encoder = Some(encoder);
  cfg.model_config.paraformer.decoder = Some(decoder);
  cfg.model_config.tokens = Some(tokens);
  cfg.model_config.num_threads = 2;
  cfg.model_config.provider = Some("cpu".into());
  if endpoint_profile.eq_ignore_ascii_case("dictation") {
    // 讲话连续听写：关掉 Sherpa 自动 endpoint。
    // 否则一句话后 reset，容易表现为「识别完就结束」。
    cfg.enable_endpoint = false;
    cfg.rule1_min_trailing_silence = 0.0;
    cfg.rule2_min_trailing_silence = 0.0;
    cfg.rule3_min_utterance_length = 0.0;
  } else if endpoint_profile.eq_ignore_ascii_case("singing") {
    // 跟词 / 快歌：更短尾静音，连唱少换气也能出 endpoint
    cfg.enable_endpoint = true;
    cfg.rule1_min_trailing_silence = 0.45;
    cfg.rule2_min_trailing_silence = 0.22;
    cfg.rule3_min_utterance_length = 1.2;
  } else {
    // 默认（兼容旧 INIT）
    cfg.enable_endpoint = true;
    cfg.rule1_min_trailing_silence = 0.7;
    cfg.rule2_min_trailing_silence = 0.35;
    cfg.rule3_min_utterance_length = 2.5;
  }
  cfg.decoding_method = Some("greedy_search".into());
  // Paraformer 热词格式要求严，歌词热词只交给 FunASR，避免创建失败
  let _ = hotwords;
  let r = sherpa_onnx::OnlineRecognizer::create(&cfg)
    .ok_or_else(|| "创建 OnlineRecognizer 失败".to_string())?;
  let stream = r.create_stream();
  Ok((r, stream))
}

fn create_funasr(init: &InitMsg, interim: bool) -> Result<FunAsrNanoEngine, String> {
  let (
    Some(encoder_adaptor),
    Some(embedding),
    Some(llm),
    Some(tokenizer),
    Some(vad_path),
  ) = (
    init.encoder_adaptor.clone(),
    init.embedding.clone(),
    init.llm.clone(),
    init.tokenizer.clone(),
    init.vad.clone(),
  )
  else {
    return Err("funasr 需要 encoder_adaptor/embedding/llm/tokenizer/vad".into());
  };

  let mut asr_cfg = sherpa_onnx::OfflineRecognizerConfig::default();
  asr_cfg.model_config.funasr_nano = sherpa_onnx::OfflineFunASRNanoModelConfig {
    encoder_adaptor: Some(encoder_adaptor),
    embedding: Some(embedding),
    llm: Some(llm),
    tokenizer: Some(tokenizer),
    language: Some(init.language.clone().unwrap_or_else(|| "zh".into())),
    itn: if init.use_itn { 1 } else { 0 },
    hotwords: init.hotwords.clone(),
    system_prompt: Some(
      "请转写中文歌声歌词。忽略拉长音造成的重复字，不要臆造歌词。".into(),
    ),
    max_new_tokens: 64,
    temperature: 1e-6,
    top_p: 0.8,
    seed: 42,
    ..Default::default()
  };
  asr_cfg.model_config.tokens = Some(String::new());
  asr_cfg.model_config.num_threads = 2;
  asr_cfg.model_config.provider = Some("cpu".into());
  asr_cfg.decoding_method = Some("greedy_search".into());

  let mut vad_cfg = sherpa_onnx::VadModelConfig::default();
  vad_cfg.silero_vad.model = Some(vad_path);
  vad_cfg.silero_vad.threshold = 0.42;
  vad_cfg.silero_vad.min_silence_duration = 0.22;
  vad_cfg.silero_vad.min_speech_duration = 0.15;
  vad_cfg.silero_vad.max_speech_duration = 12.0;
  vad_cfg.silero_vad.window_size = 512;
  vad_cfg.sample_rate = 16_000;
  vad_cfg.num_threads = 1;
  vad_cfg.provider = Some("cpu".into());

  let recognizer = sherpa_onnx::OfflineRecognizer::create(&asr_cfg)
    .ok_or_else(|| "创建 FunASR-Nano OfflineRecognizer 失败".to_string())?;
  let vad = sherpa_onnx::VoiceActivityDetector::create(&vad_cfg, 30.0)
    .ok_or_else(|| "创建 Silero VAD 失败".to_string())?;
  Ok(FunAsrNanoEngine {
    recognizer,
    vad,
    buffer: Vec::new(),
    offset: 0,
    speech_started: false,
    last_decode: Instant::now(),
    last_text: String::new(),
    interim,
  })
}

enum Engine {
  Online {
    recognizer: sherpa_onnx::OnlineRecognizer,
    stream: sherpa_onnx::OnlineStream,
    last_text: String,
  },
  FunAsrNano(FunAsrNanoEngine),
  /// Paraformer 实时 partial；FunASR 仅换气切段纠偏（不挡音频）
  Hybrid {
    recognizer: sherpa_onnx::OnlineRecognizer,
    stream: sherpa_onnx::OnlineStream,
    last_text: String,
    fun: FunAsrNanoEngine,
  },
  SenseVoice {
    recognizer: sherpa_onnx::OfflineRecognizer,
    pending: Vec<f32>,
  },
  Punct {
    punct: sherpa_onnx::OfflinePunctuation,
  },
}

fn main() {
  let mut stdin = io::stdin().lock();
  let mut tag = [0u8; 4];
  let mut engine: Option<Engine> = None;

  loop {
    if read_exact(&mut stdin, &mut tag).is_err() {
      break;
    }
    match &tag {
      b"INIT" => {
        let len = match read_u32(&mut stdin) {
          Ok(n) => n as usize,
          Err(_) => break,
        };
        let mut buf = vec![0u8; len];
        if read_exact(&mut stdin, &mut buf).is_err() {
          break;
        }
        let init: InitMsg = match serde_json::from_slice(&buf) {
          Ok(v) => v,
          Err(e) => {
            emit(&OutMsg {
              kind: "error".into(),
              text: None,
              message: Some(format!("INIT JSON 无效: {e}")),
            });
            process::exit(2);
          }
        };
        let mode = init.mode.to_ascii_lowercase();
        if mode.is_empty() || mode == "online" {
          let (Some(encoder), Some(decoder), Some(tokens)) =
            (init.encoder.clone(), init.decoder.clone(), init.tokens.clone())
          else {
            emit(&OutMsg {
              kind: "error".into(),
              text: None,
              message: Some("online 模式需要 encoder/decoder/tokens".into()),
            });
            process::exit(2);
          };
          match create_online(
            encoder,
            decoder,
            tokens,
            init.hotwords.clone(),
            &init.endpoint_profile,
          ) {
            Ok((r, stream)) => {
              engine = Some(Engine::Online {
                recognizer: r,
                stream,
                last_text: String::new(),
              });
              emit(&OutMsg {
                kind: "ready".into(),
                text: None,
                message: Some("ASR sidecar 就绪".into()),
              });
            }
            Err(e) => {
              emit(&OutMsg {
                kind: "error".into(),
                text: None,
                message: Some(e),
              });
              process::exit(3);
            }
          }
        } else if mode == "hybrid" {
          let (Some(encoder), Some(decoder), Some(tokens)) =
            (init.encoder.clone(), init.decoder.clone(), init.tokens.clone())
          else {
            emit(&OutMsg {
              kind: "error".into(),
              text: None,
              message: Some("hybrid 需要 online 的 encoder/decoder/tokens".into()),
            });
            process::exit(2);
          };
          let online = match create_online(
            encoder,
            decoder,
            tokens,
            init.hotwords.clone(),
            "lyric",
          ) {
            Ok(v) => v,
            Err(e) => {
              emit(&OutMsg {
                kind: "error".into(),
                text: None,
                message: Some(e),
              });
              process::exit(3);
            }
          };
          // FunASR 只做换气纠偏，关闭 interim 以免卡住实时流
          let fun = match create_funasr(&init, false) {
            Ok(v) => v,
            Err(e) => {
              emit(&OutMsg {
                kind: "error".into(),
                text: None,
                message: Some(e),
              });
              process::exit(3);
            }
          };
          engine = Some(Engine::Hybrid {
            recognizer: online.0,
            stream: online.1,
            last_text: String::new(),
            fun,
          });
          emit(&OutMsg {
            kind: "ready".into(),
            text: None,
            message: Some("混合跟词就绪（实时+歌词纠偏）".into()),
          });
        } else if mode == "funasr_nano" || mode == "funasr" {
          match create_funasr(&init, true) {
            Ok(eng) => {
              engine = Some(Engine::FunAsrNano(eng));
              emit(&OutMsg {
                kind: "ready".into(),
                text: None,
                message: Some("FunASR-Nano 跟词就绪".into()),
              });
            }
            Err(e) => {
              emit(&OutMsg {
                kind: "error".into(),
                text: None,
                message: Some(e),
              });
              process::exit(3);
            }
          }
        } else if mode == "sensevoice" {
          let (Some(model), Some(tokens)) = (init.model, init.tokens) else {
            emit(&OutMsg {
              kind: "error".into(),
              text: None,
              message: Some("sensevoice 模式需要 model/tokens".into()),
            });
            process::exit(2);
          };
          let mut cfg = sherpa_onnx::OfflineRecognizerConfig::default();
          cfg.model_config.sense_voice = sherpa_onnx::OfflineSenseVoiceModelConfig {
            model: Some(model),
            language: Some(init.language.unwrap_or_else(|| "zh".into())),
            use_itn: init.use_itn,
          };
          cfg.model_config.tokens = Some(tokens);
          cfg.model_config.num_threads = 2;
          cfg.model_config.provider = Some("cpu".into());
          match sherpa_onnx::OfflineRecognizer::create(&cfg) {
            Some(r) => {
              engine = Some(Engine::SenseVoice {
                recognizer: r,
                pending: Vec::new(),
              });
              emit(&OutMsg {
                kind: "ready".into(),
                text: None,
                message: Some("SenseVoice 精修就绪".into()),
              });
            }
            None => {
              emit(&OutMsg {
                kind: "error".into(),
                text: None,
                message: Some("创建 SenseVoice OfflineRecognizer 失败".into()),
              });
              process::exit(3);
            }
          }
        } else if mode == "punct" {
          let Some(model) = init.model else {
            emit(&OutMsg {
              kind: "error".into(),
              text: None,
              message: Some("punct 模式需要 model".into()),
            });
            process::exit(2);
          };
          let mut cfg = sherpa_onnx::OfflinePunctuationConfig::default();
          cfg.model.ct_transformer = Some(model);
          cfg.model.num_threads = 1;
          cfg.model.provider = Some("cpu".into());
          match sherpa_onnx::OfflinePunctuation::create(&cfg) {
            Some(punct) => {
              engine = Some(Engine::Punct { punct });
              emit(&OutMsg {
                kind: "ready".into(),
                text: None,
                message: Some("标点模型就绪".into()),
              });
            }
            None => {
              emit(&OutMsg {
                kind: "error".into(),
                text: None,
                message: Some("创建 OfflinePunctuation 失败".into()),
              });
              process::exit(3);
            }
          }
        } else {
          emit(&OutMsg {
            kind: "error".into(),
            text: None,
            message: Some(format!("未知 mode: {mode}")),
          });
          process::exit(2);
        }
      }
      b"AUD\0" => {
        let n = match read_u32(&mut stdin) {
          Ok(n) => n as usize,
          Err(_) => break,
        };
        let mut bytes = vec![0u8; n.saturating_mul(4)];
        if read_exact(&mut stdin, &mut bytes).is_err() {
          break;
        }
        let mut samples = Vec::with_capacity(n);
        for chunk in bytes.chunks_exact(4) {
          samples.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
        }
        if samples.is_empty() {
          continue;
        }
        match engine.as_mut() {
          Some(Engine::Online {
            recognizer,
            stream,
            last_text,
          }) => feed_online(recognizer, stream, last_text, &samples, true),
          Some(Engine::Hybrid {
            recognizer,
            stream,
            last_text,
            fun,
          }) => {
            // 先实时出字，再喂 FunASR（仅 VAD 切段纠偏，不挡 partial）
            feed_online(recognizer, stream, last_text, &samples, true);
            fun.feed(&samples);
          }
          Some(Engine::FunAsrNano(eng)) => eng.feed(&samples),
          Some(Engine::SenseVoice { pending, .. }) => {
            pending.extend_from_slice(&samples);
          }
          _ => {}
        }
      }
      b"RST\0" => {
        let len = match read_u32(&mut stdin) {
          Ok(n) => n as usize,
          Err(_) => break,
        };
        if len > 0 {
          let mut skip = vec![0u8; len];
          if read_exact(&mut stdin, &mut skip).is_err() {
            break;
          }
        }
        match engine.as_mut() {
          Some(Engine::Online {
            recognizer,
            stream,
            last_text,
          })
          | Some(Engine::Hybrid {
            recognizer,
            stream,
            last_text,
            ..
          }) => {
            recognizer.reset(stream);
            last_text.clear();
          }
          _ => {}
        }
      }
      b"FIN\0" => {
        let len = match read_u32(&mut stdin) {
          Ok(n) => n as usize,
          Err(_) => break,
        };
        if len > 0 {
          let mut skip = vec![0u8; len];
          if read_exact(&mut stdin, &mut skip).is_err() {
            break;
          }
        }
        if let Some(Engine::SenseVoice {
          recognizer,
          pending,
        }) = engine.as_mut()
        {
          if pending.is_empty() {
            emit(&OutMsg {
              kind: "final".into(),
              text: Some(String::new()),
              message: None,
            });
            continue;
          }
          let stream = recognizer.create_stream();
          stream.accept_waveform(16_000i32, pending);
          recognizer.decode(&stream);
          let text = stream
            .get_result()
            .map(|r| strip_sv_tags(r.text.trim()))
            .unwrap_or_default();
          pending.clear();
          emit(&OutMsg {
            kind: "final".into(),
            text: Some(text),
            message: None,
          });
        }
      }
      b"TEXT" => {
        let len = match read_u32(&mut stdin) {
          Ok(n) => n as usize,
          Err(_) => break,
        };
        let mut buf = vec![0u8; len];
        if read_exact(&mut stdin, &mut buf).is_err() {
          break;
        }
        let input = String::from_utf8_lossy(&buf).to_string();
        if let Some(Engine::Punct { punct }) = engine.as_ref() {
          let out = punct
            .add_punctuation(&input)
            .unwrap_or_else(|| input.clone());
          emit(&OutMsg {
            kind: "final".into(),
            text: Some(out),
            message: None,
          });
        } else {
          emit(&OutMsg {
            kind: "error".into(),
            text: None,
            message: Some("当前不是 punct 模式".into()),
          });
        }
      }
      b"STOP" => break,
      _ => {
        emit(&OutMsg {
          kind: "error".into(),
          text: None,
          message: Some(format!("未知帧头: {:?}", tag)),
        });
      }
    }
  }
}
