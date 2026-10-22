import type { ComputedRef } from "vue"
import { computed, onScopeDispose, readonly, ref, watch } from "vue"
import type { TooltipTouchContext } from "./touch"
import { PIN_GRACE_MS } from "./touch"
import { useTooltipWatchdog } from "./watchdog"

/** The props of a Tooltip wrapper that its open state reads (TooltipRootProps carries both). */
export interface TooltipEpisodeProps {
  open?: boolean
  defaultOpen?: boolean
}

/** What a Tooltip wrapper gets back: its open state, the setter it routes through, and the touch API. */
export interface TooltipEpisode {
  /** Whether the owner drives `open` itself, decided once at setup. */
  consumerControlled: boolean
  open: ComputedRef<boolean>
  /** Opens or closes the tooltip, refusing a close while a gesture holds it. */
  setOpen: (next: boolean) => void
  /** Provided to the trigger and content as TOOLTIP_TOUCH_KEY. */
  touch: TooltipTouchContext
}

/**
 * The open state of one Tooltip wrapper: the touch hold, the dismissal a finger needs, and the outside
 * watchdog. `emitOpen` is reka's `update:open`, the one place the owner hears a change.
 */
export function useTooltipEpisode(props: TooltipEpisodeProps, emitOpen: (next: boolean) => void): TooltipEpisode {
  // reka's TooltipRoot decides ONCE, at setup, whether it is controlled:
  //   passive: (props.open === undefined) as false
  // A tooltip that mounts uncontrolled can therefore never be driven by `open` later. Since a touch
  // gesture has to hold one open against reka's close paths (see touch.ts), this wrapper is ALWAYS
  // controlled and keeps the state itself — reka asks via `update:open`, we decide.
  const consumerControlled = props.open !== undefined
  const localOpen = ref(props.defaultOpen ?? false)
  const open = computed(() => (consumerControlled ? (props.open ?? false) : localOpen.value))

  /**
   * Refusing reka's closes while a gesture holds the tooltip. Set the moment a gesture reveals it and cleared a short
   * grace after that gesture ends — see touch.ts for why it must not be permanent.
   */
  const held = ref(false)
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  /** True while a finger-revealed tooltip is still showing; arms the dismissal listeners. */
  const openedByTouch = ref(false)
  /** The element the gesture came from — a press back on it is a toggle, not a dismissal. */
  let touchTrigger: HTMLElement | null = null

  function clearGrace(): void {
    if (graceTimer !== undefined) clearTimeout(graceTimer)
    graceTimer = undefined
  }

  function setOpen(next: boolean): void {
    // Lifting a finger fires pointerleave AND click, and reka closes on both. Refusing here is what
    // lets a revealed tooltip outlive the release that revealed it.
    if (!next && held.value) return
    if (next === open.value) return
    if (!consumerControlled) localOpen.value = next
    emitOpen(next)
  }

  function revealByTouch(trigger: HTMLElement | null): void {
    clearGrace()
    touchTrigger = trigger
    held.value = true
    openedByTouch.value = true
    setOpen(true)
  }

  function endHold(): void {
    if (!held.value) return
    clearGrace()
    graceTimer = setTimeout(() => {
      held.value = false
      graceTimer = undefined
    }, PIN_GRACE_MS)
  }

  function closeByTouch(): void {
    clearGrace()
    held.value = false
    setOpen(false)
  }

  // Dismissal for a finger-opened tooltip. Escape and hover still belong to reka once the grace has
  // lapsed; these two are the paths reka cannot serve here (touch.ts explains both).
  function onDocumentPointerDown(event: PointerEvent): void {
    const target = event.target instanceof Element ? event.target : null
    // A press back on the trigger is a toggle, settled by TooltipTrigger on release, so that a
    // tap-mode icon closes instead of closing and instantly reopening.
    if (target && touchTrigger?.contains(target)) return
    // Reading the tooltip is not dismissing it.
    if (target?.closest('[data-slot="tooltip-content"]')) return
    closeByTouch()
  }

  function bindDismissal(): void {
    if (typeof document === "undefined") return
    // Capture phase, so a dismissal still lands if something stops propagation on the way up.
    document.addEventListener("pointerdown", onDocumentPointerDown, true)
    // The trigger slides out from under the tooltip; hiding beats floating over whatever replaces it.
    document.addEventListener("scroll", closeByTouch, { capture: true, passive: true })
  }

  function unbindDismissal(): void {
    if (typeof document === "undefined") return
    document.removeEventListener("pointerdown", onDocumentPointerDown, true)
    document.removeEventListener("scroll", closeByTouch, true)
  }

  watch(openedByTouch, (is) => {
    if (is) bindDismissal()
    else unbindDismissal()
  })

  // Closed by hover, focus or the watchdog, and the watchdog's own listeners go with it. Closing goes
  // through setOpen, which still respects `held`.
  const watchdog = useTooltipWatchdog(
    computed(() => open.value && !held.value),
    () => setOpen(false),
  )

  // However it closed — our dismissal, reka's, or a hover leaving — the touch episode is over.
  watch(open, (is) => {
    if (!is) {
      openedByTouch.value = false
      touchTrigger = null
      clearGrace()
      held.value = false
    }
  })

  onScopeDispose(() => {
    clearGrace()
    unbindDismissal()
  })

  return {
    consumerControlled,
    open,
    setOpen,
    touch: {
      isOpen: readonly(open),
      revealByTouch,
      endHold,
      closeByTouch,
      setTrigger: watchdog.setTrigger,
      setContent: watchdog.setContent,
    },
  }
}
