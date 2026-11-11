// The sheet's look in this app: components/ui/sheet reads it through the @ui-skin alias and keeps the layout itself.
export { XIcon as CloseIcon } from "@lucide/vue"

export const content = "bg-popover text-popover-foreground text-xs/relaxed"
export const title = "text-sm"
export const description = "text-muted-foreground text-xs/relaxed"

/** The words the sheet says, in this app's language. */
export function useLabels() {
  return { close: "Close" }
}
