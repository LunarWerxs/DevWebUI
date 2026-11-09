// The single-instance guard (index.ts) and the dev launcher (dev.ts) decide whether to SPAWN a
// daemon. instance-pointer.mjs says such callers must re-probe (attempts >= 2): one missed probe
// against a busy live daemon otherwise starts a second daemon that hops to PORT+1.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

test.each(["../src/index.ts", "../src/dev.ts"])(
  "%s probes for a live instance with attempts >= 2 before spawning",
  (rel) => {
    const source = readFileSync(path.resolve(import.meta.dir, rel), "utf8");
    expect(source).toMatch(/findLiveInstance\(\s*\d+\s*,\s*([2-9]|\d{2,})\s*\)/);
    expect(source).not.toMatch(/findLiveInstance\(\s*\)/);
  },
);
