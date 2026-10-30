// TEMP-DIAG CDP probe (delete after use)
const base = 'http://127.0.0.1:9223';
async function waitPort() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base + '/json/list'); if (r.ok) return await r.json(); } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('devtools port not up');
}
const targets = await waitPort();
const page = targets.find((t) => t.type === 'page');
console.log('TARGET url=', page?.url, 'title=', page?.title);
if (!page) process.exit(1);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const logs = [];
function send(method, params = {}) {
  return new Promise((res, rej) => {
    const i = ++id; pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
}
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    logs.push('EXC: ' + (d.exception?.description || d.text) + ' @' + (d.url || '') + ':' + d.lineNumber);
  } else if (m.method === 'Runtime.consoleAPICalled') {
    logs.push('CONSOLE ' + m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
  } else if (m.method === 'Debugger.scriptFailedToParse') {
    logs.push('SCRIPT-FAIL: ' + m.params.url);
  }
};
await new Promise((r) => { ws.onopen = r; });
await send('Runtime.enable');
await send('Page.enable');
await send('Debugger.enable');

async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return 'EVAL-EXC: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}

console.log('href =', await ev('location.href'));
console.log('readyState =', await ev('document.readyState'));
const served = await ev(`fetch(location.origin + '/js/main.js').then(r=>r.text()).catch(e=>'FETCH-ERR '+e)`);
console.log('served main.js len =', typeof served === 'string' ? served.length : served);
console.log('served has TEMP-DIAG marker =', typeof served === 'string' ? served.includes('boot start') : '-');
console.log('served has diagLog =', typeof served === 'string' ? served.includes('diagLog') : '-');
const servedP = await ev(`fetch(location.origin + '/js/program.js').then(r=>r.text()).catch(e=>'FETCH-ERR '+e)`);
console.log('served program.js has __diagN =', typeof servedP === 'string' ? servedP.includes('__diagN') : '-');

console.log('--- reload with cache bypass ---');
const loaded = new Promise((r) => {
  const h = (m) => { if (m.method === 'Page.loadEventFired') { ws.removeEventListener('message', h); r(); } };
  ws.addEventListener('message', h);
});
await send('Page.reload', { ignoreCache: true });
await loaded;
await new Promise((r) => setTimeout(r, 10000));

const mem = await ev('JSON.stringify(performance.memory || null)');
console.log('memory =', mem);
console.log('imgs =', await ev('document.images.length'), ' canvas =', await ev("document.querySelectorAll('canvas').length"));
console.log('body snippet =', String(await ev('document.body ? document.body.innerText.slice(0,200) : "NO BODY"')).replace(/\n/g, ' | '));
console.log('--- collected events ---');
console.log(logs.slice(0, 60).join('\n') || '(none)');
ws.close();
process.exit(0);
