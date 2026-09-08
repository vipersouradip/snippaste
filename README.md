# SnipPaste

<p align="center">
  <img src="icons/icon128.png" width="80" height="80" alt="SnipPaste"><br>
  <strong>Snip anything on your screen — it lands straight in your text box.</strong><br>
  Chrome extension for Windows · works inside websites, not apps
</p>

> **Right now only for Windows** — works in **Claude, Gemini, ChatGPT, Grok, Perplexity** websites (`chatgpt.com`, `claude.ai`, `gemini.google.com`…). **iOS and Android coming soon.**

### Demo

![SnipPaste demo — drag a region, it lands in the composer](demo.gif)

<!-- This is a GIF, so it animates anywhere the README is rendered (github.com, npm, offline clones)
     and needs nothing but the relative path above.
     For an inline player with audio/scrubbing instead: open this file on github.com · pencil (Edit) ·
     drag demo-compressed.mp4 into the editor box. GitHub uploads it and inserts a
     https://github.com/user-attachments/assets/<uuid> link — replace the image line above with that
     bare URL, alone on its own line. No <video> tag, no ![](), no <a href>.
     Only user-attachments / user-images.githubusercontent.com URLs embed that way;
     raw.githubusercontent.com and release-download links do not. -->

> Windows 11 · live recording · no cuts — drag any region → auto-pasted

### How it works

```
button → extension → helper → Windows overlay (ms-screenclip:) → PNG → paste into composer
```

Hover the button for prompts (Explain / Answer / Summarise / Translate / Extract).

### How to install

**1. Load extension:** `chrome://extensions` (Brave: `brave://extensions`, Edge: `edge://extensions`) → Developer mode → Load unpacked → select this folder

**2. Helper:** `powershell -ExecutionPolicy Bypass -File "native\install.ps1"` → restart browser

### Support

[☕ Buy me a coffee](https://buymeacoffee.com/vipersouradip) · [GitHub](https://github.com/vipersouradip/snippaste)
