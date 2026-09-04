# DevWebUI — AI guide & `.devwebui` authoring

DevWebUI runs and monitors a codebase's dev servers from a GUI (and an MCP server).
It learns about a codebase from a **`.devwebui` file** you drop in that repo. This
guide tells an AI exactly what that file should contain.

**The fastest path:** copy the prompt in [§ Copy-paste prompt](#copy-paste-prompt)
into your AI assistant while it's open in the repo you want to manage. It will
inspect the repo and write a correct `.devwebui` file for you.

---

## The `.devwebui` file format

A `.devwebui` file is JSON. One file describes **one codebase** and lists every
long-running dev process it has. Name it after the repo, e.g. `myapp.devwebui`,
and put it in the repo root.

```jsonc
{
  "name": "My App",            // shown as the codebase header in DevWebUI (required)
  "processes": [               // one entry per long-running server (required, ≥1)
    {
      "id": "web",             // unique within this file; letters/numbers/._- (required)
      "name": "Web (Vite)",    // human label on the card (required)
      "command": "npm run dev",// the shell command that starts the server (required)
      "cwd": ".",              // optional; relative to THIS file. Default "." (the file's folder)
      "port": 5173,            // optional; lets DevWebUI warn on port conflicts
      "url": "/admin",         // optional; where the title links. Path appended to http://<host>:<port>, or an absolute http(s):// URL
      "color": "#6366f1",      // optional; a hex dot color for the card
      "autostart": true,       // optional; start it automatically when the project loads
      "env": { "NODE_ENV": "development" }, // optional; extra env vars for this process
      "waitForPort": "web",    // optional; wait for a literal port, or a sibling id's port, before spawning
      "links": ["web"],        // optional; sibling ids that act as one unit with this one: start and stop together (symmetric, transitive)
      "companion": true        // optional; starts whenever any other process in the project is started individually
    }
  ]
}
```

### Field rules

| Field        | Required | Notes |
| ------------ | -------- | ----- |
| `name`       | yes      | The codebase name (the collapsible panel header). |
| `processes`  | yes      | Array, at least one. |
| `id`         | yes      | Unique **within the file**. `^[A-Za-z0-9._-]+$`. |
| `name`       | yes      | Per-process label. |
| `command`    | yes      | Exactly what you'd type in a terminal to start it. |
| `cwd`        | no       | Relative to the `.devwebui` file's folder. Omit if it's the repo root. |
| `port`       | no       | The port the server listens on. Enables conflict detection + "Free it". |
| `url`        | no       | Where the (running) process title links. A path like `/admin` is appended to `http://<host>:<port>` (the host comes from Settings → *Open in browser*, defaulting to the address you opened DevWebUI on); an absolute `http(s)://…` is used as-is. Defaults to `http://<host>:<port>`. |
| `color`      | no       | Hex like `#10b981`. |
| `autostart`  | no       | `true` to launch on load. Use it for the main server(s), not every one. |
| `env`        | no       | `{ "KEY": "value" }` map merged into the process environment. |
| `waitForPort`| no       | Dependency-ordered startup. A number waits on that literal port; a string names a sibling process's `id` and waits on THAT process's declared `port` instead. |
| `links`      | no       | Sibling process `id`s (same file) that act as one unit with this one. Symmetric and transitive; starting or stopping any member (single-process actions in the GUI, or MCP `start_process` / `stop_process`) starts or stops the whole group. Unknown ids are ignored at runtime. |
| `companion`  | no       | `true` to start this process whenever any *other* process in the project is started individually. For a shared database or proxy everything needs but nobody starts by hand. |

### Authoring guidance

- **One `.devwebui` per repo**, listing the servers a developer actually starts to
  work on it (frontend dev server, backend/API, worker, etc.).
- Find the real commands in `package.json` `scripts` (`dev`, `start`, `serve`,
  `watch`), a `Procfile`, `docker-compose.yml`, `Makefile`, or the README.
- Set `port` whenever you can tell what port the server binds (from the command,
  config, or docs) — it powers conflict detection.
- `cwd` is relative to the file. For a monorepo, point each process at its package
  (e.g. `"cwd": "apps/api"`), keeping ONE `.devwebui` at the repo root.
- Only `autostart` the server(s) the developer always wants up — not heavy or
  occasional ones.
- Use `links` when two or more servers only make sense running together (e.g. a
  frontend and the API it calls); use `companion` for a shared always-needed
  service (e.g. a database) that should start alongside whatever the developer
  starts by hand.

---

## Copy-paste prompt

> Paste this to your AI assistant in the repo you want DevWebUI to manage. It does
> not need DevWebUI installed to write the file.

```text
You are creating a `.devwebui` file for DevWebUI (a GUI dev-server manager). Inspect
THIS repository and produce a single `.devwebui` file describing the dev servers a
developer starts to work on it.

How to find them: read package.json "scripts" (dev/start/serve/watch), plus any
Procfile, docker-compose.yml, Makefile, turbo.json, or README dev instructions.
Identify each long-running process (frontend dev server, backend/API, worker,
queue, etc.). Ignore one-shot commands (build, test, lint, typecheck, migrations).

Output ONLY the file content as JSON in this exact schema — no prose, no code fence:

{
  "name": "<repo name>",
  "processes": [
    {
      "id": "<short-unique-id>",     // ^[A-Za-z0-9._-]+$, unique in this file
      "name": "<human label>",
      "command": "<exact shell command to start it>",
      "cwd": "<dir relative to this file, omit if repo root>",
      "port": <number, omit if unknown>,
      "url": "<path like /admin or an absolute http(s):// URL, omit unless the app's entry isn't the server root>",
      "color": "<hex, optional>",
      "autostart": <true only for the main server(s), omit otherwise>,
      "waitForPort": "<literal port number, or a sibling id to wait on that id's port, omit if no ordering needed>",
      "links": ["<sibling id>"],     // omit unless servers must start and stop as a group
      "companion": <true only for a shared service every other process needs, omit otherwise>
    }
  ]
}

Rules:
- One file for the whole repo. cwd is relative to where this .devwebui file will be
  saved (default the repo root). In a monorepo, set cwd per package.
- Include "port" whenever you can determine it from the command or config.
- Only set "autostart": true on the server(s) a developer always wants running.
- Only set "links" when servers clearly belong together (e.g. a frontend and the
  API it calls); only set "companion" for a shared always-needed service (e.g. a
  database or proxy), not for ordinary servers.
- Required per process: id, name, command. Everything else is optional.
- If you cannot find any dev server, say so instead of inventing one.

Save the result as `<repo-name>.devwebui` in the repo root. Then in DevWebUI click
"Add project" and pick that file.
```

---

## For an AI driving DevWebUI over MCP

DevWebUI exposes an MCP server — a thin stdio client over the running daemon, so the GUI and
agents share one state. Register it as shown in the README's
[MCP section](README.md#drive-it-from-an-ai-agent-mcp), then use the **36 tools**:

**Projects**

- `list_projects` — loaded projects (codebases), each with its processes and live status.
- `load_project` — load a `.devwebui` file by **absolute path** (registers its processes, remembers it).
- `clone_project` — clone a git repo into a dest path, then load it (or report it needs scaffolding).
- `scan_projects` — sweep the machine for existing `.devwebui` files (and detectable dev folders); loads nothing.
- `update_project` — rename and/or recolor a project (rewrites its `.devwebui` file); processes untouched.
- `remove_project` — unload a project by id (stops its processes and forgets it).
- `start_project` / `stop_project` — start/stop every process in a project **now** (transient; doesn't change saved on/off).
- `enable_project` / `disable_project` — turn a whole codebase on/off and start/stop it; persists across daemon restarts.

**Processes**

- `list_processes` — every managed process with live status, pid, uptime, CPU and memory.
- `add_process` — add a process to a project's `.devwebui` file (id, name, command + optional fields).
- `update_process` — replace a process's whole config by its in-file id (send the full definition; renames follow links).
- `remove_process` — delete a process from a project (a project must keep at least one).
- `set_process_starred` — star/unstar a process (starred float to the top of every list).
- `start_process` / `stop_process` / `restart_process` — act on one process by id. `start_process`
  also starts any linked siblings (`links`) and any companion processes (`companion: true`) in the
  same project; `stop_process` also stops linked siblings but leaves companions running; restart
  only affects the one process. The response's `coStarted` / `coStopped` arrays list the other
  process ids the action set in motion or brought down.
- `start_all` / `stop_all` — every managed process at once.
- `enable_process` / `disable_process` — turn one process on/off and start/stop it; persists across restarts.
- `free_port` — free a process's declared port (stops a managed holder cleanly; `confirm:true` also kills external owners).
- `take_over_autostart` — retire a repo's external dev-server auto-start (VS Code `tasks.json` `runOn:folderOpen`, the Vite extension's `vite.autoStart`) so DevWebUI is the sole launcher. Backs up each edited file first. Pass the project folder (absolute path).

**Desktop shortcuts (Windows)**

- `create_process_shortcut` — put a `.lnk` on the user's Desktop that starts ONE process later without the dashboard: double-clicking boots the daemon if needed, loads the project if needed, starts the process (plus its `links` group and the project's companions) and opens a focused single-process window with a Stop button.
- `create_project_shortcut` — the same for every process in a project; opens the dashboard rather than a single-process window.
- Both return `{ ok: true, path }`, or `{ ok: false, reason }` on a non-Windows host (`unsupported-platform`) — a reported outcome, not an error.

**Logs, errors & diagnostics**

- `get_logs` — recent in-memory log lines for a process (most recent last).
- `get_log_file` — tail a process's on-disk rotating log file (survives daemon restarts and the in-memory cap).
- `list_errors` — the de-duplicated record of process errors (stderr / crashes / error-looking stdout), most recent first.
- `clear_errors` — clear the error log (optionally for a single process id).
- `diagnose_process` — Incident Autopilot: a structured root-cause guess (exit code + error log + port ownership + command) plus a suggested remediation (never auto-executed).

**Threshold alerts**

- `list_alert_rules` / `add_alert_rule` / `remove_alert_rule` - configure rules that fire once a
  process's CPU or memory sample stays over a threshold, continuously, for a set duration (e.g.
  "alert if this process exceeds 80% CPU for 2 minutes"). Same GUI (Settings -> Alerts) and CLI
  (`devwebui alerts add|remove`) surface - all three agree.
- `list_alert_events` / `clear_alert_events` - the fired-event history a rule has produced,
  most recent first; clear it all or for one process.

**Common flows:** to onboard a repo, write its `.devwebui` file (above) then `load_project` with the
absolute path — or `scan_projects` to find existing ones. Build or reshape a project with
`add_process` / `update_process` / `update_project`. To diagnose breakage, `list_errors` then
`diagnose_process`. To hand a repo fully over to DevWebUI, `take_over_autostart` on its folder.
