/** GitHub Releases updater for the compiled distribution; archives are the updater contract. */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import pkg from "../../package.json";
import type { UpdateApplyResult, UpdateStatus } from "../../shared/dto";
import { readSettings, writeSettings } from "./runtime";

const SERVICE = "devwebui" as const;
const REPO = "LunarWerxs/DevWebUI";
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;
// Studio's install-ping endpoint returns the SAME GitHub releases/latest JSON verbatim (it's a
// passthrough proxy), so hitting it here doubles as both the update check AND the one anonymous
// "an install exists" signal — no separate network call for the ping. See latestRelease() below.
const LATEST_API = "https://studio.connections.icu/v1/app/devwebui/latest";
const VERSION = pkg.version;

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface Release {
  tag_name: string;
  assets: ReleaseAsset[];
}

export function releaseTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const os = platform === "win32" ? "windows" : platform === "darwin" ? "macos" : "linux";
  return `${os}-${arch}`;
}

export function assetForPlatform(
  assets: ReleaseAsset[],
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ReleaseAsset | null {
  const extension = platform === "win32" ? ".zip" : ".tar.gz";
  const expected = `devwebui-${releaseTarget(platform, arch)}${extension}`;
  return assets.find((asset) => asset.name === expected) ?? null;
}

/** The release asset carrying the per-file SHA-256 manifest (published by .github/workflows/release.yml). */
export const CHECKSUM_ASSET = "SHA256SUMS.txt";

/**
 * Parse a `sha256sum`-style manifest into `{ filename: digest }`.
 * Lines look like `<64-hex>  devwebui-windows-x64.zip` (two spaces, or ` *` in binary mode).
 */
export function parseChecksums(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line.trim());
    if (m) out[m[2]] = m[1].toLowerCase();
  }
  return out;
}

export const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

function numericVersion(value: string): number[] {
  return value
    .replace(/^v/, "")
    .split(/[.+-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
}

export function isNewer(remote: string, local: string): boolean {
  const a = numericVersion(remote);
  const b = numericVersion(local);
  for (let i = 0; i < 3; i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

function baseStatus(overrides: Partial<UpdateStatus>): UpdateStatus {
  return {
    ok: true,
    service: SERVICE,
    currentVersion: VERSION,
    currentCommit: null,
    remoteCommit: null,
    branch: null,
    upstream: null,
    remote: RELEASES_PAGE,
    dirty: false,
    updateAvailable: false,
    canApply: false,
    checkedAt: Date.now(),
    reason: null,
    ...overrides,
  };
}

/** Coarse OS family for the ping's `os` query param — no version/build number, just windows/macos/linux. */
function pingOsTag(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "windows" : platform === "darwin" ? "macos" : "linux";
}

/**
 * True when the anonymous install ping should be suppressed. The underlying fetch still runs
 * either way (it's the real update check) — this only decides whether it carries identity.
 * DEVWEBUI_NO_PING is the documented opt-out; DEVWEBUI_PULSE_DISABLE / CONNECTIONS_PULSE_DISABLE
 * are honored too since the README already told users those turn telemetry off. Dev/test/CI runs
 * are never worth counting as an install: NODE_ENV=test covers `bun test`, CI covers GitHub
 * Actions, and DEVWEBUI_PORT_FIXED=1 is the flag `bun run dev` (server/src/dev.ts) already sets
 * on itself for an unrelated reason (pinning the daemon's port) — reused here rather than adding
 * a second dev-mode flag.
 */
function pingSuppressed(): boolean {
  return (
    process.env.DEVWEBUI_NO_PING === "1" ||
    process.env.DEVWEBUI_PULSE_DISABLE === "1" ||
    process.env.CONNECTIONS_PULSE_DISABLE === "1" ||
    process.env.NODE_ENV === "test" ||
    !!process.env.CI ||
    process.env.DEVWEBUI_PORT_FIXED === "1"
  );
}

/** Get (or lazily mint + persist) this install's anonymous ping id — reusing whatever the
 *  retired product-pulse attempt already generated (settings.json's pulseInstallId, itself
 *  migrated from an even older analyticsInstallId) so an existing install keeps counting as
 *  one install rather than minting a second id. */
function pingInstallId(): string {
  const existing = readSettings().pulseInstallId;
  if (existing) return existing;
  const fresh = randomUUID();
  writeSettings({ pulseInstallId: fresh });
  return fresh;
}

async function latestRelease(): Promise<Release> {
  const suppressed = pingSuppressed();
  const url = new URL(LATEST_API);
  let installId: string | null = null;
  if (!suppressed) {
    installId = pingInstallId();
    url.searchParams.set("v", VERSION);
    url.searchParams.set("os", pingOsTag());
    // First-ever successful ping for this install only — see the write-back below.
    if (!readSettings().pulseInstallReported) url.searchParams.set("new", "1");
  }
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": `${SERVICE}/${VERSION}`,
      ...(installId ? { "X-Install-Id": installId } : {}),
    },
    // Fire-and-forget contract: never let a stalled network hang the update check indefinitely.
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`GitHub Releases API returned HTTP ${response.status}`);
  const release = (await response.json()) as Release;
  // Persist "reported" only after a confirmed successful ping, so a failed/suppressed attempt
  // still sends &new=1 next time instead of silently under-counting the install.
  if (installId && !readSettings().pulseInstallReported)
    writeSettings({ pulseInstallReported: true });
  return release;
}

let cached: { status: UpdateStatus; at: number } | null = null;
const CACHE_MS = 5 * 60 * 1000;

export async function checkForUpdate(options: { fresh?: boolean } = {}): Promise<UpdateStatus> {
  if (!options.fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.status;
  try {
    const release = await latestRelease();
    const remoteVersion = release.tag_name?.replace(/^v/, "") ?? "";
    const available = !!remoteVersion && isNewer(remoteVersion, VERSION);
    const asset = available ? assetForPlatform(release.assets ?? []) : null;
    const status = baseStatus({
      remoteCommit: release.tag_name ?? null,
      updateAvailable: available,
      canApply: available && !!asset,
      reason:
        available && !asset
          ? `v${remoteVersion} is available, but its ${releaseTarget()} archive is missing.`
          : null,
    });
    cached = { status, at: Date.now() };
    return status;
  } catch (error) {
    return baseStatus({
      ok: false,
      reason: `couldn't check GitHub Releases (${error instanceof Error ? error.message : String(error)}).`,
    });
  }
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code ?? "null"}`)),
    );
  });
}

async function extract(archive: string, destination: string): Promise<void> {
  if (process.platform === "win32") {
    await run("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${destination.replaceAll("'", "''")}' -Force`,
    ]);
  } else {
    await run("tar", ["-xzf", archive, "-C", destination]);
  }
}

function verifyVersion(executable: string, expected: string): Promise<boolean> {
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn(executable, ["--version"], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 15_000);
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0 && stdout.trim().replace(/^v/, "") === expected.replace(/^v/, ""));
    });
  });
}

function moveInto(source: string, destination: string): void {
  try {
    renameSync(source, destination);
  } catch {
    cpSync(source, destination);
    rmSync(source, { force: true });
  }
}

function failure(message: string): UpdateApplyResult {
  return {
    ok: false,
    message,
    restartRequired: false,
    status: baseStatus({ ok: false, reason: message }),
    output: [],
  };
}

export async function applyUpdate(): Promise<UpdateApplyResult> {
  const status = await checkForUpdate({ fresh: true });
  if (!status.ok) return failure(status.reason ?? "update check failed");
  if (!status.updateAvailable) return failure("already up to date");
  const remoteVersion = (status.remoteCommit ?? "").replace(/^v/, "");

  let asset: ReleaseAsset | null = null;
  let checksumAsset: ReleaseAsset | null = null;
  try {
    const assets = (await latestRelease()).assets ?? [];
    asset = assetForPlatform(assets);
    checksumAsset = assets.find((a) => a.name === CHECKSUM_ASSET) ?? null;
  } catch {}
  if (!asset) return failure(`no ${releaseTarget()} archive is attached to v${remoteVersion}`);
  // The manifest is REQUIRED, not best-effort: without it there is nothing to check the
  // download against, and the alternative "verification" below (running the binary and
  // reading its --version) proves only that the payload can print a string. Every release
  // this updater can target publishes one (release.yml builds it with fail_on_unmatched_files),
  // so a missing manifest means something is wrong with the release, and refusing is correct.
  if (!checksumAsset)
    return failure(`v${remoteVersion} has no ${CHECKSUM_ASSET} to verify the download against`);

  const executable = process.execPath;
  const installDir = dirname(executable);
  const staging = join(installDir, ".update-staging");
  const oldExecutable = join(installDir, `${basename(executable)}.old-${status.checkedAt}`);
  const bundledName = process.platform === "win32" ? "devwebui.exe" : "devwebui";
  const output: string[] = [];
  let movedAside = false;

  try {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    const archive = join(staging, asset.name);
    output.push(`downloading ${asset.name} (${Math.round(asset.size / 1048576)} MB)`);
    const response = await fetch(asset.browser_download_url, {
      headers: { accept: "application/octet-stream", "user-agent": `${SERVICE}/${VERSION}` },
      redirect: "follow",
    });
    if (!response.ok) return failure(`download failed (HTTP ${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());

    // ---- verify BEFORE anything executes ----------------------------------------
    // Order matters. Everything past this point either unpacks or RUNS the payload, so
    // the integrity check has to come first: extracting an attacker-controlled archive
    // (zip-slip) or spawning it for a version banner is already game over. Fetch the
    // manifest, match this exact asset name, compare digests, and stop dead on mismatch.
    const sumsResponse = await fetch(checksumAsset.browser_download_url, {
      headers: { accept: "text/plain", "user-agent": `${SERVICE}/${VERSION}` },
      redirect: "follow",
    });
    if (!sumsResponse.ok)
      return failure(`couldn't fetch ${CHECKSUM_ASSET} (HTTP ${sumsResponse.status})`);
    const expected = parseChecksums(await sumsResponse.text())[asset.name];
    if (!expected) return failure(`${CHECKSUM_ASSET} has no entry for ${asset.name}`);
    const actual = sha256(bytes);
    if (actual !== expected)
      return failure(
        `the download does not match its published checksum — refusing to install (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`,
      );
    output.push(`verified sha256 ${actual.slice(0, 12)}…`);

    writeFileSync(archive, bytes);
    await extract(archive, staging);

    const candidate = join(staging, bundledName);
    if (!existsSync(candidate)) return failure(`the update archive has no ${bundledName}`);
    // Sanity check, NOT a security control (the checksum above is): catches a corrupt or
    // wrong-architecture build that would otherwise be installed and fail on next boot.
    if (!(await verifyVersion(candidate, remoteVersion))) {
      return failure("the downloaded executable failed its version self-check");
    }

    renameSync(executable, oldExecutable);
    movedAside = true;
    moveInto(candidate, executable);
    if (process.platform !== "win32") {
      try {
        await run("chmod", ["+x", executable]);
      } catch {}
    }
    rmSync(staging, { recursive: true, force: true });
    cached = null;
    output.push(`installed v${remoteVersion}`);
    return {
      ok: true,
      message: `Updated to v${remoteVersion}. Restarting…`,
      restartRequired: true,
      status: baseStatus({ currentVersion: remoteVersion }),
      output,
    };
  } catch (error) {
    if (movedAside && existsSync(oldExecutable)) {
      try {
        rmSync(executable, { force: true });
        renameSync(oldExecutable, executable);
      } catch {}
    }
    return failure(`update failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function cleanupStaleUpdateArtifacts(): void {
  try {
    const installDir = dirname(process.execPath);
    const executableName = basename(process.execPath);
    rmSync(join(installDir, ".update-staging"), { recursive: true, force: true });
    for (const name of readdirSync(installDir)) {
      if (name.startsWith(`${executableName}.old-`))
        rmSync(join(installDir, name), { force: true });
    }
  } catch {}
}
