// Rounded box (#513): a box with rounded corners whose wall is one bent strip. The strip gets living hinge cuts where
// it bends (from the app, host.hinge), tabs on its lower (and with a lid upper) edge that go through slots in the
// floor and lid, and dovetails where its ends meet. A strip longer than the work area is split into pieces that join
// with the same dovetails.
// Lengths along the wall are measured on its centre line (the middle of the board), which keeps its length when the
// board bends; bendExtra adds length per 90° bend for boards that stretch or squeeze a little.
// Pure geometry without the app, so the tests run it in Node.
import type { Node, SubPath } from '../../../sdk/ts';

export type V = [number, number];

interface Line { kind: 'line'; a: V; b: V; n: V; len: number; s0: number }
/** Arc around c with radius r from angle a0 down to a1 (y down: the wall runs round the box this way) */
interface Arc { kind: 'arc'; c: V; r: number; a0: number; a1: number; len: number; s0: number }
type El = Line | Arc;

/** Closed centre line of the wall, made of straight lines and quarter arcs */
export interface Ring {
  els: El[];
  length: number;
}

/**
 * Rounded rectangle w × h with corner radius r, centred on the origin (y down). Starts at the left end of the lower
 * straight side and runs to the right, then up the right side.
 */
export function ring(w: number, h: number, r: number): Ring {
  const x = w / 2, y = h / 2;
  const P = Math.PI;
  const els: El[] = [];
  const line = (a: V, b: V, n: V) => els.push({ kind: 'line', a, b, n, len: Math.hypot(b[0] - a[0], b[1] - a[1]), s0: 0 });
  const arc = (c: V, a0: number) => els.push({ kind: 'arc', c, r, a0, a1: a0 - P / 2, len: (r * P) / 2, s0: 0 });
  line([-x + r, y], [x - r, y], [0, 1]);
  arc([x - r, y - r], P / 2);
  line([x, y - r], [x, -y + r], [1, 0]);
  arc([x - r, -y + r], 0);
  line([x - r, -y], [-x + r, -y], [0, -1]);
  arc([-x + r, -y + r], -P / 2);
  line([-x, -y + r], [-x, y - r], [-1, 0]);
  arc([-x + r, y - r], -P);
  let s = 0;
  for (const e of els) (e.s0 = s), (s += e.len);
  return { els: els.filter((e) => e.len > 1e-9), length: s };
}

const mod = (s: number, L: number) => {
  const m = ((s % L) + L) % L;
  return m > L - 1e-9 ? 0 : m;
};
/** Element at s (0 ≤ s < length) */
function elAt(rg: Ring, s: number): El {
  for (const e of rg.els) if (s < e.s0 + e.len - 1e-9) return e;
  return rg.els[rg.els.length - 1];
}

/** Point at s along the centre line, moved d outwards */
export function pointAt(rg: Ring, s: number, d = 0): V {
  s = mod(s, rg.length);
  const e = elAt(rg, s);
  const u = s - e.s0;
  if (e.kind === 'line') {
    const k = u / e.len;
    return [e.a[0] + (e.b[0] - e.a[0]) * k + e.n[0] * d, e.a[1] + (e.b[1] - e.a[1]) * k + e.n[1] * d];
  }
  const a = e.a0 - u / e.r;
  return [e.c[0] + (e.r + d) * Math.cos(a), e.c[1] + (e.r + d) * Math.sin(a)];
}

/**
 * The centre line moved d outwards from sa to sb (sb > sa, at most once round), as nodes with exact straight lines and
 * arcs as Bézier curves (at most a quarter turn each).
 */
export function trace(rg: Ring, sa: number, sb: number, d: number): Node[] {
  const nodes: Node[] = [];
  const add = (p: V) => {
    const l = nodes[nodes.length - 1];
    if (!l || Math.hypot(l.x - p[0], l.y - p[1]) > 1e-9) nodes.push({ x: p[0], y: p[1] });
    return nodes[nodes.length - 1];
  };
  let cur = sa;
  let guard = 0;
  while (cur < sb - 1e-9 && guard++ < 1000) {
    const s = mod(cur, rg.length);
    const e = elAt(rg, s);
    const u0 = s - e.s0;
    const u1 = Math.min(e.len, u0 + (sb - cur));
    if (e.kind === 'line') {
      add(pointAt(rg, e.s0 + u0, d));
      add(pointAt(rg, e.s0 + Math.min(u1, e.len - 1e-12), d));
      if (u1 >= e.len - 1e-12) nodes[nodes.length - 1] = { x: e.b[0] + e.n[0] * d, y: e.b[1] + e.n[1] * d };
    } else {
      const R = e.r + d;
      const al = e.a0 - u0 / e.r, be = e.a0 - u1 / e.r;
      const n = Math.max(1, Math.ceil((al - be) / (Math.PI / 2) - 1e-9));
      const at = (a: number): V => [e.c[0] + R * Math.cos(a), e.c[1] + R * Math.sin(a)];
      let prev = add(at(al));
      for (let i = 1; i <= n; i++) {
        const a0 = al - ((al - be) * (i - 1)) / n, a1 = al - ((al - be) * i) / n;
        const k = (4 / 3) * Math.tan((a0 - a1) / 4) * R;
        const p1 = at(a1);
        prev.cout = { x: prev.x + k * Math.sin(a0), y: prev.y - k * Math.cos(a0) };
        const node: Node = { x: p1[0], y: p1[1], cin: { x: p1[0] - k * Math.sin(a1), y: p1[1] + k * Math.cos(a1) } };
        nodes.push(node);
        prev = node;
      }
    }
    cur += u1 - u0;
  }
  return nodes;
}

/** Nodes in the other direction */
export function reverse(nodes: Node[]): Node[] {
  return nodes
    .slice()
    .reverse()
    .map((n) => {
      const q: Node = { x: n.x, y: n.y };
      if (n.cout) q.cin = n.cout;
      if (n.cin) q.cout = n.cin;
      return q;
    });
}

/** The whole centre line moved d outwards as a closed outline */
export function closedRing(rg: Ring, d: number): SubPath {
  const nodes = trace(rg, 0, rg.length, d);
  const first = nodes[0], last = nodes[nodes.length - 1];
  if (nodes.length > 1 && Math.hypot(first.x - last.x, first.y - last.y) < 1e-6) {
    nodes.pop();
    if (last.cin) first.cin = last.cin;
  }
  return { closed: true, nodes };
}

/** Slot along the centre line from sa to sb, width w across it */
export function slot(rg: Ring, sa: number, sb: number, w: number): SubPath {
  const out = trace(rg, sa, sb, w / 2);
  const inn = reverse(trace(rg, sa, sb, -w / 2));
  return { closed: true, nodes: [...out, ...inn] };
}

/**
 * Positions along the strip: the strip is the centre line laid flat, each arc bendExtra longer per quarter turn.
 * x(s) and s(x) map between the two; both start at the same point (s = 0).
 */
export interface StripMap {
  length: number;
  x: (s: number) => number;
  s: (x: number) => number;
  /** Bends as intervals [x0, x1] along the strip */
  bends: [number, number][];
  /** Straight sides as intervals [x0, x1] along the strip */
  straights: [number, number][];
}

export function stripMap(rg: Ring, bendExtra: number): StripMap {
  const rows: { s0: number; s1: number; x0: number; x1: number }[] = [];
  const bends: [number, number][] = [], straights: [number, number][] = [];
  let x = 0;
  for (const e of rg.els) {
    const dx = e.len + (e.kind === 'arc' ? (bendExtra * (e.a0 - e.a1)) / (Math.PI / 2) : 0);
    rows.push({ s0: e.s0, s1: e.s0 + e.len, x0: x, x1: x + dx });
    (e.kind === 'arc' ? bends : straights).push([x, x + dx]);
    x += dx;
  }
  const L = x;
  const lerp = (v: number, a0: number, a1: number, b0: number, b1: number) => (a1 - a0 > 1e-12 ? b0 + ((v - a0) * (b1 - b0)) / (a1 - a0) : b0);
  return {
    length: L,
    x: (s) => {
      const k = Math.floor(s / rg.length);
      const m = s - k * rg.length;
      const r = rows.find((q) => m <= q.s1 + 1e-9) ?? rows[rows.length - 1];
      return k * L + lerp(m, r.s0, r.s1, r.x0, r.x1);
    },
    s: (v) => {
      const k = Math.floor(v / L);
      const m = v - k * L;
      const r = rows.find((q) => m <= q.x1 + 1e-9) ?? rows[rows.length - 1];
      return k * rg.length + lerp(m, r.x0, r.x1, r.s0, r.s1);
    },
    bends,
    straights,
  };
}

/** Merge touching or overlapping intervals */
export function merge(iv: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of iv.slice().sort((p, q) => p[0] - q[0])) {
    const l = out[out.length - 1];
    if (l && a <= l[1] + 1e-9) l[1] = Math.max(l[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Intervals of iv (on a circle of length L, shifted by off) that lie inside [a, b] */
export function clipCircular(iv: [number, number][], L: number, off: number, a: number, b: number): [number, number][] {
  const out: [number, number][] = [];
  for (const [p, q] of iv)
    for (const k of [-1, 0, 1]) {
      const s = Math.max(a, p - off + k * L), e = Math.min(b, q - off + k * L);
      if (e - s > 1e-6) out.push([s, e]);
    }
  return merge(out);
}

/** Dovetail sizes for a board thickness: depth, neck and head width */
export function dovetail(t: number) {
  const depth = Math.max(4, 2 * t);
  return { depth, neck: 0.9 * depth, head: 1.6 * depth };
}

/** Polygon moved e outwards (miter joins); for the kerf, e is small against the features */
export function offsetPolygon(pts: V[], e: number): V[] {
  if (Math.abs(e) < 1e-12) return pts;
  let A = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    A += p[0] * q[1] - q[0] * p[1];
  }
  const sgn = A > 0 ? 1 : -1;
  const n = pts.length;
  const normal = (p: V, q: V): V => {
    const dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy);
    return [(sgn * dy) / l, (-sgn * dx) / l];
  };
  return pts.map((p, i) => {
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const n1 = normal(a, p), n2 = normal(p, b);
    const m: V = [n1[0] + n2[0], n1[1] + n2[1]];
    const c = 1 + n1[0] * n2[0] + n1[1] * n2[1];
    if (c < 1e-6) return [p[0] + n1[0] * e, p[1] + n1[1] * e];
    return [p[0] + (m[0] * e) / c, p[1] + (m[1] * e) / c];
  });
}

/** Remove repeated points of a closed polygon */
export function dedupe(pts: V[]): V[] {
  const out: V[] = [];
  for (const p of pts) {
    const l = out[out.length - 1];
    if (!l || Math.hypot(l[0] - p[0], l[1] - p[1]) > 1e-9) out.push(p);
  }
  while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 1e-9) out.pop();
  return out;
}

export interface PieceSpec {
  /** Start and end along the strip */
  x0: number;
  x1: number;
  /** Wall height (without tabs) */
  h: number;
  t: number;
  /** Tab centres along the strip (lower edge; with the lid also the upper edge) */
  tabs: number[];
  tabWidth: number;
  top: boolean;
  /** Centres of the dovetails across the strip (y, 0 = upper edge) */
  tails: number[];
  clearance: number;
  kerf: number;
}

/**
 * Outline of one strip piece in strip coordinates (x along, y down from the upper edge): tabs, the dovetails at its
 * end x1 and the sockets for the dovetails of the piece before it at x0. The kerf moves the whole outline outwards.
 */
export function pieceOutline(p: PieceSpec): V[] {
  const { x0, x1, h, t, tabWidth: w, clearance: c } = p;
  const dv = dovetail(t);
  const pts: V[] = [[x0, 0]];
  if (p.top) for (const xc of p.tabs) pts.push([xc - w / 2, 0], [xc - w / 2, -t], [xc + w / 2, -t], [xc + w / 2, 0]);
  pts.push([x1, 0]);
  for (const y of p.tails) pts.push([x1, y - dv.neck / 2], [x1 + dv.depth, y - dv.head / 2], [x1 + dv.depth, y + dv.head / 2], [x1, y + dv.neck / 2]);
  pts.push([x1, h]);
  for (const xc of p.tabs.slice().reverse()) pts.push([xc + w / 2, h], [xc + w / 2, h + t], [xc - w / 2, h + t], [xc - w / 2, h]);
  pts.push([x0, h]);
  // Sockets: as wide as the dovetail plus the play, as deep plus half of it
  const sd = dv.depth + c / 2, sn = dv.neck + c, sh = dv.head + c;
  for (const y of p.tails.slice().reverse()) pts.push([x0, y + sn / 2], [x0 + sd, y + sh / 2], [x0 + sd, y - sh / 2], [x0, y - sn / 2]);
  return offsetPolygon(dedupe(pts), p.kerf / 2);
}
