# Security Policy

DevWebUI runs on your own machine, but it can do a lot from there: it starts and stops processes
with the commands in your `.devwebui` files, serves its GUI and REST API from a local daemon,
routes `*.localhost` names to your dev servers, runs an MCP server that AI agents can call, opens
files in your editor, downloads and installs its own updates, and can sign in with a LunarWerx
Connections account for settings sync. A bug in any of those could let a web page or another
program run commands on your machine, so we want to hear about it.

## Reporting a vulnerability

If you find a security issue (a web page or another program reaching DevWebUI's daemon or MCP tools, a way
to make it run a command it was not told to run, an update that could be swapped for something
else, a sign-in or token leaking, or anything else that looks exploitable) **please report it privately** rather than
opening a public issue, so it can be fixed before it's disclosed:

- **Preferred:** GitHub's private
  **[Report a vulnerability](https://github.com/LunarWerxs/DevWebUI/security/advisories/new)**
  (the repository's *Security, Advisories* tab), or
- open a normal issue **asking us to contact you** (don't include the exploit details there), or
- message the maintainers on [Discord](https://discord.gg/PsWpeNUzhk) and ask for a private
  channel.

Please include:

- what triggers it (the steps, request or `.devwebui` file, or a link to it),
- the **DevWebUI version** and your **operating system**, and
- what you observed (what was reachable, run, leaked or changed).

We'll acknowledge within a few days and keep you updated through to a fix and release.

## Supported versions

The **latest release** is the supported version, so please update and confirm the issue still
reproduces before reporting.

Thank you for helping keep DevWebUI users safe.
