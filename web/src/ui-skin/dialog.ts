// The dialog's look in this app: components/ui/dialog reads it through the @ui-skin alias and keeps the layout itself.
export { XIcon as CloseIcon } from "@lucide/vue"

export const content = "bg-popover text-popover-foreground ring-foreground/10 text-xs/relaxed"
export const description = "text-muted-foreground *:[a]:hover:text-foreground text-xs/relaxed"
export const scrollContent = "bg-background"
export const scrollClose = "hover:bg-secondary"
export { title, useLabels } from "./overlay-labels"
