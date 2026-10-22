// The dropdown menu's look in this app: components/ui/dropdown-menu reads it through the @ui-skin alias and keeps the layout itself.
export { CheckIcon, ChevronRightIcon } from "@lucide/vue"

export const content = "ring-foreground/10 bg-popover text-popover-foreground"
export const item = "text-xs/relaxed focus:bg-accent focus:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:*:[svg]:text-destructive not-data-[variant=destructive]:focus:**:text-accent-foreground"
export const checkboxItem = "text-xs focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground"
export const radioItem = "text-xs focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground"
export const label = "text-muted-foreground text-xs"
export const subTrigger = "text-xs focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground"
export const shortcut = "text-muted-foreground group-focus/dropdown-menu-item:text-accent-foreground text-3xs"
