// The one rule for turning a decoded `file://` URL pathname into a local path: `/C:/x` loses its
// leading slash, because the slash belongs to the URL, not to the Windows drive. Pure, so the
// server and the bundled web client can both use it.
/** `/D:/x` -> `D:/x`; a path without a drive form passes through unchanged. */
export function drivePathFromUrlPath(p: string): string {
  return /^\/[A-Za-z]:[\\/]/.test(p) ? p.slice(1) : p;
}
