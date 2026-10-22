/**
 * Local edits the update already carries (part of updater-engine.mjs, synced with it).
 *
 * A deployed checkout patched by hand, whose patch was then landed upstream: every local edit is
 * already the update target's content (AgentHydra, 2026-10-15: a chat fixed a running feature by
 * editing the deployed checkout, its edits were landed, and the checkout stayed dirty, so it took
 * no update at all). Such edits do not block the update; any other local edit still does. Only
 * unstaged edits and untracked files qualify: a staged, renamed or unmerged path is someone's git
 * work in progress.
 */

import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";

const LANDED_MAX = 200;

// Through realpath, so a junction or a short name to the checkout still matches git's own top level.
function sameFolder(a, b) {
  const norm = (p) => {
    try {
      return realpathSync.native(p).replace(/[\\/]+$/, "");
    } catch {
      return resolve(p).replace(/[\\/]+$/, "");
    }
  };
  return process.platform === "win32" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

// The paths whose content or mode is compared in the target: the edits that are neither new nor deleted.
function modifiedPaths(edits) {
  return edits.filter((e) => !e.deleted && !e.untracked).map((e) => e.path);
}

export function createEditReader({ appRoot, git, gitText }) {
  /** The checkout's local edits ({ path from the top level, deleted }), or null when one is staged,
   *  renamed, unmerged or a type change, there are more than LANDED_MAX, or status cannot be read. */
  async function localEdits() {
    const r = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (!r.ok) return null;
    const edits = [];
    for (const entry of r.stdout.split("\0").filter(Boolean)) {
      const [x, y, path] = [entry[0], entry[1], entry.slice(3)];
      if (x === "?" && y === "?") edits.push({ path, deleted: false, untracked: true });
      else if (x !== " ") return null;
      else if (y === "M") edits.push({ path, deleted: false, untracked: false });
      else if (y === "D") edits.push({ path, deleted: true, untracked: false });
      else return null;
    }
    return edits.length <= LANDED_MAX ? edits : null;
  }

  /** A mode change (chmod +x) is an edit as well: a modified file's mode must be the target's too. */
  async function modesMatch(modified, modes) {
    if (!modified.length) return true;
    const raw = await git(["--literal-pathspecs", "diff", "--raw", "-z", "--", ...modified]);
    if (!raw.ok) return false;
    const parts = raw.stdout.split("\0").filter(Boolean);
    for (let i = 0; i + 1 < parts.length; i += 2) {
      if (modes.get(parts[i + 1]) !== parts[i].slice(1).split(" ")[1]) return false;
    }
    return true;
  }

  // One ls-tree answers every edit's presence, oid and mode in `target`. Null when it failed or a
  // pathspec matched a child (its answer is then not one-to-one with the edits).
  async function targetTree(target, wanted) {
    const tree = await git(["--literal-pathspecs", "ls-tree", "-z", target, "--", ...wanted]);
    if (!tree.ok) return null;
    const inTarget = new Map(); // path -> [mode, type, oid] in the target; absent when gone there
    for (const line of tree.stdout.split("\0").filter(Boolean)) {
      // "<mode> <type> <oid>\t<path>": the path follows a TAB; the three fields before it are spaced.
      const tab = line.indexOf("\t");
      const path = line.slice(tab + 1);
      if (!wanted.has(path)) return null; // a pathspec matched a child: not one-to-one with the edits
      inTarget.set(path, line.slice(0, tab).split(" "));
    }
    return inTarget;
  }

  // One hash-object hashes every working file: path -> hash. Null when it failed or answered a different count.
  async function workingHashes(top, present) {
    const hashed = present.length
      ? await git(["hash-object", "--", ...present.map((e) => join(top, e.path))])
      : { ok: true, stdout: "" };
    const lines = hashed.ok ? hashed.stdout.split("\n").filter(Boolean) : null;
    if (lines?.length !== present.length) return null;
    return new Map(present.map((e, i) => [e.path, lines[i]]));
  }

  /** The local edits when every one is already `target`'s content (a deleted file is gone there
   *  too), else null. Compared as git blobs, so line-ending conversion on checkout is no difference.
   *  One ls-tree and one hash-object answer every edit (2026-10-16: the old loop spent up to two
   *  spawns per edit). When either cannot answer one-to-one, the edits block the update: a path
   *  that is a folder in the target, or a file git cannot hash, is never the target's content. */
  async function editsAlreadyIn(target) {
    if (!target) return null;
    const edits = await localEdits();
    const top = edits?.length ? await gitText(["rev-parse", "--show-toplevel"]) : null;
    // Status paths are from the top level and every later pathspec is from appRoot: they must be one folder.
    if (!top || !sameFolder(top, appRoot)) return null;
    const inTarget = await targetTree(target, new Set(edits.map((e) => e.path)));
    const hash = inTarget && (await workingHashes(top, edits.filter((e) => !e.deleted)));
    if (!hash) return null;
    // A deleted edit must be gone in the target, every other must hash to the target's blob, and the
    // modified files' modes must match.
    for (const e of edits) {
      const want = inTarget.get(e.path)?.[2] ?? null;
      if (e.deleted ? want : hash.get(e.path) !== want) return null;
    }
    const modes = new Map([...inTarget].map(([p, m]) => [p, m[0]]));
    return (await modesMatch(modifiedPaths(edits), modes)) ? edits : null;
  }

  return { editsAlreadyIn };
}
