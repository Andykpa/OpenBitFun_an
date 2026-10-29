<#
.SYNOPSIS
  Follow upstream OpenBitFun into this fork without losing the fork delta.
.DESCRIPTION
  scripts/check-mobile-architecture.mjs already fails on pristine upstream code
  (FORK.md section 8), so this script does NOT demand a green gate. It measures
  the violations on the *upstream tag itself* and then requires that the rebased
  fork tree adds none - that is the honest bar for a fork.

  Default is dry-run: it reports what would move and stops. -Rebase does the move,
  and it always creates a backup ref first.
.PARAMETER To
  Upstream tag to follow, e.g. v1.0.8.
.PARAMETER Rebase
  Replay the fork commits onto that tag.
.EXAMPLE
  .\.fork\sync-upstream.ps1 -To v1.0.8
  .\.fork\sync-upstream.ps1 -To v1.0.8 -Rebase
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$To,
  [switch]$Rebase,
  [string]$ToolsRoot = 'D:\software\qwnpawagent\tools',
  [string]$CacheRoot = 'D:\software\qwnpawagent\tools\_dl\fork-cache'
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$branch = (git -C $repo rev-parse --abbrev-ref HEAD)
$env:GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o ConnectTimeout=20'
$env:PATH = ((Join-Path $ToolsRoot 'node') + ';' + $env:PATH)

# The checker prints one "actual:" line per failing rule holding a JSON array.
# Parse that as JSON - string munging here would silently under-count.
function Get-GateViolations([string]$workTree) {
  Push-Location $workTree
  try {
    $out = cmd /c 'node scripts/check-mobile-architecture.mjs 2>&1'
    $all = [System.Collections.Generic.List[string]]::new()
    foreach ($l in $out) {
      $s = "$l".Trim()
      if ($s -notlike 'actual:*') { continue }
      $json = ($s -replace '^actual:\s*', '')
      if (-not $json -or $json -eq '[]') { continue }
      try { foreach ($v in ($json | ConvertFrom-Json)) { $all.Add("$v") } }
      catch { throw "could not parse gate output as JSON: $json" }
    }
    return , @($all | Sort-Object -Unique)
  }
  finally { Pop-Location }
}

function Resolve-UpstreamRemote {
  $remotes = @(git -C $repo remote)
  if ($remotes -contains 'upstream') { return 'upstream' }
  if ($remotes -contains 'origin') { return 'origin' }
  throw 'no upstream remote configured'
}

Write-Host "[sync] repo   = $repo"
Write-Host "[sync] branch = $branch"

$up = Resolve-UpstreamRemote
Write-Host "[sync] remote = $up"
git -C $repo fetch --tags --force $up "refs/tags/${To}:refs/tags/${To}" 2>&1 |
  ForEach-Object { "$_".Trim() } | Where-Object { $_ } | Select-Object -Last 2
if ($LASTEXITCODE -or -not (git -C $repo rev-parse --verify -q "refs/tags/$To")) { throw "fetch of tag $To failed" }
Write-Host "[sync] upstream $To = $(git -C $repo rev-parse --short $To)"

# --- what would move -------------------------------------------------------
$mergeBase = (git -C $repo merge-base HEAD $To)
if (-not $mergeBase) {
  throw 'no common ancestor with the target tag - history went shallow again; run: git fetch --unshallow ' + $up
}
$shortBase = git -C $repo rev-parse --short $mergeBase
$behind = [int](git -C $repo rev-list --count "$mergeBase..$To")
$forkCount = [int](git -C $repo rev-list --count "$mergeBase..HEAD")
Write-Host "[sync] merge-base = $shortBase ; upstream commits we lack = $behind ; our commits = $forkCount"
Write-Host ''
Write-Host '[sync] our private delta that must survive the replay:'
git -C $repo --no-pager log --oneline "$mergeBase..HEAD" | ForEach-Object { "         $_" }
Write-Host ''
Write-Host '[sync] upstream changes under src/apps/mobile:'
$stat = (git -C $repo --no-pager diff --stat "$mergeBase" "$To" -- src/apps/mobile) 2>&1
if ($stat) { $stat | ForEach-Object { "         $_" } } else { Write-Host '         (none)' }
Write-Host ''
Write-Host '[sync] upstream changes to files we touched (conflict forecast):'
foreach ($f in @(git -C $repo diff --name-only "$mergeBase" HEAD)) {
  $d = (git -C $repo diff --name-only "$mergeBase" $To -- $f) 2>&1
  if ($d) { Write-Host "         CONFLICT RISK: $f" }
}

if (-not $Rebase) {
  Write-Host "[sync] DRY RUN - nothing moved. Re-run with -Rebase."
  exit 0
}

# --- refuse a dirty tree --------------------------------------------------
$porcelain = (git -C $repo status --porcelain) 2>&1
if ($porcelain) { throw "working tree is dirty; commit or stash first.`n$($porcelain -join "`n")" }

# --- measure the upstream gate baseline (cached per tag) ------------------
New-Item -ItemType Directory -Force -Path $CacheRoot | Out-Null
$cache = Join-Path $CacheRoot "gate-$To.json"
$baseline = $null
if (Test-Path $cache) {
  $baseline = @((Get-Content $cache -Raw | ConvertFrom-Json))
  Write-Host "[sync] upstream gate baseline for $To from cache: $($baseline.Count)"
}
else {
  $wt = Join-Path $CacheRoot "wt-$To"
  if (Test-Path $wt) { git -C $repo worktree remove --force $wt 2>&1 | Out-Null }
  git -C $repo worktree add --detach $wt $To 2>&1 | ForEach-Object { "$_".Trim() } | Select-Object -Last 1
  Write-Host '[sync] measuring gate violations on the pristine upstream tree ...'
  $baseline = @(Get-GateViolations $wt)
  Write-Host "[sync] upstream baseline = $($baseline.Count) violations"
  @($baseline) | ConvertTo-Json -Compress | Set-Content $cache -Encoding ascii
  git -C $repo worktree remove --force $wt 2>&1 | Out-Null
  git -C $repo worktree prune 2>&1 | Out-Null
}

# --- backup ref, then rebase ----------------------------------------------
$backup = "backup/$branch-$(Get-Date -Format yyyyMMddHHmmss)"
git -C $repo branch $backup HEAD 2>&1 | Out-Null
Write-Host "[sync] backup ref: $backup"
git -C $repo rebase --onto $To $mergeBase $branch 2>&1 | ForEach-Object { "$_".Trim() } | Select-Object -Last 12
if ($LASTEXITCODE) {
  Write-Host ''
  Write-Host '[sync] REBASE STOPPED ON CONFLICT. Resolve, then:  git rebase --continue'
  Write-Host "[sync] Or abandon and return exactly here:  git rebase --abort"
  Write-Host "[sync] Pre-sync branch is preserved at ref: $backup"
  exit 1
}
Write-Host "[sync] rebased onto $To ; head = $(git -C $repo rev-parse --short HEAD)"

# --- verify: no NEW gate violations --------------------------------------
Write-Host '[sync] re-checking the gate on the rebased fork tree ...'
$after = @(Get-GateViolations $repo)
$new = @($after | Where-Object { $baseline -notcontains $_ })
Write-Host "[sync] violations upstream=$($baseline.Count) fork=$($after.Count) new=$($new.Count)"
if ($new.Count -gt 0) {
  Write-Host '[sync] NEW violations introduced by the fork delta:'
  $new | ForEach-Object { "         $_" }
  throw 'the fork must not add architecture violations: fix the delta, or document it in FORK.md section 8 with a reason'
}
Write-Host '[sync] gate parity OK (no new architecture violations).'
Write-Host '[sync] private delta after replay:'
git -C $repo --no-pager log --oneline "$To..HEAD" | ForEach-Object { "         $_" }
Write-Host ''
Write-Host '[sync] DONE. Now: 1) build a release with a NEW -Build index, 2) adb install -r.'
Write-Host '[sync] Remember: if upstream bumped protocol 2 -> 3, your old desktop stops being controllable.'
