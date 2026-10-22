import type { ComputedRef } from "vue"
import { onScopeDispose, watch } from "vue"

/** The outside watchdog's view of its tooltip: where the trigger and the portaled content are. */
export interface TooltipWatchdog {
  /** The real trigger element, registered once it is mounted (null when it goes). */
  setTrigger: (el: HTMLElement | null) => void
  /** Where the portaled content is, asked at check time (null when it goes). */
  setContent: (get: (() => unknown) | null) => void
}

const OUTSIDE_GRACE_MS = 150

/**
 * Watchdog for a mouse-opened (or focus-opened) tooltip whose close never arrives. reka closes on the
 * trigger's pointerleave or on pointermoves that its grace-area tracking sees, and neither fires when
 * the pointer leaves the document (this pane lives in an iframe, so Desk's chrome counts), when the
 * window loses focus, or when a modal (body pointer-events: none) sits over the trigger. So while the
 * tooltip is open and not held by a touch gesture, listen on the document and close it ourselves; a
 * closed tooltip has no listeners. `watching` is that condition, and `close` goes through the owner's
 * setOpen, which still respects `held`.
 */
export function useTooltipWatchdog(watching: ComputedRef<boolean>, close: () => void): TooltipWatchdog {
  let triggerEl: HTMLElement | null = null
  let contentOf: (() => unknown) | null = null
  let outsideTimer: ReturnType<typeof setTimeout> | undefined
  let bound = false

  function clearOutsideTimer(): void {
    if (outsideTimer !== undefined) clearTimeout(outsideTimer)
    outsideTimer = undefined
  }

  function closeIfStranded(): void {
    clearOutsideTimer()
    close()
  }

  function onWatchPointerOut(event: PointerEvent): void {
    if (event.pointerType === "touch") return
    if (event.relatedTarget === null) return closeIfStranded()
    // Into an iframe (Desk's AgentHydra pane): its moves never reach this document, so no pointermove would ever
    // start the grace below. Where the pointer went is enough to start it.
    checkOutside(event.relatedTarget)
  }

  function onWatchPointerMove(event: PointerEvent): void {
    if (event.pointerType === "touch") return
    checkOutside(event.target)
  }

  function checkOutside(at: EventTarget | null): void {
    if (triggerEl && !triggerEl.isConnected) return closeIfStranded()
    const target = at instanceof Node ? at : null
    const content = contentOf?.()
    if (!triggerEl || (target && (triggerEl.contains(target) || (content instanceof Node && content.contains(target))))) {
      clearOutsideTimer()
      return
    }
    // Short grace: crossing the gap into hoverable content passes over neither element.
    outsideTimer ??= setTimeout(closeIfStranded, OUTSIDE_GRACE_MS)
  }

  function bindWatchdog(): void {
    if (bound || typeof document === "undefined") return
    bound = true
    if (triggerEl && !triggerEl.isConnected) return closeIfStranded()
    document.addEventListener("pointerout", onWatchPointerOut, true)
    document.addEventListener("pointermove", onWatchPointerMove, true)
    document.documentElement.addEventListener("pointerleave", onWatchPointerOut)
    window.addEventListener("blur", closeIfStranded)
  }

  function unbindWatchdog(): void {
    clearOutsideTimer()
    if (!bound) return
    bound = false
    document.removeEventListener("pointerout", onWatchPointerOut, true)
    document.removeEventListener("pointermove", onWatchPointerMove, true)
    document.documentElement.removeEventListener("pointerleave", onWatchPointerOut)
    window.removeEventListener("blur", closeIfStranded)
  }

  watch(
    watching,
    (is) => {
      if (is) bindWatchdog()
      else unbindWatchdog()
    },
    { immediate: true },
  )
  onScopeDispose(unbindWatchdog)

  return {
    setTrigger(el) {
      triggerEl = el
    },
    setContent(get) {
      contentOf = get
    },
  }
}
