// Renaming a process id must follow every sibling reference to it. A sibling's string waitForPort
// names a sibling process id, just as its links do, so it has to follow the rename too.
import "./isolate"; // CWD-proof data-dir isolation - must load before any server/src import
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { updateProcessInFile } from "../server/src/projects/file-store";

const scratchDirs: string[] = [];
afterAll(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("renaming a process rewrites a sibling's string waitForPort to the new id", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "devwebui-rename-wait-"));
  scratchDirs.push(dir);
  const file = path.join(dir, ".devwebui");
  writeFileSync(
    file,
    JSON.stringify({
      name: "P",
      processes: [
        { id: "web", name: "Web", command: "echo web" },
        { id: "api", name: "API", command: "echo api", waitForPort: "web" },
      ],
    }),
  );

  updateProcessInFile(file, "web", { id: "site", name: "Web", command: "echo web" });

  const api = JSON.parse(readFileSync(file, "utf8")).processes.find(
    (p: { id: string }) => p.id === "api",
  );
  expect(api.waitForPort).toBe("site");
});
