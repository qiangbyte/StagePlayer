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

const LRC_TAG = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const LRC_META = /^\[(ti|ar|al|by|offset|re|ve|length):.*\]$/i;

function parseLrcTimeSec(raw) {
  let best = null;
  LRC_TAG.lastIndex = 0;
  let m;
  while ((m = LRC_TAG.exec(raw))) {
    const min = +m[1];
    const sec = +m[2];
    const frac = m[3] || '0';
    const ms = frac.length <= 2 ? +frac * (frac.length === 1 ? 100 : 10) : +frac;
    const t = min * 60 + sec + ms / 1000;
    if (best == null || t < best) best = t;
  }
  return best;
}

/**
 * 歌词文本 → { lines, times, secOf, sections }
 * times[i]：该行 LRC 时间（秒），无时间轴则为 null
 * 有段落标记按标记分段；没有标记时按空行分段，重复出现的段落自动认作副歌
 */
export function parseLyricSheet(text) {
  const rows = String(text || '').replace(/^﻿/, '').split(/\r?\n/);
  const hasHeaders = rows.some((r) => parseSectionHeader(r));
  const sections = [];
  const lines = [];
  const times = [];
  let cur = null;
  const open = (name, type) => {
    cur = { name, type, start: lines.length, end: lines.length, auto: !name };
    sections.push(cur);
  };
  for (const raw of rows) {
    if (LRC_META.test(raw.trim())) continue;
    const tSec = parseLrcTimeSec(raw);
    LRC_TAG.lastIndex = 0;
    const row = raw.replace(LRC_TAG, '').trim();
    const head = parseSectionHeader(row);
    if (head) { open(head.name, head.type); continue; }
    if (!row) {
      if (!hasHeaders && cur && cur.end > cur.start) cur = null;
      continue;
    }
    if (!cur) open(hasHeaders ? '开头' : '', 'verse');
    lines.push(row);
    times.push(tSec);
    cur.end = lines.length;
  }
  const secs = sections.filter((s) => s.end > s.start);

  if (!hasHeaders) {
    // 无标记：重复段落 → 副歌（内容不同的重复段依次叫 副歌 / 副歌2 …），其余依次「第N段」
    const sig = (s) => lines.slice(s.start, s.end).join('\n');
    const count = new Map();
    for (const s of secs) count.set(sig(s), (count.get(sig(s)) || 0) + 1);
    const chorusNo = new Map();
    let n = 0;
    for (const s of secs) {
      const k = sig(s);
      if (count.get(k) > 1) {
        if (!chorusNo.has(k)) chorusNo.set(k, chorusNo.size + 1);
        const c = chorusNo.get(k);
        s.type = 'chorus';
        s.name = c > 1 ? `副歌${c}` : '副歌';
      } else { n += 1; s.name = `第${n}段`; }
    }
  }
  const secOf = new Array(lines.length).fill(0);
  secs.forEach((s, i) => { for (let k = s.start; k < s.end; k++) secOf[k] = i; });
  return {
    lines,
    times,
    secOf,
    sections: secs.map(({ name, type, start, end }) => ({ name, type, start, end })),
  };
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
    st.scale, st.showLabel, st.showTitle, st.font, st.anim, p.title,
  ].join('|');
}

function bgHtml(bg, opts) {
  const pal = paletteFromColor(bg.color);
  const [c1, c2, c3] = pal.colors;
  const speed = Math.max(6, +bg.speed || 24);
  const flow = bg.anim !== false && !(bg.mode === 'image' && bg.image) && !(bg.mode === 'video' && bg.video && !opts.videoPoster) ? ' is-anim' : '';
  // 背景用一张低分辨率 canvas 绘制后拉伸：渐变本身很柔，放大无损；
  // 不再用 CSS 大图层 + transform 动画（扩展屏上会颤 / 边角闪）
  const lite = opts.videoPoster ? ' is-lite' : '';
  const grad = `<canvas class="lshow-canvas${flow}${lite}" style="position:absolute;inset:0;width:100%;height:100%;display:block" data-c1="${c1}" data-c2="${c2}" data-c3="${c3}" data-glow="${pal.glow}" data-spd="${speed}"></canvas>`;
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
  if (p.view === 'page') {
    const sec = p.sections[p.secOf[a] | 0];
    if (sec) return Array.from({ length: sec.end - sec.start }, (_, k) => sec.start + k);
  }
  const out = [a];
  if (p.step === 2 && a + 1 < p.lines.length && p.secOf[a + 1] === p.secOf[a]) out.push(a + 1);
  return out;
}

/** 歌词字体（扩展屏必须装了对应字体；没装时 CSS 回退微软雅黑） */
const LSHOW_FONTS = {
  fzchs: '"方正粗黑宋简体", "FZCuHeiSongS-B-GB"',
  yahei: '"Microsoft YaHei"',
  hei: '"SimHei", "Microsoft YaHei"',
  song: '"SimSun", "NSimSun"',
};

/** stanza / page 都是整段排版，只有 scroll 走滚动轨道 */
const isStanzaView = (p) => p.view === 'stanza' || p.view === 'page';

function buildTrack(wrap, p) {
  const track = wrap.querySelector('.lshow-track');
  if (isStanzaView(p)) {
    track.innerHTML = '';
    return;
  }
  track.innerHTML = p.lines.map((t, i) => {
    const gap = i > 0 && p.secOf[i] !== p.secOf[i - 1] ? ' sec-start' : '';
    return `<div class="lshow-line${gap}" data-i="${i}" data-t="${esc(t)}">${esc(t)}</div>`;
  }).join('');
}

function paintScroll(wrap, p) {
  const lit = litLines(p);
  const view = wrap.querySelector('.lshow-viewport');
  const track = wrap.querySelector('.lshow-track');
  const rows = track.children;
  const lo = lit[0], hi = lit[lit.length - 1];
  const preview = p.preview | 0;
  const showPreview = p.autoPlay && preview > hi && preview < p.lines.length;
  for (let i = 0; i < rows.length; i++) {
    const d = i < lo ? lo - i : i > hi ? i - hi : 0;
    rows[i].style.setProperty('--d', Math.min(d, 5));
    rows[i].classList.toggle('is-active', d === 0);
    rows[i].classList.toggle('is-next', showPreview && i === preview);
  }
  const a = rows[lo], b = rows[hi];
  if (!a || !view) return;
  const mid = (a.offsetTop + b.offsetTop + b.offsetHeight) / 2;
  // 宽屏（如 2048×896）高度紧张：当前行放正中；16:9 略偏上更符合视线
  const center = wrap.classList.contains('is-wide') ? 0.5 : 0.46;
  scrollTrackTo(track, view.clientHeight * center - mid);
}

/**
 * 歌词滚动：JS 逐帧驱动，每帧都对齐到屏幕物理像素。
 * 不用 CSS transform 过渡——过渡中途是小数像素，GPU 插值把文字层摆到小数位置会发虚，
 * 每帧虚实不同 = 字在闪（Windows 125%/150% 缩放下尤其明显）
 */
const SCROLL_MS = 500;
const easeOut = (k) => 1 - Math.pow(1 - k, 3);
function snapPx(v) {
  const dpr = window.devicePixelRatio || 1;
  return Math.round(v * dpr) / dpr;
}
function setTrackY(track, y) {
  track._y = y;
  track.style.transform = `translate3d(0, ${snapPx(y)}px, 0)`;
}
function scrollTrackTo(track, target, instant = false) {
  target = snapPx(target);
  const st = track._scroll || (track._scroll = { raf: 0 });
  if (st.target === target && (st.raf || track._y === target)) return;
  st.target = target;
  if (instant || track._y == null || track.dataset.instant === '1') {
    cancelAnimationFrame(st.raf); st.raf = 0;
    setTrackY(track, target);
    return;
  }
  st.from = track._y;
  st.t0 = performance.now();
  if (st.raf) return;
  const step = (now) => {
    const k = Math.min(1, (now - st.t0) / SCROLL_MS);
    setTrackY(track, st.from + (st.target - st.from) * easeOut(k));
    if (k < 1 && track.isConnected) st.raf = requestAnimationFrame(step);
    else { st.raf = 0; if (track.isConnected) setTrackY(track, st.target); }
  };
  st.raf = requestAnimationFrame(step);
}

function paintStanza(wrap, p, force) {
  const box = wrap.querySelector('.lshow-stanza');
  const si = p.secOf[p.active | 0] | 0;
  const sec = p.sections[si];
  if (!sec) { box.innerHTML = ''; return; }
  const n = sec.end - sec.start;
  // 宽屏且段落较长：两栏排布，避免挤成一长列
  const cols = wrap.classList.contains('is-wide') && n > 4;
  const layoutKey = `${si}|${cols}`;
  if (force || box.dataset.sec !== layoutKey) {
    box.dataset.sec = layoutKey;
    box.classList.toggle('cols-2', cols);
    box.style.setProperty('--rows', String(Math.ceil(n / 2)));
    box.innerHTML = p.lines.slice(sec.start, sec.end)
      .map((t, k) => `<div class="lshow-sline" data-i="${sec.start + k}" data-t="${esc(t)}" style="--k:${k}">${esc(t)}</div>`).join('');
    fitStanza(box);
    box.classList.remove('is-in');
    void box.offsetWidth;
    box.classList.add('is-in');
  }
  const lit = new Set(litLines(p));
  const preview = p.preview | 0;
  const showPreview = p.autoPlay && preview >= 0 && !lit.has(preview);
  for (const el of box.children) {
    const i = +el.dataset.i;
    el.classList.toggle('is-active', lit.has(i));
    el.classList.toggle('is-next', showPreview && i === preview);
  }
}

/** 段落行数多时整体缩小字号，保证一整段放得下（不出框、不被裁） */
function fitStanza(box) {
  box.style.setProperty('--sfit', '1');
  const kids = box.children;
  if (!kids.length || !(box.clientHeight > 0)) return;
  // 用布局位置（offset*）而不是屏幕矩形：切换动画中的位移 / 缩放不影响测量
  let top = Infinity, bottom = -Infinity;
  for (const el of kids) {
    top = Math.min(top, el.offsetTop);
    bottom = Math.max(bottom, el.offsetTop + el.offsetHeight);
  }
  const k = Math.min(1, box.clientHeight / Math.max(1, bottom - top));
  if (k < 1) box.style.setProperty('--sfit', String(Math.max(0.4, Math.floor(k * 0.97 * 100) / 100)));
}

function refitStanza(wrap) {
  const box = wrap.querySelector('.lshow-stanza');
  if (box && wrap.classList.contains('view-stanza')) fitStanza(box);
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

/** 宽高比 ≥ 1.9（如 2048×896 的长条屏）走宽屏排版 */
const WIDE_RATIO = 1.9;

function paint(wrap, p, force = false) {
  const w = wrap.clientWidth, h = wrap.clientHeight;
  if (h > 0) wrap.classList.toggle('is-wide', w / h >= WIDE_RATIO);
  if (isStanzaView(p)) paintStanza(wrap, p, force);
  else paintScroll(wrap, p);
  paintLabel(wrap, p);
  wrap._lshow = p;
}

// ---------- 背景绘制（canvas） ----------

function hexRgb(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const mix = (a, b, k) => a.map((v, i) => Math.round(v * k + b[i] * (1 - k)));
/** 0→1→0 的往返缓动，等同 CSS ease-in-out alternate */
const swing = (t, period) => (1 - Math.cos((Math.PI * t) / period)) / 2;

/** 背景画布宽度（像素）。内容是大面积柔和渐变，低分辨率放大后肉眼无差别 */
const BG_W = 320;

function sizeBgCanvas(cv) {
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!(w > 0 && h > 0)) return false;
  const H = Math.max(2, Math.round((BG_W * h) / w));
  if (cv.width !== BG_W || cv.height !== H) { cv.width = BG_W; cv.height = H; }
  return true;
}

function drawBg(cv, t) {
  const g = cv.getContext('2d', { alpha: false });
  const W = cv.width, H = cv.height;
  const c1 = hexRgb(cv.dataset.c1), c2 = hexRgb(cv.dataset.c2), c3 = hexRgb(cv.dataset.c3);
  const glow = hexRgb(cv.dataset.glow);
  const P = Math.max(6, +cv.dataset.spd || 24);

  // 底色：125° 渐变铺在 3 倍大的虚拟面上缓慢平移（与原 CSS 效果一致）
  const u = swing(t, P);
  const vx = -2 * W * u, vy = -2 * H * (0.4 + 0.2 * u), vw = 3 * W, vh = 3 * H;
  const rad = (125 * Math.PI) / 180;
  const dx = Math.sin(rad), dy = -Math.cos(rad);
  const len = Math.abs(vw * dx) + Math.abs(vh * dy);
  const cx = vx + vw / 2, cy = vy + vh / 2;
  const lg = g.createLinearGradient(cx - (dx * len) / 2, cy - (dy * len) / 2, cx + (dx * len) / 2, cy + (dy * len) / 2);
  lg.addColorStop(0, rgba(c1, 1)); lg.addColorStop(0.35, rgba(c2, 1));
  lg.addColorStop(0.65, rgba(c3, 1)); lg.addColorStop(1, rgba(c1, 1));
  g.globalCompositeOperation = 'source-over';
  g.fillStyle = lg;
  g.fillRect(0, 0, W, H);

  // 两团柔光
  const blob = (x, y, r, col, a) => {
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, rgba(col, a));
    rg.addColorStop(0.3, rgba(col, a * 0.7));
    rg.addColorStop(0.6, rgba(col, a * 0.3));
    rg.addColorStop(0.82, rgba(col, a * 0.08));
    rg.addColorStop(1, rgba(col, 0));
    g.fillStyle = rg;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  };
  const u1 = swing(t, P * 1.3), u2 = swing(t, P * 1.7);
  blob(W * (0.2 + 0.3 * u1), W * 0.05 + H * 0.18 * u1, W * 0.45, c2, 0.55);
  blob(W * (0.9 - 0.26 * u2), H * (0.15 - 0.2 * u2) + W * 0.45, W * 0.45, mix(glow, c1, 0.4), 0.4);
}

/** 所有动态背景共用一个 rAF 循环；画布离开页面自动移除。
 * 每块画布自己累计时间，单帧最多前进 50ms：偶尔掉帧时背景只是慢一拍，不会突然跳一截 */
const bgSet = new Set();
let bgRaf = 0;
let bgLast = 0;
/** 主控里的小预览降到约 15fps，给输出窗口让出 GPU */
const LITE_MS = 66;
function bgLoop(now) {
  bgRaf = 0;
  const dt = bgLast ? Math.min(50, Math.max(0, now - bgLast)) : 16;
  bgLast = now;
  for (const cv of bgSet) {
    if (!cv.isConnected) { bgSet.delete(cv); continue; }
    cv._t = (cv._t || 0) + dt / 1000;
    if (cv.classList.contains('is-lite')) {
      if (now - (cv._drawn || 0) < LITE_MS) continue;
      cv._drawn = now;
    }
    if (sizeBgCanvas(cv)) drawBg(cv, cv._t);
  }
  if (bgSet.size) bgRaf = requestAnimationFrame(bgLoop);
  else bgLast = 0;
}

/** 背景整页重建（换歌 / 改样式）时沿用上一块画布的进度，动画不会从头跳 */
let bgCarryT = 0;

function startBg(wrap) {
  const cv = wrap.querySelector('.lshow-canvas');
  if (!cv) return;
  if (cv.classList.contains('is-anim')) {
    if (!cv.classList.contains('is-lite')) {
      // 接上旧画布的进度
      for (const old of bgSet) if (!old.classList.contains('is-lite') && old._t) bgCarryT = Math.max(bgCarryT, old._t);
      cv._t = bgCarryT;
    }
    bgSet.add(cv);
    if (!bgRaf) bgRaf = requestAnimationFrame(bgLoop);
  }
  // 静态（或首帧）立即画一张，避免出现一帧空白
  if (sizeBgCanvas(cv)) drawBg(cv, cv._t || 0);
}

function redrawStaticBg(wrap) {
  const cv = wrap.querySelector('.lshow-canvas');
  if (cv && !cv.classList.contains('is-anim') && sizeBgCanvas(cv)) drawBg(cv, 0);
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
  const anim = ['fade', 'rise', 'zoom', 'blur', 'stagger', 'none'].includes(st.anim) ? st.anim : 'fade';
  wrap.className = `out-lshow view-${isStanzaView(p) ? 'stanza' : 'scroll'}${p.view === 'page' ? ' is-page' : ''} anim-${anim}`;
  wrap.dataset.sig = layoutSig(p);
  wrap.style.setProperty('--lscale', String(Math.min(2, Math.max(0.5, +st.scale || 1))));
  wrap.style.setProperty('--glow', paletteFromColor(bg.color).glow);
  wrap.style.setProperty('--lfont', LSHOW_FONTS[st.font] || LSHOW_FONTS.fzchs);
  wrap.innerHTML = `
    <div class="lshow-bg">${bgHtml(bg, opts)}</div>
    ${st.showTitle ? `<div class="lshow-title">${esc(p.title)}</div>` : ''}
    ${st.showLabel !== false ? '<div class="lshow-label"></div>' : ''}
    <div class="lshow-viewport"><div class="lshow-track"></div></div>
    <div class="lshow-stanza"></div>`;
  stage.appendChild(wrap);
  buildTrack(wrap, p);
  startBg(wrap);
  // 首帧不做滚动动画，直接定位
  const track = wrap.querySelector('.lshow-track');
  track.dataset.instant = '1';
  paint(wrap, p, true);
  requestAnimationFrame(() => {
    paint(wrap, wrap._lshow, false);
    requestAnimationFrame(() => { delete track.dataset.instant; });
  });
  // 窗口尺寸变化（拖到投影 / 全屏）后重新居中
  const ro = new ResizeObserver(() => {
    if (!wrap.isConnected) { ro.disconnect(); return; }
    paint(wrap, wrap._lshow);
    refitStanza(wrap);
    redrawStaticBg(wrap);
  });
  ro.observe(wrap);
  // 字体加载完字宽会变，整段排版重新量一次
  document.fonts?.ready.then(() => { if (wrap.isConnected) refitStanza(wrap); });
}
