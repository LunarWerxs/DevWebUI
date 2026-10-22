<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@ui-skin/cn"
import { tableCellVariants } from "./table-variants"

// size, align and weight are the skin's tableCellVariants names, typed here as literal unions.
const props = defineProps<{
  class?: HTMLAttributes["class"]
  size?: "default" | "xs" | "sm" | null
  align?: "start" | "end" | null
  weight?: "default" | "medium" | null
  mono?: boolean
  numeric?: boolean
  muted?: boolean
  truncate?: boolean
}>()
</script>

<template>
  <td
    data-slot="table-cell"
    :class="cn(tableCellVariants({ size, align, weight, mono, numeric, muted, truncate }), props.class)"
  >
    <slot />
  </td>
</template>
