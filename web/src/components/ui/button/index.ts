import type { ButtonVariants } from "@ui-skin/button"
import type { PrimitiveProps } from "reka-ui"
import type { DefineComponent, HTMLAttributes } from "vue"
import ButtonBase from "./Button.vue"

// The one Button, typed with this app's variant and size names (its skin's buttonVariants).
export const Button = ButtonBase as unknown as DefineComponent<PrimitiveProps & ButtonVariants & { class?: HTMLAttributes["class"] }>
export type { ButtonVariants } from "@ui-skin/button"
export { buttonVariants } from "@ui-skin/button"
