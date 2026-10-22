// The shared fixture of the self-update engine's tests (SHARED LunarWerx server-lib, synced with
// updater-engine.test.ts beside it): scratch git remotes and clones, real install/build steps that
// log each call, and the updater under test. Not a test file itself.
//
// Exercises the real engine against a scratch git remote + clone (no mocking of git/spawn) so the
// stage-then-swap / rollback-on-failure path around applyUpdate() is verified against actual repo
// state, not just the transcript log. installCmd/buildCmd are real `bun -e` invocations that log
// each call and can be made to fail on demand, so "did install/build actually run, how many times,
// and in what order" is checkable after the fact. All git operations are local (file:// clones of
// tmpdir repos) — no network — so the suite is hermetic and deterministic.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { createUpdater } from "../../src/updater-engine.mjs";

// Every scratch dir (git remotes, clones, and per-test log/count dirs) is tracked here and
// removed in afterEach — each run otherwise leaks 9 full git repos into the temp dir, which
// accumulates unbounded on a long-lived CI runner. Mirrors the tempDir/tempHome + rmSync
// pattern the sibling kit tests use.
const dirs: string[] = [];
export function scratchDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

// Each test file registers this as its afterEach with 30s, stated there because the hook deletes NINE full git repos from the temp dir and a
// recursive delete of a git tree is thousands of small files - I/O time, not assertion time. On
// a loaded machine it crosses bun's 5s default, and bun reports a hook timeout as
// `(fail) (unnamed)` with no file and no hook name, which is the least actionable red a suite
// can print. Hooks DO honour setDefaultTimeout() as well (measured on bun 1.4.0), but this file
// is kit-synced into apps that may not set one, so it carries its own.
export function cleanScratchDirs(): void {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  }
}

// The backstop for a test file that registers no afterEach: whatever is left goes when the process exits.
process.on("exit", cleanScratchDirs);

export async function remoteRepo(): Promise<string> {
  const dir = scratchDir("ue-remote-");
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "0.1.0" }));
  writeFileSync(join(dir, "marker.txt"), "v1\n");
  await $`git -C ${dir} -c user.name=S -c user.email=s@s.io add -A`.quiet();
  await $`git -C ${dir} -c user.name=S -c user.email=s@s.io commit -q -m init`.quiet();
  return dir;
}

export async function cloneRepo(remote: string): Promise<string> {
  const dir = scratchDir("ue-local-");
  await $`git clone -q ${remote} ${dir}`.quiet();
  await $`git -C ${dir} config user.name S`.quiet();
  await $`git -C ${dir} config user.email s@s.io`.quiet();
  return dir;
}

export async function advanceRemote(remote: string, version: string): Promise<void> {
  writeFileSync(join(remote, "package.json"), JSON.stringify({ name: "x", version }));
  writeFileSync(join(remote, "marker.txt"), `${version}\n`);
  await $`git -C ${remote} -c user.name=S -c user.email=s@s.io add -A`.quiet();
  await $`git -C ${remote} -c user.name=S -c user.email=s@s.io commit -q -m ${version}`.quiet();
}

/** The remote lands a fix: marker.txt changes and hotfix.txt is new. */
export async function landHotfix(remote: string): Promise<void> {
  writeFileSync(join(remote, "marker.txt"), "0.2.0\n");
  writeFileSync(join(remote, "hotfix.txt"), "the fix\n");
  await $`git -C ${remote} -c user.name=S -c user.email=s@s.io add -A`.quiet();
  await $`git -C ${remote} -c user.name=S -c user.email=s@s.io commit -q -m hotfix`.quiet();
}

/** The same fix typed into the deployed checkout by hand, uncommitted. */
export function patchByHand(local: string): void {
  writeFileSync(join(local, "marker.txt"), "0.2.0\n");
  writeFileSync(join(local, "hotfix.txt"), "the fix\n");
}

/** A runtime `-e` step that appends `label` to a log file — a real subprocess, no mocking.
 *  Use the exact executable running the suite instead of the bare `bun` command: on Windows,
 *  npm-installed Bun can put only `bun.cmd`/`bun.ps1` on PATH, and the updater's shell fallback
 *  would then reinterpret the JavaScript argument and strip its quotes. */
export function loggingCmd(logPath: string, label: string): string[] {
  const script = `require("fs").appendFileSync(${JSON.stringify(logPath)}, ${JSON.stringify(label)} + "\\n")`;
  return [process.execPath, "-e", script];
}

/** A `bun -e` step that logs, then exits non-zero iff `failFlag` exists on disk. */
export function failableCmd(logPath: string, label: string, failFlag: string): string[] {
  const script = [
    `require("fs").appendFileSync(${JSON.stringify(logPath)}, ${JSON.stringify(label)} + "\\n")`,
    `if (require("fs").existsSync(${JSON.stringify(failFlag)})) { console.error("boom"); process.exit(1); }`,
  ].join("; ");
  return [process.execPath, "-e", script];
}

/** A `bun -e` step that logs, then exits non-zero on calls whose 1-based call number is in
 *  `failOnCalls` (call count persisted in `countFile`, which — unlike the git-tracked tree —
 *  survives a `git reset --hard`). `stderr` may be multiline, to stand in for a real runner's
 *  output where the first line is the echoed command and the reason is further down. */
export function failsOnCallsCmd(
  logPath: string,
  label: string,
  countFile: string,
  failOnCalls: number[],
  stderr = "boom",
): string[] {
  const script = [
    `const fs = require("fs")`,
    `const n = (fs.existsSync(${JSON.stringify(countFile)}) ? Number(fs.readFileSync(${JSON.stringify(countFile)}, "utf8")) : 0) + 1`,
    `fs.writeFileSync(${JSON.stringify(countFile)}, String(n))`,
    `fs.appendFileSync(${JSON.stringify(logPath)}, ${JSON.stringify(label)} + "\\n")`,
    `if (${JSON.stringify(failOnCalls)}.includes(n)) { console.error(${JSON.stringify(stderr)}); process.exit(1); }`,
  ].join("; ");
  return [process.execPath, "-e", script];
}

// The budget of every test below: each one is a dozen-plus real git and bun spawns (init, commit,
// clone, fetch, pull, install, build, reset, stash). 30s was a race, not a bound: run 1 of five
// back-to-back runs under the fair-job wrapper (BelowNormal priority, other suites beside it) spent
// 109.55s on this file and the stash test timed out at 30536ms (2026-10-03), while the same test
// passes in a few seconds on an idle machine. 120s was a race too: beside a full app suite run four
// files at a time, on a box at ~90% CPU from other work (2026-10-11), every git or bun spawn took
// 0.5-3.4 s, twelve runs of the cooldown test (19 s alone) took 62-194 s, each checkForUpdate in them
// 15-54 s and each applyUpdate 21-96 s, and three tests were cut at 120 s in one suite run. A test is
// many engine steps, so the engine's own per-step bound (APPLY_TIMEOUT_MS, 120 s) never bounds a
// whole test. 400s is about twice the slowest measured run, and a real hang still fails in bounded time.
export const REAL_GIT_TEST_MS = 400_000;

export function updaterFor(appRoot: string, installCmd: string[], buildCmd: string[], asideDir: string | null = null) {
  return createUpdater({
    appRoot,
    serviceName: "testsvc",
    appLabel: "TestSvc",
    updateRepoEnvVar: "UE_TEST_UPDATE_REPO_UNUSED",
    installCmd,
    buildCmd,
    asideDir,
  });
}

/** Lands `body` at `rel` in the remote as one commit. */
export async function landFile(remote: string, rel: string, body: string): Promise<void> {
  mkdirSync(join(remote, rel, ".."), { recursive: true });
  writeFileSync(join(remote, rel), body);
  await $`git -C ${remote} -c user.name=S -c user.email=s@s.io add -A`.quiet();
  await $`git -C ${remote} -c user.name=S -c user.email=s@s.io commit -q -m ${rel}`.quiet();
}

/** A `bun -e` step that appends the base name of the folder it runs in, so a test can see where a step ran. */
export function cwdCmd(logPath: string): string[] {
  const script = `require("fs").appendFileSync(${JSON.stringify(logPath)}, require("path").basename(process.cwd()) + "\\n")`;
  return [process.execPath, "-e", script];
}
