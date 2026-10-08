# IO–1 rope switcher

React reconstruction of George Kedenburg III's July 2022 `te-ios.origami` prototype. The demo displays the interactive panel alone, centered on a neutral background.

Run `npm install` and `npm run dev`, then open http://localhost:4197. `npm run build` checks TypeScript and builds the demo.

`src/RopeSwitcher.tsx` exports the reusable component. It accepts `defaultConnection`, `onChange`, `className`, and `assetsPath`. Source indices are all audio (0) and this app (1); output indices are iPhone speaker (0), AirPods (1), and kitchen (2). Drag either plug, or focus it and use the arrow keys. Calls and other devices are decorative sockets in the original and are preserved that way. This is an interaction prototype; it does not change system audio routing.

The original download is preserved at `reference/te-ios.origami`. Panel, plug, and LED artwork comes directly from that document. Cable geometry, spring parameters, drag limits, snap thresholds, and destination colors were extracted from its patch graph. `src/physics.ts` ports the cable curve and Facebook Pop spring conversion; the upstream Pop license is included at `reference/POP-LICENSE`. Reduced motion disables oscillation and cycling effects.

Original creator: https://twitter.com/GK3/status/1545071311029805057

Original file: https://www.dropbox.com/scl/fi/blolpkb7zoip60b3ao4r2/te-ios.origami?rlkey=9o1ehw79glo3dsox7g0sqxp7c&dl=1

Original artwork retains its creators' rights.
