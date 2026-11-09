// Rules reloaded from alerts-rules.json get the same clamps as rules created through the API. The
// clamps used to run only on create/update, so a hand-edited or older file with a missing, negative
// or huge forMs or threshold reached the evaluator unclamped (a missing forMs compares as NaN and
// fires on the first over-threshold sample).
import "./isolate"; // data-dir isolation - must load before any server/src import
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AlertStore } from "../server/src/alerts";
import { dataDir } from "../server/src/data-dir";

test("a rule loaded from disk is clamped and defaulted the same way as a newly created one", () => {
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(
    path.join(dataDir(), "alerts-rules.json"),
    JSON.stringify({
      rules: [
        { id: "no-for", processId: "p1", metric: "cpu", threshold: 50 },
        { id: "bad", processId: "p1", metric: "cpu", threshold: -5, forMs: -1, enabled: true },
        {
          id: "huge",
          processId: "p1",
          metric: "memory",
          threshold: 10,
          forMs: 1e12,
          enabled: true,
        },
      ],
    }),
  );
  const byId = new Map(new AlertStore().listRules().map((r) => [r.id, r]));
  expect(byId.get("no-for")).toMatchObject({ forMs: 0, enabled: true });
  expect(byId.get("bad")).toMatchObject({ threshold: 0, forMs: 0 });
  expect(byId.get("huge")?.forMs).toBe(24 * 60 * 60 * 1000);
});
