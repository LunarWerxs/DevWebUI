<script setup lang="ts">
import type { PrimitiveProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { Primitive } from "reka-ui"
import { buttonVariants } from "@ui-skin/button"
import { cn } from "@ui-skin/cn"

// The variant and size names are the app's own (its skin's buttonVariants); index.ts types them for callers.
interface Props extends PrimitiveProps {
  variant?: string | null
  size?: string | null
  class?: HTMLAttributes["class"]
}

const props = withDefaults(defineProps<Props>(), {
  as: "button",
})
</script>

<template>
  <Primitive
    data-slot="button"
    :data-variant="variant"
    :data-size="size"
    :as="as"
    :as-child="asChild"
    :class="cn(buttonVariants({ variant, size } as never), props.class)"
  >
    <slot />
  </Primitive>
</template>
