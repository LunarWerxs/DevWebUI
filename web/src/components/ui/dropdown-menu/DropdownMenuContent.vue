<script setup lang="ts">
import type { DropdownMenuContentEmits, DropdownMenuContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import {
  DropdownMenuContent,
  DropdownMenuPortal,
  useForwardPropsEmits,
} from "reka-ui"
import { cn } from "@ui-skin/cn"
import * as skin from "@ui-skin/dropdown-menu"
import { usePortalTo } from "../core/portal-to"

defineOptions({
  inheritAttrs: false,
})

// A cap on the menu's width, for menus whose rows carry long names; the menu still shrinks to fit shorter ones.
const widths = {
  sm: "max-w-52",
  md: "max-w-56",
  lg: "max-w-64",
} as const

const props = withDefaults(
  defineProps<DropdownMenuContentProps & { class?: HTMLAttributes["class"], width?: "sm" | "md" | "lg" }>(),
  {
    align: "start",
    sideOffset: 4,
  },
)
const emits = defineEmits<DropdownMenuContentEmits>()

const delegatedProps = reactiveOmit(props, "class", "width")

const forwarded = useForwardPropsEmits(delegatedProps, emits)
// Where the overlay portals to: the body, or the root an ancestor provides (core/portal-to.ts).
const portalTo = usePortalTo()
</script>

<template>
  <!-- Width is deliberately NOT bound to `--reka-dropdown-menu-trigger-width`: a menu should be as wide as its widest
       ITEM, not as wide as whatever opened it. Most triggers are icon buttons, so that binding pinned every menu to the
       `min-w-32` floor and wrapped every label. Unset, the popper shrink-to-fits and still respects the viewport width;
       `width` caps it, and a caller that wants a fixed width passes one through `class`. -->
  <DropdownMenuPortal :to="portalTo">
    <DropdownMenuContent
      data-slot="dropdown-menu-content"
      v-bind="{ ...$attrs, ...forwarded }"
      :class="cn('data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 min-w-32 rounded-lg p-1 shadow-md ring-1 duration-100 cn-menu-translucent z-50 max-h-(--reka-dropdown-menu-content-available-height) max-w-(--reka-dropdown-menu-content-available-width) origin-(--reka-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto data-[state=closed]:overflow-hidden', skin.content, width && widths[width], props.class)"
    >
      <slot />
    </DropdownMenuContent>
  </DropdownMenuPortal>
</template>
