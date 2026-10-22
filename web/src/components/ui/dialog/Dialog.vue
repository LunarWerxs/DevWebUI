<script setup lang="ts">
import type { DialogRootEmits, DialogRootProps } from "reka-ui"
import { useForwardPropsEmits } from "reka-ui"
import DialogRootShell from "./DialogRootShell.vue"

// Declared here, not only passed through, so a caller's `@update:open` handler is typed.
const props = defineProps<DialogRootProps>()
const emits = defineEmits<DialogRootEmits>()
const forwarded = useForwardPropsEmits(props, emits)
</script>

<template>
  <DialogRootShell
    v-slot="slotProps"
    v-bind="forwarded"
    data-slot="dialog"
  >
    <slot v-bind="slotProps" />
  </DialogRootShell>
</template>
