// The alert's look in this app: components/ui/alert reads its variant table through the @ui-skin alias and keeps
// the parts that do not change (the grid, the icon column) itself.
import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

export const alertVariants = cva('grid gap-0.5 rounded-lg border px-2 py-1.5 text-left text-xs/relaxed has-data-[slot=alert-action]:relative has-data-[slot=alert-action]:pr-18 has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-1.5 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current *:[svg:not([class*=size-])]:size-3.5 group/alert relative w-full', {
  variants: {
    variant: {
      default: 'bg-card text-card-foreground',
      destructive: 'text-destructive bg-card *:data-[slot=alert-description]:text-destructive/90 *:[svg]:text-current',
      warning: 'border-warning/30 bg-warning/10 text-warning *:data-[slot=alert-description]:text-warning *:[svg]:text-current',
    },
  },
  defaultVariants: {
    variant: "default",
  },
})

export type AlertVariants = VariantProps<typeof alertVariants>

// The title and description parts: their colour and text size, the layout stays in the component.
export const title = "cn-font-heading [&_a]:hover:text-foreground"
export const description = "text-muted-foreground text-xs/relaxed [&_a]:hover:text-foreground"
