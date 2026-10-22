<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@ui-skin/cn"
import { tableHeadVariants } from "./table-variants"

// width and align are the skin's tableHeadVariants names, typed here as literal unions.
const props = defineProps<{
  class?: HTMLAttributes["class"]
  width?: "auto" | "measured" | "grow" | "10" | "12" | "16" | "20" | "24" | "32" | "48" | null
  align?: "start" | "end" | null
}>()
</script>

<template>
  <th
    data-slot="table-head"
    :class="cn(tableHeadVariants({ width, align }), props.class)"
  >
    <slot />
  </th>
</template>
