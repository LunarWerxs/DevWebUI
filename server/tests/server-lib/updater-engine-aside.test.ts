// Tests for the self-update engine on Windows: running programs moved aside before the advance (SHARED LunarWerx server-lib, source of truth: lunarwerx-ui/src/server-lib/updater-engine-aside.test.ts,
// synced by sync.mjs into each app's `serverTests` dir under a `server-lib/` subdir next to the app's server
// tree; the `../../src/updater-engine.mjs` import resolves only there). Scratch repos and steps:
// updater-engine-fixture.ts.
import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { advanceRemote, cleanScratchDirs, cloneRepo, loggingCmd, REAL_GIT_TEST_MS, remoteRepo, scratchDir, updaterFor } from "./updater-engine-fixture.ts";

// 30s: the hook deletes every scratch git repo the file made (I/O time, not assertion time); see the fixture.
afterEach(cleanScratchDirs, 30_000);

// Windows locks a running program's image against overwrite, so a fast-forward that replaces it
// fails with "unable to unlink old" partway through the checkout. It can still rename that file,
// and the process keeps running from the renamed copy, so the engine moves it aside before advancing.
const SYSTEM32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");

/** A remote whose bin/tool.exe is PING.EXE, and a clone of it. */
async function programRepo(): Promise<{ remote: string; local: string }> {
  const remote = await remoteRepo();
  mkdirSync(join(remote, "bin"));
  copyFileSync(join(SYSTEM32, "PING.EXE"), join(remote, "bin", "tool.exe"));
  await $`git -C ${remote} -c user.name=S -c user.email=s@s.io add -A`.quiet();
  await $`git -C ${remote} -c user.name=S -c user.email=s@s.io commit -q -m tool`.quiet();
  return { remote, local: await cloneRepo(remote) };
}

/** The remote replaces bin/tool.exe with a different program, plus the usual version bump. */
async function replaceProgram(remote: string, version: string): Promise<void> {
  copyFileSync(join(SYSTEM32, "WHERE.EXE"), join(remote, "bin", "tool.exe"));
  await advanceRemote(remote, version);
}

/** Runs the clone's bin/tool.exe, holding its image open until `stop` is awaited. */
function holdProgram(local: string): { stop: () => Promise<void> } {
  const running = spawn(join(local, "bin", "tool.exe"), ["-n", "60", "127.0.0.1"], {
    stdio: "ignore",
    windowsHide: true,
  });
  const exited = new Promise((resolve) => running.once("exit", resolve));
  return {
    stop: async () => {
      running.kill();
      await exited;
    },
  };
}

async function expectAtRemoteHead(local: string, remote: string): Promise<void> {
  const head = (await $`git -C ${local} rev-parse HEAD`.text()).trim();
  const remoteHead = (await $`git -C ${remote} rev-parse HEAD`.text()).trim();
  expect(head).toBe(remoteHead);
  expect(readFileSync(join(local, "bin", "tool.exe")).equals(readFileSync(join(SYSTEM32, "WHERE.EXE")))).toBe(true);
  expect((await $`git -C ${local} status --porcelain`.text()).trim()).toBe("");
}

test.skipIf(process.platform !== "win32")(
  "an update that replaces a running program file applies: the old copy is moved aside and the tree stays clean",
  async () => {
    const { remote, local } = await programRepo();
    const program = holdProgram(local);
    try {
      await replaceProgram(remote, "0.2.0");
      const log = join(scratchDir("ue-scratch-"), "steps.log");
      const updater = updaterFor(local, loggingCmd(log, "install"), loggingCmd(log, "build"));

      expect((await updater.applyUpdate()).ok).toBe(true);
      await expectAtRemoteHead(local, remote);
    } finally {
      await program.stop();
    }
  },
  REAL_GIT_TEST_MS,
);

// An app that names `asideDir` gets the running program's old copy moved there, outside the work
// tree, instead of beside the program; the next apply deletes copies whose program has exited, and
// nothing else in the folder.
test.skipIf(process.platform !== "win32")(
  "with asideDir, a running program's old copy goes to that folder, not beside it, and the next apply sweeps only its copies",
  async () => {
    const { remote, local } = await programRepo();
    const aside = join(scratchDir("ue-aside-"), "update-aside");
    const log = join(scratchDir("ue-scratch-"), "steps.log");
    const updater = updaterFor(local, loggingCmd(log, "install"), loggingCmd(log, "build"), aside);
    const program = holdProgram(local);
    try {
      await replaceProgram(remote, "0.2.0");
      const result = await updater.applyUpdate();
      expect(result.ok).toBe(true);
      await expectAtRemoteHead(local, remote);
      expect(readdirSync(join(local, "bin"))).toEqual(["tool.exe"]);
      expect(readdirSync(aside)).toHaveLength(1);
      expect(readdirSync(aside)[0]).toStartWith("bin%2Ftool.exe.replaced-");
    } finally {
      await program.stop();
    }

    writeFileSync(join(aside, "keep.txt"), "not the updater's\n");
    await advanceRemote(remote, "0.3.0");
    expect((await updater.applyUpdate()).ok).toBe(true);
    expect(readdirSync(aside)).toEqual(["keep.txt"]);
  },
  REAL_GIT_TEST_MS,
);

// Without an aside folder a failed move is recorded and the advance goes ahead; with one, the app
// asked for a clean tree, so the update stops before anything changes.
test.skipIf(process.platform !== "win32")(
  "with asideDir, a program that cannot be moved aside refuses the update and leaves HEAD where it was",
  async () => {
    const { remote, local } = await programRepo();
    const before = (await $`git -C ${local} rev-parse HEAD`.text()).trim();
    // A folder that cannot be made: its parent is a file.
    const blocker = join(scratchDir("ue-aside-"), "not-a-folder");
    writeFileSync(blocker, "");
    const log = join(scratchDir("ue-scratch-"), "steps.log");
    const updater = updaterFor(local, loggingCmd(log, "install"), loggingCmd(log, "build"), join(blocker, "update-aside"));

    await replaceProgram(remote, "0.2.0");
    const message = await updater.applyUpdate().then(
      () => "applyUpdate unexpectedly succeeded",
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    expect(message).toContain("could not move bin/tool.exe aside, so nothing was updated");
    expect((await $`git -C ${local} rev-parse HEAD`.text()).trim()).toBe(before);
    expect(readFileSync(join(local, "bin", "tool.exe")).equals(readFileSync(join(SYSTEM32, "PING.EXE")))).toBe(true);
    expect(existsSync(log)).toBe(false);
  },
  REAL_GIT_TEST_MS,
);
