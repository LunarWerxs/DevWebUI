<script setup lang="ts">
import { computed, provide } from "vue"
import { useFirstInterest } from "../core/first-interest"
import type { TooltipLazyContext } from "./lazy"
import { TOOLTIP_LAZY_KEY } from "./lazy"
import Tooltip from "./Tooltip.vue"

defineOptions({
  inheritAttrs: false,
})

const emit = defineEmits<{ "update:open": [open: boolean] }>()

/**
 * A Tooltip that mounts on first interest. A list row holds N of these, and a Tooltip mounted per row is N reka roots
 * for nothing: until a pointer enters or presses the trigger, or it takes focus or a key, only the bare trigger renders.
 * Arming swaps that for a full Tooltip, which rebuilds the trigger, so it goes through core/first-interest.ts: no swap
 * while a press runs (a press with no move before it sends pointerenter and pointerdown back to back, and a swap
 * between them sent the pointerdown to a node no longer on the page), focus handed back to the rebuilt element, the
 * arming hover or key replayed onto it, and the click a menu trigger inside it missed. A press that arms it closes the
 * tooltip again, since the focus handed back would open it. A tap arms once its click has run on the bare trigger; the
 * trigger's long press arms it at once and reveals the text.
 */
let pendingReveal = false
const { seen, listeners } = useFirstInterest({ replay: true, afterPress: () => emit("update:open", false) })

function arm(reveal = false): void {
  if (reveal) pendingReveal = true
  seen.value = true
}

function takeReveal(): boolean {
  const pending = pendingReveal
  pendingReveal = false
  return pending
}

provide(TOOLTIP_LAZY_KEY, { closed: computed(() => !seen.value), arm, takeReveal } satisfies TooltipLazyContext)
</script>

<template>
  <span class="contents" v-on="listeners">
    <Tooltip v-if="seen" v-bind="$attrs" @update:open="emit('update:open', $event)">
      <slot />
    </Tooltip>
    <slot v-else />
  </span>
</template>
