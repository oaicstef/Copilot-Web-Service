/*
 * Copilot Web Console — mobile-friendly overlay for ttyd.
 *
 * This file is inlined by web/build.mjs immediately BEFORE ttyd's own bundle.
 * Running first lets us wrap window.WebSocket, capture the connection ttyd
 * opens, and reuse it to send exact key sequences. Reusing the existing socket
 * means no second ttyd client and therefore no terminal resize side effects.
 */
(function () {
  'use strict';

  var STORE_FONT = 'copilot-web.fontSize';
  var MIN_FONT = 4;
  var MAX_FONT = 32;
  var DEFAULT_FONT = 16;
  var FRAME_INPUT = 0x30; // ttyd protocol: '0' starts an INPUT frame (UTF-8 payload follows)

  /* --------------------------------------------------------------- input --- */

  // Escape sequences a Copilot CLI menu needs from a touch screen.
  var KEYS = {
    up: { label: 'Arrow up', title: 'Up', glyph: '\u2191', seq: '\u001b[A' },
    down: { label: 'Arrow down', title: 'Down', glyph: '\u2193', seq: '\u001b[B' },
    right: { label: 'Arrow right', title: 'Right', glyph: '\u2192', seq: '\u001b[C' },
    left: { label: 'Arrow left', title: 'Left', glyph: '\u2190', seq: '\u001b[D' },
    enter: { label: 'Enter', title: 'Enter', glyph: '\u21b5', seq: '\r' },
    esc: { label: 'Escape', title: 'Esc', glyph: 'Esc', seq: '\u001b' },
    tab: { label: 'Tab', title: 'Tab', glyph: 'Tab', seq: '\t' },
    btab: { label: 'Shift plus Tab', title: 'Shift+Tab', glyph: '\u21e4', seq: '\u001b[Z' },
    ctrlc: { label: 'Control C', title: 'Ctrl+C', glyph: '^C', seq: '\u0003' },
    ctrld: { label: 'Control D', title: 'Ctrl+D', glyph: '^D', seq: '\u0004' },
    pgup: { label: 'Page up', title: 'PgUp', glyph: 'PgUp', seq: '\u001b[5~' },
    pgdn: { label: 'Page down', title: 'PgDn', glyph: 'PgDn', seq: '\u001b[6~' }
  };

  // Always visible: what driving a Copilot menu needs.
  var PRIMARY_KEYS = ['up', 'down', 'left', 'right', 'enter', 'esc'];
  // Behind the "More keys" button so the bar stays one compact row.
  var EXTRA_KEYS = ['tab', 'btab', 'ctrlc', 'ctrld', 'pgup', 'pgdn'];

  /* ------------------------------------------- capture ttyd's WebSocket --- */

  var socket = null;
  var watchers = [];

  function currentSocket() {
    return socket;
  }

  function notify(ws) {
    for (var i = 0; i < watchers.length; i += 1) {
      try {
        watchers[i](ws);
      } catch (err) {
        /* a watcher must never break the terminal */
      }
    }
  }

  function onSocket(fn) {
    watchers.push(fn);
    if (socket) fn(socket);
  }

  function patchWebSocket() {
    var Native = window.WebSocket;
    if (!Native || Native.__copilotWebPatched) return;

    function Patched(url, protocols) {
      var ws = arguments.length > 1 ? new Native(url, protocols) : new Native(url);
      socket = ws;
      notify(ws);
      return ws;
    }

    Patched.prototype = Native.prototype;
    Patched.CONNECTING = Native.CONNECTING;
    Patched.OPEN = Native.OPEN;
    Patched.CLOSING = Native.CLOSING;
    Patched.CLOSED = Native.CLOSED;
    Patched.__copilotWebPatched = true;
    window.WebSocket = Patched;
  }

  function encodeFrame(text) {
    var payload = new TextEncoder().encode(text);
    var frame = new Uint8Array(payload.length + 1);
    frame[0] = FRAME_INPUT;
    frame.set(payload, 1);
    return frame;
  }

  function isOpen(ws) {
    return !!ws && ws.readyState === 1;
  }

  function sendSequence(seq) {
    if (!isOpen(socket)) return false;
    socket.send(encodeFrame(seq));
    return true;
  }

  function sendKey(name) {
    var key = KEYS[name];
    if (!key) return false;
    var sent = sendSequence(key.seq);
    if (!sent) {
      // The socket is gone. ttyd shows "Press ⏎ to Reconnect" and reconnects
      // from a keydown in xterm's helper textarea, which a touch device cannot
      // deliver without first focusing that hidden input — so tapping Enter
      // used to be a silent no-op. Reconnect ourselves instead, so the one key
      // a user naturally reaches for actually does something.
      if (name === 'Enter') {
        setStatus('connecting', 'Reconnecting…');
        reconnect();
        return false;
      }
      setStatus('offline', 'Not connected — tap Reconnect.');
    }
    focusTerminal();
    return sent;
  }

  function focusTerminal() {
    var textarea = document.querySelector('.xterm-helper-textarea');
    if (textarea && typeof textarea.focus === 'function') {
      try {
        textarea.focus({ preventScroll: true });
      } catch (err) {
        textarea.focus();
      }
    }
  }

  /* ---------------------------------------------------- touch scrolling --- */

  // The Copilot TUI scrolls its own transcript with the mouse wheel, and only in
  // alt screen mode (`--mouse [on|off]  Enable mouse support in alt screen mode`),
  // so the launcher must leave mouse support ON. It is the only scroll there is:
  // the TUI keeps its transcript on the pane's alternate screen, where tmux stores
  // no history (measured `#{history_size}` = 0), so xterm is left with no
  // scrollback to move either. Measured on this TUI: one SGR wheel notch scrolls
  // the transcript three lines, while PageUp/PageDown only repaint.
  //
  // A wheel event never reaches the phone, though. xterm bails out of *both* of its
  // touch handlers when mouse reporting is active (`if (!coreMouseService
  // .areMouseEventsActive)` in touchstart and touchmove), so on a phone the swipe
  // has to be turned into the very report a desktop wheel sends: SGR button 64/65.
  // tmux forwards that to the pane application and, measured, does so only while
  // its own `mouse` option is OFF — with `mouse on` tmux keeps the wheel for its
  // copy-mode bindings and the pane sees nothing at all.
  var CELLS_PER_WHEEL_NOTCH = 3; // measured: one notch moves the transcript 3 lines

  var mouseTracking = false;
  var sgrMouse = false;

  // tmux toggles these modes on and off repeatedly — it re-applies the pane's
  // mouse state around its own redraws — and one frame routinely contains a
  // disable *followed by* an enable:
  //   …\e[?1003l  \e[?1006h\e[?1000h\e[?1002h\e[?1003h
  // So order matters. Testing for 'h' and 'l' separately, as this used to, let the
  // 'l' match win every time a frame contained both, and the overlay never armed.
  var MOUSE_MODES = /\u001b\[\?(100[0-3]|1006)([hl])/g;

  function applyMouseModes(data) {
    MOUSE_MODES.lastIndex = 0;
    var match;
    while ((match = MOUSE_MODES.exec(data)) !== null) {
      var on = match[2] === 'h';
      if (match[1] === '1006') sgrMouse = on;
      else mouseTracking = on;
    }
  }

  function watchMouseReporting(ws) {
    ws.addEventListener('message', function (event) {
      if (!event || typeof event.data === 'undefined') return;
      var data = event.data;
      if (typeof data !== 'string') {
        if (typeof TextDecoder !== 'function') return;
        try {
          data = new TextDecoder().decode(data);
        } catch (err) {
          return;
        }
      }
      applyMouseModes(data);
    });
  }

  // The terminal's size, as the client tells the server. Two client frames carry
  // it: the opening handshake, a plain `{"AuthToken":…,"columns":…,"rows":…}`, and
  // every later relayout, a RESIZE frame ('1' + JSON). Those are the counts the
  // pane is sized from, so trust them instead of counting DOM nodes — counting only
  // works for xterm's DOM renderer, and ttyd defaults to the *webgl* one, where the
  // rows are painted into a canvas and there is no node per row.
  var termSize = null;

  function readTerminalSize(json) {
    try {
      var size = JSON.parse(json);
      if (size && size.columns > 0 && size.rows > 0) {
        termSize = { cols: size.columns, rows: size.rows };
      }
    } catch (err) {
      /* not one of the client's size frames */
    }
  }

  function watchClientSizeFrames(ws) {
    var send = ws.send;
    if (typeof send !== 'function') return;
    ws.send = function (data) {
      var RESIZE = 0x31; // ttyd client message '1', followed by {"columns","rows"}
      var JSON_START = 0x7b; // '{', the opening {"AuthToken",…,"columns","rows"} frame
      if (typeof data === 'string') {
        var first = data.charCodeAt(0);
        if (first === RESIZE) readTerminalSize(data.slice(1));
        else if (first === JSON_START) readTerminalSize(data);
      } else if (data && data.length > 1 && typeof TextDecoder === 'function') {
        var text = null;
        try {
          // The handshake arrives as bytes too, so both forms have to be decoded.
          if (data[0] === RESIZE) text = new TextDecoder().decode(data.subarray(1));
          else if (data[0] === JSON_START) text = new TextDecoder().decode(data);
        } catch (err) {
          text = null;
        }
        if (text) readTerminalSize(text);
      }
      return send.apply(ws, arguments);
    };
  }

  // The drawn grid. The canvas the renderer paints into is the grid's exact box;
  // the renderer-less fallbacks only matter for the DOM renderer.
  function gridRect() {
    var el = document.querySelector('.xterm-screen canvas')
      || document.querySelector('.xterm-screen')
      || document.querySelector('.xterm-rows');
    if (!el || typeof el.getBoundingClientRect !== 'function') return null;
    var rect = el.getBoundingClientRect();
    return rect && rect.width && rect.height ? rect : null;
  }

  // How far a finger has to travel for one wheel notch: one notch scrolls three
  // transcript lines, so three cells of travel keeps the two in step.
  function wheelStep() {
    var rect = termSize ? gridRect() : null;
    if (rect && termSize.rows) {
      var cellHeight = rect.height / termSize.rows;
      if (cellHeight) return cellHeight * CELLS_PER_WHEEL_NOTCH;
    }
    return 60; // fallback when the grid cannot be measured (a ~20px row)
  }

  // SGR mouse report for a wheel notch: button 64 is wheel-up, 65 wheel-down, and
  // columns and rows are 1-based, exactly as xterm encodes them. A touch that
  // cannot be placed falls back to the top-left cell, which is always inside the
  // pane — an out-of-pane coordinate is dropped by tmux and would scroll nothing.
  function wheelReport(down, clientX, clientY) {
    var col = 1;
    var row = 1;
    var rect = termSize ? gridRect() : null;
    if (rect) {
      col = Math.floor((clientX - rect.left) / (rect.width / termSize.cols)) + 1;
      row = Math.floor((clientY - rect.top) / (rect.height / termSize.rows)) + 1;
      col = Math.min(termSize.cols, Math.max(1, col));
      // tmux's status line takes the last row of the client, so the pane's last
      // row is one above it: measured, a wheel aimed at the status line is handled
      // by tmux and never reaches the CLI.
      row = Math.min(Math.max(1, termSize.rows - 1), Math.max(1, row));
    }
    return sendSequence('\u001b[<' + (down ? 65 : 64) + ';' + col + ';' + row + 'M');
  }

  function attachTouchScroll() {
    // Bound to the document, not to `.xterm-viewport`: ttyd mounts its whole page
    // from a Preact app, so the terminal's nodes are created by ttyd's own script
    // and looking them up at init is a race. Filtering on the touched node instead
    // works whenever the terminal appears, and ignores the toolbar.
    var lastY = null;
    var carry = 0;

    function inTerminal(target) {
      return !!target && typeof target.closest === 'function' && !!target.closest('.xterm');
    }

    document.addEventListener('touchstart', function (event) {
      lastY = inTerminal(event.target) && event.touches && event.touches.length === 1
        ? event.touches[0].clientY
        : null;
      carry = 0;
    }, { passive: true });

    document.addEventListener('touchmove', function (event) {
      // A gesture that did not start on the terminal (the toolbar, say) is not ours.
      if (lastY === null) return;
      // Without mouse reporting xterm scrolls its own viewport; leave that alone
      // rather than sending reports for a terminal that never asked for them.
      if (!mouseTracking || !sgrMouse) return;
      if (!event.touches || event.touches.length !== 1) return;

      var touch = event.touches[0];
      var delta = lastY - touch.clientY; // positive while the finger moves up
      lastY = touch.clientY;

      // xterm ignores the gesture either way while mouse reporting is active, so
      // claim it: this also stops the page rubber-banding behind the terminal.
      if (typeof event.preventDefault === 'function') event.preventDefault();

      carry += delta;
      if (!carry) return;

      var step = wheelStep();
      while (Math.abs(carry) >= step) {
        // A finger moving up walks forward through the transcript, which is what a
        // wheel-down notch does: button 65. Only knock whole notches off the carry
        // so a long swipe keeps pace with the finger instead of jumping.
        wheelReport(carry > 0, touch.clientX, touch.clientY);
        carry -= carry > 0 ? step : -step;
      }
    }, { passive: false });

    var endGesture = function () {
      lastY = null;
      carry = 0;
    };
    document.addEventListener('touchend', endGesture, { passive: true });
    document.addEventListener('touchcancel', endGesture, { passive: true });
  }

  /* ---------------------------------------------------------- font size --- */

  function readStoredFont() {
    try {
      var raw = window.localStorage.getItem(STORE_FONT);
      var value = raw === null ? NaN : parseInt(raw, 10);
      return isNaN(value) ? null : value;
    } catch (err) {
      return null;
    }
  }

  function storeFont(value) {
    try {
      window.localStorage.setItem(STORE_FONT, String(value));
    } catch (err) {
      /* private mode: font simply will not persist */
    }
  }

  // ttyd applies whatever `?fontSize=` says — it has no clamp of its own — so the
  // terminal can legitimately sit outside our range. Never push the size back
  // "up" in that case: the floor becomes what is already on screen, which keeps
  // A- from making the text bigger.
  function clampFont(value, from) {
    var floor = MIN_FONT;
    if (typeof from === 'number' && !isNaN(from) && from < floor) floor = from;
    return Math.min(MAX_FONT, Math.max(floor, value));
  }

  // The terminal itself is authoritative: both the query string and the stored
  // value can lag behind a size that has already been applied in place. The
  // value is reported verbatim so the controls step from the size really shown.
  function liveFont() {
    var term = window.term;
    if (!term || !term.options || typeof term.options.fontSize !== 'number') return null;
    var value = term.options.fontSize;
    return isNaN(value) ? null : value;
  }

  function currentFont() {
    var live = liveFont();
    if (live !== null) return live;
    var fromUrl = parseInt(new URLSearchParams(window.location.search).get('fontSize') || '', 10);
    if (!isNaN(fromUrl)) return fromUrl;
    var stored = readStoredFont();
    if (stored !== null) return stored;
    return DEFAULT_FONT;
  }

  // The size a step would produce, or null when it cannot change anything.
  // The buttons are disabled on null so a press is never a silent no-op.
  function stepTarget(delta) {
    var from = currentFont();
    var target = clampFont(from + delta, from);
    return target === from ? null : target;
  }

  function withFontParam(font) {
    var url = new URL(window.location.href);
    url.searchParams.set('fontSize', String(font));
    return url.pathname + url.search + url.hash;
  }

  // Applied before ttyd's bundle reads the query string, so no reload is needed
  // on first paint when a size was saved earlier.
  function applyStoredFontToUrl() {
    var params = new URLSearchParams(window.location.search);
    if (params.has('fontSize')) return;
    var stored = readStoredFont();
    if (stored === null) return;
    try {
      window.history.replaceState(null, '', withFontParam(clampFont(stored)));
    } catch (err) {
      /* history unavailable: ttyd keeps its default size */
    }
  }

  // ttyd exposes its xterm instance as `window.term` (plus `window.term.fit`).
  // Mutating the option in place re-renders the terminal without a reload, so
  // the font controls take effect instantly.
  function applyFontToTerminal(font) {
    var term = window.term;
    if (!term || typeof term.options !== 'object') return false;
    try {
      term.options.fontSize = font;
      if (typeof term.fit === 'function') term.fit();
      repaintTerminal(term);
    } catch (err) {
      return false;
    }
    return true;
  }

  // Some renderers (the WebGL one in particular) keep a stale glyph cache after
  // a size change, which leaves the terminal looking unchanged or blank. Redraw
  // the viewport from the buffer so the new size shows up straight away.
  function repaintTerminal(term) {
    try {
      if (typeof term.clearTextureAtlas === 'function') term.clearTextureAtlas();
    } catch (err) {
      /* renderer without a glyph atlas */
    }
    try {
      if (typeof term.refresh === 'function') {
        term.refresh(0, Math.max(0, (term.rows || 1) - 1));
      }
    } catch (err) {
      /* ignore */
    }
  }

  // ttyd reads `?fontSize=` when it connects, so the query string has to stay in
  // step with the size in use. If it goes stale, currentFont() reports the old
  // value and A-/A+ keep re-applying the same size, i.e. appear dead.
  function syncFontToUrl(font) {
    try {
      window.history.replaceState(null, '', withFontParam(font));
    } catch (err) {
      /* history unavailable: the live terminal is still correct */
    }
  }

  function setFontSize(value) {
    var font = clampFont(value, liveFont());
    storeFont(font);
    if (applyFontToTerminal(font)) {
      syncFontToUrl(font);
      syncFontControls();
      return font;
    }
    // No terminal yet means ttyd has not created its socket, so it cannot have
    // read the query string: recording the size there is enough, and skipping
    // the reload keeps the console (and the session) on screen.
    if (!window.term) {
      syncFontToUrl(font);
      syncFontControls();
      return font;
    }
    // Terminal present but the size could not be applied in place: only a
    // reload re-initialises xterm with the new size.
    try {
      window.location.replace(withFontParam(font));
    } catch (err) {
      /* jsdom / restricted contexts */
    }
    return font;
  }

  // Reflect the limits in the UI: a button that cannot change anything is
  // disabled, so "nothing happens" is never a mystery.
  function syncFontControls() {
    if (!smallerBtn || !largerBtn) return;
    markStep(smallerBtn, -2, 'Decrease text size', 'Smallest size reached');
    markStep(largerBtn, 2, 'Increase text size', 'Largest size reached');
  }

  function markStep(el, delta, label, limitLabel) {
    var can = stepTarget(delta) !== null;
    el.disabled = !can;
    el.setAttribute('aria-disabled', can ? 'false' : 'true');
    el.title = can ? label : limitLabel;
  }

  /* ------------------------------------------------------------- status --- */

  var statusEl = null;
  var statusState = 'connecting';
  var reconnectBtn = null;
  var sawConnection = false;
  var smallerBtn = null;
  var largerBtn = null;

  function setStatus(state, message) {
    statusState = state;
    if (!statusEl) return;
    statusEl.dataset.state = state;
    statusEl.hidden = state === 'online';
    var text = statusEl.querySelector('[data-cw-status-text]');
    if (text) text.textContent = message;
    if (reconnectBtn) reconnectBtn.hidden = state !== 'offline';
  }

  // ttyd applies its options — and therefore `?fontSize=` — while handling the
  // first socket message, so the live size is only settled on the next task.
  function watchConnection(ws) {
    sawConnection = true;
    setStatus('connecting', 'Connecting to Copilot\u2026');
    ws.addEventListener('open', function () {
      setStatus('online', 'Connected');
    });
    ws.addEventListener('message', function onFirstMessage() {
      ws.removeEventListener('message', onFirstMessage);
      watchTerminalSize();
      window.setTimeout(syncFontControls, 0);
    });
    ws.addEventListener('close', function () {
      setStatus('offline', 'Disconnected \u2014 tap Reconnect.');
    });
    ws.addEventListener('error', function () {
      setStatus('offline', 'Connection error \u2014 tap Reconnect.');
    });
  }

  // ttyd re-fits the terminal whenever it applies a font option, and xterm
  // reports every geometry change through onResize: subscribing there keeps the
  // enabled state of A-/A+ in step with the size actually on screen.
  function watchTerminalSize() {
    var term = window.term;
    if (!term || term.__cwWatchingSize || typeof term.onResize !== 'function') return;
    term.__cwWatchingSize = true;
    try {
      term.onResize(function () {
        syncFontControls();
      });
    } catch (err) {
      /* xterm version without onResize */
    }
  }

  function reconnect() {
    try {
      window.location.reload();
    } catch (err) {
      /* ignore */
    }
  }

  /* ----------------------------------------------------------------- UI --- */

  function button(key, extraClass) {
    var spec = KEYS[key];
    var el = document.createElement('button');
    el.type = 'button';
    el.className = 'cw-btn' + (extraClass ? ' ' + extraClass : '');
    el.dataset.cwKey = key;
    el.setAttribute('aria-label', spec.label);
    el.title = spec.title;
    var glyph = document.createElement('span');
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = spec.glyph;
    el.appendChild(glyph);
    el.addEventListener('click', function () {
      sendKey(key);
    });
    return el;
  }

  function iconButton(label, glyph, cls) {
    var el = document.createElement('button');
    el.type = 'button';
    el.className = 'cw-btn' + (cls ? ' ' + cls : '');
    el.setAttribute('aria-label', label);
    el.title = label;
    var span = document.createElement('span');
    span.setAttribute('aria-hidden', 'true');
    span.textContent = glyph;
    el.appendChild(span);
    return el;
  }

  function buildToolbar() {
    var root = document.createElement('div');
    root.id = 'cw-root';

    var toast = document.createElement('div');
    toast.id = 'cw-status';
    toast.dataset.state = 'connecting';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    var toastText = document.createElement('span');
    toastText.setAttribute('data-cw-status-text', '');
    toastText.textContent = 'Connecting to Copilot\u2026';
    toast.appendChild(toastText);
    reconnectBtn = document.createElement('button');
    reconnectBtn.type = 'button';
    reconnectBtn.id = 'cw-reconnect';
    reconnectBtn.textContent = 'Reconnect';
    reconnectBtn.hidden = true;
    reconnectBtn.addEventListener('click', reconnect);
    toast.appendChild(reconnectBtn);
    root.appendChild(toast);

    var bar = document.createElement('div');
    bar.id = 'cw-toolbar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Terminal key controls');

    // One row whose keys shrink to fit: nothing can wrap onto its own line,
    // scroll out of reach or be pushed off screen. The less-used keys sit in
    // #cw-extras behind the More keys button.
    var keys = document.createElement('div');
    keys.id = 'cw-keys';
    keys.className = 'cw-row';

    PRIMARY_KEYS.forEach(function (key) {
      keys.appendChild(button(key));
    });

    var separator = document.createElement('span');
    separator.className = 'cw-sep';
    separator.setAttribute('aria-hidden', 'true');
    keys.appendChild(separator);

    var fontGroup = document.createElement('span');
    fontGroup.className = 'cw-group cw-font';
    fontGroup.setAttribute('role', 'group');
    fontGroup.setAttribute('aria-label', 'Text size');

    var smaller = iconButton('Decrease text size', 'A\u2212');
    smaller.addEventListener('click', function () {
      var target = stepTarget(-2);
      if (target !== null) setFontSize(target);
    });
    var larger = iconButton('Increase text size', 'A+');
    larger.addEventListener('click', function () {
      var target = stepTarget(2);
      if (target !== null) setFontSize(target);
    });
    smallerBtn = smaller;
    largerBtn = larger;
    fontGroup.appendChild(smaller);
    fontGroup.appendChild(larger);
    keys.appendChild(fontGroup);

    var more = iconButton('More keys', '\u22ef', 'cw-more');
    more.setAttribute('aria-expanded', 'false');
    more.addEventListener('click', function () {
      var open = root.classList.toggle('cw-expanded');
      more.setAttribute('aria-expanded', open ? 'true' : 'false');
      more.setAttribute('aria-label', open ? 'Fewer keys' : 'More keys');
      more.title = open ? 'Fewer keys' : 'More keys';
      syncKeySpace();
    });
    keys.appendChild(more);

    var collapse = iconButton('Hide key controls', '\u25be', 'cw-toggle');
    collapse.setAttribute('aria-pressed', 'false');
    collapse.addEventListener('click', function () {
      var hidden = root.classList.toggle('cw-collapsed');
      collapse.setAttribute('aria-pressed', hidden ? 'true' : 'false');
      collapse.setAttribute('aria-label', hidden ? 'Show key controls' : 'Hide key controls');
      syncKeySpace();
    });
    keys.appendChild(collapse);

    bar.appendChild(keys);

    var extras = document.createElement('div');
    extras.id = 'cw-extras';
    extras.className = 'cw-row';
    EXTRA_KEYS.forEach(function (key) {
      extras.appendChild(button(key));
    });
    var reset = iconButton('Reset text size', '\u21ba');
    reset.addEventListener('click', function () {
      setFontSize(DEFAULT_FONT);
    });
    extras.appendChild(reset);
    bar.appendChild(extras);

    root.appendChild(bar);

    var fab = iconButton('Show key controls', '\u2328', 'cw-fab');
    fab.addEventListener('click', function () {
      root.classList.remove('cw-collapsed');
      collapse.setAttribute('aria-pressed', 'false');
      syncKeySpace();
    });
    root.appendChild(fab);

    document.body.appendChild(root);
    statusEl = toast;
    syncKeySpace();
    syncFontControls();
    setStatus(statusState === 'online' ? 'online' : 'connecting', 'Connecting to Copilot\u2026');
  }

  // ttyd's fit addon re-measures the terminal on window `resize`, and this
  // module listens for `resize` too (so a rotation or a toolbar change re-fits
  // the terminal). Dispatching that event therefore re-enters syncKeySpace:
  // without the guard it recursed until "Maximum call stack size exceeded".
  var refitInFlight = false;

  function requestTerminalRefit() {
    if (refitInFlight) return;
    refitInFlight = true;
    try {
      window.dispatchEvent(new Event('resize'));
    } catch (err) {
      /* ignore */
    } finally {
      refitInFlight = false;
    }
  }

  // Reserve space so the toolbar never covers the bottom rows of the terminal
  // (where interactive menus are most likely to appear).
  function syncKeySpace() {
    var root = document.getElementById('cw-root');
    var bar = document.getElementById('cw-toolbar');
    if (!root) return;
    var reserved = 0;
    if (!root.classList.contains('cw-collapsed') && bar) {
      reserved = bar.offsetHeight;
    }
    // Never let the toolbar reserve more than half the viewport, so a phone's
    // terminal always keeps at least half the screen even if the bar wraps or
    // a browser reports an unexpectedly large height.
    var maxReserved = Math.floor((window.innerHeight || 0) * 0.5);
    if (maxReserved > 0 && reserved > maxReserved) {
      reserved = maxReserved;
    }
    document.documentElement.style.setProperty('--cw-keyspace', reserved + 'px');
    requestTerminalRefit();
  }

  function init() {
    patchWebSocket();
    applyStoredFontToUrl();
    buildToolbar();

    onSocket(watchConnection);
    onSocket(watchMouseReporting);
    onSocket(watchClientSizeFrames);
    attachTouchScroll();
    watchTerminalSize();

    // A session that never establishes a connection (e.g. proxy/auth failure)
    // should say so instead of spinning forever.
    window.setTimeout(function () {
      if (!sawConnection && statusState !== 'online') {
        setStatus('offline', 'No connection to Copilot \u2014 tap Reconnect.');
      }
    }, 15000);

    window.addEventListener('online', reconnect);
    window.addEventListener('resize', syncKeySpace);
    // Re-measure once the toolbar has been painted with its final metrics
    // (fonts, glyphs, safe-area insets) so --cw-keyspace is not stale.
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(syncKeySpace);
    } else {
      window.setTimeout(syncKeySpace, 0);
    }

    window.__copilotWeb = {
      KEYS: KEYS,
      PRIMARY_KEYS: PRIMARY_KEYS,
      EXTRA_KEYS: EXTRA_KEYS,
      encodeFrame: encodeFrame,
      sendKey: sendKey,
      sendSequence: sendSequence,
      currentFont: currentFont,
      stepTarget: stepTarget,
      setFontSize: setFontSize,
      syncFontControls: syncFontControls,
      setStatus: setStatus,
      syncKeySpace: syncKeySpace,
      currentSocket: currentSocket
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
