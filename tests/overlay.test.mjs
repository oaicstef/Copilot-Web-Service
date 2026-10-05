import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

const overlaySource = readFileSync(new URL('../web/overlay.js', import.meta.url), 'utf8');
const overlayCss = readFileSync(new URL('../web/overlay.css', import.meta.url), 'utf8');

const PAGE = `<!doctype html><html><head></head><body>
  <div id="terminal-container"><div class="terminal xterm">
    <textarea class="xterm-helper-textarea"></textarea>
    <div class="xterm-viewport">
      <div class="xterm-screen"><canvas></canvas></div>
    </div>
  </div></div>
</body></html>`;

function boot({ search = '', seedFont = null } = {}) {
  const jsdomErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err) => jsdomErrors.push(err)); // jsdom cannot navigate

  const dom = new JSDOM(PAGE, {
    url: `https://oaiccopilot.example/${search}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole
  });

  const { window } = dom;
  window.TextEncoder = TextEncoder;
  window.TextDecoder = TextDecoder;

  const sent = [];
  const instances = [];

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.handlers = {};
      instances.push(this);
    }
    addEventListener(type, fn) {
      if (!this.handlers[type]) this.handlers[type] = [];
      this.handlers[type].push(fn);
    }
    removeEventListener(type, fn) {
      if (!this.handlers[type]) return;
      this.handlers[type] = this.handlers[type].filter((h) => h !== fn);
    }
    send(data) {
      sent.push(data);
    }
    emit(type) {
      (this.handlers[type] || []).forEach((fn) => fn());
    }
  }
  FakeWebSocket.CONNECTING = 0;
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSING = 2;
  FakeWebSocket.CLOSED = 3;
  window.WebSocket = FakeWebSocket;

  if (seedFont !== null) {
    window.localStorage.setItem('copilot-web.fontSize', String(seedFont));
  }

  window.eval(overlaySource);
  if (!window.__copilotWeb) {
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  }

  return { dom, window, sent, instances, jsdomErrors };
}

const bytes = (frame) => Array.from(frame);
const INPUT = 0x30; // ttyd '0' = INPUT frame prefix

test('wraps window.WebSocket and captures the connection ttyd opens', () => {
  const { window } = boot();
  const ws = new window.WebSocket('wss://oaiccopilot.example/ws');
  assert.equal(window.WebSocket.__copilotWebPatched, true);
  assert.equal(window.__copilotWeb.currentSocket(), ws);
});

test('ArrowUp is sent as a ttyd INPUT frame', () => {
  const { window, sent } = boot();
  new window.WebSocket('wss://oaiccopilot.example/ws');
  assert.equal(window.__copilotWeb.sendKey('up'), true);
  assert.deepEqual(bytes(sent[0]), [INPUT, 0x1b, 0x5b, 0x41]);
});

test('every key maps to the escape sequence a Copilot menu expects', () => {
  const { window, sent } = boot();
  new window.WebSocket('wss://oaiccopilot.example/ws');
  const expected = {
    up: [0x1b, 0x5b, 0x41],
    down: [0x1b, 0x5b, 0x42],
    right: [0x1b, 0x5b, 0x43],
    left: [0x1b, 0x5b, 0x44],
    enter: [0x0d],
    esc: [0x1b],
    tab: [0x09],
    btab: [0x1b, 0x5b, 0x5a],
    ctrlc: [0x03],
    ctrld: [0x04],
    pgup: [0x1b, 0x5b, 0x35, 0x7e],
    pgdn: [0x1b, 0x5b, 0x36, 0x7e]
  };
  for (const [key, seq] of Object.entries(expected)) {
    sent.length = 0;
    window.__copilotWeb.sendKey(key);
    assert.deepEqual(bytes(sent[0]), [INPUT, ...seq], `key "${key}"`);
  }
});

test('sending fails cleanly when the connection is not open', () => {
  const { window } = boot();
  assert.equal(window.__copilotWeb.sendKey('up'), false);
  assert.equal(window.document.getElementById('cw-status').dataset.state, 'offline');
});

test('toolbar renders a labelled, focusable button for every key', () => {
  const { window } = boot();
  const buttons = Array.from(window.document.querySelectorAll('#cw-toolbar .cw-btn[data-cw-key]'));
  const keys = Object.keys(window.__copilotWeb.KEYS);
  assert.equal(buttons.length, keys.length);
  for (const el of buttons) {
    assert.equal(el.tagName, 'BUTTON');
    assert.ok(el.getAttribute('aria-label'), 'aria-label present');
    assert.ok(el.title, 'tooltip present');
  }
  const toolbar = window.document.getElementById('cw-toolbar');
  assert.equal(toolbar.getAttribute('role'), 'toolbar');
  assert.ok(toolbar.getAttribute('aria-label'));
});

test('tapping a toolbar button sends that key', () => {
  const { window, sent } = boot();
  new window.WebSocket('wss://oaiccopilot.example/ws');
  window.document.querySelector('[data-cw-key="down"]').click();
  assert.deepEqual(bytes(sent[0]), [INPUT, 0x1b, 0x5b, 0x42]);
});

test('status region is an ARIA live status that clears when connected', () => {
  const { window } = boot();
  const status = window.document.getElementById('cw-status');
  assert.equal(status.getAttribute('role'), 'status');
  assert.equal(status.getAttribute('aria-live'), 'polite');

  window.__copilotWeb.setStatus('online', 'Connected');
  assert.equal(status.hidden, true);

  window.__copilotWeb.setStatus('offline', 'Disconnected');
  assert.equal(status.hidden, false);
  assert.equal(window.document.getElementById('cw-reconnect').hidden, false);
});

test('socket lifecycle drives the status text', () => {
  const { window } = boot();
  const ws = new window.WebSocket('wss://oaiccopilot.example/ws');
  const status = window.document.getElementById('cw-status');

  ws.emit('open');
  assert.equal(status.dataset.state, 'online');

  ws.emit('close');
  assert.equal(status.dataset.state, 'offline');
  assert.match(status.textContent, /Reconnect/);
});

test('collapsing the toolbar frees the terminal space', () => {
  const { window } = boot();
  const root = window.document.getElementById('cw-root');
  const toggle = window.document.querySelector('.cw-toggle');

  toggle.click();
  assert.equal(root.classList.contains('cw-collapsed'), true);
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');

  window.document.querySelector('.cw-fab').click();
  assert.equal(root.classList.contains('cw-collapsed'), false);
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
});

test('font size is clamped and persisted', () => {
  const { window } = boot();
  assert.equal(window.__copilotWeb.setFontSize(40), 32);
  assert.equal(window.localStorage.getItem('copilot-web.fontSize'), '32');

  assert.equal(window.__copilotWeb.setFontSize(2), 4);
  assert.equal(window.localStorage.getItem('copilot-web.fontSize'), '4');
});

/* ttyd applies `?fontSize=` verbatim, so the terminal can sit below our floor.
   Stepping must never drag the size back up, and a step that cannot change
   anything must be reported as such instead of appearing to do nothing. */
test('the controls never push a size that is already below the floor back up', () => {
  const { window } = boot({ search: '?fontSize=2' });
  const term = { options: { fontSize: 2 }, fit() {} };
  window.term = term;

  assert.equal(window.__copilotWeb.currentFont(), 2, 'the live size is reported verbatim');
  assert.equal(window.__copilotWeb.stepTarget(-2), null, 'cannot go smaller');
  assert.equal(window.__copilotWeb.stepTarget(2), 4, 'can grow back into the managed range');
});

test('the step buttons are disabled when they cannot change anything', () => {
  const { window } = boot({ search: '?fontSize=10' });
  const term = { options: { fontSize: 10 }, fit() {} };
  window.term = term;
  const smaller = window.document.querySelector('[aria-label="Decrease text size"]');
  const larger = window.document.querySelector('[aria-label="Increase text size"]');

  window.__copilotWeb.syncFontControls();
  assert.equal(smaller.disabled, false);
  assert.equal(larger.disabled, false);

  // walk down to the floor: the last step disables A-
  for (let i = 0; i < 3; i += 1) smaller.click();
  assert.equal(term.options.fontSize, 4);
  assert.equal(smaller.disabled, true, 'A- is disabled at the floor');
  assert.equal(smaller.getAttribute('aria-disabled'), 'true');
  assert.equal(larger.disabled, false);

  term.options.fontSize = 32;
  window.__copilotWeb.syncFontControls();
  assert.equal(larger.disabled, true, 'A+ is disabled at the ceiling');
  assert.equal(smaller.disabled, false);
});

test('a size change repaints the terminal so stale glyphs cannot hide it', () => {
  const { window } = boot({ search: '?fontSize=16' });
  const calls = [];
  window.term = {
    options: { fontSize: 16 },
    rows: 40,
    fit() { calls.push('fit'); },
    refresh(start, end) { calls.push(`refresh ${start}-${end}`); },
    clearTextureAtlas() { calls.push('clearTextureAtlas'); }
  };

  window.__copilotWeb.setFontSize(14);
  assert.deepEqual(calls, ['fit', 'clearTextureAtlas', 'refresh 0-39']);
});

test('a saved font size is applied to the URL before ttyd reads it', () => {
  const { window } = boot({ seedFont: 22 });
  assert.equal(new window.URLSearchParams(window.location.search).get('fontSize'), '22');
  assert.equal(window.__copilotWeb.currentFont(), 22);
});

test('an explicit fontSize in the URL wins over the saved value', () => {
  const { window } = boot({ search: '?fontSize=24', seedFont: 22 });
  assert.equal(window.__copilotWeb.currentFont(), 24);
});

/* The A-/A+ buttons used to stop responding after the first tap: the size was
   applied to the live terminal but never written back to ?fontSize=, so
   currentFont() kept returning the stale URL value and both buttons recomputed
   the same target. */
test('repeated taps keep changing the size when the URL already carries one', () => {
  const { window } = boot({ search: '?fontSize=16' });
  const term = { options: { fontSize: 16 }, fit() {} };
  window.term = term;
  const smaller = window.document.querySelector('.cw-font .cw-btn[aria-label="Decrease text size"]');

  smaller.click();
  assert.equal(term.options.fontSize, 14);
  smaller.click();
  assert.equal(term.options.fontSize, 12);
  smaller.click();
  assert.equal(term.options.fontSize, 10);
  assert.equal(window.__copilotWeb.currentFont(), 10, 'currentFont tracks the live terminal');
});

test('a size applied to the live terminal is written back to the query string', () => {
  const { window } = boot({ search: '?fontSize=16' });
  window.term = { options: { fontSize: 16 }, fit() {} };

  window.__copilotWeb.setFontSize(12);
  assert.equal(new window.URLSearchParams(window.location.search).get('fontSize'), '12');
  assert.equal(window.__copilotWeb.currentFont(), 12);
});

test('the live terminal wins over a stale query string', () => {
  const { window } = boot({ search: '?fontSize=16' });
  window.term = { options: { fontSize: 20 } };
  assert.equal(window.__copilotWeb.currentFont(), 20);
});

test('changing the size before the terminal exists does not navigate away', () => {
  const { window, jsdomErrors } = boot();
  window.__copilotWeb.setFontSize(14);

  assert.equal(new window.URLSearchParams(window.location.search).get('fontSize'), '14');
  assert.equal(window.localStorage.getItem('copilot-web.fontSize'), '14');
  assert.deepEqual(jsdomErrors, [], 'no reload is triggered while ttyd has not connected');
});

test('the toolbar holds every key, split into a primary row and an extras row', () => {
  const { window } = boot();
  const toolbar = window.document.getElementById('cw-toolbar');
  const keys = window.document.getElementById('cw-keys');
  const extras = window.document.getElementById('cw-extras');

  assert.ok(keys && extras, 'both rows exist');
  assert.equal(keys.parentElement, toolbar);
  assert.equal(extras.parentElement, toolbar);
  assert.equal(
    window.document.querySelectorAll('#cw-toolbar .cw-btn[data-cw-key]').length,
    Object.keys(window.__copilotWeb.KEYS).length,
    'every key is rendered somewhere in the toolbar'
  );
  assert.equal(
    window.document.querySelectorAll('#cw-keys .cw-btn[data-cw-key]').length,
    window.__copilotWeb.PRIMARY_KEYS.length
  );
  assert.equal(window.document.querySelector('.cw-font').parentElement, keys);
});

/* syncKeySpace used to dispatch `resize` from inside its own `resize` handler,
   which recursed until the stack overflowed (RangeError) on every window
   resize and on first paint. */
test('re-fitting after a toolbar change emits exactly one resize event', () => {
  const { window } = boot();
  let fired = 0;
  window.addEventListener('resize', () => {
    fired += 1;
  });

  window.__copilotWeb.syncKeySpace();
  assert.equal(fired, 1);

  fired = 0;
  window.document.querySelector('.cw-toggle').click();
  assert.equal(fired, 1);
  assert.equal(window.document.documentElement.style.getPropertyValue('--cw-keyspace'), '0px');
});

/* A row that never wraps and whose keys shrink to fit is what keeps every key on
   screen. An earlier version wrapped, and on the phone it stacked into a column
   that covered half the screen and buried the arrow keys. */
test('each toolbar row is a single non-wrapping line of shrinking keys', () => {
  const row = overlayCss.match(/\.cw-row\s*\{[^}]*\}/)[0];
  assert.match(row, /flex-wrap:\s*nowrap/);

  const btn = overlayCss.match(/\.cw-btn\s*\{[^}]*\}/)[0];
  assert.match(btn, /flex:\s*1 1 0/);
  assert.match(btn, /min-width:\s*0/);

  assert.doesNotMatch(overlayCss, /overflow-x:\s*(auto|scroll)/);
  assert.doesNotMatch(overlayCss, /display:\s*contents/);
  assert.doesNotMatch(overlayCss, /flex-wrap:\s*wrap/);
});

test('the less-used keys stay hidden behind the More keys button', () => {
  const { window } = boot();
  const root = window.document.getElementById('cw-root');
  const more = window.document.querySelector('.cw-more');
  const extras = window.document.getElementById('cw-extras');

  assert.equal(more.getAttribute('aria-expanded'), 'false');
  assert.equal(root.classList.contains('cw-expanded'), false);
  assert.equal(
    extras.querySelectorAll('.cw-btn[data-cw-key]').length,
    window.__copilotWeb.EXTRA_KEYS.length
  );

  more.click();
  assert.equal(root.classList.contains('cw-expanded'), true);
  assert.equal(more.getAttribute('aria-expanded'), 'true');

  more.click();
  assert.equal(root.classList.contains('cw-expanded'), false);
  assert.equal(more.getAttribute('aria-expanded'), 'false');
});

test('the toolbar buttons are sized by a single compact variable', () => {
  const root = overlayCss.match(/:root\s*\{[^}]*\}/)[0];
  assert.match(root, /--cw-btn:\s*30px/);
  assert.match(root, /--cw-btn-font:\s*13px/);
});

test('the terminal viewport cannot rubber-band the page while scrolling', () => {
  assert.match(overlayCss, /#terminal-container \.xterm-viewport\s*\{[^}]*overscroll-behavior:\s*contain/);
});

/* xterm's scrollbar is dead weight here — scrolling is the CLI's own wheel — and
   it costs 10px of the grid's width, which shows up as a bar with dead space down
   the right edge. The rules are scoped to #terminal-container because the fit runs
   before xterm puts its own class on the element. */
test('xterm’s scrollbar is hidden and its width given back to the grid', () => {
  assert.match(overlayCss, /#terminal-container \.xterm-viewport\s*\{[^}]*scrollbar-width:\s*none/);
  assert.match(overlayCss, /#terminal-container \.xterm-viewport::-webkit-scrollbar\s*\{[^}]*width:\s*0/);
  assert.doesNotMatch(overlayCss, /scrollbar-color:\s*#3b4a63/);
});

test('the grid is not inset by ttyd’s own 5px terminal padding', () => {
  assert.match(overlayCss, /#terminal-container \.terminal\s*\{[^}]*padding:\s*0\s*!important/);
});

/* Regression guard: a stored scroll offset used to restart the bar scrolled with
   the arrows already off the left edge. */
test('the overlay never persists a toolbar scroll offset', () => {
  assert.doesNotMatch(overlaySource, /sessionStorage/);
  assert.doesNotMatch(overlaySource, /scrollLeft/);
});


/* ---------------------------------------------------------- touch scroll --- */

/* The TUI scrolls its transcript with the mouse wheel — the only scroll it has,
   because the transcript lives on the alternate screen, where tmux keeps no
   history, and its own mouse support is alt-screen only. xterm skips *both* of its
   touch handlers while mouse reporting is active, so the overlay turns a swipe into
   the same SGR wheel report a desktop wheel sends. */

// The app announces its mouse protocol in the incoming terminal stream. Dispatch to
// every message listener, as a real socket would, since the overlay has more than
// one (the one-shot font-size handler removes itself on the first message).
function setMouseReporting(instance, enabled, { sgr = true } = {}) {
  const handlers = instance.handlers.message || [];
  assert.ok(handlers.length, 'the overlay watches the socket for mouse reporting');
  const seq = (mode, on) => `\u001b[?${mode}${on ? 'h' : 'l'}`;
  const data = (enabled ? [seq(1002, true), seq(1003, true)] : [seq(1002, false), seq(1003, false)]).join('')
    + (sgr ? seq(1006, enabled) : '');
  handlers.slice().forEach((fn) => fn({ data }));
}

// ttyd tells the server how big the terminal is with a RESIZE frame ('1' + JSON),
// re-sent on every relayout. The overlay sniffs its own outgoing frames for it,
// because counting DOM rows would only work for xterm's DOM renderer and ttyd
// defaults to the webgl one.
function setTerminalSize(instance, cols, rows) {
  instance.send(TextEncoder === undefined
    ? new Uint8Array([0x31])
    : new TextEncoder().encode('1' + JSON.stringify({ columns: cols, rows })));
}

// jsdom has no layout, so stand in for the renderer's canvas: its box divided by
// the RESIZE grid gives the character cell. `.xterm-screen` is given a bogus box so
// a test can tell which element was used.
function stubGrid(window, { left = 0, top = 0, width = 800, height = 480 } = {}) {
  const rect = (l, t, w, h) => ({ left: l, top: t, width: w, height: h, right: l + w, bottom: t + h, x: l, y: t });
  window.document.querySelector('.xterm-screen canvas').getBoundingClientRect = () => rect(left, top, width, height);
  window.document.querySelector('.xterm-screen').getBoundingClientRect = () => rect(0, 0, 1, 1);
}

// A connected, mouse-reporting, sized terminal: the state the overlay sees once
// ttyd has started and the CLI has asked for the mouse.
function bootScroll({ cols = 80, rows = 24, grid = {}, mouse = true, sgr = true } = {}) {
  const { window, sent, instances } = boot();
  stubGrid(window, grid);
  new window.WebSocket('wss://oaiccopilot.example/ws');
  setTerminalSize(instances[0], cols, rows);
  sent.length = 0; // the RESIZE frame itself is not a wheel report
  if (mouse) setMouseReporting(instances[0], true, { sgr });
  return { window, sent, ws: instances[0] };
}

// A one-finger vertical drag over the terminal viewport.
function swipe(window, fromY, toY, x = 100) {
  const viewport = window.document.querySelector('.xterm-viewport');
  const start = new window.Event('touchstart', { bubbles: true, cancelable: true });
  start.touches = [{ clientX: x, clientY: fromY }];
  viewport.dispatchEvent(start);
  return moveTo(window, toY, x);
}

// A further move within the same gesture (no touchstart, so the carried-over
// distance from earlier moves is kept).
function moveTo(window, y, x = 100) {
  const viewport = window.document.querySelector('.xterm-viewport');
  const move = new window.Event('touchmove', { bubbles: true, cancelable: true });
  move.touches = [{ clientX: x, clientY: y }];
  viewport.dispatchEvent(move);
  return move;
}

// The escape sequence a ttyd INPUT frame carries.
const frameText = (frame) => Buffer.from(frame.slice(1)).toString('utf8');

/* 80x24 cells over an 800x480 canvas: a cell is 10x20px, so one wheel notch —
   three cells — is 60px of finger travel. */

test('a swipe up sends the wheel-down report a desktop wheel sends', () => {
  const { window, sent } = bootScroll();

  swipe(window, 300, 240); // 60px up, exactly one notch

  assert.equal(sent.length, 1, 'one wheel notch');
  assert.equal(bytes(sent[0])[0], INPUT, 'sent as a ttyd INPUT frame');
  assert.equal(frameText(sent[0]), '\u001b[<65;11;13M');
});

test('a swipe down sends wheel-up', () => {
  const { window, sent } = bootScroll();

  swipe(window, 240, 300);

  assert.equal(frameText(sent[0]), '\u001b[<64;11;16M');
});

test('a long swipe sends one notch per three cells travelled', () => {
  const { window, sent } = bootScroll();

  swipe(window, 400, 220); // 180px up

  assert.equal(sent.length, 3, '180px is three notches');
  assert.deepEqual(sent.map(frameText), [
    '\u001b[<65;11;12M',
    '\u001b[<65;11;12M',
    '\u001b[<65;11;12M'
  ]);
});

test('a partial notch is carried over to the next move event', () => {
  const { window, sent } = bootScroll();

  swipe(window, 300, 280); // 20px up: not yet a notch
  assert.equal(sent.length, 0, 'the first partial move sends nothing');

  moveTo(window, 240); // 40px more, same gesture: reaches the 60px step
  assert.equal(sent.length, 1);
  assert.equal(frameText(sent[0]), '\u001b[<65;11;13M');
});

test('a drag with no vertical movement sends nothing', () => {
  const { window, sent } = bootScroll();

  const move = swipe(window, 300, 300);

  assert.equal(sent.length, 0);
  assert.equal(move.defaultPrevented, true, 'the gesture is still claimed');
});

test('the gesture is taken over so the page cannot rubber-band behind it', () => {
  const { window } = bootScroll();

  assert.equal(swipe(window, 300, 240).defaultPrevented, true);
});

test('the report is clamped into the grid when the touch is outside it', () => {
  const { window, sent } = bootScroll();

  swipe(window, 10000, 9000, 10000);

  assert.equal(frameText(sent[0]), '\u001b[<65;80;23M');
});

test('the last row is avoided because tmux draws its status line there', () => {
  const { window, sent } = bootScroll();

  swipe(window, 540, 480); // 60px up, ending on the bottom edge of the canvas

  // row 25 unclamped; the pane's usable rows are 1..23, because row 24 of the
  // client is tmux's status line
  assert.equal(frameText(sent[0]), '\u001b[<65;11;23M');
});

test('tmux’s disable-then-enable frame still arms the overlay', () => {
  // Captured from the live stream: tmux re-applies the pane's mouse state around
  // its redraws, so one frame contains a disable followed by an enable. Testing
  // for 'h' and 'l' independently made the 'l' win and the overlay never armed.
  const { window, sent, ws } = bootScroll();
  const handlers = ws.handlers.message || [];
  handlers.slice().forEach((fn) => fn({
    data: '\u001b[?1006l\u001b[?1000l\u001b[?1002l\u001b[?1003l\u001b[?1006h\u001b[?1000h\u001b[?1002h\u001b[?1003h'
  }));

  swipe(window, 300, 240);

  assert.equal(sent.length, 1, 'the last switch in the frame is the live state');
  assert.equal(frameText(sent[0]), '\u001b[<65;11;13M');
});

test('an enable-then-disable frame disarms the overlay', () => {
  const { window, sent, ws } = bootScroll();
  const handlers = ws.handlers.message || [];
  handlers.slice().forEach((fn) => fn({ data: '\u001b[?1003h\u001b[?1006h\u001b[?1003l\u001b[?1006l' }));

  swipe(window, 300, 240);

  assert.equal(sent.length, 0);
});

test('without mouse reporting the swipe is left to xterm', () => {
  const { window, sent } = bootScroll({ mouse: false });

  const move = swipe(window, 300, 240);

  assert.equal(sent.length, 0, 'xterm owns the gesture in that case');
  assert.equal(move.defaultPrevented, false);
});

test('without SGR mouse encoding the swipe is left to xterm', () => {
  const { window, sent } = bootScroll({ sgr: false });

  swipe(window, 300, 240);

  assert.equal(sent.length, 0, 'the overlay only speaks the encoding the app chose');
});

test('turning mouse reporting off stops the overlay handling swipes', () => {
  const { window, sent, ws } = bootScroll();

  setMouseReporting(ws, false);
  swipe(window, 300, 240);

  assert.equal(sent.length, 0);
});

test('a two-finger gesture is not treated as a scroll', () => {
  const { window, sent } = bootScroll();

  const viewport = window.document.querySelector('.xterm-viewport');
  const start = new window.Event('touchstart', { bubbles: true, cancelable: true });
  start.touches = [{ clientX: 100, clientY: 300 }, { clientX: 140, clientY: 300 }];
  viewport.dispatchEvent(start);
  const move = new window.Event('touchmove', { bubbles: true, cancelable: true });
  move.touches = [{ clientX: 100, clientY: 200 }, { clientX: 140, clientY: 200 }];
  viewport.dispatchEvent(move);

  assert.equal(sent.length, 0, 'a pinch is left to the browser');
});

test('a swipe that starts on the toolbar is not a terminal scroll', () => {
  const { window, sent } = bootScroll();
  const toolbar = window.document.getElementById('cw-root');
  assert.ok(toolbar, 'the overlay built its toolbar');
  const start = new window.Event('touchstart', { bubbles: true, cancelable: true });
  start.touches = [{ clientX: 100, clientY: 300 }];
  toolbar.dispatchEvent(start);
  const move = new window.Event('touchmove', { bubbles: true, cancelable: true });
  move.touches = [{ clientX: 100, clientY: 200 }];
  toolbar.dispatchEvent(move);

  assert.equal(sent.length, 0);
});

test('the report falls back to a cell inside the pane when the grid is unknown', () => {
  const { window, sent, instances } = boot();
  new window.WebSocket('wss://oaiccopilot.example/ws'); // never sent a RESIZE frame
  setMouseReporting(instances[0], true);

  swipe(window, 300, 240);

  assert.equal(frameText(sent[0]), '\u001b[<65;1;1M', 'a valid cell, never an out-of-pane one');
});

test('the terminal size comes from the RESIZE frame, not from a relayout guess', () => {
  const { window, sent } = bootScroll({ cols: 40, rows: 12, grid: { width: 400, height: 240 } });

  swipe(window, 100, 40); // 60px up with a 20px cell

  assert.equal(frameText(sent[0]), '\u001b[<65;11;3M');
});

test('the size from ttyd’s opening handshake is used too', () => {
  // ttyd's first client message is {AuthToken, columns, rows}; a page that never
  // sends a separate RESIZE frame is still measured from it.
  const { window, sent, instances } = boot();
  stubGrid(window);
  new window.WebSocket('wss://oaiccopilot.example/ws');
  instances[0].send(JSON.stringify({ AuthToken: '', columns: 80, rows: 24 }));
  sent.length = 0;
  setMouseReporting(instances[0], true);

  swipe(window, 300, 240);

  assert.equal(frameText(sent[0]), '\u001b[<65;11;13M');
});




test('the client RESIZE frame is passed on to the socket untouched', () => {
  const { window, sent } = boot();
  const ws = new window.WebSocket('wss://oaiccopilot.example/ws');
  sent.length = 0;

  setTerminalSize(ws, 132, 43);

  assert.equal(sent.length, 1, 'the frame still reaches ttyd');
  assert.equal(bytes(sent[0])[0], 0x31, 'still a RESIZE frame');
  assert.deepEqual(JSON.parse(Buffer.from(sent[0].slice(1)).toString('utf8')), { columns: 132, rows: 43 });
});

test('the overlay never scrolls the viewport itself any more', () => {
  assert.doesNotMatch(overlaySource, /scrollTop\s*\+=/);
});
