// 界面主题：深色（默认）/ 浅色 / 护眼 / 深蓝 / 跟随系统，外加强调色。
// 只影响主控界面；输出窗口和投屏画面（舞台）不跟随，始终保持原样。
// 变量表在 css/app.css 的 :root（深色）和 css/themes.css（其余主题），由 scripts/themeify.mjs 生成。

import { lsGet, lsSet } from './util.js';

const KEY_THEME = 'sp.ui.theme';
const KEY_ACCENT = 'sp.ui.accent';
const THEMES = ['auto', 'dark', 'light', 'sepia', 'midnight'];
const ACCENTS = ['blue', 'green', 'purple', 'orange', 'rose'];

const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

function resolveTheme(t) {
  if (t === 'auto') return mq?.matches ? 'light' : 'dark';
  return THEMES.includes(t) ? t : 'dark';
}

export function applyTheme() {
  const t = lsGet(KEY_THEME, 'dark');
  const a = lsGet(KEY_ACCENT, 'blue');
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(t);
  if (a && a !== 'blue' && ACCENTS.includes(a)) root.dataset.accent = a;
  else delete root.dataset.accent;
  paintPicker(THEMES.includes(t) ? t : 'dark', ACCENTS.includes(a) ? a : 'blue');
}

function paintPicker(t, a) {
  document.querySelectorAll('#theme-grid .theme-card').forEach((b) => {
    b.classList.toggle('active', b.dataset.theme === t);
    b.setAttribute('aria-pressed', b.dataset.theme === t ? 'true' : 'false');
  });
  document.querySelectorAll('#accent-dots .accent-dot').forEach((b) => {
    b.classList.toggle('active', b.dataset.accent === a);
    b.setAttribute('aria-pressed', b.dataset.accent === a ? 'true' : 'false');
  });
}

export function initTheme() {
  document.getElementById('theme-grid')?.addEventListener('click', (e) => {
    const t = e.target.closest('.theme-card')?.dataset.theme;
    if (!t || !THEMES.includes(t)) return;
    lsSet(KEY_THEME, t);
    applyTheme();
  });
  document.getElementById('accent-dots')?.addEventListener('click', (e) => {
    const a = e.target.closest('.accent-dot')?.dataset.accent;
    if (!a || !ACCENTS.includes(a)) return;
    lsSet(KEY_ACCENT, a);
    applyTheme();
  });
  // 「跟随系统」时，系统明暗切换要即时生效
  mq?.addEventListener?.('change', () => {
    if (lsGet(KEY_THEME, 'dark') === 'auto') applyTheme();
  });
  applyTheme(); // 数据恢复之后再应用一次，换电脑导入设置后也能生效
}
