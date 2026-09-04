/* SnipPaste — content script.
   1. Anchors a small snip button to whatever text box the user is using.
   2. Click it: the desktop helper opens Windows' own snipping overlay.
   3. The returned PNG is injected into that text box automatically.

   If the helper is not installed, it falls back to snipping this page with a
   frozen-screenshot overlay so the button still does something useful.

   The DOM here avoids innerHTML and resource URLs on purpose: target sites
   enforce Trusted Types (which makes innerHTML throw) and strict img-src CSP
   (which would blank the overlay). Nodes are built one by one, styles go in
   via constructable stylesheets, and the frozen frame is painted to a canvas. */

(() => {
  if (window.__snipPasteLoaded) return;
  window.__snipPasteLoaded = true;

  const DEFAULTS = { showButton: true, minWidth: 80, minHeight: 22 };
  let settings = { ...DEFAULTS };

  try {
    chrome.storage.sync.get(DEFAULTS, (v) => {
      if (!chrome.runtime.lastError && v) settings = { ...DEFAULTS, ...v };
      if (!settings.showButton) hideButton();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      for (const k of Object.keys(changes)) settings[k] = changes[k].newValue;
      if (!settings.showButton) hideButton();
    });
  } catch { /* storage unavailable in some sandboxed frames */ }

  const Z = 2147483600;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const twoFrames = async () => { await raf(); await raf(); };

  function sendMsg(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) return resolve({ error: chrome.runtime.lastError.message });
          resolve(res || { error: 'No response' });
        });
      } catch {
        resolve({ error: 'Extension reloaded — refresh the page' });
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* DOM helpers (Trusted-Types safe)                                     */
  /* ------------------------------------------------------------------ */

  function el(tag, className) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    return n;
  }

  function applyStyles(root, css) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      root.adoptedStyleSheets = [sheet];
    } catch {
      const style = document.createElement('style');
      style.textContent = css;   // textContent is not a Trusted Types sink
      root.appendChild(style);
    }
  }

  function snipIcon() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    for (const [k, v] of Object.entries({
      viewBox: '0 0 24 24', width: '15', height: '15', fill: 'none',
      stroke: 'currentColor', 'stroke-width': '2',
      'stroke-linecap': 'round', 'stroke-linejoin': 'round'
    })) svg.setAttribute(k, v);
    const corners = [
      'M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8',
      'M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8',
      'M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16',
      'M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16'
    ];
    for (const d of corners) {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    }
    const r = document.createElementNS(SVG_NS, 'rect');
    for (const [k, v] of Object.entries({ x: '9', y: '9', width: '6', height: '6', rx: '1' })) {
      r.setAttribute(k, v);
    }
    svg.appendChild(r);
    return svg;
  }

  /* ------------------------------------------------------------------ */
  /* Editable detection                                                   */
  /* ------------------------------------------------------------------ */

  const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', '']);

  function isEditable(node) {
    if (!node || node.nodeType !== 1) return false;
    const tag = node.tagName;
    if (tag === 'TEXTAREA') return !node.disabled && !node.readOnly;
    if (tag === 'INPUT') {
      const t = (node.getAttribute('type') || 'text').toLowerCase();
      return TEXT_INPUT_TYPES.has(t) && !node.disabled && !node.readOnly;
    }
    return node.isContentEditable === true;
  }

  /* For contenteditable, anchor to the outermost editable host, not an inner span. */
  function editableRoot(node) {
    if (!node || node.nodeType !== 1) return null;
    if (node.tagName === 'TEXTAREA' || node.tagName === 'INPUT') return isEditable(node) ? node : null;
    if (!node.isContentEditable) return null;
    let n = node;
    while (n.parentElement && n.parentElement.isContentEditable) n = n.parentElement;
    return n;
  }

  function editableFrom(node) {
    let n = node && node.nodeType === 3 ? node.parentElement : node;
    while (n && n.nodeType === 1) {
      if (isEditable(n)) return editableRoot(n);
      n = n.parentElement;
    }
    return null;
  }

  function visibleRect(node) {
    if (!node || !node.isConnected) return null;
    const r = node.getBoundingClientRect();
    if (r.width < settings.minWidth || r.height < settings.minHeight) return null;
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return null;
    const cs = getComputedStyle(node);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) return null;
    return r;
  }

  /* Used by the keyboard shortcut when nothing is focused: pick the biggest text box. */
  function findBestEditable() {
    const cands = document.querySelectorAll('textarea, input, [contenteditable=""], [contenteditable="true"]');
    let best = null, bestArea = 0;
    for (const node of cands) {
      if (!isEditable(node)) continue;
      const root = editableRoot(node);
      const r = root && visibleRect(root);
      if (!r) continue;
      const area = r.width * r.height;
      if (area > bestArea) { bestArea = area; best = root; }
    }
    return best;
  }

  /* ------------------------------------------------------------------ */
  /* Floating snip button                                                 */
  /* ------------------------------------------------------------------ */

  const BUTTON_CSS = `
    :host { all: initial; }
    .btn {
      position: fixed; width: 24px; height: 24px; border-radius: 7px;
      display: flex; align-items: center; justify-content: center;
      background: rgba(24,24,27,.72); color: #fff; cursor: pointer;
      border: 1px solid rgba(255,255,255,.18);
      box-shadow: 0 2px 8px rgba(0,0,0,.28);
      opacity: .5; transition: opacity .12s, transform .12s, background .12s;
      pointer-events: auto; user-select: none;
      -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
    }
    .btn:hover { opacity: 1; transform: scale(1.08); background: rgba(108,92,255,.95); border-color: rgba(255,255,255,.3); }
    .btn:active { transform: scale(.94); }
    .btn.hidden { display: none; }
    .tip {
      position: fixed; padding: 6px 9px; border-radius: 6px; white-space: nowrap;
      background: rgba(18,18,24,.95); color: #f4f4f5;
      font: 500 11px/1.45 ui-sans-serif, system-ui, -apple-system, sans-serif;
      box-shadow: 0 4px 16px rgba(0,0,0,.34); pointer-events: none; opacity: 0;
      transition: opacity .12s; border: 1px solid rgba(255,255,255,.13);
    }
    .tip.show { opacity: 1; }
    .tip b { color: #b9b4ff; font-weight: 600; }
  `;

  let host = null, btn = null;
  let target = null;          // element the button is currently attached to
  let lastEditable = null;    // last text box the user touched
  let hovered = null, focused = null;
  let trackId = 0, lastRectKey = '';
  let snipping = false;

  function buildButton() {
    host = el('div');
    host.setAttribute('data-snippaste', 'button');
    host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;z-index:' + Z + ';';
    const root = host.attachShadow({ mode: 'closed' });
    applyStyles(root, BUTTON_CSS);

    btn = el('div', 'btn hidden');
    btn.appendChild(snipIcon());

    const tip = el('div', 'tip');
    const key = el('b');
    key.textContent = 'Alt+Shift+S';
    tip.append('Snip anything on screen  ', key);

    btn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      startSnip();
    });
    btn.addEventListener('mouseenter', () => {
      const r = btn.getBoundingClientRect();
      tip.classList.add('show');
      tip.style.top = Math.max(4, r.top - 32) + 'px';
      tip.style.left = Math.max(4, Math.min(innerWidth - 220, r.right - 210)) + 'px';
    });
    btn.addEventListener('mouseleave', () => tip.classList.remove('show'));

    root.append(btn, tip);
    (document.body || document.documentElement).appendChild(host);
  }

  function ensureButton() {
    if (!host || !host.isConnected) { host = null; buildButton(); }
  }

  function hideButton() {
    if (btn) btn.classList.add('hidden');
    target = null;
    lastRectKey = '';
    if (trackId) { cancelAnimationFrame(trackId); trackId = 0; }
  }

  function setHostVisible(v) {
    if (host) host.style.display = v ? '' : 'none';
  }

  const BTN_SIZE = 24;
  const BTN_PAD = 8;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /* The editable is often smaller than what the user sees as "the chat box":
     ChatGPT, Claude and Gemini all wrap it in a styled container that also
     holds their own buttons. Anchor to that container instead, or the button
     lands outside the visible box or misaligned against it. */
  function composerBox(node) {
    const field = node.getBoundingClientRect();
    let box = field;
    let el = node.parentElement;
    for (let depth = 0; el && depth < 4; depth++, el = el.parentElement) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) break;
      // Once an ancestor is much bigger than the field it is page layout, not the control.
      if (r.width > field.width + 200 || r.height > field.height + 300) break;
      const cs = getComputedStyle(el);
      const framed = parseFloat(cs.borderTopWidth) > 0
        || parseFloat(cs.borderTopLeftRadius) > 4
        || cs.boxShadow !== 'none'
        || (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent');
      if (framed) box = r;
    }
    return box;
  }

  /* Overlapping the text is fine; overlapping the site's own controls is not. */
  function pageBlocks(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return false;
    if (host && (el === host || host.contains(el))) return false;
    if (target && (el === target || target.contains(el) || el.contains(target))) return false;
    return !!el.closest(
      'button, a[href], [role="button"], [role="menuitem"], [role="tab"],' +
      ' input:not([type="hidden"]), select, label[for]');
  }

  function spotIsFree(left, top) {
    const probes = [
      [left + BTN_SIZE / 2, top + BTN_SIZE / 2],
      [left + 1, top + 1],
      [left + BTN_SIZE - 1, top + 1],
      [left + 1, top + BTN_SIZE - 1],
      [left + BTN_SIZE - 1, top + BTN_SIZE - 1]
    ];
    for (const [x, y] of probes) {
      if (x < 1 || y < 1 || x > innerWidth - 1 || y > innerHeight - 1) return false;
      if (pageBlocks(x, y)) return false;
    }
    return true;
  }

  function placeButton() {
    const field = visibleRect(target);
    if (!field) { hideButton(); return; }
    const key = [field.top, field.left, field.width, field.height].map(Math.round).join('|');
    if (key === lastRectKey) return;
    lastRectKey = key;

    const box = composerBox(target);
    const top = box.height < BTN_SIZE + BTN_PAD * 2
      ? box.top + (box.height - BTN_SIZE) / 2
      : box.top + BTN_PAD;

    // Hidden while probing, so elementFromPoint reports the page and not us.
    // No paint happens in between, so nothing flickers.
    const restore = host.style.display;
    host.style.display = 'none';

    let left = null;
    const outside = box.right + 4;
    // A one-line <input> is all text: keep the button off it entirely.
    const smallInput = target.tagName === 'INPUT' && box.height < 52;

    // A short single-line input has no room to spare: prefer just outside it.
    if (smallInput && outside + BTN_SIZE < innerWidth - 2 && spotIsFree(outside, top)) {
      left = outside;
    }
    // Otherwise walk in from the right edge, stepping over the site's controls.
    for (let i = 0; left === null && i < 8; i++) {
      const candidate = box.right - BTN_SIZE - BTN_PAD - i * (BTN_SIZE + 6);
      if (candidate < box.left + 2) break;
      if (spotIsFree(candidate, top)) left = candidate;
    }
    if (left === null && outside + BTN_SIZE < innerWidth - 2 && spotIsFree(outside, top)) {
      left = outside;
    }

    host.style.display = restore;
    // Nothing was clear — sit at the top-right anyway rather than vanish.
    if (left === null) left = box.right - BTN_SIZE - BTN_PAD;

    btn.style.left = Math.round(clamp(left, 2, innerWidth - BTN_SIZE - 2)) + 'px';
    btn.style.top = Math.round(clamp(top, 2, innerHeight - BTN_SIZE - 2)) + 'px';
    btn.classList.remove('hidden');
  }

  function track() {
    trackId = 0;
    if (!target || snipping) return;
    placeButton();
    if (target) trackId = requestAnimationFrame(track);
  }

  function refreshButton() {
    if (snipping) { setHostVisible(false); return; }
    if (!settings.showButton) { hideButton(); return; }
    setHostVisible(true);
    const next = (focused && focused.isConnected) ? focused
      : (hovered && hovered.isConnected) ? hovered
        : null;
    if (!next) { hideButton(); return; }
    ensureButton();
    if (next !== target) { target = next; lastRectKey = ''; }
    placeButton();
    if (!trackId) trackId = requestAnimationFrame(track);
  }

  let hoverTimer = 0;

  document.addEventListener('focusin', (e) => {
    const node = editableFrom(e.composedPath ? e.composedPath()[0] : e.target);
    focused = node;
    if (node) lastEditable = node;
    refreshButton();
  }, true);

  document.addEventListener('focusout', () => {
    focused = null;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(refreshButton, 180);
  }, true);

  document.addEventListener('pointerover', (e) => {
    if (host && e.composedPath && e.composedPath().includes(host)) return;
    const node = editableFrom(e.composedPath ? e.composedPath()[0] : e.target);
    if (node === hovered) return;
    hovered = node;
    clearTimeout(hoverTimer);
    if (node) { lastEditable = node; refreshButton(); }
    else hoverTimer = setTimeout(refreshButton, 260);
  }, true);

  addEventListener('scroll', () => { lastRectKey = ''; }, true);
  addEventListener('resize', () => { lastRectKey = ''; refreshButton(); });

  /* ------------------------------------------------------------------ */
  /* Image decoding                                                       */
  /* ------------------------------------------------------------------ */

  /* Decoded without fetch() or an <img src>, so no CSP directive applies. */
  function dataUrlToBlob(dataUrl) {
    const comma = dataUrl.indexOf(',');
    const meta = dataUrl.slice(0, comma);
    const bin = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const match = meta.match(/:(.*?);/);
    return new Blob([bytes], { type: match ? match[1] : 'image/png' });
  }

  /* ------------------------------------------------------------------ */
  /* Fallback: snip this page                                             */
  /* ------------------------------------------------------------------ */

  const OVERLAY_CSS = `
    :host { all: initial; }
    .root { position: fixed; inset: 0; cursor: crosshair; overflow: hidden;
            font: 500 12px/1.4 ui-sans-serif, system-ui, -apple-system, sans-serif; }
    .shot { position: fixed; inset: 0; }
    .scrim { position: fixed; inset: 0; background: rgba(9,9,14,.5); }
    .sel { position: fixed; display: none; background: transparent;
           box-shadow: 0 0 0 100vmax rgba(9,9,14,.5); outline: 1.5px solid #7c6cff; }
    .sel::after { content: ''; position: absolute; inset: 0; outline: 1px solid rgba(255,255,255,.7); }
    .xh { position: fixed; background: rgba(124,108,255,.5); pointer-events: none; }
    .xh.v { top: 0; bottom: 0; width: 1px; }
    .xh.h { left: 0; right: 0; height: 1px; }
    .badge { position: fixed; display: none; padding: 3px 7px; border-radius: 5px;
             background: #7c6cff; color: #fff; font-variant-numeric: tabular-nums;
             white-space: nowrap; box-shadow: 0 2px 8px rgba(0,0,0,.35); }
    .loupe { position: fixed; width: 116px; height: 116px; border-radius: 10px; display: none;
             border: 1px solid rgba(255,255,255,.35); box-shadow: 0 6px 20px rgba(0,0,0,.5);
             pointer-events: none; background: #0b0b10; }
    .hint { position: fixed; top: 18px; left: 50%; transform: translateX(-50%);
            padding: 8px 15px; border-radius: 999px; background: rgba(18,18,24,.9); color: #f4f4f5;
            border: 1px solid rgba(255,255,255,.14); box-shadow: 0 6px 22px rgba(0,0,0,.4);
            -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); white-space: nowrap; }
    .hint b { color: #b9b4ff; }
    .hint.fade { opacity: 0; transition: opacity .15s; }
  `;

  const LOUPE_SIZE = 116;
  const LOUPE_ZOOM = 6;

  async function capturePageFrame() {
    const res = await sendMsg({ type: 'captureTab' });
    if (res.error) throw new Error(res.error);
    const bitmap = await createImageBitmap(dataUrlToBlob(res.dataUrl));
    return { source: bitmap, width: bitmap.width, height: bitmap.height };
  }

  function selectRegion(frame) {
    return new Promise((resolve) => {
      /* A tab screenshot maps 1:1 onto the viewport. */
      const scaleX = frame.width / innerWidth;
      const scaleY = frame.height / innerHeight;
      const dpr = devicePixelRatio || 1;

      const oHost = el('div');
      oHost.setAttribute('data-snippaste', 'overlay');
      oHost.style.cssText = 'position:fixed;inset:0;z-index:' + (Z + 10) + ';';
      const shadowRoot = oHost.attachShadow({ mode: 'closed' });
      applyStyles(shadowRoot, OVERLAY_CSS);

      const root = el('div', 'root');
      const shot = el('canvas', 'shot');
      shot.width = Math.max(1, Math.round(innerWidth * dpr));
      shot.height = Math.max(1, Math.round(innerHeight * dpr));
      shot.style.width = innerWidth + 'px';
      shot.style.height = innerHeight + 'px';
      shot.getContext('2d').drawImage(
        frame.source, 0, 0, frame.width, frame.height, 0, 0, shot.width, shot.height
      );

      const scrim = el('div', 'scrim');
      const xhV = el('div', 'xh v');
      const xhH = el('div', 'xh h');
      const sel = el('div', 'sel');
      const badge = el('div', 'badge');
      const loupe = el('canvas', 'loupe');
      loupe.width = LOUPE_SIZE * dpr;
      loupe.height = LOUPE_SIZE * dpr;
      const loupeCtx = loupe.getContext('2d');
      loupeCtx.imageSmoothingEnabled = false;

      const hint = el('div', 'hint');
      const esc = el('b');
      esc.textContent = 'Esc';
      hint.append('Drag to snip this page  ·  ', esc, ' to cancel');

      root.append(shot, scrim, xhV, xhH, sel, badge, loupe, hint);
      shadowRoot.appendChild(root);

      let dragging = false, x0 = 0, y0 = 0, cur = null, settled = false;

      const clampX = (v) => Math.max(0, Math.min(innerWidth, v));
      const clampY = (v) => Math.max(0, Math.min(innerHeight, v));

      function paintLoupe(e) {
        const fx = clampX(e.clientX) * scaleX;
        const fy = clampY(e.clientY) * scaleY;
        const span = LOUPE_SIZE / LOUPE_ZOOM;
        loupeCtx.fillStyle = '#0b0b10';
        loupeCtx.fillRect(0, 0, loupe.width, loupe.height);
        loupeCtx.drawImage(frame.source, fx - span / 2, fy - span / 2, span, span,
          0, 0, loupe.width, loupe.height);
        const mid = Math.round(loupe.width / 2) + 0.5;
        loupeCtx.strokeStyle = 'rgba(124,108,255,.95)';
        loupeCtx.lineWidth = Math.max(1, dpr);
        loupeCtx.beginPath();
        loupeCtx.moveTo(mid, 0); loupeCtx.lineTo(mid, loupe.height);
        loupeCtx.moveTo(0, mid); loupeCtx.lineTo(loupe.width, mid);
        loupeCtx.stroke();
        const flipX = e.clientX + 24 + LOUPE_SIZE > innerWidth;
        const flipY = e.clientY + 24 + LOUPE_SIZE > innerHeight;
        loupe.style.display = 'block';
        loupe.style.left = (flipX ? e.clientX - 24 - LOUPE_SIZE : e.clientX + 24) + 'px';
        loupe.style.top = (flipY ? e.clientY - 24 - LOUPE_SIZE : e.clientY + 24) + 'px';
      }

      function paint(e) {
        xhV.style.left = e.clientX + 'px';
        xhH.style.top = e.clientY + 'px';
        if (dragging) {
          const x1 = clampX(e.clientX), y1 = clampY(e.clientY);
          const l = Math.min(x0, x1), t = Math.min(y0, y1);
          const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
          cur = { l, t, w, h };
          sel.style.display = 'block';
          sel.style.left = l + 'px';
          sel.style.top = t + 'px';
          sel.style.width = w + 'px';
          sel.style.height = h + 'px';
          badge.style.display = 'block';
          badge.textContent = Math.round(w * scaleX) + ' × ' + Math.round(h * scaleY);
          badge.style.top = (t > 30 ? t - 26 : Math.min(innerHeight - 26, t + h + 8)) + 'px';
          badge.style.left = Math.max(4, Math.min(innerWidth - 96, l)) + 'px';
        }
        paintLoupe(e);
      }

      function finish(rect) {
        if (settled) return;
        settled = true;
        removeEventListener('keydown', onKey, true);
        oHost.remove();
        resolve(rect);
      }

      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); }
      }

      root.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) { finish(null); return; }
        e.preventDefault();
        dragging = true;
        x0 = clampX(e.clientX);
        y0 = clampY(e.clientY);
        scrim.style.display = 'none';
        hint.classList.add('fade');
        try { root.setPointerCapture(e.pointerId); } catch { /* not captured, fine */ }
        paint(e);
      });

      root.addEventListener('pointermove', paint);

      root.addEventListener('pointerup', (e) => {
        if (!dragging) return;
        dragging = false;
        paint(e);
        /* A stray click means "I misclicked", not "snip nothing". */
        if (!cur || cur.w < 5 || cur.h < 5) {
          sel.style.display = 'none';
          badge.style.display = 'none';
          scrim.style.display = '';
          hint.classList.remove('fade');
          cur = null;
          return;
        }
        finish({ sx: cur.l * scaleX, sy: cur.t * scaleY, sw: cur.w * scaleX, sh: cur.h * scaleY });
      });

      root.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
      root.addEventListener('contextmenu', (e) => { e.preventDefault(); finish(null); });
      addEventListener('keydown', onKey, true);

      (document.body || document.documentElement).appendChild(oHost);
    });
  }

  function cropToBlob(frame, r) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(r.sw));
    canvas.height = Math.max(1, Math.round(r.sh));
    canvas.getContext('2d').drawImage(frame.source, r.sx, r.sy, r.sw, r.sh, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  }

  async function pageSnip(anchor) {
    let frame = null;
    try {
      await twoFrames();   // let the button actually disappear before the screenshot
      frame = await capturePageFrame();
      const region = await selectRegion(frame);
      if (!region) return;
      const blob = await cropToBlob(frame, region);
      if (!blob) throw new Error('could not encode the snip');
      await deliver(blob, anchor);
    } finally {
      if (frame && frame.source && frame.source.close) frame.source.close();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Injection into the text box                                          */
  /* ------------------------------------------------------------------ */

  function focusEditable(node) {
    try { node.focus({ preventScroll: true }); } catch { try { node.focus(); } catch { /* ignore */ } }
    if (!node.isContentEditable) return;
    const s = getSelection();
    if (!s) return;
    if (s.rangeCount && node.contains(s.getRangeAt(0).commonAncestorContainer)) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    s.removeAllRanges();
    s.addRange(range);
  }

  function dataTransferWith(file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    return dt;
  }

  /* Each try* returns true when the page called preventDefault — i.e. it took the image. */
  function tryPaste(node, file) {
    let ev;
    try {
      ev = new ClipboardEvent('paste', {
        clipboardData: dataTransferWith(file),
        bubbles: true, cancelable: true, composed: true
      });
    } catch { return false; }
    if (!ev.clipboardData || !ev.clipboardData.files.length) return false;
    return node.dispatchEvent(ev) === false;
  }

  function tryDrop(node, file) {
    const r = node.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const dt = dataTransferWith(file);
    const mk = (type) => new DragEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      dataTransfer: dt, clientX: cx, clientY: cy
    });
    let accepted = false;
    for (const type of ['dragenter', 'dragover']) {
      if (node.dispatchEvent(mk(type)) === false) accepted = true;
    }
    const dropped = node.dispatchEvent(mk('drop')) === false;
    return dropped || accepted;
  }

  function tryFileInput(node, file) {
    const scopes = [
      node.closest('form'),
      node.closest('[class*="composer" i],[class*="compose" i],[class*="chat" i],[class*="input" i]'),
      document
    ];
    const seen = new Set();
    for (const scope of scopes) {
      if (!scope) continue;
      for (const input of scope.querySelectorAll('input[type="file"]')) {
        if (seen.has(input) || input.disabled) continue;
        seen.add(input);
        const accept = (input.getAttribute('accept') || '').toLowerCase();
        if (accept && !/image|\*|png/.test(accept)) continue;
        try {
          input.files = dataTransferWith(file).files;
          input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          return true;
        } catch { /* some inputs refuse assignment */ }
      }
    }
    return false;
  }

  async function copyToClipboard(blob) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return true;
    } catch { return false; }
  }

  async function deliver(blob, anchor) {
    const file = new File([blob], 'snip-' + Date.now() + '.png', { type: 'image/png', lastModified: Date.now() });

    let node = (anchor && anchor.isConnected) ? anchor : null;
    if (!node) {
      node = editableFrom(document.activeElement)
        || ((lastEditable && lastEditable.isConnected) ? lastEditable : null)
        || findBestEditable();
    }
    if (!node) {
      toast('Snipped — it is on your clipboard, press Ctrl+V in a text box');
      return;
    }

    focusEditable(node);
    await raf();

    if (tryPaste(node, file)) { toast('Pasted'); return; }
    if (tryDrop(node, file)) { toast('Pasted'); return; }
    if (tryFileInput(node, file)) { toast('Attached'); return; }

    if (await copyToClipboard(blob)) toast('Copied to clipboard — press Ctrl+V to paste');
    else toast('This box did not accept the image');
  }

  /* ------------------------------------------------------------------ */
  /* Toast                                                                */
  /* ------------------------------------------------------------------ */

  const TOAST_CSS = `
    :host { all: initial; }
    .t { position: fixed; left: 50%; bottom: 28px; transform: translate(-50%, 8px);
         padding: 9px 15px; border-radius: 999px; background: rgba(18,18,24,.94); color: #f4f4f5;
         font: 500 12.5px/1.4 ui-sans-serif, system-ui, -apple-system, sans-serif;
         border: 1px solid rgba(255,255,255,.14); box-shadow: 0 8px 26px rgba(0,0,0,.42);
         opacity: 0; transition: opacity .16s, transform .16s; white-space: nowrap; max-width: 90vw; }
    .t.show { opacity: 1; transform: translate(-50%, 0); }
  `;

  let toastHost = null, toastBody = null, toastTimer = 0;

  function toast(text, ms = 2400) {
    if (!toastHost || !toastHost.isConnected) {
      toastHost = el('div');
      toastHost.setAttribute('data-snippaste', 'toast');
      toastHost.style.cssText = 'position:fixed;inset:auto 0 0 0;pointer-events:none;z-index:' + (Z + 20) + ';';
      const root = toastHost.attachShadow({ mode: 'closed' });
      applyStyles(root, TOAST_CSS);
      toastBody = el('div', 't');
      root.appendChild(toastBody);
      (document.body || document.documentElement).appendChild(toastHost);
    }
    toastBody.textContent = text;
    requestAnimationFrame(() => toastBody.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastBody.classList.remove('show');
      setTimeout(() => { if (toastHost) { toastHost.remove(); toastHost = null; } }, 250);
    }, ms);
  }

  /* ------------------------------------------------------------------ */
  /* Orchestration                                                        */
  /* ------------------------------------------------------------------ */

  async function startSnip() {
    if (snipping) return;
    snipping = true;

    /* Remember the destination now — the snip overlay takes focus next. */
    const anchor = ((target && target.isConnected) ? target : null)
      || editableFrom(document.activeElement)
      || ((lastEditable && lastEditable.isConnected) ? lastEditable : null)
      || findBestEditable();

    setHostVisible(false);
    if (toastHost) { toastHost.remove(); toastHost = null; }

    try {
      const res = await sendMsg({ type: 'nativeSnip' });

      if (res.dataUrl) {
        await deliver(dataUrlToBlob(res.dataUrl), anchor);
        return;
      }
      if (res.error === 'cancelled') return;          // user pressed Esc in the overlay
      if (res.error === 'no-host') {
        toast('Desktop helper not installed — snipping this page instead', 3200);
        await pageSnip(anchor);
        return;
      }
      toast('Snip failed: ' + res.error);
    } catch (e) {
      console.warn('[SnipPaste] snip failed', e);
      toast('Snip failed: ' + ((e && e.message) || e));
    } finally {
      snipping = false;
      setHostVisible(true);
      lastRectKey = '';
      refreshButton();
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'startSnip') {
      startSnip();
      sendResponse({ ok: true });
    }
    return false;
  });
})();
