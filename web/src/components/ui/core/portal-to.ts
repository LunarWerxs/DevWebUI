import { type InjectionKey, inject } from "vue"

// Where the kit's overlays (dialog, sheet, dropdown menu, popover, select, tooltip) portal to: the body, unless an
// ancestor provides another root. An app that runs pages inside a root its styles are scoped to provides that root
// (AgentHydra's hydra screens in the window's own document), so their overlays stay inside it.
export const PORTAL_TO: InjectionKey<string | HTMLElement> = Symbol("portalTo")

export function usePortalTo(): string | HTMLElement {
  return inject(PORTAL_TO, "body")
}
