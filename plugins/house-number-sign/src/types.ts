import { K, type Node, type Params, type Pt, type SubPath } from '../../../sdk/ts';

export type FontFamily = 'sans' | 'serif' | 'rounded' | 'artdeco' | 'slab' | 'technical';
export type NumberLayout = 'row' | 'stack' | 'diagonal' | 'splitLeft';
export type TextPosition = 'bottom' | 'top' | 'split';
export type TextMode = 'engraveOutline' | 'engraveStroke' | 'raised';

export type BoardShape =
  | 'rounded'
  | 'rect'
  | 'arch'
  | 'pill'
  | 'house'
  | 'shield'
  | 'hexagon'
  | 'chamfer'
  | 'oval'
  | 'scalloped';

export type SizingMode = 'auto' | 'custom';
export type FrameStyle = 'none' | 'engraveSingle' | 'engraveDouble' | 'raisedFrame';

export type NumberStyle = 'raisedSpaced' | 'raisedFlat' | 'cutout' | 'engrave';
export type SpacerStyle = 'insetGlyph' | 'pegs';
export type GlueGuides = 'none' | 'outline' | 'corners';

export type DividerStyle = 'none' | 'line' | 'double' | 'diamond' | 'dots' | 'flourish';
export type MotifKind = 'none' | 'house' | 'leaf' | 'compass' | 'sun' | 'key' | 'paw' | 'heart' | 'trees';
export type MotifPosition = 'top' | 'divider' | 'bottom';
export type CornerOrnaments = 'none' | 'dots' | 'brackets' | 'diamonds';

export type MountType =
  | 'none'
  | 'corners4'
  | 'triangle3'
  | 'sides2'
  | 'vertical2'
  | 'keyhole1'
  | 'keyhole2'
  | 'standoff4';

export interface SignParams extends Params {
  // Step 1: Text & Content
  number: string;
  numberHeight: number;
  font: FontFamily;
  boldness: number;
  charSpacing: number;
  layout: NumberLayout;
  street: string;
  subtitle: string;
  textPosition: TextPosition;
  textMode: TextMode;
  streetHeight: number;
  textSpacing: number;

  // Step 2: Board Shape & Frame
  boardShape: BoardShape;
  sizingMode: SizingMode;
  boardWidth: number;
  boardHeight: number;
  paddingX: number;
  paddingY: number;
  cornerRadius: number;
  roofPitch: number;
  frameStyle: FrameStyle;
  frameWidth: number;
  frameInset: number;

  // Step 3: 3D Layers & Shadow Standoffs
  numberStyle: NumberStyle;
  spacerLayers: number;
  spacerInset: number;
  spacerStyle: SpacerStyle;
  pinHoles: boolean;
  pinDia: number;
  backplate: boolean;
  cutoutBackplate: boolean;
  bridgeWidth: number;
  glueGuides: GlueGuides;
  partLabels: boolean;

  // Step 4: Ornaments & Divider
  dividerStyle: DividerStyle;
  motif: MotifKind;
  motifPosition: MotifPosition;
  motifSize: number;
  cornerOrnaments: CornerOrnaments;

  // Step 5: Mounting & Hardware
  mountType: MountType;
  holeDia: number;
  holeInset: number;
  keyholeHeadDia: number;
  keyholeShaftDia: number;
  standoffRingMark: boolean;

  // Step 6: Material & Production
  fromMaterial: boolean;
  thickness: number;
  kerf: number;
  separatePages: boolean;
  partGap: number;
}

export interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  w: number;
  h: number;
}

/** Open straight line segment */
export const line = (x1: number, y1: number, x2: number, y2: number): SubPath => ({
  closed: false,
  nodes: [
    { x: x1, y: y1 },
    { x: x2, y: y2 },
  ],
});

/** Closed polygon from [x, y] pairs */
export const poly = (pts: [number, number][]): SubPath => ({
  closed: true,
  nodes: pts.map(([x, y]) => ({ x, y })),
});

/** Open polyline from [x, y] pairs */
export const polyline = (pts: [number, number][]): SubPath => ({
  closed: false,
  nodes: pts.map(([x, y]) => ({ x, y })),
});

/** Exact cubic Bézier elliptical arc nodes from angle a0 to a1 (radians, 0 = +x, +PI/2 = +y down) */
export function ellipseArcNodes(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  a0: number,
  a1: number,
  kScale = 1,
): Node[] {
  const span = a1 - a0;
  const n = Math.max(1, Math.ceil(Math.abs(span) / (Math.PI / 2)));
  const d = span / n;
  const alpha = (4 / 3) * Math.tan(d / 4) * kScale;
  const nodes: Node[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + i * d;
    const x = cx + rx * Math.cos(a);
    const y = cy + ry * Math.sin(a);
    const dx = -rx * Math.sin(a);
    const dy = ry * Math.cos(a);
    const nd: Node = { x, y };
    if (i > 0) nd.cin = { x: x - dx * alpha, y: y - dy * alpha };
    if (i < n) nd.cout = { x: x + dx * alpha, y: y + dy * alpha };
    if (i > 0 && i < n) nd.smooth = true;
    nodes.push(nd);
  }
  return nodes;
}

export function circleArcNodes(cx: number, cy: number, r: number, a0: number, a1: number): Node[] {
  return ellipseArcNodes(cx, cy, r, r, a0, a1, 1);
}

/** Append a node sequence to an existing chain, merging coincident endpoints cleanly */
export function appendChain(dst: Node[], src: Node[]): void {
  if (!src.length) return;
  if (dst.length) {
    const last = dst[dst.length - 1];
    const first = src[0];
    if (Math.hypot(last.x - first.x, last.y - first.y) < 1e-4) {
      if (first.cout) last.cout = first.cout;
      for (let i = 1; i < src.length; i++) dst.push(src[i]);
      return;
    }
  }
  for (const nd of src) dst.push(nd);
}

/** Close a node chain into a SubPath, merging last into first if coincident */
export function closeChain(nodes: Node[]): SubPath {
  if (nodes.length > 1) {
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) < 1e-4) {
      if (last.cin && !first.cin) first.cin = last.cin;
      nodes.pop();
    }
  }
  return { closed: true, nodes };
}

/** Closed smooth ellipse around (cx, cy) with radii rx, ry (CW by default in y-down coords) */
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

/** Reverse winding direction of a SubPath, preserving Bézier handles */
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

function xformPt(p: Pt, tx: number, ty: number, scale: number, cos: number, sin: number): Pt {
  const sx = p.x * scale;
  const sy = p.y * scale;
  return {
    x: tx + sx * cos - sy * sin,
    y: ty + sx * sin + sy * cos,
  };
}

/** Transform a SubPath by uniform scale, clockwise angle (rad), and translation */
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

/** Non-uniform scale + translate a SubPath */
export function scaleSub(s: SubPath, sx: number, sy: number, tx = 0, ty = 0): SubPath {
  return {
    closed: s.closed,
    nodes: s.nodes.map((nd) => {
      const out: Node = { x: nd.x * sx + tx, y: nd.y * sy + ty };
      if (nd.cin) out.cin = { x: nd.cin.x * sx + tx, y: nd.cin.y * sy + ty };
      if (nd.cout) out.cout = { x: nd.cout.x * sx + tx, y: nd.cout.y * sy + ty };
      if (nd.smooth) out.smooth = true;
      return out;
    }),
  };
}

/** Flatten a SubPath into polygon points */
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
export function pointInPoly(polyPts: Pt[], q: Pt): boolean {
  let c = false;
  for (let i = 0, j = polyPts.length - 1; i < polyPts.length; j = i++) {
    const a = polyPts[j];
    const b = polyPts[i];
    if (a.y > q.y !== b.y > q.y && q.x < a.x + ((q.y - a.y) * (b.x - a.x)) / (b.y - a.y)) c = !c;
  }
  return c;
}

/** Distance from point q to segment a–b */
export function distToSegment(q: Pt, a: Pt, b: Pt): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  if (len2 < 1e-12) return Math.hypot(q.x - a.x, q.y - a.y);
  const t = Math.max(0, Math.min(1, ((q.x - a.x) * vx + (q.y - a.y) * vy) / len2));
  return Math.hypot(q.x - (a.x + t * vx), q.y - (a.y + t * vy));
}

/** Minimum unsigned distance from point q to boundary of polygon */
export function distToPoly(polyPts: Pt[], q: Pt): number {
  let best = Infinity;
  for (let i = 0, j = polyPts.length - 1; i < polyPts.length; j = i++) {
    const d = distToSegment(q, polyPts[j], polyPts[i]);
    if (d < best) best = d;
  }
  return best;
}

export function bboxPts(pts: Pt[]): BBox {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  if (!Number.isFinite(x0)) return { x0: 0, y0: 0, x1: 0, y1: 0, w: 0, h: 0 };
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

export function bboxSubs(subs: SubPath[], steps = 12): BBox {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const s of subs) {
    for (const p of flattenSub(s, steps)) {
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
  }
  if (!Number.isFinite(x0)) return { x0: 0, y0: 0, x1: 0, y1: 0, w: 0, h: 0 };
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

/** Ensure outer contours are CW (signedArea > 0) and holes are CCW (signedArea < 0) */
export function ensureWinding(s: SubPath, wantCW: boolean): SubPath {
  const area = signedArea(flattenSub(s, 10));
  if (wantCW ? area < 0 : area > 0) return reverseSub(s);
  return s;
}

/** Polygon with smooth rounded corners */
export function roundedPoly(pts: [number, number][], radius: number): SubPath {
  const n = pts.length;
  if (radius <= 0.05 || n < 3) return poly(pts);
  const nodes: Node[] = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const curr = pts[i];
    const next = pts[(i + 1) % n];
    const dx1 = prev[0] - curr[0];
    const dy1 = prev[1] - curr[1];
    const dx2 = next[0] - curr[0];
    const dy2 = next[1] - curr[1];
    const l1 = Math.hypot(dx1, dy1);
    const l2 = Math.hypot(dx2, dy2);
    if (l1 < 1e-6 || l2 < 1e-6) {
      nodes.push({ x: curr[0], y: curr[1] });
      continue;
    }
    const ux1 = dx1 / l1;
    const uy1 = dy1 / l1;
    const ux2 = dx2 / l2;
    const uy2 = dy2 / l2;
    const dot = Math.max(-0.9999, Math.min(0.9999, ux1 * ux2 + uy1 * uy2));
    const halfAngle = Math.acos(dot) / 2;
    const tanH = Math.tan(halfAngle);
    if (tanH < 1e-4) {
      nodes.push({ x: curr[0], y: curr[1] });
      continue;
    }
    const d = Math.min(radius / tanH, l1 * 0.45, l2 * 0.45);
    const rEff = d * tanH;
    const turnAngle = Math.PI - 2 * halfAngle;
    const h = ((4 / 3) * Math.tan(turnAngle / 4)) * rEff;
    const p1x = curr[0] + ux1 * d;
    const p1y = curr[1] + uy1 * d;
    const p2x = curr[0] + ux2 * d;
    const p2y = curr[1] + uy2 * d;
    nodes.push({
      x: p1x,
      y: p1y,
      cout: { x: p1x - ux1 * h, y: p1y - uy1 * h },
    });
    nodes.push({
      x: p2x,
      y: p2y,
      cin: { x: p2x - ux2 * h, y: p2y - uy2 * h },
    });
  }
  return { closed: true, nodes };
}
