"""Committed size at HEAD of DevWebUI product code. Prints web_bytes=<n> and server_bytes=<n>."""
import subprocess

WEB_EXT = (".vue", ".ts", ".mts", ".js", ".mjs", ".css", ".html", ".svg", ".png", ".jpg", ".jpeg", ".webp",
           ".gif", ".ico", ".woff", ".woff2", ".json", ".webmanifest")
SERVER_EXT = (".ts", ".mts", ".js", ".mjs", ".json")

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
    if ".test." in low or ".spec." in low or low.endswith(".d.ts") and False:
        continue
    if low.endswith(".map") or low.endswith(".tsbuildinfo"):
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
