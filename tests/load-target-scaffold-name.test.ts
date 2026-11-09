// A folder with a dev script and no .devwebui is scaffolded as the one canonical `.devwebui` file,
// never `<name>.devwebui`. This pins the behaviour kept when the naming helper became a constant.
import "./isolate"; // data-dir isolation - must load before any server/src import
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveLoadTarget } from "../server/src/projects/load-target";

test("a folder with a dev script is scaffolded as .devwebui, never <name>.devwebui", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "devwebui-load-target-"));
  try {
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "demo-app", scripts: { dev: "vite" } }),
    );
    const target = await resolveLoadTarget(dir);
    expect(target.kind).toBe("scaffold");
    if (target.kind === "scaffold") expect(target.fileName).toBe(".devwebui");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
