<#
  AIWFF one-click installer v1 (fresh mode). PS 5.1 compatible, no admin needed.
  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Name demo
    install.ps1 -Mode assess          # hook only (2nd cut)
  Switches:
    -Root <dir>        default C:\AIWFF-<Name>; normalized to a full path (/ and \ both ok)
    -UseSystemTools    use node/git/npm already on PATH instead of portable downloads
    -SkipAutostart     never register the logon scheduled task, no prompt (wins over -Unattended)
    -Unattended        no prompts; autostart is ON unless -SkipAutostart or -NoStart
    -NoBrowser         do not open WebUI at the end
    -NoStart           do not register the task and do not start the runtime; implies -NoBrowser
                       (launcher start-runtime.cmd is still written; doctor still runs)
    -DryRun            print the plan for this exact switch combination, change nothing
  Autostart (A ruling a2b-20261006_071621-ee11afda): asked at install time, default Yes
  (plain Enter = on); user-level logon trigger only, never requires admin.
  A session that cannot answer that prompt (not user-interactive, stdin redirected, or
  Read-Host unavailable) aborts with exit 2 before anything is created: add -Unattended
  or -SkipAutostart there.
  Exit codes: 0 ok | 1 install error | 2 non-interactive without -Unattended/-SkipAutostart
              3 assess not implemented | 4 installed, but runtime/doctor health check failed
  Token: generated into suite\aiwff-runtime\.env as AIWFF_RUNTIME_TOKEN (never printed).
  Login: the runtime started by this script has stdout redirected to logs\runtime.log, so it
         prints only a masked link there and writes the full link to
         suite\aiwff-runtime\data\webui_login_url.txt. This script reads that file (it never
         builds ?token= itself), probes the link once, and opens it so the WebUI is already
         logged in. The token is not one-time: opening or pre-fetching the link does not use
         it up. With -NoStart, or if the link cannot be used, one line says how to open it.
#>
param(
  [ValidateSet('fresh','assess')][string]$Mode = 'fresh',
  [string]$Name = $env:USERNAME,
  [string]$Root = '',
  [switch]$UseSystemTools,
  [switch]$SkipAutostart,
  [switch]$Unattended,
  [switch]$NoBrowser,
  [switch]$NoStart,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$GH      = 'https://github.com/zaxardery8011-design'
# Upstream origin/master is canonical; its README lists exactly these three repos.
$REPOS   = @('aiwff-runtime','soplint','execution-proofs')
# Official sources only, versions pinned (A ruling a2b-20261006_071321-03eb0713).
# Node: the zip must match BOTH the pinned $NODE_SHA and its line in the official
# SHASUMS256.txt. GitHub release hashes are pinned from the official publications
# (git-for-windows release notes, PowerShell hashes.sha256).
$NODE_V   = 'v22.16.0'
$NODE_URL = "https://nodejs.org/dist/$NODE_V/node-$NODE_V-win-x64.zip"
$NODE_SUMS = "https://nodejs.org/dist/$NODE_V/SHASUMS256.txt"
$NODE_SHA = '21c2d9735c80b8f86dab19305aa6a9f6f59bbc808f68de3eef09d5832e3bfbbd'
$GIT_URL  = 'https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/MinGit-2.47.1-64-bit.zip'
$GIT_SHA  = '50b04b55425b5c465d076cdb184f63a0cd0f86f6ec8bb4d5860114a713d2c29a'
$PWSH_URL = 'https://github.com/PowerShell/PowerShell/releases/download/v7.4.6/PowerShell-7.4.6-win-x64.zip'
$PWSH_SHA = 'ed49ce5adb2162cc4a835d740486be729ba904627cca71fcb6c2b95be11b993d'
$PORT = 3100   # overridden by PORT= in .env

$Done = @()
function Step($m) { Write-Host "[install] $m" }
function Ok($m)   { $script:Done += $m; Write-Host "[ ok    ] $m" -ForegroundColor Green }

# Native exes (git / npm / node) run with a function-local $ErrorActionPreference of
# 'Continue': under PS 5.1 a stderr line becomes a terminating error when the caller
# redirects 2>&1. Success is judged only by the exit code, which is returned.
function Invoke-Native([string]$Exe, [string[]]$ArgList) {
  $ErrorActionPreference = 'Continue'
  if (-not (Get-Command $Exe -ErrorAction SilentlyContinue)) { throw "command not found: $Exe" }
  & $Exe @ArgList | Out-Host
  return $LASTEXITCODE
}

# Git never waits for credentials: GIT_TERMINAL_PROMPT=0, GCM_INTERACTIVE=never and an
# empty credential.helper make a missing or private repo fail fast instead of prompting.
# GIT_ASKPASS / SSH_ASKPASS (set by e.g. the VS Code terminal) and core.askPass are
# cleared too, otherwise git would still pop an askpass dialog.
# All env vars are restored afterwards so the caller's session is left as it was.
function Invoke-Git([string[]]$GitArgs) {
  $saved = @($env:GIT_TERMINAL_PROMPT, $env:GCM_INTERACTIVE, $env:GIT_ASKPASS, $env:SSH_ASKPASS)
  $env:GIT_TERMINAL_PROMPT = '0'; $env:GCM_INTERACTIVE = 'never'
  $env:GIT_ASKPASS = $null; $env:SSH_ASKPASS = $null
  try { return (Invoke-Native $gitExe (@('-c', 'credential.helper=', '-c', 'core.askPass=') + $GitArgs)) }
  finally {
    $env:GIT_TERMINAL_PROMPT = $saved[0]; $env:GCM_INTERACTIVE = $saved[1]
    $env:GIT_ASKPASS = $saved[2]; $env:SSH_ASKPASS = $saved[3]
  }
}

if ($Mode -eq 'assess') {
  # 2nd cut: scan an existing brain (memory / rules / hooks / schedules) and emit a
  # borrow-or-reinstall report. Interface must align with the public healthcheck tool.
  Write-Host 'assess mode: not implemented in v1 (hook reserved, see scripts/healthcheck.js)'
  exit 3
}

if (-not $Name) { $Name = 'default' }
$safe = ($Name -replace '[^A-Za-z0-9_-]','')
if (-not $safe) { $safe = 'default' }
if (-not $Root) { $Root = "C:\AIWFF-$safe" }
# Full path against the current PowerShell location; mixed / and \ become \.
$Root = [IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Root))
if ($Root.Length -gt 3) { $Root = $Root.TrimEnd('\') }
$Tools = Join-Path $Root 'tools'
$Dirs  = @('suite','node\inbox','node\outbox','docs','logs','backup','tools')

# Autostart decision, before anything is created: -SkipAutostart / -NoStart = off, no
# prompt; -Unattended = on; otherwise ask, Enter = Yes. A session that cannot answer the
# prompt aborts with exit 2 instead of silently taking the default.
$Autostart = -not ($SkipAutostart -or $NoStart)
$askAutostart = -not ($SkipAutostart -or $NoStart -or $Unattended)
$noTty = ''
if ($askAutostart) {
  if (-not [Environment]::UserInteractive) { $noTty = 'session is not user-interactive' }
  elseif ([Console]::IsInputRedirected) { $noTty = 'stdin is redirected' }
}
if ($askAutostart -and -not $DryRun) {
  $ans = ''
  if (-not $noTty) {
    try { $ans = Read-Host 'Start AIWFF automatically when you sign in? [Y/n]' }
    catch { $noTty = "Read-Host failed: $($_.Exception.Message)" }
  }
  if ($noTty) {
    Write-Host "[abort  ] non-interactive install: please add -Unattended or -SkipAutostart ($noTty)" -ForegroundColor Red
    exit 2
  }
  if ($ans -match '^\s*(n|no)\s*$') { $Autostart = $false }
}
if ($NoStart) { $NoBrowser = [switch]$true }   # -NoStart implies -NoBrowser

$autoTxt = if ($askAutostart -and $DryRun) { 'ask(Enter=Yes)' } else { "$Autostart" }
$toolTxt = if ($UseSystemTools) { 'system' } else { 'portable' }
Step "mode=fresh name=$safe root=$Root autostart=$autoTxt nostart=$([bool]$NoStart) browser=$(-not $NoBrowser) tools=$toolTxt"
if ($DryRun) {
  if ($askAutostart -and $noTty) {
    Step "would ABORT with exit 2 before creating anything: non-interactive session ($noTty); add -Unattended or -SkipAutostart"
    exit 2
  }
  if ($askAutostart) { Step 'would ask: Start AIWFF automatically when you sign in? [Y/n] (Enter = Yes)' }
  Step "would create under ${Root}: $($Dirs -join ', ')"
  if ($UseSystemTools) { Step 'would use node / git / npm.cmd found on PATH (no downloads)' }
  else { Step "would download unless already complete (sha256-verified, abort on mismatch): $NODE_URL ; $GIT_URL ; $PWSH_URL" }
  Step "would clone into suite\ (pull --ff-only if present; never prompts for credentials): $($REPOS -join ', ') (only aiwff-runtime is required)"
  Step 'would install deps: npm ci where package-lock.json exists, else npm install --no-package-lock; npm run build in execution-proofs'
  Step 'would write suite\aiwff-runtime\.env from .env.example with a generated AIWFF_RUNTIME_TOKEN (an existing .env is kept)'
  Step "would write launcher $Root\start-runtime.cmd"
  if ($NoStart) {
    Step 'would NOT register a task, NOT start the runtime, NOT open a browser (-NoStart); run doctor; print one line saying how to start it and open the login link later'
  } else {
    if ($askAutostart) { Step "on Yes: register scheduled task AIWFF_Runtime_$safe (user logon, no admin, retry 3x/1min) and start it; on No: start the runtime in background for this session only" }
    elseif ($Autostart) { Step "would register scheduled task AIWFF_Runtime_$safe (user logon, no admin, retry 3x/1min) and start it" }
    else { Step 'would NOT register a task (-SkipAutostart); start the runtime in background for this session only' }
    $tail = if ($NoBrowser) { 'no browser (print how to open the login link later)' } else { 'open WebUI with the login link the runtime writes to suite\aiwff-runtime\data\webui_login_url.txt (probed first, token not printed)' }
    Step "would wait up to 20s for /api/health, then run doctor; $tail"
  }
  exit 0
}

# 1. framework folders
foreach ($d in $Dirs) { New-Item -ItemType Directory -Force -Path (Join-Path $Root $d) | Out-Null }
Ok 'framework folders'

# 2. portable tools (no UAC)
# PS 5.1 progress bar makes Invoke-WebRequest tens of times slower.
$ProgressPreference = 'SilentlyContinue'
# Download to "$dest.zip", verify sha256, extract to "$dest.partial", rename to $dest only
# on success; any failure removes the .zip and the .partial. An existing $dest without its
# key executable ($probe, relative to $dest, wildcards ok) is a broken earlier extract:
# it is removed and fetched again.
function Get-Portable($url, $dest, $sha, $probe) {
  if (Test-Path -LiteralPath $dest) {
    if (Test-Path -Path (Join-Path $dest $probe)) { return }
    Write-Warning "$dest has no $probe (broken earlier extract): removing and fetching again"
    Remove-Item -LiteralPath $dest -Recurse -Force
  }
  $zip = "$dest.zip"; $part = "$dest.partial"
  try {
    Remove-Item -LiteralPath $zip, $part -Recurse -Force -ErrorAction SilentlyContinue
    Step "download $url"
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip
    $got = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLower()
    if ($got -ne $sha.ToLower()) { throw "SHA256 mismatch for $url (expected $sha, got $got)" }
    Ok "sha256 verified $(Split-Path $url -Leaf)"
    Expand-Archive -LiteralPath $zip -DestinationPath $part -Force
    if (-not (Test-Path -Path (Join-Path $part $probe))) { throw "extracted $(Split-Path $url -Leaf) has no $probe" }
    Rename-Item -LiteralPath $part -NewName (Split-Path $dest -Leaf)
  } finally {
    Remove-Item -LiteralPath $zip, $part -Recurse -Force -ErrorAction SilentlyContinue
  }
}
function Get-NodeSha {
  $leaf = Split-Path $NODE_URL -Leaf
  $sums = (Invoke-WebRequest -UseBasicParsing -Uri $NODE_SUMS).Content -split "`n"
  $line = $sums | Where-Object { $_ -match "^([0-9a-f]{64})\s+$([regex]::Escape($leaf))\s*$" } | Select-Object -First 1
  if (-not $line) { throw "no SHA256 for $leaf in $NODE_SUMS" }
  $official = ($line -split '\s+')[0].ToLower()
  if ($official -ne $NODE_SHA) { throw "Node SHA256 disagreement: pinned $NODE_SHA, official $NODE_SUMS says $official; aborting" }
  return $NODE_SHA
}
if ($UseSystemTools) {
  $nodeExe = (Get-Command node -ErrorAction Stop).Source
  $gitExe  = (Get-Command git  -ErrorAction Stop).Source
  $npmCmd  = (Get-Command npm.cmd -ErrorAction Stop).Source
} else {
  if (-not (Test-Path -Path (Join-Path $Tools 'node\*\node.exe'))) { Get-Portable $NODE_URL (Join-Path $Tools 'node') (Get-NodeSha) '*\node.exe' }
  Get-Portable $GIT_URL  (Join-Path $Tools 'git')  $GIT_SHA  'cmd\git.exe'
  Get-Portable $PWSH_URL (Join-Path $Tools 'pwsh') $PWSH_SHA 'pwsh.exe'
  $nodeDir = Get-ChildItem (Join-Path $Tools 'node') -Directory | Select-Object -First 1
  $nodeExe = Join-Path $nodeDir.FullName 'node.exe'
  $npmCmd  = Join-Path $nodeDir.FullName 'npm.cmd'
  $gitExe  = Join-Path $Tools 'git\cmd\git.exe'
  $env:PATH = "$($nodeDir.FullName);$(Join-Path $Tools 'git\cmd');$(Join-Path $Tools 'pwsh');$env:PATH"
}
Ok "node=$nodeExe git=$gitExe"

# 3. repos
# aiwff-runtime is required; the others are optional (warn and continue if unreachable).
$suite = Join-Path $Root 'suite'
$gotRepos = @(); $missRepos = @()
foreach ($r in $REPOS) {
  $dst = Join-Path $suite $r
  if (Test-Path (Join-Path $dst '.git')) { $rc = Invoke-Git @('-C', $dst, 'pull', '--ff-only', '-q') }
  else { $rc = Invoke-Git @('clone', '-q', '--depth', '1', "$GH/$r.git", $dst) }
  if ($rc -ne 0) {
    if ($r -eq 'aiwff-runtime') { throw "git failed for $r (exit $rc)" }
    Write-Warning "git failed for $r (exit $rc; optional, skipped)"
    $missRepos += $r
  } else { $gotRepos += $r }
}
Ok "repos: $($gotRepos -join ', ')"
if ($missRepos.Count) { Write-Warning "repos skipped: $($missRepos -join ', ')" }

# 4. deps / build
# Lockfile policy: npm ci where the repo ships package-lock.json (never rewrites it);
# otherwise npm install --no-package-lock (leaves no untracked lockfile behind).
function Install-Deps($dir) {
  $how = @(if (Test-Path (Join-Path $dir 'package-lock.json')) { 'ci' } else { 'install', '--no-package-lock' })
  Push-Location $dir
  try { $rc = Invoke-Native $npmCmd ($how + @('--no-audit', '--no-fund', '--loglevel=error')) }
  finally { Pop-Location }
  if ($rc -ne 0) { throw "npm $($how -join ' ') failed in $dir (exit $rc)" }
}
$rt = Join-Path $suite 'aiwff-runtime'
Install-Deps $rt
$ep = Join-Path $suite 'execution-proofs'
if (Test-Path (Join-Path $ep 'package.json')) {
  Install-Deps $ep
  $pkg = Get-Content -LiteralPath (Join-Path $ep 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($pkg.scripts -and $pkg.scripts.build) {
    Push-Location $ep
    try { $rc = Invoke-Native $npmCmd @('run', 'build', '--loglevel=error') }
    finally { Pop-Location }
    if ($rc -ne 0) { throw "npm run build failed in $ep (exit $rc)" }
  }
}
Ok 'dependencies'

# 5. .env from .env.example with a generated AIWFF_RUNTIME_TOKEN (never overwrite an
# existing .env). Read and written as UTF-8 (no BOM) so the Chinese comments survive.
$envFile = Join-Path $rt '.env'
$envExample = Join-Path $rt '.env.example'
if (-not (Test-Path -LiteralPath $envFile)) {
  $bytes = New-Object byte[] 24
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $token = ([BitConverter]::ToString($bytes) -replace '-','').ToLower()
  $lines = @()
  if (Test-Path -LiteralPath $envExample) { $lines = @(Get-Content -LiteralPath $envExample -Encoding UTF8) }
  $tokenSet = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^\s*AIWFF_RUNTIME_TOKEN\s*=') { $lines[$i] = "AIWFF_RUNTIME_TOKEN=$token"; $tokenSet = $true; break }
  }
  if (-not $tokenSet) { $lines += "AIWFF_RUNTIME_TOKEN=$token" }
  [IO.File]::WriteAllLines($envFile, [string[]]$lines, (New-Object Text.UTF8Encoding $false))
  Ok '.env written (AIWFF_RUNTIME_TOKEN generated, not printed)'
} else { Ok '.env exists, kept' }
$pl = Get-Content -LiteralPath $envFile -Encoding UTF8 | Where-Object { $_ -match '^PORT=\d+' } | Select-Object -First 1
if ($pl) { $PORT = [int]($pl -replace '^PORT=','') }

# 6. autostart (user-level logon task, no admin)
$taskName = "AIWFF_Runtime_$safe"
$launcher = Join-Path $Root 'start-runtime.cmd'
[IO.File]::WriteAllText($launcher, "@echo off`r`ncd /d `"$rt`"`r`nset PATH=$(Split-Path $nodeExe);%PATH%`r`n`"$npmCmd`" run start >> `"$Root\logs\runtime.log`" 2>&1`r`n")
if ($NoStart) {
  Step "nostart: task not registered, runtime not started (launcher: $launcher)"
} elseif ($Autostart) {
  $act = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$launcher`""
  $trg = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $set = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries
  $prn = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -Action $act -Trigger $trg -Settings $set -Principal $prn -Force | Out-Null
  Ok "scheduled task $taskName (logon, retry 3x/1min)"
  Start-ScheduledTask -TaskName $taskName
} else {
  Step 'autostart skipped; starting runtime in background for this session'
  Start-Process -FilePath 'cmd.exe' -ArgumentList "/c `"$launcher`"" -WindowStyle Hidden
}

# Login link. With stdout redirected (the launcher appends to logs\runtime.log) the runtime
# prints only a masked link and writes the full one to data\webui_login_url.txt; this reads
# that file and never builds ?token= itself. The token is not one-time: the runtime keeps
# accepting it (until restart, or for good with a fixed AIWFF_RUNTIME_TOKEN), so a browser or
# antivirus pre-fetch cannot use it up. The link is still probed before it is opened, because
# the file can be stale (an older runtime wrote it, or a restart made a new token): a 302
# means the runtime accepts it, a 401 means it does not. Returns the link or '' (reason in
# $script:LoginWhy, which never contains the token). The link itself is never printed.
$loginFile = Join-Path $rt 'data\webui_login_url.txt'
$reopen = 'Start-Process (Get-Content -LiteralPath ''' + ($loginFile -replace "'", "''") + ''' -TotalCount 1)'
function Get-LoginLink([string]$File, [int]$Port) {
  $script:LoginWhy = ''
  for ($try = 1; $try -le 4; $try++) {
    if ($try -gt 1) { Start-Sleep -Milliseconds 500 }
    if (-not (Test-Path -LiteralPath $File)) { $script:LoginWhy = 'the runtime has not written its login link file'; continue }
    $url = ''
    $first = Get-Content -LiteralPath $File -Encoding UTF8 -TotalCount 1
    if ($first) { $url = "$first".Trim() }
    if ($url -notmatch "^http://127\.0\.0\.1:$Port/\?token=[A-Za-z0-9%._~-]+$") { $script:LoginWhy = 'the login link file does not hold a link for this port'; continue }
    $resp = $null
    try {
      $req = [Net.HttpWebRequest]::Create($url)
      $req.AllowAutoRedirect = $false; $req.Timeout = 3000; $req.Proxy = $null
      $resp = $req.GetResponse()
    } catch [Net.WebException] { $resp = $_.Exception.Response } catch { $resp = $null }
    if (-not $resp) { $script:LoginWhy = 'the runtime did not answer the login link'; continue }
    $code = [int]$resp.StatusCode
    $resp.Close()
    if ($code -eq 302) { return $url }
    $script:LoginWhy = "the runtime rejected the login link in the file (HTTP $code; stale file from an earlier start?)"
  }
  return ''
}

# 7. health: poll /api/health (no fixed sleep), doctor only once the runtime answers, WebUI
$health = ''   # empty = healthy; otherwise the reason for exit 4
if (-not $NoStart) {
  $hurl = "http://127.0.0.1:$PORT/api/health"
  $up = $false
  $deadline = (Get-Date).AddSeconds(20)
  while (-not $up -and (Get-Date) -lt $deadline) {
    try { $up = ((Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri $hurl).StatusCode -eq 200) } catch { }
    if (-not $up) { Start-Sleep -Milliseconds 500 }
  }
  if ($up) { Ok "runtime answers $hurl" }
  else { $health = "runtime did not answer $hurl within 20s (see $Root\logs\runtime.log)" }
}
if (-not $health) {
  Push-Location $rt
  try { $doc = Invoke-Native $nodeExe @('scripts\doctor.js') }
  finally { Pop-Location }
  Step "doctor exit=$doc"
  if ($doc -eq 0) { Ok 'doctor' }
  else { $health = "doctor exit=$doc (see its output above; details: cd `"$rt`" ; npm run doctor -- --json)" }
}
Step "completed: $($Done -join ' | ')"
$tokLine = Get-Content $envFile -Encoding UTF8 | Where-Object { $_ -match '^AIWFF_RUNTIME_TOKEN=' } | Select-Object -First 1
if ($tokLine -and ($tokLine -replace '^AIWFF_RUNTIME_TOKEN=', '').Trim()) {
  Step "token: in $envFile as AIWFF_RUNTIME_TOKEN (value not printed); the runtime saves its ready-to-click login link in $loginFile"
} else {
  Write-Warning "AIWFF_RUNTIME_TOKEN in $envFile is empty: the runtime will make a new token on every start and rewrite $loginFile each time. Set a fixed value in .env to keep one token."
}
if ($health) {
  Write-Host "[FAILED ] installed, but the health check failed: $health" -ForegroundColor Red
  exit 4
}
if ($NoStart) {
  Step "nostart: the runtime is not running, so there is no login link yet; to use the WebUI run `"$launcher`", wait a few seconds, then in PowerShell: $reopen"
} elseif ($NoBrowser) {
  Step "browser not opened (-NoBrowser); to open the WebUI already logged in, in PowerShell: $reopen"
} else {
  $link = Get-LoginLink $loginFile $PORT
  if ($link) {
    Start-Process $link
    Ok 'WebUI opened already logged in (login link not printed)'
    Step "to open it again later (a closed browser forgets the login), in PowerShell: $reopen"
  } else {
    Write-Warning "no usable login link ($script:LoginWhy). Opening the WebUI without login (the chat tab cannot create tasks). To log in once the runtime is up, in PowerShell: $reopen"
    Start-Process "http://127.0.0.1:$PORT/"
  }
}
Ok "done. root=$Root"
