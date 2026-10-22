# DevWebUI licensing

From 2026-10-22 on, DevWebUI's own code is offered under the
[PolyForm Noncommercial License 1.0.0](LICENSE) (`PolyForm-Noncommercial-1.0.0`).
Copyright 2026 LunarWerx LLC, a Missouri limited liability company trading as LunarWerx Studios.

## What that means

- **Free for noncommercial use.** Running DevWebUI for yourself, a hobby, learning, research, a
  charity, a school or a government body is free, with every feature included, and so is reading,
  changing and sharing the code for those purposes. The license defines the permitted purposes and
  organizations; it governs where this summary is short.
- **Commercial use needs a separate license** from LunarWerx. That includes running it for a
  for-profit business and building it into a paid product or service. There is no price list yet:
  ask through the [commercial licence request form](https://github.com/LunarWerxs/DevWebUI/issues/new?template=licence_quote.yml) or email
  [lunawerx@gmail.com](mailto:lunawerx@gmail.com), and we will reply with terms.

This is a source-available license with a noncommercial restriction, not an open-source license.

## Earlier versions

DevWebUI 1.2.0 and every earlier release, and the source as published up to commit `f68417e`
(2026-10-22), were offered under MIT. Changing the terms of later versions does not take back what
was already granted for those copies. The original MIT notice is kept in
[LICENSES/MIT-legacy.txt](LICENSES/MIT-legacy.txt).

## Third-party material

Dependencies keep their own licenses, which travel with them in `node_modules` and in the
built app. Two pieces of DevWebUI were adapted from MIT-licensed projects: the fuzzy matcher in
`web/src/lib/fuzzy.ts` (from fzf) and the threshold alerts in `server/src/alerts.ts`,
`server/src/http/alert-routes.ts` and `shared/dto.ts` (from PostHog). Their copyright and permission
notices are in [LICENSES/third-party-MIT.txt](LICENSES/third-party-MIT.txt), and the MIT terms keep
applying to those portions. Other source comments that name a project credit an idea only; that
code was written fresh.

## Contributions

Opening a pull request means you accept the contribution terms in
[.github/CONTRIBUTING.md](.github/CONTRIBUTING.md).
