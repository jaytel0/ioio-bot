# Landing motion

Run `npm run preview:landing` on the Mac Mini. Open:

- `http://127.0.0.1:8800/` — the actual landing HTML, CSS and nonce-authorized script.
- `/study` — all characters enlarged; pause, scrub and record a ten-second loop.
- `/verify` — an 18-second in-browser geometry/frame-time/layout-shift check.
- The local preview's **Original / OG v2 / Shop Minis** selector switches motion in place.
  Direct links: `/?motion=original`, `/?motion=og-v2`, and `/?motion=minis`.
  Original remains the default.

The study and verifier exist only in the local preview server. Neither is routed
by the production Worker. `npm run dev` requires a local Wrangler configuration
with routes removed and `BTB_BASE_URL` matching the local origin, as in the
integration-test fixture. Do not change production origin/security checks for preview.

## Motion comparison

The approved original motion is saved in commit `45eadef`. Its scale easing,
360/280 ms anticipation, 420 ms release, spring constants and random cue rhythm
are preserved. Instinct's tile now matches the o's .54em ink height in both modes.

The second mode ports the exact four-segment `circ.inOut.soft` path, .75-second
tweens, half-duration entrance swap, 1.7 active wrapper scale and .9 rebound from
[`materic-inc/shop-minis` at `1417626`](https://github.com/materic-inc/shop-minis/tree/1417626161dc5e48b5ab391385353f13f0bff927).
The sources are `standalone/src/gsap-setup.ts`,
`app/components/minis/minis-loop.tsx`, and `app/components/minis/index.tsx`.
`web/minis-motion.ts` evaluates the original curve directly without adding GSAP.

The footer's cadence and visibility delays are adapted to four slots and the
ioio rules: one or two distinct characters, never adjacent, with letters always
present. Character artwork is normalized against the 1.7 wrapper scale so its
fully shown height stays equal to the o. Minis widths follow the source's
eased width-times-wrapper-scale positioning; Original retains its springs.
The comparison selector is injected only by the local preview server.

**OG v2** applies only that custom curve, 750 ms total exchange time, visibility
delays and cue cadence to Original's shrink/swap motion. The 1 → .32 → 1 scale
range, 14% slot compression, optical spacing, and 520/38 position springs stay
the same. It eases each side of the artwork swap separately, dividing the 750 ms
at the source's visibility delay. It does not use the Minis 1.7 wrapper expansion,
.9 rebound, or width-times-wrapper-scale positioning.

## Implementation

- `web/characters.ts`: procedural fur, curved-volume shading, independent eyes,
  glasses, beret, bow tie, Jollybot face and shoulder/wrist animation. In-memory
  canvases cache generated fibres. Fur is clipped to each antialiased silhouette
  for clean outer contours while retaining the interior texture; no source media
  is loaded by the landing page.
- `web/vendor/bloub`: pinned MIT Grok geometry/animation engine; upstream license
  and measurement notes included. Only idle and wink are selected by ioio.
- `web/landing.ts`: varied phrases that always mix one or two characters with letters between them,
  with no duplicate characters visible together (the two different Dots are allowed),
  one shared animation clock and spring positions.
  Each exchange anticipates for 360 ms (280 ms on exit), compressing with a
  quartic acceleration before a discrete artwork swap and a 420 ms spring-like
  release. Character gaze and gestures continue throughout their dwell.
- `bin/build-landing.mjs`: bundles the browser code into the committed generated
  TypeScript string, retaining the full bloub license. It stays in the existing
  nonce-authorized script; CSP and authentication are unchanged.

The button has a fixed stage width. `web/optical-spacing.ts` measures the loaded
Inter glyph contours and each character silhouette, then corrects each pairing
for its visible whitespace. Spacing starts at .085em, with half the contour-area
correction to bring curved letters closer without crowding them. Slot widths
retain the original 14% anticipation compression and 520/38 position spring;
pair-spacing adjustments use that same spring. Settled visible edges stay centered.
Positions move using transforms; layout width is never animated. Grok, Muse and
both Dots have transparent backgrounds; their measured bodies match the o's
.54em ink height. Only Instinct retains its .54em rounded tile and original
internal path scaled to 88%. The typeface is unchanged. The tagline is
“Your agents and your friends’ agents, connected.”

The logo is passive: clicks and keyboard input do not pause it.
Hidden documents cancel animation frames and resume without a time jump.
Reduced motion shows static letters with one Grok character and skips fur
generation at first load. A JavaScript or Canvas failure leaves the
ordinary typography visible. Measurements use em units and are cached by typeface;
resizing updates the display size without reading transformed letter bounds.

## Review evidence

See [RESEARCH.md](RESEARCH.md) for references, licenses and fidelity limitations.
The captures are actual browser playback, not an animation generated by a video
model. The newest full-page recording is `captures/desktop-latest.mp4` (40 seconds).
Earlier desktop and responsive mobile recordings are also in `captures/`.

The procedural furry reconstructions are not pixel-identical to the source 3D
artwork. They preserve the character identities and identifying visual features;
original fur grooms, full meshes and animation curves were not available.
