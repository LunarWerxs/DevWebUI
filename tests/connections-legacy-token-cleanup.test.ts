// The legacy plaintext refreshToken must be removed from connections.json even when an SDK token entry
// already exists (a partial migration or a hand-edit). The old code deleted it only inside the
// one-time migration branch, which that case skips, so the plaintext secret stayed on disk.
import "./isolate"; // data-dir isolation - must load before any server/src import
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { initConnections, TOKEN_KEY } from "../server/src/connections";
import { dataDir } from "../server/src/data-dir";

test("initConnections drops a plaintext legacy refreshToken even when an SDK token is already stored", () => {
  mkdirSync(dataDir(), { recursive: true });
  const file = path.join(dataDir(), "connections.json");
  writeFileSync(
    file,
    JSON.stringify({
      refreshToken: "legacy-plaintext-secret",
      sdk: { [TOKEN_KEY]: "already-stored" },
    }),
  );
  initConnections();
  const saved = JSON.parse(readFileSync(file, "utf8"));
  expect(saved.refreshToken).toBeUndefined();
  expect(saved.sdk[TOKEN_KEY]).toBe("already-stored");
});
