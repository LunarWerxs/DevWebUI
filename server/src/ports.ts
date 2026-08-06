import net from "node:net";
import { spawn } from "node:child_process";
import treeKill from "tree-kill";
import type { PortOwner } from "../../shared/dto";
import { collectStdout } from "./spawn-capture";

export type { PortOwner };

/** Spawn a command, capture stdout, resolve on close (bounded by a short timeout). Port-owner
 *  output (cmdlines) is small, so this caps well below collectStdout's 1 MiB default. */
const collect = (cmd: string, args: string[], timeoutMs?: number) =>
  collectStdout(cmd, args, { maxBytes: 1 << 16, ...(timeoutMs ? { timeoutMs } : {}) });

/**
 * How long the WINDOWS owner probe may take, overriding collectStdout's 5s default.
 *
 * That default is fine for the unix path (`lsof`, `ps` — tiny static binaries) but is not enough
 * for this one, which starts a whole PowerShell and makes it autoload NetTCPIP and CimCmdlets. On a
 * warm developer machine the round trip is ~1.5s; on a cold or loaded one it goes past 5s, and
 * collectStdout RESOLVES WITH WHAT IT HAS on timeout rather than reporting one. So the probe came
 * back empty, portOwners returned [], and a port that was plainly occupied was reported as having
 * no owner — diagnose() then downgraded a port-in-use crash to "low confidence, cause unknown".
 * Reproduced continuously on windows-latest CI (both port tests landing at ~5010ms, i.e. exactly
 * the timeout) and red on main from 2026-08-03 until 2026-08-06.
 *
 * 20s because the failure mode is a WRONG ANSWER, not a slow one: this runs after a crash, or when
 * freeing a port the user asked to free, and in both cases waiting is strictly better than
 * confidently reporting nobody is there. Still bounded, so a genuinely wedged PowerShell can't hang
 * a diagnosis forever.
 */
const WIN_OWNER_PROBE_TIMEOUT_MS = 20_000;

// Field separator for the one-line-per-owner PowerShell/ps output below. "::" avoids both the
// PowerShell backtick-tab escape headaches in a JS template AND collisions with a Windows
// command line (which may contain plain colons, e.g. drive letters, but essentially never "::").
const FIELD_SEP = "::";

/** Who is listening on `port`? Returns each owning PID + name + best-effort cmdline/uptime. */
export async function portOwners(port: number): Promise<PortOwner[]> {
  if (process.platform === "win32") {
    // One CIM query gets CommandLine + CreationDate for every owning PID in a single round-trip
    // (rather than a Get-Process-per-PID follow-up). CommandLine/CreationDate can be null (e.g.
    // a protected/system process this user can't inspect) — "" downstream reads back as undefined.
    // Each command line's own newlines are collapsed so it can't smuggle in extra output lines.
    const ps =
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ` +
      `Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { ` +
      `$procId = $_; $p = Get-Process -Id $procId -ErrorAction SilentlyContinue; if ($p) { ` +
      `$ci = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue; ` +
      `$cmd = if ($ci -and $ci.CommandLine) { ($ci.CommandLine -replace '[\\r\\n]+', ' ') } else { "" }; ` +
      `$created = if ($ci -and $ci.CreationDate) { $ci.CreationDate.ToFileTimeUtc() } else { "" }; ` +
      `Write-Output "$($p.Id)${FIELD_SEP}$($p.ProcessName)${FIELD_SEP}$cmd${FIELD_SEP}$created" } }`;
    const out = await collect(
      "powershell",
      ["-NoProfile", "-Command", ps],
      WIN_OWNER_PROBE_TIMEOUT_MS,
    );
    return parseWinOwners(out);
  }
  const pidsOut = await collect("sh", ["-c", `lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null`]);
  const pids = [...new Set(pidsOut.split(/\s+/).map(Number).filter(Boolean))];
  if (!pids.length) return [];
  // `args=` (full command line) + `etime=` (elapsed wall time, [[DD-]HH:]MM:SS) — the `=` suffix
  // on each key suppresses ps's column header, but NOT the leading padding etime uses, so the
  // parse below trims/splits defensively rather than assuming fixed-width columns.
  const psOut = await collect("ps", ["-o", "pid=,etime=,args=", "-p", pids.join(",")]);
  return parseUnixOwners(psOut);
}

function parseWinOwners(out: string): PortOwner[] {
  const owners: PortOwner[] = [];
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const [pidStr, name, cmd, created] = line.split(FIELD_SEP);
    if (!pidStr || !/^\d+$/.test(pidStr)) continue;
    owners.push({
      pid: Number(pidStr),
      name: name?.trim() || pidStr,
      cmdline: cmd?.trim() || undefined,
      uptime: created ? formatUptime(fileTimeUtcToMs(created)) : undefined,
    });
  }
  return owners;
}

function parseUnixOwners(out: string): PortOwner[] {
  const owners: PortOwner[] = [];
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const [, pidStr, etime, args] = m;
    owners.push({
      pid: Number(pidStr),
      name: (args.split(/\s+/)[0]?.split(/[/\\]/).pop() ?? pidStr) || pidStr,
      cmdline: args.trim() || undefined,
      uptime: formatUnixEtime(etime),
    });
  }
  return owners;
}

/** Windows `FILETIME.ToFileTimeUtc()` (100ns ticks since 1601-01-01) → epoch milliseconds. */
function fileTimeUtcToMs(ticksStr: string): number | undefined {
  const ticks = Number(ticksStr);
  if (!Number.isFinite(ticks) || ticks <= 0) return undefined;
  const EPOCH_DIFF_MS = 11644473600000; // ms between 1601-01-01 and 1970-01-01
  return ticks / 10000 - EPOCH_DIFF_MS;
}

/** Human-readable "created at" → "Xh Ym" (or "Ym"/"Xd Yh") elapsed-since-now uptime string. */
function formatUptime(createdAtMs: number | undefined): string | undefined {
  if (createdAtMs === undefined) return undefined;
  const elapsedSec = Math.max(0, Math.floor((Date.now() - createdAtMs) / 1000));
  return formatElapsedSeconds(elapsedSec);
}

/** Parse `ps`'s `etime=` format ([[DD-]HH:]MM:SS) into the same "Xd Yh" / "Xh Ym" / "Ym" shape. */
function formatUnixEtime(etime: string): string | undefined {
  const m = etime.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return undefined;
  const [, days, hours, minutes, seconds] = m;
  const elapsedSec =
    (Number(days) || 0) * 86400 +
    (Number(hours) || 0) * 3600 +
    (Number(minutes) || 0) * 60 +
    (Number(seconds) || 0);
  return formatElapsedSeconds(elapsedSec);
}

function formatElapsedSeconds(elapsedSec: number): string {
  const days = Math.floor(elapsedSec / 86400);
  const hours = Math.floor((elapsedSec % 86400) / 3600);
  const minutes = Math.floor((elapsedSec % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Kill exactly these PIDs (and their child trees) — targeted, unlike freePort's port sweep. */
export function killPids(pids: number[]): Promise<void> {
  return Promise.all(
    pids.map(
      (pid) =>
        new Promise<void>((resolve) => {
          try {
            treeKill(pid, "SIGKILL", () => resolve());
          } catch {
            resolve();
          }
        }),
    ),
  ).then(() => undefined);
}

/**
 * Find a bindable port at or above `preferred`. The implementation was promoted
 * verbatim into the shared kit server-lib (synced in as ./find-free-port.mjs) so every
 * sibling daemon uses the identical race-free walk — re-exported here so every
 * existing `from "./ports"` import keeps resolving.
 */
export { findFreePort } from "./find-free-port.mjs";

/** True if something is already listening on the port (non-intrusive TCP probe). */
export function isPortListening(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (v: boolean) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(300);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
    try {
      sock.connect(port, host);
    } catch {
      done(false);
    }
  });
}

/** Kill whatever process is holding the given port (best-effort, cross-platform). */
export function freePort(port: number): Promise<void> {
  return new Promise((resolve) => {
    let cmd: string;
    let args: string[];
    if (process.platform === "win32") {
      cmd = "powershell";
      args = [
        "-NoProfile",
        "-Command",
        `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ` +
          `Select-Object -ExpandProperty OwningProcess -Unique | ` +
          `ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`,
      ];
    } else {
      cmd = "sh";
      args = ["-c", `lsof -ti tcp:${port} | xargs -r kill -9`];
    }
    try {
      const c = spawn(cmd, args, { windowsHide: true });
      c.on("close", () => resolve());
      c.on("error", () => resolve());
    } catch {
      resolve();
    }
  });
}
