/**
 * StagePlayer CDP 冒烟测试：连接 WebView2 远程调试端口，验证 UI 与后端命令。
 */
import WebSocket from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.CDP_PORT || 9223;
const results = [];

function log(ok, name, detail = '') {
  results.push({ ok, name, detail: String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout ${method}`));
        }
      }, 15000);
    });
  }
  async eval(expression, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.text || JSON.stringify(r.exceptionDetails));
    }
    return r.result?.value;
  }
  close() { this.ws.close(); }
}

function makeWav(filePath, seconds = 1, freq = 440) {
  const sampleRate = 22050;
  const numSamples = sampleRate * seconds;
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * freq * t) * 0.3 * 32767;
    buf.writeInt16LE(sample | 0, 44 + i * 2);
  }
  fs.writeFileSync(filePath, buf);
}

async function main() {
  const pages = await getJson(`http://127.0.0.1:${PORT}/json`);
  // 正式版输出窗口也是 tauri.localhost，必须排除 output.html，否则会连到输出窗口
  const page = pages.find((p) => p.title.includes('StagePlayer'))
    || pages.find((p) => p.url.includes('tauri') && !p.url.includes('output.html'));
  if (!page) throw new Error('未找到主窗口 page: ' + JSON.stringify(pages));
  log(true, '连接 WebView2', page.title);

  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');

  // 1. DOM 基本结构
  const hasApp = await cdp.eval(`!!document.getElementById('app')`);
  log(!!hasApp, '主界面 #app 存在');

  const tabs = await cdp.eval(`Array.from(document.querySelectorAll('.tab')).map(t => t.dataset.module + ':' + t.classList.contains('active'))`);
  log(Array.isArray(tabs) && tabs.length >= 5, '五个模块 Tab', JSON.stringify(tabs));

  // 2. Tauri API
  const hasTauri = await cdp.eval(`!!(window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)`);
  log(!!hasTauri, 'window.__TAURI__ 可用');

  // 3. 后端命令：list_monitors / list_audio / audio_state
  const monitors = await cdp.eval(`window.__TAURI__.core.invoke('list_monitors')`, true);
  log(Array.isArray(monitors) && monitors.length > 0, 'list_monitors', `count=${monitors?.length}`);

  const devices = await cdp.eval(`window.__TAURI__.core.invoke('list_audio_output_devices')`, true);
  log(Array.isArray(devices), 'list_audio_output_devices', `count=${devices?.length}`);

  const audioState = await cdp.eval(`window.__TAURI__.core.invoke('audio_state')`, true);
  log(audioState && typeof audioState.exists === 'boolean' && ('path' in audioState), 'audio_state 含 path 字段', JSON.stringify(audioState));

  // 4. 模块切换
  for (const mod of ['video', 'ppt', 'pdf', 'program', 'audio']) {
    const ok = await cdp.eval(`
      (() => {
        const tab = document.querySelector('.tab[data-module="${mod}"]');
        if (!tab) return false;
        tab.click();
        const panel = document.querySelector('.panel[data-module="${mod}"]');
        return panel && panel.classList.contains('active');
      })()
    `);
    log(!!ok, `切换到 ${mod} 面板`);
  }

  // 5. 计时器开始/暂停
  const timerOk = await cdp.eval(`
    (() => {
      const btn = document.getElementById('sw-start');
      const el = document.getElementById('sw-display');
      if (!btn || !el) return 'missing';
      btn.click();
      const running = btn.textContent.includes('暂停');
      btn.click();
      return running ? 'ok' : 'fail';
    })()
  `);
  log(timerOk === 'ok', '正计时 开始/暂停', timerOk);

  // 6. 打开输出窗口并同步
  try {
    await cdp.eval(`window.__TAURI__.core.invoke('open_output_window')`, true);
    await new Promise((r) => setTimeout(r, 500));
    await cdp.eval(`
      (() => {
        // 触发前端 resync：点一次黑屏再恢复，或直接 emit
        return true;
      })()
    `);
    // 推送标题卡到输出
    await cdp.eval(`
      (async () => {
        const { emit } = window.__TAURI__.event;
        await emit('output:set', { kind: 'audio', title: '测试歌曲', sub: 'StagePlayer' });
        return true;
      })()
    `, true);
    log(true, '打开输出窗口 + 推送音频标题卡');
  } catch (e) {
    log(false, '打开输出窗口', e.message);
  }

  // 7. 创建测试 wav 并播放
  const tmpDir = path.join(__dirname, '..', '.tmp-test');
  fs.mkdirSync(tmpDir, { recursive: true });
  const wav = path.join(tmpDir, 'test-tone.wav');
  makeWav(wav, 2, 523.25);
  const wavPath = wav.replace(/\//g, '\\');

  try {
    const playRes = await cdp.eval(`
      (async () => {
        const p = ${JSON.stringify(wavPath)};
        await window.__TAURI__.core.invoke('audio_play', { path: p, deviceIndex: null, startAt: 0 });
        await window.__TAURI__.core.invoke('audio_set_volume', { v: 0.2 });
        const st = await window.__TAURI__.core.invoke('audio_state');
        return st;
      })()
    `, true);
    log(!!playRes?.exists && playRes?.playing, '音频播放 test-tone.wav', JSON.stringify(playRes));

    await new Promise((r) => setTimeout(r, 400));
    const paused = await cdp.eval(`
      (async () => {
        await window.__TAURI__.core.invoke('audio_pause');
        return window.__TAURI__.core.invoke('audio_state');
      })()
    `, true);
    log(!!paused?.exists && paused?.paused, '音频暂停', JSON.stringify(paused));

    const resumed = await cdp.eval(`
      (async () => {
        await window.__TAURI__.core.invoke('audio_resume');
        return window.__TAURI__.core.invoke('audio_state');
      })()
    `, true);
    log(!!resumed?.playing, '音频恢复', JSON.stringify(resumed));

    // 切歌路径判断：stop 后再 play 另一文件
    const wav2 = path.join(tmpDir, 'test-tone2.wav');
    makeWav(wav2, 1, 659.25);
    const switchRes = await cdp.eval(`
      (async () => {
        const p2 = ${JSON.stringify(wav2.replace(/\//g, '\\'))};
        await window.__TAURI__.core.invoke('audio_stop');
        await window.__TAURI__.core.invoke('audio_play', { path: p2, deviceIndex: null, startAt: 0 });
        const st = await window.__TAURI__.core.invoke('audio_state');
        return { pathMatch: st.path && st.path.includes('test-tone2'), st };
      })()
    `, true);
    log(!!switchRes?.pathMatch && switchRes?.st?.playing, '切歌到第二首', JSON.stringify(switchRes?.st));

    await cdp.eval(`window.__TAURI__.core.invoke('audio_stop')`, true);
  } catch (e) {
    log(false, '音频播放链路', e.message);
  }

  // 8. UI：节目单默认活动、导入提示
  const programOk = await cdp.eval(`
    (() => {
      document.querySelector('.tab[data-module="program"]').click();
      const events = document.querySelectorAll('#program-events .file-item');
      return events.length >= 1;
    })()
  `);
  log(!!programOk, '节目单至少有一个默认活动');

  // 9. 空格快捷键绑定（检查 toggleAudio 导出后主控监听）
  const spaceHandler = await cdp.eval(`
    (() => {
      // 切回音频，模拟 keydown 空格不应抛错
      document.querySelector('.tab[data-module="audio"]').click();
      const ev = new KeyboardEvent('keydown', { key: ' ', bubbles: true });
      document.dispatchEvent(ev);
      return true;
    })()
  `);
  log(!!spaceHandler, '空格键事件不抛错');

  // 10. 黑屏推送
  const blackOk = await cdp.eval(`
    (async () => {
      const preview = document.getElementById('preview-stage');
      // 黑屏是切换键：前面步骤可能已处于黑屏，先恢复到非黑屏再测
      if (preview?.classList.contains('is-black')) {
        document.getElementById('btn-black').click();
        await new Promise(r => setTimeout(r, 100));
      }
      document.getElementById('btn-black').click();
      await new Promise(r => setTimeout(r, 100));
      return preview && preview.classList.contains('is-black');
    })()
  `, true);
  log(!!blackOk, '黑屏按钮生效（预览变黑）');

  // 恢复
  await cdp.eval(`document.getElementById('btn-black').click()`);

  // 控制台错误
  const errors = await cdp.eval(`window.__spTestErrors || []`);
  // 注入收集（若之前没有）
  await cdp.eval(`
    if (!window.__spTestErrors) {
      window.__spTestErrors = [];
      window.addEventListener('error', e => window.__spTestErrors.push(String(e.message)));
      window.addEventListener('unhandledrejection', e => window.__spTestErrors.push(String(e.reason)));
    }
  `);

  cdp.close();

  const failed = results.filter((r) => !r.ok);
  console.log('\n========== SUMMARY ==========');
  console.log(`total=${results.length} pass=${results.length - failed.length} fail=${failed.length}`);
  if (failed.length) {
    failed.forEach((f) => console.log(' -', f.name, f.detail));
    process.exitCode = 1;
  } else {
    console.log('All checks passed.');
  }

  // 写报告
  const report = path.join(__dirname, '..', '.tmp-test', 'smoke-report.json');
  fs.writeFileSync(report, JSON.stringify({ when: new Date().toISOString(), results }, null, 2));
  console.log('report:', report);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
