# Store listing copy

Paste-ready text for both store submissions, plus the answers to the review questionnaires
that decide whether a listing goes live or bounces. C-011 and C-012.

Character limits below are the stores' own and are enforced at upload. Where a field has a
limit, the count of the supplied text follows it.

**One rule that overrides all copy decisions here: the listing never names the reference
extension.** Not as comparison, not as "unlike X", not as a migration keyword. PD-004
rebrands completely, and naming a competitor in store copy is both a trademark exposure and
a listing-policy problem on Chrome. The copy below competes on what this extension is, and
the word "Fake" appears nowhere in it.

---

## 1. Shared across both stores

| Field | Value |
|---|---|
| Name | `FieldFiller` |
| Category | Developer Tools |
| Language | English (United States) |
| Licence | MIT |
| Price | Free, with no paid tier, no accounts, and no in-app purchases |

---

## 2. Chrome Web Store

### 2.1 Short description — 132 character limit

> Fill every form control on a page with plausible dummy data in one action.

*(74 characters. This is the string already in the manifest, so the listing and the
extension agree — a mismatch there is a small but real review flag.)*

### 2.2 Detailed description — 16,000 character limit

```
Fill an entire form in one click, with data that actually passes the form's own validation.

FieldFiller is a form filler for developers and QA engineers who are tired of typing
"test test test" into the same signup page forty times a day. Click the toolbar button and
every control on the page gets a plausible value — including the ones most fillers miss.

WHAT IT FILLS

Every native control: text, email, password, search, URL, telephone, number, range, colour,
all five date and time types, checkboxes, radio groups, single and multiple selects,
textareas, and contenteditable regions. Custom comboboxes that aren't native form controls
at all are driven too.

It also reaches the places forms actually hide: nested iframes, cross-origin frames, and
open shadow roots.

DATA THAT SURVIVES VALIDATION

Generated values respect the form's own constraints — maxlength, minlength, min, max, step
and pattern all shape the result. You get a value the page accepts, not one its validator
rejects a second later.

Every field in a single fill comes from one coherent invented person. The email matches the
name. The town matches the postcode. A "confirm email" field gets the email that was just
generated, not a different one. Consent and terms checkboxes are ticked, because a form you
can't submit hasn't been filled.

Hidden fields, disabled and read-only controls, and honeypot traps are left alone.

Fields that a page rewrites when you change another field — a state list that repopulates
after you pick a country — are followed rather than raced.

CONFIGURE IT AS FAR AS YOU NEED

- Custom rules matching on name, id, test id, class, placeholder, label text or ARIA label, by
  contains, exact or regular expression, filled from thirteen generator types.
- Test-automation attributes are matched as their own source — data-testid, data-test-id,
  data-test, data-qa, data-cy, data-automation-id — so a React or Vue form whose ids are
  generated and whose fields have no name is still targetable by a rule.
- Scope a rule to specific match sources so a noisy class attribute can't trigger it.
- Rule order is precedence, first match wins, and reordering works from the keyboard.
- A live preview shows what a rule produces before you save it.
- Profiles: extra rules that switch on for the URLs you match, layered over your global rules.
- Exclude fields by pattern, and turn the extension off entirely for domains where a stray
  fill would be expensive.
- Password policy, event dispatch behaviour, and locale — en-US and de-CH.

Every one of those is free. There is no paid tier and nothing is capped.

IT TELLS YOU WHAT IT DID

A fill reports how many controls it filled, what it skipped, and why — including which rule
matched each field. A fill that stops early says so, instead of looking like an empty page.

TAKE YOUR CONFIGURATION WITH YOU

Export everything to plain, pretty-printed JSON. It's diffable and reviewable, so a team
configuration can live in version control. Import validates the file and refuses a bad one
with a specific reason, leaving your existing settings untouched.

NO NETWORK ACCESS. AT ALL.

No account. No sign-in. No analytics, telemetry, or crash reporting. No server.

The extension makes no outbound request because it contains no code capable of making one,
and that isn't a promise — it's a build gate. A check in continuous integration fails the
build if any shipped file gains a fetch, XMLHttpRequest, WebSocket, EventSource or
sendBeacon call, references an external URL, or introduces remotely executed code. A second
gate fails the build if the extension ever requests a permission beyond the five it declares.

Your settings are stored locally on your device and are not synchronised anywhere. Nothing
you fill, and no site you fill it on, is recorded.

The source is public, and each release publishes its source tag and the digest of its
package, so you can build it yourself and confirm the store package matches. Or just open
DevTools, watch the Network panel, and use it. There's nothing to see.
```

### 2.3 Single purpose statement

Chrome requires one narrow purpose, stated plainly. Vagueness here is a common rejection.

```
FieldFiller has a single purpose: to populate form controls on a web page with generated
placeholder data, on the user's explicit command, so that developers and QA engineers can
test forms without typing values by hand.

Every feature in the extension serves that one purpose. The options page configures how
values are generated and which fields are filled. The context menu and keyboard shortcuts
choose how much of the page to fill. The export and import features move that configuration
between the user's own machines. The extension does nothing else — it does not read, store
or transmit page content, and it takes no action unless the user triggers a fill.
```

### 2.4 Permission justifications

One field per permission on the submission form. Each must say what the extension does with
it, not what the permission is.

**`storage`**
```
Stores the user's own settings — their field rules, profiles, exclusions, password policy
and behaviour preferences — on their device, so their configuration persists between
sessions. It is the only thing written to storage. No page content, no usage data, and
nothing identifying the user or the device is stored. Browser sync storage is not used, so
settings never leave the machine they were set on.
```

**`activeTab`**
```
Fills the form in the tab the user is currently looking at, when they click the toolbar
button or press the keyboard shortcut. Access is granted for that one tab at the moment the
user invokes the extension, which is exactly the scope of the action they asked for.
```

**`scripting`**
```
Dispatches the fill into each frame of the page being filled. A form inside an iframe cannot
be reached from its parent document, so filling a page that embeds a form — a checkout
widget, an embedded signup — requires injecting into that frame specifically. It is used
only in response to a user-triggered fill.
```

**`contextMenus`**
```
Adds three right-click menu entries so the user can choose how much to fill: all inputs on
the page, only the form they are in, or only the single control they right-clicked. These
menu items are the only interface this permission is used for.
```

**Host permission — content script on all sites**

This is the one reviewers push back on, so it answers the "why not activeTab?" question
directly rather than restating the feature.

```
The extension registers a small helper script in pages so that the "Fill this input" command
can identify which control the user right-clicked.

This cannot be done with activeTab alone. Chrome's context menu API does not tell an
extension which DOM element a right-click landed on — it reports only the frame and the
selection. Something must already be present in the page at the moment of the right-click to
observe which element received it. Injecting after the click has happened is too late; the
target is gone.

The helper carries no data and contacts nothing. It performs no work of any kind until the
user explicitly triggers a fill, and it is inert on every page the user never fills. It does
not read field values, does not observe navigation or input, and does not communicate with
anything outside the extension. Its entire size is 22 KB, and the source is public.
```

### 2.5 Remote code

```
No. The extension executes no remote code. All logic is contained in the submitted package.
No script is fetched, no eval or new Function is used on external input, and the build
disables the module-preload polyfill specifically so that no fetch call appears in shipped
code at all.
```

### 2.6 Data usage disclosure

The certification checkboxes. Every answer is **no data collected** — tick nothing in the
data-types list, and affirm all three certifications.

| Data type | Collected? |
|---|---|
| Personally identifiable information | No |
| Health information | No |
| Financial and payment information | No |
| Authentication information | No |
| Personal communications | No |
| Location | No |
| Web history | No |
| User activity | No |
| Website content | No |

| Certification | Answer |
|---|---|
| I do not sell or transfer user data to third parties, outside of the approved use cases | Yes |
| I do not use or transfer user data for purposes that are unrelated to my item's single purpose | Yes |
| I do not use or transfer user data to determine creditworthiness or for lending purposes | Yes |

Privacy policy URL: the published location of `PRIVACY.md`. Chrome will not accept the
listing without a reachable one.

**Amended 2026-08-28 by UC-029, and the answers above are unchanged by it.** Synchronised
settings leave the device, so the *claim* changes shape — "stored on the device" becomes
"stored on the device and, where you have turned it on, in your browser's own
synchronisation" — but every certification stays `No`, because the data goes to the user's
own browser account under their browser vendor's terms and never to us: there is no server,
no account and no collection to declare. `PRIVACY.md` was rewritten in the same change rather
than after somebody asked (BR-029-1). What this row still owes is publication: a reachable
URL, which is C-011's outstanding half.

### 2.7 Images

Store icon, screenshots and promo tiles are specified in [`art_brief.md`](art_brief.md).

The 128×128 store icon is done — `public/icon/128.png`, drawn by `scripts/make-icons.mjs`.
The promo tiles are done — `docs/art/promo-440x280.png` and `docs/art/promo-1400x560.png`,
drawn by `scripts/make-promo.mjs` with the lettering set in Inter (SIL OFL, committed in
`scripts/fonts/`) rather than generated text. Screenshots are not, and the listing cannot go
live without at least one 1280×800 screenshot.

---

## 3. Firefox AMO

### 3.1 Summary — 250 character limit

```
Fill every form control on a page with plausible dummy data in one action. Respects the
form's own validation constraints, reaches iframes and shadow roots, and makes no network
request of any kind — no account, no tracking, no server.
```

*(235 characters.)*

### 3.2 Description

Reuse §2.2 verbatim. AMO accepts limited HTML in this field; the plain text above is fine as
is, and converting the section headings to `<strong>` improves it if you want the effort.

### 3.3 Categories and tags

| Field | Value |
|---|---|
| Category | Other *(AMO has no Developer Tools category; "Other" is where comparable tools sit)* |
| Tags | `forms`, `testing`, `developer`, `qa`, `privacy`, `automation` |

### 3.4 Data collection

AMO reads this from the manifest, which now declares
`data_collection_permissions: { required: ["none"] }`. The listing form will reflect it. No
additional disclosure is required, and the privacy policy field should still point at the
published `PRIVACY.md`.

### 3.5 Source code submission — required, not optional

**AMO requires a source-code upload for any add-on whose submitted code was produced by a
bundler or minifier.** This one is built with WXT and Vite, so the requirement applies, and a
submission without it is rejected pending source.

`pnpm zip` already produces `.output/fieldfiller-<version>-sources.zip` alongside the package
for exactly this. Upload it in the source-code field, with these build instructions:

```
Build environment
  Node.js 24 or later
  pnpm 11.2.0 (the version in package.json's packageManager field)
  Operating system: any; the build is platform-independent

Steps
  pnpm install --frozen-lockfile
  pnpm build:firefox

Output
  .output/firefox-mv3/ — this is the content of the submitted package.

The build is reproducible: two clean builds of the same commit produce byte-identical
output, verifiable with `pnpm run verify:reproducible`.

No code in the submitted package is obfuscated. Minification is Vite's default production
setting and is limited to whitespace removal and identifier shortening.
```

### 3.6 Notes for the reviewer

```
This add-on makes no network requests. It has no runtime dependencies — package.json
declares no dependencies field at all — and the entire package is first-party code.

The content script registered on all sites is required for the "Fill this input" context
menu command. The context menu API does not report which DOM element received the
right-click, so a listener must already be present in the page to observe it; injecting
after the click is too late. The script does nothing until the user triggers a fill and
contacts nothing at any point.

Verification you can run against the source:
  pnpm run gate:network     — fails the build on any fetch, XMLHttpRequest, WebSocket,
                              EventSource, sendBeacon, external URL, or remote code in any
                              shipped file, across both targets.
  pnpm run gate:permissions — fails the build if the manifest requests any permission beyond
                              storage, contextMenus, scripting and activeTab.
  pnpm run gate:imports     — walks the content script's import graph and fails on any
                              package not explicitly allowlisted.
  pnpm test                 — 665 unit tests.

All four run in CI on every change.
```

---

## 4. Before either submission

- [ ] Screenshots — see [`art_brief.md`](art_brief.md) §6. They block both listings.
      The promo tiles exist (`docs/art/`, drawn by `scripts/make-promo.mjs`) but still need
      the side-by-side check against the Fake Filler listings before upload. Icons are done.
- [ ] `PRIVACY.md` published at a public URL, and the contact address in it filled in.
- [ ] Source public at the release tag (C-014), which the AMO source upload and the
      build-verification claim in §2.2 both depend on.
- [ ] Version decided and tagged; `CHANGELOG.md`'s Unreleased section renamed and given the
      tag and artefact digests.
- [ ] `pnpm run verify:reproducible` run, and the digests recorded in the changelog entry.
- [ ] The `gecko.id` is `fieldfiller@dividbzero` and becomes permanent at the first AMO
      submission (C-004). Last chance to change it.
- [ ] A Firefox end-to-end fill. `smoke:firefox` proves the add-on installs and that the
      gecko.id is honoured; it fills nothing. Every claim in §2.2 about filling behaviour
      currently rests on Chromium plus a shared source tree.
