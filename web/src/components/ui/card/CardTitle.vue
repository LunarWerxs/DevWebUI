<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@ui-skin/cn"
import * as skin from "@ui-skin/card"

const props = defineProps<{
  class?: HTMLAttributes["class"]
  size?: "default" | "lg"
  tone?: "default" | "destructive"
}>()
</script>

<template>
  <div
    data-slot="card-title"
    :class="cn('font-medium', skin.title, size === 'lg' && skin.titleLg, tone === 'destructive' && skin.titleDestructive, props.class)"
  >
    <slot />
  </div>
</template>
