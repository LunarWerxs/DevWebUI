import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import type { Manager } from "../manager";
import { loopbackGuard } from "../loopback-guard.mjs";
import {
  allowedOrigins,
  registerRealtime,
  registerSystemRoutes,
  type CreateAppOptions,
} from "./core";
import { registerProjectRoutes } from "./project-routes";
import { registerProcessRoutes } from "./process-routes";
import { registerConnectionsRoutes } from "./connections-routes";

export function createApp(manager: Manager, options: CreateAppOptions = {}) {
  const app = new Hono();
  // CORS is scoped to the daemon's own origin(s) — see allowedOrigins(). This alone only
  // gates whether a browser lets a page READ a cross-origin response; the Origin-gate
  // below stops the mutating request from running at all. Non-browser clients (no Origin
  // header) are unaffected by either.
  app.use("/api/*", cors({ origin: allowedOrigins(options.port) }));
  // Cross-site (CSRF) guard — the shared kit primitive (server/src/loopback-guard.mjs). Rejects
  // browser cross-site requests (Sec-Fetch-Site: cross-site, or a present non-loopback Origin/Host)
  // on every /api/* verb; same-origin (GUI), same-site (dev), and non-browser (CLI/tray/MCP) pass.
  // Runs after cors so a preflight OPTIONS is answered by cors and never reaches the guard. Replaces
  // DevWebUI's former hand-rolled requireAllowedOrigin (which gated only mutating verbs); the shared
  // guard also blocks cross-site GET read-exfil.
  app.use("/api/*", loopbackGuard);

  registerRealtime(app, manager);
  registerSystemRoutes(app, manager, options);
  registerProjectRoutes(app, manager);
  registerProcessRoutes(app, manager);
  registerConnectionsRoutes(app, manager);

  // Serve the built GUI from the daemon. Resolve web/dist in BOTH shapes: dev (relative to this
  // source) and compiled (a `web/dist` shipped next to the single-file binary — see scripts/build.ts).
  const distCandidates = [
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../web/dist"),
    path.resolve(path.dirname(process.execPath), "web", "dist"),
  ];
  const dist = distCandidates.find((c) => existsSync(c));
  if (dist) {
    const root = path.relative(process.cwd(), dist);
    app.use("/assets/*", serveStatic({ root }));
    // A MISSING hashed chunk under /assets/ (a stale browser tab requesting an old chunk after a
    // rebuild/auto-update) must return a real 404 — NOT fall through to the index.html SPA fallback,
    // which hands the browser text/html for a module script ("Failed to load module script … MIME
    // type text/html"). The client recovers from the 404 via a vite:preloadError reload (see
    // web/src/main.ts). Navigation routes (no /assets/ prefix) still fall through to the SPA below.
    app.get("/assets/*", (c) => c.text("not found", 404, { "cache-control": "no-store" }));
    // Root-level public files (icon.svg / icon-light.svg / favicon.ico / logo-*.svg) must resolve
    // as real files first — without this the SPA fallback below answers the browser's favicon
    // request with index.html and the daemon-served app never shows a tab icon (the Vite dev
    // server masks the bug by serving web/public itself).
    app.use("/*", serveStatic({ root }));
    app.get("/*", serveStatic({ path: path.join(root, "index.html") }));
  }

  return app;
}
