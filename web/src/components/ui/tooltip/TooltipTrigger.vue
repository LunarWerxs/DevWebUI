<script setup lang="ts">
import type { TooltipTriggerProps } from "reka-ui"
import { reactiveOmit } from "@vueuse/core"
import { TooltipTrigger } from "reka-ui"
import type { FunctionalComponent, VNode } from "vue"
import { cloneVNode, Comment, computed, Fragment, h, inject, onBeforeUnmount, onMounted, ref, useAttrs } from "vue"
import { TOOLTIP_LAZY_KEY } from "./lazy"
import type { TooltipTouchMode } from "./touch"
import { swallowNextClick, TOOLTIP_TOUCH_KEY } from "./touch"
import { useTooltipTriggerGesture } from "./trigger-gesture"

const props = withDefaults(
  defineProps<
    TooltipTriggerProps & {
      /**
       * Which finger gesture reveals this tooltip (see touch.ts). The default long press keeps a
       * single tap doing what it always did — running the control's action — so no tooltip turns a
       * one-tap button into a two-tap one. Use `"tap"` only where a click does nothing anyway, e.g.
       * an info icon whose text has no other surface.
       */
      touch?: TooltipTouchMode
    }
  >(),
  { touch: "long-press" },
)

const attrs = useAttrs()
// Under a LazyTooltip that has not armed yet there is no reka root to trigger from. The gesture still runs here,
// and a long press (or a tap, in tap mode) arms the LazyTooltip, which reveals the text once it has mounted.
const lazy = inject(TOOLTIP_LAZY_KEY, null)
const lazyClosed = computed(() => lazy?.closed.value === true)
const trigger = ref<{ $el: unknown } | null>(null)
const { suppressNativeHold, endGesture, onPointerDown, onPointerMove, onPointerUp, onContextMenu } =
  useTooltipTriggerGesture(props, trigger)

// The LazyTooltip that armed on this long press has just mounted this trigger. The finger is still on the
// node the gesture started on (now gone), so the reveal and the hold are settled here, on the new node.
const touchCtx = inject(TOOLTIP_TOUCH_KEY, null)
onMounted(() => {
  if (!lazy?.takeReveal()) return
  const el = trigger.value?.$el
  if (!(el instanceof HTMLElement)) return
  touchCtx?.revealByTouch(el)
  touchCtx?.endHold()
  swallowNextClick(el)
})

onBeforeUnmount(endGesture)

const forwarded = reactiveOmit(props, "touch")

/** The first real element the slot renders, looking through fragments and comments the way reka's as-child does. */
function firstElement(nodes: VNode[]): VNode | undefined {
  for (const node of nodes) {
    if (node.type === Comment) continue
    if (node.type === Fragment && Array.isArray(node.children)) {
      const inner = firstElement(node.children as VNode[])
      if (inner) return inner
      continue
    }
    return node
  }
  return undefined
}

/**
 * The trigger before its LazyTooltip arms: the slot's own element, carrying what reka's trigger would put on it, so the
 * bare icon reads and behaves like a closed trigger (data-state, touch gesture) with no reka root behind it.
 */
const BareTrigger: FunctionalComponent<{ attrs: Record<string, unknown>, asChild: boolean, tag: string }> = (bare, { slots }) => {
  const nodes = slots.default?.() ?? []
  // Without as-child reka renders its own element around the slot; the bare trigger does the same, so nothing shifts on arming.
  if (!bare.asChild) return h(bare.tag, bare.tag === "button" ? { type: "button", ...bare.attrs } : bare.attrs, nodes)
  const target = firstElement(nodes)
  return target ? cloneVNode(target, bare.attrs) : nodes
}
// Declared, so the template's kebab-case `as-child` reaches `bare.asChild` and the rest do not fall through as attributes.
BareTrigger.props = ["attrs", "asChild", "tag"]

// `as-child` as written on the tag: a bare attribute reads "" and counts as true, like reka's own boolean prop.
const bareAsChild = computed(() => {
  const value: unknown = props.asChild ?? attrs.asChild ?? attrs["as-child"]
  return value === true || value === ""
})

const bareAttrs = computed(() => ({
  "data-slot": "tooltip-trigger",
  "data-state": "closed",
  class: { "select-none [-webkit-touch-callout:none]": suppressNativeHold.value },
  onPointerdown: onPointerDown,
  onPointermove: onPointerMove,
  onPointerup: onPointerUp,
  onPointercancel: endGesture,
  onContextmenu: onContextMenu,
}))
</script>

<template>
  <BareTrigger v-if="lazyClosed" :attrs="bareAttrs" :as-child="bareAsChild" :tag="typeof props.as === 'string' ? props.as : 'button'">
    <slot />
  </BareTrigger>
  <TooltipTrigger
    v-else
    ref="trigger"
    data-slot="tooltip-trigger"
    v-bind="forwarded"
    :class="{ 'select-none [-webkit-touch-callout:none]': suppressNativeHold }"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="endGesture"
    @contextmenu="onContextMenu"
  >
    <slot />
  </TooltipTrigger>
</template>
