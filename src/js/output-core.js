// 输出内容核心：渲染任意输出载荷（主控预览 & 输出窗口共用）

import { renderSlide, makeSlideCanvas } from './slide-render.js';
import { convertFileSrc, fmtTimeLong, invoke } from './util.js';
import { renderBlankInto } from './blank-page.js';
import { renderBibleInto, updateBibleDom } from './bible-page.js';

export const OUTPUT_EVENT = 'output:set';
export const VIDEO_CTRL_EVENT = 'output:video';
/** 输出窗口 → 主控：视频实际播放进度（以观众看到的为准） */
export const VIDEO_TIME_EVENT = 'output:video-time';

let activeVideo = null;
let lobbyTimer = null;

function stopLobbyTimer() {
  if (lobbyTimer) {
    clearInterval(lobbyTimer);
    lobbyTimer = null;
  }
}

export function stopActiveVideo() {
  stopLobbyTimer();
  if (activeVideo) {
    try { activeVideo.pause(); } catch { /* ignore */ }
    activeVideo.removeAttribute('src');
    try { activeVideo.load(); } catch { /* ignore */ }
    activeVideo.remove();
    activeVideo = null;
  }
}

function setKind(stage, kind) {
  stage.dataset.outKind = kind || 'clear';
}

/** 空白页：同类型就地改文案/背景，避免整树闪烁 */
function updateBlankInPlace(stage, payload) {
  const wrap = stage.querySelector('.out-blank');
  if (!wrap) return false;
  const wantLyric = payload.blankKind === 'lyric';
  if (wantLyric !== wrap.classList.contains('is-lyric')) return false;

  wrap.classList.toggle('is-light', !!payload.light);
  wrap.classList.toggle('has-bgimg', !!payload.bgImage);
  wrap.style.setProperty('--blank-accent', payload.accent || '#e8c56a');

  if (payload.bgImage) {
    const src = String(payload.bgImage).replace(/\\/g, '/').replace(/"/g, '%22');
    wrap.style.backgroundImage = `linear-gradient(rgba(6,6,10,.62), rgba(6,6,10,.78)), url("${src}")`;
    wrap.style.backgroundSize = 'cover';
    wrap.style.backgroundPosition = 'center';
    wrap.style.background = '';
  } else {
    wrap.style.backgroundImage = '';
    wrap.style.background = payload.bg || '';
  }

  if (wantLyric) {
    const head = wrap.querySelector('.out-blank-lyric-head');
    const body = wrap.querySelector('.out-blank-body');
    if (!head || !body) return false;
    if (payload.title) {
      head.textContent = payload.subtitle ? `${payload.title}  ·  ${payload.subtitle}` : payload.title;
      head.classList.remove('is-empty');
    } else {
      head.textContent = '';
      head.classList.add('is-empty');
    }
    body.textContent = payload.body || '';
  } else {
    const title = wrap.querySelector('.out-blank-title');
    const sub = wrap.querySelector('.out-blank-sub');
    if (!title || !sub) return false;
    title.textContent = payload.title || '歌曲名称';
    sub.textContent = payload.subtitle || '';
    sub.classList.toggle('is-empty', !payload.subtitle);
  }
  return true;
}

function updateLobbyInPlace(stage, payload) {
  const wrap = stage.querySelector('.out-lobby');
  if (!wrap) return false;
  const prevAt = Number(wrap.dataset.startAt) || 0;
  const startAt = Number(payload.startAt) || 0;

  if (payload.accent) wrap.style.setProperty('--lobby-accent', payload.accent);
  if (payload.bgImage) {
    wrap.classList.add('has-bgimg');
    const src = String(payload.bgImage).replace(/\\/g, '/').replace(/"/g, '%22');
    wrap.style.backgroundImage = `linear-gradient(rgba(8,8,12,.55), rgba(8,8,12,.72)), url("${src}")`;
    wrap.style.backgroundSize = 'cover';
    wrap.style.backgroundPosition = 'center';
    wrap.style.backgroundRepeat = 'no-repeat';
  } else if (payload.bg) {
    wrap.classList.remove('has-bgimg');
    wrap.style.backgroundImage = '';
    wrap.style.background = payload.bg;
  }

  const kicker = wrap.querySelector('.out-lobby-kicker');
  const title = wrap.querySelector('.out-lobby-title');
  const sub = wrap.querySelector('.out-lobby-sub');
  const note = wrap.querySelector('.out-lobby-note');
  const startLabel = wrap.querySelector('.out-lobby-startat');
  if (kicker) kicker.textContent = payload.kicker || '';
  if (title) title.textContent = payload.title || '';
  if (sub) sub.textContent = payload.subtitle || '';
  if (note) note.textContent = payload.note || '';
  if (startLabel) startLabel.textContent = payload.startLabel || '';

  wrap.dataset.startedText = payload.startedText || '演出开始';
  wrap.dataset.countingText = payload.countingText || '距离开始还有';
  wrap.dataset.startAt = String(startAt);

  // startAt 未变则复用已有 timer，避免反复拆建
  if (prevAt === startAt && lobbyTimer) return true;

  stopLobbyTimer();
  const digits = wrap.querySelector('.out-lobby-digits');
  const status = wrap.querySelector('.out-lobby-status');
  if (!digits || !status) return false;
  const tick = () => {
    const at = Number(wrap.dataset.startAt) || 0;
    const remain = at ? Math.max(0, Math.floor((at - Date.now()) / 1000)) : 0;
    digits.textContent = fmtTimeLong(remain);
    const started = !at || remain <= 0;
    wrap.classList.toggle('is-urgent', !started && remain <= 60);
    wrap.classList.toggle('is-started', started);
    status.textContent = started
      ? (wrap.dataset.startedText || '演出开始')
      : (wrap.dataset.countingText || '距离开始还有');
  };
  tick();
  lobbyTimer = setInterval(tick, 250);
  return true;
}

function updateAudioInPlace(stage, payload) {
  const isLyrics = payload.mode === 'lyrics' && Array.isArray(payload.lines) && payload.lines.length;
  const lyricsWrap = stage.querySelector('.out-lyrics');
  const cardWrap = stage.querySelector('.out-audio-card');

  if (isLyrics) {
    if (!lyricsWrap) return false;
    const title = lyricsWrap.querySelector('.out-lyrics-song');
    if (title) title.textContent = payload.title || '';
    applyLyricsActive(lyricsWrap, payload);
    return true;
  }

  if (!cardWrap || lyricsWrap) return false;
  const title = cardWrap.querySelector('.out-audio-title');
  const sub = cardWrap.querySelector('.out-audio-sub');
  if (title) title.textContent = payload.title || '';
  if (sub) sub.textContent = payload.sub || '';
  return true;
}

function applyLyricsActive(wrap, payload) {
  const lines = payload.lines || [];
  const active = Math.max(0, Math.min(lines.length - 1, payload.active | 0));
  const track = wrap.querySelector('.out-lyrics-track');
  if (!track) return;
  // 行数变化时重建
  const kids = track.children;
  if (kids.length !== lines.length) {
    track.innerHTML = lines
      .map((l, i) => `<div class="out-lyrics-line${i === active ? ' is-active' : ''}" data-i="${i}"></div>`)
      .join('');
    [...track.children].forEach((el, i) => {
      el.textContent = lines[i]?.text || '';
    });
  } else {
    for (let i = 0; i < kids.length; i++) {
      kids[i].classList.toggle('is-active', i === active);
      if (kids[i].textContent !== (lines[i]?.text || '')) {
        kids[i].textContent = lines[i]?.text || '';
      }
    }
  }
  const lineH = kids[0]?.offsetHeight || 64;
  const view = wrap.querySelector('.out-lyrics-viewport');
  const viewH = view?.clientHeight || 400;
  const offset = viewH / 2 - lineH / 2 - active * lineH;
  track.style.transform = `translateY(${offset}px)`;
  wrap.dataset.active = String(active);
}

/**
 * 把载荷渲染到 stage 容器
 * opts.muted：预览窗格静音
 */
export function renderOutput(stage, payload, opts = {}) {
  if (!stage) return;
  const kind = payload?.kind || 'clear';
  const prev = stage.dataset.outKind || '';

  // 同类型差分：减少闪烁与主线程压力（礼拜连翻关键）
  if (kind === 'blank' && prev === 'blank' && updateBlankInPlace(stage, payload)) {
    stage.classList.add('out-stage', 'is-blank');
    stage.classList.remove('is-black', 'is-idle', 'is-lobby', 'is-bible');
    setKind(stage, 'blank');
    return;
  }
  if (kind === 'bible' && prev === 'bible') {
    const wrap = stage.querySelector('.out-bible');
    if (wrap && updateBibleDom(wrap, payload)) {
      stage.classList.add('out-stage', 'is-bible');
      stage.classList.remove('is-black', 'is-idle', 'is-lobby', 'is-blank');
      setKind(stage, 'bible');
      return;
    }
  }
  if (kind === 'ppt' && prev === 'ppt') {
    const canvas = stage.querySelector('.slide-canvas');
    if (canvas) {
      stopLobbyTimer();
      renderSlide(canvas, payload.slide || {});
      stage.classList.add('out-stage');
      stage.classList.remove('is-black', 'is-idle', 'is-lobby', 'is-blank');
      setKind(stage, 'ppt');
      return;
    }
  }
  if ((kind === 'pdf' || kind === 'image') && (prev === 'pdf' || prev === 'image')) {
    const img = stage.querySelector('img.out-fit');
    if (img) {
      stopLobbyTimer();
      const next = payload.dataUrl || payload.src || '';
      if (img.src !== next) img.src = next;
      stage.classList.add('out-stage');
      stage.classList.remove('is-black', 'is-idle', 'is-lobby', 'is-blank');
      setKind(stage, kind);
      return;
    }
  }
  if (kind === 'lobby' && prev === 'lobby' && updateLobbyInPlace(stage, payload)) {
    stage.classList.add('out-stage', 'is-lobby');
    stage.classList.remove('is-black', 'is-idle', 'is-blank');
    setKind(stage, 'lobby');
    return;
  }
  if (kind === 'audio' && prev === 'audio' && updateAudioInPlace(stage, payload)) {
    stage.classList.add('out-stage');
    stage.classList.remove('is-black', 'is-idle', 'is-lobby', 'is-blank');
    setKind(stage, 'audio');
    return;
  }

  // 全量重建
  stopActiveVideo();
  stage.innerHTML = '';
  stage.classList.add('out-stage');
  stage.classList.remove('is-black', 'is-idle', 'is-lobby', 'is-blank', 'is-bible');

  if (kind === 'black') {
    stage.classList.add('is-black');
    setKind(stage, 'black');
    return;
  }

  if (kind === 'blank') {
    stage.classList.add('is-blank');
    renderBlankInto(stage, payload);
    setKind(stage, 'blank');
    return;
  }

  if (kind === 'bible') {
    stage.classList.add('is-bible');
    renderBibleInto(stage, payload);
    setKind(stage, 'bible');
    return;
  }

  if (kind === 'lobby') {
    stage.classList.add('is-lobby');
    const wrap = document.createElement('div');
    wrap.className = 'out-lobby';
    if (payload.accent) wrap.style.setProperty('--lobby-accent', payload.accent);
    if (payload.bgImage) {
      wrap.classList.add('has-bgimg');
      const src = String(payload.bgImage).replace(/\\/g, '/').replace(/"/g, '%22');
      wrap.style.backgroundImage = `linear-gradient(rgba(8,8,12,.55), rgba(8,8,12,.72)), url("${src}")`;
      wrap.style.backgroundSize = 'cover';
      wrap.style.backgroundPosition = 'center';
      wrap.style.backgroundRepeat = 'no-repeat';
    } else if (payload.bg) {
      wrap.style.background = payload.bg;
    }
    wrap.innerHTML = `
      <div class="out-lobby-kicker"></div>
      <div class="out-lobby-title"></div>
      <div class="out-lobby-sub"></div>
      <div class="out-lobby-clock">
        <div class="out-lobby-status"></div>
        <div class="out-lobby-digits">00:00:00</div>
      </div>
      <div class="out-lobby-note"></div>
      <div class="out-lobby-startat"></div>`;
    wrap.querySelector('.out-lobby-kicker').textContent = payload.kicker || '';
    wrap.querySelector('.out-lobby-title').textContent = payload.title || '';
    wrap.querySelector('.out-lobby-sub').textContent = payload.subtitle || '';
    wrap.querySelector('.out-lobby-note').textContent = payload.note || '';
    wrap.querySelector('.out-lobby-startat').textContent = payload.startLabel || '';
    const digits = wrap.querySelector('.out-lobby-digits');
    const status = wrap.querySelector('.out-lobby-status');
    const startAt = Number(payload.startAt) || 0;
    wrap.dataset.startAt = String(startAt);
    wrap.dataset.startedText = payload.startedText || '演出开始';
    wrap.dataset.countingText = payload.countingText || '距离开始还有';
    const tick = () => {
      const at = Number(wrap.dataset.startAt) || 0;
      const remain = at ? Math.max(0, Math.floor((at - Date.now()) / 1000)) : 0;
      digits.textContent = fmtTimeLong(remain);
      const started = !at || remain <= 0;
      wrap.classList.toggle('is-urgent', !started && remain <= 60);
      wrap.classList.toggle('is-started', started);
      status.textContent = started
        ? (wrap.dataset.startedText || '演出开始')
        : (wrap.dataset.countingText || '距离开始还有');
    };
    tick();
    lobbyTimer = setInterval(tick, 250);
    stage.appendChild(wrap);
    setKind(stage, 'lobby');
    return;
  }

  if (kind === 'ppt') {
    const canvas = makeSlideCanvas();
    stage.appendChild(canvas);
    renderSlide(canvas, payload.slide || {});
    setKind(stage, 'ppt');
    return;
  }

  if (kind === 'pdf' || kind === 'image') {
    const img = document.createElement('img');
    img.className = 'out-fit';
    img.src = payload.dataUrl || payload.src || '';
    img.draggable = false;
    stage.appendChild(img);
    setKind(stage, kind);
    return;
  }

  if (kind === 'video' && opts.videoPoster) {
    // 主控预览不再自己解码一份视频：显示缩略图 + 输出窗口回报的进度
    const ph = document.createElement('div');
    ph.className = 'out-video-poster';
    const img = document.createElement('img');
    img.className = 'out-fit';
    img.draggable = false;
    const badge = document.createElement('span');
    badge.className = 'out-video-time';
    badge.textContent = '▶ 输出中';
    ph.append(img, badge);
    stage.appendChild(ph);
    setKind(stage, 'video');
    invoke('make_video_thumb', { path: payload.path })
      .then((url) => { if (url) img.src = url; })
      .catch(() => {});
    return;
  }

  if (kind === 'video') {
    const v = document.createElement('video');
    v.className = 'out-fit';
    v.src = convertFileSrc(payload.path);
    v.autoplay = payload.autoplay !== false;
    v.muted = !!opts.muted;
    v.playsInline = true;
    if (typeof payload.volume === 'number') v.volume = payload.volume;
    if (payload.startAt > 0) {
      v.addEventListener('loadedmetadata', () => {
        try { v.currentTime = payload.startAt; } catch { /* ignore */ }
      }, { once: true });
    }
    v.addEventListener('loadeddata', () => {
      if (payload.autoplay !== false) v.play().catch(() => {});
    });
    stage.appendChild(v);
    activeVideo = v;
    setKind(stage, 'video');
    return;
  }

  if (kind === 'audio') {
    const isLyrics = payload.mode === 'lyrics' && Array.isArray(payload.lines) && payload.lines.length;
    if (isLyrics) {
      const wrap = document.createElement('div');
      wrap.className = 'out-lyrics';
      wrap.innerHTML = `
        <div class="out-lyrics-song"></div>
        <div class="out-lyrics-viewport">
          <div class="out-lyrics-track"></div>
        </div>
        <div class="out-lyrics-hint">${payload.timed === false ? '无时间轴 · 按进度滚动' : '滚动歌词'}</div>`;
      wrap.querySelector('.out-lyrics-song').textContent = payload.title || '';
      stage.appendChild(wrap);
      // 下一帧再算高度，保证 viewport 已布局
      requestAnimationFrame(() => applyLyricsActive(wrap, payload));
      setKind(stage, 'audio');
      return;
    }
    const wrap = document.createElement('div');
    wrap.className = 'out-audio-card';
    wrap.innerHTML = `
      <div class="out-audio-icon">♪</div>
      <div class="out-audio-title"></div>
      <div class="out-audio-sub"></div>`;
    wrap.querySelector('.out-audio-title').textContent = payload.title || '';
    wrap.querySelector('.out-audio-sub').textContent = payload.sub || '';
    stage.appendChild(wrap);
    setKind(stage, 'audio');
    return;
  }

  // clear / 待机
  stage.classList.add('is-idle');
  const idle = document.createElement('div');
  idle.className = 'out-idle';
  idle.textContent = 'StagePlayer 演出播放器';
  stage.appendChild(idle);
  setKind(stage, 'clear');
}

/** 应用画面适配模式 */
export function applyFitMode(stage, mode) {
  if (!stage) return;
  stage.classList.remove('fit-contain', 'fit-stretch', 'fit-cover');
  stage.classList.add('fit-' + (mode || 'contain'));
}

/** 输出端视频控制 */
/** 更新主控预览上的视频进度角标（rep 来自 VIDEO_TIME_EVENT） */
export function paintVideoTime(stage, rep) {
  const badge = stage?.querySelector('.out-video-time');
  if (!badge || !rep) return;
  const state = rep.ended ? '■ 已播完' : rep.paused ? '⏸ 已暂停' : '▶ 输出中';
  badge.textContent = `${state} ${fmtTimeLong(rep.t)} / ${fmtTimeLong(rep.d)}`;
}

/** 输出窗口：把当前视频的实际进度回报给主控（timeupdate 约 4 次/秒） */
export function reportVideoTime(stage, path, send) {
  const v = stage?.querySelector('video');
  if (!v) return;
  const report = () => send({
    path,
    t: v.currentTime || 0,
    d: Number.isFinite(v.duration) ? v.duration : 0,
    paused: v.paused,
    ended: v.ended,
  });
  for (const ev of ['loadedmetadata', 'timeupdate', 'play', 'pause', 'ended', 'seeked']) {
    v.addEventListener(ev, report);
  }
}

export function controlVideo(action, value) {
  if (!activeVideo && action !== 'stop') return;
  switch (action) {
    case 'play':
      activeVideo?.play().catch(() => {});
      break;
    case 'pause':
      activeVideo?.pause();
      break;
    case 'seek':
      if (activeVideo && typeof value === 'number' && isFinite(value)) {
        try { activeVideo.currentTime = value; } catch { /* ignore */ }
      }
      break;
    case 'volume':
      if (activeVideo && typeof value === 'number') activeVideo.volume = value;
      break;
    case 'stop':
      stopActiveVideo();
      break;
  }
}
