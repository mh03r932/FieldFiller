# FieldFiller

A browser extension that fills every form control on a page with plausible dummy data in one
action, for developers and QA engineers who test forms.

**Status: feature-complete, not yet published.** A click on the toolbar button fills the page
— every control kind, native constraints honoured, hidden fields and honeypots left alone,
confirmation fields agreeing with their source, across nested frames and open shadow roots,
all from one coherent persona. `pnpm e2e` asserts each of those against a real browser, and
CI runs it on every change. All three fill scopes, the dependent-field cascade, the rule
editor, profiles, exclusions, the fill report and settings export/import are built and
tested.

What remains is release work rather than product work — store artwork, screenshots, a
published privacy policy, and a Firefox end-to-end fill. See
[Still open before release](#still-open-before-release).

Design documents live in [`docs/`](docs/): [vision](docs/vision.md),
[requirements](docs/requirements.md), [use cases](docs/use_case_catalog.md), and the
[implementation plan](docs/implementation_plan.md) that this phase order comes from.

## Getting started

```sh
pnpm install
pnpm dev              # Chrome, with hot reload
pnpm dev:firefox      # Firefox
```

```sh
pnpm compile          # typecheck (TS strict)
pnpm lint
pnpm test             # unit tests
pnpm build:all        # both targets into .output/
pnpm gate:all         # the CI gates, against the built output
pnpm smoke            # load the built extension in a real Chrome and Firefox
pnpm e2e              # fill the reference page in a real Chrome, assert what landed
```

## What CI enforces

Six gates run on every push. None of them is hygiene — each keeps a claim the project makes
publicly from quietly becoming false.

| Gate | Enforces | Why it exists from day one |
|---|---|---|
| `gate:size` | NFR-003 — page agent ≤ 40 KB minified, uncompressed | The agent runs in every frame of every page (DD-001). G6 quotes the number against the reference's 480 KB. |
| `gate:imports` | ND-4 — the page agent's import graph | Nobody decided to ship Firebase into every page; an import graph decided it. This walks the graph and rejects any package not on an allowlist. |
| `gate:network` | NFR-033, NFR-007 — no `fetch`/`XHR`/`WebSocket`/`EventSource`/`sendBeacon`, no external URL, no remote code | G3 is absolute: "no outbound request, ever." An absolute claim needs a gate. |
| `gate:permissions` | NFR-008 — the manifest requests `storage`, `contextMenus`, `scripting`, `activeTab`, and nothing else | The permission set is the first thing a store reviewer and a sceptical user read. A fifth permission should have to be argued for, not merged. |
| `gate:coverage-scope` | NFR-012 — which files are under a coverage threshold, and why each exemption exists | A coverage number falls silently when new code lands outside the measured set. This fails instead, and makes every exemption state its reason. |
| `verify:reproducible` | NFR-011, G4 — two clean builds, digests compared | The published digest is what an auditor checks. Retrofitted later, the digests simply differ with nothing to show for it. |

Browsers run in CI as well, which is NFR-014: the Chromium end-to-end fill on every change,
Firefox on release candidates. `pnpm smoke` checks that the extension installs, that Chrome
accepts all three keyboard commands, that Firefox honours the `gecko.id`, and that the page
agent reaches a page. `pnpm e2e` drives a real fill against the reference page and asserts
what landed — every control kind, the exclusions, confirmation fields, both frame kinds and an
open shadow root, all from one persona.

Both drive the browsers directly: CDP for Chrome, WebDriver BiDi for Firefox. Playwright is a
devDependency purely as a browser fetcher, because it cannot test Firefox extensions at all
and a Chromium-only harness would leave half of NFR-017's promise unverified. Run
`pnpm exec playwright install chromium` once and the harnesses locate that pinned build
themselves, so a local run and a CI run exercise the same browser.

## Layout

```
src/entrypoints/background.ts           trigger registration; owns settings and generation
src/entrypoints/page-agent.content.ts   injected everywhere; walks and applies, carries no data
src/entrypoints/options/                settings UI — rules, profiles, exclusions, export/import
src/lib/protocol.ts                     the background ↔ agent message protocol
src/lib/platform/                       modules that touch the extension API
scripts/                                the CI gates, the smoke tests, the icon generator
```

The engine boundary is load-bearing: neither half imports the other's platform. The
background side takes descriptors plus settings and returns values; the page side takes a DOM
root and returns descriptors, then takes values and applies them. Both are unit-testable
without a browser (NFR-015), and lint enforces it rather than review.

## Still open before release

- **The attribution does not reach the user yet.** `NOTICE` now carries the upstream MIT
  text and copyright line, kept distinct from our own `LICENSE` (C-009). It sits in the
  repository and not in the package: vision §8.1 asks for it to be reachable from an About
  page, and there is no About page. FR-062 is what closes this, and it is unbuilt.
- **The promo tiles have not been judged by a human.** Both exist —
  `docs/art/promo-440x280.png` and `docs/art/promo-1400x560.png`, drawn by
  [`scripts/make-promo.mjs`](scripts/make-promo.mjs) on the same committed-geometry
  basis as the icons, with the lettering set in Inter (SIL OFL, committed in
  `scripts/fonts/`) so the text cannot be misspelled. What they have not had is the
  side-by-side against the Fake Filler listings that
  [`docs/art_brief.md`](docs/art_brief.md) §2 asks for before anything ships, nor a
  plain eyeballing by anyone with taste.
- **No screenshots exist.** Both stores require at least one, and they have to be captures of
  the real extension rather than generated art. The harness is already there —
  `scripts/e2e-chrome.mjs` drives the built extension in a real Chromium — and it is a
  `page.screenshot()` away from producing them.
- **Nothing is published yet.** `PRIVACY.md` needs a public URL before the Chrome Web Store
  will take the listing, and C-014 separately wants the source public at the release tag.
  The only remote today is self-hosted.
- **The contact address is unfilled**, in `PRIVACY.md` and in the listing. Both stores
  require a working one.
- **No Firefox end-to-end fill.** `smoke:firefox` proves the add-on installs and that the
  `gecko.id` is honoured; it fills nothing. Every claim about *filling* behaviour rests on
  Chromium plus a shared source tree — which NFR-014 asks not to be the case.
- The `gecko.id` is `fieldfiller@dividbzero`, changeable until the first AMO submission and
  permanent after it (C-004).

[`docs/store_listing.md`](docs/store_listing.md) holds the listing copy, the single-purpose
statement, the permission justifications and the data disclosures for both stores, and ends
with the submission checklist these items feed.
