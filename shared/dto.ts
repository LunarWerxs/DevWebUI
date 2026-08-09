// ---------------------------------------------------------------------------
// Shared DTOs — every data shape that crosses the server↔web (or server↔mcp)
// boundary. Pure type declarations only: NO runtime code, NO imports (not even
// node or zod), so both the Bun daemon and the Vue web bundle can import these
// by relative path without pulling in any dependency.
// ---------------------------------------------------------------------------

// ---- process / project lifecycle -----------------------------------------

/** Lifecycle status of a managed dev-server process. */
export type Status = "stopped" | "starting" | "waiting" | "running" | "stopping" | "crashed";

/** A managed process as projected to a client (live status + persisted config). */
export interface ProcessView {
  id: string;
  localId: string;
  name: string;
  command: string;
  cwd: string;
  cwdRaw?: string;
  color?: string;
  autostart?: boolean;
  /** User-starred processes float to the top of every list, regardless of sort. */
  starred?: boolean;
  /** Resolved run-intent: the user's persisted on/off toggle, else `autostart`. */
  enabled: boolean;
  port?: number;
  /**
   * Where the process's title links to. An absolute `http(s)://` URL is used
   * verbatim; a path like `/admin` is appended to `http://<host>:<port>`.
   * When omitted, the title links to `http://<host>:<port>` (port permitting).
   * `<host>` is the Settings → Open in browser `linkHost`, falling back to the
   * GUI page's own hostname when that's blank.
   */
  url?: string;
  runtime?: "node" | "bun";
  /** Dependency-ordered startup: a literal port, or a sibling process id, to wait on before spawning. */
  waitForPort?: number | string;
  /** Linked servers (sibling local ids): starting any member of a linked group starts the whole group. */
  links?: string[];
  /** Companion: starts whenever any other process in the project is started individually. */
  companion?: boolean;
  projectId: string;
  projectName: string;
  status: Status;
  pid: number | null;
  startedAt: number | null;
  restarts: number;
  exitCode: number | null;
  cpu: number | null;
  memory: number | null;
  /** Declared port is occupied while this process isn't the one running it. */
  conflict: boolean;
  /** While status is "waiting": the port number this process is waiting to see open. */
  waitingOnPort?: number;
  /**
   * The project's `.devwebui` changed this process's command/cwd/env on disk while it was
   * running, and DevWebUI deliberately did not apply it (a file edit must not be able to
   * relaunch a server on a new command by itself). The process is still running its
   * original definition; restarting it applies the new one.
   */
  configChanged?: boolean;
}

/** A loaded project (codebase) as projected to a client. */
export interface ProjectView {
  id: string;
  name: string;
  /** Optional accent color (CSS color string) tinting the project's stack icon; unset = theme primary. */
  color?: string;
  path: string; // absolute path of the .devwebui file
  /** Project master switch (gates the whole stack's autostart); defaults on. */
  enabled: boolean;
  processes: ProcessView[];
}

/** Editable project-level metadata sent to the daemon (rename + recolor). */
export interface ProjectMetaInput {
  name: string;
  /** CSS color string; omit or send empty to clear back to the theme default. */
  color?: string;
}

/** One line of process output, streamed over SSE and returned by the logs API. */
export interface LogLine {
  id: string; // process id
  stream: "stdout" | "stderr";
  line: string;
  ts: number;
}

/** Editable shape sent to the daemon when creating/updating a process. */
export interface ProcessInput {
  id: string;
  name: string;
  command: string;
  cwd?: string;
  color?: string;
  port?: number;
  url?: string;
  autostart?: boolean;
  starred?: boolean;
  runtime?: "node" | "bun";
  waitForPort?: number | string;
  links?: string[];
  companion?: boolean;
}

// ---- machine scan ---------------------------------------------------------

/** A .devwebui file found on disk by the machine scan. */
export interface FoundFile {
  path: string;
  name: string;
  processes: number;
  valid: boolean;
}

/** A project folder found by package/script detection, but not configured yet. */
export interface DetectedProject {
  path: string;
  name: string;
  framework?: string;
  processes: number;
}

export interface ScanResult {
  files: FoundFile[];
  detected: DetectedProject[];
  scannedDirs: number;
  truncated: boolean; // hit the result limit
  timedOut: boolean; // hit the time budget
  ms: number;
  roots: string[];
}

/** Server-owned scan profiles — ask for an intent, not raw depth/budget/limit numbers. */
export type ScanPreset = "startup" | "quick" | "deep" | "scoped";

// ---- settings -------------------------------------------------------------

export type RuntimePref = "auto" | "node" | "bun";

export interface Settings {
  runtime: RuntimePref;
  freePortOnStart: boolean; // free a process's declared port (kill the holder) before starting it
  autoStartOnLaunch: boolean; // start every enabled server when the daemon boots (default OFF)
  monitorResources: boolean; // sample per-process CPU + memory (in-process on Windows; no child processes)
  linkHost: string; // host used when opening a process from its title (http://<host>:<port>); blank = the GUI page's own hostname
  autoScan: boolean; // sweep the machine for .devwebui files when the GUI loads (default OFF)
  firstScanDone: boolean; // per-machine marker: one startup scan runs on the very FIRST launch even when autoScan is off, then this latches so it never repeats. NOT synced (see connections.ts PREF_KEYS).
  scanExclude: string[]; // extra folder names / absolute paths to skip while scanning
  skipWindows: boolean; // skip Windows system folders while scanning
  skipMac: boolean; // skip macOS system folders
  skipLinux: boolean; // skip Linux system folders
  osSkip: Record<"windows" | "mac" | "linux", string[]>; // the editable per-OS skip lists (seeded from defaults)
  pulseInstallId?: string; // anonymous install id used only when a Connections pulse endpoint is configured
  /**
   * Auto-update the app on a schedule: check the update remote, and when a newer commit is
   * available AND the working tree is clean (canApply), pull + reinstall + rebuild, then
   * self-relaunch so the new code takes over — see server/src/auto-update.ts. Default OFF
   * (opt-in): it restarts the daemon unattended. A dirty tree is never updated.
   */
  autoUpdate: boolean;
  /** Auto-update check cadence in seconds. Clamped to [900, 604800]; default 21600 (6 h). */
  autoUpdateIntervalSecs: number;
  /**
   * Open the app UI in a chromeless Chromium app window (`--app=URL`) instead of a
   * normal browser tab — both from the in-app toggle and the tray/desktop launcher.
   * Default OFF. See server/src/portable-window.mjs (shared kit) + POST /api/portable-window.
   */
  portableMode: boolean;
  /**
   * Hide the tray notification-area icon. Default OFF. The daemon and tray keep running
   * in the background either way — re-launching the shortcut reopens the UI, and the icon
   * can be turned back on right here in Settings. See misc/DevWebUI-Tray.ps1.
   */
  hideTrayIcon: boolean;
}

// ---- scaffold detection ---------------------------------------------------

/** A dev process the daemon detected and could write into a scaffolded .devwebui. */
export interface DetectedProcess {
  id: string;
  name: string;
  command: string;
  cwd?: string; // relative to the .devwebui (set for workspace packages)
  port?: number;
  color?: string;
  runtime?: "node" | "bun"; // pinned to "bun" for Bun projects (efficient Vite)
}

/**
 * A proposed .devwebui the daemon built from a folder's dev scripts. Unifies the
 * server's `Detection` and the web's `ProjectProposal` — they describe the same
 * thing (name/framework/processes/truncated).
 */
export interface Detection {
  name: string;
  framework?: string;
  processes: DetectedProcess[];
  /** How many dev scripts were dropped to keep the list manageable. */
  truncated?: number;
}

/** Alias kept for the web's historical name for {@link Detection}. */
export type ProjectProposal = Detection;

// ---- external auto-start "take over" --------------------------------------

export type AutostartKind = "vscode-task" | "vite-extension";

/** A dev server that starts OUTSIDE DevWebUI (VS Code tasks.json / Vite extension). */
export interface AutostartTrigger {
  kind: AutostartKind;
  file: string; // absolute path to the config file holding the trigger
  label: string; // short human label, e.g. 'VS Code task "dev server"'
  detail: string; // what it does, e.g. "runs `bun run dev` when the folder opens"
}

/** Outcome of retiring a folder's external auto-start triggers. */
export interface TakeOverResult {
  ok?: boolean;
  disabled: AutostartTrigger[];
  backups: string[]; // backup files written (one per edited file, kept pristine)
  skipped: { file: string; reason: string }[];
}

// ---- ports / free-port ----------------------------------------------------

/** A process holding a port: its PID and a human-readable name (for confirmation prompts). */
export interface PortOwner {
  pid: number;
  name: string;
  /** Full command line (best-effort; undefined when it couldn't be read, e.g. no permission). */
  cmdline?: string;
  /** Human-readable process uptime, e.g. "2h 14m" (best-effort; undefined when unavailable). */
  uptime?: string;
}

/** Outcome of a "free this port" request. `needsConfirm` means external owners need an OK. */
export interface FreePortResult {
  ok?: boolean;
  /** External (unmanaged) owners are present and `confirm` wasn't set — the GUI must confirm. */
  needsConfirm?: boolean;
  /** External processes holding the port (shown to the user before killing). */
  owners?: PortOwner[];
  /** Managed processes we stopped cleanly (preferred over killing). */
  stoppedManaged?: string[];
}

// ---- add a project --------------------------------------------------------

/** Result shape shared by every "add a project" path. */
export type AddResult = {
  ok?: boolean;
  cancelled?: boolean;
  error?: string;
  cloned?: string;
  created?: string;
  // When a folder has no .devwebui but we can build one from its dev scripts:
  needsScaffold?: boolean;
  dir?: string;
  fileName?: string;
  proposal?: ProjectProposal;
  // When the added/loaded repo also auto-starts its dev server outside DevWebUI:
  autostartTriggers?: AutostartTrigger[];
  /**
   * True when this exact path had never been added before, so DevWebUI registered its
   * processes WITHOUT starting any of them, `autostart: true` included. Adding a project
   * must not silently execute a repo's commands; the GUI tells the user they're staged
   * and waiting for an explicit Start.
   */
  firstLoad?: boolean;
};

// ---- app updates / pulse --------------------------------------------------

export interface UpdateStatus {
  ok: boolean;
  service: "devwebui";
  currentVersion: string;
  currentCommit: string | null;
  remoteCommit: string | null;
  branch: string | null;
  upstream: string | null;
  remote: string | null;
  dirty: boolean;
  updateAvailable: boolean;
  canApply: boolean;
  checkedAt: number;
  reason: string | null;
}

export interface UpdateApplyResult {
  ok: boolean;
  message: string;
  restartRequired: boolean;
  status: UpdateStatus;
  output: string[];
}

// ---- persisted error log ---------------------------------------------------

export type ErrorSource = "stderr" | "stdout" | "crash";

/** A de-duplicated error-log entry, as projected to a client (see server/src/errors.ts). */
export interface ErrorEvent {
  fingerprint: string;
  processId: string;
  localId: string;
  processName: string;
  projectId: string;
  projectName: string;
  source: ErrorSource;
  sample: string; // original (ANSI-stripped) text, truncated
  count: number;
  firstSeen: number;
  lastSeen: number;
}

// ---- desktop shortcuts (Windows) -------------------------------------------

/** Why {@link ShortcutResult} came back unsuccessful. */
export type ShortcutFailure =
  /** Shortcut creation is Windows-only; macOS/Linux get this rather than a throw. */
  | "unsupported-platform"
  /** A path or id carried a character that cannot be embedded in a .lnk safely. */
  | "bad-input"
  /** The PowerShell that builds the .lnk refused, timed out, or is unavailable. */
  | "powershell-failed";

/**
 * Outcome of creating a desktop shortcut (server/src/shortcuts.ts). Failures come back
 * at HTTP 200 as `{ ok: false }` rather than as an error status: none of them mean the
 * request was malformed, and the GUI reports them as a message instead of a red failure.
 */
export type ShortcutResult =
  | { ok: true; path: string }
  | { ok: false; reason: ShortcutFailure; detail?: string };
