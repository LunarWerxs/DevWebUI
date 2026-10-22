<script setup lang="ts">
import type { TooltipContentEmits, TooltipContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { TooltipArrow, TooltipContent, TooltipPortal, useForwardPropsEmits } from "reka-ui"
import { computed, inject, onBeforeUnmount, ref } from "vue"
import { cn } from "@ui-skin/cn"
import * as skin from "@ui-skin/tooltip"
import { usePortalTo } from "../core/portal-to"
import { TOOLTIP_LAZY_KEY } from "./lazy"
import { TOOLTIP_TOUCH_KEY } from "./touch"

defineOptions({
  inheritAttrs: false,
})

const props = withDefaults(defineProps<TooltipContentProps & { class?: HTMLAttributes["class"], elevated?: boolean }>(), {
  sideOffset: 0,
})

const emits = defineEmits<TooltipContentEmits>()

const delegatedProps = reactiveOmit(props, "class", "elevated")
const forwarded = useForwardPropsEmits(delegatedProps, emits)
// Under an unarmed LazyTooltip the content has no root to portal from, and nothing shows until it is armed anyway.
const lazyClosed = computed(() => inject(TOOLTIP_LAZY_KEY, null)?.closed.value === true)
// Show the tooltip where its content is (its open-tooltip watchdog counts it as "inside"). A getter, read
// when the watchdog checks: reka's content root is a placeholder until it opens, and $el is not reactive.
const touchCtx = inject(TOOLTIP_TOUCH_KEY, null)
const contentRef = ref<{ $el: unknown } | null>(null)
touchCtx?.setContent(() => contentRef.value?.$el)
onBeforeUnmount(() => touchCtx?.setContent(null))
// Where the overlay portals to: the body, or the root an ancestor provides (core/portal-to.ts).
const portalTo = usePortalTo()
</script>

<template>
  <TooltipPortal v-if="!lazyClosed" :to="portalTo">
    <TooltipContent
      ref="contentRef"
      data-slot="tooltip-content"
      v-bind="{ ...forwarded, ...$attrs }"
      :class="cn('data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 has-data-[slot=kbd]:pe-1.5 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm z-50 w-fit max-w-xs origin-(--reka-tooltip-content-transform-origin) [&>span:has(>svg)]:pointer-events-none', skin.content, elevated && 'shadow-lg', props.class)"
    >
      <slot />

      <!-- The arrow's tip touches the trigger, and the opening slide moves it 8px further in: the arrow's positioning span
           (reka renders it around the svg and gives it none of these classes) takes no pointer events, or
           a press on a short trigger (a 16px name) lands on the arrow and is lost. -->
      <TooltipArrow :class="cn('size-2.5 rotate-45 rounded-xs z-50 translate-y-[calc(-50%-2px)]', skin.arrow)" />
    </TooltipContent>
  </TooltipPortal>
</template>
