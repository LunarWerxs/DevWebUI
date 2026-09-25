// REST surface for local API auth (server/src/local-auth.ts): the pairing handshake a browser
// uses to earn a key, and the paired-client list the owner manages. status/request/verify are on
// local-auth's open list; codes/clients/revoke need a credential once enforcement is on, which is
// what makes the CLI (holding the cookie file) the trusted place a pairing code is shown.
import type { Context, Hono } from "hono";
import { setCookie } from "hono/cookie";
import {
  PAIRED_COOKIE,
  completePairing,
  isAuthorized,
  listPairedClients,
  pendingPairings,
  revokePairedClient,
  startPairing,
} from "../local-auth";
import { ROUTES } from "../routes";
import { type CreateAppOptions, fail, readBody } from "./core";

/** Browsers cap cookie lifetime at 400 days; revocation, not expiry, is the real off switch. */
const PAIRED_COOKIE_MAX_AGE_SECS = 400 * 24 * 60 * 60;

function handleStatus(c: Context, options: CreateAppOptions) {
  const required = options.requireAuth === true;
  return c.json({
    required,
    authorized: !required || isAuthorized(c, { trayToken: options.shutdownToken }),
  });
}

async function handleRequest(c: Context) {
  const body = await readBody(c);
  return c.json(startPairing(typeof body.label === "string" ? body.label : ""));
}

async function handleVerify(c: Context) {
  const body = await readBody(c);
  if (typeof body.requestId !== "string" || typeof body.code !== "string")
    return fail(c, "requestId and code are required");
  const result = completePairing(body.requestId, body.code);
  if (!result.ok) return fail(c, result.reason, 403);
  // HttpOnly + SameSite=Strict: page script never sees the key, and no other site can make the
  // browser send it. A cookie (not a header) because EventSource cannot set headers.
  setCookie(c, PAIRED_COOKIE, result.key, {
    httpOnly: true,
    sameSite: "Strict",
    path: "/",
    maxAge: PAIRED_COOKIE_MAX_AGE_SECS,
  });
  return c.json({ clientId: result.client.id, label: result.client.label, key: result.key });
}

function handleRevoke(c: Context) {
  const id = c.req.param("id") ?? "";
  if (!revokePairedClient(id)) return fail(c, "unknown paired client", 404);
  return c.json({ ok: true });
}

export function registerPairingRoutes(app: Hono, options: CreateAppOptions) {
  app.get(ROUTES.pairingStatus, (c) => handleStatus(c, options));
  app.post(ROUTES.pairingRequest, handleRequest);
  app.post(ROUTES.pairingVerify, handleVerify);
  app.get(ROUTES.pairingCodes, (c) => c.json(pendingPairings()));
  app.get(ROUTES.pairingClients, (c) => c.json(listPairedClients()));
  app.delete(ROUTES.pairingClient.pattern, handleRevoke);
}
