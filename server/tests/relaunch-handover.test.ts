// The auto-update successor is handed its port, relaunch signal and resume list as argv FLAGS:
// WMI Win32_Process.Create (win32) does not carry an environment block. An env override on the
// relaunch spawn is therefore dead on Windows and misleads whoever reads the handover.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseDaemonArgs } from "../src/daemon-args";

test("the relaunch spawn sets no env overrides; port, relaunch and resume ride as flags", () => {
  const source = readFileSync(path.resolve(import.meta.dir, "../src/index.ts"), "utf8");
  const start = source.indexOf("const child = spawn(plan.argv[0]");
  expect(start).toBeGreaterThan(-1);
  const spawnCall = source.slice(start, source.indexOf("child.unref();", start));
  expect(spawnCall).not.toMatch(/DEVWEBUI_(PORT|RELAUNCH|RELAUNCH_RESUME|SAFE_MODE)\b/);
  expect(source).toMatch(/if \(resume\.length\) relaunchArgv\.push\("--resume"/);
});

test("the successor reads port, relaunch and resume from those flags", () => {
  expect(parseDaemonArgs(["--port", "4001", "--relaunch", "--resume", "a,b"])).toEqual({
    port: 4001,
    relaunch: true,
    resume: ["a", "b"],
  });
});
