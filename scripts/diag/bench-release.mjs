// 正式版测速：需先以 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 启动打包后的 exe
// 用法：node scripts/diag/bench-release.mjs <音频> <视频> [pptx]
import WebSocket from 'ws';
const [audio, video, pptx] = process.argv.slice(2);
const list = await (await fetch('http://127.0.0.1:9223/json/list')).json();
const page = list.find((t) => t.type === 'page' && !t.url.includes('output'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.on('message', (d) => { const m = JSON.parse(d); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m); } });
await new Promise((r) => ws.on('open', r));
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => { const m = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); return m.result?.exceptionDetails ? 'EXC: ' + (m.result.exceptionDetails.exception?.description || m.result.exceptionDetails.text) : m.result?.result?.value; };
const time = (call) => ev(`(async()=>{const r=[];for(let i=0;i<3;i++){const t=performance.now();await ${call};r.push(Math.round(performance.now()-t));}return r.join(' / ')+' ms';})()`);
console.log('page:', page.url);
console.log('JS heap at idle:', await ev(`Math.round(performance.memory.usedJSHeapSize/1048576)+' MB'`));
console.log('audio_wave (5min FLAC):', await time(`window.__TAURI__.core.invoke('audio_wave',{path:${JSON.stringify(audio)}})`));
console.log('make_video_thumb:', await time(`window.__TAURI__.core.invoke('make_video_thumb',{path:${JSON.stringify(video)}})`));
if (pptx) console.log('parse_pptx:', await time(`window.__TAURI__.core.invoke('parse_pptx',{path:${JSON.stringify(pptx)}})`));
process.exit(0);
