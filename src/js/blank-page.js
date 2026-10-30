// 空白歌曲页：歌名片 / 歌词段，画幅 2048×896

import { convertFileSrc, esc } from './util.js';

export const BLANK_W = 2048;
export const BLANK_H = 896;
export const BLANK_RATIO = `${BLANK_W} / ${BLANK_H}`;

export const BG_PRESETS = {
  auto: { label: '强调色自动', bg: null },
  'church-dark': {
    label: '教会深色',
    bg: 'radial-gradient(ellipse at 50% 22%, #3a2a18 0%, #1a1210 42%, #08060a 100%)',
  },
  'clean-dark': {
    label: '简洁深底',
    bg: 'radial-gradient(ellipse at 50% 40%, #1c1c24 0%, #0a0a10 70%, #050508 100%)',
  },
  'blue-gold': {
    label: '蓝金氛围',
    bg: 'radial-gradient(ellipse at 50% 18%, #243a5c 0%, #101828 48%, #060810 100%)',
  },
  'soft-light': {
    label: '柔光浅底',
    bg: 'radial-gradient(ellipse at 50% 35%, #fff8ee 0%, #ebe2d4 65%, #d8cfc0 100%)',
  },
};

const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/** 按强调色生成自动渐变（礼拜大屏：更暗底、强调色更亮） */
export function autoGradient(accent = '#e8c56a') {
  const c = String(accent || '#e8c56a').trim() || '#e8c56a';
  return `radial-gradient(ellipse at 50% 20%, color-mix(in srgb, ${c} 45%, #2a2010) 0%, #120e0c 48%, #060508 100%)`;
}

export function resolveBlankBackground(item) {
  const accent = item?.accent || '#e8c56a';
  const preset = item?.bgPreset || 'auto';
  const bgImage = (item?.bgImage || '').trim();
  let bg = BG_PRESETS[preset]?.bg;
  if (preset === 'auto' || !bg) bg = autoGradient(accent);
  return { accent, bg, bgImage, preset, light: preset === 'soft-light' };
}

export function blankDisplayName(item) {
  const title = (item?.title || '').trim() || '未命名';
  if (item?.blankKind === 'lyric') {
    const idx = item.lyricIndex != null ? ` ${item.lyricIndex}` : '';
    return `${title} · 歌词${idx}`.trim();
  }
  return `${title} · 歌名`;
}

export function createBlankItem(partial = {}) {
  const blankKind = partial.blankKind === 'lyric' ? 'lyric' : 'title';
  const title = (partial.title || '').trim();
  const item = {
    id: partial.id || genId(),
    type: 'blank',
    blankKind,
    title: title || (blankKind === 'title' ? '歌曲名称' : ''),
    subtitle: (partial.subtitle || '').trim(),
    body: (partial.body || '').trim(),
    accent: partial.accent || '#e8c56a',
    bgPreset: partial.bgPreset && BG_PRESETS[partial.bgPreset] ? partial.bgPreset : 'auto',
    bgImage: partial.bgImage || '',
    lyricIndex: partial.lyricIndex ?? null,
    note: partial.note || '',
    cueTime: partial.cueTime || '',
    cueDate: partial.cueDate || '',
    path: '', // 无文件路径
  };
  item.name = partial.name || blankDisplayName(item);
  return item;
}

/** 空行分段歌词 → 段落数组 */
export function splitLyricParagraphs(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!raw) return [];
  return raw
    .split(/\n\s*\n+/)
    .map((p) => p.replace(/^\n+|\n+$/g, '').trim())
    .filter(Boolean);
}

/**
 * 歌曲页组：1 歌名片 + N 歌词页
 * @returns {object[]}
 */
export function buildSongBlankSet({
  title,
  subtitle = '',
  lyrics = '',
  accent = '#e8c56a',
  bgPreset = 'auto',
  bgImage = '',
} = {}) {
  const song = (title || '').trim() || '未命名歌曲';
  const shared = { accent, bgPreset, bgImage };
  const items = [
    createBlankItem({
      ...shared,
      blankKind: 'title',
      title: song,
      subtitle: (subtitle || '').trim(),
    }),
  ];
  const paras = splitLyricParagraphs(lyrics);
  paras.forEach((body, i) => {
    items.push(createBlankItem({
      ...shared,
      blankKind: 'lyric',
      title: song,
      body,
      lyricIndex: i + 1,
    }));
  });
  return items;
}

export function blankToOutputPayload(item) {
  const bg = resolveBlankBackground(item);
  let bgImageUrl = '';
  if (bg.bgImage) {
    try {
      bgImageUrl = convertFileSrc(bg.bgImage);
    } catch {
      bgImageUrl = bg.bgImage;
    }
  }
  return {
    kind: 'blank',
    blankKind: item.blankKind === 'lyric' ? 'lyric' : 'title',
    title: item.title || '',
    subtitle: item.subtitle || '',
    body: item.body || '',
    accent: bg.accent,
    bg: bg.bg,
    bgImage: bgImageUrl,
    light: bg.light,
  };
}

/** 把空白页画进容器（输出舞台或缩略图） */
export function renderBlankInto(container, payload, opts = {}) {
  if (!container) return null;
  const p = payload || {};
  const wrap = document.createElement('div');
  wrap.className = 'out-blank' + (p.light ? ' is-light' : '') + (p.bgImage ? ' has-bgimg' : '');
  wrap.style.setProperty('--blank-accent', p.accent || '#e8c56a');
  wrap.style.aspectRatio = BLANK_RATIO;

  if (p.bgImage) {
    const src = String(p.bgImage).replace(/\\/g, '/').replace(/"/g, '%22');
    // 礼拜大屏：背景图再压暗一点，保证白字醒目
    wrap.style.backgroundImage = `linear-gradient(rgba(6,6,10,.62), rgba(6,6,10,.78)), url("${src}")`;
    wrap.style.backgroundSize = 'cover';
    wrap.style.backgroundPosition = 'center';
  } else {
    wrap.style.background = p.bg || autoGradient(p.accent);
  }

  if (p.blankKind === 'lyric') {
    wrap.classList.add('is-lyric');
    // 歌词页：歌名小字仅作弱提示；正文纯白大字 + 宽字距（百寸远距）
    wrap.innerHTML = `
      <div class="out-blank-ornament" aria-hidden="true"></div>
      <div class="out-blank-lyric-head"></div>
      <div class="out-blank-body"></div>
      <div class="out-blank-ornament out-blank-ornament-bottom" aria-hidden="true"></div>`;
    const head = wrap.querySelector('.out-blank-lyric-head');
    const body = wrap.querySelector('.out-blank-body');
    // 歌名片信息放到歌词页时用「歌名」一行即可，避免副标题抢视觉
    if (p.title) {
      head.textContent = p.subtitle ? `${p.title}  ·  ${p.subtitle}` : p.title;
    } else {
      head.classList.add('is-empty');
    }
    body.textContent = p.body || '';
  } else {
    wrap.classList.add('is-title');
    wrap.innerHTML = `
      <div class="out-blank-ornament" aria-hidden="true"></div>
      <div class="out-blank-title"></div>
      <div class="out-blank-sub"></div>
      <div class="out-blank-ornament out-blank-ornament-bottom" aria-hidden="true"></div>`;
    wrap.querySelector('.out-blank-title').textContent = p.title || '歌曲名称';
    const sub = wrap.querySelector('.out-blank-sub');
    sub.textContent = p.subtitle || '';
    if (!p.subtitle) sub.classList.add('is-empty');
  }

  if (opts.replace !== false) {
    container.innerHTML = '';
    container.appendChild(wrap);
  }
  return wrap;
}

/** 节目单缩略图预览 */
export function mountBlankPreview(el, item) {
  if (!el || !item) return false;
  const keep = [...el.querySelectorAll('.pg-corner-num, .pg-corner-tag, .pg-hover-bar, .pg-remain, .pg-cue')];
  el.innerHTML = '';
  const stage = document.createElement('div');
  stage.className = 'pg-blank-thumb';
  renderBlankInto(stage, blankToOutputPayload(item));
  el.appendChild(stage);
  for (const node of keep) el.appendChild(node);
  return true;
}

export function blankPresetOptionsHtml(selected = 'auto') {
  return Object.entries(BG_PRESETS).map(([key, v]) =>
    `<option value="${esc(key)}" ${key === selected ? 'selected' : ''}>${esc(v.label)}</option>`).join('');
}
