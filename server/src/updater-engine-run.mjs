/**
 * The self-update engine's command runner (part of updater-engine.mjs, synced with it): every git,
 * install and build step goes through `runCommand`, and its transcript line and failure reason are
 * written here, so the check, the advance and the rollback read a step the same way.
 */

import { spawn } from "node:child_process";

export const CHECK_TIMEOUT_MS = 30_000;
export const APPLY_TIMEOUT_MS = 120_000;
export const BUILD_TIMEOUT_MS = 240_000;

const GIT_ENV = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0" });

/**
 * The runner for one checkout. `run` (optional) is the app's own runner; without one the engine spawns.
 *
 * On Windows, package-manager launchers (npm/yarn/pnpm) are `.cmd` shims that CreateProcess
 * can't execute directly, so a bare spawn throws ENOENT, while git/node/bun are real `.exe`
 * and resolve fine. So spawn raw first (git/bun keep their exact behavior and no shell-escaping
 * deprecation fires) and retry once through a shell only when the raw spawn ENOENTs on Windows,
 * which is exactly the `.cmd`-shim case. Every arg here is a fixed literal or a git URL (no
 * spaces or shell metacharacters), so the shell's arg concatenation is safe.
 */
export function createRunner({ appRoot, run = null }) {
  function runCommand(args, timeoutMs, cwd = appRoot) {
    if (run) return runThrough(args, timeoutMs, cwd);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (r) => {
        if (!settled) {
          settled = true;
          resolve(r);
        }
      };
      const attempt = (useShell) => spawnAttempt(args, timeoutMs, cwd, useShell, finish, () => attempt(true));
      attempt(false);
    });
  }

  // The app's own runner (`run`): the same argv, root, environment and deadline, its answer read
  // the way the spawn below reads a child. One that throws is a failed step, never an unhandled one.
  async function runThrough(args, timeoutMs, cwd) {
    try {
      const r = await run(args, { cwd, env: GIT_ENV(), timeoutMs });
      return { ok: r.code === 0 && !r.timedOut, code: r.code, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut };
    } catch (err) {
      return { ok: false, code: null, stdout: "", stderr: err?.message ?? String(err), timedOut: false };
    }
  }

  const git = (args, timeoutMs = CHECK_TIMEOUT_MS) => runCommand(["git", ...args], timeoutMs);
  async function gitText(args, timeoutMs = CHECK_TIMEOUT_MS) {
    const r = await git(args, timeoutMs);
    return r.ok ? r.stdout.trim() : null;
  }

  return { runCommand, git, gitText };
}

// One spawn of `args`. `retryInShell` runs when a raw Windows spawn ENOENTs (a `.cmd` shim); this
// attempt's own trailing `close` is then ignored.
function spawnAttempt(args, timeoutMs, cwd, useShell, finish, retryInShell) {
  const child = spawn(args[0], args.slice(1), { cwd, windowsHide: true, shell: useShell, env: GIT_ENV() });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let superseded = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  child.on("error", (err) => {
    clearTimeout(timer);
    // `error` fires before this attempt's `close`; flag it so that trailing `close`
    // is ignored while we retry the `.cmd` shim through a shell.
    if (err.code === "ENOENT" && !useShell && process.platform === "win32") {
      superseded = true;
      retryInShell();
      return;
    }
    finish({ ok: false, code: null, stdout, stderr: stderr || err.message, timedOut });
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    if (superseded) return;
    finish({ ok: code === 0 && !timedOut, code, stdout, stderr, timedOut });
  });
}

/** Runs `step` on each item, one after the other, and resolves to their results in order: each async fs
 *  call in flight holds a Bun I/O thread that is never given back, so no list is fanned out. */
export function oneAtATime(items, step) {
  const results = [];
  return items
    .reduce((done, item) => done.then(() => step(item)).then((result) => void results.push(result)), Promise.resolve())
    .then(() => results);
}

/** The transcript line of one step: the command, where it ran, and its output (or how it ended). */
export function commandSummary(args, result, where = "") {
  const text = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n").trim();
  const suffix = result.timedOut ? "timed out" : result.ok ? "ok" : `exit ${result.code ?? "unknown"}`;
  return `$ ${args.join(" ")}${where ? ` (in ${where})` : ""}\n${text || suffix}`;
}

/** Lines that name a failure, so the excerpt below can prefer them over surrounding noise. */
const ERRORISH =
  /\berror\b|\bfailed\b|\bfailure\b|cannot |can't |could not |not found|unable to|unresolved|does the file exist|ENOENT|EACCES|✗|✘/i;
const STEP_ERROR_LINES = 4;
const STEP_ERROR_CHARS = 400;

/**
 * The user-facing reason a step failed.
 *
 * Taking `stderr.split("\n")[0]` looked right and was not: a `bun run <script>` failure begins by
 * ECHOING the script it is about to run, so the dashboard showed people the command
 * (`$ node scripts/i18n-check.mjs && vue-tsc -b && …`) and threw away the line that mattered
 * (`Failed to resolve import "./button-variants"`), which is several lines further down. The full
 * transcript is not a fallback either: `output` is only returned on the SUCCESS path, so on a
 * failure this message is the only thing the user ever sees. (RepoYeti issue #24.)
 *
 * So: drop echoed commands and blank lines, prefer the lines that actually name a failure, and
 * cap the result — this lands in a toast description, and an unbounded build log is not readable
 * there. The command itself is not lost: `commandSummary` already recorded it in `output`.
 */
export function stepFailureMessage(args, result) {
  const lines = `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("$ "));
  const errorish = lines.filter((line) => ERRORISH.test(line));
  const picked = (errorish.length ? errorish : lines).slice(0, STEP_ERROR_LINES);
  const msg = picked.join(" · ");
  if (!msg) return result.timedOut ? `${args[0]} timed out` : `${args[0]} failed`;
  return msg.length > STEP_ERROR_CHARS ? `${msg.slice(0, STEP_ERROR_CHARS - 1)}…` : msg;
}

/** Runs one recorded step; a failed one throws its reason. */
export async function runStep(runCommand, args, timeoutMs, output, cwd, where = "") {
  const result = await runCommand(args, timeoutMs, cwd);
  output.push(commandSummary(args, result, where));
  if (!result.ok) throw new Error(stepFailureMessage(args, result));
}

/** The install and build steps in order, each recorded; they run one after another, since a build reads what the
 *  install wrote. Stops at the first that fails and answers it ({ step, result }), or null when every one passed. */
export async function runDueSteps(runCommand, due, output) {
  let failed = null;
  for (const step of due) {
    const result = await runCommand(step.cmd, BUILD_TIMEOUT_MS, step.cwd);
    output.push(commandSummary(step.cmd, result, step.dir));
    if (!result.ok) {
      failed = { step, result };
      break;
    }
  }
  return failed;
}
