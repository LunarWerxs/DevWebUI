// ---------------------------------------------------------------------------
// The second-instance chooser: what a release double-click sees when a daemon
// is already serving.
//
// That double-click used to silently open the EXISTING UI and exit — right when
// the user wanted exactly that, mysterious when they double-clicked BECAUSE the
// app felt wedged and expected a fresh start. This module puts the choice in a
// page: "open the existing UI" (the old behaviour) or "restart" (the old stack
// tears down and THIS process boots as its replacement).
//
// The page is served by a one-shot loopback server inside the second instance,
// not by the running daemon — the daemon's route surface is the app's API, and a
// bootstrap-time question is not part of it. Every call that touches the OLD
// daemon (the shutdown POST, the liveness probes) is made by this process rather
// than by the page: a plain Bun fetch carries no browser headers, so the
// daemon's loopback guard passes it exactly like `devwebui stop` does.
// ---------------------------------------------------------------------------
import { spawnSync } from "node:child_process";
import { ROUTES } from "../../shared/routes";
import { withLocalAuth } from "./local-auth";
import { openUi } from "./open-ui";
import { isPortListening } from "./ports";

/** How long the chooser waits for a click before falling back to the pre-chooser
 *  behaviour (open the existing UI). The tab can be closed or ignored; a process
 *  that lingers forever on an unanswered question is a zombie in its own right. */
const CHOOSER_TIMEOUT_MS = 5 * 60_000;

export type ChooserAction = "open" | "restart";
export type ChooserOutcome = "open" | "restart" | "timeout";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c;
  });
}

// --- the page -----------------------------------------------------------------------------------

/** The chooser page, self-contained (no assets, no network beyond /choose). Both
 *  languages ship inline and the page picks by navigator.language, because the
 *  second instance cannot know the locale the daemon's settings keep. */
export function buildAlreadyRunningPage(liveUrl: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>DevWebUI</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 14px/1.5 system-ui, sans-serif; background: #f5f5f5; color: #222; }
  @media (prefers-color-scheme: dark) { body { background: #161616; color: #eee; } }
  main { max-width: 26rem; margin: 1rem; padding: 1.75rem; border: 1px solid #8886;
         border-radius: 12px; }
  h1 { margin: 0 0 0.25rem; font-size: 1.25rem; }
  .url { margin: 0 0 1rem; font-family: ui-monospace, monospace; opacity: 0.75;
         word-break: break-all; }
  .row { display: flex; gap: 0.75rem; flex-wrap: wrap; }
  button { flex: 1 1 8rem; padding: 0.6rem 1rem; font: inherit; border-radius: 8px;
           border: 1px solid #8886; cursor: pointer; background: #3b82f6; color: #fff; }
  button.secondary { background: transparent; color: inherit; }
  button[disabled] { opacity: 0.6; cursor: default; }
  .after { margin: 1rem 0 0; min-height: 1.5em; }
</style>
</head>
<body>
<main>
  <h1>DevWebUI</h1>
  <p class="url">${escapeHtml(liveUrl)}</p>
  <p id="lead"></p>
  <div class="row">
    <button id="open"></button>
    <button id="restart" class="secondary"></button>
  </div>
  <p class="after" id="after"></p>
</main>
<script>
  var STR = {
    zh: {
      lead: "DevWebUI \u5df2\u7ecf\u5728\u8fd0\u884c\u3002\u8981\u6253\u5f00\u73b0\u6709\u754c\u9762\uff0c\u8fd8\u662f\u91cd\u542f\uff1f",
      open: "\u6253\u5f00\u73b0\u6709\u754c\u9762",
      restart: "\u91cd\u542f DevWebUI",
      opening: "\u6b63\u5728\u6253\u5f00\u2026\u2026",
      restarting: "\u6b63\u5728\u91cd\u542f\uff1a\u65e7\u5b9e\u4f8b\u6b63\u5728\u9000\u51fa\uff0c\u65b0\u5b9e\u4f8b\u542f\u52a8\u540e\u4f1a\u81ea\u52a8\u6253\u5f00\u7a97\u53e3\u3002",
      done: "\u5b8c\u6210\u3002\u6b64\u6807\u7b7e\u9875\u53ef\u4ee5\u5173\u95ed\u4e86\u3002",
      fail: "\u64cd\u4f5c\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5\u3002"
    },
    en: {
      lead: "DevWebUI is already running. Open the existing UI, or restart?",
      open: "Open existing UI",
      restart: "Restart DevWebUI",
      opening: "Opening\u2026",
      restarting: "Restarting: the old instance is exiting; the new one will open its window automatically.",
      done: "Done. You can close this tab now.",
      fail: "The action failed \u2014 please try again."
    }
  };
  var t = ((navigator.language || "").toLowerCase().indexOf("zh") === 0) ? STR.zh : STR.en;
  document.getElementById("lead").textContent = t.lead;
  document.getElementById("open").textContent = t.open;
  document.getElementById("restart").textContent = t.restart;
  function setAfter(text) {
    var el = document.getElementById("after");
    el.textContent = text || "";
  }
  function choose(action) {
    document.getElementById("open").disabled = true;
    document.getElementById("restart").disabled = true;
    setAfter(action === "restart" ? t.restarting : t.opening);
    fetch("/choose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: action })
    })
      .then(function (res) {
        if (!res.ok) throw new Error(String(res.status));
        setAfter(t.done);
      })
      .catch(function () {
        document.getElementById("open").disabled = false;
        document.getElementById("restart").disabled = false;
        setAfter(t.fail);
      });
  }
  document.getElementById("open").addEventListener("click", function () { choose("open"); });
  document.getElementById("restart").addEventListener("click", function () { choose("restart"); });
</script>
</body>
</html>
`;
}

// --- the request handler ------------------------------------------------------------------------

export interface PromptHandlerDeps {
  liveUrl: string;
  /** Fires at most once per action request; the orchestrator races it against the timeout. */
  onChoose: (action: ChooserAction) => void;
}

/** The chooser server's whole surface: `GET /` is the page, `POST /choose` reports the
 *  click. Cross-site browser requests are refused for parity with the daemon's own
 *  loopbackGuard — the actions here are local, but so is /api/shutdown, and that one
 *  is guarded. Non-browser callers (curl, another local process) carry no
 *  Sec-Fetch-Site and pass, exactly as they do against the daemon. */
export function createPromptHandler(
  deps: PromptHandlerDeps,
): (req: Request) => Response | Promise<Response> {
  return (req) => {
    if (req.headers.get("sec-fetch-site") === "cross-site")
      return new Response("forbidden", { status: 403 });
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/")
      return new Response(buildAlreadyRunningPage(deps.liveUrl), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    if (req.method === "POST" && url.pathname === "/choose") {
      return req
        .json()
        .then((body: unknown) => {
          const value = (body as { action?: unknown } | null)?.action;
          if (value !== "open" && value !== "restart")
            return new Response(JSON.stringify({ ok: false, error: "bad action" }), {
              status: 400,
              headers: { "content-type": "application/json" },
            });
          deps.onChoose(value);
          // Respond BEFORE the orchestrator acts: "restart" tears the old stack down and
          // that takes seconds the page must not hang on.
          return new Response(JSON.stringify({ ok: true, action: value }), {
            headers: { "content-type": "application/json" },
          });
        })
        .catch(
          () =>
            new Response(JSON.stringify({ ok: false, error: "bad body" }), {
              status: 400,
              headers: { "content-type": "application/json" },
            }),
        );
    }
    return new Response("not found", { status: 404 });
  };
}

// --- talking to the old daemon ------------------------------------------------------------------

async function defaultPostShutdown(shutdownUrl: string): Promise<boolean> {
  // The ui-source header is the same intentional-shutdown signal `devwebui stop` sends
  // (see http/core.ts's handleShutdown); withLocalAuth adds the cookie credential only
  // if the old daemon opted into local auth.
  const init = { method: "POST", headers: { "x-devwebui-shutdown-source": "ui" } };
  const res = await fetch(shutdownUrl, withLocalAuth(shutdownUrl, init));
  return res.ok;
}

async function defaultProbeAlive(url: string): Promise<boolean> {
  // Same shape as findLiveInstance's probe: only a real, answering DevWebUI counts.
  try {
    const res = await fetch(`${url}${ROUTES.health}`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean; service?: string } | null;
    return body?.ok === true && body?.service === "devwebui";
  } catch {
    return false;
  }
}

function defaultForceKill(pid: number): void {
  if (process.platform === "win32") {
    // The same tool the tray host uses; /T takes the whole tree, which is where the
    // daemon's managed servers live.
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

export interface StopDaemonDeps {
  liveUrl: string;
  livePid?: number | null;
  livePort?: number | null;
  postShutdown?: (url: string) => Promise<boolean>;
  probeAlive?: (url: string) => Promise<boolean>;
  isPortBusy?: (port: number) => Promise<boolean>;
  forceKill?: (pid: number) => void;
  /** Graceful-shutdown wait before the force-kill backstop. Injectable for tests only. */
  gracefulMs?: number;
  /** Post-kill / post-exit wait for the port to release. Injectable for tests only. */
  killWaitMs?: number;
  log?: (...args: unknown[]) => void;
}

/**
 * Tear the OLD stack down so the caller can boot as its replacement.
 *
 * The ui-source POST is the whole story when it lands: the old daemon runs its clean
 * shutdown (managed servers stopped gracefully, crash sentinel disarmed) and writes the
 * full-shutdown sentinel that takes its tray host down too. Everything after the POST —
 * the bounded liveness wait, the PID force-kill, the port-free wait — exists for the
 * daemon that never answers: a second instance that booted anyway would just hop the
 * port and leave two daemons.
 */
export async function stopLiveDaemon(deps: StopDaemonDeps): Promise<void> {
  const post = deps.postShutdown ?? defaultPostShutdown;
  const probe = deps.probeAlive ?? defaultProbeAlive;
  const isPortBusy = deps.isPortBusy ?? isPortListening;
  const forceKill = deps.forceKill ?? defaultForceKill;
  const log = deps.log ?? console.log;

  let posted = false;
  try {
    posted = await post(`${deps.liveUrl}${ROUTES.shutdown}`);
  } catch {
    posted = false;
  }
  if (!posted) log(`[devwebui] shutdown request to ${deps.liveUrl} failed — force-killing instead`);

  // Graceful window: the daemon's shutdown() bounds itself (6s settings flush + stopping
  // managed processes with their SIGTERM grace), so give it room before the backstop.
  let deadline = Date.now() + (deps.gracefulMs ?? 15_000);
  while (Date.now() < deadline && (await probe(deps.liveUrl))) await sleep(300);

  if ((await probe(deps.liveUrl)) && deps.livePid) {
    forceKill(deps.livePid);
    deadline = Date.now() + (deps.killWaitMs ?? 5_000);
    while (Date.now() < deadline && (await probe(deps.liveUrl))) await sleep(300);
  }

  // Wait for the listen socket to release so the successor rebinds the SAME port — an
  // open tab's SSE reconnects seamlessly instead of chasing the daemon to port+1.
  if (deps.livePort) {
    deadline = Date.now() + (deps.killWaitMs ?? 5_000);
    while (Date.now() < deadline && (await isPortBusy(deps.livePort))) await sleep(150);
  }
}

// --- the orchestrator ---------------------------------------------------------------------------

export interface ChooserDeps extends StopDaemonDeps {
  /** How long to wait for a click before defaulting to "open the existing UI". */
  timeoutMs?: number;
  openUi?: (url: string) => boolean;
  serve?: (handler: (req: Request) => Response | Promise<Response>) => {
    port: number;
    stop: (force?: boolean) => void;
  };
}

/**
 * Show the chooser page and resolve with what happened: a click, or "timeout" (tab
 * closed / ignored — the fallback opens the existing UI, the pre-chooser behaviour).
 * "restart" means the old stack is ALREADY down and the port has been waited for: the
 * caller should boot normally and become the replacement daemon.
 */
export async function promptAlreadyRunning(deps: ChooserDeps): Promise<ChooserOutcome> {
  const open = deps.openUi ?? openUi;
  const log = deps.log ?? console.log;
  let chosen: ChooserAction | null = null;
  const handler = createPromptHandler({
    liveUrl: deps.liveUrl,
    onChoose: (action) => {
      if (chosen === null) chosen = action;
    },
  });
  // The typed-global trick index.ts uses for Bun.serve: server/tsconfig has types:["node"],
  // no Bun globals — reach the runtime through a narrow structural cast instead.
  const serve =
    deps.serve ??
    ((h: (req: Request) => Response | Promise<Response>) => {
      const bun = (
        globalThis as unknown as {
          Bun?: {
            serve(options: {
              hostname: string;
              port: number;
              fetch: (request: Request) => Response | Promise<Response>;
            }): { port: number; stop: (force?: boolean) => void };
          };
        }
      ).Bun;
      if (!bun) throw new Error("no Bun runtime available for the chooser server");
      return bun.serve({ hostname: "127.0.0.1", port: 0, fetch: h });
    });
  const server = serve(handler);
  try {
    open(`http://127.0.0.1:${server.port}/`);
    const deadline = Date.now() + (deps.timeoutMs ?? CHOOSER_TIMEOUT_MS);
    while (chosen === null && Date.now() < deadline) await sleep(200);
    if (chosen === null) {
      log(`[devwebui] no choice made — opening the existing instance at ${deps.liveUrl}`);
      open(deps.liveUrl);
      return "timeout";
    }
    if (chosen === "open") {
      open(deps.liveUrl);
      return "open";
    }
    log(`[devwebui] restart chosen — stopping the running instance at ${deps.liveUrl}`);
    await stopLiveDaemon(deps);
    return "restart";
  } finally {
    server.stop(true);
  }
}
