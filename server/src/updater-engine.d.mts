export interface UpdateStatus {
  ok: boolean;
  service: string;
  currentVersion: string;
  currentCommit: string | null;
  remoteCommit: string | null;
  branch: string | null;
  upstream: string | null;
  remote: string | null;
  dirty: boolean;
  updateAvailable: boolean;
  canApply: boolean;
  checkedAt: number;
  reason: string | null;
  /** True when the checkout is dirty but every local edit is already the update target's content
   *  (a hand patch since landed upstream): it does not block the update. OPTIONAL: set by the
   *  git-checkout engine only. */
  localEditsLanded?: boolean;
  /** The remote branch an apply would pull: the tracked/local branch when the remote has it, else
   *  the remote's HEAD branch the check fell back to. OPTIONAL: set by the git-checkout engine only. */
  remoteBranch?: string | null;
  /** True when a newer remote commit exists but HEAD is not its ancestor, so `pull --ff-only`
   *  cannot apply it (local commits the remote lacks). `canApply` is false and `reason` says so.
   *  OPTIONAL: set by the git-checkout engine only. */
  diverged?: boolean;
  /** Set only while an update cooldown is in play: the remote branch tip, whereas `remoteCommit` is
   *  the newest first-parent commit old enough to adopt (null when none is yet). OPTIONAL: set by
   *  the git-checkout engine only. */
  latestRemoteCommit?: string | null;
  /** The cooldown in days that chose `remoteCommit`; present alongside `latestRemoteCommit`. */
  cooldownDays?: number;
  /** Installed version of each release-owned component, or null where an install predates version
   *  stamping. OPTIONAL because only an app whose release ships sidecar components beside the
   *  executable can populate it: the git-checkout engine has no such components, and a fabricated
   *  entry there would be worse than an absent one. */
  components?: Array<{ name: string; version: string | null }>;
}

export interface UpdateApplyResult {
  ok: boolean;
  message: string;
  restartRequired: boolean;
  status: UpdateStatus;
  output: string[];
}

/** What `applyUpdate` rejects with: `message` is the one-line reason, `output` is every step's
 *  `$ command` + result recorded before the failure (rollback steps included), in order. */
export interface UpdateApplyError extends Error {
  output: string[];
}

/** One install or build step: `cmd` runs in `dir` (a folder under the checkout root; default the root) when `when` holds. */
export interface UpdaterStep {
  cmd: string[];
  dir?: string;
  when?: (changed: string[]) => boolean;
}

/** What an UpdaterOptions `run` answers for one command. */
export interface UpdaterRunResult {
  /** The exit code; null when the command could not be started or did not exit on its own. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** It ran past `timeoutMs` and was ended. */
  timedOut: boolean;
}

export interface UpdaterOptions {
  /** Checkout root (each app resolves its own import.meta path and passes it in). */
  appRoot: string;
  /** Value of the `service` field on UpdateStatus. */
  serviceName: string;
  /** Display name used in the apply-result messages. */
  appLabel: string;
  /** Env var whose value overrides the update remote (URL or remote name). */
  updateRepoEnvVar: string;
  /** Install step, e.g. ["bun", "install"]. Unused when `steps` is given. */
  installCmd?: string[];
  /** Build step, e.g. ["bun", "run", "--cwd", "web", "build"]. Unused when `steps` is given. */
  buildCmd?: string[];
  /** The install and build steps in order, in place of installCmd and buildCmd. Only the steps `when` makes due for the
   *  paths the update changed run, forward and in a rollback. */
  steps?: UpdaterStep[];
  /** Whether the update needs the app restarted, given the paths it changed (renames split). Default: any path changed. */
  restartWhen?: (changed: string[]) => boolean | Promise<boolean>;
  /** Folder outside the work tree (same volume) that a running program the update replaces is moved into
   *  (Windows), so `git status` stays clean; a program that cannot be moved there refuses the update.
   *  Default null: the copy is left beside the program, hidden by the clone's local git exclude. */
  asideDir?: string | null;
  /** Adopt only commits at least this many days old (committer date, first-parent history of the
   *  remote branch), so a bad push can be caught before installs run it. Default 0: off, the tip is
   *  adopted as soon as it is seen. Not a defence against a compromised push: the committer date is
   *  set by whoever pushes and can be backdated past the cooldown. */
  cooldownDays?: number;
  /** Runs each command the engine needs (git, install, build) in place of its own node:child_process
   *  spawn, which retries a Windows `.cmd` shim through a shell. An app whose daemon serves every
   *  route on one thread passes a runner that starts processes off that thread. It gets the argv, the
   *  checkout root, the environment (GIT_TERMINAL_PROMPT=0 set) and the step's deadline. */
  run?: (
    args: string[],
    opts: { cwd: string; env: Record<string, string | undefined>; timeoutMs: number },
  ) => Promise<UpdaterRunResult>;
}

export interface Updater {
  checkForUpdate(): Promise<UpdateStatus>;
  applyUpdate(): Promise<UpdateApplyResult>;
}

export function createUpdater(opts: UpdaterOptions): Updater;
