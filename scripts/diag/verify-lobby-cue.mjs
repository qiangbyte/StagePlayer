// 验证拆分后的大厅页 / 定时开播模块：加载、定时器刷新、推送大厅页（之后恢复原输出）
import WebSocket from 'ws';
const list = await (await fetch('http://127.0.0.1:9223/json/list')).json();
const page = list.find((t) => t.type === 'page' && !t.url.includes('output'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const logs = [];
ws.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m); return; }
  if (m.method === 'Runtime.exceptionThrown') logs.push(`[exception] ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) logs.push(`[console.${m.params.type}] ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
});
await new Promise((r) => ws.on('open', r));
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => { const m = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); return m.result?.exceptionDetails ? 'EXC: ' + (m.result.exceptionDetails.exception?.description || m.result.exceptionDetails.text) : m.result?.result?.value; };
await send('Runtime.enable');
await send('Page.reload', { ignoreCache: true });
await new Promise((r) => setTimeout(r, 4000));
console.log('modules:', await ev(`Promise.all(['program-cue','program-lobby'].map(m=>import('/js/'+m+'.js'))).then(ms=>ms.map(m=>Object.keys(m).length+' exports').join(', '))`));
console.log('lobby countdown ticks:', await ev(`(async()=>{document.querySelector('.tab[data-module="program"]').click();const el=document.getElementById('pg-lobby-remain');const a=el?.textContent;await new Promise(r=>setTimeout(r,1600));return JSON.stringify({before:a,after:el?.textContent});})()`));
console.log('cue countdowns:', await ev(`(()=>{const n=[...document.querySelectorAll('.pg-cue')];return JSON.stringify({total:n.length,visible:n.filter(e=>!e.classList.contains('hidden')).map(e=>e.textContent.replace(/\s+/g,' ').trim()).slice(0,3)});})()`));
console.log('push lobby page:', await ev(`(async()=>{const o=await import('/js/output-main.js');const l=await import('/js/program-lobby.js');const prev=o.getCurrentOutput();l.pushLobbyPage(false);await new Promise(r=>setTimeout(r,300));const s=document.getElementById('preview-stage');const res={kind:o.getCurrentOutput().kind,cls:s.className};o.pushToOutput(prev);return JSON.stringify(res);})()`));
await new Promise((r) => setTimeout(r, 1500));
console.log('--- console problems ---'); console.log(logs.join('\n') || '(none)');
process.exit(0);
