import WebSocket from 'ws';
const list = await (await fetch('http://127.0.0.1:9223/json/list')).json();
// --output：在输出窗口里执行
const wantOutput = process.argv.includes('--output');
const page = list.find((t) => t.type === 'page' && t.url.includes('output') === wantOutput);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.on('open', r));
ws.on('message', (d) => { const m = JSON.parse(d); if (m.id === 1) { console.log(JSON.stringify(m.result.result?.value ?? m.result)); process.exit(0); } });
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: process.argv.filter((a) => a !== '--output')[2], awaitPromise: true, returnByValue: true } }));
