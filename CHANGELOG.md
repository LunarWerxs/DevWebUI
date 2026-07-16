# Changelog

All notable changes to DevWebUI are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **The launcher's "Open dashboard" button opens a real dashboard window, not a 440x220 one.**
  It used to navigate the launcher window itself to `/`, cramming the full dashboard into the
  launcher's mini-viewer geometry with zero room for any rows. It now asks the daemon to open `/`
  as its own portable window — its own first-run size, its own remembered geometry, zero
  interference with the launcher's — and closes the launcher; if no Chromium can be spawned it
  falls back to the old in-place navigation so the button is never a dead end. The dashboard's
  first-run size is a measured 840x760 (the layout caps content at 800px, so wider is dead
  margin; 13 process rows visible), joining the launcher's measured 440x220.
- **Portable windows opened while another one is already up now get their intended size.** A
  forwarded `--app` launch into a running Chromium instance ignores both `--window-size` and the
  window's own saved placement — it just inherits the existing window's geometry (verified,
  Edge 150). That made "Open dashboard" produce a launcher-sized dashboard even with a first-run
  size in place, since the launcher is by definition running when you click it. The daemon now
  tags each portable window's URL with the size it should have (the user's remembered size when
  one exists, the measured first-run size otherwise) and the page corrects itself once with
  `window.resizeTo` — queries are not part of Chromium's geometry key, and a page-initiated
  resize saves onto the window's own slot, so the hint can't disturb any other window.

## [0.5.0] - 2026-07-16

### Added
- **Desktop shortcuts for one server (or a whole repo).** The process ⋮ menu gains **Add desktop
  shortcut**; the project ⋮ menu gains the same for every process in the codebase. Double-clicking
  the `.lnk` boots the daemon if it isn't running, loads the project if it isn't registered, starts
  the process — bringing up its `links` group and the project's companions, since it goes through
  the ordinary start action — and opens a small focused window showing just that server: status,
  metrics, logs, and a Stop button. No console flash (the shortcut runs through `wscript.exe` and a
  generated launcher), and clicking it twice is a no-op rather than a restart. Windows only;
  elsewhere the action reports that instead of failing. Backed by new
  `POST /api/processes/:id/shortcut` and `POST /api/projects/:id/shortcut` endpoints, plus the
  `create_process_shortcut` / `create_project_shortcut` MCP tools (now 31 total).
- **The compiled binary is now also the CLI.** `dist/devwebui.exe` previously only booted the
  daemon, so a portable install had no command line at all and nothing for a shortcut to invoke.
  Any argument now dispatches to the CLI (`devwebui.exe status`, `… start-process web`, `… mcp`),
  while a bare launch still boots the daemon exactly as before. Two new verbs, `open-process` and
  `open-project`, are what the shortcuts run.

### Fixed
- **A managed server no longer pops a console window.** Every dev server is spawned through
  `cmd` (`shell: true`) but without `windowsHide`, so whether a console appeared depended on the
  console the daemon itself happened to own — invisible under the tray (which starts the daemon
  with `CreateNoWindow`, and children inherit that headless console), but a desktop shortcut boots
  the daemon detached with *no* console, and Windows then gave each dev server a brand-new console
  of its own. With Windows Terminal set as the default terminal that surfaced as a real window that
  stayed up for the life of the server. The spawn now sets `windowsHide` so the result is the same
  on every launch path. `cli.ts`'s daemon boot states it too, so "no window" survives someone
  dropping `detached`.
- **The shortcut's focus window opens small, and remembers the size you give it.** It never passed
  a size, and Chromium's default for a window it has never seen is roughly the whole work area
  (~1905x2092 on a 4K display) — so "a small focused window" was neither small nor sized. It now
  opens at a first-run size measured to fit the card exactly, and yields to your own resize
  afterwards (Chromium persists a manual resize but not a `--window-size`, which is what makes
  "small by default, yours once you touch it" work rather than fighting you every launch).
- **The focus window reads as a launcher, not a shrunken dashboard.** It reused the dashboard's
  full-size ProcessCard, so a small window just clipped a big card: label-above-value metrics
  three rows tall, plus star / enable / edit / engine-chip / overflow controls that a launcher has
  no use for. ProcessCard gained a `compact` density (the same component — status, logs, metrics
  and Start/Stop must never fork into a launcher copy that drifts) which tightens the type and
  spacing, folds the metrics into one icon+value line, and drops the config-only affordances. The
  window hugs the result at 440x220 instead of 520x300.
- **`devwebui start` from the compiled binary.** It hardcoded a spawn of `bun server/src/index.ts`,
  a path that doesn't exist outside a checkout. Daemon launches now resolve the right vector for the
  build they're running in.
- **Restarting the daemon no longer hops it off its own port.** The chromeless window the shortcut
  opens was launched via `cmd /c start ""`, whose `CreateProcess` inherits the parent's handles —
  including the daemon's listening socket. The browser then pinned the daemon's port for as long as
  its window stayed open, so a restart (or auto-update relaunch) found the port still held by the
  dead daemon's ghost socket and moved to the next one. The launch now goes through WMI
  (`Win32_Process.Create`), where the service creates the process and it inherits nothing of ours —
  still fully detached from the daemon's tree, but no longer holding its socket.

### Changed
- **The focus view moved from `/?process=<id>` to `/focus/<id>`.** Chromium keys a saved app-window
  placement by host + path only — the query string isn't part of it — so every focus window and the
  dashboard shared one `localhost_/` geometry slot: no focus window could keep its own size, and
  resizing one silently resized the others. A path per process gives each window its own remembered
  geometry. Nothing on disk needs migrating (a `.lnk` stores `open-process <file> <id>`, never a
  URL), and the old query form still renders for a window or bookmark left on it.

## [0.4.0] - 2026-07-13

### Added
- **Edit project (rename + accent color).** The project ⋮ menu gains an **Edit project** action that
  opens a small dialog to rename the project and pick an accent color — shown as a tint on the
  project's stacked-servers icon in the panel header. Project color is a new optional top-level
  `color` field in the `.devwebui` file (any CSS color string; the picker writes `#rrggbb`, and
  clearing it falls back to the theme accent). Renaming or recoloring rewrites the file in place and
  never restarts running servers. Backed by a new `PUT /api/projects/:id` endpoint.
- **MCP server: 11 new tools (now 29 total).** The MCP server gained the config-editing and
  observability tools it was missing, so an agent can do what the GUI can — not just start/stop.
  New: `update_project` (rename/recolor), `add_process`, `update_process`, `remove_process`,
  `set_process_starred`, `start_project` / `stop_project` (transient, distinct from
  enable/disable), `free_port`, `get_log_file` (tail the persisted rotating log), `scan_projects`,
  and `clone_project`. Native file-picker dialogs are intentionally excluded (they can't run
  headless). `AI_GUIDE.md`'s tool reference was updated to match.

## [0.3.0] - 2026-07-13

### Changed
- **Brand tray/taskbar icon regenerated** from the current stacked-servers vector (the shipped
  `misc/DevWebUI.ico` had drifted to a generic placeholder). A new `misc/Make-Icon.ps1` rebuilds
  it from the committed `misc/DevWebUI-icon.png` master (re-rendered from `web/public/icon.svg`),
  matching the sibling apps' icon-generator convention; the web `favicon.ico` was refreshed too.
- **Settings split into tabs.** The settings panel now groups its sections under three tabs
  (General / Servers / Projects) instead of one long scroll, using the shared kit's new
  segmented tab bar. General holds appearance, app updates, resource monitoring, and cloud
  sync; Servers holds the start-behavior knobs plus the portable-window / link-host group;
  Projects holds scanning. Save/Cancel stay visible on every tab and still apply the whole
  form at once.

### Added
- **Linked servers.** Two new optional per-process fields in the `.devwebui` schema. `links` names
  sibling process ids that act as one unit: the relationship is symmetric and transitive, so
  starting or stopping any member of a linked group (GUI single-process actions, or MCP
  `start_process` / `stop_process`) starts or stops the whole group. `companion: true` marks a
  process (a shared database or proxy, say) that starts whenever any other process in the project
  is started individually; companions are never stopped by group propagation. Neither affects
  autostart, "start project"/"start all", or restart. Both live in the process edit dialog (a
  linked-servers picker and a Companion toggle), and persist in the `.devwebui` file. When an
  action ripples to other servers, the GUI shows an "Also started/stopped: …" toast, and the
  HTTP/MCP response lists the affected ids (`coStarted` / `coStopped`).
- **Portable window mode.** A new Settings → Open in browser → "Portable window" toggle opens
  DevWebUI in its own chromeless Chromium app window (`msedge`/`chrome --app=`, no tabs or
  address bar) instead of a normal browser tab. Turning it on immediately opens the app window
  (`POST /api/portable-window`); the desktop launcher/tray follows the same setting on its next
  Open/double-click/launch, falling back to a normal tab when no Edge or Chrome is installed.
  The window uses a dedicated Chromium profile (`~/.devwebui/portable-profile`) shared by both
  open paths, so it remembers its own size and position across launches instead of sharing the
  main browser profile.

## [0.2.0] - 2026-07-09

Release-readiness audit: makes a public `bun install` (no private LunarWerx registry access)
boot cleanly, clarifies what "Sign in with Connections" actually does, and cleans up some
internal duplication.

### Changed
- **Sign in with Connections now uses the official `@cnct/connect` / `@cnct/locker` SDKs**
  instead of a hand-rolled client. Both are optional dependencies that are only ever loaded
  (via dynamic `import()`) when you actually use sign-in — so installing DevWebUI without
  access to the private LunarWerx package registry still boots the daemon cleanly; sign-in
  simply reports itself unavailable instead of crashing anything.
- Existing sign-ins are migrated to the new SDK's token storage automatically on first boot
  after upgrading — no need to sign in again. "Forget" now also revokes the credential with
  the server, not just locally.
- **README clarifies the one optional, off-by-default thing that ever touches the network:**
  settings sync, which requires explicitly signing in with a Connections account.
- **README rewritten for humans**, with real screenshots (dashboard, live logs, de-duplicated
  error log, light theme) and a release badge; the full 17-tool MCP list moved to `AI_GUIDE.md`.
- **Release notes come from the CHANGELOG** (the tagged version's section) rather than an
  auto-generated commit list; dropped a redundant `bun install` in `release.yml`.
- The `bun` workspace was internally renamed from `devdeck` to `devwebui` to match the
  product name (no user-visible effect).

### Fixed
- `/oauth/login` now redirects back to the app with an error instead of returning a server
  error (HTTP 500) when the sign-in machinery isn't available.
- **CI is green again.** `bun run lint` (Biome) had been failing on pre-existing format drift plus
  two `noExplicitAny` warnings in `tests/auto-update.test.ts` (the fixtures are now typed as
  `UpdateStatus` / `UpdateApplyResult`). Bumped `actions/cache` + `actions/checkout` to clear the
  Node.js 20 deprecation warning, and fixed the `release.yml` "stage binary" step that failed on
  Linux/macOS (`ls` of a per-OS path under `set -e -o pipefail`).

### Internal
- De-duplicated several bits of internal logic that had drifted into multiple copies: the
  helper that captures a spawned process's stdout, the shared log-line cap constant, the
  error-event type, and the file-store path normalizer.
- The settings sync UI now cleans up its background refresh timer when it's closed, and the
  in-memory log buffer trims old lines more efficiently (O(1) instead of shifting an array).
- Removed lingering references to the private internal kit-repo name from source comments.

## [0.1.0] - 2026-07-06

First public, open-source release.

### Added
- **`devwebui` CLI.** A single installable command (new `bin`) so humans, scripts, and AI agents
  can run and drive DevWebUI without `bun run <script>` or raw HTTP/MCP: `devwebui start`
  (boots the daemon detached and prints the URL; `--foreground` runs it attached, `--port N`
  pins the port), `devwebui stop` (graceful shutdown), `devwebui status [--json]` (running? where?
  + a project/process summary), `devwebui list`/`ps` (managed processes), `devwebui start-process` /
  `stop-process` / `restart-process` / `enable-process` / `disable-process <id|name>`,
  `devwebui start-all` / `stop-all`, and `devwebui mcp` (the stdio MCP server). It's a thin wrapper
  over the daemon's existing REST API + `instance.ts` discovery (`shared/routes.ts`) — no new
  control logic. Lives in `server/src/cli.ts`.
- **Open a dev server from its title.** Click a running process's name (card or table
  view) to open it in a new browser tab. By default it opens the port-derived
  `http://<host>:<port>` (the host is configurable — see below); a new optional per-process
  `url` field overrides it — an absolute `http(s)://…` opens verbatim, or a path like
  `/admin` is appended to that address. The title is only a link while the process is
  running, and `url` is editable from the Add/Edit process form.
- **Configurable link host** (Settings → *Open in browser*, persisted as `linkHost`). By
  default a process opens on the host you're viewing DevWebUI from (so `localhost` on your
  own machine, the LAN IP from another device); set an explicit host to pin it, e.g. a fixed
  dev-box hostname. A per-process absolute `url` still overrides the host entirely.
- **Server-owned scan presets** (`startup` / `quick` / `deep` / `scoped`) — call sites
  ask for an intent instead of repeating raw depth/budget/limit numbers.
- **Internationalization (i18n).** The web UI is now fully localized with
  [vue-i18n](https://vue-i18n.intlify.dev/). English is the base catalog
  (`web/src/i18n/locales/en.ts`); every user-facing string — including
  accessibility labels, placeholders, and tooltips — is routed through `t()` /
  `<i18n-t>`. See `web/src/i18n/README.md`.
- **Language picker** in Settings → *Language* — driven by the locale registry and
  persisting the choice. It stays hidden while English is the only registered locale,
  so it appears automatically the moment a second language is added.
- **i18n compliance checker** (`bun run check:i18n`, also gates `bun run build`).
  Fails the build on any hardcoded UI string, any `t()` key missing from the base
  catalog, or any locale that drifts from the English key shape.
- **Sponsor credit** — a subtle footer line crediting
  [LunarWerx Studios](https://lunarwerx.com/).
- **MIT `LICENSE`** — DevWebUI is now open source.
- **Launcher guard tests** (`tests/launcher.test.ts`, via `bun test`) — fail unless the
  one-click launcher is intact: the shortcut machinery (`Create-Shortcut.ps1`,
  `DevWebUI.vbs`, `DevWebUI-Tray.ps1`, `DevWebUI.ico`) exists, is committed, and is wired
  shortcut → wscript → vbs → tray → daemon + icon. On Windows it also runs the tray's new
  headless `-SelfTest` (bun on PATH + daemon entry + the icon actually loading into a
  `NotifyIcon`) and regenerates + resolves the root shortcut.

### Changed
- **Single instance.** Only one DevWebUI daemon runs at a time. On launch it checks the
  runtime pointer (validated with an `/api/health` probe) and, if a daemon is already
  serving, prints where it's running and exits instead of starting a second one — across
  every entry point (tray, `bun run daemon`, `bun start`, `bun run dev`). A `--watch`
  reload of the dev daemon is exempt so hot-reload still rebinds cleanly.
- **Daemon survives a busy port.** On launch the daemon prefers its configured port but,
  if it's taken, steps to the next free one instead of crashing on bind — the same
  courtesy it already gives the dev servers it manages. The port it actually bound is
  written to `~/.devwebui/runtime.json`; the tray launcher reads that (validated with an
  `/api/health` probe) to open the right URL and to detect an already-running instance,
  `bun run dev` reserves the port up front so the Vite proxy follows the daemon, and the
  MCP client falls back to that pointer so agents reach a hopped daemon without any manual
  `DEVWEBUI_URL`.
- **Scan notifications say what they found.** The "found new projects" notification now
  lists each project (name, path, process count) instead of just a bare count, and
  **"Review & add" no longer clears it** — a scan notification is removed only when you
  explicitly Dismiss or Clear it, so a mis-click never loses the find.
- **Shared contract (`shared/`).** Cross-boundary DTOs, REST route definitions, daemon
  constants, and the `.devwebui` Zod schema now live in one `shared/` module that the
  daemon, the MCP client, and the web GUI all import — so types, routes, and the file
  schema can no longer drift between surfaces. The schema is the single source of truth
  (the web infers its types from it; zod stays out of the browser bundle).
- **Async, package-backed detection.** Project-scaffold detection moved off the HTTP
  hot path (async `fs/promises`, no event-loop-blocking tree walk), and the bespoke
  workspace-glob / package-manager / pnpm-yaml parsing was replaced with `tinyglobby`,
  `package-manager-detector`, and `yaml`.
- **Tidier HTTP layer.** Repeated request-body parsing, error responses, and
  project-lookup checks in the daemon's routes were factored into small shared helpers
  (identical responses, less boilerplate).
- **Safer "Free port".** Freeing a process's port now stops a DevWebUI-managed holder
  cleanly and, for *external* processes, reports the owner (PID + name) and asks for
  explicit confirmation before killing only those PIDs — instead of blindly killing
  whatever held the port.
- **Log backpressure.** The daemon coalesces child output into batched SSE `log` events
  (and sheds the oldest under a flood) rather than fanning out one event per line.
- **Robust machine scans.** Scans are single-flighted and serialized (no overlapping
  broad-scan storms) and abort when the requesting client disconnects.
- **Hardened subprocess helpers.** Git clone and the native file/folder pickers now have
  timeouts, honour request-abort, bound their captured output, and clean up the partial
  folder a failed/aborted clone leaves behind.
- **Centralized daemon defaults.** The daemon port, MCP base URL, and log-buffer cap live
  in one place (`server/src/constants.ts`); the Vite proxy follows `DEVWEBUI_PORT`.
- **Header redesign.** The live/offline indicator moved to the left beside the
  logo and merged with the active-server count (`● Live · N of M active`).
- The card/table view switch and the sort & filter controls moved into the
  header's "⋮" overflow menu — view is a single split control (Cards | Table) and
  filters open in a focused modal.

### Fixed
- **CPU/memory now reflect the whole server, not its shell wrapper.** Managed
  processes are spawned with `shell: true`, so the pid we hold is the OS shell
  (cmd.exe on Windows), not the real Node/Bun server — which lives in a child. The
  sampler used to read only that wrapper, reporting ~8 MB and ~0% CPU for a server
  actually using 50–200 MB. It now sums the entire descendant process tree
  (`metrics.ts`): on Windows via an in-process `CreateToolhelp32Snapshot` (still no
  spawning), and on the `pidusage` fallback by expanding the subtree first. Covered
  by `tests/metrics.test.ts`.

### Internal
- **End-to-end type checking** — `bun run typecheck` runs `vue-tsc` over the web app
  and `tsc` over the server (previously only the web build was type-checked).
- **Biome** for linting + formatting (`bun run lint` / `bun run format`), tuned to the
  existing style; `.vue` template-blind rules, the generated `ui/` primitives, and
  static assets are scoped out.
- **Expanded unit tests** — pure logic for the link/URL builder, process sort/filter,
  port helpers, and the `.devwebui` schema (`bun test`, 13 → 34 tests).
- **CI** — a GitHub Actions workflow runs install, lint, typecheck, build, and tests on
  every push to `main` and every pull request.
- **Smaller modules** — the log-backpressure batcher (`log-buffer.ts`) and the
  `ProcessView` projection (`process-view.ts`) were split out of `manager.ts`, and the
  drag-drop helpers (`lib/drop.ts`) out of the Add-Project dialog.
- **Dependencies refreshed to latest** — Vite 8, TypeScript 6, vue-tsc 3,
  `@vitejs/plugin-vue` 6, concurrently 10, `@types/node` 26, plus assorted minors;
  CI's `actions/checkout` bumped to v5 (clears the Node 20 deprecation). `baseUrl` was
  dropped from the web tsconfigs (deprecated in TS 6; `paths` resolves without it).
  `zod` is intentionally held at 3.x — `@modelcontextprotocol/sdk` is not yet
  zod-4 compatible, so bumping it would break the MCP server.

[Unreleased]: https://github.com/LunarWerxs/devwebui/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/LunarWerxs/devwebui/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/LunarWerxs/devwebui/releases/tag/v0.1.0
