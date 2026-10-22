<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@ui-skin/cn"

// compact: a header with no gap under it, for a card whose content starts at once.
const props = defineProps<{
  class?: HTMLAttributes["class"]
  compact?: boolean
}>()
</script>

<template>
  <div
    data-slot="card-header"
    :class="cn('gap-1 rounded-t-lg px-4 group-data-[size=sm]/card:px-3 [.border-b]:pb-4 group-data-[size=sm]/card:[.border-b]:pb-3 group/card-header @container/card-header grid auto-rows-min items-start has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto]', compact && 'space-y-0 pb-2', props.class)"
  >
    <slot />
  </div>
</template>
