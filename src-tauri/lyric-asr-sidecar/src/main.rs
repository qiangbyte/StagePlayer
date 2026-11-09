//! StagePlayer 歌词跟词 ASR sidecar。
//! 协议（stdin 二进制帧 / stdout JSON 行）：
//!   INIT + u32_le(len) + utf8 JSON {encoder,decoder,tokens}
//!   AUD0 + u32_le(n) + n * f32_le
//!   STOP
//! stdout: {"kind":"ready"|"partial"|"endpoint"|"error", ...}
use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};
use std::process;

#[derive(Deserialize)]
struct InitMsg {
  encoder: String,
  decoder: String,
  tokens: String,
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

fn main() {
  let mut stdin = io::stdin().lock();
  let mut tag = [0u8; 4];
  let mut recognizer: Option<sherpa_onnx::OnlineRecognizer> = None;
  let mut stream: Option<sherpa_onnx::OnlineStream> = None;
  let mut last_text = String::new();

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
        let mut cfg = sherpa_onnx::OnlineRecognizerConfig::default();
        cfg.model_config.paraformer.encoder = Some(init.encoder);
        cfg.model_config.paraformer.decoder = Some(init.decoder);
        cfg.model_config.tokens = Some(init.tokens);
        cfg.model_config.num_threads = 2;
        cfg.model_config.provider = Some("cpu".into());
        cfg.enable_endpoint = true;
        cfg.decoding_method = Some("greedy_search".into());
        match sherpa_onnx::OnlineRecognizer::create(&cfg) {
          Some(r) => {
            stream = Some(r.create_stream());
            recognizer = Some(r);
            last_text.clear();
            emit(&OutMsg {
              kind: "ready".into(),
              text: None,
              message: Some("ASR sidecar 就绪".into()),
            });
          }
          None => {
            emit(&OutMsg {
              kind: "error".into(),
              text: None,
              message: Some("创建 OnlineRecognizer 失败".into()),
            });
            process::exit(3);
          }
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
        let (Some(rec), Some(st)) = (recognizer.as_ref(), stream.as_ref()) else {
          continue;
        };
        if samples.is_empty() {
          continue;
        }
        st.accept_waveform(16_000i32, &samples);
        while rec.is_ready(st) {
          rec.decode(st);
        }
        if let Some(result) = rec.get_result(st) {
          let text = result.text.trim().to_string();
          if !text.is_empty() && text != last_text {
            last_text = text.clone();
            emit(&OutMsg {
              kind: "partial".into(),
              text: Some(text),
              message: None,
            });
          }
        }
        if rec.is_endpoint(st) {
          rec.reset(st);
          last_text.clear();
          emit(&OutMsg {
            kind: "endpoint".into(),
            text: None,
            message: None,
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
