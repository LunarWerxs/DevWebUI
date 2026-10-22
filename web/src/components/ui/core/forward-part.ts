import { cn } from "@ui-skin/cn"
import type { Component, DefineComponent, HTMLAttributes, PropType } from "vue"
import { defineComponent, h } from "vue"

type ClassProp = { class?: HTMLAttributes["class"] }
// The props a reka part takes, as a template passes them.
type PropsOf<T> = T extends new (...args: never) => { $props: infer P } ? P : Record<string, unknown>

const classProp = { type: [String, Array, Object] as PropType<HTMLAttributes["class"]> }

// A kit part that is one reka part passed through: its data-slot name and base classes, the caller's class merged
// after them, and every other prop, listener and slot handed on as given. The dialog's and the sheet's title,
// description, close and trigger are each one call to this.
export function defineForwardPart<T extends Component>(part: T, slot: string, ...look: string[]) {
  return defineComponent({
    inheritAttrs: false,
    props: { class: classProp },
    setup(props, { attrs, slots }) {
      return () => h(part as Component, { ...attrs, "data-slot": slot, class: cn(...look, props.class) || undefined }, slots)
    },
  }) as unknown as DefineComponent<PropsOf<T> & ClassProp>
}

// The layout every menu row shares, a context menu's or a dropdown's; its colours are the skin's.
const MENU_ITEM =
  "min-h-7 gap-2 rounded-md px-2 py-1 data-inset:ps-7.5 [&_svg:not([class*=size-])]:size-3.5 relative flex cursor-default items-center outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0"

// A menu row: a reka menu item passed through as above, with `inset` (room for a leading icon) and the destructive
// variant as the data attributes the skin's classes read.
export function defineMenuItem<T extends Component>(part: T, slot: string, ...look: string[]) {
  return defineComponent({
    inheritAttrs: false,
    props: {
      class: classProp,
      inset: Boolean,
      variant: { type: String as PropType<"default" | "destructive">, default: "default" },
    },
    setup(props, { attrs, slots }) {
      return () =>
        h(
          part as Component,
          {
            ...attrs,
            "data-slot": slot,
            "data-inset": props.inset ? "" : undefined,
            "data-variant": props.variant,
            class: cn(MENU_ITEM, ...look, props.class),
          },
          slots,
        )
    },
  }) as unknown as DefineComponent<PropsOf<T> & ClassProp & { inset?: boolean; variant?: "default" | "destructive" }>
}
