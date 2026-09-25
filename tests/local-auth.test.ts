// Contract for opt-in local API auth (server/src/local-auth.ts + http/pairing-routes.ts): with
// requireAuth on, /api/* refuses a caller with no credential, accepts the cookie file the CLI and
// MCP shim send, and lets a browser in only after the OTP pairing handshake - until revoked.
// Drives a REAL Hono app over a REAL Manager with app.request, the house pattern.
import "./isolate"; // CWD-proof data-dir isolation - must load before any server/src import
import { afterEach, expect, test } from "bun:test";
import { createApp } from "../server/src/http";
import { Manager } from "../server/src/manager";
import {
  PAIRED_COOKIE,
  readCookieFile,
  resetPairingState,
  withLocalAuth,
  writeCookieFile,
} from "../server/src/local-auth";
import { ROUTES } from "../shared/routes";

const JSON_HEADERS = { "content-type": "application/json" };

function newApp(requireAuth: boolean) {
  const manager = new Manager();
  manager.monitorResources = false;
  manager.applyMonitorResources();
  return { app: createApp(manager, { requireAuth }), manager };
}

afterEach(() => resetPairingState());

test("enforcing daemon: no credential is refused, health stays open, cookie file gets in", async () => {
  writeCookieFile();
  const { app, manager } = newApp(true);
  try {
    expect((await app.request(ROUTES.processes)).status).toBe(401);
    expect((await app.request(ROUTES.health)).status).toBe(200);
    expect(readCookieFile()).toMatch(/^__cookie__:[0-9a-f]{64}$/);
    expect((await app.request(ROUTES.processes, withLocalAuth())).status).toBe(200);
    const wrong = { headers: { authorization: `Basic ${btoa("__cookie__:nope")}` } };
    expect((await app.request(ROUTES.processes, wrong)).status).toBe(401);
  } finally {
    manager.dispose();
  }
});

test("non-enforcing daemon keeps the open-on-loopback behaviour", async () => {
  const { app, manager } = newApp(false);
  try {
    expect((await app.request(ROUTES.processes)).status).toBe(200);
  } finally {
    manager.dispose();
  }
});

test("pairing: code only via an authorized caller, right code earns a revocable cookie", async () => {
  writeCookieFile();
  const { app, manager } = newApp(true);
  try {
    const status = await (await app.request(ROUTES.pairingStatus)).json();
    expect(status).toEqual({ required: true, authorized: false });

    const req = await app.request(ROUTES.pairingRequest, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ label: "test browser" }),
    });
    const reqBody = await req.text();
    expect(reqBody).not.toContain('"code"'); // the requester never learns the code itself
    const { requestId } = JSON.parse(reqBody) as { requestId: string };

    // The code list is behind auth: an unpaired caller cannot read its own code back.
    expect((await app.request(ROUTES.pairingCodes)).status).toBe(401);
    const codes = (await (await app.request(ROUTES.pairingCodes, withLocalAuth())).json()) as {
      requestId: string;
      code: string;
    }[];
    const code = codes.find((p) => p.requestId === requestId)?.code ?? "";
    expect(code).toMatch(/^\d{6}$/);

    const wrongCode = code === "000000" ? "111111" : "000000";
    const bad = await app.request(ROUTES.pairingVerify, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ requestId, code: wrongCode }),
    });
    expect(bad.status).toBe(403);

    const ok = await app.request(ROUTES.pairingVerify, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ requestId, code }),
    });
    expect(ok.status).toBe(200);
    const setCookie = ok.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${PAIRED_COOKIE}=`);
    expect(setCookie).toContain("HttpOnly");
    const { clientId } = (await ok.json()) as { clientId: string };
    const cookie = { headers: { cookie: setCookie.split(";")[0]! } };
    expect((await app.request(ROUTES.processes, cookie)).status).toBe(200);

    // A code is single-use.
    const replay = await app.request(ROUTES.pairingVerify, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ requestId, code }),
    });
    expect(replay.status).toBe(403);

    const revoke = await app.request(
      ROUTES.pairingClient.build(clientId),
      withLocalAuth({ method: "DELETE" }),
    );
    expect(revoke.status).toBe(200);
    expect((await app.request(ROUTES.processes, cookie)).status).toBe(401);
  } finally {
    manager.dispose();
  }
});
