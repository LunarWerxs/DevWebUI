/** The class merge, from the app's skin (ui-skin/cn.ts): its tailwind-merge knows the app's type scale. */
export { cn } from "@ui-skin/cn";

/**
 * The ONE prefers-reduced-motion read for every kit module (the theme crossfade, the resize-grip
 * reset glide, ...). Keeping the SSR guard, the matchMedia capability check and the policy in a
 * single place stops the copies drifting apart. Stylesheet-level motion is handled separately by
 * the `@media (prefers-reduced-motion: reduce)` block in base.css.
 *
 * Read on every call rather than cached, so a change to the OS setting applies to the next
 * animation without a reload.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
}
