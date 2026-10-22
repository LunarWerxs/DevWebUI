<script setup lang="ts">
import { ref } from "vue"
import * as skin from "@ui-skin/tooltip"
import LazyTooltip from "./LazyTooltip.vue"
import Tooltip from "./Tooltip.vue"
import TooltipContent from "./TooltipContent.vue"
import TooltipProvider from "./TooltipProvider.vue"
import TooltipTrigger from "./TooltipTrigger.vue"
import { tipProps } from "./tip-props"
import { useTipOff } from "./tip-off"

// A label on one control. Until the first hover, focus, press or key the tip renders only its slot (a long sidebar has
// dozens of Tips, and a closed tooltip is a dozen components); LazyTooltip mounts the real tooltip then, and replays
// the arming hover onto it so the very first hover still shows the label after its delay. The slot is the trigger
// itself (as-child); a multi-line label keeps its lines. An `eager` tip mounts the tooltip at once.
const props = defineProps(tipProps)

const open = ref(false)
const off = useTipOff(props, open)
</script>

<template>
  <TooltipProvider :delay-duration="delay" :disabled="off">
    <component :is="eager ? Tooltip : LazyTooltip" v-model:open="open">
      <TooltipTrigger as-child>
        <slot />
      </TooltipTrigger>
      <TooltipContent
        :side="side"
        :align="align"
        :side-offset="4"
        :collision-padding="8"
        :class="skin.tip"
      >
        {{ label }}
      </TooltipContent>
    </component>
  </TooltipProvider>
</template>
