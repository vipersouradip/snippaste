# Builds SnipPaste.apk with nothing but the Android SDK build-tools and a JDK.
#
# The app deliberately has no third-party dependencies, so there is no need for
# Gradle, an AAR resolver, or Android Studio: compile resources, compile Java,
# dex it, align it, sign it.
#
# Point these at your own copies if they live elsewhere:
#   $env:JAVA_HOME    - a JDK 17
#   $env:ANDROID_HOME - an SDK with platforms/android-34 and build-tools/34.0.0
#
# Run:  powershell -ExecutionPolicy Bypass -File android\build.ps1

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out  = Join-Path $here 'build'

if (-not $env:JAVA_HOME)    { throw 'Set JAVA_HOME to a JDK 17 install.' }
if (-not $env:ANDROID_HOME) { throw 'Set ANDROID_HOME to your Android SDK.' }

$jdk         = $env:JAVA_HOME
$sdk         = $env:ANDROID_HOME
$buildTools  = Join-Path $sdk 'build-tools\34.0.0'
$androidJar  = Join-Path $sdk 'platforms\android-34\android.jar'

foreach ($p in @($jdk, $buildTools, $androidJar)) {
  if (-not (Test-Path $p)) { throw "Missing: $p" }
}

$aapt2    = Join-Path $buildTools 'aapt2.exe'
$d8       = Join-Path $buildTools 'd8.bat'
$zipalign = Join-Path $buildTools 'zipalign.exe'
$apksigner= Join-Path $buildTools 'apksigner.bat'
$javac    = Join-Path $jdk 'bin\javac.exe'
$jar      = Join-Path $jdk 'bin\jar.exe'
$keytool  = Join-Path $jdk 'bin\keytool.exe'

Remove-Item -Recurse -Force $out -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path "$out\res","$out\gen","$out\classes","$out\dex" | Out-Null

# --- 1. compile resources -------------------------------------------------
Write-Host '[1/6] compiling resources'
$resFiles = Get-ChildItem -Path (Join-Path $here 'res') -Recurse -File
& $aapt2 compile -o "$out\res" $resFiles.FullName
if ($LASTEXITCODE -ne 0) { throw 'aapt2 compile failed' }

# --- 2. link into a resources-only APK, generating R.java ------------------
Write-Host '[2/6] linking resources'
$flat = Get-ChildItem "$out\res" -Filter *.flat | ForEach-Object { $_.FullName }
& $aapt2 link -o "$out\base.apk" `
    -I $androidJar `
    --manifest (Join-Path $here 'AndroidManifest.xml') `
    --java "$out\gen" `
    --min-sdk-version 26 --target-sdk-version 34 `
    $flat
if ($LASTEXITCODE -ne 0) { throw 'aapt2 link failed' }

# --- 3. compile Java ------------------------------------------------------
Write-Host '[3/6] compiling java'
$sources = @()
$sources += (Get-ChildItem (Join-Path $here 'java') -Recurse -Filter *.java | ForEach-Object { $_.FullName })
$sources += (Get-ChildItem "$out\gen" -Recurse -Filter R.java | ForEach-Object { $_.FullName })
& $javac -nowarn -source 8 -target 8 -encoding UTF-8 `
    -bootclasspath $androidJar -classpath $androidJar `
    -d "$out\classes" $sources
if ($LASTEXITCODE -ne 0) { throw 'javac failed' }

# --- 4. dex ---------------------------------------------------------------
Write-Host '[4/6] dexing'
$classes = Get-ChildItem "$out\classes" -Recurse -Filter *.class | ForEach-Object { $_.FullName }
& $d8 --min-api 26 --lib $androidJar --output "$out\dex" $classes
if ($LASTEXITCODE -ne 0) { throw 'd8 failed' }

# --- 5. package -----------------------------------------------------------
Write-Host '[5/6] packaging'
Copy-Item "$out\base.apk" "$out\unsigned.apk" -Force
Push-Location "$out\dex"
& $jar uf "$out\unsigned.apk" classes.dex
$jarExit = $LASTEXITCODE
Pop-Location
if ($jarExit -ne 0) { throw 'adding classes.dex failed' }

& $zipalign -f -p 4 "$out\unsigned.apk" "$out\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw 'zipalign failed' }

# --- 6. sign --------------------------------------------------------------
Write-Host '[6/6] signing'
$keystore = Join-Path $here 'debug.keystore'
if (-not (Test-Path $keystore)) {
  & $keytool -genkeypair -v -keystore $keystore -storepass android -keypass android `
      -alias snippaste -keyalg RSA -keysize 2048 -validity 10000 `
      -dname 'CN=SnipPaste, OU=Dev, O=SnipPaste, L=NA, S=NA, C=NA' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'keytool failed' }
}

$apk = Join-Path $here 'SnipPaste.apk'
& $apksigner sign --ks $keystore --ks-pass pass:android --key-pass pass:android `
    --out $apk "$out\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw 'apksigner failed' }

& $apksigner verify --print-certs $apk | Select-Object -First 2

$size = [math]::Round((Get-Item $apk).Length / 1KB, 1)
Write-Host ''
Write-Host "Built $apk ($size KB)" -ForegroundColor Green
