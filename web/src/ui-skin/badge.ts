// The badge's colours and text sizes in this app: components/ui/badge builds its variant table from them.
export const base = "text-3xs focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40"
export const variant = {
  default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
  secondary: "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
  destructive: "bg-destructive/10 [a]:hover:bg-destructive/20 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 text-destructive dark:bg-destructive/20",
  primary: "bg-primary/10 text-primary dark:bg-primary/20",
  success: "bg-success/10 text-success dark:bg-success/20",
  warning: "bg-warning/10 text-warning dark:bg-warning/20",
  info: "bg-info/10 text-info dark:bg-info/20",
  outline: "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground bg-input/20 dark:bg-input/30",
  ghost: "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
  link: "text-primary underline-offset-4 hover:underline",
  muted: "border-border bg-muted text-muted-foreground",
}
export const size = { default: "", sm: "px-1", md: "text-xs" }
export const tone = { default: "", muted: "text-muted-foreground" }
// An interactive badge's hover, by variant.
export const hover: Partial<Record<keyof typeof variant, string>> = {
  default: "hover:bg-primary/80",
  secondary: "hover:bg-secondary/80",
  destructive: "hover:bg-destructive/20 dark:hover:bg-destructive/30",
  primary: "hover:bg-primary/20 dark:hover:bg-primary/30",
  success: "hover:bg-success/20 dark:hover:bg-success/30",
  warning: "hover:bg-warning/20 dark:hover:bg-warning/30",
  info: "hover:bg-info/20 dark:hover:bg-info/30",
  outline: "hover:bg-muted hover:text-muted-foreground",
  muted: "hover:bg-muted hover:text-muted-foreground",
}
