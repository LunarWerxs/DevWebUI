<script setup lang="ts">
import type { DialogOverlayProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import ModalOverlay from "../dialog/ModalOverlay.vue"

const props = defineProps<DialogOverlayProps & { class?: HTMLAttributes["class"] }>()
</script>

<template>
  <ModalOverlay
    v-bind="props"
    slot-name="sheet-overlay"
    base-class="bg-black/50 fixed inset-0 z-50 duration-100 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
  >
    <slot />
  </ModalOverlay>
</template>
