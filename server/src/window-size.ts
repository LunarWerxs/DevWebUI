// The size a portable window's placement slot remembers, read straight from the
// Chromium profile the daemon owns. Its one caller is the portable-window route
// (http/core.ts), which passes the result to the page as the WINDOW_SIZE_HINT_PARAM —
// see shared/constants.ts for why the hint exists at all (forwarded `--app` launches
// ignore both `--window-size` and the saved placement).
//
// Deliberately its own module with no daemon imports, so tests can exercise it against
// a scratch profile without dragging in the runtime/instance config machinery.
import { readFileSync } from "node:fs";
import path from "node:path";
import { appWindowPlacementKey } from "./portable-window.mjs";

/**
 * The outer size Chromium has saved for `url`'s window in `profileDir`, or null when
 * nothing usable is remembered (fresh profile, unreadable Preferences, zero-area rect).
 *
 * The lookup tries the placement key flat AND as a dotted pref path: Chromium writes
 * preferences by path, so a key containing dots — every focus URL does, the process id
 * is `<projectId>.<localId>` — lands as nested dicts ("localhost_/focus/p1" → {"main":
 * {...}}), not as the flat key its own `GenerateApplicationNameFromURL` produces
 * (observed against Edge 150, 2026-07-16). The kit's `hasRememberedBounds` only probes
 * flat, so it misses those; this reader must not repeat that.
 */
export function rememberedWindowSize(
  profileDir: string,
  url: string,
): { width: number; height: number } | null {
  const key = appWindowPlacementKey(url);
  if (!profileDir || !key) return null;
  try {
    const prefs = JSON.parse(readFileSync(path.join(profileDir, "Default", "Preferences"), "utf8"));
    const placements = prefs?.browser?.app_window_placement;
    if (!placements || typeof placements !== "object") return null;
    let node: unknown = placements[key];
    if (node === undefined) {
      node = key
        .split(".")
        .reduce<unknown>(
          (n, seg) =>
            n && typeof n === "object" ? (n as Record<string, unknown>)[seg] : undefined,
          placements,
        );
    }
    const b = node as { left?: unknown; top?: unknown; right?: unknown; bottom?: unknown };
    if (
      typeof b?.left !== "number" ||
      typeof b.top !== "number" ||
      typeof b.right !== "number" ||
      typeof b.bottom !== "number"
    )
      return null;
    const width = b.right - b.left;
    const height = b.bottom - b.top;
    return width > 0 && height > 0 ? { width, height } : null;
  } catch {
    return null; // no profile yet / corrupt Preferences: same as "nothing remembered"
  }
}
