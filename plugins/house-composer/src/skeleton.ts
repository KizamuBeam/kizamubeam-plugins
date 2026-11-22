// Pure-TypeScript orthogonal straight-skeleton & rectilinear polygon roof helpers.
// Used for L-, U-, C-, T-, and arbitrary simple orthogonal house footprints across all roof types.
//
// Coordinate convention: 2D math coordinates (X right, Y back/up), normalized CCW (interior to the LEFT
// of every directed edge a → b, so inward normal N = (-ty, tx)).

export type XY = [number, number];

const EPS = 1e-6;

/** Signed area of a simple polygon (> 0 = CCW in math XY) */
export function polySignedArea(pts: XY[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

/** Remove collinear / duplicate consecutive vertices from a closed orthogonal polygon */
export function cleanOrthoPoly(pts: XY[]): XY[] {
  const dedup: XY[] = [];
  for (const p of pts) {
    const prev = dedup[dedup.length - 1];
    if (!prev || Math.hypot(p[0] - prev[0], p[1] - prev[1]) > EPS) dedup.push([p[0], p[1]]);
  }
  if (dedup.length > 1 && Math.hypot(dedup[0][0] - dedup[dedup.length - 1][0], dedup[0][1] - dedup[dedup.length - 1][1]) <= EPS) {
    dedup.pop();
  }
  const out: XY[] = [];
  const n = dedup.length;
  for (let i = 0; i < n; i++) {
    const a = dedup[(i + n - 1) % n];
    const b = dedup[i];
    const c = dedup[(i + 1) % n];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) > EPS) out.push(b);
  }
  return out;
}

/** Normalize a simple polygon to CCW order in math XY (signed area > 0) */
export function ensureCCW(pts: XY[]): XY[] {
  const cleaned = cleanOrthoPoly(pts);
  return polySignedArea(cleaned) < 0 ? [...cleaned].reverse() : cleaned;
}

/** Point-in-polygon ray cast (strictly inside) */
export function pointInPoly(pts: XY[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Compute minimum clear exterior bay/courtyard gaps (along X and along Y) between opposing outer edges
 * of a simple orthogonal polygon. Used to validate that roof overhangs will not self-intersect across a
 * concave U-courtyard or narrow notch.
 */
export function minExteriorBayGaps(polyRaw: XY[]): { gapX: number; gapY: number } {
  const poly = ensureCCW(polyRaw);
  const n = poly.length;
  type Edge = { horiz: boolean; pos: number; a: number; b: number; outSign: 1 | -1 };
  const es: Edge[] = [];
  for (let i = 0; i < n; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % n];
    const horiz = Math.abs(y1 - y0) < EPS;
    if (horiz) {
      // CCW: tangent (+1,0) -> inward (0,+1) -> outward (0,-1)
      const outSign: 1 | -1 = x1 > x0 ? -1 : 1;
      es.push({ horiz: true, pos: y0, a: Math.min(x0, x1), b: Math.max(x0, x1), outSign });
    } else {
      // CCW: tangent (0,+1) -> inward (-1,0) -> outward (+1,0)
      const outSign: 1 | -1 = y1 > y0 ? 1 : -1;
      es.push({ horiz: false, pos: x0, a: Math.min(y0, y1), b: Math.max(y0, y1), outSign });
    }
  }

  let gapX = Infinity;
  let gapY = Infinity;
  for (let i = 0; i < es.length; i++) {
    for (let j = i + 1; j < es.length; j++) {
      const e1 = es[i];
      const e2 = es[j];
      if (e1.horiz !== e2.horiz) continue;
      // Must face EACH OTHER across exterior space
      const lo = e1.pos < e2.pos ? e1 : e2;
      const hi = e1.pos < e2.pos ? e2 : e1;
      if (lo.outSign !== 1 || hi.outSign !== -1) continue;
      const ovA = Math.max(lo.a, hi.a);
      const ovB = Math.min(lo.b, hi.b);
      if (ovB <= ovA + EPS) continue;
      const midSpan = (ovA + ovB) / 2;
      const midPos = (lo.pos + hi.pos) / 2;
      const isExt = lo.horiz ? !pointInPoly(poly, midSpan, midPos) : !pointInPoly(poly, midPos, midSpan);
      if (!isExt) continue;
      const dist = hi.pos - lo.pos;
      if (lo.horiz) gapY = Math.min(gapY, dist);
      else gapX = Math.min(gapX, dist);
    }
  }
  return { gapX, gapY };
}

/**
 * Offset an orthogonal CCW polygon outward by `dx` on vertical edges and `dy` on horizontal edges.
 * Valid whenever `2 * dx < gapX` and `2 * dy < gapY` (guaranteed by validateRoof).
 */
export function offsetOrthoPoly(polyRaw: XY[], dx: number, dy: number): XY[] {
  const poly = ensureCCW(polyRaw);
  const n = poly.length;
  if (Math.abs(dx) < EPS && Math.abs(dy) < EPS) return poly;
  // Each edge shifts outward along its outward normal (-nx, -ny)
  type Line = { horiz: boolean; c: number };
  const lines: Line[] = [];
  for (let i = 0; i < n; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % n];
    const horiz = Math.abs(y1 - y0) < EPS;
    if (horiz) {
      const outY = x1 > x0 ? -1 : 1;
      lines.push({ horiz: true, c: y0 + outY * dy });
    } else {
      const outX = y1 > y0 ? 1 : -1;
      lines.push({ horiz: false, c: x0 + outX * dx });
    }
  }
  const out: XY[] = [];
  for (let i = 0; i < n; i++) {
    const prev = lines[(i + n - 1) % n];
    const cur = lines[i];
    if (prev.horiz && !cur.horiz) out.push([cur.c, prev.c]);
    else if (!prev.horiz && cur.horiz) out.push([prev.c, cur.c]);
    else out.push(poly[i]);
  }
  return cleanOrthoPoly(out);
}

/** One planar roof face of the orthogonal straight skeleton (swept inward from outer edge `orig`) */
export interface SkeletonFace {
  /** Index of originating outer edge in the CCW input polygon */
  orig: number;
  /** Outward unit tangent T = (tx, ty) of the originating edge (CCW) */
  tx: number;
  ty: number;
  /** Inward unit normal N = (-ty, tx) of the originating edge */
  nx: number;
  ny: number;
  /** Initial coordinate along N: P · N = line0 on the outer eaves edge */
  line0: number;
  /** Swept convex quads/triangles in math XY that partition this roof face (exact, non-overlapping) */
  quads: XY[][];
  /** Maximum inward skeleton distance s reached by this face */
  maxS: number;
}

/** One horizontal/vertical ridge segment emitted where two opposing parallel roof planes collide */
export interface SkeletonRidge {
  axis: 'x' | 'y';
  /** Constant coordinate (Y if axis='x', X if axis='y') */
  at: number;
  /** Span along the ridge axis [a..b] (a <= b) */
  a: number;
  b: number;
  /** Inward skeleton distance s from the input eaves polygon */
  s: number;
  /** Originating outer edge indices on the two sides of the ridge */
  sideNegOrig: number;
  sidePosOrig: number;
}

export interface StraightSkeletonResult {
  /** Normalized CCW input polygon */
  poly: XY[];
  /** One face entry per outer edge of `poly` */
  faces: SkeletonFace[];
  /** All ridge segments (including zero-length pyramid apexes if a square wing collapses to a point) */
  ridges: SkeletonRidge[];
  /** All 45° hip and valley segments traced by moving vertices (for plan preview) */
  diagonals: [XY, XY][];
  /** Maximum inward distance s reached across the entire polygon */
  maxS: number;
}

interface ActiveEdge {
  orig: number;
  /** Exact starting vertex of this edge in the current loop */
  p: XY;
  tx: number;
  ty: number;
  nx: number;
  ny: number;
  /** Coordinate along N: points on this edge satisfy P · N = line */
  line: number;
}

interface DirSeg {
  orig: number;
  tx: number;
  ty: number;
  nx: number;
  ny: number;
  line: number;
  /** Start and end coordinates along tangent T (always s0 < s1) */
  s0: number;
  s1: number;
}

function vertVelocity(prev: ActiveEdge, cur: ActiveEdge): [number, number] {
  // Collinear seam between two edges with identical inward normal advances purely along N
  if (prev.nx === cur.nx && prev.ny === cur.ny) return [cur.nx, cur.ny];
  // Perpendicular corner advances along N_prev + N_cur
  return [prev.nx + cur.nx, prev.ny + cur.ny];
}

function snapNum(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

function ptKey(x: number, y: number): string {
  return `${Math.round(x * 1e4)},${Math.round(y * 1e4)}`;
}

/**
 * Compute the exact orthogonal straight skeleton of a simple rectilinear polygon (L, U, C, T, H, etc.).
 * Advances all edges inward at unit speed using event-driven edge/split resolution and opposite-edge cancellation.
 */
export function orthogonalStraightSkeleton(polyRaw: XY[]): StraightSkeletonResult {
  const poly = ensureCCW(polyRaw);
  const n0 = poly.length;

  const faces: SkeletonFace[] = [];
  const initLoop: ActiveEdge[] = [];
  for (let i = 0; i < n0; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % n0];
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    const tx = Math.abs(dx) >= Math.abs(dy) ? Math.sign(dx) : 0;
    const ty = Math.abs(dy) > Math.abs(dx) ? Math.sign(dy) : 0;
    const nx = -ty;
    const ny = tx;
    const line0 = x0 * nx + y0 * ny;
    if (len < EPS) continue;
    const orig = faces.length;
    faces.push({ orig, tx, ty, nx, ny, line0, quads: [], maxS: 0 });
    initLoop.push({ orig, p: [x0, y0], tx, ty, nx, ny, line: line0 });
  }

  let loops: ActiveEdge[][] = initLoop.length >= 4 ? [initLoop] : [];
  const ridges: SkeletonRidge[] = [];
  const diagonals: [XY, XY][] = [];
  let curS = 0;

  for (let iter = 0; iter < 64 && loops.length > 0; iter++) {
    // 1. Compute current vertices & velocities for all active loops
    type VInfo = { loopIdx: number; edgeIdx: number; p: XY; vx: number; vy: number; reflex: boolean };
    const loopVel: [number, number][][] = [];
    const allVerts: VInfo[] = [];

    for (let li = 0; li < loops.length; li++) {
      const lp = loops[li];
      const m = lp.length;
      const vels: [number, number][] = [];
      for (let i = 0; i < m; i++) {
        const prev = lp[(i + m - 1) % m];
        const cur = lp[i];
        const [vx, vy] = vertVelocity(prev, cur);
        vels.push([vx, vy]);
        const cross = prev.tx * cur.ty - prev.ty * cur.tx;
        const reflex = cross < -0.5;
        allVerts.push({
          loopIdx: li,
          edgeIdx: i,
          p: cur.p,
          vx,
          vy,
          reflex,
        });
      }
      loopVel.push(vels);
    }

    // 2. Find earliest positive event time dt = min(edge events, reflex split events, reflex-reflex collisions)
    let dt = Infinity;

    // 2a. Edge events: edge length shrinks whenever (v_end - v_start) · T < 0
    for (let li = 0; li < loops.length; li++) {
      const lp = loops[li];
      const vels = loopVel[li];
      const m = lp.length;
      for (let i = 0; i < m; i++) {
        const cur = lp[i];
        const p0 = cur.p;
        const p1 = lp[(i + 1) % m].p;
        const [v0x, v0y] = vels[i];
        const [v1x, v1y] = vels[(i + 1) % m];
        const len = (p1[0] - p0[0]) * cur.tx + (p1[1] - p0[1]) * cur.ty;
        const rate = (v1x - v0x) * cur.tx + (v1y - v0y) * cur.ty;
        if (rate < -0.5) {
          const cand = len / -rate;
          if (cand > EPS && cand < dt) dt = cand;
        }
      }
    }

    // 2b. Split events: reflex vertex hitting an opposing edge
    for (const rv of allVerts) {
      if (!rv.reflex) continue;
      for (let li = 0; li < loops.length; li++) {
        const lp = loops[li];
        const vels = loopVel[li];
        const m = lp.length;
        for (let j = 0; j < m; j++) {
          if (li === rv.loopIdx && (j === rv.edgeIdx || j === (rv.edgeIdx + m - 1) % m)) continue;
          const ej = lp[j];
          const dotVN = rv.vx * ej.nx + rv.vy * ej.ny;
          if (dotVN > -0.5) continue;
          const dist = rv.p[0] * ej.nx + rv.p[1] * ej.ny - ej.line;
          const cand = dist / (1 - dotVN);
          if (cand <= EPS || cand >= dt + EPS) continue;
          const rx = rv.p[0] + rv.vx * cand;
          const ry = rv.p[1] + rv.vy * cand;
          const rT = rx * ej.tx + ry * ej.ty;
          const a0 = ej.p;
          const b0 = lp[(j + 1) % m].p;
          const [vax, vay] = vels[j];
          const [vbx, vby] = vels[(j + 1) % m];
          const aT = (a0[0] + vax * cand) * ej.tx + (a0[1] + vay * cand) * ej.ty;
          const bT = (b0[0] + vbx * cand) * ej.tx + (b0[1] + vby * cand) * ej.ty;
          if (rT >= Math.min(aT, bT) - 1e-4 && rT <= Math.max(aT, bT) + 1e-4) {
            if (cand < dt) dt = cand;
          }
        }
      }
    }

    // 2c. Reflex-reflex head-on collision
    for (let i = 0; i < allVerts.length; i++) {
      const a = allVerts[i];
      if (!a.reflex) continue;
      for (let j = i + 1; j < allVerts.length; j++) {
        const b = allVerts[j];
        if (!b.reflex) continue;
        const dvx = a.vx - b.vx;
        const dvy = a.vy - b.vy;
        if (Math.abs(dvx) < 0.5 || Math.abs(dvy) < 0.5) continue;
        const tx = (b.p[0] - a.p[0]) / dvx;
        const ty = (b.p[1] - a.p[1]) / dvy;
        if (tx > EPS && Math.abs(tx - ty) < 1e-4 && tx < dt) dt = tx;
      }
    }

    if (!Number.isFinite(dt) || dt <= EPS) break;
    curS += dt;

    // 3. Record swept quads & diagonals, and collect shifted directed segments
    const rawSegs: DirSeg[] = [];
    for (let li = 0; li < loops.length; li++) {
      const lp = loops[li];
      const vels = loopVel[li];
      const m = lp.length;
      const newVs: XY[] = [];
      for (let i = 0; i < m; i++) {
        const pOld = lp[i].p;
        const [vx, vy] = vels[i];
        const pNew: XY = [pOld[0] + vx * dt, pOld[1] + vy * dt];
        newVs.push(pNew);
        if (Math.abs(vx) > 0.5 && Math.abs(vy) > 0.5 && Math.hypot(pNew[0] - pOld[0], pNew[1] - pOld[1]) > EPS) {
          diagonals.push([pOld, pNew]);
        }
      }

      for (let i = 0; i < m; i++) {
        const e = lp[i];
        const a0 = e.p;
        const b0 = lp[(i + 1) % m].p;
        const a1 = newVs[i];
        const b1 = newVs[(i + 1) % m];
        const quad = cleanOrthoPoly([a0, b0, b1, a1]);
        if (quad.length >= 3 && Math.abs(polySignedArea(quad)) > 1e-5) {
          faces[e.orig].quads.push(quad);
          faces[e.orig].maxS = Math.max(faces[e.orig].maxS, curS);
        }
        const s0 = a1[0] * e.tx + a1[1] * e.ty;
        const s1 = b1[0] * e.tx + b1[1] * e.ty;
        if (s1 - s0 > 1e-4) {
          rawSegs.push({ orig: e.orig, tx: e.tx, ty: e.ty, nx: e.nx, ny: e.ny, line: e.line + dt, s0, s1 });
        }
      }
    }

    if (!rawSegs.length) break;

    // 4. Split segments at all shared coordinates and cancel opposite collinear overlaps (emitting ridges!)
    const splitXs: number[] = [];
    const splitYs: number[] = [];
    for (const seg of rawSegs) {
      const [ax, ay] = [seg.line * seg.nx + seg.s0 * seg.tx, seg.line * seg.ny + seg.s0 * seg.ty];
      const [bx, by] = [seg.line * seg.nx + seg.s1 * seg.tx, seg.line * seg.ny + seg.s1 * seg.ty];
      splitXs.push(ax, bx);
      splitYs.push(ay, by);
    }

    type UnitSeg = { orig: number; horiz: boolean; coord: number; a: number; b: number; dir: 1 | -1; nx: number; ny: number };
    const units: UnitSeg[] = [];
    for (const seg of rawSegs) {
      const horiz = Math.abs(seg.ty) < 0.5;
      const coord = horiz ? seg.line * seg.ny : seg.line * seg.nx;
      const dir: 1 | -1 = horiz ? (seg.tx > 0 ? 1 : -1) : seg.ty > 0 ? 1 : -1;
      const u0 = dir === 1 ? seg.s0 : -seg.s1;
      const u1 = dir === 1 ? seg.s1 : -seg.s0;
      const cuts = (horiz ? splitXs : splitYs)
        .filter((v) => v > u0 + 1e-4 && v < u1 - 1e-4)
        .sort((p, q) => p - q);
      const pts: number[] = [u0];
      for (const c of cuts) if (c - pts[pts.length - 1] > 1e-4) pts.push(c);
      pts.push(u1);
      for (let k = 0; k + 1 < pts.length; k++) {
        if (pts[k + 1] - pts[k] > 1e-4) {
          units.push({ orig: seg.orig, horiz, coord, a: pts[k], b: pts[k + 1], dir, nx: seg.nx, ny: seg.ny });
        }
      }
    }

    // Cancel opposite collinear unit segments -> emit ridges
    const dead = new Uint8Array(units.length);
    for (let i = 0; i < units.length; i++) {
      if (dead[i]) continue;
      for (let j = i + 1; j < units.length; j++) {
        if (dead[j]) continue;
        const u = units[i];
        const v = units[j];
        if (
          u.horiz === v.horiz &&
          Math.abs(u.coord - v.coord) < 1e-3 &&
          Math.abs(u.a - v.a) < 1e-3 &&
          Math.abs(u.b - v.b) < 1e-3 &&
          u.dir === -v.dir
        ) {
          dead[i] = 1;
          dead[j] = 1;
          const posSide = (u.horiz ? u.ny : u.nx) > 0 ? u.orig : v.orig;
          const negSide = (u.horiz ? u.ny : u.nx) < 0 ? u.orig : v.orig;
          ridges.push({
            axis: u.horiz ? 'x' : 'y',
            at: snapNum(u.coord),
            a: snapNum(u.a),
            b: snapNum(u.b),
            s: curS,
            sideNegOrig: negSide,
            sidePosOrig: posSide,
          });
          break;
        }
      }
    }

    const alive = units.filter((_, idx) => !dead[idx]);
    if (!alive.length) break;

    // 5. Reassemble surviving directed segments into simple CCW loops
    type DEdge = {
      u: UnitSeg;
      ax: number;
      ay: number;
      bx: number;
      by: number;
      tx: number;
      ty: number;
      used: boolean;
    };
    const dEdges: DEdge[] = alive.map((u) => {
      const ax = u.horiz ? (u.dir === 1 ? u.a : u.b) : u.coord;
      const ay = u.horiz ? u.coord : u.dir === 1 ? u.a : u.b;
      const bx = u.horiz ? (u.dir === 1 ? u.b : u.a) : u.coord;
      const by = u.horiz ? u.coord : u.dir === 1 ? u.b : u.a;
      return { u, ax, ay, bx, by, tx: u.horiz ? u.dir : 0, ty: u.horiz ? 0 : u.dir, used: false };
    });

    const outFrom = new Map<string, DEdge[]>();
    for (const de of dEdges) {
      const k = ptKey(de.ax, de.ay);
      (outFrom.get(k) ?? (outFrom.set(k, []), outFrom.get(k)!)).push(de);
    }

    const nextLoops: ActiveEdge[][] = [];
    for (const start of dEdges) {
      if (start.used) continue;
      const chain: DEdge[] = [];
      let cur: DEdge | undefined = start;
      let guard = 0;
      while (cur && !cur.used && guard++ <= dEdges.length + 2) {
        cur.used = true;
        chain.push(cur);
        const cands: DEdge[] = (outFrom.get(ptKey(cur.bx, cur.by)) ?? []).filter((c) => !c.used);
        if (!cands.length) break;
        if (cands.length === 1) {
          cur = cands[0];
        } else {
          const score = (c: DEdge) => {
            const cross = cur!.tx * c.ty - cur!.ty * c.tx;
            const dot = cur!.tx * c.tx + cur!.ty * c.ty;
            if (cross > 0.5) return 0; // sharpest left turn
            if (dot > 0.5) return 1; // straight
            return 2; // right turn
          };
          cands.sort((p, q) => score(p) - score(q));
          cur = cands[0];
        }
      }
      if (chain.length < 4) continue;
      // Merge consecutive collinear edges that share the SAME orig
      const merged: ActiveEdge[] = [];
      for (const de of chain) {
        const line = de.ax * de.u.nx + de.ay * de.u.ny;
        const prev = merged[merged.length - 1];
        if (
          prev &&
          prev.tx === de.tx &&
          prev.ty === de.ty &&
          Math.abs(prev.line - line) < 1e-3 &&
          prev.orig === de.u.orig
        ) {
          continue;
        }
        merged.push({ orig: de.u.orig, p: [de.ax, de.ay], tx: de.tx, ty: de.ty, nx: de.u.nx, ny: de.u.ny, line });
      }
      if (
        merged.length > 1 &&
        merged[0].tx === merged[merged.length - 1].tx &&
        merged[0].ty === merged[merged.length - 1].ty &&
        Math.abs(merged[0].line - merged[merged.length - 1].line) < 1e-3 &&
        merged[0].orig === merged[merged.length - 1].orig
      ) {
        merged[0].p = merged[merged.length - 1].p;
        merged.pop();
      }
      if (merged.length >= 4) {
        const pts: XY[] = merged.map((e) => e.p);
        if (polySignedArea(pts) > 1e-4) nextLoops.push(merged);
      }
    }
    loops = nextLoops;
  }

  // Merge adjacent collinear ridge segments at identical (axis, at, s)
  const mergedRidges: SkeletonRidge[] = [];
  for (const r of ridges) {
    const existing = mergedRidges.find(
      (m) =>
        m.axis === r.axis &&
        Math.abs(m.at - r.at) < 1e-3 &&
        Math.abs(m.s - r.s) < 1e-3 &&
        (Math.abs(m.b - r.a) < 1e-3 || Math.abs(r.b - m.a) < 1e-3),
    );
    if (existing) {
      existing.a = Math.min(existing.a, r.a);
      existing.b = Math.max(existing.b, r.b);
    } else {
      mergedRidges.push({ ...r });
    }
  }

  return { poly, faces, ridges: mergedRidges, diagonals, maxS: curS };
}

/**
 * Intersect an axis-aligned line (`axis === 'x'` => constant Y = at, returning X spans;
 * `axis === 'y'` => constant X = at, returning Y spans) with a simple polygon `poly`.
 * Returns sorted interior intervals `[u0, u1]`.
 */
export function polyChordIntervals(poly: XY[], axis: 'x' | 'y', at: number): [number, number][] {
  const xs: number[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % n];
    const [u0, v0, u1, v1] = axis === 'x' ? [x0, y0, x1, y1] : [y0, x0, y1, x1];
    if ((v0 <= at && v1 > at) || (v1 <= at && v0 > at)) {
      const f = (at - v0) / (v1 - v0);
      xs.push(u0 + f * (u1 - u0));
    }
  }
  xs.sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (xs[i + 1] - xs[i] > EPS) out.push([xs[i], xs[i + 1]]);
  }
  return out;
}

/**
 * Sample the straight-skeleton roof profile along a chord `[uStart..uEnd]` (constant Y=at if axis='x',
 * constant X=at if axis='y'). Returns piecewise linear segments with originating face index `orig` and
 * skeleton distance `s0..s1` (from the eaves polygon).
 */
export function skeletonChordProfile(
  skel: StraightSkeletonResult,
  axis: 'x' | 'y',
  at: number,
  uStart: number,
  uEnd: number,
): { u0: number; u1: number; s0: number; s1: number; orig: number }[] {
  const raw: { u0: number; u1: number; s0: number; s1: number; orig: number }[] = [];
  for (const f of skel.faces) {
    for (const q of f.quads) {
      const ivs = polyChordIntervals(q, axis, at);
      for (const [a, b] of ivs) {
        const u0 = Math.max(uStart, a);
        const u1 = Math.min(uEnd, b);
        if (u1 - u0 <= 1e-4) continue;
        const sAt = (u: number) => {
          const [px, py] = axis === 'x' ? [u, at] : [at, u];
          return px * f.nx + py * f.ny - f.line0;
        };
        raw.push({ u0, u1, s0: sAt(u0), s1: sAt(u1), orig: f.orig });
      }
    }
  }
  raw.sort((p, q) => p.u0 - q.u0);
  // Merge consecutive segments belonging to the same face
  const merged: typeof raw = [];
  for (const seg of raw) {
    const prev = merged[merged.length - 1];
    if (prev && prev.orig === seg.orig && Math.abs(prev.u1 - seg.u0) < 1e-3) {
      prev.u1 = seg.u1;
      prev.s1 = seg.s1;
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}

/**
 * Exact pure-TypeScript half-plane clip of an orthogonal polygon against `x <= limit` / `x >= limit`
 * (axis='x') or `y <= limit` / `y >= limit` (axis='y').
 * Returns 0, 1, or multiple disjoint CCW simple polygons (e.g. a deep U-courtyard split across a gable ridge).
 */
export function clipOrthoPolyHalfPlane(
  polyRaw: XY[],
  axis: 'x' | 'y',
  limit: number,
  keepLess: boolean,
): XY[][] {
  const poly = ensureCCW(polyRaw);
  const uniq = (vals: number[]) => {
    const s = [...vals].sort((a, b) => a - b);
    const out: number[] = [];
    for (const v of s) if (!out.length || v - out[out.length - 1] > 1e-5) out.push(v);
    return out;
  };
  const xs = uniq([...poly.map((p) => p[0]), ...(axis === 'x' ? [limit] : [])]);
  const ys = uniq([...poly.map((p) => p[1]), ...(axis === 'y' ? [limit] : [])]);
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  if (nx < 1 || ny < 1) return [];

  // Mark grid cells strictly inside poly AND on the kept side of `limit`
  const cell: boolean[][] = Array.from({ length: nx }, () => new Array<boolean>(ny).fill(false));
  for (let i = 0; i < nx; i++) {
    const mx = (xs[i] + xs[i + 1]) / 2;
    if (axis === 'x' && (keepLess ? mx > limit : mx < limit)) continue;
    for (let j = 0; j < ny; j++) {
      const my = (ys[j] + ys[j + 1]) / 2;
      if (axis === 'y' && (keepLess ? my > limit : my < limit)) continue;
      if (pointInPoly(poly, mx, my)) cell[i][j] = true;
    }
  }

  // Extract CCW boundary loops per connected component of marked cells
  const visited: boolean[][] = Array.from({ length: nx }, () => new Array<boolean>(ny).fill(false));
  const outPolys: XY[][] = [];

  for (let si = 0; si < nx; si++) {
    for (let sj = 0; sj < ny; sj++) {
      if (!cell[si][sj] || visited[si][sj]) continue;
      const comp: boolean[][] = Array.from({ length: nx }, () => new Array<boolean>(ny).fill(false));
      const stack: [number, number][] = [[si, sj]];
      visited[si][sj] = true;
      comp[si][sj] = true;
      while (stack.length) {
        const [ci, cj] = stack.pop()!;
        for (const [ni, nj] of [[ci + 1, cj], [ci - 1, cj], [ci, cj + 1], [ci, cj - 1]]) {
          if (ni >= 0 && nj >= 0 && ni < nx && nj < ny && cell[ni][nj] && !visited[ni][nj]) {
            visited[ni][nj] = true;
            comp[ni][nj] = true;
            stack.push([ni, nj]);
          }
        }
      }

      // Build CCW directed boundary edges (in math XY: interior on LEFT of directed edge)
      const on = (i: number, j: number) => i >= 0 && j >= 0 && i < nx && j < ny && comp[i][j];
      type GEdge = { a: [number, number]; b: [number, number]; used: boolean };
      const edges: GEdge[] = [];
      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < ny; j++) {
          if (!comp[i][j]) continue;
          if (!on(i, j - 1)) edges.push({ a: [i, j], b: [i + 1, j], used: false });
          if (!on(i + 1, j)) edges.push({ a: [i + 1, j], b: [i + 1, j + 1], used: false });
          if (!on(i, j + 1)) edges.push({ a: [i + 1, j + 1], b: [i, j + 1], used: false });
          if (!on(i - 1, j)) edges.push({ a: [i, j + 1], b: [i, j], used: false });
        }
      }
      const byStart = new Map<string, GEdge[]>();
      const gk = (p: [number, number]) => `${p[0]},${p[1]}`;
      for (const e of edges) (byStart.get(gk(e.a)) ?? (byStart.set(gk(e.a), []), byStart.get(gk(e.a))!)).push(e);

      for (const start of edges) {
        if (start.used) continue;
        const pts: XY[] = [];
        let cur: GEdge | undefined = start;
        let guard = 0;
        while (cur && !cur.used && guard++ <= edges.length + 2) {
          cur.used = true;
          pts.push([xs[cur.a[0]], ys[cur.a[1]]]);
          const cands: GEdge[] = (byStart.get(gk(cur.b)) ?? []).filter((e) => !e.used);
          if (!cands.length) break;
          if (cands.length === 1) {
            cur = cands[0];
          } else {
            const dx = cur.b[0] - cur.a[0];
            const dy = cur.b[1] - cur.a[1];
            const score = (e: GEdge) => {
              const ex = e.b[0] - e.a[0];
              const ey = e.b[1] - e.a[1];
              const cross = dx * ey - dy * ex;
              const dot = dx * ex + dy * ey;
              return cross > 0 ? 0 : dot > 0 ? 1 : 2;
            };
            cands.sort((p, q) => score(p) - score(q));
            cur = cands[0];
          }
        }
        const cleaned = cleanOrthoPoly(pts);
        if (cleaned.length >= 3 && polySignedArea(cleaned) > 1e-4) outPolys.push(cleaned);
      }
    }
  }
  return outPolys;
}

/**
 * Merge adjacent non-overlapping CCW convex quads/triangles belonging to one straight-skeleton face
 * into clean simple outer boundary polygon(s) by cancelling shared opposite internal edges.
 */
export function mergeFaceQuads(quads: XY[][]): XY[][] {
  if (!quads.length) return [];
  if (quads.length === 1) return [ensureCCW(quads[0])];

  // Collect all directed edges from every quad (normalized CCW)
  type Seg = { a: XY; b: XY; dead: boolean };
  const raw: Seg[] = [];
  for (const qRaw of quads) {
    const q = ensureCCW(qRaw);
    for (let i = 0; i < q.length; i++) {
      const a = q[i];
      const b = q[(i + 1) % q.length];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-5) raw.push({ a, b, dead: false });
    }
  }

  // Split any edge that contains another quad's vertex strictly in its interior (T-junction along shared seam)
  const allPts: XY[] = [];
  for (const s of raw) allPts.push(s.a, s.b);
  const segs: Seg[] = [];
  for (const s of raw) {
    const dx = s.b[0] - s.a[0];
    const dy = s.b[1] - s.a[1];
    const len = Math.hypot(dx, dy);
    const ux = dx / len;
    const uy = dy / len;
    const ts: number[] = [0, len];
    for (const p of allPts) {
      const px = p[0] - s.a[0];
      const py = p[1] - s.a[1];
      const proj = px * ux + py * uy;
      if (proj > 1e-4 && proj < len - 1e-4) {
        const perp = Math.abs(px * uy - py * ux);
        if (perp < 1e-3) ts.push(proj);
      }
    }
    ts.sort((p, q) => p - q);
    const uniqT: number[] = [];
    for (const tv of ts) if (!uniqT.length || tv - uniqT[uniqT.length - 1] > 1e-4) uniqT.push(tv);
    for (let k = 0; k + 1 < uniqT.length; k++) {
      segs.push({
        a: [s.a[0] + ux * uniqT[k], s.a[1] + uy * uniqT[k]],
        b: [s.a[0] + ux * uniqT[k + 1], s.a[1] + uy * uniqT[k + 1]],
        dead: false,
      });
    }
  }

  // Cancel opposite coincident edge pairs (internal shared seams between adjacent quads)
  const near = (p: XY, q: XY) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-3;
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].dead) continue;
    for (let j = i + 1; j < segs.length; j++) {
      if (segs[j].dead) continue;
      if (near(segs[i].a, segs[j].b) && near(segs[i].b, segs[j].a)) {
        segs[i].dead = true;
        segs[j].dead = true;
        break;
      }
    }
  }

  const alive = segs.filter((s) => !s.dead).map((s) => ({ ...s, used: false }));
  const outFrom = new Map<string, typeof alive>();
  for (const s of alive) {
    const k = ptKey(s.a[0], s.a[1]);
    (outFrom.get(k) ?? (outFrom.set(k, []), outFrom.get(k)!)).push(s);
  }

  const polys: XY[][] = [];
  for (const start of alive) {
    if (start.used) continue;
    const pts: XY[] = [];
    let cur: (typeof alive)[number] | undefined = start;
    let guard = 0;
    while (cur && !cur.used && guard++ <= alive.length + 2) {
      cur.used = true;
      pts.push(cur.a);
      const cands: typeof alive = (outFrom.get(ptKey(cur.b[0], cur.b[1])) ?? []).filter((c) => !c.used);
      if (!cands.length) break;
      if (cands.length === 1) {
        cur = cands[0];
      } else {
        // Pick sharpest CCW left turn
        const inAng = Math.atan2(cur.b[1] - cur.a[1], cur.b[0] - cur.a[0]);
        const turnOf = (c: (typeof alive)[number]) => {
          let d = Math.atan2(c.b[1] - c.a[1], c.b[0] - c.a[0]) - inAng;
          while (d <= -Math.PI) d += 2 * Math.PI;
          while (d > Math.PI) d -= 2 * Math.PI;
          return d;
        };
        cands.sort((p, q) => turnOf(q) - turnOf(p));
        cur = cands[0];
      }
    }
    const cleaned = cleanOrthoPoly(pts);
    if (cleaned.length >= 3 && polySignedArea(cleaned) > 1e-4) polys.push(cleaned);
  }
  return polys;
}

