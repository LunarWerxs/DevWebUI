// Regression: POST /browser/reply caps the answer by BYTES (256 KiB) and accepts only a JSON
// object. The old cap compared UTF-16 length, so multibyte text above the byte limit passed;
// an array body also passed the object check and reached the bridge.
import "./isolate"; // CWD-proof data-dir isolation - must load before any server/src import
import { expect, test } from "bun:test";
import { createApp } from "../server/src/http";
import { Manager } from "../server/src/manager";
import { ROUTES } from "../shared/routes";

const JSON_HEADERS = { "content-type": "application/json" };

test("browser reply: the 256 KiB cap counts bytes, so multibyte JSON over the limit gets 413", async () => {
  const manager = new Manager();
  manager.monitorResources = false;
  manager.applyMonitorResources();
  const app = createApp(manager, {});
  try {
    // 150,000 characters of 2-byte text: under 262,144 characters, but ~300 KB encoded.
    const body = JSON.stringify({ requestId: "r", tabId: "t", result: "é".repeat(150_000) });
    expect(body.length).toBeLessThan(256 * 1024);
    expect(Buffer.byteLength(body)).toBeGreaterThan(256 * 1024);
    const res = await app.request(ROUTES.browserReply, {
      method: "POST",
      headers: JSON_HEADERS,
      body,
    });
    expect(res.status).toBe(413);
  } finally {
    manager.dispose();
  }
});

test("browser reply: an array body is rejected with the JSON-object error", async () => {
  const manager = new Manager();
  manager.monitorResources = false;
  manager.applyMonitorResources();
  const app = createApp(manager, {});
  try {
    const res = await app.request(ROUTES.browserReply, {
      method: "POST",
      headers: JSON_HEADERS,
      body: "[]",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "answer is not a JSON object" });
  } finally {
    manager.dispose();
  }
});
