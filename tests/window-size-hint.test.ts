// The window-size hint: how a portable window learns its intended size when Chromium
// won't apply one from outside.
//
// Why this exists: --window-size and even the slot's saved placement are IGNORED when a
// Chromium instance on the profile is already running — the forwarded --app launch just
// inherits the existing window's geometry (verified against Edge 150 on 2026-07-16).
// The launcher's "Open dashboard" button always hits that case, so the daemon appends
// WINDOW_SIZE_HINT_PARAM to the URL (server/src/http/core.ts) and the page resizes
// itself (web/src/lib/window-size-hint.ts). These tests pin the two halves the daemon
// owns: the hint format, and reading the size a profile already remembers.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { formatWindowSizeHint, parseWindowSizeHint } from "../shared/constants";
import { rememberedWindowSize } from "../server/src/window-size";

test("hint format round-trips, garbage degrades to null (never a bizarre resizeTo)", () => {
  expect(formatWindowSizeHint({ width: 840, height: 760 })).toBe("840x760");
  expect(parseWindowSizeHint("840x760")).toEqual({ width: 840, height: 760 });
  expect(parseWindowSizeHint(formatWindowSizeHint({ width: 440, height: 220 }))).toEqual({
    width: 440,
    height: 220,
  });
  for (const bad of [null, "", "840", "840x", "x760", "840x760x2", "-840x760", "a840x760", "8x7"])
    expect(parseWindowSizeHint(bad)).toBeNull();
});

test("rememberedWindowSize reads a flat placement (the dashboard's key has no dots)", () => {
  const dir = mkdtempSync(join(tmpdir(), "lw-winsize-"));
  try {
    const url = "http://localhost:4000/";

    // Fresh profile / no Preferences: nothing remembered, the caller's size applies.
    expect(rememberedWindowSize(dir, url)).toBeNull();

    mkdirSync(join(dir, "Default"), { recursive: true });
    const prefs = join(dir, "Default", "Preferences");
    writeFileSync(
      prefs,
      JSON.stringify({
        browser: {
          app_window_placement: { "localhost_/": { left: 100, top: 50, right: 940, bottom: 810 } },
        },
      }),
    );
    expect(rememberedWindowSize(dir, url)).toEqual({ width: 840, height: 760 });

    // A different window's placement must not answer for this one.
    expect(rememberedWindowSize(dir, "http://localhost:4000/focus/p1.main")).toBeNull();

    // Degenerate rects and corrupt Preferences degrade to "nothing remembered".
    writeFileSync(
      prefs,
      JSON.stringify({
        browser: {
          app_window_placement: { "localhost_/": { left: 10, top: 10, right: 10, bottom: 10 } },
        },
      }),
    );
    expect(rememberedWindowSize(dir, url)).toBeNull();
    writeFileSync(prefs, "{ not json");
    expect(rememberedWindowSize(dir, url)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rememberedWindowSize reads the NESTED form a dotted process id is stored as", () => {
  // Chromium writes preferences by dotted PATH, and every focus URL contains a dot
  // (`<projectId>.<localId>`), so the launcher's placement lands nested:
  // app_window_placement["localhost_/focus/p1"]["main"], NOT under the flat key its
  // own key format names (observed against Edge 150, 2026-07-16). A flat-only lookup
  // silently reports "nothing remembered" for every launcher — the kit's
  // hasRememberedBounds still has that gap; this reader must not.
  const dir = mkdtempSync(join(tmpdir(), "lw-winsize-"));
  try {
    mkdirSync(join(dir, "Default"), { recursive: true });
    writeFileSync(
      join(dir, "Default", "Preferences"),
      JSON.stringify({
        browser: {
          app_window_placement: {
            "localhost_/focus/p1": { main: { left: 600, top: 600, right: 1040, bottom: 820 } },
          },
        },
      }),
    );
    expect(rememberedWindowSize(dir, "http://localhost:4000/focus/p1.main")).toEqual({
      width: 440,
      height: 220,
    });
    // The sibling local id under the same project is a different window.
    expect(rememberedWindowSize(dir, "http://localhost:4000/focus/p1.other")).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
