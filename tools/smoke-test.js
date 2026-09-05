/* Headless checks for the extension half of SnipPaste.
   (The native host itself is covered by tools/native-test.js.)

   Two phases, because the two code paths need opposite setups:
     A. the real extension  -> its ID is allowlisted, so Chrome can reach the
        desktop helper; we ping it to prove the whole bridge is wired up.
     B. a copy with the pinned "key" removed -> different ID, so the helper
        refuses it and the in-page fallback runs, which lets us drive a full
        snip-and-paste round trip without popping a real snipping overlay.

   Run: node tools/serve.js, then node tools/smoke-test.js               */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ROOT = path.join(__dirname, '..');
const PAGE = process.env.SNIP_TEST_URL || 'http://127.0.0.1:8777/test/test.html';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function getJSON(url) {
  return (await fetch(url)).json();
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('websocket failed')));
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
  return { ready, send, events, close: () => ws.close() };
}

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval threw');
  return r.result.value;
}

function launch(extensionDir, port) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'snippaste-'));
  const proc = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    // Chrome 137+ ignores --load-extension without this opt-in.
    '--enable-unsafe-extension-debugging',
    `--load-extension=${extensionDir}`,
    `--remote-debugging-port=${port}`,
    PAGE
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const stderr = [];
  proc.stderr.on('data', (d) => stderr.push(d.toString()));
  return { proc, profile, stderr, port };
}

async function waitForDevTools(port) {
  for (let i = 0; i < 60; i++) {
    try { return await getJSON(`http://127.0.0.1:${port}/json/version`); }
    catch { await sleep(250); }
  }
  throw new Error('DevTools endpoint never came up');
}

function cleanup(session) {
  session.proc.kill();
  try { fs.rmSync(session.profile, { recursive: true, force: true }); } catch { /* locked on Windows */ }
}

/* ---------------------------------------------------------------- phase A */

async function phaseNativeBridge() {
  const session = launch(ROOT, 9333);
  try {
    await waitForDevTools(9333);
    await sleep(1500);
    const targets = await getJSON('http://127.0.0.1:9333/json');
    const worker = targets.find((t) => t.type === 'service_worker' && t.url.includes('/src/background.js'));
    check('service worker registered', !!worker, worker ? worker.url.split('//')[1].split('/')[0] : 'not found');
    if (!worker) return;

    const sw = connect(worker.webSocketDebuggerUrl);
    await sw.ready;
    await sw.send('Runtime.enable');

    // Goes out over real native messaging: registry -> host manifest -> exe.
    const pong = await evaluate(sw, `callHost({ cmd: 'ping' }, 8000).then((r) => r)`);
    check('Chrome reaches the desktop helper', !!pong && pong.pong === true,
      pong && pong.pong ? 'host v' + pong.version : 'got ' + JSON.stringify(pong));

    const shot = await evaluate(sw, `
      (async () => {
        const [t] = await chrome.tabs.query({ url: 'http://127.0.0.1:8777/*' });
        const r = await captureTab(t.windowId);
        return { ok: !!r.dataUrl, head: (r.dataUrl || r.error || '').slice(0, 22) };
      })()`);
    check('fallback screenshot capture works', !!shot && shot.ok, shot && shot.head);

    sw.close();
  } finally {
    cleanup(session);
  }
}

/* ---------------------------------------------------------------- phase B */

function makeUnallowlistedCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snippaste-copy-'));
  for (const entry of ['manifest.json', 'src', 'icons']) {
    fs.cpSync(path.join(ROOT, entry), path.join(dir, entry), { recursive: true });
  }
  // Dropping "key" changes the extension ID, so the helper's allowed_origins
  // no longer matches and connectNative is refused -> fallback path.
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  delete manifest.key;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

async function phaseFallbackRoundTrip() {
  const dir = makeUnallowlistedCopy();
  const session = launch(dir, 9334);
  try {
    await waitForDevTools(9334);
    await sleep(1500);

    const targets = await getJSON('http://127.0.0.1:9334/json');
    const page = targets.find((t) => t.type === 'page' && t.url.includes('test.html'));
    const worker = targets.find((t) => t.type === 'service_worker' && t.url.includes('/src/background.js'));
    if (!page || !worker) { check('test targets found', false, 'page/worker missing'); return; }

    const cdp = connect(page.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Log.enable');
    try { await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch { /* optional */ }

    await cdp.send('Page.reload');
    await sleep(1800);

    const worlds = cdp.events
      .filter((e) => e.method === 'Runtime.executionContextCreated')
      .map((e) => e.params.context.name).filter(Boolean);
    check('content script isolated world created', worlds.some((n) => /snip/i.test(n)),
      'worlds: ' + (worlds.join(' / ') || '(none named)'));

    await evaluate(cdp, `document.getElementById('ta').focus(); 1`);
    await sleep(400);
    if (!await evaluate(cdp, `!!document.querySelector('div[data-snippaste="button"]')`)) {
      await evaluate(cdp, `document.getElementById('ta').dispatchEvent(new PointerEvent('pointerover', { bubbles: true, composed: true })); 1`);
      await sleep(400);
    }
    const host = await evaluate(cdp, `
      (() => {
        const h = document.querySelector('div[data-snippaste="button"]');
        return h ? { present: true, shadow: !!h.shadowRoot } : null;
      })()`);
    check('button anchors to a focused text box', !!host, host ? JSON.stringify(host) : 'no button host');
    check('button shadow root is closed', !!host && host.shadow === false);

    const pasteWorks = await evaluate(cdp, `
      (() => {
        const dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array([1,2,3])], 'x.png', { type: 'image/png' }));
        const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
        return !!(ev.clipboardData && ev.clipboardData.files.length === 1);
      })()`);
    check('ClipboardEvent carries synthetic files', pasteWorks === true);

    /* Full round trip through the fallback: trigger, drag, assert the paste. */
    const sw = connect(worker.webSocketDebuggerUrl);
    await sw.ready;
    await sw.send('Runtime.enable');
    const tabId = await evaluate(sw, `
      (async () => {
        const [t] = await chrome.tabs.query({ url: 'http://127.0.0.1:8777/*' });
        return t ? t.id : null;
      })()`);

    const refused = await evaluate(sw, `callHost({ cmd: 'ping' }, 6000).then((r) => r)`);
    check('unallowlisted copy is refused by the helper', !!refused && refused.error === 'no-host',
      JSON.stringify(refused));

    await evaluate(cdp, `
      lines.length = 0;
      document.getElementById('log').textContent = '';
      document.querySelectorAll('#ce img').forEach((n) => n.remove());
      document.getElementById('ce').focus(); 1`);

    await evaluate(sw, `chrome.tabs.sendMessage(${tabId}, { type: 'startSnip' }).then(() => 1)`);

    let overlayUp = false;
    for (let i = 0; i < 40 && !overlayUp; i++) {
      overlayUp = await evaluate(cdp, `!!document.querySelector('div[data-snippaste="overlay"]')`);
      if (!overlayUp) await sleep(150);
    }
    check('fallback overlay opens when the helper is unreachable', overlayUp === true);

    const [x0, y0, x1, y1] = [120, 160, 380, 300];
    const mouse = (type, x, y, buttons) => cdp.send('Input.dispatchMouseEvent', {
      type, x, y, button: 'left', buttons, clickCount: 1
    });
    await mouse('mousePressed', x0, y0, 1);
    await mouse('mouseMoved', (x0 + x1) / 2, (y0 + y1) / 2, 1);
    await mouse('mouseMoved', x1, y1, 1);
    await mouse('mouseReleased', x1, y1, 0);
    await sleep(1500);

    const pageLog = await evaluate(cdp, `document.getElementById('log').textContent`);
    const pasteLine = (pageLog.match(/.*paste on ce .*snip-\d+\.png image\/png.*/) || [''])[0];
    check('snip is pasted into the composer', !!pasteLine,
      pasteLine.trim() || 'log: ' + pageLog.slice(-160));

    const rendered = pageLog.match(/rendered (\d+)×(\d+)/);
    check('crop matches the dragged region',
      !!rendered && Math.abs(+rendered[1] - (x1 - x0)) <= 2 && Math.abs(+rendered[2] - (y1 - y0)) <= 2,
      rendered ? `${rendered[1]}×${rendered[2]} (wanted ${x1 - x0}×${y1 - y0})` : 'nothing rendered');

    check('image ended up inside the contenteditable',
      await evaluate(cdp, `document.querySelectorAll('#ce img').length`) === 1);

    /* Same round trip again, but asking for a prompt: the image and the text
       both have to land in the composer. */
    await evaluate(cdp, `
      (() => {
        lines.length = 0;
        document.getElementById('log').textContent = '';
        const box = document.getElementById('ce');
        box.querySelectorAll('img').forEach((n) => n.remove());
        box.textContent = '';
        box.focus();
        return 1;
      })()`);

    await evaluate(sw, `chrome.tabs.sendMessage(${tabId}, { type: 'startSnip', prompt: 'Explain this.' }).then(() => 1)`);

    let overlay2 = false;
    for (let i = 0; i < 40 && !overlay2; i++) {
      overlay2 = await evaluate(cdp, `!!document.querySelector('div[data-snippaste="overlay"]')`);
      if (!overlay2) await sleep(150);
    }
    check('prompted snip opens the overlay too', overlay2 === true);

    await mouse('mousePressed', x0, y0, 1);
    await mouse('mouseMoved', (x0 + x1) / 2, (y0 + y1) / 2, 1);
    await mouse('mouseMoved', x1, y1, 1);
    await mouse('mouseReleased', x1, y1, 0);
    await sleep(1500);

    const withPrompt = await evaluate(cdp, `
      (() => {
        const ce = document.getElementById('ce');
        return { text: ce.textContent.trim(), imgs: ce.querySelectorAll('img').length };
      })()`);
    check('prompt is typed into the composer with the image',
      withPrompt.text === 'Explain this.' && withPrompt.imgs === 1,
      JSON.stringify(withPrompt));

    /* Clicking the button itself means "just snip": the hover menu is open by
       then, and none of its prompts may leak into the composer. */
    await evaluate(cdp, `
      (() => {
        lines.length = 0;
        document.getElementById('log').textContent = '';
        const box = document.getElementById('ce');
        box.querySelectorAll('img').forEach((n) => n.remove());
        box.textContent = '';
        box.focus();
        return 1;
      })()`);
    await sleep(500);

    const btnRect = await evaluate(cdp, `
      (() => {
        const host = document.querySelector('div[data-snippaste="button"]');
        if (!host) return null;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let y = 0; y < innerHeight; y += 2) for (let x = 0; x < innerWidth; x += 2) {
          if (document.elementFromPoint(x, y) === host) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
        return minX === Infinity ? null : { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
      })()`);

    if (!btnRect) {
      check('clicking the button snips with no prompt', false, 'button not painted');
    } else {
      const bx = Math.round(btnRect.x), by = Math.round(btnRect.y);
      // Hover long enough for the menu to open, then click the button anyway.
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bx, y: by, buttons: 0 });
      await sleep(500);
      await mouse('mousePressed', bx, by, 1);
      await mouse('mouseReleased', bx, by, 0);

      let overlay3 = false;
      for (let i = 0; i < 40 && !overlay3; i++) {
        overlay3 = await evaluate(cdp, `!!document.querySelector('div[data-snippaste="overlay"]')`);
        if (!overlay3) await sleep(150);
      }
      check('clicking the button starts a snip', overlay3 === true);

      await mouse('mousePressed', x0, y0, 1);
      await mouse('mouseMoved', (x0 + x1) / 2, (y0 + y1) / 2, 1);
      await mouse('mouseMoved', x1, y1, 1);
      await mouse('mouseReleased', x1, y1, 0);
      await sleep(1500);

      const plain = await evaluate(cdp, `
        (() => {
          const box = document.getElementById('ce');
          return { text: box.textContent.trim(), imgs: box.querySelectorAll('img').length };
        })()`);
      check('clicking the button snips with no prompt',
        plain.imgs === 1 && plain.text === '', JSON.stringify(plain));
    }

    const thrown = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown').length;
    check('no page-side exceptions', thrown === 0, thrown ? thrown + ' thrown' : '');

    sw.close();
    cdp.close();
  } finally {
    cleanup(session);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

(async () => {
  try {
    await phaseNativeBridge();
    await phaseFallbackRoundTrip();
  } catch (e) {
    check('test run completed', false, e.message);
  }
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exitCode = failed ? 1 : 0;
})();
