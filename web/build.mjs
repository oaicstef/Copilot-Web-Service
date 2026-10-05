#!/usr/bin/env node
/*
 * Generates web/index.html from ttyd's own index page.
 *
 * ttyd serves a single self-contained HTML file, so the overlay styles and
 * script are inlined here rather than referenced (ttyd would not serve them).
 * The script is placed *before* ttyd's bundle so it can wrap window.WebSocket.
 *
 * Usage:
 *   npm run build                      # fetch from http://localhost:7681/
 *   TTYD_URL=... TTYD_AUTH=user:pass npm run build
 *   TTYD_URL=... TTYD_AUTH_HEADER=X-Copilot-Auth TTYD_AUTH_VALUE=... npm run build
 *   npm run build:reference            # also save the untouched stock page
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const url = process.env.TTYD_URL || 'http://localhost:7681/';
const auth = process.env.TTYD_AUTH || '';
const authHeader = process.env.TTYD_AUTH_HEADER || '';
const authValue = process.env.TTYD_AUTH_VALUE || '';
const saveReference = process.argv.includes('--save-reference');

const VIEWPORT =
  '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">';
const BUNDLE_MARKER = '<script type="text/javascript">';
const OVERLAY_MARKER = 'id="cw-script"';

async function fetchStockPage() {
  const headers = {};
  if (auth) headers.Authorization = `Basic ${Buffer.from(auth).toString('base64')}`;
  // Header auth (ttyd -H): the proxy would inject this. ttyd only checks that
  // the header is present and non-empty, so any value works when building.
  if (authHeader) headers[authHeader] = authValue || '1';

  let res;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    // `localhost` is the default but ttyd is usually bound to a LAN address
    // (the installer sets TTYD_LISTEN to it), so localhost is refused unless
    // TTYD_URL is overridden. Say so, rather than implying ttyd is down.
    const hint =
      url.includes('localhost') || url.includes('127.0.0.1')
        ? 'ttyd is normally bound to a LAN address, so `localhost` is refused ' +
          'unless it listens there too — check the bind address with ' +
          '`ps -eo args | grep "[t]tyd"` and pass it, e.g. ' +
          'TTYD_URL=http://192.168.0.156:7681/'
        : 'Is copilot-web running on that address? The request was refused.';
    throw new Error(
      `Cannot reach ttyd at ${url} (${err.message}). ${hint} ` +
        'Credentials may also be needed: TTYD_AUTH=user:pass (basic auth) or ' +
        'TTYD_AUTH_HEADER=NAME with TTYD_AUTH_VALUE=... (ttyd -H header auth).'
    );
  }
  if (res.status === 401 || res.status === 407) {
    throw new Error(
      `Authentication failed (${res.status}) for ${url}. ` +
        'Pass TTYD_AUTH=user:pass, or TTYD_AUTH_HEADER=NAME / TTYD_AUTH_VALUE=... ' +
        'when ttyd runs with -H.'
    );
  }
  if (!res.ok) {
    throw new Error(`Unexpected HTTP ${res.status} from ${url}.`);
  }
  return res.text();
}

function injectOverlay(html) {
  if (html.includes(OVERLAY_MARKER)) return { html, injected: false };
  if (!html.includes(BUNDLE_MARKER)) {
    throw new Error('Unexpected ttyd page: could not find the bundle <script> marker.');
  }

  let out = html;
  if (!out.includes('name="viewport"')) {
    out = out.replace('<head>', `<head>${VIEWPORT}`);
  }

  const css = readFileSync(join(here, 'overlay.css'), 'utf8');
  const js = readFileSync(join(here, 'overlay.js'), 'utf8');

  const overlay =
    `<style id="cw-style">${css}</style>\n` +
    `<script id="cw-script" type="text/javascript">${js}</script>\n`;

  const at = out.indexOf(BUNDLE_MARKER);
  return { html: out.slice(0, at) + overlay + out.slice(at), injected: true };
}

function verify(html) {
  const checks = [
    ['viewport meta', html.includes('name="viewport"')],
    ['overlay style', html.includes('id="cw-style"')],
    ['overlay script', html.includes('id="cw-script"')],
    ['toolbar markup', html.includes(OVERLAY_MARKER) || html.includes('cw-toolbar')],
    ['ttyd bundle preserved', html.includes(BUNDLE_MARKER)]
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length) throw new Error(`Generated page failed checks: ${failed.join(', ')}`);
}

async function main() {
  const stock = await fetchStockPage();

  // The installed service runs with `-I web/index.html`, so it serves the page
  // this script produced last time. Building from that quietly regenerates
  // nothing (the bundle stays stale) and would also save a bogus reference
  // copy, so refuse instead of writing a file that looks like success.
  if (stock.includes(OVERLAY_MARKER)) {
    throw new Error(
      `The page at ${url} is already patched (it contains ${OVERLAY_MARKER}), so it still ` +
        'embeds the OLD ttyd bundle — building from it would change nothing. The installed ' +
        'service runs with -I web/index.html and always serves the patched page. Start a ' +
        'throwaway stock ttyd instead:\n' +
        '  ttyd -p 7682 -c tmp:build sleep 120 &\n' +
        '  TTYD_URL=http://127.0.0.1:7682/ TTYD_AUTH=tmp:build npm run build'
    );
  }

  if (saveReference) {
    writeFileSync(join(here, 'stock-index.html'), stock);
    console.log('Saved reference copy to web/stock-index.html');
  }

  const { html, injected } = injectOverlay(stock);
  verify(html);
  writeFileSync(join(here, 'index.html'), html);

  const kb = Math.round(html.length / 1024);
  console.log(`${injected ? 'Generated' : 'Already patched'} web/index.html (${kb} KB) from ${url}`);
}

main().catch((err) => {
  console.error(`build failed: ${err.message}`);
  process.exitCode = 1;
});
