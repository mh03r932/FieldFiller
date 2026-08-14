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

### Precedence when goals compete

**G5 outranks every other quality attribute.** Where correctness and a non-functional budget
cannot both be met, the budget yields and the shortfall is measured and recorded — not the
other way round. A fill that is fast, small and wrong is a worse product than a fill that
misses a millisecond target, because the wrong one is silent and the slow one is not.

Two qualifications, because "correctness first" expands to cover everything if left
unqualified:

- **Coverage is not correctness.** A control the engine cannot drive and reports as skipped,
  with a reason, is *correct* — it is incomplete. Filling it wrongly is the incorrect
  outcome, and reporting it as filled when it was not is the worst one. So the size and
  latency budgets legitimately outrank *reaching further*; they never outrank *telling the
  truth about what was reached*.
- **Bounded failure is the correct behaviour, not a compromise.** Where the engine cannot
  finish — a page that fights back, a cascade deeper than the pass budget — stopping at a
  declared limit and saying so is the correct outcome. Running unbounded in pursuit of
  completeness is not more correct, it is merely unfinished.

This ordering is deliberately stated once, here, rather than argued per decision. Every NFR
in `docs/requirements.md` §2 carries a bare High/Medium priority with no tiebreak, which is
what caused the question to be reopened on each design in turn.

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
- **No modelling of a page's own validation relationships.** DD-009 makes the engine follow
  dependencies the page expresses *in the DOM* — options rewritten, fields revealed, controls
  enabled. It does not attempt dependencies the page keeps to itself: a postcode the server
  checks against the chosen city, or a select whose options were all present from the start
  but only some are valid given another answer. Nothing observable changes in either case, so
  there is nothing to observe. Named here because "dependent fields" otherwise reads as
  covering it.

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

Generation runs in the **background**, not in the page. The page agent walks, applies,
observes what the page does in response, and decides when the page has stopped changing; it
carries no data corpus. See DD-003 (resolved) in §9 for why, and DD-009 for what the agent
observes.

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
        executeScript       │  ▲  field descriptors ── one round-trip per pass
                            ▼  │  values + provenance
┌──────────────────────────────────────────────────────────────┐
│ Page agent (content script — small, no corpus)               │
│  · records the right-clicked element                         │
│  · resolves domain exclusion (enabled / suspended)           │
│  ├── walk     → collect fillable elements (frames, shadow DOM)│
│  ├── exclude  → disabled/readonly/hidden/prefilled/ignored   │
│  ├── identify → name, id, class, label, aria, autocomplete   │
│  ├── apply    → framework-safe write + event sequence        │
│  └── settle   → verify writes, observe the page's reaction,  │
│                 re-fill what changed, stop at the cap        │
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
2. **No corpus, no rule set and no persona in the page.** Measured: `@faker-js/faker` is
   444 KB minified even when a single locale is imported — its locale data is monolithic and
   does not tree-shake. Parsing that in every frame of every page is exactly the mistake the
   reference made with Firebase (ND-4). In the background it is parsed once per session.

   This is the invariant, and it is narrower than "the agent is thin". The agent holds DOM
   state and always has — the written-by-us set, the anchor element, and since DD-009 an
   observer, element tokens and a pass counter. What must never cross is *data*: the corpus,
   because it is enormous; the rule list and profiles, because the agent never uses them and
   less exposed is less lost if a page ever compromises it (BR-024-4); the persona, because
   it is the whole record and the page only ever needs the field in front of it. Logic in the
   agent is kilobytes and is budgeted by NFR-003. Data in the agent is hundreds of kilobytes
   and would reopen DD-001.

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

> **Status as of 2026-08-14:** DD-001, DD-003, DD-004 and DD-007 are resolved; ND-1, ND-2
> and ND-9 are decided (see §7.4). **DD-008 resolved 2026-08-13. DD-009 resolved 2026-08-14,
> amending DD-003.** DD-002, DD-005 and DD-006 remain open — and DD-006 now carries two
> obligations: from DD-008, a result must name the scope it filled; from DD-009, it must be
> able to say that a fill stopped at its cap rather than finishing.

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

**DD-008 — Scope when no `<form>` exists. RESOLVED.**

"Fill this form" is resolved by a fixed ladder from the element the user pointed at. The first
rule that matches wins, and the result names which one did.

| | Rule | Rationale |
|---|---|---|
| 1 | `element.form` | The page said so |
| 2 | Nearest ancestor `[role="form"]` or `<fieldset>` | The author said so, without a `<form>` tag |
| 3 | Nearest ancestor containing the anchor **and a submit control** | A form is the thing you can submit |
| 4 | *(anchored)* fill nothing and report why | An explicit narrowing must not be overridden |

**The anchor**, in order: the right-clicked element; otherwise the focused element; otherwise
the last control focused during this page's lifetime. The third exists because the case is
common — tab through a form, click something else, then use the shortcut — and it costs
nothing: it stores element identity only, exactly as the "written by us" set does
(BR-005-7), so NFR-010 is untouched.

**With no anchor at all** — the keyboard shortcut on a page the user has not touched — the
scope is decided by how many form-like units the page has: exactly one, fill it; none, fill
the page; two or more, fill the page.

The asymmetry between rule 4 and the anchorless case is the whole design, and it is not an
inconsistency. Widening after an anchor would override a narrowing the user expressed on
purpose, which is why it refuses. Widening with no anchor overrides nothing, because no
narrower intent was ever stated — and refusing there would mean the user pressed a key and
watched nothing happen. Where two or more forms compete for an absent cursor, the page is
chosen over the largest form because a superset cannot be wrong about which one was meant,
while a guess silently fails whenever the other one was wanted.

Rule 3 is preferred over the more obvious "nearest container holding more than one field"
because it is both more accurate and explainable in one sentence: *the smallest block
containing the field you pointed at and its submit button*. A scope the user cannot predict is
the same defect as a rule they cannot predict (ND-2).

**A correctness fix that applies regardless.** `closest("form")` is wrong even when a `<form>`
is present: HTML associates a control with a form by the `form="id"` attribute too, which is
how a modal or a sticky footer holds the submit button for fields outside it. `element.form`
answers this natively. Same class of fix as `element.labels` over `label[for]` (ND-3).

**What this obliges elsewhere.** The scope is now inferable three ways, so a fill result must
state which scope ran — "6 fields in the form around your cursor" against "6 fields on the
page". That is a requirement on **DD-006**, which remains open: a bare badge count cannot
express it, so whatever feedback surface is chosen has to carry the scope as well as the
count.

**DD-003 — Generation runs in the background. RESOLVED.** *(Amended 2026-08-14 by DD-009.)*
The page agent walks, classifies and applies; it carries no corpus. Field descriptors go to
the background over one message round-trip **per pass**, and values come back. Rationale and
measurements in §6.1. Consequences: the corpus can be as rich as ND-1's full-persona
coherence needs, and the page agent stays small enough that persistent injection (DD-001)
remains defensible. Costs: the round trips, and an MV3 service-worker cold start on the first
fill after idle, which is why NFR-002 is now split into warm and cold thresholds.

**The invariant, restated so the amendment cannot erode it: the background never learns what
the page *did*, only what it contains.** Descriptors in, values out. Every DOM semantic —
what changed, whether a write survived, whether the page has stopped moving — stays on the
page side of the boundary. That is what keeps generation a pure function and the background a
stateless oracle, and it is the property that made multi-pass filling a change to one side
rather than to both.

**Re-examined 2026-08-14, when DD-009 turned one round trip into several. It holds, and the
reasons are worth recording because the obvious objection is that the split now costs more.**

- The split was never about round trips or about a thin agent — it was about the corpus.
  DD-009 adds logic to the agent, not data. Nothing it adds moves the 444 KB measurement the
  decision was taken on.
- DD-003 and DD-001 are coupled, and only one is reopenable. Persistent `<all_urls>`
  injection is defensible *because* the agent is 40 KB. Moving the corpus into the page ships
  half a megabyte into every frame of every site — the exact criticism this project levels at
  the reference in §2 and ND-4 — so unwinding DD-003 forces DD-001 open too, and DD-001 is
  load-bearing for FR-003 on Chrome.
- The eviction window narrows rather than widens. The worry is that a fill lasting seconds
  rather than milliseconds gives the service worker more chance to be evicted mid-operation.
  But an MV3 worker's idle timer is reset by each incoming message, and a cascade sends a
  descriptor batch every few hundred milliseconds: a fill *with* passes keeps the worker
  alive. The residual exposure is unchanged and is cold start on the first pass, which
  NFR-027 already covers.
- FR-080 pushes further the same way. Making generation a pure function of persona, token and
  descriptor — which correctness required regardless — removes the last per-fill mutable
  state from the background. A stateless oracle is easier to keep remote, not harder.

**Considered and rejected: send the persona to the agent once, project it locally, and make
later passes free of round trips.** It survives Phase 1 and dies in Phase 2. Rule matching,
the regex generator, alphanumeric templates, randomised lists and policy-aware passwords are
code plus the user's rule set, not a few hundred bytes of persona — so "just send the
persona" becomes "ship the generators and the rule list", which is what `AgentSettings`
withholds on purpose (BR-024-4). It also only covers persona-slot fields, a minority of any
real form. Recorded because it is the obvious way to make passes cheap and will otherwise be
re-proposed.

**DD-009 — Fields whose content depends on an earlier answer. RESOLVED.**

A single-pass fill assumes the page is finished changing by the time we walk it. Modern pages
falsify that: choosing a country rewrites the state list, ticking a box reveals three fields,
picking a plan enables a seat count. The reference has no answer at all — it walks once and
leaves.

**The single round trip and the 400 ms settle window were never invariants about the page.
They were assumptions about how quickly a page stops changing, and single-page applications
falsified them.** This decision turns both into backstops; everything in it exists to make
the backstops honest rather than silent.

#### What the problem decomposes into

| | Sub-problem | Kind |
|---|---|---|
| **P1** | Stale options — a dependent control's options are rewritten after its controller is set | mechanical |
| **P2** | Late fields — controls appear or become enabled only after an earlier choice | mechanical |
| **P3** | Non-native widgets — the "select" is not a `<select>` | interaction |
| **P4** | Semantic coherence — a valid pick may still be the wrong pick | generation |

P1 and P2 are one problem wearing two coats: a snapshot against a living DOM. P3 is a
different problem and gets a different mechanism. **P4 is not part of this decision** — it is
a UC-004 generation concern (FR-082), only adjacent because cascading selects happen to be
country/state/city. It is sequenced independently so this change does not wait on a
data-shaped question.

#### The decision: an event-driven fixpoint loop, owned by the page agent

The agent applies, watches what the page does in response, fills exactly what changed,
verifies every write survived, caps everything, and reports the caps. The background is
unchanged in kind: it answers descriptor batches, several times per frame instead of once.

The loop lives in the agent because the agent owns the DOM. Putting it in the background
would mean shipping DOM observation semantics across a boundary that has no DOM, and would
break the invariant restated under DD-003.

#### The five mechanisms that make it stable rather than hopeful

**1 · Element tokens, for identity *and* for value stability.** `ref` is positional per batch
and meaningless across passes, so each element gets a token for the operation's lifetime,
held in a `WeakMap`. The report carries one final outcome per token — a control filled in
pass 1, wiped by the page, refilled in pass 2 counts once. This is the same problem `FrameId`
solved one level up, and the same answer.

The token must also reach the background, because generation draws from a stateful PRNG:
re-describe an element in a later pass and it would otherwise receive a *different* value.
An email refilled in pass 2 no longer matches the "confirm email" filled in pass 1, and
FR-024 is broken by the loop itself, invisibly. So generation is seeded per token from the
operation's seed (FR-080), making it idempotent within a fill and still fresh across fills
(FR-075). This also defuses whole-node replacement: a framework that swaps a `<select>` out
gets a new token and a second fill, but with the *same* value — the damage reduces from a
double-fill to a double-count.

**2 · Two signals, with different jobs.** This is the correction that matters most, because
the intuitive design gets it wrong in both directions.

- A `MutationObserver` decides **when to look** — `childList` on the document subtree plus a
  narrow `attributeFilter` (`disabled`, `hidden`, `readonly`, `style`, `class`,
  `aria-disabled`, `aria-busy`). It is a timing signal and nothing more.
- A **verification sweep at quiescence decides what changed**, read from the DOM rather than
  from mutation records.

Mutation records cannot be the diff's only input, in both directions at once. A framework
that reverts our write does it with a property assignment, which emits **no records at all** —
so a `childList`-only observer can never see the reset loop it was chosen to catch. And
"previously excluded, now eligible", which is most of P2, is usually an *attribute* change: a
`disabled` lifted off a fieldset, a `hidden` removed, a `display:none` flipped.

**3 · What earns a re-fill.** Not everything, every pass. A control re-enters the candidate
set only if it is new; its option list changed; our written value did not survive; or it was
excluded for a reason that no longer applies. A control the page cascaded to a sensible
default is treated as content and left alone. A control still holding our value is left alone
and keeps its earlier `filled` outcome — reported under its own exclusion reason, never as
`pre-filled`, which would be a lie the badge would then repeat.

**4 · Verification, twice.** Immediately after the write, to answer *did it take*; and again
at final quiescence, to answer *did it survive*. Only the second can be honest about a page
that reverts us, and it is why a control's outcome is decided at the end rather than when it
was written.

Verification is **per kind, never string equality**. `type=number` given `007` reads back `7`,
`type=date` given a bad format reads back empty, `type=color` normalises case, `maxlength`
truncates, and a currency mask turns `1234` into `$1,234.00`. Equality would report a page
full of correctly-filled fields as failures. Toggles and selects verify exactly; text-like
controls verify non-empty plus the constraints the descriptor already carries. A page that
normalised our value filled successfully.

The comparison happens entirely inside the agent, and neither the value read back nor the
value it is compared against ever enters a descriptor or a report. NFR-010 and NFR-030 are
untouched.

**5 · The user always wins.** A cascade stretches a fill from milliseconds to seconds, which
is long enough for a human to start typing into it. **No pass may write to a control the user
has touched since the fill began, and any trusted user input ends the cascade.** The
discrimination is exact and free: everything the agent dispatches, including the synthetic
click a checkbox receives, carries `isTrusted: false`. This is the only failure in the whole
design where the *user* is harmed rather than the fill being incomplete, so it is a rule and
not a mitigation.

#### Bounds, and why stopping is the correct answer

Some pages cannot be resolved. A validation bug that reverts a select on every change, two
controls that rewrite each other, a handler that throws on our synthetic event — each is a
loop with no fixpoint. The engine stops at a declared limit and says so: a pass cap, a
per-pass maximum wait, and a total cascade budget (NFR-034), with "capped" reported as its own
fact — *"3 passes, 2 fields may be stale"* — rather than folded into the count. Per §3, a
bounded honest failure is the correct outcome, not a compromise on the way to one.

The caps are chosen from measured cascade depth across the fixture matrix, not from round
numbers, and the fixtures are the specification: native cascade, chained cascade, debounced
cascade, server-driven options, reset loop, circular dependency, whole-node replacement, and
a property-only wipe — that last one being the regression test that the observer never became
the diff.

#### P3: non-native selects, best-effort with honesty

Detected by `role="combobox"`, `role="listbox"`, `aria-haspopup="listbox"`, and the
hidden-input-beside-a-combobox pattern. They become a new control kind, so the existing
per-source identity machinery applies unchanged. Then a ladder, each rung verified by readback
before it is trusted, and the whole ladder bounded by having recorded the focused element and
scroll position first:

1. **Keyboard**, the ARIA authoring pattern — focus, `ArrowDown` to open, read the options
   from the now-open popup (a portaled popup lands in `document.body` and a document-scoped
   query finds it), arrow to the choice, `Enter`, verify.
2. **Click-open** — click the trigger, read the options, click the choice, verify.
3. **Restore and give up honestly** — `Escape`, put focus and scroll back, and report the
   control as skipped with a reason. A page left in a trapped modal state because we opened a
   popup and walked away is a worse outcome than an unfilled field.

Clicking a combobox trigger is consistent with ND-6 rather than an exception to it: a
combobox trigger is a control a user actually clicks, which is the entire test ND-6 sets.

**Deliberately not on the ladder: writing the hidden backing `<input type="hidden">`.** It is
excluded by type for good reason, and writing it typically updates the form payload without
updating the component's state — producing a UI reading "Select…" and a submission carrying
"GB". That is worse than an honest skip, because it is wrong *and* invisible.

P3 is the one part of this decision that yields to NFR-003. Reaching further is coverage, not
correctness (§3), and the detection also widens the walk's candidate selector on every page —
`div[role="combobox"]` is not `input, textarea, select, [contenteditable]` — spending latency
budget everywhere to serve a minority of pages. It is gated on measuring that inflation
first.

#### Also considered and rejected

- **Blind re-fill N times, or a fixed sleep between passes.** Both die on the debounced
  cascade, which is the commonest case in the wild: too early and the options have not
  arrived, too late and every fill pays for the worst page the user owns.
- **Watching the page's own `fetch` to know when options arrive.** Patching `fetch` from the
  agent is observable to the page, muddies G3's story even though it issues nothing itself,
  and is strictly worse than observing the DOM that the fetch produces.
- **Filling choice controls before text controls within a pass**, so controllers are set
  first. The loop already covers it, and it makes the report's order unexplainable — a
  predictability cost of the kind ND-2 exists to avoid.

#### What this obliges elsewhere

- **DD-003** is amended: one round trip per pass, with the stateless-oracle invariant restated
  above so the amendment cannot be read as permission to move DOM semantics across.
- **DD-006** gains a second obligation. A capped fill is a distinct outcome and a bare count
  cannot express it, exactly as DD-008 made scope inexpressible in a count.
- **NFR-001 is split rather than loosened.** The 500-controls-in-500 ms budget is what the
  user perceives — the form visibly filling — and it stays, scoped to the first pass. Cascade
  resolution gets its own budget (NFR-034) that is explicitly not part of the responsiveness
  claim, so the §10 success criterion survives verbatim.
- **NFR-029 is bounded rather than reworded**: 20 ms per round trip still, plus a cap on the
  number of round trips per frame, so the total is derivable instead of asserted.
- The background's operation timeout becomes a **sliding deadline** — last progress plus the
  existing 15 s — rather than a larger fixed one. A bigger fixed timeout would make the
  navigate-mid-fill case worse by locking the tab for longer; a sliding window frees a dead
  agent as quickly as today and never abandons a working one. The absolute ceiling is derived
  from the agent's own cascade budget so the two cannot disagree.
- The observer and the token map are disconnected and dropped when the report is sent. An
  observer left connected on every page the user visits is the permanent tax DD-001 already
  made expensive (NFR-035).
- The protocol grows **compatibly**: the token is an added field, `capped` and the pass count
  are optional on a frame report, and their absence means "one pass". After an update, tabs
  opened beforehand still run the previous build until they reload, so a report in the old
  shape must keep validating — a commitment the protocol already makes and this must not
  quietly withdraw.
- The loop takes its scheduler as a parameter, the way the walk takes its root. Quiescence is
  timing, NFR-015 requires the engine to be testable without a browser, and otherwise the
  entire fixture matrix above can only run in the end-to-end harness.

**Why this was affordable at all: ND-1.** Generation projects a pre-existing persona onto
descriptors, so a field described in pass 3 resolves to the same persona slot as one described
in pass 0. Under the reference's order-dependent mirroring (ND-7), a "confirm email" filled in
a later pass would mirror whatever that pass happened to generate. Multi-pass filling would
have been incoherent by construction. The decision to synthesise a record before touching the
page — taken for §7.4's reasons, not for this one — is what made this change tractable two
phases later.

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

Constrained by DD-008: the scope of a fill is now inferable three ways, so the surface must
convey *which* scope ran and not only how many fields were filled. A bare badge count cannot
do that. It is also contended — the badge is where the active profile (UC-017) and domain-off
(UC-008) indicators must live, and those are persistent facts that outrank a transient count.
Phase 1 ships a count that reverts after a few seconds as a provisional answer; the decision
is what replaces it.

Constrained again by DD-009: a fill can now stop at its cap with fields left stale, and that
is a third thing the surface must be able to say. "6 filled" and "6 filled, 2 may be stale"
are different facts about the same page, and a user who cannot tell them apart is back to the
reference's problem of not knowing whether anything went wrong. Three facts — scope, count,
completeness — is past what a badge holds, which is now the strongest argument in the
decision rather than an aside.

---

## 10. Success Criteria

| | Measure |
|---|---|
| Parity | Fills a 60-field reference test page — every input type, `<select>`, `<textarea>`, `contenteditable`, shadow-root, cross-origin iframe — with no field left empty and no console error. |
| Correctness | All ten defects in §7.2 have a regression test that fails against ported reference logic and passes against ours. |
| Dependent fields | A cascading country/state/city form ends with every dependent select holding a value from its *rewritten* option list, and a page that reverts every write is reported as capped with stale fields named — never as a clean fill. |
| Speed | 500 controls filled in under 500 ms, measured on the first pass (DD-009). |
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
