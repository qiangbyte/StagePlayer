// 歌词投屏：歌词解析（段落标记）+ 扩展屏渲染（主控预览与输出窗口共用）
// 渲染两种视图：scroll（当前行居中、上下渐隐滚动）/ stanza（整段显示、当前行高亮）

import { convertFileSrc } from './util.js';

// ---------- 解析 ----------

const SEC_TYPES = [
  { type: 'pre', label: '预副歌', re: /^(预副歌|导歌|pre[- ]?chorus|pc|p)$/i },
  { type: 'chorus', label: '副歌', re: /^(副歌|chorus|c)$/i },
  { type: 'bridge', label: '桥段', re: /^(桥段|bridge|b)$/i },
  { type: 'ending', label: '尾声', re: /^(尾声|结尾|ending|outro|tag|e)$/i },
  { type: 'intro', label: '间奏', re: /^(前奏|间奏|intro|interlude|i)$/i },
  { type: 'verse', label: '主歌', re: /^(主歌|verse|v)$/i },
];
const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 段落标记行：[副歌] 【主歌2】 Chorus: V1 (桥段) … 返回 { type, name } 或 null */
export function parseSectionHeader(line) {
  const s = line.trim();
  if (!s || s.length > 24) return null;
  const bracketed = /^[[【(（].*[\]】)）]$/.test(s);
  const colon = /[:：]$/.test(s);
  const core = s.replace(/^[[【(（]\s*|\s*[\]】)）]$/g, '').replace(/\s*[:：]$/, '').trim();
  const m = core.match(/^(.*?)\s*([0-9]+|[一二三四五六七八九])?$/);
  if (!m) return null;
  const word = m[1].trim();
  const num = m[2] ? (CN_NUM[m[2]] || +m[2]) : 0;
  const def = SEC_TYPES.find((t) => t.re.test(word));
  if (!def) return null;
  // 单字母（C / V1）必须带括号、冒号或数字，避免误判歌词
  if (word.length === 1 && !bracketed && !colon && !num) return null;
  return { type: def.type, name: def.label + (num ? num : '') };
}

const LRC_TAG = /\[\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?\]/g;
const LRC_META = /^\[(ti|ar|al|by|offset|re|ve|length):.*\]$/i;

/**
 * 歌词文本 → { lines: string[], secOf: number[], sections: {name,type,start,end}[] }
 * 有段落标记按标记分段；没有标记时按空行分段，重复出现的段落自动认作副歌
 */
export function parseLyricSheet(text) {
  const rows = String(text || '').replace(/^﻿/, '').split(/\r?\n/);
  const hasHeaders = rows.some((r) => parseSectionHeader(r));
  const sections = [];
  const lines = [];
  let cur = null;
  const open = (name, type) => {
    cur = { name, type, start: lines.length, end: lines.length, auto: !name };
    sections.push(cur);
  };
  for (const raw of rows) {
    if (LRC_META.test(raw.trim())) continue;
    const row = raw.replace(LRC_TAG, '').trim();
    const head = parseSectionHeader(row);
    if (head) { open(head.name, head.type); continue; }
    if (!row) {
      if (!hasHeaders && cur && cur.end > cur.start) cur = null;
      continue;
    }
    if (!cur) open(hasHeaders ? '开头' : '', 'verse');
    lines.push(row);
    cur.end = lines.length;
  }
  const secs = sections.filter((s) => s.end > s.start);

  if (!hasHeaders) {
    // 无标记：重复段落 → 副歌，其余依次「第N段」
    const sig = (s) => lines.slice(s.start, s.end).join('\n');
    const count = new Map();
    for (const s of secs) count.set(sig(s), (count.get(sig(s)) || 0) + 1);
    let n = 0;
    for (const s of secs) {
      if (count.get(sig(s)) > 1) { s.type = 'chorus'; s.name = '副歌'; }
      else { n += 1; s.name = `第${n}段`; }
    }
  }
  const secOf = new Array(lines.length).fill(0);
  secs.forEach((s, i) => { for (let k = s.start; k < s.end; k++) secOf[k] = i; });
  return { lines, secOf, sections: secs.map(({ name, type, start, end }) => ({ name, type, start, end })) };
}

// ---------- 配色 ----------

function hexToHsl(hex) {
  const m = String(hex || '').replace('#', '').match(/^([0-9a-f]{6})$/i);
  const n = m ? parseInt(m[1], 16) : 0xc8902e;
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return { h, s: s * 100, l: l * 100 };
}

export function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return '#' + [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** 由一个主色生成三色深色渐变 + 高亮色（保证白字清晰） */
export function paletteFromColor(hex) {
  const { h, s } = hexToHsl(hex);
  const sat = Math.max(35, Math.min(80, s));
  return {
    colors: [hslToHex(h, sat, 24), hslToHex(h + 32, sat * 0.9, 16), hslToHex(h - 38, sat * 0.85, 9)],
    glow: hslToHex(h, 90, 72),
  };
}

export const LSHOW_SWATCHES = [
  { name: '暖金', color: '#c8902e' },
  { name: '深蓝', color: '#2f5fb3' },
  { name: '夜紫', color: '#7a3fc4' },
  { name: '晨光', color: '#e07a4f' },
  { name: '青绿', color: '#2aa58f' },
  { name: '酒红', color: '#a8324a' },
];

export function defaultLshowBg() {
  return { mode: 'gradient', color: '#c8902e', anim: true, speed: 24, dim: 0.45, image: '', video: '' };
}

// ---------- 渲染 ----------

/** 影响整体结构的签名：变了才全量重建（换行只走就地更新） */
function layoutSig(p) {
  const bg = p.bg || {};
  const st = p.style || {};
  return [
    p.songId, p.lines?.length, (p.lines || []).join('\n').length, p.view,
    bg.mode, bg.color, bg.anim, bg.speed, bg.dim, bg.image, bg.video,
    st.scale, st.showLabel, st.showTitle, p.title,
  ].join('|');
}

function bgHtml(bg, opts) {
  const pal = paletteFromColor(bg.color);
  const [c1, c2, c3] = pal.colors;
  const speed = Math.max(6, +bg.speed || 24);
  const flow = bg.anim !== false ? ' is-anim' : '';
  const grad = `<div class="lshow-grad${flow}" style="--c1:${c1};--c2:${c2};--c3:${c3};--glow:${pal.glow};--spd:${speed}s">
      <i class="lshow-blob b1"></i><i class="lshow-blob b2"></i></div>`;
  const dim = `<div class="lshow-dim" style="--dim:${Math.min(0.9, Math.max(0, +bg.dim || 0))}"></div>`;
  if (bg.mode === 'image' && bg.image) {
    return `${grad}<img class="lshow-media" src="${convertFileSrc(bg.image)}" draggable="false" alt="">${dim}`;
  }
  if (bg.mode === 'video' && bg.video) {
    // 主控预览不解码背景视频（与视频模块同理），只显示渐变 + 标注
    if (opts.videoPoster) return `${grad}${dim}<span class="lshow-badge">视频背景</span>`;
    return `${grad}<video class="lshow-media" src="${convertFileSrc(bg.video)}" autoplay loop muted playsinline></video>${dim}`;
  }
  return grad;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** 当前高亮的行（每次两行时为两行，不跨段） */
export function litLines(p) {
  const a = p.active | 0;
  const out = [a];
  if (p.step === 2 && a + 1 < p.lines.length && p.secOf[a + 1] === p.secOf[a]) out.push(a + 1);
  return out;
}

function buildTrack(wrap, p) {
  const track = wrap.querySelector('.lshow-track');
  if (p.view === 'stanza') {
    track.innerHTML = '';
    return;
  }
  track.innerHTML = p.lines.map((t, i) => {
    const gap = i > 0 && p.secOf[i] !== p.secOf[i - 1] ? ' sec-start' : '';
    return `<div class="lshow-line${gap}" data-i="${i}">${esc(t)}</div>`;
  }).join('');
}

function paintScroll(wrap, p) {
  const lit = litLines(p);
  const view = wrap.querySelector('.lshow-viewport');
  const track = wrap.querySelector('.lshow-track');
  const rows = track.children;
  const lo = lit[0], hi = lit[lit.length - 1];
  for (let i = 0; i < rows.length; i++) {
    const d = i < lo ? lo - i : i > hi ? i - hi : 0;
    rows[i].style.setProperty('--d', Math.min(d, 5));
    rows[i].classList.toggle('is-active', d === 0);
  }
  const a = rows[lo], b = rows[hi];
  if (!a || !view) return;
  const mid = (a.offsetTop + b.offsetTop + b.offsetHeight) / 2;
  track.style.transform = `translateY(${Math.round(view.clientHeight * 0.46 - mid)}px)`;
}

function paintStanza(wrap, p, force) {
  const box = wrap.querySelector('.lshow-stanza');
  const si = p.secOf[p.active | 0] | 0;
  const sec = p.sections[si];
  if (!sec) { box.innerHTML = ''; return; }
  if (force || box.dataset.sec !== String(si)) {
    box.dataset.sec = String(si);
    box.innerHTML = p.lines.slice(sec.start, sec.end)
      .map((t, k) => `<div class="lshow-sline" data-i="${sec.start + k}">${esc(t)}</div>`).join('');
    box.classList.remove('is-in');
    void box.offsetWidth;
    box.classList.add('is-in');
  }
  const lit = new Set(litLines(p));
  for (const el of box.children) el.classList.toggle('is-active', lit.has(+el.dataset.i));
}

function paintLabel(wrap, p) {
  const el = wrap.querySelector('.lshow-label');
  if (!el) return;
  const sec = p.sections[p.secOf[p.active | 0] | 0];
  const name = sec?.name || '';
  if (el.textContent === name) return;
  el.textContent = name;
  el.classList.remove('is-in');
  void el.offsetWidth;
  el.classList.add('is-in');
}

function paint(wrap, p, force = false) {
  if (p.view === 'stanza') paintStanza(wrap, p, force);
  else paintScroll(wrap, p);
  paintLabel(wrap, p);
  wrap._lshow = p;
}

/** 同一首歌、同样式时只换高亮行（不重建，不打断背景动画）。成功返回 true */
export function updateLyricShowInPlace(stage, p) {
  const wrap = stage.querySelector('.out-lshow');
  if (!wrap || wrap.dataset.sig !== layoutSig(p)) return false;
  paint(wrap, p);
  return true;
}

export function renderLyricShowInto(stage, p, opts = {}) {
  const bg = p.bg || defaultLshowBg();
  const st = p.style || {};
  const wrap = document.createElement('div');
  wrap.className = `out-lshow view-${p.view === 'stanza' ? 'stanza' : 'scroll'}`;
  wrap.dataset.sig = layoutSig(p);
  wrap.style.setProperty('--lscale', String(Math.min(2, Math.max(0.5, +st.scale || 1))));
  wrap.style.setProperty('--glow', paletteFromColor(bg.color).glow);
  wrap.innerHTML = `
    <div class="lshow-bg">${bgHtml(bg, opts)}</div>
    ${st.showTitle ? `<div class="lshow-title">${esc(p.title)}</div>` : ''}
    ${st.showLabel !== false ? '<div class="lshow-label"></div>' : ''}
    <div class="lshow-viewport"><div class="lshow-track"></div></div>
    <div class="lshow-stanza"></div>`;
  stage.appendChild(wrap);
  buildTrack(wrap, p);
  // 首帧不做滚动动画，直接定位
  const track = wrap.querySelector('.lshow-track');
  track.style.transition = 'none';
  paint(wrap, p, true);
  requestAnimationFrame(() => {
    paint(wrap, wrap._lshow, false);
    requestAnimationFrame(() => { track.style.transition = ''; });
  });
  // 窗口尺寸变化（拖到投影 / 全屏）后重新居中
  const ro = new ResizeObserver(() => { if (wrap.isConnected) paint(wrap, wrap._lshow); else ro.disconnect(); });
  ro.observe(wrap);
}
