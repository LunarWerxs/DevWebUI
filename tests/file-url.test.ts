// file:// URLs become local paths in two places (the .devwebui loader and the source-frame links).
// Both must share one drive-letter rule from shared/file-url.ts, so they agree on every drive form.
import { expect, test } from "bun:test";
import { drivePathFromUrlPath } from "../shared/file-url";
import { frameFilePath } from "../shared/source-frames";
import { fileUrlToLocalPath } from "../server/src/projects/load-target";

test("a URL drive form loses its leading slash, a plain path passes through", () => {
  expect(drivePathFromUrlPath("/D:/x y/a.ts")).toBe("D:/x y/a.ts");
  expect(drivePathFromUrlPath("/home/me/a.ts")).toBe("/home/me/a.ts");
});

test("the loader and the source-frame links resolve a drive file:// URL the same way", () => {
  expect(fileUrlToLocalPath("file:///D:/x%20y/a.devwebui")).toBe("D:/x y/a.devwebui");
  expect(frameFilePath("file:///C:/x%20y/a.ts")).toBe("C:/x y/a.ts");
});
