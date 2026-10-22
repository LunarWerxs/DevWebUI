<script setup lang="ts">
// Wrap a single interactive element (a button, a toggle item, a menu trigger) in a
// hover/focus tooltip without replacing it. The trigger goes in the default slot and
// must be exactly ONE root element — it's forwarded with `as-child`, so the tooltip's
// listeners/aria merge straight onto your element (no extra DOM wrapper, so things like
// ToggleGroup rounding and roving focus keep working). Pass copy via the `label` prop,
// or richer markup via the #label slot. Needs a <TooltipProvider> ancestor (mounted
// once at the App root). For plain icon buttons, prefer IconButton.vue instead.
import { nextTick, ref } from "vue";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

withDefaults(
  defineProps<{
    label?: string;
    side?: "top" | "right" | "bottom" | "left";
    sideOffset?: number;
  }>(),
  { side: "bottom" },
);

// A list renders one Hint per row, so the tooltip root mounts on first interest, not with the row. Until then the
// trigger renders bare inside a display:contents span (no box, so the layout is unchanged) that carries the
// listeners; the first hover, press, focus or key arms the tooltip around the same element.
const armed = ref(false);
const wrapper = ref<HTMLElement>();

function arm() {
  if (armed.value) return;
  const hadFocus = !!wrapper.value?.contains(document.activeElement);
  armed.value = true;
  // Mounting the tooltip re-mounts the trigger, which drops focus; hand it back to the new element.
  if (hadFocus) nextTick(() => (wrapper.value?.firstElementChild as HTMLElement | null)?.focus());
}
</script>

<template>
  <span ref="wrapper" class="contents" @pointerover="arm" @pointerdown="arm" @focusin="arm" @keydown="arm">
    <Tooltip v-if="armed">
      <TooltipTrigger as-child>
        <slot />
      </TooltipTrigger>
      <TooltipContent :side="side" :side-offset="sideOffset">
        <slot name="label">{{ label }}</slot>
      </TooltipContent>
    </Tooltip>
    <slot v-else />
  </span>
</template>
