// 第三轮验证：系统视频缩略图、节目单行复用、拆分后模块正常加载
// 用法：node scripts/diag/verify-round3.mjs <视频路径>
import WebSocket from 'ws';
const [video] = process.argv.slice(2);
const list = await (await fetch('http://127.0.0.1:9223/json/list')).json();
const page = list.find((t) => t.type === 'page' && !t.url.includes('output'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const logs = [];
ws.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m); return; }
  if (m.method === 'Log.entryAdded' && !/\.(lrc|txt)$/i.test(decodeURIComponent(m.params.entry.url || ''))) logs.push(`[log:${m.params.entry.level}] ${m.params.entry.text} ${m.params.entry.url || ''}`);
  if (m.method === 'Runtime.exceptionThrown') logs.push(`[exception] ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
});
await new Promise((r) => ws.on('open', r));
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => { const m = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); return m.result?.exceptionDetails ? 'EXC: ' + (m.result.exceptionDetails.exception?.description || m.result.exceptionDetails.text) : m.result?.result?.value; };
await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
await send('Page.reload', { ignoreCache: true });
await new Promise((r) => setTimeout(r, 4000));
const V = JSON.stringify(video);
console.log('boot / modules:', await ev(`(async()=>{const ms=['program-store','program-blank','program-bible','program-thumbs','audio-meters','audio-wave','audio-stem-ui'];for(const m of ms)await import('/js/'+m+'.js');return document.querySelector('.tab.active')?.dataset.module+' ok';})()`));
console.log('video thumb (system):', await ev(`(async()=>{const t=performance.now();const u=await window.__TAURI__.core.invoke('make_video_thumb',{path:${V}});if(!u)return 'null (no system thumbnail)';const img=new Image();img.src=u;await img.decode();return JSON.stringify({ms:Math.round(performance.now()-t),w:img.naturalWidth,h:img.naturalHeight,kb:Math.round(u.length/1024)});})()`));
console.log('video thumb missing file:', await ev(`window.__TAURI__.core.invoke('make_video_thumb',{path:'C:/nope/none.mp4'}).then(u=>String(u),e=>'err '+e)`));
// 节目单行复用：第 2 条上移再下移（顺序复原），检查第 1 条的 DOM 节点两次重排后仍是同一个
console.log('program rows reuse:', await ev(`(async()=>{document.querySelector('.tab[data-module="program"]').click();await new Promise(r=>setTimeout(r,300));const box=document.getElementById('pg-items');const ids=()=>[...box.querySelectorAll(':scope > .pg-item')].map(r=>r.dataset.id);const before=ids();if(before.length<2)return 'need >=2 items, have '+before.length;const first=box.querySelector(':scope > .pg-item');const second=box.querySelector('.pg-item[data-id="'+before[1]+'"]');second.querySelector('[data-op="up"]').click();await new Promise(r=>setTimeout(r,300));const mid=ids();const moved=box.querySelector('.pg-item[data-id="'+before[1]+'"]');moved.querySelector('[data-op="down"]').click();await new Promise(r=>setTimeout(r,300));const after=ids();const firstAfter=box.querySelector('.pg-item[data-id="'+before[0]+'"]');return JSON.stringify({count:before.length,swapped:mid[0]===before[1]&&mid[1]===before[0],restored:JSON.stringify(after)===JSON.stringify(before),sameNode:firstAfter===first,nums:[...box.querySelectorAll(':scope > .pg-item')].slice(0,3).map(r=>r.querySelector('.pg-corner-num,.pg-num')?.textContent)});})()`));
console.log('meters draw:', await ev(`(async()=>{document.querySelector('.tab[data-module="audio"]').click();await new Promise(r=>setTimeout(r,500));const c=document.getElementById('audio-spec');return c?('spec '+c.width+'x'+c.height):'no canvas';})()`));
await new Promise((r) => setTimeout(r, 800));
console.log('--- console problems ---'); console.log(logs.join('\n') || '(none)');
process.exit(0);
