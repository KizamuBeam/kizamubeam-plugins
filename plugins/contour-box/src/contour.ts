// Box from a contour (#513): the outline as evenly spaced points, its curvature, the line at the middle of the wall,
// and walking along that line for the 3D view. Pure geometry without host functions, so the Node tests can check it.
import type { Node, Pt, Selected, SubPath } from '../../../sdk/ts';

export type V = [number, number];

/** Signed area by the shoelace formula in the coordinates as given (y down: positive = clockwise on screen) */
export function area(pts: V[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function perimeter(pts: V[]): number {
  let l = 0;
  for (let i = 0; i < pts.length; i++) l += dist(pts[i], pts[(i + 1) % pts.length]);
  return l;
}

const dist = (a: V, b: V) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** The closed outline again with n points evenly spaced by length, the first at the first point */
export function resample(pts: V[], n: number): V[] {
  const L = perimeter(pts);
  const out: V[] = [];
  let i = 0, acc = 0;
  for (let k = 0; k < n; k++) {
    const s = (k * L) / n;
    while (i < pts.length) {
      const d = dist(pts[i], pts[(i + 1) % pts.length]);
      if (acc + d >= s - 1e-12 || i === pts.length - 1) {
        const f = d > 1e-12 ? Math.min(1, Math.max(0, (s - acc) / d)) : 0;
        const a = pts[i], b = pts[(i + 1) % pts.length];
        out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
        break;
      }
      acc += d;
      i++;
    }
  }
  return out;
}

/** Points of the contour: the largest closed outline of the selection, centred on the origin; null when there is none */
export function fromSelection(sel: Selected[] | undefined): V[] | null {
  let best: V[] | null = null, bestA = 0;
  for (const o of sel ?? [])
    for (const poly of o.polys) {
      if (poly.length < 3) continue;
      const pts = poly.map((p: Pt): V => [p.x, p.y]);
      const a = Math.abs(area(pts));
      if (a > bestA) (bestA = a), (best = pts);
    }
  if (!best || bestA < 1) return null;
  const xs = best.map((p) => p[0]), ys = best.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  return best.map((p): V => [p[0] - cx, p[1] - cy]);
}

/** Contour as it is saved in the parameter: points rounded to 0.01 mm, at most about one per half millimetre */
export function encode(pts: V[]): string {
  const L = perimeter(pts);
  const n = Math.max(8, Math.min(4000, pts.length, Math.ceil(L / 0.5)));
  const q = n < pts.length ? resample(pts, n) : pts;
  return JSON.stringify(q.map((p) => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100]));
}

/** Points of the saved parameter; null when it is not a list of at least three points */
export function decode(s: string): V[] | null {
  try {
    const v = JSON.parse(s) as unknown;
    if (!Array.isArray(v) || v.length < 3) return null;
    const pts: V[] = [];
    for (const q of v) {
      if (!Array.isArray(q) || q.length !== 2 || !Number.isFinite(q[0]) || !Number.isFinite(q[1])) return null;
      const p: V = [q[0], q[1]];
      if (!pts.length || dist(p, pts[pts.length - 1]) > 1e-6) pts.push(p);
    }
    if (pts.length > 3 && dist(pts[0], pts[pts.length - 1]) < 1e-6) pts.pop();
    return pts.length >= 3 && Math.abs(area(pts)) > 1 ? pts : null;
  } catch {
    return null;
  }
}

/** Closed outline smoothed by averaging each point with k neighbours on both sides, twice (takes out the kinks of a polygon) */
export function smooth(pts: V[], k: number): V[] {
  const n = pts.length;
  let cur = pts;
  for (let pass = 0; pass < 2; pass++) {
    cur = cur.map((_, i): V => {
      let x = 0, y = 0;
      for (let j = -k; j <= k; j++) {
        const q = cur[(i + j + n) % n];
        x += q[0];
        y += q[1];
      }
      return [x / (2 * k + 1), y / (2 * k + 1)];
    });
  }
  return cur;
}

/** Unit tangent at each point (from its two neighbours) */
export function tangents(pts: V[]): V[] {
  const n = pts.length;
  return pts.map((_, i) => {
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  });
}

/** The outline moved d outwards (negative = inwards) along its normals; for smooth outlines with radii above |d| */
export function offset(pts: V[], d: number): V[] {
  const s = area(pts) > 0 ? 1 : -1;
  const tg = tangents(pts);
  // Positive area (y down: clockwise on screen): the outward normal is (ty, −tx)
  return pts.map((p, i): V => [p[0] + s * tg[i][1] * d, p[1] - s * tg[i][0] * d]);
}

/**
 * Bend radius at each point, from the turn of the tangent over about `span` mm on both sides (Infinity on a straight
 * line). Corners of the outline give a radius near 0.
 */
export function radii(pts: V[], span: number): number[] {
  const n = pts.length;
  const step = perimeter(pts) / n;
  const k = Math.max(1, Math.min(Math.floor(n / 4), Math.round(span / step)));
  const tg = tangents(pts);
  return pts.map((_, i) => {
    let turn = 0, len = 0;
    for (let j = i - k; j < i + k; j++) {
      const a = tg[(j + n) % n], b = tg[(j + 1 + n) % n];
      turn += Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]);
      len += dist(pts[(j + n) % n], pts[(j + 1 + n) % n]);
    }
    return Math.abs(turn) < 1e-9 ? Infinity : len / Math.abs(turn);
  });
}

/** Cumulative length at each point, and the whole length as the last entry */
export function lengths(pts: V[]): number[] {
  const out = [0];
  for (let i = 0; i < pts.length; i++) out.push(out[i] + dist(pts[i], pts[(i + 1) % pts.length]));
  return out;
}

/** The outline as a closed path of Bézier curves through every point, tangent at each (Catmull-Rom) */
export function smoothPath(pts: V[]): SubPath {
  const n = pts.length;
  const nodes: Node[] = pts.map((p, i) => {
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const tx = (b[0] - a[0]) / 6, ty = (b[1] - a[1]) / 6;
    return { x: p[0], y: p[1], cin: { x: p[0] - tx, y: p[1] - ty }, cout: { x: p[0] + tx, y: p[1] + ty }, smooth: true } as Node;
  });
  return { closed: true, nodes };
}

/**
 * Points along a closed path of Bézier curves, as the app's Joint tool samples a curved edge (even steps in the curve
 * parameter, at most 0.4 mm apart by the control polygon, at least 8 per curve), so lengths along them match the
 * app's to a few micrometres
 */
export function sampleLike(sub: SubPath): V[] {
  const out: V[] = [];
  const N = sub.nodes.length;
  for (let i = 0; i < N; i++) {
    const a = sub.nodes[i], b = sub.nodes[(i + 1) % N];
    const c1 = a.cout ?? a, c2 = b.cin ?? b;
    const rough = Math.hypot(c1.x - a.x, c1.y - a.y) + Math.hypot(c2.x - c1.x, c2.y - c1.y) + Math.hypot(b.x - c2.x, b.y - c2.y);
    const m = Math.max(8, Math.ceil(rough / 0.4));
    for (let j = 0; j < m; j++) {
      const t = j / m, u = 1 - t;
      out.push([u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x, u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y]);
    }
  }
  return out;
}

/** Intervals [a, b] of a closed outline of length L where keep(i) holds, by length from point 0; wrapping ones may end past L */
export function runs(cum: number[], keep: (i: number) => boolean): [number, number][] {
  const n = cum.length - 1, L = cum[n];
  const out: [number, number][] = [];
  if (n === 0) return out;
  let start = -1;
  for (let i = 0; i < n; i++) {
    if (keep(i) && start < 0) start = i;
    if (!keep(i) && start >= 0) {
      out.push([cum[start], cum[i]]);
      start = -1;
    }
  }
  if (start >= 0) {
    if (start === 0) return [[0, L]];
    // Joins the run at the start of the outline
    if (out.length && out[0][0] === 0) out[0] = [cum[start] - L, out[0][1]];
    else out.push([cum[start], L]);
  }
  return out;
}

/**
 * Points along the closed polyline `pts` (cumulative lengths `cum`) for a bent wall in the 3D view, from length s0 to s1
 * (may exceed the length; it wraps), with consecutive points exactly `steps` apart in a straight line: the 3D view lays
 * the strip along the chords, so the strip then lands where its length says. Returns the points and their lengths along
 * the strip from s0. The walk stops exactly at the lengths in `stops` (from s0, ascending).
 */
export function walk(pts: V[], cum: number[], s0: number, s1: number, step: (s: number) => number, stops: number[] = []): { path: V[]; xs: number[] } {
  const n = pts.length, L = cum[n];
  const at = (s: number): V => {
    const u = ((s % L) + L) % L;
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cum[mid] <= u) lo = mid;
      else hi = mid - 1;
    }
    const a = pts[lo], b = pts[(lo + 1) % n], d = cum[lo + 1] - cum[lo];
    const f = d > 1e-12 ? (u - cum[lo]) / d : 0;
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  };
  const path: V[] = [at(s0)];
  const xs = [0];
  let s = s0, x = 0;
  while (x < s1 - s0 - 1e-9) {
    const next = stops.find((q) => q > x + 1e-9) ?? Infinity;
    const h = Math.min(step(s), s1 - s0 - x, next - x);
    // Find the point on the polyline after s whose straight distance from the last point is h
    const p = path[path.length - 1];
    let lo = s, hi = s + 2 * h + 1;
    for (let it = 0; it < 60; it++) {
      const mid = (lo + hi) / 2;
      if (dist(p, at(mid)) < h) lo = mid;
      else hi = mid;
    }
    s = (lo + hi) / 2;
    x += h;
    path.push(at(s));
    xs.push(x);
  }
  return { path, xs };
}
