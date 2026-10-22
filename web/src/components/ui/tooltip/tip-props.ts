import type { PropType } from "vue"

// The props every tip takes, so each default lives in one place.
export const tipProps = {
  label: { type: String, required: true as const },
  side: { type: String as PropType<"top" | "right" | "bottom" | "left">, default: "bottom" },
  align: { type: String as PropType<"start" | "center" | "end">, default: "center" },
  delay: { type: Number, default: 1000 },
  disabled: { type: Boolean, default: false },
  // Mount the tooltip at once instead of on the first hover. A tip that wraps a menu, or a row with tips of its own,
  // needs it: a lazy tip remounts its slot on the first gesture, which detaches a menu's anchor and loses the first
  // touch tap of a lazy tip nested inside it.
  eager: { type: Boolean, default: false },
}
