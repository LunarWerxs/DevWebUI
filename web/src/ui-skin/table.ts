// The table's text sizes and colours in this app: components/ui/table builds its variant tables from them.
export const table = "text-xs"
// The hover is the row hover, a step above a tinted row's muted fill.
export const row = "hover:bg-muted/50 data-[state=selected]:bg-muted border-b transition-colors has-aria-expanded:bg-muted/50"
export const rowVariant = {
  default: "",
  tinted: "bg-muted/40 hover:bg-muted/40",
  dimmed: "opacity-60",
  faded: "opacity-25 hover:bg-transparent transition-opacity",
}
export const cellSize = { default: "", xs: "text-xs", sm: "text-sm" }
export const muted = "text-muted-foreground"
export const head = "text-foreground"

// The colour and text-size parts of the table's other elements; each component keeps its layout.
export const caption = "text-muted-foreground text-xs"
export const footer = "bg-muted/50"
export const stickyHeader = "bg-card"
export const emptyCell = "text-sm text-foreground"
