// Divider and slot geometry for the Flex Book Box page block,
// ported from KizamuBeam's Finger Joint Box with Dividers (fingerbox-dividers.ts)
// and extended for both separate floor plate (pageBlockFloor = true) and 4-wall frame (false).
import type { Pt, SubPath } from '../../../sdk/ts';
import { distributeGaps } from './distribution';

export interface DividerInput {
  /** Page block outer width (spine to fore-edge, mm) */
  Wb: number;
  /** Page block outer depth/height along spine (tail to head, mm) */
  Hb: number;
  /** Page block outer wall height (mm) */
  P: number;
  /** Material thickness (mm) */
  t: number;
  /** Minimum finger width (mm) */
  finger: number;
  /** Total joint play (v2 semantics, mm) */
  clearance: number;
  /** Laser kerf width (mm) */
  kerf: number;
  /** Whether the page block has a bottom plate */
  floor: boolean;
  /** Number of compartments across width (spine -> fore-edge) */
  compartmentsX: number;
  /** Ratio/mm distribution across width */
  ratiosX: string;
  /** Number of compartments across depth (tail -> head) */
  compartmentsY: number;
  /** Ratio/mm distribution across depth */
  ratiosY: string;
  /** Divider height = P - dividerDrop (mm) */
  dividerHeight: number;
}

export interface SlotRect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface DividerResult {
  dividers: { key: string; outline: SubPath; length: number; height: number }[];
  holes: Record<'bottom' | 'tail' | 'head' | 'fore' | 'spine', SubPath[]>;
  /** Un-kerfed slot rectangles on each visible outer wall (for clipping page-edge score lines) */
  wallSlots: Record<'tail' | 'head' | 'fore', SlotRect[]>;
  gapsX: number[];
  gapsY: number[];
  centresX: number[];
  centresY: number[];
  warnings: string[];
}

type Span = { a: number; b: number };

/** Odd number of equal segments, at least 3 (identical to fingerboxSegments) */
export function fingerboxSegments(length: number, finger: number): number {
  if (!Number.isFinite(length) || !Number.isFinite(finger) || length <= 0 || finger <= 0) {
    throw new Error('finger-length-invalid');
  }
  const n = Math.floor(length / finger);
  const count = Math.max(3, n % 2 ? n : n - 1);
  if (count > 5001) throw new Error('too-many-fingers');
  return count;
}

/** Odd number of equal segments, at least 1 (identical to panelJoints.fieldCount / horizontalSegments) */
export function horizontalSegments(length: number, finger: number): number {
  if (!Number.isFinite(length) || !Number.isFinite(finger) || length <= 0 || finger <= 0) {
    throw new Error('finger-length-invalid');
  }
  const n = Math.floor(length / finger);
  const count = Math.max(1, n % 2 ? n : n - 1);
  if (count > 5001) throw new Error('too-many-fingers');
  return count;
}

function clean(points: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    if (!out.length || Math.hypot(p.x - out[out.length - 1].x, p.y - out[out.length - 1].y) > 1e-7) {
      out.push(p);
    }
  }
  if (out.length > 1 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) < 1e-7) {
    out.pop();
  }
  return out;
}

function loop(points: Pt[], width: number, height: number, invertY: boolean): SubPath {
  return {
    closed: true,
    nodes: clean(points).map((p) => ({
      x: p.x - width / 2,
      y: invertY ? height / 2 - p.y : p.y - height / 2,
    })),
  };
}

/** Closed rectangular hole in local panel coordinates, shrunk inward by kerf/2 */
function slotHole(r: SlotRect, kerf: number): SubPath {
  const k = kerf / 2;
  const x0 = r.x0 + k;
  const x1 = r.x1 - k;
  const y0 = r.y0 + k;
  const y1 = r.y1 - k;
  if (x1 - x0 <= 0.05 || y1 - y0 <= 0.05) throw new Error('kerf-too-large');
  return {
    closed: true,
    nodes: [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ],
  };
}

/** Verify no two slots on the same panel overlap or touch after kerf */
function checkSlotOverlaps(rects: SlotRect[], kerf: number): void {
  const eps = 1e-6;
  const k = kerf / 2;
  for (let i = 0; i < rects.length; i++) {
    const a = rects[i];
    for (let j = i + 1; j < rects.length; j++) {
      const b = rects[j];
      const ox = Math.min(a.x1 - k, b.x1 - k) - Math.max(a.x0 + k, b.x0 + k);
      const oy = Math.min(a.y1 - k, b.y1 - k) - Math.max(a.y0 + k, b.y0 + k);
      if (ox >= -eps && oy >= -eps) throw new Error('slots-overlap');
    }
  }
}

/** Bottom finger spans between walls and crossings (never placed on a cross-lap notch) */
function bottomFingers(
  start: number,
  end: number,
  crossings: number[],
  t: number,
  finger: number,
  warnings: string[],
): Span[] {
  const fields: Span[] = [];
  let cursor = start;
  for (const c of crossings) {
    const a = c - t / 2;
    const b = c + t / 2;
    if (a <= cursor || b >= end) throw new Error('dividers-overlap');
    fields.push({ a: cursor, b: a });
    cursor = b;
  }
  fields.push({ a: cursor, b: end });
  const spans: Span[] = [];
  for (const field of fields) {
    const len = field.b - field.a;
    if (crossings.length && len < 3 * t - 1e-9) {
      warnings.push('narrow-no-bottom-fingers');
      continue;
    }
    const n = fingerboxSegments(len, finger);
    const step = len / n;
    for (let i = 1; i < n; i += 2) spans.push({ a: field.a + i * step, b: field.a + (i + 1) * step });
  }
  return spans;
}

/** Bottom edge of divider: optional floor fingers + optional bottom-open cross-lap notches */
function bottomEdge(
  start: number,
  end: number,
  fingers: Span[],
  crossings: number[],
  baseY: number,
  mid: number,
  slotWidth: number,
): Pt[] {
  const notches = crossings.map((c) => ({ a: c - slotWidth / 2, b: c + slotWidth / 2 }));
  const cuts = [
    start,
    end,
    ...fingers.flatMap((s) => [s.a, s.b]),
    ...notches.flatMap((s) => [s.a, s.b]),
  ].sort((a, b) => a - b);
  const pts: Pt[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i];
    const b = cuts[i + 1];
    if (b - a < 1e-9) continue;
    const m = (a + b) / 2;
    const y = notches.some((s) => m > s.a && m < s.b)
      ? mid
      : fingers.some((s) => m > s.a && m < s.b)
        ? 0
        : baseY;
    pts.push({ x: a, y }, { x: b, y });
  }
  return clean(pts);
}

/** Top edge of divider with optional top-open cross-lap notches */
function topEdge(
  start: number,
  end: number,
  crossings: number[],
  height: number,
  slotWidth: number,
): Pt[] {
  const pts: Pt[] = [{ x: end, y: height }];
  for (const c of [...crossings].reverse()) {
    pts.push(
      { x: c + slotWidth / 2, y: height },
      { x: c + slotWidth / 2, y: height / 2 },
      { x: c - slotWidth / 2, y: height / 2 },
      { x: c - slotWidth / 2, y: height },
    );
  }
  pts.push({ x: start, y: height });
  return pts;
}

/**
 * Generate divider outlines (un-kerfed) and kerf-compensated panel slots for the page block.
 * Wall slot coordinates are already oriented for outer-face-up 3D poses:
 *   - tail:  u = +X  (x_local = c_x - Wb/2)
 *   - head:  u = -X  (x_local = Wb/2 - c_x)
 *   - fore:  u = +Y  (x_local = c_y - Hb/2)
 *   - spine: u = -Y  (x_local = Hb/2 - c_y)
 *   - bottom: u = +X, v = -Y  (x_local = x - Wb/2, y_local = Hb/2 - y)
 */
export function makeDividers(p: DividerInput): DividerResult {
  const { Wb, Hb, P, t, finger, dividerHeight: hd, clearance, kerf, floor } = p;
  if (![Wb, Hb, P, t, finger, hd].every((n) => Number.isFinite(n) && n > 0) || hd > P + 1e-9 || hd <= 2 * t) {
    throw new Error('divider-height-invalid');
  }
  const slotWidth = t + clearance;
  if (!Number.isFinite(clearance) || slotWidth <= 0) throw new Error('clearance-invalid');

  const x = distributeGaps(Wb, t, p.compartmentsX, p.ratiosX);
  const y = distributeGaps(Hb, t, p.compartmentsY, p.ratiosY);
  const nx = x.centres;
  const ny = y.centres;

  const nh = fingerboxSegments(hd, finger);
  const dy = hd / nh;
  if (dy <= t + 1e-9) throw new Error('divider-fingers-short');

  const result: DividerResult = {
    dividers: [],
    holes: { bottom: [], tail: [], head: [], fore: [], spine: [] },
    wallSlots: { tail: [], head: [], fore: [] },
    gapsX: x.gaps,
    gapsY: y.gaps,
    centresX: nx,
    centresY: ny,
    warnings: [],
  };

  if (!nx.length && !ny.length) return result;
  if (!floor) result.warnings.push('dividers-no-floor');

  const vertical: Span[] = [];
  for (let i = 1; i < nh; i += 2) vertical.push({ a: i * dy, b: (i + 1) * dy });

  const bottomRects: SlotRect[] = [];
  const spineRects: SlotRect[] = [];

  function make(axis: 'x' | 'y', centre: number, num: number) {
    const length = axis === 'x' ? Hb : Wb;
    const crossings = axis === 'x' ? ny : nx;

    // Validate crossing spacing even when floor = false
    let cursor = t;
    for (const c of crossings) {
      if (c - t / 2 <= cursor || c + t / 2 >= length - t) throw new Error('dividers-overlap');
      cursor = c + t / 2;
    }

    const fs = floor ? bottomFingers(t, length - t, crossings, t, finger, result.warnings) : [];
    const teeth = fs.map(({ a, b }) => ({ a: a + clearance / 2, b: b - clearance / 2 }));
    const vt = vertical.map(({ a, b }) => ({ a: a + clearance / 2, b: b - clearance / 2 }));
    if ([...teeth, ...vt].some(({ a, b }) => b - a <= 1e-7)) throw new Error('clearance-too-large');
    for (const c of crossings) {
      if (teeth.some(({ a, b }) => a < c + slotWidth / 2 && b > c - slotWidth / 2)) {
        throw new Error('clearance-overlap');
      }
      if (c - slotWidth / 2 <= t + 1e-7 || c + slotWidth / 2 >= length - t - 1e-7) {
        throw new Error('clearance-overlap');
      }
    }

    // Bottom edge: sits on floor (baseY = t with teeth to 0) or flush on back cover (baseY = 0, flat)
    const baseY = floor ? t : 0;
    const points = bottomEdge(t, length - t, teeth, axis === 'y' ? crossings : [], baseY, hd / 2, slotWidth);

    // Right vertical edge (at x = length - t, fingers extending to x = length)
    for (let i = 0; i < nh; i++) {
      const offset = i % 2 ? t : 0;
      const a = i === 0 ? baseY : i % 2 ? vt[(i - 1) / 2].a : vertical[i / 2 - 1].b - clearance / 2;
      const b = i % 2 ? vt[(i - 1) / 2].b : i === nh - 1 ? hd : vertical[i / 2].a + clearance / 2;
      points.push({ x: length - t + offset, y: a }, { x: length - t + offset, y: b });
    }

    // Top edge (X-dividers receive top-open cross-lap notches)
    points.push(...topEdge(t, length - t, axis === 'x' ? crossings : [], hd, slotWidth));

    // Left vertical edge (at x = t, fingers extending to x = 0)
    for (let i = nh - 1; i >= 0; i--) {
      const offset = i % 2 ? t : 0;
      const a = i === 0 ? baseY : i % 2 ? vt[(i - 1) / 2].a : vertical[i / 2 - 1].b - clearance / 2;
      const b = i % 2 ? vt[(i - 1) / 2].b : i === nh - 1 ? hd : vertical[i / 2].a + clearance / 2;
      points.push({ x: t - offset, y: b }, { x: t - offset, y: a });
    }

    result.dividers.push({
      key: `div${axis}-${num}`,
      outline: loop(points, length, hd, true),
      length,
      height: hd,
    });

    // Floor slots (bottom plate: u = +X, v = -Y -> x = X - Wb/2, y = Hb/2 - Y)
    if (floor) {
      for (const s of fs) {
        const rect: SlotRect =
          axis === 'x'
            ? { x0: centre - slotWidth / 2 - Wb / 2, x1: centre + slotWidth / 2 - Wb / 2, y0: Hb / 2 - s.b, y1: Hb / 2 - s.a }
            : { x0: s.a - Wb / 2, x1: s.b - Wb / 2, y0: Hb / 2 - (centre + slotWidth / 2), y1: Hb / 2 - (centre - slotWidth / 2) };
        bottomRects.push(rect);
        result.holes.bottom.push(slotHole(rect, kerf));
      }
    }

    // Wall slots (v = -Z -> y_local = P/2 - z_from_bottom, so z in [s.a, s.b] -> y in [P/2 - s.b, P/2 - s.a])
    for (const s of vertical) {
      const y0 = P / 2 - s.b;
      const y1 = P / 2 - s.a;
      if (axis === 'x') {
        // tail wall: u = +X -> x = centre - Wb/2
        const tailRect: SlotRect = { x0: centre - slotWidth / 2 - Wb / 2, x1: centre + slotWidth / 2 - Wb / 2, y0, y1 };
        // head wall: u = -X -> x = Wb/2 - centre
        const headRect: SlotRect = { x0: Wb / 2 - centre - slotWidth / 2, x1: Wb / 2 - centre + slotWidth / 2, y0, y1 };
        result.wallSlots.tail.push(tailRect);
        result.wallSlots.head.push(headRect);
        result.holes.tail.push(slotHole(tailRect, kerf));
        result.holes.head.push(slotHole(headRect, kerf));
      } else {
        // fore wall: u = +Y -> x = centre - Hb/2
        const foreRect: SlotRect = { x0: centre - slotWidth / 2 - Hb / 2, x1: centre + slotWidth / 2 - Hb / 2, y0, y1 };
        // spine wall: u = -Y -> x = Hb/2 - centre
        const spineRect: SlotRect = { x0: Hb / 2 - centre - slotWidth / 2, x1: Hb / 2 - centre + slotWidth / 2, y0, y1 };
        result.wallSlots.fore.push(foreRect);
        spineRects.push(spineRect);
        result.holes.fore.push(slotHole(foreRect, kerf));
        result.holes.spine.push(slotHole(spineRect, kerf));
      }
    }
  }

  nx.forEach((c, i) => make('x', c, i + 1));
  ny.forEach((c, i) => make('y', c, i + 1));

  checkSlotOverlaps(bottomRects, kerf);
  checkSlotOverlaps(result.wallSlots.tail, kerf);
  checkSlotOverlaps(result.wallSlots.head, kerf);
  checkSlotOverlaps(result.wallSlots.fore, kerf);
  checkSlotOverlaps(spineRects, kerf);

  return result;
}
