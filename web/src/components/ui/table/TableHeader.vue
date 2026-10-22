<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@ui-skin/cn"
import * as skin from "@ui-skin/table"

const props = defineProps<{
  class?: HTMLAttributes["class"]
  sticky?: boolean
}>()
</script>

<template>
  <thead
    data-slot="table-header"
    :data-sticky="sticky ? '' : undefined"
    :class="cn('[&_tr]:border-b', sticky && 'sticky top-0 z-10', sticky && skin.stickyHeader, props.class)"
  >
    <slot />
  </thead>
</template>
