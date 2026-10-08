export type Point = { x: number; y: number };
export type Dynamics = { tension: number; friction: number };

/** The original Pop Animation patch's bounciness/speed conversion.
 * Equations: facebookarchive/pop, POPAnimationExtras.mm and POPMath.mm.
 * See reference/POP-LICENSE for the upstream license.
 */
export function origamiSpring(bounciness: number, speed: number): Dynamics {
  const b = (bounciness / 34) * 0.8;
  const t = 0.5 + (speed / 34) * 199.5;
  const noBounce = t <= 18
    ? 0.0007 * t ** 3 - 0.031 * t ** 2 + 0.64 * t + 1.28
    : t <= 44
      ? 0.000044 * t ** 3 - 0.006 * t ** 2 + 0.36 * t + 2
      : 0.00000045 * t ** 3 - 0.000332 * t ** 2 + 0.1078 * t + 5.84;
  const mix = 2 * b - b * b;
  return {
    tension: (t - 30) * 3.62 + 194,
    friction: ((1 - mix) * noBounce + mix * 0.01 - 8) * 3 + 25,
  };
}

export const PLUG_SPRING = origamiSpring(3, 30);
export const CABLE_SPRING = origamiSpring(10, 5);
export const COLOR_SPRING = origamiSpring(5, 10);

export class Spring {
  value: number;
  velocity = 0;
  target: number;

  constructor(value: number, readonly dynamics = PLUG_SPRING) {
    this.value = value;
    this.target = value;
  }

  jump(value: number) {
    this.value = this.target = value;
    this.velocity = 0;
  }

  /** Analytic damped spring, independent of screen refresh rate. */
  get settled() { return this.value === this.target && this.velocity === 0; }

  step(dt: number, reducedMotion = false) {
    if (this.settled) return;
    if (reducedMotion) { this.jump(this.target); return; }
    const { tension, friction } = this.dynamics;
    const alpha = friction / 2;
    const omega = Math.sqrt(Math.max(0.000001, tension - alpha * alpha));
    const displacement = this.value - this.target;
    const a = displacement;
    const b = (this.velocity + alpha * displacement) / omega;
    const decay = Math.exp(-alpha * dt);
    const sin = Math.sin(omega * dt);
    const cos = Math.cos(omega * dt);
    this.value = this.target + decay * (a * cos + b * sin);
    this.velocity = decay * ((b * omega - alpha * a) * cos - (a * omega + alpha * b) * sin);
    if (Math.abs(this.value - this.target) < 0.0001 && Math.abs(this.velocity) < 0.001) {
      this.jump(this.target);
    }
  }
}

export const SOURCES = [
  { name: 'all audio', x: 142, y: 102 },
  { name: 'this app', x: 142, y: 143 },
] as const;

export const OUTPUTS = [
  { name: 'iPhone speaker', x: 348, y: 102 },
  { name: 'george’s AirPods', x: 348, y: 143 },
  { name: 'kitchen', x: 348, y: 184 },
] as const;

// Preserve the original threshold-based snapping, including its asymmetry.
export function destination(side: 'source' | 'output', y: number) {
  return side === 'source' ? Number(y > 135) : Number(y > 135) + Number(y > 185);
}

export function cableMidpoint(a: Point, b: Point): Point {
  const remaining = Math.max(0, Math.min(280, 280 - Math.hypot(b.x - a.x, b.y - a.y)));
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + (remaining + 10) / 2 };
}

/** Luke Haddock's Curve Shape patch: three points, curve amount 0.8.
 * Endpoint handles are zero; the middle handles are ±0.8 × half the chord.
 */
export function cablePath(a: Point, b: Point, middle: Point): string {
  const dx = (b.x - a.x) * 0.4;
  const dy = (b.y - a.y) * 0.4;
  return `M ${a.x} ${a.y} C ${a.x} ${a.y} ${middle.x - dx} ${middle.y - dy} ${middle.x} ${middle.y} C ${middle.x + dx} ${middle.y + dy} ${b.x} ${b.y} ${b.x} ${b.y}`;
}
