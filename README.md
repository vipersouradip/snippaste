# SnipPaste

<p align="center">
  <strong>Snip anything on your screen — it lands straight in your text box.</strong><br>
  No clipboard dance. No <kbd>Ctrl</kbd>+<kbd>V</kbd>. Just drag and it's there.
</p>

<p align="center">
  <img src="icons/icon128.png" width="72" height="72" alt="SnipPaste logo"><br>
  <a href="site/"><img src="https://img.shields.io/badge/Windows-Chrome%20%7C%20Brave%20%7C%20Edge-2563EB?style=flat-square&logo=googlechrome" alt="Windows"></a>
  <a href="#install"><img src="https://img.shields.io/badge/Helper-.NET%20on‑your‑machine-512BD4?style=flat-square" alt="Helper"></a>
  <img src="https://img.shields.io/badge/Private-local%20only-10B981?style=flat-square" alt="Private">
  <img src="https://img.shields.io/badge/License-open%20source-black?style=flat-square" alt="Open source">
</p>

<p align="center">
  <a href="https://buymeacoffee.com/vipersouradip" target="_blank"><img src="https://img.shields.io/badge/Buy%20me%20a%20coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy me a coffee"></a>
</p>

---

### Demo — Windows (real recording, no cuts)

<video src="SnipPaste Demo Windows.mp4" controls width="100%" poster="icons/icon128.png" style="border-radius:16px; border:1px solid #E8E5DD; box-shadow: 0 8px 32px rgba(0,0,0,.12)"></video>

> 📹 File: [`SnipPaste Demo Windows.mp4`](SnipPaste%20Demo%20Windows.mp4) (10 MB) — also available as [`site/demo.mp4`](site/demo.mp4) for the homepage. Drag a region over *any app* (PDF, Excel, video, second monitor) → Windows overlay → release → **auto-pasted** into ChatGPT/Claude/Gemini/Perplexity.

<details>
<summary><strong>Homepage preview</strong> — the same video is embedded on the landing page</summary>

The demo on [`site/index.html`](site/index.html) plays inside a Windows-styled chrome with `— □ ✕` controls, plus an illustrated diagram (report.pdf → ChatGPT). The video sits directly below that illustration on the live site (`node tools/serve.js` → http://127.0.0.1:8777/).
</details>

---

## What it is

**Windows:** Chrome extension + a tiny native helper (this folder).  
**Android:** Standalone app with a floating bubble → [`android/`](android/README.md).

> Android exists because Chrome for Android has no extension support, no `nativeMessaging`, and cannot capture outside the page.

| | What it is | Where | Status |
|---|---|---|---|
| **Windows** | Chrome / Brave / Edge extension + helper | this folder | ✅ Live — **Chrome extension, works inside websites** (`chatgpt.com`, `claude.ai`, `gemini.google.com`…) — *not* inside standalone desktop/mobile apps |
| **Android** | Floating bubble, system-wide | [`android/`](android/README.md) | 🚧 In development |
| **iOS** | Custom keyboard | — | 🚧 Planned |

---

## Highlights

- **Anything on screen** — PDF in Acrobat, chart in Excel, video frame, another browser, second monitor. The OS overlay (`Win+Shift+S` / `ms-screenclip:`) sees everything.
- **Zero friction** — no file picker, no upload, no paste. Snip → image is already in the prompt.
- **With prompts** — hover the button → *Explain / Answer / Summarise / Translate / Extract* — the prompt is typed next to the image in one gesture.
- **Private by design** — no network code, no servers. The PNG goes `screen → clipboard → composer` locally.
- **Chrome extension** — runs in `chrome://extensions` (Brave: `brave://extensions`, Edge: `edge://extensions`), works on any `<textarea>`, `input`, or `contenteditable`.

---

## Homepage & Deploy

`site/` is a self-contained landing page (Cliento-inspired, blue/white/black, orange → blue, with cloud hero, side-scrolling logos, reviews, FAQ). It shows version/size/SHA-256 for each download.

```powershell
powershell -ExecutionPolicy Bypass -File tools\build-site.ps1
```

Writes `site/downloads/SnipPaste-windows.zip` (extension + helper source, *never* the signing key) and copies `android/SnipPaste.apk`, then regenerates `site/downloads.js`.

Preview (also serves the demo video):

```bash
node tools/serve.js
# local   http://127.0.0.1:8777/
# network http://192.168.x.x:8777/  (open on a tablet to grab the APK)
```

`vercel.json` → `outputDirectory: site`, so Vercel publishes only the homepage. `.vercelignore` keeps source/tooling/keys off the host. For GitHub Pages / Netlify / S3, publish `site/` as the site root.

---

## Windows — How it works

Click the snip button on any text box, drag over **anything**, and it pastes automatically.

Uses Windows' own snipping overlay — the same as `Win+Shift+S` — so you can snip a PDF in Acrobat, a spreadsheet, a video, another browser, anything at all. Built for chat composers but attaches to any text field.

### Install — two steps, both one-time

**1. Load the extension**

1. Open `chrome://extensions` (Brave: `brave://extensions`, Edge: `edge://extensions`)
2. Turn on **Developer mode** (top-right)
3. **Load unpacked** → select **this folder**

**2. Install the desktop helper**

Chrome cannot open the OS overlay alone — a small helper does it and hands the image back. Once, in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File "native\install.ps1"
```

It compiles the helper with the .NET compiler already on your machine, registers it for Chrome/Brave/Edge, and prints what it did. No admin rights — everything stays under your user profile. **Restart Chrome/Brave/Edge afterwards**.

The extension popup shows a green dot and `Desktop helper ready` when it worked. To remove later: `native\uninstall.ps1`.

> If you skip step 2, the button still works — it falls back to snipping the current page only (frozen-screenshot overlay with magnifier).

### Use

Hover or focus any text box — a small button appears in its corner (fixed in `src/content.js:385` — ChatGPT nudge `TOP_PAD=5` keeps it visually centered).

| Action | Result |
|---|---|
| Click the button | Windows overlay → drag a region |
| **Hover** the button | Menu: *Explain, Answer, Summarise, Translate, Extract* |
| `Alt+Shift+S` | Snip without a prompt, into the focused box |
| `Esc` | Cancel snip or close menu |

Release and the image is in your box — with the prompt you picked, if any, typed right next to it via `document.execCommand('insertText')` (so React/ProseMirror/Lexical all see the `beforeinput`/`input` they expect).

---

## Under the hood

```
text box button  ──▶  extension  ──▶  native helper  ──▶  ms-screenclip:
                                                             (Windows overlay)
                                             ◀── PNG ───────  clipboard
      composer  ◀── synthetic paste ──  extension
```

**Getting the snip.** The helper (`native/SnipPasteHost.cs`, ~330 lines C#) launches `ms-screenclip:`, watches the clipboard sequence number, encodes PNG and streams it back over Chrome's native-messaging pipe. Chrome caps a host message at 1 MB, so larger snips are split into `chunk` messages and reassembled in the service worker (`src/background.js:17`). `cancelled` if the overlay closes without an image.

**Pasting it.** No real paste is possible, so the extension escalates the same way a real paste would:

1. **Synthetic `paste`** — `ClipboardEvent` with `DataTransfer` PNG. If the site calls `preventDefault()`, it took it.
2. **Synthetic `drop`** — `dragenter`/`dragover`/`drop`.
3. **Hidden file input** — assign to the composer's own `input[type=file]`, fire `change`.
4. **Clipboard fallback** — toast *press Ctrl+V* (the OS snip already put it there).

Steps 1–3 need no user action.

**Typing the prompt.** Via `execCommand('insertText')` → browser editing pipeline. Fallbacks: synthetic `paste` of `text/plain`, then direct `.value` assignment.

**Pinned ID.** `manifest.json` `key` fixes the unpacked ID to `nmcnffjofjobldocbnicfmbdanjlddlk` — otherwise the folder path would break the helper allowlist.

---

## Permissions

| Permission | Why |
|---|---|
| `nativeMessaging` | Talk to the desktop helper |
| `<all_urls>` | Run the button on any site; screenshot fallback |
| `storage` | Remember the one setting |
| `clipboardWrite` | Step-4 fallback |

Nothing leaves your machine — no network code in extension or helper.

---

## FAQ

**Why is it not in the Chrome Web Store?**  
Too poor to get a $5 Chrome Web Store Publisher Account.

**Is it available for iOS and Android?**  
No, not yet. Windows is live; Android (bubble) and iOS (keyboard) are in development.

**Is it open source?**  
Yes — helper is compiled on your machine from C# source in the zip.

**Does it store the screenshots?**  
Not at all. Everything happens locally — `screen → clipboard → composer`.

**How can I support?**  
Donate via [Buy Me a Coffee](https://buymeacoffee.com/vipersouradip) — thank you!

---

## Known limits

- **Windows only** for now — see [`android/`](android/README.md). macOS would need `screencapture -i`.
- **Snipping Tool must be present** (`ms-screenclip:`) — ships with every Windows 10 (1809+) & 11. The legacy `SnippingTool.exe` fallback is dead code on Win11.
- **Top frame only** — no cross-origin iframes (all target composers are in the top frame).
- **Restricted pages** — `chrome://*`, Web Store, PDF viewer — extensions cannot inject there.
- **`file://` pages** need *Allow access to file URLs* on the extension's details page.
- `tools/extension-key.pem` is the private key behind the pinned ID — keep it out of public repos.

---

## Layout

```
android/                    the Android app (see android/README.md)
vercel.json                 publishes site/ as the deployed root
site/                       homepage (index.html + downloads/ + demo video)
  ├── index.html            Cliento-inspired landing (blue/white/black, cloud hero, marquee, reviews, FAQ)
  ├── SnipPaste Demo Windows.mp4  real recording (10 MB) — also as demo.mp4
  └── downloads/            zips + apk + downloads.js (generated)
manifest.json               MV3 manifest (pinned "key")
src/background.js           native client, chunk reassembly, fallback screenshot
src/content.js              button anchoring (TOP_PAD=5 for ChatGPT), paste injection, overlay
src/popup.html/.js          helper status + install command
native/SnipPasteHost.cs     desktop helper
native/install.ps1          builds, registers, verifies
native/uninstall.ps1        unregisters
tools/build-site.ps1        packages downloads + refreshes page details
tools/serve.js              static server (also serves the demo video)
test/composers.html         ChatGPT / Claude / Gemini replicas (placement bench)
```

### Moving the folder
The helper's registration stores absolute paths. After moving, re-run `native\install.ps1`.

### Testing

```bash
node tools/native-test.js
# drives helper over real native-messaging framing: ping + PNG round trip (6/6)

node tools/serve.js
# then in another shell:
node tools/smoke-test.js
# Phase A: real extension pings helper through Chrome (registry→manifest→exe)
# Phase B: key stripped → helper refuses → in-page fallback: drag 260×140, assert paste + prompt (15/15)

node tools/placement-test.js
# ChatGPT / Claude / Gemini replicas → button inside composer, clear of site buttons, menu hover (11/11)
```

Chrome 137+ ignores `--load-extension` on stable; use Chrome for Testing:

```powershell
npx @puppeteer/browsers install chrome@stable --path ./browsers
CHROME_PATH=./browsers/chrome/win64-*/chrome-win64/chrome.exe node tools/smoke-test.js
```

Manual: http://127.0.0.1:8777/test/test.html — logs every `paste`/`drop` and renders the image. Homepage: http://127.0.0.1:8777/ (or `/?v=…` to bust cache) — includes the video.

---

## Credits

Inspired by the need to stop juggling screenshots between apps and chat. Built for the tools you already use — [ChatGPT](https://chat.openai.com), [Claude](https://claude.ai), [Gemini](https://gemini.google.com), [Grok](https://grok.com), [Perplexity](https://perplexity.ai).

If it saves you time, consider [buying me a coffee](https://buymeacoffee.com/vipersouradip).
