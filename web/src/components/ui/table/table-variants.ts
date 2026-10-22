import * as skin from "@ui-skin/table"
import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

// The table's variant tables: their layout is the kit's, the same in every app, and their text sizes and colours come
// from the app's skin (@ui-skin/table).
export const tableVariants = cva(["w-full caption-bottom", skin.table], {
  variants: {
    density: { default: "", compact: "[&_td]:px-1.5 [&_th]:px-1.5" },
    // Row height, separate from density so a compact table can also have short rows.
    rows: { default: "", dense: "[&_td]:py-1 [&_th]:h-8 [&_th]:py-0", tight: "[&_td]:py-px [&_th]:h-7" },
  },
  defaultVariants: { density: "default", rows: "default" },
})

export const tableRowVariants = cva(skin.row, {
  variants: { variant: skin.rowVariant },
  defaultVariants: { variant: "default" },
})

export const tableCellVariants = cva("p-2 align-middle whitespace-nowrap has-[[role=checkbox]]:pe-0", {
  variants: {
    size: skin.cellSize,
    align: { start: "", end: "text-end" },
    weight: { default: "", medium: "font-medium" },
    mono: { true: "font-mono", false: "" },
    numeric: { true: "tabular-nums", false: "" },
    muted: { true: skin.muted, false: "" },
    truncate: { true: "truncate", false: "" },
  },
  defaultVariants: {
    size: "default",
    align: "start",
    weight: "default",
    mono: false,
    numeric: false,
    muted: false,
    truncate: false,
  },
})

// A header cell's width and alignment. `measured` takes the width a table hands its columns as --col-w; a fixed
// width (a status dot's column, a number column) or `grow` (the name column that takes what is left) replaces it.
export const tableHeadVariants = cva(
  [skin.head, "h-10 px-2 text-start align-middle font-medium whitespace-nowrap has-[[role=checkbox]]:pe-0"],
  {
    variants: {
      width: {
        auto: "",
        measured: "w-(--col-w)",
        grow: "w-full min-w-36",
        "10": "w-10",
        "12": "w-12",
        "16": "w-16",
        "20": "w-20",
        "24": "w-24",
        "32": "w-32",
        "48": "w-48",
      },
      align: { start: "", end: "text-end" },
    },
    defaultVariants: { width: "auto", align: "start" },
  },
)

export type TableVariants = VariantProps<typeof tableVariants>
export type TableRowVariants = VariantProps<typeof tableRowVariants>
export type TableCellVariants = VariantProps<typeof tableCellVariants>
export type TableHeadVariants = VariantProps<typeof tableHeadVariants>
