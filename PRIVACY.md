# Privacy Policy

**FieldFiller browser extension**
Last updated: 28 August 2026. Applies from the first published release.

---

## The short version

FieldFiller collects nothing, transmits nothing, and contacts no server. There is no
account, no analytics, no telemetry, no crash reporting, and no third-party service of any
kind. Nothing you do with it is visible to anyone but you.

This is not a promise about intent. The extension contains no code capable of making a
network request, and that is checked mechanically on every change — see
[Verifying this](#verifying-this) below.

---

## What FieldFiller stores

One thing: **your settings**, in the browser's extension-local storage (`storage.local`) on
the device where you set them.

That is your rules, profiles, field and domain exclusions, password policy, behaviour
toggles, and corpus locale — the contents of the options page, and nothing else.

### Settings stay on the device unless you say otherwise

By default, they stay put. FieldFiller does not use the browser's synchronised storage
unless you switch it on, and the switch is off when the extension is installed.

**If you switch it on**, a copy of those same settings is written to the browser's own
synchronised storage (`storage.sync`) so that your other browsers signed into the same
browser account receive it. That copy is handled by your browser and your browser vendor,
under their terms, exactly as your bookmarks and saved passwords are. FieldFiller has no
account, no server and no way to read it: there is nowhere for it to go that your browser
was not already going.

Two things about that switch are worth knowing before you use it:

- **It is decided separately on each browser**, and the setting itself is never carried. Turning
  synchronisation off on your laptop does not turn it off on your desktop, and does not touch
  the copy your other browsers are using.
- **It carries settings, and only settings.** The same list as above. Nothing about pages you
  visited, nothing generated, nothing about the device.

You can turn it off at any time. Your settings stay on the device, complete, and the copy
your other browsers use is left where it is.

Either way, moving a configuration between machines by hand is still a deliberate act you
perform: you export a JSON file from the options page and import it on the other machine. The
file goes where you put it.

**FieldFiller does not store:** the contents of any page you visit, the values it generated,
which sites you used it on, when you used it, how often, or anything identifying you or your
device.

## What FieldFiller reads on a page

To fill a form, the extension has to look at the form. When you trigger a fill, it reads the
structural attributes of the form controls in scope — the element type, `name`, `id`,
`class`, `placeholder`, associated label text, and native validation constraints such as
`maxlength`, `min`, `max` and `pattern` — and uses them to decide what kind of value each
control should get.

That reading happens entirely inside your browser, at the moment you trigger a fill, and the
result is discarded when the fill completes. It is not stored, logged, or sent anywhere.

**FieldFiller never reads the values already in a page's fields**, with a single narrow
exception: when the "skip pre-filled fields" behaviour is enabled, it checks whether a field
is empty in order to leave non-empty ones alone. It tests emptiness; it does not retain,
inspect or transmit the content.

## What FieldFiller writes to a page

Plausible fake data, generated locally, from a name and address corpus bundled inside the
extension. The generated persona is invented. It does not correspond to a real person, and
it is not drawn from anything on your device, your contacts, your browser profile, or any
external source.

## Permissions, and why each one exists

| Permission | Why it is needed |
|---|---|
| `storage` | To save your settings on this device — and, only if you switch synchronisation on, to write the same settings to the browser's own synchronised storage. Nothing else is written to either. |
| `activeTab` | To act on the tab you are looking at when you click the toolbar button or press a shortcut. It grants access to that one tab, at that moment, because you asked. |
| `scripting` | To dispatch the fill into each frame of the page, including nested and cross-origin frames — a form in an iframe cannot be reached from its parent document. |
| `contextMenus` | To add the three right-click entries: fill all inputs, fill this form, fill this input. |
| Access to all sites | The extension's helper runs in every page so that "fill this input" knows which element you right-clicked. Chrome does not tell an extension which element a context-menu click landed on, so something must already be present in the page to observe it. **That helper carries no data, contacts nothing, and does nothing at all until you trigger a fill.** It is inert on every page you never fill. |

The extension deliberately does **not** request `tabs`, `webRequest`, `cookies`, `history`,
`downloads`, or `nativeMessaging`. Several features were built the harder way specifically to
avoid needing them.

## Children

FieldFiller is a developer and QA tool. It is not directed at children and collects no data
from anyone, of any age.

## Third parties

There are none. The published extension bundles no third-party runtime libraries, no SDKs, no
fonts or assets fetched from elsewhere, and no remote code. There is no data to share,
because none is collected, and there is no party to share it with.

## Verifying this

You do not have to take any of the above on trust, which is the point of building it this
way.

- **The source is public** at the tag matching each published release.
- **A gate in CI rejects the build** if any shipped file gains a `fetch`, `XMLHttpRequest`,
  `WebSocket`, `EventSource` or `sendBeacon` call, references an external URL, or introduces
  remotely-executed code. "No outbound request is possible" is enforced as a build failure,
  not asserted in a document.
- **A second gate rejects the build** if the extension ever requests a permission beyond the
  five above.
- **Builds are reproducible.** Each release publishes the digest of its artefact, so you can
  build the public source yourself and confirm that what is in the store is what is in the
  repository.
- **You can watch it directly.** Open your browser's developer tools, switch to the Network
  panel, and use the extension as much as you like. There is nothing to see.

## Changes to this policy

If this policy ever changes, the change will be recorded in the repository's `CHANGELOG.md`
and the date at the top of this file will be updated. Because the extension is versioned and
its source is public, any change to what it does is visible in the diff between two tags.

If a future version were ever to collect or transmit anything — it will not — that would be a
new permission in the manifest, a new entry in the store's data disclosure, and a browser
prompt asking you to accept it. The stores will not let it happen quietly, and neither will
the gates above.

## Contact

Questions about this policy, or about what the extension does: open an issue at
**https://github.com/mh03r932/FieldFiller/issues** — it reaches the maintainer directly,
and the answer lands in public where the next person with the same question finds it.

Source: **https://github.com/mh03r932/FieldFiller**
