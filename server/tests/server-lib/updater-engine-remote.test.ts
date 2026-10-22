// Tests for the self-update engine's remote: a diverged checkout, the branch it follows, the cooldown (SHARED LunarWerx server-lib, source of truth: lunarwerx-ui/src/server-lib/updater-engine-remote.test.ts,
// synced by sync.mjs into each app's `serverTests` dir under a `server-lib/` subdir next to the app's server
// tree; the `../../src/updater-engine.mjs` import resolves only there). Scratch repos and steps:
// updater-engine-fixture.ts.
import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { createUpdater } from "../../src/updater-engine.mjs";
import { advanceRemote, cleanScratchDirs, cloneRepo, loggingCmd, REAL_GIT_TEST_MS, remoteRepo, scratchDir, updaterFor } from "./updater-engine-fixture.ts";

// 30s: the hook deletes every scratch git repo the file made (I/O time, not assertion time); see the fixture.
afterEach(cleanScratchDirs, 30_000);

test("a diverged checkout is reported as an update that cannot fast-forward, and apply refuses it", async () => {
  const remote = await remoteRepo();
  const local = await cloneRepo(remote);
  const logPath = join(scratchDir("ue-log-"), "log.txt");
  // Local work the remote does not have...
  writeFileSync(join(local, "local.txt"), "mine\n");
  await $`git -C ${local} add -A`.quiet();
  await $`git -C ${local} commit -q -m local`.quiet();
  const headBefore = (await $`git -C ${local} rev-parse HEAD`.text()).trim();
  // ...and remote work the local does not have.
  await advanceRemote(remote, "0.2.0");

  const updater = updaterFor(local, loggingCmd(logPath, "install"), loggingCmd(logPath, "build"));
  const status = await updater.checkForUpdate();
  expect(status.updateAvailable).toBe(true);
  expect(status.canApply).toBe(false);
  expect(status.diverged).toBe(true);
  expect(status.reason).toContain("diverged");

  await expect(updater.applyUpdate()).rejects.toThrow(/diverged/);
  expect((await $`git -C ${local} rev-parse HEAD`.text()).trim()).toBe(headBefore);
  expect(existsSync(logPath)).toBe(false); // install/build never ran
  // real git — same widened timeout every spawning test in this file carries. ⛔ These last two
  // tests shipped without it (2026-09-11): the kit has no repo-wide `bun test --timeout`, so the
  // omission was invisible here and turned DevWebUI's "subprocess tests must set an explicit
  // timeout" guardrail red the moment a sync carried them downstream. The kit is less strict than
  // its consumers, and that asymmetry is exactly what sync.mjs warns about.
}, REAL_GIT_TEST_MS);

test("a local branch with no remote counterpart follows the remote's HEAD branch, and apply pulls THAT branch", async () => {
  const remote = await remoteRepo();
  const local = await cloneRepo(remote);
  const logPath = join(scratchDir("ue-log-"), "log.txt");
  await $`git -C ${local} checkout -q -b feature`.quiet(); // no upstream, and no `feature` on the remote
  await advanceRemote(remote, "0.3.0");
  const remoteHead = (await $`git -C ${remote} rev-parse HEAD`.text()).trim();

  const updater = updaterFor(local, loggingCmd(logPath, "install"), loggingCmd(logPath, "build"));
  const status = await updater.checkForUpdate();
  expect(status.remoteBranch).toBe("main");
  expect(status.updateAvailable).toBe(true);
  expect(status.canApply).toBe(true);

  const result = await updater.applyUpdate();
  expect(result.ok).toBe(true);
  expect((await $`git -C ${local} rev-parse HEAD`.text()).trim()).toBe(remoteHead);
  // Line endings normalised: a Windows clone with core.autocrlf checks the marker out as CRLF.
  expect(readFileSync(join(local, "marker.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("0.3.0\n");
}, REAL_GIT_TEST_MS); // real git+install+build - see the note on the test above.

// Update cooldown: a commit younger than cooldownDays must never be adopted, even when it is the
// tip; the update lands on the newest first-parent commit that is old enough, and once there the
// young tip is reported as held back rather than offered.
test("cooldownDays adopts the newest aged commit and holds back a younger tip", async () => {
  const remote = await remoteRepo();
  const local = await cloneRepo(remote);
  const logPath = join(scratchDir("ue-log-"), "log.txt");
  const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
  writeFileSync(join(remote, "marker.txt"), "0.2.0\n");
  await $`git -C ${remote} -c user.name=S -c user.email=s@s.io commit -q -am aged`
    .env({ ...process.env, GIT_AUTHOR_DATE: tenDaysAgo, GIT_COMMITTER_DATE: tenDaysAgo })
    .quiet();
  const agedCommit = (await $`git -C ${remote} rev-parse HEAD`.text()).trim();
  await advanceRemote(remote, "0.3.0"); // committed now: inside the cooldown
  const tip = (await $`git -C ${remote} rev-parse HEAD`.text()).trim();

  const updater = createUpdater({
    appRoot: local,
    serviceName: "testsvc",
    appLabel: "TestSvc",
    updateRepoEnvVar: "UE_TEST_UPDATE_REPO_UNUSED",
    installCmd: loggingCmd(logPath, "install"),
    buildCmd: loggingCmd(logPath, "build"),
    cooldownDays: 7,
  });
  const before = await updater.checkForUpdate();
  expect(before.updateAvailable).toBe(true);
  expect(before.canApply).toBe(true);
  expect(before.remoteCommit).toBe(agedCommit);
  expect(before.latestRemoteCommit).toBe(tip);

  const result = await updater.applyUpdate();
  expect(result.ok).toBe(true);
  expect((await $`git -C ${local} rev-parse HEAD`.text()).trim()).toBe(agedCommit);
  expect(readFileSync(join(local, "marker.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("0.2.0\n");

  const after = await updater.checkForUpdate();
  expect(after.updateAvailable).toBe(false);
  expect(after.reason).toContain("7-day update cooldown");
}, REAL_GIT_TEST_MS); // real git+install+build - see the note on the tests above.
