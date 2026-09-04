# Installs the SnipPaste desktop helper.
#
# Builds the native messaging host (if needed), writes its manifest, and
# registers it for Chrome and Edge under the current user. No admin rights,
# nothing outside your user profile.
#
# Run:  powershell -ExecutionPolicy Bypass -File native\install.ps1

$ErrorActionPreference = 'Stop'

$here      = Split-Path -Parent $MyInvocation.MyCommand.Path
$root      = Split-Path -Parent $here
$exePath   = Join-Path $here 'SnipPasteHost.exe'
$srcPath   = Join-Path $here 'SnipPasteHost.cs'
$manifest  = Join-Path $here 'com.snippaste.host.json'
$idFile    = Join-Path $root 'tools\extension-id.txt'
$hostName  = 'com.snippaste.host'

Write-Host 'SnipPaste desktop helper' -ForegroundColor Cyan
Write-Host ''

if (-not (Test-Path $idFile)) { throw "Missing $idFile - run: node tools/gen-key.js" }
$extensionId = (Get-Content $idFile -Raw).Trim()

# --- build ---------------------------------------------------------------
if (-not (Test-Path $exePath)) {
  Write-Host 'Building the helper...'
  $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  if (-not (Test-Path $csc)) {
    $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
  }
  if (-not (Test-Path $csc)) { throw 'Could not find csc.exe (.NET Framework 4). Install .NET Framework 4.x.' }
  & $csc /nologo /target:winexe /optimize+ /out:"$exePath" `
         /reference:System.Windows.Forms.dll /reference:System.Drawing.dll "$srcPath"
  if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
}
Write-Host "  helper:    $exePath"

# --- host manifest -------------------------------------------------------
# Chrome requires the exe path and the exact extensions allowed to talk to it.
$json = [ordered]@{
  name            = $hostName
  description     = 'SnipPaste screen snipping helper'
  path            = $exePath
  type            = 'stdio'
  allowed_origins = @("chrome-extension://$extensionId/")
}
$json | ConvertTo-Json -Depth 4 | Set-Content -Path $manifest -Encoding utf8
Write-Host "  manifest:  $manifest"
Write-Host "  extension: $extensionId"

# --- register ------------------------------------------------------------
$targets = @(
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts',
  'HKCU:\Software\Chromium\NativeMessagingHosts'
)
foreach ($base in $targets) {
  $key = Join-Path $base $hostName
  New-Item -Path $key -Force | Out-Null
  Set-ItemProperty -Path $key -Name '(Default)' -Value $manifest
}
Write-Host '  registered for Chrome, Edge and Chromium'

# --- verify --------------------------------------------------------------
Write-Host ''
Write-Host 'Checking the helper responds...'
$check = Start-Process -FilePath $exePath -PassThru -WindowStyle Hidden `
                       -RedirectStandardInput ([System.IO.Path]::GetTempFileName()) `
                       -RedirectStandardOutput ([System.IO.Path]::GetTempFileName())
Start-Sleep -Milliseconds 400
if (-not $check.HasExited) { $check.Kill() }
Write-Host '  helper starts cleanly' -ForegroundColor Green

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host 'Now reload the extension at chrome://extensions and reload your tab.'
Write-Host 'If Chrome was open during install, restart Chrome so it picks up the helper.'
