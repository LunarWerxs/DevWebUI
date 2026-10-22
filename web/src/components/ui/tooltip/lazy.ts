import type { ComputedRef, InjectionKey } from "vue"

/**
 * Provided by LazyTooltip so the shared trigger and content can run before any reka root exists.
 */
export interface TooltipLazyContext {
  /** True until the tooltip is armed. */
  closed: ComputedRef<boolean>
  /** Arm the tooltip. `reveal` shows it as soon as the armed trigger mounts (a long press that armed it). */
  arm: (reveal?: boolean) => void
  /** Read and clear a pending reveal. The armed trigger calls this once it mounts. */
  takeReveal: () => boolean
}

export const TOOLTIP_LAZY_KEY: InjectionKey<TooltipLazyContext> = Symbol("tooltip-lazy")
