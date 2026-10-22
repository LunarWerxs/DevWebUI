# =====================================================================================
# Shared tray-host engine (Windows). A parameterized WinForms tray host that runs a
# Bun (or any) daemon with no console window, showing a tray icon menu:
# Open / Rebuild & Restart / Restart / [app action] / Quit.
#
# Reusable engine: a small per-app launcher builds a $TrayConfig hashtable (app name,
# port, start/build commands, icon, health check, etc.), dot-sources this file, then
# calls Start-TrayHost for a normal run or Invoke-TrayHostSelfTest for a headless
# self-check. All app-specific behavior comes from that config; the engine stays generic.
# =====================================================================================

$ErrorActionPreference = "SilentlyContinue"
# Windows PowerShell 5.1 renders a progress bar for every Invoke-RestMethod / Invoke-WebRequest,
# and that rendering is not free — it is the single best-known speedup for those cmdlets. This host
# runs them in a tight startup poll and again on every health tick, all on the WinForms UI thread,
# and none of it has anywhere to draw (the console is hidden). Off.
$ProgressPreference = "SilentlyContinue"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# --- Config accessor with defaults ---------------------------------------------------
# Central place for the engine's default timing/policy values, so an app only overrides a
# key when its CURRENT behavior genuinely differs (never silently changed). $Config is the
# hashtable the adapter passed in; $Key missing/$null falls back to $Default.
function Get-TrayConfigValue($Config, [string]$Key, $Default) {
  if ($Config.ContainsKey($Key) -and $null -ne $Config[$Key]) { return $Config[$Key] }
  return $Default
}

# The engine's other parts, beside this file and synced with it: Tray-Host-Control.ps1 (the daemon
# control, the background worker, the headless self-test) and Tray-Host-Window.ps1 (the tray icon,
# the window's remembered placement, the app window Open-AppUi starts).
. (Join-Path $PSScriptRoot 'Tray-Host-Control.ps1')
. (Join-Path $PSScriptRoot 'Tray-Host-Window.ps1')

function Start-TrayHost($Config) {
  # --- Resolve config into locals (engine idioms match the originals' variable names) ---
  $scriptDir   = $Config.ScriptDir
  $root        = $Config.Root
  $displayName = $Config.DisplayName
  $serviceName = $Config.ServiceName                 # $null ⇒ validate only body.ok
  $infoFile    = $Config.InfoFile
  $logPath     = $Config.DaemonLogPath               # daemon log, for crash balloons ($null ok)
  $script:url  = "http://$(Get-TrayConfigValue $Config 'UrlHost' '127.0.0.1'):$($Config.Port)"
  $port        = $Config.Port

  $CrashLoopMax       = Get-TrayConfigValue $Config 'CrashLoopMax' 4          # restarts…
  $CrashLoopWindowSec = Get-TrayConfigValue $Config 'CrashLoopWindowSec' 120  # …within this many seconds ⇒ pause
  # Consecutive failed health probes before the watchdog declares the daemon dead. MUST be > 1:
  # a single missed probe is not evidence of death (see Test-Daemon), and acting on one produced
  # duplicate daemons in the field — the tray relaunched a daemon that was alive the whole time,
  # the successor's own single-instance guard also mis-probed, and it hopped to PORT+1. At the
  # 5s tick this trades ~10s of extra recovery latency on a REAL crash (which answers instantly
  # with connection-refused, so misses accrue every tick) for not inventing crashes that never
  # happened. Set to 1 only if an app truly wants the old hair-trigger behavior.
  $reviveAfterMisses  = Get-TrayConfigValue $Config 'ReviveAfterMisses' 3
  $restartRetries     = Get-TrayConfigValue $Config 'RestartRetries' 0        # extra worker retries (ReDesign: 1)
  $usePortFreeWait    = Get-TrayConfigValue $Config 'UsePortFreeWait' $false  # wait for the socket to release (ReDesign)
  $startupWaitSec     = Get-TrayConfigValue $Config 'StartupWaitSec' 15
  $workerWaitSec      = Get-TrayConfigValue $Config 'WorkerWaitSec' 12
  # Attach apps only (OnStrayDaemon='attach'): does the auto-restart watchdog require THIS tray to
  # own the daemon (startedByUs) before it will revive a crashed one? Default $true preserves the
  # DevWebUI-derived behavior (an attached instance owned by another session is left alone — no
  # revive, no balloon). a sibling app's OLD watchdog had no such gate — it unconditionally relaunched
  # on any health-check failure — so its adapter sets this $false to keep that parity.
  $watchdogRequiresOwnership = Get-TrayConfigValue $Config 'WatchdogRequiresOwnership' $true

  # Shutdown protocol flavor: token+HTTP (DevWebUI/a sibling app) vs force-kill (ReDesign/RepoYeti).
  $tokenEnvVar   = $Config.ShutdownTokenEnvVar       # $null ⇒ no graceful token shutdown
  $headerPrefix  = $Config.ShutdownHeaderPrefix
  $useToken      = [bool]$tokenEnvVar
  $script:shutdownToken = if ($useToken) { [System.Guid]::NewGuid().ToString("N") } else { $null }

  # Stray-daemon policy when we win the mutex but a daemon is already alive.
  $onStray = Get-TrayConfigValue $Config 'OnStrayDaemon' 'attach'

  # Append a tray-side line to the daemon log, so the watchdog's decisions land in the SAME file
  # the balloons tell the user to open. Without this a "stopped unexpectedly - restarting" balloon
  # pointed at a log containing no trace of the restart, which reads as "the log is empty, so
  # nothing was wrong" — exactly backwards. Format matches the daemon's own writer (log-file.mjs:
  # "[ISO] LEVEL text") so the two interleave cleanly. Best-effort: a logging failure (the daemon
  # holds the handle, disk full, mid-rotation) must never take the tray down.
  function Write-TrayLog($level, $text) {
    if (-not $logPath) { return }
    try {
      $stamp = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'")
      Add-Content -LiteralPath $logPath -Value "[$stamp] $($level.PadRight(5)) [tray] $text" -ErrorAction Stop
    } catch {}
  }

  # Full-shutdown sentinel (web-UI "Shut Down" / `<app> stop`). $null ⇒ no sentinel.
  $script:shutdownRequestFile = $Config.SentinelFile

  # Crash sentinel + safe mode (server-lib crash-sentinel.mjs). The daemon writes run_<launch> into
  # CrashSentinelDir and deletes it on a graceful exit, so a leftover whose owner is dead means the
  # last run ended uncleanly. After an unclean exit the tray offers "Restart in Safe Mode": the
  # daemon is relaunched with $safeModeEnvVar=1 and skips its auto-start work, so a crash inside
  # that work stops replaying on every revive. An env var, not a flag, because StartCommand is an
  # opaque per-app string a flag cannot be spliced into safely. Setting CrashSentinelDir is the
  # app's statement that its daemon honours $safeModeEnvVar: with no dir the tray never offers safe
  # mode, since the item would change nothing and the crash would simply repeat.
  $crashSentinelDir = Get-TrayConfigValue $Config 'CrashSentinelDir' $null
  $safeModeEnvVar = 'LUNARWERX_SAFE_MODE'
  $script:safeMode = $false

  # $startedByUs: did THIS tray launch the daemon? Only an owned daemon is force-stopped at Quit
  # and revived by the watchdog. For the force-kill apps that always own on the winner path, it's
  # implicitly true; the token/attach apps track it explicitly (an attached instance is left alone).
  $script:startedByUs = $false
  $script:trayMutex = $null
  $script:ownsTrayMutex = $false

  # The daemon control (Tray-Host-Control.ps1): the same functions run on this UI thread and,
  # re-created from their text, inside the background worker's runspace.
  $ServerControl = $TrayHostServerControl
  . $ServerControl   # make the functions available on the UI thread
  # Read BEFORE the cold start below: the daemon we are about to launch reports and deletes them.
  $script:uncleanExitSeen = Test-UncleanRunLeft $crashSentinelDir

  # Effective start command / env with {PORT} and {TOKEN} tokens substituted, computed once and
  # reused by cold start, worker, and watchdog (so all launch paths are byte-identical).
  $portEnvVar = if ($Config.ContainsKey('PortEnvVar')) { $Config['PortEnvVar'] } else { 'PORT' }
  $startCommand = ($Config.StartCommand -replace '\{PORT\}', "$port")
  $startEnv = @{}
  $rawStartEnv = Get-TrayConfigValue $Config 'StartEnv' @{}
  foreach ($k in $rawStartEnv.Keys) {
    $v = "$($rawStartEnv[$k])" -replace '\{PORT\}', "$port"
    if ($useToken) { $v = $v -replace '\{TOKEN\}', "$script:shutdownToken" }
    $startEnv[$k] = $v
  }
  # Token apps also inject the shutdown-token env var at spawn (the daemon reads it and only
  # honours a shutdown POST bearing the matching token).
  if ($useToken) { $startEnv[$tokenEnvVar] = $script:shutdownToken }

  # The env every launch path uses: StartEnv plus the safe-mode switch, pinned to '0' when off so
  # a value inherited from the tray's own environment cannot keep the daemon quiet by accident.
  function Get-LaunchEnv {
    $launchEnv = @{}
    foreach ($k in $startEnv.Keys) { $launchEnv[$k] = $startEnv[$k] }
    $launchEnv[$safeModeEnvVar] = if ($script:safeMode) { '1' } else { '0' }
    return $launchEnv
  }

  # Small UI-thread wrappers that bind the app-specific parameters so the rest of the host reads
  # cleanly (the worker binds them itself from the passed-in config args).
  function Get-LiveUrl { return (Get-RunningUrl $infoFile $port $serviceName (Get-TrayConfigValue $Config 'UrlHost' '127.0.0.1')) }
  function Start-DaemonHere($proc) { return (Start-Daemon $root $port $startCommand $portEnvVar (Get-LaunchEnv)) }
  function Stop-DaemonHere([bool]$forceKill, [bool]$skipGraceful = $false) { Stop-Daemon $infoFile $port $serviceName (Get-TrayConfigValue $Config 'UrlHost' '127.0.0.1') $script:shutdownToken $headerPrefix $forceKill $skipGraceful }

  # --- Portable-window open path (UI-thread only) --------------------------------------
  # Opt-in portable-window sizing, validated once here (unlike runtime.json, the app's own
  # config can't change mid-run):
  #   · PortableWindowSize = @{ Width; Height } — outer px for a window this profile has
  #     NEVER seen. Without it Chromium's never-seen default is ~the whole work area
  #     (~1905x2092 on a 4K display; verified Edge 150, Windows 11) — comically large for a
  #     small single-purpose window. Passed only while NOTHING usable is remembered:
  #     --window-size overrides a saved placement, so once the user sizes (or maximizes)
  #     the window themselves, their geometry must win on every later launch. A malformed
  #     value degrades to $null (feature off), never to a junk --window-size.
  #   · PortableWindowSizeHint = $true — additionally append ?window-size=WxH to the URL,
  #     for apps whose web build applies it via resizeTo. A FORWARDED --app launch (a
  #     Chromium instance already running on the profile) ignores --window-size AND the
  #     saved placement, inheriting the running window's geometry (verified Edge 150) —
  #     only the page itself can correct that case, so this stays off for apps that don't
  #     implement the applier (devwebui does: web/src/lib/window-size-hint.ts).
  # Neither key set ⇒ Open-AppUi's launch line is byte-identical to what it always was.
  $portableWindowSize = $null
  $rawPortableSize = Get-TrayConfigValue $Config 'PortableWindowSize' $null
  if ($rawPortableSize) {
    try {
      $pwsW = [int][math]::Round([double]$rawPortableSize.Width)
      $pwsH = [int][math]::Round([double]$rawPortableSize.Height)
      if ($pwsW -gt 0 -and $pwsH -gt 0) { $portableWindowSize = @{ Width = $pwsW; Height = $pwsH } }
    } catch {}
  }
  $portableWindowSizeHint = [bool](Get-TrayConfigValue $Config 'PortableWindowSizeHint' $false)

  # Open-AppUi and Resolve-ChromiumBrowser live in Tray-Host-Window.ps1; Open-AppUi reads $infoFile
  # and the two portable-window settings above when it runs.

  # "Hide tray icon" opt-in (web Settings → runtime.json's hideTrayIcon, same pattern as
  # portableMode). Read fresh every call. Only ever gates the NotifyIcon's .Visible — the icon
  # object itself is ALWAYS created (Quit/menu/watchdog machinery hangs off it). Missing/corrupt
  # runtime.json ⇒ icon stays visible (default).
  function Get-HideTrayIcon {
    try {
      if (Test-Path $infoFile) {
        $info = Get-Content $infoFile -Raw | ConvertFrom-Json
        if ($info.hideTrayIcon) { return $true }
      }
    } catch {}
    return $false
  }

  # --- Rebuild command resolver --------------------------------------------------------
  # RebuildCommand is either a plain string or a scriptblock(appRoot, scriptDir) resolver
  # (ReDesign: Rebuild.bat-first, then npm-run-build fallback). Resolve fresh each time.
  $rebuildSpec = Get-TrayConfigValue $Config 'RebuildCommand' $null
  function Resolve-RebuildCommand {
    if ($null -eq $rebuildSpec) { return $null }
    if ($rebuildSpec -is [scriptblock]) {
      try { return (& $rebuildSpec $root $scriptDir) } catch { return $null }
    }
    return $rebuildSpec
  }
  $rebuildLogName = Get-TrayConfigValue $Config 'RebuildLogName' 'Rebuild.log'
  $isDevTree = [bool]$Config.IsDevTree

  # --- Optional app action: one extra menu item that POSTs to the live daemon ----------
  # For apps that supervise WORK the daemon owns (DevWebUI's managed dev servers), not just the
  # daemon itself: Restart/Quit act on the daemon, this acts on what the daemon is running. Opt-in
  # — no ActionPath, no menu item, and the menu is byte-identical to what it always was.
  #   · ActionPath    — the POST path on the live daemon, e.g. '/api/processes/stop-all'.
  #   · ActionLabel   — menu text.
  #   · ActionOkText / ActionFailText — balloon copy ('{APP}' → DisplayName).
  # Fired on a background runspace (the request can legitimately take seconds — DevWebUI's stop-all
  # waits out each child's SIGTERM grace) so the tray menu never blocks on it, with the result
  # marshalled back to the UI thread by $actionTimer exactly like the rebuild worker's pollTimer.
  $actionPath     = Get-TrayConfigValue $Config 'ActionPath' $null
  $actionLabel    = Get-TrayConfigValue $Config 'ActionLabel' 'Run action'
  $actionOkText   = Get-TrayConfigValue $Config 'ActionOkText' 'Done.'
  $actionFailText = Get-TrayConfigValue $Config 'ActionFailText' "{APP} didn't accept that. Open it to check."
  $actionTimeoutSec = Get-TrayConfigValue $Config 'ActionTimeoutSec' 60

  # --- Mutex: one tray host per (app / checkout). Acquired BEFORE NotifyIcon creation. ---
  # A listening port WITHOUT this mutex means the daemon is running headless. 'attach' hosts a
  # tray for it; 'warn' refuses (ReDesign — a headless orphan the user must stop). Either way the
  # loser branch (mutex already held elsewhere) resolves the running URL, opens it, and returns
  # WITHOUT creating an icon or any timers — so exactly one tray icon ever exists per session.
  function Release-TrayMutex {
    if ($script:ownsTrayMutex -and $script:trayMutex) {
      try { $script:trayMutex.ReleaseMutex() } catch {}
    }
    if ($script:trayMutex) {
      try { $script:trayMutex.Dispose() } catch {}
    }
    $script:trayMutex = $null
    $script:ownsTrayMutex = $false
  }

  $createdMutex = $false
  try {
    $script:trayMutex = New-Object System.Threading.Mutex($true, $Config.MutexName, [ref]$createdMutex)
    $script:ownsTrayMutex = $createdMutex
    if (-not $createdMutex) {
      # A non-abandoned failure to create means someone else owns it — treat as loser below.
      # (WaitOne semantics differ across the originals; New-Object(...,[ref]) is the uniform path.
      # An AbandonedMutexException would surface on a later WaitOne, not here.)
    }
  } catch {
    [System.Windows.Forms.MessageBox]::Show("$displayName could not verify that the tray host is available. It will not start without the tray icon.", $displayName) | Out-Null
    Release-TrayMutex
    return
  }

  if (-not $script:ownsTrayMutex) {
    # Loser: open the running UI and exit — no icon, no timers. If Get-LiveUrl finds nothing yet,
    # the winning instance is still cold-starting (daemon not bound to its port yet) — tell the
    # user to wait rather than opening a browser tab against the bare, unvalidated preferred-port
    # guess URL, which would just show a connection-refused error since nothing is listening.
    $u = Get-LiveUrl
    if ($u) {
      Open-AppUi $u
    } else {
      [System.Windows.Forms.MessageBox]::Show("$displayName is already starting in the tray. Wait a moment, then open it from the tray icon.", $displayName) | Out-Null
    }
    if ($script:trayMutex) { try { $script:trayMutex.Dispose() } catch {} }
    $script:trayMutex = $null
    return
  }

  # --- Stray-daemon check (we won the mutex; is a daemon already alive?) ---
  $existing = Get-LiveUrl
  if ($existing) {
    if ($onStray -eq 'warn') {
      # ReDesign: a live daemon without our tray is a headless orphan — refuse and tell the user.
      [System.Windows.Forms.MessageBox]::Show("$displayName is already serving at $existing, but the tray icon is not running. Stop that process, then run the shortcut again.", $displayName) | Out-Null
      Release-TrayMutex
      return
    }
    # 'attach' (RepoYeti/DevWebUI/a sibling app): adopt the live URL, host a tray for it, and don't
    # spin up a second daemon. startedByUs stays $false so Quit/watchdog leave it alone.
    $script:url = $existing
  }

  # --- Bun (runtime) must be on PATH before we try to launch anything ---
  $runtimeCmd = Get-TrayConfigValue $Config 'RuntimeCheckCommand' 'bun'
  if (-not $existing -and -not (Get-Command $runtimeCmd -ErrorAction SilentlyContinue)) {
    [System.Windows.Forms.MessageBox]::Show("$runtimeCmd was not found on PATH.`nInstall it from https://bun.sh then click $displayName again.", $displayName) | Out-Null
    Release-TrayMutex
    return
  }

  # --- Create the tray icon (ALWAYS, on the winner path) ---
  # The NotifyIcon is ALWAYS created here with Visible=$true BEFORE the hide gate — the
  # icon-first guarantee the launcher tests assert. Quit/menu/watchdog all hang off it; only
  # .Visible is ever gated. On failure: dispose, message, release the mutex, and don't start.
  $tray = $null
  try {
    $tray = New-TrayHostIcon (Join-Path $scriptDir $Config.IconFile) $displayName
    $tray.Visible = $true
    # Gate visibility on the saved preference right after the unconditional line above. A LIVE
    # re-read happens on the health timer below so re-enabling from web Settings restores the
    # icon within a few seconds without restarting anything.
    if (Get-HideTrayIcon) { $tray.Visible = $false }
  } catch {
    if ($tray) { try { $tray.Visible = $false; $tray.Dispose() } catch {} }
    [System.Windows.Forms.MessageBox]::Show("$displayName could not start because the tray icon could not be created.`n`n$($_.Exception.Message)", $displayName) | Out-Null
    Release-TrayMutex
    return
  }

  # --- Cold start: first-run bootstrap + launch the daemon (only if none already alive) ---
  if (-not $existing) {
    # First run (blocking, once): the app's install/build-if-missing bootstrap. The tray icon is
    # already visible so the app doesn't look hung. $null to skip.
    $firstRun = Get-TrayConfigValue $Config 'FirstRun' $null
    if ($firstRun) { try { & $firstRun $root } catch {} }

    $startProc = Start-DaemonHere $null
    if ($startProc) { $script:shared.serverPid = $startProc.Id }
    $urlHost = Get-TrayConfigValue $Config 'UrlHost' '127.0.0.1'
    $readyUrl = Wait-ForUrl $infoFile $port $serviceName $urlHost $startupWaitSec $startProc
    if ($readyUrl) { $script:url = $readyUrl }
    $script:startedByUs = $true

    # RepoYeti-style "started but not serving" guidance (most-likely cause: no scan root). Only
    # when the app supplied a hint AND nothing is serving after the wait.
    $noScanHint = Get-TrayConfigValue $Config 'NoScanRootHint' $null
    if ($noScanHint -and -not (Get-LiveUrl)) {
      Stop-DaemonHere $true
      [System.Windows.Forms.MessageBox]::Show($noScanHint, $displayName) | Out-Null
      $tray.Visible = $false
      $tray.Dispose()
      Release-TrayMutex
      return
    }
  }

  # The background worker (Tray-Host-Control.ps1): the whole rebuild+restart (or plain restart)
  # sequence, off the UI thread; its positional args must match Start-Job-Async's AddArgument order.
  $worker = $TrayHostWorker

  # --- Worker plumbing + watchdog state ------------------------------------------------
  $script:busy = $false
  $script:ps = $null
  $script:psAsync = $null
  $script:jobKind = ''
  # Shared with the worker runspace (same process heap): the worker records the PIDs it spawns so
  # Quit can reap them, and Quit sets `cancel` to stop the worker early.
  $script:shared = [hashtable]::Synchronized(@{ buildPid = 0; serverPid = 0; cancel = $false })
  # Auto-restart watchdog state. Nothing else brings the daemon back if it dies on its own. This
  # host is the natural supervisor: the health timer probes /api/health and relaunches a daemon
  # that died. Guards keep it from fighting deliberate stops:
  #   · $intentionalStop  — set during Quit so we never resurrect a daemon we're closing.
  #   · $script:busy       — a Rebuild/Restart worker owns the daemon; the watchdog stands down.
  #   · $script:startedByUs — only revive a daemon THIS tray launched (attach apps leave an
  #                            externally-owned instance alone).
  #   · reviveGraceUntil   — after firing a relaunch, wait for it to bind before trying again.
  #   · crash-loop guard   — >= MAX restarts within WINDOW seconds ⇒ pause + notify.
  #   · healthMisses       — CONSECUTIVE failed probes; only >= $reviveAfterMisses means "dead".
  $script:intentionalStop = $false
  $script:autoRestartPaused = $false
  $script:reviveGraceUntil = [DateTime]::MinValue
  $script:healthMisses = 0
  $script:restartTimes = New-Object System.Collections.Generic.List[DateTime]
  # Re-entrancy guard: the Quit menu item and the watch timer can both fire the full teardown.
  $script:quitting = $false

  # --- Menu -----------------------------------------------------------------------------
  $menu = New-Object System.Windows.Forms.ContextMenuStrip
  $openItem = New-Object System.Windows.Forms.ToolStripMenuItem($Config.MenuOpenLabel)
  # "Rebuild && Restart" — the literal double-ampersand is deliberate: WinForms treats a single
  # '&' as a mnemonic-underline escape, so '&&' renders one visible '&'. Only shown in a dev tree.
  $rebuildItem = New-Object System.Windows.Forms.ToolStripMenuItem("Rebuild && Restart")
  $restartItem = New-Object System.Windows.Forms.ToolStripMenuItem("Restart")
  # Offered only after an unclean exit (see CrashSentinelDir above); while in safe mode, Restart
  # reads "Restart Normally" and is the way back out.
  $safeModeItem = New-Object System.Windows.Forms.ToolStripMenuItem("Restart in Safe Mode")
  $safeModeItem.Available = $script:uncleanExitSeen
  # Optional app action (see ActionPath above). Created only when configured, so the object can't
  # be referenced by a handler that shouldn't exist.
  $actionItem = if ($actionPath) { New-Object System.Windows.Forms.ToolStripMenuItem($actionLabel) } else { $null }
  $quitItem = New-Object System.Windows.Forms.ToolStripMenuItem("Quit")

  # --- pollTimer: marshals the async worker result back to the UI thread ---------------
  # Ticks on the UI thread — polls the worker and, once it finishes, reports the outcome, updates
  # the live URL, and re-enables the menu. Only place worker results touch the UI (no cross-thread
  # control access). Interval matches the family default.
  $pollTimer = New-Object System.Windows.Forms.Timer
  $pollTimer.Interval = 350
  $pollTimer.Add_Tick({
    if (-not $script:ps -or -not $script:psAsync) { $pollTimer.Stop(); return }
    if (-not $script:psAsync.IsCompleted) { return }
    $pollTimer.Stop()
    $out = $null
    try {
      $res = $script:ps.EndInvoke($script:psAsync)
      if ($res -and $res.Count -gt 0) { $out = $res[$res.Count - 1] }
    } catch {}
    try { $script:ps.Dispose() } catch {}
    $script:ps = $null; $script:psAsync = $null

    if ($out -and -not $out.Ok) {
      $tray.ShowBalloonTip(3500, $displayName, "Build failed. See misc\$rebuildLogName.", [System.Windows.Forms.ToolTipIcon]::Error)
    } elseif ($out -and $out.Ready) {
      if ($out.Url) { $script:url = $out.Url }
      $script:startedByUs = $true
      if ($script:jobKind -eq 'rebuild') { Open-AppUi $script:url }
    } else {
      $tray.ShowBalloonTip(3500, $displayName, "Restarted, but $displayName isn't answering yet.", [System.Windows.Forms.ToolTipIcon]::Warning)
    }
    $rebuildItem.Enabled = $true
    $restartItem.Enabled = $true
    $safeModeItem.Enabled = $true
    $script:busy = $false
  })

  # Kick off the worker without blocking the UI thread.
  function Start-Job-Async([bool]$doRebuild) {
    if ($script:busy) { return }
    # Defense-in-depth: the menu item is never even added outside a dev tree, but refuse a rebuild
    # request here too rather than trust only the menu's absence.
    if ($doRebuild -and -not $isDevTree) { return }
    $script:busy = $true
    $script:jobKind = if ($doRebuild) { 'rebuild' } else { 'restart' }
    # An explicit Restart/Rebuild is the user re-arming things: clear any crash-loop pause and the
    # restart history so the watchdog resumes cleanly once the worker hands the daemon back.
    $script:autoRestartPaused = $false
    $script:restartTimes.Clear()
    $rebuildItem.Enabled = $false
    $restartItem.Enabled = $false
    $safeModeItem.Enabled = $false

    try {
      $script:shared = [hashtable]::Synchronized(@{ buildPid = 0; serverPid = 0; cancel = $false })
      $buildCommand = if ($doRebuild) { Resolve-RebuildCommand } else { $null }
      $urlHost = Get-TrayConfigValue $Config 'UrlHost' '127.0.0.1'
      $extraEnvJson = (Get-LaunchEnv) | ConvertTo-Json -Compress
      $script:ps = [System.Management.Automation.PowerShell]::Create()
      [void]$script:ps.AddScript($worker.ToString())
      [void]$script:ps.AddArgument($root)              # 1  appRoot
      [void]$script:ps.AddArgument($scriptDir)         # 2  appScriptDir
      [void]$script:ps.AddArgument($infoFile)          # 3  infoFile
      [void]$script:ps.AddArgument($port)              # 4  appPort
      [void]$script:ps.AddArgument($serviceName)       # 5  service
      [void]$script:ps.AddArgument($urlHost)           # 6  urlHost
      [void]$script:ps.AddArgument($startCommand)      # 7  startCommand
      [void]$script:ps.AddArgument($portEnvVar)        # 8  portEnvVar
      [void]$script:ps.AddArgument($extraEnvJson)      # 9  extraEnvJson
      [void]$script:ps.AddArgument($script:shutdownToken) # 10 token
      [void]$script:ps.AddArgument($headerPrefix)      # 11 headerPrefix
      [void]$script:ps.AddArgument($doRebuild)         # 12 doRebuild
      [void]$script:ps.AddArgument($buildCommand)      # 13 buildCommand
      [void]$script:ps.AddArgument($rebuildLogName)    # 14 rebuildLogName
      [void]$script:ps.AddArgument($ServerControl.ToString()) # 15 helpersText
      [void]$script:ps.AddArgument($script:shared)     # 16 shared
      [void]$script:ps.AddArgument($isDevTree)         # 17 isDevTree
      [void]$script:ps.AddArgument($restartRetries)    # 18 restartRetries
      [void]$script:ps.AddArgument($usePortFreeWait)   # 19 usePortFreeWait
      [void]$script:ps.AddArgument($workerWaitSec)     # 20 workerWaitSec
      [void]$script:ps.AddArgument($crashSentinelDir)  # 21 crashSentinelDir
      $script:psAsync = $script:ps.BeginInvoke()
      $pollTimer.Start()
    } catch {
      # Kicking off the runspace failed — never leave the menu stuck disabled.
      if ($script:ps) { try { $script:ps.Dispose() } catch {} }
      $script:ps = $null; $script:psAsync = $null
      $rebuildItem.Enabled = $true
      $restartItem.Enabled = $true
      $safeModeItem.Enabled = $true
      $script:busy = $false
      $tray.ShowBalloonTip(3500, $displayName, "Couldn't start the background worker. Try again.", [System.Windows.Forms.ToolTipIcon]::Error)
    }
  }

  # --- Optional app action: fire the POST off-thread, report on the UI thread ----------
  # Deliberately independent of the rebuild worker's $script:busy/$script:ps: this touches only the
  # daemon's own state, never the daemon PROCESS, so it must not stand down for (or block) a
  # Rebuild/Restart, and the watchdog has no reason to care about it. Its own in-flight flag just
  # stops a double-click firing it twice.
  $script:actionPs = $null
  $script:actionAsync = $null
  $actionTimer = New-Object System.Windows.Forms.Timer
  $actionTimer.Interval = 350
  $actionTimer.Add_Tick({
    if (-not $script:actionPs -or -not $script:actionAsync) { $actionTimer.Stop(); return }
    if (-not $script:actionAsync.IsCompleted) { return }
    $actionTimer.Stop()
    $ok = $false
    try {
      $res = $script:actionPs.EndInvoke($script:actionAsync)
      if ($res -and $res.Count -gt 0) { $ok = [bool]$res[$res.Count - 1] }
    } catch {}
    try { $script:actionPs.Dispose() } catch {}
    $script:actionPs = $null; $script:actionAsync = $null
    if ($actionItem) { $actionItem.Enabled = $true }
    if ($ok) {
      $tray.ShowBalloonTip(3000, $displayName, ($actionOkText -replace '\{APP\}', $displayName), [System.Windows.Forms.ToolTipIcon]::Info)
    } else {
      $tray.ShowBalloonTip(4000, $displayName, ($actionFailText -replace '\{APP\}', $displayName), [System.Windows.Forms.ToolTipIcon]::Warning)
    }
  })

  function Invoke-AppAction {
    if (-not $actionPath) { return }
    if ($script:actionPs) { return }   # one in flight
    # Resolve the LIVE url (the daemon may have hopped ports, or be down entirely) rather than
    # posting blind at $script:url — a dead daemon has nothing to act on, and saying so beats a
    # silent no-op the user reads as "the menu item is broken".
    $u = Get-LiveUrl
    if (-not $u) {
      $tray.ShowBalloonTip(3500, $displayName, "$displayName isn't running.", [System.Windows.Forms.ToolTipIcon]::Warning)
      return
    }
    $script:url = $u
    if ($actionItem) { $actionItem.Enabled = $false }
    try {
      $script:actionPs = [System.Management.Automation.PowerShell]::Create()
      [void]$script:actionPs.AddScript({
        param($url, $path, $timeoutSec)
        $ErrorActionPreference = 'SilentlyContinue'
        try {
          Invoke-RestMethod -Uri "$url$path" -Method Post -TimeoutSec $timeoutSec -ErrorAction Stop | Out-Null
          return $true
        } catch { return $false }
      }.ToString())
      [void]$script:actionPs.AddArgument($u)
      [void]$script:actionPs.AddArgument($actionPath)
      [void]$script:actionPs.AddArgument($actionTimeoutSec)
      $script:actionAsync = $script:actionPs.BeginInvoke()
      $actionTimer.Start()
    } catch {
      if ($script:actionPs) { try { $script:actionPs.Dispose() } catch {} }
      $script:actionPs = $null; $script:actionAsync = $null
      if ($actionItem) { $actionItem.Enabled = $true }
      $tray.ShowBalloonTip(3500, $displayName, "Couldn't start the background worker. Try again.", [System.Windows.Forms.ToolTipIcon]::Error)
    }
  }

  # --- Quit teardown -------------------------------------------------------------------
  # Called by BOTH the Quit menu item AND the watch timer that fires on a web-UI "Shut Down"
  # (which drops the sentinel). Sets intentionalStop BEFORE any teardown so the watchdog doesn't
  # relaunch what we're stopping. Token apps ask their own daemon to shut down gracefully first
  # (bounded, so Quit can't hang); force-kill apps go straight to the port sweep. Reaps in-flight
  # worker PIDs when busy; releases the mutex; exits the message loop.
  function Invoke-QuitApp {
    if ($script:quitting) { return }   # re-entrancy guard (menu + watch timer could both fire)
    $script:quitting = $true
    $script:intentionalStop = $true
    if ($healthTimer) { try { $healthTimer.Stop() } catch {} }
    if ($script:shutdownRequestFile) { Remove-Item $script:shutdownRequestFile -Force -ErrorAction SilentlyContinue }
    if ($watchTimer) { try { $watchTimer.Stop() } catch {} }
    $script:shared.cancel = $true
    $pollTimer.Stop()
    # Token apps: best-effort graceful shutdown of OUR own daemon, bounded (3s) so Quit can't hang.
    if ($useToken -and $script:startedByUs) {
      try { Invoke-DaemonShutdown $script:url $script:shutdownToken $headerPrefix 3 | Out-Null } catch {}
    }
    # If a job is in flight, reap what the worker spawned (build + a daemon that may not have bound
    # yet) so nothing is orphaned and $script:ps.Stop() doesn't block on the build's WaitForExit.
    # When idle the tracked PIDs are stale (the live daemon is killed by-port below) — skip so we
    # never taskkill a reused PID.
    if ($script:busy) {
      foreach ($k in @('buildPid', 'serverPid')) {
        $procId = $script:shared[$k]
        if ($procId -and $procId -gt 0) { try { & taskkill /PID $procId /T /F 2>$null | Out-Null } catch {} }
      }
    }
    if ($script:ps) { try { $script:ps.Stop(); $script:ps.Dispose() } catch {} }
    # An in-flight app-action POST is just an HTTP call — drop it (we're about to stop the daemon
    # it was talking to) rather than let its poll timer fire a balloon at a disposed tray icon.
    if ($actionTimer) { try { $actionTimer.Stop() } catch {} }
    if ($script:actionPs) { try { $script:actionPs.Stop(); $script:actionPs.Dispose() } catch {}; $script:actionPs = $null; $script:actionAsync = $null }
    # Stop the live daemon. Force-kill apps (ReDesign/RepoYeti) ALWAYS sweep the port at Quit —
    # matching their originals' unconditional Stop-Server/Stop-RepoYeti call (they own the daemon
    # on the winner path). Token apps (DevWebUI/a sibling app) only stop a daemon THEY started, so an
    # attached instance owned by another session is left running. The graceful POST above already
    # ran for token apps (bounded to 3s so Quit can't hang) — pass skipGraceful so this
    # belt-and-braces call goes straight to the port-kill instead of re-running a second,
    # 20s-bounded graceful POST + 10s poll if the daemon is still alive (which would turn a fast
    # Quit into a ~30s hang, the exact case the fast fallback exists for).
    if (-not $useToken) {
      Stop-DaemonHere $true
      Clear-RunSentinels $crashSentinelDir
    } elseif ($script:startedByUs) {
      Stop-DaemonHere $true $true
      Clear-RunSentinels $crashSentinelDir
    }
    $tray.Visible = $false
    $tray.Dispose()
    Release-TrayMutex
    [System.Windows.Forms.Application]::Exit()
  }

  $openItem.Add_Click({ Open-AppUi $script:url })
  $rebuildItem.Add_Click({ Start-Job-Async $true })
  # Flip the mode, then restart through the normal worker (which launches with Get-LaunchEnv).
  # The mode only changes when a restart will actually run, so a busy click cannot desync it.
  function Set-SafeMode([bool]$on) {
    $script:safeMode = $on
    $restartItem.Text = if ($on) { 'Restart Normally' } else { 'Restart' }
    $safeModeItem.Available = (-not $on) -and $script:uncleanExitSeen
    try { $tray.Text = if ($on) { "$displayName (Safe Mode)" } else { $displayName } } catch {}
  }
  function Restart-InMode([bool]$safe) {
    if ($script:busy) { return }
    if ($script:safeMode -ne $safe) {
      Set-SafeMode $safe
      $modeNote = if ($safe) { 'restarting in SAFE MODE (auto-start work skipped)' } else { 'leaving safe mode - restarting normally' }
      Write-TrayLog 'INFO' $modeNote
    }
    Start-Job-Async $false
  }
  # An unclean exit the tray did not cause: from here on, offer the quiet way back in. Only for an
  # app that names CrashSentinelDir (see above): anything else would get an item that does nothing.
  function Show-SafeModeOffer {
    if (-not $crashSentinelDir) { return }
    $script:uncleanExitSeen = $true
    if (-not $script:safeMode) { $safeModeItem.Available = $true }
  }
  $restartItem.Add_Click({ Restart-InMode $false })
  $safeModeItem.Add_Click({ Restart-InMode $true })
  if ($actionItem) { $actionItem.Add_Click({ Invoke-AppAction }) }
  $quitItem.Add_Click({ Invoke-QuitApp })

  $menu.Items.Add($openItem) | Out-Null
  # Only shown in a dev tree — a distributed build never gets this menu item at all (not merely a
  # disabled one). Gated here at menu-ADD time; re-checked in Start-Job-Async and the worker.
  if ($isDevTree -and $rebuildSpec) { $menu.Items.Add($rebuildItem) | Out-Null }
  $menu.Items.Add($restartItem) | Out-Null
  $menu.Items.Add($safeModeItem) | Out-Null
  # App action sits in its own group between the daemon-lifecycle items and Quit: it acts on what
  # the daemon is RUNNING, not on the daemon, and next to Restart/Quit without a divider it reads
  # as another way to stop the app itself.
  if ($actionItem) {
    $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
    $menu.Items.Add($actionItem) | Out-Null
  }
  $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
  $menu.Items.Add($quitItem) | Out-Null
  $tray.ContextMenuStrip = $menu
  $tray.Add_MouseDoubleClick({ Open-AppUi $script:url })

  # --- Auto-restart watchdog -----------------------------------------------------------
  # Ticks on the UI thread; each tick is cheap (one /api/health probe) and NEVER blocks — a
  # relaunch is fire-and-forget (Start-Daemon returns as soon as it spawns), and recovery is
  # observed on a later tick, so the tray stays responsive even while the daemon reboots. Also
  # live-syncs the tray icon's visibility with the hideTrayIcon setting so re-enabling it in web
  # Settings restores the icon within one tick, no restart needed.
  $healthTimer = New-Object System.Windows.Forms.Timer
  $healthTimer.Interval = 5000
  $healthTimer.Add_Tick({
    # Deliberate close, a Rebuild/Restart worker owns the daemon, or (attach apps) this tray never
    # launched the daemon → stand down. The visibility live-sync below still needs to run on every
    # tick, so do it BEFORE this early-return only when we're not shutting down.
    if ($script:intentionalStop -or $script:busy) { $script:healthMisses = 0; return }

    # Live-sync the tray icon's visibility with the web Settings toggle (hideTrayIcon).
    $wantHidden = Get-HideTrayIcon
    if ($tray.Visible -eq $wantHidden) { $tray.Visible = -not $wantHidden }

    # Attach apps: only supervise a daemon we started — UNLESS the app opts out via
    # WatchdogRequiresOwnership=$false (a sibling app: OLD revived regardless of ownership).
    if ($useToken -and -not $script:startedByUs -and $watchdogRequiresOwnership) { $script:healthMisses = 0; return }

    $u = Get-LiveUrl
    if ($u) {                                    # healthy (track where it actually bound)
      $script:url = $u
      # Recovered after one or more misses without ever being dead — that is the false positive
      # this counter exists to absorb. Record it: a box that logs these regularly wants a higher
      # ReviveAfterMisses, and without a line here the near-miss is invisible.
      if ($script:healthMisses -gt 0) {
        Write-TrayLog 'INFO' "health probe recovered after $($script:healthMisses) missed probe(s) - no restart needed"
      }
      $script:healthMisses = 0
      return
    }

    # A probe failed. Not the same thing as "the daemon died" — require consecutive misses
    # before believing it, so one slow/timed-out probe against a live daemon cannot spawn a
    # duplicate. A genuinely dead daemon refuses connections instantly, so it still trips this
    # within $reviveAfterMisses ticks.
    $script:healthMisses++
    if ($script:healthMisses -lt $reviveAfterMisses) {
      Write-TrayLog 'WARN' "health probe missed ($($script:healthMisses)/$reviveAfterMisses) - not restarting yet"
      return
    }

    # Down. Wait out the grace window after a relaunch so a still-booting daemon isn't
    # double-spawned, and honour a crash-loop pause.
    if ((Get-Date) -lt $script:reviveGraceUntil) { return }
    if ($script:autoRestartPaused) { return }
    Show-SafeModeOffer

    # Crash-loop guard: prune attempts outside the window, then bail if we've hit the cap.
    $cutoff = (Get-Date).AddSeconds(-$CrashLoopWindowSec)
    for ($i = $script:restartTimes.Count - 1; $i -ge 0; $i--) {
      if ($script:restartTimes[$i] -lt $cutoff) { $script:restartTimes.RemoveAt($i) }
    }
    if ($script:restartTimes.Count -ge $CrashLoopMax) {
      $script:autoRestartPaused = $true
      Write-TrayLog 'ERROR' "auto-restart PAUSED - $($script:restartTimes.Count) restarts within ${CrashLoopWindowSec}s (crash-loop guard)"
      $retryHint = if ($crashSentinelDir) { 'Restart or Restart in Safe Mode' } else { 'Restart to try again' }
      $tray.ShowBalloonTip(6000, $displayName, "$displayName keeps crashing - auto-restart paused. See $logPath, then use $retryHint.", [System.Windows.Forms.ToolTipIcon]::Error)
      return
    }

    # Relaunch (same path the tray uses everywhere else — cmd->bun so taskkill /T can reap it).
    $script:restartTimes.Add((Get-Date))
    $script:reviveGraceUntil = (Get-Date).AddSeconds(20)
    $script:startedByUs = $true
    Write-TrayLog 'WARN' "daemon unreachable for $($script:healthMisses) consecutive probes - relaunching"
    $relaunched = Start-DaemonHere $null
    if ($relaunched) { $script:shared.serverPid = $relaunched.Id }
    $script:healthMisses = 0
    if ($relaunched) {
      Write-TrayLog 'INFO' "relaunch spawned (pid $($relaunched.Id))"
    } else {
      Write-TrayLog 'ERROR' 'relaunch FAILED to spawn a successor'
    }
    $tray.ShowBalloonTip(4000, $displayName, "$displayName stopped unexpectedly - restarting. Log: $logPath", [System.Windows.Forms.ToolTipIcon]::Warning)
  })

  # --- Watch timer: full-shutdown sentinel + (for some apps) the hide-tray live-sync ----
  # Only created when the app has a sentinel. Polls for the shutdown.request the daemon drops on a
  # web-UI "Shut Down" (or `<app> stop`) and tears the WHOLE app down (reusing Quit's teardown so
  # $intentionalStop is set and the watchdog stands down). Skipped while $script:busy so a
  # Rebuild/Restart's internal stop isn't mistaken for a user quit. Guarded so a Quit already in
  # progress is left alone.
  $watchTimer = $null
  if ($script:shutdownRequestFile) {
    # Clear any stale sentinel from a hard-killed previous run so it can't make us quit instantly.
    Remove-Item $script:shutdownRequestFile -Force -ErrorAction SilentlyContinue
    $watchTimer = New-Object System.Windows.Forms.Timer
    $watchTimer.Interval = 500
    $watchTimer.Add_Tick({
      if ($script:intentionalStop) { return }
      if ($script:busy) { return }
      if (Test-Path $script:shutdownRequestFile) {
        $watchTimer.Stop()
        Remove-Item $script:shutdownRequestFile -Force -ErrorAction SilentlyContinue
        Invoke-QuitApp
      }
    })
    $watchTimer.Start()
  }

  $healthTimer.Start()

  # --- Startup banner + open the UI ----------------------------------------------------
  if ($script:uncleanExitSeen) {
    Write-TrayLog 'WARN' 'previous run did not shut down cleanly - Restart in Safe Mode offered'
    $tray.ShowBalloonTip(5000, $displayName, "$displayName did not shut down cleanly last time. If it misbehaves, right-click > Restart in Safe Mode.", [System.Windows.Forms.ToolTipIcon]::Warning)
  } else {
    $tray.ShowBalloonTip(2500, $displayName, "Running in the tray - right-click for options.", [System.Windows.Forms.ToolTipIcon]::Info)
  }
  # Wait for a freshly-spawned daemon to bind before opening the browser, so the first paint isn't
  # ERR_CONNECTION_REFUSED (Bun takes ~1s to boot), resolving $script:url to wherever it ACTUALLY
  # bound (it may have hopped past the preferred port). Only meaningful on the cold-start path;
  # when we attached to a live daemon, $script:url is already correct.
  if ($script:startedByUs) {
    $urlHost = Get-TrayConfigValue $Config 'UrlHost' '127.0.0.1'
    $readyUrl = Wait-ForUrl $infoFile $port $serviceName $urlHost $startupWaitSec $null
    if ($readyUrl) { $script:url = $readyUrl }
  }
  Open-AppUi $script:url

  # Run the WinForms message loop (keeps the tray alive until Quit). The finally guarantees the
  # mutex is released even on a crashed exit of the loop.
  try {
    [System.Windows.Forms.Application]::Run()
  } finally {
    Release-TrayMutex
  }
}
