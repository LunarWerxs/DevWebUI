import * as skin from "@ui-skin/textarea"
import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

// The textarea's variant table: its layout is the kit's, the same in every app, and its border, fill and text sizes
// come from the app's skin (@ui-skin/textarea).
export const textareaVariants = cva(
  [
    "resize-none rounded-md border p-2 transition-colors focus-visible:ring-2 aria-invalid:ring-2 flex field-sizing-content min-h-16 w-full outline-none disabled:cursor-not-allowed disabled:opacity-50",
    skin.base,
  ],
  {
    variants: {
      variant: { default: "", mono: "font-mono" },
      textSize: skin.textSize,
      density: { default: "", compact: "py-1.5 leading-snug" },
      trailing: { none: "", action: "pe-10", actions: "pe-17" },
    },
    defaultVariants: { variant: "default", textSize: "default", density: "default", trailing: "none" },
  },
)
export type TextareaVariants = VariantProps<typeof textareaVariants>
