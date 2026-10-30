// TEMP-DIAG probe2: test append_file + runtime state
const base = 'http://127.0.0.1:9223';
const r = await fetch(base + '/json/list');
const targets = await r.json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
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
const ev = async (expr) => {
  const r2 = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  return r2.exceptionDetails ? 'EVAL-EXC: ' + (r2.exceptionDetails.exception?.description || r2.exceptionDetails.text) : r2.result?.value;
};
console.log('has __TAURI__ =', await ev('typeof window.__TAURI__'));
console.log('invoke typeof =', await ev('typeof window.__TAURI__?.core?.invoke'));
const t = await ev(`(async () => {
  try {
    await window.__TAURI__.core.invoke('append_file', { path: 'E:\\\\my\\\\音乐播放器和视频播放器，还有ppt 播放pdf 导入播放器\\\\diag-log.txt', data_b64: btoa('cdp-test-ok\\n'), create: false });
    return 'append OK';
  } catch (e) { return 'append FAIL: ' + (e && (e.message || JSON.stringify(e))); }
})()`);
console.log(t);
console.log('markers on window =', await ev("JSON.stringify({diagN: !!window.__diagN, boot: 'ok'})"));
console.log('mem =', await ev("JSON.stringify(performance.memory ? {heap: Math.round(performance.memory.usedJSHeapSize/1048576)+'MB'} : null)"));
console.log('imgs =', await ev('document.images.length'));
console.log('body text =', String(await ev('document.body.innerText.slice(0,150)')).replace(/\n/g, ' | '));
ws.close(); process.exit(0);
