# Packages both downloads and refreshes the homepage's file details.
#
#   site/downloads/SnipPaste-windows.zip   extension + native helper source
#   (no apk - Android is still "coming soon" on the page)
#   site/downloads.js                      sizes, hashes and versions for the page
#
# Run:  powershell -ExecutionPolicy Bypass -File tools\build-site.ps1

$ErrorActionPreference = 'Stop'

$here      = Split-Path -Parent $MyInvocation.MyCommand.Path
$root      = Split-Path -Parent $here
$site      = Join-Path $root 'site'
$downloads = Join-Path $site 'downloads'
$staging   = Join-Path $env:TEMP ("snippaste-pkg-" + [guid]::NewGuid().ToString('N'))

New-Item -ItemType Directory -Force -Path $downloads | Out-Null
New-Item -ItemType Directory -Force -Path "$staging\snippaste" | Out-Null

$extensionVersion = (Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json).version

Write-Host "Packaging SnipPaste $extensionVersion" -ForegroundColor Cyan

# --- Windows zip ----------------------------------------------------------
# The private signing key and the debug keystore must never ship.
Copy-Item (Join-Path $root 'manifest.json') "$staging\snippaste\" -Force
Copy-Item (Join-Path $root 'src')   "$staging\snippaste\src"   -Recurse -Force
Copy-Item (Join-Path $root 'icons') "$staging\snippaste\icons" -Recurse -Force

New-Item -ItemType Directory -Force -Path "$staging\snippaste\native","$staging\snippaste\tools" | Out-Null
foreach ($f in @('SnipPasteHost.cs', 'install.ps1', 'uninstall.ps1')) {
  Copy-Item (Join-Path $root "native\$f") "$staging\snippaste\native\" -Force
}
# install.ps1 reads this to allowlist the extension with the native host.
Copy-Item (Join-Path $root 'tools\extension-id.txt') "$staging\snippaste\tools\" -Force

@"
SnipPaste for Windows $extensionVersion
=======================================

1. Load the extension
   - Open  chrome://extensions
   - Turn on "Developer mode" (top right)
   - Click "Load unpacked" and pick this snippaste folder

2. Install the desktop helper
   - Right-click  native\install.ps1  and choose "Run with PowerShell"
   - Restart Chrome afterwards

The helper is what opens the Windows snipping overlay; Chrome cannot do that
on its own. It is compiled on your machine from native\SnipPasteHost.cs, so
nothing unsigned is downloaded. It registers only for your user account.

To remove it later: native\uninstall.ps1

Then hover any text box, click the snip button, and drag.
"@ | Set-Content "$staging\snippaste\INSTALL.txt" -Encoding utf8

$zip = Join-Path $downloads 'SnipPaste-windows.zip'
Remove-Item $zip -Force -ErrorAction SilentlyContinue
Compress-Archive -Path "$staging\snippaste" -DestinationPath $zip -CompressionLevel Optimal
Remove-Item -Recurse -Force $staging

# Guard against ever shipping the signing key.
$leaked = [System.IO.Compression.ZipFile]::OpenRead($zip).Entries |
          Where-Object { $_.FullName -match '\.pem$|\.keystore$' }
if ($leaked) { throw "Refusing to ship: $($leaked.FullName)" }

# --- Android apk ----------------------------------------------------------
# The page says "coming soon", so the apk is deliberately not published: an
# untested build sitting behind a live download link is worse than no link.
# Restore the copy below once the page offers Android for real.
$apk = Join-Path $downloads 'SnipPaste.apk'
Remove-Item $apk -Force -ErrorAction SilentlyContinue

# --- details for the page -------------------------------------------------
function FileInfo($path) {
  if (-not (Test-Path $path)) { return $null }
  $item = Get-Item $path
  [pscustomobject]@{
    name   = $item.Name
    size   = "{0:N1} KB" -f ($item.Length / 1KB)
    sha256 = (Get-FileHash $path -Algorithm SHA256).Hash.ToLower()
    built  = $item.LastWriteTime.ToString('yyyy-MM-dd')
  }
}

$info = [ordered]@{
  windows = [ordered]@{ version = $extensionVersion; file = (FileInfo $zip) }
}

"window.SNIPPASTE = " + ($info | ConvertTo-Json -Depth 5) + ";" |
  Set-Content (Join-Path $site 'downloads.js') -Encoding utf8

Write-Host ''
foreach ($key in $info.Keys) {
  $f = $info[$key].file
  if ($f) { Write-Host ("  {0,-8} {1,-28} {2,10}" -f $key, $f.name, $f.size) }
}
Write-Host ''
Write-Host "Site ready: $site" -ForegroundColor Green
