// Guard for collectStdout (server/src/spawn-capture.ts), the helper behind the process-tree
// (metrics.ts) and port-owner (ports.ts) probes.
//
// Bug: on timeout the helper resolved with whatever stdout had arrived so far, as if it were the
// whole answer. A half-read `ps` table built a wrong process tree; a half-read netstat table
// named the wrong (or no) port owner. A timed-out probe must say "no answer" (null), not "partial".
import { expect, test } from "bun:test";
import { collectStdout } from "../src/spawn-capture";

test("collectStdout: a child that is cut off by the timeout resolves null, not its partial stdout", async () => {
  // Writes a line straight away, then hangs far past the timeout.
  const out = await collectStdout(
    process.execPath,
    ["-e", "process.stdout.write('1 0\\n'); setTimeout(() => {}, 60000)"],
    { timeoutMs: 400 },
  );
  expect(out).toBeNull();
});

test("collectStdout: a child that closes cleanly resolves with its full stdout", async () => {
  const out = await collectStdout(
    process.execPath,
    ["-e", "process.stdout.write('1 0\\n2 1\\n')"],
    {
      timeoutMs: 10_000,
    },
  );
  expect(out).toBe("1 0\n2 1\n");
});
