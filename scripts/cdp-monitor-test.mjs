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

async function connect(titleIncludes) {
  const pages = await getJson('http://127.0.0.1:9223/json');
  console.log('pages:', pages.map((p) => p.title).join(' | '));
  const page = pages.find((p) => p.title.includes(titleIncludes));
  if (!page) throw new Error('page not found: ' + titleIncludes);
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
  return { ws, ev, pages };
}

// 等主窗口出现
let main;
for (let i = 0; i < 15; i++) {
  try {
    main = await connect('StagePlayer');
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}
if (!main) throw new Error('主窗口未出现');

const monitors = await main.ev(`window.__TAURI__.core.invoke('list_monitors')`, true);
console.log('monitors:', JSON.stringify(monitors, null, 2));

const ext = monitors.find((m) => !m.is_primary) || monitors[0];
console.log('target:', ext.index, ext.is_primary ? 'primary' : 'extended', `${ext.width}x${ext.height}`, `@${ext.x},${ext.y}`);

const placed = await main.ev(
  `(async () => {
    const idx = ${ext.index};
    await window.__TAURI__.core.invoke('open_output_window', { monitorIndex: idx });
    await new Promise(r => setTimeout(r, 200));
    const info = await window.__TAURI__.core.invoke('place_output_on_monitor', { index: idx, fullscreen: true });
    await window.__TAURI__.event.emit('output:set', { kind: 'audio', title: '扩展屏测试', sub: 'Monitor ' + idx });
    return info;
  })()`,
  true
);
console.log('placed:', JSON.stringify(placed));

await new Promise((r) => setTimeout(r, 800));
const pages2 = await getJson('http://127.0.0.1:9223/json');
console.log('pages after:', pages2.map((p) => p.title).join(' | '));

// 查输出窗口内容
const outPage = pages2.find((p) => p.title.includes('输出'));
if (outPage) {
  const out = await connect('输出');
  const text = await out.ev(`document.body.innerText`);
  const hasCard = await out.ev(`!!document.querySelector('.out-audio-title')`);
  const title = await out.ev(`document.querySelector('.out-audio-title')?.textContent || ''`);
  console.log('output text sample:', String(text).slice(0, 120).replace(/\\n/g, ' | '));
  console.log('has title card:', hasCard, 'title:', title);
  out.ws.close();
}

main.ws.close();
console.log('DONE');
