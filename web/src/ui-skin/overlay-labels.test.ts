import { afterEach, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { useLabels } from "./overlay-labels";

afterEach(() => {
  i18n.global.locale.value = "en";
});

it("the popover close label follows the active locale, not a fixed English word", () => {
  i18n.global.setLocaleMessage("xx", { overlay: { close: "Schliessen" } });
  i18n.global.locale.value = "xx";

  expect(useLabels().close).toBe("Schliessen");
});
