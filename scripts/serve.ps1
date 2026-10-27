# Windows equivalent of `make serve`: builds the Studio and serves it at http://127.0.0.1:8000 with APK export enabled.
# It looks for the Android SDK, a JDK that Gradle 8 can run on (17-23) and a local Gradle 8.x, and sets the variables
# the backend reads (ANDROID_HOME, JAVA_HOME, GRADLE_BIN). Anything you already set yourself is kept.
#   .\scripts\serve.ps1            build the Studio, then serve
#   .\scripts\serve.ps1 -NoBuild   serve the last build
param([int]$Port = 8000, [switch]$NoBuild)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

function Get-JavaMajor([string]$home_) {
    $release = Join-Path $home_ 'release'
    if (-not (Test-Path $release)) { return 0 }
    $line = Select-String -Path $release -Pattern '^JAVA_VERSION="?(\d+)' | Select-Object -First 1
    if ($line) { return [int]$line.Matches[0].Groups[1].Value }
    return 0
}

function Test-JdkOk([string]$home_) {
    if (-not $home_ -or -not (Test-Path (Join-Path $home_ 'bin\java.exe'))) { return $false }
    $major = Get-JavaMajor $home_
    return ($major -ge 17 -and $major -le 23)
}

# --- Android SDK
if (-not $env:ANDROID_HOME -and -not $env:ANDROID_SDK_ROOT) {
    $sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
    if (Test-Path $sdk) { $env:ANDROID_HOME = $sdk }
}

# --- JDK 17-23 (newer JDKs make Gradle 8 fail)
if (-not (Test-JdkOk $env:JAVA_HOME)) {
    $candidates = @(
        Get-ChildItem (Join-Path $env:USERPROFILE '.jdks') -Directory -ErrorAction SilentlyContinue
        Get-ChildItem 'C:\Program Files\Java', 'C:\Program Files\Eclipse Adoptium', 'C:\Program Files\Microsoft' -Directory -ErrorAction SilentlyContinue
        Get-Item 'C:\Program Files\Android\Android Studio\jbr' -ErrorAction SilentlyContinue
    ) | Where-Object { $_ } | Where-Object { Test-JdkOk $_.FullName } | Sort-Object { Get-JavaMajor $_.FullName } -Descending
    $pick = $candidates | Select-Object -First 1
    if ($pick) { $env:JAVA_HOME = $pick.FullName }
}

# --- Gradle 8.x (the Android Gradle Plugin in android-template needs 8.7+, and is not compatible with Gradle 9)
if (-not $env:GRADLE_BIN -and -not (Get-Command gradle -ErrorAction SilentlyContinue)) {
    $dists = Join-Path $env:USERPROFILE '.gradle\wrapper\dists'
    $found = Get-ChildItem $dists -Recurse -Filter gradle.bat -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match 'gradle-8\.(\d+)' -and [int]$Matches[1] -ge 7 } |
        Sort-Object { [int]([regex]::Match($_.FullName, 'gradle-8\.(\d+)').Groups[1].Value) } -Descending | Select-Object -First 1
    if ($found) { $env:GRADLE_BIN = $found.FullName }
}

Write-Host "ANDROID_HOME = $env:ANDROID_HOME"
Write-Host "JAVA_HOME    = $env:JAVA_HOME"
Write-Host "GRADLE_BIN   = $env:GRADLE_BIN"
if (-not $env:ANDROID_HOME -or -not (Test-JdkOk $env:JAVA_HOME) -or (-not $env:GRADLE_BIN -and -not (Get-Command gradle -ErrorAction SilentlyContinue))) {
    Write-Warning 'APK export will report what is missing in the Studio Build tab (Android SDK, JDK 17-23, Gradle 8.7+). See README.'
}

if (-not $NoBuild) {
    Push-Location (Join-Path $root 'frontend')
    try { npm run build; if ($LASTEXITCODE) { throw 'Studio build failed' } } finally { Pop-Location }
}

Push-Location (Join-Path $root 'backend')
try { python -m uvicorn apppanrom.main:create_app --factory --host 127.0.0.1 --port $Port } finally { Pop-Location }
