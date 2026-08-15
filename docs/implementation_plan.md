# FieldFiller — Implementation Plan

**Status:** Draft v0.1
**Date:** 2026-08-12
**Inputs:** `docs/vision.md` · `docs/requirements.md` · `docs/use_case_catalog.md`

Build order for the 34 use cases. Each phase writes the specs for its own use cases just
before building them — specification and implementation move together rather than as two
separate passes, so this is the single ordering for both.

## Ordering principles

1. **Decisions before code they invalidate.** ND-1 and ND-2 change the engine's control flow
   and the rule data model. Deciding them after the engine exists means rewriting it.
2. **Walking skeleton early.** Get one trigger filling one field end to end, in both
   browsers, before building breadth. Integration risk is the risk that hides longest.
3. **Engine before UI.** The engine is the product; the options page configures it. Building
   configuration for behaviour that doesn't exist yet inverts the dependency.
4. **Schema stable before portability.** Export, import, migration and sync all serialise the
   settings schema. Written before profiles exist, every one of them gets rewritten when
   profiles land.
5. **Value density.** "Fill all inputs with sensible defaults" is most of the product's
   worth. It ships in Phase 2, not Phase 6.

---

## Phase 0 — Decisions and foundations

*No user-visible output. Everything downstream is cheaper or more expensive based on this.*

**Decided 2026-08-12:** DD-001 → persistent `<all_urls>` · DD-003 → generation in the
background, no corpus in the page agent · DD-004 → WXT · ND-1 → full persona · ND-2 →
source-scoped matching · ND-9 → discriminated union. **One spike left.**

**Decided 2026-08-14:** DD-009 → event-driven fixpoint loop in the page agent for dependent
and late-appearing fields, amending DD-003 to one round trip per pass. Lands in Phase 2 as
UC-034; it needs the full walk, exclusion and report machinery underneath it, and none of
that exists before then.

**Moved to Phase 4, 2026-08-14; moved back into Phase 2, 2026-08-15.** The settings-schema row
— the discriminated union on generator type (ND-9, DD-005, FR-073) — sat in Phase 0 from the
first draft and was deferred because writing a migration ladder against an undecided shape is
what ordering principle 4 exists to prevent. What the deferral did not anticipate is that eight
Phase 2 requirements need the *rule model*, which needs the schema: the conflict is described
under "Where Phase 2 actually stands" below. Resolved by deciding DD-005 early rather than by
moving those rows, so the schema is designed once. The ladder itself is the one part not
built — DD-005 accepts a tolerant parser in its place and records what that costs.

| Work | Closes |
|---|---|
| **Spike: cold-start budget** — measure background restart + corpus load + round trip against NFR-027 (400 ms). If it fails, the corpus shrinks or gets lazily sliced | NFR-027, NFR-028, NFR-029 |
| Scaffold WXT, TS strict, Chrome + Firefox from one source tree | C-002, C-003, C-004, NFR-017 |
| Message protocol: field descriptors out, values plus provenance back | NFR-029, NFR-030, FR-069 |
| CI: build, test, **uncompressed** page-agent size budget, disallowed-import check | NFR-003, **ND-4** |
| **Reproducible build pipeline** — pinned lockfile, `SOURCE_DATE_EPOCH`, deterministic archive member order and timestamps, no build-time clock or randomness reaching the bundle, digest published per build | NFR-011, G4, UC-032 |
| **Reference test page** — every control type, shadow root, cross-origin iframe, honeypot | the acceptance harness for every later phase |

Nothing here ships. All of it is load-bearing.

Reproducibility gets its own row because bundlers are not reproducible by default — they
embed timestamps, order archive members by filesystem enumeration, and minify with passes
that are not always stable. Left until later, the digests simply differ on every build and
G4's verifiable-build claim collapses with nothing to show for it. It has to be true from the
first build, not retrofitted before the first release.

DD-001 resolving to persistent injection makes the page-agent size budget (NFR-003) the
single most load-bearing non-functional requirement in the project: our code now runs on
every page the user visits, so its weight is a permanent tax on their browsing. The CI size
check is not hygiene, it is the requirement that keeps the decision defensible.

---

## Phase 1 — Walking skeleton

*Goal: click the toolbar button, watch a text input fill, in Chrome and Firefox.*

| UC | Scope at this phase |
|---|---|
| **UC-024** Persist and Propagate Settings | Read defaults from storage; no UI yet |
| **UC-005** Exclude a Field from Filling | Structural exclusions only (`disabled`, `readonly`, `type=button\|submit\|hidden\|file\|image`) |
| **UC-004** Determine the Value for a Field | Text inputs only, no rule matching, framework-safe write + correct event sequence |
| **UC-001** Fill All Inputs | Toolbar trigger only, single frame |

Proves the whole pipeline — background → injection → engine → DOM → events — before any of
it is built out. This is also where the cold-start numbers become real rather than estimated,
at the cost of a week rather than a quarter.

---

## Phase 2 — Engine completeness

*Goal: the product is genuinely useful, with sensible defaults and no settings UI.*

| UC | Brings |
|---|---|
| **UC-004** (full) | Record-first generation (ND-1); all input types; native constraints; source-scoped matching with provenance (ND-2); implicit labels; per-type sizing |
| — | The settings schema and rule model (DD-005, pulled forward 2026-08-15): thirteen generator types, three match modes, save-time validation, and the ReDoS filter behind it |
| **UC-005** (full) | Hidden, pre-filled, ignore patterns, honeypot detection |
| **UC-006** Reuse a Value for a Confirmation Field | Resolved against the record, not DOM order |
| **UC-034** Fill Fields That Depend on an Earlier Answer | DD-009 — in three steps, below |
| — | Fill report (FR-009), per-element error isolation (FR-010), nested frames, open shadow roots |

At the end of this phase the extension does the job. Everything after it is control,
convenience and trust.

### Where Phase 2 actually stands, 2026-08-15

Reconciling `requirements.md` against the test suite after DD-009 gave the first honest
picture: **51 Done, 13 Partial, 9 Blocked, 44 Open** — 117 rows, being the 82 functional and 35
non-functional requirements that existed at that moment. After DD-005 and DD-006 both landed
later the same day, and Phase 3 after them, the count reads **70 Done, 10 Partial, 1 Blocked,
50 Open and 1 Deferred**, across **132**: the same rows plus NFR-036, which DD-009 added, plus
the 14 Constraints.

**The two denominators are stated because they differ, and the difference is not only
arithmetic.** The Constraints carry a status column and every one of the 14 reads `Open` — as a
default nobody ever revisited, not as an assessment. Several are demonstrably satisfied and
gated in CI (C-001 Manifest V3, C-002 TypeScript strict, C-003 the per-target background model),
so the 132-row tally's `Open` count is inflated by rows that were never scored. Recorded here
rather than corrected in passing: scoring 14 constraints is a judgement per row, and the
regulatory ones are not ours to mark off between commits.

The single remaining Blocked row is NFR-028, waiting on the data
corpus rather than on any decision. Almost everything Phase 2
lists is built and verified — every control kind, native constraints, the framework-safe write,
the full exclusion set with honeypots, confirmation mirroring, coherent personas, frames, shadow
roots, error isolation, and all three steps of UC-034.

**What was left in this phase was blocked by a decision this plan deferred past it.**
FR-019..FR-022 (generator types, alphanumeric templates, regex, randomized list), FR-031
(precedence), FR-067, FR-068 and FR-070 are all rule-driven, and the rule model needs the
settings schema — DD-005, which was moved to Phase 4 on 2026-08-14 for its own good reasons.
**Eight** requirements were therefore parked in a phase whose exit criterion could not include
them. (Earlier revisions of this paragraph said nine, by reading the tally's nine `Blocked` rows
as nine blocked *by DD-005*. The ninth was NFR-028, which waits on the corpus and always did.)

**Resolved 2026-08-15 by bringing DD-005 forward**, the first of the two options recorded here.
The whole schema is fixed rather than the rule model alone, because Phase 5 is stated below to
be the last change to the schema and Phase 6 depends on that being true. All eight requirements
are built and tested; the screens that author them remain Phase 4. See DD-005 in `vision.md`
for the decision and for the one cost it accepts — no migration ladder, so a future structural
change loses what the tolerant parser cannot recognise.

**Phase 2 is therefore complete**, and completed as written rather than by redefining its exit.

**Two things remain unscheduled anywhere**, and both were surfaced by DD-009's work rather than
by this plan:

- **The data corpus.** `persona.ts` carries about fifty placeholder entries. Every Phase 0
  latency budget was written against a corpus that does not exist: NFR-028 (250 ms to load it)
  has never been measurable, and NFR-027's cold-start figure is a floor rather than a result,
  with roughly 390 ms of its 400 ms budget reserved for something unwritten.
- **FR-082**, persona-preferred options, which UC-004 owes and DD-009 deliberately split off.

### UC-034 in three steps

DD-009 is the largest single change in this phase and the only one that touches both sides of
the DD-003 boundary. It is sequenced so that each step is shippable and the later ones cannot
be trusted without the earlier ones.

| Step | Brings | Depends on | State |
|---|---|---|---|
| **A · Honesty floor** | Per-kind write verification (FR-076), the stale/rejected outcome, `summarise` handling it. No NFR changes, no loop, shippable alone. | — | **Landed 2026-08-15** |
| **B · The fixpoint loop** | Element tokens and token-seeded generation (FR-080), the two observation signals, the re-fill rules, the pass and time bounds (FR-078, NFR-034), the trusted-input rule (FR-079), teardown (NFR-035), the sliding operation deadline, the compatible protocol delta. | A — a loop that cannot tell whether a write survived cannot decide what to re-fill | **Landed 2026-08-15** |
| **C · Combobox ladder** | FR-081, with the restore rung. | B, and a measurement | **Landed 2026-08-15** |

Step B landed with three things the decision did not anticipate — a per-control write bound, a
control the page removed being dropped from the report rather than double-counted, and frames
announcing themselves so completion is known rather than inferred from silence. Each is
recorded under "What building it changed" in DD-009. At the point B landed the cascade fixture
reported **16 claimed filled against 16 the page holds**, of 17 fillable, the seventeenth being
the field the page will not let anyone fill — reported as a failure. Step C moved those figures
by adding a control the fixture had never been able to fill; see below for where they stand
now.

The pass cap was set by measurement rather than by argument: lowering it until the fixture
broke showed the matrix fills in three passes and settles in four, and the shipped cap is that
doubled.

Step A first is not caution, it is a dependency: the loop's central decision — *does this
control need another pass?* — is a verification question, so building the loop on an
unverified report means building it on a guess.

Step C was gated on a measurement rather than scheduled, and the measurement was a **latency**
one: widening the walk's candidate selector to find `role="combobox"` was expected to grow the
candidate set on **every** page, not only on pages that have one, so the cost would land on
NFR-001's per-fill budget everywhere. Per `vision.md` §3, coverage yields to a budget where
correctness does not, so C was the part of DD-009 that got cut if the number was bad.

**Measured 2026-08-15 (`scripts/spike-combobox.mjs`, `pnpm run spike:combobox`). The gate is
passed, and the premise behind it was wrong.**

| Page | Candidates | Walk | Cost |
|---|---|---|---|
| Reference fixture, 105 elements | 32 → 32 | 0.012 → 0.014 ms | — |
| Cascade fixture, 93 elements | 18 → 19 | 0.012 → 0.012 ms | — |
| **Application page, 500 controls, no combobox** | **500 → 500** | 0.346 → 0.398 ms | **+0.052 ms, 0.01% of NFR-001** |
| Design system, 500 controls, 60 comboboxes | 500 → 560 | 0.360 → 0.410 ms | +0.050 ms |

Candidate-set inflation on a page with no combobox is **zero**, not small — an attribute
selector matches only elements carrying the attribute, so classification, identification and
generation see exactly what they saw before. What the widening actually costs is selector
*matching*, and on a 3,591-element application page that is 0.05 ms. The worry was aimed at
the wrong quantity.

**The cost that does exist is somewhere else, and this measurement does not cover it.** Driving
a combobox means interacting with it and waiting for the page to respond, per control. Sixty of
them on one page is the number that could threaten NFR-001, not the selector. So C ships with a
per-control interaction budget and a per-pass total (NFR-036), and reports the overflow as
skipped rather than spending an unbounded amount of time — which is the same shape as every
other bound in DD-009, and the reason A10 already exists.

**Landed 2026-08-15.** The ladder cost 3.8 KB, taking the page agent to 18.5 KB of its 40 KB.
The cascade fixture now passes **all 16 of its harness assertions** — the scoreboard rows in
`scripts/e2e-cascade.mjs`, not a count of fields. Two of those rows are the fill counts, and
they are the ones worth quoting: the report claims 17 filled, the page holds 17 filled, and the
fixture offers 18 fillable controls — the eighteenth being the field the page will not let
anyone fill, reported as a failure rather than quietly dropped from both sides. One honesty gap is left and is recorded in BR-034-11 rather than in a comment: the
end-of-fill check on a combobox cannot tell a placeholder from an answer, because telling them
apart means retaining the chosen option's label, which BR-034-11 forbids.

**Not** gated on NFR-003, which is where an earlier draft of this section pointed. Measured
2026-08-14, the page agent was **10.73 KB of its 40 KB** budget, with the full walk, exclusion,
identification and apply machinery in it; steps A and B took it to **14.72 KB**, so the whole
of DD-009's honesty floor and fixpoint loop cost 4 KB against 29 KB of headroom. The ladder is
the same order again. The size gate is still read before and after each step —
it is the requirement that keeps DD-001 defensible, and a change that quietly eats a third of
the headroom should be seen — but it is not the constraint that will decide C's fate.

FR-082 (persona-preferred options) is deliberately **not** here. It is UC-004 generation work
that shares a motivating example with UC-034 — cascading country/state/city — and nothing
else. Sequenced with the rest of UC-004 so the cascade work does not wait on an ISO
normalisation table.

---

## Phase 3 — Scopes and triggers

*Goal: all three fill scopes, all three trigger channels.*

- **UC-002** Fill the Current Form — true form scoping, no `document` reach-through (ND-5)
- **UC-003** Fill the Selected Input — unblocked by DD-001; the persistent page agent records the right-clicked element, so this works identically on both browsers
- **UC-008** Suspend Filling on an Excluded Domain — engine-side enforcement, badge, and non-injection for host-pattern entries (FR-074)
- Keyboard shortcuts and context menu wiring (FR-005, FR-006)

UC-008 lands here rather than with its settings screen: "inert on my banking site" is a trust
property, and trust properties should exist before the thing is shareable.

**Built 2026-08-15.** DD-006 unblocked it — a bare count reads identically for a form and for a
whole page — and the scope turned out to cost exactly what was predicted on the result surface:
nothing. UC-002, UC-003 and UC-008 are specified and built; `scripts/e2e-scopes.mjs` proves each
rung of DD-008's ladder in a real browser, which is where the two defects below were found.

What building it changed:

- **`<body>` cannot be a form root.** Rule 3 walks up looking for a container holding both the
  anchor and a submit control. Almost every page has *a* submit button somewhere, so a walk that
  admits the body returns the whole page — the page scope arriving under the form scope's name,
  and precisely the widening BR-002-2 forbids. The unit tests missed it because their fixtures
  had no submit button outside the block under test; the harness filled all four blocks of its
  fixture and said so.
- **A transient badge must not erase a persistent one.** A fill's badge reverts after three
  seconds. That timer was clearing whatever was on the badge when it fired, so filling a page and
  then invoking a fill on an excluded site inside the window showed "off" and then wiped it. The
  revert now clears only what it set.
- **`activeTab` cannot be synthesised**, so the harness cannot exercise the pattern-matching path
  of UC-008 — a menu click dispatched over CDP is not a user gesture, and the tab's URL comes
  back empty. It asserts UC-008 A1 instead (an unreadable address is treated as excluded), and
  `matchesGlob` carries the patterns in unit tests. Recorded against FR-037 rather than glossed.

---

## Phase 4 — Configuration

*Goal: users can shape the engine's behaviour.*

- ~~**Settings schema**~~ — **done in Phase 2 on 2026-08-15.** DD-005 was brought forward
  rather than closed here, so the discriminated union on generator type (ND-9), every section
  of the schema, and the rule model already exist. What this phase inherits is the screens,
  not the shape. FR-073's migration ladder is the one piece deliberately not built: the
  tolerant parser stands in for it, with the cost written into DD-005
- **UC-024** (full) — durable writes, live propagation to open tabs, in-memory caching (ND-17)
- **UC-009**, **UC-010**, **UC-011**, **UC-012** — rule create / edit / delete / reorder
- **UC-013** Preview Values Generated by a Rule — with authoring-time validation (FR-070)
- **UC-018** matching sources · **UC-019** password · **UC-020** field exclusions ·
  **UC-021** domain exclusions · **UC-022** behaviour defaults · **UC-023** triggers

UC-013 is scheduled with rule authoring rather than after it: writing a regex or template
blind is the worst moment in the reference's UX, and the preview is what makes rule authoring
teachable.

UC-012 carries a decision that is easy to miss: rule reordering must be operable from the
keyboard to satisfy NFR-019. The reference used `react-beautiful-dnd`, now deprecated and
with known accessibility regressions, so the drag implementation is a deliberate choice here
rather than a default.

---

## Phase 5 — Profiles

*Goal: per-application rule sets.*

- **UC-014**, **UC-015**, **UC-016** — profile create / edit / delete
- **UC-017** Identify the Active Profile for a Page — resolution and badge
- **UC-007** Apply a URL Profile — precedence over global rules in the engine

This is the last change to the settings schema. Phase 6 depends on that being true.

---

## Phase 6 — Portability

*Goal: configuration can leave, arrive, and travel between devices.*

- **UC-025** Export Settings — plain JSON (ND-12)
- **UC-026** Import Settings — validation plus the migration ladder, no bypass (ND-13)
- **UC-028** Restore Default Settings
- **UC-027** Migrate Settings from Fake Filler — with an unmapped-items report
- **UC-029** Synchronise Settings Across Devices — *gated on DD-002 (8 KB per-item quota)*

Deliberately last of the functional work. Every use case here serialises the schema; running
this phase before Phase 5 means writing the exporter, the importer and the migration twice.

UC-027 is the one piece with an external deadline pressure — it is how existing Fake Filler
users switch — but it is also the piece most damaged by a moving schema. It stays here.

---

## Phase 7 — Release readiness

*Goal: shippable, and the trust claims are real rather than asserted.*

- **UC-032** Verify the Published Build — publish source tag and artefact digest; the CI from
  Phase 0 becomes a user-facing guarantee
- **UC-030** Review Keyboard Shortcuts · **UC-031** Review the Changelog
- Attribution and licence surface (FR-062, C-009)
- Store listings, privacy disclosures, screenshots — all original (C-010, C-011)
- Full NFR verification pass: latency, bundle size, zero-network, accessibility, coverage
- **A Firefox end-to-end fill**, which NFR-014 asks for and CI does not have. `smoke:firefox`
  proves the add-on installs and that `gecko.id` is honoured; it fills nothing, and there is no
  `e2e:firefox` or `cascade:firefox` to run. Corrected from Done to Partial on 2026-08-15 —
  every claim about cross-browser *behaviour* currently rests on one browser plus a shared
  source tree. The harness exists in outline: `smoke-firefox.mjs` already drives Firefox over
  WebDriver BiDi, so what is missing is the fill trigger and the assertions, not the transport

---

## Deferred

| UC | Why |
|---|---|
| **UC-033** Undo the Last Fill | FR-064, Low. Needs the engine to retain the user's *own* prior field values, which NFR-010 forbids without qualification — that rule covers page-derived data and has no exception. Distinct from persona continuity, which NFR-031 permits because a persona is synthetic. Resolve the NFR-010 tension before scheduling; the two are not one problem. |

---

## Critical path

```
Phase 0 ─► Phase 1 ─► Phase 2 engine + schema (ND-9, DD-005) ─┬─► Phase 3 scopes ────────────────────────────────────────────┐
                                                              │                                                              │
                                                              └─► Phase 4 config ─► Phase 5 profiles ─► Phase 6 portability ─┴─► Phase 7
                                                                                                            ▲
                                                                                                   DD-002 (sync quota)
```

Phase 7 waits on **both** upper branches, not on Phase 3 alone: it is the release phase, and a
release ships the configuration and portability work as much as the scopes. The `┴` is where
they meet. **DD-002** enters from below because it gates Phase 6 and nothing else — an earlier
drawing of this graph put its connector in the Phase 7 junction's column, where it read as a
decision blocking the release. It is not one.

All the decisions that gated the engine are now closed, and **DD-005** closed with them on
2026-08-15 — pulled forward out of Phase 4, which is why the schema arrow above now feeds the
engine rather than trailing it. **DD-002** (sync quota) is the only decision left on the path;
it blocks nothing before Phase 6 and can be resolved as late as UC-029 without holding anything
up. **DD-006** (the feedback surface) was decided and built on 2026-08-15: badge, tooltip and the
options-page report. Phase 3 is therefore unblocked — UC-002 and UC-003 need only supply their
own scope value, because the sentence already names one.

The cold-start spike is the sole remaining unknown, and it is a tuning question rather than
an architectural one: if the corpus loads too slowly, the corpus shrinks. It cannot invalidate
Phase 1.

## Shippable points

| After | You could ship |
|---|---|
| Phase 2 | A usable, defaults-only filler. Genuinely competitive on the engine alone. |
| Phase 4 | Feature parity with the reference's free tier, minus profiles. |
| Phase 5 | **Full parity with the reference's paid tier**, all free. |
| Phase 7 | The differentiated product: verifiable build, no network capability, 40 KB page agent. |

Phase 5 is the earliest defensible public release. Phase 2 is the earliest useful one, and is
worth putting in front of a few testers even if it never reaches a store.
