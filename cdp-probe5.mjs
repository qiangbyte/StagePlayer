// TEMP-DIAG probe5: inspect open PDF docs & program items
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
  const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  return res.exceptionDetails ? 'EVAL-EXC: ' + res.exceptionDetails.exception?.description : res.result?.value;
};
// pdf.js module scope is not directly reachable; find exposed state via DOM/data attributes
console.log('open pdf imgs in program =', await ev("document.querySelectorAll('#pg-items img').length"));
console.log('pg thumbs canvases =', await ev("document.querySelectorAll('#pg-items canvas').length"));
console.log('module roots:', await ev("['pdf-grid','ppt-grid','pg-items'].map(id=>id+':'+(document.getElementById(id)?.children.length??-1)).join(' ')"));
// check exposed debug handles
console.log('window debug handles =', await ev("Object.keys(window).filter(k=>/pdf|doc|thumb|diag/i.test(k)).join(',')"));
// items by type from the DOM cards
console.log('cards by type =', await ev("[...document.querySelectorAll('#pg-items [data-type]')].reduce((a,c)=>{const t=c.dataset.type;a[t]=(a[t]||0)+1;return a},{});"));
ws.close(); process.exit(0);
