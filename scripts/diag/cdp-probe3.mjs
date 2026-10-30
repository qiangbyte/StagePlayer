// 诊断探针（需 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223） probe3: enumerate targets + perf metrics per page
const base = 'http://127.0.0.1:9223';
const r = await fetch(base + '/json/list');
const targets = await r.json();
console.log('targets:');
for (const t of targets) console.log(' -', t.type, '|', t.title, '|', t.url);
const pages = targets.filter((t) => t.type === 'page');
for (const page of pages) {
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
  try {
    await send('Performance.enable');
    await new Promise((r2) => setTimeout(r2, 1500));
    const { metrics } = await send('Performance.getMetrics');
    const pick = (n) => metrics.find((m) => m.name === n)?.value;
    console.log(`--- ${page.title} (${page.url})`);
    console.log(`  JSHeap=${Math.round(pick('JSHeapUsedSize') / 1048576)}MB HeapAlloc=${Math.round(pick('JSHeapTotalSize') / 1048576)}MB Nodes=${pick('Nodes')} Listeners=${pick('JSEventListeners')} Documents=${pick('Documents')} Frames=${pick('Frames')}`);
    const ev = async (expr) => {
      const r2 = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      return r2.exceptionDetails ? 'EVAL-EXC' : r2.result?.value;
    };
    console.log('  imgs=', await ev('document.images.length'),
      ' canvas=', await ev("document.querySelectorAll('canvas').length"),
      ' video=', await ev("document.querySelectorAll('video').length"),
      ' allEls=', await ev("document.querySelectorAll('*').length"));
    console.log('  canvas sizes=', await ev("[...document.querySelectorAll('canvas')].map(c=>c.width+'x'+c.height).join(',')"));
    console.log('  img sizes=', await ev("[...document.images].slice(0,12).map(i=>(i.naturalWidth||0)+'x'+(i.naturalHeight||0)+'/'+(i.currentSrc||'').slice(0,40)).join(' | ')"));
    console.log('  video sizes=', await ev("[...document.querySelectorAll('video')].map(v=>v.videoWidth+'x'+v.videoHeight).join(',')"));
  } catch (e) { console.log('  probe err', e.message); }
  ws.close();
}
process.exit(0);
