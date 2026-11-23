// Living Hinge engine ported 1:1 from KizamuBeam's Living Hinge tool (src/hinges.ts).
// Encapsulated cleanly so it can swap to a future host.hinges API without parameter changes.
// Cuts run parallel to the spine axis (Y, head-to-tail) inside the rectangular spine bend zone,
// allowing the one-piece book cover to bend 180° cleanly around the page block.
import type { Node, Pt, SubPath } from '../../../sdk/ts';
import type { HingeKind, HingeOptions } from './types';

export const MAX_CUTS = 50_000;
const LATTICE: readonly HingeKind[] = ['diamond', 'honeycomb', 'triangle', 'cross'];

export interface HingeResult {
  subs: SubPath[];
  cuts: number;
  totalLength: number;
  error?: { code: string; values?: Record<string, number> };
}

/** Suggested starting parameters for a material thickness, identical to KizamuBeam's suggestHinge() */
export function suggestHinge(t: number): {
  hingeBridge: number;
  hingeSpacing: number;
  hingeCutLength: number;
  hingeMargin: number;
  hingeWaveAmp: number;
  hingeWaveLength: number;
} {
  const r = (v: number) => Math.round(v * 10) / 10;
  return {
    hingeBridge: r(Math.max(2, t)),
    hingeSpacing: r(Math.max(1, t / 2)),
    hingeCutLength: r(Math.max(15, 6 * t)),
    hingeMargin: r(Math.max(2, t)),
    hingeWaveAmp: r(Math.max(0.5, t / 3)),
    hingeWaveLength: r(Math.max(5, 2.5 * t)),
  };
}

/** Reverse path node direction (for alternating laser travel order) */
function reverseNodes(nodes: Node[]): Node[] {
  return [...nodes].reverse().map((n) => {
    const q: Node = { x: n.x, y: n.y };
    if (n.cout) q.cin = { ...n.cout };
    if (n.cin) q.cout = { ...n.cin };
    if (n.smooth) q.smooth = true;
    return q;
  });
}

/** Exact Liang-Barsky clip of segment (x0, y0)-(x1, y1) against axis-aligned rectangle [rx0, rx1] x [ry0, ry1] */
function clipSegRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rx0: number,
  ry0: number,
  rx1: number,
  ry1: number,
): [Pt, Pt] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const clip = (p: number, q: number): boolean => {
    if (Math.abs(p) < 1e-12) return q >= -1e-9;
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
  if (
    !clip(-dx, x0 - rx0) ||
    !clip(dx, rx1 - x0) ||
    !clip(-dy, y0 - ry0) ||
    !clip(dy, ry1 - y0)
  ) {
    return null;
  }
  return [
    { x: x0 + t0 * dx, y: y0 + t0 * dy },
    { x: x0 + t1 * dx, y: y0 + t1 * dy },
  ];
}

/**
 * Exact intervals of u in [u0, u1] where v + A * sin(k * (u - uc)) lies within [v0, v1].
 * Analytic equivalent of KizamuBeam's rowIntervals() for a rectangular bend zone.
 */
function waveIntervals(
  u0: number,
  u1: number,
  uc: number,
  v: number,
  A: number,
  k: number,
  v0: number,
  v1: number,
): [number, number][] {
  const eps = 1e-9;
  if (A <= eps) {
    return v >= v0 - eps && v <= v1 + eps ? [[u0, u1]] : [];
  }
  const lo = (v0 - v) / A;
  const hi = (v1 - v) / A;
  if (lo > 1 + eps || hi < -1 - eps) return [];
  if (lo <= -1 + eps && hi >= 1 - eps) return [[u0, u1]];

  const tMin = k * (u0 - uc);
  const tMax = k * (u1 - uc);
  const twoPi = 2 * Math.PI;
  const splits: number[] = [tMin, tMax];

  const addRoots = (c: number) => {
    if (c <= -1 + eps || c >= 1 - eps) return;
    const a1 = Math.asin(c);
    const a2 = Math.PI - a1;
    for (const base of [a1, a2]) {
      const nStart = Math.floor((tMin - base) / twoPi) - 1;
      const nEnd = Math.ceil((tMax - base) / twoPi) + 1;
      for (let n = nStart; n <= nEnd; n++) {
        const th = base + n * twoPi;
        if (th > tMin + 1e-11 && th < tMax - 1e-11) splits.push(th);
      }
    }
  };
  addRoots(lo);
  addRoots(hi);
  splits.sort((a, b) => a - b);

  const out: [number, number][] = [];
  for (let i = 0; i + 1 < splits.length; i++) {
    const a = splits[i];
    const b = splits[i + 1];
    if (b - a < 1e-11) continue;
    const mid = (a + b) / 2;
    const val = v + A * Math.sin(mid);
    if (val >= v0 - 1e-7 && val <= v1 + 1e-7) {
      const ua = uc + a / k;
      const ub = uc + b / k;
      const prev = out[out.length - 1];
      if (prev && ua <= prev[1] + 1e-5) prev[1] = Math.max(prev[1], ub);
      else out.push([ua, ub]);
    }
  }
  return out;
}

/** Lattice hinge patterns: diamond, honeycomb, triangle, cross (ported from KizamuBeam src/hinges.ts) */
function latticeHinge(
  rx0: number,
  ry0: number,
  rx1: number,
  ry1: number,
  o: HingeOptions,
): HingeResult {
  const L = o.cutLength;
  const g = o.bridge;
  const e = L + g;
  const uc = (ry0 + ry1) / 2;
  const vc = (rx0 + rx1) / 2;
  const hu = (ry1 - ry0) / 2;
  const hv = (rx1 - rx0) / 2;

  const cellArea = o.kind === 'cross' ? e * o.spacing : e * e * 0.4;
  const est = ((2 * hu + 2 * e) * (2 * hv + 2 * e)) / cellArea;
  if (est > MAX_CUTS * 1.5) {
    return { subs: [], cuts: 0, totalLength: 0, error: { code: 'hinge-too-many', values: { max: MAX_CUTS } } };
  }

  // Segments in local (u, v) relative to centre: u along spine (Y), v across spine (X)
  const segs: [number, number, number, number][] = [];
  const edge = (au: number, av: number, bu: number, bv: number) => {
    const d = Math.hypot(bu - au, bv - av);
    if (d <= g) return;
    const f = g / 2 / d;
    segs.push([au + (bu - au) * f, av + (bv - av) * f, bu - (bu - au) * f, bv - (bv - av) * f]);
  };

  if (o.kind === 'diamond') {
    const a = (o.diamondAngle * Math.PI) / 360;
    const dx = e * Math.cos(a);
    const dy = e * Math.sin(a);
    const J = Math.ceil(hv / dy) + 1;
    const I = Math.ceil(hu / (2 * dx)) + 1;
    for (let j = -J; j <= J; j++) {
      for (let i = -I; i <= I; i++) {
        const u = 2 * dx * i + (Math.abs(j) % 2 ? dx : 0);
        const v = dy * j;
        edge(u, v, u + dx, v + dy);
        edge(u, v, u + dx, v - dy);
      }
    }
  } else if (o.kind === 'triangle') {
    const hh = (e * Math.sqrt(3)) / 2;
    const J = Math.ceil(hv / hh) + 1;
    const I = Math.ceil(hu / e) + 1;
    for (let j = -J; j <= J; j++) {
      for (let i = -I; i <= I; i++) {
        const u = e * i + (Math.abs(j) % 2 ? e / 2 : 0);
        const v = hh * j;
        edge(u, v, u + e, v);
        edge(u, v, u + e / 2, v + hh);
        edge(u, v, u - e / 2, v + hh);
      }
    }
  } else if (o.kind === 'honeycomb') {
    const s3 = Math.sqrt(3) * e;
    const I = Math.ceil(hu / (1.5 * e)) + 1;
    const J = Math.ceil(hv / s3) + 1;
    const hexPt = (cu: number, cv: number, k: number): [number, number] => [
      cu + e * Math.cos((k * Math.PI) / 3),
      cv - e * Math.sin((k * Math.PI) / 3),
    ];
    for (let i = -I; i <= I; i++) {
      for (let j = -J; j <= J; j++) {
        const cu = 1.5 * e * i;
        const cv = s3 * j + (Math.abs(i) % 2 ? s3 / 2 : 0);
        for (let k = 0; k < 3; k++) {
          const [au, av] = hexPt(cu, cv, k);
          const [bu, bv] = hexPt(cu, cv, k + 1);
          edge(au, av, bu, bv);
        }
      }
    }
  } else {
    // cross (woven checkerboard)
    const n = Math.floor((e / 2 - g / 2) / o.spacing + 1e-9);
    const I = Math.ceil(hu / e) + 1;
    const J = Math.ceil(hv / e) + 1;
    for (let i = -I; i <= I; i++) {
      for (let j = -J; j <= J; j++) {
        const cu = e * i;
        const cv = e * j;
        for (let k = -n; k <= n; k++) {
          if ((i + j) % 2 === 0) segs.push([cu - L / 2, cv + k * o.spacing, cu + L / 2, cv + k * o.spacing]);
          else segs.push([cu + k * o.spacing, cv - L / 2, cu + k * o.spacing, cv + L / 2]);
        }
      }
    }
  }

  const minPiece = Math.max(0.5, Math.min(g, L / 2));
  const cuts: { a: Pt; b: Pt }[] = [];
  for (const [u0, v0, u1, v1] of segs) {
    // Map (u along Y, v along X) to cover coordinates
    const clipped = clipSegRect(vc + v0, uc + u0, vc + v1, uc + u1, rx0, ry0, rx1, ry1);
    if (!clipped) continue;
    const [a, b] = clipped;
    if (Math.hypot(b.x - a.x, b.y - a.y) < minPiece - 1e-6) continue;
    cuts.push({ a, b });
    if (cuts.length > MAX_CUTS) {
      return { subs: [], cuts: 0, totalLength: 0, error: { code: 'hinge-too-many', values: { max: MAX_CUTS } } };
    }
  }
  if (!cuts.length) {
    return { subs: [], cuts: 0, totalLength: 0, error: { code: 'hinge-empty' } };
  }

  // Sort roughly column-by-column (across X) and then along Y to minimise laser travel
  const col = Math.max(1, o.kind === 'cross' ? e : L / 2);
  cuts.sort((p, q) => Math.floor(p.a.x / col) - Math.floor(q.a.x / col) || p.a.y - q.a.y);

  let totalLength = 0;
  const subs: SubPath[] = cuts.map(({ a, b }) => {
    totalLength += Math.hypot(b.x - a.x, b.y - a.y);
    return { closed: false, nodes: [a, b] };
  });
  return { subs, cuts: subs.length, totalLength };
}

/**
 * Compute KizamuBeam living hinge cuts inside the rectangular spine zone [x0, x1] x [y0, y1]
 * (in cover local coordinates, y down). Cuts always run parallel to the spine (Y axis).
 */
export function computeSpineHinge(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  o: HingeOptions,
): HingeResult {
  const fail = (code: string, values?: Record<string, number>): HingeResult => ({
    subs: [],
    cuts: 0,
    totalLength: 0,
    error: { code, ...(values ? { values } : {}) },
  });

  if (!(o.cutLength > 0)) return fail('hinge-cut-length');
  if (!(o.bridge >= 0.3)) return fail('hinge-bridge');
  if (o.kind === 'diamond' && !(o.diamondAngle >= 10 && o.diamondAngle <= 170)) return fail('hinge-diamond-angle');
  if (o.kind !== 'diamond' && o.kind !== 'honeycomb' && o.kind !== 'triangle' && !(o.spacing >= 0.3)) return fail('hinge-spacing');
  if (o.kind === 'wave' && !(o.waveLength >= 1)) return fail('hinge-wave-length');
  if (o.kind === 'wave' && !(o.waveAmp >= 0)) return fail('hinge-wave-amp');
  if (!(o.margin >= 0)) return fail('hinge-margin');

  const rx0 = x0 + o.margin;
  const rx1 = x1 - o.margin;
  const ry0 = y0 + o.margin;
  const ry1 = y1 - o.margin;
  if (rx1 - rx0 <= 1e-3 || ry1 - ry0 <= 1e-3) return fail('hinge-margin-large');

  if (LATTICE.includes(o.kind)) return latticeHinge(rx0, ry0, rx1, ry1, o);

  // Straight (masonry) & Wave (cubic Bézier Hermite pieces per eighth-wave), cuts parallel to Y (spine)
  const wave = o.kind === 'wave' && o.waveAmp > 0;
  const A = wave ? o.waveAmp : 0;
  const k = (2 * Math.PI) / o.waveLength;
  const uc = (ry0 + ry1) / 2;
  const vc = (rx0 + rx1) / 2;

  const f = (u: number) => A * Math.sin(k * (u - uc));
  const df = (u: number) => A * k * Math.cos(k * (u - uc));
  // Point in cover coordinates: x = v + f(u), y = u
  const W = (u: number, v: number): Pt => ({ x: v + f(u), y: u });

  const K = Math.floor(((rx1 - rx0) / 2 + A) / o.spacing);
  const P = o.cutLength + o.bridge;
  const est = (2 * K + 1) * Math.ceil((ry1 - ry0) / P + 1);
  if (est > MAX_CUTS * 1.5) return fail('hinge-too-many', { max: MAX_CUTS });

  const minPiece = Math.max(0.5, Math.min(o.bridge, o.cutLength / 2));

  const makeCut = (v: number, a: number, b: number, rev: boolean): SubPath => {
    let nodes: Node[];
    if (!wave) {
      nodes = [W(a, v), W(b, v)];
    } else {
      // Exact cubic Hermite spline per eighth-wave (< 0.1% deviation from true sine), identical to src/hinges.ts
      const q = o.waveLength / 8;
      const ts = [a];
      for (let t = uc + Math.ceil((a - uc) / q + 1e-9) * q; t < b - 1e-6; t += q) {
        if (t > a + 1e-6) ts.push(t);
      }
      ts.push(b);
      const tan = (u: number): Pt => ({ x: df(u), y: 1 });
      nodes = ts.map((t) => ({ ...W(t, v) }));
      for (let i = 0; i + 1 < ts.length; i++) {
        const d = (ts[i + 1] - ts[i]) / 3;
        const t0 = tan(ts[i]);
        const t1 = tan(ts[i + 1]);
        const p0 = nodes[i];
        const p1 = nodes[i + 1];
        p0.cout = { x: p0.x + d * t0.x, y: p0.y + d * t0.y };
        p1.cin = { x: p1.x - d * t1.x, y: p1.y - d * t1.y };
        if (i > 0) p0.smooth = true;
      }
    }
    return { closed: false, nodes: rev ? reverseNodes(nodes) : nodes };
  };

  const subs: SubPath[] = [];
  let rows = 0;
  let totalLength = 0;

  for (let r = -K; r <= K; r++) {
    const v = vc + r * o.spacing;
    const iv = waveIntervals(ry0, ry1, uc, v, A, k, rx0, rx1);
    if (!iv.length) continue;

    // Masonry stagger: every second row shifted by half a pitch
    const shift = Math.abs(r) % 2 ? P / 2 : 0;
    const jA = Math.floor((ry0 - uc - shift) / P) - 1;
    const jB = Math.ceil((ry1 - uc - shift) / P) + 1;
    const row: [number, number][] = [];

    for (let j = jA; j <= jB; j++) {
      const c = uc + shift + j * P;
      const a = c - o.cutLength / 2;
      const b = c + o.cutLength / 2;
      for (const [ia, ib] of iv) {
        const s = Math.max(a, ia);
        const e = Math.min(b, ib);
        if (e - s >= minPiece - 1e-6) row.push([s, e]);
      }
    }
    if (!row.length) continue;

    // Alternate direction per row to minimize laser travel
    const rev = rows % 2 === 1;
    if (rev) row.reverse();
    for (const [s, e] of row) {
      subs.push(makeCut(v, s, e, rev));
      totalLength += e - s;
    }
    rows++;
    if (subs.length > MAX_CUTS) return fail('hinge-too-many', { max: MAX_CUTS });
  }

  if (!subs.length) return fail('hinge-empty');

  if (wave) {
    // Arc-length factor for sine wave y = A*sin(k*u) (same 64-step Simpson/trapezoidal factor as src/hinges.ts)
    const n = 64;
    let factor = 0;
    for (let i = 0; i < n; i++) {
      const u = ((i + 0.5) * o.waveLength) / n;
      factor += Math.hypot(1, df(uc + u));
    }
    totalLength *= factor / n;
  }

  return { subs, cuts: subs.length, totalLength };
}
