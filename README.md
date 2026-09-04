# SnipPaste

Snip anything on your screen, and it is pasted straight into whatever you are typing in.
No clipboard step, no Ctrl+V.

Two builds, because the platforms have nothing in common:

| | What it is | Where |
| --- | --- | --- |
| **Windows** | Chrome extension + a small native helper | this folder |
| **Android** | Standalone app with a floating bubble | [`android/`](android/README.md) |

The Android app exists because a Chrome extension categorically cannot do this there: Chrome
for Android has no extension support, Android has no native-messaging mechanism, and Android
Chromium cannot capture the screen outside the page.

## Homepage

`site/` is a self-contained download page offering both builds, with version, size and
SHA-256 for each. Rebuild the packages and refresh those details with:

```
powershell -ExecutionPolicy Bypass -File toolsuild-site.ps1
```

That writes `site/downloads/SnipPaste-windows.zip` (extension + helper source, never the
signing key) and copies `android/SnipPaste.apk`, then regenerates `site/downloads.js`.

To preview it — or to get the APK onto a tablet without a cable — run `node tools/serve.js`
and open the `network` address it prints on the device; the download works straight from
there. To publish it, upload the `site/` folder anywhere static (GitHub Pages, Netlify, any
web host); the links are all relative.

---

## Windows

Click the snip button on any text box, drag a rectangle over **anything on your screen**,
and the image is pasted into that box automatically.

It uses Windows' own snipping overlay — the one `Win+Shift+S` opens — so you can snip a PDF
in Acrobat, a chart in Excel, a video, another browser, anything at all. Built for chat
composers (ChatGPT, Gemini, Claude, Perplexity, …) but it attaches to any `<textarea>`,
text `<input>`, or `contenteditable`.

## Install

Two steps. Both are one-time.

**1. Load the extension**

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select this folder

**2. Install the desktop helper**

Chrome cannot open the OS snipping overlay by itself — no extension can. A small helper
program does it and hands the image back. Run this once in PowerShell:

```
powershell -ExecutionPolicy Bypass -File "native\install.ps1"
```

It builds the helper, registers it for Chrome/Edge, and prints what it did. No admin rights;
everything stays under your user profile. **Restart Chrome afterwards** so it picks the
helper up.

The extension's popup shows a green dot and `Desktop helper ready` once this worked. To
remove it later: `native\uninstall.ps1`.

> If you skip step 2 the button still works, but it can only snip the current page.

## Use

Hover or focus any text box — a small button appears in its corner.

| Action | Result |
| --- | --- |
| Click the button | The Windows snip overlay opens; drag a region |
| `Alt+Shift+S` | Same thing, into the focused text box |
| `Esc` during a snip | Cancel |

Release the mouse and the image is in your text box. That's the whole flow.

## How it works

```
text box button  ──▶  extension  ──▶  native helper  ──▶  ms-screenclip:
                                                             (Windows overlay)
                                             ◀── PNG ───────  clipboard
      composer  ◀── synthetic paste ──  extension
```

**Getting the snip.** The helper (`native/SnipPasteHost.cs`, ~330 lines of C#) launches the
`ms-screenclip:` protocol, which is exactly what `Win+Shift+S` runs. It watches the clipboard
sequence number, and when an image lands it encodes PNG and streams it back over Chrome's
native-messaging pipe. Chrome caps a single host message at 1 MB, so larger snips are split
into `chunk` messages and reassembled in the service worker. If the overlay closes without
producing an image, it reports `cancelled` rather than hanging.

**Pasting it.** There is no way to make the browser perform a *real* paste on a page's
behalf, so the extension hands the image over the same way the site would receive a real
one, escalating until something sticks:

1. **Synthetic `paste`** — a `ClipboardEvent` carrying a `DataTransfer` with the PNG file.
   Every modern chat composer reads `event.clipboardData.files`. If the site calls
   `preventDefault()`, it took the image.
2. **Synthetic `drop`** — the same file through `dragenter`/`dragover`/`drop`.
3. **Hidden file input** — assigned to the composer's own `input[type=file]`, then `change`.
4. **Clipboard** — a toast tells you to press Ctrl+V. (The OS snip already put it there.)

Steps 1–3 need no user action, so pasting is automatic anywhere the site accepts images.

**Pinned extension ID.** `manifest.json` carries a `key`, so the unpacked extension always
gets ID `nmcnffjofjobldocbnicfmbdanjlddlk`. Without it the ID would depend on the folder path
and the helper's allowlist would break whenever the folder moved.

## Permissions

| Permission | Why |
| --- | --- |
| `nativeMessaging` | Talk to the desktop helper |
| `<all_urls>` host access | Run the button on any site; screenshot for the fallback |
| `storage` | Remember the one setting |
| `clipboardWrite` | The step-4 fallback |

Nothing leaves your machine. There is no network code in the extension or the helper.

## Known limits

- **Windows only** — see [`android/`](android/README.md) for tablets and phones. macOS would
  need the same idea around `screencapture -i`; nothing else would change.
- **The Windows Snipping Tool must be present**, since the helper opens `ms-screenclip:`.
  It ships with every Windows 10 (1809+) and 11 install. The legacy `SnippingTool.exe`
  fallback in the helper is dead code on Windows 11, which no longer ships that binary.
- **Top frame only.** The button does not appear inside cross-origin iframes. Every target
  chat site keeps its composer in the top frame.
- **Restricted pages** — `chrome://*`, the Web Store, the PDF viewer — no extension can
  inject there.
- **`file://` pages** need "Allow access to file URLs" ticked on the extension's details page.
- `tools/extension-key.pem` is the private key behind the pinned ID. Keep it out of public
  repos; it is only needed if you later pack a `.crx` with the same identity.

## Layout

```
android/                    the Android app (see android/README.md)
site/                       the download homepage (index.html + downloads/)
tools/build-site.ps1        packages both downloads and refreshes the page details
manifest.json               MV3 manifest (pinned "key" fixes the extension ID)
src/background.js           native-messaging client, chunk reassembly, fallback screenshot
src/content.js              button anchoring, paste injection, in-page fallback overlay
src/popup.html/.js          helper status + install command
native/SnipPasteHost.cs     the desktop helper
native/install.ps1          builds, registers, verifies
native/uninstall.ps1        unregisters
tools/gen-key.js            regenerates the pinned extension ID (changes it!)
tools/gen-icons.js          regenerates icons/
tools/serve.js              static server for the homepage and the test page
tools/native-test.js        drives the helper over real native-messaging framing
tools/smoke-test.js         headless Chrome checks
tools/placement-test.js     button placement against composer replicas
test/test.html              manual bench: contenteditable, textarea, input, event log
test/composers.html         ChatGPT / Claude / Gemini composer replicas
```

### Moving the folder

The helper's registration stores absolute paths. After moving this folder, re-run
`native\install.ps1`.

### Testing

`node tools/native-test.js` — drives the compiled helper over real native-messaging framing:
ping, error handling, and a clipboard image round trip that asserts the returned bytes are a
valid PNG of the right dimensions, reassembled from its chunks. **6/6.**

`node tools/serve.js`, then `node tools/smoke-test.js` — headless Chrome, two phases. Phase A
loads the real extension and pings the helper *through Chrome*, proving the registry →
manifest → exe bridge. Phase B loads a copy with `key` stripped, so its ID is not allowlisted
and the helper refuses it; that exercises the in-page fallback with a full round trip —
trigger, drag a 260×140 rectangle with synthesised mouse input, and assert the page received
a `paste` carrying a `snip-*.png` of exactly those dimensions. **13/13.**

`node tools/placement-test.js` — loads replicas of the ChatGPT, Claude and Gemini composers
(`test/composers.html`) and asserts the snip button lands inside each visible composer box and
clear of that site's own buttons. This is what catches placement regressions, which the smoke
test cannot see. **8/8.**

Chrome 137+ ignores `--load-extension` on the stable channel, so point `CHROME_PATH` at a
Chrome for Testing binary:

```
npx @puppeteer/browsers install chrome@stable --path ./browsers
CHROME_PATH=./browsers/chrome/win64-*/chrome-win64/chrome.exe node tools/smoke-test.js
```

Manual: open `http://127.0.0.1:8777/test/test.html` with the server running. It logs every
`paste`/`drop` it receives and renders the image.
