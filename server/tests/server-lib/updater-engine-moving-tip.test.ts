import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { $ } from "bun";
import { createUpdater } from "../../src/updater-engine.mjs";
import {
  advanceRemote,
  cleanScratchDirs,
  cloneRepo,
  remoteRepo,
  runProcess,
} from "./updater-engine-fixture";

setDefaultTimeout(30_000);

afterEach(cleanScratchDirs);

test("a branch replacement during fetch cannot make an undownloaded update applicable", async () => {
  const remote = await remoteRepo();
  const local = await cloneRepo(remote);
  const base = (await $`git -C ${remote} rev-parse HEAD`.text()).trim();
  await advanceRemote(remote, "0.2.0");
  const advertised = (await $`git -C ${remote} rev-parse HEAD`.text()).trim();
  let replacement: string | undefined;
  const updater = createUpdater({
    appRoot: local,
    serviceName: "example",
    appLabel: "Example",
    updateRepoEnvVar: "UE_TEST_UPDATE_REPO_UNUSED",
    steps: [],
    run: async (args, options) => {
      if (args[1] === "fetch" && !replacement) {
        await $`git -C ${remote} reset --hard ${base}`.quiet();
        await advanceRemote(remote, "0.3.0");
        replacement = (await $`git -C ${remote} rev-parse HEAD`.text()).trim();
      }
      return runProcess(args, options);
    },
  });

  expect(await updater.checkForUpdate()).toMatchObject({
    remoteCommit: advertised,
    updateAvailable: true,
    canApply: false,
    diverged: false,
  });
  expect(replacement).toBeDefined();
  expect((await updater.applyUpdate()).ok).toBe(true);
  expect((await $`git -C ${local} rev-parse HEAD`.text()).trim()).toBe(replacement!);
});
