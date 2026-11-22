//! 大模型总结设置与调用（DeepSeek / 千问 / ChatGPT，可切换）。
//! API Key 只保存在本机配置目录（ai.json），不进 localStorage / 导出文件，也不回传前端明文。
//! 总结走 OpenAI 兼容的 chat/completions（流式 SSE），只发送文字，不发送音频（转写始终在本地）。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

const DEEPSEEK_URL: &str = "https://api.deepseek.com/chat/completions";
const QWEN_CHAT_URL: &str = "https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions";
/// ChatGPT 兼容中转（OpenAI /v1/chat/completions）
const CHATGPT_URL: &str = "https://sub.601730.xyz/v1/chat/completions";
/// 文稿不超过这个字数时一次性总结
const SINGLE_MAX_CHARS: usize = 28_000;
/// 超长文稿分段时每段目标字数（优先在章节边界切开）
const PART_CHARS: usize = 14_000;
/// 各段笔记拼起来超过这个字数时，先做一层「组内合并」再出全书总结
const NOTES_DIRECT_MAX: usize = 22_000;
/// 组内合并时，每组大约覆盖多少字的笔记
const NOTES_GROUP_CHARS: usize = 10_000;
/// 滚动「前文脉络」带给下一段的上限，避免提示词膨胀
const BRIDGE_MAX_CHARS: usize = 1_800;
/// 前端传入的文稿上限（防误操作）
const TEXT_MAX_CHARS: usize = 600_000;

const SYSTEM_PROMPT: &str = "你是严谨的中文内容整理助手。只依据用户提供的转写文稿进行总结，不要编造文稿里没有的内容。\
文稿由语音识别自动生成，可能有同音错字、断句不当；请结合上下文理解，对明显的人名、术语、经文名称做合理校正，\
无法确定时保持原样。输出使用 Markdown，条理清晰。";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Vendor {
  Deepseek,
  Qwen,
  Chatgpt,
}

impl Vendor {
  fn parse(s: &str) -> Option<Vendor> {
    match s.trim() {
      "deepseek" => Some(Vendor::Deepseek),
      "qwen" => Some(Vendor::Qwen),
      "chatgpt" | "openai" | "gpt" => Some(Vendor::Chatgpt),
      _ => None,
    }
  }
  fn id(self) -> &'static str {
    match self {
      Vendor::Deepseek => "deepseek",
      Vendor::Qwen => "qwen",
      Vendor::Chatgpt => "chatgpt",
    }
  }
  fn label(self) -> &'static str {
    match self {
      Vendor::Deepseek => "DeepSeek",
      Vendor::Qwen => "千问",
      Vendor::Chatgpt => "ChatGPT",
    }
  }
  fn url(self) -> &'static str {
    match self {
      Vendor::Deepseek => DEEPSEEK_URL,
      Vendor::Qwen => QWEN_CHAT_URL,
      Vendor::Chatgpt => CHATGPT_URL,
    }
  }
  /// 模型名区分大小写：千问必须用小写 qwen3.8-flash；ChatGPT 中转用 GPT-5.6-Terra
  fn default_model(self) -> &'static str {
    match self {
      Vendor::Deepseek => "deepseek-chat",
      Vendor::Qwen => "qwen3.8-flash",
      Vendor::Chatgpt => "gpt-6-luna",
    }
  }
}

#[derive(Clone)]
pub struct SummaryState {
  running: Arc<AtomicBool>,
  cancel: Arc<AtomicBool>,
}

impl Default for SummaryState {
  fn default() -> Self {
    Self {
      running: Arc::new(AtomicBool::new(false)),
      cancel: Arc::new(AtomicBool::new(false)),
    }
  }
}

struct RunGuard(Arc<AtomicBool>);
impl Drop for RunGuard {
  fn drop(&mut self) {
    self.0.store(false, Ordering::SeqCst);
  }
}

#[derive(Default, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Creds {
  #[serde(default)]
  api_key: String,
  #[serde(default)]
  model: String,
}

/// 长文是否先走本地蒸馏模型
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
enum LocalMode {
  #[default]
  Off,
  /// 分段提炼用本地，终稿用云端
  Map,
  /// 分段 + 组内合并用本地，终稿用云端
  MapMerge,
}

impl LocalMode {
  fn parse(s: &str) -> LocalMode {
    match s.trim().to_ascii_lowercase().as_str() {
      "map" | "local_map" | "local" => LocalMode::Map,
      "map_merge" | "mapmerge" | "merge" => LocalMode::MapMerge,
      _ => LocalMode::Off,
    }
  }
  fn id(self) -> &'static str {
    match self {
      LocalMode::Off => "off",
      LocalMode::Map => "map",
      LocalMode::MapMerge => "map_merge",
    }
  }
  fn label(self) -> &'static str {
    match self {
      LocalMode::Off => "关闭",
      LocalMode::Map => "本地蒸馏分段 → 云端终稿",
      LocalMode::MapMerge => "本地分段+合并 → 云端终稿",
    }
  }
}

/// 默认指向 LM Studio（本机常见）；Ollama 用户可改成 http://127.0.0.1:11434/v1
const DEFAULT_LOCAL_URL: &str = "http://127.0.0.1:1234/v1";
const DEFAULT_LOCAL_MODEL: &str = "qwen/qwen3.6-27b";

#[derive(Default, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Stored {
  /// 当前总结服务：deepseek | qwen | chatgpt
  #[serde(default)]
  provider: String,
  #[serde(default)]
  deepseek: Creds,
  #[serde(default)]
  qwen: Creds,
  #[serde(default)]
  chatgpt: Creds,
  /// off | map | map_merge
  #[serde(default)]
  local_preprocess: String,
  /// OpenAI 兼容根路径，如 http://127.0.0.1:11434/v1
  #[serde(default)]
  local_base_url: String,
  #[serde(default)]
  local_model: String,
  /// 本地服务可选 Key（Ollama 可空；LM Studio 有时需要）
  #[serde(default)]
  local_api_key: String,
}

#[derive(Clone)]
struct LocalCfg {
  mode: LocalMode,
  base_url: String,
  model: String,
  api_key: String,
}

impl Stored {
  fn vendor(&self) -> Vendor {
    Vendor::parse(&self.provider).unwrap_or(Vendor::Deepseek)
  }
  fn creds(&self, v: Vendor) -> &Creds {
    match v {
      Vendor::Deepseek => &self.deepseek,
      Vendor::Qwen => &self.qwen,
      Vendor::Chatgpt => &self.chatgpt,
    }
  }
  fn creds_mut(&mut self, v: Vendor) -> &mut Creds {
    match v {
      Vendor::Deepseek => &mut self.deepseek,
      Vendor::Qwen => &mut self.qwen,
      Vendor::Chatgpt => &mut self.chatgpt,
    }
  }
  fn local_cfg(&self) -> LocalCfg {
    let mode = LocalMode::parse(&self.local_preprocess);
    let base = self.local_base_url.trim();
    let model = self.local_model.trim();
    LocalCfg {
      mode,
      base_url: if base.is_empty() {
        DEFAULT_LOCAL_URL.into()
      } else {
        base.trim_end_matches('/').to_string()
      },
      model: if model.is_empty() {
        DEFAULT_LOCAL_MODEL.into()
      } else {
        model.to_string()
      },
      api_key: self.local_api_key.trim().to_string(),
    }
  }
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
  fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  Ok(dir)
}

fn load_stored(app: &AppHandle) -> Stored {
  let Ok(dir) = config_dir(app) else {
    return Stored::default();
  };
  if let Some(s) = fs::read_to_string(dir.join("ai.json"))
    .ok()
    .and_then(|s| serde_json::from_str::<Stored>(&s).ok())
  {
    return s;
  }
  // 旧版只有 DeepSeek 的 deepseek.json：迁移过来，之后只写 ai.json
  let mut st = Stored::default();
  if let Some(old) = fs::read_to_string(dir.join("deepseek.json"))
    .ok()
    .and_then(|s| serde_json::from_str::<Creds>(&s).ok())
  {
    st.deepseek = old;
  }
  st.provider = "deepseek".into();
  st
}

fn save_stored(app: &AppHandle, s: &Stored) -> Result<(), String> {
  let p = config_dir(app)?.join("ai.json");
  let json = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
  fs::write(p, json).map_err(|e| format!("保存失败: {e}"))
}

fn key_hint(key: &str) -> String {
  let chars: Vec<char> = key.chars().collect();
  if chars.is_empty() {
    String::new()
  } else if chars.len() <= 10 {
    "••••••".into()
  } else {
    let head: String = chars[..3].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}…{tail}")
  }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VendorView {
  label: String,
  has_key: bool,
  key_hint: String,
  model: String,
  default_model: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalView {
  mode: String,
  mode_label: String,
  base_url: String,
  model: String,
  default_url: String,
  default_model: String,
  has_key: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettingsView {
  provider: String,
  deepseek: VendorView,
  qwen: VendorView,
  chatgpt: VendorView,
  local: LocalView,
}

fn vendor_view(s: &Stored, v: Vendor) -> VendorView {
  let c = s.creds(v);
  VendorView {
    label: v.label().into(),
    has_key: !c.api_key.trim().is_empty(),
    key_hint: key_hint(&c.api_key),
    model: if c.model.trim().is_empty() {
      v.default_model().into()
    } else {
      c.model.clone()
    },
    default_model: v.default_model().into(),
  }
}

fn local_view(s: &Stored) -> LocalView {
  let cfg = s.local_cfg();
  LocalView {
    mode: cfg.mode.id().into(),
    mode_label: cfg.mode.label().into(),
    base_url: cfg.base_url,
    model: cfg.model,
    default_url: DEFAULT_LOCAL_URL.into(),
    default_model: DEFAULT_LOCAL_MODEL.into(),
    has_key: !s.local_api_key.trim().is_empty(),
  }
}

fn view_of(s: &Stored) -> AiSettingsView {
  AiSettingsView {
    provider: s.vendor().id().into(),
    deepseek: vendor_view(s, Vendor::Deepseek),
    qwen: vendor_view(s, Vendor::Qwen),
    chatgpt: vendor_view(s, Vendor::Chatgpt),
    local: local_view(s),
  }
}

fn valid_model(m: &str) -> bool {
  // 允许 Ollama 的 qwen2.5:3b，以及 LM Studio 的 qwen/qwen3.6-27b、variant@quant
  !m.is_empty()
    && m.len() <= 96
    && m
      .chars()
      .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':' | '/' | '@'))
}

#[tauri::command]
pub fn ai_settings_get(app: AppHandle) -> Result<AiSettingsView, String> {
  Ok(view_of(&load_stored(&app)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettingsInput {
  /// 当前总结服务 deepseek | qwen | chatgpt
  provider: Option<String>,
  /// Key / 模型所属的服务商（缺省为当前总结服务）
  vendor: Option<String>,
  api_key: Option<String>,
  model: Option<String>,
  clear_key: Option<bool>,
  /// off | map | map_merge
  local_preprocess: Option<String>,
  local_base_url: Option<String>,
  local_model: Option<String>,
  local_api_key: Option<String>,
  clear_local_key: Option<bool>,
}

fn normalize_local_url(raw: &str) -> Result<String, String> {
  let u = raw.trim().trim_end_matches('/').to_string();
  if u.is_empty() {
    return Ok(DEFAULT_LOCAL_URL.into());
  }
  if !(u.starts_with("http://") || u.starts_with("https://")) {
    return Err("本地地址需以 http:// 或 https:// 开头".into());
  }
  if u.len() > 200 {
    return Err("本地地址过长".into());
  }
  // 允许用户填到 /v1 或到根；统一成 …/v1
  let base = if u.ends_with("/v1") {
    u
  } else if u.contains("/v1/") {
    u.split("/v1/").next().unwrap_or(&u).to_string() + "/v1"
  } else {
    format!("{u}/v1")
  };
  Ok(base)
}

/// 只改传入的字段；api_key 为空表示不改；clear_key=true 清除该服务商的 Key
#[tauri::command]
pub fn ai_settings_set(app: AppHandle, input: AiSettingsInput) -> Result<AiSettingsView, String> {
  let mut s = load_stored(&app);
  if let Some(p) = input.provider.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
    let v = Vendor::parse(p).ok_or("未知的总结服务")?;
    s.provider = v.id().into();
  }
  let v = match input.vendor.as_deref().map(str::trim).filter(|x| !x.is_empty()) {
    Some(x) => Vendor::parse(x).ok_or("未知的服务商")?,
    None => s.vendor(),
  };
  if input.clear_key.unwrap_or(false) {
    s.creds_mut(v).api_key.clear();
  }
  if let Some(k) = input.api_key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
    if k.len() > 200 || !k.chars().all(|c| c.is_ascii_graphic()) {
      return Err("API Key 格式不对（应为一串英文数字）".into());
    }
    s.creds_mut(v).api_key = k.to_string();
  }
  if let Some(m) = input.model.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
    if !valid_model(m) {
      return Err("模型名只能含字母、数字和 . _ - :".into());
    }
    s.creds_mut(v).model = m.to_string();
  }
  if let Some(mode) = input.local_preprocess.as_deref() {
    s.local_preprocess = LocalMode::parse(mode).id().into();
  }
  if let Some(url) = input.local_base_url.as_deref() {
    s.local_base_url = normalize_local_url(url)?;
  }
  if let Some(m) = input.local_model.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
    if !valid_model(m) {
      return Err("本地模型名只能含字母、数字和 . _ - :".into());
    }
    s.local_model = m.to_string();
  }
  if input.clear_local_key.unwrap_or(false) {
    s.local_api_key.clear();
  }
  if let Some(k) = input.local_api_key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
    if k.len() > 200 {
      return Err("本地 API Key 过长".into());
    }
    s.local_api_key = k.to_string();
  }
  save_stored(&app, &s)?;
  Ok(view_of(&s))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SummaryEvent {
  /// start | progress | delta | done | error | cancelled
  kind: String,
  message: String,
  text: Option<String>,
  percent: Option<f32>,
}

fn emit(app: &AppHandle, kind: &str, message: &str, text: Option<&str>, percent: Option<f32>) {
  let _ = app.emit(
    "sp-summary",
    &SummaryEvent {
      kind: kind.into(),
      message: message.into(),
      text: text.map(|s| s.to_string()),
      percent,
    },
  );
}

fn http_client(timeout_secs: u64) -> Result<reqwest::blocking::Client, String> {
  reqwest::blocking::Client::builder()
    .connect_timeout(Duration::from_secs(20))
    .timeout(Duration::from_secs(timeout_secs))
    .build()
    .map_err(|e| e.to_string())
}

fn api_error(v: Vendor, status: u16, body: &str) -> String {
  let detail = serde_json::from_str::<Value>(body)
    .ok()
    .and_then(|v| {
      v.pointer("/error/message")
        .and_then(|m| m.as_str())
        .map(|s| s.to_string())
    })
    .unwrap_or_else(|| body.chars().take(200).collect());
  let head = match status {
    400 => "请求格式有误",
    401 => "API Key 无效或未填写",
    402 => "账户余额不足或额度已用完",
    403 => "没有权限访问该模型",
    404 => "接口地址或模型名不对（模型名区分大小写）",
    422 => "请求参数有误（模型名可能不对）",
    429 => "请求太频繁，请稍后再试",
    500 | 502 | 503 | 504 => "服务繁忙，请稍后再试",
    _ => "返回错误",
  };
  let name = v.label();
  if detail.is_empty() {
    format!("{name}：{head}（HTTP {status}）")
  } else {
    format!("{name}：{head}（HTTP {status}）：{detail}")
  }
}

const LOCAL_SYSTEM: &str = "你是严谨的中文文稿蒸馏助手。只依据用户提供的正文提炼要点，不要编造。\
输出简洁 Markdown。文稿可能有错字，人名术语结合上下文合理校正，不确定则保持原样。\
不要输出思考过程、推理链或「好的我来…」类开场，直接从要点正文开始。";

fn strip_local_noise(s: &str) -> String {
  let mut t = s.trim().to_string();
  // 常见思考标签：保留标签后的正文
  for (a, b) in [
    ("<think>", "</think>"),
    ("<thinking>", "</thinking>"),
    ("<reasoning>", "</reasoning>"),
  ] {
    while let Some(i) = t.find(a) {
      if let Some(j) = t[i..].find(b) {
        let end = i + j + b.len();
        t.replace_range(i..end, "");
      } else {
        // 只有开头没有结尾：丢掉思考前缀
        t = t[i + a.len()..].to_string();
        break;
      }
    }
  }
  // 纯英文思考草稿时，尽量取最后一段像正文的部分
  if t.lines().filter(|l| !l.trim().is_empty()).count() > 8
    && t.contains("Thinking")
    && !t.contains("##")
    && !t.contains('第')
  {
    if let Some(last) = t
      .split("\n\n")
      .map(str::trim)
      .filter(|p| p.chars().any(|c| c > '\u{7f}') || p.starts_with('#') || p.starts_with('-'))
      .last()
    {
      return last.to_string();
    }
  }
  t.trim().to_string()
}

fn message_text(v: &Value) -> String {
  let msg = v.pointer("/choices/0/message");
  let content = msg
    .and_then(|m| m.get("content"))
    .and_then(|c| c.as_str())
    .unwrap_or("")
    .trim();
  let reasoning = msg
    .and_then(|m| m.get("reasoning_content").or_else(|| m.get("reasoning")))
    .and_then(|c| c.as_str())
    .unwrap_or("")
    .trim();
  // 优先 content；Qwen3/LM Studio 常把结果放在 reasoning_content
  let raw = if !content.is_empty() {
    if reasoning.is_empty() {
      content.to_string()
    } else {
      format!("{reasoning}\n{content}")
    }
  } else {
    reasoning.to_string()
  };
  strip_local_noise(&raw)
}

/// 本地 OpenAI 兼容接口：非流式一次返回（适合 LM Studio / Ollama 做分段蒸馏）
fn chat_local(
  client: &reqwest::blocking::Client,
  local: &LocalCfg,
  user: &str,
  cancel: &AtomicBool,
) -> Result<String, String> {
  if cancel.load(Ordering::SeqCst) {
    return Err("已取消".into());
  }
  let url = format!("{}/chat/completions", local.base_url.trim_end_matches('/'));
  // /no_think：Qwen3 系列常用关闭思考；enable_thinking=false 给兼容中转
  let user_forced = format!("{user}\n\n/no_think");
  let body = json!({
    "model": local.model,
    "messages": [
      { "role": "system", "content": LOCAL_SYSTEM },
      { "role": "user", "content": user_forced },
    ],
    "stream": false,
    "temperature": 0.2,
    "max_tokens": 8192,
    "enable_thinking": false,
  });
  let mut req = client
    .post(&url)
    .header("Content-Type", "application/json")
    .body(body.to_string());
  let key = if local.api_key.is_empty() {
    "lm-studio"
  } else {
    &local.api_key
  };
  req = req.bearer_auth(key);
  let resp = req
    .send()
    .map_err(|e| format!("连接本地模型失败（{}）：{e}。请在 LM Studio 打开 Local Server（默认端口 1234）。", local.base_url))?;
  let status = resp.status();
  let txt = resp.text().unwrap_or_default();
  if !status.is_success() {
    let detail = serde_json::from_str::<Value>(&txt)
      .ok()
      .and_then(|v| {
        v.pointer("/error/message")
          .and_then(|m| m.as_str())
          .map(|s| s.to_string())
      })
      .unwrap_or_else(|| txt.chars().take(180).collect());
    return Err(format!(
      "本地模型错误（HTTP {}）：{}。模型「{}」是否已加载？",
      status.as_u16(),
      detail,
      local.model
    ));
  }
  let v: Value = serde_json::from_str(&txt).map_err(|e| format!("本地模型返回无法解析：{e}"))?;
  let content = message_text(&v);
  if content.is_empty() {
    return Err("本地模型没有返回内容（可能还在思考模式或上下文过长；可在 LM Studio 关闭 reasoning）".into());
  }
  Ok(content)
}

/// 探测本地服务是否可用；尽量列出已安装模型名
#[tauri::command]
pub async fn ai_local_probe(app: AppHandle) -> Result<serde_json::Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let cfg = load_stored(&app).local_cfg();
    let client = http_client(12)?;
    let models_url = format!("{}/models", cfg.base_url.trim_end_matches('/'));
    let mut req = client.get(&models_url);
    let key = if cfg.api_key.is_empty() { "ollama" } else { cfg.api_key.as_str() };
    req = req.bearer_auth(key);
    let resp = req
      .send()
      .map_err(|e| format!("连不上本地服务 {}: {e}", cfg.base_url))?;
    let status = resp.status();
    let txt = resp.text().unwrap_or_default();
    if !status.is_success() {
      return Err(format!("本地服务 HTTP {}：{}", status.as_u16(), txt.chars().take(120).collect::<String>()));
    }
    let mut names: Vec<String> = Vec::new();
    if let Ok(v) = serde_json::from_str::<Value>(&txt) {
      if let Some(arr) = v.get("data").and_then(|d| d.as_array()) {
        for it in arr {
          if let Some(id) = it.get("id").and_then(|x| x.as_str()) {
            names.push(id.to_string());
          }
        }
      }
    }
    Ok(json!({
      "ok": true,
      "baseUrl": cfg.base_url,
      "model": cfg.model,
      "models": names,
      "modelReady": names.is_empty() || names.iter().any(|n| n == &cfg.model || n.starts_with(&format!("{}:", cfg.model)) || cfg.model.starts_with(n)),
    }))
  })
  .await
  .map_err(|e| e.to_string())?
}

/// 一次流式对话；on_delta 收到每个增量文本
fn chat_stream(
  client: &reqwest::blocking::Client,
  v: Vendor,
  key: &str,
  model: &str,
  user: &str,
  cancel: &AtomicBool,
  on_delta: &mut dyn FnMut(&str),
) -> Result<(String, bool), String> {
  // 讲道笔记模板较长，统一放宽输出上限（deepseek-chat 最大 8K）
  let max_tokens: u32 = 8192;
  let mut body = json!({
    "model": model,
    "messages": [
      { "role": "system", "content": SYSTEM_PROMPT },
      { "role": "user", "content": user },
    ],
    "stream": true,
    "max_tokens": max_tokens,
    "temperature": 0.3,
  });
  // Qwen3.8-flash 默认开启深度思考；思考阶段只回传 reasoning_content，
  // 用户看不到逐字总结。总结场景关闭思考，保留标准增量 content 流。
  if v == Vendor::Qwen {
    body["enable_thinking"] = json!(false);
    body["incremental_output"] = json!(true);
  }
  let resp = client
    .post(v.url())
    .bearer_auth(key)
    .header("Content-Type", "application/json")
    .header("Accept", "text/event-stream")
    .body(body.to_string())
    .send()
    .map_err(|e| format!("连接{}失败：{e}", v.label()))?;
  let status = resp.status();
  if !status.is_success() {
    let txt = resp.text().unwrap_or_default();
    return Err(api_error(v, status.as_u16(), &txt));
  }
  let mut full = String::new();
  let mut truncated = false;
  for line in BufReader::new(resp).lines() {
    if cancel.load(Ordering::SeqCst) {
      return Err("已取消".into());
    }
    let line = line.map_err(|e| format!("读取响应中断：{e}"))?;
    let Some(data) = line.trim().strip_prefix("data:") else {
      continue;
    };
    let data = data.trim();
    if data == "[DONE]" {
      break;
    }
    let Ok(v2) = serde_json::from_str::<Value>(data) else {
      continue;
    };
    if let Some(msg) = v2.pointer("/error/message").and_then(|m| m.as_str()) {
      return Err(format!("{} 返回错误：{msg}", v.label()));
    }
    if let Some(s) = v2.pointer("/choices/0/delta/content").and_then(|c| c.as_str()) {
      if !s.is_empty() {
        full.push_str(s);
        on_delta(s);
      }
    }
    if v2.pointer("/choices/0/finish_reason").and_then(|c| c.as_str()) == Some("length") {
      truncated = true;
    }
  }
  Ok((full, truncated))
}

fn char_len(s: &str) -> usize {
  s.chars().count()
}

fn take_chars(s: &str, max: usize) -> String {
  s.chars().take(max).collect()
}

/// 是否像章节/小节标题行（用于优先在边界处分段）
fn looks_like_heading(line: &str) -> bool {
  let t = line.trim();
  if t.is_empty() || t.chars().count() > 48 {
    return false;
  }
  if t.starts_with('#') {
    return true;
  }
  let cn = regex_is_match(r"^第[一二三四五六七八九十百千零〇两\d]+[章节回卷篇部]", t);
  let en = t.to_ascii_lowercase().starts_with("chapter ");
  let page = regex_is_match(r"^\[?(?:第\s*)?\d+\s*页\]?$", t);
  cn || en || page
}

/// 极简匹配，避免再引 regex crate：前缀/字符类够用
fn regex_is_match(pat: &str, text: &str) -> bool {
  match pat {
    r"^第[一二三四五六七八九十百千零〇两\d]+[章节回卷篇部]" => {
      let mut it = text.chars();
      if it.next() != Some('第') {
        return false;
      }
      let mut saw = false;
      for c in it.by_ref() {
        if "一二三四五六七八九十百千零〇两".contains(c) || c.is_ascii_digit() {
          saw = true;
          continue;
        }
        return saw && "章节回卷篇部".contains(c);
      }
      false
    }
    r"^\[?(?:第\s*)?\d+\s*页\]?$" => {
      let t = text.trim().trim_matches(|c| c == '[' || c == ']');
      let t = t.trim_start_matches('第').trim();
      let digits: String = t.chars().take_while(|c| c.is_ascii_digit()).collect();
      !digits.is_empty() && t[digits.len()..].trim() == "页"
    }
    _ => false,
  }
}

/// 按行聚合；若遇章节标题且当前段已有一定篇幅，则在标题前切开
fn split_text(text: &str, max_chars: usize) -> Vec<String> {
  let mut parts: Vec<String> = Vec::new();
  let mut cur = String::new();
  let mut cur_n = 0usize;
  // 当前段至少写到这么多才允许「遇标题就切」，避免碎段
  let soft_min = max_chars / 3;

  for line in text.lines() {
    let raw = line.trim_end();
    let line = raw.trim();
    if line.is_empty() {
      continue;
    }
    let chars: Vec<char> = line.chars().collect();
    let pieces: Vec<String> = if chars.len() > max_chars {
      chars.chunks(max_chars).map(|c| c.iter().collect()).collect()
    } else {
      vec![line.to_string()]
    };
    for (pi, p) in pieces.into_iter().enumerate() {
      let n = char_len(&p);
      let at_heading = pi == 0 && looks_like_heading(&p);
      if cur_n > 0
        && (cur_n + n + 1 > max_chars || (at_heading && cur_n >= soft_min))
      {
        parts.push(std::mem::take(&mut cur));
        cur_n = 0;
      }
      if !cur.is_empty() {
        cur.push('\n');
        cur_n += 1;
      }
      cur.push_str(&p);
      cur_n += n;
    }
  }
  if !cur.is_empty() {
    parts.push(cur);
  }
  if parts.is_empty() && !text.trim().is_empty() {
    parts.push(text.trim().to_string());
  }
  parts
}

/// 从本段笔记里抽出「术语 / 关联 / 线索」作下一段的前文脉络
fn bridge_from_note(note: &str) -> String {
  let mut keep = String::new();
  let mut take = false;
  for line in note.lines() {
    let t = line.trim();
    if t.starts_with("## ") {
      take = t.contains("人名")
        || t.contains("术语")
        || t.contains("关联")
        || t.contains("线索")
        || t.contains("论点");
    }
    if take {
      keep.push_str(line);
      keep.push('\n');
    }
  }
  if keep.trim().is_empty() {
    keep = take_chars(note, BRIDGE_MAX_CHARS);
  }
  let s = keep.trim().to_string();
  if char_len(&s) > BRIDGE_MAX_CHARS {
    format!("{}…", take_chars(&s, BRIDGE_MAX_CHARS.saturating_sub(1)))
  } else {
    s
  }
}

fn peek_title(part: &str) -> String {
  for line in part.lines() {
    let t = line.trim();
    if t.is_empty() {
      continue;
    }
    if looks_like_heading(t) || t.starts_with('#') {
      return take_chars(t.trim_start_matches('#').trim(), 40);
    }
    return take_chars(t, 36);
  }
  "（本段）".into()
}

fn map_part_prompt(i: usize, n: usize, title: &str, bridge: &str, part: &str) -> String {
  let bridge_block = if bridge.trim().is_empty() {
    "（这是首段，暂无前文）".to_string()
  } else {
    bridge.to_string()
  };
  format!(
    "你正在整理同一本长书/长文稿的第 {i}/{n} 段（本段开头线索：{title}）。\n\
目标：为后续「全书总结」准备可拼接的笔记，必须保留与前后文的关联，禁止写成孤立摘要。\n\n\
【前文脉络】（供对照呼应，勿重复扩写）\n{bridge_block}\n\n\
请只依据【本段正文】输出 Markdown，严格使用下列小标题（没有的写「无」）：\n\
## 本段定位\n一句话说明本段在全书中的作用（开篇/推进/转折/收束等）。\n\
## 论点与结构\n按原顺序列 3～8 条要点，保留关键推理，不要流水账。\n\
## 关键事实 / 案例 / 引用\n人物、事件、数据、经文或原话（短引即可）。\n\
## 人名 / 术语 / 专名\n本段出现且后文可能再用的名称。\n\
## 与前文的关联\n呼应、对比、延续、反转、补证；若看不出关联，写「本段未见明显关联」。\n\
## 未完线索\n留下的问题、伏笔、待展开论点（供后段对照）。\n\n\
要求：约 450～850 字；不要写全书总评；不要编造本段未出现的内容。\n\n\
【本段正文】\n{part}"
  )
}

fn merge_notes_prompt(chunk_notes: &str, group_i: usize, group_n: usize) -> String {
  format!(
    "下面是同一长书/长文稿的第 {group_i}/{group_n} 组分段笔记（已按原文顺序）。\n\
请合并为一份「中层纪要」，要求：\n\
1. 打通组内各段关联，按主题归类，禁止「第1段/第2段」流水账；\n\
2. 保留反复出现的人物、术语、主线与未完线索；\n\
3. 注明组内前后呼应或矛盾；\n\
4. 输出 Markdown，约 600～1200 字，不要写全书终章总评。\n\n\
【本组笔记】\n{chunk_notes}"
  )
}

fn final_synth_prompt(user_prompt: &str, n_parts: usize, notes_body: &str) -> String {
  format!(
    "{user_prompt}\n\n\
【长文合成说明——必须遵守】\n\
你拿到的不是原文，而是按顺序提炼的分段笔记（全文共约 {n_parts} 段加工）。请据此完成「一整本书/整篇文稿」的总结：\n\
1. **主线优先**：找出贯穿前后的核心问题、立场或叙事弧，写成一气呵成的整体，禁止按「第1段、第2段」复述。\n\
2. **关联显性化**：把跨段呼应、对比、递进、反转写进「内容解读」或等价板块；前后矛盾处如实标出。\n\
3. **人物与术语统一**：同一人/概念前后称呼不一致时，选笔记中最清楚的写法并保持一致。\n\
4. **结构按主题**：板块按逻辑主题划分（通常 4～8 个），可对应原书章节精神，但不要机械复制分段编号。\n\
5. **忠实笔记**：笔记未出现的情节、观点、数据不得编造；若信息不足，写「文稿/笔记未明确提及」。\n\n\
【各段/各组笔记（原文顺序）】\n{notes_body}"
  )
}

/// 把笔记列表按字数打包成若干组
fn pack_note_groups(notes: &[String], max_chars: usize) -> Vec<String> {
  let mut groups: Vec<String> = Vec::new();
  let mut cur = String::new();
  let mut cur_n = 0usize;
  for note in notes {
    let n = char_len(note);
    if cur_n > 0 && cur_n + n + 2 > max_chars {
      groups.push(std::mem::take(&mut cur));
      cur_n = 0;
    }
    if !cur.is_empty() {
      cur.push_str("\n\n");
      cur_n += 2;
    }
    cur.push_str(note);
    cur_n += n;
  }
  if !cur.is_empty() {
    groups.push(cur);
  }
  groups
}

/// 分段/合并调用：优先本地蒸馏；失败则回退云端（避免整次总结中断）
fn distill_once(
  client: &reqwest::blocking::Client,
  local: &LocalCfg,
  use_local: bool,
  v: Vendor,
  key: &str,
  model: &str,
  user: &str,
  cancel: &AtomicBool,
  fallback_warned: &mut bool,
  app: &AppHandle,
) -> Result<String, String> {
  if use_local {
    match chat_local(client, local, user, cancel) {
      Ok(s) => return Ok(s),
      Err(e) => {
        if !*fallback_warned {
          *fallback_warned = true;
          emit(
            app,
            "progress",
            &format!("本地蒸馏暂不可用，本段起改用云端：{e}"),
            None,
            None,
          );
        }
      }
    }
  }
  let (full, _) = chat_stream(client, v, key, model, user, cancel, &mut |_: &str| {})?;
  Ok(full)
}

fn run_summary(
  app: &AppHandle,
  v: Vendor,
  key: &str,
  model: &str,
  prompt: &str,
  text: &str,
  local: LocalCfg,
  cancel: &AtomicBool,
) -> Result<String, String> {
  let client = http_client(900)?;
  let label = v.label();
  let total_chars = char_len(text);
  let mut on_delta = |s: &str| emit(app, "delta", "", Some(s), None);

  if total_chars <= SINGLE_MAX_CHARS {
    emit(app, "progress", &format!("{label} 正在总结…"), None, Some(10.0));
    let user = format!("{prompt}\n\n【转写文稿】\n{text}");
    let (full, truncated) = chat_stream(&client, v, key, model, &user, cancel, &mut on_delta)?;
    return Ok(finish_text(full, truncated, &mut on_delta));
  }

  // 超长：章节优先分段 → 带「前文脉络」提炼 →（必要时组内合并）→ 全书合成
  // 可选：分段/合并走本地蒸馏，终稿仍走云端，减少云端污染与费用
  let use_local_map = local.mode == LocalMode::Map || local.mode == LocalMode::MapMerge;
  let use_local_merge = local.mode == LocalMode::MapMerge;
  let parts = split_text(text, PART_CHARS);
  let n = parts.len().max(1);
  let mode_hint = if use_local_map {
    format!("；分段用本地「{}」", local.model)
  } else {
    String::new()
  };
  emit(
    app,
    "progress",
    &format!("长文约 {total_chars} 字，将分 {n} 段提炼并保留关联{mode_hint}…"),
    None,
    Some(4.0),
  );

  let mut notes: Vec<String> = Vec::with_capacity(n);
  let mut bridge = String::new();
  let mut fallback_warned = false;
  for (i, part) in parts.iter().enumerate() {
    if cancel.load(Ordering::SeqCst) {
      return Err("已取消".into());
    }
    let title = peek_title(part);
    let who = if use_local_map { "本地蒸馏" } else { label };
    emit(
      app,
      "progress",
      &format!("{who} 提炼 {}/{}：{}…", i + 1, n, title),
      None,
      Some(5.0 + 70.0 * i as f32 / n as f32),
    );
    let user = map_part_prompt(i + 1, n, &title, &bridge, part);
    let full = distill_once(
      &client,
      &local,
      use_local_map,
      v,
      key,
      model,
      &user,
      cancel,
      &mut fallback_warned,
      app,
    )?;
    let note = format!("### 第 {}/{} 段 · {}\n{}", i + 1, n, title, full.trim());
    bridge = bridge_from_note(&note);
    notes.push(note);
  }

  // 笔记仍过长：先做一层组内合并
  let mut synth_notes = notes;
  let joined_len: usize = synth_notes.iter().map(|s| char_len(s)).sum();
  if joined_len > NOTES_DIRECT_MAX && synth_notes.len() > 2 {
    let groups = pack_note_groups(&synth_notes, NOTES_GROUP_CHARS);
    let gn = groups.len();
    let who = if use_local_merge { "本地" } else { "云端" };
    emit(
      app,
      "progress",
      &format!("笔记较长，{who}组内合并关联 {} 组…", gn),
      None,
      Some(78.0),
    );
    let mut mid: Vec<String> = Vec::with_capacity(gn);
    for (gi, g) in groups.iter().enumerate() {
      if cancel.load(Ordering::SeqCst) {
        return Err("已取消".into());
      }
      emit(
        app,
        "progress",
        &format!("组内合并 {}/{}…", gi + 1, gn),
        None,
        Some(78.0 + 8.0 * gi as f32 / gn.max(1) as f32),
      );
      let user = merge_notes_prompt(g, gi + 1, gn);
      let full = distill_once(
        &client,
        &local,
        use_local_merge,
        v,
        key,
        model,
        &user,
        cancel,
        &mut fallback_warned,
        app,
      )?;
      mid.push(format!("### 第 {}/{} 组纪要\n{}", gi + 1, gn, full.trim()));
    }
    synth_notes = mid;
  }

  emit(
    app,
    "progress",
    &format!("云端 {label} 打通各段关联，生成全书总结…"),
    None,
    Some(90.0),
  );
  let body = synth_notes.join("\n\n");
  let user = final_synth_prompt(prompt, n, &body);
  let (full, truncated) = chat_stream(&client, v, key, model, &user, cancel, &mut on_delta)?;
  Ok(finish_text(full, truncated, &mut on_delta))
}

fn finish_text(mut full: String, truncated: bool, on_delta: &mut dyn FnMut(&str)) -> String {
  if truncated {
    let note = "\n\n（输出达到长度上限，内容被截断）";
    on_delta(note);
    full.push_str(note);
  }
  full
}

/// 流式总结：增量通过事件 sp-summary(kind=delta) 推送，返回完整文本。
/// 使用当前选中的总结服务（DeepSeek 或千问）及其已保存的模型。
#[tauri::command]
pub async fn ai_summarize(
  app: AppHandle,
  state: State<'_, SummaryState>,
  text: String,
  prompt: String,
  vendor: Option<String>,
) -> Result<String, String> {
  let text = text.trim().to_string();
  if text.chars().count() < 20 {
    return Err("文稿太短，没有可总结的内容".into());
  }
  if text.chars().count() > TEXT_MAX_CHARS {
    return Err("文稿过长（超过 60 万字），请分开总结".into());
  }
  let prompt = {
    let p = prompt.trim();
    if p.is_empty() {
      "请对下面的内容做结构化总结：一句话主旨、核心要点、值得记录的细节。".to_string()
    } else {
      // 深度结构化等长模板约 2～4 千字，留足余量
      p.chars().take(12_000).collect()
    }
  };
  let (v, key, model) = active_creds(&app, vendor.as_deref())?;
  let local = load_stored(&app).local_cfg();
  let start = if local.mode == LocalMode::Off {
    format!("连接{}…", v.label())
  } else {
    format!("本地蒸馏「{}」→ 云端 {}…", local.model, v.label())
  };
  run_job(
    app,
    &state,
    start,
    "总结完成",
    move |app, cancel| run_summary(app, v, &key, &model, &prompt, &text, local, cancel),
  )
  .await
}

/// 取 (服务商, Key, 模型)：指定了服务商就用它（用于多份总结对比），否则用设置里选中的；
/// 缺 Key / 模型名非法时直接报错
fn active_creds(app: &AppHandle, vendor: Option<&str>) -> Result<(Vendor, String, String), String> {
  let stored = load_stored(app);
  let v = match vendor.map(str::trim).filter(|s| !s.is_empty()) {
    Some(s) => Vendor::parse(s).ok_or_else(|| format!("未知的总结服务：{s}"))?,
    None => stored.vendor(),
  };
  let key = stored.creds(v).api_key.trim().to_string();
  if key.is_empty() {
    return Err(format!("请先在设置里填写并保存 {} API Key", v.label()));
  }
  let model = {
    let m = stored.creds(v).model.trim();
    if m.is_empty() {
      v.default_model().to_string()
    } else {
      m.to_string()
    }
  };
  if !valid_model(&model) {
    return Err("模型名只能含字母、数字和 . _ - :".into());
  }
  Ok((v, key, model))
}

/// 总结 / 精修共用：同一时间只跑一个任务，进度与增量都走 sp-summary 事件
async fn run_job<F>(
  app: AppHandle,
  state: &SummaryState,
  start_msg: String,
  done_msg: &'static str,
  job: F,
) -> Result<String, String>
where
  F: FnOnce(&AppHandle, &AtomicBool) -> Result<String, String> + Send + 'static,
{
  if state.running.swap(true, Ordering::SeqCst) {
    return Err("正在处理中，请先等待或停止".into());
  }
  state.cancel.store(false, Ordering::SeqCst);
  let running = state.running.clone();
  let cancel = state.cancel.clone();

  tauri::async_runtime::spawn_blocking(move || {
    let _guard = RunGuard(running);
    emit(&app, "start", &start_msg, None, Some(2.0));
    match job(&app, &cancel) {
      Ok(full) => {
        emit(&app, "done", done_msg, None, Some(100.0));
        Ok(full)
      }
      Err(e) if e == "已取消" => {
        emit(&app, "cancelled", "已停止", None, None);
        Err(e)
      }
      Err(e) => {
        emit(&app, "error", &e, None, None);
        Err(e)
      }
    }
  })
  .await
  .map_err(|e| e.to_string())?
}

const REFINE_PROMPT: &str = "你是总结的修订编辑。下面依次给出【转写文稿】（语音识别原文，可能有同音错字，仅供核对）、\
【当前总结】和【修改意见】。请严格按【修改意见】修订【当前总结】，并遵守：\n\
1. 只输出修订后的完整总结（Markdown），不要输出解释、前言或“修改说明”。\n\
2. 修改意见没有涉及的部分保持原样，不要无故改写、删减，也不要改动标题编号、层级和格式。\n\
3. 需要核对事实时以【转写文稿】为准；文稿里没有的内容不要编造，无法确认的保持原样或在句末标注“（待核实）”。\n\
4. 若意见含糊，按最合理的理解执行。";

/// 精修：按用户给出的修改意见，在当前总结的基础上修订，流式返回修订后的全文
#[tauri::command]
pub async fn ai_refine(
  app: AppHandle,
  state: State<'_, SummaryState>,
  text: String,
  summary: String,
  instruction: String,
  vendor: Option<String>,
) -> Result<String, String> {
  let summary = summary.trim().to_string();
  if summary.chars().count() < 20 {
    return Err("还没有可精修的总结，请先生成总结".into());
  }
  if summary.chars().count() > TEXT_MAX_CHARS {
    return Err("总结过长，无法精修".into());
  }
  let instruction: String = instruction.trim().chars().take(2000).collect();
  if instruction.is_empty() {
    return Err("请先写明哪里要改、怎么改".into());
  }
  // 文稿太长就不附带（避免超出模型上下文），此时只能依据总结本身修订
  let text = text.trim();
  let transcript = if text.chars().count() <= SINGLE_MAX_CHARS {
    format!("【转写文稿】\n{text}")
  } else {
    "【转写文稿】\n（文稿过长，未附上；请仅依据【当前总结】与【修改意见】修订，不要自行补充事实。）".to_string()
  };
  let user = format!(
    "{REFINE_PROMPT}\n\n{transcript}\n\n【当前总结】\n{summary}\n\n【修改意见】\n{instruction}"
  );
  let (v, key, model) = active_creds(&app, vendor.as_deref())?;
  run_job(
    app,
    &state,
    format!("{}正在精修…", v.label()),
    "精修完成",
    move |app, cancel| {
      let client = http_client(900)?;
      emit(app, "progress", &format!("{} 正在按意见修订…", v.label()), None, Some(10.0));
      let mut on_delta = |s: &str| emit(app, "delta", "", Some(s), None);
      let (full, truncated) = chat_stream(&client, v, &key, &model, &user, cancel, &mut on_delta)?;
      Ok(finish_text(full, truncated, &mut on_delta))
    },
  )
  .await
}

#[tauri::command]
pub fn ai_cancel(state: State<'_, SummaryState>) {
  state.cancel.store(true, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn split_keeps_all_text_and_limit() {
    let line = "字".repeat(500);
    let text = (0..50).map(|_| line.clone()).collect::<Vec<_>>().join("\n");
    let parts = split_text(&text, 18_000);
    assert!(parts.len() >= 2);
    assert!(parts.iter().all(|p| p.chars().count() <= 18_000));
    let total: usize = parts.iter().map(|p| p.chars().filter(|c| *c == '字').count()).sum();
    assert_eq!(total, 500 * 50);
  }

  #[test]
  fn split_hard_cuts_long_line() {
    let text = "字".repeat(45_000);
    let parts = split_text(&text, 18_000);
    assert_eq!(parts.len(), 3);
    assert!(parts.iter().all(|p| p.chars().count() <= 18_000));
  }

  #[test]
  fn split_prefers_chapter_boundary() {
    let chap1 = format!("第一章 开篇\n{}", "甲".repeat(6000));
    let chap2 = format!("第二章 转折\n{}", "乙".repeat(6000));
    let text = format!("{chap1}\n{chap2}");
    let parts = split_text(&text, 10_000);
    assert!(parts.len() >= 2, "parts={}", parts.len());
    assert!(parts[1].contains("第二章") || parts.iter().any(|p| p.starts_with("第二章")), "{:?}", parts.iter().map(|p| take_chars(p, 20)).collect::<Vec<_>>());
  }

  #[test]
  fn heading_detects_cn_chapter() {
    assert!(looks_like_heading("第一章 引言"));
    assert!(looks_like_heading("## 小结"));
    assert!(!looks_like_heading("这是一句普通的正文，很长很长很长很长很长很长很长。"));
  }

  #[test]
  fn key_hint_masks() {
    assert_eq!(key_hint(""), "");
    assert_eq!(key_hint("sk-abc"), "••••••");
    assert_eq!(key_hint("sk-1234567890abcdef"), "sk-…cdef");
  }

  #[test]
  fn model_validation() {
    assert!(valid_model("deepseek-chat"));
    assert!(valid_model("qwen3.8-flash"));
    assert!(valid_model("gpt-6-luna"));
    assert!(valid_model("GPT-6-Luna"));
    assert!(!valid_model("a b"));
    assert!(!valid_model("../x"));
    assert!(!valid_model(""));
  }

  #[test]
  fn api_error_messages() {
    let e = api_error(Vendor::Deepseek, 401, r#"{"error":{"message":"Authentication Fails"}}"#);
    assert!(e.contains("API Key") && e.contains("Authentication Fails"));
    assert!(api_error(Vendor::Deepseek, 402, "").contains("余额"));
    assert!(api_error(Vendor::Qwen, 404, "").contains("千问"));
  }

  #[test]
  fn legacy_deepseek_file_parses() {
    let old: Creds = serde_json::from_str(r#"{"apiKey":"sk-abc123456","model":"deepseek-chat"}"#).unwrap();
    assert_eq!(old.api_key, "sk-abc123456");
    assert_eq!(old.model, "deepseek-chat");
  }

  #[test]
  fn vendor_defaults() {
    assert_eq!(Vendor::Qwen.default_model(), "qwen3.8-flash");
    assert_eq!(Vendor::Chatgpt.default_model(), "gpt-6-luna");
    assert_eq!(Vendor::parse("qwen"), Some(Vendor::Qwen));
    assert_eq!(Vendor::parse("chatgpt"), Some(Vendor::Chatgpt));
    assert_eq!(Vendor::parse("openai"), Some(Vendor::Chatgpt));
    assert_eq!(Vendor::parse("x"), None);
    assert!(Vendor::Chatgpt.url().contains("sub.601730.xyz"));
  }

  /// 真实千问调用：QWEN_API_KEY=sk-... cargo test --lib -- llm::tests::qwen_summary_live --ignored --nocapture
  #[test]
  #[ignore]
  fn qwen_summary_live() {
    let key = std::env::var("QWEN_API_KEY").expect("QWEN_API_KEY");
    let client = http_client(120).unwrap();
    let cancel = AtomicBool::new(false);
    let (full, _) = chat_stream(
      &client,
      Vendor::Qwen,
      &key,
      "qwen3.8-flash",
      "请用一句话总结：今天天气很好，我们去公园散步，遇到了很多朋友。",
      &cancel,
      &mut |_: &str| {},
    )
    .unwrap();
    println!("qwen summary: {full}");
    assert!(!full.trim().is_empty());
  }
}
