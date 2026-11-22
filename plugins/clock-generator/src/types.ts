import { K, type Node, type Params, type Pt, type SubPath } from '../../../sdk/ts';

export type ClockShape =
  | 'circle'
  | 'square'
  | 'rectangle'
  | 'oval'
  | 'octagon'
  | 'hexagon'
  | 'dodecagon'
  | 'arch'
  | 'squircle'
  | 'scalloped';

export type BackplateCenter = 'none' | 'shaft' | 'movement';

export type DialStyle =
  | 'classic'
  | 'quarters'
  | 'roman'
  | 'romanQuarters'
  | 'minimal'
  | 'station'
  | 'skeleton';

export type NumeralMode = 'engrave' | 'engraveStroke' | 'cutout';

export type FontFamily = 'sans' | 'serif' | 'rounded' | 'artdeco' | 'slab' | 'technical';

export type BridgeCount = 'auto' | '1' | '2';
export type BridgeDirection = 'shortest' | 'vertical' | 'horizontal';

export type TickMode = 'hoursAndMinutes' | 'hours' | 'quarters' | 'minutesOnly' | 'none';
export type TickStyle = 'line' | 'bar' | 'taper' | 'dot' | 'cutout';
export type ChapterRing = 'none' | 'outer' | 'inner' | 'double';

export type HandStyle =
  | 'baton'
  | 'dauphine'
  | 'spade'
  | 'breguet'
  | 'railway'
  | 'arrow'
  | 'leaf'
  | 'cathedral';

export interface ClockParams extends Params {
  // Step 1: Shape & Dimensions
  shape: ClockShape;
  diameter: number;
  width: number;
  height: number;
  cornerRadius: number;
  thickness: number;
  shaftDia: number;

  // Step 2: Backplate & Spacer Rings
  backplate: boolean;
  backplateCenter: BackplateCenter;
  movementSize: number;
  hangerHole: boolean;
  ringCount: number;
  ringWidth: number;
  glueMarks: boolean;

  // Step 3: Dial & Numerals
  dialStyle: DialStyle;
  numeralMode: NumeralMode;
  font: FontFamily;
  numeralSize: number;
  numeralRadiusPct: number;
  rotateNumerals: boolean;
  bridgeWidth: number;
  bridgeCount: BridgeCount;
  bridgeDirection: BridgeDirection;
  skeletonSpokes: number;
  skeletonHubDia: number;

  // Step 4: Tick Marks & Chapter Ring
  tickMode: TickMode;
  tickStyle: TickStyle;
  tickInset: number;
  hourTickLength: number;
  hourTickWidth: number;
  minuteTickLength: number;
  minuteTickWidth: number;
  quarterAccent: boolean;
  chapterRing: ChapterRing;

  // Step 5: Clock Hands
  includeHands: boolean;
  handStyle: HandStyle;
  includeSecondHand: boolean;
  handWidth: number;
  hourHandPct: number;
  minuteHandPct: number;
  hourHoleDia: number;
  minuteHoleDia: number;
  secondHoleDia: number;
}

export const SYMMETRIC_SHAPES = new Set<ClockShape>([
  'circle',
  'square',
  'octagon',
  'hexagon',
  'dodecagon',
  'squircle',
  'scalloped',
]);

export const HAS_NUMERALS_STYLE = new Set<DialStyle>([
  'classic',
  'quarters',
  'roman',
  'romanQuarters',
  'skeleton',
]);

/** Create an open straight line segment */
export const line = (x1: number, y1: number, x2: number, y2: number): SubPath => ({
  closed: false,
  nodes: [
    { x: x1, y: y1 },
    { x: x2, y: y2 },
  ],
});

/** Closed smooth ellipse around (cx, cy) with radii rx, ry and cubic handle factor k (K = true ellipse) */
export function ellipse(cx: number, cy: number, rx: number, ry: number, k = K, ccw = false): SubPath {
  const kx = rx * k;
  const ky = ry * k;
  const n = (x: number, y: number, ix: number, iy: number, ox: number, oy: number): Node => ({
    x,
    y,
    cin: { x: ix, y: iy },
    cout: { x: ox, y: oy },
    smooth: true,
  });
  if (ccw) {
    return {
      closed: true,
      nodes: [
        n(cx + rx, cy, cx + rx, cy + ky, cx + rx, cy - ky),
        n(cx, cy - ry, cx + kx, cy - ry, cx - kx, cy - ry),
        n(cx - rx, cy, cx - rx, cy - ky, cx - rx, cy + ky),
        n(cx, cy + ry, cx - kx, cy + ry, cx + kx, cy + ry),
      ],
    };
  }
  return {
    closed: true,
    nodes: [
      n(cx + rx, cy, cx + rx, cy - ky, cx + rx, cy + ky),
      n(cx, cy + ry, cx + kx, cy + ry, cx - kx, cy + ry),
      n(cx - rx, cy, cx - rx, cy + ky, cx - rx, cy - ky),
      n(cx, cy - ry, cx - kx, cy - ry, cx + kx, cy - ry),
    ],
  };
}

/** Reverse the winding direction of a SubPath (preserving Bézier handles) */
export function reverseSub(s: SubPath): SubPath {
  const nodes: Node[] = [];
  for (let i = s.nodes.length - 1; i >= 0; i--) {
    const a = s.nodes[i];
    const nd: Node = { x: a.x, y: a.y };
    if (a.cout) nd.cin = { x: a.cout.x, y: a.cout.y };
    if (a.cin) nd.cout = { x: a.cin.x, y: a.cin.y };
    if (a.smooth) nd.smooth = true;
    nodes.push(nd);
  }
  return { closed: s.closed, nodes };
}

/** Affine transform on a point: scale -> rotate (radians CW in y-down) -> translate */
function xformPt(p: Pt, tx: number, ty: number, scale: number, cos: number, sin: number): Pt {
  const sx = p.x * scale;
  const sy = p.y * scale;
  return {
    x: tx + sx * cos - sy * sin,
    y: ty + sx * sin + sy * cos,
  };
}

/** Transform a SubPath by scale, clockwise angle (radians), and translation */
export function transformSub(s: SubPath, tx: number, ty: number, scale = 1, angleRad = 0): SubPath {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return {
    closed: s.closed,
    nodes: s.nodes.map((nd) => {
      const p = xformPt(nd, tx, ty, scale, cos, sin);
      const out: Node = { x: p.x, y: p.y };
      if (nd.cin) out.cin = xformPt(nd.cin, tx, ty, scale, cos, sin);
      if (nd.cout) out.cout = xformPt(nd.cout, tx, ty, scale, cos, sin);
      if (nd.smooth) out.smooth = true;
      return out;
    }),
  };
}

/** Translate a SubPath by (dx, dy) */
export function translateSub(s: SubPath, dx: number, dy: number): SubPath {
  if (dx === 0 && dy === 0) return s;
  return {
    closed: s.closed,
    nodes: s.nodes.map((nd) => {
      const out: Node = { x: nd.x + dx, y: nd.y + dy };
      if (nd.cin) out.cin = { x: nd.cin.x + dx, y: nd.cin.y + dy };
      if (nd.cout) out.cout = { x: nd.cout.x + dx, y: nd.cout.y + dy };
      if (nd.smooth) out.smooth = true;
      return out;
    }),
  };
}

/** Flatten a SubPath into polygon vertices (sampling cubic Béziers) */
export function flattenSub(s: SubPath, steps = 16): Pt[] {
  const out: Pt[] = [];
  const n = s.nodes.length;
  for (let i = 0; i < n; i++) {
    const a = s.nodes[i];
    const b = s.nodes[(i + 1) % n];
    out.push({ x: a.x, y: a.y });
    if (i === n - 1 && !s.closed) break;
    if (!a.cout && !b.cin) continue;
    const c1 = a.cout ?? a;
    const c2 = b.cin ?? b;
    for (let k = 1; k < steps; k++) {
      const t = k / steps;
      const u = 1 - t;
      out.push({
        x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
        y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
      });
    }
  }
  return out;
}

/** Signed area of a closed polygon (>0 = CW in y-down coords) */
export function signedArea(pts: Pt[]): number {
  let s = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    s += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  }
  return s / 2;
}

export const polyArea = (pts: Pt[]): number => Math.abs(signedArea(pts));

/** Ray-casting point-in-polygon check */
export function pointInPoly(poly: Pt[], q: Pt): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j];
    const b = poly[i];
    if (a.y > q.y !== b.y > q.y && q.x < a.x + ((q.y - a.y) * (b.x - a.x)) / (b.y - a.y)) c = !c;
  }
  return c;
}

/** Bounding box of a point list */
export function bbox(pts: Pt[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const q of pts) {
    if (q.x < x0) x0 = q.x;
    if (q.y < y0) y0 = q.y;
    if (q.x > x1) x1 = q.x;
    if (q.y > y1) y1 = q.y;
  }
  return { x0, y0, x1, y1 };
}

/** Round sharp corners of a closed polygon into smooth circular-arc Bézier corners */
export function roundedPoly(pts: [number, number][], radius: number): SubPath {
  const n = pts.length;
  if (radius <= 0 || n < 3) {
    return { closed: true, nodes: pts.map(([x, y]) => ({ x, y })) };
  }
  const nodes: Node[] = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const curr = pts[i];
    const next = pts[(i + 1) % n];
    const vx1 = prev[0] - curr[0];
    const vy1 = prev[1] - curr[1];
    const vx2 = next[0] - curr[0];
    const vy2 = next[1] - curr[1];
    const l1 = Math.hypot(vx1, vy1);
    const l2 = Math.hypot(vx2, vy2);
    if (l1 < 1e-6 || l2 < 1e-6) {
      nodes.push({ x: curr[0], y: curr[1] });
      continue;
    }
    const u1x = vx1 / l1,
      u1y = vy1 / l1;
    const u2x = vx2 / l2,
      u2y = vy2 / l2;
    const dot = Math.max(-1, Math.min(1, u1x * u2x + u1y * u2y));
    const halfAngle = Math.acos(dot) / 2;
    const tanHalf = Math.tan(halfAngle);
    if (tanHalf < 1e-4) {
      nodes.push({ x: curr[0], y: curr[1] });
      continue;
    }
    const maxDist = Math.min(l1, l2) * 0.45;
    const dist = Math.min(radius / tanHalf, maxDist);
    const effR = dist * tanHalf;
    const p1x = curr[0] + u1x * dist;
    const p1y = curr[1] + u1y * dist;
    const p2x = curr[0] + u2x * dist;
    const p2y = curr[1] + u2y * dist;
    const sweep = Math.PI - 2 * halfAngle;
    const k = (4 / 3) * Math.tan(sweep / 4) * effR;
    nodes.push({
      x: p1x,
      y: p1y,
      cout: { x: p1x - u1x * k, y: p1y - u1y * k },
    });
    nodes.push({
      x: p2x,
      y: p2y,
      cin: { x: p2x - u2x * k, y: p2y - u2y * k },
    });
  }
  return { closed: true, nodes };
}
