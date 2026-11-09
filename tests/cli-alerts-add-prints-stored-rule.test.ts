// `devwebui alerts add` reports the rule the daemon stored, not the numbers that were typed. The
// daemon clamps a negative threshold to 0 and a hold time above a day to one day, so echoing the
// typed values would promise a rule the daemon never created.
import "./isolate"; // CWD-proof data-dir isolation - must load before any server/src import
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { clearInstanceInfo, writeInstanceInfo } from "../server/src/instance";
import { main } from "../server/src/cli";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_LOG = console.log;

const json = (value: unknown): Response => new Response(JSON.stringify(value), { status: 200 });

const PROCESS = {
  id: "p1.api",
  localId: "api",
  name: "API",
  port: 4000,
  projectId: "p1",
  projectName: "P",
  status: "running",
};

beforeAll(() => {
  writeInstanceInfo(59995); // pins the pointer file findLiveInstance() reads
});

afterAll(() => {
  clearInstanceInfo();
  globalThis.fetch = ORIGINAL_FETCH;
});

beforeEach(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/api/health")) return json({ ok: true, service: "devwebui" });
    if (url.endsWith("/api/processes")) return json([PROCESS]);
    if (method === "POST" && url.endsWith("/api/alerts/rules")) {
      // The daemon's clamp: threshold >= 0, forMs capped at one day.
      return json({
        id: "rule1",
        processId: "p1.api",
        metric: "cpu",
        threshold: 0,
        forMs: 86_400_000,
        enabled: true,
        createdAt: 1,
      });
    }
    throw new Error(`unstubbed request: ${method} ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  console.log = ORIGINAL_LOG;
});

test("alerts add prints the threshold and hold time the daemon stored, not the typed ones", async () => {
  const lines: string[] = [];
  console.log = (...parts: unknown[]) => {
    lines.push(parts.map(String).join(" "));
  };

  await main(["alerts", "add", "p1.api", "cpu", "80", "--for-secs", "200000"]);

  const added = lines.find((l) => l.startsWith("Added alert rule"));
  expect(added).toBeDefined();
  expect(added).toContain("> 0");
  expect(added).not.toContain("> 80");
  expect(added).toContain("for 86400s");
  expect(added).not.toContain("200000s");
});
