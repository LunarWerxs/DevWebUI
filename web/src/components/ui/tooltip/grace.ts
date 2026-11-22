import { getCurrentInstance, onBeforeUnmount } from "vue"

/** How long a hover card stays once the pointer left its trigger or the card, and how long a part crossed on the way to the
 *  card waits before it takes the card over: long enough to cross the gap between them, short enough that a pointer resting
 *  there gets that part's card. The kit owns this wait so every tooltip-like surface waits the same. */
export const TIP_GRACE_MS = 300

/** One grace timer for a hover card: `start(fn)` runs `fn` after the grace (a new start replaces the pending one), `cancel()`
 *  drops it. Inside a component it is also cancelled on unmount. */
export function useTipGrace(ms: number = TIP_GRACE_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancel = () => clearTimeout(timer)
  const start = (fn: () => void) => {
    clearTimeout(timer)
    timer = setTimeout(fn, ms)
  }
  if (getCurrentInstance()) onBeforeUnmount(cancel)
  return { start, cancel }
}
