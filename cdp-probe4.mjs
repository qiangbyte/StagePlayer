// TEMP-DIAG probe4: worker heap + all targets memory info
const base = 'http://127.0.0.1:9223';
const r = await fetch(base + '/json/list');
const targets = await r.json();
for (const t of targets) {
  if (t.type !== 'page' && t.type !== 'worker' && t.type !== 'other') continue;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id; pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  };
  await new Promise((r2) => { ws.onopen = r2; });
  try {
    const res = await send('Runtime.evaluate', { expression: `JSON.stringify({heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize/1048576) : null, total: performance.memory ? Math.round(performance.memory.totalJSHeapSize/1048576) : null, href: self.location ? self.location.href : 'n/a'})`, returnByValue: true });
    console.log(`[${t.type}] ${t.url.slice(0, 60)} ->`, res.result?.value ?? JSON.stringify(res));
  } catch (e) { console.log(`[${t.type}] err:`, e.message); }
  ws.close();
}
process.exit(0);
