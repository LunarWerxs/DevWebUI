# DevWebUI system-tray host (Windows). Thin adapter over the shared Tray-Host engine
# (misc/Tray-Host.ps1). This file owns only what's genuinely app-specific: names,
# paths, the daemon start command, and a few documented behavior tweaks. Everything
# else -- mutex/tray lifecycle, watchdog, rebuild/restart worker, hide-tray live-sync,
# open path, full-shutdown sentinel -- lives in the shared engine.
#
# Launch it via DevWebUI.vbs (which sets the port) so there's no console flash. The
# daemon serves the built GUI + API on one port. The shortcut launches FAST with the
# existing build; use the tray's "Rebuild & Restart" to rebuild the GUI from source.
param([int]$Port = 4000, [switch]$SelfTest)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$root = Split-Path -Parent $scriptDir
Set-Location $root

# Config dir honours DEVWEBUI_HOME (matches server/src/data-dir.ts), else ~/.devwebui — so
# the runtime pointer + crash-log + sentinel paths the engine reads always track wherever
# the daemon actually writes.
$dwHome = if ($env:DEVWEBUI_HOME) { $env:DEVWEBUI_HOME } else { Join-Path $env:USERPROFILE ".devwebui" }

$TrayConfig = @{
  DisplayName          = "DevWebUI"
  ServiceName          = $null                                  # health payload has no 'service' field — body.ok only
  IconFile             = "DevWebUI.ico"
  Port                 = $Port
  UrlHost              = "localhost"
  InfoFile             = Join-Path $dwHome "runtime.json"
  DaemonLogPath        = Join-Path $dwHome "logs\daemon.log"

  # Daemon launch: cmd.exe /c so bun's PATHEXT shim resolves; engine substitutes {PORT}.
  StartCommand         = "bun server/src/index.ts"
  PortEnvVar           = "DEVWEBUI_PORT"
  EntryFile            = "server\src\index.ts"

  # First run only (cold start, blocking, tray icon already visible): install deps and
  # build the GUI if there's no build yet. Subsequent launches use the existing build;
  # "Rebuild & Restart" is the on-demand path.
  FirstRun             = {
    param($appRoot)
    if (-not (Test-Path (Join-Path $appRoot "node_modules"))) { & cmd.exe /c "bun install" | Out-Null }
    if (-not (Test-Path (Join-Path $appRoot "web\dist"))) { & cmd.exe /c "bun run build" | Out-Null }
  }

  # "Rebuild & Restart" rebuilds the GUI from SOURCE — a developer convenience so UI edits
  # show up without a manual build. Public/end users get a prebuilt web\dist and no
  # server\src tree (or necessarily bun) to build with, so this is gated by IsDevTree
  # below; end users do their own rebuilds with the standalone misc\Rebuild.bat instead.
  RebuildCommand       = "bun run build"
  RebuildLogName       = "DevWebUI-Rebuild.log"

  # Dev-only gate for the "Rebuild & Restart" menu item: a distributed build ships a
  # prebuilt web\dist and no server\src tree to rebuild from, so offering that menu item
  # there would just fail. True when either the source tree is present (this script is
  # running from a checkout, not a bare distribution) or DEVWEBUI_DEV=1 is set (explicit
  # override for a dev machine laid out unusually).
  IsDevTree            = ($env:DEVWEBUI_DEV -eq "1") -or (Test-Path (Join-Path $root "server\src"))

  # Full-shutdown sentinel: the daemon drops this when a user picks "Shut Down" in the web
  # UI (or runs `devwebui stop`) — a request to terminate the WHOLE app, this tray
  # included. The engine polls for it and reuses Quit's teardown so the watchdog doesn't
  # resurrect the daemon the user just stopped. Cleared at startup by the engine.
  SentinelFile         = Join-Path $dwHome "shutdown.request"

  # Shutdown protocol: HTTP token, graceful-first then port-sweep fallback (not a force-kill
  # app). The daemon only honours a shutdown POST bearing the token it was spawned with.
  ShutdownTokenEnvVar  = "DEVWEBUI_TRAY_SHUTDOWN_TOKEN"
  ShutdownHeaderPrefix = "x-devwebui"

  # A live daemon without our tray is adopted (host a tray for it, don't spawn a second
  # daemon, leave it running at Quit) rather than treated as an orphan to refuse.
  OnStrayDaemon        = "attach"

  SelfTestMarker       = "DEVWEBUI_TRAY_SELFTEST"
  MenuOpenLabel        = "Open DevWebUI"
  MutexName            = "DevWebUITrayHost"

  # OLD standalone script waited 12s (Wait-ForUrl ... 12000) for the daemon to bind on cold
  # start before opening the browser. Pin it so the shared engine's 15s family default doesn't
  # silently change this app's cold-start timing. (Hide-tray icon re-sync intentionally rides
  # the engine's 5s health-timer cadence, family-standard — a deliberate consistency choice.)
  StartupWaitSec       = 12

  ScriptDir            = $scriptDir
  Root                 = $root
}

. (Join-Path $scriptDir "Tray-Host.ps1")

if ($SelfTest) {
  Invoke-TrayHostSelfTest $TrayConfig
} else {
  Start-TrayHost $TrayConfig
}
