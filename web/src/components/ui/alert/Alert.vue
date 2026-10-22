<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@ui-skin/cn"
import { alertVariants } from "./alert-variants"

// variant names the skin's table (default, destructive, warning); typed here as a literal union, not from the skin.
const props = defineProps<{
  class?: HTMLAttributes["class"]
  variant?: "default" | "destructive" | "warning" | null
}>()
</script>

<template>
  <div
    data-slot="alert"
    :class="cn(alertVariants({ variant }), props.class)"
    role="alert"
  >
    <slot />
  </div>
</template>
