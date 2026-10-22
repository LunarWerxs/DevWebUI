<script setup lang="ts">
import type { DialogRootEmits, DialogRootProps } from "reka-ui"
import { reactiveOmit } from "@vueuse/core"
import { DialogRoot, useForwardPropsEmits } from "reka-ui"

// The one root that Dialog and Sheet share; each names its own data-slot.
const props = defineProps<DialogRootProps & { dataSlot: string }>()
const emits = defineEmits<DialogRootEmits>()
// dataSlot is bound on the root below, so it is not forwarded too (the spread would overwrite it)
const forwarded = useForwardPropsEmits(reactiveOmit(props, "dataSlot"), emits)
</script>

<template>
  <DialogRoot
    v-slot="slotProps"
    :data-slot="dataSlot"
    v-bind="forwarded"
  >
    <slot v-bind="slotProps" />
  </DialogRoot>
</template>
