import { cn } from "@ui-skin/cn"
import type { HTMLAttributes, PropType } from "vue"
import { defineComponent, h } from "vue"

// A kit part that is one element (a div unless it names another tag): its data-slot name, its base classes, and the
// caller's class merged after them. Each part of this shape (the card's action and footer, the dialog's header, a
// menu's shortcut, the table's caption) is one call to this.
export function defineSlotBox(slot: string, base: string, tag = "div") {
  return defineComponent({
    props: {
      class: { type: [String, Array, Object] as PropType<HTMLAttributes["class"]> },
    },
    setup(props, { slots }) {
      return () => h(tag, { "data-slot": slot, class: cn(base, props.class) }, slots.default?.())
    },
  })
}
