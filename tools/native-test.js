/* Exercises the native host over the real Chrome native-messaging framing:
   4-byte little-endian length + UTF-8 JSON, in both directions.

   The "snip" command needs a human to drag a rectangle, so this drives "ping"
   and "clipboard" instead — which covers the framing, the clipboard read, the
   PNG encode and the multi-chunk reassembly. Run: node tools/native-test.js   */

const { spawn } = require('child_process');
const path = require('path');

const HOST = path.join(__dirname, '..', 'native', 'SnipPasteHost.exe');

function open() {
  const proc = spawn(HOST, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const queue = [];
  let waiter = null;
  let buffer = Buffer.alloc(0);

  proc.stdout.on('data', (d) => {
    buffer = Buffer.concat([buffer, d]);
    for (;;) {
      if (buffer.length < 4) return;
      const len = buffer.readUInt32LE(0);
      if (buffer.length < 4 + len) return;
      const msg = JSON.parse(buffer.subarray(4, 4 + len).toString('utf8'));
      buffer = buffer.subarray(4 + len);
      if (waiter) { const w = waiter; waiter = null; w(msg); }
      else queue.push(msg);
    }
  });

  const next = (timeoutMs = 15000) => new Promise((resolve, reject) => {
    if (queue.length) return resolve(queue.shift());
    const timer = setTimeout(() => { waiter = null; reject(new Error('timed out')); }, timeoutMs);
    waiter = (m) => { clearTimeout(timer); resolve(m); };
  });

  const send = (obj) => {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    proc.stdin.write(Buffer.concat([header, body]));
  };

  return { proc, send, next, close: () => proc.stdin.end() };
}

async function collectImage(host) {
  const parts = [];
  let expected = null;
  for (;;) {
    const msg = await host.next();
    if (msg.type === 'error') return { error: msg.message };
    if (msg.type === 'chunk') { parts[msg.seq] = msg.data; expected = msg.total; continue; }
    if (msg.type === 'done') {
      return { base64: parts.join(''), bytes: msg.bytes, chunks: msg.chunks, expected };
    }
  }
}

(async () => {
  const results = [];
  const check = (name, pass, detail) => {
    results.push(pass);
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  };

  const host = open();
  host.proc.stderr.on('data', (d) => console.log('host stderr:', d.toString().trim()));

  try {
    host.send({ cmd: 'ping' });
    const pong = await host.next();
    check('host answers ping over native framing', pong.type === 'pong', 'version ' + pong.version);

    host.send({ cmd: 'bogus' });
    const bad = await host.next();
    check('unknown command reports an error', bad.type === 'error', bad.message);

    // Put a known PNG on the clipboard, then read it back through the host.
    const { execFileSync } = require('child_process');
    const png = path.join(__dirname, '..', 'icons', 'icon128.png');
    execFileSync('powershell.exe', ['-NoProfile', '-STA', '-Command',
      `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; ` +
      `$img=[System.Drawing.Image]::FromFile('${png}'); ` +
      `[System.Windows.Forms.Clipboard]::SetImage($img); $img.Dispose()`]);

    host.send({ cmd: 'clipboard' });
    const image = await collectImage(host);
    check('host returns the clipboard image', !image.error && image.bytes > 0,
      image.error || `${image.bytes} bytes in ${image.chunks} chunk(s)`);

    if (!image.error) {
      const buf = Buffer.from(image.base64, 'base64');
      const isPng = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      check('payload decodes to a real PNG', isPng && buf.length === image.bytes,
        `${buf.length} bytes, magic ${isPng ? 'ok' : 'bad'}`);

      const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
      check('image has the expected dimensions', width === 128 && height === 128, `${width}x${height}`);
      check('chunk count matched the reassembly', image.chunks === image.expected,
        `${image.chunks} sent`);
    }
  } catch (e) {
    check('native host run', false, e.message);
  } finally {
    host.close();
  }

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exitCode = failed ? 1 : 0;
})();
