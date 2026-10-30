// 计时器模块：正计时（秒表）+ 倒计时

import { fmtTimeLong, toast } from './util.js';

export function initTimers() {
  // ---------- 正计时 ----------
  const swEl = document.getElementById('sw-display');
  const swStart = document.getElementById('sw-start');
  const swReset = document.getElementById('sw-reset');
  let swRunning = false;
  let swBase = 0;       // 累计毫秒
  let swT0 = 0;         // 本次起点
  let swTimer = null;

  const swRender = () => { swEl.textContent = fmtTimeLong(swBase / 1000); };

  function swToggle() {
    if (swRunning) {
      swBase += performance.now() - swT0;
      clearInterval(swTimer);
      swRunning = false;
      swStart.textContent = '开始';
      swStart.classList.remove('active');
    } else {
      swT0 = performance.now();
      swTimer = setInterval(() => {
        swEl.textContent = fmtTimeLong((swBase + performance.now() - swT0) / 1000);
      }, 100);
      swRunning = true;
      swStart.textContent = '暂停';
      swStart.classList.add('active');
    }
  }

  swStart.addEventListener('click', swToggle);
  swReset.addEventListener('click', () => {
    clearInterval(swTimer);
    swRunning = false;
    swBase = 0;
    swStart.textContent = '开始';
    swStart.classList.remove('active');
    swRender();
  });
  swRender();

  // ---------- 倒计时 ----------
  const cdEl = document.getElementById('cd-display');
  const cdMin = document.getElementById('cd-minutes');
  const cdStart = document.getElementById('cd-start');
  const cdReset = document.getElementById('cd-reset');
  let cdRunning = false;
  let cdRemain = 0;     // 秒
  let cdTimer = null;

  const cdRender = () => {
    cdEl.textContent = fmtTimeLong(cdRemain);
    cdEl.classList.toggle('danger', cdRunning && cdRemain <= 60);
    cdEl.classList.toggle('stopped', cdRemain === 0);
  };

  function cdStop(run) {
    cdRunning = run;
    if (!run) {
      clearInterval(cdTimer);
      cdStart.textContent = '开始';
      cdStart.classList.remove('active');
    } else {
      cdStart.textContent = '暂停';
      cdStart.classList.add('active');
    }
  }

  cdStart.addEventListener('click', () => {
    if (cdRunning) { cdStop(false); return; }
    if (cdRemain <= 0) {
      cdRemain = Math.max(0, parseInt(cdMin.value || '0', 10) * 60);
    }
    if (cdRemain <= 0) return;
    cdStop(true);
    cdTimer = setInterval(() => {
      cdRemain = Math.max(0, cdRemain - 1);
      cdRender();
      if (cdRemain === 0) {
        cdStop(false);
        toast('⏰ 倒计时时间到！', 6000);
      }
    }, 1000);
  });

  cdReset.addEventListener('click', () => {
    cdStop(false);
    cdRemain = Math.max(0, parseInt(cdMin.value || '0', 10) * 60);
    cdRender();
  });

  cdMin.addEventListener('change', () => {
    if (!cdRunning) {
      cdRemain = Math.max(0, parseInt(cdMin.value || '0', 10) * 60);
      cdRender();
    }
  });

  cdRemain = Math.max(0, parseInt(cdMin.value || '0', 10) * 60);
  cdRender();
}
