<script setup lang="ts">
import type { LabelProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { Label } from "reka-ui"
import { cn } from "@ui-skin/cn"
import * as skin from "@ui-skin/label"

// variant names the skin's variants table; clickable shows a pointer cursor.
const props = defineProps<LabelProps & {
  class?: HTMLAttributes["class"]
  variant?: "default" | "text" | "inline" | "mono"
  clickable?: boolean
}>()

const delegatedProps = reactiveOmit(props, "class", "variant", "clickable")
</script>

<template>
  <Label
    data-slot="label"
    v-bind="delegatedProps"
    :class="
      cn(
        'gap-2 font-medium group-data-[disabled=true]:opacity-50 peer-disabled:opacity-50 flex items-center select-none group-data-[disabled=true]:pointer-events-none peer-disabled:cursor-not-allowed',
        skin.text,
        skin.variants[variant ?? 'default'],
        clickable && 'cursor-pointer',
        props.class,
      )
    "
  >
    <slot />
  </Label>
</template>
