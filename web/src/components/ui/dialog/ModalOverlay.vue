<script setup lang="ts">
import type { DialogOverlayProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { DialogOverlay } from "reka-ui"
import { cn } from "@ui-skin/cn"

// The overlay Dialog and Sheet share: each passes its own data-slot name and base classes.
const props = defineProps<DialogOverlayProps & { class?: HTMLAttributes["class"], slotName: string, baseClass: string }>()
const delegatedProps = reactiveOmit(props, "class", "slotName", "baseClass")
</script>

<template>
  <DialogOverlay
    :data-slot="props.slotName"
    v-bind="delegatedProps"
    :class="cn(props.baseClass, props.class)"
  >
    <slot />
  </DialogOverlay>
</template>
