// Ported from materic-inc/shop-minis: standalone/src/gsap-setup.ts and
// app/components/minis/minis-loop.tsx. No GSAP runtime is needed here.
export type MotionVersion = 'original' | 'og-v2' | 'minis';
export function motionVersion(value: string | null): MotionVersion {
 return value === 'minis' || value === 'og-v2' ? value : 'original';
}
export const MINIS_DURATION = .75;
export const MINIS_ACTIVE_SCALE = 1.7;
export const MINIS_REBOUND_SCALE = .9;
export const MINIS_ENTRY_DELAY = MINIS_DURATION * .5;
export const MINIS_INTERVALS = [1.25, 2.4, 1, 2, 1, 2.1].map(x => x * MINIS_DURATION);
export const MINIS_EXITS = [
 { bounce: true, delay: MINIS_DURATION * .25 },
 { bounce: false, delay: MINIS_DURATION * .5 },
 { bounce: true, delay: MINIS_DURATION * .4 },
 { bounce: false, delay: MINIS_DURATION * .5 },
 { bounce: false, delay: MINIS_DURATION * .5 },
] as const;
export type MinisExit = { bounce: boolean; delay: number };

// The reference's exact four-segment circ.inOut.soft path, evaluated by x.
const segments = [
 [0, 0, .17, 0, .286, .085, .32, .115],
 [.32, .115, .394, .18, .478, .301, .5, .5],
 [.5, .5, .522, .706, .608, .816, .645, .852],
 [.645, .852, .67, .877, .794, 1, 1, 1],
];
const cubic = (a: number, b: number, c: number, d: number, t: number) => {
 const u = 1 - t;
 return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
};
export function minisEase(progress: number): number {
 if (progress <= 0) return 0;
 if (progress >= 1) return 1;
 const s = segments.find(segment => progress <= segment[6])!;
 let low = 0, high = 1;
 for (let i = 0; i < 20; i++) {
  const t = (low + high) / 2;
  if (cubic(s[0], s[2], s[4], s[6], t) < progress) low = t; else high = t;
 }
 return cubic(s[1], s[3], s[5], s[7], (low + high) / 2);
}

// Original's 1 → .32 → 1 shrink/snap, retimed to the Minis 750ms clock.
// Only the phase easing/timing changes; there is no 1.7x expansion or .9 rebound.
export function ogV2Motion(elapsed: number, swapAt: number, switched: boolean) {
 if (!switched) {
  const squeeze = minisEase(elapsed / swapAt);
  return { squeeze, scale: 1 - .68 * squeeze };
 }
 return { squeeze: 0, scale: .32 + .68 * minisEase((elapsed - swapAt) / (MINIS_DURATION - swapAt)) };
}
