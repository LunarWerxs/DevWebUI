// The one owner of "signal a process and its whole tree". Every stop, force-kill and picker/clone
// cleanup goes through here so the tree-kill rule (taskkill /T /F on win32, process-group walk
// elsewhere) lives in exactly one place.
import treeKill from "tree-kill";

/**
 * Signal `pid` and every descendant. `done` receives tree-kill's error, if any. Sync throws are
 * NOT swallowed here: callers that escalate on failure (lifecycle's SIGTERM -> SIGKILL) rely on them.
 */
export function killTree(
  pid: number,
  signal: "SIGKILL" | "SIGTERM" = "SIGKILL",
  done: (err?: Error | null) => void = () => {},
): void {
  treeKill(pid, signal, done);
}
