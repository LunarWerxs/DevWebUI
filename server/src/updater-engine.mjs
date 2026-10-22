/**
 * Shared self-update engine for the LunarWerx daemons. Checks the app's configured
 * update remote for a newer commit and (on request) fast-forward-pulls + reinstalls +
 * rebuilds, returning a step-by-step transcript. The git/spawn/parse plumbing was
 * duplicated near-verbatim across the apps, this is the one copy, parameterised by:
 *
 *   appRoot           the checkout root (each app resolves its own import.meta path)
 *   serviceName       the `service` field on UpdateStatus (e.g. "repoyeti")
 *   appLabel          display name used in the apply messages (e.g. "RepoYeti")
 *   updateRepoEnvVar  env var that overrides the update remote (e.g. REPOYETI_UPDATE_REPO)
 *   installCmd        install step, e.g. ["bun", "install"] (unused when steps is given)
 *   buildCmd          build step, e.g. ["bun", "run", "--cwd", "web", "build"] (unused when steps is given)
 *   cooldownDays      optional; when > 0, only commits at least this many days old are adopted
 *   run               optional; runs each command instead of the engine's own spawn (an app whose
 *                     daemon serves every route on one thread passes an off-thread runner)
 *   steps             optional; instead of installCmd and buildCmd, the install and build steps in order, each
 *                     { cmd, dir?, when? }: `dir` is a folder under appRoot (default: the root), and `when(changed)` says
 *                     whether the step is due for the paths the update changed (a step with no `when` always is). Only the
 *                     due steps run, and a rollback reruns those same ones (2026-10-21: an app whose install and build read
 *                     only part of its checkout does not run them for a change they do not read).
 *   restartWhen       optional; (changed) => boolean, whether the update needs the app restarted. Default: any path changed.
 *                     The paths are git's own (`git diff --name-only`, renames split): a file moved out of a path counts.
 *   asideDir          optional; where Windows moves a running program the update replaces (updater-engine-aside.mjs)
 *
 * runtime-agnostic (Bun + Node): node:child_process spawn runs in both. Part of the
 * shared kit, keep it app-agnostic. Its parts sit beside it as updater-engine-<part>.mjs and are synced with it:
 * run (commands and their transcript), remote (what the update remote offers), edits (local edits the update
 * already carries), rollback (after a failed step) and aside (running programs on Windows).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createAsideMover } from "./updater-engine-aside.mjs";
import { createEditReader } from "./updater-engine-edits.mjs";
import { createRemoteReader, reasonForStatus } from "./updater-engine-remote.mjs";
import { createRollback } from "./updater-engine-rollback.mjs";
import {
  APPLY_TIMEOUT_MS,
  CHECK_TIMEOUT_MS,
  commandSummary,
  createRunner,
  runDueSteps,
  runStep,
  stepFailureMessage,
} from "./updater-engine-run.mjs";

const DAY_SECONDS = 86_400;

export function createUpdater({ appRoot, serviceName, appLabel, updateRepoEnvVar, installCmd, buildCmd, cooldownDays = 0, run = null, steps = null, restartWhen = null, asideDir = null }) {
  // Normalized once so a string or negative option is never echoed back in status or reasons.
  const cooldownDaysN = Math.max(0, Number(cooldownDays) || 0);
  // The install and build steps: the app's `steps`, or its two commands as steps that always run. `dir` is shown in the
  // transcript; `cwd` is where the step runs.
  const plan = (steps ?? [{ cmd: installCmd }, { cmd: buildCmd }]).map((step) => ({
    cmd: step.cmd,
    when: step.when ?? null,
    dir: step.dir ?? "",
    cwd: step.dir ? join(appRoot, step.dir) : appRoot,
  }));
  const anyChange = (paths) => paths.length > 0;

  const { runCommand, git, gitText } = createRunner({ appRoot, run });
  const remotes = createRemoteReader({ appRoot, git, gitText, updateRepoEnvVar, cooldownSeconds: cooldownDaysN * DAY_SECONDS });
  const { editsAlreadyIn } = createEditReader({ appRoot, git, gitText });
  const { rollbackAfterFailedUpdate } = createRollback({ serviceName, runCommand, gitText });
  const { moveAsideRunningPrograms } = createAsideMover({ appRoot, asideDir, git, gitText, runCommand });

  function packageVersion() {
    try {
      const pkg = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8"));
      return pkg.version ?? "0.0.0";
    } catch {
      return "0.0.0";
    }
  }

  function emptyStatus() {
    return {
      ok: true,
      service: serviceName,
      currentVersion: packageVersion(),
      currentCommit: null,
      remoteCommit: null,
      branch: null,
      upstream: null,
      remote: null,
      dirty: false,
      updateAvailable: false,
      canApply: false,
      checkedAt: Date.now(),
      reason: null,
    };
  }

  async function gatherLocalStatus(base) {
    const currentCommit = await gitText(["rev-parse", "HEAD"]);
    const branch = await gitText(["branch", "--show-current"]);
    const upstream = await remotes.currentUpstream();
    const remote = await remotes.remoteForCheck(upstream.remoteName);
    const dirty = !!(await gitText(["status", "--porcelain"]));
    const status = { ...base, currentCommit, branch, upstream: upstream.upstream, remote: remote.remote, dirty };
    return { status, upstream, remote };
  }

  async function checkForUpdate() {
    const base = emptyStatus();
    if (!(await remotes.isGitCheckout())) return { ...base, ok: false, reason: "not a git checkout" };
    const { status, upstream, remote } = await gatherLocalStatus(base);
    if (!status.currentCommit) return { ...status, ok: false, reason: "could not read current commit" };
    if (!remote.remoteArg) return { ...status, ok: false, reason: "no update remote configured" };
    const compareBranch = upstream.remoteBranch || status.branch;
    const resolved = await remotes.resolveRemoteCommit(remote.remoteArg, compareBranch, status.branch);
    // With a cooldown, `remoteCommit` is the aged commit an apply would move to; the tip it was
    // chosen from is reported beside it so a host can show what is being held back.
    const { commit: target, cooldown } = await remotes.applyCooldown(
      resolved.remoteCommit,
      status.currentCommit,
      resolved.remoteBranch,
      remote.remoteArg,
    );
    status.branch = resolved.branch;
    status.remoteCommit = target;
    status.remoteBranch = resolved.remoteBranch;
    if (cooldown !== "off") {
      status.latestRemoteCommit = resolved.remoteCommit;
      status.cooldownDays = cooldownDaysN;
    }
    const fastForward = await remotes.evaluateFastForward(
      target,
      status.currentCommit,
      resolved.remoteBranch,
      remote.remoteArg,
      cooldown !== "off",
    );
    return settleStatus(status, target, fastForward, cooldown);
  }

  // Whether the target is an update this checkout can take, and the reason when it cannot.
  async function settleStatus(status, target, { remoteIsAncestor, fastForward }, cooldown) {
    const newer = !!(target && target !== status.currentCommit && !remoteIsAncestor);
    status.updateAvailable = newer;
    status.diverged = newer && fastForward === "no";
    status.localEditsLanded = newer && status.dirty && !!(await editsAlreadyIn(target));
    const blocked = status.dirty && !status.localEditsLanded;
    status.canApply = newer && fastForward === "yes" && !blocked && !!status.remoteBranch;
    status.reason = reasonForStatus(
      { newer, dirty: blocked, fastForward, remoteBranch: status.remoteBranch, remoteCommit: target, remoteIsAncestor, cooldown },
      cooldownDaysN,
    );
    return status;
  }

  /** The paths the advance changed, from `from` to HEAD. Renames are split (--no-renames), so a path moved away counts as
   *  changed there too. Null when git cannot say: every step is then due, and the app restarts. */
  async function changedPaths(from) {
    if (!from) return null;
    const diff = await git(["diff", "--name-only", "--no-renames", "-z", from, "HEAD"], CHECK_TIMEOUT_MS);
    return diff.ok ? diff.stdout.split("\0").filter(Boolean) : null;
  }

  /** The steps the update makes due: each one whose `when` holds for `changed`, and all of them when it is unknown. */
  function dueSteps(changed) {
    return plan.filter((step) => !step.when || changed === null || step.when(changed));
  }

  // Every failure carries the transcript: the rejection is an Error whose message is the one-line
  // reason, and `err.output` holds every step recorded before it, rollback steps included, for the
  // host to log and offer as details (RepoYeti issue #24: a user could paste only the one line).
  async function applyUpdate() {
    const output = [];
    try {
      return await applyRecording(output);
    } catch (err) {
      const failure = err instanceof Error ? err : new Error(String(err));
      failure.output = output;
      throw failure;
    }
  }

  async function applyRecording(output) {
    const before = await checkForUpdate();
    if (!before.updateAvailable) {
      const message = before.reason === "up to date" ? `${appLabel} is already up to date.` : "No update is available.";
      return { ok: true, message, restartRequired: false, status: before, output };
    }
    const landed = await applicableEdits(before);
    await advance(before, landed, await advanceCommand(before), output);
    // What the advance changed decides which installs and builds are due, and whether the app restarts.
    const changed = await changedPaths(before.currentCommit);
    const due = dueSteps(changed);
    const failed = await runDueSteps(runCommand, due, output);
    if (failed) {
      const err = new Error(stepFailureMessage(failed.step.cmd, failed.result));
      await rollbackAfterFailedUpdate(err, before, output, landed, due);
    }
    // An unknown change set restarts: the app's own code may be among what changed.
    const restartRequired = changed === null ? true : await (restartWhen ?? anyChange)(changed);
    return {
      ok: true,
      message: restartRequired
        ? `${appLabel} was updated. Restart the daemon to run the new code.`
        : `${appLabel} was updated. The code it runs did not change, so no restart is needed.`,
      restartRequired,
      status: await checkForUpdate(),
      output,
    };
  }

  /** The local edits the advance takes as its own (already the target's), or null for a clean checkout. Throws when any
   *  other edit blocks the update, or the check said it cannot apply (diverged, unverifiable, no pullable branch):
   *  running the pull anyway is the fail-every-cycle loop this guard ends. */
  async function applicableEdits(before) {
    const landed = before.dirty && before.localEditsLanded ? await editsAlreadyIn(before.remoteCommit) : null;
    if (before.dirty && !landed) throw new Error("Commit or stash local changes before applying an update.");
    if (!before.canApply) throw new Error(before.reason ?? "The update cannot be applied to this checkout.");
    return landed;
  }

  // The branch the check PROVED fast-forwardable, pulled by name: the configured upstream is the same
  // branch in the ordinary case, and naming it keeps apply on what check verified when they differ (a
  // local branch with no remote counterpart follows the remote's HEAD; a URL remote is pulled from that
  // URL). Under a cooldown the target is the aged commit the check fetched, so the advance merges exactly it.
  async function advanceCommand(before) {
    const upstream = await remotes.currentUpstream();
    const remote = await remotes.remoteForCheck(upstream.remoteName);
    const branch = before.remoteBranch || upstream.remoteBranch || before.branch;
    if (!remote.remoteArg || !branch) throw new Error("No update remote/branch is configured.");
    return before.latestRemoteCommit
      ? ["git", "merge", "--ff-only", before.remoteCommit]
      : ["git", "pull", "--ff-only", remote.remoteArg, branch];
  }

  // Staged, an edit that is the target's content is the fast-forward's own (git's two-way merge keeps
  // an index entry equal to the new tree). Any failure from here to the advance unstages the paths
  // again; their files are never touched.
  async function advance(before, landed, advanceArgs, output) {
    const landedPaths = (landed ?? []).map((e) => e.path);
    try {
      if (landedPaths.length) await stageLanded(before.remoteCommit, landedPaths, output);
      // Windows: a running program file cannot be overwritten by the advance, so move the ones it changes aside
      // first. The target is the commit check already fetched: FETCH_HEAD, or the cooldown's aged commit.
      if (process.platform === "win32") {
        await moveAsideRunningPrograms(before.latestRemoteCommit ? before.remoteCommit : "FETCH_HEAD", output);
      }
      await runStep(runCommand, advanceArgs, APPLY_TIMEOUT_MS, output, appRoot);
    } catch (err) {
      if (landedPaths.length) {
        const unstage = ["git", "--literal-pathspecs", "reset", "-q", "--", ...landedPaths];
        output.push(commandSummary(unstage, await runCommand(unstage, APPLY_TIMEOUT_MS)));
      }
      throw err;
    }
  }

  // The staged entries must be exactly the target's, mode included: an edit written after the check is
  // not, so nothing is advanced.
  async function stageLanded(target, landedPaths, output) {
    await runStep(runCommand, ["git", "--literal-pathspecs", "add", "-A", "--", ...landedPaths], APPLY_TIMEOUT_MS, output, appRoot);
    const same = ["git", "--literal-pathspecs", "diff", "--cached", "--quiet", target, "--", ...landedPaths];
    const compared = await runCommand(same, APPLY_TIMEOUT_MS);
    output.push(commandSummary(same, compared));
    if (!compared.ok) {
      throw new Error("A local edit changed after the update check, so nothing was updated; it is left as it was.");
    }
  }

  return { checkForUpdate, applyUpdate };
}
