import "./isolate"; // CWD-proof data-dir isolation — must load before any server/src import
import { expect, test } from "bun:test";
import {
  buildAlreadyRunningPage,
  createPromptHandler,
  promptAlreadyRunning,
  stopLiveDaemon,
} from "../server/src/second-instance";

const LIVE_URL = "http://localhost:4000";

function chooseRequest(action: string): Request {
  return new Request("http://127.0.0.1:45678/choose", {
    method: "POST",
    body: JSON.stringify({ action }),
  });
}

// --- the page -----------------------------------------------------------------------------------

test("the chooser page carries both languages and the live URL, HTML-escaped", () => {
  const page = buildAlreadyRunningPage(LIVE_URL);
  expect(page).toContain(LIVE_URL);
  expect(page).toContain("DevWebUI is already running");
  expect(page).toContain("Open existing UI");
  expect(page).toContain("Restart DevWebUI");
  expect(page).toContain("\u5df2\u7ecf\u5728\u8fd0\u884c"); // zh lead
  expect(page).toContain("\u91cd\u542f DevWebUI"); // zh restart button

  // The URL is local input (runtime.json), not markup: an escaped injection must not survive.
  const hostile = buildAlreadyRunningPage(`http://localhost:4000/<script>alert(1)</script>`);
  expect(hostile).not.toContain("<script>alert"); // the page's own <script> tags are fine
  expect(hostile).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
});

// --- the handler --------------------------------------------------------------------------------

test("the prompt handler serves the page, reports a valid choice, and refuses everything else", async () => {
  const chosen: string[] = [];
  const handler = createPromptHandler({ liveUrl: LIVE_URL, onChoose: (a) => chosen.push(a) });

  const page = handler(new Request("http://127.0.0.1:45678/"));
  expect((page as Response).status).toBe(200);
  expect((page as Response).headers.get("content-type")).toContain("text/html");

  const accepted = (await handler(chooseRequest("restart"))) as Response;
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toEqual({ ok: true, action: "restart" });
  expect(chosen).toEqual(["restart"]);

  // A bad action is rejected AND does not count as a choice — the orchestrator keeps waiting.
  const badAction = (await handler(chooseRequest("format-c:"))) as Response;
  expect(badAction.status).toBe(400);
  expect(chosen).toEqual(["restart"]);

  const badBody = (await handler(
    new Request("http://127.0.0.1:45678/choose", { method: "POST", body: "not json" }),
  )) as Response;
  expect(badBody.status).toBe(400);

  // Cross-site browser requests are refused for parity with the daemon's loopbackGuard.
  const crossSite = handler(
    new Request("http://127.0.0.1:45678/choose", {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ action: "open" }),
    }),
  ) as Response;
  expect(crossSite.status).toBe(403);

  expect((handler(new Request("http://127.0.0.1:45678/nope")) as Response).status).toBe(404);
});

// --- the orchestrator ---------------------------------------------------------------------------

/** A fake serve() that hands back a fixed port and records the handler for the test to drive. */
function fakeServe() {
  let handler: ((req: Request) => Response | Promise<Response>) | null = null;
  let stopped = 0;
  return {
    serve: (h: (req: Request) => Response | Promise<Response>) => {
      handler = h;
      return {
        port: 45678,
        stop: () => {
          stopped += 1;
        },
      };
    },
    get stopped() {
      return stopped;
    },
    async choose(action: string): Promise<void> {
      if (!handler) throw new Error("server never started");
      const res = (await handler(chooseRequest(action))) as Response;
      expect(res.status).toBe(200);
    },
  };
}

test("choosing open opens the existing UI and the second instance stands down", async () => {
  const opened: string[] = [];
  const fake = fakeServe();
  const run = promptAlreadyRunning({
    liveUrl: LIVE_URL,
    timeoutMs: 5_000,
    openUi: (url) => {
      opened.push(url);
      return true;
    },
    serve: fake.serve,
    log: () => {},
  });
  await fake.choose("open");
  // The prompt page itself was opened first, then the live UI after the click.
  expect(await run).toBe("open");
  expect(opened).toEqual(["http://127.0.0.1:45678/", LIVE_URL]);
  expect(fake.stopped).toBe(1);
});

test("choosing restart stops the old daemon gracefully and waits for its port", async () => {
  const posted: string[] = [];
  const killed: number[] = [];
  const probedPorts: number[] = [];
  const fake = fakeServe();
  const run = promptAlreadyRunning({
    liveUrl: LIVE_URL,
    livePid: 4242,
    livePort: 4000,
    timeoutMs: 5_000,
    openUi: () => true,
    serve: fake.serve,
    postShutdown: async (url) => {
      posted.push(url);
      return true;
    },
    probeAlive: async () => false, // the graceful POST landed; nothing answers anymore
    isPortBusy: async (port) => {
      probedPorts.push(port);
      return false;
    },
    forceKill: (pid) => killed.push(pid),
    log: () => {},
  });
  await fake.choose("restart");
  expect(await run).toBe("restart");
  expect(posted).toEqual([`${LIVE_URL}/api/shutdown`]);
  expect(killed).toEqual([]); // graceful path — the force-kill backstop never fires
  expect(probedPorts).toContain(4000); // the successor's same-port rebind depends on this wait
});

test("a daemon that will not die gets force-killed by pid", async () => {
  const killed: number[] = [];
  await stopLiveDaemon({
    liveUrl: LIVE_URL,
    livePid: 4242,
    livePort: 4000,
    postShutdown: async () => true,
    probeAlive: async () => true, // wedged: keeps answering past the graceful window
    isPortBusy: async () => false,
    forceKill: (pid) => killed.push(pid),
    gracefulMs: 60,
    killWaitMs: 60,
    log: () => {},
  });
  expect(killed).toEqual([4242]);
});

test("an ignored chooser tab falls back to opening the existing UI", async () => {
  const opened: string[] = [];
  const fake = fakeServe();
  const outcome = await promptAlreadyRunning({
    liveUrl: LIVE_URL,
    timeoutMs: 150, // never answered
    openUi: (url) => {
      opened.push(url);
      return true;
    },
    serve: fake.serve,
    log: () => {},
  });
  expect(outcome).toBe("timeout");
  expect(opened).toEqual(["http://127.0.0.1:45678/", LIVE_URL]); // prompt page, then the fallback
  expect(fake.stopped).toBe(1);
});
