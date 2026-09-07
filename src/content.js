/* SnipPaste — content script.
   1. Anchors a small snip button to whatever text box the user is using.
   2. Click it: the desktop helper opens Windows' own snipping overlay.
   3. The returned PNG is injected into that text box automatically.
   Hovering the button first opens a menu of prompts ("Explain", "Answer", …);
   picking one snips as usual and types that prompt in alongside the image.

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
      position: fixed; width: 24px; height: 24px; border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      background: linear-gradient(135deg, #1A1A1E 0%, #2A2A30 100%);
      color: #fff; cursor: pointer;
      border: 1px solid rgba(255,255,255,.15);
      box-shadow: 0 2px 10px rgba(0,0,0,.28), 0 1px 2px rgba(0,0,0,.18), inset 0 1px 0 rgba(255,255,255,.10);
      opacity: .72; transition: opacity .16s, transform .16s, background .16s, box-shadow .16s, border-color .16s;
      pointer-events: auto; user-select: none;
      -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
    }
    .btn:hover { opacity: 1; transform: scale(1.08) translateY(-1px); background: linear-gradient(135deg, #6C5CFF 0%, #4F46E5 100%); border-color: rgba(255,255,255,.24); box-shadow: 0 6px 20px rgba(108,92,255,.42), 0 2px 8px rgba(0,0,0,.2); }
    .btn:active { transform: scale(.94); }
    .btn.hidden { display: none; }
    /* Laid out at all times so it can be measured before it is shown; hidden
       with visibility, which also keeps it out of elementFromPoint. */
    .menu {
      position: fixed; top: 0; left: 0; min-width: 192px; padding: 6px;
      border-radius: 14px; background: rgba(18,18,22,.94); color: #f4f4f5;
      border: 1px solid rgba(255,255,255,.11);
      box-shadow: 0 16px 40px rgba(0,0,0,.45), 0 4px 12px rgba(0,0,0,.22), inset 0 1px 0 rgba(255,255,255,.06);
      font: 500 12.5px/1.4 "Instrument Sans", ui-sans-serif, system-ui, -apple-system, sans-serif;
      -webkit-backdrop-filter: blur(16px) saturate(180%); backdrop-filter: blur(16px) saturate(180%);
      visibility: hidden; opacity: 0; pointer-events: none;
      transition: opacity .14s, transform .14s; transform: translateY(4px) scale(.98);
      overflow: hidden;
    }
    .menu.show { visibility: visible; opacity: 1; pointer-events: auto; transform: none; }
    .menu-head {
      padding: 6px 10px 8px; font-size: 10.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
      color: #9a9aa6; display: flex; align-items: center; gap: 6px;
    }
    .menu-head::before { content:''; width: 6px; height: 6px; border-radius: 50%; background: #6C5CFF; box-shadow: 0 0 0 3px rgba(108,92,255,.18); }
    .item {
      display: flex; align-items: center; gap: 9px; padding: 8px 10px; border-radius: 9px;
      cursor: pointer; white-space: nowrap; color: #e9e9ef; transition: background .12s, color .12s, transform .08s;
    }
    .item svg { flex: none; width: 16px; height: 16px; opacity: .9; }
    .item:hover { background: linear-gradient(135deg, #6C5CFF 0%, #5B4CF2 100%); color: #fff; transform: translateX(1px); }
    .item:active { transform: scale(.98); }
    .item.just { color: #a1a1aa; }
    .item.just:hover { color: #fff; }
    .sep { height: 1px; margin: 6px 6px; background: linear-gradient(90deg, transparent, rgba(255,255,255,.10), transparent); }
    .foot {
      padding: 8px 10px 4px; color: #8e8e9a;
      font: 500 11px/1.4 "Instrument Sans", ui-sans-serif, system-ui, -apple-system, sans-serif;
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
    }
    .foot b { color: #b9b4ff; font-weight: 700; background: rgba(108,92,255,.18); border: 1px solid rgba(108,92,255,.22); padding: 1px 5px; border-radius: 5px; font-size: 10.5px; }
  `;

  /* Picking one of these snips as usual, then types the prompt in with the image,
     so the whole thing goes off as one message. "Just snip" keeps the old behaviour. */
  const ACTIONS = [
    { label: 'Explain this', prompt: 'Explain this.' },
    { label: 'Answer this', prompt: 'Answer this.' },
    { label: 'Summarise this', prompt: 'Summarise this.' },
    { label: 'Translate to English', prompt: 'Translate this into English.' },
    { label: 'Extract the text', prompt: 'Transcribe all the text in this image.' },
    null,
    { label: 'Just snip', prompt: '' }
  ];

  let host = null, btn = null, menu = null;
  let menuOpen = false, menuTimer = 0;
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

    menu = el('div', 'menu');
    const head = el('div', 'menu-head');
    head.textContent = 'Snip with prompt';
    menu.appendChild(head);
    function svgEl(tag, attrs) {
      const n = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      return n;
    }
    function actionIcon(label) {
      const wrap = document.createElementNS(SVG_NS, 'svg');
      for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) wrap.setAttribute(k, v);
      const add = (tag, d) => wrap.appendChild(svgEl(tag, d));
      if (label.includes('Explain')) {
        add('circle', { cx: '12', cy: '12', r: '10' });
        add('path', { d: 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3' });
        add('path', { d: 'M12 17h.01' });
      } else if (label.includes('Answer')) {
        add('path', { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' });
      } else if (label.includes('Summarise')) {
        add('path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' });
        add('path', { d: 'M14 2v6h6' });
        add('path', { d: 'M10 13H8' });
        add('path', { d: 'M16 17H8' });
      } else if (label.includes('Translate')) {
        add('path', { d: 'M5 8h6' });
        add('path', { d: 'M4 6h8' });
        add('path', { d: 'M12 2a15.3 15.3 0 0 1 4 10a15.3 15.3 0 0 1-4 10a15.3 15.3 0 0 1-4-10a15.3 15.3 0 0 1 4-10z' });
      } else if (label.includes('Extract')) {
        add('path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' });
        add('path', { d: 'M14 2v6h6' });
        add('path', { d: 'M10 13H8' });
      } else if (label.includes('Just')) {
        add('rect', { x: '3', y: '3', width: '18', height: '18', rx: '2' });
        add('path', { d: 'M9 9h6v6H9z' });
      } else {
        add('circle', { cx: '12', cy: '12', r: '10' });
      }
      return wrap;
    }
    for (const action of ACTIONS) {
      if (!action) { menu.appendChild(el('div', 'sep')); continue; }
      const item = el('div', 'item');
      if (action.label === 'Just snip') item.classList.add('just');
      item.appendChild(actionIcon(action.label));
      const span = el('span');
      span.textContent = action.label;
      item.appendChild(span);
      item.setAttribute('role', 'button');
      // mousedown would blur the text box before we get to remember it.
      item.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
      item.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        closeMenu();
        startSnip(action.prompt);
      });
      menu.appendChild(item);
    }
    const foot = el('div', 'foot');
    const key = el('b');
    key.textContent = 'Alt+Shift+S';
    const footLabel = el('span');
    footLabel.textContent = 'Just snip';
    foot.append(footLabel, key);
    menu.appendChild(foot);

    btn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      closeMenu();
      startSnip();
    });
    btn.addEventListener('pointerenter', scheduleOpenMenu);
    btn.addEventListener('pointerleave', scheduleCloseMenu);
    menu.addEventListener('pointerenter', () => clearTimeout(menuTimer));
    menu.addEventListener('pointerleave', scheduleCloseMenu);

    root.append(btn, menu);
    (document.body || document.documentElement).appendChild(host);
  }

  function ensureButton() {
    if (!host || !host.isConnected) { host = null; buildButton(); }
  }

  const MENU_GAP = 6;

  /* Above the button when there is room, otherwise below; right edges aligned. */
  function positionMenu() {
    if (!menuOpen || !menu) return;
    const r = btn.getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let top = r.top - mh - MENU_GAP;
    if (top < 4) top = r.bottom + MENU_GAP;
    menu.style.top = Math.round(clamp(top, 4, Math.max(4, innerHeight - mh - 4))) + 'px';
    menu.style.left = Math.round(clamp(r.right - mw, 4, Math.max(4, innerWidth - mw - 4))) + 'px';
  }

  function openMenu() {
    clearTimeout(menuTimer);
    if (menuOpen || snipping || !menu || btn.classList.contains('hidden')) return;
    menuOpen = true;
    menu.classList.add('show');
    positionMenu();
  }

  function closeMenu() {
    clearTimeout(menuTimer);
    if (!menuOpen) return;
    menuOpen = false;
    menu.classList.remove('show');
  }

  function scheduleOpenMenu() {
    clearTimeout(menuTimer);
    menuTimer = setTimeout(openMenu, 130);
  }

  /* A grace period, so crossing the gap between button and menu does not close it. */
  function scheduleCloseMenu() {
    clearTimeout(menuTimer);
    menuTimer = setTimeout(closeMenu, 220);
  }

  function hideButton() {
    closeMenu();
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
    // ChatGPT's composer sits low inside its rounded frame (14px top padding) —
    // top+8 lands ~6px above the text and reads a little low; nudge up to 5px.
    const TOP_PAD = 5;
    const top = box.height < BTN_SIZE + BTN_PAD * 2
      ? box.top + (box.height - BTN_SIZE) / 2
      : box.top + TOP_PAD;

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
    positionMenu();
  }

  function track() {
    trackId = 0;
    if (!target || snipping) return;
    placeButton();
    if (target) trackId = requestAnimationFrame(track);
  }

  function refreshButton() {
    if (snipping) { setHostVisible(false); return; }
    // While the prompt menu is open the pointer is off the text box by design;
    // leave the button exactly where it is rather than hiding it out from under it.
    if (menuOpen) return;
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

  addEventListener('scroll', () => { lastRectKey = ''; closeMenu(); }, true);
  addEventListener('resize', () => { lastRectKey = ''; closeMenu(); refreshButton(); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); }, true);
  document.addEventListener('pointerdown', (e) => {
    if (host && e.composedPath && e.composedPath().includes(host)) return;
    closeMenu();
  }, true);

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
            font: 500 12px/1.4 "Instrument Sans", ui-sans-serif, system-ui, -apple-system, sans-serif; }
    .shot { position: fixed; inset: 0; }
    .scrim { position: fixed; inset: 0; background: rgba(8,8,14,.52); backdrop-filter: blur(1px); }
    .sel { position: fixed; display: none; background: transparent;
           box-shadow: 0 0 0 100vmax rgba(8,8,14,.52); outline: 1.5px solid #6C5CFF; border-radius: 2px; }
    .sel::after { content: ''; position: absolute; inset: 0; outline: 1px solid rgba(255,255,255,.75); border-radius: 1px; }
    .xh { position: fixed; background: linear-gradient(180deg, rgba(108,92,255,0), rgba(108,92,255,.55), rgba(108,92,255,0)); pointer-events: none; }
    .xh.v { top: 0; bottom: 0; width: 1px; background: linear-gradient(180deg, transparent, rgba(108,92,255,.5), transparent); }
    .xh.h { left: 0; right: 0; height: 1px; background: linear-gradient(90deg, transparent, rgba(108,92,255,.5), transparent); }
    .badge { position: fixed; display: none; padding: 4px 8px; border-radius: 8px;
             background: linear-gradient(135deg, #6C5CFF, #4F46E5); color: #fff; font: 600 11px "JetBrains Mono", monospace;
             font-variant-numeric: tabular-nums; letter-spacing: .02em;
             white-space: nowrap; box-shadow: 0 4px 14px rgba(108,92,255,.38), 0 2px 6px rgba(0,0,0,.22);
             border: 1px solid rgba(255,255,255,.14); }
    .loupe { position: fixed; width: 120px; height: 120px; border-radius: 14px; display: none;
             border: 1px solid rgba(255,255,255,.28); box-shadow: 0 12px 32px rgba(0,0,0,.48), 0 4px 12px rgba(0,0,0,.32), inset 0 1px 0 rgba(255,255,255,.10);
             pointer-events: none; background: #0b0b10; overflow: hidden; }
    .hint { position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
            padding: 9px 16px; border-radius: 999px; background: rgba(18,18,22,.92); color: #f4f4f5;
            border: 1px solid rgba(255,255,255,.12); box-shadow: 0 8px 28px rgba(0,0,0,.42), inset 0 1px 0 rgba(255,255,255,.06);
            -webkit-backdrop-filter: blur(16px) saturate(180%); backdrop-filter: blur(16px) saturate(180%); white-space: nowrap;
            font-size: 12.5px; display: flex; align-items: center; gap: 8px; }
    .hint b { color: #b9b4ff; background: rgba(108,92,255,.18); border: 1px solid rgba(108,92,255,.22); padding: 1px 6px; border-radius: 6px; font-size: 11px; }
    .hint.fade { opacity: 0; transform: translateX(-50%) translateY(-4px); transition: opacity .18s, transform .18s; }
  `;

  const LOUPE_SIZE = 120;
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

  async function pageSnip(anchor, prompt) {
    let frame = null;
    try {
      await twoFrames();   // let the button actually disappear before the screenshot
      frame = await capturePageFrame();
      const region = await selectRegion(frame);
      if (!region) return;
      const blob = await cropToBlob(frame, region);
      if (!blob) throw new Error('could not encode the snip');
      await deliver(blob, anchor, prompt);
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

  /* Types the chosen prompt into the composer next to the image.

     execCommand('insertText') goes through the browser's own editing pipeline, so
     React, ProseMirror and Lexical all see the beforeinput/input they expect —
     assigning .value or .textContent directly is what these composers ignore. */
  function insertPrompt(node, text) {
    if (!text) return false;
    focusEditable(node);

    const existing = node.isContentEditable ? node.textContent : node.value;
    const body = (existing && !/\s$/.test(existing)) ? ' ' + text : text;

    try { if (document.execCommand('insertText', false, body)) return true; } catch { /* not editable */ }

    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', body);
      const ev = new ClipboardEvent('paste', {
        clipboardData: dt, bubbles: true, cancelable: true, composed: true
      });
      if (node.dispatchEvent(ev) === false) return true;
    } catch { /* ClipboardEvent construction is blocked in some frames */ }

    if (!node.isContentEditable && 'value' in node) {
      const proto = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(node, (existing || '') + body);
      node.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      return true;
    }
    return false;
  }

  async function copyToClipboard(blob) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return true;
    } catch { return false; }
  }

  async function deliver(blob, anchor, prompt) {
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

    let how = null;
    if (tryPaste(node, file)) how = 'Pasted';
    else if (tryDrop(node, file)) how = 'Pasted';
    else if (tryFileInput(node, file)) how = 'Attached';

    if (!how) {
      insertPrompt(node, prompt);
      if (await copyToClipboard(blob)) toast('Copied to clipboard — press Ctrl+V to paste');
      else toast('This box did not accept the image');
      return;
    }

    /* Let the site finish turning the file into an attachment before typing,
       or the prompt lands in a box that is about to be re-rendered. */
    await twoFrames();
    if (insertPrompt(node, prompt)) toast(how + ' with your prompt');
    else toast(how);
  }

  /* ------------------------------------------------------------------ */
  /* Toast                                                                */
  /* ------------------------------------------------------------------ */

  const TOAST_CSS = `
    :host { all: initial; }
    .t { position: fixed; left: 50%; bottom: 28px; transform: translate(-50%, 10px) scale(.98);
         padding: 10px 16px; border-radius: 999px; background: rgba(18,18,22,.94); color: #f4f4f5;
         font: 500 13px/1.4 "Instrument Sans", ui-sans-serif, system-ui, -apple-system, sans-serif;
         border: 1px solid rgba(255,255,255,.12); box-shadow: 0 12px 32px rgba(0,0,0,.38), 0 4px 12px rgba(0,0,0,.22), inset 0 1px 0 rgba(255,255,255,.06);
         opacity: 0; transition: opacity .22s cubic-bezier(.2,.8,.2,1), transform .22s cubic-bezier(.2,.8,.2,1);
         white-space: nowrap; max-width: 90vw; display: flex; align-items: center; gap: 9px;
         -webkit-backdrop-filter: blur(16px) saturate(180%); backdrop-filter: blur(16px) saturate(180%); }
    .t::before { content:''; width: 22px; height: 22px; border-radius: 50%; flex: none;
                 background: linear-gradient(135deg, #6C5CFF, #4F46E5); display: block;
                 box-shadow: 0 2px 8px rgba(108,92,255,.4); }
    .t.show { opacity: 1; transform: translate(-50%, 0) scale(1); }
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

  async function startSnip(prompt) {
    if (snipping) return;
    snipping = true;
    closeMenu();

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
        await deliver(dataUrlToBlob(res.dataUrl), anchor, prompt);
        return;
      }
      if (res.error === 'cancelled') return;          // user pressed Esc in the overlay
      if (res.error === 'no-host') {
        toast('Desktop helper not installed — snipping this page instead', 3200);
        await pageSnip(anchor, prompt);
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
      startSnip(msg.prompt);
      sendResponse({ ok: true });
    }
    return false;
  });
})();
