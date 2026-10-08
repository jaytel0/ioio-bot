import { CharacterRenderer, type Character } from './characters';
export type LogoShape = 'i' | 'o' | Character;
type Contour = { left: number; right: number; rows: ([number, number] | null)[] };
export type LogoSpacing = {
 edges: Record<LogoShape, { left: number; right: number }>;
 corrections: Record<LogoShape, Record<LogoShape, number>>;
};
const resolution = 512;
const characters: Character[] = ['grok', 'alfred', 'felipe', 'muse', 'instinct'];
const shapes: LogoShape[] = ['i', 'o', ...characters];
let cached: { key: string; spacing: LogoSpacing } | undefined;

function scan(c: CanvasRenderingContext2D): Contour {
 const pixels = c.getImageData(0, 0, resolution, resolution).data;
 let left = resolution, right = 0;
 const rows: Contour['rows'] = [];
 for (let y = 0; y < resolution; y++) {
  let start = resolution, end = -1;
  for (let x = 0; x < resolution; x++) {
   if (pixels[(y * resolution + x) * 4 + 3] > 127) { start = Math.min(start, x); end = x; }
  }
  rows.push(end < 0 ? null : [(start - resolution / 2) / resolution, (end + 1 - resolution / 2) / resolution]);
  if (end >= 0) { left = Math.min(left, start); right = Math.max(right, end + 1); }
 }
 return { left: (left - resolution / 2) / resolution, right: (right - resolution / 2) / resolution, rows };
}

// Measure the loaded typeface once, in em units, independently of display size.
// Use the letters' body height: the i's dot should not widen its stem spacing.
export function measureLogoSpacing(font: Pick<CSSStyleDeclaration, 'fontFamily' | 'fontWeight' | 'fontStyle'>, furry = true): LogoSpacing {
 const key = `${font.fontStyle} ${font.fontWeight} ${font.fontFamily} ${furry}`;
 if (cached?.key === key) return cached.spacing;
 const canvas = document.createElement('canvas');
 canvas.width = canvas.height = resolution;
 const c = canvas.getContext('2d', { willReadFrequently: true })!;
 c.font = `${font.fontStyle} ${font.fontWeight} ${resolution}px ${font.fontFamily}`;
 c.textAlign = 'center';
 const contours = {} as Record<LogoShape, Contour>;
 for (const letter of ['i', 'o'] as const) {
  c.clearRect(0, 0, resolution, resolution);
  const text = c.measureText(letter);
  // CSS line-height:1 centers the font's ascent/descent inside its em box.
  const baseline = resolution / 2 + (text.fontBoundingBoxAscent - text.fontBoundingBoxDescent) / 2;
  c.fillText(letter, resolution / 2, baseline);
  contours[letter] = scan(c);
 }
 const sample = document.createElement('canvas');
 sample.width = sample.height = resolution;
 const renderer = new CharacterRenderer(sample);
 for (const kind of characters) {
  // Reduced motion only shows Grok and need not generate the furry artwork.
  if (!furry && kind !== 'grok' && kind !== 'instinct') { contours[kind] = contours.grok; continue; }
  renderer.draw(kind, 0);
  const width = kind === 'instinct' ? .54 : .72;
  c.clearRect(0, 0, resolution, resolution);
  c.save();
  const left = resolution * (.5 - width / 2), top = resolution * (.6 - width / 2);
  if (kind === 'instinct') { c.beginPath(); c.roundRect(left, top, width * resolution, width * resolution, width * .24 * resolution); c.clip(); }
  c.drawImage(sample, left, top, width * resolution, width * resolution);
  c.restore();
  contours[kind] = scan(c);
 }
 const corrections = {} as LogoSpacing['corrections'];
 for (const a of shapes) {
  corrections[a] = {} as Record<LogoShape, number>;
  for (const b of shapes) {
   let span = 0, count = 0;
   for (let row = Math.ceil(resolution * (.5 - .16)); row < resolution * (.5 + .37); row++) {
    const first = contours[a].rows[row], second = contours[b].rows[row];
    if (first && second) { span += first[1] - second[0]; count++; }
   }
   // Half contour-area correction balances equal nearest-edge gaps with equal
   // whitespace area. A fully area-based correction crowds the curved o.
   corrections[a][b] = count ? .5 * (span / count - (contours[a].right - contours[b].left)) : 0;
  }
 }
 const spacing = { edges: Object.fromEntries(shapes.map(shape => [shape, { left: contours[shape].left, right: contours[shape].right }])) as LogoSpacing['edges'], corrections };
 cached = { key, spacing };
 return spacing;
}

export function logoPositions(spacing: LogoSpacing, kinds: LogoShape[], advances: number[], gaps: number[]): number[] {
 const total = advances.reduce((sum, width) => sum + width, 0) + gaps.reduce((sum, gap) => sum + gap, 0);
 let x = -total / 2;
 return kinds.map((kind, i) => {
  const edges = spacing.edges[kind];
  const position = x + advances[i] / 2 - (edges.left + edges.right) / 2;
  x += advances[i] + (gaps[i] ?? 0);
  return position;
 });
}
