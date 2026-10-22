import * as skin from "@ui-skin/badge"
import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

type BadgeVariant = keyof typeof skin.variant

// The badge's variant table: its layout is the kit's, the same in every app, and its colours, text sizes and hovers
// come from the app's skin (@ui-skin/badge), whose variant names are the app's own.
export const badgeVariants = cva(
  [
    "h-5 gap-1 rounded-full border border-transparent px-2 py-0.5 font-medium transition has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&>svg]:size-2.5! group/badge inline-flex w-fit shrink-0 items-center justify-center overflow-hidden whitespace-nowrap focus-visible:ring-3 [&>svg]:pointer-events-none",
    skin.base,
  ],
  {
    variants: {
      variant: skin.variant,
      size: skin.size,
      tabular: { true: "tabular-nums", false: "" },
      tone: skin.tone,
      dimmed: { true: "opacity-60", false: "" },
      interactive: { true: "cursor-pointer disabled:cursor-default disabled:opacity-70", false: "" },
    },
    compoundVariants: (Object.keys(skin.hover) as BadgeVariant[]).map((variant) => ({
      interactive: true,
      variant,
      class: skin.hover[variant],
    })),
    defaultVariants: { variant: "default", size: "default", tabular: false, tone: "default", dimmed: false, interactive: false },
  },
)
export type BadgeVariants = VariantProps<typeof badgeVariants>
