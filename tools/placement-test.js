/* Checks where the snip button lands on replicas of the real chat composers.

   Placement was the one thing the smoke test could not catch: the button was
   landing outside Claude's box, misaligned on ChatGPT and on top of Gemini's
   mic. Each case here asserts the button sits inside the visible composer and
   clear of that site's own controls.

   Run: node tools/serve.js, then node tools/placement-test.js              */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ROOT = path.join(__dirname, '..');
const PAGE = process.env.SNIP_TEST_URL || 'http://127.0.0.1:8777/test/composers.html';
const PORT = 9350;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
  });
  const ready = new Promise((r) => ws.addEventListener('open', r));
  const send = (method, params) => new Promise((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  return { ready, send, close: () => ws.close() };
}

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval threw');
  return r.result.value;
}

/* Reports the button's box, its composer's box, and every control it overlaps. */
const PROBE = (id) => `
  (() => {
    const host = document.querySelector('div[data-snippaste="button"]');
    if (!host) return { error: 'no button' };
    // The button is inside a closed shadow root, so measure the host's child box
    // via its painted position: the host is 0x0, so use elementFromPoint sweeps.
    const field = document.getElementById(${JSON.stringify(id)});
    const box = field.closest('[data-box]').getBoundingClientRect();
    const b = window.__btnRect;
    if (!b) return { error: 'button rect unknown' };
    const controls = [...document.querySelectorAll('[data-ctl]')].map((c) => {
      const r = c.getBoundingClientRect();
      return { r: { l: r.left, t: r.top, rt: r.right, b: r.bottom }, text: c.textContent.trim() };
    });
    const hits = controls.filter((c) =>
      b.left < c.r.rt && b.right > c.r.l && b.top < c.r.b && b.bottom > c.r.t);
    return {
      button: { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), bo: Math.round(b.bottom) },
      box: { l: Math.round(box.left), t: Math.round(box.top), r: Math.round(box.right), bo: Math.round(box.bottom) },
      inside: b.left >= box.left - 1 && b.right <= box.right + 1
              && b.top >= box.top - 1 && b.bottom <= box.bottom + 1,
      overlaps: hits.map((h) => h.text)
    };
  })()`;

/* The shadow root is closed, so read the button's position from the page side
   by sweeping elementFromPoint for the host element. */
const FIND_BTN_RECT = `
  (() => {
    const host = document.querySelector('div[data-snippaste="button"]');
    window.__btnRect = null;
    if (!host) return false;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let y = 0; y < innerHeight; y += 2) {
      for (let x = 0; x < innerWidth; x += 2) {
        if (document.elementFromPoint(x, y) === host) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    if (minX === Infinity) return false;
    window.__btnRect = { left: minX, top: minY, right: maxX + 2, bottom: maxY + 2 };
    return true;
  })()`;

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'snip-place-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, '--enable-unsafe-extension-debugging',
    `--load-extension=${ROOT}`, `--remote-debugging-port=${PORT}`,
    '--window-size=1200,900', PAGE
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  try {
    let targets;
    for (let i = 0; i < 60; i++) {
      try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; }
      catch { await sleep(250); }
    }
    const page = targets.find((t) => t.type === 'page' && t.url.includes('composers.html'));
    if (!page) throw new Error('composer bench page not found');

    const cdp = connect(page.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    try { await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch { /* optional */ }
    await cdp.send('Page.reload');
    await sleep(1800);

    const cases = [
      ['ChatGPT-style', 'cg'],
      ['Claude-style', 'cl'],
      ['Gemini-style', 'gm'],
      ['search input', 'sr']
    ];

    for (const [label, id] of cases) {
      await evaluate(cdp, `
        document.getElementById(${JSON.stringify(id)}).dispatchEvent(
          new PointerEvent('pointerover', { bubbles: true, composed: true }));
        document.getElementById(${JSON.stringify(id)}).focus(); 1`);
      await sleep(500);

      const found = await evaluate(cdp, FIND_BTN_RECT);
      if (!found) { check(`${label}: button appears`, false, 'not painted anywhere'); continue; }

      const r = await evaluate(cdp, PROBE(id));
      if (r.error) { check(`${label}: button appears`, false, r.error); continue; }

      const clear = r.overlaps.length === 0;
      check(`${label}: clear of the site's controls`, clear,
        clear ? '' : 'overlaps ' + r.overlaps.join(', '));

      if (id === 'sr') {
        // A short input has no room inside; just outside its right edge is correct.
        const nearby = r.button.l >= r.box.r - 2 && r.button.l <= r.box.r + 30;
        check(`${label}: sits beside the field`, nearby || r.inside,
          `button.l=${r.button.l} box.r=${r.box.r}`);
      } else {
        check(`${label}: inside the composer box`, r.inside,
          `button ${r.button.l},${r.button.t}-${r.button.r},${r.button.bo} vs box ${r.box.l},${r.box.t}-${r.box.r},${r.box.bo}`);
      }
    }

    cdp.close();
  } catch (e) {
    check('placement run', false, e.message);
  } finally {
    chrome.kill();
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* locked */ }
  }

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exitCode = failed ? 1 : 0;
})();
