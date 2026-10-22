// Tests for the self-update engine's local edits the update already carries (SHARED LunarWerx server-lib, source of truth: lunarwerx-ui/src/server-lib/updater-engine-edits.test.ts,
// synced by sync.mjs into each app's `serverTests` dir under a `server-lib/` subdir next to the app's server
// tree; the `../../src/updater-engine.mjs` import resolves only there). Scratch repos and steps:
// updater-engine-fixture.ts.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { createUpdater } from "../../src/updater-engine.mjs";
import { cleanScratchDirs, cloneRepo, failsOnCallsCmd, landHotfix, loggingCmd, patchByHand, REAL_GIT_TEST_MS, remoteRepo, scratchDir, updaterFor } from "./updater-engine-fixture.ts";

// 30s: the hook deletes every scratch git repo the file made (I/O time, not assertion time); see the fixture.
afterEach(cleanScratchDirs, 30_000);

// ── A hand patch since landed upstream ──────────────────────────────────────────────────────
// A deployed checkout patched by hand stayed dirty after the same edits were landed, so it took no
// update at all (AgentHydra, 2026-10-15). Edits that are already the target's content no longer
// block; any other edit still does, and none is ever overwritten.

test("a hand edit the update already carries does not block it: applied, and the checkout ends clean", async () => {
  const remote = await remoteRepo();
  const local = await cloneRepo(remote);
  await landHotfix(remote);
  patchByHand(local);
  const scratch = scratchDir("ue-scratch-");
  const log = join(scratch, "steps.log");
  const updater = updaterFor(local, loggingCmd(log, "install"), loggingCmd(log, "build"));

  const before = await updater.checkForUpdate();
  expect(before.dirty).toBe(true);
  expect(before.localEditsLanded).toBe(true);
  expect(before.canApply).toBe(true);
  expect((await updater.applyUpdate()).ok).toBe(true);
  expect((await $`git -C ${local} rev-parse HEAD`.text()).trim()).toBe(
    (await $`git -C ${remote} rev-parse HEAD`.text()).trim(),
  );
  expect((await $`git -C ${local} status --porcelain`.text()).trim()).toBe("");
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["install", "build"]);
}, REAL_GIT_TEST_MS);

test("an edit the update does not carry still blocks it, beside one it does, and both stay as they were", async () => {
  const remote = await remoteRepo();
  const local = await cloneRepo(remote);
  const preUpdateCommit = (await $`git -C ${local} rev-parse HEAD`.text()).trim();
  await landHotfix(remote);
  patchByHand(local);
  writeFileSync(join(local, "notes.txt"), "mine, never landed\n");
  const scratch = scratchDir("ue-scratch-");
  const updater = updaterFor(local, loggingCmd(join(scratch, "steps.log"), "install"), loggingCmd(join(scratch, "steps.log"), "build"));

  const before = await updater.checkForUpdate();
  expect(before.localEditsLanded).toBe(false);
  expect(before.canApply).toBe(false);
  expect(before.reason).toBe("local changes must be committed or stashed before updating");
  await expect(updater.applyUpdate()).rejects.toThrow("Commit or stash local changes");
  expect((await $`git -C ${local} rev-parse HEAD`.text()).trim()).toBe(preUpdateCommit);
  expect(readFileSync(join(local, "notes.txt"), "utf8")).toBe("mine, never landed\n");
  expect(readFileSync(join(local, "hotfix.txt"), "utf8")).toBe("the fix\n");
}, REAL_GIT_TEST_MS);

// A mode is part of the edit: git tracks the executable bit only where the file system has one.
test.skipIf(process.platform === "win32")("a hand patch that also made a file executable is not the update's, so it blocks", async () => {
  const remote = await remoteRepo();
  const local = await cloneRepo(remote);
  await landHotfix(remote);
  patchByHand(local);
  chmodSync(join(local, "marker.txt"), 0o755);
  const scratch = scratchDir("ue-scratch-");
  const updater = updaterFor(local, loggingCmd(join(scratch, "steps.log"), "install"), loggingCmd(join(scratch, "steps.log"), "build"));

  const before = await updater.checkForUpdate();
  expect(before.localEditsLanded).toBe(false);
  expect(before.canApply).toBe(false);
  await expect(updater.applyUpdate()).rejects.toThrow("Commit or stash local changes");
}, REAL_GIT_TEST_MS);

test("an edit written after the check stops the update before the advance, and it is kept, unstaged", async () => {
  const remote = await remoteRepo();
  const local = await cloneRepo(remote);
  const preUpdateCommit = (await $`git -C ${local} rev-parse HEAD`.text()).trim();
  await landHotfix(remote);
  patchByHand(local);
  const scratch = scratchDir("ue-scratch-");
  const log = join(scratch, "steps.log");
  const updater = createUpdater({
    appRoot: local,
    serviceName: "testsvc",
    appLabel: "TestSvc",
    updateRepoEnvVar: "UE_TEST_UPDATE_REPO_UNUSED",
    installCmd: loggingCmd(log, "install"),
    buildCmd: loggingCmd(log, "build"),
    run: async (args, { cwd, env }) => {
      // The edit lands between the check and the staging, as a chat still writing would.
      if (args[0] === "git" && args.includes("add")) writeFileSync(join(local, "marker.txt"), "typed after the check\n");
      const p = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe", windowsHide: true });
      const [stdout, stderr, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      return { code, stdout, stderr, timedOut: false };
    },
  });

  await expect(updater.applyUpdate()).rejects.toThrow("A local edit changed after the update check");
  expect((await $`git -C ${local} rev-parse HEAD`.text()).trim()).toBe(preUpdateCommit);
  expect(readFileSync(join(local, "marker.txt"), "utf8")).toBe("typed after the check\n");
  expect(readFileSync(join(local, "hotfix.txt"), "utf8")).toBe("the fix\n");
  expect((await $`git -C ${local} diff --cached --name-only`.text()).trim()).toBe("");
  expect(existsSync(log)).toBe(false);
}, REAL_GIT_TEST_MS);

test("a failed build puts the edits the update had taken back as they were before it", async () => {
  const remote = await remoteRepo();
  const local = await cloneRepo(remote);
  const preUpdateCommit = (await $`git -C ${local} rev-parse HEAD`.text()).trim();
  await landHotfix(remote);
  patchByHand(local);
  const scratch = scratchDir("ue-scratch-");
  const log = join(scratch, "steps.log");
  const updater = updaterFor(
    local,
    loggingCmd(log, "install"),
    failsOnCallsCmd(log, "build", join(scratch, "build.count"), [1]),
  );

  await expect(updater.applyUpdate()).rejects.toThrow("boom; rolled back to the previous version");
  expect((await $`git -C ${local} rev-parse HEAD`.text()).trim()).toBe(preUpdateCommit);
  expect(readFileSync(join(local, "marker.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("0.2.0\n");
  expect(readFileSync(join(local, "hotfix.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("the fix\n");
  expect((await $`git -C ${local} diff --cached --name-only`.text()).trim()).toBe("");
  expect((await $`git -C ${local} stash list`.text()).trim()).toBe("");
  // Still the same hand patch, so the next check offers the update again.
  expect((await updater.checkForUpdate()).localEditsLanded).toBe(true);
}, REAL_GIT_TEST_MS);

// ── "newer" is not "applicable" ─────────────────────────────────────────────────────────────
// check used to advertise any non-ancestor remote commit as an applicable update. Two shapes
// made apply fail on every cycle: a checkout that had DIVERGED (pull --ff-only refuses it), and a
// local branch the remote does not have (check fell back to the remote's HEAD but apply pulled the
// local branch name). check now proves the fast-forward with a bounded fetch and carries the
// resolved remote branch through to apply.
