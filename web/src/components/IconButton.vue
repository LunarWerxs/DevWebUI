<script setup lang="ts">
// Shared icon button: a shadcn Button (icon size by default) wrapped in a Tooltip.
// Put the icon in the slot; @click and other attrs fall through to the Button.
// Needs a <TooltipProvider> ancestor (mounted once at the App root).
import { nextTick, ref } from "vue";
import { Button, type ButtonVariants } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

defineOptions({ inheritAttrs: false });
const props = withDefaults(
  defineProps<{
    tooltip?: string;
    variant?: ButtonVariants["variant"];
    size?: ButtonVariants["size"];
  }>(),
  { variant: "ghost", size: "icon-sm" },
);

// Icon buttons sit in every row, so the tooltip root mounts on first hover, press, focus or key, not with the row.
const armed = ref(false);
const button = ref<{ $el: HTMLElement }>();

function arm() {
  if (armed.value || !props.tooltip) return;
  const hadFocus = !!button.value?.$el.contains(document.activeElement);
  armed.value = true;
  // Mounting the tooltip re-mounts the button, which drops focus; hand it back to the new element.
  if (hadFocus) nextTick(() => button.value?.$el.focus());
}
</script>

<template>
  <Tooltip v-if="tooltip && armed">
    <TooltipTrigger as-child>
      <Button ref="button" :variant="variant" :size="size" :aria-label="tooltip" v-bind="$attrs"><slot /></Button>
    </TooltipTrigger>
    <TooltipContent>{{ tooltip }}</TooltipContent>
  </Tooltip>
  <Button
    v-else
    ref="button"
    :variant="variant"
    :size="size"
    :aria-label="tooltip"
    v-bind="$attrs"
    @pointerover="arm"
    @pointerdown="arm"
    @focusin="arm"
    @keydown="arm"
  ><slot /></Button>
</template>
