// 把 app.css 里的颜色换成 CSS 变量，并生成 themes.css（浅色 / 护眼 / 深蓝 + 强调色）。
//   node scripts/themeify.mjs
// 可重复运行：已经是 var(--c-xxxxxx) 的不会再动；以后在 app.css 里新写了硬编码颜色，再跑一次即可。
//
// 规则：
//  - 输出舞台 / 投屏画面（.out-* / #output-* / .lshow-* 渲染层 / 缩略图 等）保持原样，不随主题变；
//  - 背景是「有色 / 纯黑 / 近黑」的规则（彩色按钮、媒体遮罩等），里面的白字和灰字也保持原样，
//    只有主强调色（蓝）跟随「强调色」设置；
//  - 其余的中性色（灰）按主题变换；浅色主题下偏亮的彩色（文字用的荧光绿 / 浅蓝等）自动压暗以保证可读。
import fs from 'node:fs';

const CSS_PATH = 'src/css/app.css';
const THEMES_PATH = 'src/css/themes.css';
const BEGIN = '/* THEME-TOKENS:BEGIN（由 scripts/themeify.mjs 生成，勿手改）*/';
const END = '/* THEME-TOKENS:END */';

// ───────── 颜色工具 ─────────
const hex6 = (h) => {
  h = h.toLowerCase();
  return h.length === 3 ? [...h].map((c) => c + c).join('') : h;
};
const toRgb = (hex) => {
  const n = parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
function rgb2hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2, d = mx - mn;
  let h = 0, s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s, l };
}
function hsl2rgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let [r, g, b] = [0, 0, 0];
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round((v + m) * 255))));
}
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const toHex = (rgb) => rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
const isSat = (hsl) => hsl.s >= 0.35;

// 主强调色（跟随「强调色」设置）
const ACCENT = new Set(['3a6fe8', '4f80f0']);

// ───────── 主题定义：对每个颜色(h,s,l)返回新的 [r,g,b] ─────────
// 深变浅、浅变深；原来偏亮的（文字类）再压暗一点，保证浅色底上够清晰
const flip = (l) => {
  const v = clamp(1.022 - 0.92 * l, 0.06, 0.985);
  return l >= 0.38 ? v * 0.8 : v;
};
function darkenSat(hsl) {
  // 浅色底上，偏亮的彩色（做文字用）压暗
  if (hsl.l > 0.55) return hsl2rgb(hsl.h, Math.min(hsl.s, 0.78), clamp(hsl.l * 0.6, 0.26, 0.5));
  return hsl2rgb(hsl.h, hsl.s, hsl.l);
}
const THEMES = {
  light: {
    name: '浅色',
    scheme: 'light',
    map(hsl) {
      if (isSat(hsl)) return darkenSat(hsl);
      return hsl2rgb(hsl.h, hsl.s * 0.9, flip(hsl.l));
    },
  },
  sepia: {
    name: '护眼',
    scheme: 'light',
    map(hsl) {
      if (isSat(hsl)) return darkenSat(hsl);
      const L = flip(hsl.l);
      return hsl2rgb(36, L > 0.7 ? 0.34 : L > 0.4 ? 0.2 : 0.16, L > 0.7 ? L * 0.97 : L * 0.9);
    },
  },
  midnight: {
    name: '深蓝',
    scheme: 'dark',
    map(hsl) {
      if (isSat(hsl)) return hsl2rgb(hsl.h, hsl.s, hsl.l);
      return hsl2rgb(222, clamp(0.22 + hsl.s * 0.8, 0, 0.5), hsl.l * 0.93);
    },
  },
};

const ACCENTS = {
  green: { name: '青绿', main: '1fa67a', hover: '2fbd8e' },
  purple: { name: '紫色', main: '7b61e6', hover: '8f78f0' },
  orange: { name: '橙色', main: 'e0762a', hover: 'ee8a40' },
  rose: { name: '玫红', main: 'dd4a7a', hover: 'ea6290' },
};

// ───────── 读 CSS，按规则处理 ─────────
let css = fs.readFileSync(CSS_PATH, 'utf8');
const nl = css.includes('\r\n') ? '\r\n' : '\n';
css = css.replace(/\r\n/g, '\n');
// 去掉上次生成的 token 区
const bi = css.indexOf(BEGIN), ei = css.indexOf(END);
if (bi >= 0 && ei > bi) css = css.slice(0, bi).replace(/\s+$/, '\n') + css.slice(ei + END.length).replace(/^\s*\n/, '');

const lineAt = (idx) => css.slice(0, idx).split('\n').length;
const STAGE_RANGES = [[881, 892], [962, 1035]];
const STAGE_SEL =
  /\.out-|#output-|\.output-body|\.slide-canvas|#preview-stage|\.lshow-(?:line|sline|title|stanza|label|viewport|track|bg|media|dim|badge|canvas)\b|\.pg-(?:bible|blank|lobby)-thumb|\.view-stanza|\.anim-|\.accent-dot|\.theme-sw/;

const used = { hex: new Map(), rgb: new Map() };
const stat = { rules: 0, literalStage: 0, literalBg: 0, converted: 0 };

function parseColors(value) {
  const out = [];
  for (const m of value.matchAll(/#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g)) out.push({ hex: hex6(m[1]) });
  for (const m of value.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g)) {
    out.push({ rgb: [+m[1], +m[2], +m[3]], alpha: /rgba\([^)]*,\s*([\d.]+)\s*\)/.exec(m[0] + value.slice(m.index + m[0].length, m.index + m[0].length + 20))?.[1] });
  }
  return out;
}

// 背景是否「有色 / 纯黑 / 近黑」——这类规则整体保持原样
function bgIsFixed(body) {
  for (const d of body.split(';')) {
    const m = /^\s*(background(?:-color)?)\s*:\s*([\s\S]+)$/.exec(d);
    if (!m) continue;
    const v = m[2];
    for (const c of parseColors(v)) {
      if (c.hex) {
        if (ACCENT.has(c.hex)) continue;
        if (c.hex === '000000') return true;
        const hsl = rgb2hsl(...toRgb(c.hex));
        if (isSat(hsl) && hsl.l < 0.7) return true;
        if (!isSat(hsl) && hsl.l < 0.05) return true;
      } else {
        const [r, g, b] = c.rgb;
        if (r === 0 && g === 0 && b === 0) return true;
        const hsl = rgb2hsl(r, g, b);
        if (isSat(hsl) && !(r === 58 && g === 111 && b === 232) && hsl.l < 0.7) return true;
      }
    }
  }
  return false;
}

function convertBody(body, fixed) {
  // 十六进制
  body = body.replace(/#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b(?![0-9a-fA-F])/g, (all, h) => {
    const hex = hex6(h);
    if (hex === '000000') return all; // 黑色（阴影 / 视频底）保持
    const hsl = rgb2hsl(...toRgb(hex));
    if (fixed && !ACCENT.has(hex)) return all;
    used.hex.set(hex, (used.hex.get(hex) || 0) + 1);
    stat.converted++;
    return `var(--c-${hex})`;
  });
  // rgba(r,g,b,a)：中性色 + 主强调色
  body = body.replace(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/g, (all, r, g, b, a) => {
    r = +r; g = +g; b = +b;
    if (r === 0 && g === 0 && b === 0) return all; // 黑色阴影 / 遮罩保持
    const hex = toHex([r, g, b]);
    const hsl = rgb2hsl(r, g, b);
    const accent = ACCENT.has(hex) || hex === '3a6fe8';
    if (!accent && (isSat(hsl) || fixed)) return all;
    used.rgb.set(hex, (used.rgb.get(hex) || 0) + 1);
    stat.converted++;
    return `rgba(var(--r-${hex}), ${a})`;
  });
  return body;
}

const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
css = css.replace(ruleRe, (all, sel, body, offset) => {
  stat.rules++;
  const line = lineAt(offset + sel.length - sel.trimStart().length);
  const inStage = STAGE_RANGES.some(([a, b]) => line >= a && line <= b) || STAGE_SEL.test(sel);
  // 舞台规则也要保留「已经是 var(--c-)」之外的原样：不转换
  if (inStage) {
    stat.literalStage++;
    return all;
  }
  const fixed = bgIsFixed(body);
  if (fixed) stat.literalBg++;
  return sel + '{' + convertBody(body, fixed) + '}';
});

// 已有 var(--c-xxx) / var(--r-xxx) 也要统计（重复运行时）
for (const m of css.matchAll(/var\(--c-([0-9a-f]{6})\)/g)) used.hex.set(m[1], used.hex.get(m[1]) || 1);
for (const m of css.matchAll(/var\(--r-([0-9a-f]{6})\)/g)) used.rgb.set(m[1], used.rgb.get(m[1]) || 1);

// ───────── 生成变量块 ─────────
const hexKeys = [...used.hex.keys()].sort();
const rgbKeys = [...used.rgb.keys()].sort();

function block(selector, hexFn, rgbFn, extra = '') {
  const lines = [];
  for (const k of hexKeys) {
    const v = hexFn(k);
    if (v) lines.push(`  --c-${k}: #${v};`);
  }
  for (const k of rgbKeys) {
    const v = rgbFn(k);
    if (v) lines.push(`  --r-${k}: ${v.join(', ')};`);
  }
  return `${selector} {\n${extra}${lines.join('\n')}\n}\n`;
}

const defaults = block(':root', (k) => k, (k) => toRgb(k), '  color-scheme: dark;\n');
fs.writeFileSync(
  CSS_PATH,
  (BEGIN + '\n' + defaults + END + '\n\n' + css.replace(/^\s+/, '')).replace(/\n/g, nl)
);

let themes = `/* 界面主题（由 scripts/themeify.mjs 生成，勿手改）。默认深色在 app.css 的 :root 里。
   用法：<html data-theme="light|sepia|midnight" data-accent="green|purple|orange|rose"> */\n\n`;
for (const [id, t] of Object.entries(THEMES)) {
  themes += `/* ${t.name} */\n`;
  themes += block(
    `html[data-theme="${id}"]`,
    (k) => (ACCENT.has(k) ? k : toHex(t.map(rgb2hsl(...toRgb(k))))),
    (k) => (ACCENT.has(k) ? toRgb(k) : t.map(rgb2hsl(...toRgb(k)))),
    `  color-scheme: ${t.scheme};\n`
  );
  themes += '\n';
}
themes += '/* 强调色（放在最后，覆盖主题里的蓝色） */\n';
for (const [id, a] of Object.entries(ACCENTS)) {
  themes += `html[data-accent="${id}"] {\n  --c-3a6fe8: #${a.main};\n  --c-4f80f0: #${a.hover};\n  --r-3a6fe8: ${toRgb(a.main).join(', ')};\n}\n`;
}
fs.writeFileSync(THEMES_PATH, themes);

console.log(
  `规则 ${stat.rules}；舞台保留 ${stat.literalStage}；有色/黑底保留 ${stat.literalBg}；新转换 ${stat.converted} 处；` +
    `变量：hex ${hexKeys.length} 个，rgb ${rgbKeys.length} 个`
);
