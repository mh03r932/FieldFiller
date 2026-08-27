# Changelog

All notable changes to FieldFiller are recorded here (FR-061, UC-031).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each released entry names the git tag it was built from and the digest of the published
artefact, so that a reader can confirm the store package matches the public source
(FR-063, UC-032, NFR-011).

<!-- At release: rename the Unreleased heading below to the version and date, add the tag
     and digests, and open a fresh Unreleased section above it. `pnpm run verify:reproducible`
     prints the digests. -->

## [Unreleased]

The first public release. Everything below is new, so this entry describes the product
rather than a set of changes to it.

### Added

**Filling**

- One action fills every form control on a page: click the toolbar button, press
  `Ctrl+Shift+Y` (`⌘⇧Y` on macOS), or use the right-click menu.
- Three scopes — fill every input on the page, fill just the form you are in, or fill a
  single control you right-clicked. Available from the context menu and separately bindable
  as keyboard shortcuts.
- Every control kind is handled: text, email, password, search, URL, telephone, number,
  range, colour, all five date and time types, checkboxes, radio groups, single and
  multiple selects, textareas, `contenteditable` regions, and custom comboboxes that are
  not native form controls at all.
- Native validation constraints are honoured rather than ignored — `maxlength`, `minlength`,
  `min`, `max`, `step` and `pattern` all shape the generated value, so a fill does not
  produce data the page's own validation immediately rejects.
- Every value in a single fill comes from one coherent invented person. The email matches the
  name, the town matches the postcode, and the same persona reaches every frame on the page.
- Confirmation fields agree with their source: a "confirm email" gets the email that was
  just generated, not a second unrelated one. Same for passwords.
- Consent and terms checkboxes are ticked rather than randomised, because a form you cannot
  submit has not been filled.
- Hidden fields, disabled and read-only controls, and honeypot traps are left alone.
- Nested frames, cross-origin frames and open shadow roots are all filled.
- Fields that a page rewrites in response to another field — a state list that repopulates
  when you pick a country — are followed rather than raced, so the dependent field ends up
  with a value that is actually valid for the one it depends on.

**Configuration**

- Custom rules: match a class of field by `name`, `id`, test id, `class`, `placeholder`,
  label text or ARIA label, using contains, exact or regular-expression matching, and fill it
  from any of thirteen generator types — name, email, organisation, username, telephone, URL,
  text, alphanumeric template, number, date, constant, list, or regular expression.
- Test-automation attributes are a matching source of their own: `data-testid`,
  `data-test-id`, `data-test`, `data-qa`, `data-cy` and `data-automation-id`. On a
  component-rendered form whose `id` is generated and whose `name` is absent, that attribute
  is often the only stable identity there is — and it is the one a rule can be written
  against. On by default, and it names the field in the fill report too.
- Rules can be scoped to a subset of match sources, so a noisy `class` attribute cannot
  trigger a rule meant for `name`.
- Rule order is precedence, first match wins, and reordering is fully keyboard-operable.
- A live preview shows what a rule will generate before you save it, and invalid patterns
  are refused at edit time rather than failing silently during a fill.
- Profiles: a named set of additional rules that activates on the URLs you match, layered
  over the global rules rather than replacing them.
- Field exclusions by pattern, and domain exclusions that turn the extension off entirely
  for sites where a stray fill would be costly.
- A stored field exclusion whose pattern could hang the extension is never evaluated against a
  page, and the fill report says which one was not applied — the exclusion editor keeps a
  half-typed pattern while you are typing it, and keeping one is not the same as running it.
- Password policy: length, and which character classes must appear.
- Behaviour toggles for which events are dispatched after a write, whether hidden fields are
  skipped, and whether fields that already have a value are left alone.
- Corpus locale, shipping `en-US` and `de-CH`.

**Feedback**

- A fill reports what it did — how many controls were filled, what was skipped, and why —
  on the toolbar badge and in the options page, including which rule matched each field.
  A fill that stops early says that it stopped rather than looking like an empty page.

**Portability**

- Export the whole configuration to a plain, pretty-printed JSON file — diffable,
  reviewable, and suitable for keeping a team configuration in version control.
- Import it back, with validation and a schema-migration path. A file that is not a settings
  file, was written by a newer version than the one reading it, or is far too large to be a
  settings file at all, is refused with a specific reason and leaves existing settings
  untouched. Before anything is written, the import says
  what it would do: what is being replaced, everything in the file that cannot be kept, and
  anything that arrives carrying a fault or changed — a field exclusion whose pattern will not
  compile, imported as it stands and flagged rather than quietly dropped; a number range the
  file states backwards, imported the right way round and said so; two rules claiming one
  identity, which the rule list would otherwise treat as a single rule.
- Bring a configuration over from Fake Filler. Hand it that extension's backup — the plain
  JSON or the Base64 `.txt` its export actually downloads — and the whole report arrives
  before anything is written: what will be stored, every field and profile that cannot be
  translated with the reason it cannot, and, separately, every rule that arrives *changed* —
  the email customisation with nowhere to go, a date token this format has no equivalent for,
  a bound moved to fit. Nothing is guessed into an active state: a profile whose URL match
  will not translate arrives switched off with its original pattern quoted, and a pattern
  this extension would refuse from its own editor is refused here too, in the same words.
- Restore the shipped defaults behind a confirmation that says, in counts, what it will
  discard — rules, profiles, both exclusion lists — and names export as the way back before
  anything is written. There is no undo: the copy you might want is the one you make first.
  A configuration that already is the shipped one is told so, and can still be restored.

**Privacy and verifiability**

- No network access of any kind. The extension makes no outbound request, contains no code
  capable of making one, and has no runtime dependencies.
- Settings are stored locally on the device and are not synchronised anywhere.
- Five gates run in CI and fail the build rather than warn: page agent size budget, the page
  agent's import graph, absence of any network or remote-code capability, the permission set,
  and unit-test coverage scope.
- Builds are reproducible; each release publishes its source tag and artefact digest.
- Available in Chromium and Firefox from a single codebase, both on Manifest V3.

### Notes

- The Firefox package declares `data_collection_permissions: { required: ["none"] }`, AMO's
  formal statement that the add-on collects no data. This is the same claim the network gate
  enforces in code.
- Keyboard shortcut defaults: `Ctrl+Shift+Y` fills the page and `Ctrl+Shift+Period` fills the
  current form. "Fill the selected input" ships deliberately unbound — three default bindings
  from one extension is more of a user's keyboard than this earns. Assign it yourself from
  the browser's own shortcuts settings.

<!-- TODO before publishing: point this at the public repository, once §Contact in
     PRIVACY.md has settled where that is. -->
[Unreleased]: [REPOSITORY URL]/compare/main...HEAD
