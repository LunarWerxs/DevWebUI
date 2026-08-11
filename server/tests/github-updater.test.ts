import { expect, test } from "bun:test";
import {
  applyUpdate,
  assetForPlatform,
  CHECKSUM_ASSET,
  cleanupStaleUpdateArtifacts,
  isNewer,
  parseChecksums,
  releaseTarget,
  sha256,
} from "../src/github-updater";

const direct = {
  name: "devwebui-windows-x64.exe",
  browser_download_url: "https://example.test/direct",
  size: 100,
};
const archive = {
  name: "devwebui-windows-x64.zip",
  browser_download_url: "https://example.test/archive",
  size: 40,
};

test("compiled updater selects the Windows archive regardless of direct-exe upload order", () => {
  expect(assetForPlatform([direct, archive], "win32", "x64")).toEqual(archive);
  expect(assetForPlatform([archive, direct], "win32", "x64")).toEqual(archive);
});

test("compiled updater uses the public release target names", () => {
  expect(releaseTarget("win32", "x64")).toBe("windows-x64");
  expect(releaseTarget("darwin", "arm64")).toBe("macos-arm64");
  expect(releaseTarget("linux", "x64")).toBe("linux-x64");
});

test("release versions compare as numeric semver triples", () => {
  expect(isNewer("v0.6.1", "0.6.0")).toBe(true);
  expect(isNewer("0.6.0", "0.6.0")).toBe(false);
  expect(isNewer("0.5.9", "0.6.0")).toBe(false);
});

// ── parseChecksums / sha256 ──────────────────────────────────────────────────────────────────

test("parseChecksums parses a sha256sum-style manifest, tolerating a leading '*' and CRLF line endings", () => {
  const digestA = "a".repeat(64);
  const digestB = "b".repeat(64);
  const text = `${digestA}  devwebui-windows-x64.zip\r\n${digestB} *devwebui-linux-x64.tar.gz\n`;
  expect(parseChecksums(text)).toEqual({
    "devwebui-windows-x64.zip": digestA,
    "devwebui-linux-x64.tar.gz": digestB,
  });
});

test("parseChecksums lowercases uppercase hex digests and ignores blank/malformed lines", () => {
  const upper = "A".repeat(64);
  const text = `\nnot a checksum line\n${upper}  devwebui-macos-arm64.tar.gz\n   \n`;
  expect(parseChecksums(text)).toEqual({
    "devwebui-macos-arm64.tar.gz": upper.toLowerCase(),
  });
});

test("sha256 matches known SHA-256 test vectors", () => {
  // Pinned against the standard NIST test vectors, not re-derived through node:crypto directly —
  // the whole point is catching a regression in what sha256() computes, not confirming it agrees
  // with itself.
  expect(sha256(new TextEncoder().encode("abc"))).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  expect(sha256(new Uint8Array())).toBe(
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

// ── applyUpdate: refuses instead of installing ──────────────────────────────────────────────
//
// applyUpdate() reads process.execPath directly (no injection point) and, once it finds BOTH a
// platform asset and a checksum manifest in the release, creates `.update-staging` NEXT TO THE
// REAL BUN EXECUTABLE before it downloads anything — there is no way to unit-test the
// digest-mismatch refusal without that directory briefly existing on THIS machine. It never gets
// as far as renaming/replacing the real executable (the checksum check runs before that), and
// `cleanupStaleUpdateArtifacts()` (the same sweep the daemon runs on every boot) removes the
// staging dir afterward either way — see the `finally` blocks below.
const REMOTE_VERSION = "99.0.0"; // comfortably newer than this repo's pkg.version, whatever it is
const target = releaseTarget(); // this machine's own platform-arch — must match what applyUpdate resolves
const assetName = `devwebui-${target}${process.platform === "win32" ? ".zip" : ".tar.gz"}`;

function stubFetchJson(handlers: Record<string, () => Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [match, respond] of Object.entries(handlers)) {
      if (url.includes(match)) return respond();
    }
    throw new Error(`unstubbed fetch in test: ${url}`);
  }) as typeof fetch;
}

test("applyUpdate refuses when the release has no SHA256SUMS.txt manifest", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubFetchJson({
    "/v1/app/devwebui/latest": () =>
      new Response(
        JSON.stringify({
          tag_name: `v${REMOTE_VERSION}`,
          assets: [
            { name: assetName, browser_download_url: "https://example.test/asset", size: 123 },
            // deliberately no CHECKSUM_ASSET entry
          ],
        }),
        { status: 200 },
      ),
  });
  try {
    const result = await applyUpdate();
    expect(result.ok).toBe(false);
    expect(result.message).toContain(CHECKSUM_ASSET);
    expect(result.message).toContain("to verify the download against");
    expect(result.restartRequired).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("applyUpdate refuses when the downloaded bytes don't match the published checksum", async () => {
  const originalFetch = globalThis.fetch;
  const fakeBytes = new TextEncoder().encode("not-the-real-binary");
  const wrongDigest = "0".repeat(64); // guaranteed not to equal sha256(fakeBytes)
  globalThis.fetch = stubFetchJson({
    "/v1/app/devwebui/latest": () =>
      new Response(
        JSON.stringify({
          tag_name: `v${REMOTE_VERSION}`,
          assets: [
            { name: assetName, browser_download_url: "https://example.test/asset", size: 123 },
            {
              name: CHECKSUM_ASSET,
              browser_download_url: "https://example.test/sums",
              size: 10,
            },
          ],
        }),
        { status: 200 },
      ),
    "https://example.test/asset": () => new Response(fakeBytes, { status: 200 }),
    "https://example.test/sums": () =>
      new Response(`${wrongDigest}  ${assetName}\n`, { status: 200 }),
  });
  try {
    const result = await applyUpdate();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("does not match its published checksum");
    expect(result.restartRequired).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
    cleanupStaleUpdateArtifacts();
  }
});
