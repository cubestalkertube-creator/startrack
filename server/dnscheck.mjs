import WebSocket from 'ws';
const list = await (await fetch('http://127.0.0.1:9335/json/list')).json();
const t = list.find((x) => x.type === 'page');
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.on('open', r));
let id = 0;
const ev = (expr) => new Promise((res) => {
  const i = ++id;
  const h = (m) => { const d = JSON.parse(m); if (d.id === i) { ws.off('message', h); res(d.result?.result?.value ?? JSON.stringify(d).slice(0, 300)); } };
  ws.on('message', h);
  ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  setTimeout(() => res('eval timeout'), 15000);
});
for (let i = 0; i < 3; i++) console.log('health:', await ev(`(() => { const t0 = performance.now(); return fetch('https://185-218-0-111.sslip.io/health?' + Math.random(), { signal: AbortSignal.timeout(6000) }).then(r => r.text() + ' ' + Math.round(performance.now() - t0) + 'ms', e => 'FAIL ' + e.message + ' ' + Math.round(performance.now() - t0) + 'ms') })()`));
process.exit(0);
