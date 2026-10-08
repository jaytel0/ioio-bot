/*! Grok's measured animation engine: Copyright (c) 2026 Jérémy Perret, MIT. See web/vendor/bloub/LICENSE. Other character rendering is an independent reference-based recreation. */
import { CharacterRenderer, prepareCharacters, type Character } from './characters';
import { measureLogoSpacing, logoPositions, type LogoShape, type LogoSpacing } from './optical-spacing';
import { minisEase, ogV2Motion, motionVersion, MINIS_DURATION, MINIS_ACTIVE_SCALE, MINIS_REBOUND_SCALE, MINIS_ENTRY_DELAY, MINIS_INTERVALS, MINIS_EXITS, type MotionVersion, type MinisExit } from './minis-motion';

type Cue = [time: number, slot: number, character: Character | null, exit?: MinisExit];
const clamp = (x: number) => Math.max(0, Math.min(1, x));
const between = (a: number, b: number) => a + Math.random() * (b - a);
function shuffle<T>(items: T[]): T[] {
 const result = [...items];
 for (let i = result.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [result[i], result[j]] = [result[j], result[i]];
 }
 return result;
}
// Every exchange keeps one or two characters visible, separated by letters.
// Fresh slots, dwell lengths and artwork order vary the rhythm of each phrase.
function phrase(current: (Character | null)[], version: MotionVersion = 'original') {
 const cues: Cue[] = [];
 const cast = shuffle<Character>(['grok', 'alfred', 'felipe', 'muse', 'instinct']);
 const appearances = [...current];
 const visible = new Set(current.flatMap((kind, index) => kind ? [index] : []));
 let time = version !== 'original' ? 0 : between(1.5, 2.2), used = 0, exits = 0;
 for (let exchange = 0; exchange < 12; exchange++) {
  const entering = visible.size === 1;
  const candidates = [0, 1, 2, 3].filter(index => entering
   ? !visible.has(index) && !visible.has(index - 1) && !visible.has(index + 1)
   : visible.has(index));
  const index = shuffle(candidates)[0];
  let kind: Character | null = null;
  if (entering) {
   do { kind = cast[used++ % cast.length]; } while (appearances.includes(kind));
  }
  const exit = !entering && version !== 'original' ? MINIS_EXITS[exits++ % MINIS_EXITS.length] : undefined;
  cues.push([time, index, kind, exit]);
  appearances[index] = kind;
  if (entering) visible.add(index); else visible.delete(index);
  time += version !== 'original' ? MINIS_INTERVALS[exchange % MINIS_INTERVALS.length] : exchange % 3 === 2 ? between(1.65, 2.65) : between(.9, 1.6);
 }
 return { cues, duration: time + .7 };
}
const brand = document.querySelector<HTMLElement>('.brand-play');
if (brand) start(brand);
function start(brand: HTMLElement) {
 const reduced = matchMedia('(prefers-reduced-motion: reduce)');
 const slots = [...brand.querySelectorAll<HTMLElement>('.brand-slot')];
 const letters = slots.map(s => s.querySelector<HTMLElement>('.brand-letter')!);
 const canvases = slots.map(s => s.querySelector<HTMLCanvasElement>('canvas')!);
 if (canvases.some(c => !c.getContext('2d'))) return;
 const renderers = canvases.map(c => new CharacterRenderer(c));
 const initialSlot = Math.floor(Math.random() * slots.length);
 let version: MotionVersion = motionVersion(new URLSearchParams(location.search).get('motion'));
 const states = slots.map((_, i) => ({
  advance: 0, velocity: 0, shown: i === initialSlot, next: null as Character | null,
  kind: 'grok' as Character, since: 0, cue: -100, anticipation: .36, switched: true,
  baseWidth: 0, widthFrom: 0, widthTo: 0, wrapperScale: i === initialSlot ? MINIS_ACTIVE_SCALE : 1,
  scaleFrom: 1, scaleTo: i === initialSlot ? MINIS_ACTIVE_SCALE : 1, bounce: false,
 }));
 let prepared = false, ready = false, raf = 0, last = 0;
 const currentCast = () => states.map(s => s.shown ? s.kind : null);
 let clock = 0, beat = 0, phraseStart = 0, score = phrase(currentCast(), version), size = 180;
 let spacing: LogoSpacing;
 const gaps = slots.slice(1).map(() => ({ advance: 0, velocity: 0 }));
 const canRun = () => ready && !reduced.matches && !document.hidden;
 function measure(snap = !ready) {
  const style = getComputedStyle(brand);
  size = parseFloat(style.fontSize);
  spacing = measureLogoSpacing(style, prepared);
  renderers.forEach(r => r.resize(size * .72));
  layout(0, snap);
 }
 function layout(dt: number, snap = !ready) {
  const scales: number[] = [];
  const steps = Math.max(1, Math.ceil(dt / .008)), h = dt / steps;
  states.forEach((s, i) => {
   const elapsed = clock - s.cue;
   let squeeze = 0, scale = 1;
   if (!s.switched && elapsed >= s.anticipation) {
    s.shown = s.next !== null;
    if (s.next) { s.kind = s.next; s.since = s.cue + s.anticipation; }
    s.switched = true;
   }
   if (version === 'minis' && !reduced.matches) {
    const progress = minisEase(elapsed / MINIS_DURATION);
    if (snap) {
     const kind: LogoShape = s.shown ? s.kind : letters[i].textContent as 'i' | 'o';
     const edges = spacing.edges[kind];
     s.wrapperScale = s.shown ? MINIS_ACTIVE_SCALE : 1;
     s.baseWidth = (edges.right - edges.left) / s.wrapperScale;
     s.widthFrom = s.widthTo = s.baseWidth;
     s.scaleFrom = s.scaleTo = s.wrapperScale;
    } else {
     s.baseWidth = s.widthFrom + (s.widthTo - s.widthFrom) * progress;
     s.wrapperScale = s.scaleFrom + (s.scaleTo - s.scaleFrom) * progress;
     if (s.bounce && elapsed > MINIS_DURATION) {
      s.wrapperScale = MINIS_REBOUND_SCALE + (1 - MINIS_REBOUND_SCALE) * minisEase((elapsed - MINIS_DURATION) / MINIS_DURATION);
     }
    }
    // Normalize the reference's active 1.7x wrapper so a fully shown character
    // still matches the o, including Instinct's tile.
    scale = s.wrapperScale / (s.shown ? MINIS_ACTIVE_SCALE : 1);
    s.advance = s.baseWidth * s.wrapperScale;
    s.velocity = 0;
    scales.push(scale);
    return;
   }
   if (version === 'og-v2' && !reduced.matches) {
    ({ squeeze, scale } = ogV2Motion(elapsed, s.anticipation, s.switched));
   } else if (!s.switched) {
    const p = clamp(elapsed / s.anticipation);
    // Slow initial compression; most collapse happens in the final third.
    squeeze = .12 * p + .88 * p ** 4;
    scale = 1 - .68 * squeeze;
   } else {
    const p = clamp((elapsed - s.anticipation) / .42);
    // A discrete swap at 32% scale, then a fast, lightly overshooting release.
    const release = p === 1 ? 1 : 1 - Math.exp(-8 * p) * (Math.cos(10 * p) + .8 * Math.sin(10 * p));
    scale = .32 + .68 * release;
   }
   const kind: LogoShape = s.shown ? s.kind : letters[i].textContent as 'i' | 'o';
   const edges = spacing.edges[kind];
   const target = (edges.right - edges.left) * (1 - .14 * squeeze);
   if (snap) { s.advance = target; s.velocity = 0; }
   for (let step = 0; step < steps; step++) {
    s.velocity += (520 * (target - s.advance) - 38 * s.velocity) * h;
    s.advance += s.velocity * h;
   }
   if (Math.abs(s.advance - target) < .0001 && Math.abs(s.velocity) < .001) { s.advance = target; s.velocity = 0; }
   scales.push(scale);
  });
  const kinds = states.map((s, i): LogoShape => s.shown ? s.kind : letters[i].textContent as 'i' | 'o');
  gaps.forEach((g, i) => {
   const target = .085 + spacing.corrections[kinds[i]][kinds[i + 1]];
   if (snap || version === 'minis') { g.advance = target; g.velocity = 0; }
   for (let step = 0; step < steps; step++) {
    g.velocity += (520 * (target - g.advance) - 38 * g.velocity) * h;
    g.advance += g.velocity * h;
   }
   if (Math.abs(g.advance - target) < .0001 && Math.abs(g.velocity) < .001) { g.advance = target; g.velocity = 0; }
  });
  const positions = logoPositions(spacing, kinds, states.map(s => s.advance), gaps.map(g => g.advance));
  states.forEach((s, i) => {
   slots[i].style.transform = `translate3d(${(positions[i] * size).toFixed(3)}px,0,0)`;
   // Never dissolve a letter into an image: exchange the visible artwork at the snap.
   letters[i].style.opacity = s.shown ? '0' : '1';
   canvases[i].style.opacity = s.shown ? '1' : '0';
   const transform = `translate(-50%,-50%) scale(${scales[i]})`;
   letters[i].style.transform = transform;
   canvases[i].style.transform = transform;
   if (s.shown) renderers[i].draw(s.kind, Math.max(0, clock - s.since));
   slots[i].dataset.character = s.shown ? s.kind : '';
  });
 }
 function frame(now: number) {
  raf = 0;
  if (!canRun()) return;
  const dt = last ? Math.min((now - last) / 1000, .05) : 0;
  last = now; clock += dt;
  const local = clock - phraseStart;
  while (beat < score.cues.length && local >= score.cues[beat][0]) {
   const [time, index, kind, exit] = score.cues[beat++], s = states[index];
   s.next = kind; s.cue = phraseStart + time; s.switched = false;
   if (version === 'minis') {
    s.anticipation = kind ? MINIS_ENTRY_DELAY : exit!.delay;
    s.widthFrom = s.baseWidth;
    const targetKind: LogoShape = kind ?? letters[index].textContent as 'i' | 'o';
    const edges = spacing.edges[targetKind];
    s.widthTo = (edges.right - edges.left) / (kind ? MINIS_ACTIVE_SCALE : 1);
    s.scaleFrom = s.wrapperScale;
    s.scaleTo = kind ? MINIS_ACTIVE_SCALE : exit!.bounce ? MINIS_REBOUND_SCALE : 1;
    s.bounce = !kind && exit!.bounce;
   } else if (version === 'og-v2') s.anticipation = kind ? MINIS_ENTRY_DELAY : exit!.delay;
   else s.anticipation = kind ? .36 : .28;
  }
  if (local >= score.duration) { phraseStart = clock; beat = 0; score = phrase(currentCast(), version); }
  if (states.some(s => s.shown || clock - s.cue < 1.4)) layout(dt);
  raf = requestAnimationFrame(frame);
 }
 function update() {
  cancelAnimationFrame(raf); raf = 0; last = 0;
  if (reduced.matches) {
   clock = 0; phraseStart = 0; beat = 0;
   states.forEach((s, i) => { s.shown = i === initialSlot; s.kind = 'grok'; s.since = 0; s.velocity = 0; s.next = null; s.cue = -100; s.switched = true; });
   score = phrase(currentCast(), version);
   layout(0, true);
  } else if (canRun()) raf = requestAnimationFrame(frame);
 }
 window.addEventListener('ioio:motion-change', event => {
  const selected = (event as CustomEvent<MotionVersion>).detail;
  if ((selected !== 'original' && selected !== 'og-v2' && selected !== 'minis') || selected === version) return;
  version = selected; clock = 0; phraseStart = 0; beat = 0;
  states.forEach((s, i) => { s.shown = i === initialSlot; s.kind = 'grok'; s.since = 0; s.velocity = 0; s.next = null; s.cue = -100; s.switched = true; s.bounce = false; });
  score = phrase(currentCast(), version);
  if (!ready) return;
  layout(0, true); update();
 });
 document.addEventListener('visibilitychange', update);
 reduced.addEventListener('change', () => { if (!reduced.matches) { if (!prepared) prepare(); measure(true); } update(); });
 new ResizeObserver(() => { if (ready) measure(); }).observe(brand);
 function prepare() { if (prepared) return; prepareCharacters(); prepared = true; }
 document.fonts.ready.then(() => {
  if (!reduced.matches) prepare();
  measure(); brand.classList.add('is-ready'); ready = true; layout(0); update();
 }).catch(() => {/* A readable, static ioio remains if font preparation fails. */});
}
