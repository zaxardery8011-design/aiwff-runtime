<#
  AIWFF one-click installer v1 (fresh mode). PS 5.1 compatible, no admin needed.
  Keep this file pure ASCII: PS 5.1 reads a BOM-less script as ANSI. Chinese text lives in
  the Node scripts (connect-brain.js, first-reply.js, install-summary.js). The few lines that
  must print before Node exists go through [regex]::Unescape('\uXXXX'), which stays ASCII here.
  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1            # asks what it needs
    powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Name demo
    install.ps1 -Mode assess                  # hook only (2nd cut)
    install.ps1 -Mode uninstall -Root <dir>   # stop and unwire this Root; the data stays
    install.ps1 -Mode restart -Root <dir>     # restart this Root's runtime, e.g. after a new .env
  Switches:
    -Root <dir>        default C:\AIWFF-<Name>; normalized to a full path (/ and \ both ok)
    -Source <path|url> clone aiwff-runtime from here instead of GitHub; optional repos are skipped
    -Brain <b>         ask (default) | claude | ollama | mock, see "Brain" below
    -UseSystemTools    use node/git/npm already on PATH instead of portable downloads
    -SkipAutostart     never register the logon scheduled task and no autostart prompt; the brain
                       and Desktop prompts still come (wins over -Unattended)
    -Unattended        no prompts; autostart is ON unless -SkipAutostart or -NoStart
    -NoBrowser         do not open WebUI at the end
    -NoStart           do not register the task and do not start the runtime; implies -NoBrowser
                       (launcher start-runtime.cmd is still written; doctor still runs)
    -ConnectDesktop    connect to Claude Desktop without asking
    -ReplaceDesktop    same, and take over the aiwff entry when it points at another Root
    -NoDesktop         never touch Claude Desktop; with -Mode uninstall too (wins over -ConnectDesktop)
    -NoShortcut        no desktop shortcut (open-webui.cmd is still written)
    -DryRun            print the plan for this exact switch combination, change nothing
  Autostart (A ruling a2b-20261006_071621-ee11afda): asked at install time, default Yes
  (plain Enter = on); user-level logon trigger only, never requires admin.
  A session that cannot answer that prompt (not user-interactive, stdin redirected,
  powershell -NonInteractive, or Read-Host unavailable) aborts with exit 2 before anything
  is created: add -Unattended or -SkipAutostart there.
  Brain: a real brain spends the user's quota, so it needs a yes. -Unattended or a session
  that cannot answer stays on mock unless -Brain says otherwise; an existing .env is left
  alone unless -Brain is passed. With no one there, the first-reply check does not call the
  model on such a kept .env, and a named brain that bills the API is not called either.
  Claude Desktop: asked only when detected. -Unattended never connects without
  -ConnectDesktop: this changes another app's settings.
  Exit codes: 0 ok (mock included; the final screen says so) | 1 install error
              2 non-interactive without -Unattended/-SkipAutostart | 3 assess not implemented
              4 installed, but runtime/doctor health check failed
              5 installed, but the brain did not answer
  Token: generated into suite\aiwff-runtime\.env as AIWFF_RUNTIME_TOKEN (never printed);
         <Root>\open-webui.cmd and the desktop shortcut read it and open the login link.
  Permissions: a new Root is limited to this account, SYSTEM and Administrators. Under C:\ every
         signed-in account could otherwise read the token and change what runs at logon.
  Test overrides: AIWFF_DESKTOP_DIR replaces the user's Desktop folder.
#>
param(
  [ValidateSet('fresh','assess','uninstall','restart')][string]$Mode = 'fresh',
  [string]$Name = $env:USERNAME,
  [string]$Root = '',
  [string]$Source = '',
  [ValidateSet('ask','claude','ollama','mock')][string]$Brain = 'ask',
  [switch]$UseSystemTools,
  [switch]$SkipAutostart,
  [switch]$Unattended,
  [switch]$NoBrowser,
  [switch]$NoStart,
  [switch]$ConnectDesktop,
  [switch]$ReplaceDesktop,
  [switch]$NoDesktop,
  [switch]$NoShortcut,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Anything thrown below lands here: a first-time user should not get a PowerShell stack.
trap {
  Write-Host "[FAILED ] $($_.Exception.Message)" -ForegroundColor Red
  Write-Host ([regex]::Unescape('\u5b89\u88dd\u6c92\u6709\u5b8c\u6210\u3002\u6700\u5e38\u898b\u7684\u539f\u56e0\u662f\u7db2\u8def\u65b7\u4e86\uff1a\u518d\u8cbc\u4e00\u6b21\u540c\u4e00\u884c\uff0c\u6703\u5f9e\u65b7\u6389\u7684\u5730\u65b9\u63a5\u8457\u88dd\u3002'))
  exit 1
}

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

function Step($m) { Write-Host "[install] $m" }
function Ok($m)   { Write-Host "[ ok    ] $m" -ForegroundColor Green }

# Native exes (git / npm / node) run with a function-local $ErrorActionPreference of
# 'Continue': under PS 5.1 a stderr line becomes a terminating error when the caller
# redirects 2>&1. Success is judged only by the exit code, which is returned.
function Invoke-Native([string]$Exe, [string[]]$ArgList) {
  $ErrorActionPreference = 'Continue'
  if (-not (Get-Command $Exe -ErrorAction SilentlyContinue)) { throw "command not found: $Exe" }
  & $Exe @ArgList | Out-Host
  return $LASTEXITCODE
}

# Same exit-code rule, but the output goes to a log file instead of the screen.
function Invoke-Logged([string]$Exe, [string[]]$ArgList, [string]$Log) {
  $ErrorActionPreference = 'Continue'
  & $Exe @ArgList 2>&1 | ForEach-Object { "$_" } | Out-File -LiteralPath $Log -Append -Encoding utf8
  return $LASTEXITCODE
}

# The Node scripts print Chinese and must own the console: the Out-Host pipe above decodes
# their UTF-8 with the console code page and shows mojibake. Start-Process -NoNewWindow
# inherits the console, stdin included, so their prompts work too.
function Invoke-Console([string]$Exe, [string[]]$ArgList) {
  $quoted = $ArgList | ForEach-Object { '"' + ($_ -replace '(\\+)$', '$1$1') + '"' }
  return (Start-Process -FilePath $Exe -ArgumentList ($quoted -join ' ') -NoNewWindow -Wait -PassThru).ExitCode
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

# First non-empty value of a key in .env, the same rule as loadDotEnv in agent/index.js.
function Get-EnvValue([string]$Key) {
  if (-not (Test-Path -LiteralPath $envFile)) { return '' }
  foreach ($line in (Get-Content -LiteralPath $envFile -Encoding UTF8)) {
    if ($line -match "^\s*$Key=(.*)$") {
      $value = $Matches[1].Trim() -replace '^[''"]|[''"]$', ''
      if ($value) { return $value }
    }
  }
  return ''
}

function Read-Port {
  $value = Get-EnvValue 'PORT'
  if ($value -match '^\d+$') { $script:PORT = [int]$value }
}

function Test-PortOpen {
  $client = New-Object Net.Sockets.TcpClient
  try { return $client.ConnectAsync('127.0.0.1', $PORT).Wait(1000) }
  catch { return $false }
  finally { $client.Close() }
}

function Get-HealthPid {
  try { return [int]((Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri "http://127.0.0.1:$PORT/api/health").Content | ConvertFrom-Json).pid }
  catch { return 0 }
}

function Test-OwnToken {
  $token = Get-EnvValue 'AIWFF_RUNTIME_TOKEN'
  if (-not $token) { return $false }
  try {
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Headers @{ 'x-aiwff-runtime-token' = $token } -Uri "http://127.0.0.1:$PORT/api/bots" | Out-Null
    return $true
  } catch { return $false }
}

# The processes of this Root, children first. Only the launcher's cmd.exe has the Root on its
# command line: the node that listens is a bare "node agent/index.js", same as any other
# runtime on this machine, so never match on that text. Walk down from the launcher, and from
# a runtime that accepts this Root's token (covers a launcher that is already gone).
# CreationDate guards against a reused parent pid.
function Get-RootProcess {
  $all = @(Get-CimInstance Win32_Process)
  $pattern = '(?i)/c\s+"*' + [regex]::Escape($launcher) + '"*\s*"*\s*$'
  $seeds = @($all | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -match $pattern })
  $healthPid = Get-HealthPid
  if ($healthPid -and (Test-OwnToken)) { $seeds += @($all | Where-Object { $_.ProcessId -eq $healthPid }) }
  $tree = New-Object System.Collections.ArrayList
  $queue = New-Object System.Collections.Queue
  foreach ($seed in $seeds) { $queue.Enqueue($seed) }
  while ($queue.Count) {
    $proc = $queue.Dequeue()
    if ($proc.ProcessId -eq $PID -or @($tree | Where-Object { $_.ProcessId -eq $proc.ProcessId }).Count) { continue }
    [void]$tree.Add($proc)
    foreach ($child in $all) {
      if ($child.ParentProcessId -eq $proc.ProcessId -and $child.CreationDate -ge $proc.CreationDate) { $queue.Enqueue($child) }
    }
  }
  $tree.Reverse()
  return @($tree)
}

# Returns how many are still alive after the wait.
function Stop-RootProcess {
  foreach ($proc in @(Get-RootProcess)) { Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue }
  $deadline = (Get-Date).AddSeconds(5)
  while (@(Get-RootProcess).Count -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
  return @(Get-RootProcess).Count
}

function Start-Launcher { Start-Process -FilePath 'cmd.exe' -ArgumentList "/c `"$launcher`"" -WindowStyle Hidden }

# Poll /api/health (no fixed sleep).
function Wait-Health {
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    try { if ((Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri "http://127.0.0.1:$PORT/api/health").StatusCode -eq 200) { return $true } } catch { }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

# By launcher path, not by name: uninstall gets only -Root, -Name may differ from the install.
function Get-RootTask {
  @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
    $_.TaskName -like 'AIWFF_Runtime_*' -and @($_.Actions | Where-Object { $_.Arguments -and $_.Arguments.IndexOf($launcher, [StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count
  })
}

function Get-RootShortcut {
  $shell = New-Object -ComObject WScript.Shell
  @(Get-ChildItem -LiteralPath $desktopDir -Filter 'AIWFF*.lnk' -ErrorAction SilentlyContinue | Where-Object { $shell.CreateShortcut($_.FullName).TargetPath -ieq $opener })
}

function Find-NodeExe {
  $portable = Get-ChildItem -Path (Join-Path $Root 'tools\node\*\node.exe') -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($portable) { return $portable.FullName }
  $system = Get-Command node -ErrorAction SilentlyContinue
  if ($system) { return $system.Source }
  return ''
}

# What the Claude Desktop config says right now: connected | other | no | absent; '' = unreadable.
function Get-DesktopState {
  $ErrorActionPreference = 'Continue'
  $state = & $nodeExe $desktopJs --status 2>$null
  if ($LASTEXITCODE -eq 0) { return "$state".Trim() }
  return ''
}

# Default ACLs under C:\ give every signed-in account Modify. The launchers here run as the user
# at logon and from Claude Desktop, and .env holds the token, so inheritance goes.
function Protect-Folder([string]$Dir) {
  try {
    if ((Get-Acl -LiteralPath $Dir).AreAccessRulesProtected) { return }
    $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $rc = Invoke-Logged 'icacls.exe' @($Dir, '/inheritance:r', '/grant:r', "*${me}:(OI)(CI)F", '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '/Q') (Join-Path $Root 'logs\acl.log')
    if ($rc -ne 0) { throw "icacls exit $rc" }
    Ok "only this account, SYSTEM and Administrators can open $Dir"
  } catch { Write-Warning "could not limit access to ${Dir} ($($_.Exception.Message)); other accounts on this PC may read the token there" }
}

if ($Mode -eq 'assess') {
  # 2nd cut: scan an existing brain (memory / rules / hooks / schedules) and emit a
  # borrow-or-reinstall report. Interface must align with the public healthcheck tool.
  Write-Host 'assess mode: not implemented in v1 (hook reserved, see scripts/healthcheck.js)'
  exit 3
}

if ($Source.StartsWith('-')) {
  Write-Host "[abort  ] -Source cannot start with '-': git would read it as an option; nothing changed" -ForegroundColor Red
  exit 1
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
$rt = Join-Path $Root 'suite\aiwff-runtime'
$envFile = Join-Path $rt '.env'
$launcher = Join-Path $Root 'start-runtime.cmd'
$opener = Join-Path $Root 'open-webui.cmd'
$summaryJs = Join-Path $rt 'scripts\install-summary.js'
$desktopJs = Join-Path $rt 'scripts\connect-desktop.js'
$desktopDir = if ($env:AIWFF_DESKTOP_DIR) { $env:AIWFF_DESKTOP_DIR } else { [Environment]::GetFolderPath('Desktop') }

if ($Mode -in 'uninstall', 'restart') {
  if (-not (Test-Path -LiteralPath $launcher)) {
    Write-Host "[abort  ] no AIWFF install at $Root (no start-runtime.cmd); nothing changed" -ForegroundColor Red
    exit 1
  }
  Read-Port
}

if ($Mode -eq 'restart') {
  if ($DryRun) {
    Step "would stop $(@(Get-RootProcess).Count) process(es) of this Root, run $launcher again and wait up to 20s for /api/health"
    exit 0
  }
  $left = Stop-RootProcess
  if ($left) { Write-Host "[FAILED ] $left process(es) of this Root are still running" -ForegroundColor Red; exit 1 }
  Start-Launcher
  if (Wait-Health) { Ok "restarted: http://127.0.0.1:$PORT/"; exit 0 }
  Write-Host "[FAILED ] runtime did not answer within 20s (see $Root\logs\runtime.log)" -ForegroundColor Red
  exit 4
}

if ($Mode -eq 'uninstall') {
  $nodeExe = Find-NodeExe
  $canTouchDesktop = $nodeExe -and (Test-Path -LiteralPath $desktopJs)
  $procs = @(Get-RootProcess); $tasks = @(Get-RootTask); $links = @(Get-RootShortcut)
  if ($DryRun) {
    if ($NoDesktop) { Step 'would leave Claude Desktop alone (-NoDesktop)' }
    elseif ($canTouchDesktop) { $null = Invoke-Console $nodeExe @($desktopJs, '--remove', '--dry-run') }
    else { Step 'cannot touch Claude Desktop here: no node or no scripts\connect-desktop.js' }
    Step "would remove $($tasks.Count) scheduled task(s): $(@($tasks | ForEach-Object { $_.TaskName }) -join ', ')"
    Step "would stop $($procs.Count) process(es): $(@($procs | ForEach-Object { "$($_.ProcessId) $($_.Name)" }) -join ', ')"
    Step "would remove $($links.Count) desktop shortcut(s) from ${desktopDir}: $(@($links | ForEach-Object { $_.Name }) -join ', ')"
    Step "data stays: $Root is not deleted"
    exit 0
  }
  # Wiring first: an MCP client restarts a server that dies. Then the task, or its retry
  # brings the runtime back. Then the processes.
  $desktopArg = 'no'
  if (-not $NoDesktop) {
    if ($canTouchDesktop) {
      $wasConnected = (Get-DesktopState) -eq 'connected'
      if ((Invoke-Console $nodeExe @($desktopJs, '--remove')) -eq 0) { if ($wasConnected) { $desktopArg = 'touched' } }
      else { Write-Warning 'Claude Desktop wiring not removed; delete mcpServers.aiwff from its config by hand' }
    } else { Write-Warning 'no node or no scripts\connect-desktop.js: if Claude Desktop was connected, delete mcpServers.aiwff from its config by hand' }
  }
  foreach ($task in $tasks) { Unregister-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath -Confirm:$false }
  $left = Stop-RootProcess
  foreach ($link in $links) { Remove-Item -LiteralPath $link.FullName -Force }
  if ($left) { Write-Host "[FAILED ] $left process(es) of this Root are still running" -ForegroundColor Red; exit 1 }
  if ($nodeExe -and (Test-Path -LiteralPath $summaryJs)) { $null = Invoke-Console $nodeExe @($summaryJs, '--uninstall', '--root', $Root, '--desktop', $desktopArg) }
  else { Step "stopped and unwired. The data stays in $Root; delete that folder yourself if you want it gone" }
  exit 0
}

# Autostart decision, before anything is created: -SkipAutostart / -NoStart = off, no
# prompt; -Unattended = on; otherwise ask, Enter = Yes. A session that cannot answer the
# prompt aborts with exit 2 instead of silently taking the default.
$Autostart = -not ($SkipAutostart -or $NoStart)
$askAutostart = -not ($SkipAutostart -or $NoStart -or $Unattended)
$noTty = ''
if (-not [Environment]::UserInteractive) { $noTty = 'session is not user-interactive' }
elseif ([Console]::IsInputRedirected) { $noTty = 'stdin is redirected' }
elseif ([Environment]::GetCommandLineArgs() -match '^[-/]noni') { $noTty = 'powershell -NonInteractive' }
if ($askAutostart -and -not $DryRun) {
  # Only a clear answer counts, same as the Claude Desktop question in install-summary.js.
  $yes = '^(|y|yes|\u597d|\u8981|\u662f)$'
  $no = '^(n|no|\u4e0d|\u4e0d\u8981|\u5426)$'
  $ans = ''
  if (-not $noTty) {
    try {
      do { $ans = (Read-Host ([regex]::Unescape('\u767b\u5165 Windows \u5f8c\u8981\u81ea\u52d5\u555f\u52d5\u5c0f\u4e3b\u8166\u55ce\uff1f[Y/n]'))).Normalize([Text.NormalizationForm]::FormKC).Trim() }
      until ($ans -match $yes -or $ans -match $no)
    }
    catch { $noTty = "Read-Host failed: $($_.Exception.Message)" }
  }
  if ($noTty) {
    Write-Host "[abort  ] non-interactive install: please add -Unattended or -SkipAutostart ($noTty)" -ForegroundColor Red
    exit 2
  }
  if ($ans -match $no) { $Autostart = $false }
}
if ($NoStart) { $NoBrowser = [switch]$true }   # -NoStart implies -NoBrowser

# Brain plan: 'use' = -Brain named one; 'menu' = ask; 'keep' = leave .env as it is.
$envExisted = Test-Path -LiteralPath $envFile
if ($Brain -ne 'ask') { $brainPlan = 'use' }
elseif ($Unattended -or $noTty) { $brainPlan = 'keep' }
elseif ($envExisted -and -not $PSBoundParameters.ContainsKey('Brain')) { $brainPlan = 'keep' }
else { $brainPlan = 'menu' }
# Desktop plan: 'off' = -NoDesktop; 'connect'; 'skip' = cannot ask; 'ask' = only if detected.
if ($NoDesktop) { $desktopPlan = 'off' }
elseif ($ConnectDesktop -or $ReplaceDesktop) { $desktopPlan = 'connect' }
elseif ($Unattended -or $noTty) { $desktopPlan = 'skip' }
else { $desktopPlan = 'ask' }
$repoList = if ($Source) { @('aiwff-runtime') } else { $REPOS }
# -Root may be a folder the user shares on purpose: it is ours only if nothing else lives in it,
# on this run and on every re-run.
$ourNames = @($Dirs | ForEach-Object { ($_ -split '\\')[0] }) + @('start-runtime', 'open-webui', 'connect-brain', 'connect-desktop', 'claude-login', 'restart-runtime', 'uninstall' | ForEach-Object { "$_.cmd" })
$rootIsOurs = -not @(Get-ChildItem -LiteralPath $Root -Force -ErrorAction SilentlyContinue | Where-Object { $ourNames -notcontains $_.Name }).Count

$autoTxt = if ($askAutostart -and $DryRun) { 'ask(Enter=Yes)' } else { "$Autostart" }
$toolTxt = if ($UseSystemTools) { 'system' } else { 'portable' }
Step "mode=fresh name=$safe root=$Root autostart=$autoTxt nostart=$([bool]$NoStart) browser=$(-not $NoBrowser) tools=$toolTxt brain=$brainPlan/$Brain desktop=$desktopPlan shortcut=$(-not $NoShortcut)"
if ($DryRun) {
  if ($askAutostart -and $noTty) {
    Step "would ABORT with exit 2 before creating anything: non-interactive session ($noTty); add -Unattended or -SkipAutostart"
    exit 2
  }
  if ($askAutostart) { Step 'would ask: Start AIWFF automatically when you sign in? [Y/n] (Enter = Yes)' }
  Step "would create under ${Root}: $($Dirs -join ', ')"
  if ($rootIsOurs) { Step "would limit $Root to this account, SYSTEM and Administrators" }
  else { Step "would leave the permissions of $Root alone: it already holds other files; only suite\ gets limited" }
  if ($UseSystemTools) { Step 'would use node / git / npm.cmd found on PATH (no downloads)' }
  else { Step "would download unless already complete (sha256-verified, abort on mismatch): $NODE_URL ; $GIT_URL ; $PWSH_URL" }
  if ($Source) { Step "would clone aiwff-runtime from $Source into suite\ (pull --ff-only if present); optional repos skipped" }
  else { Step "would clone into suite\ (pull --ff-only if present; never prompts for credentials): $($REPOS -join ', ') (only aiwff-runtime is required)" }
  Step 'would install deps: npm ci where package-lock.json exists, else npm install --no-package-lock; npm run build in execution-proofs'
  Step 'would write suite\aiwff-runtime\.env from .env.example with a generated AIWFF_RUNTIME_TOKEN (an existing .env is kept)'
  if ($brainPlan -eq 'use') { Step "would run scripts\connect-brain.js --use $Brain (if it cannot connect, the install ends with exit 5)" }
  elseif ($brainPlan -eq 'menu') { Step 'would show the brain menu of scripts\connect-brain.js (Enter = suggested)' }
  elseif ($envExisted) { Step 'brain: existing .env kept (pass -Brain to change it)' }
  else { Step 'brain stays mock (no one to ask; pass -Brain to choose one)' }
  if ($desktopPlan -eq 'connect') { Step 'would run scripts\connect-desktop.js (merges mcpServers.aiwff; never closes the app)' }
  elseif ($desktopPlan -eq 'ask') { Step 'would ask about Claude Desktop, only if scripts\connect-desktop.js --status finds it not connected yet' }
  elseif ($desktopPlan -eq 'off') { Step 'desktop: not connected, not asked (-NoDesktop)' }
  else { Step 'desktop: not connected (no one to ask; pass -ConnectDesktop)' }
  Step "would write launchers $launcher, $opener, and connect-brain, connect-desktop, claude-login, restart-runtime, uninstall .cmd in $Root"
  if ($NoShortcut) { Step 'no desktop shortcut (-NoShortcut)' }
  else { Step "would create desktop shortcut $desktopDir\AIWFF-$safe.lnk -> open-webui.cmd" }
  if ($NoStart) {
    Step 'would NOT register a task, NOT start the runtime, NOT open a browser (-NoStart); run doctor'
  } else {
    Step 'would check the port first: this Root already up = reuse it (restart it if .env changed); another program = exit 4, nothing started'
    if ($askAutostart) { Step "on Yes: register scheduled task AIWFF_Runtime_$safe (user logon, no admin, retry 3x/1min) and start it; on No: start the runtime in background for this session only" }
    elseif ($Autostart) { Step "would register scheduled task AIWFF_Runtime_$safe (user logon, no admin, retry 3x/1min) and start it" }
    else { Step 'would NOT register a task (-SkipAutostart); start the runtime in background for this session only' }
    $tail = if ($NoBrowser) { 'no browser' } else { 'open WebUI http://127.0.0.1:<PORT>/' }
    Step "would wait up to 20s for /api/health, run doctor (output in logs\doctor.log), run scripts\first-reply.js (up to 120s; mock never calls a model; with no one here a kept .env or API billing is not called either; no answer = exit 5); $tail"
  }
  Step 'would finish with scripts\install-summary.js on the console'
  exit 0
}

# 1. framework folders
foreach ($d in $Dirs) { New-Item -ItemType Directory -Force -Path (Join-Path $Root $d) | Out-Null }
if ($rootIsOurs) { Protect-Folder $Root }
else {
  Write-Warning "$Root already holds other files, so its permissions stay as they are and only suite\ is limited. Anyone who can write here can change the .cmd files that run when you sign in; a new folder is safer"
  Protect-Folder (Join-Path $Root 'suite')
}
Ok 'framework folders'

# 2. portable tools (no UAC)
# PS 5.1 progress bar makes Invoke-WebRequest tens of times slower.
$ProgressPreference = 'SilentlyContinue'
# Download to "$dest.zip", verify sha256, extract to "$dest.partial", rename to $dest only
# on success; any failure removes the .zip and the .partial. An existing $dest without its
# key executable ($probe, relative to $dest, wildcards ok) is a broken earlier extract and is
# fetched again, but only if the .aiwff-tool mark says this script made it: -Root may point at
# a folder where tools\git is the user's own.
function Get-Portable($url, $dest, $sha, $probe) {
  $mark = Join-Path $dest '.aiwff-tool'
  if (Test-Path -LiteralPath $dest) {
    if (Test-Path -Path (Join-Path $dest $probe)) { return }
    if (-not (Test-Path -LiteralPath $mark)) { throw "$dest is not a tool this installer unpacked, so it was left alone. Use another -Root, or move that folder away" }
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
    [IO.File]::WriteAllText($mark, '')
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
  if (-not (Test-Path -LiteralPath (Join-Path $Tools 'pwsh\pwsh.exe'))) { Write-Host ([regex]::Unescape('\u63a5\u4e0b\u4f86\u8981\u4e0b\u8f09\u548c\u89e3\u58d3\uff0c\u5e7e\u5206\u9418\u6c92\u6709\u756b\u9762\u662f\u6b63\u5e38\u7684\u3002')) }
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
foreach ($r in $repoList) {
  $dst = Join-Path $suite $r
  $from = if ($Source -and $r -eq 'aiwff-runtime') { $Source } else { "$GH/$r.git" }
  if (Test-Path (Join-Path $dst '.git')) { $rc = Invoke-Git @('-C', $dst, 'pull', '--ff-only', '-q') }
  else { $rc = Invoke-Git @('clone', '-q', '--depth', '1', '--', $from, $dst) }
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

# 5a. launchers, before the brain menu: its hints point at them. They stay pure ASCII and reach
# everything through %~dp0: cmd reads a batch file by byte offset and can lose its place around
# non-ASCII bytes after chcp (a Chinese Root plus one Chinese echo line stopped the launcher,
# measured). chcp 65001 stays for what the for /f below reads back, and for a node path outside
# the Root that has Chinese in it.
# The runtime starts claude through cmd /d /s /c, which cuts a quoted path at its first space, and
# Claude Desktop's bundled exe lives in a folder that changes with every update. So CLAUDE_CMD stays
# "claude" and the launcher finds the current folder on each start.
function Get-CmdPath([string]$Path) {
  if ($Path.StartsWith("$Root\", [StringComparison]::OrdinalIgnoreCase)) { return '%~dp0' + $Path.Substring($Root.Length + 1) }
  return $Path
}
$cmdHead = "@echo off`r`nchcp 65001 >nul`r`n"
$cdRuntime = "cd /d `"$(Get-CmdPath $rt)`"`r`n"
$nodeRef = Get-CmdPath $nodeExe
$claudeDirLine = 'for /f "usebackq delims=" %%d in (`node scripts\connect-brain.js --claude-dir`) do set "PATH=%%d;%PATH%"'
[IO.File]::WriteAllText($launcher, "$cmdHead$cdRuntime" + "set PATH=$(Get-CmdPath (Split-Path $nodeExe));%PATH%`r`n$claudeDirLine`r`necho AIWFF runs in this window. Closing it stops AIWFF.`r`n`"$(Get-CmdPath $npmCmd)`" run start >> `"%~dp0logs\runtime.log`" 2>&1`r`n")
# The portable node is not on PATH, so "npm run connect" only works from a dev shell.
[IO.File]::WriteAllText((Join-Path $Root 'connect-brain.cmd'), "$cmdHead$cdRuntime`"$nodeRef`" scripts\connect-brain.js %*`r`npause`r`n")
[IO.File]::WriteAllText((Join-Path $Root 'connect-desktop.cmd'), "$cmdHead$cdRuntime`"$nodeRef`" scripts\connect-desktop.js %*`r`npause`r`n")
[IO.File]::WriteAllText((Join-Path $Root 'claude-login.cmd'), "$cmdHead$cdRuntime`"$nodeRef`" scripts\connect-brain.js --login`r`npause`r`n")
# %~dp0 ends with \, and \" would escape the quote: %~dp0. is the same folder.
$selfRun = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$(Get-CmdPath (Join-Path $rt 'install.ps1'))`" -Root `"%~dp0.`""
[IO.File]::WriteAllText((Join-Path $Root 'restart-runtime.cmd'), "$cmdHead$selfRun -Mode restart %*`r`npause`r`n")
[IO.File]::WriteAllText((Join-Path $Root 'uninstall.cmd'), "$cmdHead" + "echo This stops AIWFF in this folder and unwires it. Your data stays. Close this window to cancel.`r`npause`r`n$selfRun -Mode uninstall %*`r`npause`r`n")
$openerBody = @(
  'set "PORT="', 'set "TOKEN="',
  "for /f `"usebackq tokens=1,* delims==`" %%a in (`"$(Get-CmdPath $envFile)`") do (",
  '  if "%%a"=="PORT" if not defined PORT set "PORT=%%~b"',
  '  if "%%a"=="AIWFF_RUNTIME_TOKEN" if not defined TOKEN set "TOKEN=%%~b"',
  ')',
  'if not defined PORT set "PORT=3100"',
  'start "" "http://127.0.0.1:%PORT%/?token=%TOKEN%"', ''
) -join "`r`n"
[IO.File]::WriteAllText($opener, $cmdHead + $openerBody)

# 5b. brain, before the runtime starts so its first start already reads the choice.
$brainJs = Join-Path $rt 'scripts\connect-brain.js'
$brainReason = Join-Path $Root 'logs\brain_failure.txt'
Remove-Item -LiteralPath $brainReason -Force -ErrorAction SilentlyContinue
$envBefore = [IO.File]::ReadAllText($envFile)
$brainArgs = @($brainJs, '--no-restart-hint', '--reason-file', $brainReason)
$brainRc = 0
if ($brainPlan -eq 'use') { $brainRc = Invoke-Console $nodeExe ($brainArgs + @('--use', $Brain)) }
elseif ($brainPlan -eq 'menu') { $brainRc = Invoke-Console $nodeExe $brainArgs }
$envChanged = [IO.File]::ReadAllText($envFile) -cne $envBefore
Read-Port

# 5c. Claude Desktop. The final screen reports what the config says, not what this run did:
# a re-run with -NoDesktop must not call a connected Desktop "not connected".
$desktopNow = Get-DesktopState
$desktopState = @{ connected = 'kept'; other = 'other'; no = 'no'; absent = 'absent' }[$desktopNow]
if (-not $desktopState) { $desktopState = 'failed' }
if ($desktopPlan -eq 'ask' -and $desktopNow -eq 'no' -and (Invoke-Console $nodeExe @($summaryJs, '--ask-desktop')) -eq 0) { $desktopPlan = 'connect' }
if ($desktopPlan -eq 'connect') {
  $rc = Invoke-Console $nodeExe (@($desktopJs) + @(if ($ReplaceDesktop) { '--force' }))
  $desktopState = switch ($rc) { 0 { 'connected' } 3 { 'absent' } 4 { 'other' } default { 'failed' } }
}

# 6. desktop shortcut
if (-not $NoShortcut) {
  New-Item -ItemType Directory -Force -Path $desktopDir | Out-Null
  $lnkPath = Join-Path $desktopDir "AIWFF-$safe.lnk"
  $lnk = (New-Object -ComObject WScript.Shell).CreateShortcut($lnkPath)
  $lnk.TargetPath = $opener
  $lnk.WorkingDirectory = $Root
  $lnk.WindowStyle = 7
  $lnk.Save()
  Ok "desktop shortcut $lnkPath"
}

# 7. port check: /api/health alone would take another runtime's answer for this install.
$health = ''    # empty = healthy; otherwise the reason for exit 4
$failure = ''   # what install-summary.js should explain
$alreadyUp = $false
$portOpen = Test-PortOpen
$ownRunning = $false
if ($portOpen) {
  $owner = Get-HealthPid
  $ownRunning = $owner -and (@(Get-RootProcess | ForEach-Object { $_.ProcessId }) -contains $owner)
}
if (-not $NoStart -and $portOpen) {
  if ($ownRunning) {
    if ($envChanged) {
      Step 'this Root is already running with the old .env: restarting it'
      $left = Stop-RootProcess
      if ($left) { throw "$left process(es) of this Root are still running" }
    } else {
      Step "this Root is already running on port $PORT"
      $alreadyUp = $true
    }
  } else {
    $failure = 'port-busy'
    $health = "port $PORT is used by another program; nothing was started. Change PORT in $envFile and run again"
  }
}

# 8. autostart (user-level logon task, no admin)
$taskName = "AIWFF_Runtime_$safe"
if ($NoStart) {
  Step "nostart: task not registered, runtime not started (launcher: $launcher)"
} elseif ($failure) {
  $Autostart = $false
} elseif ($Autostart) {
  $act = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$launcher`""
  $trg = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $set = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries
  $prn = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -Action $act -Trigger $trg -Settings $set -Principal $prn -Force | Out-Null
  Ok "scheduled task $taskName (logon, retry 3x/1min)"
  if (-not $alreadyUp) { Start-ScheduledTask -TaskName $taskName }
} elseif (-not $alreadyUp) {
  Step 'autostart skipped; starting runtime in background for this session'
  Start-Launcher
}

# 9. health, doctor only once the runtime answers. Its output goes to a log: it warns that the
# port is taken and tells the user to stop the owner, which here is the runtime we just started.
if (-not $NoStart -and -not $health) {
  $hurl = "http://127.0.0.1:$PORT/api/health"
  if (Wait-Health) { Ok "runtime answers $hurl" }
  else {
    $failure = 'no-health'
    $health = "runtime did not answer $hurl within 20s (see $Root\logs\runtime.log)"
  }
}
if (-not $health) {
  Push-Location $rt
  try { $doc = Invoke-Logged $nodeExe @('scripts\doctor.js') (Join-Path $Root 'logs\doctor.log') }
  finally { Pop-Location }
  Step "doctor exit=$doc"
  if ($doc -eq 0) { Ok 'doctor' }
  else {
    $failure = 'doctor'
    $health = "doctor exit=$doc (see $Root\logs\doctor.log)"
  }
}

# 10. first reply: health only proves a port answers, not that the brain does.
$replyFile = ''
$replyRc = 0
if (-not $NoStart -and -not $health) {
  $replyFile = Join-Path $Root 'logs\first_reply.json'
  $replyArgs = @((Join-Path $rt 'scripts\first-reply.js'), '--out', $replyFile)
  # Spending needs a yes: with no one here, a kept .env is never asked, and a brain named with
  # -Brain is asked only when that does not cost API money.
  if ($Unattended -or $noTty) { $replyArgs += $(if ($brainPlan -eq 'keep') { '--no-model' } else { '--no-api-billing' }) }
  Step 'asking the brain one short question (up to 120s)'
  $replyRc = Invoke-Console $nodeExe $replyArgs
}

# 11. final screen
$token = Get-EnvValue 'AIWFF_RUNTIME_TOKEN'
$loginUrl = "http://127.0.0.1:$PORT/"
if ($token) { $loginUrl += '?token=' + [Uri]::EscapeDataString($token) }
else { Write-Warning "AIWFF_RUNTIME_TOKEN in $envFile is empty: the runtime will make a new token on every start. Set a fixed value there to keep one login link." }
$finalArgs = @($summaryJs, '--root', $Root, '--desktop', $desktopState,
  '--started', $(if ($failure -or ($NoStart -and -not $ownRunning)) { '0' } else { '1' }),
  '--autostart', $(if ($Autostart -or @(Get-RootTask).Count) { 'on' } else { 'off' }),
  '--shortcut', $(if ($NoShortcut) { 'off' } else { 'on' }))
if ($replyFile) { $finalArgs += @('--reply-file', $replyFile) }
if ($failure) { $finalArgs += @('--failure', $failure) }
if ($brainRc -ne 0) { $finalArgs += @('--brain-reason-file', $brainReason) }
$null = Invoke-Console $nodeExe $finalArgs
if ($health) {
  Write-Host "[FAILED ] installed, but the health check failed: $health" -ForegroundColor Red
  exit 4
}
if (-not $NoBrowser) { Start-Process $loginUrl }
if ($brainRc -ne 0) {
  Write-Host '[FAILED ] installed, but the brain you chose is not connected (see the lines above)' -ForegroundColor Red
  exit 5
}
if ($replyRc -eq 1) {
  Write-Host '[FAILED ] installed, but the brain did not answer (see the lines above)' -ForegroundColor Red
  exit 5
}
Ok "done. root=$Root"
