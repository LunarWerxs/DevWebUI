// Tests for the shared self-update engine: check, apply, the steps an update makes due, and the rollback (SHARED LunarWerx server-lib, source of truth: lunarwerx-ui/src/server-lib/updater-engine.test.ts,
// synced by sync.mjs into each app's `serverTests` dir under a `server-lib/` subdir next to the app's server
// tree; the `../../src/updater-engine.mjs` import resolves only there). Scratch repos and steps:
// updater-engine-fixture.ts.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import type { UpdateApplyError } from "../../src/updater-engine.mjs";
import { createUpdater } from "../../src/updater-engine.mjs";
import { advanceRemote, cleanScratchDirs, cloneRepo, cwdCmd, failableCmd, failsOnCallsCmd, landFile, loggingCmd, REAL_GIT_TEST_MS, remoteRepo, scratchDir, updaterFor } from "./updater-engine-fixture.ts";

// 30s: the hook deletes every scratch git repo the file made (I/O time, not assertion time); see the fixture.
afterEach(cleanScratchDirs, 30_000);

test("checkForUpdate + applyUpdate happy path: pulls, installs, builds, HEAD advances", async () => {
  const remote = await remoteRepo();
  const local = await cloneRepo(remote);
  await advanceRemote(remote, "0.2.0");

  const scratch = scratchDir("ue-scratch-");
  const log = join(scratch, "steps.log");
  const updater = updaterFor(local, loggingCmd(log, "install"), loggingCmd(log, "build"));

  const before = await updater.checkForUpdate();
  expect(before.updateAvailable).toBe(true);
  expect(before.canApply).toBe(true);

  const result = await updater.applyUpdate();
  expect(result.ok).toBe(true);
  expect(result.restartRequired).toBe(true);
  expect(result.message).toBe("TestSvc was updated. Restart the daemon to run the new code.");

  const head = (await $`git -C ${local} rev-parse HEAD`.text()).trim();
  const remoteHead = (await $`git -C ${remote} rev-parse HEAD`.text()).trim();
  expect(head).toBe(remoteHead);
  expect(readFileSync(join(local, "marker.txt"), "utf8").trim()).toBe("0.2.0");
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["install", "build"]);

  const after = await updater.checkForUpdate();
  expect(after.updateAvailable).toBe(false);
  expect(after.dirty).toBe(false);
  // REAL git pull + install + build in a scratch repo: ~5s locally, and it repeatedly hit the 5s
  // default on a cold Windows CI runner (2026-07-16), then the 30s that replaced it under load
  // (2026-10-03). See REAL_GIT_TEST_MS. (Push upstream to the kit source.)
}, REAL_GIT_TEST_MS);

// An app whose daemon serves every route on one thread passes `run`, its own off-thread runner
// (AgentHydra: Bun.spawn held that thread for seconds per git call under load). Every step of a check
// and an apply must go through it, in the checkout with prompts off, and its answers decide the
// outcome: a step spawned around it would hold the app's thread again.
test("run: an app's runner carries every git, install and build step, and its answers decide the apply", async () => {
  const remote = await remoteRepo();
  const local = await cloneRepo(remote);
  await advanceRemote(remote, "0.2.0");
  const scratch = scratchDir("ue-scratch-");
  const log = join(scratch, "steps.log");
  const installCmd = loggingCmd(log, "install");
  const buildCmd = loggingCmd(log, "build");
  const calls: { args: string[]; cwd: string; prompt: string | undefined }[] = [];
  const updater = createUpdater({
    appRoot: local,
    serviceName: "testsvc",
    appLabel: "TestSvc",
    updateRepoEnvVar: "UE_TEST_UPDATE_REPO_UNUSED",
    installCmd,
    buildCmd,
    run: async (args, { cwd, env }) => {
      calls.push({ args, cwd, prompt: env.GIT_TERMINAL_PROMPT });
      const p = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe", windowsHide: true });
      const [stdout, stderr, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      return { code, stdout, stderr, timedOut: false };
    },
  });

  expect((await updater.checkForUpdate()).updateAvailable).toBe(true);
  const result = await updater.applyUpdate();
  expect(result.ok).toBe(true);
  expect(readFileSync(join(local, "marker.txt"), "utf8").trim()).toBe("0.2.0");
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["install", "build"]);
  const ran = calls.map((c) => c.args);
  expect(ran.some((a) => a[0] === "git" && a[1] === "ls-remote")).toBe(true);
  expect(ran.some((a) => a[0] === "git" && a[1] === "pull")).toBe(true);
  expect(ran).toContainEqual(installCmd);
  expect(ran).toContainEqual(buildCmd);
  expect(calls.every((c) => c.cwd === local && c.prompt === "0")).toBe(true);
}, REAL_GIT_TEST_MS);

test("applyUpdate rolls back the checkout when build fails after the code swap", async () => {
  const remote = await remoteRepo();
  const local = await cloneRepo(remote);
  const preUpdateCommit = (await $`git -C ${local} rev-parse HEAD`.text()).trim();
  await advanceRemote(remote, "0.2.0");

  const scratch = scratchDir("ue-scratch-");
  const log = join(scratch, "steps.log");
  const buildCount = join(scratch, "build.count");
  // build fails on call 1 (forward pass, triggers the rollback) and succeeds on call 2 (rollback
  // reinstall pass), so this test isolates a clean rollback from the reinstall-also-fails case.
  const updater = updaterFor(local, loggingCmd(log, "install"), failsOnCallsCmd(log, "build", buildCount, [1]));

  const failure = (await updater.applyUpdate().then(
    () => null,
    (e: unknown) => e,
  )) as UpdateApplyError | null;
  expect(failure?.message).toContain("boom; rolled back to the previous version");
  // The transcript rides on the rejection (RepoYeti issue #24): the pull, the failed build with its
  // stderr, and the rollback steps, in order. Before, it only ever reached a caller on success.
  const transcript = (failure?.output ?? []).join("\n");
  expect(transcript).toContain("git pull --ff-only");
  expect(transcript).toContain("boom");
  expect(transcript).toContain("git reset --hard");

  // Checkout state, not just the log message: HEAD is back at the pre-update commit, the
  // pulled-in file change is gone, and the tree is clean (no half-applied swap left behind).
  const head = (await $`git -C ${local} rev-parse HEAD`.text()).trim();
  expect(head).toBe(preUpdateCommit);
  expect(readFileSync(join(local, "marker.txt"), "utf8").trim()).toBe("v1");
  const porcelain = (await $`git -C ${local} status --porcelain`.text()).trim();
  expect(porcelain).toBe("");
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["install", "build", "install", "build"]);

  const status = await updater.checkForUpdate();
  expect(status.currentCommit).toBe(preUpdateCommit);
  expect(status.dirty).toBe(false);
}, REAL_GIT_TEST_MS); // real git+install+build — see the happy-path test's note on the widened timeout.

test("a failed build reports the underlying error, not the command line the runner echoed", async () => {
  const remote = await remoteRepo();
  const local = await cloneRepo(remote);
  await advanceRemote(remote, "0.2.0");

  const scratch = scratchDir("ue-scratch-");
  const log = join(scratch, "steps.log");
  const buildCount = join(scratch, "build.count");
  // Exactly the shape reported in RepoYeti issue #24: `bun run build` opens by ECHOING the script
  // it is about to run, so the reason the build failed is several lines down. Taking stderr line 1
  // showed the user the command and dropped the cause; the dashboard has no other copy to fall back
  // on, because `output` is only returned on the success path.
  const buildStderr = [
    "$ node scripts/i18n-check.mjs && vue-tsc -b && vite build --outDir dist-next",
    "",
    "vite v5.4.11 building for production...",
    'Failed to resolve import "./button-variants" from "src/components/ui/button/index.ts". Does the file exist?',
  ].join("\n");
  // Build fails on the forward pass only, so this isolates the message from the reinstall-also-failed case.
  const updater = updaterFor(
    local,
    loggingCmd(log, "install"),
    failsOnCallsCmd(log, "build", buildCount, [1], buildStderr),
  );

  const message = await updater.applyUpdate().then(
    () => "applyUpdate unexpectedly succeeded",
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  );

  expect(message).toContain('Failed to resolve import "./button-variants"');
  expect(message).not.toContain("node scripts/i18n-check.mjs");
  expect(message).toContain("rolled back to the previous version");
}, REAL_GIT_TEST_MS); // real git+install+build — see the happy-path test's note on the widened timeout.

test("rollback message distinguishes a clean revert from a revert whose reinstall also fails", async () => {
  const remote = await remoteRepo();
  const local = await cloneRepo(remote);
  const preUpdateCommit = (await $`git -C ${local} rev-parse HEAD`.text()).trim();
  await advanceRemote(remote, "0.2.0");

  const scratch = scratchDir("ue-scratch-");
  const log = join(scratch, "steps.log");
  const installCount = join(scratch, "install.count");
  const buildFailFlag = join(scratch, "FAIL_BUILD");
  writeFileSync(buildFailFlag, "1");

  // install succeeds on the forward pass (call 1), fails on the rollback reinstall pass (call 2);
  // build fails on the forward pass, which is what triggers the rollback in the first place.
  const updater = updaterFor(
    local,
    failsOnCallsCmd(log, "install", installCount, [2]),
    failableCmd(log, "build", buildFailFlag),
  );

  await expect(updater.applyUpdate()).rejects.toThrow(
    "boom; code was rolled back, but reinstalling/rebuilding it failed; the previous version may not run until this is fixed",
  );

  const head = (await $`git -C ${local} rev-parse HEAD`.text()).trim();
  expect(head).toBe(preUpdateCommit);
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["install", "build", "install"]);
}, REAL_GIT_TEST_MS); // real git+install+build — see the happy-path test's note on the widened timeout.

/** A `bun -e` build step whose FIRST call edits a tracked file in the checkout and writes an
 *  untracked one beside it, then fails - the developer who typed into the tree while
 *  install/build were running. Later calls (the rollback's rebuild pass) log and succeed, so
 *  what the test then finds in the tree is the rollback's doing, not the fixture's. */
function editingThenFailingBuildCmd(logPath: string, appRoot: string, countFile: string): string[] {
  const script = [
    `const fs = require("fs")`,
    `const n = (fs.existsSync(${JSON.stringify(countFile)}) ? Number(fs.readFileSync(${JSON.stringify(countFile)}, "utf8")) : 0) + 1`,
    `fs.writeFileSync(${JSON.stringify(countFile)}, String(n))`,
    `fs.appendFileSync(${JSON.stringify(logPath)}, "build\\n")`,
    `if (n === 1) {`,
    `fs.writeFileSync(${JSON.stringify(join(appRoot, "marker.txt"))}, "my edit, typed during the build\\n")`,
    `fs.writeFileSync(${JSON.stringify(join(appRoot, "notes.txt"))}, "an untracked file I was writing\\n")`,
    `console.error("boom"); process.exit(1)`,
    `}`,
  ].join("; ");
  return [process.execPath, "-e", script];
}

test("an edit made during install/build survives the rollback, in a named stash, and the message says so", async () => {
  // Audit AH-39: the tree was proven clean BEFORE the pull; install + build then ran for a
  // while, and a `git reset --hard` erased whatever was typed into the checkout meanwhile.
  const remote = await remoteRepo();
  const local = await cloneRepo(remote);
  const preUpdateCommit = (await $`git -C ${local} rev-parse HEAD`.text()).trim();
  await advanceRemote(remote, "0.2.0");

  const scratch = scratchDir("ue-scratch-");
  const log = join(scratch, "steps.log");
  const buildCount = join(scratch, "build.count");
  const updater = updaterFor(
    local,
    loggingCmd(log, "install"),
    editingThenFailingBuildCmd(log, local, buildCount),
  );

  let message = "";
  try {
    await updater.applyUpdate();
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  expect(message).toContain("boom; rolled back to the previous version");
  expect(message).toContain("2 file(s) changed during the update were saved to git stash");
  expect(message).toContain("testsvc-update-rollback-");
  expect(message).toContain("git stash pop brings them back");

  // The rollback itself still happened: HEAD is back, the tracked file is the pre-update one,
  // the tree is clean.
  expect((await $`git -C ${local} rev-parse HEAD`.text()).trim()).toBe(preUpdateCommit);
  expect(readFileSync(join(local, "marker.txt"), "utf8").trim()).toBe("v1");
  expect((await $`git -C ${local} status --porcelain`.text()).trim()).toBe("");

  // And the edit is recoverable, not gone: one stash, named, holding both files.
  const stashes = (await $`git -C ${local} stash list`.text()).trim().split("\n").filter(Boolean);
  expect(stashes).toHaveLength(1);
  expect(stashes[0]).toContain("testsvc-update-rollback-");
  const stashed = await $`git -C ${local} stash show -p --include-untracked stash@{0}`.text();
  expect(stashed).toContain("my edit, typed during the build");
  expect(stashed).toContain("an untracked file I was writing");
  // File-by-file recovery works regardless of whether a `stash pop` would conflict (it does
  // here: the stash is based on the NEW commit, whose marker.txt differs from the rolled-back
  // one). The tracked edit is the stash commit's tree; untracked files ride on its third parent.
  expect((await $`git -C ${local} show stash@{0}:marker.txt`.text()).trim()).toBe("my edit, typed during the build");
  expect((await $`git -C ${local} show stash@{0}^3:notes.txt`.text()).trim()).toBe("an untracked file I was writing");
}, REAL_GIT_TEST_MS);

test("a rollback of a tree nobody touched creates no stash", async () => {
  const remote = await remoteRepo();
  const local = await cloneRepo(remote);
  await advanceRemote(remote, "0.2.0");
  const scratch = scratchDir("ue-scratch-");
  const log = join(scratch, "steps.log");
  const buildCount = join(scratch, "build.count");
  const updater = updaterFor(local, loggingCmd(log, "install"), failsOnCallsCmd(log, "build", buildCount, [1]));
  let message = "";
  try {
    await updater.applyUpdate();
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  expect(message).toBe("boom; rolled back to the previous version");
  expect((await $`git -C ${local} stash list`.text()).trim()).toBe("");
}, REAL_GIT_TEST_MS);

// ── Steps and the restart, by what the update changed ───────────────────────────────────────────
// An app whose install and build read only part of its checkout passes `steps`, and a restart is asked for only the paths
// `restartWhen` names. The paths are git's own, so a commit that moves HEAD without touching them runs and restarts nothing
// (2026-10-21: 44 of 59 daemon relaunches in 18 h changed no file the daemon loads).


test("a README-only update runs no install and restarts nothing: the steps and the restart answer by the paths changed", async () => {
  const remote = await remoteRepo();
  const local = await cloneRepo(remote);
  await landFile(remote, "NOTES.md", "notes\n");
  const log = join(scratchDir("ue-scratch-"), "steps.log");
  const updater = createUpdater({
    appRoot: local,
    serviceName: "testsvc",
    appLabel: "TestSvc",
    updateRepoEnvVar: "UE_TEST_UPDATE_REPO_UNUSED",
    steps: [
      { cmd: loggingCmd(log, "install"), when: (changed) => changed.includes("package.json") },
      { cmd: loggingCmd(log, "build") },
    ],
    restartWhen: (changed) => changed.some((p) => p.startsWith("src/")),
  });

  const result = await updater.applyUpdate();
  expect(result.ok).toBe(true);
  expect(result.restartRequired).toBe(false);
  expect(result.message).toBe("TestSvc was updated. The code it runs did not change, so no restart is needed.");
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["build"]);
  expect(readFileSync(join(local, "NOTES.md"), "utf8").replace(/\r\n/g, "\n")).toBe("notes\n");
}, REAL_GIT_TEST_MS);

test("a file moved out of a daemon path counts as changed there, so the restart it needs is not missed", async () => {
  const remote = await remoteRepo();
  await landFile(remote, "src/a.ts", "export const a = 1;\n");
  const local = await cloneRepo(remote);
  mkdirSync(join(remote, "lib"));
  await $`git -C ${remote} mv src/a.ts lib/a.ts`.quiet();
  await $`git -C ${remote} -c user.name=S -c user.email=s@s.io commit -q -m moved`.quiet();
  const seen: string[] = [];
  const updater = createUpdater({
    appRoot: local,
    serviceName: "testsvc",
    appLabel: "TestSvc",
    updateRepoEnvVar: "UE_TEST_UPDATE_REPO_UNUSED",
    steps: [],
    restartWhen: (changed) => {
      seen.push(...changed);
      return changed.some((p) => p.startsWith("src/"));
    },
  });

  const result = await updater.applyUpdate();
  expect(seen.sort()).toEqual(["lib/a.ts", "src/a.ts"]);
  expect(result.restartRequired).toBe(true);
  expect(existsSync(join(local, "lib", "a.ts"))).toBe(true);
}, REAL_GIT_TEST_MS);

test("a commit that moves HEAD without changing any path runs no step and restarts nothing", async () => {
  const remote = await remoteRepo();
  const local = await cloneRepo(remote);
  await $`git -C ${remote} -c user.name=S -c user.email=s@s.io commit -q --allow-empty -m empty`.quiet();
  const log = join(scratchDir("ue-scratch-"), "steps.log");
  const updater = createUpdater({
    appRoot: local,
    serviceName: "testsvc",
    appLabel: "TestSvc",
    updateRepoEnvVar: "UE_TEST_UPDATE_REPO_UNUSED",
    steps: [
      { cmd: loggingCmd(log, "install"), when: (changed) => changed.includes("package.json") },
      { cmd: loggingCmd(log, "build"), when: (changed) => changed.length > 0 },
    ],
  });

  const result = await updater.applyUpdate();
  expect(result.ok).toBe(true);
  expect(result.restartRequired).toBe(false);
  expect(existsSync(log)).toBe(false);
  expect((await $`git -C ${local} rev-parse HEAD`.text()).trim()).toBe((await $`git -C ${remote} rev-parse HEAD`.text()).trim());
}, REAL_GIT_TEST_MS);

test("a step runs in its own folder under the checkout", async () => {
  const remote = await remoteRepo();
  const local = await cloneRepo(remote);
  await landFile(remote, "NOTES.md", "notes\n");
  mkdirSync(join(local, "sub"));
  const log = join(scratchDir("ue-scratch-"), "steps.log");
  const updater = createUpdater({
    appRoot: local,
    serviceName: "testsvc",
    appLabel: "TestSvc",
    updateRepoEnvVar: "UE_TEST_UPDATE_REPO_UNUSED",
    steps: [
      { cmd: loggingCmd(log, "install"), when: (changed) => changed.includes("package.json") },
      { cmd: cwdCmd(log), dir: "sub" },
    ],
  });

  expect((await updater.applyUpdate()).ok).toBe(true);
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["sub"]);
}, REAL_GIT_TEST_MS);

test("a failed step rolls back, and the rollback reruns only the steps this update made due", async () => {
  const remote = await remoteRepo();
  const local = await cloneRepo(remote);
  await landFile(remote, "NOTES.md", "notes\n");
  mkdirSync(join(local, "sub"));
  const scratch = scratchDir("ue-scratch-");
  const log = join(scratch, "steps.log");
  const updater = createUpdater({
    appRoot: local,
    serviceName: "testsvc",
    appLabel: "TestSvc",
    updateRepoEnvVar: "UE_TEST_UPDATE_REPO_UNUSED",
    steps: [
      { cmd: loggingCmd(log, "install"), when: (changed) => changed.includes("package.json") },
      // Fails on its first call only: the forward pass fails, and the rollback's rebuild succeeds.
      { cmd: failsOnCallsCmd(log, "build", join(scratch, "build.count"), [1]), dir: "sub" },
    ],
  });

  const message = await updater.applyUpdate().then(
    () => "applyUpdate unexpectedly succeeded",
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  );
  expect(message).toContain("boom; rolled back to the previous version");
  // No install: the update did not make it due, so the rollback does not run it either.
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["build", "build"]);
}, REAL_GIT_TEST_MS);
