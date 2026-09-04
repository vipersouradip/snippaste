/* Pins the extension's ID.

   An unpacked extension normally gets an ID derived from its folder path, which
   would change per machine and break the native-host allowlist. Embedding a
   public key in manifest.json makes the ID deterministic instead, so the
   installer can hard-code it.

   Run with: node tools/gen-key.js   (only needed once; re-running changes the ID)  */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/* Chrome's ID: first 16 bytes of SHA-256 over the DER public key, hex digits
   remapped from 0-9a-f onto a-p. */
function extensionId(derPublicKey) {
  const hash = crypto.createHash('sha256').update(derPublicKey).digest();
  return [...hash.subarray(0, 16)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .split('')
    .map((c) => String.fromCharCode(parseInt(c, 16) + 'a'.charCodeAt(0)))
    .join('');
}

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const der = publicKey.export({ type: 'spki', format: 'der' });
const id = extensionId(der);

const manifestPath = path.join(ROOT, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

// "key" must sit near the top to stay readable, so rebuild the object in order.
const ordered = {};
for (const [k, v] of Object.entries(manifest)) {
  ordered[k] = v;
  if (k === 'description') ordered.key = der.toString('base64');
}
if (!ordered.key) ordered.key = der.toString('base64');

fs.writeFileSync(manifestPath, JSON.stringify(ordered, null, 2) + '\n');
fs.writeFileSync(
  path.join(ROOT, 'tools', 'extension-key.pem'),
  privateKey.export({ type: 'pkcs8', format: 'pem' })
);
fs.writeFileSync(path.join(ROOT, 'tools', 'extension-id.txt'), id + '\n');

console.log('extension id:', id);
console.log('wrote manifest.json "key", tools/extension-key.pem, tools/extension-id.txt');
