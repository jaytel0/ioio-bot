# Validation — Mac Mini, 8 October 2026

Machine: Apple M4 Pro Mac Mini, macOS 26.2. Browser: local Chrome.
Mobile checks use Chrome's responsive device emulation on this machine; they are
not a physical iPhone performance benchmark.

| Full loop | Samples | All 5 artworks | Word frames | Clipping / overflow | Layout shift | p95 frame interval | Max center step per frame |
| --- | ---: | --- | ---: | --- | ---: | ---: | ---: |
| 1200 × 863 | 1069 | yes | 476 | none | 0 | 17.4 ms | 6.11 px |
| 390 × 844 | 1073 | yes | 477 | none | 0 | 17.2 ms | 3.25 px |
| 320 × 844 | 1071 | yes | 475 | none | 0 | 17.1 ms | 3.35 px |
| 390 × 844, reduced motion | 1079 | no animation | 1079 | none | 0 | — | 0 px |

These are 18-second samples from the actual render loop and DOM geometry via the
local-only `/verify` fixture. They include entry/exit transitions, long word
holds and the complete character sequence. Width changes are transform motion
inside a fixed stage, hence no document reflow or measured layout shift.

- `npm run check`: browser TypeScript, Worker TypeScript and deterministic bundle pass.
- `npm test`: all 44 existing tests pass, including messaging, durable identity,
  OAuth, enrollment, owner-session/CSRF, backup and landing security checks.
- `wrangler deploy --dry-run`: passes; packaged Worker is 2024.61 KiB
  (709.19 KiB gzip). Obsolete hero raster imports are no longer bundled.
- Keyboard: Space changes the button to “Play logo animation” with pressed=true;
  Enter resumes. DOM transforms remain identical across paused observations.
- Actual playback: reviewed desktop screen recording and frame contact sheet;
  gallery reviewed at enlarged size against reference images. Fixed vertical
  alignment, fur lighting/scanline bands, and resized letter-width measurement.
- Reduced motion: Chrome DevTools media emulation enabled before reload. All
  1079 frames remained typography, no characters appeared, maximum movement was
  zero, and the button was disabled and labelled “ioio”. Normal motion resumed
  when the media emulation was removed.
- Hidden-tab suspension: reviewed the `visibilitychange` handler and shared
  clock reset. Browser automation did not provide a reliable hidden-document
  observation, so this behavior is not claimed as experimentally verified.

Saved playback: `captures/desktop.mp4`, `captures/mobile-320.mp4`, and
`captures/characters.webm`. The mobile recording shows Chrome's 320 × 844
responsive viewport scaled to fit the desktop. These are local browser captures;
they are not production deployment evidence.

Deployment: the Mac Mini's Infisical CLI reported “No valid login session found”.
The prod `/btb` secret scope could not be loaded. `wrangler whoami` also reported
that this machine is not authenticated to Cloudflare. No secrets were printed or saved,
and no production deployment has been claimed.

## Accelerating snap revision

Replaced the fixed score and crossfade with varied phrases and discrete swaps.
The outgoing artwork compresses for 360 ms on entry / 280 ms on exit, using
`0.12t + 0.88t⁴`; the replacement pops from 32% scale with a damped release.
Adjacent centers follow springs. Each phrase covers all five artworks and uses
fresh slot order, bounded dwell/stagger timing and typography rests.

Fresh 18-second checks after this revision:

| Viewport | Samples | Artworks | Clipping / overflow | Layout shift | p95 frame interval | Max center step |
| --- | ---: | --- | --- | ---: | ---: | ---: |
| 1200 × 863 | 1066 | all 5 | none | 0 | 17.4 ms | 12.57 px |
| 320 × 844 | 1074 | all 5 | none | 0 | 17.4 ms | 4.04 px |

`npm run check` and all 44 existing tests pass. Reviewed a 40-second native screen
recording and a 12 fps close-up contact sheet for the compression/swap. The latest
recording is `captures/desktop-latest.mp4`; its still is `desktop-latest.png`.
The earlier captures and reduced-motion results above refer to the first revision.
Production deployment remains blocked by the previously reported authentication.
