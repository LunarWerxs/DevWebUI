<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@ui-skin/cn"
import * as skin from "@ui-skin/card"

// tone colours the border: error is a failed result, the border and a light wash behind it (the skin's tone table).
const props = withDefaults(defineProps<{
  class?: HTMLAttributes["class"]
  size?: "default" | "sm"
  tone?: "default" | "primary" | "destructive" | "error"
}>(), {
  size: "default",
  tone: "default",
})
</script>

<template>
  <div
    data-slot="card"
    :data-size="size"
    :class="cn('gap-4 overflow-hidden rounded-lg py-4 ring-1 has-[>img:first-child]:pt-0 data-[size=sm]:gap-3 data-[size=sm]:py-3 *:[img:first-child]:rounded-t-lg *:[img:last-child]:rounded-b-lg group/card flex flex-col', skin.root, skin.tone[tone], props.class)"
  >
    <slot />
  </div>
</template>
