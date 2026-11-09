// The labels and title every popover surface (dialog, sheet) shares. dialog.ts and sheet.ts re-export these, so this
// module is the one owner of them. The labels go through the app's i18n, so they follow the app's language.
import { t } from "@/i18n";

export const title = "text-sm";

/** The words the popover surfaces say, in this app's language. */
export function useLabels() {
  return { close: t("overlay.close") };
}
