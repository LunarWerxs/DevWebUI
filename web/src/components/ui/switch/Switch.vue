<script setup lang="ts">
import type { SwitchRootEmits, SwitchRootProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import {
  SwitchRoot,
  SwitchThumb,
  useForwardPropsEmits,
} from "reka-ui"
import { cn } from "@ui-skin/cn"
import * as skin from "@ui-skin/switch"

const props = withDefaults(defineProps<SwitchRootProps & {
  class?: HTMLAttributes["class"]
  size?: "sm" | "default" | "pane"
}>(), {
  size: "default",
})

const emits = defineEmits<SwitchRootEmits>()

const delegatedProps = reactiveOmit(props, "class", "size")

const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <SwitchRoot
    v-slot="slotProps"
    data-slot="switch"
    :data-size="size"
    v-bind="forwarded"
    :class="cn(
      'focus-visible:ring-2 aria-invalid:ring-2 shrink-0 rounded-full border border-transparent data-[size=default]:h-[16.6px] data-[size=default]:w-7 data-[size=sm]:h-3.5 data-[size=sm]:w-6 data-[size=pane]:h-5 data-[size=pane]:w-9 data-[size=pane]:border-0 data-[size=pane]:p-0.5 data-[size=pane]:data-[state=unchecked]:bg-(--fill-secondary) dark:data-[size=pane]:data-[state=unchecked]:bg-(--fill-secondary) peer group/switch relative inline-flex items-center transition-colors outline-none after:absolute after:-inset-x-3 after:-inset-y-2 data-disabled:cursor-not-allowed data-disabled:opacity-50',
      skin.root,
      props.class,
    )"
  >
    <SwitchThumb
      data-slot="switch-thumb"
      :class="cn(
        'rounded-full group-data-[size=pane]/switch:size-4 group-data-[size=pane]/switch:group-data-[state=checked]/switch:translate-x-4 group-data-[size=default]/switch:size-3.5 group-data-[size=sm]/switch:size-3 group-data-[state=checked]/switch:translate-x-[calc(100%-2px)] group-data-[state=unchecked]/switch:translate-x-0 pointer-events-none block ring-0 transition-transform',
        skin.thumb,
      )"
    >
      <slot name="thumb" v-bind="slotProps" />
    </SwitchThumb>
  </SwitchRoot>
</template>
