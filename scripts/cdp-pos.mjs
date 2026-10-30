import WebSocket from 'ws';
import http from 'http';

const pages = await new Promise((res, rej) =>
  http.get('http://127.0.0.1:9223/json', (r) => {
    let d = '';
    r.on('data', (c) => (d += c));
    r.on('end', () => res(JSON.parse(d)));
  }).on('error', rej)
);
const page = pages.find((p) => p.title.includes('StagePlayer'));
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
  });
const r = await send('Runtime.evaluate', {
  expression: `(async()=>{
    const w = await window.__TAURI__.window.WebviewWindow.getByLabel('output');
    if(!w) return {err:'no window'};
    const o = await w.outerPosition();
    const s = await w.outerSize();
    const fs = await w.isFullscreen();
    return {x:o.x, y:o.y, w:s.width, h:s.height, fs};
  })()`,
  awaitPromise: true,
  returnByValue: true,
});
console.log(JSON.stringify(r.result?.value ?? r, null, 2));
ws.close();
