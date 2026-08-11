import { spawn } from "node:child_process";
import { Manager } from "./manager";
import { createApp } from "./http";
import { applyToManager } from "./http/connections-routes";
import { readDevWebUIFile, readRegistry } from "./projects";
import { startProjectWatch } from "./project-watch";
import { materializeSettings, readSettings } from "./runtime";
import { flushPending, initConnections, pullNow, syncStatus } from "./connections";
import { daemonPort } from "./constants";
import { findFreePort, isPortListening } from "./ports";
import { skipSingleInstanceGuard } from "./single-instance";
import {
  clearInstanceInfo,
  clearShutdownRequest,
  findLiveInstance,
  writeInstanceInfo,
} from "./instance";
import {
  setAutoUpdateEnabled,
  setAutoUpdateIntervalSecs,
  setUpdateNotifyEnabled,
  setAutoUpdateBroadcast,
  setAutoUpdateHooks,
  startAutoUpdate,
  stopAutoUpdate,
} from "./auto-update";
import { initFileLogging } from "./log-file.mjs";
import { dataDir } from "./data-dir";
import { openUi } from "./open-ui";
import { cleanupStaleUpdateArtifacts } from "./updater";

// ---------------------------------------------------------------------------
// CLI dispatch — must stay the FIRST side effect in this file.
//
// scripts/build.ts compiles THIS module into dist/devwebui.exe, so without this
// branch the shipped binary could only ever boot the daemon: a machine with the
// portable exe (no repo, no Bun) would have no CLI at all, and a desktop shortcut
// would have nothing to invoke. Any argv beyond the program name is handed to the
// CLI, which exits without ever starting a server.
//
// A bare launch falls through to the daemon below, unchanged — and every existing
// launcher is bare: the tray, dev.ts, and the auto-update relaunch all respawn with
// `process.argv.slice(1)`, which carries no verb (index.ts:~169).
//
// Ordering matters: this sits above initFileLogging so a one-shot CLI invocation
// doesn't tee its output into the long-running daemon's log file.
// ---------------------------------------------------------------------------
if (process.argv.length > 2) {
  const { run } = await import("./cli");
  await run(process.argv.slice(2));
  process.exit(process.exitCode ?? 0);
}

cleanupStaleUpdateArtifacts();

const releaseDoubleClick =
  (globalThis as { __DEVWEBUI_RELEASE_BUILD__?: boolean }).__DEVWEBUI_RELEASE_BUILD__ === true &&
  process.env.DEVWEBUI_RELAUNCH !== "1" &&
  !process.env.DEVWEBUI_TRAY_SHUTDOWN_TOKEN;

// Persist console output to <CONFIG_DIR>/logs/daemon.log BEFORE anything else can throw, so
// the crash reason logged just below actually survives the process (the tray runs us with a
// hidden console, so without this the output would vanish). Best-effort; never throws. The
// config dir comes from dataDir() (the shared kit lib takes it as a required argument).
initFileLogging(dataDir());

// Last-resort crash handlers: an unhandled throw/rejection anywhere in the daemon logs what
// happened and exits non-zero instead of dying silently (or, for a rejection, limping on in an
// unknown state). The tray's health watchdog sees the daemon go unresponsive and relaunches it;
// the console.error above is now teed to daemon.log, so the reason is on disk even after the
// process is gone.
//
// They also take the managed children down with us. DevWebUI's core promise is that it owns
// the lifecycle of the servers it launches; exiting on a stray throw while leaving a fleet of
// orphaned dev servers holding their ports is the loudest possible way to break it, and the
// user is then hunting PIDs by hand. `killAllSync` is deliberately synchronous — these
// handlers exit immediately, so there is no event loop left to await the normal `stopAll()`.
// Assigned after the Manager is constructed below; null before that, when nothing has spawned.
let liveManager: Manager | null = null;
const killChildrenOnCrash = () => {
  try {
    const killed = liveManager?.killAllSync() ?? [];
    if (killed.length) console.error(`[devwebui] killed ${killed.length} managed process(es).`);
  } catch (e) {
    console.error("[devwebui] failed to kill managed processes during crash exit:", e);
  }
};
process.on("uncaughtException", (err) => {
  console.error("[devwebui] uncaught exception:", err);
  killChildrenOnCrash();
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[devwebui] unhandled rejection:", reason);
  killChildrenOnCrash();
  process.exit(1);
});

// Single instance: if a DevWebUI daemon is already serving, don't start a second
// one (a second would just hop to another port and confuse the launcher/MCP about
// which instance is "the" one). The dev launcher (DEVWEBUI_PORT_FIXED) and the
// auto-update successor (DEVWEBUI_RELAUNCH) are exempt; see skipSingleInstanceGuard
// for why, and single-instance.test.ts for the regression guard on that exemption.
if (!skipSingleInstanceGuard()) {
  const live = await findLiveInstance();
  if (live) {
    console.log(
      `\n  DevWebUI is already running  →  ${live.url}\n  Not starting a second instance.\n`,
    );
    if (releaseDoubleClick && process.env.DEVWEBUI_NO_OPEN !== "1") openUi(live.url);
    process.exit(0);
  }
}

/** Poll until `port` is free (the predecessor released it), up to timeoutMs. Used by the
 *  auto-update relaunch: a daemon respawned with DEVWEBUI_RELAUNCH=1 waits for its predecessor
 *  to free the preferred port so it rebinds the SAME port — an open browser tab's SSE then
 *  reconnects seamlessly instead of the daemon hopping to a port the tab can't reach. */
async function waitForPortFree(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortListening(port))) return;
    await new Promise((r) => setTimeout(r, 300));
  }
}

// Pick a port the same way we treat the dev servers we manage: prefer the
// configured one, but if it's busy (a stale daemon, or anything else holding it)
// move to the next free port instead of crashing on bind. The chosen port is
// published to ~/.devwebui/runtime.json so the launcher opens the right URL.
const DESIRED_PORT = daemonPort();
// A daemon relaunched by the auto-updater (DEVWEBUI_RELAUNCH=1) waits for its predecessor to
// free the preferred port BEFORE probing/binding, so it rebinds the SAME port.
if (process.env.DEVWEBUI_RELAUNCH === "1") await waitForPortFree(DESIRED_PORT, 8000);
// Normally probe for a free port and hop if the preferred one is busy. The dev
// launcher (server/src/dev.ts) instead RESERVES a free port up front and pins it
// via DEVWEBUI_PORT_FIXED so the daemon and the Vite proxy bind the same port —
// in that case bind it directly (a second probe could diverge from Vite's target).
const PORT =
  process.env.DEVWEBUI_PORT_FIXED === "1" ? DESIRED_PORT : await findFreePort(DESIRED_PORT);

materializeSettings(); // write the full settings file (incl. editable osSkip lists) on first run
const manager = new Manager();
liveManager = manager; // arm the crash handlers registered above
const startupSettings = readSettings();
manager.globalRuntime = startupSettings.runtime;
manager.freePortOnStart = startupSettings.freePortOnStart;
manager.monitorResources = startupSettings.monitorResources;
manager.applyMonitorResources(); // honour the saved toggle (constructor starts it on by default)
// Auto-update: opt-in (it restarts the daemon) → absent/false = off. Prime the runtime flags now;
// the timer itself only STARTS after boot (startAutoUpdate below), one interval out.
setAutoUpdateEnabled(startupSettings.autoUpdate === true);
setAutoUpdateIntervalSecs(startupSettings.autoUpdateIntervalSecs);
// Update-notify: the opposite default — absent/true = on. It only announces (SSE
// `update_available`), so the check timer runs even when auto-update stays off.
setUpdateNotifyEnabled(startupSettings.updateNotify !== false);

// Auto-load every remembered .devwebui file. Only auto-START them when the user has
// opted in (autoStartOnLaunch) — otherwise a daemon boot would stampede every server.
let loaded = 0;
for (const file of readRegistry()) {
  try {
    manager.addProject(readDevWebUIFile(file), { autostart: startupSettings.autoStartOnLaunch });
    loaded += 1;
  } catch (e) {
    console.error(`[devwebui] skipping ${file}: ${(e as Error).message}`);
  }
}

// Auto-update continuity: our predecessor handed us the ids it had RUNNING when it stepped
// aside (see the relaunch hook below). Applying an update otherwise silently took every dev
// server down and left it down, because the successor only auto-starts when the separate
// `autoStartOnLaunch` setting happens to be on — so the one feature whose whole promise is
// "update without you noticing" was the one that stopped your work. Resume exactly that set,
// nothing more: processes the user had stopped stay stopped.
const resumeIds = (process.env.DEVWEBUI_RELAUNCH_RESUME ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (process.env.DEVWEBUI_RELAUNCH === "1" && resumeIds.length) {
  manager.startProcesses(resumeIds);
  console.log(`[devwebui] resuming ${resumeIds.length} process(es) after auto-update.`);
}

// That loop is the ONLY time a project's file is read at boot, and the daemon outlives
// any edit — so from here on, watch each loaded file and re-read it when it changes.
// Without this, a `.devwebui` edit stays invisible until the daemon restarts: the GUI
// renders what the daemon holds, so reloading the browser can't surface it.
const projectWatcher = startProjectWatch(manager);

// Advertise where we actually landed, then keep it tidy on a clean exit. (A hard
// kill skips this; readers re-validate the pointer with /api/health, so a stale
// file is harmless.) `portableMode`/`hideTrayIcon` ride along as launcher-facing
// extras so the tray can decide app-window vs. tab and icon visibility without a
// round-trip to the daemon.
writeInstanceInfo(PORT, {
  portableMode: startupSettings.portableMode === true,
  hideTrayIcon: startupSettings.hideTrayIcon === true,
});
// Clear any stale "full shutdown" sentinel left by a previous (possibly hard-killed) run so a
// leftover can't make a freshly-launched tray quit the instant it starts. Only a genuine
// in-session UI shutdown (the /api/shutdown route) writes a fresh one; the tray watches for it.
clearShutdownRequest();
const cleanup = () => clearInstanceInfo();
process.on("exit", cleanup);

let shuttingDown = false;
async function shutdown(exitCode = 0, exitDelayMs = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  let code = exitCode;
  try {
    await Promise.race([
      flushPending().catch((error) => {
        console.error(
          `[devwebui] final settings sync failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }),
      new Promise<void>((resolve) => setTimeout(resolve, 6_000)),
    ]);
    cleanup();
    stopAutoUpdate();
    projectWatcher.stop();
    await manager.stopAll();
  } catch (e) {
    console.error(`[devwebui] clean shutdown failed: ${(e as Error).message}`);
    if (code === 0) code = 1;
  } finally {
    manager.dispose();
    setTimeout(() => process.exit(code), exitDelayMs);
  }
}

for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    void shutdown(0);
  });

const app = createApp(manager, {
  shutdownToken: process.env.DEVWEBUI_TRAY_SHUTDOWN_TOKEN,
  requestShutdown: () => shutdown(0, 250),
  port: PORT,
});

// Auto-update loop (opt-in; see server/src/auto-update.ts). When it applies an update it must
// restart the daemon ITSELF — the tray is a bare supervisor that never relaunches us. So hand it a
// relaunch that spawns a DETACHED copy of this exact launch command (DEVWEBUI_RELAUNCH=1 so the
// successor waits for our port), then gracefully shuts THIS daemon down to free the port. Its
// broadcast is wired to the Manager's EventEmitter so registerRealtime relays it out over SSE
// exactly like every other manager event.
setAutoUpdateBroadcast((event, data) => manager.emit("autoUpdate", { event, data }));
setAutoUpdateHooks({
  relaunch: () => {
    // Snapshot what's running BEFORE we shut down, and hand it to the successor so the
    // update doesn't leave the user's fleet stopped. Env var rather than a file: nothing
    // to clean up, nothing to go stale, and it dies with the process if the spawn fails.
    const resume = manager.runningIds();
    try {
      const child = spawn(process.argv[0]!, process.argv.slice(1), {
        cwd: process.cwd(),
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env, DEVWEBUI_RELAUNCH: "1", DEVWEBUI_RELAUNCH_RESUME: resume.join(",") },
      });
      child.unref();
    } catch (e) {
      console.error(
        "[devwebui] auto-update relaunch failed to spawn — staying on the running version.",
        e,
      );
      return; // never shut down without a successor
    }
    console.log("[devwebui] auto-update applied — relaunching the daemon…");
    setTimeout(() => void shutdown(0), 800); // let the successor start, then free the port
  },
});
startAutoUpdate();

// "Sync my settings with Connections" — load the persisted refresh token, then (if the owner
// enabled sync) pull the cloud copy in the BACKGROUND so a fresh machine converges without
// blocking boot on the network; a landed pull is applied to the live manager.
initConnections();
if (syncStatus().enabled) {
  void pullNow()
    .then(({ applied }) => applied && applyToManager(manager, applied))
    .catch(() => {}); // best-effort boot converge — boot must not block on the network; a failed
  // pull just leaves local settings in place until the next sync attempt
}

const moved = PORT !== DESIRED_PORT ? `  (port ${DESIRED_PORT} was busy)` : "";
console.log(`
  DevWebUI daemon  →  http://localhost:${PORT}${moved}
  loaded          →  ${loaded} project(s) from registry
`);

const bunRuntime = (
  globalThis as unknown as {
    Bun: {
      serve(options: {
        hostname: string;
        port: number;
        fetch: (request: Request) => Response | Promise<Response>;
        idleTimeout: number;
      }): { port: number };
    };
  }
).Bun;
const server = bunRuntime.serve({
  // LOOPBACK ONLY, and not optional. Bun.serve defaults to 0.0.0.0 when `hostname` is
  // omitted, which put the daemon on every interface — reachable from anything sharing the
  // network. The API is unauthenticated by design (single-user, own machine) and the CSRF
  // guard in loopback-guard.mjs explicitly assumes this bind: it trusts any request without
  // browser provenance headers, so a LAN client only had to send `Host: 127.0.0.1` to drive
  // every mutating route, including the ones that spawn configured commands. Binding
  // loopback is what makes that guard's threat model true. See tests/bind-address.test.ts.
  hostname: "127.0.0.1",
  port: PORT,
  fetch: app.fetch,
  idleTimeout: 255, // keep SSE connections alive (Bun max)
});

if (releaseDoubleClick && process.env.DEVWEBUI_NO_OPEN !== "1") {
  const url = `http://127.0.0.1:${server.port}/`;
  if (!openUi(url))
    console.error(`[devwebui] Could not open a browser automatically. Open ${url} manually.`);
}
