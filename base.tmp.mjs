import WsImpl from 'ws';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find((t) => t.type === 'page');
const cdp = new WsImpl(page.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((r, j) => { cdp.on('open', r); cdp.on('error', j); });
let id = 0; const pending = new Map(); const logs = [];
cdp.on('message', (raw) => { const m = JSON.parse(raw.toString());
  if (m.method === 'Runtime.consoleAPICalled' && m.params?.args?.[0]) logs.push(String(m.params.args[0].value));
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, res);
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('timeout ' + method)); } }, 25000);
  cdp.send(JSON.stringify({ id: i, method, params })); });
const js = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result && r.result.result ? r.result.result.value : undefined; };
const cols = () => execFileSync('tmux', ['display-message', '-t', 'fillcheck', '-p', '#{pane_width}'], { encoding: 'utf8' }).trim();
await send('Page.enable'); await send('Runtime.enable');
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
  const t=q('.terminal'), r=q('.xterm-screen').getBoundingClientRect();
  return { available: t.clientWidth, grid: Math.round(r.width*100)/100, cell: Math.round(r.width/ (window.term?window.term.cols:1) *1000)/1000,
           leftover: Math.round((t.clientWidth - r.left - r.width)*100)/100,
           spacing: window.term ? (window.term.options.letterSpacing || 0) : null, cols: window.term ? window.term.cols : null }; })())`;
console.log('renderer:', logs.filter((l) => /renderer/i.test(l)).slice(0, 1));
console.log('layout  :', await js(probe), '| pane cols', cols());
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync('/tmp/base.png', Buffer.from(shot.result.data, 'base64'));
const b64 = Buffer.from(shot.result.data, 'base64').toString('base64');
const strip = JSON.parse(await js(`(async () => {
  const img = new Image(); await new Promise((r) => { img.onload = r; img.src = 'data:image/png;base64,${b64}'; });
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, img.width, img.height).data;
  const at = (x, y) => { const i = (y*img.width + x)*4; return d[i] + ',' + d[i+1] + ',' + d[i+2]; };
  const t = {}; for (let cx = 380; cx < 390; cx++) for (let y = 30; y < img.height - 300; y += 3) { const p = at(cx*3, y); t[p] = (t[p]||0)+1; }
  return JSON.stringify(Object.entries(t).sort((a,b)=>b[1]-a[1]).slice(0,3)); })()`));
console.log('far-right strip colours:', JSON.stringify(strip), '(was 84% 59,74,99 = the scrollbar)');
await js('window.__sent = []; true');
await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: 600 }] });
for (let y = 560; y >= 300; y -= 40) { await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 195, y }] }); await wait(60); }
await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await wait(1200);
const wheels = JSON.parse(await js('JSON.stringify((window.__sent||[]).filter((s)=>s.indexOf("\\u001b[<")!==-1))'));
console.log('swipe works:', wheels.length, 'wheel reports');
cdp.close(); process.exit(0);
