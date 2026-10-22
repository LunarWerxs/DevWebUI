<script setup lang="ts">
import type { SelectLabelProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { SelectLabel } from "reka-ui"
import { cn } from "@ui-skin/cn"
import * as skin from "@ui-skin/select"

const props = defineProps<SelectLabelProps & { class?: HTMLAttributes["class"] }>()
</script>

<template>
  <SelectLabel
    data-slot="select-label"
    :class="cn(skin.label, 'px-2 py-1.5', props.class)"
  >
    <slot />
  </SelectLabel>
</template>
