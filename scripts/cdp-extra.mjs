import WebSocket from 'ws';
import http from 'http';
import fs from 'fs';

const getJson = (url) =>
  new Promise((res, rej) =>
    http.get(url, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej)
  );

const pages = await getJson('http://127.0.0.1:9223/json');
console.log('pages:');
pages.forEach((p) => console.log(' -', p.title, '|', p.url));

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
    setTimeout(() => {
      if (pending.has(i)) {
        pending.delete(i);
        reject(new Error('timeout ' + method));
      }
    }, 20000);
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

const freeze = await ev(
  `(async()=>{ document.getElementById('btn-freeze').click(); return document.getElementById('btn-freeze').textContent; })()`,
  true
);
console.log('freeze:', freeze);

const unfreeze = await ev(
  `(async()=>{ document.getElementById('btn-freeze').click(); return document.getElementById('btn-freeze').textContent; })()`,
  true
);
console.log('unfreeze:', unfreeze);

const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.mkdirSync('.tmp-test', { recursive: true });
fs.writeFileSync('.tmp-test/ui-main.png', Buffer.from(shot.data, 'base64'));
console.log('screenshot bytes', Buffer.from(shot.data, 'base64').length);

const pages2 = await getJson('http://127.0.0.1:9223/json');
console.log('pages after:', pages2.map((p) => p.title).join(', '));
const out = pages2.find((p) => p.title.includes('输出'));
console.log('output window:', out ? 'FOUND' : 'NOT FOUND');

ws.close();
