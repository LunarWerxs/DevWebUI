// All 31 tools in server/src/mcp.ts are thin wrappers mapping args to a REST call — a typo'd
// ROUTES.* build() call or a wrong HTTP method is the entire risk (server/src/mcp.ts's own header
// comment says as much). Nothing in that file is exported, and its top-level code ends in
// `await runMcpStdio(...)`, which reads process.stdin forever — importing it unmodified would
// hang the test process (verified: mcp-stdio.mjs's runMcpStdio does `for await (const chunk of
// process.stdin)`, which never sees EOF under `bun test`).
//
// So this mocks "./mcp-stdio.mjs" (the module mcp.ts imports it from) with a stub `runMcpStdio`
// that just captures `ctx.tools` and resolves immediately, instead of looping. `mock.module`
// resolves by the mocked specifier's ABSOLUTE path, not by string-matching it against mcp.ts's
// own "./mcp-stdio.mjs" import text, so a relative path from THIS file still intercepts the same
// module (confirmed against a throwaway repro before writing this file). Once mcp.ts's top-level
// await resolves, the captured `tools` array is the real TOOLS table, unexported but reachable.
//
// `mock.module` replaces the module in the process-wide registry — bun runs every test FILE in
// one shared process, so without restoring it in afterAll, every OTHER file that imports
// mcp-stdio.mjs after this one (server/tests/server-lib/mcp-stdio.test.ts imports handleRpc from
// it directly) would get this stub instead and fail with "Export named 'handleRpc' not found"
// (reproduced while writing this file). Capture the real module first, put it back afterward.
import "./isolate"; // CWD-proof data-dir isolation — must load before any server/src import (mcp.ts imports ./instance)
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import * as realMcpStdio from "../server/src/mcp-stdio.mjs";
import type { McpEngineTool } from "../server/src/mcp-stdio.mjs";

let TOOLS: McpEngineTool[] = [];
const originalFetch = globalThis.fetch;
let calls: { url: string; init?: RequestInit }[] = [];

beforeAll(async () => {
  process.env.DEVWEBUI_URL = "http://test-daemon.local"; // pin daemonBase() — no real network, no instance-file lookup
  mock.module("../server/src/mcp-stdio.mjs", () => ({
    ...realMcpStdio,
    runMcpStdio: async (ctx: { tools: McpEngineTool[] }) => {
      TOOLS = ctx.tools;
    },
  }));
  await import("../server/src/mcp.ts");
});

afterAll(() => {
  mock.module("../server/src/mcp-stdio.mjs", () => realMcpStdio); // undo the stub for later test files
  globalThis.fetch = originalFetch;
  delete process.env.DEVWEBUI_URL;
});

/** Stub global fetch to record the call and answer with an empty-but-valid JSON body. */
function stubFetch() {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({}), { status: 200 });
  }) as typeof fetch;
}

function toolNamed(name: string): McpEngineTool {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`tool "${name}" not found — ${TOOLS.length} tools loaded`);
  return t;
}

test("all 31 tools are loaded", () => {
  expect(TOOLS.length).toBe(31);
});

// One row per tool: the args it's invoked with, and the request it MUST produce. `body` is
// omitted for GET/bodyless calls; when present it's checked as a parsed-JSON deep-equal (not a
// raw string) so key order in the tool's source can't cause a spurious failure.
interface Case {
  name: string;
  args: Record<string, unknown>;
  method: string;
  url: string;
  body?: unknown;
}

const cases: Case[] = [
  { name: "list_projects", args: {}, method: "GET", url: "/api/projects" },
  {
    name: "load_project",
    args: { path: "C:/repo/.devwebui" },
    method: "POST",
    url: "/api/projects/load",
    body: { path: "C:/repo/.devwebui" },
  },
  {
    name: "update_project",
    args: { id: "p1", name: "New", color: "#fff" },
    method: "PUT",
    url: "/api/projects/p1",
    body: { name: "New", color: "#fff" },
  },
  {
    name: "clone_project",
    args: { url: "https://example.test/repo.git", dest: "C:/dest" },
    method: "POST",
    url: "/api/projects/clone",
    body: { url: "https://example.test/repo.git", dest: "C:/dest" },
  },
  {
    name: "scan_projects",
    args: { roots: ["C:/"], preset: "quick" },
    method: "POST",
    url: "/api/projects/scan",
    body: { roots: ["C:/"], preset: "quick" },
  },
  {
    name: "remove_project",
    args: { id: "p1" },
    method: "POST",
    url: "/api/projects/p1/remove",
  },
  { name: "start_project", args: { id: "p1" }, method: "POST", url: "/api/projects/p1/start" },
  { name: "stop_project", args: { id: "p1" }, method: "POST", url: "/api/projects/p1/stop" },
  { name: "list_processes", args: {}, method: "GET", url: "/api/processes" },
  {
    name: "add_process",
    args: { projectId: "p1", id: "api", name: "API", command: "bun run dev" },
    method: "POST",
    url: "/api/projects/p1/processes",
    body: { id: "api", name: "API", command: "bun run dev" },
  },
  {
    name: "update_process",
    args: { projectId: "p1", localId: "api", id: "api", name: "API", command: "bun run dev" },
    method: "PUT",
    url: "/api/projects/p1/processes/api",
    body: { id: "api", name: "API", command: "bun run dev" },
  },
  {
    name: "remove_process",
    args: { projectId: "p1", localId: "api" },
    method: "DELETE",
    url: "/api/projects/p1/processes/api",
  },
  {
    name: "set_process_starred",
    args: { projectId: "p1", localId: "api", starred: true },
    method: "POST",
    url: "/api/projects/p1/processes/api/star",
    body: { starred: true },
  },
  {
    name: "create_process_shortcut",
    args: { id: "p1.api" },
    method: "POST",
    url: "/api/processes/p1.api/shortcut",
  },
  {
    name: "create_project_shortcut",
    args: { id: "p1" },
    method: "POST",
    url: "/api/projects/p1/shortcut",
  },
  {
    name: "start_process",
    args: { id: "p1.api" },
    method: "POST",
    url: "/api/processes/p1.api/start",
  },
  {
    name: "stop_process",
    args: { id: "p1.api" },
    method: "POST",
    url: "/api/processes/p1.api/stop",
  },
  {
    name: "restart_process",
    args: { id: "p1.api" },
    method: "POST",
    url: "/api/processes/p1.api/restart",
  },
  { name: "start_all", args: {}, method: "POST", url: "/api/processes/start-all" },
  { name: "stop_all", args: {}, method: "POST", url: "/api/processes/stop-all" },
  { name: "get_logs", args: { id: "p1.api" }, method: "GET", url: "/api/processes/p1.api/logs" },
  {
    name: "get_log_file",
    args: { id: "p1.api", lines: 50 },
    method: "GET",
    url: "/api/processes/p1.api/logfile?lines=50",
  },
  {
    name: "free_port",
    args: { id: "p1.api", confirm: true },
    method: "POST",
    url: "/api/processes/p1.api/free-port",
    body: { confirm: true },
  },
  { name: "list_errors", args: {}, method: "GET", url: "/api/errors" },
  {
    name: "clear_errors",
    args: { processId: "p1.api" },
    method: "POST",
    url: "/api/errors/clear?processId=p1.api",
  },
  {
    name: "enable_process",
    args: { id: "p1.api" },
    method: "POST",
    url: "/api/processes/p1.api/enable",
  },
  {
    name: "disable_process",
    args: { id: "p1.api" },
    method: "POST",
    url: "/api/processes/p1.api/disable",
  },
  { name: "enable_project", args: { id: "p1" }, method: "POST", url: "/api/projects/p1/enable" },
  {
    name: "disable_project",
    args: { id: "p1" },
    method: "POST",
    url: "/api/projects/p1/disable",
  },
  {
    name: "diagnose_process",
    args: { id: "p1.api" },
    method: "GET",
    url: "/api/processes/p1.api/diagnose",
  },
  {
    name: "take_over_autostart",
    args: { dir: "C:/repo" },
    method: "POST",
    url: "/api/projects/take-over",
    body: { dir: "C:/repo" },
  },
];

for (const c of cases) {
  test(`${c.name}: builds ${c.method} ${c.url}`, async () => {
    stubFetch();
    await toolNamed(c.name).run(c.args);
    expect(calls.length).toBe(1);
    const call = calls[0]!;
    expect(call.url).toBe(`http://test-daemon.local${c.url}`);
    expect((call.init?.method ?? "GET").toUpperCase()).toBe(c.method);
    if (c.body !== undefined) {
      expect(JSON.parse(String(call.init?.body))).toEqual(c.body);
    } else {
      expect(call.init?.body).toBeUndefined();
    }
  });
}
