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
source-scoped matching · ND-9 → discriminated union. **The one spike left was run on 2026-08-15**,
against the real corpus rather than a placeholder, and is recorded in the table below.

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

| Work | Closes | Built |
|---|---|---|
| **Spike: cold-start budget** — measure background restart + corpus load + round trip against NFR-027 (400 ms) | NFR-027, NFR-028, NFR-029 | **Yes** — `scripts/spike-coldstart.mjs`, re-run 2026-08-15 against the real corpus: 14.0 ms cold start of 400 ms, 0.2 ms per round trip of 20 ms. All three rows `Done` |
| Scaffold WXT, TS strict, Chrome + Firefox from one source tree | C-002, C-003, C-004, NFR-017 | **Yes** — NFR-017 `Done`. C-002..C-004 are satisfied and gated, and still read `Open`: see the constraints note below |
| Message protocol: field descriptors out, values plus provenance back | NFR-029, NFR-030, FR-069 | **Yes** — `src/lib/protocol.ts`; FR-069 `Done`, NFR-030 `Done` by construction |
| CI: build, test, **uncompressed** page-agent size budget, disallowed-import check | NFR-003, **ND-4** | **Yes** — `check-size.mjs` and `check-imports.mjs`, joined since by the network, permissions and coverage-scope gates |
| **Reproducible build pipeline** — pinned lockfile, `SOURCE_DATE_EPOCH`, deterministic archive member order and timestamps, no build-time clock or randomness reaching the bundle, digest published per build | NFR-011, G4, UC-032 | **Yes** — `check-reproducible.mjs` and `digest.mjs`, both in CI on every push. NFR-011 `Done`; UC-032, the auditor's *use* of it, is Phase 7 and unstarted |
| **Reference test page** — every control type, shadow root, cross-origin iframe, honeypot | the acceptance harness for every later phase | **Yes** — `tests/fixtures/reference.html`, joined since by `cascade.html` and `scopes.html` |

Nothing here ships. All of it is load-bearing.

**Phase 0 is complete**, and the table says so per row rather than leaving it to be inferred from
the phases built on top of it. Two things the "Built" column deliberately does not round off:
UC-032 is the auditor's use of the reproducible pipeline and belongs to Phase 7, so NFR-011 being
`Done` does not close it; and **C-002, C-003 and C-004 read `Open` in §3 of the catalog while this
table calls the work that satisfies them built**. That is the unscored-constraints gap recorded
under "Where Phase 2 actually stands" — the constraints were never scored at all, and this row is
where the omission is most visible, since the scaffold closing them is the oldest work in the
project.

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
later the same day, then Phase 3, the data corpus and Phase 4's rule editor after them, the
count reads **79 Done, 9 Partial, 43 Open and 1 Deferred — and nothing Blocked**, across
**132**: the same rows plus NFR-036, which DD-009 added, plus the 14 Constraints.

**Recounted 2026-08-17, after Phase 4's settings screens: 83 Done, 6 Partial, 38 Open and 1
Deferred, still nothing Blocked, across 128 status-bearing rows.** Six requirements moved:
FR-014, FR-025, FR-028 and FR-036 from `Partial`, and FR-049 and FR-050 from `Open`.

**Recounted again 2026-08-17 after Phase 5: 86 Done, 6 Partial, 35 Open, 1 Deferred over the
same 128.** Three moved, all from `Open`: FR-045, FR-046 and FR-047.

**And again the same day, after the Firefox engine harness: 87 Done, 5 Partial, 35 Open, 1
Deferred.** NFR-014 moved from `Partial`, having been the longest-standing one in the table.

**Recounted 2026-08-22 after UC-025: 88 Done, 5 Partial, 34 Open, 1 Deferred, over the same
128.** One row moved — FR-052, the export — and it is recorded here rather than left to be
inferred because the denominator is the part of this tally that has been wrong before.

**And after UC-026 the same day: 90 Done, 5 Partial, 32 Open, 1 Deferred.** FR-053 and FR-054
moved from `Open`. FR-073 deliberately did not move: the ladder it asks for is still not built,
and what UC-026 added is a report of what the parser dropped in its place.

**Recounted 2026-08-24 after UC-028: 92 Done, 5 Partial, 30 Open, 1 Deferred, over the same
128.** FR-048 and FR-057 moved from `Open` — the restore itself, and the default configuration
it lands. FR-048 is worth the sentence: it moved `Done` by way of a narrowing rather than a
build, since the requirement's written form asks for a starter rule set and what shipped is an
empty list on purpose (BR-028-4) — the third requirement in the project whose honest form is
narrower than its written one, after FR-047 and FR-074.

The denominator moved too, from 132 to 128, and that is a *counting* correction rather than
four requirements disappearing. Four rows in the "Guarantees held by construction" table begin
with `FR-` or `NFR-` and carry a description of the check that would enforce them, not a status
— so a count keyed on the row's last cell reads them as four unrecognisable statuses. Whichever
earlier count produced 132 folded them in. They are the same rows either way; only the arithmetic
was wrong, which is precisely why this figure is recounted rather than carried forward.

**The two denominators are stated because they differ, and the difference is not only
arithmetic.** The Constraints carry a status column and every one of the 14 reads `Open` — as a
default nobody ever revisited, not as an assessment. Several are demonstrably satisfied and
gated in CI (C-001 Manifest V3, C-002 TypeScript strict, C-003 the per-target background model),
so the 132-row tally's `Open` count is inflated by rows that were never scored. Recorded here
rather than corrected in passing: scoring 14 constraints is a judgement per row, and the
regulatory ones are not ours to mark off between commits.

NFR-028 was the last Blocked row, and the data corpus it waited for now exists. Almost
everything Phase 2 lists is built and verified — every control kind, native constraints, the
framework-safe write, the full exclusion set with honeypots, confirmation mirroring, coherent
personas, frames, shadow roots, error isolation, and all three steps of UC-034.

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

- ~~**The data corpus.**~~ **Built 2026-08-15.** Two locales (en-US, de-CH), ~2,300 entries held
  as parts and combined, so the number of distinct records is effectively unbounded while the
  data stays small enough to read in a diff. Real cities, regions and postal districts — the
  only way the coherence claim means anything — with invented people and streets. NFR-027 is no
  longer a floor (14.0 ms with the corpus in place) and NFR-028 is measured as a bound: the
  corpus is a bundled module, so it is parsed inside an 11.0 ms worker start and has no separate
  load to time.
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
- **UC-008** Suspend Filling on an Excluded Domain — engine-side enforcement and badge. Non-injection for host-pattern entries was this row's third item until BR-008-4 declined it on 2026-08-15; FR-074 now asks that the agent never be *asked to act*, not that it never be loaded
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
- ~~**UC-009**, **UC-010**, **UC-011**, **UC-012**~~ — **built 2026-08-15.** Create, edit,
  delete with undo, and reorder, in plain DOM with no runtime dependency: the extension has
  never shipped one, and G4's verifiable build is worth more than the convenience
- ~~**UC-013** Preview Values Generated by a Rule~~ — **built 2026-08-15**, several samples from
  the real generators, regenerated as the rule is edited, with FR-070's validation inline
- ~~**UC-018** matching sources · **UC-019** password · **UC-020** field exclusions ·
  **UC-021** domain exclusions · **UC-022** behaviour defaults · **UC-023** triggers~~ —
  **built 2026-08-17**, with a control for the corpus locale alongside them. Six sections on
  the same scrolling page as the rule editor, saved per change with no Save button anywhere,
  so there is no state in which what the user sees and what a fill does disagree

**Phase 4 is complete except FR-073's ladder**, which is not this phase's to build: DD-005
accepts the tolerant parser in its place and records the cost. The three keys these screens
added — a `triggers` section, and two keyword lists inside `behaviour` — are additive and
default when absent, so none of them is the restructuring the catalog names as the moment the
ladder becomes owed. That was checked rather than assumed.

UC-013 is scheduled with rule authoring rather than after it: writing a regex or template
blind is the worst moment in the reference's UX, and the preview is what makes rule authoring
teachable.

**What building it changed.** Two defects that only an interaction sequence could find, both
caught by `scripts/e2e-options.mjs` and by none of the 34 unit tests over the same code:

- **Every field handler closed over the rule as it was when the editor rendered.** Ordinary
  edits deliberately do not re-render the fields — rebuilding a form on each keystroke takes the
  caret with it — so that snapshot stayed stale for as long as the editor was open, and typing a
  name and then a pattern silently discarded the name. Handlers now spread from a live
  reference.
- **A change of generator type never re-rendered its own fields**, for the same reason: the new
  type's defaults were stored while the previous type's editor stayed on screen. A type change
  is now the one edit that rebuilds the body, and it returns focus to the control that caused it.

Both are the shape of defect a unit test cannot reach, because each operation was correct on its
own — `addRule`, `replaceRule` and `changeGeneratorType` all pass in isolation. What was wrong
was the state the second call was applied to.

**What the settings screens changed, 2026-08-17.** Three findings, and the first is the one
worth carrying forward:

- **Three settings were stored and read by nothing at all.** The password policy, the per-kind
  length caps and — once added — the keyword lists existed in the schema from DD-005 because
  defining a section late was judged more expensive than defining it unused. That judgement
  holds, but it left a state nobody had named: a screen written over any of them would have
  reported the setting saved while every fill ignored it, with nothing on either surface to say
  which was lying. **A setting nothing consumes is worse than a missing one**, and the check
  that catches it is not a unit test of the parser — it is asserting the setting's effect on a
  *filled page*, which is what every row of `scripts/e2e-settings.mjs` does.
- **The password fitter handed back a class the policy had switched off.** Shortening a password
  to a field's `maxlength` defaulted each missing character class to a literal, which was
  harmless while every password came from one hard-coded recipe and became wrong the moment
  FR-025 was configurable — on exactly the fields whose `maxlength` makes a character-set
  restriction likeliest. It now keeps only the classes the value actually has.
- **The first version of the new harness could pass by the fill never running.** It returned as
  soon as values appeared, which is several hundred milliseconds before the operation closes,
  so navigating away left a fill with no report and the tab held in `filling` for its full
  15-second timeout — silently ignoring the next trigger (UC-001 A7). The domain-exclusion check
  then went green on a form nothing had touched. It now waits on the badge, which is set on both
  endings. A harness that can pass by nothing happening is worse than no harness, because it is
  evidence pointing the wrong way.

The accessibility audit also found a layout defect the reflow check could not: three controls in
an exclusion row overflowed by 4px at 200% text in a wide window, where every viewport-width
media query still said there was room (WCAG 1.4.4). Wrapping needs no breakpoint to be named and
is therefore right at every text size rather than at the ones somebody thought of.

UC-012 carries a decision that is easy to miss: rule reordering must be operable from the
keyboard to satisfy NFR-019. The reference used `react-beautiful-dnd`, now deprecated and
with known accessibility regressions, so the drag implementation is a deliberate choice here
rather than a default.

---

## Phase 5 — Profiles

*Goal: per-application rule sets.*

- ~~**UC-014**, **UC-015**, **UC-016**~~ — **built 2026-08-17.** Profile create / edit / delete,
  with reordering, because order is the only tiebreak between two profiles that match one page
- ~~**UC-017** Identify the Active Profile for a Page~~ — **built 2026-08-17**, as a fill
  *result* rather than a badge. See below
- ~~**UC-007** Apply a URL Profile~~ — **built 2026-08-17**, three lines: resolve, concatenate,
  compile

~~This is the last change to the settings schema. Phase 6 depends on that being true.~~
**It changed the schema not at all**, which is the stronger version of the same claim. DD-005
defined `Profile` in Phase 2 with exactly the shape this needed — `id`, `label`, `enabled`,
`urls`, `rules` — and the tolerant parser has been reading it since. Phase 6 inherits a schema
that has been stable through two phases of screens rather than one that stopped changing
because this phase was careful.

**What building it changed.**

- **UC-017 could not be what FR-047 asks for, and the reason is a guarantee rather than a
  limitation of effort.** The requirement wants a Tester to see which profile applies to the
  *current page*; the extension learns a page's address only when a fill is invoked, because
  that is what `activeTab` grants and what keeps `tabs` off the manifest (NFR-008, BR-008-2).
  An indicator answering the question before a fill would require watching the user browse.
  So the answer is given where it can be given truthfully — in the fill report, naming the
  profile that governed the fill that just ran, and saying so in words when none did. BR-017-3
  and BR-017-4 record both halves. This is the second requirement in the project whose
  *honest* form is narrower than its written form, after FR-074.
- **The rule editor was pointed at a second list rather than copied.** A profile's rules are
  edited by the same 700 lines through a lens (`read`/`write`/`key`). Copying would have
  guaranteed the two drifted, and the first divergence would be a profile rule that could be
  written but not validated the same way. The state the editor holds outside the DOM — the
  open rule's draft, and the undo offer — had to learn which list it belongs to; an undo
  restoring a rule into the wrong list is the defect that shape invites (BR-015-2).
- **The profile harness found two things on its first run**, both invisible to the 22 unit
  tests over the same code. A profile's "matches nothing" flag never cleared when the address
  pattern that fixed it was typed — so the one state the flag exists to report was the one
  state in which it lied. And the section's Add button was indistinguishable from the rule
  editor's own `.primary` button nested inside an open profile, which comes *first* in document
  order: the harness added a rule where it meant to add a profile, and a person would have been
  saved only by the labels. Both are the same shape as every other defect this project has
  found — correct in isolation, wrong in sequence.

**One assertion in that harness was wrong rather than the code**, and it is worth recording
because the correction is the more useful statement. It asserted that focus returns to the
button that was pressed after a reorder; with two profiles, moving the second up puts it at the
top, where its own up button is disabled and focus falls to the sibling by design. The
requirement is that focus follows the profile that moved, not that it lands on a particular
control — asserting the mechanism instead of the requirement is how a test comes to fail on
correct behaviour.

### The Firefox gap, closed 2026-08-17

Not a phase — it was listed under "two things remain unscheduled" and stayed there through four
phases, which is long enough that closing it deserves the record.

**What it was.** NFR-014 has two sentences and neither held for Firefox. `smoke:firefox` proved
the add-on installs and filled nothing; the unit suite ran once, under happy-dom, which is
neither engine we ship to. So every DOM-facing behaviour the engine relies on — `element.labels`
resolving implicit labels, the prototype value setter frameworks patch, `InputEvent` being a
distinct type from `Event`, shadow roots, the event order a real user's typing produces — had
been verified in one engine and asserted for two.

**What closed it.** `engine:firefox` runs the real engine against the real reference fixture in
Gecko, with no extension installed at all: 27 controls across 12 kinds, settling in two passes,
nothing failing verification. **NFR-015 is what made that a day's work rather than a project** —
`runFill` takes a `Document` and a `requestValues` callback and touches no extension API, so the
code under test is exactly the code the page agent runs, with the background's half supplied by
calling the real generators in the page. The isolation requirement was written to keep the
engine testable without a browser host; it turned out to also make it testable in *any* browser
host, which is the more valuable of the two.

**What is still not covered, and why it is not a matter of effort.** The extension's own trigger
in Firefox. A fill starts from a toolbar click, a context-menu item or a keyboard shortcut, and
none can be synthesised: WebDriver input is dispatched into the content area, and browser-level
shortcut handling is deliberately out of its reach. That was measured rather than assumed —
headless and headful, with the correct BiDi modifier codepoints — before concluding it.

Chromium has the mirror-image limitation: `activeTab` follows a real user gesture, so its
harnesses can dispatch a toolbar click but can never read a tab's address, which is why UC-017's
and FR-037's matching paths have no end-to-end cover there. **Neither browser can be driven
through the whole product**, and the two gaps are in different places — which is the strongest
argument available for keeping both harnesses rather than picking one.

---

## Phase 6 — Portability

*Goal: configuration can leave, arrive, and travel between devices.*

- ~~**UC-025** Export Settings — plain JSON (ND-12)~~ **Built 2026-08-22.** `lib/settings-file.ts` and the options page's export section, with `scripts/e2e-export.mjs` watching a file land on disk. FR-052 `Done`
- ~~**UC-026** Import Settings — validation, no bypass (ND-13)~~ **Built 2026-08-22.** `lib/settings-import.ts` plans an import before it happens; the page shows both sides and every dropped entry, then writes once. FR-053 and FR-054 `Done`. **The migration ladder is still not built** — this phase's line has said "plus the migration ladder" since the first draft, and what landed is DD-005's tolerant parser with its losses *reported* instead. FR-073 stays `Partial`
- ~~**UC-028** Restore Default Settings~~ **Built 2026-08-24.** The confirmation quantifies what will be discarded and names export as the way back before the write; the write is the import's single-replacement path, so a rejected restore leaves the previous configuration whole. FR-048 and FR-057 `Done`. FR-048's honest form is recorded in BR-028-4: the useful default is the engine, with an empty rule list by design. **Review, before merge (2026-08-26), caught the counts going stale across this page's own edits:** the confirmation recomputed on renders and on foreign-write adoption, but nothing renders on a same-page save (the caret's protection), so a rule added while the confirmation read two was discarded as two — and on a defaults-only page the "this changes nothing" line stood over a password length the confirm was about to discard. `host.save` now runs the sections' refresh hooks after every write to memory; the import preview's "what is there now" half, the sibling the review named, gets the same hook and patches in place from the element's own file-derived halves without re-analysing the file. Both flows are regression-tested in the restore and import harnesses, and were confirmed failing on the pre-fix build
- **UC-027** Migrate Settings from Fake Filler — with an unmapped-items report
- **UC-029** Synchronise Settings Across Devices — DD-002 resolved to sharding at eight rules a key, ~399 rules of capacity, last-writer-wins accepted and said out loud*

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
- **NFR-032's evaluation bound**, narrowed on 2026-08-24 from "unbuilt" to "still owed". The hole
  it was the only guard against is closed: a field exclusion whose pattern `validateMatcher`
  refuses is no longer sent to the page, and the fill report names it (UC-005 A5) — which matters
  because an exclusion is stored while faulty on purpose and imported the same way, so authoring
  was never going to be where it was contained. What the requirement itself asks for is not built:
  identity truncated to 1,024 characters and a 250 ms budget, in both `selectRule` and
  `matchesIgnorePattern`. Neither half is what closed the hole, and the measurements say why —
  the patterns that hang the tab do it at 40 to 86 characters, an order of magnitude under the
  truncation bound, and a running regex cannot be interrupted to enforce a budget

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
                                                                                               DD-002 (sync quota, closed)
```

Phase 7 waits on **both** upper branches, not on Phase 3 alone: it is the release phase, and a
release ships the configuration and portability work as much as the scopes. The `┴` is where
they meet. **DD-002** enters from below because it gates Phase 6 and nothing else — an earlier
drawing of this graph put its connector in the Phase 7 junction's column, where it read as a
decision blocking the release. It is not one.

All the decisions that gated the engine are now closed, and **DD-005** closed with them on
2026-08-15 — pulled forward out of Phase 4, which is why the schema arrow above now feeds the
engine rather than trailing it. **DD-002** (sync quota) was the only decision left on the path,
and it closed on 2026-08-22 — sharding at eight rules a key, with last-writer-wins accepted and
stated in the interface. It never held anything up: it gated UC-029 alone, and Phase 6 opened
with UC-025 while it was still open. The connector stays drawn because the graph is a record of
what gated what, not a to-do list. **DD-006** (the feedback surface) was decided and built on 2026-08-15: badge, tooltip and the
options-page report. That unblocked Phase 3, which was built the same day — UC-002 and UC-003
needed only to supply their own scope value, because the sentence already named one.

The cold-start spike was the last unknown on this path, and it is now measured rather than
estimated: **14.0 ms with the corpus in place**, against NFR-027's 400 ms. The contingency this
paragraph used to carry — if the corpus loads too slowly, the corpus shrinks — was never
exercised and can be retired. There is no separate load to shrink: the corpus is a bundled
module, parsed inside an **11.0 ms** worker start, which is what turns NFR-028 from a floor into
a measured bound. Nothing on the critical path is now unknown; what remains is unbuilt, which is
a different thing.

## Shippable points

| After | You could ship |
|---|---|
| Phase 2 | A usable, defaults-only filler. Genuinely competitive on the engine alone. |
| Phase 4 | Feature parity with the reference's free tier, minus profiles. |
| Phase 5 | **Full parity with the reference's paid tier**, all free. |
| Phase 7 | The differentiated product: verifiable build, no network capability, 40 KB page agent. |

Phase 5 is the earliest defensible public release. Phase 2 is the earliest useful one, and is
worth putting in front of a few testers even if it never reaches a store.
