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
 *   installCmd        install step, e.g. ["bun", "install"]
 *   buildCmd          build step, e.g. ["bun", "run", "--cwd", "web", "build"]
 *   cooldownDays      optional; when > 0, only commits at least this many days old are adopted
 *   run               optional; runs each command instead of the engine's own spawn (an app whose
 *                     daemon serves every route on one thread passes an off-thread runner)
 *
 * runtime-agnostic (Bun + Node): node:child_process spawn runs in both. Part of the
 * shared kit, keep it app-agnostic.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";

const CHECK_TIMEOUT_MS = 30_000;
const APPLY_TIMEOUT_MS = 120_000;
const BUILD_TIMEOUT_MS = 240_000;

const DAY_SECONDS = 86_400;

export function createUpdater({ appRoot, serviceName, appLabel, updateRepoEnvVar, installCmd, buildCmd, cooldownDays = 0, run = null }) {
  // Normalized once so a string or negative option is never echoed back in status or reasons.
  const cooldownDaysN = Math.max(0, Number(cooldownDays) || 0);
  const cooldownSeconds = cooldownDaysN * DAY_SECONDS;

  function packageVersion() {
    try {
      const pkg = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8"));
      return pkg.version ?? "0.0.0";
    } catch {
      return "0.0.0";
    }
  }

  // On Windows, package-manager launchers (npm/yarn/pnpm) are `.cmd` shims that CreateProcess
  // can't execute directly, so a bare spawn throws ENOENT, while git/node/bun are real `.exe`
  // and resolve fine. So spawn raw first (git/bun keep their exact behavior and no shell-escaping
  // deprecation fires) and retry once through a shell only when the raw spawn ENOENTs on Windows,
  // which is exactly the `.cmd`-shim case. Every arg here is a fixed literal or a git URL (no
  // spaces or shell metacharacters), so the shell's arg concatenation is safe.
  function runCommand(args, timeoutMs) {
    if (run) return runThrough(args, timeoutMs);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (r) => {
        if (!settled) {
          settled = true;
          resolve(r);
        }
      };
      const attempt = (useShell) => {
        const child = spawn(args[0], args.slice(1), {
          cwd: appRoot,
          windowsHide: true,
          shell: useShell,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let superseded = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill();
        }, timeoutMs);
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr?.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("error", (err) => {
          clearTimeout(timer);
          // `error` fires before this attempt's `close`; flag it so that trailing `close`
          // is ignored while we retry the `.cmd` shim through a shell.
          if (err.code === "ENOENT" && !useShell && process.platform === "win32") {
            superseded = true;
            attempt(true);
            return;
          }
          finish({ ok: false, code: null, stdout, stderr: stderr || err.message, timedOut });
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (superseded) return;
          finish({ ok: code === 0 && !timedOut, code, stdout, stderr, timedOut });
        });
      };
      attempt(false);
    });
  }

  // The app's own runner (`run`): the same argv, root, environment and deadline, its answer read
  // the way the spawn above reads a child. One that throws is a failed step, never an unhandled one.
  async function runThrough(args, timeoutMs) {
    try {
      const r = await run(args, { cwd: appRoot, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeoutMs });
      return { ok: r.code === 0 && !r.timedOut, code: r.code, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut };
    } catch (err) {
      return { ok: false, code: null, stdout: "", stderr: err?.message ?? String(err), timedOut: false };
    }
  }

  const git = (args, timeoutMs = CHECK_TIMEOUT_MS) => runCommand(["git", ...args], timeoutMs);
  async function gitText(args, timeoutMs = CHECK_TIMEOUT_MS) {
    const r = await git(args, timeoutMs);
    return r.ok ? r.stdout.trim() : null;
  }

  function parseRemoteHead(stdout) {
    return {
      branch: stdout.match(/^ref:\s+refs\/heads\/(.+)\s+HEAD$/m)?.[1] ?? null,
      commit: stdout.match(/^([0-9a-f]{40})\s+HEAD$/m)?.[1] ?? null,
    };
  }
  function parseLsRemoteCommit(stdout) {
    return stdout.match(/^([0-9a-f]{40})\s+/m)?.[1] ?? null;
  }

  async function currentUpstream() {
    const upstream = await gitText(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    if (!upstream) return { upstream: null, remoteName: null, remoteBranch: null };
    const slash = upstream.indexOf("/");
    if (slash <= 0) return { upstream, remoteName: null, remoteBranch: null };
    return { upstream, remoteName: upstream.slice(0, slash), remoteBranch: upstream.slice(slash + 1) };
  }

  async function remoteForCheck(remoteName) {
    const configured = process.env[updateRepoEnvVar]?.trim();
    if (configured) return { remote: configured, remoteArg: configured };
    const name = remoteName || "origin";
    const url = await gitText(["remote", "get-url", name]);
    return url ? { remote: url, remoteArg: name } : { remote: null, remoteArg: null };
  }

  async function isGitCheckout() {
    if (!existsSync(join(appRoot, ".git"))) return false;
    return (await gitText(["rev-parse", "--is-inside-work-tree"])) === "true";
  }

  // A deployed checkout patched by hand, whose patch was then landed upstream: every local edit is
  // already the update target's content (AgentHydra, 2026-10-15: a chat fixed a running feature by
  // editing the deployed checkout, its edits were landed, and the checkout stayed dirty, so it took
  // no update at all). Such edits do not block the update; any other local edit still does. Only
  // unstaged edits and untracked files qualify: a staged, renamed or unmerged path is someone's git
  // work in progress.
  const LANDED_MAX = 200;

  /** The checkout's local edits ({ path from the top level, deleted }), or null when one is staged,
   *  renamed, unmerged or a type change, there are more than LANDED_MAX, or status cannot be read. */
  async function localEdits() {
    const r = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (!r.ok) return null;
    const edits = [];
    for (const entry of r.stdout.split("\0").filter(Boolean)) {
      const [x, y, path] = [entry[0], entry[1], entry.slice(3)];
      if (x === "?" && y === "?") edits.push({ path, deleted: false, untracked: true });
      else if (x !== " ") return null;
      else if (y === "M") edits.push({ path, deleted: false, untracked: false });
      else if (y === "D") edits.push({ path, deleted: true, untracked: false });
      else return null;
    }
    return edits.length <= LANDED_MAX ? edits : null;
  }

  /** The target's mode per modified path, or null when the ls-tree fails. */
  async function targetModes(target, modified) {
    const tree = await git(["--literal-pathspecs", "ls-tree", "-z", target, "--", ...modified]);
    if (!tree.ok) return null;
    return new Map(
      tree.stdout.split("\0").filter(Boolean).map((line) => [line.slice(line.indexOf("\t") + 1), line.split(" ")[0]]),
    );
  }

  /** A mode change (chmod +x) is an edit as well: a modified file's mode must be the target's too. */
  async function modesMatch(modified, modes) {
    if (!modified.length) return true;
    const raw = await git(["--literal-pathspecs", "diff", "--raw", "-z", "--", ...modified]);
    if (!raw.ok) return false;
    const parts = raw.stdout.split("\0").filter(Boolean);
    for (let i = 0; i + 1 < parts.length; i += 2) {
      if (modes.get(parts[i + 1]) !== parts[i].slice(1).split(" ")[1]) return false;
    }
    return true;
  }

  /** The local edits when every one is already `target`'s content (a deleted file is gone there
   *  too), else null. Compared as git blobs, so line-ending conversion on checkout is no difference. */
  async function editsAlreadyIn(target) {
    if (!target) return null;
    const edits = await localEdits();
    const top = edits?.length ? await gitText(["rev-parse", "--show-toplevel"]) : null;
    // Status paths are from the top level and every later pathspec is from appRoot: they must be one folder.
    if (!top || !sameFolder(top, appRoot)) return null;
    // Batched: one ls-tree answers every edit's presence, oid and mode in the target and one
    // hash-object hashes every working file, where the old loop spent up to two spawns per edit
    // (2026-10-16). A batch that fails, or whose answer doesn't map one-to-one onto the edits,
    // falls back to the per-edit loop, so failure handling stays exactly as it was.
    const wanted = new Set(edits.map((e) => e.path));
    const tree = await git(["--literal-pathspecs", "ls-tree", "-z", target, "--", ...wanted]);
    const inTarget = new Map(); // path -> [mode, type, oid] in the target; absent when gone there
    let batched = tree.ok;
    if (tree.ok)
      for (const line of tree.stdout.split("\0").filter(Boolean)) {
        // "<mode> <type> <oid>\t<path>": the path follows a TAB; the three fields before it are spaced.
        const tab = line.indexOf("\t");
        const path = line.slice(tab + 1);
        if (!wanted.has(path)) {
          batched = false; // a pathspec matched a child: not one-to-one with the edits
          break;
        }
        inTarget.set(path, line.slice(0, tab).split(" "));
      }
    if (batched) {
      const present = edits.filter((e) => !e.deleted);
      const hashed = present.length
        ? await git(["hash-object", "--", ...present.map((e) => join(top, e.path))])
        : { ok: true, stdout: "" };
      const lines = hashed.ok ? hashed.stdout.split("\n").filter(Boolean) : null;
      if (lines?.length === present.length) {
        const hash = new Map(present.map((e, i) => [e.path, lines[i]]));
        for (const e of edits) {
          const want = inTarget.get(e.path)?.[2] ?? null;
          // A deleted edit must be gone in the target; every other must hash to the target's blob.
          if (e.deleted ? want : hash.get(e.path) !== want) return null;
        }
        const modified = edits.filter((e) => !e.deleted && !e.untracked).map((e) => e.path);
        return (await modesMatch(modified, new Map([...inTarget].map(([p, m]) => [p, m[0]])))) ? edits : null;
      }
    }
    // The per-edit fallback: one rev-parse per edit and one hash-object per working file.
    for (const e of edits) {
      const want = await gitText(["rev-parse", "--verify", "--quiet", `${target}:${e.path}`]);
      if (e.deleted ? want : !want || (await gitText(["hash-object", "--", join(top, e.path)])) !== want) return null;
    }
    const modified = edits.filter((e) => !e.deleted && !e.untracked).map((e) => e.path);
    const modes = modified.length ? await targetModes(target, modified) : new Map();
    return modes && (await modesMatch(modified, modes)) ? edits : null;
  }

  // Through realpath, so a junction or a short name to the checkout still matches git's own top level.
  const sameFolder = (a, b) => {
    const norm = (p) => {
      try {
        return realpathSync.native(p).replace(/[\\/]+$/, "");
      } catch {
        return resolve(p).replace(/[\\/]+$/, "");
      }
    };
    return process.platform === "win32" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
  };

  async function gatherLocalStatus(base) {
    const currentCommit = await gitText(["rev-parse", "HEAD"]);
    const branch = await gitText(["branch", "--show-current"]);
    const upstream = await currentUpstream();
    const remote = await remoteForCheck(upstream.remoteName);
    const dirty = !!(await gitText(["status", "--porcelain"]));
    const status = { ...base, currentCommit, branch, upstream: upstream.upstream, remote: remote.remote, dirty };
    return { status, upstream, remote };
  }

  // The remote branch the update would actually pull. `compareBranch` is what was ASKED for;
  // when the remote has no such branch the check falls back to the remote's HEAD, and apply
  // must then pull THAT branch, not the local name. It used to pull the local name, so a
  // checkout on a branch the remote lacks was told an update existed and then failed to apply
  // it with "couldn't find remote ref", every cycle.
  async function resolveRemoteCommit(remoteArg, compareBranch, localBranch) {
    let remoteBranch = compareBranch || null;
    let remoteCommit = null;
    let branch = localBranch;
    if (compareBranch) {
      const ref = await git(["ls-remote", remoteArg, `refs/heads/${compareBranch}`]);
      if (ref.ok) remoteCommit = parseLsRemoteCommit(ref.stdout);
    }
    if (!remoteCommit) {
      const head = await git(["ls-remote", "--symref", remoteArg, "HEAD"]);
      if (head.ok) {
        const parsed = parseRemoteHead(head.stdout);
        remoteCommit = parsed.commit;
        remoteBranch = parsed.branch;
        branch = branch || parsed.branch;
      }
    }
    return { remoteCommit, remoteBranch, branch };
  }

  // A differing remote SHA is NOT enough: on a dev checkout the local branch is routinely
  // AHEAD of the update remote (committed-but-unpushed work). ls-remote gives us the SHA
  // without fetching, and when we're ahead that commit already exists locally, so
  // merge-base --is-ancestor can prove it's behind us (exit 0). A genuinely new remote
  // commit is an unknown object locally (exit 128) or a non-ancestor (exit 1), both of
  // which correctly read as "update available". Without this, an enabled auto-update
  // loop on an ahead checkout would ff-pull a no-op and reinstall + rebuild every cycle.
  //
  // "Newer" is not "applicable". `pull --ff-only` succeeds only when HEAD is an ancestor of
  // the remote commit; a checkout that has DIVERGED (local commits the remote lacks AND remote
  // commits it lacks) used to be advertised as an update that apply then refused, every
  // cycle. So the fast-forward is proven before it is advertised: fetch just that branch into
  // FETCH_HEAD (no local branch and no working file moves) and ask git the ancestry question.
  // A failed fetch is reported as its own reason rather than guessed either way.
  //
  // `alreadyFetched` is set by the cooldown path, which has fetched the branch and picked an older
  // commit than the tip: the fast-forward question is then asked of that commit, not FETCH_HEAD.
  async function evaluateFastForward(remoteCommit, currentCommit, remoteBranch, remoteArg, alreadyFetched = false) {
    if (!remoteCommit || remoteCommit === currentCommit) return { remoteIsAncestor: false, fastForward: "n/a" };
    const remoteIsAncestor = (await git(["merge-base", "--is-ancestor", remoteCommit, "HEAD"])).ok;
    if (remoteIsAncestor || !remoteBranch) return { remoteIsAncestor, fastForward: "n/a" };
    if (!alreadyFetched) {
      const fetched = await git(["fetch", "--quiet", "--no-tags", remoteArg, remoteBranch], APPLY_TIMEOUT_MS);
      if (!fetched.ok) return { remoteIsAncestor, fastForward: "unknown" };
    }
    const target = alreadyFetched ? remoteCommit : "FETCH_HEAD";
    const fastForward = (await git(["merge-base", "--is-ancestor", "HEAD", target])).ok ? "yes" : "no";
    return { remoteIsAncestor, fastForward };
  }

  // Update cooldown (idea from ohmyzsh's tools/upgrade.sh, MIT): with cooldownDays set, an update
  // targets the newest FIRST-PARENT commit on the remote branch that is at least that old, never
  // the tip, so a bad push has N days to be caught and reverted before any install adopts it.
  // Limitation: the age is the committer date (%ct), which the pusher sets and can backdate, so this
  // does not stop a compromised push; that would need a first-seen time recorded locally. Returns the commit to update to and a state: "off" (no cooldown, or nothing new to
  // hold back), "clear" (the tip itself is old enough), "held" (younger commits are held back; the
  // commit is the newest aged one, or null when none is aged yet), "unknown" (history unreadable).
  async function applyCooldown(remoteCommit, currentCommit, remoteBranch, remoteArg) {
    if (!cooldownSeconds || !remoteCommit || remoteCommit === currentCommit || !remoteBranch) {
      return { commit: remoteCommit, cooldown: "off" };
    }
    // Local is already at or past the tip: there is nothing to hold back.
    if ((await git(["merge-base", "--is-ancestor", remoteCommit, "HEAD"])).ok) return { commit: remoteCommit, cooldown: "off" };
    const fetched = await git(["fetch", "--quiet", "--no-tags", remoteArg, remoteBranch], APPLY_TIMEOUT_MS);
    // --until with -1 asks git for just the newest aged first-parent commit, so the output stays
    // one line however long the history is.
    const cutoff = Math.floor(Date.now() / 1000) - cooldownSeconds;
    const log = fetched.ok
      ? await git(["log", "--first-parent", `--until=@${cutoff}`, "-1", "--format=%H", "FETCH_HEAD"])
      : fetched;
    if (!log.ok) return { commit: null, cooldown: "unknown" };
    const sha = log.stdout.trim();
    if (sha) return { commit: sha, cooldown: sha === remoteCommit ? "clear" : "held" };
    return { commit: null, cooldown: "held" };
  }

  function reasonForStatus({ newer, dirty, fastForward, remoteBranch, remoteCommit, remoteIsAncestor, cooldown }) {
    if (newer) {
      if (dirty) return "local changes must be committed or stashed before updating";
      if (fastForward === "no")
        return "local checkout has diverged from the update remote; a fast-forward is not possible (merge or rebase at your desk)";
      if (fastForward === "unknown") return "could not fetch the update remote to verify the update";
      if (!remoteBranch) return "could not determine the remote branch to pull";
      return null;
    }
    if (cooldown === "unknown") return "could not fetch the update remote to apply the update cooldown";
    if (cooldown === "held") return `newer commits on the update remote are inside the ${cooldownDaysN}-day update cooldown`;
    if (remoteCommit) return remoteIsAncestor ? "local checkout is ahead of the update remote" : "up to date";
    return "could not read remote commit";
  }

  async function checkForUpdate() {
    const base = {
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

    if (!(await isGitCheckout())) return { ...base, ok: false, reason: "not a git checkout" };

    const { status, upstream, remote } = await gatherLocalStatus(base);
    if (!status.currentCommit) return { ...status, ok: false, reason: "could not read current commit" };
    if (!remote.remoteArg) return { ...status, ok: false, reason: "no update remote configured" };

    const compareBranch = upstream.remoteBranch || status.branch;
    const resolved = await resolveRemoteCommit(remote.remoteArg, compareBranch, status.branch);
    // With a cooldown, `remoteCommit` is the aged commit an apply would move to; the tip it was
    // chosen from is reported beside it so a host can show what is being held back.
    const { commit: target, cooldown } = await applyCooldown(
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

    const { remoteIsAncestor, fastForward } = await evaluateFastForward(
      target,
      status.currentCommit,
      resolved.remoteBranch,
      remote.remoteArg,
      cooldown !== "off",
    );
    const newer = !!(target && target !== status.currentCommit && !remoteIsAncestor);
    status.updateAvailable = newer;
    status.diverged = newer && fastForward === "no";
    status.localEditsLanded = newer && status.dirty && !!(await editsAlreadyIn(target));
    const blocked = status.dirty && !status.localEditsLanded;
    status.canApply = newer && fastForward === "yes" && !blocked && !!resolved.remoteBranch;
    status.reason = reasonForStatus({
      newer,
      dirty: blocked,
      fastForward,
      remoteBranch: resolved.remoteBranch,
      remoteCommit: target,
      remoteIsAncestor,
      cooldown,
    });
    return status;
  }

  function commandSummary(args, result) {
    const text = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n").trim();
    const suffix = result.timedOut ? "timed out" : result.ok ? "ok" : `exit ${result.code ?? "unknown"}`;
    return `$ ${args.join(" ")}\n${text || suffix}`;
  }
  /** Lines that name a failure, so the excerpt below can prefer them over surrounding noise. */
  const ERRORISH =
    /\berror\b|\bfailed\b|\bfailure\b|cannot |can't |could not |not found|unable to|unresolved|does the file exist|ENOENT|EACCES|✗|✘/i;
  const STEP_ERROR_LINES = 4;
  const STEP_ERROR_CHARS = 400;

  /**
   * The user-facing reason a step failed.
   *
   * Taking `stderr.split("\n")[0]` looked right and was not: a `bun run <script>` failure begins by
   * ECHOING the script it is about to run, so the dashboard showed people the command
   * (`$ node scripts/i18n-check.mjs && vue-tsc -b && …`) and threw away the line that mattered
   * (`Failed to resolve import "./button-variants"`), which is several lines further down. The full
   * transcript is not a fallback either: `output` is only returned on the SUCCESS path, so on a
   * failure this message is the only thing the user ever sees. (RepoYeti issue #24.)
   *
   * So: drop echoed commands and blank lines, prefer the lines that actually name a failure, and
   * cap the result — this lands in a toast description, and an unbounded build log is not readable
   * there. The command itself is not lost: `commandSummary` already recorded it in `output`.
   */
  function stepFailureMessage(args, result) {
    const lines = `${result.stderr}\n${result.stdout}`
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("$ "));
    const errorish = lines.filter((line) => ERRORISH.test(line));
    const picked = (errorish.length ? errorish : lines).slice(0, STEP_ERROR_LINES);
    const msg = picked.join(" · ");
    if (!msg) return result.timedOut ? `${args[0]} timed out` : `${args[0]} failed`;
    return msg.length > STEP_ERROR_CHARS ? `${msg.slice(0, STEP_ERROR_CHARS - 1)}…` : msg;
  }

  async function runStep(args, timeoutMs, output) {
    const result = await runCommand(args, timeoutMs);
    output.push(commandSummary(args, result));
    if (!result.ok) throw new Error(stepFailureMessage(args, result));
  }

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
      for (const args of [
        ["git", "--literal-pathspecs", "checkout", target, "--", ...kept],
        ["git", "--literal-pathspecs", "reset", "-q", "--", ...kept],
      ]) {
        const r = await runCommand(args, APPLY_TIMEOUT_MS);
        output.push(commandSummary(args, r));
        if (!r.ok) return;
      }
    }
    const top = await gitText(["rev-parse", "--show-toplevel"]);
    for (const e of landed.filter((e) => e.deleted)) {
      try {
        if (top) unlinkSync(join(top, e.path));
      } catch {
        // already gone
      }
    }
  }

  async function resetAndRebuild(currentCommit, output, landed = null, target = null) {
    const resetArgs = ["git", "reset", "--hard", currentCommit];
    const reset = await runCommand(resetArgs, APPLY_TIMEOUT_MS);
    output.push(commandSummary(resetArgs, reset));
    let restored = false;
    if (reset.ok) {
      if (landed?.length && target) await restoreLandedEdits(landed, target, output);
      restored = true;
      for (const cmd of [installCmd, buildCmd]) {
        const r = await runCommand(cmd, BUILD_TIMEOUT_MS);
        output.push(commandSummary(cmd, r));
        if (!r.ok) {
          restored = false;
          break;
        }
      }
    }
    return { reset, restored };
  }

  function buildRollbackMessage(msg, reset, restored, stashName, changedCount) {
    const preserved = stashName
      ? `; ${changedCount} file(s) changed during the update were saved to git stash "${stashName}" (git stash pop brings them back; resolve any conflict against the rolled-back files)`
      : "";
    if (!reset.ok) return `${msg}; rollback failed; the checkout may be partially updated${preserved}`;
    if (restored) return `${msg}; rolled back to the previous version${preserved}`;
    return `${msg}; code was rolled back, but reinstalling/rebuilding it failed; the previous version may not run until this is fixed${preserved}`;
  }

  // Unattended self-update: a failed install/build must never leave the checkout
  // half-upgraded (new code, stale deps/build). Reset back to the pre-update commit
  // (the pull was ff-only), then best-effort reinstall + rebuild the previous version so
  // the running daemon stays consistent.
  //
  // BUT THE TREE WAS ONLY PROVEN CLEAN BEFORE THE PULL. Install + build run for minutes,
  // and a developer editing the checkout meanwhile (this is a source install - the same
  // tree they work in) has changes the clean check never saw. `git reset --hard` erases
  // them without a trace. So the tree is re-read here: anything that changed since is
  // moved into a named git stash BEFORE the reset, and the message says so. If the tree
  // cannot be inspected, or the stash fails, the reset does NOT run - a half-updated
  // checkout is recoverable by hand; a deleted edit is not. Edits the update had taken as its
  // own (`landed`, already the target's) are put back unstaged after the reset. Always throws.
  async function rollbackAfterFailedUpdate(err, before, output, landed = null) {
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
    const { reset, restored } = await resetAndRebuild(before.currentCommit, output, landed, before.remoteCommit);
    throw new Error(buildRollbackMessage(msg, reset, restored, stashName, changedDuring.length));
  }

  // Windows keeps a running program's image locked against overwrite, but lets it be renamed, and the
  // process keeps running from the renamed copy. So a fast-forward that changes a running program file
  // (AgentHydra's window host is one) fails partway with "unable to unlink old" and leaves a half-updated
  // checkout. Before advancing on Windows, each such file is moved aside to `<file>.replaced-<stamp>` and
  // put back at HEAD, so the checkout overwrites an unlocked copy instead of the running file.
  const PROGRAM_FILE = /\.(exe|dll|node)$/i;
  const REPLACED_COPY = ".replaced-";

  // The moved-aside copies must never make the checkout dirty, or every later apply refuses it. Git's
  // local exclude file covers them without touching the app's own .gitignore.
  async function excludeReplacedCopies() {
    const commonDir = await gitText(["rev-parse", "--git-common-dir"]);
    if (!commonDir) return false;
    const infoDir = resolve(appRoot, commonDir, "info");
    const excludeFile = join(infoDir, "exclude");
    const pattern = `*${REPLACED_COPY}*`;
    const current = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
    if (current.split(/\r?\n/).includes(pattern)) return true;
    mkdirSync(infoDir, { recursive: true });
    appendFileSync(excludeFile, `${current && !current.endsWith("\n") ? "\n" : ""}${pattern}\n`);
    return true;
  }

  // A copy moved aside while its program was still running cannot be deleted by the apply that made it.
  // Try to delete every such leftover now; one that is still running is retried by a later apply.
  async function removeLeftoverCopies() {
    const listed = await git(["ls-files", "-z"]);
    if (!listed.ok) return;
    for (const path of listed.stdout.split("\0")) {
      if (!PROGRAM_FILE.test(path)) continue;
      const full = join(appRoot, path);
      const dir = dirname(full);
      const prefix = `${basename(full)}${REPLACED_COPY}`;
      let entries = [];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.startsWith(prefix)) continue;
        try {
          unlinkSync(join(dir, entry));
        } catch {
          /* still running: a later apply retries */
        }
      }
    }
  }

  // Windows only, run before the advance. `target` is the commit the fast-forward lands on. A move that
  // fails is recorded and the advance runs as it does today; a checkout that fails after a move is put
  // back before the failure is thrown, so the path is never left missing.
  async function moveAsideRunningPrograms(target, output) {
    await removeLeftoverCopies();
    const diffArgs = ["git", "diff", "--name-only", "-z", "--no-renames", "--diff-filter=MD", "HEAD", target];
    const diff = await runCommand(diffArgs, CHECK_TIMEOUT_MS);
    if (!diff.ok) {
      output.push(commandSummary(diffArgs, diff));
      return;
    }
    const programs = diff.stdout.split("\0").filter((path) => PROGRAM_FILE.test(path) && existsSync(join(appRoot, path)));
    if (!programs.length) return;
    if (!(await excludeReplacedCopies().catch(() => false))) {
      output.push("could not exclude the moved-aside program copies from git; running programs were not moved aside");
      return;
    }
    // UTC, digits only: YYYYMMDDHHmmss.
    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    for (const path of programs) {
      const full = join(appRoot, path);
      const copy = `${full}${REPLACED_COPY}${stamp}`;
      try {
        renameSync(full, copy);
      } catch (err) {
        output.push(`could not move ${path} aside: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      output.push(`moved ${path} aside to ${basename(copy)}`);
      const checkoutArgs = ["git", "checkout", "HEAD", "--", path];
      const checkout = await runCommand(checkoutArgs, CHECK_TIMEOUT_MS);
      output.push(commandSummary(checkoutArgs, checkout));
      if (!checkout.ok) {
        const failure = stepFailureMessage(checkoutArgs, checkout);
        try {
          renameSync(copy, full);
        } catch {
          throw new Error(`${failure}; ${path} could not be moved back and is at ${basename(copy)}`);
        }
        throw new Error(failure);
      }
    }
  }

  // Every failure carries the transcript. `output` used to reach a caller only on SUCCESS: each
  // failure path threw a bare Error and the array died with the frame, so a user reporting a failed
  // update could paste one line and never the build output that explained it (RepoYeti issue #24).
  // The rejection is still an Error whose message is the one-line reason; `err.output` holds every
  // step recorded before it, rollback steps included, for the host to log and offer as details.
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
      return {
        ok: true,
        message: before.reason === "up to date" ? `${appLabel} is already up to date.` : "No update is available.",
        restartRequired: false,
        status: before,
        output,
      };
    }
    // Edits that are already the target's are staged for the advance (below); any other edit blocks it.
    const landed = before.dirty && before.localEditsLanded ? await editsAlreadyIn(before.remoteCommit) : null;
    if (before.dirty && !landed) throw new Error("Commit or stash local changes before applying an update.");
    // Diverged, unverifiable, or no pullable branch: the check already said why. Running the pull
    // anyway is exactly the fail-every-cycle loop this guard exists to end.
    if (!before.canApply) throw new Error(before.reason ?? "The update cannot be applied to this checkout.");

    const upstream = await currentUpstream();
    const remote = await remoteForCheck(upstream.remoteName);
    // Pull the branch the check just PROVED fast-forwardable, by name. A plain `git pull --ff-only`
    // would pull the configured upstream, which is the same branch in the ordinary case; naming it
    // keeps apply pointed at what check verified when the two differ (a local branch with no remote
    // counterpart follows the remote's HEAD; an update remote given by URL is pulled from that URL).
    const branch = before.remoteBranch || upstream.remoteBranch || before.branch;
    if (!remote.remoteArg || !branch) throw new Error("No update remote/branch is configured.");

    // Under a cooldown the target is an aged commit, not the tip a pull would take; the check just
    // fetched it, so fast-forward to exactly that commit instead.
    const advance = before.latestRemoteCommit
      ? ["git", "merge", "--ff-only", before.remoteCommit]
      : ["git", "pull", "--ff-only", remote.remoteArg, branch];
    // Staged, an edit that is the target's content is the fast-forward's own (git's two-way merge keeps
    // an index entry equal to the new tree). The staged entries must then be exactly the target's, mode
    // included: an edit written after the check is not, so nothing is advanced. Any failure from here
    // to the advance unstages the paths again; their files are never touched.
    const landedPaths = (landed ?? []).map((e) => e.path);
    try {
      if (landedPaths.length) {
        await runStep(["git", "--literal-pathspecs", "add", "-A", "--", ...landedPaths], APPLY_TIMEOUT_MS, output);
        const same = ["git", "--literal-pathspecs", "diff", "--cached", "--quiet", before.remoteCommit, "--", ...landedPaths];
        const compared = await runCommand(same, APPLY_TIMEOUT_MS);
        output.push(commandSummary(same, compared));
        if (!compared.ok)
          throw new Error("A local edit changed after the update check, so nothing was updated; it is left as it was.");
      }
      // Windows: a running program file cannot be overwritten by the advance, so move the ones it changes aside
      // first. The target is the commit check already fetched: FETCH_HEAD, or the cooldown's aged commit.
      if (process.platform === "win32") {
        await moveAsideRunningPrograms(before.latestRemoteCommit ? before.remoteCommit : "FETCH_HEAD", output);
      }
      await runStep(advance, APPLY_TIMEOUT_MS, output);
    } catch (err) {
      if (landedPaths.length) {
        const unstage = ["git", "--literal-pathspecs", "reset", "-q", "--", ...landedPaths];
        output.push(commandSummary(unstage, await runCommand(unstage, APPLY_TIMEOUT_MS)));
      }
      throw err;
    }
    try {
      await runStep(installCmd, BUILD_TIMEOUT_MS, output);
      await runStep(buildCmd, BUILD_TIMEOUT_MS, output);
    } catch (err) {
      await rollbackAfterFailedUpdate(err, before, output, landed);
    }

    return {
      ok: true,
      message: `${appLabel} was updated. Restart the daemon to run the new code.`,
      restartRequired: true,
      status: await checkForUpdate(),
      output,
    };
  }

  return { checkForUpdate, applyUpdate };
}
