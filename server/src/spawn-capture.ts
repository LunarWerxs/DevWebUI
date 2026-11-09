import { spawn } from "node:child_process";

/**
 * Spawn a command, capture stdout, resolve on a clean close.
 *
 * Resolves `null` when the answer is NOT whole: the timeout fired before the child closed, the
 * spawn errored, or it could not start. Partial stdout is never returned as if it were complete —
 * a half-read `ps` table yields a wrong process tree and a half-read netstat table yields a wrong
 * port owner, which is worse than no answer. A child that closes cleanly and merely hit the
 * `maxBytes` cap is still whole for the caller's purposes and resolves with the capped text.
 */
export function collectStdout(
  cmd: string,
  args: string[],
  { timeoutMs = 5000, maxBytes = 1 << 20 }: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    let child: ReturnType<typeof spawn> | null = null;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child?.kill();
      } catch {
        /* ignore */
      }
      resolve(null);
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      child = spawn(cmd, args, { windowsHide: true });
      child.stdout?.on("data", (d: Buffer) => {
        if (out.length < maxBytes) out += d.toString();
      });
      child.on("close", () => {
        clearTimeout(timer);
        if (!done) {
          done = true;
          resolve(out);
        }
      });
      child.on("error", finish);
    } catch {
      finish();
    }
  });
}
