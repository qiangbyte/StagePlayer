use base64::Engine as _;
use roxmltree::Node;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::Read;


/// OOXML 关系属性命名空间（r:id / r:embed）
const REL_NS: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/// 读取 r:id / r:embed，避免与无命名空间的 id 属性冲突
fn attr_r<'a>(n: Node<'a, '_>, local: &str) -> Option<&'a str> {
    n.attribute((REL_NS, local)).or_else(|| {
        n.attributes()
            .find(|a| a.name() == local && a.namespace().is_some())
            .map(|a| a.value())
    })
}

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use zip::ZipArchive;

/// 文本框（坐标为相对幻灯片宽高的百分比 0-100）
#[derive(Serialize, Clone, Debug)]
pub struct TextBox {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub lines: Vec<TextLine>,
}

#[derive(Serialize, Clone, Debug)]
pub struct TextLine {
    pub text: String,
    pub size: Option<f64>, // pt
    pub color: Option<String>,
    pub bold: bool,
    pub align: String, // l | ctr | r | just
}

#[derive(Serialize, Clone, Debug)]
pub struct Picture {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub src: String, // 本地缓存文件路径（前端转 asset URL）；落盘失败时为 data url
}

#[derive(Serialize, Clone, Debug)]
pub struct Slide {
    pub index: usize,
    pub background: Option<String>,
    pub bg_color: Option<String>,
    pub text_boxes: Vec<TextBox>,
    pub pictures: Vec<Picture>,
}

#[derive(Serialize, Clone, Debug)]
pub struct PptxDoc {
    pub name: String,
    pub slide_width: f64,  // emu
    pub slide_height: f64, // emu
    pub slides: Vec<Slide>,
}

fn ext_mime(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "tiff" | "tif" => "image/tiff",
        _ => "application/octet-stream",
    }
}

fn read_zip_entry<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
) -> Option<Vec<u8>> {
    let mut f = archive.by_name(name).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    Some(buf)
}

/// 媒体缓存保留的文稿版本数（每个文稿+修改时间一份目录）
const MEDIA_KEEP: usize = 30;

/// 本文稿版本的媒体缓存目录：路径 + 修改时间 + 大小 决定，文稿改动后自动换新目录
fn media_dir(cache_root: &Path, canon: &Path) -> Option<PathBuf> {
    let meta = fs::metadata(canon).ok()?;
    let mut h = Sha256::new();
    h.update(canon.to_string_lossy().as_bytes());
    if let Ok(t) = meta.modified() {
        if let Ok(d) = t.duration_since(std::time::UNIX_EPOCH) {
            h.update(d.as_secs().to_le_bytes());
        }
    }
    h.update(meta.len().to_le_bytes());
    let key = format!("{:x}", h.finalize());
    let root = cache_root.join("pptx-media");
    let dir = root.join(&key[..16]);
    if !dir.is_dir() {
        fs::create_dir_all(&dir).ok()?;
        prune_media(&root);
    }
    Some(dir)
}

/// 只保留最近 MEDIA_KEEP 个文稿的媒体目录
fn prune_media(root: &Path) {
    let Ok(rd) = fs::read_dir(root) else { return };
    let mut dirs: Vec<(std::time::SystemTime, PathBuf)> = rd
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| {
            let t = e
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            (t, e.path())
        })
        .collect();
    if dirs.len() <= MEDIA_KEEP {
        return;
    }
    dirs.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, p) in dirs.into_iter().skip(MEDIA_KEEP) {
        let _ = fs::remove_dir_all(p);
    }
}

/// 媒体落盘（同版本只写一次）并返回本地路径；
/// 图片走 asset 协议：事件推送只带路径，浏览器可缓存解码结果，JS 堆不再常驻 base64
fn media_src(dir: Option<&Path>, bytes: &[u8], name: &str) -> String {
    if let Some(dir) = dir {
        let safe: String = name
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' })
            .collect();
        let p = dir.join(&safe);
        let ok = p.is_file() || {
            // 先写临时文件再改名，避免中断留下半截图片被当成完整缓存
            let tmp = dir.join(format!("{safe}.part"));
            fs::write(&tmp, bytes).is_ok() && fs::rename(&tmp, &p).is_ok()
        };
        if ok {
            return p.to_string_lossy().into_owned();
        }
    }
    data_url(bytes, name)
}

fn data_url(bytes: &[u8], name: &str) -> String {
    let ext = name.rsplit('.').next().unwrap_or("");
    format!(
        "data:{};base64,{}",
        ext_mime(ext),
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

/// 解析 rels 文件，返回 rId -> Target 的映射
fn parse_rels(xml: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    if let Ok(doc) = roxmltree::Document::parse(xml) {
        for rel in doc.descendants().filter(|n| n.has_tag_name("Relationship")) {
            if let (Some(id), Some(target)) = (
                rel.attribute("Id"),
                rel.attribute("Target"),
            ) {
                map.insert(id.to_string(), target.to_string());
            }
        }
    }
    map
}

fn emu_percent(v: i64, total: i64) -> f64 {
    if total == 0 {
        0.0
    } else {
        (v as f64 / total as f64) * 100.0
    }
}

/// 从 xfrm 节点读取位置（返回百分比）
fn read_xfrm(xfrm: Node, cx: i64, cy: i64) -> Option<(f64, f64, f64, f64)> {
    let off = xfrm.children().find(|n| n.tag_name().name() == "off")?;
    let ext = xfrm.children().find(|n| n.tag_name().name() == "ext")?;
    let x = off.attribute("x")?.parse::<i64>().ok()?;
    let y = off.attribute("y")?.parse::<i64>().ok()?;
    let w = ext.attribute("cx")?.parse::<i64>().ok()?;
    let h = ext.attribute("cy")?.parse::<i64>().ok()?;
    Some((
        emu_percent(x, cx),
        emu_percent(y, cy),
        emu_percent(w.max(1), cx),
        emu_percent(h.max(1), cy),
    ))
}

fn normalize_hex(v: &str) -> Option<String> {
    let s = v.trim().trim_start_matches('#');
    if s.len() == 6 && s.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(format!("#{}", s.to_ascii_uppercase()))
    } else if s.len() == 8 && s.chars().all(|c| c.is_ascii_hexdigit()) {
        // AARRGGBB → #RRGGBB
        Some(format!("#{}", s[2..].to_ascii_uppercase()))
    } else {
        None
    }
}

/// 解析 theme 色板（ppt/theme/theme1.xml）
fn parse_theme_colors(xml: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Ok(doc) = roxmltree::Document::parse(xml) else {
        return map;
    };
    let Some(scheme) = doc.descendants().find(|n| n.tag_name().name() == "clrScheme") else {
        return map;
    };
    for child in scheme.children().filter(|n| n.is_element()) {
        let name = child.tag_name().name().to_string();
        if let Some(c) = extract_color_raw(child, None) {
            map.insert(name, c);
        }
    }
    // 别名
    if let Some(v) = map.get("dk1").cloned() {
        map.insert("tx1".into(), v);
    }
    if let Some(v) = map.get("lt1").cloned() {
        map.insert("bg1".into(), v);
    }
    if let Some(v) = map.get("dk2").cloned() {
        map.insert("tx2".into(), v);
    }
    if let Some(v) = map.get("lt2").cloned() {
        map.insert("bg2".into(), v);
    }
    map
}

fn default_scheme_color(name: &str) -> &'static str {
    match name {
        "tx1" | "dk1" => "#000000",
        "bg1" | "lt1" => "#FFFFFF",
        "tx2" | "dk2" => "#1F2937",
        "bg2" | "lt2" => "#E5E7EB",
        "accent1" => "#3B82F6",
        "accent2" => "#EF4444",
        "accent3" => "#10B981",
        "accent4" => "#F59E0B",
        "accent5" => "#8B5CF6",
        "accent6" => "#EC4899",
        "hlink" => "#0563C1",
        "folHlink" => "#954F72",
        _ => "#FFFFFF",
    }
}

/// 提取颜色：srgbClr / sysClr(lastClr) / schemeClr（可带主题表）
fn extract_color_raw(node: Node, theme: Option<&HashMap<String, String>>) -> Option<String> {
    for child in node.descendants() {
        let tag = child.tag_name().name();
        if tag == "srgbClr" {
            if let Some(v) = child.attribute("val") {
                if let Some(hex) = normalize_hex(v) {
                    return Some(hex);
                }
            }
        }
        if tag == "sysClr" {
            if let Some(v) = child.attribute("lastClr").or_else(|| child.attribute("val")) {
                if let Some(hex) = normalize_hex(v) {
                    return Some(hex);
                }
            }
        }
        if tag == "schemeClr" {
            let v = child.attribute("val")?;
            if let Some(theme) = theme {
                if let Some(c) = theme.get(v) {
                    return Some(c.clone());
                }
            }
            return Some(default_scheme_color(v).to_string());
        }
    }
    None
}

fn extract_color(node: Node) -> Option<String> {
    extract_color_raw(node, None)
}

fn extract_color_theme(node: Node, theme: &HashMap<String, String>) -> Option<String> {
    extract_color_raw(node, Some(theme))
}

fn join_ppt_path(base_file: &str, target: &str) -> String {
    let t = target.replace('\\', "/");
    let t = t.trim_start_matches('/');
    if t.starts_with("ppt/") {
        return t.to_string();
    }
    let dir = base_file
        .replace('\\', "/")
        .rsplit_once('/')
        .map(|(d, _)| d.to_string())
        .unwrap_or_else(|| "ppt".into());
    let mut stack: Vec<String> = dir.split('/').filter(|s| !s.is_empty()).map(|s| s.to_string()).collect();
    for p in t.split('/') {
        if p == ".." {
            stack.pop();
        } else if p != "." && !p.is_empty() {
            stack.push(p.to_string());
        }
    }
    stack.join("/")
}

/// 从 cSld（幻灯片/版式/母版）读取背景色或背景图
fn read_background(
    root: Node,
    cx: i64,
    cy: i64,
    rels: &HashMap<String, String>,
    media: &HashMap<String, String>,
    theme: &HashMap<String, String>,
) -> (Option<String>, Option<String>) {
    let mut background = None;
    let mut bg_color = None;

    if let Some(bg) = root.descendants().find(|n| n.tag_name().name() == "bg") {
        if let Some(blip) = bg.descendants().find(|n| n.tag_name().name() == "blip") {
            if let Some(rid) = attr_r(blip, "embed") {
                if let Some(target) = rels.get(rid) {
                    let name = target.rsplit('/').next().unwrap_or("");
                    if let Some(src) = media.get(name) {
                        background = Some(src.clone());
                    }
                }
            }
        }
        if bg_color.is_none() {
            bg_color = extract_color_theme(bg, theme);
        }
    }

    // 绿幕等场景：整页矩形色块当作背景（无文字、覆盖 ≥90%）
    if bg_color.is_none() && background.is_none() {
        bg_color = find_fullbleed_solid(root, cx, cy, theme);
    }

    (background, bg_color)
}

fn find_fullbleed_solid(
    root: Node,
    cx: i64,
    cy: i64,
    theme: &HashMap<String, String>,
) -> Option<String> {
    let mut best: Option<(f64, String)> = None;
    for sp in root.descendants().filter(|n| n.tag_name().name() == "sp") {
        let has_text = sp.descendants().any(|n| {
            n.tag_name().name() == "t"
                && n.text().map(|t| !t.trim().is_empty()).unwrap_or(false)
        });
        if has_text {
            continue;
        }
        let Some(sp_pr) = sp.children().find(|n| n.tag_name().name() == "spPr") else {
            continue;
        };
        // 必须有实心填充
        if sp_pr
            .descendants()
            .find(|n| n.tag_name().name() == "solidFill")
            .is_none()
        {
            continue;
        }
        let Some(xfrm) = sp_pr.children().find(|n| n.tag_name().name() == "xfrm") else {
            continue;
        };
        let Some((x, y, w, h)) = read_xfrm(xfrm, cx, cy) else {
            continue;
        };
        if x > 8.0 || y > 8.0 || w < 85.0 || h < 85.0 {
            continue;
        }
        let Some(color) = extract_color_theme(sp_pr, theme) else {
            continue;
        };
        let area = w * h;
        if best.as_ref().map(|(a, _)| area > *a).unwrap_or(true) {
            best = Some((area, color));
        }
    }
    best.map(|(_, c)| c)
}

fn font_size_from(node: Node) -> Option<f64> {
    node.attribute("sz")
        .and_then(|s| s.parse::<f64>().ok())
        .map(|v| v / 100.0)
}

/// 解析一个形状（文本框）
fn parse_text_box(sp: Node, cx: i64, cy: i64) -> Option<TextBox> {
    let sp_pr = sp.children().find(|n| n.tag_name().name() == "spPr")?;
    let xfrm = sp_pr.children().find(|n| n.tag_name().name() == "xfrm")?;
    let (x, y, w, h) = read_xfrm(xfrm, cx, cy)?;

    let tx_body = sp.children().find(|n| n.tag_name().name() == "txBody")?;
    let mut lines = Vec::new();
    for para in tx_body.children().filter(|n| n.tag_name().name() == "p") {
        let align = para
            .children()
            .find(|n| n.tag_name().name() == "pPr")
            .and_then(|p| p.attribute("algn"))
            .unwrap_or("l")
            .to_string();

        // 段落内可能多个 run；若无 run 但有 a:br/a:fld 仍取文本
        let mut text = String::new();
        let mut size: Option<f64> = None;
        let mut color: Option<String> = None;
        let mut bold = false;
        for r in para.descendants() {
            if r.tag_name().name() == "rPr" {
                if size.is_none() {
                    size = font_size_from(r);
                }
                if color.is_none() {
                    color = extract_color(r);
                }
                if r.attribute("b") == Some("1") {
                    bold = true;
                }
            }
            if r.tag_name().name() == "t" {
                if let Some(t) = r.text() {
                    text.push_str(t);
                }
            }
            if r.tag_name().name() == "br" {
                text.push('\n');
            }
        }
        if !text.trim().is_empty() {
            // 字号转换为占幻灯片高度的百分比（1pt = 12700 EMU）
            let size_pct = size.map(|pt| pt * 12700.0 / cy as f64 * 100.0);
            for seg in text.split('\n') {
                lines.push(TextLine {
                    text: seg.to_string(),
                    size: size_pct,
                    color: color.clone(),
                    bold,
                    align: align.clone(),
                });
            }
        }
    }

    if lines.is_empty() {
        None
    } else {
        Some(TextBox { x, y, w, h, lines })
    }
}

/// 解析一个图片
fn parse_picture(
    pic: Node,
    cx: i64,
    cy: i64,
    rels: &HashMap<String, String>,
    media: &HashMap<String, String>,
) -> Option<Picture> {
    let sp_pr = pic.children().find(|n| n.tag_name().name() == "spPr")?;
    let xfrm = sp_pr.children().find(|n| n.tag_name().name() == "xfrm")?;
    let (x, y, w, h) = read_xfrm(xfrm, cx, cy)?;

    let blip = pic
        .descendants()
        .find(|n| n.tag_name().name() == "blip")?;
    let rid = attr_r(blip, "embed")?;
    let target = rels.get(rid)?;
    let media_name = target.rsplit('/').next()?;
    let src = media.get(media_name)?.clone();
    Some(Picture { x, y, w, h, src })
}

fn parse_slide_xml(
    xml: &str,
    cx: i64,
    cy: i64,
    rels: &HashMap<String, String>,
    media: &HashMap<String, String>,
    theme: &HashMap<String, String>,
    fallback_bg: (Option<String>, Option<String>),
) -> Slide {
    let mut slide = Slide {
        index: 0,
        background: None,
        bg_color: None,
        text_boxes: Vec::new(),
        pictures: Vec::new(),
    };

    let doc = match roxmltree::Document::parse(xml) {
        Ok(d) => d,
        Err(_) => return slide,
    };
    let root = doc.root_element();

    let (bg_img, bg_color) = read_background(root, cx, cy, rels, media, theme);
    slide.background = bg_img.or(fallback_bg.0);
    slide.bg_color = bg_color.or(fallback_bg.1).or_else(|| Some("#FFFFFF".into()));

    // 图片（含组合形状内的）
    for pic in root.descendants().filter(|n| n.tag_name().name() == "pic") {
        if let Some(p) = parse_picture(pic, cx, cy, rels, media) {
            slide.pictures.push(p);
        }
    }

    // 文本框
    for sp in root.descendants().filter(|n| n.tag_name().name() == "sp") {
        if let Some(tb) = parse_text_box(sp, cx, cy) {
            slide.text_boxes.push(tb);
        }
    }

    slide
}

/// 从版式/母版 XML 取背景（作为幻灯片回退）
fn background_from_xml(
    xml: &str,
    cx: i64,
    cy: i64,
    rels: &HashMap<String, String>,
    media: &HashMap<String, String>,
    theme: &HashMap<String, String>,
) -> (Option<String>, Option<String>) {
    let Ok(doc) = roxmltree::Document::parse(xml) else {
        return (None, None);
    };
    read_background(doc.root_element(), cx, cy, rels, media, theme)
}

/// 解析 pptx；放到阻塞线程池执行，避免大文件卡住主线程（窗口/输出无响应）
/// 前端按路径缓存结果，后端不再常驻一份含 base64 图片的副本
#[tauri::command]
pub async fn parse_pptx(app: AppHandle, path: String) -> Result<PptxDoc, String> {
    let cache_root = app.path().app_cache_dir().ok();
    tauri::async_runtime::spawn_blocking(move || parse_pptx_blocking(path, cache_root))
        .await
        .map_err(|e| e.to_string())?
}

fn parse_pptx_blocking(path: String, cache_root: Option<PathBuf>) -> Result<PptxDoc, String> {
    let dir = cache_root.and_then(|root| {
        let canon = fs::canonicalize(&path).ok()?;
        media_dir(&root, &canon)
    });
    let file = fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|e| e.to_string())?;

    // 幻灯片尺寸
    let pres_xml = String::from_utf8_lossy(
        &read_zip_entry(&mut archive, "ppt/presentation.xml")
            .ok_or("无效的 pptx：缺少 presentation.xml")?,
    )
    .to_string();
    let pres_doc = roxmltree::Document::parse(&pres_xml).map_err(|e| e.to_string())?;
    // 缺省 16:9（部分导出工具会省略 sldSz）
    let (cx, cy) = pres_doc
        .descendants()
        .find(|n| n.tag_name().name() == "sldSz")
        .map(|sld_sz| {
            let cx: i64 = sld_sz
                .attribute("cx")
                .unwrap_or("12192000")
                .parse()
                .unwrap_or(12192000);
            let cy: i64 = sld_sz
                .attribute("cy")
                .unwrap_or("6858000")
                .parse()
                .unwrap_or(6858000);
            (cx, cy)
        })
        .unwrap_or((12_192_000, 6_858_000));

    // 幻灯片顺序
    let rels_xml = String::from_utf8_lossy(
        &read_zip_entry(&mut archive, "ppt/_rels/presentation.xml.rels")
            .ok_or("无效的 pptx：缺少 rels")?,
    )
    .to_string();
    let pres_rels = parse_rels(&rels_xml);
    let mut slide_targets: Vec<String> = Vec::new();
    for sid in pres_doc
        .descendants()
        .filter(|n| n.tag_name().name() == "sldId")
    {
        if let Some(rid) = attr_r(sid, "id") {
            if let Some(t) = pres_rels.get(rid) {
                let t = t.trim_start_matches('/');
                slide_targets.push(if t.starts_with("ppt/") {
                    t.to_string()
                } else {
                    format!("ppt/{}", t)
                });
            }
        }
    }
    if slide_targets.is_empty() {
        // 兜底：按文件名排序
        let mut names: Vec<String> = (0..archive.len())
            .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
            .filter(|n| n.starts_with("ppt/slides/slide") && n.ends_with(".xml"))
            .collect();
        names.sort_by_key(|n| {
            n.trim_end_matches(".xml")
                .trim_start_matches("ppt/slides/slide")
                .parse::<usize>()
                .unwrap_or(0)
        });
        slide_targets = names;
    }

    // 收集所有媒体
    let mut media: HashMap<String, String> = HashMap::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        if name.starts_with("ppt/media/") {
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
            let short = name.rsplit('/').next().unwrap_or(&name).to_string();
            let src = media_src(dir.as_deref(), &buf, &short);
            media.insert(short, src);
        }
    }

    // 主题色（绿幕常挂在主题 / 版式上）
    let theme = read_zip_entry(&mut archive, "ppt/theme/theme1.xml")
        .map(|b| parse_theme_colors(&String::from_utf8_lossy(&b)))
        .unwrap_or_default();

    let file_name = PathBuf::from(&path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    let mut slides = Vec::new();
    for (idx, target) in slide_targets.iter().enumerate() {
        let xml_bytes = match read_zip_entry(&mut archive, target) {
            Some(b) => b,
            None => continue,
        };
        let xml = String::from_utf8_lossy(&xml_bytes).to_string();

        // 该 slide 的 rels
        let rel_path = format!(
            "ppt/slides/_rels/{}.rels",
            target.rsplit('/').next().unwrap_or("")
        );
        let rels = read_zip_entry(&mut archive, &rel_path)
            .map(|b| parse_rels(&String::from_utf8_lossy(&b)))
            .unwrap_or_default();

        // 版式 → 母版背景回退
        let mut fallback_bg = (None, None);
        if let Some(layout_rel) = rels.values().find(|t| {
            let t = t.to_ascii_lowercase();
            t.contains("slidelayout")
        }) {
            let layout_path = join_ppt_path(target, layout_rel);
            if let Some(layout_xml) = read_zip_entry(&mut archive, &layout_path) {
                let layout_rels_path = format!(
                    "{}/_rels/{}.rels",
                    layout_path.rsplit_once('/').map(|(d, _)| d).unwrap_or("ppt/slideLayouts"),
                    layout_path.rsplit('/').next().unwrap_or("")
                );
                let layout_rels = read_zip_entry(&mut archive, &layout_rels_path)
                    .map(|b| parse_rels(&String::from_utf8_lossy(&b)))
                    .unwrap_or_default();
                fallback_bg = background_from_xml(
                    &String::from_utf8_lossy(&layout_xml),
                    cx,
                    cy,
                    &layout_rels,
                    &media,
                    &theme,
                );
                if fallback_bg.0.is_none() && fallback_bg.1.is_none() {
                    if let Some(master_rel) = layout_rels.values().find(|t| {
                        t.to_ascii_lowercase().contains("slidemaster")
                    }) {
                        let master_path = join_ppt_path(&layout_path, master_rel);
                        if let Some(master_xml) = read_zip_entry(&mut archive, &master_path) {
                            let master_rels_path = format!(
                                "{}/_rels/{}.rels",
                                master_path.rsplit_once('/').map(|(d, _)| d).unwrap_or("ppt/slideMasters"),
                                master_path.rsplit('/').next().unwrap_or("")
                            );
                            let master_rels = read_zip_entry(&mut archive, &master_rels_path)
                                .map(|b| parse_rels(&String::from_utf8_lossy(&b)))
                                .unwrap_or_default();
                            fallback_bg = background_from_xml(
                                &String::from_utf8_lossy(&master_xml),
                                cx,
                                cy,
                                &master_rels,
                                &media,
                                &theme,
                            );
                        }
                    }
                }
            }
        }

        let mut s = parse_slide_xml(&xml, cx, cy, &rels, &media, &theme, fallback_bg);
        s.index = idx;
        slides.push(s);
    }

    let doc = PptxDoc {
        name: file_name,
        slide_width: cx as f64,
        slide_height: cy as f64,
        slides,
    };
    Ok(doc)
}
