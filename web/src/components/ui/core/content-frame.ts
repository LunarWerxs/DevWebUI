import { reactiveOmit } from "@vueuse/core"
import { usePortalTo } from "./portal-to"

// What a content part (dialog, sheet) hands on to reka-ui, its own props left off, and the root its overlay portals
// to (portal-to.ts). Each part forwards its own emits with these props (useForwardPropsEmits).
export function useContentFrame<T extends object, K extends keyof T>(props: T, ...ownProps: K[]) {
  return { delegatedProps: reactiveOmit(props, ...ownProps), portalTo: usePortalTo() }
}
