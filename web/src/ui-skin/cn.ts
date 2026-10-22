// The class merge for this app's look: the kit's components and lib/utils read it through @ui-skin. This is the
// default skin's, shadcn's merge, told the kit's own type steps and roles (styles/base.css): tailwind-merge reads an
// unknown text-* as a colour, so `text-caption text-muted-foreground` would lose one of the two.
import { type ClassValue, clsx } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

const twMerge = extendTailwindMerge({
  extend: { theme: { text: ["3xs", "2xs", "ui", "caption", "hint", "label"] } },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
