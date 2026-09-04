const DEFAULTS = { showButton: true };

const showButton = document.getElementById('showButton');

chrome.storage.sync.get(DEFAULTS, (v) => {
  showButton.checked = !!{ ...DEFAULTS, ...v }.showButton;
});

showButton.addEventListener('change', () => {
  chrome.storage.sync.set({ showButton: showButton.checked });
});

/* Ask the desktop helper whether it is there, and show the one-line installer
   (with this checkout's real path) when it is not. */
const dot = document.getElementById('dot');
const statusText = document.getElementById('statusText');
const install = document.getElementById('install');
const cmd = document.getElementById('cmd');

/* Deliberately not an absolute path: every install lives somewhere different,
   and the helper panel is only ever visible before the helper exists. */
cmd.textContent = 'Right-click native\install.ps1 → Run with PowerShell';

chrome.runtime.sendMessage({ type: 'hostStatus' }, (res) => {
  if (chrome.runtime.lastError || !res) return;
  if (res.pong) {
    dot.className = 'dot ok';
    statusText.textContent = 'Desktop helper ready (v' + res.version + ')';
    install.classList.remove('show');
  } else {
    dot.className = 'dot bad';
    statusText.textContent = res.error === 'no-host'
      ? 'Desktop helper not installed'
      : 'Desktop helper problem: ' + res.error;
    install.classList.add('show');
  }
});

document.getElementById('copy').addEventListener('click', () => {
  navigator.clipboard.writeText(cmd.textContent).then(() => {
    const button = document.getElementById('copy');
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = 'Copy'; }, 1400);
  }, () => { /* clipboard blocked; the text is selectable anyway */ });
});

document.getElementById('shortcuts').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});
