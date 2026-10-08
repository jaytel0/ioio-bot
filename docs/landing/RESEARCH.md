# ioio character research — 8 October 2026

The brief is four agent products: OpenAI Dots (Alfred and Felipe), xAI Grok Bot,
Meta Muse (Jollybot), and Instinct. “Rockbot” is interpreted as Grok Bot: the black
round face in the approved artwork matches Grok and the measured bloub recreation.
It is unrelated to the Rockbot music company.

## Visual references

- Approved board: https://www.figma.com/design/yrkfdRbYchnEQZoANJfNsy/materic-mark?node-id=6-8
  The board requires a Figma login on this Mac Mini. The committed exports in
  `src/assets/landing/` were the available design evidence. Alfred and Felipe's
  original embedded PNGs were extracted losslessly into `references/` for study.
- OpenAI launch: https://openai.com/index/introducing-dots/
  Also checked https://openai.com/es-ES/index/introducing-dots/?video=1231177365.
  The article was accessible; the Vimeo configuration was not retrievable here.
  Motion for these two characters is an independent idle loop, not an extracted
  original animation. The supplied Figma screenshots establish their appearance.
- Muse's official landing page: https://muse.ai/
- Official Jollybot close-up: https://muse.ai/images/landing/brand/hatch.jpg
- Official animated wave: https://muse.ai/videos/avatars/hatch_connecting.mp4
- Official working loop: https://muse.ai/videos/avatars/hatch_working.mp4
- Official launch and videos: https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/
- Product design explanation: https://introducing.muse.ai/
  The public Muse landing page uses MP4 avatar loops. This is evidence against
  assuming its furry mascot is originally rendered live in browser code.
- Official Muse gadget SDK: https://github.com/facebookincubator/muse-gadget-sdk
  Inspected at `86cf33fb4092ba700b4dc33928966d1bcb31556d`. Its
  `esp32/avatar/muse_pixel.c` is a procedural **pixel-art** avatar; `jollybot.gif`
  and `AVATAR_RECIPE.md` confirm the character. That style is different from the
  furry landing-page mascot. No SDK code or GIF is used in the ioio renderer.
- Grok source recreation: https://github.com/jeremy-prt/bloub
  Inspected and vendored at `b4bb3c1b5f93c7b87a2e8d620f667c4093d97749`.
  Its README, measurements, state board and animation engine describe a black
  circle, tangent-projected white eyes, gaze drift, and blinks. The eye orientation
  and near/far width asymmetry are measurements, not arbitrary design choices.
- Existing approved Instinct path: `src/assets/landing/instinct.svg`.
  Its geometry is preserved and scaled to 88% about its center on the same warm tile.

## Public recreation search

Searched web and GitHub for Grok bot avatars, OpenAI Dots avatars/mascots,
Alfred/Felipe animation, Muse mascot recreation, and Jollybot.

- https://github.com/jeremy-prt/bloub — selected: framework-free measured engine,
  MIT license. The Vue editor and export dependencies are not included.
- https://github.com/Eyadkelleh/Grok_bot — independent bloub-parity studio,
  inspected as a secondary lead; not used.
- https://github.com/zichenzhang04/even-grokbot-avatars — line-based glasses
  rendition; not the requested filled black face. Not used.
- https://github.com/keyframesfound/jollybot — pixel-art desk assistant based on
  Meta's SDK. Does not recreate the furry character. Not used. Its attribution
  describes the avatar as Apache-2.0, but Meta's upstream explicitly excludes the
  avatar from that license; upstream's exclusion is the authority.
- No suitable public, licensed furry Alfred/Felipe/Jollybot renderer was found
  in these searches. This is a bounded search result, not a claim none exists.

## Rendering and fidelity

`web/characters.ts` builds all furry layers from paths and seeded individual
fibres, using curved-surface lighting and gloss highlights. Those layers are
cached in in-memory canvases, then independently animated: eye gaze and blinking,
head/face pivots, the beret, breathing deformation, and Jollybot's shoulder/wrist.
There are no image or video loads in the character renderer. Grok samples the
vendored pure animation engine and paints its SVG paths into Canvas.

The shapes, colors, accessories and identifying facial features follow the
references. Remaining differences from the original rendered footage:

- Fur is a procedural 2.5D reconstruction, not the original groom or 3D mesh.
  It does not reproduce every strand, physically based scattering, or changing
  self-shadow. It is visibly less dimensional in an enlarged study view.
- Alfred and Felipe are based on single-view supplied screenshots; their loops
  are designed idle gestures. Exact original animation curves were unavailable.
- Jollybot's wave follows the official gesture, with simplified paw geometry and
  face/body articulation. It is not frame-for-frame identical to the video.
- Grok uses measured source geometry but only the idle/wink behavior in this
  composition. Instinct is intentionally the approved stationary mark.

## Licenses

- Original ioio implementation: repository MIT license.
- Vendored bloub code: MIT, Copyright (c) 2026 Jérémy Perret. Full notice in
  `web/vendor/bloub/LICENSE`; upstream measurements included alongside it.
  That license covers the implementation, not xAI's character design.
- OpenAI, Meta, xAI and Instinct character/brand designs retain their owners'
  rights. The user explicitly authorized these reference-based recreations.
  No open artwork license is asserted for the Figma exports or official media.
  Research reference images are attributed here and are not served by the Worker.
- Muse gadget SDK code is Apache-2.0, but its Jollybot avatar is explicitly
  excluded. No claim of an Apache artwork license is made.
