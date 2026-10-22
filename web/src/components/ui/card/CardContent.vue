<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@ui-skin/cn"
import * as skin from "@ui-skin/card"

// stack spaces the content's children; text "sm" sets them one step up from the card's own text.
const STACK = { none: "", sm: "space-y-2", md: "space-y-3" }

const props = defineProps<{
  class?: HTMLAttributes["class"]
  stack?: "none" | "sm" | "md"
  text?: "default" | "sm"
}>()
</script>

<template>
  <div
    data-slot="card-content"
    :class="cn('px-4 group-data-[size=sm]/card:px-3', STACK[stack ?? 'none'], text === 'sm' && skin.contentTextSm, props.class)"
  >
    <slot />
  </div>
</template>
