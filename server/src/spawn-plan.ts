// ---------------------------------------------------------------------------
// How to spawn a managed dev server: directly, or through the OS shell.
//
// WHY THIS EXISTS. Every managed server used to be spawned with Node's
// `shell: true`, which on Windows is literally `cmd.exe /d /s /c "<command>"`.
// That wraps EVERY running server in a persistent `cmd.exe` process that shows
// up in Task Manager as its parent — start 25 servers and Task Manager fills
// with 25 `cmd.exe` (+ their conhost) entries that ran nothing but a hand-off.
// (See .claude/notes/2026-07-18… for the full process-tree anatomy.)
//
// The earlier working note warned "shell: true is LOAD-BEARING — do not flatten
// it", and it was RIGHT about the hazards: a managed command is a free-form
// STRING (`node ../../vite.js --host 0.0.0.0 --port 4173`, or `npm run dev`, or
// `A && B`), and naively splitting any string into argv breaks on Windows for
//   · shell operators (`&&`, `||`, `|`, `>`, …)
//   · `%VAR%` expansion
//   · `.cmd` / `.bat` shims (`npm.cmd`, `vite.cmd`) — CreateProcess CANNOT run
//     a batch file directly; only cmd.exe can
//   · CommandLineToArgvW quoting rules (not naive whitespace splitting)
//
// So this module does NOT flatten everything. It flattens ONLY the provably-safe
// subset: a command that tokenizes cleanly (no unquoted shell metacharacters, no
// broken quoting) AND whose first token resolves to a real, directly-launchable
// executable (`.exe`/`.com` on Windows; an executable file on POSIX). For that
// subset, running the command directly is byte-for-byte equivalent to handing it
// to the shell — there is nothing for the shell to interpret — so we skip the
// wrapper. Everything else (operators, `%VAR%`, `.cmd`/`.bat` shims, odd quoting)
// falls back to the exact old `shell: true` behaviour. `bun …` and `node …`
// commands — which is what Bun/Node dev servers are — take the direct path and
// lose their cmd.exe wrapper; `npm run dev` keeps it.
//
// The two real hazards of the old deep chain stay handled by the caller, and are
// UNAFFECTED by going direct: stops still use `tree-kill` (walks the child's
// subtree, and the child IS the real server now), and metrics still walk the
// descendant tree from the spawned pid. `windowsHide` is still passed on both
// paths, so no console window ever appears.
//
// Pure + platform-injectable so the decision is locked by unit tests
// (tests/spawn-plan.test.ts). The filesystem/PATH probe is the only impurity and
// it only ever downgrades to the safe shell path on any doubt.
// ---------------------------------------------------------------------------
import { statSync } from "node:fs";
import path from "node:path";

/** What {@link planManagedSpawn} decided: run the command directly, or via the shell. */
export type SpawnPlan =
  | { shell: true; command: string }
  | { shell: false; file: string; args: string[] };

// cmd.exe metacharacters — operators, grouping, `%VAR%`/`!delayed!` expansion. Any of
// these OUTSIDE double quotes means the string needs cmd.exe to interpret it. Backslash is
// NOT here: on Windows it is the path separator, not an escape.
export const WIN_META = new Set("&|<>^()%!".split(""));
// /bin/sh metacharacters + expansion + globbing + escaping we deliberately do not emulate.
// (Double quote is absent because the tokenizer consumes it; single quote IS here — we only
// group on double quotes, so a single-quoted command is left for the shell.)
export const POSIX_META = new Set("&|;<>()$`*?~#\\'".split(""));

// Extensions Windows' CreateProcess can launch WITHOUT a shell. `.cmd`/`.bat` are
// intentionally absent: they are batch scripts that only cmd.exe can run, which is exactly
// why npm/pnpm/yarn/vite shims must stay on the shell path.
const WIN_DIRECT_EXTS = [".exe", ".com"];

/**
 * Split a command line into argv, or return null if it must go to a real shell.
 *
 * Follows the CommandLineToArgvW backslash/quote rules — the same ones a directly-spawned
 * Windows program parses its own command line with — so an embedded escaped quote
 * (`node -e "require(\"net\")…"`, a common dev-command shape) round-trips exactly instead of
 * mangling into garbage argv. A run of N backslashes is literal UNLESS it immediately precedes
 * a `"`: then N/2 backslashes are emitted and an odd one escapes the quote (literal `"`, no
 * grouping toggle); an even run lets the `"` toggle grouping. Backslashes not before a quote
 * stay literal, which is what keeps Windows path separators (`..\node_modules\…`) intact.
 *
 * Returns null — deferring to the shell — on any unquoted shell metacharacter or an unbalanced
 * quote, rather than guessing. On POSIX, backslash is itself a metacharacter (see POSIX_META),
 * so a POSIX command containing one takes the shell path and never reaches the escape logic.
 */
/** Consume a run of backslashes at `i` (Windows rules) and resolve it against a following quote.
 *  Returns the index just past the run (plus the escaped quote, if any) and the literal text to emit. */
function consumeBackslashRun(command: string, i: number): { i: number; text: string } {
  let n = 0;
  while (command[i] === "\\") {
    n++;
    i++;
  }
  if (command[i] === '"') {
    let text = "\\".repeat(n >> 1); // each PAIR before a quote → one literal backslash
    if (n % 2 === 1) {
      text += '"'; // odd → the trailing backslash escapes the quote → literal "
      i++;
    }
    // even → backslashes emitted; the quote itself is handled on the next iteration
    return { i, text };
  }
  return { i, text: "\\".repeat(n) }; // not before a quote → every backslash is literal (path separators)
}

export function tokenize(command: string, meta: Set<string>): string[] | null {
  const tokens: string[] = [];
  const escapes = !meta.has("\\"); // Windows: backslash is a path sep / quote-escape lead, not a shell op
  let cur = "";
  let has = false; // did this token accumulate any char (incl. "")? distinguishes "" from a gap
  let quoted = false;
  let i = 0;
  while (i < command.length) {
    const ch = command[i]!;

    // Backslash run (Windows rules only) — resolved against a following quote, in any quote state.
    if (ch === "\\" && escapes) {
      const consumed = consumeBackslashRun(command, i);
      cur += consumed.text;
      i = consumed.i;
      has = true;
      continue;
    }

    if (ch === '"') {
      quoted = !quoted;
      has = true;
      i++;
      continue;
    }
    if (!quoted && (ch === " " || ch === "\t" || ch === "\r" || ch === "\n")) {
      if (has) {
        tokens.push(cur);
        cur = "";
        has = false;
      }
      i++;
      continue;
    }
    if (!quoted && meta.has(ch)) return null; // unquoted operator / expansion → needs a shell
    cur += ch;
    has = true;
    i++;
  }
  if (quoted) return null; // unterminated quote — don't guess, use the shell
  if (has) tokens.push(cur);
  return tokens.length ? tokens : null;
}

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

const isExecutableFile = (p: string): boolean => {
  try {
    const s = statSync(p);
    return s.isFile() && (s.mode & 0o111) !== 0;
  } catch {
    return false;
  }
};

/** PATH from an env, read case-insensitively (Windows uses `Path`; a merged def.env may too). */
function envPath(env: NodeJS.ProcessEnv): string {
  for (const key of Object.keys(env)) if (key.toLowerCase() === "path") return env[key] ?? "";
  return "";
}

/** Dirs to search for a bare command name: the running binary's own dir first (guarantees
 *  `bun` resolves — the daemon IS bun), then PATH. */
function searchDirs(env: NodeJS.ProcessEnv, delimiter: string): string[] {
  return [path.dirname(process.execPath), ...envPath(env).split(delimiter)].filter(Boolean);
}

function resolveWindows(file: string, cwd: string, env: NodeJS.ProcessEnv): string | null {
  const lower = file.toLowerCase();
  const alreadyDirect = WIN_DIRECT_EXTS.some((e) => lower.endsWith(e));
  const hasSep = file.includes("\\") || file.includes("/");

  if (hasSep) {
    const base = path.resolve(cwd, file);
    if (alreadyDirect) return isFile(base) ? base : null;
    for (const e of WIN_DIRECT_EXTS) if (isFile(base + e)) return base + e;
    return null; // a path to a .cmd/.bat/extensionless — leave it to the shell
  }
  for (const dir of searchDirs(env, ";")) {
    if (alreadyDirect) {
      const p = path.join(dir, file);
      if (isFile(p)) return p;
    } else {
      for (const e of WIN_DIRECT_EXTS) {
        const p = path.join(dir, file + e);
        if (isFile(p)) return p;
      }
    }
  }
  return null;
}

function resolvePosix(file: string, cwd: string, env: NodeJS.ProcessEnv): string | null {
  if (file.includes("/")) {
    const p = path.resolve(cwd, file);
    return isExecutableFile(p) ? p : null;
  }
  for (const dir of searchDirs(env, ":")) {
    const p = path.join(dir, file);
    if (isExecutableFile(p)) return p;
  }
  return null;
}

/**
 * Decide how to spawn a managed command. Returns `{ shell: false, file, args }` only when the
 * command is a plain executable invocation that needs no shell (so direct spawn is equivalent
 * and the cmd.exe/sh wrapper is dropped); otherwise `{ shell: true, command }`, matching the
 * original behaviour exactly. Any doubt — metachars, bad quoting, unresolved or non-direct
 * executable — downgrades to the shell path.
 */
export function planManagedSpawn(
  command: string,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): SpawnPlan {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const win = platform === "win32";

  const tokens = tokenize(command, win ? WIN_META : POSIX_META);
  if (!tokens?.[0]) return { shell: true, command };
  const [file, ...args] = tokens;

  const exe = win ? resolveWindows(file, cwd, env) : resolvePosix(file, cwd, env);
  if (!exe) return { shell: true, command };
  return { shell: false, file: exe, args };
}
