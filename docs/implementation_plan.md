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

**Moved to Phase 4, 2026-08-14:** the settings-schema row — the discriminated union on
generator type with the migration ladder (ND-9, DD-005, FR-073). It sat in Phase 0 from the
first draft, but `src/lib/settings.ts` deliberately ships only the versioned stub: DD-005 is
open, and writing a migration ladder against an undecided shape is what ordering principle 4
exists to prevent. The schema is first needed by Phase 4's rule authoring, and DD-005 closes
before that lands — the latest point at which the ladder can still be written against a
moving shape. With the row gone, "one spike left" below is true again rather than one open
row too optimistic.

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

*Goal: the product is genuinely useful, with defaults only and no settings UI.*

| UC | Brings |
|---|---|
| **UC-004** (full) | Record-first generation (ND-1); all input types; native constraints; source-scoped matching with provenance (ND-2); implicit labels; per-type sizing |
| **UC-005** (full) | Hidden, pre-filled, ignore patterns, honeypot detection |
| **UC-006** Reuse a Value for a Confirmation Field | Resolved against the record, not DOM order |
| **UC-034** Fill Fields That Depend on an Earlier Answer | DD-009 — in three steps, below |
| — | Fill report (FR-009), per-element error isolation (FR-010), nested frames, open shadow roots |

At the end of this phase the extension does the job. Everything after it is control,
convenience and trust.

### UC-034 in three steps

DD-009 is the largest single change in this phase and the only one that touches both sides of
the DD-003 boundary. It is sequenced so that each step is shippable and the later ones cannot
be trusted without the earlier ones.

| Step | Brings | Depends on | State |
|---|---|---|---|
| **A · Honesty floor** | Per-kind write verification (FR-076), the stale/rejected outcome, `summarise` handling it. No NFR changes, no loop, shippable alone. | — | **Landed 2026-08-15** |
| **B · The fixpoint loop** | Element tokens and token-seeded generation (FR-080), the two observation signals, the re-fill rules, the pass and time bounds (FR-078, NFR-034), the trusted-input rule (FR-079), teardown (NFR-035), the sliding operation deadline, the compatible protocol delta. | A — a loop that cannot tell whether a write survived cannot decide what to re-fill | **Landed 2026-08-15** |
| **C · Combobox ladder** | FR-081, with the restore rung. | B, and a measurement | Open |

Step B landed with three things the decision did not anticipate — a per-control write bound, a
control the page removed being dropped from the report rather than double-counted, and frames
announcing themselves so completion is known rather than inferred from silence. Each is
recorded under "What building it changed" in DD-009. The cascade fixture now reports **16
claimed filled against 16 the page holds**, of 17 fillable; the seventeenth is the field the
page will not let anyone fill, and it is reported as a failure.

The pass cap was set by measurement rather than by argument: lowering it until the fixture
broke showed the matrix fills in three passes and settles in four, and the shipped cap is that
doubled.

Step A first is not caution, it is a dependency: the loop's central decision — *does this
control need another pass?* — is a verification question, so building the loop on an
unverified report means building it on a guess.

Step C is gated on a measurement rather than scheduled, and the measurement is a **latency**
one: widening the walk's candidate selector to find `role="combobox"` grows the candidate set
on **every** page, not only on pages that have one, so the cost lands on NFR-001's per-fill
budget everywhere. Measure that inflation against the reference page before committing.

Per `vision.md` §3, coverage yields to a budget where correctness does not, so C is the part of
DD-009 that gets cut if the measurement is bad — an honestly skipped combobox is a correct
outcome.

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

---

## Phase 4 — Configuration

*Goal: users can shape the engine's behaviour.*

- **Settings schema** — the full discriminated union on generator type and the migration
  ladder (ND-9, DD-005, FR-073), moved here from Phase 0 on 2026-08-14: DD-005 closes
  first, and everything else in this phase serialises the schema it produces
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

---

## Deferred

| UC | Why |
|---|---|
| **UC-033** Undo the Last Fill | FR-064, Low. Needs the engine to retain the user's *own* prior field values, which NFR-010 forbids without qualification — that rule covers page-derived data and has no exception. Distinct from persona continuity, which NFR-031 permits because a persona is synthetic. Resolve the NFR-010 tension before scheduling; the two are not one problem. |

---

## Critical path

```
Phase 0 scaffold ─► Phase 1 skeleton ─► Phase 2 engine ─► Phase 3 scopes ─┐
                                                                           ├─► Phase 7
schema (ND-9) ─► Phase 4 config ─► Phase 5 profiles ─► Phase 6 portability ─┘
                                                  DD-002 ─┘
```

All the decisions that gated the engine are now closed. Two remain on the path: **DD-005**
(schema versioning), which gates the schema work that now opens Phase 4, and **DD-002**
(sync quota), which blocks nothing before Phase 6 and can be resolved as late as UC-029
without holding anything up. **DD-006** (the feedback surface) sits off the path: Phase 1
shipped a provisional badge, and the decision is what replaces it — carrying obligations
from DD-008 and DD-009 until then.

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
