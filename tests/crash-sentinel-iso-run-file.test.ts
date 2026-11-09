// A run file the kit's crash-sentinel.mjs wrote carries startedAt as an ISO string. A leftover of
// that kind from before the current boot is a reboot, not a crash, and must be dropped rather than
// reported (which would send the next boot into safe mode).
import "./isolate"; // CWD-proof data-dir isolation - must load before any server/src import
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { armCrashSentinel, disarmCrashSentinel } from "../server/src/crash-sentinel";

test("a leftover ISO-string run file from before this boot is dropped, not reported as a crash", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "devwebui-sentinel-iso-"));
  try {
    const bootTime = Date.parse("2026-11-09T10:00:00.000Z");
    const leftover = path.join(dir, "run_old");
    writeFileSync(
      leftover,
      JSON.stringify({ pid: 999_999, startedAt: "2026-11-09T08:00:00.000Z" }),
    );

    const crashed = armCrashSentinel({ dir, isAlive: () => false, bootTime });

    expect(crashed).toBeNull();
    expect(existsSync(leftover)).toBe(false);
  } finally {
    disarmCrashSentinel();
    rmSync(dir, { recursive: true, force: true });
  }
});
