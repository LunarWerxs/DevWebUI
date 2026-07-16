import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { streamSSE } from "hono/streaming";
import type { Manager } from "../manager";
import { readSettings, writeSettings, type RuntimePref } from "../runtime";
import { applyUpdate, checkForUpdate } from "../updater";
import { setAutoUpdateEnabled, setAutoUpdateIntervalSecs } from "../auto-update";
import { ROUTES } from "../../../shared/routes";
import {
  DASHBOARD_WINDOW_SIZE,
  FOCUS_PATH_PREFIX,
  FOCUS_WINDOW_SIZE,
  WINDOW_SIZE_HINT_PARAM,
  formatWindowSizeHint,
} from "../../../shared/constants";
import { rememberedWindowSize } from "../window-size";
import {
  instanceFilePath,
  readInstanceInfo,
  updateInstanceInfo,
  writeShutdownRequest,
} from "../instance";
import { openPortableWindow } from "../portable-window.mjs";

export interface Client {
  send: (event: string, data: unknown) => Promise<void>;
}

export interface CreateAppOptions {
  requestShutdown?: () => Promise<void> | void;
  shutdownToken?: string;
  /** Port the daemon itself bound to (its own same-origin GUI origin) — see allowedOrigins(). */
  port?: number;
}

/** Parse the JSON request body, defaulting to `{}` on missing/invalid JSON. */
// biome-ignore lint/suspicious/noExplicitAny: handlers read loosely-typed fields off the body
export const readBody = (c: Context): Promise<any> => c.req.json().catch(() => ({}));

/** Standard error response: `{ error: message }` with the given status (400 by default). */
export const fail = (c: Context, message: string, status: ContentfulStatusCode = 400) =>
  c.json({ error: message }, status);

/**
 * Origins allowed to make cross-origin calls into the daemon: the daemon's own
 * bound port (belt-and-suspenders; the GUI is normally served same-origin, which
 * needs no CORS grant at all) plus the Vite dev-server origin (web/vite.config.ts,
 * `bun run dev`'s HMR proxy target) on localhost/127.0.0.1. Anything else — in
 * particular an arbitrary third-party site the user has open in another tab — is
 * rejected by both the CORS middleware and the Origin-gate below.
 */
export function allowedOrigins(port?: number): string[] {
  const origins = ["http://localhost:4010", "http://127.0.0.1:4010"];
  if (port) origins.push(`http://localhost:${port}`, `http://127.0.0.1:${port}`);
  return origins;
}

/**
 * CSRF guard for mutating requests: CORS alone only controls whether the BROWSER
 * lets the calling page read the response — a cross-origin "simple" request (e.g.
 * a bare POST with a text/plain body) still reaches and executes on the server
 * before the browser enforces same-origin policy. This middleware rejects any
 * request that carries an Origin header outside the allowlist before it reaches a
 * mutating handler. Non-browser clients (CLI/MCP/tray, curl) send no Origin header
 * at all and are unaffected.
 */
export function requireAllowedOrigin(port?: number) {
  const allowed = new Set(allowedOrigins(port));
  return async (c: Context, next: () => Promise<void>) => {
    const origin = c.req.header("origin");
    if (origin && !allowed.has(origin)) return fail(c, "forbidden origin", 403);
    await next();
  };
}

/**
 * Run a block that may throw and turn any throw into a 400 `{ error }` (via {@link fail}).
 * The block returns the success response; the wrapper returns it untouched.
 */
export const guard = async (
  c: Context,
  fn: () => Response | Promise<Response>,
): Promise<Response> => {
  try {
    return await fn();
  } catch (e) {
    return fail(c, (e as Error).message);
  }
};

// Fire-and-forget product pulse to the owner's collector — a no-op until
// DEVWEBUI_PULSE_URL (or the shared CONNECTIONS_PULSE_URL) is set. Kept inline; no
// dedicated module. Set DEVWEBUI_PULSE_DISABLE=1 (or CONNECTIONS_PULSE_DISABLE=1) to force
// it off even when a collector URL is configured — see README's "Local-first" section.
export async function recordPulse(event: string, properties?: unknown) {
  const disabled =
    process.env.DEVWEBUI_PULSE_DISABLE === "1" || process.env.CONNECTIONS_PULSE_DISABLE === "1";
  if (disabled) return { ok: true, enabled: false };
  const url = process.env.DEVWEBUI_PULSE_URL?.trim() || process.env.CONNECTIONS_PULSE_URL?.trim();
  if (!url) return { ok: true, enabled: false };
  const s = readSettings();
  if (!s.pulseInstallId) {
    s.pulseInstallId = randomUUID();
    writeSettings(s);
  }
  const token =
    process.env.DEVWEBUI_PULSE_TOKEN?.trim() || process.env.CONNECTIONS_PULSE_TOKEN?.trim();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        source: "connections",
        app: "devwebui",
        installId: s.pulseInstallId,
        event,
        properties,
        ts: new Date().toISOString(),
      }),
    });
    return { ok: res.ok, enabled: true };
  } catch {
    return { ok: false, enabled: true };
  }
}

/**
 * Wire the manager's live events (status/log/projects/errors) out to connected SSE
 * clients, and register the `/stream` endpoint they connect through.
 */
export function registerRealtime(app: Hono, manager: Manager) {
  const clients = new Set<Client>();
  const broadcast = (event: string, data: unknown) => {
    for (const c of clients) c.send(event, data).catch(() => clients.delete(c));
  };
  manager.on("status", (v) => broadcast("status", v));
  manager.on("log", (l) => broadcast("log", l));
  manager.on("projects", (p) => broadcast("projects", p));
  manager.on("errors", (e) => broadcast("errors", e));
  // Time-Travel Log Vault killer detail: a process about to (re)start whose LAST run
  // crashed. A dedicated event (not folded into "status") so the GUI can show a
  // one-shot dismissible hint without every routine status tick carrying the payload.
  manager.on("lastCrash", (v) => broadcast("lastCrash", v));
  // Auto-update lifecycle events (see server/src/auto-update.ts): the module itself has no
  // transport, so server/src/index.ts wires its broadcast hook to `manager.emit("autoUpdate", …)`,
  // relayed out to SSE clients here exactly like every other manager event.
  manager.on("autoUpdate", (v: { event: string; data: unknown }) => broadcast(v.event, v.data));

  // ---- live stream ----
  app.get(ROUTES.stream, (c) =>
    streamSSE(c, async (stream) => {
      const client: Client = {
        send: (event, data) => stream.writeSSE({ event, data: JSON.stringify(data) }),
      };
      clients.add(client);
      await stream.writeSSE({ event: "projects", data: JSON.stringify(manager.listProjects()) });
      await stream.writeSSE({ event: "errors", data: JSON.stringify(manager.listErrors()) });
      const ping = setInterval(() => void client.send("ping", Date.now()), 15000);
      stream.onAbort(() => {
        clearInterval(ping);
        clients.delete(client);
      });
      while (true) await stream.sleep(60000);
    }),
  );
}

/** Register health/update/pulse/shutdown/settings/error-log routes. */
export function registerSystemRoutes(app: Hono, manager: Manager, options: CreateAppOptions) {
  // `service` is the identity the launchers match on. Without it a responder is indistinguishable
  // from any other server that happens to answer this path -- a Vite dev server returns its SPA
  // fallback (200, text/html) for /api/health, and misc/Restart-Daemon.ps1 has to be able to tell
  // that apart from us before it kills anything. Every app in the family stamps this; DevWebUI was
  // the last one that didn't, which is why its daemon could not be found by the restart scripts.
  app.get(ROUTES.health, (c) => c.json({ ok: true, service: "devwebui", ts: Date.now() }));
  app.get(ROUTES.updates, async (c) => {
    const status = await checkForUpdate();
    void recordPulse("update_check", {
      available: status.updateAvailable,
      canApply: status.canApply,
      reason: status.reason,
    });
    return c.json(status);
  });
  app.post(ROUTES.updatesApply, async (c) =>
    guard(c, async () => {
      void recordPulse("update_apply_clicked");
      try {
        const result = await applyUpdate();
        void recordPulse("update_apply_result", {
          ok: result.ok,
          restartRequired: result.restartRequired,
        });
        return c.json(result);
      } catch (e) {
        void recordPulse("update_apply_result", {
          ok: false,
          message: e instanceof Error ? e.message : String(e),
        });
        throw e;
      }
    }),
  );
  app.post(ROUTES.pulse, async (c) => {
    const body = await readBody(c);
    const result = await recordPulse(String(body.event ?? ""), body.properties);
    return c.json(result, result.ok ? 200 : 400);
  });
  app.post(ROUTES.shutdown, async (c) => {
    const token = options.shutdownToken ?? "";
    const trayHeader = c.req.header("x-devwebui-shutdown-token") ?? "";
    const uiHeader = c.req.header("x-devwebui-shutdown-source") === "ui";
    if (!options.requestShutdown || (!uiHeader && (!token || trayHeader !== token)))
      return fail(c, "forbidden", 403);
    // A UI-source shutdown WITHOUT the tray's session token is a user "Shut Down" from the web
    // menu (or `devwebui stop`) — a request to terminate the WHOLE app, tray included. Drop a
    // sentinel the tray host polls so it disposes its notification-area icon and exits too. The
    // tray's own Restart/Rebuild/Quit carry the token, so they don't trip this; harmless when no
    // tray is running (cleared on the next daemon boot).
    if (uiHeader && (!token || trayHeader !== token)) writeShutdownRequest();
    await options.requestShutdown();
    return c.json({ ok: true });
  });

  // ---- settings (global runtime default) ----
  app.get(ROUTES.settings, (c) => c.json(readSettings()));
  app.put(ROUTES.settings, async (c) => {
    const body = await readBody(c);
    if (body.runtime !== undefined && !["auto", "node", "bun"].includes(body.runtime))
      return fail(c, "runtime must be one of: auto, node, bun");
    const optBool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
    const saved = writeSettings({
      runtime: body.runtime as RuntimePref | undefined,
      freePortOnStart: optBool(body.freePortOnStart),
      autoStartOnLaunch: optBool(body.autoStartOnLaunch),
      monitorResources: optBool(body.monitorResources),
      linkHost: typeof body.linkHost === "string" ? body.linkHost : undefined,
      autoScan: optBool(body.autoScan),
      scanExclude: Array.isArray(body.scanExclude) ? body.scanExclude : undefined,
      skipWindows: optBool(body.skipWindows),
      skipMac: optBool(body.skipMac),
      skipLinux: optBool(body.skipLinux),
      osSkip: body.osSkip && typeof body.osSkip === "object" ? body.osSkip : undefined,
      autoUpdate: optBool(body.autoUpdate),
      autoUpdateIntervalSecs:
        typeof body.autoUpdateIntervalSecs === "number" &&
        Number.isFinite(body.autoUpdateIntervalSecs)
          ? body.autoUpdateIntervalSecs
          : undefined,
      portableMode: optBool(body.portableMode),
      hideTrayIcon: optBool(body.hideTrayIcon),
    });
    manager.globalRuntime = saved.runtime;
    manager.freePortOnStart = saved.freePortOnStart;
    manager.monitorResources = saved.monitorResources;
    manager.applyMonitorResources(); // start/stop the metrics loop to match the new setting
    // Auto-update timer: toggling this starts/stops the daemon-wide auto-update timer (see
    // server/src/auto-update.ts). The interval setter clamps — persist the value it settled on.
    setAutoUpdateEnabled(saved.autoUpdate);
    setAutoUpdateIntervalSecs(saved.autoUpdateIntervalSecs);
    // Keep the runtime pointer's launcher-facing flags current so the tray sees the new
    // values within its next poll/timer tick without waiting for a daemon restart.
    updateInstanceInfo({ portableMode: saved.portableMode, hideTrayIcon: saved.hideTrayIcon });
    // Apply to anything already running — fire-and-forget so this response can't hang on
    // a stubborn kill; the GUI sees the restarts via SSE status events.
    if (body.restart) void manager.restartRunning();
    return c.json(saved);
  });

  // ---- portable window (chromeless app window instead of a browser tab) ----
  app.post(ROUTES.portableWindow, async (c) => {
    // Optional `path` opens the window on a specific in-app view rather than the
    // dashboard root (the desktop-shortcut launcher passes "/focus/<id>" to get
    // the single-process focus view). Constrained to a same-origin relative path
    // beginning with "/" and carrying no "//" authority, so a caller can never
    // redirect this window at an arbitrary external origin.
    const body = await readBody(c);
    const rel = typeof body.path === "string" && /^\/(?!\/)/.test(body.path) ? body.path : "";
    return guard(c, async () => {
      const base = readInstanceInfo()?.url ?? `http://localhost:${options.port ?? ""}`;
      const url = `${base}${rel}`;
      // Dedicated profile so Chromium remembers the app window's size/position across
      // launches instead of sharing (and fighting over) the user's main browser profile.
      // Family convention: <configDir>/portable-profile, a sibling of runtime.json — the
      // PS tray derives the identical path from the same runtime.json location so both
      // open paths share one profile.
      const profileDir = path.join(path.dirname(instanceFilePath()), "portable-profile");
      // First-run sizes, measured per view (shared/constants.ts): the focus view is a
      // small single-process launcher; every other path renders the dashboard, whose
      // layout caps at --container-max, so Chromium's never-seen-window default (~the
      // whole work area) is wrong for it too. Either way this yields to the user's own
      // resize once they make one (openPortableWindow checks the profile's saved
      // placement).
      const initialSize = rel.startsWith(FOCUS_PATH_PREFIX)
        ? FOCUS_WINDOW_SIZE
        : DASHBOARD_WINDOW_SIZE;
      // Neither of those mechanisms reaches a window whose profile already has a
      // Chromium instance running: the forwarded --app launch inherits the EXISTING
      // window's geometry, ignoring --window-size and the saved placement alike (the
      // launcher's "Open dashboard" always lands here — the launcher is that instance).
      // So also tell the page what size this window should be — its own remembered
      // size when the user has set one, the measured first-run size otherwise — and it
      // corrects itself with resizeTo (web/src/lib/window-size-hint.ts). The query
      // string is not part of Chromium's placement key, so the hint can't re-key the
      // window; a URL that won't parse just goes out without one.
      let target = url;
      try {
        const u = new URL(url);
        u.searchParams.set(
          WINDOW_SIZE_HINT_PARAM,
          formatWindowSizeHint(rememberedWindowSize(profileDir, url) ?? initialSize),
        );
        target = u.toString();
      } catch {
        /* unparseable base URL: open it un-hinted rather than fail the route */
      }
      const result = await openPortableWindow(target, { profileDir, initialSize });
      return c.json(result);
    });
  });

  // ---- error log ----
  app.get(ROUTES.errors, (c) => c.json(manager.listErrors()));
  app.post(ROUTES.errorsClear, (c) => {
    manager.clearErrors(c.req.query("processId") || undefined);
    return c.json({ ok: true });
  });
  app.post(ROUTES.errorsDismiss, async (c) => {
    const body = await readBody(c);
    const fingerprint = typeof body.fingerprint === "string" ? body.fingerprint : "";
    if (fingerprint) manager.dismissError(fingerprint);
    return c.json({ ok: true });
  });
}
