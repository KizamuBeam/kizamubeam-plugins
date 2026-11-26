// Box from a contour with separate flat walls (#513): the outline becomes a polygon, straight parts stay one wall
// each, curved parts are split into walls of about the chosen width. Every wall stands on the floor with finger joints
// from the app's Joint tool (host.joints on two straight edges); neighbouring walls meet at the inside of a corner and
// leave a narrow gap outside it, which a laser cut square to the board cannot close.
import { host, mm, type Issue, type Part, type Pose, type SubPath, type Text } from '../../../sdk/ts';
import { area, lengths, radii, runs, type V } from './contour';
import { grow, type P } from './box';

export interface Wall {
  /** Corner of the outline where the wall starts, the direction along it and its outward normal */
  v: V;
  d: V;
  out: V;
  /** Outer edge length, and where the wall begins and ends along it (the corners take a little off at either end) */
  len: number;
  a: number;
  b: number;
  /** Gap left open at the corner where it starts: outside an outward corner, inside an inward one, none at a square one */
  gap: number;
}

/** Point at length s along a closed polyline (wraps) */
function pointAt(pts: V[], cum: number[], s: number): V {
  const n = pts.length, L = cum[n];
  const u = ((s % L) + L) % L;
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (cum[m] <= u) lo = m;
    else hi = m - 1;
  }
  const a = pts[lo], b = pts[(lo + 1) % n], d = cum[lo + 1] - cum[lo];
  const f = d > 1e-12 ? (u - cum[lo]) / d : 0;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

/**
 * Corners of the polygon for an outline (anticlockwise seen from above, y down): straight runs (bend radius from
 * 25 wall widths up, at least half a wall width long) become one edge each; the curved runs between them are split
 * evenly into edges of about `seg` mm. A curved run shorter than half a wall (a corner of the shape, which the
 * smoothing rounded) gives one corner where the straight runs beside it meet. Without straight runs the whole
 * outline is split evenly.
 */
export function polygon(pts: V[], seg: number): V[] {
  const cum = lengths(pts);
  const L = cum[pts.length];
  const at = (s: number) => pointAt(pts, cum, s);
  const rad = radii(pts, 2);
  const flat: [number, number][] = runs(cum, (i) => rad[i] >= 25 * seg).filter(([a, b]) => b - a >= seg / 2);
  if (!flat.length || (flat.length === 1 && flat[0][1] - flat[0][0] >= L - 1e-6)) {
    const n = Math.max(3, Math.round(L / seg));
    return Array.from({ length: n }, (_, i) => at((i * L) / n));
  }
  flat.sort((p, q) => p[0] - q[0]);
  // The bend radius evens out over a few millimetres and ends a straight run early: carry it on as long as the
  // outline stays within 3 µm of its line, up to half way to the next run
  const off = (a: number, b: number, s: number) => {
    const p = at(a), q = at(b), x = at(s);
    const dx = q[0] - p[0], dy = q[1] - p[1];
    return Math.abs((x[0] - p[0]) * dy - (x[1] - p[1]) * dx) / Math.hypot(dx, dy);
  };
  const ext = flat.map(([a, b], j): [number, number] => {
    const prev = flat[(j - 1 + flat.length) % flat.length], next = flat[(j + 1) % flat.length];
    const lo = a - ((a - (prev[1] - (j === 0 ? L : 0))) / 2), hi = b + (next[0] + (j === flat.length - 1 ? L : 0) - b) / 2;
    let a2 = a, b2 = b;
    while (a2 - 0.1 > lo && off(a, b, a2 - 0.1) < 0.003) a2 -= 0.1;
    while (b2 + 0.1 < hi && off(a, b, b2 + 0.1) < 0.003) b2 += 0.1;
    return [a2, b2];
  });
  flat.splice(0, flat.length, ...ext);
  const out: V[] = [];
  for (let j = 0; j < flat.length; j++) {
    const [a0, b0] = flat[j];
    let [a1, b1] = flat[(j + 1) % flat.length];
    if (j + 1 === flat.length) (a1 += L), (b1 += L);
    const l = a1 - b0;
    const m = Math.round(l / seg);
    if (m >= 1) {
      // From the end of this straight run to the start of the next one
      for (let q = 0; q <= m; q++) out.push(at(b0 + (l * q) / m));
      continue;
    }
    // One corner: where the lines of the two straight runs cross, if that is near the rounded corner
    const p1 = at(a0), p2 = at(b0), q1 = at(a1), q2 = at(b1);
    const dp: V = [p2[0] - p1[0], p2[1] - p1[1]], dq: V = [q2[0] - q1[0], q2[1] - q1[1]];
    const cr = dp[0] * dq[1] - dp[1] * dq[0];
    const mid = at((b0 + a1) / 2);
    let c = mid;
    if (Math.abs(cr) > Math.sin((5 * Math.PI) / 180) * Math.hypot(...dp) * Math.hypot(...dq)) {
      const f = ((q1[0] - p1[0]) * dq[1] - (q1[1] - p1[1]) * dq[0]) / cr;
      const x: V = [p1[0] + dp[0] * f, p1[1] + dp[1] * f];
      if (Math.hypot(x[0] - mid[0], x[1] - mid[1]) <= Math.max(2, l)) c = x;
    }
    out.push(c);
  }
  // Corners closer than a tenth of a millimetre are one
  return out.filter((p, i) => {
    const q = out[(i + 1) % out.length];
    return out.length <= 3 || Math.hypot(q[0] - p[0], q[1] - p[1]) > 0.1;
  });
}

/**
 * The walls along the polygon (anticlockwise seen from above, y down) for boards t thick: at a corner that turns
 * outwards both walls end where their inner faces meet, at one that turns inwards where their outer faces meet; the
 * gap is the width left open on the other side
 */
export function walls(poly: V[], t: number): Wall[] {
  const n = poly.length;
  const dirs = poly.map((p, i): V => {
    const q = poly[(i + 1) % n], l = Math.hypot(q[0] - p[0], q[1] - p[1]);
    return [(q[0] - p[0]) / l, (q[1] - p[1]) / l];
  });
  // Turn at corner i, positive where the outline turns outwards (convex)
  const turn = (i: number) => {
    const a = dirs[(i - 1 + n) % n], b = dirs[i];
    return -Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]);
  };
  // A square corner (within 1°) closes without a gap: the wall before it runs through to the outside of the corner
  // (outward) or to its inside (inward), the wall after it butts against it
  const square = (i: number) => Math.abs(Math.abs(turn(i)) - Math.PI / 2) < Math.PI / 180;
  const back = (i: number) => (square(i) ? 0 : t * Math.tan(Math.max(0, turn(i)) / 2));
  return poly.map((v, i) => {
    const j = (i + 1) % n;
    const q = poly[j];
    const len = Math.hypot(q[0] - v[0], q[1] - v[1]);
    const d = dirs[i];
    const a = square(i) ? (turn(i) > 0 ? t : 0) : back(i);
    const b = square(j) ? len + (turn(j) > 0 ? 0 : t) : len - back(j);
    return { v, d, out: [-d[1], d[0]], len, a, b, gap: square(i) ? 0 : 2 * t * Math.tan(Math.abs(turn(i)) / 2) };
  });
}

const rect = (x0: number, y0: number, x1: number, y1: number): SubPath => ({ closed: true, nodes: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }] });

const mapSub = (s: SubPath, f: (x: number, y: number) => { x: number; y: number }): SubPath => ({
  closed: s.closed,
  nodes: s.nodes.map((nd) => ({ ...nd, ...f(nd.x, nd.y), ...(nd.cin ? { cin: f(nd.cin.x, nd.cin.y) } : {}), ...(nd.cout ? { cout: f(nd.cout.x, nd.cout.y) } : {}) })),
});

export interface SegBuilt {
  parts: Part[];
  issues: Issue[];
  info: [Text, Text][];
  labels: Record<string, Text>;
  poses: Record<string, Pose>;
  /** For tests: the polygon (outside of the walls) and the walls along it */
  poly: V[];
  walls: Wall[];
}

/** The box with flat walls for the outline `pts` (smoothed, anticlockwise seen from above) */
export function buildSegments(p: P, pts: V[]): SegBuilt {
  const t = p.thickness, c = p.clearance, k = p.kerf, H = p.height;
  const issues: Issue[] = [];
  const empty = (): SegBuilt => ({ parts: [], issues, info: [], labels: {}, poses: {}, poly: [], walls: [] });
  let poly = polygon(pts, p.segment);
  if (p.measure === 'inside') poly = grow(poly, t);
  const inner = grow(poly, -t);
  const ws = walls(poly, t);
  // A wall narrower than one finger (or three thicknesses) cannot hold its joints
  const minW = Math.max(3 * t, p.finger);
  const narrow = Math.min(...ws.map((w) => w.b - w.a));
  if (narrow < minW || Math.sign(area(inner)) !== Math.sign(area(poly))) {
    issues.push({ key: 'segment', level: 'error', code: 'wall-narrow', values: { w: Number(mm(Math.max(0, narrow))), min: Number(mm(minW)) } });
    return empty();
  }
  const gap = Math.max(...ws.map((w) => w.gap));
  if (gap > t) issues.push({ key: 'segment', level: 'warn', code: 'corner-gap', values: { g: Number(mm(gap)) } });

  // End faces a hair back, so neighbouring walls meet with a little room instead of touching exactly
  const e = Math.max(0.01, c / 4);
  const E = 2 * t;
  const parts: Part[] = [];
  const poses: Record<string, Pose> = {};
  const labels: Record<string, Text> = {};
  const tabs: SubPath[] = [];
  for (const [i, w] of ws.entries()) {
    const x0 = w.a + e, x1 = w.b - e;
    // The wall's lower edge against a straight stand-in for the floor's edge, a little longer at both ends: the app
    // centres the pattern on both edges, so it lines up with the wall
    const jr = host.joints({
      op: 'edge', v: 2, options: { kind: 'finger', thickness: t, fingerWidth: p.finger, direction: 'in', kerf: k, clearance: c },
      parts: { base: [rect(w.a - E, H, w.b + E, H + 3 * t)], wall: [rect(x0, H, x1, 0)] }, edges: [{ part: 'base', seg: 0 }, { part: 'wall', seg: 0 }],
    });
    if (jr.error) {
      issues.push({ level: 'error', code: jr.error.code, values: jr.error.values as Record<string, number> | undefined });
      return empty();
    }
    let wall = jr.parts.wall;
    // With a lid the upper edge gets the same notches: the wall mirrored top to bottom keeps every x
    if (p.lid) wall = host.boolean({ op: 'intersection', a: wall, b: wall.map((s) => mapSub(s, (x, y) => ({ x, y: H - y }))) });
    // The floor's fingers under this wall: the stand-in's edge band, laid onto the outline (y = H is the outside of
    // the wall, y = H + t its inside)
    const band = host.boolean({ op: 'intersection', a: jr.parts.base, b: [rect(w.a, H - t, w.b, H + t + 1)] });
    for (const s of band)
      tabs.push(mapSub(s, (x, y) => ({ x: w.v[0] + x * w.d[0] + (H - y) * w.out[0], y: w.v[1] + x * w.d[1] + (H - y) * w.out[1] })));
    const key = `wall${i + 1}`;
    const cx = (x0 + x1) / 2, cy = H / 2;
    parts.push({ key, subs: wall.map((s) => mapSub(s, (x, y) => ({ x: x - cx, y: y - cy }))), at: { x: 0, y: 0 } });
    labels[key] = { code: 'part.wallN', values: { n: i + 1 } };
    // Standing on the floor, inner face on the inside of the outline, laser side out: −(u×v) is the outward normal
    const o: V = [w.v[0] + cx * w.d[0] - t * w.out[0], w.v[1] + cx * w.d[1] - t * w.out[1]];
    poses[key] = { o: [o[0], -o[1], H / 2], u: [w.d[0], -w.d[1], 0], v: [0, 0, -1], n: [w.out[0], -w.out[1], 0] };
  }
  // Floor (and lid): the inside of the walls with the fingers under every wall
  // One band at a time: within one side of a boolean, overlapping outlines cancel (even-odd), and the bands overlap
  // at square corners
  let floor: SubPath[] = [{ closed: true, nodes: inner.map(([x, y]) => ({ x, y })) }];
  for (const tab of tabs) floor = host.boolean({ op: 'union', a: floor, b: [tab] });
  parts.unshift({ key: 'floor', subs: floor, at: { x: 0, y: 0 } });
  poses.floor = { o: [0, 0, 0], u: [1, 0, 0], v: [0, -1, 0], n: [0, 0, 1] };
  if (p.lid) {
    parts.splice(1, 0, { key: 'lid', subs: floor, at: { x: 0, y: 0 } });
    poses.lid = { o: [0, 0, H - t], u: [1, 0, 0], v: [0, -1, 0], n: [0, 0, 1] };
  }
  const at = host.nest({ parts: parts.map((q) => ({ key: q.key, subs: q.subs.filter((s) => s.closed) })), gap: 5 }) as [number, number][];
  parts.forEach((q, i) => (q.at = { x: at[i][0], y: at[i][1] }));

  const xs = poly.map((q) => q[0]), ys = poly.map((q) => q[1]);
  const widths = ws.map((w) => w.b - w.a);
  return {
    parts,
    issues,
    info: [
      ['info.size', `${mm(Math.max(...xs) - Math.min(...xs))} × ${mm(Math.max(...ys) - Math.min(...ys))} × ${mm(H)} mm`],
      ['info.walls', String(ws.length)],
      ['info.widths', Math.max(...widths) - Math.min(...widths) < 0.05 ? `${mm(widths[0])} mm` : `${mm(Math.min(...widths))} … ${mm(Math.max(...widths))} mm`],
      ['info.gap', `${mm(gap)} mm`],
    ],
    labels,
    poses,
    poly,
    walls: ws,
  };
}
