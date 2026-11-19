use base64::Engine as _;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

/// 用户通过保存对话框亲自选过的路径；写文件类命令只允许写这些路径
#[derive(Default)]
pub struct ApprovedSavePaths(Mutex<HashSet<PathBuf>>);

impl ApprovedSavePaths {
    fn approve(&self, p: PathBuf) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).insert(p);
    }

    /// 校验目标路径来自保存对话框，防止前端被注入后写任意文件
    pub fn check(&self, p: &str) -> Result<(), String> {
        let ok = self
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(&PathBuf::from(p));
        if ok {
            Ok(())
        } else {
            Err("保存路径未经用户确认".into())
        }
    }
}

/// 保存文件对话框（返回所选路径，取消返回 None）
#[tauri::command]
pub async fn pick_save_path(
    app: AppHandle,
    approved: State<'_, ApprovedSavePaths>,
    default_name: String,
    extensions: Vec<String>,
) -> Result<Option<String>, String> {
    let mut builder = app
        .dialog()
        .file()
        .set_title("保存文件")
        .set_file_name(&default_name);
    if !extensions.is_empty() {
        let exts: Vec<&str> = extensions.iter().map(|s| s.as_str()).collect();
        builder = builder.add_filter("文件", &exts);
    }
    // 该版本插件没有阻塞式保存 API：用回调 + 通道等待用户选择
    let (tx, rx) = std::sync::mpsc::channel();
    builder.save_file(move |f| {
        let _ = tx.send(f);
    });
    let picked = rx.recv().map_err(|e| e.to_string())?;
    let picked = picked.map(|f| f.to_string());
    if let Some(p) = &picked {
        approved.approve(PathBuf::from(p));
    }
    Ok(picked)
}

/// 复制文件（用于导出 AI 分离缓存的伴奏）
/// 仅允许：源在伴奏缓存目录内，目标是用户在保存对话框里选的路径
#[tauri::command]
pub async fn copy_file(
    app: AppHandle,
    approved: State<'_, ApprovedSavePaths>,
    src: String,
    dst: String,
) -> Result<u64, String> {
    approved.check(&dst)?;
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("stem-instrumental");
    let cache = std::fs::canonicalize(&cache).map_err(|e| e.to_string())?;
    let src_c = std::fs::canonicalize(&src).map_err(|e| e.to_string())?;
    if !src_c.starts_with(&cache) {
        return Err("只能导出伴奏缓存文件".into());
    }
    let n = std::fs::copy(&src_c, &dst).map_err(|e| e.to_string())?;
    Ok(n)
}

/// 写文本文件（导出节目单）：目标必须是保存对话框里选的路径
#[tauri::command]
pub async fn write_text_file(
    approved: State<'_, ApprovedSavePaths>,
    path: String,
    text: String,
) -> Result<(), String> {
    approved.check(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::write(&path, text.as_bytes()).map_err(|e| format!("写入失败: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 读节目单导出文件（只允许 .json，最大 50MB）
#[tauri::command]
pub async fn read_show_file(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = std::path::Path::new(&path);
        if !p.extension().is_some_and(|e| e.eq_ignore_ascii_case("json")) {
            return Err("只能导入 .json 节目单文件".into());
        }
        let len = std::fs::metadata(p).map_err(|e| e.to_string())?.len();
        if len > 50 * 1024 * 1024 {
            return Err("文件过大".into());
        }
        std::fs::read_to_string(p).map_err(|e| format!("读取失败: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 返回其中实际存在的文件（保持原顺序）；用于找歌词、检查导入节目单的媒体是否在本机
#[tauri::command]
pub async fn existing_files(paths: Vec<String>) -> Vec<String> {
    paths
        .into_iter()
        .filter(|p| std::path::Path::new(p).is_file())
        .collect()
}

/// 原生生成图片缩略图（最长边 320px 的 JPEG dataURL）
/// 在 Rust 侧解码，避免 WebView 渲染进程解码高清原图导致 OOM；失败返回 None
#[tauri::command]
pub async fn make_image_thumb(path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let opened = image::ImageReader::open(&path)
            .ok()
            .and_then(|r| r.with_guessed_format().ok());
        let img = match opened.and_then(|r| r.decode().ok()) {
            Some(img) => img,
            None => return Ok(None),
        };
        Ok(jpeg_data_url(&img.thumbnail(320, 320)))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn jpeg_data_url(img: &image::DynamicImage) -> Option<String> {
    let mut buf = std::io::Cursor::new(Vec::new());
    // JPEG 不支持透明通道，统一转 RGB
    image::DynamicImage::ImageRgb8(img.to_rgb8())
        .write_to(&mut buf, image::ImageFormat::Jpeg)
        .ok()?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(buf.get_ref());
    Some(format!("data:image/jpeg;base64,{b64}"))
}

/// 视频缩略图：取 Windows 资源管理器同款系统缩略图（不打包 ffmpeg，安装包不增大）
/// 系统无该格式解码器时返回 None，前端回退到 <video> 截帧
#[tauri::command]
pub async fn make_video_thumb(path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(shell_thumb(&path).and_then(|img| jpeg_data_url(&img.thumbnail(320, 320))))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(not(windows))]
fn shell_thumb(_path: &str) -> Option<image::DynamicImage> {
    None
}

#[cfg(windows)]
fn shell_thumb(path: &str) -> Option<image::DynamicImage> {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::{DeleteObject, HGDIOBJ};
    use windows::Win32::System::Com::IBindCtx;
    use windows::Win32::UI::Shell::{
        IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF, SIIGBF_BIGGERSIZEOK,
        SIIGBF_THUMBNAILONLY,
    };
    unsafe {
        // 线程池线程可能已经初始化 COM；只对本次成功取得的初始化引用做配对释放。
        let _com = ShellComGuard::initialize();
        let factory: IShellItemImageFactory =
            SHCreateItemFromParsingName(&HSTRING::from(path), None::<&IBindCtx>).ok()?;
        let flags = SIIGBF(SIIGBF_THUMBNAILONLY.0 | SIIGBF_BIGGERSIZEOK.0);
        let hbm = factory.GetImage(SIZE { cx: 320, cy: 320 }, flags).ok()?;
        let img = bitmap_to_image(hbm);
        let _ = DeleteObject(HGDIOBJ(hbm.0));
        img
    }
}

#[cfg(windows)]
struct ShellComGuard(bool);

#[cfg(windows)]
impl ShellComGuard {
    unsafe fn initialize() -> Self {
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
        Self(CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok())
    }
}

#[cfg(windows)]
impl Drop for ShellComGuard {
    fn drop(&mut self) {
        if self.0 {
            unsafe { windows::Win32::System::Com::CoUninitialize() };
        }
    }
}

#[cfg(windows)]
unsafe fn bitmap_to_image(
    hbm: windows::Win32::Graphics::Gdi::HBITMAP,
) -> Option<image::DynamicImage> {
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, GetDIBits, GetObjectW, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
    };
    let mut bm = BITMAP::default();
    let got = GetObjectW(
        HGDIOBJ(hbm.0),
        std::mem::size_of::<BITMAP>() as i32,
        Some(&mut bm as *mut BITMAP as *mut core::ffi::c_void),
    );
    if got == 0 || bm.bmWidth <= 0 || bm.bmHeight == 0 {
        return None;
    }
    let (w, h) = (bm.bmWidth, bm.bmHeight.abs());
    let mut bi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h, // 负值 = 自上而下行序
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut bgra = vec![0u8; (w * h * 4) as usize];
    let hdc = CreateCompatibleDC(None);
    let lines = GetDIBits(
        hdc,
        hbm,
        0,
        h as u32,
        Some(bgra.as_mut_ptr() as *mut core::ffi::c_void),
        &mut bi,
        DIB_RGB_COLORS,
    );
    let _ = DeleteDC(hdc);
    if lines == 0 {
        return None;
    }
    let rgb: Vec<u8> = bgra.chunks_exact(4).flat_map(|p| [p[2], p[1], p[0]]).collect();
    image::RgbImage::from_raw(w as u32, h as u32, rgb).map(image::DynamicImage::ImageRgb8)
}
