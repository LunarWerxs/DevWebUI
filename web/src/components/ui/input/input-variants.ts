import * as skin from "@ui-skin/input"
import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

export const inputVariants = cva(
  `h-7 rounded-md border px-2 py-0.5 transition-colors file:h-6 file:font-medium focus-visible:ring-2 aria-invalid:ring-2 w-full min-w-0 outline-none file:inline-flex file:border-0 file:bg-transparent disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 ${skin.base}`,
  {
    variants: {
      variant: {
        default: '',
        mono: 'font-mono',
        quiet: skin.quiet,
        numeric: 'rounded px-1.5 text-end font-medium tabular-nums [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
        swatch: 'p-1',
      },
      textSize: {
        default: '',
        xs: skin.textXs,
        ui: skin.textUi,
      },
      leading: {
        none: '',
        "icon-sm": 'ps-7',
        icon: 'ps-8',
      },
      trailing: {
        none: '',
        "icon-sm": 'pe-7',
        icon: 'pe-8',
        action: 'pe-10',
        actions: 'pe-17',
      },
    },
    defaultVariants: {
      variant: "default",
      textSize: "default",
      leading: "none",
      trailing: "none",
    },
  },
)
export type InputVariants = VariantProps<typeof inputVariants>
