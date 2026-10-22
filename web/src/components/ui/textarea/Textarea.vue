<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { useVModel } from "@vueuse/core"
import { cn } from "@ui-skin/cn"
import { textareaVariants } from "./textarea-variants"

// The variant names are textarea-variants.ts's table, typed here as literal unions.
const props = defineProps<{
  class?: HTMLAttributes["class"]
  defaultValue?: string | number
  modelValue?: string | number
  variant?: "default" | "mono" | null
  textSize?: "default" | "2xs" | "xs" | "ui" | null
  density?: "default" | "compact" | null
  trailing?: "none" | "action" | "actions" | null
}>()

const emits = defineEmits<{
  (e: "update:modelValue", payload: string | number): void
}>()

const modelValue = useVModel(props, "modelValue", emits, {
  passive: true,
  defaultValue: props.defaultValue,
})
</script>

<template>
  <textarea
    v-model="modelValue"
    data-slot="textarea"
    :data-variant="variant"
    :class="cn(textareaVariants({ variant, textSize, density, trailing }), props.class)"
  />
</template>
