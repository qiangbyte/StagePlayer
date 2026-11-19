//! 大模型总结设置与调用（DeepSeek / 千问，可切换）。
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
/// 文稿不超过这个字数时一次性总结
const SINGLE_MAX_CHARS: usize = 30_000;
/// 超长文稿分段时每段字数
const PART_CHARS: usize = 18_000;
/// 前端传入的文稿上限（防误操作）
const TEXT_MAX_CHARS: usize = 600_000;

const SYSTEM_PROMPT: &str = "你是严谨的中文内容整理助手。只依据用户提供的转写文稿进行总结，不要编造文稿里没有的内容。\
文稿由语音识别自动生成，可能有同音错字、断句不当；请结合上下文理解，对明显的人名、术语、经文名称做合理校正，\
无法确定时保持原样。输出使用 Markdown，条理清晰。";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Vendor {
  Deepseek,
  Qwen,
}

impl Vendor {
  fn parse(s: &str) -> Option<Vendor> {
    match s.trim() {
      "deepseek" => Some(Vendor::Deepseek),
      "qwen" => Some(Vendor::Qwen),
      _ => None,
    }
  }
  fn id(self) -> &'static str {
    match self {
      Vendor::Deepseek => "deepseek",
      Vendor::Qwen => "qwen",
    }
  }
  fn label(self) -> &'static str {
    match self {
      Vendor::Deepseek => "DeepSeek",
      Vendor::Qwen => "千问",
    }
  }
  fn url(self) -> &'static str {
    match self {
      Vendor::Deepseek => DEEPSEEK_URL,
      Vendor::Qwen => QWEN_CHAT_URL,
    }
  }
  /// 模型名区分大小写：千问必须用小写 qwen3.8-flash
  fn default_model(self) -> &'static str {
    match self {
      Vendor::Deepseek => "deepseek-chat",
      Vendor::Qwen => "qwen3.8-flash",
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

#[derive(Default, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Stored {
  /// 当前总结服务：deepseek | qwen
  #[serde(default)]
  provider: String,
  #[serde(default)]
  deepseek: Creds,
  #[serde(default)]
  qwen: Creds,
}

impl Stored {
  fn vendor(&self) -> Vendor {
    Vendor::parse(&self.provider).unwrap_or(Vendor::Deepseek)
  }
  fn creds(&self, v: Vendor) -> &Creds {
    match v {
      Vendor::Deepseek => &self.deepseek,
      Vendor::Qwen => &self.qwen,
    }
  }
  fn creds_mut(&mut self, v: Vendor) -> &mut Creds {
    match v {
      Vendor::Deepseek => &mut self.deepseek,
      Vendor::Qwen => &mut self.qwen,
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
pub struct AiSettingsView {
  provider: String,
  deepseek: VendorView,
  qwen: VendorView,
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

fn view_of(s: &Stored) -> AiSettingsView {
  AiSettingsView {
    provider: s.vendor().id().into(),
    deepseek: vendor_view(s, Vendor::Deepseek),
    qwen: vendor_view(s, Vendor::Qwen),
  }
}

fn valid_model(m: &str) -> bool {
  !m.is_empty()
    && m.len() <= 64
    && m
      .chars()
      .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':'))
}

#[tauri::command]
pub fn ai_settings_get(app: AppHandle) -> Result<AiSettingsView, String> {
  Ok(view_of(&load_stored(&app)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettingsInput {
  /// 当前总结服务 deepseek | qwen
  provider: Option<String>,
  /// Key / 模型所属的服务商（缺省为当前总结服务）
  vendor: Option<String>,
  api_key: Option<String>,
  model: Option<String>,
  clear_key: Option<bool>,
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

/// 按行聚合，每段不超过 max_chars；超长单行硬切
fn split_text(text: &str, max_chars: usize) -> Vec<String> {
  let mut parts: Vec<String> = Vec::new();
  let mut cur = String::new();
  let mut cur_n = 0usize;
  for line in text.lines() {
    let line = line.trim();
    if line.is_empty() {
      continue;
    }
    let chars: Vec<char> = line.chars().collect();
    let mut pieces: Vec<String> = Vec::new();
    if chars.len() > max_chars {
      for c in chars.chunks(max_chars) {
        pieces.push(c.iter().collect());
      }
    } else {
      pieces.push(line.to_string());
    }
    for p in pieces {
      let n = p.chars().count();
      if cur_n > 0 && cur_n + n + 1 > max_chars {
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
  parts
}

fn run_summary(
  app: &AppHandle,
  v: Vendor,
  key: &str,
  model: &str,
  prompt: &str,
  text: &str,
  cancel: &AtomicBool,
) -> Result<String, String> {
  let client = http_client(900)?;
  let label = v.label();
  let total_chars = text.chars().count();
  let mut on_delta = |s: &str| emit(app, "delta", "", Some(s), None);

  if total_chars <= SINGLE_MAX_CHARS {
    emit(app, "progress", &format!("{label} 正在总结…"), None, Some(10.0));
    let user = format!("{prompt}\n\n【转写文稿】\n{text}");
    let (full, truncated) = chat_stream(&client, v, key, model, &user, cancel, &mut on_delta)?;
    return Ok(finish_text(full, truncated, &mut on_delta));
  }

  // 超长：先分段提炼，再合并总结
  let parts = split_text(text, PART_CHARS);
  let n = parts.len();
  let mut notes: Vec<String> = Vec::with_capacity(n);
  for (i, part) in parts.iter().enumerate() {
    if cancel.load(Ordering::SeqCst) {
      return Err("已取消".into());
    }
    emit(
      app,
      "progress",
      &format!("文稿较长，分段提炼 {}/{}…", i + 1, n),
      None,
      Some(5.0 + 80.0 * i as f32 / n as f32),
    );
    let user = format!(
      "这是一篇长篇讲话转写的第 {}/{} 段。请按原顺序提炼本段的论点、重要经文/案例/数据、人名术语，\
用条目列出，约 300–600 字，不要写总评。\n\n【转写文稿】\n{}",
      i + 1,
      n,
      part
    );
    let (full, _) = chat_stream(&client, v, key, model, &user, cancel, &mut |_: &str| {})?;
    notes.push(format!("### 第 {} 段要点\n{}", i + 1, full.trim()));
  }
  emit(app, "progress", "合并各段，生成整体总结…", None, Some(88.0));
  let user = format!(
    "{prompt}\n\n以下是同一篇讲话按先后顺序分成 {n} 段整理出的要点，请据此完成整体总结（不要逐段复述）：\n\n{}",
    notes.join("\n\n")
  );
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
      p.chars().take(4000).collect()
    }
  };
  let (v, key, model) = active_creds(&app, vendor.as_deref())?;
  run_job(
    app,
    &state,
    format!("连接{}…", v.label()),
    "总结完成",
    move |app, cancel| run_summary(app, v, &key, &model, &prompt, &text, cancel),
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
  fn key_hint_masks() {
    assert_eq!(key_hint(""), "");
    assert_eq!(key_hint("sk-abc"), "••••••");
    assert_eq!(key_hint("sk-1234567890abcdef"), "sk-…cdef");
  }

  #[test]
  fn model_validation() {
    assert!(valid_model("deepseek-chat"));
    assert!(valid_model("qwen3.8-flash"));
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
    assert_eq!(Vendor::parse("qwen"), Some(Vendor::Qwen));
    assert_eq!(Vendor::parse("x"), None);
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
