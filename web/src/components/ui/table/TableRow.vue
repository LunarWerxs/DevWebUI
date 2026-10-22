<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@ui-skin/cn"
import { tableRowVariants } from "./table-variants"

// variant is the skin's tableRowVariants name, typed here as a literal union.
const props = defineProps<{
  class?: HTMLAttributes["class"]
  variant?: "default" | "tinted" | "dimmed" | "faded" | null
}>()
</script>

<template>
  <tr
    data-slot="table-row"
    :data-variant="variant"
    :class="cn(tableRowVariants({ variant }), props.class)"
  >
    <slot />
  </tr>
</template>
