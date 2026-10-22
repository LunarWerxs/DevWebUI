import type { PrimitiveProps } from "reka-ui"
import type { DefineComponent, HTMLAttributes } from "vue"
import BadgeBase from "./Badge.vue"
import type { BadgeVariants } from "./badge-variants"

// The one Badge, typed with this app's variant, size and tone names (its skin's badgeVariants).
export const Badge = BadgeBase as unknown as DefineComponent<PrimitiveProps & BadgeVariants & { class?: HTMLAttributes["class"] }>
export type { BadgeVariants } from "./badge-variants"
export { badgeVariants } from "./badge-variants"
