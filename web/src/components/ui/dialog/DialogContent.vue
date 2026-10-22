<script setup lang="ts">
import type { DialogContentEmits, DialogContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import {
  DialogClose,
  DialogContent,
  DialogPortal,
  useForwardPropsEmits,
} from "reka-ui"
import { cn } from "@ui-skin/cn"
import * as skin from "@ui-skin/dialog"
import { Button } from "../button"
import { useContentFrame } from "../core/content-frame"
import DialogOverlay from "./DialogOverlay.vue"

defineOptions({
  inheritAttrs: false,
})

const props = withDefaults(defineProps<DialogContentProps & { class?: HTMLAttributes["class"], showCloseButton?: boolean, flush?: boolean, elevated?: boolean }>(), {
  showCloseButton: true,
})
const emits = defineEmits<DialogContentEmits>()

const { delegatedProps, portalTo } = useContentFrame(props, "class", "flush", "elevated")
const forwarded = useForwardPropsEmits(delegatedProps, emits)
const labels = skin.useLabels()
</script>

<template>
  <DialogPortal :to="portalTo">
    <DialogOverlay />
    <DialogContent
      data-slot="dialog-content"
      v-bind="{ ...$attrs, ...forwarded }"
      :data-flush="flush ? '' : undefined"
      :class="cn('data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 grid max-w-[calc(100%-2rem)] gap-4 rounded-xl p-4 ring-1 duration-100 sm:max-w-sm fixed top-1/2 left-[calc(50%-var(--content-inset-right,0px)/2)] z-50 w-full max-h-[calc(100dvh-2rem)] overflow-y-auto -translate-1/2 outline-none', skin.content, flush && 'gap-0 p-0', elevated && 'shadow-xl', props.class)"
    >
      <slot />

      <DialogClose
        v-if="showCloseButton"
        data-slot="dialog-close"
        as-child
      >
        <Button variant="ghost" class="absolute top-2 right-2" size="icon-sm" :title="labels.close" :aria-label="labels.close">
          <skin.CloseIcon />
          <span class="sr-only">{{ labels.close }}</span>
        </Button>
      </DialogClose>
    </DialogContent>
  </DialogPortal>
</template>
