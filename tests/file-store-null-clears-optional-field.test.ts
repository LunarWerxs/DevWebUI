// JSON cannot carry `undefined`, so over HTTP the only way to clear an optional process field
// (port, waitForPort, compose...) is to send it as null. The update must clear it, not keep the
// stored value and not fail the schema.
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

test("an update that sends null for a stored optional field clears that field", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "devwebui-null-clear-"));
  scratchDirs.push(dir);
  const file = path.join(dir, ".devwebui");
  writeFileSync(
    file,
    JSON.stringify({
      name: "P",
      processes: [{ id: "web", name: "Web", command: "echo hi", port: 3000 }],
    }),
  );

  updateProcessInFile(file, "web", {
    id: "web",
    name: "Web",
    command: "echo hi",
    port: null,
  } as never);

  const proc = JSON.parse(readFileSync(file, "utf8")).processes[0];
  expect(proc.port).toBeUndefined();
  expect(proc.name).toBe("Web");
});
