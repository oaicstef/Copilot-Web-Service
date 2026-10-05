import WsImpl from 'ws';
import { execFileSync } from 'node:child_process';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find((t) => t.type === 'page');
const cdp = new WsImpl(page.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((r, j) => { cdp.on('open', r); cdp.on('error', j); });
let id = 0; const pending = new Map();
cdp.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, res);
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('timeout ' + method)); } }, 25000);
  cdp.send(JSON.stringify({ id: i, method, params }));
});
const js = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result && r.result.result ? r.result.result.value : undefined; };
const cols = () => execFileSync('tmux', ['display-message', '-t', 'fillcheck', '-p', '#{pane_width}'], { encoding: 'utf8' }).trim();
await send('Page.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__sent = [];
  const s = WebSocket.prototype.send;
  WebSocket.prototype.send = function (d) { try { window.__sent.push(typeof d === 'string' ? d : new TextDecoder().decode(d)); } catch (e) {} return s.apply(this, arguments); };
`});
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
await send('Page.navigate', { url: 'http://127.0.0.1:7699/' });
await wait(16000);
const probe = `JSON.stringify((() => { const q=(s)=>document.querySelector(s);
  const t=q('.terminal'), sc=q('.xterm-screen'); const r=sc.getBoundingClientRect();
  return { available: t.clientWidth, grid: Math.round(r.width*100)/100, left: Math.round(r.left*100)/100,
           leftover: Math.round((t.clientWidth - r.left - r.width)*100)/100,
           letterSpacing: window.term ? window.term.options.letterSpacing : null, cols: window.term ? window.term.cols : null }; })())`;
console.log('after load      :', await js(probe), '| pane cols', cols());
await wait(2000);
console.log('after settling  :', await js(probe), '| pane cols', cols());
await js('window.__sent = []; true');
await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: 600 }] });
for (let y = 560; y >= 300; y -= 40) { await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 195, y }] }); await wait(60); }
await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await wait(1200);
const wheels = JSON.parse(await js('JSON.stringify((window.__sent||[]).filter((s)=>s.indexOf("\\u001b[<")!==-1))'));
console.log('swipe still works:', wheels.length, 'wheel reports');
cdp.close(); process.exit(0);
