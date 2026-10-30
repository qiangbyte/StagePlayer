// 第二轮优化验证：原生波形解码、PPT 媒体落盘 + asset 渲染、lsGetCached
// 用法：node scripts/diag/verify-perf.mjs <wav路径> <带图片的pptx路径>
import WebSocket from 'ws';
const [wav, pptx] = process.argv.slice(2);
const list = await (await fetch('http://127.0.0.1:9223/json/list')).json();
const page = list.find((t) => t.type === 'page' && !t.url.includes('output'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const logs = [];
ws.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m); return; }
  if (m.method === 'Log.entryAdded') logs.push(`[log:${m.params.entry.level}] ${m.params.entry.text} ${m.params.entry.url || ''}`);
  if (m.method === 'Runtime.exceptionThrown') logs.push(`[exception] ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
});
await new Promise((r) => ws.on('open', r));
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => { const m = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); return m.result?.exceptionDetails ? 'EXC: ' + (m.result.exceptionDetails.exception?.description || m.result.exceptionDetails.text) : m.result?.result?.value; };
await send('Runtime.enable'); await send('Log.enable');
const W = JSON.stringify(wav); const X = JSON.stringify(pptx);
console.log('audio_wave:', await ev(`(async()=>{const t=performance.now();const b=await window.__TAURI__.core.invoke('audio_wave',{path:${W}});const dv=new DataView(b);const np=dv.getUint32(16,true),nm=dv.getUint32(20,true);const pk=new Float32Array(b,24,np);return JSON.stringify({ms:Math.round(performance.now()-t),bytes:b.byteLength,dur:+dv.getFloat64(0,true).toFixed(3),sr:dv.getUint32(8,true),monoSr:dv.getUint32(12,true),np,nm,maxPeak:+Math.max(...pk).toFixed(3)});})()`));
console.log('pptx parse:', await ev(`(async()=>{const d=await window.__TAURI__.core.invoke('parse_pptx',{path:${X}});const p=d.slides[0].pictures[0];return JSON.stringify({slides:d.slides.length,src:p?.src?.slice(0,120),isData:p?.src?.startsWith('data:'),json:JSON.stringify(d).length});})()`));
console.log('slide image loads:', await ev(`(async()=>{const d=await window.__TAURI__.core.invoke('parse_pptx',{path:${X}});const m=await import('/js/slide-render.js');const el=m.makeSlideCanvas();el.style.width='400px';document.body.appendChild(el);m.renderSlide(el,d.slides[0]);const img=el.querySelector('img');await new Promise(r=>{if(img.complete)r();img.onload=r;img.onerror=r;});const out={src:img.src.slice(0,60),w:img.naturalWidth};el.remove();return JSON.stringify(out);})()`));
console.log('ppt push to output:', await ev(`(async()=>{const m=await import('/js/ppt.js');await m.playPage(${X},0,{stay:true});const im=document.querySelector('#preview-stage img');return im?im.src.slice(0,60)+' w='+im.naturalWidth:'no img';})()`));
console.log('lsGetCached memo:', await ev(`(async()=>{const u=await import('/js/util.js');localStorage.setItem('sp.test.memo',JSON.stringify({a:1}));const a=u.lsGetCached('sp.test.memo',null),b=u.lsGetCached('sp.test.memo',null);localStorage.setItem('sp.test.memo',JSON.stringify({a:2}));const c=u.lsGetCached('sp.test.memo',null);localStorage.removeItem('sp.test.memo');return JSON.stringify({same:a===b,updated:c.a===2});})()`));
await new Promise((r) => setTimeout(r, 800));
console.log('--- console problems ---'); console.log(logs.join('\n') || '(none)');
process.exit(0);
