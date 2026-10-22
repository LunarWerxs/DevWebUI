import type { VNode } from "vue"
import { Comment, Fragment, Text } from "vue"

// What a first gesture on a lazy overlay replays onto its real trigger: first-interest.ts here, and any app's own lazy
// layer (AgentHydra's screens). A caller decides what to replay; these build it.

/** The init of a pointer event re-sent to the real trigger: the same pointer, position, buttons and modifiers. */
export function pointerInit(event: PointerEvent): PointerEventInit {
  return {
    bubbles: true,
    cancelable: true,
    pointerId: event.pointerId,
    pointerType: event.pointerType,
    isPrimary: event.isPrimary,
    clientX: event.clientX,
    clientY: event.clientY,
    button: event.button,
    buttons: event.buttons,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
  }
}

export function replayKey(event: KeyboardEvent, target: HTMLElement): void {
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: event.key,
      code: event.code,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
    }),
  )
}

/** Sends a pointermove from the element under the pointer that armed the overlay, when that is inside the new
 *  trigger: it bubbles to the trigger's own listeners even when `target` is a wrapper around it. */
export function replayUnderPointer(event: PointerEvent, target: HTMLElement, init: PointerEventInit): void {
  // The new trigger is under a pointer that has not moved, so no pointermove will come by itself.
  const under = document.elementFromPoint(event.clientX, event.clientY)
  if (under && target.contains(under)) under.dispatchEvent(new PointerEvent("pointermove", init))
}

export function firstElement(node: Node | null): HTMLElement | null {
  let cur = node
  while (cur) {
    if (cur instanceof HTMLElement) return cur
    cur = cur.nextSibling
  }
  return null
}

/** The nodes of a slot that render an element: comments, blank text and fragment wrappers are looked through. */
export function elementNodes(nodes: VNode[] | undefined, out: VNode[] = []): VNode[] {
  for (const node of nodes ?? []) {
    if (node.type === Comment) continue
    if (node.type === Text && !String(node.children ?? "").trim()) continue
    if (node.type === Fragment && Array.isArray(node.children)) elementNodes(node.children as VNode[], out)
    else out.push(node)
  }
  return out
}
