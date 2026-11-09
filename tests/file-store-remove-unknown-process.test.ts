// Removing a process id that the project does not have must throw "not found" and leave the file
// as it was, as the star and update paths already do. A silent no-op hides a typo in the caller.
import "./isolate"; // CWD-proof data-dir isolation - must load before any server/src import
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeProcessFromFile } from "../server/src/projects/file-store";

const scratchDirs: string[] = [];
afterAll(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("removing an unknown process id throws and leaves the file unchanged", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "devwebui-remove-unknown-"));
  scratchDirs.push(dir);
  const file = path.join(dir, ".devwebui");
  const before = JSON.stringify({
    name: "P",
    processes: [
      { id: "web", name: "Web", command: "echo web" },
      { id: "api", name: "API", command: "echo api" },
    ],
  });
  writeFileSync(file, before);

  expect(() => removeProcessFromFile(file, "nope")).toThrow('Process "nope" not found.');
  expect(readFileSync(file, "utf8")).toBe(before);
});
