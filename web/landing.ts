/*! Grok's measured animation engine: Copyright (c) 2026 Jérémy Perret, MIT. See web/vendor/bloub/LICENSE. Other character rendering is an independent reference-based recreation. */
import { CharacterRenderer, prepareCharacters, type Character } from './characters';

type Cue = [time: number, slot: number, character: Character | null];
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
// Phrase grammar keeps the ensemble coherent, while fresh slots, dwell lengths,
// stagger intervals and exit order make each phrase different. Every phrase
// includes all five artworks and returns to readable typography between bursts.
function phrase() {
 const cues: Cue[] = [];
 const cast = shuffle<Character>(['grok', 'alfred', 'felipe', 'muse', 'instinct']);
 let time = between(1.5, 2.2), used = 0;
 for (const count of [2, 3, Math.random() < .5 ? 2 : 4]) {
  const indices = shuffle([0, 1, 2, 3]).slice(0, count);
  let entry = time;
  for (const index of indices) {
   cues.push([entry, index, cast[used++ % cast.length]]);
   entry += between(.16, .39);
  }
  let exit = entry + between(1.65, 2.65);
  for (const index of shuffle(indices)) {
   cues.push([exit, index, null]);
   exit += between(.12, .3);
  }
  time = exit + between(1.45, 2.25);
 }
 return { cues: cues.sort((a, b) => a[0] - b[0]), duration: time + .7 };
}
const brand = document.querySelector<HTMLButtonElement>('.brand-play');
if (brand) start(brand);
function start(brand: HTMLButtonElement) {
 const reduced = matchMedia('(prefers-reduced-motion: reduce)');
 const slots = [...brand.querySelectorAll<HTMLElement>('.brand-slot')];
 const letters = slots.map(s => s.querySelector<HTMLElement>('.brand-letter')!);
 const canvases = slots.map(s => s.querySelector<HTMLCanvasElement>('canvas')!);
 if (canvases.some(c => !c.getContext('2d'))) return;
 const renderers = canvases.map(c => new CharacterRenderer(c));
 const states = slots.map(() => ({
  advance: 0, velocity: 0, shown: false, next: null as Character | null,
  kind: 'grok' as Character, since: 0, cue: -100, anticipation: .36, switched: true,
 }));
 let prepared = false, ready = false, paused = false, raf = 0, last = 0;
 let clock = 0, beat = 0, phraseStart = 0, score = phrase(), size = 180;
 let widths = [.21, .54, .21, .54];
 const canRun = () => ready && !paused && !reduced.matches && !document.hidden;
 function measure() {
  size = parseFloat(getComputedStyle(brand).fontSize);
  const previousWidths = widths;
  widths = letters.map(letter => parseFloat(getComputedStyle(letter).width) / size);
  states.forEach((s, i) => {
   if (!ready) s.advance = widths[i];
   else if (!s.shown) s.advance += widths[i] - previousWidths[i];
  });
  renderers.forEach(r => r.resize(size * .6));
  layout(0);
 }
 function layout(dt: number) {
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
   if (!s.switched) {
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
   const target = (s.shown ? .665 : widths[i]) * (1 - .14 * squeeze);
   for (let step = 0; step < steps; step++) {
    s.velocity += (520 * (target - s.advance) - 38 * s.velocity) * h;
    s.advance += s.velocity * h;
   }
   if (Math.abs(s.advance - target) < .0001 && Math.abs(s.velocity) < .001) {
    s.advance = target; s.velocity = 0;
   }
   scales.push(scale);
  });
  const total = states.reduce((sum, s) => sum + s.advance, 0);
  let x = -total / 2;
  states.forEach((s, i) => {
   slots[i].style.transform = `translate3d(${((x + s.advance / 2) * size).toFixed(3)}px,0,0)`;
   // Never dissolve a letter into an image: exchange the visible artwork at the snap.
   letters[i].style.opacity = s.shown ? '0' : '1';
   canvases[i].style.opacity = s.shown ? '1' : '0';
   const transform = `translate(-50%,-50%) scale(${scales[i]})`;
   letters[i].style.transform = transform;
   canvases[i].style.transform = transform;
   if (s.shown) renderers[i].draw(s.kind, Math.max(0, clock - s.since));
   slots[i].dataset.character = s.shown ? s.kind : '';
   x += s.advance;
  });
 }
 function frame(now: number) {
  raf = 0;
  if (!canRun()) return;
  const dt = last ? Math.min((now - last) / 1000, .05) : 0;
  last = now; clock += dt;
  const local = clock - phraseStart;
  while (beat < score.cues.length && local >= score.cues[beat][0]) {
   const [time, index, kind] = score.cues[beat++], s = states[index];
   s.next = kind; s.cue = phraseStart + time; s.switched = false;
   s.anticipation = kind ? .36 : .28;
  }
  if (local >= score.duration) { phraseStart = clock; beat = 0; score = phrase(); }
  if (states.some(s => s.shown || clock - s.cue < 1.4)) layout(dt);
  raf = requestAnimationFrame(frame);
 }
 function update() {
  cancelAnimationFrame(raf); raf = 0; last = 0;
  brand.setAttribute('aria-pressed', String(paused));
  brand.setAttribute('aria-label', reduced.matches ? 'ioio' : paused ? 'Play logo animation' : 'Pause logo animation');
  brand.disabled = reduced.matches;
  if (reduced.matches) {
   clock = 0; phraseStart = 0; beat = 0; score = phrase();
   states.forEach((s, i) => { s.advance = widths[i]; s.velocity = 0; s.shown = false; s.next = null; s.cue = -100; s.switched = true; });
   layout(0);
  } else if (canRun()) raf = requestAnimationFrame(frame);
 }
 brand.addEventListener('click', () => { paused = !paused; update(); });
 document.addEventListener('visibilitychange', update);
 reduced.addEventListener('change', () => { if (!reduced.matches && !prepared) prepare(); update(); });
 new ResizeObserver(() => { if (ready) measure(); }).observe(brand);
 function prepare() { if (prepared) return; prepareCharacters(); prepared = true; }
 document.fonts.ready.then(() => {
  if (!reduced.matches) prepare();
  measure(); brand.classList.add('is-ready'); ready = true; layout(0); update();
 }).catch(() => {/* A readable, static ioio remains if font preparation fails. */});
}
