//! 文稿导入：TXT / EPUB / MOBI → 纯文本（本地解析，不上传）。
//! EPUB 用已有 zip + 简单去标签；MOBI 用 mobi crate；TXT 支持 UTF-8 / GBK。

use serde::Serialize;
use std::io::{Cursor, Read};
use std::path::Path;
use zip::ZipArchive;

const MAX_BYTES: u64 = 80 * 1024 * 1024; // 80MB
const MAX_OUT_CHARS: usize = 800_000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocTextResult {
  pub title: String,
  pub text: String,
  pub kind: String,
  pub chars: usize,
}

#[tauri::command]
pub async fn extract_doc_text(path: String) -> Result<DocTextResult, String> {
  tauri::async_runtime::spawn_blocking(move || extract_doc_text_blocking(&path))
    .await
    .map_err(|e| e.to_string())?
}

fn extract_doc_text_blocking(path: &str) -> Result<DocTextResult, String> {
  let p = Path::new(path.trim().trim_matches('"'));
  if !p.is_file() {
    return Err(format!("找不到文件：{}", p.display()));
  }
  let meta = std::fs::metadata(p).map_err(|e| format!("读取文件信息失败：{e}"))?;
  if meta.len() > MAX_BYTES {
    return Err("文件过大（超过 80MB），请先拆分或另存精简版".into());
  }
  let ext = p
    .extension()
    .and_then(|e| e.to_str())
    .unwrap_or("")
    .to_ascii_lowercase();
  let fallback_title = p
    .file_stem()
    .map(|s| s.to_string_lossy().into_owned())
    .unwrap_or_else(|| "导入文稿".into());

  let mut out = match ext.as_str() {
    "txt" | "text" | "md" | "markdown" => {
      let bytes = std::fs::read(p).map_err(|e| format!("读取失败：{e}"))?;
      DocTextResult {
        title: fallback_title.clone(),
        text: decode_text_bytes(&bytes),
        kind: "txt".into(),
        chars: 0,
      }
    }
    "epub" => extract_epub(p, &fallback_title)?,
    "mobi" | "prc" | "azw" => extract_mobi(p, &fallback_title)?,
    "azw3" => {
      return Err("暂不支持 .azw3（KF8）。请用 Calibre 另存为 EPUB / MOBI / TXT 后再导入".into());
    }
    _ => {
      return Err(format!("不支持的文稿格式：.{ext}（目前支持 txt / epub / mobi）"));
    }
  };

  out.text = normalize_doc_text(&out.text);
  if out.text.trim().is_empty() {
    return Err("没有抽出文字（可能是加密、纯图片或空文件）".into());
  }
  // 过长截断，避免总结/UI 撑爆
  let chars: Vec<char> = out.text.chars().collect();
  if chars.len() > MAX_OUT_CHARS {
    out.text = chars[..MAX_OUT_CHARS].iter().collect();
    out.text.push_str("\n\n…（正文过长，已截取前 80 万字）");
  }
  out.chars = out.text.chars().count();
  if out.title.trim().is_empty() {
    out.title = fallback_title;
  }
  Ok(out)
}

fn decode_text_bytes(bytes: &[u8]) -> String {
  if let Ok(s) = std::str::from_utf8(bytes) {
    return s.to_string();
  }
  // 国内 TXT 常见 GBK / GB18030
  encoding_rs::GBK.decode(bytes).0.into_owned()
}

fn normalize_doc_text(s: &str) -> String {
  let mut out = String::with_capacity(s.len());
  let mut blank = 0u8;
  for line in s.replace('\u{00a0}', " ").replace('\r', "").lines() {
    let t = line.trim_end();
    if t.trim().is_empty() {
      blank = blank.saturating_add(1);
      if blank <= 2 {
        out.push('\n');
      }
    } else {
      blank = 0;
      out.push_str(t);
      out.push('\n');
    }
  }
  out.trim().to_string()
}

fn strip_html(html: &str) -> String {
  let mut out = String::with_capacity(html.len());
  let mut in_tag = false;
  let mut in_script = false;
  let mut tag = String::new();
  let chars: Vec<char> = html.chars().collect();
  let mut i = 0usize;
  while i < chars.len() {
    // 用字符切片判断标签开头（ASCII 标签名）
    let starts_with_ci = |at: usize, pat: &str| -> bool {
      let p: Vec<char> = pat.chars().collect();
      if at + p.len() > chars.len() {
        return false;
      }
      chars[at..at + p.len()]
        .iter()
        .zip(p.iter())
        .all(|(a, b)| a.to_ascii_lowercase() == b.to_ascii_lowercase())
    };

    if !in_tag && starts_with_ci(i, "<script") {
      in_script = true;
    }
    if !in_tag && starts_with_ci(i, "<style") {
      in_script = true;
    }
    if in_script {
      if starts_with_ci(i, "</script>") {
        in_script = false;
        i += 9;
        continue;
      }
      if starts_with_ci(i, "</style>") {
        in_script = false;
        i += 8;
        continue;
      }
      i += 1;
      continue;
    }
    let c = chars[i];
    if c == '<' {
      in_tag = true;
      tag.clear();
      i += 1;
      continue;
    }
    if in_tag {
      if c == '>' {
        let t = tag.to_ascii_lowercase();
        if t.starts_with("br")
          || t == "p"
          || t.starts_with("p ")
          || t == "/p"
          || t == "div"
          || t.starts_with("div ")
          || t == "/div"
          || t == "li"
          || t.starts_with("li ")
          || t == "/li"
          || t.starts_with("h1")
          || t == "/h1"
          || t.starts_with("h2")
          || t == "/h2"
          || t.starts_with("h3")
          || t == "/h3"
          || t == "tr"
          || t.starts_with("tr ")
          || t == "/tr"
        {
          out.push('\n');
        }
        in_tag = false;
      } else if tag.len() < 64 {
        tag.push(c);
      }
      i += 1;
      continue;
    }
    if c == '&' {
      if starts_with_ci(i, "&nbsp;") {
        out.push(' ');
        i += 6;
        continue;
      }
      if starts_with_ci(i, "&amp;") {
        out.push('&');
        i += 5;
        continue;
      }
      if starts_with_ci(i, "&lt;") {
        out.push('<');
        i += 4;
        continue;
      }
      if starts_with_ci(i, "&gt;") {
        out.push('>');
        i += 4;
        continue;
      }
      if starts_with_ci(i, "&quot;") {
        out.push('"');
        i += 6;
        continue;
      }
    }
    out.push(c);
    i += 1;
  }
  out
}

fn zip_normalize(name: &str) -> String {
  name.replace('\\', "/").trim_start_matches('/').to_string()
}

fn zip_read_string(zip: &mut ZipArchive<Cursor<Vec<u8>>>, name: &str) -> Option<String> {
  let want = zip_normalize(name);
  let want_lower = want.to_ascii_lowercase();
  let mut idx = None;
  for i in 0..zip.len() {
    let Ok(e) = zip.by_index(i) else { continue };
    let n = zip_normalize(e.name());
    if n == want || n.to_ascii_lowercase() == want_lower {
      idx = Some(i);
      break;
    }
  }
  let mut entry = zip.by_index(idx?).ok()?;
  let mut buf = Vec::new();
  entry.read_to_end(&mut buf).ok()?;
  Some(String::from_utf8_lossy(&buf).into_owned())
}

fn extract_epub(path: &Path, fallback_title: &str) -> Result<DocTextResult, String> {
  let bytes = std::fs::read(path).map_err(|e| format!("读取 EPUB 失败：{e}"))?;
  let mut zip = ZipArchive::new(Cursor::new(bytes)).map_err(|_| "不是有效的 EPUB（ZIP）文件".to_string())?;

  let container = zip_read_string(&mut zip, "META-INF/container.xml")
    .ok_or_else(|| "EPUB 缺少 META-INF/container.xml".to_string())?;
  let rootfile = {
    let doc = roxmltree::Document::parse(&container).map_err(|e| format!("解析 container.xml 失败：{e}"))?;
    doc
      .descendants()
      .find(|n| n.tag_name().name() == "rootfile")
      .and_then(|n| n.attribute("full-path"))
      .map(|s| s.to_string())
      .ok_or_else(|| "EPUB 找不到 content.opf 路径".to_string())?
  };

  let opf = zip_read_string(&mut zip, &rootfile).ok_or_else(|| format!("读不到 {rootfile}"))?;
  let opf_dir = Path::new(&rootfile)
    .parent()
    .map(|p| p.to_string_lossy().replace('\\', "/"))
    .unwrap_or_default();
  let join = |href: &str, already_full: bool| -> String {
    let href = href.trim().split('#').next().unwrap_or(href).trim();
    let href = zip_normalize(href);
    if already_full || opf_dir.is_empty() || href.starts_with(&format!("{opf_dir}/")) {
      href
    } else {
      format!("{opf_dir}/{href}")
    }
  };

  let doc = roxmltree::Document::parse(&opf).map_err(|e| format!("解析 OPF 失败：{e}"))?;
  let mut title = fallback_title.to_string();
  if let Some(t) = doc
    .descendants()
    .find(|n| n.tag_name().name() == "title")
    .and_then(|n| n.text())
  {
    let t = t.trim();
    if !t.is_empty() {
      title = t.to_string();
    }
  }

  // id → href
  let mut manifest = std::collections::HashMap::<String, String>::new();
  for item in doc.descendants().filter(|n| n.tag_name().name() == "item") {
    let id = item.attribute("id").unwrap_or("").to_string();
    let href = item.attribute("href").unwrap_or("").to_string();
    if !id.is_empty() && !href.is_empty() {
      manifest.insert(id, href);
    }
  }
  let mut spine_hrefs: Vec<(String, bool)> = Vec::new();
  for itemref in doc.descendants().filter(|n| n.tag_name().name() == "itemref") {
    let idref = itemref.attribute("idref").unwrap_or("");
    if let Some(href) = manifest.get(idref) {
      spine_hrefs.push((href.clone(), false));
    }
  }
  if spine_hrefs.is_empty() {
    // 无 spine 时退化为扫全部 xhtml/html（zip 内已是完整路径）
    for i in 0..zip.len() {
      let name = zip.by_index(i).ok().map(|e| e.name().to_string()).unwrap_or_default();
      let lower = name.to_ascii_lowercase();
      if lower.ends_with(".xhtml") || lower.ends_with(".html") || lower.ends_with(".htm") {
        if !lower.contains("nav") && !lower.contains("toc") {
          spine_hrefs.push((name, true));
        }
      }
    }
  }

  let mut parts = Vec::new();
  for (href, full) in spine_hrefs {
    let path_in_zip = join(&href, full);
    let html = match zip_read_string(&mut zip, &path_in_zip) {
      Some(s) => s,
      None => continue,
    };
    let text = strip_html(&html);
    let text = normalize_doc_text(&text);
    if !text.is_empty() {
      parts.push(text);
    }
  }
  if parts.is_empty() {
    return Err("EPUB 里没有抽出正文（可能是纯图片书或加密）".into());
  }
  Ok(DocTextResult {
    title,
    text: parts.join("\n\n"),
    kind: "epub".into(),
    chars: 0,
  })
}

fn extract_mobi(path: &Path, fallback_title: &str) -> Result<DocTextResult, String> {
  let m = mobi::Mobi::from_path(path).map_err(|e| format!("解析 MOBI 失败：{e}"))?;
  let html = match m.content_as_string() {
    Ok(s) => s,
    Err(_) => m.content_as_string_lossy(),
  };
  let title = {
    let t = m.title();
    if t.trim().is_empty() {
      fallback_title.to_string()
    } else {
      t
    }
  };
  let text = normalize_doc_text(&strip_html(&html));
  if text.is_empty() {
    return Err("MOBI 没有抽出文字（可能是加密书、AZW3/KF8 或纯图片）".into());
  }
  Ok(DocTextResult {
    title,
    text,
    kind: "mobi".into(),
    chars: 0,
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::Write;
  use zip::write::SimpleFileOptions;
  use zip::ZipWriter;

  fn write_min_epub(path: &Path, title: &str, body_html: &str) {
    let file = std::fs::File::create(path).unwrap();
    let mut zip = ZipWriter::new(file);
    let opt = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    zip.start_file("mimetype", opt).unwrap();
    zip.write_all(b"application/epub+zip").unwrap();
    zip
      .start_file("META-INF/container.xml", opt)
      .unwrap();
    zip
      .write_all(
        br#"<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#,
      )
      .unwrap();
    let opf = format!(
      r#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="uid" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>{title}</dc:title>
    <dc:identifier id="uid">test-epub</dc:identifier>
  </metadata>
  <manifest>
    <item id="c1" href="chap1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="chap2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>"#
    );
    zip.start_file("OEBPS/content.opf", opt).unwrap();
    zip.write_all(opf.as_bytes()).unwrap();
    let chap1 = format!(
      r#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第一章</h1><p>{body_html}</p><script>evil()</script></body></html>"#
    );
    zip.start_file("OEBPS/chap1.xhtml", opt).unwrap();
    zip.write_all(chap1.as_bytes()).unwrap();
    zip.start_file("OEBPS/chap2.xhtml", opt).unwrap();
    zip
      .write_all(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><p>第二章内容&nbsp;完整。</p></body></html>"#
          .as_bytes(),
      )
      .unwrap();
    zip.finish().unwrap();
  }

  #[test]
  fn txt_utf8_roundtrip() {
    let dir = std::env::temp_dir().join("sp_ebook_utf8.txt");
    let body = "第一行\n\n第二行：完整性检查 ABC 123";
    std::fs::write(&dir, body).unwrap();
    let r = extract_doc_text_blocking(dir.to_str().unwrap()).unwrap();
    assert_eq!(r.kind, "txt");
    assert!(r.text.contains("第一行"));
    assert!(r.text.contains("完整性检查 ABC 123"));
    assert_eq!(r.chars, r.text.chars().count());
    let _ = std::fs::remove_file(dir);
  }

  #[test]
  fn txt_gbk_roundtrip() {
    let dir = std::env::temp_dir().join("sp_ebook_gbk.txt");
    let (bytes, _, _) = encoding_rs::GBK.encode("国标编码测试：转写导入");
    std::fs::write(&dir, bytes.as_ref()).unwrap();
    let r = extract_doc_text_blocking(dir.to_str().unwrap()).unwrap();
    assert!(r.text.contains("国标编码测试"));
    assert!(r.text.contains("转写导入"));
    let _ = std::fs::remove_file(dir);
  }

  #[test]
  fn epub_spine_order_and_strip() {
    let path = std::env::temp_dir().join("sp_ebook_min.epub");
    write_min_epub(&path, "测试书名", "正文段落一。");
    let r = extract_doc_text_blocking(path.to_str().unwrap()).unwrap();
    assert_eq!(r.kind, "epub");
    assert_eq!(r.title, "测试书名", "got title={}", r.title);
    assert!(
      r.text.contains("第一章") && r.text.contains("正文段落一"),
      "missing chap1, text={:?}",
      r.text
    );
    assert!(
      r.text.contains("第二章内容") && r.text.contains("完整"),
      "missing chap2, text={:?}",
      r.text
    );
    assert!(!r.text.contains("evil"), "script leaked: {:?}", r.text);
    // spine 顺序：第一章在前
    let i1 = r.text.find("第一章").unwrap();
    let i2 = r.text.find("第二章").unwrap();
    assert!(i1 < i2);
    let _ = std::fs::remove_file(path);
  }

  #[test]
  fn empty_txt_errors() {
    let path = std::env::temp_dir().join("sp_ebook_empty.txt");
    std::fs::write(&path, "   \n\n").unwrap();
    let err = extract_doc_text_blocking(path.to_str().unwrap()).unwrap_err();
    assert!(err.contains("没有抽出文字"));
    let _ = std::fs::remove_file(path);
  }

  #[test]
  fn azw3_rejected() {
    let path = std::env::temp_dir().join("sp_ebook.azw3");
    std::fs::write(&path, b"not-a-real-azw3").unwrap();
    let err = extract_doc_text_blocking(path.to_str().unwrap()).unwrap_err();
    assert!(err.contains("azw3") || err.contains("AZW3"));
    let _ = std::fs::remove_file(path);
  }
}
