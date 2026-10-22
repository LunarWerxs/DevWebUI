<script setup lang="ts">
import type { DialogContentEmits, DialogContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import {
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  useForwardPropsEmits,
} from "reka-ui"
import { cn } from "@ui-skin/cn"
import * as skin from "@ui-skin/dialog"
import { useContentFrame } from "../core/content-frame"

defineOptions({
  inheritAttrs: false,
})

const props = defineProps<DialogContentProps & { class?: HTMLAttributes["class"], flush?: boolean }>()
const emits = defineEmits<DialogContentEmits>()

const { delegatedProps, portalTo } = useContentFrame(props, "class", "flush")
const forwarded = useForwardPropsEmits(delegatedProps, emits)
const labels = skin.useLabels()
</script>

<template>
  <DialogPortal :to="portalTo">
    <DialogOverlay
      class="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/50 pe-(--content-inset-right,0px) data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
    >
      <DialogContent
        :class="cn('relative z-50 grid w-full max-w-lg my-8 gap-4 border border-border p-6 shadow-lg duration-200 sm:rounded-lg md:w-full', skin.scrollContent, flush && 'gap-0 p-0', props.class)"
        :data-flush="flush ? '' : undefined"
        v-bind="{ ...$attrs, ...forwarded }"
        @pointer-down-outside="(event) => {
          const originalEvent = event.detail.originalEvent;
          const target = originalEvent.target as HTMLElement;
          if (originalEvent.offsetX > target.clientWidth || originalEvent.offsetY > target.clientHeight) {
            event.preventDefault();
          }
        }"
      >
        <slot />

        <DialogClose
          :class="cn('absolute top-4 right-4 p-0.5 transition-colors rounded-md', skin.scrollClose)"
        >
          <skin.CloseIcon class="size-4" />
          <span class="sr-only">{{ labels.close }}</span>
        </DialogClose>
      </DialogContent>
    </DialogOverlay>
  </DialogPortal>
</template>
