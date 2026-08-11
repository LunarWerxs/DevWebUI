// ---------------------------------------------------------------------------
// Centralized REST paths — the single source of truth shared by the Hono route
// registrations (server/src/http.ts), the web fetch calls (web/src/api.ts), and
// the MCP client (server/src/mcp.ts). Every path includes the `/api` prefix.
//
// Static routes are plain string constants. Parameterized routes carry BOTH a
// Hono `pattern` (with `:param` placeholders, used to REGISTER the route) and a
// `build(...)` function (used to CALL the route). Keeping both in one object
// means the registration and the call site can never drift apart.
//
// The whole table is `as const` so `pattern` keeps its LITERAL string type —
// Hono infers `:param` names from the literal, so `c.req.param("id")` stays
// typed. A `ParamRoute` shape is enforced via the `_assert` check below rather
// than an inline `satisfies`, which would otherwise widen `pattern` to `string`.
// ---------------------------------------------------------------------------

/**
 * A parameterized route: its Hono registration pattern + a URL builder. The
 * builder's parameter list is intentionally `never[]` so ANY concrete builder
 * signature (one arg, two args, …) is assignable to it — this type is used only
 * as a structural shape guard, not as the call-site type.
 */
export interface ParamRoute {
  /** Hono registration pattern, e.g. "/api/processes/:id/:action". */
  pattern: string;
  /** Build the concrete URL for a call site. */
  build: (...args: never[]) => string;
}

export const ROUTES = {
  // ---- health / settings / errors ----
  health: "/api/health",
  shutdown: "/api/shutdown",
  settings: "/api/settings",
  portableWindow: "/api/portable-window",
  updates: "/api/updates",
  updatesApply: "/api/updates/apply",
  errors: "/api/errors",
  errorsClear: "/api/errors/clear",
  errorsDismiss: "/api/errors/dismiss",

  // ---- "Sync my settings with Connections" (optional, opt-in) ----
  authMe: "/api/auth/me",
  authLogout: "/api/auth/logout",
  settingsSync: "/api/settings/sync",
  settingsSyncPull: "/api/settings/sync/pull",
  settingsSyncPush: "/api/settings/sync/push",

  // ---- projects (collection + add/load/clone/scan flows) ----
  projects: "/api/projects",
  projectsLoad: "/api/projects/load",
  projectsScan: "/api/projects/scan",
  projectsIgnored: "/api/projects/ignored",
  projectsIgnore: "/api/projects/ignore",
  projectsUnignore: "/api/projects/unignore",
  projectsClone: "/api/projects/clone",
  projectsScaffold: "/api/projects/scaffold",
  projectsBrowse: "/api/projects/browse",
  projectsBrowseFolder: "/api/projects/browse-folder",
  projectsSuggestDest: "/api/projects/suggest-dest",
  projectsTakeOver: "/api/projects/take-over",
  projectsRestoreAutostart: "/api/projects/restore-autostart",

  // ---- processes (collection + bulk actions) ----
  processes: "/api/processes",
  startAll: "/api/processes/start-all",
  stopAll: "/api/processes/stop-all",

  // ---- live stream ----
  stream: "/api/stream",

  // ---- parameterized: processes ----
  /** POST a process lifecycle/toggle action (start|stop|restart|enable|disable). */
  processAction: {
    pattern: "/api/processes/:id/:action",
    build: (id: string, action: string) => `/api/processes/${id}/${action}`,
  },
  /** GET recent log lines for one process. */
  processLogs: {
    pattern: "/api/processes/:id/logs",
    build: (id: string) => `/api/processes/${id}/logs`,
  },
  /** GET a tail of a process's on-disk rotating log file (Time-Travel Log Vault). */
  processLogFile: {
    pattern: "/api/processes/:id/logfile",
    build: (id: string, lines?: number) =>
      `/api/processes/${id}/logfile${lines ? `?lines=${lines}` : ""}`,
  },
  /** POST to free a process's declared port. */
  processFreePort: {
    pattern: "/api/processes/:id/free-port",
    build: (id: string) => `/api/processes/${id}/free-port`,
  },
  /** GET a composite root-cause diagnosis for a process (Incident Autopilot). */
  processDiagnose: {
    pattern: "/api/processes/:id/diagnose",
    build: (id: string) => `/api/processes/${id}/diagnose`,
  },
  /**
   * POST a desktop shortcut that starts this process (Windows only).
   * MUST be registered before {@link ROUTES.processAction} — `/:id/:action` would
   * otherwise swallow `/:id/shortcut`, exactly as it would `/:id/free-port`.
   */
  processShortcut: {
    pattern: "/api/processes/:id/shortcut",
    build: (id: string) => `/api/processes/${id}/shortcut`,
  },

  // ---- parameterized: projects ----
  /** PUT project-level metadata (rename + recolor) — rewrites the .devwebui file's top-level name/color. */
  projectUpdate: {
    pattern: "/api/projects/:id",
    build: (id: string) => `/api/projects/${id}`,
  },
  /** POST a project lifecycle/toggle action (start|stop|enable|disable|remove). */
  projectAction: {
    pattern: "/api/projects/:id/:action",
    build: (id: string, action: string) => `/api/projects/${id}/${action}`,
  },
  /** POST a new process into a project's .devwebui file. */
  projectProcesses: {
    pattern: "/api/projects/:id/processes",
    build: (id: string) => `/api/projects/${id}/processes`,
  },
  /** PUT/DELETE one process (by its in-file localId) in a project. */
  projectProcess: {
    pattern: "/api/projects/:id/processes/:localId",
    build: (id: string, localId: string) => `/api/projects/${id}/processes/${localId}`,
  },
  /** POST a process's starred flag (floats it to the top of the list). */
  projectProcessStar: {
    pattern: "/api/projects/:id/processes/:localId/star",
    build: (id: string, localId: string) => `/api/projects/${id}/processes/${localId}/star`,
  },
  /**
   * POST a desktop shortcut that starts every process in this project (Windows only).
   * MUST be registered before {@link ROUTES.projectAction} — same `/:id/:action`
   * shadowing hazard as {@link ROUTES.processShortcut}.
   */
  projectShortcut: {
    pattern: "/api/projects/:id/shortcut",
    build: (id: string) => `/api/projects/${id}/shortcut`,
  },
} as const;

// Compile-time guard: every parameterized entry conforms to `ParamRoute`
// (a `pattern` string + a `build` function) without widening the literal
// `pattern` types that the `as const` above preserves for Hono.
type _AssertParamRoutes = {
  processAction: typeof ROUTES.processAction extends ParamRoute ? true : never;
  processLogs: typeof ROUTES.processLogs extends ParamRoute ? true : never;
  processLogFile: typeof ROUTES.processLogFile extends ParamRoute ? true : never;
  processFreePort: typeof ROUTES.processFreePort extends ParamRoute ? true : never;
  processDiagnose: typeof ROUTES.processDiagnose extends ParamRoute ? true : never;
  processShortcut: typeof ROUTES.processShortcut extends ParamRoute ? true : never;
  projectUpdate: typeof ROUTES.projectUpdate extends ParamRoute ? true : never;
  projectAction: typeof ROUTES.projectAction extends ParamRoute ? true : never;
  projectProcesses: typeof ROUTES.projectProcesses extends ParamRoute ? true : never;
  projectProcess: typeof ROUTES.projectProcess extends ParamRoute ? true : never;
  projectProcessStar: typeof ROUTES.projectProcessStar extends ParamRoute ? true : never;
  projectShortcut: typeof ROUTES.projectShortcut extends ParamRoute ? true : never;
};
const _assert: _AssertParamRoutes = {
  processAction: true,
  processLogs: true,
  processLogFile: true,
  processFreePort: true,
  processDiagnose: true,
  processShortcut: true,
  projectUpdate: true,
  projectAction: true,
  projectProcesses: true,
  projectProcess: true,
  projectProcessStar: true,
  projectShortcut: true,
};
void _assert;
