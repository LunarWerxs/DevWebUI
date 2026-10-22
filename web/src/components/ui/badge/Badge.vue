<script setup lang="ts">
import type { PrimitiveProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { Primitive } from "reka-ui"
import { cn } from "@ui-skin/cn"
import { badgeVariants } from "./badge-variants"

// The variant, size and tone names are the app's own (its skin's badgeVariants); index.ts types them for callers.
const props = defineProps<PrimitiveProps & {
  variant?: string | null
  size?: string | null
  tabular?: boolean
  tone?: "default" | "muted" | null
  dimmed?: boolean
  interactive?: boolean
  class?: HTMLAttributes["class"]
}>()

const delegatedProps = reactiveOmit(props, "class", "size", "tabular", "tone", "dimmed", "interactive")
</script>

<template>
  <Primitive
    data-slot="badge"
    :data-variant="variant"
    :class="cn(badgeVariants({ variant, size, tabular, tone, dimmed, interactive } as never), props.class)"
    v-bind="delegatedProps"
  >
    <slot />
  </Primitive>
</template>
