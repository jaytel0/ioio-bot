import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { CABLE_SPRING, COLOR_SPRING, OUTPUTS, SOURCES, Spring, cableMidpoint, cablePath, destination, type Point } from './physics';
import './rope-switcher.css';

type Side = 'source' | 'output';
export type Connection = { source: number; output: number };
export type RopeSwitcherProps = {
  defaultConnection?: Connection;
  onChange?: (connection: Connection) => void;
  className?: string;
  assetsPath?: string;
};

type Drag = { pointerId: number; offset: Point; previous: number };
function makePlug(point: Point) {
  return { x: new Spring(point.x), y: new Spring(point.y), lift: new Spring(0), drag: null as Drag | null };
}
function makeEngine(connection: Connection) {
  const source = makePlug(SOURCES[connection.source]);
  const output = makePlug(OUTPUTS[connection.output]);
  const middle = cableMidpoint(SOURCES[connection.source], OUTPUTS[connection.output]);
  return {
    source, output,
    middle: { x: new Spring(middle.x, CABLE_SPRING), y: new Spring(middle.y, CABLE_SPRING) },
    color: [new Spring(223), new Spring(68), new Spring(9)],
    neutral: new Spring(0, COLOR_SPRING),
    connection: { ...connection },
    reducedMotion: false,
    requestPaint: null as (() => void) | null,
    screenInverse: null as DOMMatrix | null,
  };
}
function hueColor(hue: number) {
  const h = (hue % 1) * 6;
  const x = 1 - Math.abs(h % 2 - 1);
  return (h < 1 ? [1,x,0] : h < 2 ? [x,1,0] : h < 3 ? [0,1,x] : h < 4 ? [0,x,1] : h < 5 ? [x,0,1] : [1,0,x]).map(c => c * 255);
}

/** Faithful visual/interaction port of GK3's te-ios.origami (July 2022).
 * The original offers two source destinations and three output destinations.
 * “calls” and “other devices” are artwork only in that file, preserved here.
 */
export function RopeSwitcher({ defaultConnection = { source: 0, output: 0 }, onChange, className = '', assetsPath = `${import.meta.env.BASE_URL}assets` }: RopeSwitcherProps) {
  const [connection, setConnection] = useState<Connection>(() => ({
    source: Math.max(0, Math.min(1, Math.trunc(defaultConnection.source) || 0)),
    output: Math.max(0, Math.min(2, Math.trunc(defaultConnection.output) || 0)),
  }));
  const engineRef = useRef<ReturnType<typeof makeEngine> | null>(null);
  if (!engineRef.current) engineRef.current = makeEngine(connection);
  const engine = engineRef.current;
  const initialConnection = useRef(connection).current;
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  const svgRef = useRef<SVGSVGElement>(null);
  const sourceRef = useRef<SVGGElement>(null);
  const outputRef = useRef<SVGGElement>(null);
  const cableRef = useRef<SVGPathElement>(null);
  const shadowRef = useRef<SVGPathElement>(null);
  const colorShadowRef = useRef<SVGPathElement>(null);
  const shadowFilterRef = useRef<SVGFilterElement>(null);
  const sourceTipRef = useRef<SVGCircleElement>(null);
  const outputTipRef = useRef<SVGCircleElement>(null);
  const lightsRef = useRef<SVGGElement>(null);
  const id = useId().replace(/:/g, '');

  useEffect(() => {
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    let levelTimer = 0;
    let lastTime = 0;
    let levelCount = 3;
    const started = performance.now();
    const springs = [engine.source.x, engine.source.y, engine.source.lift,
      engine.output.x, engine.output.y, engine.output.lift,
      engine.middle.x, engine.middle.y, ...engine.color, engine.neutral];
    // Only changed attributes reach the DOM; settled artwork never repaints.
    const written = new WeakMap<Element, Map<string, string>>();
    const write = (element: Element | null, name: string, value: string) => {
      if (!element) return;
      let attrs = written.get(element);
      if (!attrs) { attrs = new Map(); written.set(element, attrs); }
      if (attrs.get(name) === value) return;
      element.setAttribute(name, value);
      attrs.set(name, value);
    };
    const precision = (value: number) => Math.round(value * 1000) / 1000;
    const paint = () => {
      const a = { x: precision(engine.source.x.value), y: precision(engine.source.y.value) };
      const b = { x: precision(engine.output.x.value), y: precision(engine.output.y.value) };
      const middle = { x: precision(engine.middle.x.value), y: precision(engine.middle.y.value) };
      const color = `rgb(${engine.color.map(c => precision(Math.max(0, Math.min(255, c.value * (1 - engine.neutral.value) + 118.45546875 * engine.neutral.value)))).join(' ')})`;
      write(cableRef.current, 'd', cablePath(a, b, middle));
      write(cableRef.current, 'stroke', color);
      const shadowMiddle = { x: middle.x, y: middle.y + 10 };
      const shadowPath = cablePath(a, b, shadowMiddle);
      write(shadowRef.current, 'd', shadowPath);
      write(colorShadowRef.current, 'd', shadowPath);
      write(colorShadowRef.current, 'stroke', color);
      // Bound the blur to its actual Bezier control hull, with a 4-sigma margin.
      const dx = (b.x - a.x) * 0.4, dy = (b.y - a.y) * 0.4;
      const xs = [a.x, b.x, middle.x - dx, middle.x + dx];
      const ys = [a.y, b.y, shadowMiddle.y - dy, shadowMiddle.y + dy];
      const left = Math.min(...xs) - 22, top = Math.min(...ys) - 22;
      write(shadowFilterRef.current, 'x', String(left));
      write(shadowFilterRef.current, 'y', String(top));
      write(shadowFilterRef.current, 'width', String(Math.max(...xs) - left + 22));
      write(shadowFilterRef.current, 'height', String(Math.max(...ys) - top + 22));
      for (const [side, group, tip] of [
        ['source', sourceRef.current, sourceTipRef.current],
        ['output', outputRef.current, outputTipRef.current],
      ] as const) {
        const plug = engine[side];
        const scale = precision(1 + 0.3 * plug.lift.value);
        write(group, 'transform', `translate(${precision(plug.x.value)} ${precision(plug.y.value)}) scale(${scale})`);
        write(tip, 'cx', String(precision(plug.x.value)));
        write(tip, 'cy', String(precision(plug.y.value)));
        write(tip, 'r', String(6 * scale));
        write(tip, 'fill', color);
      }
      const dragging = !!(engine.source.drag || engine.output.drag);
      if (lightsRef.current) {
        for (let i = 0; i < lightsRef.current.children.length; i++) {
          write(lightsRef.current.children[i], 'opacity', !dragging && i < levelCount ? '1' : '0');
        }
      }
    };
    const requestPaint = () => {
      if (!frame && !document.hidden) frame = requestAnimationFrame(tick);
    };
    const tick = (timestamp: number) => {
      frame = 0;
      const dt = lastTime ? Math.min((timestamp - lastTime) / 1000, 1 / 30) : 1 / 60;
      lastTime = timestamp;
      const reduced = engine.reducedMotion;
      for (const plug of [engine.source, engine.output]) {
        plug.x.step(dt, reduced);
        plug.y.step(dt, reduced);
        plug.lift.target = plug.drag ? 1 : 0;
        plug.lift.step(dt, reduced);
      }
      const middle = cableMidpoint(
        { x: engine.source.x.value, y: engine.source.y.value },
        { x: engine.output.x.value, y: engine.output.y.value },
      );
      engine.middle.x.target = middle.x;
      engine.middle.y.target = middle.y;
      engine.middle.x.step(dt, reduced);
      engine.middle.y.step(dt, reduced);
      const colors = engine.connection.output === 0 ? [223, 68, 9]
        : engine.connection.output === 2 ? [9, 137.32, 223]
        : hueColor(reduced ? 0.4 : (timestamp - started) / 3000);
      engine.color.forEach((spring, i) => { spring.target = colors[i]; spring.step(dt, reduced); });
      engine.neutral.target = engine.source.drag || engine.output.drag ? 1 : 0;
      engine.neutral.step(dt, reduced);
      paint();
      const active = engine.source.drag || engine.output.drag
        || (!reduced && engine.connection.output === 1)
        || springs.some(spring => !spring.settled);
      if (active) requestPaint();
      else lastTime = 0;
    };
    engine.requestPaint = requestPaint;
    const updateLevels = () => {
      levelCount = Math.round(Math.random() * 5);
      requestPaint();
      levelTimer = window.setTimeout(updateLevels, 100);
    };
    const visibility = () => {
      cancelAnimationFrame(frame);
      clearTimeout(levelTimer);
      frame = 0;
      lastTime = 0;
      if (!document.hidden) {
        requestPaint();
        if (!engine.reducedMotion) levelTimer = window.setTimeout(updateLevels, 100);
      }
    };
    const updateMotion = () => {
      engine.reducedMotion = query.matches;
      visibility();
    };
    // Cache the coordinate transform outside the pointermove path.
    const refreshMatrix = () => {
      if (engine.source.drag || engine.output.drag)
        engine.screenInverse = svgRef.current?.getScreenCTM()?.inverse() ?? null;
    };
    const observer = new ResizeObserver(refreshMatrix);
    if (svgRef.current) observer.observe(svgRef.current);
    window.addEventListener('scroll', refreshMatrix, true);
    window.addEventListener('resize', refreshMatrix);
    query.addEventListener('change', updateMotion);
    document.addEventListener('visibilitychange', visibility);
    updateMotion();
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(levelTimer);
      observer.disconnect();
      window.removeEventListener('scroll', refreshMatrix, true);
      window.removeEventListener('resize', refreshMatrix);
      engine.requestPaint = null;
      query.removeEventListener('change', updateMotion);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [engine]);
  function publish() {
    const next = { ...engine.connection };
    setConnection(next);
    onChangeRef.current?.(next);
  }

  function point(event: PointerEvent<SVGGElement>): Point | null {
    const matrix = engine.screenInverse;
    if (!matrix) return null;
    return new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix);
  }

  function begin(side: Side, event: PointerEvent<SVGGElement>) {
    if (event.button !== 0 || engine[side].drag) return;
    engine.screenInverse = svgRef.current?.getScreenCTM()?.inverse() ?? null;
    const at = point(event);
    if (!at) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const plug = engine[side];
    plug.drag = { pointerId: event.pointerId, previous: engine.connection[side], offset: { x: at.x - plug.x.value, y: at.y - plug.y.value } };
    // Retain the exact grabbed position even when interrupting a return spring.
    plug.x.jump(plug.x.value);
    plug.y.jump(plug.y.value);
    event.currentTarget.dataset.dragging = 'true';
    engine.requestPaint?.();
  }

  function move(side: Side, event: PointerEvent<SVGGElement>) {
    const plug = engine[side];
    if (!plug.drag || plug.drag.pointerId !== event.pointerId) return;
    const at = point(event);
    if (!at) return;
    plug.x.jump(Math.max(35, Math.min(365, at.x - plug.drag.offset.x)));
    plug.y.jump(Math.max(-465, Math.min(735, at.y - plug.drag.offset.y)));
    engine.connection[side] = destination(side, plug.y.value);
    // Keep the newest input; paint once before the next display refresh.
    engine.requestPaint?.();
  }

  function finish(side: Side, event: PointerEvent<SVGGElement>, cancelled = false) {
    const plug = engine[side];
    if (!plug.drag || plug.drag.pointerId !== event.pointerId) return;
    if (cancelled) engine.connection[side] = plug.drag.previous;
    const target = (side === 'source' ? SOURCES : OUTPUTS)[engine.connection[side]];
    plug.x.target = target.x;
    plug.y.target = target.y;
    plug.drag = null;
    engine.requestPaint?.();
    event.currentTarget.dataset.dragging = 'false';
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    publish();
  }

  function key(side: Side, event: KeyboardEvent<SVGGElement>) {
    const choices = side === 'source' ? SOURCES : OUTPUTS;
    const current = engine.connection[side];
    let next: number;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = Math.min(current + 1, choices.length - 1);
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = Math.max(current - 1, 0);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = choices.length - 1;
    else return;
    event.preventDefault();
    engine.connection[side] = next;
    engine[side].x.jump(choices[next].x);
    engine[side].y.jump(choices[next].y);
    const middle = cableMidpoint(
      { x: engine.source.x.value, y: engine.source.y.value },
      { x: engine.output.x.value, y: engine.output.y.value },
    );
    engine.middle.x.jump(middle.x);
    engine.middle.y.jump(middle.y);
    engine.requestPaint?.();
    publish();
  }

  return <div className={`rope-switcher ${className}`} data-source={connection.source} data-output={connection.output}>
    <svg ref={svgRef} viewBox="0 0 390 270" aria-label="IO–1 audio routing" role="group">
      <defs>
        <clipPath id={`${id}-panel`}>
          <path d="M 50 -7.2 H 340 C 368.7 -7.2 378.7 2.8 378.7 31.5 V 218.5 C 378.7 247.2 368.7 257.2 340 257.2 H 50 C 21.3 257.2 11.3 247.2 11.3 218.5 V 31.5 C 11.3 2.8 21.3 -7.2 50 -7.2 Z" />
        </clipPath>
        <filter ref={shadowFilterRef} id={`${id}-shadow`} filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feGaussianBlur stdDeviation="5" />
        </filter>
      </defs>
      <image href={`${assetsPath}/panel.png`} x="-50" y="-68.5" width="490" height="387" clipPath={`url(#${id}-panel)`} aria-hidden="true" />
      <image href={`${assetsPath}/levels.png`} x="316.666667" y="18" width="41.333333" height="5.333333" aria-hidden="true" />
      <g ref={lightsRef} aria-hidden="true" className="rope-levels">
        {[0, 1, 2, 3, 4].map(i => <circle key={i} cx={320 + i * 9} cy="21" r="2" fill="#00ff00" />)}
      </g>
      <g filter={`url(#${id}-shadow)`} style={{ mixBlendMode: 'multiply' }} aria-hidden="true" fill="none" strokeWidth="3">
        <path ref={shadowRef} stroke="rgba(0,0,0,.4)" />
        <path ref={colorShadowRef} />
      </g>
      {(['source', 'output'] as const).map(side => <g
        key={side}
        ref={side === 'source' ? sourceRef : outputRef}
        className="rope-plug"
        transform={`translate(${(side === 'source' ? SOURCES : OUTPUTS)[initialConnection[side]].x} ${(side === 'source' ? SOURCES : OUTPUTS)[initialConnection[side]].y})`}
        role="slider"
        aria-label={side === 'source' ? 'Audio source' : 'Audio output'}
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={side === 'source' ? 1 : 2}
        aria-valuenow={connection[side]}
        aria-valuetext={(side === 'source' ? SOURCES : OUTPUTS)[connection[side]].name}
        tabIndex={0}
        onPointerDown={event => begin(side, event)}
        onPointerMove={event => move(side, event)}
        onPointerUp={event => finish(side, event)}
        onPointerCancel={event => finish(side, event, true)}
        onLostPointerCapture={event => finish(side, event, true)}
        onKeyDown={event => key(side, event)}
      >
        <image href={`${assetsPath}/handle.png`} x="-37" y="-37" width="90" height="90" pointerEvents="none" />
        <circle className="rope-focus" r="22" fill="none" stroke="#2474dd" strokeWidth="2" pointerEvents="none" />
        <rect x="-30" y="-30" width="60" height="60" fill="transparent" />
      </g>)}
      <path ref={cableRef} data-testid="cable" className="rope-cable" fill="none" stroke="#df4409" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" />
      <circle ref={sourceTipRef} r="6" pointerEvents="none" aria-hidden="true" />
      <circle ref={outputTipRef} r="6" pointerEvents="none" aria-hidden="true" />
    </svg>
    <span className="sr-only" role="status" aria-live="polite">{SOURCES[connection.source].name} connected to {OUTPUTS[connection.output].name}</span>
  </div>;
}
