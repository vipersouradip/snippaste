/* SnipPaste — service worker.

   Talks to the desktop helper, which opens the operating system's own snipping
   overlay and hands back a PNG. Also keeps the in-page screenshot as a fallback
   for when the helper is not installed.                                       */

const HOST_NAME = 'com.snippaste.host';
const SNIP_TIMEOUT_MS = 120000;
const CAPTURE_RETRY_MS = 260;

/* ------------------------------------------------------------------ */
/* Desktop helper                                                      */
/* ------------------------------------------------------------------ */

/* One request per connection: connect, ask, collect chunks, disconnect.
   Chrome caps a host message at 1 MB, so the PNG arrives in pieces. */
function callHost(request, timeoutMs) {
  return new Promise((resolve) => {
    let port = null;
    let settled = false;
    const parts = [];

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (port) port.disconnect(); } catch { /* already gone */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish({ error: 'timeout' }), timeoutMs);

    try {
      port = chrome.runtime.connectNative(HOST_NAME);
    } catch {
      return finish({ error: 'no-host' });
    }

    port.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === 'chunk') { parts[msg.seq] = msg.data; return; }
      if (msg.type === 'done') return finish({ dataUrl: 'data:image/png;base64,' + parts.join('') });
      if (msg.type === 'pong') return finish({ pong: true, version: msg.version });
      if (msg.type === 'error') return finish({ error: msg.message });
    });

    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      const message = (err && err.message) || '';
      // "Specified native messaging host not found" / manifest problems.
      finish({ error: /not found|forbidden|manifest|access/i.test(message) ? 'no-host' : 'disconnected' });
    });

    port.postMessage(request);
  });
}

/* ------------------------------------------------------------------ */
/* In-page fallback screenshot                                         */
/* ------------------------------------------------------------------ */

function captureTab(windowId) {
  return new Promise((resolve) => {
    const attempt = (triesLeft) => {
      chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, (dataUrl) => {
        const err = chrome.runtime.lastError;
        if (!err && dataUrl) return resolve({ dataUrl });
        // captureVisibleTab is capped around 2 calls/sec; back off and retry.
        if (triesLeft > 0) return setTimeout(() => attempt(triesLeft - 1), CAPTURE_RETRY_MS);
        resolve({ error: (err && err.message) || 'Screenshot failed' });
      });
    };
    attempt(2);
  });
}

/* ------------------------------------------------------------------ */
/* Messaging                                                           */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return undefined;

  if (msg.type === 'nativeSnip') {
    callHost({ cmd: 'snip', timeoutMs: SNIP_TIMEOUT_MS - 10000 }, SNIP_TIMEOUT_MS).then(sendResponse);
    return true;
  }

  if (msg.type === 'hostStatus') {
    callHost({ cmd: 'ping' }, 4000).then(sendResponse);
    return true;
  }

  if (msg.type === 'captureTab') {
    if (!sender.tab) return undefined;
    captureTab(sender.tab.windowId).then(sendResponse);
    return true;
  }

  return undefined;
});

chrome.commands.onCommand.addListener(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'startSnip' });
  } catch {
    /* No content script on this page (chrome://, web store, PDF viewer...). */
  }
});
