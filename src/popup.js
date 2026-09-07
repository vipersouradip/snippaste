const DEFAULTS = { showButton: true };

const showButton = document.getElementById('showButton');
const switchWrap = document.getElementById('switchWrap');

chrome.storage.sync.get(DEFAULTS, (v) => {
  const on = !!{ ...DEFAULTS, ...v }.showButton;
  showButton.checked = on;
  switchWrap.classList.toggle('on', on);
});

showButton.addEventListener('change', () => {
  switchWrap.classList.toggle('on', showButton.checked);
  chrome.storage.sync.set({ showButton: showButton.checked });
});

/* Ask the desktop helper whether it is there, and show the one-line installer
   (with this checkout's real path) when it is not. */
const dot = document.getElementById('dot');
const statusText = document.getElementById('statusText');
const statusSub = document.getElementById('statusSub');
const statusCard = document.getElementById('statusCard');
const statusIcon = document.getElementById('statusIcon');
const install = document.getElementById('install');
const cmd = document.getElementById('cmd');

/* Deliberately not an absolute path: every install lives somewhere different,
   and the helper panel is only ever visible before the helper exists. */
cmd.textContent = 'Right-click native\\install.ps1 → Run with PowerShell';

const okIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg>';
const badIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>';
const idleIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';

chrome.runtime.sendMessage({ type: 'hostStatus' }, (res) => {
  if (chrome.runtime.lastError || !res) {
    dot.className = 'dot';
    statusText.textContent = 'Checking helper…';
    statusSub.textContent = 'Unable to reach helper';
    statusIcon.innerHTML = idleIcon;
    return;
  }
  if (res.pong) {
    dot.className = 'dot ok';
    statusCard.className = 'status-card ok';
    statusIcon.innerHTML = okIcon;
    statusText.textContent = 'Desktop helper ready';
    statusSub.textContent = 'v' + res.version + ' · snips the whole screen';
    install.classList.remove('show');
  } else {
    dot.className = 'dot bad';
    statusCard.className = 'status-card bad';
    statusIcon.innerHTML = badIcon;
    statusText.textContent = res.error === 'no-host'
      ? 'Desktop helper not installed'
      : 'Desktop helper issue';
    statusSub.textContent = res.error === 'no-host'
      ? 'One-time PowerShell step below'
      : res.error;
    install.classList.add('show');
  }
});

document.getElementById('copy').addEventListener('click', () => {
  const btn = document.getElementById('copy');
  const label = btn.querySelector('span');
  navigator.clipboard.writeText(cmd.textContent).then(() => {
    btn.classList.add('copied');
    const prev = label.textContent;
    label.textContent = 'Copied ✓';
    setTimeout(() => { label.textContent = prev; btn.classList.remove('copied'); }, 1400);
  }, () => { /* clipboard blocked; the text is selectable anyway */ });
});

document.getElementById('shortcuts').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});
