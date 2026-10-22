/**
 * What the update remote offers (part of updater-engine.mjs, synced with it): the remote and branch
 * to compare against, the commit an update would move to (cooldown included), whether HEAD can
 * fast-forward to it, and the one-line reason a status carries.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { APPLY_TIMEOUT_MS } from "./updater-engine-run.mjs";

function parseRemoteHead(stdout) {
  return {
    branch: stdout.match(/^ref:\s+refs\/heads\/(.+)\s+HEAD$/m)?.[1] ?? null,
    commit: stdout.match(/^([0-9a-f]{40})\s+HEAD$/m)?.[1] ?? null,
  };
}

function parseLsRemoteCommit(stdout) {
  return stdout.match(/^([0-9a-f]{40})\s+/m)?.[1] ?? null;
}

/** The status reason: why an update is blocked, or what the check found when there is none to apply. */
export function reasonForStatus({ newer, dirty, fastForward, remoteBranch, remoteCommit, remoteIsAncestor, cooldown }, cooldownDays) {
  if (newer) return blockedReason(dirty, fastForward, remoteBranch);
  if (cooldown === "unknown") return "could not fetch the update remote to apply the update cooldown";
  if (cooldown === "held") return `newer commits on the update remote are inside the ${cooldownDays}-day update cooldown`;
  if (remoteCommit) return remoteIsAncestor ? "local checkout is ahead of the update remote" : "up to date";
  return "could not read remote commit";
}

function blockedReason(dirty, fastForward, remoteBranch) {
  if (dirty) return "local changes must be committed or stashed before updating";
  if (fastForward === "no")
    return "local checkout has diverged from the update remote; a fast-forward is not possible (merge or rebase at your desk)";
  if (fastForward === "unknown") return "could not fetch the update remote to verify the update";
  if (!remoteBranch) return "could not determine the remote branch to pull";
  return null;
}

export function createRemoteReader({ appRoot, git, gitText, updateRepoEnvVar, cooldownSeconds }) {
  async function isGitCheckout() {
    if (!existsSync(join(appRoot, ".git"))) return false;
    return (await gitText(["rev-parse", "--is-inside-work-tree"])) === "true";
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

  // The remote branch the update would actually pull. `compareBranch` is what was ASKED for;
  // when the remote has no such branch the check falls back to the remote's HEAD, and apply
  // must then pull THAT branch: the local name is unknown there ("couldn't find remote ref").
  async function resolveRemoteCommit(remoteArg, compareBranch, localBranch) {
    if (compareBranch) {
      const ref = await git(["ls-remote", remoteArg, `refs/heads/${compareBranch}`]);
      const remoteCommit = ref.ok ? parseLsRemoteCommit(ref.stdout) : null;
      if (remoteCommit) return { remoteCommit, remoteBranch: compareBranch, branch: localBranch };
    }
    const head = await git(["ls-remote", "--symref", remoteArg, "HEAD"]);
    if (!head.ok) return { remoteCommit: null, remoteBranch: compareBranch || null, branch: localBranch };
    const parsed = parseRemoteHead(head.stdout);
    return { remoteCommit: parsed.commit, remoteBranch: parsed.branch, branch: localBranch || parsed.branch };
  }

  // A differing remote SHA is not enough: a dev checkout is routinely AHEAD of the update remote,
  // and then that commit exists locally and merge-base --is-ancestor proves it is behind us.
  // "Newer" is not "applicable" either: `pull --ff-only` needs HEAD to be the remote commit's
  // ancestor, so the fast-forward is proven before it is advertised, by fetching just that branch
  // into FETCH_HEAD (nothing local moves). A failed fetch is its own reason, never a guess.
  // `alreadyFetched`: the cooldown path fetched already and picked an older commit than the tip.
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

  return { isGitCheckout, currentUpstream, remoteForCheck, resolveRemoteCommit, evaluateFastForward, applyCooldown };
}
