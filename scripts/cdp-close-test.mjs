import WebSocket from 'ws';
import http from 'http';

const getJson = (url) =>
  new Promise((res, rej) =>
    http.get(url, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej)
  );

async function connect(pred) {
  const pages = await getJson('http://127.0.0.1:9223/json');
  const page = pages.find(pred);
  if (!page) throw new Error('page not found, have: ' + pages.map((p) => p.title).join(','));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.on('open', r);
    ws.on('error', j);
  });
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
      setTimeout(() => {
        if (pending.has(i)) {
          pending.delete(i);
          reject(new Error('timeout ' + method));
        }
      }, 15000);
    });
  const ev = async (expression, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result?.value;
  };
  return { ws, ev, pages };
}

// wait for main
let main;
for (let i = 0; i < 20; i++) {
  try {
    main = await connect((p) => p.title.includes('StagePlayer'));
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 400));
  }
}
if (!main) throw new Error('no main');

const monitors = await main.ev(`window.__TAURI__.core.invoke('list_monitors')`, true);
const ext = monitors.find((m) => !m.is_primary) || monitors[0];
console.log('open on monitor', ext.index);

await main.ev(
  `(async()=>{
    await window.__TAURI__.core.invoke('open_output_window', { monitorIndex: ${ext.index} });
    await new Promise(r=>setTimeout(r,200));
    await window.__TAURI__.core.invoke('place_output_on_monitor', { index: ${ext.index}, fullscreen: true });
    return true;
  })()`,
  true
);

await new Promise((r) => setTimeout(r, 600));
let pages = await getJson('http://127.0.0.1:9223/json');
console.log('before close pages:', pages.map((p) => p.title).join(' | '));
const hasOut = pages.some((p) => p.title.includes('输出'));
console.log('output exists:', hasOut);

// click close via output page
const out = await connect((p) => p.title.includes('输出'));
const result = await out.ev(
  `(async()=>{
    const btn = document.getElementById('oc-close');
    if (!btn) return { err: 'no btn' };
    // 模拟点击关闭逻辑
    btn.click();
    await new Promise(r=>setTimeout(r,800));
    return { clicked: true };
  })()`,
  true
);
console.log('click result:', result);
try { out.ws.close(); } catch { /* ignore */ }

await new Promise((r) => setTimeout(r, 500));
pages = await getJson('http://127.0.0.1:9223/json');
console.log('after close pages:', pages.map((p) => p.title).join(' | '));
const stillOut = pages.some((p) => p.title.includes('输出'));
console.log(stillOut ? 'FAIL: output still open' : 'PASS: output closed');

main.ws.close();
process.exit(stillOut ? 1 : 0);
