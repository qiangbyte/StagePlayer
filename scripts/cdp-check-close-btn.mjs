import http from 'http';
import WebSocket from 'ws';

const pages = await new Promise((res, rej) =>
  http.get('http://127.0.0.1:9223/json', (r) => {
    let d = '';
    r.on('data', (c) => (d += c));
    r.on('end', () => res(JSON.parse(d)));
  }).on('error', rej)
);
console.log('pages:', pages.map((p) => p.title).join(' | '));
const page = pages.find((p) => p.title.includes('StagePlayer'));
if (!page) process.exit(1);

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
        reject(new Error('timeout'));
      }
    }, 10000);
  });

const r = await send('Runtime.evaluate', {
  expression: `({
    closeBtn: !!document.getElementById('btn-close-output'),
    closeText: document.getElementById('btn-close-output')?.textContent || null,
    buttons: Array.from(document.querySelectorAll('.output-controls button')).map(b => b.id + ':' + b.textContent.trim() + ':' + getComputedStyle(b).display)
  })`,
  returnByValue: true,
});
console.log(JSON.stringify(r.result?.value ?? r, null, 2));
ws.close();
