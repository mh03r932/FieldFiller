# Art brief and generation prompts

Everything in `public/icon/` today is placeholder artwork drawn by `scripts/make-icons.mjs`.
C-010 requires that the icon, store imagery and listing copy share nothing with Fake Filler,
and the generator was the cheapest possible proof of that — the artwork's whole provenance is
forty lines of committed geometry. It satisfies the constraint; it does not carry a listing.

This file is the brief for replacing it. The prompts below are paste-ready, one per asset.
Read §1 and §2 first — the prompts assume both.

---

## 1. Asset inventory

What each store actually requires, as of the 2026 review policies. Sizes are hard: both
stores reject off-size uploads rather than scaling them.

### Ships inside the package

| Asset | Size | Where |
|---|---|---|
| Extension icon | 16, 32, 48, 96, 128 px PNG | `public/icon/`, referenced by `manifest.icons` |

The 16 px rendering is the one that decides whether the mark works. It is what a user sees in
the toolbar, all day, and it is roughly eleven pixels of usable interior once the rounded
corners are paid for. Design at that size and scale up; a mark designed at 512 and reduced is
how you get a blue smudge.

### Chrome Web Store listing

| Asset | Size | Required |
|---|---|---|
| Store icon | 128×128 PNG | Yes |
| Screenshots | 1280×800 PNG or JPEG, 1–5 of them | Yes — at least one |
| Small promo tile | 440×280 PNG or JPEG | No, but it is what the store shows in every browse and search result. Treat as required |
| Marquee promo tile | 1400×560 PNG or JPEG | No. Only used if Google considers the extension for featuring |

### Firefox AMO listing

| Asset | Size | Required |
|---|---|---|
| Add-on icon | 128×128 PNG | No — AMO substitutes a generic puzzle piece, which is worth avoiding |
| Screenshots | 1000 px wide or more, PNG or JPEG | No, same argument. Reuse the 1280×800 captures |

AMO has no promo tiles. Nothing else on either listing is an image.

---

## 2. Brand constants

Paste this block into every prompt below. It is the whole visual system, and it comes from
what the product already is rather than from a moodboard — every hex below is live in the
shipped code.

```
PALETTE (exact hex, enforced in post-processing — treat as direction, not as a promise
the generator can keep):
  brand blue      #2F6FED   the icon tile; the badge after a successful fill
  warn amber      #D68910   the badge when a fill was capped
  fail red        #C0392B   the badge when a control could not be filled
  neutral grey    #8A8F98   the badge when nothing was filled
  ink             #1B1C1E   text, dark surfaces
  paper           #FFFFFF   light surfaces
  muted           #55585E   secondary text
  rule            #D8DADE   hairlines and borders

FORM: geometric, flat, no gradients beyond a single subtle vertical tint, no drop shadows,
no bevels, no glass, no 3D, no skeuomorphism. Sharp geometry with generous corner radii.
The visual language of a developer tool, not of a consumer app.

SUBJECT: the product fills form fields. The existing mark is three stacked rounded bars on a
blue rounded-square tile, the third bar part-filled — a field caught mid-fill. That idea is
sound and worth keeping; it is the execution that needs raising.
```

### Negative constraints — these are legal, not aesthetic

PD-004 rebrands completely and C-010 requires the imagery share nothing with the reference.
Carry these into every prompt:

```
DO NOT: use a letterform or monogram of any kind (no F, no FF, no lettering inside the mark).
DO NOT: use a pencil, pen, quill, magic wand, magnifying glass, robot, or lightning bolt.
DO NOT: use a clipboard or a paper-document silhouette.
DO NOT: use any teal, green, or purple as the primary tile colour.
DO NOT: render any text inside the icon.
```

The monogram and the pencil are the two shapes a form-filler extension reaches for by
default, which is exactly why the reference and its imitators are full of them. Avoiding
them is what makes a side-by-side comparison boring, and boring is the goal.

Before shipping anything generated here, open the Fake Filler listing on both stores and put
the two marks side by side. §8.3 of the vision found no registered trademark anywhere, so the
realistic risk is not litigation — it is a store complaint, which Google and Mozilla act on
without adjudicating. A mark that is obviously unrelated at a glance is the whole mitigation.

---

## 3. Prompt — the icon master

> **Settled, 2026-08-22.** The icon is done and this section is kept for the record and for
> any future remake. A generated master was produced from the prompt below, and what shipped
> is the mark rebuilt as geometry in `scripts/make-icons.mjs` — see the note at the end of
> this section for what changed between the two and why.

Generate at **1024×1024**. This is a master to trace, not a shippable asset; see §7 for what
happens to it afterwards.

Ask for all three directions, then pick one. They are genuinely different bets, and which one
survives 16 px is not predictable from the 1024 px render.

```
A flat vector app icon, 1024×1024, centred on a transparent background.

SUBJECT: a rounded-square tile in a strong medium blue (#2F6FED), corner radius roughly 22%
of the tile's width, filling the frame with about 3% margin. On the tile, three stacked
horizontal rounded bars in pure white, evenly spaced, each about 10% of the tile height with
a small corner radius. The bottom bar is split: its left two-thirds is solid white, its right
third is a lighter translucent white — one field caught halfway through being filled.

STYLE: flat geometric vector. No gradient, no drop shadow, no bevel, no inner glow, no
texture, no 3D, no outline stroke. Crisp mathematical edges. Perfectly symmetrical about the
vertical axis. The style of a modern developer-tool icon — Linear, Vercel, Raycast — not a
consumer app icon.

CONSTRAINTS: no text, no letters, no numbers, no monogram. No pencil, pen, cursor, wand,
magnifier, robot, or lightning bolt. No clipboard or document silhouette. No teal, no green,
no purple. Nothing outside the tile.

LEGIBILITY: the composition must survive reduction to 16×16 pixels. At most three distinct
shapes. Whitespace between bars at least as thick as the bars themselves.
```

Three variations to request alongside it:

**Direction A — the caret.** Replace the part-filled third bar with a solid short bar plus a
white text caret at its right edge. Says *in progress* more literally, and reads as "a field
being typed into" rather than "a progress meter." Risk: a 1 px caret disappears at 16 px.

**Direction B — the stack.** Four bars instead of three, of decreasing width, all solid
white. Says *many fields at once*, which is nearer to what the product actually does than
*one field mid-fill*. Risk: four bars at 16 px is two grey bands.

**Direction C — the check.** Three solid bars with a small white check mark overlapping the
lower right, breaking the tile edge. Says *done*, which is the state the user is buying.
Risk: a check mark is the single most crowded shape in an extension toolbar.

My recommendation is to render all three and judge them only at 16 px, pasted into a real
toolbar screenshot next to the extensions you already have installed. The 1024 px render will
make all three look fine and will tell you nothing.

### What actually shipped

The generated master confirmed the concept reads — blue tile, three bars, third part-filled,
no monogram and no pencil — and three things had to change before it could be an icon.

**The sparkles came out.** The generator added three four-pointed stars down the right edge
that the prompt never asked for. They are the standard visual tell of a generated image, they
broke the vertical symmetry the prompt specified, and they spent the entire shape budget that
§3's legibility clause exists to protect. At 16 px they were three grey specks. Removing them
also recentred the mark, which the sparkles had pushed left, leaving a dead band across the
bottom third.

**The geometry moved onto the 16 px grid.** This is the change that mattered, and it is not
something a generated master can do for you. Every horizontal edge is now an exact sixteenth,
so a 16 px render lands on whole pixels: bars on rows 3-5, 7-9 and 11-13, two pixels each,
two clear pixels between, three of margin. The previous geometry sat on arbitrary fractions,
so at 16 px every bar straddled a pixel boundary and antialiasing diluted it — the bars never
reached white, and the mark read as a pale blue blur. Same shapes, same colours; the only
difference is where the edges fall. It is the whole difference between the two renders.

**The part-filled bar became a fill over a track.** It had been two abutting pills, and two
pills meeting at a seam taper to a point on both sides of it, pinching the bar in the middle.
At 128 px that is a subtle flaw; at 16 px it reads as a gap rather than as a boundary. Drawing
the filled portion over a full-width track removes the seam entirely.

The generated PNG is not in the repository and nothing was traced from it. The mark is
forty lines of committed geometry, which keeps C-010's provenance argument intact: you can
read the entire artwork.

---

## 4. Prompt — small promo tile, 440×280

This is the one that matters. It appears in every Chrome Web Store search result and browse
row, at a size where a screenshot is unreadable, so it has to work as a poster.

```
A promotional tile for a developer tool, exactly 440×280 pixels, landscape.

COMPOSITION: the app icon — a blue rounded square with three white horizontal bars, the
bottom one part-filled — sits at the left third, occupying about 45% of the tile height. To
its right, the product name "FieldFiller" in a clean geometric sans-serif, semibold, near
black (#1B1C1E), and beneath it in smaller regular weight and medium grey (#55585E) the line
"Fill every form on the page in one click."

BACKGROUND: flat near-white (#FFFFFF) with a very subtle pale blue tint in the lower right
corner. Optionally a faint hairline grid in #D8DADE at very low opacity, suggesting form
field outlines, kept well behind the foreground.

STYLE: flat, geometric, generous whitespace, high contrast, no gradient mesh, no drop
shadows, no glow, no 3D mockup, no photographic elements, no people, no hands, no browser
chrome. Clean developer-tool marketing, closer to a documentation site header than to an
app-store banner.

CONSTRAINTS: no stock-photo imagery, no gradients across the whole background, no busy
patterns. Leave at least 20 pixels of clear margin on all four edges.
```

**Assume the generated text is wrong.** Image models still mangle short strings, and
"FieldFiller" is one word that any of them will happily render as "FieldFiler" or
"FeildFiller" — on the tile that is the first thing a reviewer sees. Generate the tile as
background and icon only, then set the two text lines yourself in any layout tool. That is
also how you get the type to match across the tile, the marquee and the screenshots.

---

## 5. Prompt — marquee promo tile, 1400×560

Only used if Google considers the extension for featuring. Cheap to make once the small tile
exists, and there is no way to be considered without it.

```
A wide promotional banner for a developer tool, exactly 1400×560 pixels.

COMPOSITION: strongly asymmetric. The left 40% carries the app icon — a blue rounded square
with three white horizontal bars, the bottom one part-filled — at about 30% of the banner
height, with the product name "FieldFiller" below it in geometric semibold sans near black,
and one line of smaller grey supporting text. The right 60% shows an abstract, simplified
representation of a web form: six or seven rounded rectangles of varying width stacked with
even spacing, in pale grey (#D8DADE), with three of them filled solid in brand blue (#2F6FED)
as though completed. No real text inside the field shapes — they are abstract bars, not a
readable form.

BACKGROUND: flat near-white, with an extremely subtle vertical tint from white to a very pale
blue-grey. Nothing else.

STYLE: flat geometric vector, generous whitespace, calm, high contrast. No 3D, no perspective,
no browser window mockup, no laptop or device frame, no people, no hands, no photographs, no
gradients beyond the single background tint, no drop shadows.

CONSTRAINTS: keep the outer 60 pixels on every edge clear of anything meaningful — the store
crops this tile at several aspect ratios.
```

Same warning as §4: set the text yourself.

---

## 6. The screenshots are not generated

Both stores require screenshots, and a generated image of a fake UI is a policy problem, not
just a taste one — CWS review rejects listing images that misrepresent the product, and an
invented options screen misrepresents it by construction. The five captures should come out
of the real extension.

The harness for this already exists. `scripts/e2e-chrome.mjs` loads the built extension in a
real Chromium over CDP and fills the reference page; `scripts/a11y-options.mjs` opens the real
options page. Either is a few lines from `page.screenshot()` at a 1280×800 viewport.

The five worth capturing, in listing order:

1. **The reference page after a fill.** The whole product in one image — every control kind
   carrying plausible, coherent data. This is the screenshot that sells it.
2. **The rule editor**, with a rule expanded showing its match sources and generator.
3. **The profiles section**, showing a URL-matched profile.
4. **The options page**, scrolled to exclusions, showing a domain excluded.
5. **The fill report**, showing what landed and what was skipped and why.

Composite each capture onto the §5 background with a 40 px margin and a one-line caption in
the same type as the tiles, so the five read as a set. Do not add a fake browser chrome frame
around them — reviewers dislike it and it costs you pixels.

---

## 7. Getting the result back into the repo

The generated master is a raster. What ships is five PNGs at exact sizes, and there is a
reproducibility claim standing behind them.

1. **Trace the chosen master to vector.** The mark is three or four rounded rectangles on a
   rounded square; it should be rebuilt as geometry, not downsampled from a 1024 px raster.
   Downsampling a diffusion output to 16 px produces exactly the blue smudge §1 warns about.
2. **Then choose one of two paths:**
   - *Rewrite `scripts/make-icons.mjs`* with the new geometry, keeping its deterministic
     output. This preserves the property the file was written for: the artwork's entire
     provenance stays auditable in forty lines, and regenerating never dirties the tree.
     Best if the final mark stays rectilinear.
   - *Commit the five PNGs as static assets* and retire the generator. Necessary if the final
     mark has curves the generator cannot express. If you take this path, delete
     `scripts/make-icons.mjs` rather than leaving it — its docstring asserts a provenance
     claim that would no longer be true, and a stale generator that regenerates *different*
     art than what ships is worse than no generator.
3. **Re-run `pnpm run verify:reproducible`.** NFR-011 compares digests across two clean
   builds. Icons are build inputs; changing them changes the published digest, which is
   correct and expected — what must not happen is two builds of the same tree disagreeing.
4. **Update the README.** Its "Still open before release" section names the placeholder icons
   as an open item (C-010); that line comes out when this lands.
5. **Update C-010's status** in `docs/requirements.md`, which is still `Open`.

---

## 8. What this brief does not cover

The listing *copy* — the store description, the single-purpose statement, the permission
justifications, the privacy disclosure — is C-011 and C-012, not C-010, and none of it is
art. It is a separate deliverable and it is still unwritten.

Two things found while surveying this that are release blockers and are not artwork:

- **The Firefox package is missing `data_collection_permissions`.** The build warns on every
  `pnpm build:firefox` run: AMO has required the key for new extensions since 3 November
  2025. For an extension that collects nothing it is `required: ["none"]` in
  `browser_specific_settings.gecko`, and without it a new submission is rejected.
- **No privacy policy exists**, and the Chrome Web Store will not accept a listing without a
  publicly reachable URL for one. The only git remote is self-hosted Gitea, so where this is
  hosted is an open question — and C-014 separately requires the source to be public at the
  tagged commit.
