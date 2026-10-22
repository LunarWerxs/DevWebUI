# =====================================================================================
# Tray-host engine part (Windows): the daemon control, the background worker and the headless
# self-test. Dot-sourced by Tray-Host.ps1 beside it and synced with it; never edited in an app.
# Both scriptblocks are closure-free on purpose: the worker runs in a runspace of its own and
# re-creates the control functions there from their text, so every input arrives as a parameter.
# =====================================================================================

# =====================================================================================
# Daemon control — defined once as a scriptblock so the EXACT same functions run on the UI
# thread (launch, quit) AND inside the background worker runspace (rebuild, restart). All
# stateless: they locate the live instance via the runtime pointer + /api/health and act on
# the bound port (or ask the daemon to stop, for the token apps), so nothing depends on
# WinForms or a shared Process handle. Stringified and re-hydrated in the worker via
# [scriptblock]::Create($helpersText) — so these must stay closure-free of app-scope vars
# (every input is passed in explicitly). App-specific bits (service-id, start command, env,
# token/header names, url host) are threaded in as PARAMETERS, never closed over.
# =====================================================================================
$TrayHostServerControl = {
  # Is OUR daemon answering here? /api/health is unauthenticated; when $service is non-empty
  # we also require body.service -eq $service (case-sensitive) — the anti-collision check that
  # stops the tray mistaking another app's server on the same port for its own. When $service
  # is empty we validate only body.ok, which is a WEAK check every adapter should now avoid:
  # anything answering that port passes it (a Vite dev server returns 200 + its SPA fallback for
  # /api/health). Every app in the family stamps `service` and names it here as of 2026-07-15.
  # $timeoutSec defaults to 2, not 1: a 1-second budget is not enough for a daemon that is
  # ALIVE but momentarily busy (boot-time session scanning, a slow sync tick, a loaded box
  # running many concurrent workloads). A probe that times out against a healthy daemon reads
  # as "dead" and, on the watchdog path, spawns a duplicate. Keep this modest anyway — the
  # health timer ticks on the UI THREAD, so the worst-case tick blocks the tray menu for
  # 2x this (Get-RunningUrl probes the pointer, then the preferred port). The real resilience
  # comes from requiring consecutive misses, not from one long timeout.
  function Test-Daemon($u, $service, $timeoutSec = 2) {
    if (-not $u) { return $false }
    try {
      $r = Invoke-RestMethod -Uri "$u/api/health" -TimeoutSec $timeoutSec -ErrorAction Stop
      if ($service) { return ($r.ok -eq $true -and $r.service -eq $service) }
      return [bool]$r.ok
    } catch { return $false }
  }
  # Health-probe a URL, but ONLY if something is actually bound to its port.
  #
  # Invoke-RestMethod does NOT fail fast on a refused local connection — it burns the whole
  # -TimeoutSec (measured on loopback: ~1.0s at -TimeoutSec 1, ~2.0s at 2). Get-RunningUrl can
  # probe twice, and the health timer runs on the WinForms UI THREAD, so a plainly-dead daemon
  # used to freeze the tray menu for two full timeouts EVERY tick. GetActiveTcpListeners answers
  # "is anything bound to this port" in ~1ms with no timeout at all.
  #
  # This can only skip a probe that was already certain to fail: the listener check matches on
  # port alone (any address, IPv4 AND IPv6), so anything listening still falls through to the
  # real /api/health call. Net effect: a dead daemon is detected instantly, and the generous
  # HTTP timeout is spent only where it does some good — on a daemon that IS up but busy.
  function Test-DaemonAt($u, $service) {
    if (-not $u) { return $false }
    $p = Get-PortFromUrl $u
    if ($p -gt 0 -and -not (Test-PortListening $p)) { return $false }
    return (Test-Daemon $u $service)
  }
  # The URL of a live instance (runtime pointer, else preferred port), or $null.
  function Get-RunningUrl($infoFile, $port, $service, $urlHost) {
    $fallback = "http://${urlHost}:$port"
    $pointerUrl = $null
    if (Test-Path $infoFile) {
      try {
        $info = Get-Content $infoFile -Raw | ConvertFrom-Json
        if ($info.url) {
          $pointerUrl = $info.url
          if (Test-DaemonAt $info.url $service) { return $info.url }
        }
      } catch { }
    }
    # When the pointer already named the preferred port there is nothing new to try: probing the
    # same hung endpoint a second time only doubles the stall for an answer we already have.
    if ($pointerUrl -eq $fallback) { return $null }
    if (Test-DaemonAt $fallback $service) { return $fallback }
    return $null
  }
  function Get-PortFromUrl($u) { try { return ([uri]$u).Port } catch { return 0 } }
  # Is anything LISTENING on this port? Pure .NET, no module dependency, so it works in a
  # fresh runspace where Get-NetTCPConnection may not be auto-loaded.
  function Test-PortListening([int]$p) {
    try {
      foreach ($ep in [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()) {
        if ($ep.Port -eq $p) { return $true }
      }
    } catch {}
    return $false
  }
  # PIDs LISTENING on a port (via netstat, always present). Plain `netstat -ano` (no `-p tcp`)
  # so IPv4 AND IPv6 listeners are both included — do NOT "clean up" that omission.
  function Get-PortPids([int]$p) {
    $ids = @()
    try {
      foreach ($line in (& netstat -ano 2>$null)) {
        $t = $line.Trim()
        if ($t -notmatch 'LISTENING') { continue }
        $parts = $t -split '\s+'
        if ($parts.Length -ge 5 -and $parts[1] -match (':' + $p + '$') -and $parts[4] -match '^\d+$') { $ids += [int]$parts[4] }
      }
    } catch {}
    return ($ids | Select-Object -Unique)
  }
  # Wait for the listen socket to actually release after a force-kill (Windows can hold it
  # briefly), so the new instance doesn't lose the port race. Used only by UsePortFreeWait apps.
  function Wait-PortFree([int]$p, [int]$seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
      if (-not (Test-PortListening $p)) { return $true }
      Start-Sleep -Milliseconds 150
    }
    return $false
  }
  # Ask the daemon to shut itself down cleanly (token-gated; only a daemon we started this
  # session honours our token). Header names are '<prefix>-shutdown-token' /
  # '<prefix>-shutdown-source'. Best-effort; returns whether the POST succeeded.
  function Invoke-DaemonShutdown($u, $token, $headerPrefix, $timeoutSec) {
    if (-not $u) { return $false }
    if (-not $timeoutSec) { $timeoutSec = 20 }
    try {
      $headers = @{}
      $headers["$headerPrefix-shutdown-token"] = $token
      $headers["$headerPrefix-shutdown-source"] = "ui"
      Invoke-RestMethod -Uri "$u/api/shutdown" -Method Post -Headers $headers -TimeoutSec $timeoutSec -ErrorAction Stop | Out-Null
      return $true
    } catch { return $false }
  }
  # Stop the live daemon. Token apps: graceful shutdown first (only when $forceKill — i.e. we
  # own it; an attached instance another session owns is left alone), then force-kill the port
  # owner as a fallback. Force-kill apps ($token empty): straight port-owner tree-kill of BOTH
  # the preferred port AND the runtime-pointer's actually-bound port (handles a hop), then wait
  # for it to go quiet. Both paths are stateless and safe on the UI thread and in the worker.
  # $skipGraceful: caller already ran its own bounded graceful POST (e.g. Quit's belt-and-braces
  # sweep) — skip the second 20s-bounded Invoke-DaemonShutdown + 10s poll and go straight to the
  # port-kill so a still-alive daemon can't turn Quit into a ~30s hang.
  function Stop-Daemon($infoFile, $port, $service, $urlHost, $token, $headerPrefix, $forceKill, [bool]$skipGraceful = $false) {
    $u = Get-RunningUrl $infoFile $port $service $urlHost
    if ($token) {
      # --- Token/graceful flavor ---
      if (-not $u) { return }
      if (-not $forceKill) { return }   # only act on a daemon we own
      if (-not $skipGraceful) {
        if (Invoke-DaemonShutdown $u $token $headerPrefix 20) {
          for ($i = 0; $i -lt 40; $i++) {
            if (-not (Get-RunningUrl $infoFile $port $service $urlHost)) { return }
            Start-Sleep -Milliseconds 250
          }
        }
      }
      $ports = @($port); $pp = Get-PortFromUrl $u; if ($pp -gt 0) { $ports += $pp }
      foreach ($pp in ($ports | Select-Object -Unique)) {
        foreach ($procId in (Get-PortPids $pp)) { if ($procId -gt 0) { & taskkill /PID $procId /T /F 2>$null | Out-Null } }
      }
      for ($i = 0; $i -lt 20; $i++) {
        if (-not (Get-RunningUrl $infoFile $port $service $urlHost)) { return }
        Start-Sleep -Milliseconds 200
      }
    } else {
      # --- Force-kill flavor (no token) ---
      $ports = @($port)
      if ($u) { $pp = Get-PortFromUrl $u; if ($pp -gt 0) { $ports += $pp } }
      foreach ($pp in ($ports | Select-Object -Unique)) {
        foreach ($procId in (Get-PortPids $pp)) { if ($procId -gt 0) { & taskkill /PID $procId /T /F 2>$null | Out-Null } }
      }
      # Settle poll so a follow-on Start doesn't race a socket that's still shutting down.
      for ($i = 0; $i -lt 25; $i++) {
        if (-not (Get-RunningUrl $infoFile $port $service $urlHost)) { return }
        Start-Sleep -Milliseconds 200
      }
    }
  }
  # Did an earlier run end uncleanly? True for any run file whose owner is gone, unreadable (the
  # crash landed mid-write), or written before the last boot (a live owner pid is then recycled).
  # Empty $dir: never.
  function Test-UncleanRunLeft($dir) {
    if (-not $dir) { return $false }
    try {
      foreach ($f in @(Get-ChildItem -LiteralPath $dir -Filter 'run_*' -File -ErrorAction Stop)) {
        $run = $null
        try { $run = Get-Content -LiteralPath $f.FullName -Raw | ConvertFrom-Json } catch {}
        $ownerPid = 0
        try { $ownerPid = [int]$run.pid } catch {}
        if ($ownerPid -le 0 -or -not (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue)) { return $true }
        # Alive: only the rare path pays for the boot-time query. 5 min of slack, as in the .mjs.
        if ($run.bootedAt) {
          try {
            $bootMs = ([DateTimeOffset](Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime).ToUnixTimeMilliseconds()
            if ([math]::Abs([double]$run.bootedAt - $bootMs) -gt 300000) { return $true }
          } catch {}
        }
      }
    } catch {}
    return $false
  }
  # Delete the daemon's run_* crash-sentinel files after WE stopped it on purpose, so the next
  # launch does not report a deliberate force-kill as a crash. Empty $dir: nothing to do.
  function Clear-RunSentinels($dir) {
    if (-not $dir) { return }
    try { Get-ChildItem -LiteralPath $dir -Filter 'run_*' -File -ErrorAction Stop | Remove-Item -Force -ErrorAction SilentlyContinue } catch {}
  }
  # Launch the daemon via cmd.exe /c (so bun.cmd/bun.ps1's PATHEXT shim resolves and taskkill
  # /T can later reap the whole cmd->bun tree). $startCommand is the app's exact payload with
  # any {PORT} token already substituted. $portEnvVar (if non-empty) is set to the port;
  # $extraEnv is the app's StartEnv hashtable (already token/port-substituted). $proc handle
  # returned so a caller can track its PID and fail fast if it exits before serving.
  function Start-Daemon($appRoot, $port, $startCommand, $portEnvVar, $extraEnv) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "cmd.exe"
    $psi.Arguments = "/c $startCommand"
    $psi.WorkingDirectory = $appRoot
    $psi.UseShellExecute = $false                 # required so CreateNoWindow works
    $psi.CreateNoWindow = $true
    $psi.WindowStyle = "Hidden"
    if ($portEnvVar) { $psi.EnvironmentVariables[$portEnvVar] = "$port" }
    if ($extraEnv) {
      foreach ($k in $extraEnv.Keys) { $psi.EnvironmentVariables[$k] = "$($extraEnv[$k])" }
    }
    return [System.Diagnostics.Process]::Start($psi)
  }
  # Wait for the daemon to come up and return the URL it ACTUALLY bound (validated via
  # /api/health), which may differ from the preferred port if it hopped. If a process handle is
  # given, bail early when it exits before serving (RepoYeti: usually "no scan root configured").
  # The poll interval RAMPS instead of sitting at a flat 250 ms, because this loop is the last
  # thing standing between the daemon being ready and the user's window opening. A flat 250 ms
  # grid costs ~125 ms on average — and once a daemon boots in ~120 ms (AgentHydra, after its
  # 2026-08 startup work) that overshoot is LONGER than the boot it is waiting on, i.e. the
  # waiter, not the app, became the slow part. 15 ms for the first second covers every warm
  # start almost exactly; the ramp then backs off so a genuinely slow/cold boot still polls
  # gently instead of spinning for the full timeout.
  function Wait-ForUrl($infoFile, $port, $service, $urlHost, $seconds, $proc) {
    $started = Get-Date
    $deadline = $started.AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
      $u = Get-RunningUrl $infoFile $port $service $urlHost
      if ($u) { return $u }
      if ($proc -and $proc.HasExited) { return (Get-RunningUrl $infoFile $port $service $urlHost) }
      $elapsed = ((Get-Date) - $started).TotalMilliseconds
      $wait = if ($elapsed -lt 1000) { 15 } elseif ($elapsed -lt 4000) { 100 } else { 250 }
      Start-Sleep -Milliseconds $wait
    }
    return (Get-RunningUrl $infoFile $port $service $urlHost)
  }
}

# =====================================================================================
# Background worker — runs the whole rebuild+restart (or plain restart) sequence off the UI
# thread and returns a result object. Self-contained: it re-defines the server-control helpers
# from the passed-in text so it needs nothing from the parent runspace. Nine positional args
# (order-dependent, must match the AddArgument sequence in Start-Job-Async exactly).
# =====================================================================================
$TrayHostWorker = {
  param($appRoot, $appScriptDir, $infoFile, $appPort, $service, $urlHost, $startCommand, $portEnvVar, $extraEnvJson, $token, $headerPrefix, $doRebuild, $buildCommand, $rebuildLogName, $helpersText, $shared, $isDevTree, $restartRetries, $usePortFreeWait, $workerWaitSec, $crashSentinelDir)
  $ErrorActionPreference = 'SilentlyContinue'
  . ([scriptblock]::Create($helpersText))
  # Re-hydrate the extra-env hashtable from JSON (a Synchronized hashtable doesn't marshal
  # cleanly across the runspace as a live object; JSON is the safe wire format).
  $extraEnv = @{}
  if ($extraEnvJson) {
    try {
      $obj = $extraEnvJson | ConvertFrom-Json
      foreach ($p in $obj.PSObject.Properties) { $extraEnv[$p.Name] = $p.Value }
    } catch {}
  }
  $result = [pscustomobject]@{ Ok = $true; Skipped = $false; Ready = $false; Url = $null }

  # Defense-in-depth: refuse a rebuild outside a dev tree even if one was somehow requested
  # (the menu item isn't even added there, and Start-Job-Async re-checks too — triple gate).
  if ($doRebuild -and -not $isDevTree) { $result.Ok = $false; return $result }

  if ($doRebuild) {
    if (-not $buildCommand) {
      $result.Skipped = $true
    } else {
      $logPath = Join-Path $appScriptDir $rebuildLogName
      $psi = New-Object System.Diagnostics.ProcessStartInfo
      $psi.FileName = "cmd.exe"
      $psi.Arguments = "/c cd /d `"$appRoot`" && $buildCommand > `"$logPath`" 2>&1"
      $psi.WorkingDirectory = $appRoot
      $psi.UseShellExecute = $false
      $psi.CreateNoWindow = $true
      $psi.WindowStyle = "Hidden"
      $p = [System.Diagnostics.Process]::Start($psi)
      $shared.buildPid = $p.Id
      # Poll HasExited (interruptible) instead of WaitForExit so a Quit can cancel promptly and
      # reap the build tree instead of the UI blocking on it.
      while (-not $p.HasExited) {
        if ($shared.cancel) { try { & taskkill /PID $p.Id /T /F 2>$null | Out-Null } catch {}; $result.Ok = $false; return $result }
        Start-Sleep -Milliseconds 200
      }
      $shared.buildPid = 0
      if ($p.ExitCode -ne 0) { $result.Ok = $false; return $result }
    }
  }
  if ($shared.cancel) { return $result }

  # A daemon already dead with its run file left behind crashed on its own: keep that file so the
  # next launch reports it. Only a stop THIS restart causes is cleared as deliberate.
  $crashedBefore = Test-UncleanRunLeft $crashSentinelDir
  Stop-Daemon $infoFile $appPort $service $urlHost $token $headerPrefix $true
  if (-not $crashedBefore) { Clear-RunSentinels $crashSentinelDir }
  if ($usePortFreeWait) { Wait-PortFree $appPort 6 | Out-Null }
  Start-Sleep -Milliseconds 300
  $sp = Start-Daemon $appRoot $appPort $startCommand $portEnvVar $extraEnv
  if ($sp) { $shared.serverPid = $sp.Id }
  $u = Wait-ForUrl $infoFile $appPort $service $urlHost $workerWaitSec $sp
  $result.Url = $u
  $result.Ready = [bool]$u

  # Optional extra restart attempts (ReDesign does ONE): slow/failed to bind ⇒ kill the tracked
  # process (even if it never listened), wait for the port, and retry.
  $attempt = 0
  while (-not $result.Ready -and -not $shared.cancel -and $attempt -lt $restartRetries) {
    $attempt++
    $crashedBefore = Test-UncleanRunLeft $crashSentinelDir
    if ($shared.serverPid -gt 0) { try { & taskkill /PID $shared.serverPid /T /F 2>$null | Out-Null } catch {} }
    Stop-Daemon $infoFile $appPort $service $urlHost $token $headerPrefix $true
    if (-not $crashedBefore) { Clear-RunSentinels $crashSentinelDir }
    if ($usePortFreeWait) { Wait-PortFree $appPort 6 | Out-Null }
    Start-Sleep -Milliseconds 400
    $sp = Start-Daemon $appRoot $appPort $startCommand $portEnvVar $extraEnv
    if ($sp) { $shared.serverPid = $sp.Id }
    $u = Wait-ForUrl $infoFile $appPort $service $urlHost $workerWaitSec $sp
    $result.Url = $u
    $result.Ready = [bool]$u
  }
  return $result
}

# =====================================================================================
# Invoke-TrayHostSelfTest — headless -SelfTest. Proves the tray can actually start (runtime on
# PATH, daemon entry exists, the icon LOADS into a real NotifyIcon then disposes), then reports
# the exact per-app marker and exits WITHOUT opening a browser, touching the mutex, or entering
# the message loop. A missing/corrupt icon makes this exit non-zero. Safe to run standalone in CI.
# =====================================================================================
function Invoke-TrayHostSelfTest($Config) {
  $scriptDir = $Config.ScriptDir
  $root = $Config.Root
  $marker = $Config.SelfTestMarker
  $runtimeCmd = Get-TrayConfigValue $Config 'RuntimeCheckCommand' 'bun'

  $fail = @()
  if (-not (Get-Command $runtimeCmd -ErrorAction SilentlyContinue)) { $fail += "$runtimeCmd not on PATH" }
  $entry = Join-Path $root $Config.EntryFile
  if (-not (Test-Path $entry)) { $fail += "daemon entry $($Config.EntryFile) missing" }
  $icoPath = Join-Path $scriptDir $Config.IconFile
  if (-not (Test-Path $icoPath)) {
    $fail += "tray icon $($Config.IconFile) missing"
  } else {
    try {
      # Load the TRAY-sized frame (not the 256 jumbo), force a decode, construct+dispose a real
      # NotifyIcon (proves it loads into a tray-capable object, not just that the file exists),
      # then re-parse the bytes for a <=48px frame — catches the 256-only "renders blank" icon.
      $ico = New-Object System.Drawing.Icon($icoPath, [System.Windows.Forms.SystemInformation]::SmallIconSize)
      $null = $ico.ToBitmap()
      $ni = New-Object System.Windows.Forms.NotifyIcon
      $ni.Icon = $ico
      $ni.Dispose(); $ico.Dispose()
      if (-not (Test-TrayIconHasSmallFrame $icoPath)) { $fail += "tray icon has no small (<=48px) frame; a 256-only icon renders blank" }
    } catch { $fail += "tray icon failed to load: $($_.Exception.Message)" }
  }
  if ($fail.Count) { Write-Output ("${marker}_FAIL: " + ($fail -join "; ")); exit 1 }
  Write-Output "${marker}_OK"; exit 0
}

# =====================================================================================
# Start-TrayHost — the full host lifecycle. Everything below runs on the UI thread except the
# background $worker runspace (rebuild/restart). Structured to preserve every behavioral
# invariant of the four originals: mutex BEFORE icon; loser attaches + exits without an icon or
# timers; icon ALWAYS created with Visible=$true on the winner path before the hide gate;
# healthTimer live-syncs Visible from the hide setting; Open-AppUi never touches visibility;
# Quit sets intentionalStop before any teardown; watchdog has revive-grace + crash-loop pause;
# mutex released on icon-failure AND on Quit.
# =====================================================================================
