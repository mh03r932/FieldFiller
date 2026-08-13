# FieldFiller — Vision & Design Document

**Status:** Draft v0.1
**Date:** 2026-08-12
**Owner:** dividbzero
**Supersedes:** nothing (initial design)
**Feeds:** `docs/requirements.md` → `docs/use_cases.puml` → `docs/use_cases/UC-xxx.md`

---

## 1. Summary

FieldFiller is a browser extension that fills every form control on a page with plausible
dummy data in one action, for developers and QA engineers who test forms.

It is a clean-room-by-reading reimplementation of **Fake Filler** (MIT, © 2014–2020 Hussein
Shabbir), rebranded and modernised. The original's filling engine is the reference design;
its Firebase/Stripe Pro tier, its paywall, and its accumulated defects are not carried over.

The project's reason to exist beyond "another form filler" is **verifiability**: every
feature Fake Filler charges for is free here, and the shipped binary is reproducible from
public source with no network capability at all.

---

## 2. Problem

Testing a form by hand means typing into every field, every time, on every iteration. For a
30-field checkout or onboarding flow this is the single most repeated manual action in
front-end QA. Existing solutions have three problems:

| Problem | Detail |
|---|---|
| **Paywalled basics** | Fake Filler caps the free tier at 25 custom field rules and gates URL profiles and sync behind a $3.99/mo subscription. |
| **Unverifiable builds** | The published Fake Filler is **v4.1.0** (Aug 2024); the public GitHub repo stopped at **v3.4.0** (Nov 2023). The store build contains features that exist in no public source. |
| **Excessive footprint** | The published v4.1.0 content script is **480 KB and bundles the Firebase SDK** — an authentication and database client shipped into every frame of every page, by an import graph nobody audited. *(We inject on every page too, per DD-001 — the criticism is the payload's size and contents, not the injection. Our page agent is capped at 40 KB with no SDK and no data corpus.)* |

None of these are inherent to the problem. They are consequences of the original's business
model.

---

## 3. Goals

**G1 — Parity.** Match the reference implementation's filling behaviour for every input
type, matching source, and generator type. A user switching over should not notice a
capability gap.

**G2 — Free.** No accounts, no tiers, no paywall. Unlimited rules, URL profiles, and
cross-device sync for everyone.

**G3 — Zero network.** The extension makes no outbound request, ever. Not telemetry, not
error reporting, not a font. This is a design constraint, not a policy promise.

**G4 — Verifiable.** CI builds the store package from tagged public source and publishes the
artefact plus its digest, so anyone can check `sha256(store_build) == sha256(release_build)`.

**G5 — Correct.** Fix the defect class the original carries (Section 7). Ship with tests;
the reference has none.

**G6 — Small.** Page agent under 40 KB uncompressed, versus the reference's 480 KB. No data
corpus and no SDK ships into the page.

---

## 4. Non-Goals

- **No paid tier, accounts, or backend.** Decided; see Section 9 (DD-002) for the sync
  approach that replaces it.
- **No autofill of real personal data.** This is a *fake* data tool. It will not store or
  emit real names, addresses, or card numbers. Adjacent, but a different product with a
  very different threat model.
- **No form submission.** FieldFiller fills; the user submits.
- **No scraping, recording, or replay of user input.**
- **No Safari** in v1 (requires Xcode packaging and an Apple Developer account).
- **No mobile browsers.**

---

## 5. Actors

| Actor | Kind | Description |
|---|---|---|
| **Tester** | Primary, human | Developer or QA engineer. Triggers fills on pages. Uses defaults, rarely opens settings. |
| **Power User** | Primary, human | Specialises Tester. Writes custom field rules and URL profiles for the applications they test daily. |
| **Migrating User** | Primary, human | Specialises Power User. Arrives with an existing Fake Filler configuration to bring across. |
| **Auditor** | Primary, human | Privacy- or security-conscious user (or a corporate reviewer) who wants to confirm the extension does what it claims before allowing it. |
| **Browser** | Supporting, system | Supplies triggers (toolbar, commands, context menus), storage, sync transport, and the extension lifecycle. |
| **Web Page** | Supporting, system | The DOM being filled, including nested iframes and open shadow roots. Receives values and events. |

---

## 6. Scope & Architecture

### 6.1 Component model

Generation runs in the **background**, not in the page. The page agent walks and applies;
it carries no data corpus. See DD-003 (resolved) in §9 for why.

```
┌──────────────────────────────────────────────────────────────┐
│ Background (MV3 service worker / Firefox event page)         │
│  · owns the settings store (read/write chrome.storage)       │
│  · registers context menus + keyboard commands               │
│  · maps every trigger → scripting.executeScript              │
│  · broadcasts settings changes to open tabs                  │
│  · manages the toolbar badge (active profile / domain off)   │
│  ├── Matcher    → rule selection per field descriptor        │
│  ├── Persona    → one coherent fictional record per fill     │
│  └── Generators + corpus (loaded once per session)           │
└───────────────────────────┬──────────────────────────────────┘
        executeScript       │  ▲  field descriptors ── one round-trip
                            ▼  │  values + provenance
┌──────────────────────────────────────────────────────────────┐
│ Page agent (content script — small, no corpus)               │
│  · records the right-clicked element                         │
│  · resolves domain exclusion (enabled / suspended)           │
│  ├── walk     → collect fillable elements (frames, shadow DOM)│
│  ├── exclude  → disabled/readonly/hidden/prefilled/ignored   │
│  ├── identify → name, id, class, label, aria, autocomplete   │
│  └── apply    → framework-safe write + event sequence        │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│ Options UI (own page)  — rules, profiles, settings, backup   │
└──────────────────────────────────────────────────────────────┘
```

Two hard rules:

1. **Neither half imports `chrome.*`.** The page-side engine takes a DOM root and returns
   descriptors, then takes values and applies them. The background-side engine takes
   descriptors plus settings and returns values. Both are unit-testable without an extension
   host. This is the main structural departure from the reference, where `ElementFiller`
   reaches into global `document` for radio groups and label lookups (ND-5).
2. **The corpus never enters the page agent.** Measured: `@faker-js/faker` is 444 KB
   minified even when a single locale is imported — its locale data is monolithic and does
   not tree-shake. Parsing that in every frame of every page is exactly the mistake the
   reference made with Firebase (ND-4). In the background it is parsed once per session.

The field descriptors crossing that boundary contain element names, ids and label text from
the page. They never leave the device — this is an in-process message between two contexts
of the same extension, and NFR-006 (zero network) still holds absolutely.

### 6.2 In scope for v1

Filling (3 scopes × 3 trigger channels), the rule engine, URL profiles, all general
settings, export/import, Fake Filler migration, cross-device sync, and the support pages.

### 6.3 Deferred

Undo-last-fill (UC-033), locales beyond English, per-rule "test against this page",
seeded/deterministic runs for CI use, and **persona continuity across fills** — pinning one
generated person so a multi-step form receives the same identity on every step. Continuity is
deliberately *permitted* by NFR-031 and BR-004-3 so it can be added without reopening the
engine's design; it is simply not built in v1.

---

## 7. What We Learned From the Reference

### 7.1 The published build ≠ the public source

| | Public repo | Published build |
|---|---|---|
| Version | 3.4.0 (17 Nov 2023) | **4.1.0 (7 Aug 2024)** |
| `ignoreDomains` setting | absent | **present** |
| Default keyboard shortcut | `Ctrl/Cmd+Shift+F` | **removed** — user must assign one manually |
| Content script size | n/a (unbundled) | **480 KB, includes the Firebase SDK** |
| Service worker size | 183 LOC | 394 KB (Firestore bundled) |
| Options bundle | n/a | 1.04 MB |

Verified by downloading and unpacking `fake_filler-4.1.0.xpi` from addons.mozilla.org
(11.4k users, 4.29★ / 80 ratings) and diffing its `_locales/en/messages.json` and bundles
against the repo at `36daf90`.

**Design consequence:** the research document's feature list was one release stale.
`ignoreDomains` is a real, shipped feature and is in scope (UC-021, FR-028). Treat the public
repo as a blueprint, never as a specification.

### 7.2 Defects present in the shipped v4.1.0

Each was found in the MIT source and then confirmed in the published bundle. These are the
concrete quality delta the clone can claim.

| # | Defect | Effect | Ours |
|---|---|---|---|
| D1 | Label text is read as `innerHTML`, then stripped of non-alphanumerics | `<label><span>Email</span></label>` matches as `spanemailspan` — HTML tag names pollute the match string, so a rule matching `/span/` fires on every wrapped label | Use `textContent` |
| D2 | Confirm-field and consent-checkbox detection tests `element.name` only | A "Confirm password" field identified only by `id` or `<label>` never mirrors the original value, even though matching for everything else uses all sources | Test the same normalised string used for rule matching |
| D3 | Multi-select picks index `i` to test `disabled` but selects a *different* random index | Disabled options get selected; option 0 can never be selected | Filter to enabled options, then sample |
| D4 | `text` rule computes an effective `maxLength` then discards it, passing word-count as the character cap | `maxLength` on a rule is silently ignored | Honour it |
| D5 | Random-password mode writes the password to the page console via `console.info` | Leaks generated credentials into the page's console and any console-capturing tooling | Never write to the page console |
| D6 | `selectRandomRadio` indexes an empty array when a randomized-list rule matches a radio group but none of its values exist | `TypeError`, fill aborts for the rest of the page | Guard and fall back |
| D7 | Corpus lookups use `Math.random() * (arr.length - 1)` | Last entry of every word/name/consonant/vowel array is unreachable | Correct index arithmetic |
| D8 | `contenteditable` fill skips exclusion checks and fires no events | Overwrites pre-filled rich-text editors even with "ignore fields with content" on; React/Quill/ProseMirror never see the change | Same exclusion + event path as every other control |
| D9 | No `step` support on `number`/`range`; no `minLength`; no `pattern` | Generates values the page's own validation rejects | Respect native constraints |
| D10 | One uncaught exception aborts the whole page fill | A single bad user regex silently stops the run partway | Per-element isolation + a result summary |

### 7.3 Capability gaps to close

- **`autocomplete` attribute matching** (`given-name`, `family-name`, `street-address`,
  `postal-code`, `cc-number`, …). Modern forms carry this; the reference ignores it. It is a
  better identity signal than a regex on `id`. Open upstream since 2021 as issue #188.
- **Open shadow roots.** `querySelectorAll` does not descend into them, so Lit/Stencil/Ionic
  design systems are invisible to the reference. Closed roots remain impossible — document
  that honestly.
- **Framework-controlled inputs.** A plain `Event("input")` after assigning `.value` does
  not update React 16/17 controlled components. Use the native value setter
  (`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set`) before
  dispatching.
- **No feedback.** The reference fills silently. If nothing happens the user cannot tell
  whether the page has no fillable fields, the domain is excluded, or it crashed. A badge
  count / result summary is cheap and closes the loop.

### 7.4 Design decisions not to port

Distinct from the defects in §7.2. These are working exactly as designed, and the design is
the problem. Porting the engine "faithfully" would import all of them, so each needs a
deliberate decision *before* UC-004 is specified.

#### Tier 1 — Model-level. These change what the system is.

**ND-1 · Per-field generation instead of per-record.**
`ElementFiller` generates each field in isolation as it walks the DOM. There is no concept of
"the person being filled in". The consequence is that a filled form is internally incoherent:
first name *Maria*, full name *John Smith*, an email unrelated to either, a city unrelated to
the postcode. The reference patches this with five mutable instance fields
(`previousFirstName`, `previousLastName`, `previousUsername`, `previousValue`,
`previousPassword`) and an `emailUsername: "name"` option that stitches the email out of
whatever names happened to be generated earlier.
**Do instead:** two passes. Collect and classify the whole field set, synthesise one coherent
record (identity, contact, address, account), then project it onto fields. Correlation stops
being a feature and becomes a property. This is the single biggest quality difference
available to the clone, and it is only cheap if decided now — retrofitting it onto a
single-pass walker is a rewrite.

**ND-2 · Matching against a concatenated, flattened identity blob.**
`getElementName()` joins name + id + class + placeholder + label + aria into one string, and
`SanitizeText()` strips every non-alphanumeric character and lowercases it. Rules are regexes
tested against that blob. Three consequences, all structural:
- *Anchoring is impossible.* `first_name` becomes `firstname` inside a blob like
  `" firstname userfirstname formcontrolinput firstname"`. `^name$` can never match, and
  `\bname\b` cannot match inside `firstname`. Users are forced into loose patterns.
- *Loose patterns then collide across sources.* A Bootstrap class `datepicker-input` makes an
  unrelated field match `/date/`. The user cannot say "match on `name`, ignore `class`" for
  one rule — the source toggles are global, all-or-nothing.
- *Provenance is lost.* You cannot report *why* a rule matched, so a mis-fill is undebuggable.

**Do instead:** keep sources as a structured record, match per-source with optional
source-scoping per rule, preserve separators so anchors and word boundaries work, and return
the matched source in the fill report.

**ND-3 · Label discovery via `document.querySelectorAll("label[for='...']")`.**
This finds only explicit `for=`/`id` pairings. The equally common implicit form —
`<label>Email <input></label>` — is invisible to it, so a field whose only human-readable
identity is a wrapping label gets lorem ipsum. The DOM already solves this: `element.labels`
returns both forms natively, needs no `cssesc` escaping, and works inside shadow roots where
a `document`-scoped query does not.
**Do instead:** `element.labels` + `textContent`. Drops a dependency and fixes a capability
gap in one change.

#### Tier 2 — Structural. These decide whether the codebase is testable and small.

**ND-4 · A shared `helpers` barrel that transitively imports the backend SDK.**
`content_script → fake-filler → element-filler → helpers → firebase`. `element-filler.ts`
imports `helpers.ts` for exactly two things (`SanitizeText`, `DEFAULT_EMAIL_CUSTOM_FIELD`),
and `helpers.ts` line 1 imports `saveOptionsToDb` from `firebase.ts`. That one edge is why
the shipped v4.1.0 content script is **480 KB with the Firebase SDK inside it, injected into
every frame of every page**. Nobody decided to ship Firebase to every page; an import graph
decided it.
**Do instead:** no shared barrel. Context-specific modules, a pure engine with zero platform
imports (per §6.1), and a CI check that fails the build if the page agent bundle grows past
budget or gains a disallowed import.

**ND-5 · The engine reaching into global `document`.**
`selectRandomRadio` calls `document.getElementsByName`, the pre-filled check calls
`document.querySelectorAll('input[name=…]:checked')`, label lookup calls `document`. So
"Fill this form" is not actually scoped to the form — radio-group resolution and label
lookup search the entire page, and a same-named radio group in a *different* form on the same
page interferes. It also makes the engine untestable without a DOM global and blind inside
shadow roots.
**Do instead:** pass the root node explicitly; use `element.form.elements` for group scoping.

**ND-6 · Firing `input`, `click`, `change`, `blur` as one unconditional bundle.**
Dispatching a synthetic `click` on a text input is not a lie the page should be told — it
opens date pickers, toggles dropdowns, and can trip submit handlers. `blur` without a
preceding `focus` breaks React's focus pairing. All four are generic `Event`, not
`InputEvent`, and `change` is constructed `cancelable: true`, which it is not.
**Do instead:** a per-element-type event sequence — `focus` → native value setter →
`InputEvent("input")` → `change` → `blur` — with `click` reserved for controls a user
actually clicks (checkbox, radio).

**ND-7 · Order-dependent hidden state for confirmation fields.**
Mirroring works by stashing the last generated value in `previousValue` and replaying it. But
`previousValue` is shared by text *and* email fields, so any text input between `email` and
`confirm email` silently clobbers the value being mirrored — and a confirm field that appears
*before* its source in DOM order mirrors whatever came earlier, which may be lorem ipsum.
**Do instead:** resolve confirmation fields to their target field explicitly (ND-1 makes this
trivial — both read the same record slot).

**ND-8 · Duplicate all-string "form" types shadowing the domain model.**
`IFakeFillerOptionsForm` and `ICustomFieldForm` mirror every real field as a string, with
`CsvToArray` / `MultipleLinesToArray` marshalling by hand in ~350 lines of Redux thunks.
Every new setting must be added in four places.
**Do instead:** one schema (zod), form state derived from it, validation and parsing generated
rather than written.

**ND-9 · `template: string` overloaded across four unrelated grammars.**
The same field carries a telephone mask, a moment.js date format, an alphanumeric template,
and a regex — discriminated only by `type`, with no validation. The importer cannot tell a
malformed regex from a valid date format.
**Do instead:** a discriminated union on `type`, so each generator declares its own options.

#### Tier 3 — Smaller, but each one is a papercut a user will hit.

| | Decision | Why it is wrong | Instead |
|---|---|---|---|
| ND-10 | One global `defaultMaxLength: 20` across all control types | An unconstrained `<textarea>` receives a **20-character** phrase, not a paragraph — the reference's own documented behaviour is wrong here | Per-control-type sizing defaults |
| ND-11 | Random password = `scrambledWord(8,8).toLowerCase()` | 8 alternating lowercase letters. No digit, no uppercase, no symbol — fails the registration forms the feature exists to fill | Policy-aware generation, reading `pattern` / `minlength` off the field |
| ND-12 | Base64-encoding the settings export | Zero security, only obscurity. Backups become un-diffable, un-reviewable, and un-editable — you cannot keep a team config in git | Plain, pretty-printed JSON |
| ND-13 | Import rejects on version mismatch but offers "continue anyway" | A bypass that writes unmigrated data into live settings | A real migration ladder; no bypass |
| ND-14 | Fill functions return `void` | Nothing to assert in a test, nothing to show the user, nothing to log. The absence of a return type is why the reference has no tests | Return a structured fill report (FR-009) |
| ND-15 | `new RegExp(pattern, "i")` per element per rule, per fill | 500 controls × 100 rules = 50,000 constructions per run, and an invalid user pattern throws mid-walk | Compile once on settings load; validate at authoring time |
| ND-16 | Visibility test is `offsetWidth`/`offsetHeight` + `visibility` | Misses `opacity: 0` and off-screen positioning — the two most common honeypot techniques. Filling a honeypot is exactly what the feature exists to avoid | `checkVisibility()` plus honeypot heuristics |
| ND-17 | Options read from storage on every page's `getOptions` message | A storage round-trip per page load, per frame | Cache in the background context; invalidate on write |

#### Deliberately kept

Not everything unusual is wrong. **First-match-wins ordered rules** (rather than
specificity scoring) is worth keeping: it is predictable, user-controllable via drag
ordering, and explainable in one sentence. **Profiles augmenting rather than replacing the
global rule list** is also right. Both are ported as-is.

#### Where each is resolved

Every ND is closed by a requirement with a pass/fail test, not by this section. A note
without a requirement behind it does not survive contact with implementation.

| | Not-ported decision | Closed by |
|---|---|---|
| ND-1 | Per-field generation | FR-023 Coherent Record · UC-004 |
| ND-2 | Flattened match blob | FR-067 Source-Scoped Rules · FR-068 Anchorable Patterns · FR-069 Match Provenance |
| ND-3 | `label[for]` only | FR-066 Implicit Labels · FR-029 Label Text Fidelity |
| ND-4 | Shared helpers barrel | NFR-003 Page Agent Size · NFR-015 Engine Isolation · §6.1, plus a CI check failing the build on a disallowed import in the page agent |
| ND-5 | Engine bound to global `document` | NFR-015 Engine Isolation · UC-002 (true form scoping) |
| ND-6 | Blind event bundle | FR-013 Framework-Safe Write · FR-014 Configurable Events |
| ND-7 | Order-dependent mirroring state | FR-023 Coherent Record · FR-024 Confirmation Mirroring |
| ND-8 | Duplicate all-string form types | No requirement — implementation guidance, enforced at review. Follows from the single-schema choice in DD-005. |
| ND-9 | Overloaded `template` field | FR-019 Generator Types · FR-070 Rule Validation · DD-005 |
| ND-10 | One global max length | FR-065 Sizing by Control Type |
| ND-11 | Unusable random passwords | FR-025 Password Generation · FR-072 Password Field Constraints |
| ND-12 | Base64 export | FR-052 Export Settings |
| ND-13 | Version-mismatch bypass | FR-073 Schema Migration |
| ND-14 | `void` fill functions | FR-009 Fill Result Report |
| ND-15 | Per-element regex construction | NFR-025 Pattern Precompilation · NFR-009 Regex Safety · FR-070 Rule Validation |
| ND-16 | Weak visibility test | FR-071 Honeypot Avoidance |
| ND-17 | Storage read per page load | NFR-026 Settings Read Caching |

---

## 8. Product Decisions (settled)

| ID | Decision | Rationale |
|---|---|---|
| **PD-001** | **Fully local. No accounts, no backend, no paid tier.** | Removes the entire "what does the server see?" question, which is the differentiator. Also removes ~8 use cases. |
| **PD-002** | **One-way Fake Filler import; our own export schema.** | Migrating users get a path in. We are not bound to the reference's quirks (CSV-in-a-string settings, `template` overloaded across four generator types, moment-style date tokens). |
| **PD-003** | **Chromium + Firefox in v1.** Safari deferred. | Both are MV3. The reference ships one codebase to both, so the compatibility cost is known and bounded. |
| **PD-004** | **Rebrand completely.** No "Fake Filler" name, logo, wording, or `fakefiller.com` reference anywhere in the product, listing, or repo. | The MIT grant covers the code, not the mark. |
| **PD-005** | **Everything the reference paywalls is free.** | Unlimited rules, URL profiles, sync. |
| **PD-006** | **Product name: FieldFiller.** | Checked and clear on both stores (§8.2). Proximity to "Fake Filler" was raised and assessed as low risk: a descriptive mark in its own category gets narrow protection. Decision taken 2026-08-12. |

### 8.1 Licensing position

The reference is MIT (`LICENSE`, © 2014–2020 Hussein Shabbir), and `package.json` agrees.
MIT permits copying, modification, and redistribution — including commercially — on one
condition: **the copyright notice and permission text must be retained in copies or
substantial portions of the software.**

Practical obligations for this project:

1. Ship a `NOTICE` / third-party attributions file containing the original MIT text and
   copyright line, and reference it from the extension's About page.
2. Keep `LICENSE` (ours, MIT) distinct from that attribution.
3. Do not reuse the name, logo, icon, store screenshots, or listing copy — none of that is
   covered by the code licence.
4. Where we port logic directly (the generator functions, the alphanumeric template engine,
   the option defaults), note the provenance in a file header.

This is the standard reading of MIT for a derivative work. It is not legal advice — worth a
one-off confirmation before the first store submission, given the project ships publicly.

### 8.2 Name clearance (checked 2026-08-12)

| Check | Result |
|---|---|
| Extension named "Field Filler" on Firefox AMO | none |
| Extension named "Field Filler" on Chrome Web Store | none |
| AMO slugs `fieldfiller` / `field-filler` | both free |
| `fieldfiller.io` | available (`.com`, `.dev`, `.app` registered) |

Caveat: **neither store enforces unique display names** — AMO currently lists two separate
extensions called "Form Filler". Clear today does not mean reserved.

### 8.3 Trademark register search (searched 2026-08-12)

| Register | Query | Result |
|---|---|---|
| USPTO | `FM:"field filler"` | **0 marks** |
| USPTO | `FM:"fake filler"` | **0 marks** |
| USPTO | `FM:filler AND IC:009` | 1 — "FILLER", *game software*, **DEAD**, cancelled 2016 |
| TMview (EUIPO, Switzerland, UK, US + 70 offices) | `"field filler"` | 2 — `FIELD-FILLER` (Philippines, 2014, **class 25 clothing**); one unrelated BBQ mark |
| TMview | `"fake filler"` | 1 — `FAKE THAT FILLER` (EUIPO, filed 2026, **class 3 cosmetics**, Bulgarian cosmetics company) |
| TMview | `filler`, class 9 | `FORM FILLER` (US, 1987/1989/2004), `EASY FILLER`, `FRAME FILLER`, `FILLER` — none for form-filling software |

**The headline finding: "Fake Filler" is not a registered trademark anywhere in TMview's
coverage.** Neither is "Field Filler", in any jurisdiction, for anything resembling software.
The only registered `FIELD-FILLER` is a Philippine clothing mark.

Residual risks, in order of realism:

1. **Unregistered rights.** In the US, common-law trademark rights arise from use, not
   registration, and the reference has been sold commercially since 2020. But "Fake Filler"
   is descriptive of its own goods, so asserting it would require showing acquired
   distinctiveness, and the scope would be narrow. This is the honest residual exposure and
   it is small.
2. **Store complaint, not litigation.** The practical risk is a takedown request to Google
   or Mozilla, who act on plausible complaints without adjudicating. Cheap for a complainant,
   disruptive for us. Mitigated by the register position above and by not copying the
   listing copy, icon, or screenshots.
3. **Search caveat.** TMview states it "does not constitute an official register." For a
   binding clearance opinion the national registers and a professional search are the
   authority. This is a due-diligence check, not legal advice.

Conclusion: nothing found that creates a problem. PD-006 stands.

Discoverability remains a real constraint independent of the legal question: the store is
saturated with `___ Filler` names, so the listing must earn its ranking on the description
and the differentiators in §3, not on the name.

---

## 9. Open Design Decisions

These need resolution during detailed use case work. Each is flagged on the use case it
blocks.

> **Status as of 2026-08-13:** DD-001, DD-003, DD-004 and DD-007 are resolved; ND-1, ND-2
> and ND-9 are decided (see §7.4). DD-002, DD-005, DD-006 and DD-008 remain open.

### Resolved

**DD-001 — Persistent `<all_urls>` content script. RESOLVED.**
The page agent is declared in the manifest against all URLs and all frames, as the reference
does. Chose fidelity over minimal permissions: Chrome's `contextMenus.OnClickData` carries
`frameId` and `editable` but **no element identifier and no `getTargetElement`** (verified
against Chrome's API reference), so on-demand injection cannot reliably know which field was
right-clicked. Firefox's `menus.getTargetElement()` solves it there, but building the product
around a capability only one of two target browsers has would mean two behaviours to specify,
test and explain.

**What this costs us, stated plainly rather than glossed:**

- Chrome shows **"Read and change all your data on all the websites you visit"** at install —
  its most severe warning, displayed before anyone has tried the product.
- Our code runs on every page and every frame the user visits, including ones they will never
  fill, for as long as the extension is installed.
- **G3 narrows to "no network" only.** We do not claim minimal permissions, in the store
  listing, the README, or anywhere else. On permission surface we are equivalent to the
  reference; the honest differentiators are the verifiable build (G4), the absence of any
  network capability (G3), and a page agent 12× smaller with no SDK or corpus in it (G6).
- NFR-008 is rewritten accordingly. Anything that reads as "we inject less than they do" is
  now false and must not appear.

**What it buys:** all three fill scopes work identically on both browsers, the profile and
domain badges work without the `tabs` permission (which carries its own "read your browsing
history" warning), one code path instead of two, and no per-fill injection latency.

**Still available later without rework:** ship broad access as an opt-in runtime permission
with a narrower default. Deferred, not rejected — noted so the door stays open.

**DD-007 — Default keyboard shortcuts. RESOLVED.**

| Scope | Shipped default | Note |
|---|---|---|
| Fill all inputs (UC-001) | `Ctrl+Shift+Y` / `Cmd+Shift+Y` | Collides with the Downloads library on Firefox for Linux only; Windows and macOS Firefox use `Ctrl+J`/`Cmd+J`. Accepted, and reassignable. |
| Fill this form (UC-002) | `Ctrl+Shift+Period` / `Cmd+Shift+Period` | **Provisional.** Substituted for the originally chosen `;`, which is not a legal key — see below. |
| Fill this input (UC-003) | *none* | User-assigned through the browser's shortcuts settings. |

`Ctrl+Shift+F` is abandoned deliberately: it collides with Firefox's find bar and with the
find-in-files binding of most editors, which is very likely why the reference removed its own
default in v4.1.0 (§7.1).

**Why not `;`.** Chrome's extension commands API accepts only `A`–`Z`, `0`–`9`, `Comma`,
`Period`, `Home`, `End`, `PageUp`, `PageDown`, `Space`, `Insert`, `Delete`, the arrow keys and
the media keys. Semicolon, slash and brackets are not permitted, and a manifest declaring one
is rejected at load. `Period` is the nearest legal key and is not bound by either browser.

**How FR-005 is now read.** The commitment is *at least one scope carries a shipped default,
and every other scope is assignable through the browser's own shortcuts settings* — not a
default for all three. Two considerations drive that. Chrome permits a limited number of
suggested bindings, so spending them on the two least ambiguous scopes is the better trade.
And "fill this input" is the scope most naturally reached by right-clicking the field itself,
so a shipped binding for it earns the least.

**What this obliges elsewhere:**

- The toolbar button remains the zero-configuration path. A user who never opens settings and
  never learns a shortcut still gets the product's main action in one click. Keyboard defaults
  are a convenience for people who fill forms all day, not the route in.
- UC-030 becomes load-bearing rather than decorative: with one scope deliberately unbound, the
  shortcuts page is how a user discovers that it can be bound at all. The reference ships
  *nothing* bound and offers no prompt, which is why most of its users never assign one.

**DD-003 — Generation runs in the background. RESOLVED.**
The page agent walks, classifies and applies; it carries no corpus. Field descriptors go to
the background over one message round-trip per fill, and values come back. Rationale and
measurements in §6.1. Consequences: the corpus can be as rich as ND-1's full-persona
coherence needs, and the page agent stays small enough that persistent injection (DD-001)
remains defensible. Costs: one
round-trip per fill, and an MV3 service-worker cold start on the first fill after idle, which
is why NFR-002 is now split into warm and cold thresholds.

**DD-004 — Build framework: WXT. RESOLVED.**
One config emits both targets, absorbing the `service_worker` vs `background.scripts` split
(C-003) and `gecko.id` (C-004). PD-003 put both browsers in v1, which made cross-browser
output the deciding factor.

**ND-1 — Full persona. DECIDED.**
One fill produces one coherent fictional person: identity, contact, address and account,
with city, state and postcode mutually consistent, email derived from the name, and phone
matching the country. This is the largest quality gap over every competitor found in §2, and
DD-003 is what makes it affordable.

### Open

*(DD-001, DD-003 and DD-004 were resolved on 2026-08-12 — see "Resolved" above.)*

**DD-008 — Scope fallback when no form exists.** *Blocks UC-002.*
"Fill this form" assumes a `<form>` ancestor. Modern applications routinely render form-like
UI out of `<div>`s with no `<form>` at all, so `closest("form")` returns nothing and the
reference silently does nothing. Options: fall back to filling the whole page, report that no
form was found, or fall back to a heuristic container such as the nearest element with a form
role. Silence is the one clearly wrong answer. Decide before UC-002 is drafted.

**DD-002 — Sync storage shape and conflict resolution.** *Blocks UC-029.*
`chrome.storage.sync` caps at **8 KB per item** and 102 KB total, with write-rate limits. The
reference stores everything under a single `options` key — under `storage.sync` that would
break for any user with a moderate rule set. Options: shard rules across keys, compress, or
sync a manifest and keep bulk in `storage.local`. Needs a sizing exercise against a
realistic 100-rule configuration.

Quota is only half of it. Synchronised storage is last-writer-wins per key, so two devices
editing within the same window silently discard one of the edits — and if the whole
configuration lives under one key, editing *any* setting on device A discards *every*
concurrent edit on device B. The same sharding that solves the quota problem also narrows the
blast radius of a conflict, which is why the two must be decided together. The third option
is to accept last-writer-wins explicitly and say so in the interface. Whatever is chosen has
schema consequences, so it must be settled before Phase 5 freezes the schema.

*(DD-003 and DD-004 were resolved on 2026-08-12 — see "Resolved" above.)*

**DD-005 — Settings schema versioning.** Our schema v1 must be forward-migratable, and the
importer must map Fake Filler's v1 onto it. Needs an explicit migration ladder before the
first release, not after.

**DD-006 — Result feedback surface.** Badge count, toast, or nothing. Affects UC-001..003
postconditions.

---

## 10. Success Criteria

| | Measure |
|---|---|
| Parity | Fills a 60-field reference test page — every input type, `<select>`, `<textarea>`, `contenteditable`, shadow-root, cross-origin iframe — with no field left empty and no console error. |
| Correctness | All ten defects in §7.2 have a regression test that fails against ported reference logic and passes against ours. |
| Speed | 500 controls filled in under 500 ms. |
| Size | Page agent under 40 KB minified and uncompressed, verified in CI on every build. |
| Privacy | Zero outbound requests observed over a full session under DevTools network logging, verified in CI. |
| Verifiability | Store artefact digest matches the CI-built release artefact digest. |

---

## 11. Next Steps

1. `docs/requirements.md` — FR/NFR/C catalog. **Drafted.**
2. `docs/use_cases.puml` — actor/use case overview. **Drafted.**
3. `docs/use_cases/UC-001.md` … — detailed specs, starting with the engine core
   (UC-001, UC-004, UC-005), which is where all the design risk lives.
4. Run the cold-start spike (NFR-027..029) — the last open measurement in Phase 0.
5. Build the reference test page early; it is the acceptance harness for everything else.
