<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@ui-skin/cn"
import type { InputVariants } from "./input-variants"
import { inputVariants } from "./input-variants"
import { useTextFieldModel } from "./use-text-field-model"

const props = defineProps<{
  defaultValue?: string | number
  modelValue?: string | number
  variant?: InputVariants["variant"]
  textSize?: InputVariants["textSize"]
  leading?: InputVariants["leading"]
  trailing?: InputVariants["trailing"]
  class?: HTMLAttributes["class"]
}>()

const emits = defineEmits<{
  (e: "update:modelValue", payload: string | number): void
}>()

const modelValue = useTextFieldModel(props, emits)
</script>

<template>
  <input
    v-model="modelValue"
    data-slot="input"
    :data-variant="variant"
    :class="cn(inputVariants({ variant, textSize, leading, trailing }), props.class)"
  >
</template>
