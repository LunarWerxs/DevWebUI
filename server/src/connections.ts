// ---------------------------------------------------------------------------
// "Sync my settings with Connections" — the daemon-side Backend-for-Frontend.
//
// DevWebUI is a single-user local daemon, so the daemon IS the BFF: it runs the
// OIDC login (Authorization Code + PKCE, public client — no secret), holds the
// owner's refresh token server-side, mints access tokens, and calls the Connections
// settings-sync store (studio.connections.icu/v1/app-data/{clientId}). The browser
// never holds a token.
//
// Since 2026-07-08 the OAuth/refresh/identity machinery is the OFFICIAL SDK —
// @cnct/connect (+ @cnct/locker for the settings store) — instead of a hand-rolled
// copy: single-flight rotation-safe refresh, per-attempt redirect_uri, server-side
// revoke on forget, and id_token identity all come from the shared package. This
// module keeps only the DevWebUI-specific parts: the state file (which also carries
// the app's own sync prefs), the settings allowlist, and the sync orchestration.
//
// Because DevWebUI has no tunnel / remote mode, there is NO auth gate and NO session
// cookie: "signed in" simply means the daemon holds a refresh token.
//
// Off by default: with sync disabled (the default), nothing here runs. What syncs is a
// small ALLOWLIST of portable prefs (PREF_KEYS) + the web's appearance blob (theme).
// Never machine-specific or secret values.
//
// @cnct/connect + @cnct/locker are `optionalDependencies` (package.json), NOT statically
// imported: a public `bun install` with no LunarWerx account still boots the daemon cleanly
// even if the packages fail to install/resolve. Both are pulled in ONLY by `connect()`/
// `locker()` below, via `await import()`, which only ever runs on a path the owner actually
// triggered (sign-in, or boot's pullNow() when sync was already enabled) — never on a cold
// boot with sync off. A missing install surfaces as `SdkUnavailableError`, caught by
// `guardSync` in connections-routes.ts like any other sync failure — never a boot crash.
// ---------------------------------------------------------------------------
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "./data-dir";
import type { ConnectClient, ConnectStore, TokenSet } from "@cnct/connect";
import type { LockerClient } from "@cnct/locker";
import { readSettings, writeSettings, type Settings } from "./runtime";

/** DevWebUI's own public "Sign in with Connections" OAuth client (PKCE — no secret). Its client_id
 *  doubles as the settings-sync store `appId`, so DevWebUI's synced data is namespaced to itself. */
const OAUTH = {
  issuer: "https://accounts.connections.icu",
  clientId: "622a12e32d0b39c68f56c63316f351e5",
  scopes: ["openid", "profile", "email", "photo"],
};

/** The ONLY settings keys that sync — portable UI/behaviour prefs. Deliberately excludes
 *  machine/OS-specific state (linkHost, skip*, osSkip, scanExclude paths), the unattended
 *  `autoStartOnLaunch`, and the per-install pulse id. */
const PREF_KEYS = [
  "runtime",
  "freePortOnStart",
  "monitorResources",
  "autoScan",
] as const satisfies readonly (keyof Settings)[];

// ── persisted state (~/.devwebui/connections.json, 0600) ─────────────────────────
const stateFile = (): string => path.join(dataDir(), "connections.json");

interface ConnState {
  /** LEGACY (pre-SDK) credential slot — migrated into `sdk` on first boot, then removed. */
  refreshToken?: string;
  enabled?: boolean;
  lastSyncedAt?: string;
  version?: number;
  appearance?: Record<string, unknown>;
  identity?: { sub: string; email: string; name?: string; picture?: string };
  /** The @cnct/connect session entries (token set + in-flight PKCE), keyed by the SDK.
   *  Sensitive → this file is 0600, never committed. */
  sdk?: Record<string, string>;
}

let state: ConnState = {};
let loaded = false;

function persist(): void {
  mkdirSync(dataDir(), { recursive: true });
  const file = stateFile();
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best-effort temp cleanup */
    }
    throw e;
  }
}

// The SDK's persistence rides THIS module's state file (one 0600 JSON for everything), via a
// ConnectStore adapter over the in-memory `state` — every set/remove goes through persist().
const TOKEN_KEY = `cnx.connect.tokens.${OAUTH.clientId}`;
const stateStore: ConnectStore = {
  get: (key) => state.sdk?.[key] ?? null,
  set: (key, value) => {
    state.sdk ??= {};
    state.sdk[key] = value;
    persist();
  },
  remove: (key) => {
    if (state.sdk && key in state.sdk) {
      delete state.sdk[key];
      persist();
    }
  },
};

/** Thrown when a sync/sign-in op is attempted but @cnct/connect or @cnct/locker (both
 *  `optionalDependencies`) never installed — e.g. a public install where the optional native/
 *  peer resolution was skipped. Surfaces as a normal `guardSync` error, not a boot crash. */
class SdkUnavailableError extends Error {
  code = "sdk_unavailable";
  constructor(pkg: string, cause: unknown) {
    super(`${pkg} is not installed — Connections cloud sync is unavailable`);
    this.name = "SdkUnavailableError";
    this.cause = cause;
  }
}

let connectClient: ConnectClient | null = null;
/** The lazily-built SDK client (after initConnections loads the state file). Dynamically
 *  imports @cnct/connect — never pulled in on a boot where sync is off. The constructor
 *  redirectUri is a placeholder — every real sign-in passes the live origin per attempt. */
async function connect(): Promise<ConnectClient> {
  if (connectClient) return connectClient;
  let createConnect: typeof import("@cnct/connect").createConnect;
  try {
    ({ createConnect } = await import("@cnct/connect"));
  } catch (e) {
    throw new SdkUnavailableError("@cnct/connect", e);
  }
  connectClient = createConnect({
    clientId: OAUTH.clientId,
    issuer: OAUTH.issuer,
    scopes: OAUTH.scopes,
    redirectUri: "http://127.0.0.1/oauth/callback",
    store: stateStore,
    // Late-bound so a test harness's globalThis.fetch stub is honored even though the
    // client is memoized across calls (the SDK captures `fetch` at construction). Cast:
    // the SDK only CALLS it; Bun's `typeof fetch` also declares a `preconnect` member.
    fetch: ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args)) as typeof fetch,
  });
  return connectClient;
}

/** Load persisted sync state (incl. the credential) into memory. Call once at daemon boot. */
export function initConnections(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (existsSync(stateFile())) state = JSON.parse(readFileSync(stateFile(), "utf8")) as ConnState;
  } catch {
    state = {};
  }
  // One-time legacy migration (pre-SDK state files): the bare refreshToken moves into the SDK's
  // token entry in the SAME file, so an existing signed-in daemon stays signed in across the
  // upgrade — no re-login. expiresAt 0 forces a refresh on first use (rotation persists back
  // through the store adapter above).
  if (state.refreshToken && !state.sdk?.[TOKEN_KEY]) {
    const seed: TokenSet = { accessToken: "", refreshToken: state.refreshToken, expiresAt: 0 };
    state.sdk ??= {};
    state.sdk[TOKEN_KEY] = JSON.stringify(seed);
    delete state.refreshToken;
    persist();
  }
}

/** True when the daemon holds a Connections credential (the owner has signed in). Synchronous —
 *  reads the SDK's token entry straight from the in-memory state. */
export function hasConnection(): boolean {
  const raw = state.sdk?.[TOKEN_KEY];
  if (!raw) return false;
  try {
    const tokens = JSON.parse(raw) as TokenSet;
    return Boolean(tokens.refreshToken || tokens.accessToken);
  } catch {
    return false;
  }
}

/** Build the authorize URL for a sign-in that redirects back to `${origin}/oauth/callback`.
 *  The live origin rides the SDK's per-attempt redirectUri override (the daemon may be reached
 *  as localhost, 127.0.0.1, or a LAN IP — the callback must match whichever the browser used). */
export async function buildAuthorizeUrl(origin: string): Promise<string> {
  const client = await connect();
  return client.signIn({ redirect: false, redirectUri: `${origin}/oauth/callback` });
}

/** Complete the OIDC callback: exchange the code, persist the session, capture identity. */
export async function handleCallback(
  origin: string,
  code: string,
  stateTok: string,
): Promise<boolean> {
  try {
    const callbackUrl = `${origin}/oauth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(stateTok)}`;
    const client = await connect();
    const user = await client.handleCallback(callbackUrl);
    state.identity = {
      sub: user.sub,
      email: user.email ?? "",
      name: user.name ?? "",
      picture: user.picture ?? "",
    };
    persist();
    return true;
  } catch {
    return false;
  }
}

/** Backfill display identity (name/picture) for sessions created before those fields existed —
 *  best-effort, only when something is missing, piggybacking on calls that already network. */
async function backfillIdentity(): Promise<void> {
  if (state.identity?.name && state.identity?.picture) return;
  try {
    const client = await connect();
    const user = await client.getUser();
    state.identity = {
      sub: user.sub,
      email: user.email ?? "",
      name: user.name ?? "",
      picture: user.picture ?? "",
    };
    persist();
  } catch {
    /* identity is best-effort; syncing works without it */
  }
}

/** Dynamically imports @cnct/locker — never pulled in on a boot where sync is off. */
async function locker(): Promise<LockerClient> {
  let createLocker: typeof import("@cnct/locker").createLocker;
  try {
    ({ createLocker } = await import("@cnct/locker"));
  } catch (e) {
    throw new SdkUnavailableError("@cnct/locker", e);
  }
  return createLocker({
    appId: OAUTH.clientId,
    getToken: async () => (await connect()).getAccessToken(),
  });
}

// ── settings mapping (the allowlist) ─────────────────────────────────────────────
interface SyncDoc {
  prefs?: Record<string, unknown>;
  appearance?: Record<string, unknown>;
}

function collectPrefs(): Record<string, unknown> {
  const s = readSettings();
  const out: Record<string, unknown> = {};
  for (const k of PREF_KEYS) out[k] = s[k];
  return out;
}

/** Apply an allowlisted prefs blob to the persisted settings; returns the saved Settings (or null). */
function applyPrefs(prefs: Record<string, unknown> | undefined): Settings | null {
  if (!prefs || typeof prefs !== "object") return null;
  const patch: Partial<Settings> = {};
  for (const k of PREF_KEYS) {
    if (k in prefs) (patch as Record<string, unknown>)[k] = prefs[k];
  }
  return writeSettings(patch); // writeSettings validates each field and ignores anything off-shape
}

// ── public sync API ───────────────────────────────────────────────────────────────
export interface SyncStatus {
  enabled: boolean;
  connected: boolean;
  name: string | null;
  email: string | null;
  picture: string | null;
  lastSyncedAt: string | null;
  version: number;
  appearance: Record<string, unknown> | null;
}

export function syncStatus(): SyncStatus {
  return {
    enabled: state.enabled === true,
    connected: hasConnection(),
    name: state.identity?.name || null,
    email: state.identity?.email || null,
    picture: state.identity?.picture || null,
    lastSyncedAt: state.lastSyncedAt ?? null,
    version: state.version ?? 0,
    appearance: state.appearance ?? null,
  };
}

/** Push the current allowlisted settings to the store (deep-merge — race-free per key). */
export async function pushNow(): Promise<void> {
  const doc: SyncDoc = { prefs: collectPrefs() };
  if (state.appearance) doc.appearance = state.appearance;
  const store = await locker();
  const res = await store.merge(doc as Record<string, unknown>);
  state.version = res.version;
  state.lastSyncedAt = new Date().toISOString();
  persist();
  await backfillIdentity();
}

/** Pull remote settings and apply the allowlisted subset. Returns the applied Settings (or null). */
export async function pullNow(): Promise<{ applied: Settings | null; version: number }> {
  const store = await locker();
  const remote = await store.get();
  state.version = remote.version;
  let applied: Settings | null = null;
  if (remote.version > 0) {
    const data = (remote.settings ?? {}) as SyncDoc;
    applied = applyPrefs(data.prefs);
    if (data.appearance && typeof data.appearance === "object") state.appearance = data.appearance;
    state.lastSyncedAt = new Date().toISOString();
  }
  persist();
  await backfillIdentity();
  return { applied, version: remote.version };
}

/** Turn sync on: pull the remote doc (applying it) or seed the store from local if it's empty. */
export async function enable(
  appearance?: Record<string, unknown>,
): Promise<{ status: SyncStatus; applied: Settings | null }> {
  state.enabled = true;
  if (appearance) state.appearance = appearance;
  persist();
  let applied: Settings | null = null;
  if (hasConnection()) {
    const pulled = await pullNow();
    applied = pulled.applied;
    if (pulled.version === 0) await pushNow(); // remote empty → seed with our current settings
  }
  return { status: syncStatus(), applied };
}

/** Turn sync off. `forget` also disconnects — deletes the remote document, REVOKES the grant
 *  server-side (RFC 7009, so the refresh-token family is dead everywhere), and clears the session. */
export async function disable(forget = false): Promise<SyncStatus> {
  state.enabled = false;
  if (forget) {
    if (hasConnection()) {
      try {
        const store = await locker();
        await store.delete();
      } catch {
        /* best-effort remote wipe */
      }
      try {
        const client = await connect();
        await client.signOut({ revoke: true });
      } catch {
        /* best-effort revoke — the local credential is cleared below regardless */
      }
    }
    state.identity = undefined;
    state.appearance = undefined;
    state.version = 0;
    state.lastSyncedAt = undefined;
    state.sdk = undefined;
  }
  persist();
  return syncStatus();
}

/** The web changed appearance (theme) while synced — record it and push (if enabled). */
export async function updateAppearance(appearance: Record<string, unknown>): Promise<void> {
  state.appearance = appearance;
  persist();
  if (state.enabled && hasConnection()) await pushNow();
}

/** Sign out / disconnect fully (used by the logout route). */
export async function logout(): Promise<void> {
  await disable(true);
}
