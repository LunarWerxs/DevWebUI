<script setup lang="ts">
import { computed, nextTick, provide, ref, useTemplateRef } from "vue"
import type { TooltipLazyContext } from "./lazy"
import { TOOLTIP_LAZY_KEY } from "./lazy"
import Tooltip from "./Tooltip.vue"

defineOptions({
  inheritAttrs: false,
})

/**
 * A Tooltip that mounts on first interest. A list row holds N of these, and a Tooltip mounted per row is N reka roots
 * for nothing: until a pointer enters or presses the trigger, or it takes focus or a key, only the bare trigger renders.
 * Arming swaps that for a full Tooltip, which rebuilds the trigger, so focus is handed back to the rebuilt element.
 * A touch never arms on its own press: the trigger's long press arms it, so a first tap still runs the action.
 */
const root = useTemplateRef<HTMLElement>("root")
const armed = ref(false)
let pendingReveal = false

function arm(reveal = false): void {
  if (reveal) pendingReveal = true
  if (armed.value) return
  const el = root.value
  const focused = document.activeElement
  // Matched by tag and ordinal, not by position: the bare trigger's wrapper span goes away when the tooltip arms.
  const tag = focused instanceof HTMLElement && el?.contains(focused) ? focused.tagName : null
  const ordinal = tag && el ? Array.from(el.querySelectorAll(tag)).indexOf(focused as HTMLElement) : -1
  armed.value = true
  if (!el || tag === null || ordinal < 0) return
  nextTick(() => {
    const next = el.querySelectorAll(tag)[ordinal]
    if (next instanceof HTMLElement) next.focus()
  })
}

function takeReveal(): boolean {
  const pending = pendingReveal
  pendingReveal = false
  return pending
}

function onInterest(event: Event): void {
  if ("pointerType" in event && event.pointerType === "touch") return
  arm()
}

provide(TOOLTIP_LAZY_KEY, { closed: computed(() => !armed.value), arm, takeReveal } satisfies TooltipLazyContext)
</script>

<template>
  <span ref="root" class="contents" @pointerenter="onInterest" @pointerdown="onInterest" @focusin="onInterest" @keydown="onInterest">
    <Tooltip v-if="armed" v-bind="$attrs">
      <slot />
    </Tooltip>
    <slot v-else />
  </span>
</template>
