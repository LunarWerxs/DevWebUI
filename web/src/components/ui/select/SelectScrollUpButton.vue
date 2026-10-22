<script setup lang="ts">
import type { SelectScrollUpButtonProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { SelectScrollUpButton, useForwardProps } from "reka-ui"
import { cn } from "@ui-skin/cn"
import * as skin from "@ui-skin/select"

const props = defineProps<SelectScrollUpButtonProps & { class?: HTMLAttributes["class"] }>()

const delegatedProps = reactiveOmit(props, "class")

const forwardedProps = useForwardProps(delegatedProps)
</script>

<template>
  <SelectScrollUpButton
    data-slot="select-scroll-up-button"
    v-bind="forwardedProps"
    :class="cn(skin.scrollButton, 'z-10 flex cursor-default items-center justify-center py-1 [&_svg:not([class*=size-])]:size-3.5', props.class)"
  >
    <slot>
      <skin.ChevronUpIcon />
    </slot>
  </SelectScrollUpButton>
</template>
