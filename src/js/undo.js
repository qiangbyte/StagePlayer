// 撤销：移除 / 清空之后底部弹出「撤销」条，Ctrl+Z 也能撤回（最多记 20 步）
// 演出现场容易误点：删除不再弹确认框，删了马上能撤回

import { toast } from './util.js';

const MAX = 20;
const BAR_MS = 8000;
const stack = [];
let bar = null;
let barTimer = 0;

/**
 * 记一步可撤销的操作
 * @param {string} label 例如「移除『如鹿切慕溪水』」
 * @param {() => void} restore 撤销时执行，把数据恢复回去
 */
export function pushUndo(label, restore) {
  stack.push({ label, restore });
  if (stack.length > MAX) stack.shift();
  showBar(label);
}

/** 撤销最近一步；没有可撤销的返回 false */
export function undoLast() {
  const op = stack.pop();
  hideBar();
  if (!op) {
    toast('没有可撤销的操作');
    return false;
  }
  try {
    op.restore();
    toast(`已撤销：${op.label}`);
  } catch (err) {
    toast('撤销失败：' + (err?.message || err));
  }
  if (stack.length) showBar(stack[stack.length - 1].label, true);
  return true;
}

function ensureBar() {
  if (bar) return bar;
  bar = document.createElement('div');
  bar.id = 'sp-undo-bar';
  bar.innerHTML = `<span class="undo-text"></span>
    <button type="button" class="undo-btn">撤销 <span class="undo-key">Ctrl+Z</span></button>
    <button type="button" class="undo-close" title="关闭">✕</button>`;
  bar.querySelector('.undo-btn').addEventListener('click', () => undoLast());
  bar.querySelector('.undo-close').addEventListener('click', hideBar);
  // 鼠标停在条上时不自动消失
  bar.addEventListener('mouseenter', () => clearTimeout(barTimer));
  bar.addEventListener('mouseleave', () => armHide());
  document.body.appendChild(bar);
  return bar;
}

function armHide() {
  clearTimeout(barTimer);
  barTimer = setTimeout(hideBar, BAR_MS);
}

function showBar(label, quiet = false) {
  const el = ensureBar();
  el.querySelector('.undo-text').textContent = quiet ? `还可撤销：${label}` : `已${label}`;
  el.classList.add('show');
  armHide();
}

function hideBar() {
  clearTimeout(barTimer);
  bar?.classList.remove('show');
}
