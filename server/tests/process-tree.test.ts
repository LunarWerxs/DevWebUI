// One owner for the tree-kill rule. Stops, force-kills and the picker/clone cleanup must all go
// through server/src/process-tree.ts; a direct tree-kill import elsewhere is a second copy of the rule.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { killTree } from "../src/process-tree";

test("killTree signals the process and reports completion through its callback", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  const pid = child.pid;
  expect(typeof pid).toBe("number");
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const killed = new Promise<unknown>((resolve) => {
    killTree(pid as number, "SIGKILL", (err) => resolve(err ?? null));
  });
  expect(await killed).toBeNull();
  await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error("child not killed")), 10_000)),
  ]);
}, 20_000);

test("no module outside the owner imports tree-kill directly", () => {
  const files = [
    "../src/manager/lifecycle.ts",
    "../src/manager/base.ts",
    "../src/ports.ts",
    "../src/projects/native-dialogs.ts",
  ];
  for (const rel of files) {
    const source = readFileSync(path.resolve(import.meta.dir, rel), "utf8");
    expect(source, rel).not.toMatch(/from\s+["']tree-kill["']/);
  }
});
