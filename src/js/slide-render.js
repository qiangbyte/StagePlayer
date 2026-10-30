// PPT 幻灯片渲染器：把后端解析的 slide 数据渲染为 HTML
// 坐标均为相对幻灯片宽高的百分比；字号 size 为占幻灯片高度的百分比（用 cqh 容器单位）

const ALIGN_MAP = { l: 'left', ctr: 'center', r: 'right', just: 'justify', dist: 'justify' };

/**
 * 将 slide 渲染进 el（el 应具有 16:9 或按幻灯片比例的容器，并带 .slide-canvas 类）
 */
export function renderSlide(el, slide) {
  el.classList.add('slide-canvas');
  el.innerHTML = '';
  // 缺省白底（贴近 PowerPoint）；绿幕等颜色由解析结果 bg_color 提供
  el.style.background = slide.bg_color || '#FFFFFF';

  if (slide.background) {
    const bg = document.createElement('img');
    bg.className = 'slide-bg';
    bg.src = slide.background;
    bg.draggable = false;
    el.appendChild(bg);
  }

  for (const pic of slide.pictures || []) {
    const box = document.createElement('div');
    box.className = 'slide-pic';
    box.style.left = pic.x + '%';
    box.style.top = pic.y + '%';
    box.style.width = pic.w + '%';
    box.style.height = pic.h + '%';
    const img = document.createElement('img');
    img.src = pic.src;
    img.draggable = false;
    box.appendChild(img);
    el.appendChild(box);
  }

  for (const tb of slide.text_boxes || []) {
    const box = document.createElement('div');
    box.className = 'slide-tb';
    box.style.left = tb.x + '%';
    box.style.top = tb.y + '%';
    box.style.width = tb.w + '%';
    box.style.height = tb.h + '%';
    // 垂直居中（大多数演出字幕场景文本在形状中部）
    box.style.display = 'flex';
    box.style.flexDirection = 'column';
    box.style.justifyContent = 'center';
    for (const line of tb.lines || []) {
      const div = document.createElement('div');
      div.className = 'slide-line';
      div.textContent = line.text;
      div.style.textAlign = ALIGN_MAP[line.align] || 'left';
      if (line.size) div.style.fontSize = line.size.toFixed(3) + 'cqh';
      if (line.color) div.style.color = line.color;
      if (line.bold) div.style.fontWeight = '700';
      box.appendChild(div);
    }
    el.appendChild(box);
  }
}

/** 创建一个保持比例的幻灯片画布容器（ratio = 宽/高，默认 16:9） */
export function makeSlideCanvas(ratio = 16 / 9) {
  const el = document.createElement('div');
  el.className = 'slide-canvas';
  el.style.aspectRatio = String(ratio);
  return el;
}
