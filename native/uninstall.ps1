# Removes the SnipPaste desktop helper registration.
# Run:  powershell -ExecutionPolicy Bypass -File native\uninstall.ps1

$ErrorActionPreference = 'Stop'
$hostName = 'com.snippaste.host'

$targets = @(
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts',
  'HKCU:\Software\Chromium\NativeMessagingHosts'
)

foreach ($base in $targets) {
  $key = Join-Path $base $hostName
  if (Test-Path $key) {
    Remove-Item -Path $key -Recurse -Force
    Write-Host "removed $key"
  }
}

Write-Host 'Helper unregistered. The extension falls back to snipping the page.'
Write-Host "Delete native\SnipPasteHost.exe too if you want it gone entirely."
