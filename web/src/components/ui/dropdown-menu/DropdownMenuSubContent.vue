<script setup lang="ts">
import type { DropdownMenuSubContentEmits, DropdownMenuSubContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import {
  DropdownMenuSubContent,
  useForwardPropsEmits,
} from "reka-ui"
import { cn } from "@ui-skin/cn"
import * as skin from "@ui-skin/dropdown-menu"

// The same width cap as DropdownMenuContent's `width`.
const widths = {
  sm: "max-w-52",
  md: "max-w-56",
  lg: "max-w-64",
} as const

const props = defineProps<DropdownMenuSubContentProps & { class?: HTMLAttributes["class"], width?: "sm" | "md" | "lg" }>()
const emits = defineEmits<DropdownMenuSubContentEmits>()

const delegatedProps = reactiveOmit(props, "class", "width")

const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <DropdownMenuSubContent
    data-slot="dropdown-menu-sub-content"
    v-bind="forwarded"
    :class="cn('data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 min-w-32 rounded-lg p-1 shadow-md ring-1 duration-100 cn-menu-translucent z-50 origin-(--reka-dropdown-menu-content-transform-origin) overflow-hidden', skin.content, width && widths[width], props.class)"
  >
    <slot />
  </DropdownMenuSubContent>
</template>
