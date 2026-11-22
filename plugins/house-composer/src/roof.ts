// Parametric roof geometry for the house composer: flat, gable, shed (pent), hip and pyramid roofs.
// Pure computation, no host functions, so it can be tested in Node.
//
// 3D assembly coordinates: X right (0..W), Y back (0..D), Z up (0 at bottom of floor).
// Every roof panel is returned in its own centered 2D plane (y down = ridge toward eaves) with outer face UP
// on the laser bed (−(u×v) = outward normal n), so engraved roof patterns always sit on the outside.
import type { Pose, SubPath, V3 } from '../../../sdk/ts';

export type RoofType = 'flat' | 'gable' | 'shed' | 'hip' | 'pyramid';
export type RoofSizeMode = 'angle' | 'height';
export type RoofMount = 'fixed' | 'removable';
export type RoofPattern = 'none' | 'tiles' | 'shingles' | 'seams';
export type OuterWallKey = 'front' | 'back' | 'left' | 'right';

export interface RoofSpec {
  type: RoofType;
  sizeMode: RoofSizeMode;
  /** Pitch angle in degrees (used when sizeMode === 'angle') */
  angle: number;
  /** Vertical rise from eaves to peak in mm (used when sizeMode === 'height') */
  height: number;
  /** Ridge direction for gable roofs: 'x' = left-right (gables on left/right), 'y' = front-back (gables on front/back) */
  ridgeAxis: 'x' | 'y';
  /** Direction the roof slopes down toward for shed roofs */
  shedDir: OuterWallKey;
  /** Eaves overhang in mm (all 4 sides for flat, hip, pyramid; eaves/high edges for gable, shed) */
  overhang: number;
  /** Gable / rake overhang in mm (gable and shed roofs) */
  gableOverhang: number;
  /** 'fixed' = interlocked with tenons/fingers into walls, 'removable' = lift-off roof */
  mount: RoofMount;
  /** Optional engraved roof pattern on the top face */
  pattern: RoofPattern;
  /** Pattern spacing in mm */
  patternSize: number;
}

export interface RoofMetrics {
  rise: number;
  pitchRad: number;
  pitchDeg: number;
  /** Second pitch angle in radians for rectangular pyramid roofs (along X if primary is along Y, or vice versa) */
  pitchRad2: number;
  totalHeight: number;
  ridgeAxis: 'x' | 'y';
  ridgeLength: number;
  /** How far the eaves overhang drops vertically below eaves height H */
  eavesDrop: number;
  /** Whether the flat roof sits flush inside the walls at Z = H - t */
  flushFlat: boolean;
}

export interface RoofIssue {
  key?: string;
  level: 'error' | 'warn';
  code: string;
  values?: Record<string, number | string>;
}

/** Top silhouette of an outer wall in EXTERIOR elevation coordinates (x left→right from outside, z up from Z=0) */
export interface WallProfile {
  wall: OuterWallKey;
  width: number;
  eavesZ: number;
  maxZ: number;
  kind: 'flat' | 'gable' | 'shed-slope' | 'shed-high';
  /** Height of wall top at exterior horizontal coordinate x ∈ [0, width] */
  zAt: (x: number) => number;
  /** Top boundary vertices (x, z) from x = 0 to x = width in exterior coordinates */
  topPoints: [number, number][];
}

export interface RoofPanelGeom {
  key: string;
  /** Closed 2D polygon in local centered coords (y down = ridge toward eaves) */
  pts: [number, number][];
  width: number;
  height: number;
  pose: Pose;
  /** Distance from panel top (y = -height/2) to the eaves wall outer line along local y */
  slopeLen: number;
  /** Engraved roof pattern lines in local centered coords */
  marks: SubPath[];
}

export interface TrussSpec {
  key: string;
  /** Axis the truss plane lies along ('y' for ridgeAxis='x' trusses spanning depth D, 'x' for ridgeAxis='y') */
  spanAxis: 'x' | 'y';
  /** Center position along the perpendicular axis (3D X if spanAxis='y', 3D Y if spanAxis='x') */
  at: number;
  /** Inner span (between the two eaves walls, e.g. D - 2t) */
  innerSpan: number;
  /** Full outer span (D or W) */
  outerSpan: number;
  eavesZ: number;
  rise: number;
  pitchRad: number;
  /** Vertical heel height at inner wall face = t * tan(pitchRad) */
  heel: number;
  /** Outline in local centered coords (x along spanAxis, y down from peak to eaves) */
  pts: [number, number][];
  pose: Pose;
}

const DEG = Math.PI / 180;
const EPS = 1e-6;

/** Compute roof rise, pitch angles, ridge length, eaves drop and overall height */
export function computeRoofMetrics(W: number, D: number, H: number, t: number, spec: RoofSpec): RoofMetrics {
  const flushFlat = spec.type === 'flat' && spec.mount === 'fixed' && spec.overhang < EPS;
  if (spec.type === 'flat') {
    return {
      rise: 0,
      pitchRad: 0,
      pitchDeg: 0,
      pitchRad2: 0,
      totalHeight: flushFlat ? H : H + t,
      ridgeAxis: W >= D ? 'x' : 'y',
      ridgeLength: 0,
      eavesDrop: 0,
      flushFlat,
    };
  }

  let run = 0;
  let ridgeAxis: 'x' | 'y' = spec.ridgeAxis;
  let ridgeLength = 0;

  if (spec.type === 'gable') {
    run = (spec.ridgeAxis === 'x' ? D : W) / 2;
    ridgeAxis = spec.ridgeAxis;
    ridgeLength = spec.ridgeAxis === 'x' ? W : D;
  } else if (spec.type === 'shed') {
    const alongY = spec.shedDir === 'front' || spec.shedDir === 'back';
    run = alongY ? D : W;
    ridgeAxis = alongY ? 'x' : 'y';
    ridgeLength = alongY ? W : D;
  } else if (spec.type === 'hip') {
    // Equal pitch on all 4 faces: ridge runs along the longer side
    ridgeAxis = W >= D ? 'x' : 'y';
    run = Math.min(W, D) / 2;
    ridgeLength = Math.max(0, Math.abs(W - D));
  } else {
    // pyramid: apex at center, primary angle defined on the shorter span
    ridgeAxis = W >= D ? 'x' : 'y';
    run = Math.min(W, D) / 2;
    ridgeLength = 0;
  }

  let rise: number;
  let pitchRad: number;
  if (spec.sizeMode === 'angle') {
    pitchRad = Math.max(1, Math.min(80, spec.angle)) * DEG;
    rise = run * Math.tan(pitchRad);
  } else {
    rise = Math.max(0, spec.height);
    pitchRad = run > EPS ? Math.atan2(rise, run) : 0;
  }

  let pitchRad2 = pitchRad;
  if (spec.type === 'pyramid') {
    const runLong = Math.max(W, D) / 2;
    pitchRad2 = runLong > EPS ? Math.atan2(rise, runLong) : pitchRad;
  }

  const eavesDrop =
    spec.type === 'pyramid'
      ? (spec.overhang / Math.max(EPS, run)) * rise
      : spec.overhang * Math.tan(pitchRad);

  const peakThickness = t / Math.max(0.15, Math.cos(pitchRad));
  return {
    rise,
    pitchRad,
    pitchDeg: pitchRad / DEG,
    pitchRad2,
    totalHeight: H + rise + peakThickness,
    ridgeAxis,
    ridgeLength,
    eavesDrop,
    flushFlat: false,
  };
}

/** Validate roof parameters against house dimensions and outline shape */
export function validateRoof(W: number, D: number, H: number, t: number, spec: RoofSpec, isRectOutline: boolean): RoofIssue[] {
  const issues: RoofIssue[] = [];
  if (!isRectOutline && spec.type !== 'flat') {
    issues.push({ key: 'roofType', level: 'error', code: 'roof-needs-rect' });
    return issues;
  }
  const m = computeRoofMetrics(W, D, H, t, spec);
  if (spec.type === 'flat') {
    if (spec.mount === 'fixed' && spec.overhang > EPS && spec.overhang < t - EPS) {
      issues.push({ key: 'roofOverhang', level: 'error', code: 'roof-overhang-web', values: { min: t } });
    }
    return issues;
  }
  if (m.pitchDeg > 78) {
    issues.push({ key: spec.sizeMode === 'height' ? 'roofHeight' : 'roofAngle', level: 'error', code: 'roof-too-steep' });
  }
  if (m.rise < 2 || m.pitchDeg < 3) {
    issues.push({ key: spec.sizeMode === 'height' ? 'roofHeight' : 'roofAngle', level: 'error', code: 'roof-too-flat' });
  }
  if (spec.mount === 'fixed' && (spec.type === 'gable' || spec.type === 'shed')) {
    if (spec.gableOverhang > EPS && spec.gableOverhang < t - EPS) {
      issues.push({ key: 'roofGableOverhang', level: 'error', code: 'roof-gable-overhang-web', values: { min: t } });
    }
  }
  if (H - m.eavesDrop < t) {
    issues.push({ key: 'roofOverhang', level: 'error', code: 'roof-eaves-low' });
  }
  return issues;
}

/**
 * Top silhouette of an outer wall in exterior elevation coordinates (x left→right when standing outside looking at
 * the wall, z up from Z=0).
 */
export function wallProfile(wall: OuterWallKey, W: number, D: number, H: number, t: number, spec: RoofSpec): WallProfile {
  const width = wall === 'front' || wall === 'back' ? W : D;
  const m = computeRoofMetrics(W, D, H, t, spec);
  const flat = (z: number, kind: WallProfile['kind'] = 'flat'): WallProfile => ({
    wall,
    width,
    eavesZ: H,
    maxZ: z,
    kind,
    zAt: () => z,
    topPoints: [[0, z], [width, z]],
  });

  if (spec.type === 'flat' || spec.type === 'hip' || spec.type === 'pyramid') return flat(H);

  if (spec.type === 'gable') {
    const isGable =
      (spec.ridgeAxis === 'x' && (wall === 'left' || wall === 'right')) ||
      (spec.ridgeAxis === 'y' && (wall === 'front' || wall === 'back'));
    if (!isGable) return flat(H);
    const half = width / 2;
    const zAt = (x: number) => H + m.rise * Math.max(0, 1 - Math.abs(x - half) / Math.max(EPS, half));
    return {
      wall,
      width,
      eavesZ: H,
      maxZ: H + m.rise,
      kind: 'gable',
      zAt,
      topPoints: [[0, H], [half, H + m.rise], [width, H]],
    };
  }

  // Shed roof: one low wall (shedDir), one high wall (opposite), two sloped side walls
  const opp: Record<OuterWallKey, OuterWallKey> = { front: 'back', back: 'front', left: 'right', right: 'left' };
  if (wall === spec.shedDir) return flat(H);
  const tanA = Math.tan(m.pitchRad);
  if (wall === opp[spec.shedDir]) {
    const highZ = H + Math.max(0, m.rise - t * tanA);
    return flat(highZ, 'shed-high');
  }
  // Sloped side wall: determine whether high end is on the LEFT (x=0) or RIGHT (x=width) in exterior elevation
  // Exterior left→right:
  //   front: left = X=0 (left),  right = X=W (right)
  //   back:  left = X=W (right), right = X=0 (left)
  //   left:  left = Y=D (back),  right = Y=0 (front)
  //   right: left = Y=0 (front), right = Y=D (back)
  const leftSideOf: Record<OuterWallKey, OuterWallKey> = { front: 'left', back: 'right', left: 'back', right: 'front' };
  const highOnLeft = leftSideOf[wall] === opp[spec.shedDir];
  const z0 = highOnLeft ? H + m.rise : H;
  const z1 = highOnLeft ? H : H + m.rise;
  return {
    wall,
    width,
    eavesZ: H,
    maxZ: H + m.rise,
    kind: 'shed-slope',
    zAt: (x: number) => z0 + ((z1 - z0) * Math.max(0, Math.min(width, x))) / Math.max(EPS, width),
    topPoints: [[0, z0], [width, z1]],
  };
}

/** Axis-aligned exclusion box [x0, y0, x1, y1] where roof engraving marks must not enter (e.g. tenon slots) */
export type RoofExclusion = [number, number, number, number];

function pointInPoly(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i],
      [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Liang-Barsky intersection of segment (x0,y0)→(x1,y1) with axis-aligned box [bx0,by0,bx1,by1]; returns [t0,t1] or null */
function segBoxInterval(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  bx0: number,
  by0: number,
  bx1: number,
  by1: number,
): [number, number] | null {
  let t0 = 0,
    t1 = 1;
  const dx = x1 - x0,
    dy = y1 - y0;
  const clip = (p: number, q: number): boolean => {
    if (Math.abs(p) < 1e-12) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  if (!clip(-dx, x0 - bx0) || !clip(dx, bx1 - x0) || !clip(-dy, y0 - by0) || !clip(dy, by1 - y0)) return null;
  return t1 > t0 + 1e-6 ? [t0, t1] : null;
}

/** Subtract [cut0, cut1] from a list of [a, b] intervals */
function subtractInterval(spans: [number, number][], cut0: number, cut1: number): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of spans) {
    if (cut1 <= a || cut0 >= b) out.push([a, b]);
    else {
      if (cut0 > a + 1e-5) out.push([a, cut0]);
      if (cut1 < b - 1e-5) out.push([cut1, b]);
    }
  }
  return out;
}

/**
 * Clip a 2D line segment (p0→p1) to the interior of ANY simple polygon `poly` (convex or concave L/U/C),
 * keeping at least `margin` mm away from every polygon edge and skipping all `exclude` boxes (e.g. tenon slots).
 */
export function clipSegmentPoly(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  poly: [number, number][],
  margin = 0,
  exclude: RoofExclusion[] = [],
): [[number, number], [number, number]][] {
  const dx = x1 - x0,
    dy = y1 - y0;
  const segLen = Math.hypot(dx, dy);
  if (segLen < EPS || poly.length < 3) return [];

  // 1. Intersect segment with every polygon edge to partition [0, 1] into inside/outside intervals
  const cuts: number[] = [0, 1];
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i],
      [bx, by] = poly[(i + 1) % poly.length];
    const ex = bx - ax,
      ey = by - ay;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const wx = ax - x0,
      wy = ay - y0;
    const t = (wx * ey - wy * ex) / den;
    const u = (wx * dy - wy * dx) / den;
    if (t > 1e-6 && t < 1 - 1e-6 && u >= -1e-6 && u <= 1 + 1e-6) cuts.push(t);
  }
  cuts.sort((a, b) => a - b);

  let spans: [number, number][] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i],
      b = cuts[i + 1];
    if (b - a < 1e-5) continue;
    const m = (a + b) / 2;
    if (pointInPoly(x0 + m * dx, y0 + m * dy, poly)) spans.push([a, b]);
  }
  if (!spans.length) return [];

  // 2. Subtract margin band around every polygon edge (in each edge's local frame)
  if (margin > EPS) {
    for (let i = 0; i < poly.length && spans.length; i++) {
      const [ax, ay] = poly[i],
        [bx, by] = poly[(i + 1) % poly.length];
      const ex = bx - ax,
        ey = by - ay;
      const len = Math.hypot(ex, ey);
      if (len < EPS) continue;
      const ux = ex / len,
        uy = ey / len;
      const nx = -uy,
        ny = ux;
      const rx0 = (x0 - ax) * ux + (y0 - ay) * uy;
      const ry0 = (x0 - ax) * nx + (y0 - ay) * ny;
      const rx1 = (x1 - ax) * ux + (y1 - ay) * uy;
      const ry1 = (x1 - ax) * nx + (y1 - ay) * ny;
      const hit = segBoxInterval(rx0, ry0, rx1, ry1, -margin, -margin, len + margin, margin);
      if (hit) spans = subtractInterval(spans, hit[0], hit[1]);
    }
  }

  // 3. Subtract slot exclusion boxes
  for (const [bx0, by0, bx1, by1] of exclude) {
    if (!spans.length) break;
    const hit = segBoxInterval(x0, y0, x1, y1, bx0, by0, bx1, by1);
    if (hit) spans = subtractInterval(spans, hit[0], hit[1]);
  }

  return spans
    .filter(([a, b]) => (b - a) * segLen >= 0.4)
    .map(([a, b]): [[number, number], [number, number]] => [
      [x0 + a * dx, y0 + a * dy],
      [x0 + b * dx, y0 + b * dy],
    ]);
}

const lineSub = (a: [number, number], b: [number, number]): SubPath => ({
  closed: false,
  nodes: [{ x: a[0], y: a[1] }, { x: b[0], y: b[1] }],
});

/** Generate clipped engraved roof pattern marks (tiles, shingles, standing seams) inside any roof panel polygon */
export function roofPatternMarks(
  pts: [number, number][],
  pattern: RoofPattern,
  size: number,
  margin = 2,
  exclude: RoofExclusion[] = [],
): SubPath[] {
  if (pattern === 'none' || size < 3 || pts.length < 3) return [];
  let x0 = Infinity,
    x1 = -Infinity,
    y0 = Infinity,
    y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  const marks: SubPath[] = [];
  const push = (ax: number, ay: number, bx: number, by: number) => {
    for (const seg of clipSegmentPoly(ax, ay, bx, by, pts, margin, exclude)) marks.push(lineSub(seg[0], seg[1]));
  };
  const step = Math.max(3, size);

  if (pattern === 'seams') {
    const cx = (x0 + x1) / 2;
    const count = Math.floor((x1 - x0) / (2 * step));
    for (let i = -count; i <= count; i++) {
      const x = cx + i * step;
      push(x, y0, x, y1);
    }
    return marks;
  }

  if (pattern === 'tiles') {
    const courseH = step;
    const tileW = step * 0.85;
    const cx = (x0 + x1) / 2;
    let row = 0;
    for (let y = y1 - courseH; y > y0 + margin; y -= courseH, row++) {
      push(x0, y, x1, y);
      const yNext = y + courseH;
      const offset = (row % 2) * (tileW / 2);
      const nCols = Math.ceil((x1 - x0) / tileW) + 1;
      for (let i = -nCols; i <= nCols; i++) {
        const x = cx + i * tileW + offset;
        push(x, y, x, yNext);
      }
    }
    return marks;
  }

  if (pattern === 'shingles') {
    const courseH = step * 0.75;
    const shW = step;
    const dip = courseH * 0.35;
    const cx = (x0 + x1) / 2;
    let row = 0;
    for (let y = y1 - courseH; y > y0 + margin; y -= courseH, row++) {
      const offset = (row % 2) * (shW / 2);
      const nCols = Math.ceil((x1 - x0) / shW) + 1;
      for (let i = -nCols; i <= nCols; i++) {
        const xa = cx + i * shW + offset;
        const xm = xa + shW / 2;
        const xb = xa + shW;
        push(xa, y, xm, y + dip);
        push(xm, y + dip, xb, y);
      }
    }
    return marks;
  }

  return marks;
}

const rectPts = (w: number, h: number): [number, number][] => [
  [-w / 2, -h / 2],
  [w / 2, -h / 2],
  [w / 2, h / 2],
  [-w / 2, h / 2],
];

/** Build all roof panels (2D outlines, 3D poses, and optional roof engraving marks) for a rectangular house */
export function buildRoofPanels(W: number, D: number, H: number, t: number, spec: RoofSpec): RoofPanelGeom[] {
  const m = computeRoofMetrics(W, D, H, t, spec);
  const ee = spec.overhang;
  const eg = spec.gableOverhang;
  const a = m.pitchRad;
  const ca = Math.cos(a),
    sa = Math.sin(a);
  const patMargin = spec.mount === 'fixed' ? Math.max(2, t + 1) : 2;

  if (spec.type === 'flat') {
    const rw = W + 2 * ee;
    const rd = D + 2 * ee;
    const pts = rectPts(rw, rd);
    const z = m.flushFlat ? H - t : H;
    return [
      {
        key: 'roof',
        pts,
        width: rw,
        height: rd,
        slopeLen: rd,
        pose: { o: [W / 2, D / 2, z], u: [1, 0, 0], v: [0, -1, 0], n: [0, 0, 1] },
        marks: roofPatternMarks(pts, spec.pattern, spec.patternSize, patMargin),
      },
    ];
  }

  if (spec.type === 'gable') {
    const span = spec.ridgeAxis === 'x' ? D : W;
    const ridgeLen = spec.ridgeAxis === 'x' ? W : D;
    const Ls = span / 2 / ca;
    const ph = Ls + ee;
    const pw = ridgeLen + 2 * eg;
    const pts = rectPts(pw, ph);
    const yMid = ph / 2;
    const marks = roofPatternMarks(pts, spec.pattern, spec.patternSize, patMargin);

    if (spec.ridgeAxis === 'x') {
      return [
        {
          key: 'roof-front',
          pts,
          width: pw,
          height: ph,
          slopeLen: Ls,
          pose: {
            o: [W / 2, D / 2 - yMid * ca, H + m.rise - yMid * sa],
            u: [1, 0, 0],
            v: [0, -ca, -sa],
            n: [0, -sa, ca],
          },
          marks,
        },
        {
          key: 'roof-back',
          pts,
          width: pw,
          height: ph,
          slopeLen: Ls,
          pose: {
            o: [W / 2, D / 2 + yMid * ca, H + m.rise - yMid * sa],
            u: [-1, 0, 0],
            v: [0, ca, -sa],
            n: [0, sa, ca],
          },
          marks,
        },
      ];
    } else {
      return [
        {
          key: 'roof-left',
          pts,
          width: pw,
          height: ph,
          slopeLen: Ls,
          pose: {
            o: [W / 2 - yMid * ca, D / 2, H + m.rise - yMid * sa],
            u: [0, -1, 0],
            v: [-ca, 0, -sa],
            n: [-sa, 0, ca],
          },
          marks,
        },
        {
          key: 'roof-right',
          pts,
          width: pw,
          height: ph,
          slopeLen: Ls,
          pose: {
            o: [W / 2 + yMid * ca, D / 2, H + m.rise - yMid * sa],
            u: [0, 1, 0],
            v: [ca, 0, -sa],
            n: [sa, 0, ca],
          },
          marks,
        },
      ];
    }
  }

  if (spec.type === 'shed') {
    const alongY = spec.shedDir === 'front' || spec.shedDir === 'back';
    const run = alongY ? D : W;
    const cross = alongY ? W : D;
    const Ls = run / ca;
    const ph = Ls + 2 * ee;
    const pw = cross + 2 * eg;
    const pts = rectPts(pw, ph);
    const o: V3 = [W / 2, D / 2, H + m.rise / 2];
    const basis: Record<OuterWallKey, { u: V3; v: V3; n: V3 }> = {
      front: { u: [1, 0, 0], v: [0, -ca, -sa], n: [0, -sa, ca] },
      back: { u: [-1, 0, 0], v: [0, ca, -sa], n: [0, sa, ca] },
      left: { u: [0, -1, 0], v: [-ca, 0, -sa], n: [-sa, 0, ca] },
      right: { u: [0, 1, 0], v: [ca, 0, -sa], n: [sa, 0, ca] },
    };
    const b = basis[spec.shedDir];
    return [
      {
        key: 'roof',
        pts,
        width: pw,
        height: ph,
        slopeLen: Ls,
        pose: { o, u: b.u, v: b.v, n: b.n },
        marks: roofPatternMarks(pts, spec.pattern, spec.patternSize, patMargin),
      },
    ];
  }

  if (spec.type === 'hip') {
    const short = Math.min(W, D);
    const Lr = Math.max(0, Math.abs(W - D));
    const hs = (short / 2 + ee) / ca;
    const yMid = hs / 2;
    const trapPts = (botW: number, topW: number, h: number): [number, number][] =>
      topW > EPS
        ? [[-topW / 2, -h / 2], [topW / 2, -h / 2], [botW / 2, h / 2], [-botW / 2, h / 2]]
        : [[0, -h / 2], [botW / 2, h / 2], [-botW / 2, h / 2]];

    if (W >= D) {
      // Ridge along X from X = D/2 to X = W - D/2 at Y = D/2
      const fbPts = trapPts(W + 2 * ee, Lr, hs);
      const lrPts = trapPts(D + 2 * ee, 0, hs);
      const fbMarks = roofPatternMarks(fbPts, spec.pattern, spec.patternSize, 2);
      const lrMarks = roofPatternMarks(lrPts, spec.pattern, spec.patternSize, 2);
      return [
        {
          key: 'roof-front',
          pts: fbPts,
          width: W + 2 * ee,
          height: hs,
          slopeLen: D / 2 / ca,
          pose: { o: [W / 2, D / 2 - yMid * ca, H + m.rise - yMid * sa], u: [1, 0, 0], v: [0, -ca, -sa], n: [0, -sa, ca] },
          marks: fbMarks,
        },
        {
          key: 'roof-back',
          pts: fbPts,
          width: W + 2 * ee,
          height: hs,
          slopeLen: D / 2 / ca,
          pose: { o: [W / 2, D / 2 + yMid * ca, H + m.rise - yMid * sa], u: [-1, 0, 0], v: [0, ca, -sa], n: [0, sa, ca] },
          marks: fbMarks,
        },
        {
          key: 'roof-left',
          pts: lrPts,
          width: D + 2 * ee,
          height: hs,
          slopeLen: D / 2 / ca,
          pose: { o: [D / 2 - yMid * ca, D / 2, H + m.rise - yMid * sa], u: [0, -1, 0], v: [-ca, 0, -sa], n: [-sa, 0, ca] },
          marks: lrMarks,
        },
        {
          key: 'roof-right',
          pts: lrPts,
          width: D + 2 * ee,
          height: hs,
          slopeLen: D / 2 / ca,
          pose: { o: [W - D / 2 + yMid * ca, D / 2, H + m.rise - yMid * sa], u: [0, 1, 0], v: [ca, 0, -sa], n: [sa, 0, ca] },
          marks: lrMarks,
        },
      ];
    } else {
      // Ridge along Y from Y = W/2 to Y = D - W/2 at X = W/2
      const lrPts = trapPts(D + 2 * ee, Lr, hs);
      const fbPts = trapPts(W + 2 * ee, 0, hs);
      const lrMarks = roofPatternMarks(lrPts, spec.pattern, spec.patternSize, 2);
      const fbMarks = roofPatternMarks(fbPts, spec.pattern, spec.patternSize, 2);
      return [
        {
          key: 'roof-front',
          pts: fbPts,
          width: W + 2 * ee,
          height: hs,
          slopeLen: W / 2 / ca,
          pose: { o: [W / 2, W / 2 - yMid * ca, H + m.rise - yMid * sa], u: [1, 0, 0], v: [0, -ca, -sa], n: [0, -sa, ca] },
          marks: fbMarks,
        },
        {
          key: 'roof-back',
          pts: fbPts,
          width: W + 2 * ee,
          height: hs,
          slopeLen: W / 2 / ca,
          pose: { o: [W / 2, D - W / 2 + yMid * ca, H + m.rise - yMid * sa], u: [-1, 0, 0], v: [0, ca, -sa], n: [0, sa, ca] },
          marks: fbMarks,
        },
        {
          key: 'roof-left',
          pts: lrPts,
          width: D + 2 * ee,
          height: hs,
          slopeLen: W / 2 / ca,
          pose: { o: [W / 2 - yMid * ca, D / 2, H + m.rise - yMid * sa], u: [0, -1, 0], v: [-ca, 0, -sa], n: [-sa, 0, ca] },
          marks: lrMarks,
        },
        {
          key: 'roof-right',
          pts: lrPts,
          width: D + 2 * ee,
          height: hs,
          slopeLen: W / 2 / ca,
          pose: { o: [W / 2 + yMid * ca, D / 2, H + m.rise - yMid * sa], u: [0, 1, 0], v: [ca, 0, -sa], n: [sa, 0, ca] },
          marks: lrMarks,
        },
      ];
    }
  }

  // Pyramid roof: 4 triangles meeting at (W/2, D/2, H + rise), scaled uniformly from apex by k for level eaves overhang
  const k = 1 + (2 * ee) / Math.max(EPS, Math.min(W, D));
  const ay = Math.atan2(m.rise, D / 2);
  const ax = Math.atan2(m.rise, W / 2);
  const cay = Math.cos(ay),
    say = Math.sin(ay);
  const cax = Math.cos(ax),
    sax = Math.sin(ax);
  const hsy = k * Math.hypot(D / 2, m.rise);
  const hsx = k * Math.hypot(W / 2, m.rise);
  const fbW = k * W,
    lrW = k * D;
  const fbPts: [number, number][] = [[0, -hsy / 2], [fbW / 2, hsy / 2], [-fbW / 2, hsy / 2]];
  const lrPts: [number, number][] = [[0, -hsx / 2], [lrW / 2, hsx / 2], [-lrW / 2, hsx / 2]];
  const fbMarks = roofPatternMarks(fbPts, spec.pattern, spec.patternSize, 2);
  const lrMarks = roofPatternMarks(lrPts, spec.pattern, spec.patternSize, 2);
  return [
    {
      key: 'roof-front',
      pts: fbPts,
      width: fbW,
      height: hsy,
      slopeLen: Math.hypot(D / 2, m.rise),
      pose: { o: [W / 2, D / 2 - (hsy / 2) * cay, H + m.rise - (hsy / 2) * say], u: [1, 0, 0], v: [0, -cay, -say], n: [0, -say, cay] },
      marks: fbMarks,
    },
    {
      key: 'roof-back',
      pts: fbPts,
      width: fbW,
      height: hsy,
      slopeLen: Math.hypot(D / 2, m.rise),
      pose: { o: [W / 2, D / 2 + (hsy / 2) * cay, H + m.rise - (hsy / 2) * say], u: [-1, 0, 0], v: [0, cay, -say], n: [0, say, cay] },
      marks: fbMarks,
    },
    {
      key: 'roof-left',
      pts: lrPts,
      width: lrW,
      height: hsx,
      slopeLen: Math.hypot(W / 2, m.rise),
      pose: { o: [W / 2 - (hsx / 2) * cax, D / 2, H + m.rise - (hsx / 2) * sax], u: [0, -1, 0], v: [-cax, 0, -sax], n: [-sax, 0, cax] },
      marks: lrMarks,
    },
    {
      key: 'roof-right',
      pts: lrPts,
      width: lrW,
      height: hsx,
      slopeLen: Math.hypot(W / 2, m.rise),
      pose: { o: [W / 2 + (hsx / 2) * cax, D / 2, H + m.rise - (hsx / 2) * sax], u: [0, 1, 0], v: [cax, 0, -sax], n: [sax, 0, cax] },
      marks: lrMarks,
    },
  ];
}

/**
 * Attic roof trusses for removable gable roofs (and optional center truss for wide hip roofs).
 * Each truss sits strictly above eaves height Z = H inside the attic triangle, so it never collides with inner walls.
 */
export function buildRoofTrusses(W: number, D: number, H: number, t: number, spec: RoofSpec): TrussSpec[] {
  const m = computeRoofMetrics(W, D, H, t, spec);
  if (spec.type !== 'gable' || spec.mount !== 'removable') return [];
  if (m.rise < 2 * t) return [];

  const alongX = spec.ridgeAxis === 'x';
  const ridgeLen = alongX ? W : D;
  const outerSpan = alongX ? D : W;
  const innerSpan = outerSpan - 2 * t;
  if (innerSpan < 4 * t) return [];

  const heel = t * Math.tan(m.pitchRad);
  if (heel >= m.rise - t) return [];

  // Positions along ridge axis: right inside the two gable walls (at t + t/2 and ridgeLen - t - t/2), or 1 in center if narrow
  const positions = ridgeLen >= 5 * t ? [1.5 * t, ridgeLen - 1.5 * t] : ridgeLen >= 3 * t ? [ridgeLen / 2] : [];
  const half = innerSpan / 2;
  const h = m.rise;
  // Local centered coords: x ∈ [-half, half], y ∈ [-h/2, h/2] (y = -h/2 is peak Z=H+rise, y = h/2 is base Z=H)
  const pts: [number, number][] = [
    [0, -h / 2],
    [half, h / 2 - heel],
    [half, h / 2],
    [-half, h / 2],
    [-half, h / 2 - heel],
  ];

  return positions.map((at, idx): TrussSpec => {
    const key = positions.length > 1 ? `roof-truss-${idx + 1}` : 'roof-truss';
    // Pose: same convention as walls
    const pose: Pose = alongX
      ? { o: [at - t / 2, D / 2, H + h / 2], u: [0, -1, 0], v: [0, 0, -1], n: [1, 0, 0] }
      : { o: [W / 2, at - t / 2, H + h / 2], u: [1, 0, 0], v: [0, 0, -1], n: [0, 1, 0] };
    return {
      key,
      spanAxis: alongX ? 'y' : 'x',
      at,
      innerSpan,
      outerSpan,
      eavesZ: H,
      rise: h,
      pitchRad: m.pitchRad,
      heel,
      pts,
      pose,
    };
  });
}

/** Roof outline and ridge/hip lines in plan coordinates (inner rect is [0..w] × [0..d], outer walls at [-t..w+t] × [-t..d+t]) */
export function roofPlanLines(w: number, d: number, t: number, spec: RoofSpec): { outline: [number, number][]; ridges: [[number, number], [number, number]][] } {
  const W = w + 2 * t,
    D = d + 2 * t;
  const ee = spec.overhang;
  const eg = spec.type === 'gable' || spec.type === 'shed' ? spec.gableOverhang : ee;
  const ox = spec.type === 'gable' ? (spec.ridgeAxis === 'x' ? eg : ee) : spec.type === 'shed' ? (spec.shedDir === 'front' || spec.shedDir === 'back' ? eg : ee) : ee;
  const oy = spec.type === 'gable' ? (spec.ridgeAxis === 'x' ? ee : eg) : spec.type === 'shed' ? (spec.shedDir === 'front' || spec.shedDir === 'back' ? ee : eg) : ee;

  const x0 = -t - ox,
    x1 = w + t + ox,
    y0 = -t - oy,
    y1 = d + t + oy;
  const outline: [number, number][] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const ridges: [[number, number], [number, number]][] = [];
  const mx = w / 2,
    my = d / 2;

  if (spec.type === 'gable') {
    if (spec.ridgeAxis === 'x') ridges.push([[x0, my], [x1, my]]);
    else ridges.push([[mx, y0], [mx, y1]]);
  } else if (spec.type === 'hip') {
    if (W >= D) {
      const rx0 = -t + D / 2,
        rx1 = w + t - D / 2;
      if (rx1 > rx0 + EPS) ridges.push([[rx0, my], [rx1, my]]);
      ridges.push([[x0, y0], [rx0, my]], [[x0, y1], [rx0, my]], [[x1, y0], [rx1, my]], [[x1, y1], [rx1, my]]);
    } else {
      const ry0 = -t + W / 2,
        ry1 = d + t - W / 2;
      if (ry1 > ry0 + EPS) ridges.push([[mx, ry0], [mx, ry1]]);
      ridges.push([[x0, y0], [mx, ry0]], [[x1, y0], [mx, ry0]], [[x0, y1], [mx, ry1]], [[x1, y1], [mx, ry1]]);
    }
  } else if (spec.type === 'pyramid') {
    ridges.push([[x0, y0], [mx, my]], [[x1, y0], [mx, my]], [[x0, y1], [mx, my]], [[x1, y1], [mx, my]]);
  }
  return { outline, ridges };
}
