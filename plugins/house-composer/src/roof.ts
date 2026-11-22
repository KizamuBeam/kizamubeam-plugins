// Parametric roof geometry for the house composer: flat, gable, shed (pent), hip and pyramid roofs.
// Pure computation, no host functions, so it can be tested in Node.
//
// 3D assembly coordinates: X right (0..W), Y back (0..D), Z up (0 at bottom of floor).
// Every roof panel is returned in its own centered 2D plane (y down = ridge toward eaves) with outer face UP
// on the laser bed (−(u×v) = outward normal n), so engraved roof patterns always sit on the outside.
import type { Pose, SubPath, V3 } from '../../../sdk/ts';
import {
  ensureCCW,
  minExteriorBayGaps,
  offsetOrthoPoly,
  orthogonalStraightSkeleton,
  pointInPoly as skelPointInPoly,
  polyChordIntervals,
  type XY,
} from './skeleton';

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
  kind: 'gable' | 'hip-spine' | 'hip-cross' | 'pyramid';
  /** Axis the truss plane lies along ('y' spans D in YZ plane; 'x' spans W in XZ plane) */
  spanAxis: 'x' | 'y';
  /** Center position along the perpendicular axis (3D X if spanAxis='y', 3D Y if spanAxis='x') */
  at: number;
  /** Inner span (between the two opposite outer walls: D - 2t or W - 2t) */
  innerSpan: number;
  /** Full outer span (D or W) */
  outerSpan: number;
  /** Horizontal ridge length at top of truss (0 for triangle, |W-D| for hip spine) */
  topFlat: number;
  eavesZ: number;
  rise: number;
  pitchRad: number;
  /** Vertical heel height at inner wall face = t * tan(pitchRad) */
  heel: number;
  /** Half-lap intersections with perpendicular trusses (positions in 3D along spanAxis, measured from inner start) */
  laps: { offsetFromCenter: number; fromTop: boolean }[];
  /** Roof panels touched by left (smaller local x) and right (larger local x) slopes */
  leftRoofKey: string;
  rightRoofKey: string;
  /** Local x coordinate on leftRoofKey and rightRoofKey where tenon slots sit */
  leftRoofX: number;
  rightRoofX: number;
  /** Whether outer-wall saddle hooks should engage fixed outer walls at both ends */
  fixedHooks: boolean;
  /** Outline in local centered coords (x along spanAxis, y down from peak to eaves) */
  pts: [number, number][];
  pose: Pose;
}

export interface RoofRailSpec {
  key: string;
  /** Axis the rail spans along ('x' = width W, 'y' = depth D) */
  spanAxis: 'x' | 'y';
  /** Clear length of the rail (before any interior-wall shortening) */
  length: number;
  /** Height protruding perpendicular below roof underside */
  height: number;
  /** Roof panel key this rail tenons into */
  roofKey: string;
  /** Local y coordinate on roofKey (horizontal tenon line) or local x coordinate (vertical tenon line) */
  roofY: number;
  /** Whether the rail line runs along roof local X ('x') or roof local Y ('y') */
  roofAxis: 'x' | 'y';
  /** 3D center coordinate along the perpendicular axis (Y if spanAxis='x', X if spanAxis='y') */
  perpPos3D: number;
  /** 3D pose of the centered rail */
  pose: Pose;
}

const DEG = Math.PI / 180;
const EPS = 1e-6;

/** Per-axis roof overhang [ox, oy] along 3D X and Y */
export function roofOverhangXY(spec: RoofSpec): [number, number] {
  const ee = spec.overhang;
  const eg = spec.type === 'gable' || spec.type === 'shed' ? spec.gableOverhang : ee;
  const ox =
    spec.type === 'gable'
      ? spec.ridgeAxis === 'x'
        ? eg
        : ee
      : spec.type === 'shed'
        ? spec.shedDir === 'front' || spec.shedDir === 'back'
          ? eg
          : ee
        : ee;
  const oy =
    spec.type === 'gable'
      ? spec.ridgeAxis === 'x'
        ? ee
        : eg
      : spec.type === 'shed'
        ? spec.shedDir === 'front' || spec.shedDir === 'back'
          ? ee
          : eg
        : ee;
  return [ox, oy];
}

/** Compute roof rise, pitch angles, ridge length, eaves drop and overall height */
export function computeRoofMetrics(
  W: number,
  D: number,
  H: number,
  t: number,
  spec: RoofSpec,
  outerPoly3D?: XY[] | null,
): RoofMetrics {
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

  const isShaped = !!(outerPoly3D && outerPoly3D.length > 4);
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
  } else if (isShaped) {
    // Shaped hip / pyramid: use the exact orthogonal straight-skeleton half-span of the widest wing
    const skel = orthogonalStraightSkeleton(outerPoly3D!);
    run = Math.max(EPS, skel.maxS);
    ridgeAxis = W >= D ? 'x' : 'y';
    ridgeLength = skel.ridges.reduce((acc, r) => acc + (r.b - r.a), 0);
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
  if (spec.type === 'pyramid' && !isShaped) {
    const runLong = Math.max(W, D) / 2;
    pitchRad2 = runLong > EPS ? Math.atan2(rise, runLong) : pitchRad;
  }

  const eavesDrop =
    spec.type === 'pyramid' && !isShaped
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
export function validateRoof(
  W: number,
  D: number,
  H: number,
  t: number,
  spec: RoofSpec,
  isRectOutline: boolean,
  outerPoly3D?: XY[] | null,
): RoofIssue[] {
  const issues: RoofIssue[] = [];
  if (!isRectOutline && spec.type === 'pyramid') {
    issues.push({ key: 'roofType', level: 'warn', code: 'roof-pyramid-shaped' });
  }
  // On concave L/U footprints, ensure roof overhangs do not self-intersect across narrow courtyards/bays
  if (!isRectOutline && outerPoly3D && outerPoly3D.length > 4) {
    const [ox, oy] = roofOverhangXY(spec);
    const { gapX, gapY } = minExteriorBayGaps(outerPoly3D);
    const badX = ox > EPS && 2 * ox >= gapX - 1;
    const badY = oy > EPS && 2 * oy >= gapY - 1;
    if (badX || badY) {
      const lim = Math.min(badX ? gapX : Infinity, badY ? gapY : Infinity);
      const maxOv = Math.max(0, Math.floor((lim - 1) / 2));
      const key =
        (spec.type === 'gable' && ((badX && spec.ridgeAxis === 'x') || (badY && spec.ridgeAxis === 'y'))) ||
        (spec.type === 'shed' && ((badX && (spec.shedDir === 'front' || spec.shedDir === 'back')) || (badY && (spec.shedDir === 'left' || spec.shedDir === 'right'))))
          ? 'roofGableOverhang'
          : 'roofOverhang';
      issues.push({ key, level: 'error', code: 'roof-overhang-notch', values: { max: maxOv } });
    }
  }
  const m = computeRoofMetrics(W, D, H, t, spec, outerPoly3D);
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
 * Attic roof trusses:
 * - Removable gable roofs: 1–2 trusses inside gable walls so the roof lifts off as one rigid piece.
 * - Fixed gable roofs with a missing gable wall: 1 center support truss so the roof panels remain rigid.
 * - Hip & pyramid roofs (both fixed and removable): crossed internal truss skeleton interlocked with all 4 roof panels
 *   (and engaging the outer walls via saddle hooks when mount === 'fixed').
 * Every truss base sits at eaves height Z = H so it never collides with interior room walls.
 */
export function buildRoofTrusses(
  W: number,
  D: number,
  H: number,
  t: number,
  spec: RoofSpec,
  sides: Record<'x0' | 'x1' | 'y0' | 'y1', boolean> = { x0: true, x1: true, y0: true, y1: true },
): TrussSpec[] {
  const m = computeRoofMetrics(W, D, H, t, spec);
  if (spec.type === 'flat' || spec.type === 'shed') return [];

  const makePts = (innerSpan: number, h: number, heel: number, topFlat: number): [number, number][] => {
    const half = innerSpan / 2;
    const hf = topFlat / 2;
    return hf > EPS
      ? [[-hf, -h / 2], [hf, -h / 2], [half, h / 2 - heel], [half, h / 2], [-half, h / 2], [-half, h / 2 - heel]]
      : [[0, -h / 2], [half, h / 2 - heel], [half, h / 2], [-half, h / 2], [-half, h / 2 - heel]];
  };

  if (spec.type === 'gable') {
    const alongX = spec.ridgeAxis === 'x';
    const missingGable = alongX ? !sides.x0 || !sides.x1 : !sides.y0 || !sides.y1;
    if (spec.mount !== 'removable' && !missingGable) return [];
    if (m.rise < 2 * t) return [];

    const ridgeLen = alongX ? W : D;
    const outerSpan = alongX ? D : W;
    const innerSpan = outerSpan - 2 * t;
    if (innerSpan < 4 * t) return [];

    const heel = t * Math.tan(m.pitchRad);
    if (heel >= m.rise - t) return [];

    const positions =
      spec.mount === 'removable'
        ? ridgeLen >= 5 * t
          ? [1.5 * t, ridgeLen - 1.5 * t]
          : ridgeLen >= 3 * t
            ? [ridgeLen / 2]
            : []
        : ridgeLen >= 3 * t
          ? [ridgeLen / 2]
          : [];
    const h = m.rise;
    const pts = makePts(innerSpan, h, heel, 0);

    return positions.map((at, idx): TrussSpec => {
      const key = positions.length > 1 ? `roof-truss-${idx + 1}` : 'roof-truss';
      const pose: Pose = alongX
        ? { o: [at - t / 2, D / 2, H + h / 2], u: [0, -1, 0], v: [0, 0, -1], n: [1, 0, 0] }
        : { o: [W / 2, at - t / 2, H + h / 2], u: [1, 0, 0], v: [0, 0, -1], n: [0, 1, 0] };
      return {
        key,
        kind: 'gable',
        spanAxis: alongX ? 'y' : 'x',
        at,
        innerSpan,
        outerSpan,
        topFlat: 0,
        eavesZ: H,
        rise: h,
        pitchRad: m.pitchRad,
        heel,
        laps: [],
        leftRoofKey: alongX ? 'roof-back' : 'roof-left',
        rightRoofKey: alongX ? 'roof-front' : 'roof-right',
        leftRoofX: alongX ? W / 2 - at : D / 2 - at,
        rightRoofX: alongX ? at - W / 2 : at - D / 2,
        fixedHooks: false,
        pts,
        pose,
      };
    });
  }

  // Hip & Pyramid roofs: crossed internal truss skeleton
  const h = m.rise;
  if (h < 3 * t) return [];
  const innerW = W - 2 * t;
  const innerD = D - 2 * t;
  if (innerW < 4 * t || innerD < 4 * t) return [];

  const fixedHooks = spec.mount === 'fixed';

  if (spec.type === 'pyramid') {
    const ax = Math.atan2(h, W / 2);
    const ay = Math.atan2(h, D / 2);
    const heelX = t * Math.tan(ax);
    const heelY = t * Math.tan(ay);
    if (heelX >= h - 1.5 * t || heelY >= h - 1.5 * t) return [];

    // Ensure room for center half-lap slot with horizontal shoulder
    const sh = Math.min(1.5, t * 0.5);
    const yShoulder = (t / 2 + sh) * Math.tan(ax);
    if (h - yShoulder < 2 * Math.max(t, 2.5)) return [];

    return [
      {
        key: 'roof-truss-1',
        kind: 'pyramid',
        spanAxis: 'x',
        at: D / 2,
        innerSpan: innerW,
        outerSpan: W,
        topFlat: 0,
        eavesZ: H,
        rise: h,
        pitchRad: ax,
        heel: heelX,
        laps: [{ offsetFromCenter: 0, fromTop: true }],
        leftRoofKey: 'roof-left',
        rightRoofKey: 'roof-right',
        leftRoofX: 0,
        rightRoofX: 0,
        fixedHooks,
        pts: makePts(innerW, h, heelX, 0),
        pose: { o: [W / 2, D / 2 - t / 2, H + h / 2], u: [1, 0, 0], v: [0, 0, -1], n: [0, 1, 0] },
      },
      {
        key: 'roof-truss-2',
        kind: 'pyramid',
        spanAxis: 'y',
        at: W / 2,
        innerSpan: innerD,
        outerSpan: D,
        topFlat: 0,
        eavesZ: H,
        rise: h,
        pitchRad: ay,
        heel: heelY,
        laps: [{ offsetFromCenter: 0, fromTop: false }],
        leftRoofKey: 'roof-back',
        rightRoofKey: 'roof-front',
        leftRoofX: 0,
        rightRoofX: 0,
        fixedHooks,
        pts: makePts(innerD, h, heelY, 0),
        pose: { o: [W / 2 - t / 2, D / 2, H + h / 2], u: [0, -1, 0], v: [0, 0, -1], n: [1, 0, 0] },
      },
    ];
  }

  // Hip roof: 1 longitudinal spine truss (trapezoid along ridge) + 1 or 2 perpendicular cross trusses
  const alongX = W >= D;
  const long = alongX ? W : D;
  const short = alongX ? D : W;
  const Lr = Math.max(0, long - short);
  const heel = t * Math.tan(m.pitchRad);
  if (heel >= h - 1.5 * t) return [];

  const sh = Math.min(1.5, t * 0.5);
  const minHalfTop = t / 2 + sh;
  const yShoulder = Lr / 2 < minHalfTop ? (minHalfTop - Lr / 2) * Math.tan(m.pitchRad) : 0;
  if (h - yShoulder < 2 * Math.max(t, 2.5)) return [];

  const crossPositions = Lr >= 7 * t ? [short / 2 + 1.5 * t, long - short / 2 - 1.5 * t] : [long / 2];
  const spineInner = long - 2 * t;
  const crossInner = short - 2 * t;

  const spineLaps = crossPositions.map((pos) => ({
    offsetFromCenter: alongX ? pos - W / 2 : D / 2 - pos,
    fromTop: true,
  }));

  const out: TrussSpec[] = [
    {
      key: 'roof-truss-1',
      kind: 'hip-spine',
      spanAxis: alongX ? 'x' : 'y',
      at: alongX ? D / 2 : W / 2,
      innerSpan: spineInner,
      outerSpan: long,
      topFlat: Lr,
      eavesZ: H,
      rise: h,
      pitchRad: m.pitchRad,
      heel,
      laps: spineLaps,
      leftRoofKey: alongX ? 'roof-left' : 'roof-back',
      rightRoofKey: alongX ? 'roof-right' : 'roof-front',
      leftRoofX: 0,
      rightRoofX: 0,
      fixedHooks,
      pts: makePts(spineInner, h, heel, Lr),
      pose: alongX
        ? { o: [W / 2, D / 2 - t / 2, H + h / 2], u: [1, 0, 0], v: [0, 0, -1], n: [0, 1, 0] }
        : { o: [W / 2 - t / 2, D / 2, H + h / 2], u: [0, -1, 0], v: [0, 0, -1], n: [1, 0, 0] },
    },
  ];

  crossPositions.forEach((pos, idx) => {
    out.push({
      key: `roof-truss-${idx + 2}`,
      kind: 'hip-cross',
      spanAxis: alongX ? 'y' : 'x',
      at: pos,
      innerSpan: crossInner,
      outerSpan: short,
      topFlat: 0,
      eavesZ: H,
      rise: h,
      pitchRad: m.pitchRad,
      heel,
      laps: [{ offsetFromCenter: 0, fromTop: false }],
      leftRoofKey: alongX ? 'roof-back' : 'roof-left',
      rightRoofKey: alongX ? 'roof-front' : 'roof-right',
      leftRoofX: alongX ? W / 2 - pos : D / 2 - pos,
      rightRoofX: alongX ? pos - W / 2 : pos - D / 2,
      fixedHooks,
      pts: makePts(crossInner, h, heel, 0),
      pose: alongX
        ? { o: [pos - t / 2, D / 2, H + h / 2], u: [0, -1, 0], v: [0, 0, -1], n: [1, 0, 0] }
        : { o: [W / 2, pos - t / 2, H + h / 2], u: [1, 0, 0], v: [0, 0, -1], n: [0, 1, 0] },
    });
  });

  return out;
}

/**
 * Underside positioning rails / stop cleats for removable flat and shed roofs so lift-off roofs
 * self-center cleanly on the walls and cannot slide off (especially sloped shed roofs!).
 */
export function buildRoofRails(
  W: number,
  D: number,
  H: number,
  t: number,
  floor: boolean,
  sides: Record<'x0' | 'x1' | 'y0' | 'y1', boolean>,
  spec: RoofSpec,
): RoofRailSpec[] {
  if (spec.mount !== 'removable' || (spec.type !== 'flat' && spec.type !== 'shed')) return [];
  const floorZ = floor ? t : 0;
  const clearH = H - floorZ;
  if (clearH < 3 * t) return [];
  const railH = Math.min(2 * t, 6, Math.max(t, clearH * 0.25));
  const slip = 0.3;

  if (spec.type === 'flat') {
    if (sides.y0 && sides.y1 && W - 2 * t >= 4 * t && D - 2 * t >= 5 * t) {
      const length = W - 2 * t - 2 * slip;
      const yBack = D - t - slip - t / 2;
      const yFront = t + slip + t / 2;
      return [
        {
          key: 'roof-rail-1',
          spanAxis: 'x',
          length,
          height: railH,
          roofKey: 'roof',
          roofY: D / 2 - yBack,
          roofAxis: 'x',
          perpPos3D: yBack,
          pose: { o: [W / 2, yBack - t / 2, H - railH / 2], u: [1, 0, 0], v: [0, 0, -1], n: [0, 1, 0] },
        },
        {
          key: 'roof-rail-2',
          spanAxis: 'x',
          length,
          height: railH,
          roofKey: 'roof',
          roofY: D / 2 - yFront,
          roofAxis: 'x',
          perpPos3D: yFront,
          pose: { o: [W / 2, yFront - t / 2, H - railH / 2], u: [1, 0, 0], v: [0, 0, -1], n: [0, 1, 0] },
        },
      ];
    }
    if (sides.x0 && sides.x1 && D - 2 * t >= 4 * t && W - 2 * t >= 5 * t) {
      const length = D - 2 * t - 2 * slip;
      const xLeft = t + slip + t / 2;
      const xRight = W - t - slip - t / 2;
      return [
        {
          key: 'roof-rail-1',
          spanAxis: 'y',
          length,
          height: railH,
          roofKey: 'roof',
          roofY: xLeft - W / 2,
          roofAxis: 'y',
          perpPos3D: xLeft,
          pose: { o: [xLeft - t / 2, D / 2, H - railH / 2], u: [0, -1, 0], v: [0, 0, -1], n: [1, 0, 0] },
        },
        {
          key: 'roof-rail-2',
          spanAxis: 'y',
          length,
          height: railH,
          roofKey: 'roof',
          roofY: xRight - W / 2,
          roofAxis: 'y',
          perpPos3D: xRight,
          pose: { o: [xRight - t / 2, D / 2, H - railH / 2], u: [0, -1, 0], v: [0, 0, -1], n: [1, 0, 0] },
        },
      ];
    }
    return [];
  }

  // Removable shed roof: perpendicular stop cleats inside the low wall (stops downhill sliding!) and high wall
  const m = computeRoofMetrics(W, D, H, t, spec);
  const alongY = spec.shedDir === 'front' || spec.shedDir === 'back';
  const run = alongY ? D : W;
  const cross = alongY ? W : D;
  if (cross - 2 * t < 4 * t || run - 2 * t < 4 * t) return [];

  const ca = Math.cos(m.pitchRad),
    sa = Math.sin(m.pitchRad);
  const Ls = run / ca;
  const length = cross - 2 * t - 2 * slip;
  const yLow = Ls / 2 - (t + slip) / ca - t / 2;
  const yHigh = -Ls / 2 + (t + slip + railH * sa) / ca + t / 2;

  const sideOn: Record<OuterWallKey, boolean> = { front: sides.y1, back: sides.y0, left: sides.x0, right: sides.x1 };
  const opp: Record<OuterWallKey, OuterWallKey> = { front: 'back', back: 'front', left: 'right', right: 'left' };
  const ro: V3 = [W / 2, D / 2, H + m.rise / 2];
  const basis: Record<OuterWallKey, { u: V3; v: V3; n: V3 }> = {
    front: { u: [1, 0, 0], v: [0, -ca, -sa], n: [0, -sa, ca] },
    back: { u: [-1, 0, 0], v: [0, ca, -sa], n: [0, sa, ca] },
    left: { u: [0, -1, 0], v: [-ca, 0, -sa], n: [-sa, 0, ca] },
    right: { u: [0, 1, 0], v: [ca, 0, -sa], n: [sa, 0, ca] },
  };
  const b = basis[spec.shedDir];

  const makeCleat = (key: string, yc: number): RoofRailSpec => {
    const o: V3 = [
      ro[0] + (yc - t / 2) * b.v[0] - (railH / 2) * b.n[0],
      ro[1] + (yc - t / 2) * b.v[1] - (railH / 2) * b.n[1],
      ro[2] + (yc - t / 2) * b.v[2] - (railH / 2) * b.n[2],
    ];
    const perpPos3D = alongY ? ro[1] + yc * b.v[1] : ro[0] + yc * b.v[0];
    return {
      key,
      spanAxis: alongY ? 'x' : 'y',
      length,
      height: railH,
      roofKey: 'roof',
      roofY: yc,
      roofAxis: 'x',
      perpPos3D,
      pose: {
        o,
        u: b.u,
        v: [-b.n[0], -b.n[1], -b.n[2]],
        n: b.v,
      },
    };
  };

  const candidates: number[] = [];
  if (sideOn[spec.shedDir] && yLow > -Ls / 2 + t && yLow < Ls / 2 - t) candidates.push(yLow);
  if (sideOn[opp[spec.shedDir]] && yHigh > -Ls / 2 + t && yHigh < Ls / 2 - t && (!candidates.length || yLow - yHigh >= 2.5 * t)) {
    candidates.push(yHigh);
  }
  return candidates.map((yc, idx) => makeCleat(candidates.length > 1 ? `roof-rail-${idx + 1}` : 'roof-rail', yc));
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

export type ChimneyPos = 'left' | 'center' | 'right';

export interface ChimneySpec {
  enabled: boolean;
  pos: ChimneyPos;
  size: number;
}

export interface ChimneyGeom {
  roofKey: string;
  /** 3D center (X, Y) of the vertical chimney shaft */
  cx: number;
  cy: number;
  /** Square outer width of the chimney shaft */
  size: number;
  /** Vertical Z bounds of the 4 finger-jointed chimney walls */
  zBot: number;
  zTop: number;
  /** Exact rectangular cutout [x0, y0, x1, y1] in roofKey local coordinates (accounts for roof tilt & thickness) */
  holeBox: [number, number, number, number];
}

/** Compute exact 3D placement and tilted roof cutout for an optional chimney on gable, shed, or flat roofs */
export function buildChimneyGeom(
  W: number,
  D: number,
  H: number,
  t: number,
  floor: boolean,
  spec: RoofSpec,
  roofPanels: RoofPanelGeom[],
  chimney: ChimneySpec,
  clearance = 0,
): ChimneyGeom | null {
  if (!chimney.enabled) return null;
  if (spec.type !== 'gable' && spec.type !== 'shed' && spec.type !== 'flat') return null;

  const m = computeRoofMetrics(W, D, H, t, spec);
  const S = chimney.size;
  const cl = Math.max(0, clearance);
  const ca = Math.cos(m.pitchRad);
  const tanA = Math.tan(m.pitchRad);
  const posSign = chimney.pos === 'left' ? -1 : chimney.pos === 'right' ? 1 : 0;

  let roofKey = 'roof';
  let xr = 0;
  let yr = 0;
  let cx = W / 2;
  let cy = D / 2;
  let cz = H;

  const rpByKey = new Map(roofPanels.map((r) => [r.key, r]));

  if (spec.type === 'flat') {
    const rp = rpByKey.get('roof');
    if (!rp) return null;
    const maxOffX = Math.max(0, W / 2 - 2 * t - S / 2 - 4);
    xr = posSign * Math.min(W * 0.24, maxOffX);
    yr = -Math.min(D * 0.16, Math.max(0, D / 2 - 2 * t - S / 2 - 4));
    cx = W / 2 + xr;
    cy = D / 2 - yr;
    cz = m.flushFlat ? H - t : H;
  } else if (spec.type === 'gable') {
    if (spec.ridgeAxis === 'x') {
      roofKey = 'roof-front';
      const rp = rpByKey.get(roofKey);
      if (!rp) return null;
      const maxOffX = Math.max(0, W / 2 - 2 * t - S / 2 - 4);
      xr = posSign * Math.min(W * 0.24, maxOffX);
      const dRidge = Math.max(S / 2 + t * tanA + 2, Math.min(D * 0.22, D / 2 - t - S / 2 - 3));
      yr = -rp.height / 2 + dRidge / ca;
      cx = W / 2 + xr;
      cy = D / 2 - dRidge;
      cz = H + m.rise - dRidge * tanA;
    } else {
      roofKey = 'roof-right';
      const rp = rpByKey.get(roofKey);
      if (!rp) return null;
      const maxOffY = Math.max(0, D / 2 - 2 * t - S / 2 - 4);
      xr = posSign * Math.min(D * 0.24, maxOffY);
      const dRidge = Math.max(S / 2 + t * tanA + 2, Math.min(W * 0.22, W / 2 - t - S / 2 - 3));
      yr = -rp.height / 2 + dRidge / ca;
      cx = W / 2 + dRidge;
      cy = D / 2 + xr;
      cz = H + m.rise - dRidge * tanA;
    }
  } else {
    // Shed roof
    const rp = rpByKey.get('roof');
    if (!rp) return null;
    const alongY = spec.shedDir === 'front' || spec.shedDir === 'back';
    const cross = alongY ? W : D;
    const maxOffU = Math.max(0, cross / 2 - 2 * t - S / 2 - 4);
    xr = posSign * Math.min(cross * 0.24, maxOffU);
    // Sit slightly uphill from roof midpoint (clear of both high-wall & low-wall removable cleats!)
    yr = -rp.slopeLen * 0.14;
    const po = rp.pose;
    cx = po.o[0] + xr * po.u[0] + yr * po.v[0];
    cy = po.o[1] + xr * po.u[1] + yr * po.v[1];
    cz = po.o[2] + xr * po.u[2] + yr * po.v[2];
  }

  const hw = (S + cl) / 2;
  const yTopHole = yr - S / (2 * ca) - t * tanA - cl / 2;
  const yBotHole = yr + S / (2 * ca) + cl / 2;

  const floorZ = floor ? t : 0;
  const zLow = cz - (S / 2) * tanA;
  const zHigh = cz + (S / 2) * tanA;
  const zBot = Math.max(floorZ + 2, Math.min(zLow - t / ca - 1.5, spec.type === 'flat' ? cz - t - 2 : zLow - t / ca - 1.5));
  const zTop = Math.max(H + m.rise + Math.max(8, S * 0.6), zHigh + Math.max(10, S * 0.75));

  return {
    roofKey,
    cx,
    cy,
    size: S,
    zBot,
    zTop,
    holeBox: [xr - hw, yTopHole, xr + hw, yBotHole],
  };
}

/** Check whether a 3D square [cx-r .. cx+r] × [cy-r .. cy+r] lies strictly inside an orthogonal polygon */
function boxInsideOrthoPoly(poly: XY[], cx: number, cy: number, r: number): boolean {
  const pts: XY[] = [
    [cx, cy],
    [cx - r, cy - r],
    [cx + r, cy - r],
    [cx + r, cy + r],
    [cx - r, cy + r],
    [cx, cy - r],
    [cx, cy + r],
    [cx - r, cy],
    [cx + r, cy],
  ];
  for (const [px, py] of pts) {
    if (!skelPointInPoly(poly, px, py)) return false;
  }
  // Ensure no polygon edge crosses the box interior
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % n];
    if (Math.abs(y0 - y1) < EPS) {
      if (y0 > cy - r && y0 < cy + r && Math.max(x0, x1) > cx - r && Math.min(x0, x1) < cx + r) return false;
    } else {
      if (x0 > cx - r && x0 < cx + r && Math.max(y0, y1) > cy - r && Math.min(y0, y1) < cy + r) return false;
    }
  }
  return true;
}

/** Find a valid 3D chimney center (cx, cy) inside a shaped L/U/C footprint for flat, shed, or gable roofs */
export function findShapedChimneySpot(
  outerPoly3D: XY[],
  W: number,
  D: number,
  H: number,
  t: number,
  spec: RoofSpec,
  chimney: ChimneySpec,
): { cx: number; cy: number; cz: number } | null {
  if (!chimney.enabled || (spec.type !== 'flat' && spec.type !== 'shed' && spec.type !== 'gable')) return null;
  const poly = ensureCCW(outerPoly3D);
  const m = computeRoofMetrics(W, D, H, t, spec, poly);
  const tanA = Math.tan(m.pitchRad);
  const S = chimney.size;
  const rClear = S / 2 + t + 2;
  const targetFrac = chimney.pos === 'left' ? 0.25 : chimney.pos === 'right' ? 0.75 : 0.5;
  const targetX = W * targetFrac;
  const targetY = D * 0.5;

  let best: { cx: number; cy: number; score: number } | null = null;
  const step = Math.max(2, Math.min(4, S / 4));
  for (let cx = rClear; cx <= W - rClear + EPS; cx += step) {
    for (let cy = rClear; cy <= D - rClear + EPS; cy += step) {
      if (!boxInsideOrthoPoly(poly, cx, cy, rClear)) continue;
      // On gable roofs, keep chimney cleanly on one slope (clear of the ridge line!)
      if (spec.type === 'gable') {
        const ridgeClear = S / 2 + t * tanA + 2.5;
        if (spec.ridgeAxis === 'x' && Math.abs(cy - D / 2) < ridgeClear) continue;
        if (spec.ridgeAxis === 'y' && Math.abs(cx - W / 2) < ridgeClear) continue;
      }
      const dist = Math.hypot(cx - targetX, (cy - targetY) * 0.6);
      if (!best || dist < best.score) best = { cx, cy, score: dist };
    }
  }
  if (!best) return null;

  let cz = m.flushFlat ? H - t : H;
  if (spec.type === 'shed') {
    const s =
      spec.shedDir === 'front'
        ? best.cy
        : spec.shedDir === 'back'
          ? D - best.cy
          : spec.shedDir === 'left'
            ? best.cx
            : W - best.cx;
    cz = H + s * tanA;
  } else if (spec.type === 'gable') {
    const dEaves = spec.ridgeAxis === 'x' ? Math.min(best.cy, D - best.cy) : Math.min(best.cx, W - best.cx);
    cz = H + dEaves * tanA;
  }
  return { cx: best.cx, cy: best.cy, cz };
}

/** Compute exact chimney geometry on a shaped L/U/C footprint against the built shaped roof panels */
export function buildShapedChimneyGeom(
  outerPoly3D: XY[],
  W: number,
  D: number,
  H: number,
  t: number,
  floor: boolean,
  spec: RoofSpec,
  roofPanels: RoofPanelGeom[],
  chimney: ChimneySpec,
  clearance = 0,
): ChimneyGeom | null {
  const spot = findShapedChimneySpot(outerPoly3D, W, D, H, t, spec, chimney);
  if (!spot) return null;
  const m = computeRoofMetrics(W, D, H, t, spec, outerPoly3D);
  const S = chimney.size;
  const cl = Math.max(0, clearance);
  const ca = Math.cos(m.pitchRad);
  const tanA = Math.tan(m.pitchRad);

  // Project 3D spot (cx, cy, cz) onto each roof panel and find the one whose 2D polygon contains it
  for (const rp of roofPanels) {
    if (!rp.pts.length) continue;
    const po = rp.pose;
    const dx = spot.cx - po.o[0];
    const dy = spot.cy - po.o[1];
    const dz = spot.cz - po.o[2];
    const distPlane = Math.abs(dx * po.n[0] + dy * po.n[1] + dz * po.n[2]);
    if (distPlane > 0.5) continue;
    const xr = dx * po.u[0] + dy * po.u[1] + dz * po.u[2];
    const yr = dx * po.v[0] + dy * po.v[1] + dz * po.v[2];
    if (!skelPointInPoly(rp.pts, xr, yr)) continue;

    const hw = (S + cl) / 2;
    const yTopHole = yr - S / (2 * ca) - t * tanA - cl / 2;
    const yBotHole = yr + S / (2 * ca) + cl / 2;
    const floorZ = floor ? t : 0;
    const zLow = spot.cz - (S / 2) * tanA;
    const zHigh = spot.cz + (S / 2) * tanA;
    const zBot = Math.max(floorZ + 2, zLow - t / ca - 1.5);
    const zTop = Math.max(H + m.rise + Math.max(8, S * 0.6), zHigh + Math.max(10, S * 0.75));
    return {
      roofKey: rp.key,
      cx: spot.cx,
      cy: spot.cy,
      size: S,
      zBot,
      zTop,
      holeBox: [xr - hw, yTopHole, xr + hw, yBotHole],
    };
  }
  return null;
}

/** Roof overhang outline & ridge/hip/valley lines in Plan view coordinates for a shaped L/U/C footprint */
export function roofPlanLinesShaped(
  outerPoly3D: XY[],
  W: number,
  D: number,
  t: number,
  spec: RoofSpec,
): { outline: [number, number][]; ridges: [[number, number], [number, number]][] } {
  const poly = ensureCCW(outerPoly3D);
  const toPlan = ([X, Y]: XY): [number, number] => [X - t, D - t - Y];
  const [ox, oy] = roofOverhangXY(spec);
  const { gapX, gapY } = minExteriorBayGaps(poly);
  const safeOx = ox > EPS && 2 * ox < gapX - 1 ? ox : 0;
  const safeOy = oy > EPS && 2 * oy < gapY - 1 ? oy : 0;
  const eavesPoly = offsetOrthoPoly(poly, safeOx, safeOy);
  const outline = eavesPoly.map(toPlan);
  const ridges: [[number, number], [number, number]][] = [];

  if (spec.type === 'gable') {
    const axis = spec.ridgeAxis;
    const at = axis === 'x' ? D / 2 : W / 2;
    const ivs = polyChordIntervals(eavesPoly, axis, at);
    for (const [a, b] of ivs) {
      ridges.push(axis === 'x' ? [toPlan([a, at]), toPlan([b, at])] : [toPlan([at, a]), toPlan([at, b])]);
    }
  } else if (spec.type === 'hip' || spec.type === 'pyramid') {
    const sk = orthogonalStraightSkeleton(eavesPoly);
    for (const r of sk.ridges) {
      ridges.push(
        r.axis === 'x' ? [toPlan([r.a, r.at]), toPlan([r.b, r.at])] : [toPlan([r.at, r.a]), toPlan([r.at, r.b])],
      );
    }
    for (const [a, b] of sk.diagonals) {
      ridges.push([toPlan(a), toPlan(b)]);
    }
  }
  return { outline, ridges };
}

/** Validate chimney size and clearance inside its host roof panel */
export function validateChimney(
  W: number,
  D: number,
  H: number,
  t: number,
  floor: boolean,
  spec: RoofSpec,
  chimney: ChimneySpec,
  isRectOutline: boolean,
  clearance = 0,
  outerPoly3D?: XY[] | null,
): RoofIssue[] {
  if (!chimney.enabled) return [];
  if (spec.type !== 'gable' && spec.type !== 'shed' && spec.type !== 'flat') return [];

  const minS = Math.max(10, Math.ceil(3.2 * t));
  if (chimney.size < minS) {
    return [{ key: 'chimneySize', level: 'error', code: 'chimney-small', values: { min: minS } }];
  }

  if (!isRectOutline) {
    if (!outerPoly3D || outerPoly3D.length < 4) return [];
    const spot = findShapedChimneySpot(outerPoly3D, W, D, H, t, spec, chimney);
    if (!spot) return [{ key: 'chimneySize', level: 'error', code: 'chimney-no-space' }];
    return [];
  }

  const panels = buildRoofPanels(W, D, H, t, spec);
  const g = buildChimneyGeom(W, D, H, t, floor, spec, panels, chimney, clearance);
  if (!g) return [];
  const rp = panels.find((p) => p.key === g.roofKey);
  if (!rp) return [];

  const [x0, y0, x1, y1] = g.holeBox;
  const pad = t + 2;
  const maxX = rp.width / 2 - pad;
  const maxY = rp.height / 2 - pad;
  // Also keep chimney shaft inside the house's inner footprint [t+1..W-t-1] × [t+1..D-t-1]
  const inHouse =
    g.cx - g.size / 2 >= t + 1 &&
    g.cx + g.size / 2 <= W - t - 1 &&
    g.cy - g.size / 2 >= t + 1 &&
    g.cy + g.size / 2 <= D - t - 1;
  if (!inHouse || x0 < -maxX || x1 > maxX || y0 < -maxY || y1 > maxY) {
    return [{ key: 'chimneySize', level: 'error', code: 'chimney-no-space' }];
  }
  return [];
}

