<script setup lang="ts">
import type { TooltipRootEmits, TooltipRootProps } from "reka-ui"
import { TooltipRoot, useForwardProps } from "reka-ui"
import { provide } from "vue"
import { useTooltipEpisode } from "./episode"
import { TOOLTIP_TOUCH_KEY } from "./touch"

const props = withDefaults(defineProps<TooltipRootProps>(), {
  // Vue's TS-macro compiler gives an optional `boolean` prop a bare runtime `Boolean` type, and an
  // ABSENT Boolean prop defaults to `false`, not `undefined` — the same trap TooltipProvider
  // documents for `disabled`. Without these, `props.open` reads `false` when no caller passed it,
  // `consumerControlled` below is true for EVERY tooltip, and nothing ever opens.
  open: undefined,
  defaultOpen: undefined,
})
const emits = defineEmits<TooltipRootEmits>()

const { open, setOpen, touch } = useTooltipEpisode(props, (next) => emits("update:open", next))
provide(TOOLTIP_TOUCH_KEY, touch)

// Still useForwardProps, not a plain spread: it forwards ONLY what the caller actually assigned, so
// `disabled`/`ignoreNonKeyboardFocus`/`disableHoverableContent` stay absent here and keep falling
// through to TooltipProvider. Spreading raw props would hand reka a coerced `false` for each and
// quietly override the provider — including the app-wide "show tooltips" kill switch. `:open` is
// bound after it and wins.
const forwarded = useForwardProps(props)
</script>

<template>
  <TooltipRoot
    v-slot="slotProps"
    data-slot="tooltip"
    v-bind="forwarded"
    :open="open"
    @update:open="setOpen"
  >
    <slot v-bind="slotProps" />
  </TooltipRoot>
</template>
