<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@ui-skin/cn"
import { tableVariants } from "./table-variants"

// density and rows are the skin's tableVariants names, typed here as literal unions.
const props = defineProps<{
  class?: HTMLAttributes["class"]
  density?: "default" | "compact" | null
  rows?: "default" | "dense" | "tight" | null
}>()
</script>

<template>
  <div data-slot="table-container" class="relative w-full overflow-x-auto">
    <table data-slot="table" :data-density="density" :class="cn(tableVariants({ density, rows }), props.class)">
      <slot />
    </table>
  </div>
</template>
