import WebSocket from 'ws';
import fs from 'node:fs';
const list = await (await fetch('http://127.0.0.1:9223/json/list')).json();
// --output：在输出窗口里执行
const wantOutput = process.argv.includes('--output');
// --file <path>：从文件读表达式（避免命令行过长 / 反斜杠转义）
const fileIdx = process.argv.indexOf('--file');
const args = process.argv.filter((a, i) => a !== '--output' && (fileIdx < 0 || (i !== fileIdx && i !== fileIdx + 1)));
const expression = fileIdx > 0 ? fs.readFileSync(process.argv[fileIdx + 1], 'utf8') : args[2];
const page = list.find((t) => t.type === 'page' && t.url.includes('output') === wantOutput && !t.url.startsWith('devtools'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.on('open', r));
ws.on('message', (d) => { const m = JSON.parse(d); if (m.id === 1) { console.log(JSON.stringify(m.result.result?.value ?? m.result)); process.exit(0); } });
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
