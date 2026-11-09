// A launcher that reclaims a stale boot.lock must re-take the lock before it spawns the daemon.
// Otherwise two launchers that both reach the reclaim path each spawn a daemon, which is the race
// the boot lock exists to prevent. The spawn is injected so the test can see whether the lock is
// held at the moment of the spawn.
import "./isolate"; // CWD-proof data-dir isolation - must load before any server/src import
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { spawn } from "node:child_process";
import { clearInstanceInfo, writeInstanceInfo } from "../server/src/instance";
import { bootDaemonShared } from "../server/src/cli";
import { dataDir } from "../server/src/data-dir";

const ORIGINAL_FETCH = globalThis.fetch;
const lockFile = path.join(dataDir(), "boot.lock");

beforeAll(() => {
  writeInstanceInfo(59994); // the pointer findLiveInstance() reads
  // Every health probe answers as a live DevWebUI, so the post-spawn wait returns at once.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true, service: "devwebui" }), {
      status: 200,
    })) as typeof fetch;
});

afterAll(() => {
  clearInstanceInfo();
  globalThis.fetch = ORIGINAL_FETCH;
});

afterEach(() => {
  rmSync(lockFile, { force: true });
});

test("a launcher that reclaims a stale boot lock holds the lock again when it spawns the daemon", async () => {
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(lockFile, "");
  const longAgo = new Date(Date.now() - 120_000); // older than the 60s stale window
  utimesSync(lockFile, longAgo, longAgo);

  let lockHeldAtSpawn: boolean | undefined;
  const fakeSpawn = (() => {
    lockHeldAtSpawn = existsSync(lockFile);
    return { unref() {} };
  }) as unknown as typeof spawn;

  await bootDaemonShared({ ...process.env }, fakeSpawn);

  expect(lockHeldAtSpawn).toBe(true);
});
