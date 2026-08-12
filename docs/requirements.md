# FieldFiller — Requirements Catalog

**Status:** Draft v0.1
**Date:** 2026-08-12
**Source:** `docs/vision.md`
**Traces to:** `docs/use_cases.puml`

Roles used in user stories: **Tester**, **Power User**, **Migrating User**, **Auditor**
(see `docs/vision.md` §5).

---

## 1. Functional Requirements

### 1.1 Fill actions

| ID     | Title                    | User Story                                                                                                                              | Priority | Status |
|--------|--------------------------|-----------------------------------------------------------------------------------------------------------------------------------------|----------|--------|
| FR-001 | Fill All Inputs          | As a Tester, I want to fill every fillable control on the active page in one action so that I can exercise a form without typing.        | High     | Open   |
| FR-002 | Fill Current Form        | As a Tester, I want to fill only the form containing my cursor so that I do not disturb other forms on the same page.                    | High     | Open   |
| FR-003 | Fill Selected Input      | As a Tester, I want to fill only the control under my cursor so that I can top up a single field.                                        | High     | Open   |
| FR-004 | Toolbar Trigger          | As a Tester, I want to fill all inputs by clicking the toolbar button so that the common case takes one click.                           | High     | Open   |
| FR-005 | Keyboard Trigger         | As a Tester, I want a default keyboard shortcut for each fill scope so that I can fill without leaving the keyboard.                     | High     | Open   |
| FR-006 | Context Menu Trigger     | As a Tester, I want the three fill scopes on the right-click menu so that I can choose a scope from where I am pointing.                 | High     | Open   |
| FR-007 | Nested Frames            | As a Tester, I want controls inside iframes filled too so that embedded checkout and payment forms are covered.                          | High     | Open   |
| FR-008 | Open Shadow Roots        | As a Tester, I want controls inside open shadow roots filled so that web-component design systems are covered.                           | Medium   | Open   |
| FR-009 | Fill Result Report       | As a Tester, I want every fill to return a structured report giving each control exactly one outcome — filled, skipped with a reason, failed with a cause, or unreachable — aggregated per frame and for the operation as a whole, so that I can tell a no-op from a failure and the behaviour is assertable in a test. | High | Open |
| FR-010 | Error Isolation          | As a Tester, I want a failure on one field not to abort the rest of the run so that one bad rule does not silently halve my form.        | High     | Open   |

### 1.2 Value generation

| ID     | Title                     | User Story                                                                                                                                | Priority | Status |
|--------|---------------------------|---------------------------------------------------------------------------------------------------------------------------------------------|----------|--------|
| FR-011 | Input Type Coverage       | As a Tester, I want every HTML input type filled with a type-appropriate value so that the page's own validation accepts what I generate.   | High     | Open   |
| FR-012 | Native Constraints        | As a Tester, I want generated values to respect `min`, `max`, `step`, `minlength`, `maxlength` and `required` so that fields validate.       | High     | Open   |
| FR-013 | Framework-Safe Write      | As a Tester, I want values applied so that React, Vue and Angular controlled inputs register the change so that filling works on modern apps.| High     | Open   |
| FR-014 | Configurable Events       | As a Power User, I want to turn event dispatch off so that I can fill pages whose handlers misbehave on synthetic events.                    | Medium   | Open   |
| FR-015 | Consent Checkboxes        | As a Tester, I want checkboxes matching my consent keywords always checked so that terms gates never block a test submission.                | High     | Open   |
| FR-016 | Random Checkboxes         | As a Tester, I want non-consent checkboxes toggled randomly so that I exercise both states over repeated runs.                              | Medium   | Open   |
| FR-017 | Radio Groups              | As a Tester, I want exactly one enabled option chosen per radio group so that the group ends in a valid state.                              | High     | Open   |
| FR-018 | Select Elements           | As a Tester, I want one random enabled option chosen for a single select, and for a multi-select a random enabled subset of at least one option chosen without repetition, skipping any option whose value is empty, so that every dropdown ends in a valid submittable state. | High | Open |
| FR-019 | Generator Types           | As a Power User, I want at least the reference set of generator types (name, email, username, organisation, number, date, telephone, URL, text, alphanumeric, regex, randomized list) so that my existing configuration has an equivalent. | High | Open |
| FR-020 | Alphanumeric Templates    | As a Power User, I want a template syntax for letters, digits, consonants and vowels so that I can generate format-specific codes.           | Medium   | Open   |
| FR-021 | Regex Generator           | As a Power User, I want values generated from a regular expression so that I can match a field's exact accepted format.                      | High     | Open   |
| FR-022 | Randomized List           | As a Power User, I want a value picked from a list I supply so that a field only ever receives values my application accepts.                | High     | Open   |
| FR-023 | Coherent Record           | As a Tester, I want one fill to produce a single internally consistent identity — name, username, email, organisation, address and postcode all belonging to the same fictional person — so that the submitted record is realistic rather than a bag of unrelated values. | High | Open |
| FR-065 | Sizing by Control Type    | As a Tester, I want generated length to suit the control type, so that a `<textarea>` receives a paragraph rather than the same short phrase a text input gets.  | Medium   | Open   |
| FR-024 | Confirmation Mirroring    | As a Tester, I want a confirmation field to receive the same value as the field it confirms, drawn from the same persona attribute rather than replayed from whatever was generated most recently, so that "confirm email" and "retype password" always match their originals regardless of the order the fields appear in. | High | Open |
| FR-025 | Password Generation       | As a Power User, I want a generated password to satisfy a configurable complexity policy — minimum length, and at least one uppercase, lowercase, digit and symbol by default — so that registration forms accept it. | High | Open |
| FR-072 | Password Field Constraints| As a Tester, I want generated passwords to honour the field's own `pattern`, `minlength` and `maxlength` so that the page's client-side validation passes on the first attempt. | High | Open |
| FR-026 | No Credential Leakage     | As an Auditor, I want generated passwords never written to the page console or DOM outside the target field so that credentials do not leak into logs. | High | Open |

### 1.3 Field identification and matching

| ID     | Title                     | User Story                                                                                                                                | Priority | Status |
|--------|---------------------------|---------------------------------------------------------------------------------------------------------------------------------------------|----------|--------|
| FR-027 | Matching Sources          | As a Power User, I want rules matched case-insensitively against `name`, `id`, `class`, `placeholder`, associated `<label>` text, `aria-label` and `aria-labelledby` so that I can target fields however they are marked up. | High | Open |
| FR-028 | Source Toggles            | As a Power User, I want to enable or disable each matching source individually so that I can stop a noisy source causing false matches.       | Medium   | Open   |
| FR-029 | Label Text Fidelity       | As a Power User, I want label text taken as rendered text and not as markup so that HTML tag names never take part in matching.               | High     | Open   |
| FR-066 | Implicit Labels           | As a Power User, I want labels that wrap their control recognised as well as those using `for`/`id` so that fields identified only by a wrapping label are still matched. | High | Open |
| FR-067 | Source-Scoped Rules       | As a Power User, I want to restrict an individual rule to specific matching sources, bounded by the sources I have enabled globally, so that a noisy `class` attribute cannot trigger a rule meant for `name`. | Medium | Open |
| FR-068 | Anchorable Patterns       | As a Power User, I want to write anchored and word-bounded patterns that behave predictably so that `^name$` matches only a field actually called "name".      | High     | Open   |
| FR-069 | Match Provenance          | As a Power User, I want the fill report to state which rule matched each field and via which source so that I can debug an unexpected value.                   | Medium   | Open   |
| FR-070 | Rule Validation           | As a Power User, I want an invalid pattern or template rejected when I save the rule, not when a page is filled, so that a bad rule never breaks a fill run.    | High     | Open   |
| FR-030 | Autocomplete Matching     | As a Power User, I want the `autocomplete` attribute used as a matching source so that standards-compliant forms are recognised without custom rules. | Medium | Open |
| FR-031 | Deterministic Precedence  | As a Power User, I want the first matching rule in my ordered list to win, with profile rules taking precedence over global rules, so that outcomes are predictable. | High | Open |
| FR-032 | Consistent Match Target   | As a Power User, I want consent, confirmation and exclusion keywords matched against the same identity string as custom rules so that behaviour does not depend on which attribute happens to carry the label. | High | Open |

### 1.4 Exclusions

| ID     | Title                     | User Story                                                                                                                                | Priority | Status |
|--------|---------------------------|---------------------------------------------------------------------------------------------------------------------------------------------|----------|--------|
| FR-033 | Structural Exclusions     | As a Tester, I want `disabled`, `readonly`, `hidden`, `button`, `submit`, `reset`, `file` and `image` controls never filled so that the page is not corrupted. | High | Open |
| FR-034 | Hidden Field Exclusion    | As a Power User, I want to skip visually hidden controls so that off-screen and collapsed fields are left alone.                             | Medium   | Open   |
| FR-035 | Pre-filled Exclusion      | As a Power User, I want to skip controls that already hold a value so that I can top up a partially completed form.                          | Medium   | Open   |
| FR-075 | Refill With a New Persona | As a Tester, I want to fill the same page again and receive a completely new person, even when I have chosen to skip pre-filled fields, so that I can submit a form repeatedly with fresh data. | High | Open |
| FR-036 | Ignored Field Patterns    | As a Power User, I want a list of regular expressions identifying fields to never fill so that CAPTCHAs and honeypots are left untouched.     | High     | Open   |
| FR-071 | Honeypot Avoidance        | As a Tester, I want a field treated as hidden when the browser reports it as not visible, or it has zero rendered area, or zero opacity, or is clipped away, or is positioned outside the document bounds, or is marked `aria-hidden` with a negative tab index, so that anti-bot honeypots are never filled. | High | Open |
| FR-037 | Excluded Domains          | As a Power User, I want a list of patterns identifying domains where filling is disabled so that the extension is inert on my production and banking sites. | High | Open |
| FR-074 | Structural Domain Exclusion | As a Power User, I want an excluded domain expressed as a host pattern to mean the extension's code is never injected there at all, rather than injected and then disabled, so that exclusion is a guarantee about what runs and not just about what it does. | High | Open |
| FR-038 | Exclusion Indicator       | As a Tester, I want a visible indicator when the current domain is excluded so that I understand why nothing happened.                        | Medium   | Open   |

### 1.5 Rules and profiles

| ID     | Title                     | User Story                                                                                                                                | Priority | Status |
|--------|---------------------------|---------------------------------------------------------------------------------------------------------------------------------------------|----------|--------|
| FR-039 | Create Rule               | As a Power User, I want to create a custom field rule with a generator type and match patterns so that a field gets data my application accepts. | High  | Open   |
| FR-040 | Edit Rule                 | As a Power User, I want to edit an existing rule so that I can correct it as the application changes.                                        | High     | Open   |
| FR-041 | Delete Rule               | As a Power User, I want to delete a rule so that my list stays relevant.                                                                     | High     | Open   |
| FR-042 | Reorder Rules             | As a Power User, I want to reorder rules so that I control which one wins when several match the same field.                                 | High     | Open   |
| FR-043 | Preview Rule Output       | As a Power User, I want to see sample values a rule generates before saving so that I can verify a template or regex without reloading a page.| Medium   | Open   |
| FR-044 | Unlimited Rules           | As a Power User, I want no cap on the number of rules so that large applications are fully covered.                                          | High     | Open   |
| FR-045 | Create Profile            | As a Power User, I want to define a named rule set scoped to URLs matching a pattern so that each application I test gets its own data.       | High     | Open   |
| FR-046 | Manage Profiles           | As a Power User, I want to edit and delete profiles so that they track the applications I actually work on.                                  | High     | Open   |
| FR-047 | Active Profile Indicator  | As a Tester, I want to see which profile applies to the current page so that I can tell whether my scoped rules are in effect.                | Medium   | Open   |

### 1.6 Settings lifecycle

| ID     | Title                     | User Story                                                                                                                                | Priority | Status |
|--------|---------------------------|---------------------------------------------------------------------------------------------------------------------------------------------|----------|--------|
| FR-048 | Default Configuration     | As a Tester, I want a useful default rule set on first install so that the extension is valuable before I configure anything.                | High     | Open   |
| FR-049 | Behaviour Defaults        | As a Power User, I want to configure default maximum length, consent keywords and confirmation keywords so that generic filling suits my forms.| Medium  | Open   |
| FR-050 | Trigger Configuration     | As a Power User, I want to enable or disable the context menu and to reach the browser's shortcut settings so that I control how fills are invoked. | Medium | Open |
| FR-051 | Live Propagation          | As a Power User, I want settings changes to take effect in open tabs without reloading them so that iterating on a rule is fast.             | High     | Open   |
| FR-052 | Export Settings           | As a Power User, I want my configuration exported as plain, pretty-printed JSON so that I can diff it, review it and keep it in version control alongside my team's other config. | High | Open |
| FR-053 | Import Settings           | As a Power User, I want to import a configuration file so that I can restore a backup or adopt a colleague's setup.                          | High     | Open   |
| FR-054 | Import Validation         | As a Power User, I want an import that is malformed or from an unsupported version rejected with a clear reason so that I do not silently lose my configuration. | High | Open |
| FR-073 | Schema Migration          | As a Power User, I want an older configuration migrated to the current schema automatically, with no option to load it unmigrated, so that a bypass can never write inconsistent data into my settings. | High | Open |
| FR-055 | Migrate From Fake Filler  | As a Migrating User, I want to import a Fake Filler backup file so that I can switch without rebuilding my rules by hand.                    | High     | Open   |
| FR-056 | Migration Report          | As a Migrating User, I want a summary of what was imported and what could not be mapped so that I know exactly what to fix up.               | Medium   | Open   |
| FR-057 | Restore Defaults          | As a Power User, I want to reset all settings to defaults with a confirmation step so that I can recover from a broken configuration.        | Medium   | Open   |
| FR-058 | Cross-Device Sync         | As a Power User, I want my configuration synchronised across my signed-in browsers with no account of my own so that I get the same setup everywhere. | High | Open |
| FR-059 | Sync Failure Visibility   | As a Power User, I want to be told when sync cannot store my configuration so that I do not believe a device is up to date when it is not.    | Medium   | Open   |

### 1.7 Transparency and support surfaces

| ID     | Title                     | User Story                                                                                                                                | Priority | Status |
|--------|---------------------------|---------------------------------------------------------------------------------------------------------------------------------------------|----------|--------|
| FR-060 | Shortcut Discovery        | As a Tester, I want to see my current shortcuts and reach the browser page that changes them so that I can set up my keys.                   | Medium   | Open   |
| FR-061 | Changelog                 | As a Tester, I want to read what changed in each version so that I understand new behaviour after an update.                                 | Low      | Open   |
| FR-062 | Attribution               | As an Auditor, I want the extension to show its licence and the upstream MIT attribution so that provenance is clear.                        | High     | Open   |
| FR-063 | Build Verification        | As an Auditor, I want each release to publish its source tag and artefact digest so that I can confirm the store build matches public source.| High     | Open   |
| FR-064 | Undo Last Fill            | As a Tester, I want to restore the values a fill overwrote so that I can recover from filling the wrong form.                                | Low      | Deferred |

---

## 2. Non-Functional Requirements

| ID      | Title                      | Requirement                                                                                                                    | Category        | Priority | Status |
|---------|----------------------------|---------------------------------------------------------------------------------------------------------------------------------|-----------------|----------|--------|
| NFR-001 | Fill Latency               | A page with 500 fillable controls must be completely filled within 500 ms measured from trigger to last event dispatched.       | Performance     | High     | Open   |
| NFR-002 | Trigger Responsiveness (warm) | With the background context already running, the first field must receive a value within 100 ms of the trigger on a page with fewer than 50 controls. | Performance | Medium | Open |
| NFR-003 | Page Agent Size            | The page agent bundle must not exceed 40 KB **minified and uncompressed**. Derived from NFR-005: at ~0.1 ms/KB for parse and compile, 40 KB costs ~4 ms per frame, staying inside the 15 ms page-load budget across up to three frames. Compressed size is not the metric — an extension bundle is read from disk, never transferred, so parse cost scales with uncompressed bytes. | Performance | High | Open |
| NFR-027 | Trigger Responsiveness (cold) | After background-context eviction, the first field must receive a value within 400 ms of the trigger, covering service-worker restart plus corpus load. | Performance | Medium | Open |
| NFR-028 | Corpus Load Budget         | Loading the data corpus in the background must complete within 250 ms on a cold start, and must happen once per background lifetime rather than per fill. | Performance | Medium | Open |
| NFR-029 | Fill Round-Trip Overhead   | The page-agent-to-background round trip must add no more than 20 ms to a warm fill, independent of how many fields are in the descriptor batch. | Performance | Medium | Open |
| NFR-004 | Idle Footprint             | The page agent must add no more than 2 MB of heap per tab while idle.                                                           | Performance     | Medium   | Open   |
| NFR-005 | Page Load Impact           | Extension presence must add no more than 15 ms to page load, measured as median over 20 loads of a reference page.              | Performance     | Medium   | Open   |
| NFR-006 | Zero Autonomous Network    | The extension must issue no outbound network request the user did not initiate: no telemetry, no update checks, no remote configuration, and no remotely hosted font, stylesheet, script or image. A navigation the user starts by activating a link is not a request by the extension and is out of scope here. Verified by an automated test asserting zero requests across a full session in which no link is activated. | Security | High | Open |
| NFR-007 | No Remote Code             | All executable code must ship inside the package; no `eval`, no `new Function`, no injected remote scripts.                     | Security        | High     | Open   |
| NFR-008 | Declared Permissions       | The extension must request no permission beyond `storage`, `contextMenus`, `scripting`, `activeTab` and a content script matching all URLs (per DD-001), and must not request `tabs`, `webRequest`, `cookies`, `history` or `downloads`. Marketing and store copy must not describe the extension as minimal-permission. | Security | High | Open |
| NFR-009 | Regex Safety               | A user-supplied regular expression must not be able to hang the page; generation must abort after 250 ms per field.             | Security        | High     | Open   |
| NFR-010 | No Retention of Page Data  | The extension must never retain any value originating from a page — existing field contents, page text, or anything the user typed — beyond the operation that read it, and must never write such a value to storage or include it in a message beyond the fill it belongs to. | Security | High | Open |
| NFR-031 | Generated Data Lifetime    | Synthetic data the extension generates must be discarded when a fill completes, unless the user has explicitly asked for it to persist across fills; where they have, it must be held in volatile memory only, be discardable by a single user action, and never be written to storage or transmitted. | Security | High | Open |
| NFR-030 | Descriptor Confinement     | Field descriptors sent from the page agent to the background must carry only matching-relevant attributes, must never include a field's existing value, and must not be persisted after the fill completes. | Security | High | Open |
| NFR-011 | Reproducible Build         | Building the tagged source in CI must produce a package whose SHA-256 digest matches the published release artefact.            | Maintainability | High     | Open   |
| NFR-012 | Engine Test Coverage       | The fill engine and generators must reach at least 90% line coverage under unit test.                                           | Maintainability | High     | Open   |
| NFR-013 | Regression Suite           | Each defect listed in `docs/vision.md` §7.2 must have a dedicated failing-then-passing regression test.                         | Maintainability | High     | Open   |
| NFR-014 | End-to-End Coverage        | An automated browser test must fill the reference page covering every supported control type in Chromium on every change, and in Firefox on every release candidate. Engine unit tests run identically against both targets on every change. | Maintainability | High | Open |
| NFR-015 | Engine Isolation           | The fill engine must contain no reference to the `chrome`/`browser` namespace and must be unit-testable without a browser extension host. | Maintainability | High | Open |
| NFR-016 | Browser Support            | Must run on Chrome 120+, Edge 120+ and Firefox 128+.                                                                            | Portability     | High     | Open   |
| NFR-017 | Single Codebase            | Chromium and Firefox packages must be produced from one source tree with no forked engine or UI code.                           | Portability     | High     | Open   |
| NFR-018 | Localisation Readiness     | All user-facing strings must be resolved through the i18n message catalog; none hard-coded in components.                       | Portability     | Medium   | Open   |
| NFR-019 | Options UI Accessibility   | The options UI must meet WCAG 2.1 AA, including full keyboard operation of rule reordering.                                     | Usability       | High     | Open   |
| NFR-020 | Failure Legibility         | Every failure path visible to the user must state the cause and the corrective action in one sentence.                          | Usability       | Medium   | Open   |
| NFR-021 | Settings Durability        | No settings write may leave storage in a partially written state; a failed write must leave the previous configuration intact.  | Availability    | High     | Open   |
| NFR-022 | Sync Quota Compliance      | Synchronised data must stay within 8 KB per item and 102 KB total, and must degrade to local-only storage rather than fail when exceeded. | Scalability | High | Open |
| NFR-023 | Sync Write Rate            | Settings writes must be debounced so that no more than 100 sync write operations occur per hour under continuous editing.        | Scalability     | Medium   | Open   |
| NFR-024 | Rule Scale                 | The options UI and matcher must handle 500 rules with no interaction exceeding 100 ms.                                          | Scalability     | Medium   | Open   |
| NFR-025 | Pattern Precompilation     | Rule patterns must be compiled once when settings load and reused; a fill run must construct no `RegExp` per element per rule.  | Performance     | High     | Open   |
| NFR-026 | Settings Read Caching      | The background context must serve settings from memory, performing at most one storage read per settings change rather than one per page or frame load. | Performance | Medium | Open |

---

## 3. Constraints

| ID    | Title                        | Constraint                                                                                                                     | Category    | Priority | Status |
|-------|------------------------------|-----------------------------------------------------------------------------------------------------------------------------------|-------------|----------|--------|
| C-001 | Manifest Version             | Must ship Manifest V3; Manifest V2 is no longer accepted by the Chrome Web Store.                                                 | Technical   | High     | Open   |
| C-002 | Implementation Language      | Must be TypeScript in strict mode; browser extension APIs are JavaScript-only.                                                    | Technical   | High     | Open   |
| C-003 | Background Model Difference  | Chromium requires `background.service_worker`; Firefox requires `background.scripts`. The manifest must be generated per target.   | Technical   | High     | Open   |
| C-004 | Firefox Identity             | The Firefox package must declare `browser_specific_settings.gecko.id`.                                                            | Technical   | High     | Open   |
| C-005 | Sync Storage Limits          | `storage.sync` enforces 8,192 bytes per item, 102,400 bytes total, and 1,800 writes per hour.                                     | Technical   | High     | Open   |
| C-006 | Closed Shadow Roots          | Controls inside closed shadow roots are unreachable by any extension API and are permanently out of scope.                        | Technical   | High     | Open   |
| C-007 | Cross-Origin Frames          | Filling inside a cross-origin iframe requires injection into that frame; it cannot be reached from the parent document.           | Technical   | High     | Open   |
| C-008 | No Backend or Phoning-Home Dependency | No server-side component or account system may be introduced (per PD-001), and no runtime dependency shipped in the bundle may issue network requests, persist state outside the extension's own storage, or execute remote code. Build-time and development tooling are unconstrained by this. | Technical | High | Open |
| C-009 | Upstream Attribution         | The upstream MIT copyright notice and permission text must be retained and shipped with the extension.                            | Regulatory  | High     | Open   |
| C-010 | Trademark Separation         | The name, logo, icons, store imagery and listing copy must share nothing with "Fake Filler".                                       | Regulatory  | High     | Open   |
| C-011 | Store Privacy Disclosure     | Store listings must declare data handling; the declaration must state that no user data is collected.                             | Regulatory  | High     | Open   |
| C-012 | Store Review Policy          | The package must satisfy Chrome Web Store and AMO review policy, including the single-purpose rule and no obfuscated code.        | Regulatory  | High     | Open   |
| C-013 | Solo Maintainer              | Scope must fit one developer; anything requiring ongoing operational duty (a backend, support inbox, billing) is out.              | Business    | High     | Open   |
| C-014 | Public Development           | All source that produces a released artefact must be public at the tagged commit (per G4).                                        | Operational | High     | Open   |

---

## 4. Known Conflicts

| Conflict | Detail | Resolution |
|---|---|---|
| ~~NFR-008 vs FR-003~~ | Minimal permissions favoured on-demand injection, but "fill this input" needs a listener present *before* the right-click that identifies the target element. | **Resolved 2026-08-12 (DD-001):** persistent injection chosen. Chrome exposes no element identifier on context-menu clicks, so on-demand cannot support FR-003 reliably. NFR-008 rewritten; the minimal-permission claim is withdrawn rather than fudged. |
| **FR-037 vs FR-074** | Regular-expression domain patterns cannot be translated into the host match patterns the browser needs in order to *not* inject. | Open. Likely two tiers: host patterns get true non-injection (FR-074), regex patterns fall back to injected-then-inert (FR-037). The UI must not present the two as equivalent. |
| **FR-058 vs C-005/NFR-022** | Sync must carry an unlimited rule set (FR-044) through an 8 KB-per-item quota. | Open — tracked as **DD-002**. Sharding or local fallback; requires a sizing exercise. |
| ~~FR-019 vs NFR-003~~ | Richer generated data argued for a large corpus; the page-agent size budget argued against. | **Resolved 2026-08-12 (DD-003):** generation moved to the background. The corpus never enters the page agent, so the two requirements no longer compete. New cost is a round trip and a cold start, bounded by NFR-027..029. |
