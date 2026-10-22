/**
 * Running programs moved aside before the advance (part of updater-engine.mjs, synced with it).
 *
 * Windows keeps a running program's image locked against overwrite, but lets it be renamed, and the
 * process keeps running from the renamed copy. So a fast-forward that changes a running program file
 * (AgentHydra's window host is one) fails partway with "unable to unlink old" and leaves a half-updated
 * checkout. Before advancing on Windows, each such file is moved aside to `<file>.replaced-<stamp>` and
 * put back at HEAD, so the checkout overwrites an unlocked copy instead of the running file.
 */

import { appendFile, copyFile, mkdir, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { CHECK_TIMEOUT_MS, commandSummary, oneAtATime, stepFailureMessage } from "./updater-engine-run.mjs";

const PROGRAM_FILE = /\.(exe|dll|node)$/i;
const REPLACED_COPY = ".replaced-";

const reason = (err) => (err instanceof Error ? err.message : String(err));

/** Deletes every entry of `dir` that `isCopy` names; one whose program still runs stays for a later apply. */
async function deleteCopies(dir, isCopy) {
  const entries = await readdir(dir).catch(() => []);
  // A copy a program still runs from stays locked; a later apply retries it (floor-ok: as before the split).
  await oneAtATime(entries.filter(isCopy), (entry) => unlink(join(dir, entry)).catch(() => {}));
}

export function createAsideMover({ appRoot, asideDir, git, gitText, runCommand }) {
  // The moved-aside copies must never make the checkout dirty, or every later apply refuses it. Git's
  // local exclude file covers them without touching the app's own .gitignore.
  async function excludeReplacedCopies() {
    const commonDir = await gitText(["rev-parse", "--git-common-dir"]);
    if (!commonDir) return false;
    const infoDir = resolve(appRoot, commonDir, "info");
    const excludeFile = join(infoDir, "exclude");
    const pattern = `*${REPLACED_COPY}*`;
    const current = await readFile(excludeFile, "utf8").catch((err) => (err?.code === "ENOENT" ? "" : Promise.reject(err)));
    if (current.split(/\r?\n/).includes(pattern)) return true;
    await mkdir(infoDir, { recursive: true });
    await appendFile(excludeFile, `${current && !current.endsWith("\n") ? "\n" : ""}${pattern}\n`);
    return true;
  }

  // A copy moved aside while its program was still running cannot be deleted by the apply that made it.
  // Every such leftover is deleted now; one still running is retried by a later apply. Only names this
  // updater made: anything else in those folders is not its to delete.
  async function removeLeftoverCopies() {
    const listed = await git(["ls-files", "-z"]);
    const programs = listed.ok ? listed.stdout.split("\0").filter((path) => PROGRAM_FILE.test(path)) : [];
    const prefixesByDir = new Map(); // folder -> the `<program>.replaced-` prefixes of the programs in it
    for (const path of programs) {
      const full = join(appRoot, path);
      const dir = dirname(full);
      const prefix = `${basename(full)}${REPLACED_COPY}`;
      const prefixes = prefixesByDir.get(dir);
      if (prefixes) prefixes.push(prefix);
      else prefixesByDir.set(dir, [prefix]);
    }
    const sweeps = [...prefixesByDir].map(([dir, prefixes]) => ({ dir, isCopy: (entry) => prefixes.some((prefix) => entry.startsWith(prefix)) }));
    if (asideDir) sweeps.unshift({ dir: asideDir, isCopy: (entry) => entry.includes(REPLACED_COPY) });
    // One folder at a time, as each folder's copies are: every async fs call in flight holds a Bun I/O thread.
    await oneAtATime(sweeps, ({ dir, isCopy }) => deleteCopies(dir, isCopy));
  }

  /** The program files the advance to `target` modifies or deletes that are on disk now; null when git cannot say. */
  async function changedPrograms(target, output) {
    const diffArgs = ["git", "diff", "--name-only", "-z", "--no-renames", "--diff-filter=MD", "HEAD", target];
    const diff = await runCommand(diffArgs, CHECK_TIMEOUT_MS);
    if (!diff.ok) {
      output.push(commandSummary(diffArgs, diff));
      return null;
    }
    const named = diff.stdout.split("\0").filter((path) => PROGRAM_FILE.test(path));
    const present = await oneAtATime(named, (path) => stat(join(appRoot, path)).then(() => path, () => null));
    return present.filter(Boolean);
  }

  // With an aside folder (outside the work tree, same volume) the move never shows in `git status`: each
  // program is moved there and copied back, and one that cannot be refuses the update. Every path is put
  // back before the failure is thrown, so none is left missing. One program at a time, like every fs call here.
  async function moveIntoAsideDir(programs, stamp, output) {
    const failures = await oneAtATime(programs, (path) => moveOneAside(path).then(() => null, (err) => err));
    const failed = failures.find(Boolean);
    if (failed) throw failed;

    async function moveOneAside(path) {
      const full = join(appRoot, path);
      // One flat name per path that no other path can share (`a/b_c.exe` and `a_b/c.exe` stay apart).
      const copy = join(asideDir, `${encodeURIComponent(path)}${REPLACED_COPY}${stamp}`);
      await mkdir(asideDir, { recursive: true })
        .then(() => rename(full, copy))
        .catch((err) => {
          throw new Error(`could not move ${path} aside, so nothing was updated: ${reason(err)}`);
        });
      output.push(`moved ${path} aside to ${copy}`);
      await copyFile(copy, full).catch(async (err) => {
        await rename(copy, full).catch(() => {}); // reported below with where the bytes are
        throw new Error(`could not put ${path} back after moving it aside, so nothing was updated: ${reason(err)}`);
      });
    }
  }

  // Without one, the copy sits beside the program, hidden by git's local exclude, and one checkout puts
  // every moved path back at HEAD. A move that fails is recorded and the advance runs as it would have.
  async function moveBesideAndCheckout(programs, stamp, output) {
    const tries = await oneAtATime(programs, (path) => {
      const full = join(appRoot, path);
      const copy = `${full}${REPLACED_COPY}${stamp}`;
      return rename(full, copy).then(
        () => ({ path, full, copy, err: null }),
        (err) => ({ path, full, copy, err }),
      );
    });
    for (const t of tries) {
      output.push(t.err ? `could not move ${t.path} aside: ${reason(t.err)}` : `moved ${t.path} aside to ${basename(t.copy)}`);
    }
    const moved = tries.filter((t) => !t.err);
    if (!moved.length) return;
    const checkoutArgs = ["git", "checkout", "HEAD", "--", ...moved.map((m) => m.path)];
    const checkout = await runCommand(checkoutArgs, CHECK_TIMEOUT_MS);
    output.push(commandSummary(checkoutArgs, checkout));
    if (checkout.ok) return;
    const failure = stepFailureMessage(checkoutArgs, checkout);
    const stranded = (await oneAtATime(moved, (m) => rename(m.copy, m.full).then(() => null, () => m))).filter(Boolean);
    if (!stranded.length) throw new Error(failure);
    throw new Error(`${failure}; ${stranded.map((m) => `${m.path} could not be moved back and is at ${basename(m.copy)}`).join("; ")}`);
  }

  /** Windows only, run before the advance; `target` is the commit the fast-forward lands on. */
  async function moveAsideRunningPrograms(target, output) {
    await removeLeftoverCopies();
    const programs = await changedPrograms(target, output);
    if (!programs?.length) return;
    if (!asideDir && !(await excludeReplacedCopies().catch(() => false))) {
      output.push("could not exclude the moved-aside program copies from git; running programs were not moved aside");
      return;
    }
    // UTC, digits only: YYYYMMDDHHmmss.
    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    if (asideDir) await moveIntoAsideDir(programs, stamp, output);
    else await moveBesideAndCheckout(programs, stamp, output);
  }

  return { moveAsideRunningPrograms };
}
