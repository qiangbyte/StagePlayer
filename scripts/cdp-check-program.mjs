import http from 'http';
import WebSocket from 'ws';

const pages = await new Promise((res, rej) =>
  http.get('http://127.0.0.1:9223/json', (r) => {
    let d = '';
    r.on('data', (c) => (d += c));
    r.on('end', () => res(JSON.parse(d)));
  }).on('error', rej)
);
const page = pages.find((p) => p.title.includes('StagePlayer'));
if (!page) {
  console.log('no page', pages.map((p) => p.title));
  process.exit(1);
}
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
  expression: `({
    tab: document.querySelector('.tab.active')?.dataset.module,
    hasMixed: !!document.getElementById('pg-add-mixed'),
    hasNext: !!document.getElementById('pg-next'),
    hasNow: !!document.getElementById('pg-now'),
    close: document.getElementById('btn-close-output')?.textContent,
    err: window.__lastErr || null
  })`,
  returnByValue: true,
});
console.log(JSON.stringify(r.result?.value ?? r, null, 2));
ws.close();
