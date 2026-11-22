// 简易右键菜单：点一项执行回调，点别处 / Esc 关闭

import { esc } from './util.js';

let el = null;
let onDoc = null;

function ensure() {
  if (el) return el;
  el = document.createElement('div');
  el.className = 'sp-ctx hidden';
  el.setAttribute('role', 'menu');
  document.body.appendChild(el);
  return el;
}

export function hideCtxMenu() {
  if (!el) return;
  el.classList.add('hidden');
  el.innerHTML = '';
  if (onDoc) {
    document.removeEventListener('pointerdown', onDoc, true);
    document.removeEventListener('keydown', onDoc, true);
    onDoc = null;
  }
}

/**
 * @param {MouseEvent} e
 * @param {{ label: string, action?: () => void, danger?: boolean, disabled?: boolean }[]} items
 */
export function showCtxMenu(e, items) {
  e.preventDefault();
  e.stopPropagation();
  hideCtxMenu();
  const list = (items || []).filter(Boolean);
  if (!list.length) return;
  const menu = ensure();
  menu.innerHTML = list.map((it, i) => (
    `<button type="button" class="sp-ctx-item${it.danger ? ' is-danger' : ''}" data-i="${i}" ${it.disabled ? 'disabled' : ''} role="menuitem">${esc(it.label)}</button>`
  )).join('');
  menu.classList.remove('hidden');
  const pad = 8;
  const w = menu.offsetWidth || 160;
  const h = menu.offsetHeight || 40;
  let x = e.clientX;
  let y = e.clientY;
  if (x + w > window.innerWidth - pad) x = Math.max(pad, window.innerWidth - w - pad);
  if (y + h > window.innerHeight - pad) y = Math.max(pad, window.innerHeight - h - pad);
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  menu.onclick = (ev) => {
    const btn = ev.target.closest('[data-i]');
    if (!btn || btn.disabled) return;
    const it = list[+btn.dataset.i];
    hideCtxMenu();
    it?.action?.();
  };

  onDoc = (ev) => {
    if (ev.type === 'keydown' && ev.key !== 'Escape') return;
    if (ev.type === 'pointerdown' && menu.contains(ev.target)) return;
    hideCtxMenu();
  };
  // 下一帧再挂，避免本次右键立刻被关掉
  requestAnimationFrame(() => {
    document.addEventListener('pointerdown', onDoc, true);
    document.addEventListener('keydown', onDoc, true);
  });
}
