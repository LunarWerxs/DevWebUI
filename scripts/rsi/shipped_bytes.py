"""Committed size at HEAD of DevWebUI product code. Prints web_bytes=<n> and server_bytes=<n>.

web_bytes: web/index.html plus web/src and web/public assets that Vite bundles for the browser.
server_bytes: server/src (daemon, CLI, MCP, tray/updater helpers) plus shared/.
Not counted: tests, examples, type declarations (.d.ts/.d.mts, never run), source maps,
and server/src/dev.ts (the contributor's Vite+daemon launcher, not shipped).
"""
import subprocess

WEB_EXT = (".vue", ".ts", ".mts", ".js", ".mjs", ".css", ".html", ".svg", ".png", ".jpg", ".jpeg", ".webp",
           ".gif", ".ico", ".woff", ".woff2", ".json", ".webmanifest")
SERVER_EXT = (".ts", ".mts", ".js", ".mjs", ".json")
DECL_EXT = (".d.ts", ".d.mts", ".d.cts")
DEV_ONLY = {"server/src/dev.ts"}

listing = subprocess.run(["git", "ls-tree", "-r", "-l", "-z", "HEAD"], capture_output=True, check=True).stdout
web = 0
server = 0
for entry in listing.split(b"\0"):
    if not entry:
        continue
    meta, path = entry.decode("utf-8", "replace").split("\t", 1)
    size = meta.split()[3]
    if size == "-":
        continue
    parts = path.split("/")
    low = path.lower()
    if any(p.startswith(".") for p in parts[:-1]):
        continue
    if any(p in ("tests", "test", "__tests__", "examples") for p in parts):
        continue
    if ".test." in low or ".spec." in low or low.endswith(DECL_EXT):
        continue
    if low.endswith(".map") or low.endswith(".tsbuildinfo") or path in DEV_ONLY:
        continue
    if parts[0] == "web" and len(parts) > 1:
        rest = parts[1:]
        if rest[0] in ("src", "public") and low.endswith(WEB_EXT):
            web += int(size)
        elif rest == ["index.html"]:
            web += int(size)
    elif parts[0] in ("server", "shared") and len(parts) > 1 and parts[1] != "package.json":
        if (parts[0] == "shared" or parts[1] == "src") and low.endswith(SERVER_EXT):
            server += int(size)
print(f"web_bytes={web}")
print(f"server_bytes={server}")
