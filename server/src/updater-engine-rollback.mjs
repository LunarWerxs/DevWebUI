/**
 * The rollback after a failed install or build (part of updater-engine.mjs, synced with it).
 *
 * Unattended self-update: a failed install/build must never leave the checkout half-upgraded (new
 * code, stale deps/build). Reset back to the pre-update commit (the pull was ff-only), then
 * best-effort rerun the steps the update made due, so the running daemon stays consistent.
 *
 * The tree was only proven clean before the pull. Install + build run for minutes, and a developer
 * editing the checkout meanwhile (a source install is the tree they work in) has changes the clean
 * check never saw, which `git reset --hard` would erase. So the tree is read again: anything that
 * changed since goes into a named git stash before the reset. If the tree cannot be read, or the
 * stash fails, the reset does not run: a half-updated checkout is recoverable by hand, a deleted
 * edit is not. Edits the update had taken as its own (`landed`) are put back unstaged afterwards.
 */

import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { APPLY_TIMEOUT_MS, CHECK_TIMEOUT_MS, commandSummary, oneAtATime, runDueSteps } from "./updater-engine-run.mjs";

function rollbackMessage(msg, reset, restored, stashName, changedCount) {
  const preserved = stashName
    ? `; ${changedCount} file(s) changed during the update were saved to git stash "${stashName}" (git stash pop brings them back; resolve any conflict against the rolled-back files)`
    : "";
  if (!reset.ok) return `${msg}; rollback failed; the checkout may be partially updated${preserved}`;
  if (restored) return `${msg}; rolled back to the previous version${preserved}`;
  return `${msg}; code was rolled back, but reinstalling/rebuilding it failed; the previous version may not run until this is fixed${preserved}`;
}

export function createRollback({ serviceName, runCommand, gitText }) {
  // The stash is taken against the NEW commit, so popping it onto the rolled-back tree can
  // conflict where the update also touched the same file; the edit is intact either way and
  // `git stash show -p` / `git checkout stash@{0} -- <file>` recover it file by file.
  async function stashChangedFiles(changedDuring, msg, output) {
    if (!changedDuring.length) return null;
    const stashName = `${serviceName}-update-rollback-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const stashArgs = ["git", "stash", "push", "--include-untracked", "-m", stashName];
    const stash = await runCommand(stashArgs, APPLY_TIMEOUT_MS);
    output.push(commandSummary(stashArgs, stash));
    if (!stash.ok) {
      throw new Error(
        `${msg}; ${changedDuring.length} file(s) changed in the checkout during the update and could not be stashed, so it was NOT rolled back (a reset would have deleted them): it is at the new commit with a failed install/build; recover by hand - changed: ${changedDuring.join(", ")}`,
      );
    }
    return stashName;
  }

  // Puts edits the update had taken as its own back the way they were before it (unstaged, deleted
  // files deleted again), so a rolled-back checkout runs what it ran before the update.
  async function restoreLandedEdits(landed, target, output) {
    const kept = landed.filter((e) => !e.deleted).map((e) => e.path);
    if (kept.length) {
      const checkout = ["git", "--literal-pathspecs", "checkout", target, "--", ...kept];
      const checkedOut = await runCommand(checkout, APPLY_TIMEOUT_MS);
      output.push(commandSummary(checkout, checkedOut));
      if (!checkedOut.ok) return;
      const unstage = ["git", "--literal-pathspecs", "reset", "-q", "--", ...kept];
      const unstaged = await runCommand(unstage, APPLY_TIMEOUT_MS);
      output.push(commandSummary(unstage, unstaged));
      if (!unstaged.ok) return;
    }
    const top = await gitText(["rev-parse", "--show-toplevel"]);
    if (!top) return;
    // Each deleted edit is deleted again; one already gone is fine, and a rollback never stops on one (floor-ok: as before the split).
    await oneAtATime(landed.filter((e) => e.deleted), (e) => unlink(join(top, e.path)).catch(() => {}));
  }

  async function resetAndRebuild(currentCommit, output, landed, target, due) {
    const resetArgs = ["git", "reset", "--hard", currentCommit];
    const reset = await runCommand(resetArgs, APPLY_TIMEOUT_MS);
    output.push(commandSummary(resetArgs, reset));
    if (!reset.ok) return { reset, restored: false };
    if (landed?.length && target) await restoreLandedEdits(landed, target, output);
    // The steps the update made due: the reset puts back the same paths, so the same installs and builds are stale.
    return { reset, restored: !(await runDueSteps(runCommand, due, output)) };
  }

  /** Rolls a failed update back as above and throws why it failed, with what the rollback did. Always throws. */
  async function rollbackAfterFailedUpdate(err, before, output, landed = null, due = []) {
    const msg = err instanceof Error ? err.message : String(err);
    const statusArgs = ["git", "status", "--porcelain"];
    const statusNow = await runCommand(statusArgs, CHECK_TIMEOUT_MS);
    output.push(commandSummary(statusArgs, statusNow));
    if (!statusNow.ok) {
      throw new Error(
        `${msg}; the checkout could not be inspected afterwards (git status failed), so it was NOT rolled back: it is at the new commit with a failed install/build; inspect it by hand`,
      );
    }
    const changedDuring = statusNow.stdout.split(/\r?\n/).filter(Boolean);
    const stashName = await stashChangedFiles(changedDuring, msg, output);
    const { reset, restored } = await resetAndRebuild(before.currentCommit, output, landed, before.remoteCommit, due);
    throw new Error(rollbackMessage(msg, reset, restored, stashName, changedDuring.length));
  }

  return { rollbackAfterFailedUpdate };
}
