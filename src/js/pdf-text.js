// PDF → 文本：优先抽文字层；扫描页再渲成图走本地 OCR（Windows.Media.Ocr）

import * as pdfjsLib from '../lib/pdfjs/pdf.min.mjs';
import { convertFileSrc, invoke } from './util.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../lib/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

/** 文字层字数少于此值，视为扫描页，走 OCR */
const TEXT_LAYER_MIN = 28;

let cancelFlag = false;

export function cancelPdfExtract() {
  cancelFlag = true;
}

function releasePage(page) {
  try { page.cleanup(); } catch { /* ignore */ }
}

function itemsToText(items) {
  let out = '';
  let lastY = null;
  for (const it of items || []) {
    const s = String(it?.str || '');
    if (!s && !it?.hasEOL) continue;
    const y = Array.isArray(it.transform) ? it.transform[5] : null;
    if (lastY != null && y != null && Math.abs(y - lastY) > 6) out += '\n';
    else if (out && s && !/\s$/.test(out) && !/^\s/.test(s)) out += '';
    out += s;
    if (it?.hasEOL) out += '\n';
    if (y != null) lastY = y;
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function loadPdfDoc(path) {
  const resp = await fetch(convertFileSrc(path));
  if (!resp.ok) throw new Error(`无法读取 PDF（HTTP ${resp.status}）`);
  const data = new Uint8Array(await resp.arrayBuffer());
  return pdfjsLib.getDocument({ data }).promise;
}

async function pageTextLayer(page) {
  const tc = await page.getTextContent({ includeMarkedContent: false });
  return itemsToText(tc?.items);
}

async function pageToPngBytes(page) {
  const base = page.getViewport({ scale: 1 });
  // OCR 需要够清晰；长边约 1800，兼顾速度
  const scale = Math.min(1800 / Math.max(base.width, base.height), 2.8);
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(vp.width));
  canvas.height = Math.max(1, Math.floor(vp.height));
  await page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport: vp }).promise;
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('渲图失败'))), 'image/png');
  });
  const buf = await blob.arrayBuffer();
  return Array.from(new Uint8Array(buf));
}

/**
 * 把整本 PDF 转成带「页码」的段落。
 * onProgress({ phase, percent, message, page, total, text })
 * @returns {{ paragraphs: { start:number, text:string, source:string }[], pages:number, ocrPages:number, textPages:number }}
 */
export async function extractPdfText(path, { onProgress } = {}) {
  cancelFlag = false;
  const emit = (p) => {
    try { onProgress?.(p); } catch { /* ignore */ }
  };

  emit({ phase: 'prepare', percent: 0, message: '正在打开 PDF…' });
  const pdf = await loadPdfDoc(path);
  const total = pdf.numPages || 0;
  if (!total) {
    await pdf.destroy().catch(() => {});
    throw new Error('PDF 没有页面');
  }

  let ocrReady = null;
  const ensureOcr = async () => {
    if (ocrReady != null) return ocrReady;
    try {
      const st = await invoke('ocr_status');
      ocrReady = !!st?.ready;
      if (!ocrReady) {
        emit({
          phase: 'progress',
          percent: 0,
          message: st?.message || '系统 OCR 未就绪，扫描页将跳过',
        });
      }
    } catch (err) {
      ocrReady = false;
      emit({ phase: 'progress', percent: 0, message: `OCR 不可用：${err?.message || err}` });
    }
    return ocrReady;
  };

  const paragraphs = [];
  let textPages = 0;
  let ocrPages = 0;

  for (let i = 0; i < total; i++) {
    if (cancelFlag) {
      await pdf.destroy().catch(() => {});
      const err = new Error('已取消');
      err.code = 'cancelled';
      throw err;
    }
    const pageNo = i + 1;
    const percent = Math.round((i / total) * 100);
    emit({
      phase: 'progress',
      percent,
      message: `第 ${pageNo}/${total} 页：抽取文字…`,
      page: pageNo,
      total,
    });

    const page = await pdf.getPage(pageNo);
    let text = '';
    let source = 'text';
    try {
      text = await pageTextLayer(page);
      if ((text || '').replace(/\s/g, '').length >= TEXT_LAYER_MIN) {
        textPages += 1;
      } else {
        // 扫描页 / 空页 → OCR
        if (await ensureOcr()) {
          emit({
            phase: 'progress',
            percent,
            message: `第 ${pageNo}/${total} 页：本地 OCR…`,
            page: pageNo,
            total,
          });
          const bytes = await pageToPngBytes(page);
          text = await invoke('ocr_image', { bytes });
          source = 'ocr';
          if ((text || '').trim()) ocrPages += 1;
        } else {
          source = 'skip';
          text = '';
        }
      }
    } finally {
      releasePage(page);
    }

    const body = String(text || '').trim();
    if (body) {
      paragraphs.push({ start: pageNo, text: body, source });
      emit({
        phase: 'para',
        percent: Math.round(((i + 1) / total) * 100),
        message: `第 ${pageNo}/${total} 页完成`,
        page: pageNo,
        total,
        start: pageNo,
        text: body,
        source,
      });
    }
  }

  await pdf.destroy().catch(() => {});
  emit({
    phase: 'done',
    percent: 100,
    message: `完成：文字层 ${textPages} 页，OCR ${ocrPages} 页`,
  });
  return { paragraphs, pages: total, ocrPages, textPages };
}
