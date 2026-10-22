// Opt-in ("relative-time-coarse" in kit.config): only an app with notification-style timestamps calls it.
import { formatAgo, type RelativeTimeT } from "./relativeTime";

/**
 * Coarser variant for notification-style timestamps: "just now" under 10s,
 * rounded to the nearest 10s under a minute, then delegates to `formatAgo`. The
 * sub-minute labels are English-only (callers needing localised sub-minute copy
 * should add keys and branch here).
 */
export function formatAgoCoarse(nowMs: number, ts: number, t?: RelativeTimeT): string {
  const s = Math.max(0, Math.round((nowMs - ts) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${Math.floor(s / 10) * 10}s ago`;
  return formatAgo(nowMs, ts, t);
}
