# =====================================================================================
# Tray-host engine part (Windows): the tray icon, the app window's remembered placement, and the
# app window Open-AppUi starts. Dot-sourced by Tray-Host.ps1 beside it and synced with it; never
# edited in an app. Open-AppUi runs inside Start-TrayHost and reads its $infoFile and the two
# portable-window settings it resolves ($portableWindowSize, $portableWindowSizeHint), the way
# it did when it was defined inside that function: PowerShell resolves a function's variables
# where it is called.
# =====================================================================================

# --- Icon helpers (shared by SelfTest and the live host) -----------------------------
# Byte-level ICO validation: a valid header (magic 0,0,1,0) and at least one small (<=48px)
# frame. A 256-only .ico renders BLANK in the notification area (the classic "tray icon is
# broken"), so we require a real tray-sized frame. Width byte 0 means 256px, so it doesn't
# count. Pure byte parse — no GDI+ decode — so it's cheap and dependency-free.
function Test-TrayIconHasSmallFrame([string]$icoPath) {
  try {
    $icoBytes = [System.IO.File]::ReadAllBytes($icoPath)
    if ($icoBytes.Length -le 6 -or $icoBytes[0] -ne 0 -or $icoBytes[1] -ne 0 -or $icoBytes[2] -ne 1 -or $icoBytes[3] -ne 0) { return $false }
    $frameCount = [BitConverter]::ToUInt16($icoBytes, 4)
    for ($fi = 0; $fi -lt $frameCount; $fi++) {
      $fw = $icoBytes[6 + $fi * 16]
      if ($fw -ne 0 -and $fw -le 48) { return $true }
    }
  } catch {}
  return $false
}

# Build a live tray NotifyIcon from the app's icon: validate the bytes, pull the TRAY-SIZED
# frame out of the multi-size .ico so it renders crisply (not blank) in the notification area,
# force a decode, and construct a real NotifyIcon. Hard startup gate — no generic-system-icon
# fallback: the shortcut may only drive the daemon once the REAL notification-area icon exists.
function New-TrayHostIcon([string]$icoPath, [string]$displayName) {
  if (-not (Test-Path $icoPath)) { throw "Tray icon file is missing: $icoPath" }
  if (-not (Test-TrayIconHasSmallFrame $icoPath)) { throw "Tray icon has no small (<=48px) frame for the Windows notification area." }
  $ico = New-Object System.Drawing.Icon($icoPath, [System.Windows.Forms.SystemInformation]::SmallIconSize) -ErrorAction Stop
  $null = $ico.ToBitmap()   # force decode of the chosen frame — catches a corrupt/blank icon now
  $ni = New-Object System.Windows.Forms.NotifyIcon -ErrorAction Stop
  $ni.Text = $displayName
  $ni.Icon = $ico
  return $ni
}

# --- Chromium app-window placement probe (feeds Open-AppUi's sizing decision) ---------
# PowerShell port of the daemon's placement probe (server-lib/portable-window.mjs
# appWindowPlacementKey/hasRememberedBounds and devwebui's rememberedPlacement,
# server/src/window-size.ts), so a COLD start — the tray opening the window before the
# daemon is even up — makes the same sizing decision the daemon's POST
# /api/portable-window makes. Top-level rather than inside Start-TrayHost because both
# are pure: dot-sourcing this file is enough to unit-test them.

# The key Chromium files a saved app-window placement under — its own
# GenerateApplicationNameFromURL: hostname + "_" + path. The PORT and the QUERY STRING
# are both absent from the key (Chromium's omissions, not ours; verified Edge 150), so
# probing with the plain app URL and launching with a ?window-size-tagged one land on
# the SAME slot. $null for a URL that won't parse.
function Get-AppWindowPlacementKey([string]$u) {
  try {
    $uri = [uri]$u
    if (-not $uri.IsAbsoluteUri) { return $null }
    return "$($uri.Host)_$($uri.AbsolutePath)"
  } catch { return $null }
}

# The placement Chromium has saved for $u's window in $profileDir —
# @{ Width; Height; Maximized } — or $null when nothing usable is stored (fresh profile,
# unreadable/corrupt Preferences, junk rect). Carries the daemon probe's two
# verified-on-Edge-150 subtleties:
#   · Chromium writes prefs BY DOTTED PATH, so a placement key containing dots (any URL
#     path with a dot in it) lands as NESTED dicts, not under the flat key its own
#     GenerateApplicationNameFromURL produces. Probe flat first, then walk the key as a
#     dotted path — requiring an object at every hop so a sibling window's dotted key
#     that shares this key as a prefix can't read as "this window was saved".
#   · maximized:true means the rect holds the pre-maximize RESTORE bounds, not the
#     window's live size — surfaced so the caller can skip the size hint for it.
# A rect under 50px a side is junk (zero-area rects, monitor-reconciliation leftovers;
# Chromium's own drag-resize minimum sits well above 50), not a remembered size — the
# same floor the daemon's hint path uses, which also subsumes portable-window.mjs's
# positive-area rule on the --window-size decision.
function Get-RememberedPlacement([string]$profileDir, [string]$u) {
  $key = Get-AppWindowPlacementKey $u
  if (-not $profileDir -or -not $key) { return $null }
  try {
    $prefsPath = Join-Path $profileDir "Default\Preferences"
    if (-not (Test-Path $prefsPath)) { return $null }
    $prefs = Get-Content $prefsPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    $placements = $prefs.browser.app_window_placement
    $node = $placements.$key                     # flat probe first…
    if ($null -eq $node) {                       # …then the dotted-path form
      $node = $placements
      foreach ($seg in $key.Split('.')) {
        if ($node -isnot [System.Management.Automation.PSCustomObject]) { return $null }
        $node = $node.$seg
      }
    }
    if ($node -isnot [System.Management.Automation.PSCustomObject]) { return $null }
    foreach ($edge in @('left', 'top', 'right', 'bottom')) {
      $v = $node.$edge
      # Numbers only, as JS `typeof === "number"`: WinPS 5.1 deserializes JSON numbers as
      # int/long/decimal, PS7 as long/double — anything else (missing, string, bool) is
      # not a placement rect.
      if (-not ($v -is [int] -or $v -is [long] -or $v -is [double] -or $v -is [decimal])) { return $null }
    }
    $w = $node.right - $node.left
    $h = $node.bottom - $node.top
    if ($w -lt 50 -or $h -lt 50) { return $null }
    return @{ Width = [int]$w; Height = [int]$h; Maximized = ($node.maximized -eq $true) }
  } catch { return $null }
}

# First installed Chromium-family browser that understands --app= (msedge preferred, then
# Chrome), or $null. Mirrors src/portable-window.mjs's Windows candidate list so the tray's
# cold-start behavior (before the daemon is up) matches the daemon's own.
function Resolve-ChromiumBrowser {
  $candidates = @()
  $pf86 = ${env:ProgramFiles(x86)}
  if ($pf86) { $candidates += (Join-Path $pf86 "Microsoft\Edge\Application\msedge.exe") }
  if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe") }
  if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe") }
  if ($pf86) { $candidates += (Join-Path $pf86 "Google\Chrome\Application\chrome.exe") }
  if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe") }
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  return $null
}

# Open the app UI at $url, honouring portableMode: re-reads runtime.json FRESH on every call
# (so a setting flipped after this tray started is picked up on the next open) and, when
# portableMode is truthy AND a Chromium browser is found, launches it as a chromeless --app=
# window (with a dedicated profile) instead of a normal tab. When the app opts in
# (PortableWindowSize / PortableWindowSizeHint, resolved above), the launch also carries the
# first-run --window-size and/or the ?window-size hint, so a cold tray start sizes the window
# the same way the daemon's own POST /api/portable-window path does. Never throws — worst
# case it falls back. Its body NEVER references hideTrayIcon or $tray.Visible: visibility and
# where-the-UI-opens are orthogonal concerns (the launcher tests assert this decoupling).
function Open-AppUi([string]$url) {
  $portable = $false
  try {
    if (Test-Path $infoFile) {
      $info = Get-Content $infoFile -Raw | ConvertFrom-Json
      if ($info.portableMode) { $portable = $true }
    }
  } catch { $portable = $false }
  if ($portable) {
    $browser = Resolve-ChromiumBrowser
    if ($browser) {
      # Dedicated Chromium profile (sibling of runtime.json, named 'portable-profile') so the
      # app window remembers its own size/position across launches instead of sharing/fighting
      # over the default profile — the same convention the daemon's POST /api/portable-window
      # uses, so both open paths agree. If it can't be created, still open the window (just
      # without geometry memory) rather than dropping to a plain tab.
      $profileDir = Join-Path (Split-Path -Parent $infoFile) "portable-profile"
      $profileArgs = @()
      try {
        if (-not (Test-Path $profileDir)) { New-Item -ItemType Directory -Force -Path $profileDir | Out-Null }
        $profileArgs = @("--user-data-dir=`"$profileDir`"", "--no-first-run", "--no-default-browser-check")
      } catch {
        $profileArgs = @()
      }
      # First-run sizing: pass --window-size only while the profile remembers NOTHING usable
      # for this URL's placement slot — a placement the user made by resizing (or maximizing:
      # the rect then holds restore bounds, and the window reopens maximized natively) always
      # wins, because --window-size would override it on every launch.
      $sizeArgs = @()
      if ($portableWindowSize) {
        $placement = Get-RememberedPlacement $profileDir $url
        if ($null -eq $placement) {
          $sizeArgs = @("--window-size=$($portableWindowSize.Width),$($portableWindowSize.Height)")
        }
        # ?window-size=WxH hint: the size THIS window should have — remembered when there is
        # one, else first-run, and never for a maximized window (the page's resizeTo would
        # visibly un-maximize it). A forwarded launch ignores $sizeArgs and the saved
        # placement alike, so the page correcting itself is the only fix that reaches that
        # case. The query string is not part of Chromium's placement key, so the hint can't
        # re-key the window; a URL that won't parse just goes out un-hinted.
        if ($portableWindowSizeHint) {
          $hint = $null
          if ($null -eq $placement) {
            $hint = "$($portableWindowSize.Width)x$($portableWindowSize.Height)"
          } elseif (-not $placement.Maximized) {
            $hint = "$($placement.Width)x$($placement.Height)"
          }
          if ($hint) {
            try {
              $b = New-Object System.UriBuilder($url)
              $sizeParam = "window-size=$hint"
              $q = $b.Query.TrimStart('?')
              if ($q) { $b.Query = "$q&$sizeParam" } else { $b.Query = $sizeParam }
              $url = $b.Uri.AbsoluteUri
            } catch {}
          }
        }
      }
      Start-Process $browser -ArgumentList ($profileArgs + $sizeArgs + @("--app=$url"))
      return
    }
  }
  Start-Process $url
}
