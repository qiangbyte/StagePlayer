//! 歌词自动跟词：主领干声 → FunASR-Nano（歌词/说唱优化，VAD 模拟流式）
//! → 拼音模糊匹配 + 长音去抖 + 换气电平抢跑。
//! 若 FunASR 未就绪则回退 Online Paraformer。
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Sample, SampleFormat, StreamConfig};
use parking_lot::Mutex;
use pinyin::ToPinyin;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(test)]
#[path = "lyric_follow_replay.rs"]
mod replay_tests;

const TARGET_SR: u32 = 16_000;

// ── FunASR-Nano（跟词主模型：声明支持歌词/说唱）──
const FUNASR_DIR_NAME: &str = "funasr-nano-int8";
const FUNASR_ARCHIVE: &str = "sherpa-onnx-funasr-nano-int8-2025-12-30.tar.bz2";
const FUNASR_ARCHIVE_INNER: &str = "sherpa-onnx-funasr-nano-int8-2025-12-30";
const FUNASR_ARCHIVE_URLS: &[&str] = &[
  "https://gh-proxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-funasr-nano-int8-2025-12-30.tar.bz2",
  "https://ghfast.top/https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-funasr-nano-int8-2025-12-30.tar.bz2",
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-funasr-nano-int8-2025-12-30.tar.bz2",
];
const FUNASR_MIN_FILES: &[(&str, u64)] = &[
  ("embedding.int8.onnx", 80 * 1024 * 1024),
  ("encoder_adaptor.int8.onnx", 100 * 1024 * 1024),
  ("llm.int8.onnx", 200 * 1024 * 1024),
];
const FUNASR_TOKENIZER_MARK: &str = "Qwen3-0.6B/tokenizer.json";
const VAD_NAME: &str = "silero_vad.onnx";
const VAD_MIN_BYTES: u64 = 200 * 1024;
const VAD_URLS: &[&str] = &[
  "https://gh-proxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
  "https://ghfast.top/https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
];

// ── Online Paraformer（回退 / 兼容旧缓存）──
const MODEL_DIR_NAME: &str = "streaming-paraformer-zh-en";
const ARCHIVE_NAME: &str = "sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2";
const ARCHIVE_INNER: &str = "sherpa-onnx-streaming-paraformer-bilingual-zh-en";
const ARCHIVE_URLS: &[&str] = &[
  "https://gh-proxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2",
  "https://ghfast.top/https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2",
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2",
];
const FILE_URLS: &[(&str, &[&str])] = &[
  (
    "encoder.int8.onnx",
    &[
      "https://www.modelscope.cn/models/pengzhendong/sherpa-onnx-streaming-paraformer-bilingual-zh-en/resolve/master/encoder.int8.onnx",
      "https://hf-mirror.com/csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en/resolve/main/encoder.int8.onnx",
    ],
  ),
  (
    "decoder.int8.onnx",
    &[
      "https://www.modelscope.cn/models/pengzhendong/sherpa-onnx-streaming-paraformer-bilingual-zh-en/resolve/master/decoder.int8.onnx",
      "https://hf-mirror.com/csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en/resolve/main/decoder.int8.onnx",
    ],
  ),
  (
    "tokens.txt",
    &[
      "https://www.modelscope.cn/models/pengzhendong/sherpa-onnx-streaming-paraformer-bilingual-zh-en/resolve/master/tokens.txt",
      "https://hf-mirror.com/csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en/resolve/main/tokens.txt",
    ],
  ),
];
const FILES: &[&str] = &["encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt"];
const MIN_FILE_BYTES: &[(&str, u64)] = &[
  ("encoder.int8.onnx", 50 * 1024 * 1024),
  ("decoder.int8.onnx", 20 * 1024 * 1024),
  ("tokens.txt", 10 * 1024),
];

static APP: OnceLock<AppHandle> = OnceLock::new();

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricLineIn {
  pub text: String,
  pub song_id: u32,
  #[serde(default)]
  pub is_title: bool,
  /// 段落类型：chorus / verse / bridge / pre / ending / …
  #[serde(default)]
  pub section_type: String,
}


#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowEvent {
  pub kind: String,
  pub message: String,
  pub text: Option<String>,
  pub index: Option<usize>,
  pub preview: Option<usize>,
  pub rms_db: Option<f32>,
  pub percent: Option<f32>,
  pub busy: bool,
}

/// 供定稿模块推送讲话事件
pub fn emit_dictation_pub(ev: FollowEvent) {
  emit_dictation(ev);
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrModelStatus {
  pub ready: bool,
  pub path: String,
  pub message: String,
}

struct FollowSession {
  stop: Arc<AtomicBool>,
  tx: Sender<WorkerMsg>,
}

pub struct LyricFollowHandle {
  session: Mutex<Option<FollowSession>>,
}

impl LyricFollowHandle {
  pub fn new() -> Self {
    Self {
      session: Mutex::new(None),
    }
  }
}

enum WorkerMsg {
  /// vocal → ASR；ref_db 为可选参考声道电平（Click/鼓组等，不进 ASR）
  Audio {
    vocal: Vec<f32>,
    ref_db: Option<f32>,
  },
  Sync(usize),
  Stop,
}

fn emit(ev: FollowEvent) {
  if let Some(app) = APP.get() {
    let _ = app.emit("sp-lyric-follow", &ev);
    // 精修模型下载进度也推到讲话记录频道
    if ev.kind == "download" {
      let _ = app.emit("sp-dictation", &ev);
    }
  }
}

fn emit_dictation(ev: FollowEvent) {
  if let Some(app) = APP.get() {
    let _ = app.emit("sp-dictation", &ev);
  }
}

// ───────────────────────── 跟词引擎 ─────────────────────────
//
// 思路：把歌词和识别结果都拆成「一个字一个拼音音节」，用局部对齐（Smith-Waterman）
// 找出主领「最新唱到的那个字」落在哪一行、第几个字：
//   - 当前行唱过一半 → 预告下一句（armed，输出屏亮出下一句）
//   - 当前行唱到 ~75%，或唱过 65% 后换气 / 断句 → 提前翻到下一句
//   - 已经唱进后面的行（翻慢了）→ 直接追上
//   - 只往后看几行，中段不往回跳：重复的副歌不会被前面同样的句子抢走
//   - 末句后再唱：可循环回本曲开头；对齐窗口会临时带上开头几句以便接上
//   - 一直有人声却对不上 → 按字数估时长往下推进（跟丢兜底），对上后自动接回

/// 一个字的拼音，拆成声母 / 韵母，便于模糊比较
#[derive(Clone, Debug, PartialEq)]
struct Syl {
  ini: &'static str,
  fin: String,
}

const INITIALS: &[&str] = &[
  "zh", "ch", "sh", "b", "p", "m", "f", "d", "t", "n", "l", "g", "k", "h", "j", "q", "x", "r", "z",
  "c", "s", "y", "w",
];

fn split_syl(py: &str) -> Syl {
  for ini in INITIALS {
    if let Some(rest) = py.strip_prefix(ini) {
      if !rest.is_empty() {
        return Syl { ini, fin: rest.to_string() };
      }
    }
  }
  Syl { ini: "", fin: py.to_string() }
}

/// 平翘舌、n/l/r、f/h、零声母 y/w（唱歌和方言口音常见）
fn loose_ini(i: &str) -> &str {
  match i {
    "zh" => "z",
    "ch" => "c",
    "sh" => "s",
    "l" | "r" => "n",
    "f" => "h",
    "y" | "w" => "",
    other => other,
  }
}

/// 声母族：清浊 / 送气成对，唱歌时 ASR 常互换
fn ini_family(i: &str) -> u8 {
  match loose_ini(i) {
    "" => 0,
    "b" | "p" => 1,
    "d" | "t" => 2,
    "g" | "k" | "h" => 3,
    "j" | "q" | "x" => 4,
    "z" | "c" | "s" => 5,
    "n" => 6,
    "m" => 7,
    other => {
      // 未知声母：用首字节区分，避免全并成一类
      other.as_bytes().first().copied().unwrap_or(99)
    }
  }
}

fn loose_fin(f: &str) -> String {
  // 前后鼻音、儿化残留
  let f = f.trim_end_matches('r');
  match f {
    "ang" | "an" => "an".into(),
    "eng" | "en" => "en".into(),
    "ing" | "in" => "in".into(),
    "ong" | "ung" => "ong".into(),
    "iang" | "ian" => "ian".into(),
    "uang" | "uan" => "uan".into(),
    "iong" => "iong".into(),
    "uo" | "o" => "o".into(),
    "ue" | "ve" | "üe" => "ue".into(),
    "iu" | "ou" => "ou".into(),
    "ui" | "uei" | "ei" => "ei".into(),
    "un" | "uen" | "vun" | "vn" | "ün" => "un".into(),
    "ü" | "v" => "u".into(),
    other => other.to_string(),
  }
}

/// 韵母是否像「同一拉长音」：相等，或一个是另一个的核/前缀
fn fin_compatible(a: &str, b: &str) -> bool {
  let la = loose_fin(a);
  let lb = loose_fin(b);
  if la == lb {
    return true;
  }
  if la.is_empty() || lb.is_empty() {
    return false;
  }
  // ang→a、ao→a、ai→a、ou→o、ei→e、ong→o
  la.starts_with(&lb) || lb.starts_with(&la)
}

/// 0..1：两个字读音有多像（唱歌错字友好）
fn syl_sim(a: &Syl, b: &Syl) -> f32 {
  if a == b {
    return 1.0;
  }
  let ia = loose_ini(a.ini);
  let ib = loose_ini(b.ini);
  let fa = loose_fin(&a.fin);
  let fb = loose_fin(&b.fin);
  let ini_eq = ia == ib;
  let ini_fam = ini_family(a.ini) == ini_family(b.ini);
  let fin_eq = fa == fb;
  let fin_soft = fin_eq || fin_compatible(&a.fin, &b.fin);

  if fin_eq && ini_eq {
    0.92
  } else if fin_eq && ini_fam {
    0.82
  } else if fin_soft && ini_eq {
    0.78
  } else if fin_soft && ini_fam {
    0.68
  } else if fin_eq {
    // 韵母对、声母差一截：仍有用（串音/口齿不清）
    0.55
  } else if fin_soft {
    0.42
  } else if ini_eq && !ia.is_empty() {
    // 同声母不同韵：弱相关（避免 an/ao 完全无关时乱加分）
    if fa.chars().next() == fb.chars().next() {
      0.38
    } else {
      0.22
    }
  } else if ini_fam && fa.chars().next() == fb.chars().next() {
    0.28
  } else {
    0.0
  }
}

/// 文本 → 音节序列（只取汉字；英文、标点、空格忽略）
fn to_syls(text: &str) -> Vec<Syl> {
  text
    .chars()
    .filter_map(|c| c.to_pinyin())
    .map(|p| split_syl(p.plain()))
    .collect()
}

/// 唱歌拉长音时 ASR 常把同一字拆成一串同韵母「伪字」，压缩后再对齐。
fn collapse_sung_syls(syls: &[Syl]) -> Vec<Syl> {
  let mut out: Vec<Syl> = Vec::with_capacity(syls.len());
  for s in syls {
    if let Some(prev) = out.last_mut() {
      let same_ini = loose_ini(prev.ini) == loose_ini(s.ini);
      let fam_ini = ini_family(prev.ini) == ini_family(s.ini);
      let same_fin = loose_fin(&prev.fin) == loose_fin(&s.fin);
      let soft_fin = fin_compatible(&prev.fin, &s.fin);

      // 完全同音 / 模糊同音重复
      if (same_ini || fam_ini) && (same_fin || soft_fin) {
        // 保留信息更完整的那个（有声母、韵母更长）
        if prev.ini.is_empty() && !s.ini.is_empty() {
          prev.ini = s.ini;
        }
        if s.fin.len() > prev.fin.len() {
          prev.fin = s.fin.clone();
        }
        continue;
      }
      // 拉长音：声母被吃掉，只剩韵母核（啊→a a a）
      if soft_fin && (s.ini.is_empty() || prev.ini.is_empty()) {
        if prev.ini.is_empty() && !s.ini.is_empty() {
          prev.ini = s.ini;
        }
        if s.fin.len() > prev.fin.len() {
          prev.fin = s.fin.clone();
        }
        continue;
      }
      // 连续「同韵核 + 弱声母」：zhāng → ā → áng 一类
      if soft_fin && fam_ini {
        continue;
      }
    }
    out.push(s.clone());
  }
  out
}

#[derive(Clone, Debug)]
struct LyricLine {
  song_id: u32,
  is_title: bool,
  syls: Vec<Syl>,
  text: String,
  section_type: String,
}

fn build_lines(raw: &[LyricLineIn]) -> Vec<LyricLine> {
  raw
    .iter()
    .map(|l| LyricLine {
      song_id: l.song_id,
      is_title: l.is_title,
      syls: if l.is_title { Vec::new() } else { to_syls(&l.text) },
      text: l.text.clone(),
      section_type: l.section_type.clone(),
    })
    .collect()
}

/// 只用识别结果最后这么多个字去对齐（更早的是已经翻过去的句子）
const SPOKEN_TAIL: usize = 30;
/// 往后最多看几行（快歌略大，见 align）
const LOOKAHEAD: usize = 5;
/// 对齐分数门槛（稍低：跟上稍快唱速 + 模糊拼音）
const MIN_SCORE: f32 = 1.55;
/// 跳过一行以上（唱漏 / 跳段）要求更高的分数，避免误跳
const SKIP_SCORE: f32 = 3.0;
/// 曲中「再来」回跳：需确认；极高分可一次落地
const BACK_JUMP_SCORE: f32 = 3.35;
const BACK_JUMP_STRONG: f32 = 3.9;
/// 唱过这个比例：输出屏预告下一句
const PREVIEW_AT: f32 = 0.32;
/// 唱过这个比例：直接翻到下一句（提前量；短句会更激进）
const FLIP_AT: f32 = 0.56;
/// 唱过这个比例后遇到换气 / 断句：翻到下一句
const BREATH_FLIP_AT: f32 = 0.40;
/// 换气判定：低于该电平持续一段时间
const BREATH_DB: f32 = -42.0;
const BREATH_MS: f32 = 160.0;
/// 有人声的判定电平（跟丢兜底只在有人声时计时，间奏不会乱翻）
const VOICE_DB: f32 = -40.0;
/// 参考活跃时：更严的人声门（防乐队串音当干声）
const VOICE_DB_WITH_REF: f32 = -34.0;
/// 串音灰区上限（有参考时此区间不当人声）
const BLEED_DB: f32 = -48.0;
/// 参考声道「有能量」电平
const REF_ACTIVE_DB: f32 = -42.0;
/// 参考声道判定为活跃所需累计毫秒
const REF_ACTIVE_MS: f32 = 120.0;

struct Align {
  line: usize,
  /// 该行已唱到第几个字（含），从 0 开始
  pos: usize,
  score: f32,
}

struct FlipperEngine {
  lines: Vec<LyricLine>,
  curr: usize,
  armed: Option<usize>,
  /// 当前行已唱比例 0..1
  progress: f32,
  /// 最近一次对上之后累计的人声时长（毫秒），用于跟丢兜底
  voiced_ms: f32,
  /// 当前连续低电平时长（毫秒），用于判定换气
  quiet_ms: f32,
  /// 开唱后至少对上过一次：之前（前奏、讲话）不做跟丢兜底
  heard: bool,
  /// 当前行是跟丢兜底推过来的（猜的）：允许被识别结果纠正回上一行
  guessed: bool,
  /// 唱速估计：>1 偏快；用于下调翻行阈值 / 行时长
  tempo_rate: f32,
  /// 曲中回跳候选：(行号, 连续确认次数)
  pending_back: Option<(usize, u8)>,
  /// 参考声道近期有能量（Click/鼓组/伴奏）
  ref_active: bool,
  ref_loud_ms: f32,
  /// 干声处于串音灰区的累计时间（有参考时）
  bleed_ms: f32,
}

impl FlipperEngine {
  fn new(lines: Vec<LyricLine>, start: usize) -> Self {
    let curr = start.min(lines.len().saturating_sub(1));
    Self {
      lines,
      curr,
      armed: None,
      progress: 0.0,
      voiced_ms: 0.0,
      quiet_ms: 0.0,
      heard: false,
      guessed: false,
      tempo_rate: 1.0,
      pending_back: None,
      ref_active: false,
      ref_loud_ms: 0.0,
      bleed_ms: 0.0,
    }
  }

  /// <1 = 更快翻行 / 更短跟丢时限
  fn tempo_scale(&self) -> f32 {
    if self.tempo_rate >= 1.4 {
      0.74
    } else if self.tempo_rate >= 1.2 {
      0.84
    } else if self.tempo_rate >= 1.08 {
      0.92
    } else {
      1.0
    }
  }

  fn note_tempo_advance(&mut self, dp: f32) {
    // 单次跨度过大多半是对齐追赶，不当作唱速
    if !(0.03..=0.2).contains(&dp) {
      return;
    }
    let sample = (dp * 5.5).clamp(0.65, 1.65);
    self.tempo_rate = self.tempo_rate * 0.78 + sample * 0.22;
  }

  fn lookahead(&self) -> usize {
    if self.tempo_rate >= 1.2 {
      LOOKAHEAD + 1
    } else {
      LOOKAHEAD
    }
  }

  /// 从 curr 起（含）是否还有与 line 相同歌词的其它实例
  fn has_forward_duplicate(&self, line: usize) -> bool {
    let Some(t) = self.lines.get(line).map(|l| l.text.as_str()) else {
      return false;
    };
    if t.is_empty() {
      return false;
    }
    (self.curr..self.lines.len())
      .any(|i| i != line && !self.lines[i].is_title && self.lines[i].text == t)
  }

  /// 跳到某行并落地进度；整句已对上时不立刻翻走
  fn land_on(&mut self, target: usize, p: f32, reason: &str) {
    self.jump_to(target, reason);
    let flip = self.flip_threshold();
    if p >= flip {
      self.progress = (flip - 0.06).clamp(0.35, 0.58);
      self.voiced_ms = 0.0;
      if let Some(n) = self.next_or_loop() {
        self.armed = Some(n);
      }
    } else {
      self.set_progress(p);
    }
  }

  fn next_index(&self) -> Option<usize> {
    let cur_song = self.lines.get(self.curr)?.song_id;
    (self.curr + 1..self.lines.len())
      .find(|&i| !self.lines[i].is_title)
      .filter(|&i| self.lines[i].song_id == cur_song)
  }

  /// 本曲第一句可唱行（跳过标题）
  fn first_index(&self) -> Option<usize> {
    let cur_song = self.lines.get(self.curr)?.song_id;
    self.lines
      .iter()
      .position(|l| l.song_id == cur_song && !l.is_title)
  }

  /// 下一句；已到末句则循环回本曲开头（反复唱）
  fn next_or_loop(&self) -> Option<usize> {
    if let Some(n) = self.next_index() {
      return Some(n);
    }
    let first = self.first_index()?;
    if first != self.curr {
      Some(first)
    } else {
      None
    }
  }

  /// 是否已到本曲末句（后面没有同曲可唱行）
  fn at_song_end(&self) -> bool {
    self.next_index().is_none()
  }

  fn is_section_start(&self, li: usize) -> bool {
    let Some(l) = self.lines.get(li) else {
      return false;
    };
    if l.is_title || l.syls.is_empty() {
      return false;
    }
    if li == 0 {
      return true;
    }
    let prev = &self.lines[li - 1];
    prev.is_title || prev.section_type != l.section_type
  }

  /// 把识别结果末尾对齐到「上一行（只作上下文）+ 当前行 + 后面几行」
  /// 末句 / 同段更早实例：附带回跳候选，方便「再唱一遍」。
  fn align(&self, spoken: &[Syl]) -> Option<Align> {
    let cur_song = self.lines.get(self.curr)?.song_id;
    let from = if self.curr > 0 && self.lines[self.curr - 1].song_id == cur_song {
      self.curr - 1
    } else {
      self.curr
    };
    // 目标串：(行号, 行内位置, 音节)
    let mut target: Vec<(usize, usize, &Syl)> = Vec::new();
    let mut shown = 0;
    let look = self.lookahead();
    for li in from..self.lines.len() {
      let l = &self.lines[li];
      if l.song_id != cur_song {
        break;
      }
      if li > self.curr {
        shown += 1;
        if shown > look {
          break;
        }
      }
      for (k, s) in l.syls.iter().enumerate() {
        target.push((li, k, s));
      }
    }
    // 仅真正末句才把开头接进窗口（避免倒数第二句把第一次副歌拼进来误匹配）
    if self.at_song_end() {
      if let Some(first) = self.first_index() {
        let mut head = 0;
        for li in first..self.curr {
          let l = &self.lines[li];
          if l.song_id != cur_song {
            break;
          }
          if l.is_title || l.syls.is_empty() {
            continue;
          }
          head += 1;
          if head > look + 1 {
            break;
          }
          for (k, s) in l.syls.iter().enumerate() {
            target.push((li, k, s));
          }
        }
      }
    }
    // 曲中「再来」：同 section 更早的段首（及下一句）进窗口
    let cur_sec = self.lines[self.curr].section_type.clone();
    if !cur_sec.is_empty() && !self.at_song_end() {
      let mut instances = 0usize;
      let mut li = self.curr;
      while li > 0 && instances < 3 {
        li -= 1;
        let l = &self.lines[li];
        if l.song_id != cur_song || l.is_title || l.syls.is_empty() {
          continue;
        }
        if l.section_type != cur_sec || !self.is_section_start(li) {
          continue;
        }
        for (k, s) in l.syls.iter().enumerate() {
          target.push((li, k, s));
        }
        if let Some(n) = (li + 1..self.curr).find(|&j| {
          !self.lines[j].is_title
            && !self.lines[j].syls.is_empty()
            && self.lines[j].song_id == cur_song
            && self.lines[j].section_type == cur_sec
        }) {
          for (k, s) in self.lines[n].syls.iter().enumerate() {
            target.push((n, k, s));
          }
        }
        instances += 1;
      }
    }
    if target.is_empty() || spoken.is_empty() {
      return None;
    }
    const GAP: f32 = 0.65;
    let n = spoken.len();
    let m = target.len();
    let mut prev = vec![0f32; m + 1];
    let mut cur = vec![0f32; m + 1];
    for i in 1..=n {
      cur[0] = 0.0;
      for j in 1..=m {
        let sub = 2.0 * syl_sim(&spoken[i - 1], target[j - 1].2) - 1.0;
        cur[j] = (prev[j - 1] + sub)
          .max(prev[j] - GAP)
          .max(cur[j - 1] - GAP)
          .max(0.0);
      }
      std::mem::swap(&mut prev, &mut cur);
    }
    // 调整分：前方行加分；「后面还有相同歌词」的早实例重罚（副歌消歧）
    let mut best_j = 0;
    let mut best = f32::NEG_INFINITY;
    for j in 1..=m {
      let (line, _, _) = target[j - 1];
      let mut adj = prev[j];
      if line >= self.curr {
        adj += 0.45;
        if line == self.curr {
          adj += 0.15;
        } else if Some(line) == self.next_index() {
          adj += 0.08;
        }
      } else {
        adj -= 0.2;
        if self.has_forward_duplicate(line) {
          adj -= 0.85; // 第二次副歌时不要吸回第一次
        }
      }
      if adj > best + 1e-4 {
        best = adj;
        best_j = j;
      } else if (adj - best).abs() <= 0.12 && best_j > 0 {
        let (bl, _, _) = target[best_j - 1];
        let prefer = match (line >= self.curr, bl >= self.curr) {
          (true, false) => true,
          (false, true) => false,
          (true, true) => line < bl,
          (false, false) => line > bl,
        };
        if prefer {
          best = adj;
          best_j = j;
        }
      }
    }
    if best_j == 0 {
      return None;
    }
    let (line, pos, _) = target[best_j - 1];
    // 对外仍用原始 SW 分，避免门槛被 bonus 抬歪
    Some(Align {
      line,
      pos,
      score: prev[best_j],
    })
  }

  fn on_asr_partial(&mut self, spoken: &str) {
    let Some(curr_line) = self.lines.get(self.curr).cloned() else {
      return;
    };

    // 主领 / 导播口令
    if spoken.contains("从头") || spoken.contains("第一段") {
      let song = curr_line.song_id;
      if let Some(pos) = self.lines.iter().position(|l| l.song_id == song && !l.is_title) {
        if pos != self.curr {
          self.jump_to(pos, "主领口令：跳回本曲开头");
          return;
        }
      }
    }
    if spoken.contains("再来") || spoken.contains("再唱") || spoken.contains("重来") {
      if let Some(pos) = self.prev_section_start() {
        if pos != self.curr {
          self.jump_to(pos, "口令：再来 → 上一段开头");
          return;
        }
      }
    }
    if spoken.contains("副歌") {
      if let Some(pos) = self.nearest_section_start("chorus", true) {
        if pos != self.curr {
          self.jump_to(pos, "口令：跳副歌");
          return;
        }
      }
    }

    let all = collapse_sung_syls(&to_syls(spoken));
    let tail = &all[all.len().saturating_sub(SPOKEN_TAIL)..];
    if let Some(a) = self.align(tail) {
      if a.score >= MIN_SCORE {
        self.heard = true;
      }
      if a.line < self.curr {
        let len = self.lines[a.line].syls.len().max(1);
        let p = (a.pos + 1) as f32 / len as f32;
        // 有前方同文实例时，禁止弱回跳（副歌消歧）
        let blocked_dup = self.has_forward_duplicate(a.line) && a.score < BACK_JUMP_STRONG;
        if self.guessed && a.score >= MIN_SCORE && p < 0.85 {
          self.pending_back = None;
          self.land_on(a.line, p, "兜底推快了：退回主领所在行");
        } else if self.at_song_end() && a.score >= MIN_SCORE {
          self.pending_back = None;
          self.land_on(a.line, p, "再唱一遍：回到匹配句");
        } else if blocked_dup {
          self.pending_back = None;
        } else if a.score >= BACK_JUMP_SCORE {
          let is_sec = self.is_section_start(a.line);
          let need = if a.score >= BACK_JUMP_STRONG && is_sec {
            1
          } else if is_sec {
            2
          } else {
            2
          };
          let cnt = match self.pending_back {
            Some((l, c)) if l == a.line => c.saturating_add(1),
            _ => 1,
          };
          self.pending_back = Some((a.line, cnt));
          if cnt >= need {
            self.pending_back = None;
            self.land_on(a.line, p, "高分回跳：疑似再来/副歌");
          }
        } else {
          self.pending_back = None;
        }
      } else if a.line > self.curr {
        self.pending_back = None;
        let fast = self.tempo_rate >= 1.1;
        let need = if Some(a.line) == self.next_index() {
          MIN_SCORE
        } else if fast {
          (SKIP_SCORE - 0.45).max(MIN_SCORE + 0.35)
        } else {
          SKIP_SCORE
        };
        if a.score >= need {
          let len = self.lines[a.line].syls.len().max(1);
          let p = (a.pos + 1) as f32 / len as f32;
          self.land_on(a.line, p, "已唱到这一句：追上");
        }
      } else if a.line == self.curr && a.score >= MIN_SCORE {
        self.pending_back = None;
        let len = curr_line.syls.len().max(1);
        let p = (a.pos + 1) as f32 / len as f32;
        if p > self.progress {
          self.note_tempo_advance(p - self.progress);
          self.set_progress(p);
        } else if p + 0.18 < self.progress
          && self.progress < self.flip_threshold() * 0.94
          && a.score >= MIN_SCORE + 0.3
        {
          self.progress = p;
          self.armed = None;
          self.voiced_ms = 0.0;
        }
        self.voiced_ms = 0.0;
      }
    }

    emit(FollowEvent {
      kind: "partial".into(),
      message: "识别中".into(),
      text: Some(spoken.to_string()),
      index: Some(self.curr),
      preview: self.armed,
      rms_db: None,
      percent: Some((self.progress * 100.0).clamp(0.0, 100.0)),
      busy: true,
    });
  }

  /// 当前段或更早：同 type 最近段首；prefer_back=true 时优先当前之前
  fn nearest_section_start(&self, sec: &str, prefer_back: bool) -> Option<usize> {
    let song = self.lines.get(self.curr)?.song_id;
    let mut best: Option<usize> = None;
    for (i, l) in self.lines.iter().enumerate() {
      if l.song_id != song || l.is_title || l.section_type != sec || !self.is_section_start(i) {
        continue;
      }
      if prefer_back {
        if i <= self.curr {
          best = Some(i);
        } else if best.is_none() {
          best = Some(i);
        }
      } else if i >= self.curr {
        return Some(i);
      } else {
        best = Some(i);
      }
    }
    best
  }

  fn prev_section_start(&self) -> Option<usize> {
    let song = self.lines.get(self.curr)?.song_id;
    let mut prev = None;
    for i in 0..=self.curr {
      if self.lines[i].song_id == song && self.is_section_start(i) {
        if i < self.curr {
          prev = Some(i);
        } else if prev.is_none() {
          prev = Some(i);
        }
      }
    }
    prev
  }

  fn flip_threshold(&self) -> f32 {
    let n = self.lines.get(self.curr).map(|l| l.syls.len()).unwrap_or(6);
    let base = if n <= 3 {
      0.42
    } else if n <= 5 {
      0.48
    } else if n <= 8 {
      FLIP_AT
    } else {
      0.62
    };
    (base * self.tempo_scale()).clamp(0.36, 0.70)
  }

  fn set_progress(&mut self, p: f32) {
    self.progress = p;
    self.voiced_ms = 0.0;
    if p >= self.flip_threshold() {
      if let Some(n) = self.next_or_loop() {
        let wrap = self.at_song_end();
        self.jump_to(
          n,
          if wrap {
            "末句唱完：循环回开头"
          } else {
            "快唱完这一句：提前翻下一句"
          },
        );
      }
      return;
    }
    let preview_at = (PREVIEW_AT * self.tempo_scale()).clamp(0.28, PREVIEW_AT);
    if p >= preview_at && self.armed.is_none() {
      if let Some(n) = self.next_or_loop() {
        self.armed = Some(n);
        let wrap = self.at_song_end();
        emit(FollowEvent {
          kind: "armed".into(),
          message: if wrap {
            "末句过半：预告回开头".into()
          } else {
            "已唱过半：预告下一句".into()
          },
          text: Some(self.lines[n].text.clone()),
          index: Some(self.curr),
          preview: Some(n),
          rms_db: None,
          percent: Some(p * 100.0),
          busy: true,
        });
      }
    }
  }

  /// sidecar 断句（通常是一口气唱完、换气停顿）
  fn on_endpoint(&mut self) {
    let breath_at = (BREATH_FLIP_AT * self.tempo_scale()).clamp(0.32, BREATH_FLIP_AT);
    if self.progress >= breath_at {
      if let Some(n) = self.next_or_loop() {
        let wrap = self.at_song_end();
        self.jump_to(
          n,
          if wrap {
            "末句断句：循环回开头"
          } else {
            "断句：翻下一句"
          },
        );
      }
    }
  }

  /// 参考声道能量：间奏判定 + 收紧跟丢兜底
  fn on_ref_energy(&mut self, ref_db: Option<f32>, ms: f32) {
    match ref_db {
      Some(db) if db > REF_ACTIVE_DB => {
        self.ref_loud_ms = (self.ref_loud_ms + ms).min(6000.0);
        self.ref_active = self.ref_loud_ms >= REF_ACTIVE_MS;
      }
      _ => {
        self.ref_loud_ms = (self.ref_loud_ms - ms * 2.8).max(0.0);
        if self.ref_loud_ms < 60.0 {
          self.ref_active = false;
        }
      }
    }
  }

  /// 每块麦克风音频调用一次：rms 电平 + 该块时长（毫秒）
  fn on_rms(&mut self, rms_db: f32, ms: f32) {
    let breath_at = (BREATH_FLIP_AT * self.tempo_scale()).clamp(0.28, BREATH_FLIP_AT);
    let voice_gate = if self.ref_active {
      VOICE_DB_WITH_REF
    } else {
      VOICE_DB
    };

    // 有参考时：中等电平当串音，不计人声、不换气翻
    if self.ref_active && rms_db >= BLEED_DB && rms_db <= voice_gate {
      self.bleed_ms = (self.bleed_ms + ms).min(4000.0);
      self.quiet_ms = 0.0;
      return;
    }
    self.bleed_ms = (self.bleed_ms - ms).max(0.0);

    if rms_db < BREATH_DB {
      // 干声静、参考仍响 → 间奏；进度不高时绝不换气翻
      if self.ref_active && self.progress < (breath_at + 0.12).min(0.55) {
        self.quiet_ms = 0.0;
      } else {
        self.quiet_ms += ms;
        if self.quiet_ms >= BREATH_MS && self.progress >= breath_at {
          if let Some(n) = self.next_or_loop() {
            let wrap = self.at_song_end();
            self.jump_to(
              n,
              if wrap {
                "末句换气：循环回开头"
              } else {
                "换气：提前翻下一句"
              },
            );
            return;
          }
        }
      }
    } else {
      self.quiet_ms = 0.0;
    }

    if rms_db > voice_gate {
      // 参考活跃且尚未对上过：前奏/过门，不跟丢推进
      if self.ref_active && !self.heard {
        return;
      }
      self.voiced_ms += ms;
      let mut limit = self.est_line_ms(self.curr) * 1.55;
      if self.ref_active {
        limit *= 1.65; // 有参考轨时明显少瞎推
      }
      if self.bleed_ms > 400.0 {
        limit *= 1.2;
      }
      if self.heard && self.voiced_ms > limit {
        if let Some(n) = self.next_or_loop() {
          let wrap = self.at_song_end();
          self.jump_to(
            n,
            if wrap {
              "末句跟丢：循环回开头"
            } else {
              "跟丢兜底：按时长推进"
            },
          );
          self.guessed = true;
        } else {
          self.voiced_ms = 0.0;
        }
      }
    }
  }

  /// 按字数估一句大概唱多久（偏快：跟上稍快唱速的跟丢兜底）
  fn est_line_ms(&self, i: usize) -> f32 {
    let chars = self.lines.get(i).map(|l| l.syls.len()).unwrap_or(0) as f32;
    let base = (980.0 + chars * 240.0).clamp(1200.0, 6500.0);
    (base * self.tempo_scale()).clamp(900.0, 6500.0)
  }

  fn jump_to(&mut self, target: usize, reason: &str) {
    if target >= self.lines.len() || target == self.curr {
      return;
    }
    self.curr = target;
    self.armed = None;
    self.progress = 0.0;
    self.voiced_ms = 0.0;
    self.quiet_ms = 0.0;
    self.bleed_ms = 0.0;
    self.guessed = false;
    self.pending_back = None;
    emit(FollowEvent {
      kind: "jump".into(),
      message: reason.into(),
      text: Some(self.lines[target].text.clone()),
      index: Some(target),
      preview: self.next_or_loop().filter(|&i| i != target),
      rms_db: None,
      percent: Some(0.0),
      busy: true,
    });
  }

  fn sync(&mut self, idx: usize) {
    if idx < self.lines.len() {
      self.curr = idx;
      self.armed = None;
      self.progress = 0.0;
      self.voiced_ms = 0.0;
      self.quiet_ms = 0.0;
      self.bleed_ms = 0.0;
      self.guessed = false;
      self.heard = false;
      self.pending_back = None;
      self.tempo_rate = 1.0;
    }
  }
}

fn asr_root(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app
    .path()
    .app_cache_dir()
    .map_err(|e| e.to_string())?
    .join("asr-models");
  fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  Ok(dir)
}

/// FunASR-Nano 模型目录（跟词主路径）
fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = asr_root(app)?.join(FUNASR_DIR_NAME);
  fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  Ok(dir)
}

/// 旧版流式 Paraformer（回退）
fn paraformer_dir(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = asr_root(app)?.join(MODEL_DIR_NAME);
  fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  Ok(dir)
}

fn paraformer_ready(dir: &Path) -> bool {
  MIN_FILE_BYTES.iter().all(|(name, min)| {
    let p = dir.join(name);
    p.is_file() && p.metadata().map(|m| m.len()).unwrap_or(0) >= *min
  })
}

fn funasr_ready(dir: &Path) -> bool {
  let files_ok = FUNASR_MIN_FILES.iter().all(|(name, min)| {
    let p = dir.join(name);
    p.is_file() && p.metadata().map(|m| m.len()).unwrap_or(0) >= *min
  });
  let tok = dir.join(FUNASR_TOKENIZER_MARK);
  let vad = dir.join(VAD_NAME);
  files_ok
    && tok.is_file()
    && tok.metadata().map(|m| m.len()).unwrap_or(0) > 1024
    && vad.is_file()
    && vad.metadata().map(|m| m.len()).unwrap_or(0) >= VAD_MIN_BYTES
}

pub fn init_bridge(app: AppHandle) {
  let _ = APP.set(app);
}

#[tauri::command]
pub fn lyric_asr_status(app: AppHandle) -> Result<AsrModelStatus, String> {
  let dir = models_dir(&app)?;
  let ready = funasr_ready(&dir);
  let para = paraformer_dir(&app).ok();
  let para_ok = para.as_ref().map(|p| paraformer_ready(p)).unwrap_or(false);
  Ok(AsrModelStatus {
    ready: ready || para_ok,
    path: if ready {
      dir.to_string_lossy().into()
    } else {
      para
        .map(|p| p.to_string_lossy().into())
        .unwrap_or_else(|| dir.to_string_lossy().into())
    },
    message: if ready {
      "FunASR-Nano 歌词模型已就绪".into()
    } else if para_ok {
      "暂用流式 Paraformer（建议下载 FunASR-Nano 提升唱歌识别）".into()
    } else {
      "尚未下载 FunASR-Nano 歌词模型（约 1GB，首次需下载）".into()
    },
  })
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
  // 允许 ModelScope/CDN 跳转；禁止跟到 huggingface.co（常 401）
  reqwest::blocking::Client::builder()
    .redirect(reqwest::redirect::Policy::custom(|attempt| {
      let host = attempt.url().host_str().unwrap_or("");
      if host == "huggingface.co" || host.ends_with(".huggingface.co") {
        attempt.stop()
      } else {
        attempt.follow()
      }
    }))
    .connect_timeout(Duration::from_secs(20))
    // 单源单次下载最长 8 分钟；卡住就换源，避免「520/假进度」一直挂死
    .timeout(Duration::from_secs(8 * 60))
    .user_agent("StagePlayer/0.1 (ASR model fetch)")
    .build()
    .map_err(|e| e.to_string())
}

fn download_file(url: &str, dest: &Path, label: &str) -> Result<(), String> {
  let client = http_client()?;
  let tmp = dest.with_extension("part");
  let resp = client
    .get(url)
    .header("Accept", "*/*")
    .send()
    .map_err(|e| format!("下载失败: {e}"))?;
  let status = resp.status();
  if status.is_redirection() {
    let loc = resp
      .headers()
      .get(reqwest::header::LOCATION)
      .and_then(|v| v.to_str().ok())
      .unwrap_or("");
    if loc.contains("huggingface.co") {
      return Err(format!("镜像跳转到 HuggingFace（常 401），换源: {url}"));
    }
    return Err(format!("意外重定向 {status} → {loc}"));
  }
  let code = status.as_u16();
  // Cloudflare / 代理常见 520–527、502、503：立刻换源，不要干等
  if matches!(code, 520..=527 | 502 | 503 | 504 | 429) {
    return Err(format!("源站暂不可用 HTTP {code}，换源"));
  }
  if !status.is_success() {
    return Err(format!("HTTP {status} · {url}"));
  }
  let total = resp.content_length().unwrap_or(0);
  let mut resp = resp;
  let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
  let mut buf = [0u8; 64 * 1024];
  let mut done = 0u64;
  let mut last = Instant::now() - Duration::from_secs(1);
  loop {
    let n = resp.read(&mut buf).map_err(|e| e.to_string())?;
    if n == 0 {
      break;
    }
    file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
    done += n as u64;
    if last.elapsed() >= Duration::from_millis(250) {
      last = Instant::now();
      let pct = if total > 0 {
        (done as f32 / total as f32 * 100.0).clamp(0.0, 99.5)
      } else {
        0.0
      };
      emit(FollowEvent {
        kind: "download".into(),
        message: format!(
          "下载 {label} · {:.1}/{:.1} MB",
          done as f64 / 1e6,
          if total > 0 { total as f64 / 1e6 } else { done as f64 / 1e6 }
        ),
        text: None,
        index: None,
        preview: None,
        rms_db: None,
        percent: Some(pct),
        busy: true,
      });
    }
  }
  file.flush().map_err(|e| e.to_string())?;
  drop(file);
  if done < 1024 {
    let _ = fs::remove_file(&tmp);
    return Err(format!("下载内容过小（{done} bytes），源无效: {url}"));
  }
  if dest.exists() {
    let _ = fs::remove_file(dest);
  }
  fs::rename(&tmp, dest).map_err(|e| e.to_string())?;
  Ok(())
}

pub(crate) fn download_first_ok(urls: &[&str], dest: &Path, label: &str) -> Result<(), String> {
  let mut errors = Vec::new();
  for url in urls {
    emit(FollowEvent {
      kind: "download".into(),
      message: format!("尝试源：{label}"),
      text: None,
      index: None,
      preview: None,
      rms_db: None,
      percent: None,
      busy: true,
    });
    match download_file(url, dest, label) {
      Ok(()) => return Ok(()),
      Err(e) => {
        let _ = fs::remove_file(dest.with_extension("part"));
        errors.push(e);
      }
    }
  }
  Err(errors.join(" | "))
}

fn extract_archive_to(archive: &Path, dir: &Path) -> Result<(), String> {
  extract_archive_generic(archive, dir, ARCHIVE_INNER, FILES)
}

fn copy_dir_recursive(from: &Path, to: &Path) -> Result<(), String> {
  if from.is_file() {
    if let Some(parent) = to.parent() {
      fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::copy(from, to).map_err(|e| format!("复制失败 {}: {e}", from.display()))?;
    return Ok(());
  }
  fs::create_dir_all(to).map_err(|e| e.to_string())?;
  for e in fs::read_dir(from).map_err(|e| e.to_string())? {
    let e = e.map_err(|e| e.to_string())?;
    let name = e.file_name();
    if name == "test_wavs" || name == "_extract" {
      continue;
    }
    copy_dir_recursive(&e.path(), &to.join(name))?;
  }
  Ok(())
}

fn extract_funasr_archive(archive: &Path, dir: &Path) -> Result<(), String> {
  let staging = dir.join("_extract");
  let _ = fs::remove_dir_all(&staging);
  fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
  let mut tar = std::process::Command::new("tar");
  tar
    .args(["-xjf"])
    .arg(archive)
    .arg("-C")
    .arg(&staging)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::piped());
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    tar.creation_flags(CREATE_NO_WINDOW);
  }
  let status = tar
    .status()
    .map_err(|e| format!("无法调用 tar 解压: {e}"))?;
  if !status.success() {
    return Err(format!("tar 解压失败: {status}"));
  }
  let inner = staging.join(FUNASR_ARCHIVE_INNER);
  let root = if inner.is_dir() {
    inner
  } else {
    fs::read_dir(&staging)
      .map_err(|e| e.to_string())?
      .flatten()
      .map(|e| e.path())
      .find(|p| p.is_dir() && p.join("embedding.int8.onnx").is_file())
      .ok_or_else(|| "压缩包内找不到 FunASR-Nano 目录".to_string())?
  };
  for (name, _) in FUNASR_MIN_FILES {
    let from = root.join(name);
    if !from.is_file() {
      return Err(format!("压缩包缺少 {name}"));
    }
    let to = dir.join(name);
    let _ = fs::remove_file(&to);
    fs::copy(&from, &to).map_err(|e| format!("复制 {name} 失败: {e}"))?;
  }
  let tok_from = root.join("Qwen3-0.6B");
  if !tok_from.is_dir() {
    return Err("压缩包缺少 Qwen3-0.6B tokenizer 目录".into());
  }
  let tok_to = dir.join("Qwen3-0.6B");
  let _ = fs::remove_dir_all(&tok_to);
  copy_dir_recursive(&tok_from, &tok_to)?;
  let _ = fs::remove_dir_all(&staging);
  Ok(())
}

fn ensure_vad(dir: &Path) -> Result<(), String> {
  let dest = dir.join(VAD_NAME);
  if dest.is_file() && dest.metadata().map(|m| m.len()).unwrap_or(0) >= VAD_MIN_BYTES {
    return Ok(());
  }
  let _ = fs::remove_file(&dest);
  emit(FollowEvent {
    kind: "download".into(),
    message: "下载 Silero VAD（跟词切句）…".into(),
    text: None,
    index: None,
    preview: None,
    rms_db: None,
    percent: Some(0.0),
    busy: true,
  });
  download_first_ok(VAD_URLS, &dest, VAD_NAME)
}

/// 解压模型包并复制指定文件到目标目录
pub(crate) fn extract_archive_generic(
  archive: &Path,
  dir: &Path,
  inner_name: &str,
  files: &[&str],
) -> Result<(), String> {
  let staging = dir.join("_extract");
  let _ = fs::remove_dir_all(&staging);
  fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
  // Windows 10+ 自带 tar，可解 .tar.bz2（隐藏控制台）
  let mut tar = std::process::Command::new("tar");
  tar.args(["-xjf"])
    .arg(archive)
    .arg("-C")
    .arg(&staging)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::piped());
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    tar.creation_flags(CREATE_NO_WINDOW);
  }
  let status = tar
    .status()
    .map_err(|e| format!("无法调用 tar 解压: {e}"))?;
  if !status.success() {
    return Err(format!("tar 解压失败: {status}"));
  }
  let inner = staging.join(inner_name);
  let candidates: Vec<PathBuf> = if inner.is_dir() {
    vec![inner, staging.clone()]
  } else {
    let mut v = vec![staging.clone()];
    if let Ok(rd) = fs::read_dir(&staging) {
      for e in rd.flatten() {
        if e.path().is_dir() {
          v.push(e.path());
        }
      }
    }
    v
  };
  for name in files {
    let from = candidates
      .iter()
      .map(|r| r.join(name))
      .find(|p| p.is_file())
      .or_else(|| {
        // 有的包把 model.int8.onnx 放在子目录，再扫一层
        candidates.iter().find_map(|root| {
          if let Ok(rd) = fs::read_dir(root) {
            for e in rd.flatten() {
              let p = e.path().join(name);
              if p.is_file() {
                return Some(p);
              }
              if e.file_name().to_string_lossy() == *name && e.path().is_file() {
                return Some(e.path());
              }
            }
          }
          None
        })
      })
      .ok_or_else(|| format!("压缩包缺少 {name}"))?;
    let to = dir.join(name);
    if to.exists() {
      let _ = fs::remove_file(&to);
    }
    fs::copy(&from, &to).map_err(|e| format!("复制 {name} 失败: {e}"))?;
  }
  let _ = fs::remove_dir_all(&staging);
  Ok(())
}

fn ensure_paraformer_files(dir: &Path) -> Result<(), String> {
  if paraformer_ready(dir) {
    return Ok(());
  }
  let archive = dir.join(ARCHIVE_NAME);
  let archive_ok = archive.is_file()
    && archive.metadata().map(|m| m.len()).unwrap_or(0) > 100 * 1024 * 1024;
  if !archive_ok {
    let _ = fs::remove_file(&archive);
    emit(FollowEvent {
      kind: "download".into(),
      message: "下载回退用流式 Paraformer…".into(),
      text: None,
      index: None,
      preview: None,
      rms_db: None,
      percent: Some(0.0),
      busy: true,
    });
    let _ = download_first_ok(ARCHIVE_URLS, &archive, ARCHIVE_NAME);
  }
  if archive.is_file() && archive.metadata().map(|m| m.len()).unwrap_or(0) > 100 * 1024 * 1024 {
    let _ = extract_archive_to(&archive, dir);
    if paraformer_ready(dir) {
      return Ok(());
    }
  }
  let mut errs = Vec::new();
  for (name, urls) in FILE_URLS {
    let dest = dir.join(name);
    let min = MIN_FILE_BYTES
      .iter()
      .find(|(n, _)| *n == *name)
      .map(|(_, m)| *m)
      .unwrap_or(64);
    if dest.is_file() && dest.metadata().map(|m| m.len()).unwrap_or(0) >= min {
      continue;
    }
    if let Err(e) = download_first_ok(urls, &dest, name) {
      errs.push(format!("{name}: {e}"));
    }
  }
  if paraformer_ready(dir) {
    return Ok(());
  }
  Err(format!("Paraformer 下载失败: {}", errs.join("; ")))
}

fn ensure_model_files(dir: &Path) -> Result<(), String> {
  if funasr_ready(dir) {
    return Ok(());
  }
  // 1) FunASR-Nano 整包
  let archive = dir.join(FUNASR_ARCHIVE);
  let archive_ok = archive.is_file()
    && archive.metadata().map(|m| m.len()).unwrap_or(0) > 400 * 1024 * 1024;
  if !archive_ok {
    let _ = fs::remove_file(&archive);
    emit(FollowEvent {
      kind: "download".into(),
      message: "下载 FunASR-Nano 歌词模型（约 1GB，支持唱歌/说唱）…".into(),
      text: None,
      index: None,
      preview: None,
      rms_db: None,
      percent: Some(0.0),
      busy: true,
    });
    if let Err(e) = download_first_ok(FUNASR_ARCHIVE_URLS, &archive, FUNASR_ARCHIVE) {
      return Err(format!(
        "FunASR-Nano 下载失败: {e}\n可手动下载后放到：{}\n{}",
        dir.display(),
        FUNASR_ARCHIVE_URLS.last().unwrap_or(&"")
      ));
    }
  }
  if archive.is_file() && archive.metadata().map(|m| m.len()).unwrap_or(0) > 400 * 1024 * 1024 {
    emit(FollowEvent {
      kind: "download".into(),
      message: "正在解压 FunASR-Nano…".into(),
      text: None,
      index: None,
      preview: None,
      rms_db: None,
      percent: Some(92.0),
      busy: true,
    });
    extract_funasr_archive(&archive, dir)?;
  }
  ensure_vad(dir)?;
  if funasr_ready(dir) {
    return Ok(());
  }
  Err(format!(
    "FunASR-Nano 未就绪。请确认目录含 embedding/encoder_adaptor/llm、Qwen3-0.6B、silero_vad.onnx：{}",
    dir.display()
  ))
}

#[tauri::command]
pub async fn lyric_asr_ensure_model(app: AppHandle) -> Result<AsrModelStatus, String> {
  let dir = models_dir(&app)?;
  if funasr_ready(&dir) {
    return Ok(AsrModelStatus {
      ready: true,
      path: dir.to_string_lossy().into(),
      message: "FunASR-Nano 歌词模型已就绪".into(),
    });
  }
  emit(FollowEvent {
    kind: "download".into(),
    message: "开始下载 FunASR-Nano（约 1GB，GitHub 镜像优先）…".into(),
    text: None,
    index: None,
    preview: None,
    rms_db: None,
    percent: Some(0.0),
    busy: true,
  });
  let dir_bg = dir.clone();
  let fun_res = tauri::async_runtime::spawn_blocking(move || ensure_model_files(&dir_bg))
    .await
    .map_err(|e| e.to_string())?;
  if let Err(fun_err) = fun_res {
    // FunASR 失败时回退下载 Paraformer，保证跟词仍可用
    let para = paraformer_dir(&app)?;
    let para_bg = para.clone();
    emit(FollowEvent {
      kind: "download".into(),
      message: format!("FunASR 失败，改下 Paraformer 回退：{fun_err}"),
      text: None,
      index: None,
      preview: None,
      rms_db: None,
      percent: Some(0.0),
      busy: true,
    });
    tauri::async_runtime::spawn_blocking(move || ensure_paraformer_files(&para_bg))
      .await
      .map_err(|e| e.to_string())??;
    emit(FollowEvent {
      kind: "download".into(),
      message: "已就绪（Paraformer 回退）".into(),
      text: None,
      index: None,
      preview: None,
      rms_db: None,
      percent: Some(100.0),
      busy: false,
    });
    return Ok(AsrModelStatus {
      ready: true,
      path: para.to_string_lossy().into(),
      message: "暂用流式 Paraformer（FunASR 未装上）".into(),
    });
  }

  // 再确保 Paraformer，组成「实时+纠偏」混合跟词
  let para = paraformer_dir(&app)?;
  if !paraformer_ready(&para) {
    emit(FollowEvent {
      kind: "download".into(),
      message: "继续下载实时 Paraformer（混合跟词用）…".into(),
      text: None,
      index: None,
      preview: None,
      rms_db: None,
      percent: Some(0.0),
      busy: true,
    });
    let para_bg = para.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || ensure_paraformer_files(&para_bg))
      .await
      .map_err(|e| e.to_string())?;
  }

  let hybrid = paraformer_ready(&para);
  emit(FollowEvent {
    kind: "download".into(),
    message: if hybrid {
      "混合跟词模型就绪（实时+歌词纠偏）".into()
    } else {
      "FunASR-Nano 下载完成".into()
    },
    text: None,
    index: None,
    preview: None,
    rms_db: None,
    percent: Some(100.0),
    busy: false,
  });
  Ok(AsrModelStatus {
    ready: true,
    path: dir.to_string_lossy().into(),
    message: if hybrid {
      "混合跟词已就绪（稍快唱速用实时流，拉长音用歌词模型纠偏）".into()
    } else {
      "FunASR-Nano 已就绪（建议再装 Paraformer 以提升稍快唱速）".into()
    },
  })
}

fn build_hotwords(lines: &[LyricLineIn]) -> String {
  let mut out = String::new();
  for l in lines.iter().filter(|l| !l.is_title) {
    let t = l.text.trim();
    if t.is_empty() {
      continue;
    }
    if !out.is_empty() {
      out.push(' ');
    }
    out.push_str(t);
    if out.len() > 400 {
      break;
    }
  }
  out
}

/// 独立 ASR 进程路径（与主程序 ort/MD 隔离，避免 LNK2038）。
pub(crate) fn find_asr_sidecar() -> Result<PathBuf, String> {
  if let Ok(p) = std::env::var("STAGE_PLAYER_ASR_SIDECAR") {
    let pb = PathBuf::from(p);
    if pb.is_file() {
      return Ok(pb);
    }
  }
  let names = [
    "lyric-asr-sidecar.exe",
    "lyric-asr-sidecar-x86_64-pc-windows-msvc.exe",
    "lyric-asr-sidecar",
  ];
  if let Ok(exe) = std::env::current_exe() {
    if let Some(dir) = exe.parent() {
      for name in names {
        let cand = dir.join(name);
        if cand.is_file() {
          return Ok(cand);
        }
      }
    }
  }
  let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
  for profile in ["debug", "release"] {
    let cand = manifest
      .join("target")
      .join(profile)
      .join("lyric-asr-sidecar.exe");
    if cand.is_file() {
      return Ok(cand);
    }
  }
  Err(
    "找不到 lyric-asr-sidecar.exe。请先执行: cargo build -p lyric-asr-sidecar".into(),
  )
}

pub(crate) fn write_frame(stdin: &mut impl Write, tag: &[u8; 4], payload: &[u8]) -> Result<(), String> {
  stdin.write_all(tag).map_err(|e| e.to_string())?;
  stdin
    .write_all(&(payload.len() as u32).to_le_bytes())
    .map_err(|e| e.to_string())?;
  stdin.write_all(payload).map_err(|e| e.to_string())?;
  stdin.flush().map_err(|e| e.to_string())
}

pub(crate) fn write_audio_frame(stdin: &mut impl Write, samples: &[f32]) -> Result<(), String> {
  stdin.write_all(b"AUD\0").map_err(|e| e.to_string())?;
  stdin
    .write_all(&(samples.len() as u32).to_le_bytes())
    .map_err(|e| e.to_string())?;
  for &s in samples {
    stdin
      .write_all(&s.to_le_bytes())
      .map_err(|e| e.to_string())?;
  }
  stdin.flush().map_err(|e| e.to_string())
}

fn rms_db(samples: &[f32]) -> f32 {
  if samples.is_empty() {
    return -120.0;
  }
  let mut s = 0.0f64;
  for &x in samples {
    s += (x as f64) * (x as f64);
  }
  let rms = (s / samples.len() as f64).sqrt();
  if rms < 1e-9 {
    -120.0
  } else {
    (20.0 * rms.log10()) as f32
  }
}

fn resample_linear(input: &[f32], from_sr: u32, to_sr: u32) -> Vec<f32> {
  if from_sr == 0 || to_sr == 0 || input.is_empty() {
    return Vec::new();
  }
  if from_sr == to_sr {
    return input.to_vec();
  }
  let ratio = to_sr as f64 / from_sr as f64;
  let out_len = ((input.len() as f64) * ratio).round().max(1.0) as usize;
  let mut out = Vec::with_capacity(out_len);
  for i in 0..out_len {
    let src = i as f64 / ratio;
    let i0 = src.floor() as usize;
    let i1 = (i0 + 1).min(input.len() - 1);
    let t = (src - i0 as f64) as f32;
    out.push(input[i0] * (1.0 - t) + input[i1] * t);
  }
  out
}

fn extract_mono(interleaved: &[f32], channels: usize, ch: usize) -> Vec<f32> {
  if channels <= 1 {
    return interleaved.to_vec();
  }
  interleaved
    .chunks(channels)
    .map(|frame| frame.get(ch).copied().unwrap_or(0.0))
    .collect()
}

#[tauri::command]
pub async fn lyric_follow_start(
  app: AppHandle,
  h: State<'_, LyricFollowHandle>,
  lines: Vec<LyricLineIn>,
  start_index: usize,
  device_index: Option<usize>,
  channel: Option<u32>,
  // 同设备参考声道（Click/鼓组/伴奏），不进 ASR；None = 关闭
  ref_channel: Option<u32>,
) -> Result<(), String> {
  if lines.is_empty() {
    return Err("没有歌词行".into());
  }
  let fun_dir = models_dir(&app)?;
  let para_dir = paraformer_dir(&app)?;
  let has_fun = funasr_ready(&fun_dir);
  let has_para = paraformer_ready(&para_dir);
  if !has_fun && !has_para {
    return Err("ASR 模型未就绪，请先下载".into());
  }
  // 优先混合：Paraformer 实时跟稍快的唱；FunASR 换气纠偏拉长音
  let asr_mode = if has_fun && has_para {
    "hybrid"
  } else if has_para {
    "online"
  } else {
    "funasr_nano"
  };

  if let Some(sess) = h.session.lock().take() {
    sess.stop.store(true, Ordering::SeqCst);
    let _ = sess.tx.send(WorkerMsg::Stop);
  }

  let stop = Arc::new(AtomicBool::new(false));
  let (tx, rx) = mpsc::channel::<WorkerMsg>();
  *h.session.lock() = Some(FollowSession {
    stop: Arc::clone(&stop),
    tx: tx.clone(),
  });

  let hotwords = build_hotwords(&lines);
  let built = build_lines(&lines);
  let start = start_index.min(built.len().saturating_sub(1));
  let stop_w = Arc::clone(&stop);
  let sidecar_path = find_asr_sidecar()?;

  // ASR sidecar + 状态机线程（sidecar 独立链接 sherpa/MT，避免与 ort/MD 冲突）
  thread::Builder::new()
    .name("lyric-asr".into())
    .spawn(move || {
      let mut cmd = Command::new(&sidecar_path);
      cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
      // Windows：禁止弹出 sidecar 黑色 cmd 窗口
      #[cfg(windows)]
      {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
      }
      let mut child = match cmd.spawn()
      {
        Ok(c) => c,
        Err(e) => {
          emit(FollowEvent {
            kind: "error".into(),
            message: format!("启动 ASR sidecar 失败: {e}"),
            text: None,
            index: None,
            preview: None,
            rms_db: None,
            percent: None,
            busy: false,
          });
          return;
        }
      };
      let mut child_in = match child.stdin.take() {
        Some(s) => s,
        None => {
          emit(FollowEvent {
            kind: "error".into(),
            message: "ASR sidecar 无 stdin".into(),
            text: None,
            index: None,
            preview: None,
            rms_db: None,
            percent: None,
            busy: false,
          });
          let _ = child.kill();
          return;
        }
      };
      let child_out = match child.stdout.take() {
        Some(s) => s,
        None => {
          emit(FollowEvent {
            kind: "error".into(),
            message: "ASR sidecar 无 stdout".into(),
            text: None,
            index: None,
            preview: None,
            rms_db: None,
            percent: None,
            busy: false,
          });
          let _ = child.kill();
          return;
        }
      };

      let init = match asr_mode {
        "hybrid" => serde_json::json!({
          "mode": "hybrid",
          "encoder": para_dir.join("encoder.int8.onnx").to_string_lossy(),
          "decoder": para_dir.join("decoder.int8.onnx").to_string_lossy(),
          "tokens": para_dir.join("tokens.txt").to_string_lossy(),
          "encoder_adaptor": fun_dir.join("encoder_adaptor.int8.onnx").to_string_lossy(),
          "embedding": fun_dir.join("embedding.int8.onnx").to_string_lossy(),
          "llm": fun_dir.join("llm.int8.onnx").to_string_lossy(),
          "tokenizer": fun_dir.join("Qwen3-0.6B").to_string_lossy(),
          "vad": fun_dir.join(VAD_NAME).to_string_lossy(),
          "language": "zh",
          "use_itn": true,
          "hotwords": hotwords,
          "endpoint_profile": "singing",
        }),
        "funasr_nano" => serde_json::json!({
          "mode": "funasr_nano",
          "encoder_adaptor": fun_dir.join("encoder_adaptor.int8.onnx").to_string_lossy(),
          "embedding": fun_dir.join("embedding.int8.onnx").to_string_lossy(),
          "llm": fun_dir.join("llm.int8.onnx").to_string_lossy(),
          "tokenizer": fun_dir.join("Qwen3-0.6B").to_string_lossy(),
          "vad": fun_dir.join(VAD_NAME).to_string_lossy(),
          "language": "zh",
          "use_itn": true,
          "hotwords": hotwords,
          "endpoint_profile": "singing",
        }),
        _ => serde_json::json!({
          "mode": "online",
          "encoder": para_dir.join("encoder.int8.onnx").to_string_lossy(),
          "decoder": para_dir.join("decoder.int8.onnx").to_string_lossy(),
          "tokens": para_dir.join("tokens.txt").to_string_lossy(),
          "hotwords": hotwords,
          "endpoint_profile": "singing",
        }),
      };
      let init_bytes = init.to_string().into_bytes();
      if let Err(e) = write_frame(&mut child_in, b"INIT", &init_bytes) {
        emit(FollowEvent {
          kind: "error".into(),
          message: format!("ASR INIT 失败: {e}"),
          text: None,
          index: None,
          preview: None,
          rms_db: None,
          percent: None,
          busy: false,
        });
        let _ = child.kill();
        return;
      }

      let (asr_tx, asr_rx) = mpsc::channel::<serde_json::Value>();
      thread::spawn(move || {
        let reader = BufReader::new(child_out);
        for line in reader.lines().flatten() {
          if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
            if asr_tx.send(v).is_err() {
              break;
            }
          }
        }
      });

      let mut engine = FlipperEngine::new(built, start);
      let mut ready = false;
      let mut last_level_emit = Instant::now() - Duration::from_secs(1);
      let wait_secs = if asr_mode == "online" { 30 } else { 180 };
      let wait_deadline = Instant::now() + Duration::from_secs(wait_secs);
      while !ready && Instant::now() < wait_deadline {
        // 模型加载中用户就点了停止（或重新开启）：立即结束 sidecar，不等加载完，
        // 否则旧进程会多跑到加载完成，还会给界面补发一条过期的「已启动」
        if stop_w.load(Ordering::SeqCst) {
          let _ = child_in.write_all(b"STOP");
          drop(child_in);
          let _ = child.kill();
          let _ = child.wait();
          emit(FollowEvent {
            kind: "stop".into(),
            message: "语音跟词已停止".into(),
            text: None,
            index: None,
            preview: None,
            rms_db: None,
            percent: None,
            busy: false,
          });
          return;
        }
        // 加载期间麦克风线程也在往 rx 送音频：丢掉过期音频以免堆积，换行同步照常处理
        while let Ok(msg) = rx.try_recv() {
          match msg {
            WorkerMsg::Stop => stop_w.store(true, Ordering::SeqCst),
            WorkerMsg::Sync(i) => engine.sync(i),
            WorkerMsg::Audio { .. } => {}
          }
        }
        match asr_rx.recv_timeout(Duration::from_millis(100)) {
          Ok(v) => {
            let kind = v.get("kind").and_then(|x| x.as_str()).unwrap_or("");
            if kind == "ready" {
              ready = true;
            } else if kind == "error" {
              let msg = v
                .get("message")
                .and_then(|x| x.as_str())
                .unwrap_or("ASR 初始化失败");
              emit(FollowEvent {
                kind: "error".into(),
                message: msg.into(),
                text: None,
                index: None,
                preview: None,
                rms_db: None,
                percent: None,
                busy: false,
              });
              let _ = child_in.write_all(b"STOP");
              let _ = child.kill();
              return;
            }
          }
          Err(mpsc::RecvTimeoutError::Timeout) => {}
          Err(mpsc::RecvTimeoutError::Disconnected) => {
            emit(FollowEvent {
              kind: "error".into(),
              message: "ASR sidecar 提前退出".into(),
              text: None,
              index: None,
              preview: None,
              rms_db: None,
              percent: None,
              busy: false,
            });
            let _ = child.kill();
            return;
          }
        }
      }
      if !ready {
        emit(FollowEvent {
          kind: "error".into(),
          message: "ASR sidecar 就绪超时".into(),
          text: None,
          index: None,
          preview: None,
          rms_db: None,
          percent: None,
          busy: false,
        });
        let _ = child_in.write_all(b"STOP");
        let _ = child.kill();
        return;
      }

      emit(FollowEvent {
        kind: "start".into(),
        message: "语音跟词已启动（主领干声 · sidecar）".into(),
        text: None,
        index: Some(engine.curr),
        preview: None,
        rms_db: None,
        percent: None,
        busy: true,
      });

      while !stop_w.load(Ordering::SeqCst) {
        while let Ok(v) = asr_rx.try_recv() {
          let kind = v.get("kind").and_then(|x| x.as_str()).unwrap_or("");
          match kind {
            "partial" => {
              if let Some(text) = v.get("text").and_then(|x| x.as_str()) {
                engine.on_asr_partial(text);
              }
            }
            "endpoint" => engine.on_endpoint(),
            "error" => {
              let msg = v
                .get("message")
                .and_then(|x| x.as_str())
                .unwrap_or("ASR 错误");
              emit(FollowEvent {
                kind: "error".into(),
                message: msg.into(),
                text: None,
                index: Some(engine.curr),
                preview: engine.armed,
                rms_db: None,
                percent: None,
                busy: true,
              });
            }
            _ => {}
          }
        }

        match rx.recv_timeout(Duration::from_millis(50)) {
          Ok(WorkerMsg::Stop) => break,
          Ok(WorkerMsg::Sync(i)) => engine.sync(i),
          Ok(WorkerMsg::Audio { vocal, ref_db }) => {
            if vocal.is_empty() {
              continue;
            }
            let ms = vocal.len() as f32 * 1000.0 / TARGET_SR as f32;
            engine.on_ref_energy(ref_db, ms);
            let db = rms_db(&vocal);
            engine.on_rms(db, ms);
            if last_level_emit.elapsed() >= Duration::from_millis(160) {
              last_level_emit = Instant::now();
              let hearing = db > -48.0;
              let msg = if hearing {
                if engine.ref_active {
                  "干声有电平 · 参考有能量"
                } else {
                  "干声有电平"
                }
              } else if engine.ref_active {
                "间奏/等干声 · 参考有能量"
              } else {
                "等待干声"
              };
              emit(FollowEvent {
                kind: "level".into(),
                message: msg.into(),
                text: None,
                index: Some(engine.curr),
                preview: engine.armed,
                rms_db: Some(db),
                percent: Some(((db + 60.0) / 60.0 * 100.0).clamp(0.0, 100.0)),
                busy: true,
              });
            }
            if let Err(e) = write_audio_frame(&mut child_in, &vocal) {
              emit(FollowEvent {
                kind: "error".into(),
                message: format!("向 ASR 写音频失败: {e}"),
                text: None,
                index: Some(engine.curr),
                preview: engine.armed,
                rms_db: None,
                percent: None,
                busy: false,
              });
              break;
            }
          }
          Err(mpsc::RecvTimeoutError::Timeout) => {}
          Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
      }

      let _ = child_in.write_all(b"STOP");
      let _ = child_in.flush();
      drop(child_in);
      let _ = child.kill();
      let _ = child.wait();
      emit(FollowEvent {
        kind: "stop".into(),
        message: "语音跟词已停止".into(),
        text: None,
        index: None,
        preview: None,
        rms_db: None,
        percent: None,
        busy: false,
      });
    })
    .map_err(|e| e.to_string())?;

  // 采集线程（干声 + 可选同设备参考声道）
  let stop_c = Arc::clone(&stop);
  let ch = channel.unwrap_or(0);
  let ref_ch = ref_channel.filter(|&r| r != ch);
  thread::Builder::new()
    .name("lyric-mic".into())
    .spawn(move || {
      let host = cpal::default_host();
      let devices: Vec<_> = host
        .input_devices()
        .map(|d| d.collect())
        .unwrap_or_default();
      let device = match device_index {
        Some(i) => devices.get(i).cloned(),
        None => host.default_input_device(),
      };
      let Some(device) = device else {
        emit(FollowEvent {
          kind: "error".into(),
          message: "找不到输入设备（请接主领干声）".into(),
          text: None,
          index: None,
          preview: None,
          rms_db: None,
          percent: None,
          busy: false,
        });
        return;
      };
      let device_name = device
        .name()
        .unwrap_or_else(|_| "默认输入".into());
      let Ok(config) = device.default_input_config() else {
        emit(FollowEvent {
          kind: "error".into(),
          message: "无法读取输入配置".into(),
          text: None,
          index: None,
          preview: None,
          rms_db: None,
          percent: None,
          busy: false,
        });
        return;
      };
      let sample_format = config.sample_format();
      let stream_config: StreamConfig = config.clone().into();
      let channels = stream_config.channels as usize;
      let sr = stream_config.sample_rate.0;
      let ch_i = (ch as usize).min(channels.saturating_sub(1));
      let ref_i = ref_ch.map(|r| (r as usize).min(channels.saturating_sub(1)));
      let tx_audio = tx.clone();
      let input_msg = match ref_i {
        Some(ri) if ri != ch_i => {
          format!("已打开输入 · {device_name} · 干声Ch{} · 参考Ch{}", ch_i + 1, ri + 1)
        }
        _ => format!("已打开输入 · {device_name} · 声道 {}", ch_i + 1),
      };
      emit(FollowEvent {
        kind: "input".into(),
        message: input_msg,
        text: Some(device_name.clone()),
        index: None,
        preview: None,
        rms_db: Some(-90.0),
        percent: Some(0.0),
        busy: true,
      });

      let err_fn = |e| eprintln!("lyric mic error: {e}");
      let make = |tx: Sender<WorkerMsg>, stop: Arc<AtomicBool>| {
        move |data: &[f32]| {
          if stop.load(Ordering::SeqCst) {
            return;
          }
          let mono = extract_mono(data, channels, ch_i);
          let resampled = resample_linear(&mono, sr, TARGET_SR);
          let ref_db = ref_i.map(|ri| {
            let rmono = extract_mono(data, channels, ri);
            let r16 = resample_linear(&rmono, sr, TARGET_SR);
            rms_db(&r16)
          });
          let _ = tx.send(WorkerMsg::Audio {
            vocal: resampled,
            ref_db,
          });
        }
      };

      let stream = match sample_format {
        SampleFormat::F32 => device.build_input_stream(
          &stream_config,
          {
            let cb = make(tx_audio.clone(), Arc::clone(&stop_c));
            move |data: &[f32], _| cb(data)
          },
          err_fn,
          None,
        ),
        SampleFormat::I16 => device.build_input_stream(
          &stream_config,
          {
            let cb = make(tx_audio.clone(), Arc::clone(&stop_c));
            move |data: &[i16], _| {
              let buf: Vec<f32> = data.iter().map(|s| (*s).to_sample::<f32>()).collect();
              cb(&buf);
            }
          },
          err_fn,
          None,
        ),
        SampleFormat::U16 => device.build_input_stream(
          &stream_config,
          {
            let cb = make(tx_audio.clone(), Arc::clone(&stop_c));
            move |data: &[u16], _| {
              let buf: Vec<f32> = data.iter().map(|s| (*s).to_sample::<f32>()).collect();
              cb(&buf);
            }
          },
          err_fn,
          None,
        ),
        other => {
          emit(FollowEvent {
            kind: "error".into(),
            message: format!("不支持的采样格式: {other:?}"),
            text: None,
            index: None,
            preview: None,
            rms_db: None,
            percent: None,
            busy: false,
          });
          return;
        }
      };

      match stream {
        Ok(s) => {
          if let Err(e) = s.play() {
            emit(FollowEvent {
              kind: "error".into(),
              message: format!("无法打开输入: {e}"),
              text: None,
              index: None,
              preview: None,
              rms_db: None,
              percent: None,
              busy: false,
            });
            return;
          }
          while !stop_c.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(100));
          }
          drop(s);
        }
        Err(e) => {
          emit(FollowEvent {
            kind: "error".into(),
            message: format!("创建输入流失败: {e}"),
            text: None,
            index: None,
            preview: None,
            rms_db: None,
            percent: None,
            busy: false,
          });
        }
      }
    })
    .map_err(|e| e.to_string())?;

  Ok(())
}

#[tauri::command]
pub fn lyric_follow_stop(h: State<'_, LyricFollowHandle>) -> Result<(), String> {
  if let Some(sess) = h.session.lock().take() {
    sess.stop.store(true, Ordering::SeqCst);
    let _ = sess.tx.send(WorkerMsg::Stop);
  }
  Ok(())
}

#[tauri::command]
pub fn lyric_follow_sync(h: State<'_, LyricFollowHandle>, index: usize) -> Result<(), String> {
  if let Some(sess) = h.session.lock().as_ref() {
    let _ = sess.tx.send(WorkerMsg::Sync(index));
  }
  Ok(())
}

/// 自由听写：不匹配歌词，只把说话内容实时推到前端
#[tauri::command]
pub async fn dictation_start(
  app: AppHandle,
  h: State<'_, LyricFollowHandle>,
  device_index: Option<usize>,
  channel: Option<u32>,
) -> Result<(), String> {
  let para_dir = paraformer_dir(&app)?;
  // 讲话要长时间连续听写：必须用流式 Paraformer。
  // FunASR 中间解码会堵住管道，表现为「说一会儿/修一下就自己停了」。
  if !paraformer_ready(&para_dir) {
    emit_dictation(FollowEvent {
      kind: "download".into(),
      message: "讲话记录需要流式模型，正在下载…".into(),
      text: None,
      index: None,
      preview: None,
      rms_db: None,
      percent: Some(0.0),
      busy: true,
    });
    let para_bg = para_dir.clone();
    tauri::async_runtime::spawn_blocking(move || ensure_paraformer_files(&para_bg))
      .await
      .map_err(|e| e.to_string())??;
  }
  if !paraformer_ready(&para_dir) {
    return Err("讲话记录需要流式 Paraformer，请先完成模型下载".into());
  }

  if let Some(sess) = h.session.lock().take() {
    sess.stop.store(true, Ordering::SeqCst);
    let _ = sess.tx.send(WorkerMsg::Stop);
  }

  let stop = Arc::new(AtomicBool::new(false));
  let (tx, rx) = mpsc::channel::<WorkerMsg>();
  *h.session.lock() = Some(FollowSession {
    stop: Arc::clone(&stop),
    tx: tx.clone(),
  });

  let stop_w = Arc::clone(&stop);
  let sidecar_path = find_asr_sidecar()?;

  thread::Builder::new()
    .name("dictation-asr".into())
    .spawn(move || {
      let mut cmd = Command::new(&sidecar_path);
      cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
      #[cfg(windows)]
      {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
      }
      let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
          emit_dictation(FollowEvent {
            kind: "error".into(),
            message: format!("启动 ASR sidecar 失败: {e}"),
            text: None,
            index: None,
            preview: None,
            rms_db: None,
            percent: None,
            busy: false,
          });
          return;
        }
      };
      let mut child_in = match child.stdin.take() {
        Some(s) => s,
        None => {
          emit_dictation(FollowEvent {
            kind: "error".into(),
            message: "ASR sidecar 无 stdin".into(),
            text: None,
            index: None,
            preview: None,
            rms_db: None,
            percent: None,
            busy: false,
          });
          let _ = child.kill();
          return;
        }
      };
      let child_out = match child.stdout.take() {
        Some(s) => s,
        None => {
          emit_dictation(FollowEvent {
            kind: "error".into(),
            message: "ASR sidecar 无 stdout".into(),
            text: None,
            index: None,
            preview: None,
            rms_db: None,
            percent: None,
            busy: false,
          });
          let _ = child.kill();
          return;
        }
      };

      // 连续听写：流式 online；尾静音稍宽，换气不断整场
      let init = serde_json::json!({
        "mode": "online",
        "encoder": para_dir.join("encoder.int8.onnx").to_string_lossy(),
        "decoder": para_dir.join("decoder.int8.onnx").to_string_lossy(),
        "tokens": para_dir.join("tokens.txt").to_string_lossy(),
        "endpoint_profile": "dictation",
      });
      let init_s = init.to_string();
      if let Err(e) = write_frame(&mut child_in, b"INIT", init_s.as_bytes()) {
        emit_dictation(FollowEvent {
          kind: "error".into(),
          message: format!("ASR INIT 失败: {e}"),
          text: None,
          index: None,
          preview: None,
          rms_db: None,
          percent: None,
          busy: false,
        });
        let _ = child.kill();
        return;
      }

      let (asr_tx, asr_rx) = mpsc::channel::<serde_json::Value>();
      thread::spawn(move || {
        let reader = BufReader::new(child_out);
        for line in reader.lines().flatten() {
          if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
            if asr_tx.send(v).is_err() {
              break;
            }
          }
        }
      });

      let mut ready = false;
      let mut last_partial = String::new();
      let mut finals: Vec<String> = Vec::new();
      let mut pcm_buf: Vec<f32> = Vec::new();
      const MAX_PCM: usize = 16_000 * 60 * 90; // 最长缓存约 90 分钟
      let hot_pairs = APP
        .get()
        .map(crate::dictation_polish::load_hotwords)
        .unwrap_or_default();
      let mut last_level_emit = Instant::now() - Duration::from_secs(1);
      let mut write_fail: u32 = 0;
      let mut quiet_ms = 0.0f32;
      let wait_deadline = Instant::now() + Duration::from_secs(45);
      while !ready && Instant::now() < wait_deadline {
        if stop_w.load(Ordering::SeqCst) {
          let _ = child_in.write_all(b"STOP");
          let _ = child.kill();
          emit_dictation(FollowEvent {
            kind: "stop".into(),
            message: "讲话识别已停止".into(),
            text: None,
            index: None,
            preview: None,
            rms_db: None,
            percent: None,
            busy: false,
          });
          return;
        }
        // 加载期间丢掉过期音频，避免通道堆积
        while let Ok(msg) = rx.try_recv() {
          match msg {
            WorkerMsg::Stop => stop_w.store(true, Ordering::SeqCst),
            WorkerMsg::Sync(_) | WorkerMsg::Audio { .. } => {}
          }
        }
        match asr_rx.recv_timeout(Duration::from_millis(100)) {
          Ok(v) => {
            let kind = v.get("kind").and_then(|x| x.as_str()).unwrap_or("");
            if kind == "ready" {
              ready = true;
            } else if kind == "error" {
              let msg = v
                .get("message")
                .and_then(|x| x.as_str())
                .unwrap_or("ASR 初始化失败");
              emit_dictation(FollowEvent {
                kind: "error".into(),
                message: msg.into(),
                text: None,
                index: None,
                preview: None,
                rms_db: None,
                percent: None,
                busy: false,
              });
              let _ = child_in.write_all(b"STOP");
              let _ = child.kill();
              return;
            }
          }
          Err(mpsc::RecvTimeoutError::Timeout) => {}
          Err(mpsc::RecvTimeoutError::Disconnected) => {
            emit_dictation(FollowEvent {
              kind: "error".into(),
              message: "ASR sidecar 提前退出".into(),
              text: None,
              index: None,
              preview: None,
              rms_db: None,
              percent: None,
              busy: false,
            });
            let _ = child.kill();
            return;
          }
        }
      }
      if !ready {
        emit_dictation(FollowEvent {
          kind: "error".into(),
          message: "ASR sidecar 就绪超时".into(),
          text: None,
          index: None,
          preview: None,
          rms_db: None,
          percent: None,
          busy: false,
        });
        let _ = child_in.write_all(b"STOP");
        let _ = child.kill();
        return;
      }

      emit_dictation(FollowEvent {
        kind: "start".into(),
        message: "讲话识别已开始".into(),
        text: None,
        index: None,
        preview: None,
        rms_db: None,
        percent: None,
        busy: true,
      });

      while !stop_w.load(Ordering::SeqCst) {
        while let Ok(v) = asr_rx.try_recv() {
          let kind = v.get("kind").and_then(|x| x.as_str()).unwrap_or("");
          match kind {
            "partial" => {
              if let Some(text) = v.get("text").and_then(|x| x.as_str()) {
                let t = text.trim();
                if !t.is_empty() {
                  last_partial = t.to_string();
                  emit_dictation(FollowEvent {
                    kind: "partial".into(),
                    message: "识别中".into(),
                    text: Some(last_partial.clone()),
                    index: None,
                    preview: None,
                    rms_db: None,
                    percent: None,
                    busy: true,
                  });
                }
              }
            }
            // Sherpa endpoint 在讲话模式已关闭；即便收到也只落句，绝不结束会话
            "endpoint" => {
              if !last_partial.is_empty() {
                let polished =
                  crate::dictation_polish::apply_hotwords(&last_partial, &hot_pairs);
                finals.push(polished.clone());
                emit_dictation(FollowEvent {
                  kind: "final".into(),
                  message: "落句（继续听写中）".into(),
                  text: Some(polished),
                  index: None,
                  preview: None,
                  rms_db: None,
                  percent: None,
                  busy: true,
                });
                last_partial.clear();
                quiet_ms = 0.0;
                let _ = write_frame(&mut child_in, b"RST\0", &[]);
              }
            }
            "error" => {
              let msg = v
                .get("message")
                .and_then(|x| x.as_str())
                .unwrap_or("ASR 错误");
              emit_dictation(FollowEvent {
                kind: "error".into(),
                message: msg.into(),
                text: None,
                index: None,
                preview: None,
                rms_db: None,
                percent: None,
                busy: true, // 保持 busy，前端勿当整场结束
              });
            }
            _ => {}
          }
        }

        match rx.recv_timeout(Duration::from_millis(50)) {
          Ok(WorkerMsg::Stop) => break,
          Ok(WorkerMsg::Sync(_)) => {}
          Ok(WorkerMsg::Audio { vocal: samples, .. }) => {
            if samples.is_empty() {
              continue;
            }
            if pcm_buf.len() < MAX_PCM {
              let room = MAX_PCM - pcm_buf.len();
              let n = samples.len().min(room);
              pcm_buf.extend_from_slice(&samples[..n]);
            }
            let db = rms_db(&samples);
            let chunk_ms = (samples.len() as f32) / (TARGET_SR as f32) * 1000.0;
            // 本地静音落句：换气只提交一句，会话继续
            if db < -42.0 {
              quiet_ms += chunk_ms;
            } else {
              quiet_ms = 0.0;
            }
            if quiet_ms >= 1100.0 && !last_partial.is_empty() {
              let polished =
                crate::dictation_polish::apply_hotwords(&last_partial, &hot_pairs);
              finals.push(polished.clone());
              emit_dictation(FollowEvent {
                kind: "final".into(),
                message: "落句（继续听写中）".into(),
                text: Some(polished),
                index: None,
                preview: None,
                rms_db: None,
                percent: None,
                busy: true,
              });
              last_partial.clear();
              quiet_ms = 0.0;
              let _ = write_frame(&mut child_in, b"RST\0", &[]);
            }
            if last_level_emit.elapsed() >= Duration::from_millis(160) {
              last_level_emit = Instant::now();
              emit_dictation(FollowEvent {
                kind: "level".into(),
                message: if db > -48.0 {
                  "有电平 · 听写中".into()
                } else {
                  "等待说话 · 听写中".into()
                },
                text: None,
                index: None,
                preview: None,
                rms_db: Some(db),
                percent: Some(((db + 60.0) / 60.0 * 100.0).clamp(0.0, 100.0)),
                busy: true,
              });
            }
            if let Err(e) = write_audio_frame(&mut child_in, &samples) {
              write_fail = write_fail.saturating_add(1);
              if write_fail >= 80 {
                emit_dictation(FollowEvent {
                  kind: "error".into(),
                  message: format!("向 ASR 写音频连续失败: {e}"),
                  text: None,
                  index: None,
                  preview: None,
                  rms_db: None,
                  percent: None,
                  busy: false,
                });
                break;
              }
            } else {
              write_fail = 0;
            }
          }
          Err(mpsc::RecvTimeoutError::Timeout) => {}
          Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
      }

      let user_stop = stop_w.load(Ordering::SeqCst);

      if !last_partial.is_empty() {
        let polished = crate::dictation_polish::apply_hotwords(&last_partial, &hot_pairs);
        finals.push(polished.clone());
        emit_dictation(FollowEvent {
          kind: "final".into(),
          message: if user_stop {
            "结束落句".into()
          } else {
            "落句（继续听写中）".into()
          },
          text: Some(polished),
          index: None,
          preview: None,
          rms_db: None,
          percent: None,
          busy: true,
        });
        last_partial.clear();
      }

      let _ = child_in.write_all(b"STOP");
      let _ = child_in.flush();
      drop(child_in);
      let _ = child.kill();
      let _ = child.wait();

      // 只有用户主动结束才定稿；意外退出留给前端续接，避免「识别完就结束」
      if user_stop {
        let streaming_text = finals.join("\n");
        if !streaming_text.trim().is_empty() || !pcm_buf.is_empty() {
          emit_dictation(FollowEvent {
            kind: "refining".into(),
            message: "正在定稿精修（标点/错字）…".into(),
            text: None,
            index: None,
            preview: None,
            rms_db: None,
            percent: Some(0.0),
            busy: true,
          });
          if let Some(app) = APP.get() {
            let (polished, msg) =
              crate::dictation_polish::polish_after_stop(app, &pcm_buf, &streaming_text);
            if !polished.trim().is_empty() {
              emit_dictation(FollowEvent {
                kind: "refined".into(),
                message: msg,
                text: Some(polished),
                index: None,
                preview: None,
                rms_db: None,
                percent: Some(100.0),
                busy: false,
              });
            }
          }
        }

        emit_dictation(FollowEvent {
          kind: "stop".into(),
          message: "讲话识别已停止".into(),
          text: None,
          index: None,
          preview: None,
          rms_db: None,
          percent: None,
          busy: false,
        });
      } else {
        emit_dictation(FollowEvent {
          kind: "error".into(),
          message: "听写会话中断，正在尝试续接".into(),
          text: None,
          index: None,
          preview: None,
          rms_db: None,
          percent: None,
          busy: true,
        });
        emit_dictation(FollowEvent {
          kind: "stop".into(),
          message: "unexpected".into(),
          text: None,
          index: None,
          preview: None,
          rms_db: None,
          percent: None,
          busy: true,
        });
      }
    })
    .map_err(|e| e.to_string())?;

  let stop_c = Arc::clone(&stop);
  let ch = channel.unwrap_or(0);
  thread::Builder::new()
    .name("dictation-mic".into())
    .spawn(move || {
      let host = cpal::default_host();
      let devices: Vec<_> = host
        .input_devices()
        .map(|d| d.collect())
        .unwrap_or_default();
      let device = match device_index {
        Some(i) => devices.get(i).cloned(),
        None => host.default_input_device(),
      };
      let Some(device) = device else {
        emit_dictation(FollowEvent {
          kind: "error".into(),
          message: "找不到输入设备".into(),
          text: None,
          index: None,
          preview: None,
          rms_db: None,
          percent: None,
          busy: false,
        });
        return;
      };
      let device_name = device.name().unwrap_or_else(|_| "默认输入".into());
      let Ok(config) = device.default_input_config() else {
        emit_dictation(FollowEvent {
          kind: "error".into(),
          message: "无法读取输入配置".into(),
          text: None,
          index: None,
          preview: None,
          rms_db: None,
          percent: None,
          busy: false,
        });
        return;
      };
      let sample_format = config.sample_format();
      let stream_config: StreamConfig = config.clone().into();
      let channels = stream_config.channels as usize;
      let sr = stream_config.sample_rate.0;
      let ch_i = (ch as usize).min(channels.saturating_sub(1));
      let tx_audio = tx.clone();
      emit_dictation(FollowEvent {
        kind: "input".into(),
        message: format!("已打开输入 · {device_name} · 声道 {}", ch_i + 1),
        text: Some(device_name),
        index: None,
        preview: None,
        rms_db: Some(-90.0),
        percent: Some(0.0),
        busy: true,
      });

      let err_fn = |e| eprintln!("dictation mic error: {e}");
      let make = |tx: Sender<WorkerMsg>, stop: Arc<AtomicBool>| {
        move |data: &[f32]| {
          if stop.load(Ordering::SeqCst) {
            return;
          }
          let mono = extract_mono(data, channels, ch_i);
          let resampled = resample_linear(&mono, sr, TARGET_SR);
          let _ = tx.send(WorkerMsg::Audio {
            vocal: resampled,
            ref_db: None,
          });
        }
      };

      let stream = match sample_format {
        SampleFormat::F32 => device.build_input_stream(
          &stream_config,
          {
            let cb = make(tx_audio.clone(), Arc::clone(&stop_c));
            move |data: &[f32], _| cb(data)
          },
          err_fn,
          None,
        ),
        SampleFormat::I16 => device.build_input_stream(
          &stream_config,
          {
            let cb = make(tx_audio.clone(), Arc::clone(&stop_c));
            move |data: &[i16], _| {
              let buf: Vec<f32> = data.iter().map(|s| (*s).to_sample::<f32>()).collect();
              cb(&buf);
            }
          },
          err_fn,
          None,
        ),
        SampleFormat::U16 => device.build_input_stream(
          &stream_config,
          {
            let cb = make(tx_audio.clone(), Arc::clone(&stop_c));
            move |data: &[u16], _| {
              let buf: Vec<f32> = data.iter().map(|s| (*s).to_sample::<f32>()).collect();
              cb(&buf);
            }
          },
          err_fn,
          None,
        ),
        other => {
          emit_dictation(FollowEvent {
            kind: "error".into(),
            message: format!("不支持的采样格式: {other:?}"),
            text: None,
            index: None,
            preview: None,
            rms_db: None,
            percent: None,
            busy: false,
          });
          return;
        }
      };

      match stream {
        Ok(s) => {
          if let Err(e) = s.play() {
            emit_dictation(FollowEvent {
              kind: "error".into(),
              message: format!("无法打开输入: {e}"),
              text: None,
              index: None,
              preview: None,
              rms_db: None,
              percent: None,
              busy: false,
            });
            return;
          }
          while !stop_c.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(100));
          }
          drop(s);
        }
        Err(e) => {
          emit_dictation(FollowEvent {
            kind: "error".into(),
            message: format!("创建输入流失败: {e}"),
            text: None,
            index: None,
            preview: None,
            rms_db: None,
            percent: None,
            busy: false,
          });
        }
      }
    })
    .map_err(|e| e.to_string())?;

  Ok(())
}

#[tauri::command]
pub fn dictation_stop(h: State<'_, LyricFollowHandle>) -> Result<(), String> {
  lyric_follow_stop(h)
}
