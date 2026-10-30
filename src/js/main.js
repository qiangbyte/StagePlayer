// 主控窗口入口：模块切换、侧栏、输出控制、快捷键

import { initTimers } from './timers.js';
import { initAudio, toggleAudio, audioStep } from './audio.js';
import { initVideo } from './video.js';
import { initPpt, pptNavigate } from './ppt.js';
import { initPdf, pdfNavigate } from './pdf.js';
import { initProgram, programGo, programStep, programActiveType } from './program.js';
import { initSpl } from './spl.js';
import { initKaraoke } from './karaoke.js';
import {
  setPreviewEl, getCurrentOutput, pushFitMode, toggleBlack, setOutputFrozen, isOutputFrozen,
  resyncOutput,
} from './output-main.js';
import { invoke, listen, lsGet, lsSet, toast } from './util.js';

const $ = (id) => document.getElementById(id);

const MODULES = {
  audio: { listTitle: '目录', importEv: 'sp:import-audio' },
  video: { listTitle: '目录', importEv: 'sp:import-video' },
  ppt: { listTitle: '目录 · 文稿', importEv: 'sp:import-ppt' },
  pdf: { listTitle: '目录 · 文档', importEv: 'sp:import-pdf' },
  program: { listTitle: '本场演出' },
  spl: { listTitle: '声压测量' },
};

const SIDEBAR_MAP = {
  audio: 'audio-list-wrap',
  video: 'video-list-wrap',
  ppt: 'ppt-docs-wrap',
  pdf: 'pdf-docs-wrap',
  program: 'program-events-wrap',
};

let module = 'audio';

function switchModule(m) {
  if (!MODULES[m]) return;
  module = m;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.module === m));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.dataset.module === m));
  document.querySelectorAll('#sidebar .file-list-wrap').forEach((w) => (w.style.display = 'none'));
  const wrap = document.getElementById(SIDEBAR_MAP[m]);
  if (wrap) wrap.style.display = 'flex';
  const showIO = !!MODULES[m].importEv;
  $('btn-import').style.display = showIO ? '' : 'none';
  $('btn-clear').style.display = showIO ? '' : 'none';
  $('list-title').textContent = MODULES[m].listTitle;
  document.dispatchEvent(new CustomEvent('sp:module-change', { detail: m }));
}

document.addEventListener('sp:switch-module', (e) => {
  if (e.detail && MODULES[e.detail]) switchModule(e.detail);
});

function initTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => switchModule(tab.dataset.module));
  });
  $('btn-import').addEventListener('click', () => {
    const ev = MODULES[module].importEv;
    if (ev) document.dispatchEvent(new CustomEvent(ev));
  });
  $('btn-clear').addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('sp:clear-list'));
  });
}

function initSettings() {
  const pop = $('settings-pop');
  const selMonitor = $('sel-monitor');
  const selFit = $('sel-fit');
  const selDevice = $('sel-audio-device');

  selFit.value = lsGet('sp.output.fit', 'contain');
  selFit.addEventListener('change', () => {
    lsSet('sp.output.fit', selFit.value);
    pushFitMode(selFit.value);
  });

  $('btn-settings').addEventListener('click', (e) => {
    e.stopPropagation();
    pop.classList.toggle('hidden');
    if (!pop.classList.contains('hidden')) {
      refreshMonitors();
      refreshAudioDevices();
    }
  });
  document.addEventListener('click', (e) => {
    if (!pop.classList.contains('hidden') && !e.target.closest('.settings-wrap')) {
      pop.classList.add('hidden');
    }
  });

  async function refreshMonitors() {
    try {
      const monitors = await invoke('list_monitors');
      const target = resolveTargetMonitor(monitors);
      selMonitor.innerHTML = monitors.map((m) => {
        const sizeTxt = `${m.width}×${m.height}`;
        const tag = m.is_primary ? '主屏' : '扩展屏';
        const star = target !== null && m.index === target ? ' ✔ 当前投屏' : '';
        return `<option value="${m.index}">${m.index + 1}. ${tag} ${m.name ? m.name + ' ' : ''}${sizeTxt}${star}</option>`;
      }).join('');
      if (target !== null) selMonitor.value = String(target);
    } catch { /* ignore */ }
  }

  async function refreshAudioDevices() {
    try {
      const devices = await invoke('list_audio_output_devices');
      const saved = lsGet('sp.audio.device', null);
      selDevice.innerHTML = '<option value="">系统默认</option>' + devices.map((d) =>
        `<option value="${d.index}">${escAttr(d.name)}${d.is_default ? '（系统默认）' : ''}</option>`
      ).join('');
      if (saved !== null && saved !== undefined) selDevice.value = String(saved);
    } catch { /* ignore */ }
  }

  function escAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  }

  $('btn-refresh-devices').addEventListener('click', refreshAudioDevices);

  selDevice.addEventListener('change', () => {
    const v = selDevice.value;
    lsSet('sp.audio.device', v === '' ? null : +v);
    document.dispatchEvent(new CustomEvent('sp:audio-device-changed'));
  });

  $('btn-apply-monitor').addEventListener('click', async () => {
    const idx = parseInt(selMonitor.value, 10);
    if (isNaN(idx)) return;
    lsSet('sp.output.monitor', idx);
    await openOutput(true, idx);
  });

  // 切换下拉即记住目标屏（下次全屏输出直接用）
  selMonitor.addEventListener('change', () => {
    const idx = parseInt(selMonitor.value, 10);
    if (!isNaN(idx)) lsSet('sp.output.monitor', idx);
  });

  const chkTop = $('chk-topmost');
  chkTop.checked = lsGet('sp.output.topmost', false);
  chkTop.addEventListener('change', async () => {
    lsSet('sp.output.topmost', chkTop.checked);
    try { await invoke('set_output_always_on_top', { onTop: chkTop.checked }); } catch { /* ignore */ }
  });
}

/** 解析投屏目标：设置里选中的 → 上次使用 → 第一块扩展屏 → 主屏 */
function resolveTargetMonitor(monitors, preferred) {
  if (!Array.isArray(monitors) || !monitors.length) return null;
  const pref = preferred !== undefined && preferred !== null
    ? preferred
    : lsGet('sp.output.monitor', null);
  if (pref !== null && monitors.some((m) => m.index === pref)) return pref;
  const ext = monitors.find((m) => !m.is_primary);
  if (ext) return ext.index;
  return monitors[0].index;
}

/**
 * 打开输出窗口并投到扩展屏/所选显示器
 * @param {boolean} fullscreen 是否铺满该屏
 * @param {number|null} [forceIndex] 强制指定显示器索引
 */
async function openOutput(fullscreen, forceIndex = null) {
  try {
    const monitors = await invoke('list_monitors');
    const target = resolveTargetMonitor(monitors, forceIndex);
    if (target !== null) lsSet('sp.output.monitor', target);
    const mon = monitors.find((m) => m.index === target);

    // 创建时就落到目标屏，避免先出现在主屏再跳
    await invoke('open_output_window', { monitorIndex: target });
    await new Promise((r) => setTimeout(r, 180));

    if (target !== null) {
      const info = await invoke('place_output_on_monitor', {
        index: target,
        fullscreen: !!fullscreen,
      });
      const tag = info?.is_primary ? '主屏' : '扩展屏';
      toast(`已投到${tag}${info?.name ? ' ' + info.name : ''}（${info?.width || ''}×${info?.height || ''}）`);
    } else if (fullscreen) {
      await invoke('set_output_fullscreen', { fullscreen: true });
    }

    // 置顶（扩展屏投屏默认建议置顶，防止被遮挡）
    const topmost = lsGet('sp.output.topmost', false);
    if (topmost || (mon && !mon.is_primary)) {
      try { await invoke('set_output_always_on_top', { onTop: true }); } catch { /* ignore */ }
    }

    // 窗口监听器就绪后再推一次画面（解决扩展屏黑屏/无内容）
    await new Promise((r) => setTimeout(r, 200));
    resyncOutput();
    setTimeout(resyncOutput, 500);
  } catch (err) {
    toast('打开输出窗口失败：' + err);
  }
}

/** 从主控关闭扩展屏输出（演出场景不必跑到大屏点关闭） */
async function closeOutputFromMain() {
  try {
    await invoke('close_output_window');
    toast('已关闭输出窗口');
  } catch (err) {
    toast('关闭失败：' + err);
  }
}

/** 确保主控有「关闭输出」按钮（兼容旧版嵌入的 HTML） */
function ensureCloseOutputButton() {
  let btn = $('btn-close-output');
  if (!btn) {
    const wrap = document.querySelector('.output-controls');
    const after = $('btn-fs-output') || $('btn-open-output');
    btn = document.createElement('button');
    btn.id = 'btn-close-output';
    btn.className = 'btn danger';
    btn.title = '关闭扩展屏输出（快捷键 Esc / X）';
    btn.textContent = '关闭输出';
    if (wrap && after) after.insertAdjacentElement('afterend', btn);
    else if (wrap) wrap.insertBefore(btn, wrap.firstChild);
  }
  btn.style.display = '';
  btn.textContent = '关闭输出';
  btn.classList.add('danger');
  // 旧版「输出窗口」按钮改成次要入口，避免占位
  const oldOpen = $('btn-open-output');
  if (oldOpen && (oldOpen.textContent || '').includes('输出窗口')) {
    oldOpen.textContent = '打开输出';
    oldOpen.style.display = 'none';
  }
  return btn;
}

function initOutputControls() {
  const btnClose = ensureCloseOutputButton();
  $('btn-open-output')?.addEventListener('click', () => openOutput(false));
  $('btn-fs-output')?.addEventListener('click', () => openOutput(true));
  document.addEventListener('sp:open-output', (e) => {
    openOutput(e.detail?.fullscreen !== false);
  });
  btnClose.addEventListener('click', () => closeOutputFromMain());
  $('btn-black').addEventListener('click', () => {
    toggleBlack();
  });
  const btnFreeze = $('btn-freeze');
  btnFreeze.addEventListener('click', () => {
    const next = !isOutputFrozen();
    setOutputFrozen(next);
    btnFreeze.classList.toggle('active', next);
    btnFreeze.textContent = next ? '解冻' : '冻结';
    btnFreeze.classList.toggle('primary', next);
  });

  // 输出窗口加载完成后自动同步画面
  listen('output:ready', () => {
    resyncOutput();
  }).catch(() => {});
}

/** 根据当前模块或输出内容翻页 / 切歌 */
function navigatePages(delta) {
  // 音频页：←/→ 上一曲 / 下一曲
  if (module === 'audio') return audioStep(delta);
  if (module === 'ppt') return pptNavigate(delta);
  if (module === 'pdf') return pdfNavigate(delta);
  if (module === 'program') {
    // 节目单走台：含音乐在内，方向键与 Enter 一样翻条
    const t = programActiveType();
    if (t === 'audio' || t === 'ppt' || t === 'pdf' || t === 'bible' || t === 'blank' || t === 'image' || t === 'video') {
      return programStep(delta);
    }
    const kind = getCurrentOutput().kind;
    if (kind === 'ppt' || kind === 'pdf' || kind === 'bible' || kind === 'blank' || kind === 'image' || kind === 'video') {
      return programStep(delta);
    }
  }
  // 在任意模块，若输出是 PPT/PDF 也允许翻页
  const kind = getCurrentOutput().kind;
  if (kind === 'ppt') return pptNavigate(delta);
  if (kind === 'pdf') return pdfNavigate(delta);
  return false;
}

function initKeyboard() {
  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;

    // 演出节目单：Enter = 下一条；G = 播放当前；Shift+Enter = 上一条
    if (module === 'program') {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) programStep(-1);
        else programStep(1);
        return;
      }
      if (e.key === 'g' || e.key === 'G') {
        e.preventDefault();
        programGo();
        return;
      }
    }

    switch (e.key) {
      case ' ':
        e.preventDefault();
        if (module === 'program') {
          // 当前是音乐则暂停/继续，否则当作下一条
          if (programActiveType() === 'audio') toggleAudio();
          else programStep(1);
        } else if (module === 'audio') {
          toggleAudio();
        } else if (module === 'video') {
          document.getElementById('video-play')?.click();
        } else {
          navigatePages(1);
        }
        break;
      case 'ArrowRight':
      case 'PageDown':
        e.preventDefault();
        if (!navigatePages(1) && module === 'audio') toast('请先导入音频');
        break;
      case 'ArrowLeft':
      case 'PageUp':
        e.preventDefault();
        if (!navigatePages(-1) && module === 'audio') toast('请先导入音频');
        break;
      case 'f':
      case 'F':
        openOutput(true);
        break;
      case 'b':
      case 'B':
        toggleBlack();
        break;
      case 'Escape':
        // 礼拜中易误触：二次确认后再关扩展屏
        e.preventDefault();
        if (window.confirm('确定关闭输出窗口？大屏将停止显示。')) {
          closeOutputFromMain();
        }
        break;
      case 'x':
      case 'X':
        // 节目单里 X 容易误触，仅非节目单时关闭输出
        if (module !== 'program') {
          e.preventDefault();
          closeOutputFromMain();
        }
        break;
    }
  });
}

function boot() {
  window.addEventListener('error', (e) => {
    toast('错误：' + (e.message || e.error), 6000);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    toast('错误：' + (r?.message || r), 6000);
  });

  initTimers();
  setPreviewEl($('preview-stage'));
  initTabs();
  initOutputControls();
  initSettings();
  initKeyboard();
  // 节目单先初始化，确保默认活动存在，供音频列表绑定
  initProgram();
  initAudio();
  initVideo();
  initPpt();
  initPdf();
  initSpl();
  initKaraoke();
  // 默认进入节目单：按一场演出的时间顺序走台
  switchModule('program');
}

// 由 boot.js 在数据恢复后动态加载，此时 DOM 通常已就绪
if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', boot);
else boot();
