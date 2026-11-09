import { expect, it } from "vitest";
import * as dialog from "./dialog";
import * as sheet from "./sheet";

it("dialog and sheet read their labels from one shared owner", () => {
  expect(sheet.useLabels).toBe(dialog.useLabels);
});
