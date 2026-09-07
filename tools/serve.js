/* Static server for local previewing: the homepage in site/, and the paste
   test bench in test/. Run: node tools/serve.js  ->  http://127.0.0.1:8777 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const port = 8777;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
  '.apk': 'application/vnd.android.package-archive',
  '.mp4': 'video/mp4'
};

http.createServer((req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }

  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/site/index.html';
  if (rel.endsWith('/')) rel += 'index.html';

  // Keep requests inside the project.
  const file = path.join(root, rel);
  if (!file.startsWith(root)) { res.writeHead(403); res.end('nope'); return; }

  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(file).toLowerCase();
    const headers = { 'content-type': TYPES[ext] || 'application/octet-stream' };
    // Browsers should save these, not try to render them.
    if (ext === '.zip' || ext === '.apk') {
      headers['content-disposition'] = `attachment; filename="${path.basename(file)}"`;
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}).listen(port, () => {
  console.log('serving ' + root);
  console.log('  local   http://127.0.0.1:' + port + '/');
  // Handy for getting the APK onto a tablet: open this address on the device.
  for (const [name, addrs] of Object.entries(require('os').networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) {
        console.log('  network http://' + a.address + ':' + port + '/   (' + name + ')');
      }
    }
  }
});
