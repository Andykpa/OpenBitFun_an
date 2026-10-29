<#
.SYNOPSIS
  Reproducible signed release build for this fork (see FORK.md).
.DESCRIPTION
  Encodes the rules FORK.md states, so a release cannot accidentally break
  upgrade compatibility:
    1. signing comes from ONE stable keystore outside the repository,
    2. versionCode is strictly monotonic and derived from the upstream version,
    3. the artifact is verified (apksigner + aapt2 + sha256) before it is recorded,
    4. every release is appended to a ledger outside the working tree, so a
       build never leaves the repo dirty and cannot block a rebase.
  Nothing sensitive is committed: the keystore and its password live outside
  the working tree and are read from disk here.
.PARAMETER Build
  Fork build index for the current upstream version, 1..99. Increment it for
  every artifact you ship; never reuse one.
.EXAMPLE
  .\.fork\build-release.ps1 -Build 1
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateRange(1, 99)][int]$Build,
  [switch]$AllowDirty,
  [string]$ToolsRoot = 'D:\software\qwnpawagent\tools',
  [string]$SigningRoot = 'D:\software\qwnpawagent\android-signing',
  [string]$OutDir = 'D:\software\qwnpawagent\android-apk'
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

# --- toolchain (portable; PATH is prefixed only for this process) -----------
$jdk = Join-Path $ToolsRoot 'jdk\corretto-21'
if (-not (Test-Path (Join-Path $jdk 'bin\java.exe'))) { throw "JDK missing at $jdk" }
$env:JAVA_HOME = $jdk
$env:PATH = (@(
  (Join-Path $jdk 'bin'),
  (Join-Path $ToolsRoot 'node'),
  (Join-Path $ToolsRoot 'npm-global')
) + $env:PATH) -join ';'

# --- fork version identity --------------------------------------------------
# code = major*1000000 + minor*10000 + patch*100 + build
# Monotonic across upstream bumps (1.0.7 b99 < 1.0.8 b1) so a shipped APK can
# always be installed over the previously installed one.
$upstreamVersion = (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
$parts = $upstreamVersion.Split('-')[0].Split('.')
if ($parts.Count -ne 3) { throw "unexpected upstream version '$upstreamVersion'" }
$code = ([int]$parts[0] * 1000000) + ([int]$parts[1] * 10000) + ([int]$parts[2] * 100) + $Build
$name = "$upstreamVersion-fork.$Build"
Write-Host "[fork] upstream=$upstreamVersion versionCode=$code versionName=$name"

# --- ledger path + fail-fast monotonic check -------------------------------
# Checked before anything is built: discovering a reused versionCode after a
# three-minute Gradle run wastes the whole run.
$ledger = Join-Path $OutDir 'releases.csv'
$prevMax = 0
if (Test-Path $ledger) {
  foreach ($r in Import-Csv $ledger) {
    $c = 0
    if ([int]::TryParse($r.version_code, [ref]$c) -and $c -gt $prevMax) { $prevMax = $c }
  }
  if ($code -le $prevMax) {
    throw "versionCode $code is not greater than the recorded max $prevMax for this upstream - bump -Build (and never reuse a shipped index)"
  }
}
Write-Host "[fork] monotonic OK: $code > $prevMax"

# --- tree must be clean, so an artifact maps to one committed revision ------
$porcelain = (git -C $repo status --porcelain) 2>&1
if ($porcelain -and -not $AllowDirty) {
  throw "working tree is dirty; commit the fork delta (or pass -AllowDirty for a throwaway build).`n$($porcelain -join "`n")"
}

# --- signing material (never in the repo) ----------------------------------
$keystore = Join-Path $SigningRoot 'fork-release.keystore'
$pwFile = Join-Path $SigningRoot 'fork-release.password'
foreach ($f in $keystore, $pwFile) { if (-not (Test-Path $f)) { throw "signing material missing: $f" } }
$pw = (Get-Content $pwFile -Raw).Trim()
$env:OPENBITFUN_ANDROID_KEYSTORE = $keystore
$env:OPENBITFUN_ANDROID_KEYSTORE_PASSWORD = $pw
$env:OPENBITFUN_ANDROID_KEY_ALIAS = 'forkrelease'
$env:OPENBITFUN_ANDROID_KEY_PASSWORD = $pw
$env:FORK_VERSION_CODE = "$code"
$env:FORK_VERSION_NAME = $name

# --- design-system artifacts the ui gate needs (both gitignored) -----------
$dt = Join-Path $repo 'design-system\packages\design-tokens'
$te = Join-Path $repo 'design-system\tooling\token-engine'
$th = Join-Path $repo 'design-system\packages\theme-openbitfun'
foreach ($p in @(
  @{ dir = $dt; links = @(@{ n = 'token-engine'; t = $te }) },
  @{ dir = $th; links = @(@{ n = 'design-tokens'; t = $dt }, @{ n = 'token-engine'; t = $te }) }
)) {
  foreach ($l in $p.links) {
    $link = Join-Path $p.dir "node_modules\@openbitfun\$($l.n)"
    if (-not (Test-Path $link)) {
      New-Item -ItemType Directory -Force -Path (Split-Path $link) | Out-Null
      New-Item -ItemType Junction -Path $link -Target $l.t | Out-Null
    }
  }
}
foreach ($b in @(@{ dir = $dt; out = 'dist\tokens.css' }, @{ dir = $th; out = 'dist\themes.css' })) {
  if (-not (Test-Path (Join-Path $b.dir $b.out))) {
    Push-Location $b.dir
    try {
      node scripts/build.mjs
      if ($LASTEXITCODE) { throw "design-system build failed in $($b.dir)" }
    }
    finally { Pop-Location }
  }
}

# --- gates: design-system drift is ours to keep clean ----------------------
Push-Location $repo
try {
  node scripts/mobile-ui-design-system.mjs --check
  if ($LASTEXITCODE) { throw 'mobile:ui drift gate failed - regenerate from the contract, never hand-edit generated tokens' }
}
finally { Pop-Location }

# --- build -----------------------------------------------------------------
$androidDir = Join-Path $repo 'src\apps\mobile\android'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$log = Join-Path $ToolsRoot '_dl\fork-release-build.log'
Push-Location $androidDir
try {
  cmd /c ".\gradlew.bat :app:assembleRelease --console=plain > `"$log`" 2>&1"
  if ($LASTEXITCODE) { Get-Content $log -Tail 40; throw "assembleRelease failed (exit $LASTEXITCODE); full log: $log" }
}
finally { Pop-Location }

$built = Join-Path $androidDir 'app\build\outputs\apk\release\app-release.apk'
$staged = Join-Path $OutDir "OpenBitFun-Fork-$name-android.apk"
Copy-Item $built $staged -Force

# --- verify: signature, identity, version ----------------------------------
$bat = (Get-ChildItem (Join-Path $ToolsRoot 'android\build-tools') -Recurse -Filter 'apksigner.bat' |
  Select-Object -First 1).FullName
$verifyOut = cmd /c "`"$bat`" verify --print-certs `"$staged`"" 2>&1
if ($LASTEXITCODE) { throw "apksigner verify failed: $($verifyOut -join ' ')" }
$dnLine = ($verifyOut | Select-String -Pattern 'certificate DN' | Select-Object -First 1).Line
$fprLine = ($verifyOut | Select-String -Pattern 'SHA-256 digest' | Select-Object -First 1).Line
if (-not $dnLine -or $dnLine -notmatch 'OpenBitFun Fork') {
  throw "release is NOT signed by the fork keystore (got: $dnLine). Refusing to record it."
}
$aapt = (Get-ChildItem (Join-Path $ToolsRoot 'android\build-tools') -Recurse -Filter 'aapt2.exe' |
  Select-Object -First 1).FullName
$badging = (cmd /c "`"$aapt`" dump badging `"$staged`"" 2>&1 | Select-String -Pattern 'versionCode=' | Select-Object -First 1).Line
if (-not $badging -or $badging -notmatch [regex]::Escape("versionCode='$code'")) {
  throw "versionCode in artifact is not $code : $badging"
}
$sha = (Get-FileHash $staged -Algorithm SHA256).Hash
$fp = ($fprLine -replace '.*digest:\s*', '').Trim()

# --- ledger append (path + monotonic guard already resolved above) ---------
$record = [pscustomobject]@{
  built_at_utc     = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  upstream_version = $upstreamVersion
  version_name     = $name
  version_code     = $code
  apk              = (Split-Path $staged -Leaf)
  size_bytes       = (Get-Item $staged).Length
  sha256           = $sha
  signer_sha256    = $fp
  git_head         = (git -C $repo rev-parse --short HEAD)
}
if (-not (Test-Path $ledger)) { $record | Export-Csv -Path $ledger -NoTypeInformation -Encoding utf8 }
else { $record | Export-Csv -Path $ledger -NoTypeInformation -Append -Encoding utf8 }

Write-Host ''
Write-Host '[fork] OK'
Write-Host "       apk      = $staged"
Write-Host "       identity = versionCode $code / versionName $name"
Write-Host "       sha256   = $sha"
Write-Host "       signer   = $fp"
Write-Host "       ledger   = $ledger"
