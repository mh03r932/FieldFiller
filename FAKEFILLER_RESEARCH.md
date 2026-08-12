# FakeFiller / Fake Filler — Deep Research Analysis

> Source analysed: https://github.com/FakeFiller/fake-filler-extension (commit `36daf90`, master branch)
> Repository last commit: **17 November 2023**, manifest version `3.4.0`
> Author / copyright holder: **Hussein (Husain) Shabbir** — `hussein@fakefiller.com`
> First commit: **20 May 2012** (11+ years of history, 231 commits total)
> Stores: Chrome (`bnjjngeaknajbdcgpfkgnonkmififhfo`), Edge (`bdcjobafgkjgckiikonbfcdocnhnaaii`), Firefox AMO (`fake-filler`)
> Marketing site: https://fakefiller.com/

---

## 1. Features & Core Features

### 1.1 Core feature (what it actually does)

It is a **one‑click form filler for QA / developers**. When triggered, it walks the active tab's DOM and fills every form control with random dummy data.

Three trigger scopes (see `src/common/fake-filler.ts:12`):

| Action | Behaviour |
|---|---|
| **Fill all inputs** | `document.querySelectorAll("input,textarea,select,[contenteditable]")` filtered by `:not(:disabled):not([readonly])` — fills the whole page, all frames. |
| **Fill this form** | Finds `element.closest("form")` from the focused/right‑clicked element and fills only that form. |
| **Fill this input** | Fills just the focused / right‑clicked element. |

Triggers come from (see `src/service_worker/index.ts:108-182`):

- Browser‑toolbar icon click → fill all inputs
- Keyboard shortcuts (default `Ctrl+Shift+F` / `Cmd+Shift+F`, configurable)
- Context‑menu items: *Fill all inputs / Fill this form / Fill this input*
- `chrome.commands` API (`fill_all_inputs`, `fill_this_form`, `fill_this_input`)

### 1.2 Per‑input handling (`src/common/element-filler.ts`)

The extension inspects `element.type` and produces appropriate data:

| Input type | Filled with |
|---|---|
| `text` (default) | Lorem‑ipsum phrase, respecting `maxLength` / `defaultMaxLength` |
| `email` | Random email; "confirm email" fields repeat the previous value |
| `password` | Either a fixed string (default `Pa$$w0rd!`) or random 8‑char token |
| `number`, `range` | Random int within `[min, max]` (from element attrs or custom field) |
| `checkbox` | Terms/consent boxes always checked; others 50/50 |
| `radio` | One option in the `name` group chosen at random |
| `select` (single) | Random non‑disabled `<option>` (skips empty first option) |
| `select` (multiple) | Random number of non‑disabled options selected |
| `date` / `time` / `month` / `week` / `datetime-local` | Properly formatted random date/time |
| `tel` | Phone from template (default `+1 (XxX) XxX-XxxX`) |
| `url` | `https://www.<word>.<tld>` |
| `color` | Random hex `#rrggbb` |
| `search` | One random word |
| `<textarea>` | Lorem paragraph |
| `[contenteditable]` | `textContent` set to a paragraph |

After setting `.value`, it dispatches `input`, `click`, `change`, `blur` events so reactive frameworks (React, Vue, etc.) pick up the value (`fireEvents`, `src/common/element-filler.ts:36`). This can be disabled with the *Trigger click events* option.

### 1.3 Smart field matching (the killer feature)

Beyond per‑type defaults, users define **custom fields** keyed by regex matchers. The matcher inspects these element attributes (configurable, `src/common/element-filler.ts:158-200`):

- `name`
- `id`
- `class`
- `placeholder`
- text of `<label for="<id>">` (uses `cssesc` so weird IDs are safely quoted)
- `aria-label`
- `aria-labelledby` (resolved to the referenced element's text)

All matching is **case‑insensitive regex** (`isAnyMatch`, `element-filler.ts:43`). E.g. a custom field with `match: ["phone","fax"]` will match any input whose name/id/label matches `/phone/i` or `/fax/i`.

### 1.4 Custom field types (`src/types.ts:10`)

`alphanumeric`, `date`, `email`, `first-name`, `full-name`, `last-name`, `number`, `organization`, `randomized-list`, `regex`, `telephone`, `text`, `url`, `username`.

Two of them are interesting:

- **alphanumeric template** — like `LLL-xxx` (`L` upper letter, `l` lower, `D` either, `C/c` consonant, `V/v` vowel, `X` digit 1‑9, `x` digit 0‑9, `[...]` literal, anything else literal). See `data-generator.ts:62`.
- **regex generator** — uses [`randexp`](https://www.npmjs.com/package/randexp) to produce a random string that matches a user‑supplied regex (e.g. address line: `([1-9][0-9]{0,2}) (North |East |...)(Green |...)(Nobel|Fabien|...) (Avenue|Boulevard|...)`).

### 1.5 General settings (`src/options/components/general-settings/GeneralSettingsForm.tsx`)

- **Password settings** — fixed string or random; default `Pa$$w0rd!`
- **Field matching** — toggle which sources (id/name/label/class/placeholder/aria‑*) participate in matching
- **Default max length** — fallback when an input has no `maxLength`
- **Agree / terms checkbox keywords** — CSV list, default `agree, terms, conditions`
- **Confirm‑field keywords** — fields whose value should mirror the previous one (`confirm, reenter, retype, repeat, secondary`)
- **Ignored fields** — regex list, default `captcha, hipinputtext`
- **Ignore hidden fields** — skip anything with zero offset or `visibility:hidden`
- **Ignore fields with content** — skip non‑empty inputs and radio groups that already have a selection
- **Trigger click events** — fire `input/click/change/blur` after setting `.value` (needed for React/Vue forms)
- **Enable context menu** — toggle the right‑click menu

### 1.6 Backup / restore (`src/options/components/BackupAndRestorePage.tsx`)

- **Export** → settings JSON, Base64‑encoded, downloaded as `fake-filler-YYYY-MM-DD.txt` (uses `file-saver`)
- **Import** → reads `.txt`, decodes Base64, JSON‑parses, refuses if `version` mismatches (with a "continue anyway" override)
- Restore is local‑only; on Pro accounts it also pushes to Firebase.

### 1.7 Profiles (Pro‑only)

A profile = `{ name, urlMatch (regex), fields[] }`. On page load, the content script (`src/content_script/index.ts:16`) tests `window.location.href` against each profile's `urlMatch`. The first match is used in addition to the default field list, and a ★ badge is set on the toolbar icon.

### 1.8 Other UI surfaces

- **Keyboard shortcuts page** — shows `chrome.commands.getAll()` results and links to the browser's shortcuts settings.
- **Changelog page** — static.
- **Login page** — email/password against Firebase Auth.
- **My Account page** — shows email, Free/Pro badge, last sync time, sync‑now button, manage‑account link, logout.

### 1.9 Cap not in the UI but enforced in code

- Free tier limited to **25 custom fields** (`MAX_CUSTOM_FIELDS = 25`, `CustomFieldsView.tsx`); Pro = unlimited. Triggering the limit pops `GetProModal`.

---

## 2. File Formats

### 2.1 Bundled artefact layout (what ships in the .crx/.xpi)

```
manifest.json                  # MV3 manifest
options.html                   # single React mount point
service_worker.js              # background service worker (bundled)
build/
  content-script.js            # injected into every page
  options.js                   # React options UI bundle
  options.css                  # extracted SCSS
  media/<hash>.<ext>           # fonts, images
images/                        # icons 16/32/48/64/96/128 + logo SVGs
_locales/en/messages.json      # i18n strings (213 keys)
```

### 2.2 Settings file format (export/import)

Plain JSON, Base64‑encoded on disk for export. Schema (`src/types.ts:99`):

```ts
interface IFakeFillerOptions {
  version: number;                 // schema version, currently 1
  agreeTermsFields: string[];      // CSV‑parsed from UI
  confirmFields: string[];
  defaultMaxLength: number;
  enableContextMenu: boolean;
  fieldMatchSettings: {
    matchClass: boolean;
    matchId: boolean;
    matchLabel: boolean;
    matchName: boolean;
    matchPlaceholder: boolean;
    matchAriaLabel: boolean;
    matchAriaLabelledBy: boolean;
  };
  fields: ICustomField[];          // global field list
  ignoredFields: string[];
  ignoreFieldsWithContent: boolean;
  ignoreHiddenFields: boolean;
  passwordSettings: { mode: "defined" | "random"; password: string; };
  profiles: IProfile[];            // Pro only
  triggerClickEvents: boolean;
}

interface ICustomField {
  type: CustomFieldTypes;           // one of 14 types listed above
  name: string;
  match: string[];                  // regex list
  max?, min?, decimalPlaces?, maxLength?: number;
  template?: string;                // telephone / date / alphanumeric / regex
  list?: string[];                  // randomized-list
  minDate?, maxDate?: string;       // date
  emailPrefix?: string;
  emailHostname?: "list" | "random";
  emailHostnameList?: string[];
  emailUsername?: "list" | "name" | "random" | "username" | "regex";
  emailUsernameList?: string[];
  emailUsernameRegEx?: string;
}

interface IProfile { name: string; urlMatch: string; fields: ICustomField[]; }
```

Storage: `chrome.storage.local` under key `options`. Backup file naming: `fake-filler-YYYY-MM-DD.txt`.

### 2.3 Manifest

```jsonc
{
  "manifest_version": 3,
  "version": "3.4.0",
  "permissions": ["contextMenus", "activeTab", "storage", "scripting"],
  "content_scripts": [{ "matches": ["<all_urls>"], "js": ["build/content-script.js"], "all_frames": true }],
  "background": { "service_worker": "service_worker.js", "type": "module" },
  "options_ui": { "page": "options.html", "open_in_tab": true },
  "commands": { "fill_all_inputs": {...}, "fill_this_form": {...}, "fill_this_input": {...} }
}
```

Notable: `<all_urls>` + `all_frames: true` content script, plus `scripting` for `executeScript` calls from the service worker. No `host_permissions` — uses `activeTab`‑style access.

### 2.4 Dummy‑data source file

`src/common/dummy-data.ts` is **2,554 lines** (~33 KB) of hard‑coded arrays: `wordBank` (Lorem ipsum), `firstNames`, `lastNames`, `domains` (TLD list), `consonants`, `vowels`, `alphabets`, `organizationSuffix`. This is the entire "random" corpus.

---

## 3. Licence

**MIT** — `LICENSE` file, copyright `2014-2020 Hussein Shabbir`. `package.json:15` confirms `"license": "MIT"`. You may freely copy, modify, merge, publish, distribute, sublicense, and sell copies.

That said: the **"Fake Filler" name, logo and the fakefiller.com service are NOT MIT** — they're the author's brand. A clone should rebrand to avoid trademark issues.

---

## 4. Was it Open Source Once? Is the Open‑Source Code Still What Runs Now?

### 4.1 History

- **20 May 2012** — first commit. Extension was called *Form Filler*, pure JavaScript + jQuery in a single `content.js`. (Commit `de4825a`.)
- **22 Feb 2013** — *Version 2* commit (`91fb4d6`): added custom fields, restructured into `formfiller/` with Bootstrap LESS.
- **Jun 2020** — *Version 3* (`bf64789`, `ebe89a4`): full rewrite — renamed to *Fake Filler*, rewritten in TypeScript + React + Redux, multiple profiles, email moved to custom fields.
- **20 Jun 2020** — `0f6491d "Pro edition features"`: Firebase + Stripe integration added. **This is the point where the published extension started including server‑side code (Firebase secrets, sync) that doesn't fully live in the public repo.**
- **24 Oct 2023** — `acfb8f3 "Upgrade manifest to v3"` — MV2 → MV3 migration (background page → service worker).
- **17 Nov 2023** — `36daf90 "Update changelog and version"`, the **last public commit**. Manifest in repo says `3.4.0`.

### 4.2 Is the public repo the same as what's in the Web Store?

**No, almost certainly not.** Strong evidence:

1. **GitHub issue #137** (opened Jul 2020) — a user reported seeing runtime code in the Chrome Web Store build (service‑worker and Firebase references) that was *not present in the public repo at all*. The maintainer never refuted this; subsequent commits added some of that code, but the pattern of "the store build is ahead of GitHub" was established.
2. The repo's `package.json` says version `3.0.0`, but the manifest says `3.4.0`. This mismatch indicates the repo hasn't been kept in lockstep with releases.
3. Firebase API keys / auth domain come from `process.env.FIREBASE_*` (`src/common/firebase.ts:16-19`) via `dotenv-webpack`. Those secrets are obviously not in the repo, so **the published extension contains data the open source build does not**.
4. The repo has no GitHub Actions / CI, no test runner, and no release tags. Distribution is manual and opaque.
5. The repo has been dormant for ~2 years while the Chrome Web Store listing is still maintained.

**Bottom line:** the public GitHub repo is a **partial, slightly stale snapshot**. The architecture, file structure, custom‑field engine, matcher, and dummy‑data generation are very likely still the basis of the current extension. But the proprietary pieces (Pro billing, Firebase config, recent bug fixes, possibly MV3 polish) live in a private fork. Treat the open source code as a 95% accurate blueprint, not a byte‑exact match.

---

## 5. Does It Track Users?

**For the core form‑filling workflow: no.** I grep'd the entire codebase for `analytics`, `gtag`, `google-analytics`, `track`, `telemetry`, `mixpanel`, `amplitude`, `sentry`, `fetch(`, `XMLHttpRequest`, `navigator.sendBeacon` — **zero matches in source files**.

The only network‑capable code paths are:

| Location | What it does |
|---|---|
| `src/common/firebase.ts` | Initialises Firebase Auth + Firestore. Listens to `auth.onAuthStateChanged` and `auth.onIdTokenChanged`. Only active after explicit login on the options page. |
| `src/options/components/LoginPage.tsx` | Calls `login(email, password)` → `auth.signInWithEmailAndPassword`. |
| `src/common/firebase.ts:saveOptionsToDb` | Writes user's options JSON to Firestore `settings/<uid>` — only if `claims.subscribed === true`. |
| `src/common/firebase.ts:onNewSettings` | Subscribes to that same doc for live sync. |
| Static links to `https://fakefiller.com/...` | In the options UI (no automatic requests). |

The extension **never sends the page URL, page content, filled values, browsing history, or anything else to the server**. There is no remote code, no telemetry, no error reporting.

The official [privacy policy](https://fakefiller.com/privacy) (last updated 9 Jun 2020) explicitly states:

> **Google Analytics (privacy policy) - track and store anonymous usage behaviour so that we can optimize the services we provide to you. Google Analytics is not used in the Extension.**

So the *website* uses Google Analytics but the *extension binary* does not.

### 5.1 Permissions‑based risk

The manifest asks for `<all_urls>` match patterns + `activeTab` + `storage` + `scripting` + `contextMenus`. The content script runs on every page and listens for `mousedown` to remember the right‑clicked element (`content_script/index.ts:45`). That's technically capable of observing everything the user does, but **the code only ever reads form elements when triggered, and never exfiltrates them.**

### 5.2 Firebase specifically

Firebase SDK calls home for auth + token refresh + snapshot subscriptions. If a user **never logs in to a Pro account**, Firebase still loads (because `firebase.ts` runs at options page boot), but `auth.onAuthStateChanged` will fire with `user === null` and no Firestore subscriptions are opened (`firebase.ts:78`). So for free users, the only Firebase traffic is the initial SDK bootstrap (anonymous config fetch).

---

## 6. What Data Does It "Phone Home"?

Strictly nothing automatic beyond Firebase bootstrap. If the user **explicitly logs in to a Pro account**, the following data is sent to Firebase:

| Data | Destination | When |
|---|---|---|
| Email + password (or OAuth token) | Firebase Auth | On login button press |
| Firebase ID token (JWT) | Firebase Auth | Auto‑refreshed by SDK |
| `settings/<uid> = { options: <stringified IFakeFillerOptions>, updatedAt: serverTimestamp }` | Firestore | Every time options change, only if `claims.subscribed === true` |
| `users/<uid> = { emailAddress, stripeCustomerId, stripeSubscriptionId, claims, claimsUpdatedAt }` | Firestore | Read by client to detect Pro status changes (server‑side written by Stripe webhook) |

**Stripe** handles payment separately on `fakefiller.com/#pricing`; the extension only reads `stripeCustomerId` / `stripeSubscriptionId` indirectly via the user doc.

The extension **does not send**: page URLs, page HTML, form data filled by the user, browser history, cookies, hardware fingerprints, or anything from the pages the user fills.

---

## 7. How Could It Be Reimplemented?

### 7.1 Architecture map (what to copy)

```
┌────────────────────────────────────────────────────────┐
│ service_worker.js (MV3 background)                     │
│  - registers context menus                             │
│  - registers chrome.commands                           │
│  - on action click → executeScript(fillAllInputs)      │
└────────────────────────────────────────────────────────┘
            │ chrome.scripting.executeScript
            ▼
┌────────────────────────────────────────────────────────┐
│ content_script.js (injected in all frames)             │
│  - listens for mousedown to record clicked element     │
│  - asks background for options via sendMessage          │
│  - on receiveNewOptions → rebuilds FakeFiller instance  │
│  - exposes window.fakeFiller.{fillAllInputs,           │
│       fillThisForm, fillThisInput}                      │
└────────────────────────────────────────────────────────┘
            │ uses
            ▼
┌────────────────────────────────────────────────────────┐
│ common/fake-filler.ts                                  │
│  - querySelectorAll(input|textarea|select|ce)          │
│  - dispatches to ElementFiller per element             │
└──────────────────────────────────────────────────────── ┘
            │ uses
            ▼
┌────────────────────────────────────────────────────────┐
│ common/element-filler.ts                               │
│  - shouldIgnoreElement (skip disabled/hidden/ignored)  │
│  - getElementName (concat name+id+class+label+aria)    │
│  - findCustomField (regex match against user fields)   │
│  - branch on element.type → generate value             │
│  - fireEvents (input/click/change/blur)                │
└──────────────────────────────────────────────────────── ┘
            │ uses
            ▼
┌────────────────────────────────────────────────────────┐
│ common/data-generator.ts                               │
│  - randomNumber, scrambledWord, words, paragraph       │
│  - alphanumeric (template engine), phoneNumber         │
│  - date, time, month, year, weekNumber, color          │
│  - firstName, lastName, organizationName, website      │
└──────────────────────────────────────────────────────── ┘
            │ uses
            ▼
┌────────────────────────────────────────────────────────┐
│ common/dummy-data.ts                                   │
│  - wordBank, firstNames, lastNames, domains, ...        │
└──────────────────────────────────────────────────────── ┘

┌────────────────────────────────────────────────────────┐
│ options UI (separate React app, options.html)          │
│  - General settings, Custom fields, Profiles (Pro),    │
│    Keyboard shortcuts, Backup/Restore, Login, Account  │
└──────────────────────────────────────────────────────── ┘
            │ chrome.storage.local + chrome.runtime.sendMessage
            ▼
                  (options propagate to all tabs)
```

### 7.2 Minimum viable reimplementation plan

1. **MV3 manifest** with the same permissions (`activeTab`, `storage`, `scripting`, `contextMenus`) and one content script on `<all_urls>` with `all_frames: true`.
2. **Service worker** that wires `chrome.action.onClicked`, `chrome.contextMenus.onClicked`, `chrome.commands.onCommand` to `chrome.scripting.executeScript` calls. Three functions: `fillAllInputs`, `fillThisForm`, `fillThisInput` — basically three lines each.
3. **Content script** that
   - on `mousedown` right‑click stores `event.target`,
   - on `runtime.onMessage: "getOptions"` replies with options from `chrome.storage.local`,
   - on `runtime.onMessage: "receiveNewOptions"` rebuilds the filler,
   - exposes the three fill functions on `window`.
4. **Element filler** — port `element-filler.ts` directly. It's ~700 lines, no external deps except `cssesc`, `moment`, `randexp`. Replace `moment` with `date-fns` or `Intl.DateTimeFormat`; `cssesc` is only needed if you keep the label‑by‑id matching (you can also just escape quotes manually).
5. **Data generator + dummy data** — port verbatim. It's all `Math.random()` + array lookups.
6. **Settings store** — `chrome.storage.local`. Options schema in §2.2.
7. **Options UI** — anything you want. The reference UI is React + Redux + Formik + Bootstrap; you can use Vue, Svelte, Solid, or vanilla.

### 7.3 Things you can drop / simplify

- **Firebase, Stripe, login, Pro features** — drop entirely if your clone is free.
- **Redux + react-redux** — overkill for a settings object; one Zustand store or a single `useReducer` is enough.
- **moment** — deprecated, use `date-fns` or native `Intl`.
- **jQuery** — listed in deps but only referenced in legacy code; the actual source doesn't use it.
- **react-bootstrap** — you can pick any UI lib or write CSS.
- **`regeneratorRuntime.js` polyfill** — pre‑bundled in src/background/, no longer needed with modern targets.

### 7.4 Things to add (improvements over the original)

- **Respect `autocomplete` attributes** (`autocomplete="given-name"`, `family-name`, `street-address`, `postal-code`, …). There's an open issue (#188) for this — modern forms rely on it.
- **Faker.js / @faker-js/faker** for much richer dummy data (real addresses, IBANs, credit cards, UUIDs, etc.) instead of the 2.5k‑line hard‑coded corpus.
- **Shadow DOM piercing** — original uses `querySelectorAll`, which doesn't reach closed shadow roots. Use `element.shadowRoot?.querySelectorAll` recursion or a TreeWalker.
- **React/Vue‑friendly event dispatch** — original uses native `Event("input")`, which works for most cases but not all. Consider native setter override (`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, val)`) for React 16/17 controlled inputs.
- **Per‑site rules UI** (the Profiles feature) — keep, but make it free.
- **Sync** — use the browser's built‑in `storage.sync` (Chrome syncs it across devices for free, no backend needed) instead of Firebase.

### 7.5 Estimated effort

A faithful single‑developer MVP clone: **~1‑2 weeks**. The filling engine is the only non‑trivial part; everything else is plumbing. With a modern stack (Vite + React/Svelte + TypeScript), expect ~3,000‑4,000 LOC vs the original's ~8,000 LOC (most of which is the dummy‑data array and React boilerplate).

---

## 8. Specification

A precise spec for a compatible reimplementation:

### 8.1 Functional requirements

1. The extension MUST fill all form controls in the active tab when the toolbar icon is clicked.
2. The extension MUST support three scopes: all inputs in the page, the form containing the cursor, the single control under the cursor.
3. The extension MUST respect `disabled`, `readonly`, `hidden` (CSS), and `type=hidden|button|submit|reset|file|image`.
4. The extension MUST dispatch `input`, `click`, `change`, `blur` events after writing values, configurable per user.
5. The extension MUST match custom fields via case‑insensitive regex against any subset of {`name`, `id`, `class`, `placeholder`, `<label for=id>`, `aria-label`, `aria-labelledby`}.
6. The extension MUST support input types: text, email, password, number, range, checkbox, radio, tel, url, date, time, datetime‑local, month, week, color, search; plus `<textarea>`, `<select>` (single/multiple), `[contenteditable]`.
7. The extension MUST respect `min`, `max`, `step`, `minLength`, `maxLength` on inputs where applicable.
8. The extension MUST make confirm‑field keywords repeat the previous value (e.g. `confirm email` mirrors `email`).
9. The extension MUST check agree‑terms checkboxes unconditionally; other checkboxes randomly.
10. The extension MUST pick a random non‑disabled `<option>` for single selects and a random subset for multi selects (skipping the placeholder first option when its value is empty).
11. The extension MUST support 14 custom field types (see §1.4).
12. The extension MUST persist user settings in `chrome.storage.local` under key `options` and propagate changes to all open tabs without reload.
13. The extension MUST provide a keyboard shortcut (default `Ctrl+Shift+F` / `Cmd+Shift+F`) for "fill all".
14. The extension MUST provide a context menu with three items (when enabled).
15. The extension MUST support JSON/Base64 export and import of settings.
16. The extension MUST allow URL‑specific profiles (regex match on `window.location.href`) that augment the default field list.
17. The extension MUST NOT require any backend for core functionality.

### 8.2 Non‑functional requirements

- **Performance**: filling must complete in <500ms on a page with 500 form controls.
- **Memory**: content script idle footprint <2MB.
- **Privacy**: zero outbound network traffic for non‑logged‑in users; no analytics; no remote code.
- **Compatibility**: Chrome 100+, Edge 100+, Firefox 115+, any Chromium MV3 browser (Brave, Vivaldi, Arc).
- **Localisation**: i18n via `chrome.i18n` + `_locales/<lang>/messages.json` (reference ships English only despite a 213‑key catalog).
- **Security**: CSP‑compliant (no `eval`, no inline scripts); MV3 service worker (no persistent background page).
- **Licence**: MIT for the implementation; rebrand required to avoid trademark infringement on "Fake Filler".

### 8.3 Data model

See §2.2 for the canonical `IFakeFillerOptions` / `ICustomField` / `IProfile` schema.

### 8.4 Message protocol (background ↔ content)

| Direction | Message | Payload |
|---|---|---|
| content → bg | `getOptions` | — |
| bg → content (response) | — | `{ options: IFakeFillerOptions, isProEdition: boolean }` |
| bg → content | `receiveNewOptions` | `{ options, isProEdition }` |
| content → bg | `setProfileBadge` | `{ name }` |
| content → bg | `clearProfileBadge` | — |
| options UI → bg | `optionsUpdated` | `IFakeFillerOptions` (bg then broadcasts `receiveNewOptions` to every tab) |

---

## 9. Recommended Language / Stack for a Rewrite

### 9.1 Original stack

- **Language**: TypeScript 4 (Babel‑transpiled, not tsc‑checked in CI)
- **UI**: React 16 + Redux + redux‑thunk + react‑router‑dom v5 + Formik + react‑bootstrap (Bootstrap 4) + react‑beautiful‑dnd
- **Build**: Webpack 4 + Babel 7 + Sass + PostCSS + cssnano + mini‑css‑extract
- **Runtime libs**: firebase 7, moment 2, jquery 3, randexp 0.5, immer 7, cssesc 3, file‑saver 2
- **Lint**: ESLint + Airbnb config + Prettier
- **Target**: Manifest V3 (since Oct 2023); previous versions were MV2

This stack is by now (2026) **significantly outdated** — React 16, Webpack 4, moment.js, Bootstrap 4, react‑bootstrap v1, Formik 2 with class properties, and firebase 7 are all multiple majors behind.

### 9.2 Recommended clone stack

**Strong recommendation: TypeScript + Vite + React 19 + CRXJS** (or Plasmo).

Browser extensions are a JavaScript‑only domain — the entire platform API is `chrome.*` / `browser.*`. Choosing anything other than JS/TS means writing your own bindings layer and losing access to the rich extension ecosystem. Stick with the platform's native language.

| Concern | Recommendation | Why |
|---|---|---|
| Language | **TypeScript** (strict) | The platform is JS; TS gives you the type safety the original lacked (it's Babel‑transpiled `.ts` with `eslint-disable no-explicit-any`). `@types/chrome` is excellent. |
| Framework for options UI | **React 19** or **Svelte 5** | Settings UI is form‑heavy; React + `react-hook-form` (or Svelte's `formData` action) is far lighter than the original Formik + Redux combo. |
| Build tool | **Vite 5** + **@crxjs/vite-plugin** (or **Plasmo**) | Hot reload for content scripts, manifest generation from TS, MV3‑first. Webpack 4 is EOL. |
| State | **Zustand** (or `useReducer`) | The Redux + thunk + immer stack is overkill for a single settings object. |
| Styling | **Tailwind CSS** or **shadcn/ui** | Bootstrap 4 is dated; Tailwind ships far smaller CSS. |
| Forms | **react-hook-form** + **zod** | Replaces Formik with 1/10 the re‑renders and built‑in schema validation. |
| Date handling | **date-fns** or **native `Intl`** | moment.js is in maintenance mode and 70KB. |
| Random data | **@faker-js/faker** | Replaces the 33KB hard‑coded corpus with locale‑aware real‑looking data (addresses, phones, credit cards, etc.). |
| Regex generator | **randexp** | Still the only sensible choice; reuse as‑is. |
| CSS escaping | **cssesc** (or hand‑rolled) | Tiny, still works. Or sidestep by using `CSS.escape()` which is built into browsers. |
| Sync (optional) | **`chrome.storage.sync`** | Free, built‑in, no Firebase needed. 100KB quota is plenty. |
| Backend (optional paid) | **Supabase** or **Cloudflare Workers + D1** | If you want sync + Pro accounts without Google/Firebase. |
| Testing | **Vitest** + **Playwright** (MV3 e2e via `chromium` with `--load-extension`) | No tests exist in the original; add them. |
| Lint/format | **Biome** or **ESLint 9 + Prettier 3** | Flat config, 10× faster. |

### 9.3 Alternative stacks (if you have a strong reason)

- **Plasmo** — like Next.js for extensions; gives you TSX content scripts, messaging helpers (`@plasmohq/messaging`), and one‑command store uploads. Best choice if you want batteries included.
- **WXT** — the newer Vite‑based framework; similar pitch to Plasmo, more flexible.
- **SvelteKit‑adapted for extensions** — viable, smaller bundle.
- **Kotlin/JS or ReScript** — possible but you'll be alone; not recommended.
- **Rust → WASM for the filler engine** — pointless; the engine is DOM‑bound, not CPU‑bound, and WASM can't touch the DOM directly.

### 9.4 What NOT to use

- **Don't rewrite in Go, Rust, Python, or any non‑JS language.** Browser extensions cannot be authored natively in them; WASM adds complexity without benefit here.
- **Don't use jQuery.** It's in the original's deps but unused in source.
- **Don't use moment.js.** Use date‑fns or Intl.
- **Don't use Redux.** Zustand is enough.
- **Don't use Firebase unless you need cross‑browser sync.** And if you do, use `chrome.storage.sync` first.

### 9.5 TL;DR

> **TypeScript + Vite + Plasmo (or @crxjs) + React 19 + Tailwind + Zustand + react‑hook‑form + @faker-js/faker + randexp + date‑fns.** Skip Firebase/Stripe entirely unless you're cloning the paid tier. Expect a 2‑week MVP, 3,500 LOC, and a 60KB content script vs the original's ~250KB bundle.

---

## 10. Why the Source Went (Effectively) Closed

The LICENSE file still says MIT and was never changed. So strictly, the *last published source* remains MIT‑licensable and forkable. The maintainer simply stopped publishing current source. That's legally fine — MIT doesn't oblige you to keep publishing future versions — but it is a textbook case of **"open core, closed‑source current product."**

The smoking gun is commit **`0f6491d` — "Pro edition features"**, dated **24 June 2020**. That is the inflection point. Cross‑reference with the rest of the history:

- **Pre‑2020**: pure OSS. Single developer (Hussein Shabbir), MIT, ~7 years of quiet incremental work. No backend, no accounts, no money.
- **Jun 2020**: Pro tier lands simultaneously with Firebase, Stripe, `users/<uid>` docs containing `stripeCustomerId` / `stripeSubscriptionId`, the `subscribed` custom claim, the 25‑field paywall, and the `GetProModal`. The README shrinks to "install links only" around the same time.
- **Jul 2020**: Issue #137 is filed — "code in the store isn't in the repo." The pattern is established within weeks of monetisation.
- **2023**: last public commit. Store keeps being updated, GitHub doesn't.

Likely reasons, in order of weight:

1. **Paywall integrity.** Everything Pro‑gated (the 25‑field cap, profiles, sync, the `subscribed` claim check in `saveOptionsToDb`) is trivially patchable in OSS. Keeping the store build private is the only thing stopping a one‑line `claims.subscribed = true` fork from eating the revenue.
2. **Secret hygiene.** Firebase API key, auth domain, project ID, and any Stripe webhook signing keys cannot live in a public repo. Once you've split the codebase into "public" and "private with secrets," it's easy to let the public side stagnate.
3. **`fakefiller.com` as a business.** Once there's a marketing site, a pricing page, a Stripe webhook, an account dashboard, and customer support emails, the extension becomes the client of a SaaS — not a standalone OSS tool. SaaS clients are routinely kept proprietary even when their license says MIT (cf. many VS Code extensions, Postman, etc.).
4. **Reduced maintenance surface.** Open‑sourcing the MV3 migration, Firefox quirks, or the Firebase config invites issue reports and PRs the solo maintainer doesn't want to triage.
5. **Brand/trademark.** "Fake Filler" is now a brand with paid customers. Public builds dilute that.

## 11. Why No Privacy Guarantee Is Possible

Three independent layers of non‑auditability, each sufficient on its own:

### 11.1 The repo is not the binary

The thing in your browser is a bundled `.crx` produced from a **private branch** with extra dependencies and Firebase secrets. You can read the public repo top‑to‑bottom and still have zero assurance about what's actually shipped. There's no reproducible build, no signed SLSA provenance, no SBOM, no published checksum. Browser extension stores do *some* static review but it's well known to be beatable.

### 11.2 Firebase is a black box

`firebase@7` initialises Auth + Firestore, and the SDK then makes opaque background calls (token refresh, presence pings, analytics‑ish events if any are enabled server‑side). Even with full source you cannot see what the Firebase backend logs about your session — that lives on Google's side, controlled by the maintainer's Firebase project config, not by the code in the repo.

### 11.3 The permissions allow far more than the code uses

`<all_urls>` + `scripting` + a content script on **every page** with a `mousedown` listener is a full keylogger‑grade capability. Today it only reads form fields when triggered. Tomorrow's silent auto‑update could read `document.cookie`, exfiltrate passwords, or scrape page content. There have been multiple real‑world cases of extensions being acquired and turned into malware (HoverZoom, Copyfish, etc.).

### 11.4 The privacy policy is not a guarantee

The [official privacy policy](https://fakefiller.com/privacy) does **not** say "we will never." It says what they currently do, with caveats like *"we may update this privacy policy from time to time."* It also reserves the right to disclose data "if required by law." That's standard legal phrasing but it is explicitly **not** a forward‑looking guarantee.

### 11.5 Implications for a clone

This is actually a strong marketing position for a reimplementation. A clone can credibly offer what FakeFiller structurally cannot:

- **Publish on GitHub** the exact build that ships to the store.
- **Reproducible builds**: Vite + pinned lockfile + CI that builds the `.crx` and publishes it as a release artefact, so users can verify `sha256(store_crx) == sha256(github_release_crx)`.
- **No backend, no Firebase, no accounts.** Use `chrome.storage.sync` for cross‑device sync. Eliminates the entire "what does the server see?" question.
- **Drop `<all_urls>` content script.** Use `activeTab` + `scripting.executeScript` only on icon click. The current FakeFiller injects into every page on every load; a clone can avoid that and put it in writing.
- **A binding privacy commitment** (not a policy) stating "no network calls from the extension, ever."

That package — verifiable build, no backend, minimal permissions, public source — is something FakeFiller cannot offer without abandoning its Pro tier, and it's a legitimate reason for a clone to exist beyond just "another implementation."

---

## 12. Firebase's Exact Role (Deep Dive)

Firebase is used for **four** things, all gated behind explicit user login on the options page (`src/common/firebase.ts`). For users who never log in (i.e. the entire free tier), the only Firebase traffic is the SDK's bootstrap config fetch — `auth.onAuthStateChanged` fires with `user === null` and no Firestore subscriptions are opened (`firebase.ts:78`).

### 12.1 Authentication (`firebase.ts:107-116`)

Email/password login via `auth.signInWithEmailAndPassword`. Used to identify Pro subscribers. Persistence is `Auth.Persistence.LOCAL` so the session survives browser restarts. No OAuth providers — just email + password.

### 12.2 Pro entitlement check (`firebase.ts:87-97`)

After login, `auth.onIdTokenChanged` fires and reads the user's Firebase ID token's custom claims → `claims.subscribed: boolean`. That single boolean unlocks:

- Unlimited custom fields (free cap = 25)
- Profiles (URL‑specific field sets)
- Cross‑device sync

The claim itself is written **server‑side by a Stripe webhook** (not in the repo) that updates `users/<uid>.claims` and bumps `claimsUpdatedAt`, which the client watches (`firebase.ts:58-68`) and uses to force‑refresh the token. So the trust root is: Stripe → webhook → Firestore doc → client token claim → feature gate.

### 12.3 Settings sync (`firebase.ts:46-56, 124-137`)

One Firestore document per user:

```
settings/<uid> = { options: <stringified IFakeFillerOptions JSON>, updatedAt: serverTimestamp() }
```

- On save → `saveOptionsToDb` writes (only if `claims.subscribed === true`).
- On other devices → `onSnapshot` listener applies the new options live without reload.
- Conflict resolution is "last writer wins," mediated by `serverTimestamp()`.
- The `if (!snapshot.metadata.hasPendingWrites ...)` check (`firebase.ts:49`) suppresses echoes of the client's own writes.

That's the entire sync mechanism — a 153‑line file. It replaces what `chrome.storage.sync` could do for free (with a 100KB quota that is plenty for a settings blob).

### 12.4 User record (read‑only client side)

```
users/<uid> = { emailAddress, stripeCustomerId, stripeSubscriptionId, claims, claimsUpdatedAt }
```

Written by the backend; the client subscribes to it solely to detect subscription status changes (e.g. user upgrades → Pro unlocks without relogin). The `users` collection is also the channel through which the Stripe webhook tells the client "this user paid."

### 12.5 What Firebase does NOT do here

- **No Cloud Functions, no Analytics, no Crashlytics, no Performance Monitoring, no Remote Config, no A/B testing** — none of those SDKs are imported. `firebase.ts:1-4` pulls in `firebase/app`, `firebase/auth`, `firebase/firestore`. Period.
- **No storage of form data, page content, URLs, or anything the extension fills.** Only the user's *own settings JSON* and auth token flow through Firebase.
- **Not used in the content script at all.** Firebase only runs in the **options page** (the React UI), which opens in its own tab and never touches the pages you fill. The content script and service worker have no Firebase imports.

### 12.6 Firebase data flow diagram

```
                        ┌─────────────────────┐
                        │  fakefiller.com       │
                        │  (Stripe checkout)    │
                        └──────────┬───────────┘
                                   │ Stripe event
                                   ▼
                        ┌─────────────────────┐
                        │  Backend webhook      │
                        │  (not in public repo) │
                        └──────────┬───────────┘
                                   │ writes
                                   ▼
              ┌────────────────────────────────────┐
              │  Firebase Firestore                 │
              │  ├─ users/<uid>                     │
              │  │   { stripeCustomerId,            │
              │  │     stripeSubscriptionId,        │
              │  │     claims.subscribed: true,     │
              │  │     claimsUpdatedAt }            │
              │  └─ settings/<uid>                  │
              │      { options: <json>, updatedAt } │
              └──────────┬──────────────────────────┘
                         │ onSnapshot
                         ▼
              ┌────────────────────────────────────┐
              │  Extension options page (React)     │
              │  - onIdTokenChanged reads claim     │
              │  - saves settings on edit           │
              │  - applies remote settings to UI    │
              └────────────────────────────────────┘
```

### 12.7 Replacement options for a clone

| Need | FakeFiller's choice | Recommended clone choice |
|---|---|---|
| Cross‑device settings sync (free) | Firebase Firestore (Pro only) | **`chrome.storage.sync`** — free, 100KB quota, no backend |
| User accounts (optional) | Firebase Auth | **Clerk** or **Supabase Auth** or **none** |
| Subscription billing | Stripe + custom webhook + Firebase Firestore | **Stripe** only (webhook → `chrome.storage.sync` is not possible across users, so this only matters if you actually sell Pro) |
| Entitlement storage | Firestore `users/<uid>` doc | Same as billing — only needed for a paid tier |
| Backend logic | Implicit (Stripe webhook) | **Cloudflare Workers** or **Supabase Edge Functions** |

For a **free, no‑account clone**: drop all four columns and use `chrome.storage.sync`. Zero backend, zero Firebase, zero Stripe, zero privacy surface area. For a **clone with a paid tier**: Supabase (Postgres + Auth + Edge Functions) replaces Firebase end‑to‑end with an OSS stack you can self‑host.

---

## Appendix A — Repository Structure (master @ 36daf90)

```
fake-filler-extension/
├── public/
│   ├── _locales/en/messages.json     # 213 i18n keys (English only)
│   ├── images/                        # icons 16/32/48/64/96/128 PNGs + SVGs
│   ├── manifest.json                  # MV3 manifest, v3.4.0
│   └── options.html                   # React mount point
├── src/
│   ├── background/regeneratorRuntime.js  # babel polyfill (legacy)
│   ├── service_worker/index.ts        # 183 LOC — context menus, commands, action click
│   ├── content_script/index.ts        # 57 LOC — receives options, tracks clicked element
│   ├── common/
│   │   ├── fake-filler.ts             # 73 LOC — orchestrator class
│   │   ├── element-filler.ts          # 679 LOC — per-type fill logic + matching
│   │   ├── data-generator.ts          # 257 LOC — random generators
│   │   ├── dummy-data.ts              # 2554 LOC — hard-coded word/name/TLD corpus
│   │   ├── helpers.ts                 # 279 LOC — defaults, storage, context menus
│   │   └── firebase.ts                # 153 LOC — auth + Firestore (Pro only)
│   ├── options/
│   │   ├── index.tsx                  # React entry, Redux Provider, Router
│   │   ├── actions.ts                 # 354 LOC — Redux thunks for CRUD on options
│   │   ├── reducer.ts, store.ts
│   │   ├── constants.ts
│   │   └── components/                # ~20 React components for the options UI
│   └── types.ts                       # 182 LOC — all shared TS types
├── test_pages/plain.html              # manual test form
├── webpack.config.{ts,dev.ts,prod.ts}
├── package.json                       # version 3.0.0 (out of sync with manifest 3.4.0)
├── tsconfig.json
├── .eslintrc.json, .prettierrc, .babelrc, .browserslistrc, .editorconfig
├── LICENSE                            # MIT, (c) 2014-2020 Hussein Shabbir
└── README.md                          # 13 lines, just install links + shortcut
```

Total TypeScript source: **~7,942 lines** across 51 files (including ~2,554 lines that are pure data arrays).

## Appendix B — Key Files to Read First When Porting

1. `src/types.ts` — the data model (1 page, defines everything).
2. `src/common/element-filler.ts` — the heart; per‑type dispatch + matcher.
3. `src/common/data-generator.ts` — the random generators.
4. `src/common/fake-filler.ts` — the public orchestrator API.
5. `src/service_worker/index.ts` — how the three triggers map to `executeScript`.
6. `src/content_script/index.ts` — message handling, profile selection, click tracking.
7. `src/common/helpers.ts` — `FakeFillerDefaultOptions()` is the canonical default‑settings fixture.

## Appendix C — Sources

- GitHub repo: https://github.com/FakeFiller/fake-filler-extension
- Privacy policy: https://fakefiller.com/privacy
- Chrome Web Store: https://chromewebstore.google.com/detail/fake-filler/bnjjngeaknajbdcgpfkgnonkmififhfo
- Firefox Add‑ons: https://addons.mozilla.org/en-US/firefox/addon/fake-filler/
- Wiki (keyboard shortcuts): https://github.com/FakeFiller/fake-filler-extension/wiki/Keyboard-Shortcuts
- Issue #137 (repo ≠ store build): https://github.com/FakeFiller/fake-filler-extension/issues/137
- Issue #188 (autocomplete support request): https://github.com/FakeFiller/fake-filler-extension/issues/188
