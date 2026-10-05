import WsImpl from 'ws';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find((t) => t.type === 'page');
const cdp = new WsImpl(page.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((r, j) => { cdp.on('open', r); cdp.on('error', j); });
let id = 0; const pending = new Map();
cdp.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, res);
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('timeout ' + method)); } }, 20000);
  cdp.send(JSON.stringify({ id: i, method, params })); });
const js = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result && r.result.result ? r.result.result.value : undefined; };
const probe = `JSON.stringify((() => { const q=(s)=>document.querySelector(s);
  const t=q('.terminal'), r=q('.xterm-screen').getBoundingClientRect();
  return { w: t.clientWidth, fontSize: window.term.options.fontSize, cols: window.term.cols,
           grid: Math.round(r.width*100)/100, leftover: Math.round((t.clientWidth - r.left - r.width)*100)/100 }; })())`;
console.log('start   :', await js(probe));
// a new width means a new layout key, so the tuner will consider it again
await send('Emulation.setDeviceMetricsOverride', { width: 400, height: 844, deviceScaleFactor: 3, mobile: true });
await wait(3000);
console.log('at 400px:', await js(probe));
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await wait(3000);
console.log('back 390:', await js(probe));
cdp.close(); process.exit(0);
