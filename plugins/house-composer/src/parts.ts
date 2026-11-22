// Parts of the house composer: floor, outer walls (rectangular with any roof type, or shaped with flat roof),
// interior room walls, roof panels, attic trusses, door/window cutouts & engraved marks, kerf and 3D poses.
// Every wood joint comes from the app via host.joints (v: 2).
import { host, polygon, type JointOptions, type Pose, type SubPath, type V3 } from '../../../sdk/ts';
import { fields, joint, panel, tenonStretches, tenonsInto, widen, JointError, type Parts, type Pt } from './joints';
import type { End, Model, OEdgeInfo, Side, WallInfo } from './model';
import type { Pt as XY } from './outline';
import {
  buildWallHosts,
  openingCutouts,
  openingMarks,
  openingTrimFrame,
  outerWallHost,
  safeFrameWidth,
  sillBaseZ,
  type Opening,
  type WallHost,
} from './openings';
import {
  buildChimneyGeom,
  buildRoofPanels,
  buildRoofRails,
  buildRoofTrusses,
  buildShapedChimneyGeom,
  computeRoofMetrics,
  roofOverhangXY,
  roofPatternMarks,
  wallProfile,
  type ChimneyGeom,
  type ChimneySpec,
  type OuterWallKey,
  type RoofExclusion,
  type RoofPanelGeom,
  type RoofRailSpec,
  type RoofSpec,
  type TrussSpec,
} from './roof';
import {
  cleanOrthoPoly,
  clipOrthoPolyHalfPlane,
  ensureCCW,
  mergeFaceQuads,
  offsetOrthoPoly,
  orthogonalStraightSkeleton,
  pointInPoly,
  polyChordIntervals,
  skeletonChordProfile,
} from './skeleton';

export interface HouseDims {
  W: number;
  D: number;
  H: number;
  t: number;
  finger: number;
  /** Total play of a joint (both sides together) */
  clearance: number;
  kerf: number;
  floor: boolean;
  midFloor?: boolean;
  midFloorHeight?: number;
  midFloorStair?: boolean;
  sides: Record<Side, boolean>;
  drop: number;
  roof: RoofSpec;
  chimney?: ChimneySpec;
  engraveFrames: boolean;
  cutoutFrames?: boolean;
  frameWidth: number;
  mullionWidth: number;
}

export interface JointMsg {
  code: string;
  values?: Record<string, number | string>;
}

export interface WallPanel {
  key: string;
  it: WallInfo;
  s: number;
  e: number;
  h: number;
  fromTop: boolean;
  part: string;
  ox: number;
  oy: number;
}

export interface Board {
  key: string;
  axis: 'h' | 'v';
  pos: number;
  edges: OEdgeInfo[];
  members: WallPanel[];
  bs: number;
  be: number;
  h: number;
}

export interface BuiltHouse {
  parts: Parts;
  marks: Record<string, SubPath[]>;
  info: JointMsg[];
  walls: WallPanel[];
  boards: Board[];
  roofPanels: RoofPanelGeom[];
  trusses: TrussSpec[];
  rails: RoofRailSpec[];
  /** Extra 3D poses for optional architectural parts (mid-floor, chimney walls & cap, 3D trim frames) */
  extraPoses: Record<string, Pose>;
  /** Uncentered panel height (maxZ - floorZ or maxZ) for each outer wall, used by 3D poses */
  outerHeights: Partial<Record<OuterWallKey, { topZ: number; botZ: number }>>;
  hosts: Map<string, WallHost>;
}

export const OUTER: Record<Side, OuterWallKey> = { x0: 'left', x1: 'right', y0: 'back', y1: 'front' };
export const wallKey = (id: number) => `wall-${id}`;
export const outerKey = (k: number) => `outer-${k + 1}`;

const EPS = 1e-6;
export const anyOuter = (d: HouseDims) => d.sides.x0 || d.sides.x1 || d.sides.y0 || d.sides.y1;

/** Clear height of interior walls (capped under midFloorHeight when an intermediate floor is enabled) */
export function innerHeight(d: HouseDims): number {
  const m = computeRoofMetrics(d.W, d.D, d.H, d.t, d.roof);
  const floorZ = d.floor ? d.t : 0;
  const lidT = m.flushFlat && anyOuter(d) ? d.t : 0;
  const topCap = d.midFloor && d.midFloorHeight !== undefined ? Math.min(d.H - lidT, d.midFloorHeight) : d.H - lidT;
  return anyOuter(d) ? topCap - floorZ - d.drop : topCap - floorZ;
}

/** Height of shaped-outline outer boards (flat roof only) */
export function outerBoardHeight(d: HouseDims): number {
  const m = computeRoofMetrics(d.W, d.D, d.H, d.t, d.roof);
  const floorZ = d.floor ? d.t : 0;
  const lidT = m.flushFlat ? d.t : 0;
  return d.H - floorZ - lidT;
}

const lapHalf = (d: HouseDims) => Math.max(1.5 * d.t, d.t + Math.max(0, d.clearance) + 0.5);

function endAt(end: End, at: number, dir: -1 | 1, d: HouseDims): number {
  if (end.kind === 'outer') return d.sides[end.side] ? at : at + dir * d.t;
  if (end.kind === 'free' || end.kind === 'edge' || end.kind === 'open' || end.kind === 'board') return at;
  if (end.kind === 'step' && end.at !== undefined) return end.at;
  return at - (dir * d.t) / 2;
}

export function wallPanels(m: Model, d: HouseDims): WallPanel[] {
  const h = innerHeight(d);
  return m.walls.map((it) => ({
    key: wallKey(it.wall.id),
    it,
    s: endAt(it.start, it.wall.from, -1, d),
    e: endAt(it.end, it.wall.to, 1, d),
    h,
    fromTop: it.wall.axis === 'h',
    part: wallKey(it.wall.id),
    ox: 0,
    oy: 0,
  }));
}

/** Stretches of the bottom edge of an inner wall with one tooth in the middle of each (when floor is enabled) */
export function floorSpans(p: WallPanel, d: HouseDims): { a: number; b: number; width: number }[] {
  if (!d.floor) return [];
  const { t, finger } = d;
  const cuts = p.fromTop ? [] : p.it.crosses.map((c) => c.at).sort((x, y) => x - y);
  const lh = lapHalf(d);
  const spans: { a: number; b: number }[] = [];
  let a = p.s;
  for (const c of cuts) {
    spans.push({ a, b: c - lh });
    a = c + lh;
  }
  spans.push({ a, b: p.e });
  const out: { a: number; b: number; width: number }[] = [];
  const endSpan = finger + t;
  spans.forEach((sp, i) => {
    const freeStart = i === 0 && p.it.start.kind === 'free',
      freeEnd = i === spans.length - 1 && p.it.end.kind === 'free';
    const len = sp.b - sp.a;
    const nFree = (freeStart ? 1 : 0) + (freeEnd ? 1 : 0);
    if (!nFree) return out.push(...tenonStretches(sp.a, sp.b, finger));
    if (len < nFree * endSpan + finger) return out.push({ a: sp.a, b: sp.b, width: Math.min(finger, len - t) });
    let sa = sp.a,
      sb = sp.b;
    if (freeStart) {
      out.push({ a: sa, b: sa + endSpan, width: finger });
      sa += endSpan;
    }
    const tail = freeEnd ? { a: sb - endSpan, b: sb, width: finger } : null;
    if (freeEnd) sb -= endSpan;
    out.push(...tenonStretches(sa, sb, finger));
    if (tail) out.push(tail);
  });
  return out.filter((sp) => sp.b - sp.a > EPS);
}

type OuterTenon = (end: End, p: WallPanel) => { into: string; at: (y: number) => Pt } | null;

function wallSplits(p: WallPanel, d: HouseDims, tenoned: (e: End) => boolean) {
  const lh = lapHalf(d);
  const laps = p.it.crosses.flatMap((c) => [c.at - lh - p.s, c.at + lh - p.s]);
  const top = p.fromTop ? laps : [];
  const bottom = [...(p.fromTop ? [] : laps), ...floorSpans(p, d).flatMap((sp) => [sp.a - p.s, sp.b - p.s])];
  const ends = tenonStretches(0, p.h, d.finger).flatMap((sp) => [sp.a, sp.b]);
  return { top, bottom, left: tenoned(p.it.start) ? ends : [], right: tenoned(p.it.end) ? ends : [] };
}

function innerJoints(parts: Parts, walls: WallPanel[], d: HouseDims, info: JointMsg[], outerTenon: OuterTenon): Parts {
  const { W, D, t, finger } = d;
  const byId = new Map(walls.map((p) => [p.it.wall.id, p]));
  const lh = lapHalf(d);
  const P = (p: WallPanel, x: number, y: number): Pt => ({ x: x + p.ox, y: y + p.oy });
  const opts = (o: JointOptions): JointOptions => ({ thickness: t, clearance: d.clearance, ...o });
  const keep = (r: { parts: Parts; info: JointMsg[] }) => {
    parts = r.parts;
    info.push(...r.info);
  };

  for (const p of walls) {
    if (!p.fromTop) continue;
    for (const c of p.it.crosses) {
      const q = byId.get(c.wall)!;
      const at = q.it.crosses.find((x) => x.wall === p.it.wall.id)!.at;
      const x1 = c.at - p.s,
        x2 = at - q.s;
      keep(
        joint(parts, { kind: 'lap', thickness: t, clearance: d.clearance, lapCount: 1, lapDepth: 50 }, [
          { part: p.part, a: P(p, x1 - lh, 0), b: P(p, x1 + lh, 0) },
          { part: q.part, a: P(q, x2 + lh, q.h), b: P(q, x2 - lh, q.h) },
        ]),
      );
    }
  }

  for (const p of walls) {
    for (const which of ['start', 'end'] as const) {
      const end = p.it[which];
      const x = which === 'start' ? 0 : p.e - p.s;
      const edge = { part: p.part, a: P(p, x, 0), b: P(p, x, p.h) };
      const tenons = (into: string, at: (y: number) => Pt) => {
        for (const sp of tenonStretches(0, p.h, finger))
          parts = tenonsInto(parts, opts({ kind: 'tenon', tenonCount: 1, tenonWidth: sp.width }), { part: p.part, a: P(p, x, sp.a), b: P(p, x, sp.b) }, into, at(sp.a), at(sp.b));
      };
      if (end.kind === 'corner') {
        const q = byId.get(end.other)!;
        if (q.it.wall.id < p.it.wall.id) continue;
        const qWhich = q.it.start.kind === 'corner' && q.it.start.other === p.it.wall.id ? 'start' : 'end';
        const qx = qWhich === 'start' ? 0 : q.e - q.s;
        keep(joint(parts, opts({ kind: 'finger', fingerWidth: finger, direction: 'out' }), [edge, { part: q.part, a: P(q, qx, 0), b: P(q, qx, q.h) }]));
      } else if (end.kind === 'tee') {
        const hWall = byId.get(end.host)!;
        const at = hWall.it.tees.find((x) => x.wall === p.it.wall.id)!.at - hWall.s;
        tenons(hWall.part, (y) => P(hWall, at, y));
      } else {
        const o = outerTenon(end, p);
        if (o) tenons(o.into, o.at);
      }
    }
  }

  if (d.floor && parts.floor) {
    for (const p of walls) {
      const w = p.it.wall;
      for (const sp of floorSpans(p, d)) {
        const map = (along: number) =>
          w.axis === 'h' ? { x: along + t - W / 2, y: w.pos + t - D / 2 } : { x: w.pos + t - W / 2, y: along + t - D / 2 };
        parts = tenonsInto(
          parts,
          opts({ kind: 'tenon', tenonCount: 1, tenonWidth: sp.width }),
          { part: p.part, a: P(p, sp.b - p.s, p.h), b: P(p, sp.a - p.s, p.h) },
          'floor',
          map(sp.a),
          map(sp.b),
        );
      }
    }
  }
  return parts;
}

/** Tenon stretches along a sloped or horizontal roof edge between u0 and u1 (returns empty if too short) */
function roofTenonSpans(u0: number, u1: number, t: number, finger: number): { a: number; b: number; width: number }[] {
  const len = u1 - u0;
  if (len < 2.2 * t) return [];
  if (len < Math.max(3 * t, 1.5 * finger)) {
    const w = Math.min(finger, len * 0.45);
    return w >= Math.max(1.5, t * 0.6) ? [{ a: u0, b: u1, width: w }] : [];
  }
  return tenonStretches(u0, u1, finger);
}

/**
 * Put tenons on an edge of `srcKey` and cut matching slots (or flush edge notches when flushSide is set) into `dstKey`.
 * `flushSide`: when the slot lies flush with the left (-1) or right (+1) edge of `dstKey` (gableOverhang === 0),
 * expand the notch outward past that edge and subtract via boolean difference so no thin sliver remains.
 */
function roofTenonInto(
  parts: Parts,
  opts: JointOptions,
  srcEdge: { part: string; a: Pt; b: Pt },
  dstKey: string,
  from: Pt,
  to: Pt,
  flushSide: -1 | 0 | 1,
): Parts {
  if (flushSide === 0) {
    return tenonsInto(parts, opts, srcEdge, dstKey, from, to);
  }
  const GUIDE = '_rguide';
  const r = joint({ ...parts, [GUIDE]: [{ closed: false, nodes: [from, to] }] }, { ...opts, kind: 'tenon' }, [
    srcEdge,
    { part: GUIDE, a: from, b: to },
  ]);
  const slots = r.parts[GUIDE] ?? [];
  const out = { ...r.parts };
  delete out[GUIDE];
  if (slots.length) {
    // Expand each slot rectangle outward past the flush edge by 1 mm so boolean difference cleanly opens the edge
    const notches = slots.map((sp): SubPath => {
      let x0 = Infinity,
        x1 = -Infinity,
        y0 = Infinity,
        y1 = -Infinity;
      for (const n of sp.nodes) {
        x0 = Math.min(x0, n.x);
        x1 = Math.max(x1, n.x);
        y0 = Math.min(y0, n.y);
        y1 = Math.max(y1, n.y);
      }
      if (flushSide < 0) x0 -= 1;
      else x1 += 1;
      return polygon([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
    });
    out[dstKey] = host.boolean({ op: 'difference', a: parts[dstKey], b: notches });
  }
  return out;
}

/** Linearly interpolate point along segment A → B at distance s from A */
function alongSeg(a: Pt, b: Pt, s: number): Pt {
  const L = Math.hypot(b.x - a.x, b.y - a.y);
  const f = L > EPS ? s / L : 0;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

/** Push point onto node array if distinct from last */
function pushNode(nodes: Pt[], x: number, y: number) {
  const last = nodes[nodes.length - 1];
  if (!last || Math.abs(last.x - x) > 1e-7 || Math.abs(last.y - y) > 1e-7) nodes.push({ x, y });
}

/**
 * Find the straight segment matching (a, b) in a closed SubPath (within Clipper grid tolerance) and splice
 * intermediate split points at the given distances from `a` along `a → b`. Returns the updated SubPath and the
 * exact vertex coordinates of `a` and `b` from the path so subsequent segOf() lookups match identically.
 */
function spliceSegment(sub: SubPath, a: Pt, b: Pt, dists: number[]): { sub: SubPath; a: Pt; b: Pt } {
  const tol = 0.05;
  const close = (p: Pt, q: Pt) => Math.hypot(p.x - q.x, p.y - q.y) < tol;
  const ns = sub.nodes;
  const n = ns.length;
  for (let i = 0; i < n; i++) {
    const p = ns[i],
      q = ns[(i + 1) % n];
    const fwd = close(p, a) && close(q, b);
    const rev = !fwd && close(p, b) && close(q, a);
    if (!fwd && !rev) continue;
    const actA = fwd ? p : q;
    const actB = fwd ? q : p;
    const L = Math.hypot(actB.x - actA.x, actB.y - actA.y);
    const unique = [...new Set(dists.filter((s) => s > 0.02 && s < L - 0.02))].sort((u, v) => (fwd ? u - v : v - u));
    const mid = unique.map((s) => alongSeg(actA, actB, s));
    const nextNodes = [...ns.slice(0, i + 1), ...mid, ...ns.slice(i + 1)];
    return { sub: { closed: sub.closed, nodes: nextNodes }, a: actA, b: actB };
  }
  return { sub, a, b };
}

/** Build WallHost map for the current house model (used by validateOpenings and surface elevation views) */
export function houseWallHosts(m: Model, d: HouseDims): Map<string, WallHost> {
  const walls = wallPanels(m, d);
  const innerList = walls.map((p) => {
    const startOuter = p.it.start.kind === 'outer' ? p.it.start.side : undefined;
    const endOuter = p.it.end.kind === 'outer' ? p.it.end.side : undefined;
    const joints = [...p.it.tees.map((x) => x.at), ...p.it.crosses.map((x) => x.at)];
    return {
      id: p.it.wall.id,
      axis: p.it.wall.axis,
      pos: p.it.wall.pos,
      s: p.s,
      e: p.e,
      h: p.h,
      startOuter,
      endOuter,
      joints,
    };
  });
  const hosts = buildWallHosts(d.W, d.D, d.H, d.t, d.floor, d.sides, d.roof, innerList);
  if (!m.outline) return hosts;

  // Shaped L/U/C outline: replace outer wall hosts with the actual built stretches (spans) along each bounding side
  const { W, D, H, t } = d;
  const floorZ = d.floor ? t : 0;
  const sillZ = sillBaseZ(d.floor, t);
  const wInner = W - 2 * t;
  const dInner = D - 2 * t;
  const sideDef: Record<OuterWallKey, { axis: 'h' | 'v'; pos: number; len: number; flipX: boolean }> = {
    front: { axis: 'h', pos: dInner + t / 2, len: W, flipX: false },
    back: { axis: 'h', pos: -t / 2, len: W, flipX: true },
    left: { axis: 'v', pos: -t / 2, len: D, flipX: false },
    right: { axis: 'v', pos: wInner + t / 2, len: D, flipX: true },
  };
  const hasTopJoint = d.roof.mount === 'fixed' && d.roof.type === 'flat';
  const builtEdges = m.outline.edges.filter((e) => !e.open);

  for (const [wk, def] of Object.entries(sideDef) as [OuterWallKey, (typeof sideDef)[OuterWallKey]][]) {
    const matching = builtEdges.filter((e) => e.axis === def.axis && Math.abs(e.pos - def.pos) < 0.05);
    if (!matching.length) {
      hosts.delete(wk);
      continue;
    }
    const spans: [number, number][] = [];
    const jointXs: number[] = [];
    for (const e of matching) {
      // Unflipped outer extent including t/2 wall thickness at both perpendicular ends
      const u0 = e.from + t / 2;
      const u1 = e.to + 1.5 * t;
      const s0 = def.flipX ? def.len - u1 : u0;
      const s1 = def.flipX ? def.len - u0 : u1;
      spans.push([Math.min(s0, s1), Math.max(s0, s1)]);
      for (const tee of e.tees) {
        const u = tee.at + t;
        jointXs.push(def.flipX ? def.len - u : u);
      }
    }
    spans.sort((a, b) => a[0] - b[0]);
    const prof = wallProfile(wk, W, D, H, t, d.roof);
    hosts.set(wk, outerWallHost(prof, floorZ, sillZ, t, true, true, hasTopJoint ? t : 0, jointXs, spans));
  }
  return hosts;
}

/**
 * Build all house parts (without kerf; call withKerf afterwards), marks (engravings), wall/roof metadata and hosts.
 */
export function buildHouseParts(m: Model, d: HouseDims, openings: Opening[]): BuiltHouse {
  if (m.outline) return shapedHouseParts(m, d, openings);

  const { W, D, H, t, finger, sides, roof } = d;
  const info: JointMsg[] = [];
  const marks: Record<string, SubPath[]> = {};
  const floorZ = d.floor ? t : 0;
  const rm = computeRoofMetrics(W, D, H, t, roof);
  const opts = (o: JointOptions): JointOptions => ({ thickness: t, clearance: d.clearance, ...o });
  const keep = (r: { parts: Parts; info: JointMsg[] }) => {
    parts = r.parts;
    info.push(...r.info);
  };

  let parts: Parts = {};

  // 1. Floor plate (inner rectangle between closed walls, reaching outer edge on open sides)
  if (d.floor) {
    const fx0 = sides.x0 ? -W / 2 + t : -W / 2;
    const fx1 = sides.x1 ? W / 2 - t : W / 2;
    const fy0 = sides.y0 ? -D / 2 + t : -D / 2;
    const fy1 = sides.y1 ? D / 2 - t : D / 2;
    parts.floor = [polygon([[fx0, fy0], [fx1, fy0], [fx1, fy1], [fx0, fy1]])];
  }

  // 2. Roof panels (centered in their own 2D planes, outer face UP; marks generated after tenon slots in step 7b)
  const roofPanels = buildRoofPanels(W, D, H, t, roof);
  for (const rp of roofPanels) {
    parts[rp.key] = [polygon(rp.pts)];
  }

  // If flush flat roof, rebuild roof outline as inner rectangle (like floor) for perimeter finger joints
  let flushRoofPts: [number, number][] | null = null;
  if (rm.flushFlat && anyOuter(d)) {
    const rx0 = sides.x0 ? -W / 2 + t : -W / 2;
    const rx1 = sides.x1 ? W / 2 - t : W / 2;
    const ry0 = sides.y0 ? -D / 2 + t : -D / 2;
    const ry1 = sides.y1 ? D / 2 - t : D / 2;
    flushRoofPts = [[rx0, ry0], [rx1, ry0], [rx1, ry1], [rx0, ry1]];
    parts.roof = [polygon(flushRoofPts)];
  }

  // 3. Prepare the 4 outer walls with exact profiles and top tenon split points
  type WallSetup = {
    key: OuterWallKey;
    L: number;
    topZ: number;
    botZ: number;
    xL: number;
    xR: number;
    yCornerL: number;
    yCornerR: number;
    yBot: number;
    kind: 'flat' | 'gable' | 'shed-slope' | 'shed-high';
    /** Sloped roof tenon attachments: edge segment endpoints in uncentered wall coords + roof mapping */
    slopeJoints: {
      a: Pt;
      b: Pt;
      roofKey: string;
      xRoof: number;
      yRoofAt: (s: number) => number;
      flushSide: -1 | 0 | 1;
      spans: { a: number; b: number; width: number }[];
    }[];
    /** Flat overhanging roof tenon attachments along top edge (flat roof fixed with overhang >= t) */
    flatRoofSpans: { a: number; b: number; width: number }[];
    /** Upper gable triangle or shed cap unioned onto the wall AFTER vertical corner finger joints */
    capPoly?: SubPath;
  };

  const setups = new Map<OuterWallKey, WallSetup>();
  const outerHeights: Partial<Record<OuterWallKey, { topZ: number; botZ: number }>> = {};

  const wallEnabled: Record<OuterWallKey, boolean> = {
    front: sides.y1,
    back: sides.y0,
    left: sides.x0,
    right: sides.x1,
  };
  // Adjacent walls in UNMIRRORED panel coordinates (x=0 on left, x=L on right):
  //   front & back: x=0 is x0 (left), x=W is x1 (right)
  //   left & right: x=0 is y0 (back), x=D is y1 (front)
  const panelAdj: Record<OuterWallKey, { left: Side; right: Side }> = {
    front: { left: 'x0', right: 'x1' },
    back: { left: 'x0', right: 'x1' },
    left: { left: 'y0', right: 'y1' },
    right: { left: 'y0', right: 'y1' },
  };

  const rpByKey = new Map(roofPanels.map((rp) => [rp.key, rp]));

  for (const key of ['front', 'back', 'left', 'right'] as OuterWallKey[]) {
    if (!wallEnabled[key]) continue;
    const prof = wallProfile(key, W, D, H, t, roof);
    const L = prof.width;
    const flipX = key === 'back' || key === 'right';
    const zAtPanel = (xp: number) => prof.zAt(flipX ? L - xp : xp);
    const topZ = rm.flushFlat ? H - t : prof.maxZ;
    const botZ = floorZ;
    const adjL = sides[panelAdj[key].left];
    const adjR = sides[panelAdj[key].right];
    const xL = adjL ? t : 0;
    const xR = adjR ? L - t : L;

    // Corner top Z at x=0 and x=L (for shed-slope, corner meets the adjacent flat wall at its topZ!)
    const adjWallZ = (side: Side) => {
      const k = OUTER[side];
      const p = wallProfile(k, W, D, H, t, roof);
      return rm.flushFlat ? H - t : p.maxZ;
    };
    const cornerZL = adjL ? Math.min(zAtPanel(xL), adjWallZ(panelAdj[key].left)) : zAtPanel(0);
    const cornerZR = adjR ? Math.min(zAtPanel(xR), adjWallZ(panelAdj[key].right)) : zAtPanel(L);

    const yOfZ = (z: number) => topZ - z;
    let yCornerL = yOfZ(cornerZL);
    let yCornerR = yOfZ(cornerZR);
    const yBot = yOfZ(botZ);

    const slopeJoints: WallSetup['slopeJoints'] = [];
    let flatRoofSpans: { a: number; b: number; width: number }[] = [];

    // Flat roof overhanging tenons (fixed mount, overhang >= t)
    if (roof.type === 'flat' && roof.mount === 'fixed' && roof.overhang >= t - EPS) {
      flatRoofSpans = roofTenonSpans(xL, xR, t, finger);
    }

    // Steep gable peak (> 55°): tiny horizontal ridge plateau avoids < 56.3° acute peak tip (check-web-cut)
    const gableHalfFlat =
      roof.type === 'gable' && prof.kind === 'gable' && rm.pitchDeg > 55
        ? Math.min(Math.max(0.6, t * 0.4), Math.min(1.0, t * 0.55))
        : 0;
    const gableYPeak = gableHalfFlat * Math.tan(rm.pitchRad);
    const gableUPeak = gableHalfFlat / Math.cos(rm.pitchRad);

    // Gable roof sloped tenons on gable walls (fixed mount)
    if (roof.type === 'gable' && roof.mount === 'fixed' && prof.kind === 'gable') {
      const ca = Math.cos(rm.pitchRad);
      const tanA = Math.tan(rm.pitchRad);
      const Ls = L / 2 / ca;
      const sRidge = Math.max(t, t * tanA) + t;
      const sEaves = Math.max(t, t / ca) + t;
      const spans = roofTenonSpans(sRidge - gableUPeak, Ls - sEaves - gableUPeak, t, finger);
      const flush: -1 | 0 | 1 = roof.gableOverhang < EPS ? 1 : 0; // sign determined per roof panel below
      const pPeakL: Pt = { x: L / 2 - gableHalfFlat, y: gableYPeak };
      const pPeakR: Pt = { x: L / 2 + gableHalfFlat, y: gableYPeak };
      const pL: Pt = { x: 0, y: yOfZ(H) };
      const pR: Pt = { x: L, y: yOfZ(H) };

      if (roof.ridgeAxis === 'x') {
        // key is 'left' (X = t/2) or 'right' (X = W - t/2).
        // Unmirrored panel x=0 is Back (Y=D), x=D is Front (Y=0).
        // So segment pL→peak is BACK slope (roof-back), segment peak→pR is FRONT slope (roof-front)!
        const rpF = rpByKey.get('roof-front')!;
        const rpB = rpByKey.get('roof-back')!;
        const xF = key === 'left' ? -W / 2 + t / 2 : W / 2 - t / 2;
        const xB = key === 'left' ? W / 2 - t / 2 : -W / 2 + t / 2; // roof-back has u = -X
        const fSideF: -1 | 0 | 1 = flush ? (key === 'left' ? -1 : 1) : 0;
        const fSideB: -1 | 0 | 1 = flush ? (key === 'left' ? 1 : -1) : 0;
        if (spans.length) {
          slopeJoints.push({
            a: pPeakL,
            b: pL,
            roofKey: 'roof-back',
            xRoof: xB,
            yRoofAt: (s) => -rpB.height / 2 + gableUPeak + s,
            flushSide: fSideB,
            spans,
          });
          slopeJoints.push({
            a: pPeakR,
            b: pR,
            roofKey: 'roof-front',
            xRoof: xF,
            yRoofAt: (s) => -rpF.height / 2 + gableUPeak + s,
            flushSide: fSideF,
            spans,
          });
        }
      } else {
        // ridgeAxis === 'y': key is 'front' (Y = t/2) or 'back' (Y = D - t/2).
        // Unmirrored panel x=0 is Left (X=0), x=W is Right (X=W).
        // Segment peak→pL is LEFT slope (roof-left), segment peak→pR is RIGHT slope (roof-right).
        const rpL = rpByKey.get('roof-left')!;
        const rpR = rpByKey.get('roof-right')!;
        const xL_r = key === 'front' ? D / 2 - t / 2 : -D / 2 + t / 2;
        const xR_r = key === 'front' ? -D / 2 + t / 2 : D / 2 - t / 2;
        const fSideL: -1 | 0 | 1 = flush ? (key === 'front' ? 1 : -1) : 0;
        const fSideR: -1 | 0 | 1 = flush ? (key === 'front' ? -1 : 1) : 0;
        if (spans.length) {
          slopeJoints.push({
            a: pPeakL,
            b: pL,
            roofKey: 'roof-left',
            xRoof: xL_r,
            yRoofAt: (s) => -rpL.height / 2 + gableUPeak + s,
            flushSide: fSideL,
            spans,
          });
          slopeJoints.push({
            a: pPeakR,
            b: pR,
            roofKey: 'roof-right',
            xRoof: xR_r,
            yRoofAt: (s) => -rpR.height / 2 + gableUPeak + s,
            flushSide: fSideR,
            spans,
          });
        }
      }
    }

    // Shed roof sloped tenons on the two trapezoidal side walls (fixed mount)
    let shedHighClip: { x: number; y: number; uClip: number; highAtLeft: boolean } | null = null;
    if (roof.type === 'shed' && prof.kind === 'shed-slope') {
      const ca = Math.cos(rm.pitchRad);
      const tanA = Math.tan(rm.pitchRad);
      const z0 = zAtPanel(0),
        zL = zAtPanel(L);
      const highAtLeft = z0 > zL;
      // Small horizontal landing inside the high wall's thickness eliminates any < 90° sharp corner at the high end
      const clipX = Math.min(t * 0.5, 1.5);
      const clipY = clipX * tanA;
      const uClip = clipX / ca;
      shedHighClip = { x: highAtLeft ? clipX : L - clipX, y: clipY, uClip, highAtLeft };

      // When the high adjacent wall is turned OFF, there is no vertical corner joint on that side;
      // keep the base rectangle at eaves height yOfZ(H) so capPoly cleanly forms the entire upper trapezoid
      // with a 90° horizontal landing at shedHighClip.y and zero shared-vertex grazing in Clipper.
      if (highAtLeft && !adjL) yCornerL = yOfZ(H);
      if (!highAtLeft && !adjR) yCornerR = yOfZ(H);

      if (roof.mount === 'fixed') {
        const Ls = L / ca;
        const pad = Math.max(t, t / ca) + t;
        const spans = roofTenonSpans(pad - uClip, Ls - pad - uClip, t, finger);
        const flush = roof.gableOverhang < EPS;
        const pHigh: Pt = { x: shedHighClip.x, y: shedHighClip.y };
        const pLow: Pt = highAtLeft ? { x: L, y: yOfZ(H) } : { x: 0, y: yOfZ(H) };

        let xRoof = 0;
        let fSide: -1 | 0 | 1 = 0;
        if (roof.shedDir === 'front') {
          xRoof = key === 'left' ? -W / 2 + t / 2 : W / 2 - t / 2;
          fSide = flush ? (key === 'left' ? -1 : 1) : 0;
        } else if (roof.shedDir === 'back') {
          xRoof = key === 'left' ? W / 2 - t / 2 : -W / 2 + t / 2;
          fSide = flush ? (key === 'left' ? 1 : -1) : 0;
        } else if (roof.shedDir === 'left') {
          xRoof = key === 'back' ? -D / 2 + t / 2 : D / 2 - t / 2;
          fSide = flush ? (key === 'back' ? -1 : 1) : 0;
        } else {
          xRoof = key === 'front' ? -D / 2 + t / 2 : D / 2 - t / 2;
          fSide = flush ? (key === 'front' ? -1 : 1) : 0;
        }

        if (spans.length) {
          slopeJoints.push({
            a: pHigh,
            b: pLow,
            roofKey: 'roof',
            xRoof,
            yRoofAt: (s) => -Ls / 2 + uClip + s,
            flushSide: fSide,
            spans,
          });
        }
      }
    }

    // Build clockwise base outer wall polygon [xL..xR] × [yCorner..yBot] BEFORE vertical corner finger joints.
    // Gable triangles and shed caps are unioned AFTER vertical finger joints (where gable/shed walls are FIRST so
    // their top corner fingers already reach x=0 and x=L, giving clean obtuse 90°+α eaves corners with zero acute tips!).
    const nodes: Pt[] = [];
    pushNode(nodes, xL, yCornerL);
    if (prof.kind === 'flat' || prof.kind === 'shed-high') {
      const topSplits = [...new Set(flatRoofSpans.flatMap((sp) => [sp.a, sp.b]))]
        .filter((x) => x > xL + EPS && x < xR - EPS)
        .sort((a, b) => a - b);
      for (const x of topSplits) pushNode(nodes, x, 0);
    }
    pushNode(nodes, xR, yCornerR);
    pushNode(nodes, xR, yBot);
    pushNode(nodes, xL, yBot);

    // Prepare gable triangle or shed upper cap to union after vertical finger joints
    let capPoly: SubPath | undefined;
    const ov = Math.min(0.5, t * 0.25);
    if (prof.kind === 'gable') {
      const yE = yOfZ(H);
      capPoly =
        gableHalfFlat > EPS
          ? polygon([
              [0, yE + ov],
              [0, yE],
              [L / 2 - gableHalfFlat, gableYPeak],
              [L / 2 + gableHalfFlat, gableYPeak],
              [L, yE],
              [L, yE + ov],
            ])
          : polygon([[0, yE + ov], [0, yE], [L / 2, 0], [L, yE], [L, yE + ov]]);
    } else if (prof.kind === 'shed-slope' && shedHighClip) {
      const capNodes: Pt[] = [];
      if (shedHighClip.highAtLeft) {
        pushNode(capNodes, 0, yCornerL + ov);
        pushNode(capNodes, 0, shedHighClip.y);
        pushNode(capNodes, shedHighClip.x, shedHighClip.y);
        pushNode(capNodes, L, yOfZ(H));
        pushNode(capNodes, L, yCornerR + ov);
        pushNode(capNodes, xR, yCornerR + ov);
        pushNode(capNodes, xL, yCornerL + ov);
      } else {
        pushNode(capNodes, 0, yCornerL + ov);
        pushNode(capNodes, 0, yOfZ(H));
        pushNode(capNodes, shedHighClip.x, shedHighClip.y);
        pushNode(capNodes, L, shedHighClip.y);
        pushNode(capNodes, L, yCornerR + ov);
        pushNode(capNodes, xR, yCornerR + ov);
        pushNode(capNodes, xL, yCornerL + ov);
      }
      capPoly = { closed: true, nodes: capNodes };
    }

    parts[key] = [{ closed: true, nodes }];
    setups.set(key, { key, L, topZ, botZ, xL, xR, yCornerL, yCornerR, yBot, kind: prof.kind, slopeJoints, flatRoofSpans, capPoly });
    outerHeights[key] = { topZ, botZ };
  }

  // 4. Floor & flush-flat-roof finger joints with all closed outer walls (floor/roof FIRST so they own corner squares)
  const floorEdge = (k: OuterWallKey): [Pt, Pt] => {
    const fx0 = sides.x0 ? -W / 2 + t : -W / 2;
    const fx1 = sides.x1 ? W / 2 - t : W / 2;
    const fy0 = sides.y0 ? -D / 2 + t : -D / 2;
    const fy1 = sides.y1 ? D / 2 - t : D / 2;
    if (k === 'front') return [{ x: fx0, y: fy1 }, { x: fx1, y: fy1 }];
    if (k === 'back') return [{ x: fx0, y: fy0 }, { x: fx1, y: fy0 }];
    if (k === 'left') return [{ x: fx0, y: fy0 }, { x: fx0, y: fy1 }];
    return [{ x: fx1, y: fy0 }, { x: fx1, y: fy1 }];
  };

  for (const s of setups.values()) {
    const [fa, fb] = floorEdge(s.key);
    if (d.floor && parts.floor) {
      keep(
        joint(parts, opts({ kind: 'finger', fingerWidth: finger, direction: 'out' }), [
          { part: 'floor', a: fa, b: fb },
          { part: s.key, a: { x: s.xL, y: s.yBot }, b: { x: s.xR, y: s.yBot } },
        ]),
      );
    }
    if (rm.flushFlat && parts.roof) {
      keep(
        joint(parts, opts({ kind: 'finger', fingerWidth: finger, direction: 'out' }), [
          { part: 'roof', a: fa, b: fb },
          { part: s.key, a: { x: s.xL, y: 0 }, b: { x: s.xR, y: 0 } },
        ]),
      );
    }
  }

  // Corner squares on floor and flush flat roof where two adjacent outer walls meet
  const cornerSq: SubPath[] = [];
  for (const [ys, ySign] of [['y0', -1], ['y1', 1]] as const) {
    for (const [xs, xSign] of [['x0', -1], ['x1', 1]] as const) {
      if (!sides[ys] || !sides[xs]) continue;
      const x0 = xSign < 0 ? -W / 2 : W / 2 - t;
      const y0 = ySign < 0 ? -D / 2 : D / 2 - t;
      cornerSq.push(polygon([[x0, y0], [x0 + t, y0], [x0 + t, y0 + t], [x0, y0 + t]]));
    }
  }
  if (cornerSq.length) {
    if (d.floor && parts.floor) parts.floor = host.boolean({ op: 'union', a: parts.floor, b: cornerSq });
    if (rm.flushFlat && parts.roof) parts.roof = host.boolean({ op: 'union', a: parts.roof, b: cornerSq });
  }

  // 5. Vertical corner finger joints between adjacent outer walls
  // Rule: sloped/gable wall is ALWAYS FIRST (so its top corner fingers reach x=0 and x=L, giving clean obtuse eaves
  // corners when the gable/shed cap is unioned on top); between two flat walls, front/back is first.
  const corners: [OuterWallKey, 'left' | 'right', OuterWallKey, 'left' | 'right'][] = [
    ['front', 'left', 'left', 'right'],
    ['front', 'right', 'right', 'right'],
    ['back', 'left', 'left', 'left'],
    ['back', 'right', 'right', 'left'],
  ];
  for (const [k1, s1, k2, s2] of corners) {
    const w1 = setups.get(k1),
      w2 = setups.get(k2);
    if (!w1 || !w2) continue;
    const isSloped = (w: WallSetup) => w.kind === 'gable' || w.kind === 'shed-slope';
    const [first, fSide, second, sSide] = !isSloped(w1) && isSloped(w2) ? [w2, s2, w1, s1] : [w1, s1, w2, s2];
    const edgeOf = (w: WallSetup, side: 'left' | 'right') => {
      const x = side === 'left' ? w.xL : w.xR;
      const yTop = side === 'left' ? w.yCornerL : w.yCornerR;
      return { part: w.key, a: { x, y: yTop }, b: { x, y: w.yBot } };
    };
    keep(joint(parts, opts({ kind: 'finger', fingerWidth: finger, direction: 'out' }), [edgeOf(first, fSide), edgeOf(second, sSide)]));
  }

  // 5b. Union gable triangles & shed top caps onto the finger-jointed wall bases
  for (const s of setups.values()) {
    if (s.capPoly) {
      parts[s.key] = host.boolean({ op: 'union', a: parts[s.key], b: [s.capPoly] });
    }
  }

  // 6. Roof tenons (overhanging flat roof, fixed gable roof, fixed shed roof)
  const roofExclusions: Record<string, RoofExclusion[]> = {};
  const addRoofExcl = (roofKey: string, a: Pt, b: Pt, width: number, pad = 1.5) => {
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const horiz = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
    const hw = (width + Math.max(0, d.clearance)) / 2 + pad;
    const ht = (t + Math.max(0, d.clearance)) / 2 + pad;
    const box: RoofExclusion = horiz
      ? [mx - hw, my - ht, mx + hw, my + ht]
      : [mx - ht, my - hw, mx + ht, my + hw];
    (roofExclusions[roofKey] ??= []).push(box);
  };

  for (const s of setups.values()) {
    // Overhanging fixed flat roof tenons
    if (s.flatRoofSpans.length && parts.roof) {
      for (const sp of s.flatRoofSpans) {
        const map = (u: number): Pt => {
          if (s.key === 'front') return { x: u - W / 2, y: D / 2 - t / 2 };
          if (s.key === 'back') return { x: u - W / 2, y: -D / 2 + t / 2 };
          if (s.key === 'left') return { x: -W / 2 + t / 2, y: u - D / 2 };
          return { x: W / 2 - t / 2, y: u - D / 2 };
        };
        const ra = map(sp.a),
          rb = map(sp.b);
        parts = tenonsInto(
          parts,
          opts({ kind: 'tenon', tenonCount: 1, tenonWidth: sp.width }),
          { part: s.key, a: { x: sp.a, y: 0 }, b: { x: sp.b, y: 0 } },
          'roof',
          ra,
          rb,
        );
        addRoofExcl('roof', ra, rb, sp.width);
      }
    }

    // Sloped gable / shed roof tenons (splice split nodes directly onto the unioned wall outline)
    for (const sj of s.slopeJoints) {
      const splitDists = sj.spans.flatMap((sp) => [sp.a, sp.b]);
      const spliced = spliceSegment(parts[s.key][0], sj.a, sj.b, splitDists);
      parts[s.key] = [spliced.sub, ...parts[s.key].slice(1)];
      for (const sp of sj.spans) {
        const pa = alongSeg(spliced.a, spliced.b, sp.a);
        const pb = alongSeg(spliced.a, spliced.b, sp.b);
        const ra = { x: sj.xRoof, y: sj.yRoofAt(sp.a) };
        const rb = { x: sj.xRoof, y: sj.yRoofAt(sp.b) };
        parts = roofTenonInto(
          parts,
          opts({ kind: 'tenon', tenonCount: 1, tenonWidth: sp.width }),
          { part: s.key, a: pa, b: pb },
          sj.roofKey,
          ra,
          rb,
          sj.flushSide,
        );
        addRoofExcl(sj.roofKey, ra, rb, sp.width);
      }
    }
  }

  // 7. Attic trusses (removable gable, open-gable support, and crossed hip/pyramid roof skeletons)
  const trusses = buildRoofTrusses(W, D, H, t, roof, sides);
  const lapHalfW = Math.max(0.5, (t + d.clearance) / 2);
  const lapShoulder = Math.min(1.5, t * 0.5);

  // Precompute each truss's top plateau so intersecting spine & cross trusses share an identical half-lap Z plane
  const trussMeta = trusses.map((tr) => {
    const ca = Math.cos(tr.pitchRad);
    const tanA = Math.tan(tr.pitchRad);
    const pitchDeg = (tr.pitchRad * 180) / Math.PI;
    const topLaps = tr.laps.filter((lp) => lp.fromTop);
    let halfTop = tr.topFlat / 2;
    if (topLaps.length) {
      const maxNeed = Math.max(...topLaps.map((lp) => Math.abs(lp.offsetFromCenter))) + lapHalfW + lapShoulder;
      halfTop = Math.max(halfTop, maxNeed);
    } else if (halfTop < EPS && pitchDeg > 55) {
      halfTop = Math.min(Math.max(0.6, t * 0.4), Math.min(1.0, t * 0.55));
    }
    const extraFlat = Math.max(0, halfTop - tr.topFlat / 2);
    const yPeak = extraFlat * tanA;
    const uPeak = extraFlat / ca;
    return { tr, ca, tanA, halfTop, yPeak, uPeak };
  });

  const maxYPeak = trussMeta.reduce((acc, tm) => Math.max(acc, tm.yPeak), 0);
  const sharedLapY = trussMeta.length ? maxYPeak + (trussMeta[0].tr.rise - maxYPeak) * 0.5 : 0;

  // Map outer wall keys to interior-wall T-joint positions (unmirrored panel X) so fixed truss hooks never collide
  const outerInnerJoints: Record<OuterWallKey, number[]> = { front: [], back: [], left: [], right: [] };
  for (const wi of m.walls) {
    for (const end of [wi.start, wi.end]) {
      if (end.kind === 'outer') outerInnerJoints[OUTER[end.side]].push(wi.wall.pos + t);
    }
  }

  for (const { tr, ca, tanA, halfTop, yPeak, uPeak } of trussMeta) {
    const cx = tr.outerSpan / 2;
    const h = tr.rise;
    const LsInner = (tr.innerSpan - tr.topFlat) / 2 / ca;
    const sRidge = Math.max(t, t * tanA) + t;
    const sHeel = Math.max(t, t / ca) + t * 0.5;

    const rpL = rpByKey.get(tr.leftRoofKey)!;
    const rpR = rpByKey.get(tr.rightRoofKey)!;
    const triWebMin = (rp: RoofPanelGeom) => {
      if (rp.pts.length !== 3) return 0;
      const ratio = rp.width / (2 * Math.max(EPS, rp.height));
      return (t / 2 + Math.max(t, 2) + 0.5) / Math.max(0.15, ratio);
    };
    const sStartL = Math.max(sRidge, uPeak + t, triWebMin(rpL));
    const sStartR = Math.max(sRidge, uPeak + t, triWebMin(rpR));
    const spansL = roofTenonSpans(sStartL - uPeak, LsInner - sHeel - uPeak, t, finger);
    const spansR = roofTenonSpans(sStartR - uPeak, LsInner - sHeel - uPeak, t, finger);

    // Optional fixed outer-wall saddle hooks for hip & pyramid roofs
    const leftWall: OuterWallKey = tr.spanAxis === 'y' ? 'back' : 'left';
    const rightWall: OuterWallKey = tr.spanAxis === 'y' ? 'front' : 'right';
    const wallPanelX = tr.spanAxis === 'y' ? tr.at : D - tr.at;
    const canHook = (wk: OuterWallKey) => {
      if (!tr.fixedHooks) return false;
      const s = setups.get(wk);
      if (!s || !parts[wk]) return false;
      if (wallPanelX < 2 * t + 1 || wallPanelX > s.L - 2 * t - 1) return false;
      return !outerInnerJoints[wk].some((jx) => Math.abs(jx - wallPanelX) < t + 2);
    };
    const hookL = canHook(leftWall);
    const hookR = canHook(rightWall);

    // Uncentered truss coords: x ∈ [0..outerSpan] centered at cx = outerSpan/2, y ∈ [0..h] (+t on fixed saddle hooks)
    const pPeakL: Pt = { x: cx - halfTop, y: yPeak };
    const pPeakR: Pt = { x: cx + halfTop, y: yPeak };
    const pL: Pt = hookL ? { x: 0, y: h } : { x: t, y: h - tr.heel };
    const pR: Pt = hookR ? { x: tr.outerSpan, y: h } : { x: tr.outerSpan - t, y: h - tr.heel };
    const LsLeft = Math.hypot(pPeakL.x - pL.x, pPeakL.y - pL.y);

    const nodes: Pt[] = [];
    // Left slope up from pL to pPeakL
    pushNode(nodes, pL.x, pL.y);
    if (spansL.length) {
      const pts = [...new Set(spansL.flatMap((sp) => [LsLeft - sp.b, LsLeft - sp.a]))].sort((a, b) => a - b);
      for (const s of pts) {
        const q = alongSeg(pL, pPeakL, s);
        pushNode(nodes, q.x, q.y);
      }
    }
    pushNode(nodes, pPeakL.x, pPeakL.y);

    // Top horizontal ridge edge (with optional top half-lap slots into cross trusses)
    const topLaps = tr.laps
      .filter((lp) => lp.fromTop)
      .map((lp) => cx + lp.offsetFromCenter)
      .sort((a, b) => a - b);
    for (const lx of topLaps) {
      pushNode(nodes, lx - lapHalfW, yPeak);
      pushNode(nodes, lx - lapHalfW, sharedLapY);
      pushNode(nodes, lx + lapHalfW, sharedLapY);
      pushNode(nodes, lx + lapHalfW, yPeak);
    }
    if (halfTop > EPS) pushNode(nodes, pPeakR.x, pPeakR.y);

    // Right slope down from pPeakR to pR
    if (spansR.length) {
      const pts = [...new Set(spansR.flatMap((sp) => [sp.a, sp.b]))].sort((a, b) => a - b);
      for (const s of pts) {
        const q = alongSeg(pPeakR, pR, s);
        pushNode(nodes, q.x, q.y);
      }
    }
    pushNode(nodes, pR.x, pR.y);

    // Right end: either downward saddle hook into rightWall or vertical inner face to y=h
    if (hookR) {
      pushNode(nodes, tr.outerSpan, h + t);
      pushNode(nodes, tr.outerSpan - t, h + t);
    }
    pushNode(nodes, tr.outerSpan - t, h);

    // Bottom horizontal edge right-to-left (with optional bottom half-lap slots into spine truss)
    const botLaps = tr.laps
      .filter((lp) => !lp.fromTop)
      .map((lp) => cx + lp.offsetFromCenter)
      .sort((a, b) => b - a);
    for (const lx of botLaps) {
      pushNode(nodes, lx + lapHalfW, h);
      pushNode(nodes, lx + lapHalfW, sharedLapY);
      pushNode(nodes, lx - lapHalfW, sharedLapY);
      pushNode(nodes, lx - lapHalfW, h);
    }
    pushNode(nodes, t, h);

    // Left end: optional downward saddle hook into leftWall
    if (hookL) {
      pushNode(nodes, t, h + t);
      pushNode(nodes, 0, h + t);
    }

    parts[tr.key] = [{ closed: true, nodes }];

    // Cut matching top saddle notches into fixed outer walls where hooks engage
    const cutWallNotch = (wk: OuterWallKey) => {
      const nw = (t + Math.max(0, d.clearance)) / 2;
      const nd = t + Math.max(0, d.clearance) / 2;
      const notch = polygon([[wallPanelX - nw, -1], [wallPanelX + nw, -1], [wallPanelX + nw, nd], [wallPanelX - nw, nd]]);
      parts[wk] = host.boolean({ op: 'difference', a: parts[wk], b: [notch] });
    };
    if (hookL) cutWallNotch(leftWall);
    if (hookR) cutWallNotch(rightWall);

    // Tenon left & right slopes into their matching roof panels
    for (const sp of spansL) {
      const rlA = { x: tr.leftRoofX, y: -rpL.height / 2 + uPeak + sp.a };
      const rlB = { x: tr.leftRoofX, y: -rpL.height / 2 + uPeak + sp.b };
      parts = tenonsInto(
        parts,
        opts({ kind: 'tenon', tenonCount: 1, tenonWidth: sp.width }),
        { part: tr.key, a: alongSeg(pPeakL, pL, sp.a), b: alongSeg(pPeakL, pL, sp.b) },
        tr.leftRoofKey,
        rlA,
        rlB,
      );
      addRoofExcl(tr.leftRoofKey, rlA, rlB, sp.width);
    }
    for (const sp of spansR) {
      const rrA = { x: tr.rightRoofX, y: -rpR.height / 2 + uPeak + sp.a };
      const rrB = { x: tr.rightRoofX, y: -rpR.height / 2 + uPeak + sp.b };
      parts = tenonsInto(
        parts,
        opts({ kind: 'tenon', tenonCount: 1, tenonWidth: sp.width }),
        { part: tr.key, a: alongSeg(pPeakR, pR, sp.a), b: alongSeg(pPeakR, pR, sp.b) },
        tr.rightRoofKey,
        rrA,
        rrB,
      );
      addRoofExcl(tr.rightRoofKey, rrA, rrB, sp.width);
    }

    // Center the truss around (outerSpan/2, h/2) to match tr.pose
    parts[tr.key] = shiftSubs(parts[tr.key], -cx, -h / 2);
  }

  // 7a. Underside positioning rails / stop cleats for removable flat and shed roofs
  const rawRails = buildRoofRails(W, D, H, t, d.floor, sides, roof);
  const builtRails: RoofRailSpec[] = [];
  const innerTopZ = floorZ + innerHeight(d);
  for (const rl of rawRails) {
    // Partition [-rl.length/2, +rl.length/2] around any perpendicular interior walls that reach into the rail's Z band
    const blockers: [number, number][] = [];
    if (innerTopZ > H - rl.height - 0.5) {
      const padW = t / 2 + 0.4;
      for (const wi of m.walls) {
        if (rl.spanAxis === 'x' && wi.wall.axis === 'v') {
          const yInner = D - t - rl.perpPos3D;
          if (yInner >= wi.wall.from - t - 0.5 && yInner <= wi.wall.to + t + 0.5) {
            const wx = wi.wall.pos + t;
            const u = (wx - rl.pose.o[0]) * rl.pose.u[0];
            blockers.push([u - padW, u + padW]);
          }
        } else if (rl.spanAxis === 'y' && wi.wall.axis === 'h') {
          const xInner = rl.perpPos3D - t;
          if (xInner >= wi.wall.from - t - 0.5 && xInner <= wi.wall.to + t + 0.5) {
            const wy = D - t - wi.wall.pos;
            const u = (wy - rl.pose.o[1]) * rl.pose.u[1];
            blockers.push([u - padW, u + padW]);
          }
        }
      }
    }
    let freeSegs: [number, number][] = [[-rl.length / 2, rl.length / 2]];
    for (const [b0, b1] of blockers) {
      const next: [number, number][] = [];
      for (const [a, b] of freeSegs) {
        if (b1 <= a || b0 >= b) next.push([a, b]);
        else {
          if (b0 > a + EPS) next.push([a, b0]);
          if (b1 < b - EPS) next.push([b1, b]);
        }
      }
      freeSegs = next;
    }
    freeSegs.sort((a, b) => b[1] - b[0] - (a[1] - a[0]));
    const best = freeSegs[0];
    if (!best || best[1] - best[0] < Math.max(3 * t, 12)) continue;

    const [u0, u1] = best;
    const len = u1 - u0;
    const uShift = (u0 + u1) / 2;
    const spans = roofTenonSpans(t * 0.5, len - t * 0.5, t, finger);
    if (!spans.length || !parts[rl.roofKey]) continue;

    parts[rl.key] = [panel(len, rl.height, { top: spans.flatMap((sp) => [sp.a, sp.b]), bottom: [], left: [], right: [] })];
    for (const sp of spans) {
      const ra = rl.roofAxis === 'x' ? { x: u0 + sp.a, y: rl.roofY } : { x: rl.roofY, y: u0 + sp.a };
      const rb = rl.roofAxis === 'x' ? { x: u0 + sp.b, y: rl.roofY } : { x: rl.roofY, y: u0 + sp.b };
      parts = tenonsInto(
        parts,
        opts({ kind: 'tenon', tenonCount: 1, tenonWidth: sp.width }),
        { part: rl.key, a: { x: sp.a, y: 0 }, b: { x: sp.b, y: 0 } },
        rl.roofKey,
        ra,
        rb,
      );
      addRoofExcl(rl.roofKey, ra, rb, sp.width);
    }
    parts[rl.key] = shiftSubs(parts[rl.key], -len / 2, -rl.height / 2);
    const pose: Pose = {
      ...rl.pose,
      o: [
        rl.pose.o[0] + uShift * rl.pose.u[0],
        rl.pose.o[1] + uShift * rl.pose.u[1],
        rl.pose.o[2] + uShift * rl.pose.u[2],
      ],
    };
    builtRails.push({ ...rl, length: len, pose });
  }

  const extraPoses: Record<string, Pose> = {};

  // 7b. Optional chimney (tilted roof cutout + 4 finger-jointed shaft walls + overhanging flue cap)
  if (d.chimney?.enabled) {
    const cg = buildChimneyGeom(W, D, H, t, d.floor, roof, roofPanels, d.chimney, d.clearance);
    if (cg && parts[cg.roofKey]) {
      const [hx0, hy0, hx1, hy1] = cg.holeBox;
      const hole = polygon([[hx0, hy0], [hx1, hy0], [hx1, hy1], [hx0, hy1]]);
      parts[cg.roofKey] = host.boolean({ op: 'difference', a: parts[cg.roofKey], b: [hole] });
      (roofExclusions[cg.roofKey] ??= []).push([hx0 - 1.5, hy0 - 1.5, hx1 + 1.5, hy1 + 1.5]);

      const S = cg.size;
      const chH = cg.zTop - cg.zBot;
      const chMidZ = (cg.zBot + cg.zTop) / 2;
      const chFinger = Math.min(finger, Math.max(3, Math.round((chH / 5) * 10) / 10));
      const chWallKeys = ['chimney-front', 'chimney-back', 'chimney-left', 'chimney-right'] as const;
      for (const ck of chWallKeys) {
        parts[ck] = [polygon([[t, 0], [S - t, 0], [S - t, chH], [t, chH]])];
      }
      const chCorners: [string, number, string, number][] = [
        ['chimney-front', t, 'chimney-left', S - t],
        ['chimney-front', S - t, 'chimney-right', S - t],
        ['chimney-back', t, 'chimney-left', t],
        ['chimney-back', S - t, 'chimney-right', t],
      ];
      for (const [k1, x1, k2, x2] of chCorners) {
        keep(
          joint(parts, opts({ kind: 'finger', fingerWidth: chFinger, direction: 'out' }), [
            { part: k1, a: { x: x1, y: 0 }, b: { x: x1, y: chH } },
            { part: k2, a: { x: x2, y: 0 }, b: { x: x2, y: chH } },
          ]),
        );
      }
      for (const ck of chWallKeys) {
        parts[ck] = shiftSubs(parts[ck], -S / 2, -chH / 2);
      }
      extraPoses['chimney-front'] = { o: [cg.cx, cg.cy - S / 2, chMidZ], u: [1, 0, 0], v: [0, 0, -1], n: [0, 1, 0] };
      extraPoses['chimney-back'] = { o: [cg.cx, cg.cy + S / 2 - t, chMidZ], u: [1, 0, 0], v: [0, 0, -1], n: [0, 1, 0] };
      extraPoses['chimney-left'] = { o: [cg.cx - S / 2, cg.cy, chMidZ], u: [0, -1, 0], v: [0, 0, -1], n: [1, 0, 0] };
      extraPoses['chimney-right'] = { o: [cg.cx + S / 2 - t, cg.cy, chMidZ], u: [0, -1, 0], v: [0, 0, -1], n: [1, 0, 0] };

      // Chimney cap with hollow flue opening
      const capHalf = S / 2 + 2;
      const capOuter = polygon([[-capHalf, -capHalf], [capHalf, -capHalf], [capHalf, capHalf], [-capHalf, capHalf]]);
      const flueHalf = S / 2 - t;
      parts['chimney-cap'] =
        flueHalf >= 2
          ? host.boolean({
              op: 'difference',
              a: [capOuter],
              b: [polygon([[-flueHalf, -flueHalf], [flueHalf, -flueHalf], [flueHalf, flueHalf], [-flueHalf, flueHalf]])],
            })
          : [capOuter];
      extraPoses['chimney-cap'] = { o: [cg.cx, cg.cy, cg.zTop], u: [1, 0, 0], v: [0, -1, 0], n: [0, 0, 1] };
    }
  }

  // 7c. Roof engraving patterns (clipped to roof panel polygon AND skipping all tenon slots & chimney cutout)
  if (roof.pattern !== 'none') {
    const patMargin = roof.mount === 'fixed' ? Math.max(2, t + 1) : 2;
    for (const rp of roofPanels) {
      const pts = rm.flushFlat && rp.key === 'roof' && flushRoofPts ? flushRoofPts : rp.pts;
      const margin = rm.flushFlat && rp.key === 'roof' && flushRoofPts ? 2 : patMargin;
      const mks = roofPatternMarks(pts, roof.pattern, roof.patternSize, margin, roofExclusions[rp.key] ?? []);
      if (mks.length) marks[rp.key] = mks;
    }
  }

  // 8. Interior walls & their joints (crossings, corners, T-joints into inner & outer walls, floor teeth)
  const walls = wallPanels(m, d);
  const tenoned = (e: End) => e.kind === 'tee' || (e.kind === 'outer' && d.sides[e.side]);
  for (const p of walls) parts[p.key] = [panel(p.e - p.s, p.h, wallSplits(p, d, tenoned))];
  parts = innerJoints(parts, walls, d, info, (end, p) => {
    if (end.kind !== 'outer' || !d.sides[end.side]) return null;
    const key = OUTER[end.side];
    const s = setups.get(key);
    if (!s) return null;
    // Unmirrored outer wall coords: x = p.it.wall.pos + t, y = s.yBot - p.h + y_inner
    const u = p.it.wall.pos + t;
    return { into: key, at: (y) => ({ x: u, y: s.yBot - p.h + y }) };
  });

  // 8b. Optional intermediate floor slab (2nd story) tenoned cleanly into enabled outer walls
  if (d.midFloor && d.midFloorHeight !== undefined) {
    const midZ = d.midFloorHeight;
    const fx0 = sides.x0 ? -W / 2 + t : -W / 2;
    const fx1 = sides.x1 ? W / 2 - t : W / 2;
    const fy0 = sides.y0 ? -D / 2 + t : -D / 2;
    const fy1 = sides.y1 ? D / 2 - t : D / 2;
    const mw = fx1 - fx0;
    const md = fy1 - fy0;

    // Partition an outer wall's inner span [xL..xR] around any interior-wall T-joints so tenons stay clear
    const midEdgeSpans = (wk: OuterWallKey): { a: number; b: number; width: number }[] => {
      const s = setups.get(wk);
      if (!s) return [];
      const padJoint = t / 2 + Math.max(2, t);
      const blockers = outerInnerJoints[wk].map((jx): [number, number] => [jx - padJoint, jx + padJoint]);
      let segs: [number, number][] = [[s.xL + t, s.xR - t]];
      for (const [b0, b1] of blockers) {
        const next: [number, number][] = [];
        for (const [a, b] of segs) {
          if (b1 <= a || b0 >= b) next.push([a, b]);
          else {
            if (b0 > a + EPS) next.push([a, b0]);
            if (b1 < b - EPS) next.push([b1, b]);
          }
        }
        segs = next;
      }
      const out: { a: number; b: number; width: number }[] = [];
      for (const [a, b] of segs) out.push(...roofTenonSpans(a, b, t, finger));
      return out;
    };

    const spBack = midEdgeSpans('back');
    const spFront = midEdgeSpans('front');
    const spLeft = midEdgeSpans('left');
    const spRight = midEdgeSpans('right');

    const slabPanel = panel(mw, md, {
      top: spBack.flatMap((sp) => [sp.a - W / 2 - fx0, sp.b - W / 2 - fx0]),
      bottom: spFront.flatMap((sp) => [sp.a - W / 2 - fx0, sp.b - W / 2 - fx0]),
      left: spLeft.flatMap((sp) => [sp.a - D / 2 - fy0, sp.b - D / 2 - fy0]),
      right: spRight.flatMap((sp) => [sp.a - D / 2 - fy0, sp.b - D / 2 - fy0]),
    });
    parts['mid-floor'] = shiftSubs([slabPanel], fx0, fy0);

    const applyMidTenons = (wk: OuterWallKey, sps: { a: number; b: number; width: number }[]) => {
      const s = setups.get(wk);
      if (!s || !sps.length) return;
      const ySlot = s.topZ - (midZ + t / 2);
      for (const sp of sps) {
        let aPt: Pt, bPt: Pt;
        if (wk === 'back') {
          aPt = { x: sp.a - W / 2, y: fy0 };
          bPt = { x: sp.b - W / 2, y: fy0 };
        } else if (wk === 'front') {
          aPt = { x: sp.b - W / 2, y: fy1 };
          bPt = { x: sp.a - W / 2, y: fy1 };
        } else if (wk === 'left') {
          aPt = { x: fx0, y: sp.b - D / 2 };
          bPt = { x: fx0, y: sp.a - D / 2 };
        } else {
          aPt = { x: fx1, y: sp.a - D / 2 };
          bPt = { x: fx1, y: sp.b - D / 2 };
        }
        parts = tenonsInto(
          parts,
          opts({ kind: 'tenon', tenonCount: 1, tenonWidth: sp.width }),
          { part: 'mid-floor', a: aPt, b: bPt },
          wk,
          { x: sp.a, y: ySlot },
          { x: sp.b, y: ySlot },
        );
      }
    };
    applyMidTenons('back', spBack);
    applyMidTenons('front', spFront);
    applyMidTenons('left', spLeft);
    applyMidTenons('right', spRight);

    // Optional stairwell cutout in the back-right corner (keeping generous edge web)
    if (d.midFloorStair && mw >= 28 && md >= 24) {
      const sw = Math.min(26, mw * 0.3);
      const sd = Math.min(22, md * 0.3);
      const padS = Math.max(t + 3, 6);
      const sx1 = fx1 - padS;
      const sx0 = sx1 - sw;
      const sy0 = fy0 + padS;
      const sy1 = sy0 + sd;
      if (sx0 > fx0 + padS && sy1 < fy1 - padS) {
        parts['mid-floor'] = host.boolean({
          op: 'difference',
          a: parts['mid-floor'],
          b: [polygon([[sx0, sy0], [sx1, sy0], [sx1, sy1], [sx0, sy1]])],
        });
      }
    }

    extraPoses['mid-floor'] = { o: [W / 2, D / 2, midZ], u: [1, 0, 0], v: [0, -1, 0], n: [0, 0, 1] };
  }

  // 9. Cut doors & windows, add engraved frame marks, and optionally build separate 3D trim frames (BEFORE centering!)
  const hosts = houseWallHosts(m, d);
  const sillZ = sillBaseZ(d.floor, t);
  const threshold = sillZ - floorZ;
  for (const s of setups.values()) {
    const wallOps = openings.filter((o) => o.wall === s.key);
    if (!wallOps.length) continue;
    const hostWall = hosts.get(s.key);
    const flipX = s.key === 'back' || s.key === 'right';
    const cuts: SubPath[] = [];
    const wallMarks: SubPath[] = [];
    for (const op of wallOps) {
      const cx = flipX ? s.L - op.x : op.x;
      const yBot = s.topZ - (sillZ + op.y);
      const cutThrough = !d.floor && op.y <= 0.01;
      cuts.push(...openingCutouts(op, cx, yBot, d.mullionWidth, cutThrough));
      const fw = hostWall ? safeFrameWidth(op, hostWall, wallOps, d.frameWidth, t) : d.frameWidth;
      if (d.engraveFrames && fw > 0) wallMarks.push(...openingMarks(op, cx, yBot, fw));
      if (d.cutoutFrames) {
        const frameKey = `frame-${op.id}`;
        const cutFw = Math.max(1.8, fw > 0 ? fw : d.frameWidth);
        parts[frameKey] = openingTrimFrame(op, cutFw);
        const opMidZ = sillZ + op.y + op.h / 2;
        if (s.key === 'front') extraPoses[frameKey] = { o: [op.x, -t, opMidZ], u: [1, 0, 0], v: [0, 0, -1], n: [0, 1, 0] };
        else if (s.key === 'back') extraPoses[frameKey] = { o: [W - op.x, D, opMidZ], u: [-1, 0, 0], v: [0, 0, -1], n: [0, 1, 0] };
        else if (s.key === 'left') extraPoses[frameKey] = { o: [-t, D - op.x, opMidZ], u: [0, -1, 0], v: [0, 0, -1], n: [1, 0, 0] };
        else extraPoses[frameKey] = { o: [W, op.x, opMidZ], u: [0, 1, 0], v: [0, 0, -1], n: [1, 0, 0] };
      }
    }
    if (cuts.length) parts[s.key] = host.boolean({ op: 'difference', a: parts[s.key], b: cuts });
    if (wallMarks.length) marks[s.key] = wallMarks;
  }

  for (const p of walls) {
    const wallOps = openings.filter((o) => o.wall === p.key);
    if (!wallOps.length) continue;
    const hostWall = hosts.get(p.key);
    const cuts: SubPath[] = [];
    const wallMarks: SubPath[] = [];
    for (const op of wallOps) {
      const yBot = p.h - (threshold + op.y);
      const cutThrough = !d.floor && op.y <= 0.01;
      cuts.push(...openingCutouts(op, op.x, yBot, d.mullionWidth, cutThrough));
      if (d.engraveFrames) {
        const fw = hostWall ? safeFrameWidth(op, hostWall, wallOps, d.frameWidth, t) : d.frameWidth;
        if (fw > 0) wallMarks.push(...openingMarks(op, op.x, yBot, fw));
      }
    }
    if (cuts.length) parts[p.key] = host.boolean({ op: 'difference', a: parts[p.key], b: cuts });
    if (wallMarks.length) marks[p.key] = wallMarks;
  }

  // 10. Center outer walls and inner walls around their bounding centers
  for (const s of setups.values()) {
    const cx = s.L / 2;
    const cy = s.topZ / 2;
    parts[s.key] = shiftSubs(parts[s.key], -cx, -cy);
    if (marks[s.key]) marks[s.key] = shiftSubs(marks[s.key], -cx, -cy);
  }
  for (const p of walls) {
    const cx = (p.e - p.s) / 2,
      cy = p.h / 2;
    parts[p.key] = shiftSubs(parts[p.key], -cx, -cy);
    if (marks[p.key]) marks[p.key] = shiftSubs(marks[p.key], -cx, -cy);
  }

  return { parts, marks, info: dedupeInfo(info), walls, boards: [], roofPanels, trusses, rails: builtRails, extraPoses, outerHeights, hosts };
}

/** Translate every node and Bezier handle in a list of SubPaths by (dx, dy) */
function shiftSubs(subs: SubPath[], dx: number, dy: number): SubPath[] {
  return subs.map((sp) => ({
    closed: sp.closed,
    nodes: sp.nodes.map((n) => ({
      ...n,
      x: n.x + dx,
      y: n.y + dy,
      ...(n.cin ? { cin: { x: n.cin.x + dx, y: n.cin.y + dy } } : {}),
      ...(n.cout ? { cout: { x: n.cout.x + dx, y: n.cout.y + dy } } : {}),
    })),
  }));
}

// ---------- Shaped outline (L / U / C footprints with flat roof, adapted from box-composer-advanced) ----------

const reachOf = (q: OEdgeInfo['start'], t: number) => (q.kind === 'through' ? t / 2 : q.kind === 'line' && q.wall === undefined ? 0 : -t / 2);
const given = (q: OEdgeInfo['start']) => (q.kind === 'open' || (q.kind === 'through' && q.at !== undefined) ? q.at : undefined);
const edgeRange = (e: OEdgeInfo, t: number): [number, number] => [given(e.start) ?? e.from - reachOf(e.start, t), given(e.end) ?? e.to + reachOf(e.end, t)];
const crossed = (q: OEdgeInfo['start']) => q.kind === 'through' && q.cross !== undefined;
const jointRange = (e: OEdgeInfo, t: number): [number, number] => {
  const [a, b] = edgeRange(e, t);
  return [crossed(e.start) ? e.from + t / 2 : a, crossed(e.end) ? e.to - t / 2 : b];
};

export function boards(m: Model, d: HouseDims, walls: WallPanel[]): Board[] {
  const es = m.outline!.edges.filter((e) => !e.open);
  const t = d.t;
  const ho = outerBoardHeight(d);
  const byId = new Map(walls.map((p) => [p.it.wall.id, p]));
  const group = m.outline!.edges.map((e) => e.k);
  const find = (k: number): number => (group[k] === k ? k : (group[k] = find(group[k])));
  const memberOf = new Map<number, number>();
  for (const e of es)
    for (const q of [e.start, e.end])
      if (q.kind === 'through') {
        const prev = memberOf.get(q.wall);
        if (prev !== undefined) group[find(prev)] = find(e.k);
        memberOf.set(q.wall, e.k);
      }
  const out = new Map<number, Board>();
  for (const e of es) {
    const g = find(e.k);
    let b = out.get(g);
    if (!b) out.set(g, (b = { key: outerKey(e.k), axis: e.axis, pos: e.pos, edges: [], members: [], bs: Infinity, be: -Infinity, h: ho }));
    b.edges.push(e);
    const [a, z] = edgeRange(e, t);
    b.bs = Math.min(b.bs, a);
    b.be = Math.max(b.be, z);
  }
  for (const [id, k] of memberOf) {
    const b = out.get(find(k))!;
    const p = byId.get(id)!;
    if (!b.members.includes(p)) b.members.push(p);
    b.bs = Math.min(b.bs, p.s);
    b.be = Math.max(b.be, p.e);
  }
  const list = [...out.values()];
  for (const b of list) {
    b.key = outerKey(Math.min(...b.edges.map((e) => e.k)));
    for (const p of b.members) Object.assign(p, { part: b.key, ox: p.s - b.bs, oy: ho - p.h });
  }
  return list;
}

/** Compute the outer-face 3D XY footprint polygon (CCW in math X-right, Y-back) for a shaped model */
export function outlineOuterPoly3D(m: Model, W: number, D: number, t: number): XY[] | null {
  const ol = m.outline;
  if (!ol) return null;
  const n = ol.edges.length;
  const offOut = (e: OEdgeInfo) => e.pos - (e.inside * t) / 2;
  const endsOut = (e: OEdgeInfo, o: OEdgeInfo, p: XY): [number, number] => {
    const along = o.axis === e.axis ? (e.axis === 'h' ? p[0] : p[1]) : offOut(o);
    return e.axis === 'h' ? [along, offOut(e)] : [offOut(e), along];
  };
  const pts: XY[] = [];
  for (let k = 0; k < n; k++) {
    const e = ol.edges[k];
    const [xm, ym] = endsOut(e, ol.edges[(k + n - 1) % n], ol.pts[k]);
    pts.push([xm + t, D - t - ym]);
  }
  return ensureCCW(pts);
}

function boardOutline(
  b: Board,
  els: { a: number; b: number; top: number; topB?: number; polyTop?: Pt[] }[],
  splits: { top: number[]; bottom: number[]; left: number[]; right: number[] },
): SubPath {
  const L = b.be - b.bs,
    h = b.h;
  const e = [...els].sort((p, q) => p.a - q.a);
  const nodes: Pt[] = [];
  const push = (x: number, y: number) => {
    const last = nodes[nodes.length - 1];
    if (!last || Math.abs(last.x - x) > 1e-9 || Math.abs(last.y - y) > 1e-9) nodes.push({ x, y });
  };
  const inside = (v: number[], lo: number, hi: number, desc = false) =>
    [...new Set(v.filter((x) => x > lo + EPS && x < hi - EPS))].sort((p, q) => (desc ? q - p : p - q));
  for (const el of e) {
    if (el.polyTop && el.polyTop.length >= 2) {
      for (const pt of el.polyTop) push(pt.x, pt.y);
    } else {
      const tA = el.top;
      const tB = el.topB ?? el.top;
      push(el.a, tA);
      const span = el.b - el.a;
      for (const x of inside(splits.top.filter((x) => x > el.a && x < el.b), el.a, el.b)) {
        const y = span > EPS ? tA + ((x - el.a) / span) * (tB - tA) : tA;
        push(x, y);
      }
      push(el.b, tB);
    }
  }
  const firstEl = e[0];
  const lastEl = e[e.length - 1];
  const t0 = firstEl.polyTop?.[0]?.y ?? firstEl.top;
  const t1 = lastEl.polyTop?.[lastEl.polyTop.length - 1]?.y ?? lastEl.topB ?? lastEl.top;
  for (const y of inside(splits.right, t1, h)) push(L, y);
  push(L, h);
  for (const x of inside(splits.bottom, 0, L, true)) push(x, h);
  push(0, h);
  for (const y of inside(splits.left, t0, h, true)) push(0, y);
  return { closed: true, nodes };
}

/** Project a 2D XY polygon lying on a tilted roof plane onto centered local panel coords (u, v, n = -(u×v)) */
function projectPlanPolyToRoofPanel(
  key: string,
  planPts: XY[],
  zAt: (x: number, y: number) => number,
  u: V3,
  v: V3,
  n: V3,
  o0: V3,
): RoofPanelGeom {
  const raw: XY[] = planPts.map(([X, Y]) => {
    const Z = zAt(X, Y);
    const dx = X - o0[0];
    const dy = Y - o0[1];
    const dz = Z - o0[2];
    return [dx * u[0] + dy * u[1] + dz * u[2], dx * v[0] + dy * v[1] + dz * v[2]];
  });
  let x0 = Infinity,
    x1 = -Infinity,
    y0 = Infinity,
    y1 = -Infinity;
  for (const [x, y] of raw) {
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  const midX = (x0 + x1) / 2;
  const midY = (y0 + y1) / 2;
  const centered: [number, number][] = raw.map(([x, y]) => [x - midX, y - midY]);
  const o: V3 = [
    o0[0] + midX * u[0] + midY * v[0],
    o0[1] + midX * u[1] + midY * v[1],
    o0[2] + midX * u[2] + midY * v[2],
  ];
  return {
    key,
    pts: centered,
    width: x1 - x0,
    height: y1 - y0,
    slopeLen: y1 - y0,
    pose: { o, u, v, n },
    marks: [],
  };
}

/** Build the 4 finger-jointed chimney walls + overhanging hollow cap and attach to parts & extraPoses */
function addChimneyParts(
  parts: Parts,
  extraPoses: Record<string, Pose>,
  roofExclusions: Record<string, RoofExclusion[]>,
  cg: ChimneyGeom,
  t: number,
  finger: number,
  clearance: number,
  keep: (r: { parts: Parts; info: JointMsg[] }) => void,
): Parts {
  if (!parts[cg.roofKey]) return parts;
  const [hx0, hy0, hx1, hy1] = cg.holeBox;
  const hole = polygon([[hx0, hy0], [hx1, hy0], [hx1, hy1], [hx0, hy1]]);
  parts[cg.roofKey] = host.boolean({ op: 'difference', a: parts[cg.roofKey], b: [hole] });
  (roofExclusions[cg.roofKey] ??= []).push([hx0 - 1.5, hy0 - 1.5, hx1 + 1.5, hy1 + 1.5]);

  const S = cg.size;
  const chH = cg.zTop - cg.zBot;
  const chMidZ = (cg.zBot + cg.zTop) / 2;
  const chFinger = Math.min(finger, Math.max(3, Math.round((chH / 5) * 10) / 10));
  const chWallKeys = ['chimney-front', 'chimney-back', 'chimney-left', 'chimney-right'] as const;
  for (const ck of chWallKeys) {
    parts[ck] = [polygon([[t, 0], [S - t, 0], [S - t, chH], [t, chH]])];
  }
  const chCorners: [string, number, string, number][] = [
    ['chimney-front', t, 'chimney-left', S - t],
    ['chimney-front', S - t, 'chimney-right', S - t],
    ['chimney-back', t, 'chimney-left', t],
    ['chimney-back', S - t, 'chimney-right', t],
  ];
  for (const [k1, x1, k2, x2] of chCorners) {
    keep(
      joint(parts, { thickness: t, clearance, kind: 'finger', fingerWidth: chFinger, direction: 'out' }, [
        { part: k1, a: { x: x1, y: 0 }, b: { x: x1, y: chH } },
        { part: k2, a: { x: x2, y: 0 }, b: { x: x2, y: chH } },
      ]),
    );
  }
  for (const ck of chWallKeys) {
    parts[ck] = shiftSubs(parts[ck], -S / 2, -chH / 2);
  }
  extraPoses['chimney-front'] = { o: [cg.cx, cg.cy - S / 2, chMidZ], u: [1, 0, 0], v: [0, 0, -1], n: [0, 1, 0] };
  extraPoses['chimney-back'] = { o: [cg.cx, cg.cy + S / 2 - t, chMidZ], u: [1, 0, 0], v: [0, 0, -1], n: [0, 1, 0] };
  extraPoses['chimney-left'] = { o: [cg.cx - S / 2, cg.cy, chMidZ], u: [0, -1, 0], v: [0, 0, -1], n: [1, 0, 0] };
  extraPoses['chimney-right'] = { o: [cg.cx + S / 2 - t, cg.cy, chMidZ], u: [0, -1, 0], v: [0, 0, -1], n: [1, 0, 0] };

  const capHalf = S / 2 + 2;
  const capOuter = polygon([[-capHalf, -capHalf], [capHalf, -capHalf], [capHalf, capHalf], [-capHalf, capHalf]]);
  const flueHalf = S / 2 - t;
  parts['chimney-cap'] =
    flueHalf >= 2
      ? host.boolean({
          op: 'difference',
          a: [capOuter],
          b: [polygon([[-flueHalf, -flueHalf], [flueHalf, -flueHalf], [flueHalf, flueHalf], [-flueHalf, flueHalf]])],
        })
      : [capOuter];
  extraPoses['chimney-cap'] = { o: [cg.cx, cg.cy, cg.zTop], u: [1, 0, 0], v: [0, -1, 0], n: [0, 0, 1] };
  return parts;
}

function shapedHouseParts(m: Model, d: HouseDims, openings: Opening[]): BuiltHouse {
  const { W, D, H, t, finger, roof } = d;
  const info: JointMsg[] = [];
  const marks: Record<string, SubPath[]> = {};
  const ol = m.outline!;
  const outerPoly3D = outlineOuterPoly3D(m, W, D, t)!;
  const rm = computeRoofMetrics(W, D, H, t, roof, outerPoly3D);
  const floorZ = d.floor ? t : 0;
  const baseHo = outerBoardHeight(d);
  const ca = Math.cos(rm.pitchRad);
  const sa = Math.sin(rm.pitchRad);
  const tanA = Math.tan(rm.pitchRad);
  const isShed = roof.type === 'shed';
  const isGable = roof.type === 'gable';
  const isHipLike = roof.type === 'hip' || roof.type === 'pyramid';
  const isSlopedRoof = isShed || isGable;

  // Roof height Z(X, Y) in 3D coordinates (X right 0..W, Y back 0..D) for shed & gable
  const zRoofAt = (X: number, Y: number): number => {
    if (isShed) {
      const s =
        roof.shedDir === 'front'
          ? Y
          : roof.shedDir === 'back'
            ? D - Y
            : roof.shedDir === 'left'
              ? X
              : W - X;
      return H + Math.max(0, s) * tanA;
    }
    if (isGable) {
      const dEaves = roof.ridgeAxis === 'x' ? Math.min(Y, D - Y) : Math.min(X, W - X);
      return H + Math.max(0, dEaves) * tanA;
    }
    return rm.flushFlat ? H - t : H;
  };

  // Which model axis ('h' = X, 'v' = Y) runs parallel to the roof slope for shed & gable?
  const slopeModelAxis: 'h' | 'v' | null = isShed
    ? roof.shedDir === 'front' || roof.shedDir === 'back'
      ? 'v'
      : 'h'
    : isGable
      ? roof.ridgeAxis === 'x'
        ? 'v'
        : 'h'
      : null;

  const isEdgeSloped = (e: OEdgeInfo) => slopeModelAxis !== null && e.axis === slopeModelAxis;
  const modelTo3D = (xm: number, ym: number): XY => [xm + t, D - t - ym];

  // For a constant-height outer edge (perpendicular to slope), its top sits strictly under the lower roof face across ±t/2
  const edgeFlatZ = (e: OEdgeInfo): number => {
    if (!isSlopedRoof) return rm.flushFlat ? H - t : H;
    const mid = (e.from + e.to) / 2;
    const [xA, yA] = e.axis === 'h' ? modelTo3D(mid, e.pos - t / 2) : modelTo3D(e.pos - t / 2, mid);
    const [xB, yB] = e.axis === 'h' ? modelTo3D(mid, e.pos + t / 2) : modelTo3D(e.pos + t / 2, mid);
    return Math.min(zRoofAt(xA, yA), zRoofAt(xB, yB));
  };

  const edgePointZ = (e: OEdgeInfo, uModel: number): number => {
    const [X, Y] = e.axis === 'h' ? modelTo3D(uModel, e.pos) : modelTo3D(e.pos, uModel);
    return zRoofAt(X, Y);
  };

  // Corner height where edge e ends at which ('start' | 'end')
  const edgeCornerZ = (e: OEdgeInfo, which: 'start' | 'end'): number => {
    const q = e[which];
    const [ea, ez] = edgeRange(e, t);
    const uEnd = which === 'start' ? ea : ez;
    if (!isEdgeSloped(e)) return edgeFlatZ(e);
    const zSelf = edgePointZ(e, uEnd);
    if (q.kind === 'corner') {
      const o = ol.edges[q.edge];
      return Math.min(zSelf, edgeFlatZ(o));
    }
    if (q.kind === 'into') {
      const o = ol.edges[q.edge];
      return Math.min(zSelf, isEdgeSloped(o) ? edgePointZ(o, e.pos) : edgeFlatZ(o));
    }
    return zSelf;
  };

  // Maximum roof Z reached anywhere along an outer edge e
  const edgeMaxZ = (e: OEdgeInfo): number => {
    if (!isSlopedRoof) return rm.flushFlat ? H - t : H;
    if (!isEdgeSloped(e)) return edgeFlatZ(e);
    const [ea, ez] = edgeRange(e, t);
    let best = Math.max(edgeCornerZ(e, 'start'), edgeCornerZ(e, 'end'), edgePointZ(e, ea), edgePointZ(e, ez));
    if (isGable) {
      const uRidge = e.axis === 'v' ? D - t - D / 2 : W / 2 - t;
      if (uRidge > ea + EPS && uRidge < ez - EPS) {
        best = Math.max(best, H + rm.rise);
      }
    }
    return best;
  };

  const walls = wallPanels(m, d);
  const bs = boards(m, d, walls);
  // Adjust each board's height `b.h` to accommodate its sloped/high roof top while keeping bottom at `floorZ`!
  const boardTopZ = new Map<string, number>();
  for (const b of bs) {
    let maxZ = rm.flushFlat ? H - t : H;
    for (const e of b.edges) maxZ = Math.max(maxZ, edgeMaxZ(e));
    b.h = maxZ - floorZ;
    boardTopZ.set(b.key, maxZ);
    for (const p of b.members) Object.assign(p, { part: b.key, ox: p.s - b.bs, oy: b.h - p.h });
  }

  const boardOf = new Map<number, Board>();
  for (const b of bs) for (const e of b.edges) boardOf.set(e.k, b);
  const memberIds = new Set(bs.flatMap((b) => b.members.map((p) => p.it.wall.id)));
  const byId = new Map(walls.map((p) => [p.it.wall.id, p]));
  const fl = (x: number, y: number): Pt => ({ x: x + t - W / 2, y: y + t - D / 2 });
  const tenoned = (e: End) => e.kind === 'tee' || e.kind === 'edge';
  const innerH = innerHeight(d);
  let parts: Parts = {};
  const extraPoses: Record<string, Pose> = {};

  const n = ol.edges.length;
  const off = (e: OEdgeInfo) => e.pos + ((e.open ? -1 : 1) * e.inside * t) / 2;
  const makePlate = (outer = false, customSplits?: Map<number, number[]>): SubPath => {
    const nodes: Pt[] = [];
    const push = (x: number, y: number) => {
      const q = fl(x, y),
        last = nodes[nodes.length - 1];
      if (!last || Math.abs(last.x - q.x) > 1e-9 || Math.abs(last.y - q.y) > 1e-9) nodes.push(q);
    };
    const offFn = (e: OEdgeInfo) => (outer ? e.pos - (e.inside * t) / 2 : off(e));
    const endsFn = (e: OEdgeInfo, o: OEdgeInfo, p: XY): [number, number] => {
      const along = o.axis === e.axis ? (e.axis === 'h' ? p[0] : p[1]) : offFn(o);
      return e.axis === 'h' ? [along, offFn(e)] : [offFn(e), along];
    };
    for (let k = 0; k < n; k++) {
      const e = ol.edges[k];
      const [a, b] = endsFn(e, ol.edges[(k + n - 1) % n], ol.pts[k]),
        [c, dd] = endsFn(e, ol.edges[(k + 1) % n], ol.pts[(k + 1) % n]);
      push(a, b);
      if (!outer && !e.open) {
        const [r0, r1] = edgeRange(e, t),
          [j0, j1] = jointRange(e, t);
        const extra = customSplits?.get(e.k) ?? [];
        const along0 = e.axis === 'h' ? a : b,
          along1 = e.axis === 'h' ? c : dd;
        const dir = Math.sign(along1 - along0);
        const marksPos = [...new Set([r0, r1, j0, j1, ...extra])]
          .filter((v) => (v - along0) * dir > EPS && (along1 - v) * dir > EPS)
          .sort((p, q) => (p - q) * dir);
        for (const v of marksPos) e.axis === 'h' ? push(v, b) : push(a, v);
      }
      push(c, dd);
    }
    if (nodes.length > 1 && Math.abs(nodes[0].x - nodes[nodes.length - 1].x) < 1e-9 && Math.abs(nodes[0].y - nodes[nodes.length - 1].y) < 1e-9) nodes.pop();
    return { closed: true, nodes };
  };

  if (d.floor) parts.floor = [makePlate(false)];

  // 1. Build roof panels for ALL 5 roof types on the shaped L/U/C/T footprint!
  const [ox, oy] = roofOverhangXY(roof);
  const eavesPoly3D = offsetOrthoPoly(outerPoly3D, ox, oy);
  const roofPanels: RoofPanelGeom[] = [];
  const roofExclusions: Record<string, RoofExclusion[]> = {};
  const addShapedRoofExcl = (rk: string, a: Pt, b: Pt, width: number, pad = 1.5) => {
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const horiz = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
    const hw = (width + Math.max(0, d.clearance)) / 2 + pad;
    const ht = (t + Math.max(0, d.clearance)) / 2 + pad;
    (roofExclusions[rk] ??= []).push(horiz ? [mx - hw, my - ht, mx + hw, my + ht] : [mx - ht, my - hw, mx + ht, my + hw]);
  };

  // Track hip straight-skeleton face -> roofPanel key mapping for hip trusses
  let hipSkel: ReturnType<typeof orthogonalStraightSkeleton> | null = null;
  const hipFaceRoofKeys = new Map<number, string[]>();

  if (roof.type === 'flat') {
    if (rm.flushFlat) {
      const sp = makePlate(false);
      parts.roof = [sp];
      const pts: [number, number][] = sp.nodes.map((nd) => [nd.x, nd.y]);
      roofPanels.push({
        key: 'roof',
        pts,
        width: W,
        height: D,
        slopeLen: D,
        pose: { o: [W / 2, D / 2, H - t], u: [1, 0, 0], v: [0, -1, 0], n: [0, 0, 1] },
        marks: [],
      });
    } else {
      const pts: [number, number][] = eavesPoly3D.map(([X, Y]) => [X - W / 2, D / 2 - Y]);
      parts.roof = [polygon(pts)];
      roofPanels.push({
        key: 'roof',
        pts,
        width: W + 2 * ox,
        height: D + 2 * oy,
        slopeLen: D + 2 * oy,
        pose: { o: [W / 2, D / 2, H], u: [1, 0, 0], v: [0, -1, 0], n: [0, 0, 1] },
        marks: [],
      });
    }
  } else if (isShed) {
    let u: V3, v: V3, nn: V3, o0: V3;
    if (roof.shedDir === 'front') {
      u = [1, 0, 0];
      v = [0, -ca, -sa];
      nn = [0, -sa, ca];
      o0 = [0, 0, H];
    } else if (roof.shedDir === 'back') {
      u = [-1, 0, 0];
      v = [0, ca, -sa];
      nn = [0, sa, ca];
      o0 = [W, D, H];
    } else if (roof.shedDir === 'left') {
      u = [0, -1, 0];
      v = [-ca, 0, -sa];
      nn = [-sa, 0, ca];
      o0 = [0, D, H];
    } else {
      u = [0, 1, 0];
      v = [ca, 0, -sa];
      nn = [sa, 0, ca];
      o0 = [W, 0, H];
    }
    const rp = projectPlanPolyToRoofPanel('roof', eavesPoly3D, zRoofAt, u, v, nn, o0);
    parts.roof = [polygon(rp.pts)];
    roofPanels.push(rp);
  } else if (isGable) {
    const halves: {
      baseKey: string;
      clipAxis: 'x' | 'y';
      clipLimit: number;
      keepLess: boolean;
      u: V3;
      v: V3;
      nn: V3;
      o0: V3;
      zFn: (x: number, y: number) => number;
    }[] =
      roof.ridgeAxis === 'x'
        ? [
            {
              baseKey: 'roof-front',
              clipAxis: 'y',
              clipLimit: D / 2,
              keepLess: true,
              u: [1, 0, 0],
              v: [0, -ca, -sa],
              nn: [0, -sa, ca],
              o0: [0, 0, H],
              zFn: (_x, y) => H + y * tanA,
            },
            {
              baseKey: 'roof-back',
              clipAxis: 'y',
              clipLimit: D / 2,
              keepLess: false,
              u: [-1, 0, 0],
              v: [0, ca, -sa],
              nn: [0, sa, ca],
              o0: [W, D, H],
              zFn: (_x, y) => H + (D - y) * tanA,
            },
          ]
        : [
            {
              baseKey: 'roof-left',
              clipAxis: 'x',
              clipLimit: W / 2,
              keepLess: true,
              u: [0, -1, 0],
              v: [-ca, 0, -sa],
              nn: [-sa, 0, ca],
              o0: [0, D, H],
              zFn: (x, _y) => H + x * tanA,
            },
            {
              baseKey: 'roof-right',
              clipAxis: 'x',
              clipLimit: W / 2,
              keepLess: false,
              u: [0, 1, 0],
              v: [ca, 0, -sa],
              nn: [sa, 0, ca],
              o0: [W, 0, H],
              zFn: (x, _y) => H + (W - x) * tanA,
            },
          ];

    for (const hf of halves) {
      const valid = clipOrthoPolyHalfPlane(eavesPoly3D, hf.clipAxis, hf.clipLimit, hf.keepLess).sort(
        (a, b) => Math.min(...a.map((p) => p[0])) - Math.min(...b.map((p) => p[0])) || Math.min(...a.map((p) => p[1])) - Math.min(...b.map((p) => p[1])),
      );
      valid.forEach((pts, idx) => {
        const key = valid.length > 1 ? `${hf.baseKey}-${idx + 1}` : hf.baseKey;
        const rp = projectPlanPolyToRoofPanel(key, pts, hf.zFn, hf.u, hf.v, hf.nn, hf.o0);
        parts[key] = [polygon(rp.pts)];
        roofPanels.push(rp);
      });
    }
  } else if (isHipLike) {
    // True orthogonal straight-skeleton hip / pavilion roof!
    hipSkel = orthogonalStraightSkeleton(eavesPoly3D);
    let panelIdx = 0;
    for (const f of hipSkel.faces) {
      if (!f.quads.length) continue;
      const mergedPolys = mergeFaceQuads(f.quads);
      const u: V3 = [f.tx, f.ty, 0];
      const v: V3 = [-f.nx * ca, -f.ny * ca, -sa];
      const nn: V3 = [-f.nx * sa, -f.ny * sa, ca];
      const zFace = (X: number, Y: number) => H + (X * f.nx + Y * f.ny - f.line0 - roof.overhang) * tanA;
      const o0: V3 = [f.line0 * f.nx, f.line0 * f.ny, H - roof.overhang * tanA];
      const keysForFace: string[] = [];
      for (const pts of mergedPolys) {
        if (pts.length < 3) continue;
        const key = `roof-${++panelIdx}`;
        const rp = projectPlanPolyToRoofPanel(key, pts, zFace, u, v, nn, o0);
        parts[key] = [polygon(rp.pts)];
        roofPanels.push(rp);
        keysForFace.push(key);
      }
      hipFaceRoofKeys.set(f.orig, keysForFace);
    }
  }

  // 2. Prepare outer wall boards & sloped/gable top polylines + roof tenon specs
  const overhangingFlat = roof.type === 'flat' && !rm.flushFlat;
  const edgeRoofSpans = new Map<number, { a: number; b: number; width: number }[]>();
  interface ShapedSlopeJoint {
    a: Pt;
    b: Pt;
    roofKey: string;
    ra: Pt;
    rb: Pt;
    flushSide: -1 | 0 | 1;
    spans: { a: number; b: number; width: number }[];
  }
  const boardCaps = new Map<string, SubPath[]>();
  const boardSlopeJoints = new Map<string, ShapedSlopeJoint[]>();

  // Helper: find which shaped roof panel contains 3D segment (pA3 -> pB3) and return its local projection + flushSide
  const matchRoofPanel = (pA3: V3, pB3: V3): { rp: RoofPanelGeom; ra: Pt; rb: Pt; flushSide: -1 | 0 | 1 } | null => {
    const mid3: V3 = [(pA3[0] + pB3[0]) / 2, (pA3[1] + pB3[1]) / 2, (pA3[2] + pB3[2]) / 2];
    for (const rp of roofPanels) {
      if (!rp.pts.length) continue;
      const po = rp.pose;
      const distA = Math.abs((pA3[0] - po.o[0]) * po.n[0] + (pA3[1] - po.o[1]) * po.n[1] + (pA3[2] - po.o[2]) * po.n[2]);
      const distB = Math.abs((pB3[0] - po.o[0]) * po.n[0] + (pB3[1] - po.o[1]) * po.n[1] + (pB3[2] - po.o[2]) * po.n[2]);
      if (distA > 0.25 || distB > 0.25) continue;
      const proj = (P: V3): Pt => ({
        x: (P[0] - po.o[0]) * po.u[0] + (P[1] - po.o[1]) * po.u[1] + (P[2] - po.o[2]) * po.u[2],
        y: (P[0] - po.o[0]) * po.v[0] + (P[1] - po.o[1]) * po.v[1] + (P[2] - po.o[2]) * po.v[2],
      });
      const ra = proj(pA3);
      const rb = proj(pB3);
      const rmPt = proj(mid3);
      const probe = t / 2 + 0.5;
      const inMid = pointInPoly(rp.pts, rmPt.x, rmPt.y);
      const inL = pointInPoly(rp.pts, rmPt.x - probe, rmPt.y);
      const inR = pointInPoly(rp.pts, rmPt.x + probe, rmPt.y);
      if (!inMid && !inL && !inR) continue;
      const flushSide: -1 | 0 | 1 = inL && inR ? 0 : inR && !inL ? -1 : inL && !inR ? 1 : 0;
      return { rp, ra, rb, flushSide };
    }
    return null;
  };

  for (const b of bs) {
    const topZb = boardTopZ.get(b.key)!;
    const yOfZ = (z: number) => topZb - z;
    const els: { a: number; b: number; top: number; topB?: number; polyTop?: Pt[] }[] = [];
    const cornerSplitL: number[] = [];
    const cornerSplitR: number[] = [];

    for (const e of b.edges) {
      const [ea, ez] = edgeRange(e, t);
      const aLoc = ea - b.bs;
      const bLoc = ez - b.bs;
      if (!isSlopedRoof) {
        els.push({ a: aLoc, b: bLoc, top: 0 });
      } else if (!isEdgeSloped(e)) {
        const yFlat = yOfZ(edgeFlatZ(e));
        els.push({ a: aLoc, b: bLoc, top: yFlat, topB: yFlat });
      } else {
        // Sloped / gable outer edge: trace exact roof-plane top polyline directly on the board!
        const x0 = aLoc;
        const x1 = bLoc;
        const zStart = edgeCornerZ(e, 'start');
        const zEnd = edgeCornerZ(e, 'end');
        const zRaw0 = edgePointZ(e, ea);
        const zRaw1 = edgePointZ(e, ez);

        const ptsTop: { x: number; z: number }[] = [];
        const addPt = (x: number, z: number) => {
          const prev = ptsTop[ptsTop.length - 1];
          if (!prev || Math.hypot(x - prev.x, z - prev.z) > 1e-4) ptsTop.push({ x, z });
        };

        // Determine ridge position in board-local x (for gable edges that cross the ridge)
        const uRidge = isGable ? (e.axis === 'v' ? D - t - D / 2 : W / 2 - t) : null;
        const xRidge = uRidge !== null ? uRidge - b.bs : null;
        const crossesRidge = xRidge !== null && xRidge > x0 + t + EPS && xRidge < x1 - t - EPS;
        const halfFlat = crossesRidge && rm.pitchDeg > 55 ? Math.min(Math.max(0.6, t * 0.4), Math.min(1.0, t * 0.55)) : 0;

        addPt(x0, zRaw0);
        if (crossesRidge && xRidge !== null) {
          const zPeak = H + rm.rise - halfFlat * tanA;
          if (halfFlat > EPS) {
            addPt(xRidge - halfFlat, zPeak);
            addPt(xRidge + halfFlat, zPeak);
          } else {
            addPt(xRidge, H + rm.rise);
          }
        }
        addPt(x1, zRaw1);

        const polyTop: Pt[] = ptsTop.map((pt) => ({ x: pt.x, y: yOfZ(pt.z) }));
        els.push({ a: x0, b: x1, top: polyTop[0].y, topB: polyTop[polyTop.length - 1].y, polyTop });
        // Split left/right vertical edges at exact corner joint top height when corner wall is lower than zRaw
        if (aLoc < EPS && yOfZ(zStart) > polyTop[0].y + EPS) cornerSplitL.push(yOfZ(zStart));
        if (bLoc > b.be - b.bs - EPS && yOfZ(zEnd) > polyTop[polyTop.length - 1].y + EPS) cornerSplitR.push(yOfZ(zEnd));

        // Collect sloped roof tenon segments when roof.mount === 'fixed'
        if (roof.mount === 'fixed') {
          const sRidge = Math.max(t, t * tanA) + t;
          const sCornerPad = Math.max(t / Math.max(0.25, ca), t) + 1;
          for (let pi = 0; pi + 1 < ptsTop.length; pi++) {
            const p0 = ptsTop[pi];
            const p1 = ptsTop[pi + 1];
            if (Math.abs(p1.z - p0.z) < 0.1) continue; // skip flat steep-gable micro-plateau
            const segLen = Math.hypot(p1.x - p0.x, p1.z - p0.z);
            const pad0 = pi === 0 ? sCornerPad : sRidge;
            const pad1 = pi + 1 === ptsTop.length - 1 ? sCornerPad : sRidge;
            const spans = roofTenonSpans(pad0, segLen - pad1, t, finger);
            if (!spans.length) continue;

            const to3 = (xLoc: number, z: number): V3 => {
              const uM = b.bs + xLoc;
              const [X, Y] = e.axis === 'h' ? modelTo3D(uM, e.pos) : modelTo3D(e.pos, uM);
              return [X, Y, z];
            };
            const hit = matchRoofPanel(to3(p0.x, p0.z), to3(p1.x, p1.z));
            if (!hit) continue;
            (boardSlopeJoints.get(b.key) ?? (boardSlopeJoints.set(b.key, []), boardSlopeJoints.get(b.key)!)).push({
              a: { x: p0.x, y: yOfZ(p0.z) },
              b: { x: p1.x, y: yOfZ(p1.z) },
              roofKey: hit.rp.key,
              ra: hit.ra,
              rb: hit.rb,
              flushSide: hit.flushSide,
              spans,
            });
          }
        }
      }
    }
    for (const p of b.members) els.push({ a: p.ox, b: p.ox + p.e - p.s, top: p.oy });

    const top: number[] = [],
      bottom: number[] = [],
      left: number[] = [...cornerSplitL],
      right: number[] = [...cornerSplitR];
    for (const el of els) top.push(el.a, el.b), bottom.push(el.a, el.b);
    for (const e of b.edges) {
      for (const v of jointRange(e, t)) top.push(v - b.bs), bottom.push(v - b.bs);
      if (overhangingFlat && roof.mount === 'fixed' && roof.overhang >= t - EPS) {
        const [j0, j1] = jointRange(e, t);
        const sps = roofTenonSpans(j0, j1, t, finger);
        edgeRoofSpans.set(e.k, sps);
        for (const sp of sps) top.push(sp.a - b.bs, sp.b - b.bs);
      }
    }
    for (const p of b.members) {
      const s = wallSplits(p, d, tenoned);
      top.push(...s.top.map((x) => x + p.ox));
      bottom.push(...s.bottom.map((x) => x + p.ox));
      if (p.ox < EPS) left.push(...s.left.map((y) => y + p.oy));
      if (p.ox + p.e - p.s > b.be - b.bs - EPS) right.push(...s.right.map((y) => y + p.oy));
    }
    for (const e of b.edges) {
      const [a, z] = edgeRange(e, t);
      const intoH = Math.min(baseHo, b.h);
      const intoDrop = intoH - innerH;
      const ys = tenonStretches(intoDrop, intoH, finger).flatMap((sp) => [b.h - (intoH - sp.a), b.h - (intoH - sp.b)]);
      if (e.start.kind === 'into' && a - b.bs < EPS) left.push(...ys);
      if (e.end.kind === 'into' && z - b.bs > b.be - b.bs - EPS) right.push(...ys);
      const lower = (q: OEdgeInfo['start']) => (q.kind === 'line' && q.wall !== undefined ? [b.h - (byId.get(q.wall)?.h ?? b.h)] : []);
      if (a - b.bs < EPS) left.push(...lower(e.start));
      if (z - b.bs > b.be - b.bs - EPS) right.push(...lower(e.end));
    }
    parts[b.key] = [boardOutline(b, els, { top, bottom, left, right })];
  }

  for (const p of walls) if (!memberIds.has(p.it.wall.id)) parts[p.key] = [panel(p.e - p.s, p.h, wallSplits(p, d, tenoned))];

  const opts = (o: JointOptions): JointOptions => ({ thickness: t, clearance: d.clearance, ...o });
  const keep = (r: { parts: Parts; info: JointMsg[] }) => {
    parts = r.parts;
    info.push(...r.info);
  };

  // 3. Floor & flush-flat-roof & overhanging-flat-roof joints along outer edges
  for (const e of ol.edges) {
    if (e.open) continue;
    const b = boardOf.get(e.k)!;
    const [r0, r1] = jointRange(e, t);
    const f = e.pos + (e.inside * t) / 2;
    const P = (v: number) => (e.axis === 'h' ? fl(v, f) : fl(f, v));
    if (d.floor && parts.floor)
      keep(joint(parts, opts({ kind: 'finger', fingerWidth: finger, direction: 'out' }), [{ part: 'floor', a: P(r0), b: P(r1) }, { part: b.key, a: { x: r0 - b.bs, y: b.h }, b: { x: r1 - b.bs, y: b.h } }]));
    if (rm.flushFlat && parts.roof)
      keep(joint(parts, opts({ kind: 'finger', fingerWidth: finger, direction: 'out' }), [{ part: 'roof', a: P(r0), b: P(r1) }, { part: b.key, a: { x: r0 - b.bs, y: 0 }, b: { x: r1 - b.bs, y: 0 } }]));
    const sps = edgeRoofSpans.get(e.k);
    if (sps && parts.roof) {
      const Pc = (v: number) => (e.axis === 'h' ? fl(v, e.pos) : fl(e.pos, v));
      for (const sp of sps) {
        const ra = Pc(sp.a),
          rb = Pc(sp.b);
        parts = tenonsInto(
          parts,
          opts({ kind: 'tenon', tenonCount: 1, tenonWidth: sp.width }),
          { part: b.key, a: { x: sp.a - b.bs, y: 0 }, b: { x: sp.b - b.bs, y: 0 } },
          'roof',
          ra,
          rb,
        );
        addShapedRoofExcl('roof', ra, rb, sp.width);
      }
    }
  }

  // 4. Vertical corner finger joints between outer boards (sloped edge FIRST so top fingers reach outer corner!)
  const squares: SubPath[] = [];
  const square = (cx: number, cy: number): SubPath => {
    const p0 = fl(cx - t / 2, cy - t / 2),
      p1 = fl(cx + t / 2, cy + t / 2);
    return { closed: true, nodes: [p0, { x: p1.x, y: p0.y }, p1, { x: p0.x, y: p1.y }] };
  };
  for (const e of ol.edges)
    for (const which of ['start', 'end'] as const) {
      if (e.open) continue;
      const q = e[which];
      const v = which === 'start' ? e.from : e.to;
      const b = boardOf.get(e.k)!;
      const x = (which === 'start' ? edgeRange(e, t)[0] : edgeRange(e, t)[1]) - b.bs;
      if (q.kind === 'line' && q.wall !== undefined) {
        const p = byId.get(q.wall)!;
        const px = p.it.start.kind === 'board' && p.it.start.edge === e.k ? 0 : p.e - p.s;
        const P = (y: number): Pt => ({ x: px + p.ox, y: y + p.oy });
        keep(joint(parts, opts({ kind: 'finger', fingerWidth: finger, direction: 'out' }), [{ part: b.key, a: { x, y: b.h - p.h }, b: { x, y: b.h } }, { part: p.part, a: P(0), b: P(p.h) }]));
        squares.push(e.axis === 'h' ? square(v, e.pos) : square(e.pos, v));
      } else if (q.kind === 'corner') {
        if (q.edge < e.k) continue;
        const o = ol.edges[q.edge];
        const ob = boardOf.get(o.k)!;
        const oWhich = Math.abs(o.from - e.pos) < EPS ? 0 : 1;
        const oxCorner = edgeRange(o, t)[oWhich] - ob.bs;
        const zCorner = Math.min(edgeCornerZ(e, which), edgeCornerZ(o, oWhich === 0 ? 'start' : 'end'));
        const hCorner = zCorner - floorZ;
        const eEdge = { part: b.key, a: { x, y: b.h - hCorner }, b: { x, y: b.h } };
        const oEdge = { part: ob.key, a: { x: oxCorner, y: ob.h - hCorner }, b: { x: oxCorner, y: ob.h } };
        const [firstEdge, secondEdge] = !isEdgeSloped(e) && isEdgeSloped(o) ? [oEdge, eEdge] : [eEdge, oEdge];
        keep(joint(parts, opts({ kind: 'finger', fingerWidth: finger, direction: 'out' }), [firstEdge, secondEdge]));
        squares.push(e.axis === 'h' ? square(v, e.pos) : square(e.pos, v));
      } else if (crossed(q) && e.axis === 'h') {
        squares.push(square(v, e.pos));
      } else if (q.kind === 'into') {
        const hb = boardOf.get(q.edge)!;
        const u = e.pos - hb.bs;
        const intoH = Math.min(baseHo, b.h, hb.h);
        const intoDrop = intoH - innerH;
        for (const sp of tenonStretches(intoDrop, intoH, finger)) {
          const yA_b = b.h - (intoH - sp.a);
          const yB_b = b.h - (intoH - sp.b);
          const yA_h = hb.h - (intoH - sp.a);
          const yB_h = hb.h - (intoH - sp.b);
          parts = tenonsInto(
            parts,
            opts({ kind: 'tenon', tenonCount: 1, tenonWidth: sp.width }),
            { part: b.key, a: { x, y: yA_b }, b: { x, y: yB_b } },
            hb.key,
            { x: u, y: yA_h },
            { x: u, y: yB_h },
          );
        }
      }
    }
  if (squares.length) {
    if (d.floor && parts.floor) parts.floor = host.boolean({ op: 'union', a: parts.floor, b: squares });
    if (rm.flushFlat && parts.roof) parts.roof = host.boolean({ op: 'union', a: parts.roof, b: squares });
  }

  // 4b. Union sloped/gable top caps onto boards and tenon sloped top edges into shed/gable roof panels
  for (const [bKey, caps] of boardCaps) {
    if (caps.length && parts[bKey]) {
      parts[bKey] = host.boolean({ op: 'union', a: parts[bKey], b: caps });
    }
  }
  for (const [bKey, sjs] of boardSlopeJoints) {
    for (const sj of sjs) {
      const segLen = Math.hypot(sj.b.x - sj.a.x, sj.b.y - sj.a.y);
      const splitDists = sj.spans.flatMap((sp) => [sp.a, sp.b]);
      const spliced = spliceSegment(parts[bKey][0], sj.a, sj.b, splitDists);
      parts[bKey] = [spliced.sub, ...parts[bKey].slice(1)];
      for (const sp of sj.spans) {
        const pa = alongSeg(spliced.a, spliced.b, sp.a);
        const pb = alongSeg(spliced.a, spliced.b, sp.b);
        const fa = sp.a / Math.max(EPS, segLen);
        const fb = sp.b / Math.max(EPS, segLen);
        const ra: Pt = { x: sj.ra.x + fa * (sj.rb.x - sj.ra.x), y: sj.ra.y + fa * (sj.rb.y - sj.ra.y) };
        const rb: Pt = { x: sj.ra.x + fb * (sj.rb.x - sj.ra.x), y: sj.ra.y + fb * (sj.rb.y - sj.ra.y) };
        parts = roofTenonInto(
          parts,
          opts({ kind: 'tenon', tenonCount: 1, tenonWidth: sp.width }),
          { part: bKey, a: pa, b: pb },
          sj.roofKey,
          ra,
          rb,
          sj.flushSide,
        );
        addShapedRoofExcl(sj.roofKey, ra, rb, sp.width);
      }
    }
  }

  // 5. Internal trusses for shaped Hip/Pyramid roofs & Removable Gable roofs
  const builtTrusses: TrussSpec[] = [];
  const lapHalfW = Math.max(0.5, (t + d.clearance) / 2);

  if (isHipLike && hipSkel && hipSkel.ridges.length > 0) {
    interface ShapedTrussPlan {
      key: string;
      axis: 'x' | 'y';
      at: number;
      u0: number;
      u1: number;
      segs: { u0: number; u1: number; z0: number; z1: number; orig: number }[];
      maxZ: number;
    }
    const candidates: { axis: 'x' | 'y'; at: number; u0: number; u1: number }[] = [];
    const addCand = (axis: 'x' | 'y', at: number, hintU: number) => {
      if (candidates.some((c) => c.axis === axis && Math.abs(c.at - at) < Math.max(4 * t, 14))) return;
      const ivs = polyChordIntervals(outerPoly3D, axis, at);
      const hit = ivs.find(([a, b]) => hintU >= a - EPS && hintU <= b + EPS);
      if (!hit) return;
      const u0 = hit[0] + t;
      const u1 = hit[1] - t;
      if (u1 - u0 < Math.max(4 * t, 14)) return;
      candidates.push({ axis, at, u0, u1 });
    };

    // For each ridge, add one spine truss along the ridge and one cross truss perpendicular at its midpoint
    for (const r of hipSkel.ridges) {
      const rMid = (r.a + r.b) / 2;
      addCand(r.axis, r.at, rMid);
      const crossAxis: 'x' | 'y' = r.axis === 'x' ? 'y' : 'x';
      addCand(crossAxis, rMid, r.at);
    }

    const plans: ShapedTrussPlan[] = [];
    for (const c of candidates) {
      const rawProf = skeletonChordProfile(hipSkel, c.axis, c.at, c.u0, c.u1);
      if (!rawProf.length) continue;
      const segs = rawProf.map((s) => ({
        u0: s.u0,
        u1: s.u1,
        z0: H + Math.max(0, s.s0 - roof.overhang) * tanA,
        z1: H + Math.max(0, s.s1 - roof.overhang) * tanA,
        orig: s.orig,
      }));
      const maxZ = Math.max(...segs.map((s) => Math.max(s.z0, s.z1)));
      if (maxZ - H < Math.max(2 * t, 6)) continue;
      plans.push({
        key: `roof-truss-${plans.length + 1}`,
        axis: c.axis,
        at: c.at,
        u0: c.u0,
        u1: c.u1,
        segs,
        maxZ,
      });
    }

    // Detect X-vs-Y truss crossings for half-laps
    const zOnPlan = (pl: ShapedTrussPlan, u: number): number => {
      const seg = pl.segs.find((s) => u >= s.u0 - 0.1 && u <= s.u1 + 0.1) ?? pl.segs[0];
      const f = (u - seg.u0) / Math.max(EPS, seg.u1 - seg.u0);
      return seg.z0 + f * (seg.z1 - seg.z0);
    };

    for (const pl of plans) {
      const span = pl.u1 - pl.u0;
      const riseP = pl.maxZ - H;
      const topZ = pl.maxZ;
      const yOfZ = (z: number) => topZ - z;

      // Build top polyline in truss-local coords (x = u - u0, y = topZ - z)
      const topPts: { x: number; z: number; segIdx: number }[] = [];
      for (let si = 0; si < pl.segs.length; si++) {
        const s = pl.segs[si];
        if (si === 0) topPts.push({ x: s.u0 - pl.u0, z: s.z0, segIdx: si });
        topPts.push({ x: s.u1 - pl.u0, z: s.z1, segIdx: si });
      }
      // Steep-peak micro-plateau safeguard (> 55°)
      const nodes: Pt[] = [];
      const pushN = (x: number, y: number) => {
        const prev = nodes[nodes.length - 1];
        if (!prev || Math.hypot(x - prev.x, y - prev.y) > 1e-4) nodes.push({ x, y });
      };
      const halfFlat = rm.pitchDeg > 55 ? Math.min(Math.max(0.6, t * 0.4), Math.min(1.0, t * 0.55)) : 0;
      for (let i = 0; i < topPts.length; i++) {
        const pt = topPts[i];
        const isSharpPeak =
          halfFlat > EPS &&
          i > 0 &&
          i + 1 < topPts.length &&
          pt.z > topPts[i - 1].z + 0.2 &&
          pt.z > topPts[i + 1].z + 0.2;
        if (isSharpPeak) {
          pushN(pt.x - halfFlat, yOfZ(pt.z - halfFlat * tanA));
          pushN(pt.x + halfFlat, yOfZ(pt.z - halfFlat * tanA));
        } else {
          pushN(pt.x, yOfZ(pt.z));
        }
      }
      pushN(span, riseP);
      pushN(0, riseP);
      parts[pl.key] = [{ closed: true, nodes }];

      // Tenon each sloped segment of the truss into its matching hip roof panel!
      const sRidge = Math.max(t, t * tanA) + t;
      const sHeel = Math.max(t, t / Math.max(0.25, ca)) + t * 0.5;
      for (const s of pl.segs) {
        if (Math.abs(s.z1 - s.z0) < 0.2) continue; // flat ridge segment
        const pA: Pt = { x: s.u0 - pl.u0, y: yOfZ(s.z0) };
        const pB: Pt = { x: s.u1 - pl.u0, y: yOfZ(s.z1) };
        const segLen = Math.hypot(pB.x - pA.x, pB.y - pA.y);
        const pad0 = s.z0 < s.z1 ? sHeel : sRidge;
        const pad1 = s.z1 < s.z0 ? sHeel : sRidge;
        const spans = roofTenonSpans(pad0, segLen - pad1, t, finger);
        if (!spans.length) continue;

        const pA3: V3 = pl.axis === 'x' ? [s.u0, pl.at, s.z0] : [pl.at, s.u0, s.z0];
        const pB3: V3 = pl.axis === 'x' ? [s.u1, pl.at, s.z1] : [pl.at, s.u1, s.z1];
        const candKeys = hipFaceRoofKeys.get(s.orig) ?? [];
        const hitPanel = roofPanels.find((rp) => candKeys.includes(rp.key)) ?? null;
        if (!hitPanel) continue;
        const po = hitPanel.pose;
        const proj = (P: V3): Pt => ({
          x: (P[0] - po.o[0]) * po.u[0] + (P[1] - po.o[1]) * po.u[1] + (P[2] - po.o[2]) * po.u[2],
          y: (P[0] - po.o[0]) * po.v[0] + (P[1] - po.o[1]) * po.v[1] + (P[2] - po.o[2]) * po.v[2],
        });
        const raFull = proj(pA3);
        const rbFull = proj(pB3);

        // Verify tenon midpoints stay safely inside the triangular/trapezoidal hip panel
        const safeSpans = spans.filter((sp) => {
          const fm = ((sp.a + sp.b) / 2) / Math.max(EPS, segLen);
          const mx = raFull.x + fm * (rbFull.x - raFull.x);
          const my = raFull.y + fm * (rbFull.y - raFull.y);
          const padW = t / 2 + 1.8;
          return (
            pointInPoly(hitPanel.pts, mx - padW, my) &&
            pointInPoly(hitPanel.pts, mx + padW, my) &&
            pointInPoly(hitPanel.pts, mx, my - padW) &&
            pointInPoly(hitPanel.pts, mx, my + padW)
          );
        });
        if (!safeSpans.length) continue;

        const splitDists = safeSpans.flatMap((sp) => [sp.a, sp.b]);
        const spliced = spliceSegment(parts[pl.key][0], pA, pB, splitDists);
        parts[pl.key] = [spliced.sub, ...parts[pl.key].slice(1)];
        for (const sp of safeSpans) {
          const pa = alongSeg(spliced.a, spliced.b, sp.a);
          const pb = alongSeg(spliced.a, spliced.b, sp.b);
          const fa = sp.a / Math.max(EPS, segLen);
          const fb = sp.b / Math.max(EPS, segLen);
          const ra: Pt = { x: raFull.x + fa * (rbFull.x - raFull.x), y: raFull.y + fa * (rbFull.y - raFull.y) };
          const rb: Pt = { x: raFull.x + fb * (rbFull.x - raFull.x), y: raFull.y + fb * (rbFull.y - raFull.y) };
          parts = roofTenonInto(
            parts,
            opts({ kind: 'tenon', tenonCount: 1, tenonWidth: sp.width }),
            { part: pl.key, a: pa, b: pb },
            hitPanel.key,
            ra,
            rb,
            0,
          );
          addShapedRoofExcl(hitPanel.key, ra, rb, sp.width);
        }
      }

      // Half-lap notches at intersections with perpendicular trusses (x-axis from top, y-axis from bottom)
      const lapCuts: SubPath[] = [];
      for (const other of plans) {
        if (other.axis === pl.axis) continue;
        if (other.at <= pl.u0 + t + 1 || other.at >= pl.u1 - t - 1) continue;
        if (pl.at <= other.u0 + t + 1 || pl.at >= other.u1 - t - 1) continue;
        const zCross = Math.min(zOnPlan(pl, other.at), zOnPlan(other, pl.at));
        if (zCross - H < Math.max(2 * t, 6)) continue;
        const xLap = other.at - pl.u0;
        const zMidLap = H + (zCross - H) * 0.5;
        const yLap = yOfZ(zMidLap);
        if (pl.axis === 'x') {
          lapCuts.push(polygon([[xLap - lapHalfW, -2], [xLap + lapHalfW, -2], [xLap + lapHalfW, yLap], [xLap - lapHalfW, yLap]]));
        } else {
          lapCuts.push(polygon([[xLap - lapHalfW, yLap], [xLap + lapHalfW, yLap], [xLap + lapHalfW, riseP + 2], [xLap - lapHalfW, riseP + 2]]));
        }
      }
      if (lapCuts.length) {
        parts[pl.key] = host.boolean({ op: 'difference', a: parts[pl.key], b: lapCuts });
      }

      // Center & register exact 3D pose
      parts[pl.key] = shiftSubs(parts[pl.key], -span / 2, -riseP / 2);
      const midU = (pl.u0 + pl.u1) / 2;
      const pose: Pose =
        pl.axis === 'x'
          ? { o: [midU, pl.at - t / 2, H + riseP / 2], u: [1, 0, 0], v: [0, 0, -1], n: [0, 1, 0] }
          : { o: [pl.at - t / 2, midU, H + riseP / 2], u: [0, 1, 0], v: [0, 0, -1], n: [1, 0, 0] };
      extraPoses[pl.key] = pose;
      builtTrusses.push({
        key: pl.key,
        kind: pl.axis === 'x' ? 'hip-spine' : 'hip-cross',
        spanAxis: pl.axis,
        at: pl.at,
        innerSpan: span,
        outerSpan: span + 2 * t,
        topFlat: 0,
        eavesZ: H,
        rise: riseP,
        pitchRad: rm.pitchRad,
        heel: t * tanA,
        laps: [],
        leftRoofKey: roofPanels[0]?.key ?? 'roof-1',
        rightRoofKey: roofPanels[1]?.key ?? 'roof-1',
        leftRoofX: 0,
        rightRoofX: 0,
        fixedHooks: false,
        pts: [],
        pose,
      });
    }
  } else if (isGable && roof.mount === 'removable') {
    // Removable shaped gable: place internal ridge truss(es) across the longest full-ridge chord(s)
    const ridgeAxis = roof.ridgeAxis;
    const ridgeAt = ridgeAxis === 'x' ? D / 2 : W / 2;
    const spanAxis: 'x' | 'y' = ridgeAxis === 'x' ? 'y' : 'x';
    const rIvs = polyChordIntervals(outerPoly3D, ridgeAxis, ridgeAt);
    let tIdx = 0;
    for (const [ra, rb] of rIvs) {
      const len = rb - ra;
      if (len < Math.max(4 * t, 14)) continue;
      const at = (ra + rb) / 2;
      const cIvs = polyChordIntervals(outerPoly3D, spanAxis, at);
      const hit = cIvs.find(([a, b]) => ridgeAt > a + t + 2 && ridgeAt < b - t - 2);
      if (!hit) continue;
      const u0 = hit[0] + t;
      const u1 = hit[1] - t;
      const span = u1 - u0;
      if (span < Math.max(4 * t, 16)) continue;
      const xPeak = ridgeAt - u0;
      const halfFlat = rm.pitchDeg > 55 ? Math.min(Math.max(0.6, t * 0.4), Math.min(1.0, t * 0.55)) : 0;
      const z0 = zRoofAt(spanAxis === 'x' ? u0 : at, spanAxis === 'x' ? at : u0);
      const z1 = zRoofAt(spanAxis === 'x' ? u1 : at, spanAxis === 'x' ? at : u1);
      const zPeak = H + rm.rise - halfFlat * tanA;
      const riseT = zPeak - H;
      const yOfZ = (z: number) => zPeak - z;
      const key = rIvs.length > 1 ? `roof-truss-${++tIdx}` : 'roof-truss';
      const polyNodes: Pt[] = [
        { x: 0, y: yOfZ(z0) },
        ...(halfFlat > EPS ? [{ x: xPeak - halfFlat, y: 0 }, { x: xPeak + halfFlat, y: 0 }] : [{ x: xPeak, y: 0 }]),
        { x: span, y: yOfZ(z1) },
        { x: span, y: riseT },
        { x: 0, y: riseT },
      ];
      parts[key] = [{ closed: true, nodes: polyNodes }];
      const sRidge = Math.max(t, t * tanA) + t;
      const sHeel = Math.max(t, t / Math.max(0.25, ca)) + t * 0.5;
      const sidesT: [Pt, Pt, V3, V3][] = [
        [
          { x: 0, y: yOfZ(z0) },
          { x: xPeak - halfFlat, y: 0 },
          spanAxis === 'x' ? [u0, at, z0] : [at, u0, z0],
          spanAxis === 'x' ? [ridgeAt - halfFlat, at, zPeak] : [at, ridgeAt - halfFlat, zPeak],
        ],
        [
          { x: xPeak + halfFlat, y: 0 },
          { x: span, y: yOfZ(z1) },
          spanAxis === 'x' ? [ridgeAt + halfFlat, at, zPeak] : [at, ridgeAt + halfFlat, zPeak],
          spanAxis === 'x' ? [u1, at, z1] : [at, u1, z1],
        ],
      ];
      for (let si = 0; si < sidesT.length; si++) {
        const [pA, pB, pA3, pB3] = sidesT[si];
        const segLen = Math.hypot(pB.x - pA.x, pB.y - pA.y);
        const spans = roofTenonSpans(si === 0 ? sHeel : sRidge, segLen - (si === 0 ? sRidge : sHeel), t, finger);
        if (!spans.length) continue;
        const match = matchRoofPanel(pA3, pB3);
        if (!match) continue;
        const splitDists = spans.flatMap((sp) => [sp.a, sp.b]);
        const spliced = spliceSegment(parts[key][0], pA, pB, splitDists);
        parts[key] = [spliced.sub, ...parts[key].slice(1)];
        for (const sp of spans) {
          const pa = alongSeg(spliced.a, spliced.b, sp.a);
          const pb = alongSeg(spliced.a, spliced.b, sp.b);
          const fa = sp.a / Math.max(EPS, segLen);
          const fb = sp.b / Math.max(EPS, segLen);
          const raPt: Pt = { x: match.ra.x + fa * (match.rb.x - match.ra.x), y: match.ra.y + fa * (match.rb.y - match.ra.y) };
          const rbPt: Pt = { x: match.ra.x + fb * (match.rb.x - match.ra.x), y: match.ra.y + fb * (match.rb.y - match.ra.y) };
          parts = roofTenonInto(parts, opts({ kind: 'tenon', tenonCount: 1, tenonWidth: sp.width }), { part: key, a: pa, b: pb }, match.rp.key, raPt, rbPt, 0);
          addShapedRoofExcl(match.rp.key, raPt, rbPt, sp.width);
        }
      }
      parts[key] = shiftSubs(parts[key], -span / 2, -riseT / 2);
      const midU = (u0 + u1) / 2;
      extraPoses[key] =
        spanAxis === 'x'
          ? { o: [midU, at - t / 2, H + riseT / 2], u: [1, 0, 0], v: [0, 0, -1], n: [0, 1, 0] }
          : { o: [at - t / 2, midU, H + riseT / 2], u: [0, 1, 0], v: [0, 0, -1], n: [1, 0, 0] };
    }
  }

  // 5b. Removable flat & shed stop rails on shaped footprints (placed cleanly inside longest constant-height outer edges!)
  const builtRails: RoofRailSpec[] = [];
  if ((roof.type === 'flat' || isShed) && roof.mount === 'removable' && parts.roof && roofPanels[0]) {
    const rp = roofPanels[0];
    const po = rp.pose;
    const railH = Math.min(Math.max(2 * t, 6), Math.max(4, innerH * 0.25));
    const railEdges = ol.edges
      .filter((e) => !e.open && (!isShed || !isEdgeSloped(e)))
      .sort((a, b) => (b.to - b.from) - (a.to - a.from))
      .slice(0, 2);
    railEdges.forEach((e, idx) => {
      const [j0, j1] = jointRange(e, t);
      const inset = e.pos + e.inside * (t + 0.5 + t / 2);
      const uA = j0 + t + 1;
      const uB = j1 - t - 1;
      if (uB - uA < Math.max(3 * t, 14)) return;
      // Verify rail stays inside outerPoly3D
      const [xA3, yA3] = e.axis === 'h' ? modelTo3D(uA, inset) : modelTo3D(inset, uA);
      const [xB3, yB3] = e.axis === 'h' ? modelTo3D(uB, inset) : modelTo3D(inset, uB);
      if (!pointInPoly(outerPoly3D, xA3, yA3) || !pointInPoly(outerPoly3D, xB3, yB3) || !pointInPoly(outerPoly3D, (xA3 + xB3) / 2, (yA3 + yB3) / 2)) {
        return;
      }
      const len = uB - uA;
      const spans = roofTenonSpans(t * 0.5, len - t * 0.5, t, finger);
      if (!spans.length) return;
      const rKey = railEdges.length > 1 ? `roof-rail-${idx + 1}` : 'roof-rail';
      parts[rKey] = [panel(len, railH, { top: spans.flatMap((sp) => [sp.a, sp.b]), bottom: [], left: [], right: [] })];

      const pA3: V3 = [xA3, yA3, zRoofAt(xA3, yA3)];
      const pB3: V3 = [xB3, yB3, zRoofAt(xB3, yB3)];
      const proj = (P: V3): Pt => ({
        x: (P[0] - po.o[0]) * po.u[0] + (P[1] - po.o[1]) * po.u[1] + (P[2] - po.o[2]) * po.u[2],
        y: (P[0] - po.o[0]) * po.v[0] + (P[1] - po.o[1]) * po.v[1] + (P[2] - po.o[2]) * po.v[2],
      });
      const raFull = proj(pA3);
      const rbFull = proj(pB3);
      for (const sp of spans) {
        const fa = sp.a / len;
        const fb = sp.b / len;
        const ra: Pt = { x: raFull.x + fa * (rbFull.x - raFull.x), y: raFull.y + fa * (rbFull.y - raFull.y) };
        const rb: Pt = { x: raFull.x + fb * (rbFull.x - raFull.x), y: raFull.y + fb * (rbFull.y - raFull.y) };
        parts = tenonsInto(parts, opts({ kind: 'tenon', tenonCount: 1, tenonWidth: sp.width }), { part: rKey, a: { x: sp.a, y: 0 }, b: { x: sp.b, y: 0 } }, 'roof', ra, rb);
        addShapedRoofExcl('roof', ra, rb, sp.width);
      }
      parts[rKey] = shiftSubs(parts[rKey], -len / 2, -railH / 2);
      const midP: V3 = [(pA3[0] + pB3[0]) / 2, (pA3[1] + pB3[1]) / 2, (pA3[2] + pB3[2]) / 2];
      const uVec: V3 = [(pB3[0] - pA3[0]) / len, (pB3[1] - pA3[1]) / len, (pB3[2] - pA3[2]) / len];
      const vVec: V3 = [-po.n[0], -po.n[1], -po.n[2]];
      const nVec: V3 = [
        -(uVec[1] * vVec[2] - uVec[2] * vVec[1]),
        -(uVec[2] * vVec[0] - uVec[0] * vVec[2]),
        -(uVec[0] * vVec[1] - uVec[1] * vVec[0]),
      ];
      const pose: Pose = {
        o: [
          midP[0] + (railH / 2) * vVec[0] - (t / 2) * nVec[0],
          midP[1] + (railH / 2) * vVec[1] - (t / 2) * nVec[1],
          midP[2] + (railH / 2) * vVec[2] - (t / 2) * nVec[2],
        ],
        u: uVec,
        v: vVec,
        n: nVec,
      };
      extraPoses[rKey] = pose;
      builtRails.push({
        key: rKey,
        spanAxis: e.axis === 'h' ? 'x' : 'y',
        length: len,
        height: railH,
        roofKey: 'roof',
        roofY: 0,
        roofAxis: 'x',
        perpPos3D: e.axis === 'h' ? yA3 : xA3,
        pose,
      });
    });
  }

  // 6. Optional chimney on shaped flat / shed / gable footprints
  if (d.chimney?.enabled) {
    const cg = buildShapedChimneyGeom(outerPoly3D, W, D, H, t, d.floor, roof, roofPanels, d.chimney, d.clearance);
    if (cg) {
      parts = addChimneyParts(parts, extraPoses, roofExclusions, cg, t, finger, d.clearance, keep);
    }
  }

  // 7. Interior walls & crossings
  parts = innerJoints(parts, walls, d, info, (end, p) => {
    if (end.kind !== 'edge') return null;
    const b = boardOf.get(end.edge)!;
    const u = p.it.wall.pos - b.bs;
    return { into: b.key, at: (y) => ({ x: u, y: b.h - p.h + y }) };
  });

  for (const e of ol.edges)
    for (const which of ['start', 'end'] as const) {
      const q = e[which];
      if (q.kind !== 'through' || q.cross === undefined || e.axis !== 'h') continue;
      const o = ol.edges[q.cross];
      const v = which === 'start' ? e.from : e.to;
      const half = (t + d.clearance) / 2;
      const hb = boardOf.get(e.k)!,
        vb = boardOf.get(o.k)!;
      const hLap = Math.min(hb.h, vb.h) / 2;
      const cut = (b: Board, at: number, top: boolean): SubPath => {
        const x0 = at - b.bs - half,
          x1 = at - b.bs + half;
        const ySplit = b.h - hLap;
        const [y0, y1] = top ? [-1, ySplit] : [ySplit, b.h + t + 1];
        return polygon([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
      };
      parts[hb.key] = host.boolean({ op: 'difference', a: parts[hb.key], b: [cut(hb, v, true)] });
      parts[vb.key] = host.boolean({ op: 'difference', a: parts[vb.key], b: [cut(vb, e.pos, false)] });
    }

  // 7b. Optional intermediate floor slab (2nd story) on shaped L/U/C footprints!
  if (d.midFloor && d.midFloorHeight !== undefined) {
    const midZ = d.midFloorHeight;
    const edgeMidSpans = new Map<number, { a: number; b: number; width: number }[]>();
    const customSplits = new Map<number, number[]>();
    for (const e of ol.edges) {
      if (e.open) continue;
      const [j0, j1] = jointRange(e, t);
      const padJoint = t / 2 + Math.max(2, t);
      const blockers = e.tees.map((te): [number, number] => [te.at - padJoint, te.at + padJoint]);
      let segs: [number, number][] = [[j0, j1]];
      for (const [b0, b1] of blockers) {
        const next: [number, number][] = [];
        for (const [a, b] of segs) {
          if (b1 <= a || b0 >= b) next.push([a, b]);
          else {
            if (b0 > a + EPS) next.push([a, b0]);
            if (b1 < b - EPS) next.push([b1, b]);
          }
        }
        segs = next;
      }
      const sps: { a: number; b: number; width: number }[] = [];
      for (const [a, b] of segs) sps.push(...roofTenonSpans(a, b, t, finger));
      if (sps.length) {
        edgeMidSpans.set(e.k, sps);
        customSplits.set(e.k, sps.flatMap((sp) => [sp.a, sp.b]));
      }
    }
    parts['mid-floor'] = [makePlate(false, customSplits)];
    for (const e of ol.edges) {
      if (e.open) continue;
      const sps = edgeMidSpans.get(e.k);
      if (!sps?.length) continue;
      const b = boardOf.get(e.k)!;
      const f = e.pos + (e.inside * t) / 2;
      const P = (v: number) => (e.axis === 'h' ? fl(v, f) : fl(f, v));
      const ySlot = b.h - (midZ + t / 2 - floorZ);
      for (const sp of sps) {
        parts = tenonsInto(
          parts,
          opts({ kind: 'tenon', tenonCount: 1, tenonWidth: sp.width }),
          { part: 'mid-floor', a: P(sp.a), b: P(sp.b) },
          b.key,
          { x: sp.a - b.bs, y: ySlot },
          { x: sp.b - b.bs, y: ySlot },
        );
      }
    }
    // Optional stairwell cutout inside a verified clear region of the shaped floor
    if (d.midFloorStair) {
      const sw = Math.min(22, W * 0.22);
      const sd = Math.min(18, D * 0.22);
      const padS = t + 5;
      let placed = false;
      for (let cy = D - padS - sd / 2; cy >= padS + sd / 2 && !placed; cy -= 4) {
        for (let cx = W - padS - sw / 2; cx >= padS + sw / 2 && !placed; cx -= 4) {
          const corners: XY[] = [
            [cx - sw / 2 - padS + t, cy - sd / 2 - padS + t],
            [cx + sw / 2 + padS - t, cy - sd / 2 - padS + t],
            [cx + sw / 2 + padS - t, cy + sd / 2 + padS - t],
            [cx - sw / 2 - padS + t, cy + sd / 2 + padS - t],
            [cx, cy],
          ];
          if (!corners.every(([px, py]) => pointInPoly(outerPoly3D, px, py))) continue;
          const fx0 = cx - sw / 2 - W / 2;
          const fx1 = cx + sw / 2 - W / 2;
          const fy0 = D / 2 - (cy + sd / 2);
          const fy1 = D / 2 - (cy - sd / 2);
          parts['mid-floor'] = host.boolean({
            op: 'difference',
            a: parts['mid-floor'],
            b: [polygon([[fx0, fy0], [fx1, fy0], [fx1, fy1], [fx0, fy1]])],
          });
          placed = true;
        }
      }
    }
    extraPoses['mid-floor'] = { o: [W / 2, D / 2, midZ], u: [1, 0, 0], v: [0, -1, 0], n: [0, 0, 1] };
  }

  // 8. Cut interior-wall openings on standalone inner walls
  const hosts = houseWallHosts(m, d);
  const sillZ = sillBaseZ(d.floor, t);
  const shapedThreshold = sillZ - floorZ;
  for (const p of walls) {
    if (memberIds.has(p.it.wall.id)) continue;
    const wallOps = openings.filter((o) => o.wall === p.key);
    if (!wallOps.length) continue;
    const hostWall = hosts.get(p.key);
    const cuts: SubPath[] = [];
    const wallMarks: SubPath[] = [];
    for (const op of wallOps) {
      const yBot = p.h - (shapedThreshold + op.y);
      const cutThrough = !d.floor && op.y <= 0.01;
      cuts.push(...openingCutouts(op, op.x, yBot, d.mullionWidth, cutThrough));
      if (d.engraveFrames) {
        const fw = hostWall ? safeFrameWidth(op, hostWall, wallOps, d.frameWidth, t) : d.frameWidth;
        if (fw > 0) wallMarks.push(...openingMarks(op, op.x, yBot, fw));
      }
    }
    if (cuts.length) parts[p.key] = host.boolean({ op: 'difference', a: parts[p.key], b: cuts });
    if (wallMarks.length) marks[p.key] = wallMarks;
  }

  // 9. Cut outer-side openings onto matching bounding-box outer boards (+ optional 3D trim frames!)
  const wInner = W - 2 * t,
    dInner = D - 2 * t;
  const sidePos: Record<OuterWallKey, { axis: 'h' | 'v'; pos: number; len: number; flipX: boolean }> = {
    front: { axis: 'h', pos: dInner + t / 2, len: W, flipX: false },
    back: { axis: 'h', pos: -t / 2, len: W, flipX: true },
    left: { axis: 'v', pos: -t / 2, len: D, flipX: false },
    right: { axis: 'v', pos: wInner + t / 2, len: D, flipX: true },
  };
  for (const b of bs) {
    const cuts: SubPath[] = [];
    const bMarks: SubPath[] = [];
    for (const [wk, sp] of Object.entries(sidePos) as [OuterWallKey, (typeof sidePos)[OuterWallKey]][]) {
      if (b.axis !== sp.axis || Math.abs(b.pos - sp.pos) > 0.05) continue;
      const wallOps = openings.filter((o) => o.wall === wk);
      const hostWall = hosts.get(wk);
      const edgeSpans = b.edges.map((e) => {
        const [ea, ez] = edgeRange(e, t);
        return [ea - b.bs, ez - b.bs] as [number, number];
      });
      for (const op of wallOps) {
        const panelX = (sp.flipX ? sp.len - op.x : op.x) - t;
        const bx = panelX - b.bs;
        const onOuterEdge = edgeSpans.some(([s0, s1]) => bx - op.w / 2 >= s0 + 0.5 && bx + op.w / 2 <= s1 - 0.5);
        const maxWallZ = hostWall ? hostWall.zAt(op.x) : floorZ + b.h;
        if (onOuterEdge && sillZ + op.y + op.h <= maxWallZ - 0.5) {
          const yBot = b.h - (shapedThreshold + op.y);
          const cutThrough = !d.floor && op.y <= 0.01;
          cuts.push(...openingCutouts(op, bx, yBot, d.mullionWidth, cutThrough));
          const fw = hostWall ? safeFrameWidth(op, hostWall, wallOps, d.frameWidth, t) : d.frameWidth;
          if (d.engraveFrames && fw > 0) bMarks.push(...openingMarks(op, bx, yBot, fw));
          if (d.cutoutFrames) {
            const frameKey = `frame-${op.id}`;
            const cutFw = Math.max(1.8, fw > 0 ? fw : d.frameWidth);
            parts[frameKey] = openingTrimFrame(op, cutFw);
            const opMidZ = sillZ + op.y + op.h / 2;
            if (wk === 'front') extraPoses[frameKey] = { o: [op.x, -t, opMidZ], u: [1, 0, 0], v: [0, 0, -1], n: [0, 1, 0] };
            else if (wk === 'back') extraPoses[frameKey] = { o: [W - op.x, D, opMidZ], u: [-1, 0, 0], v: [0, 0, -1], n: [0, 1, 0] };
            else if (wk === 'left') extraPoses[frameKey] = { o: [-t, D - op.x, opMidZ], u: [0, -1, 0], v: [0, 0, -1], n: [1, 0, 0] };
            else extraPoses[frameKey] = { o: [W, op.x, opMidZ], u: [0, 1, 0], v: [0, 0, -1], n: [1, 0, 0] };
          }
        }
      }
    }
    if (cuts.length) parts[b.key] = host.boolean({ op: 'difference', a: parts[b.key], b: cuts });
    if (bMarks.length) marks[b.key] = bMarks;
  }

  // 10. Roof engraving patterns across ALL shaped roof panels (skipping all tenon slots & chimney holes)
  if (roof.pattern !== 'none') {
    const patMargin = rm.flushFlat ? 2 : roof.mount === 'fixed' ? Math.max(2, t + 1) : 2;
    for (const rp of roofPanels) {
      if (rp.pts.length < 3) continue;
      const mks = roofPatternMarks(rp.pts, roof.pattern, roof.patternSize, patMargin, roofExclusions[rp.key] ?? []);
      if (mks.length) marks[rp.key] = mks;
    }
  }

  // 11. Center outer boards and standalone inner walls
  for (const b of bs) {
    const cx = (b.be - b.bs) / 2,
      cy = b.h / 2;
    parts[b.key] = shiftSubs(parts[b.key], -cx, -cy);
    if (marks[b.key]) marks[b.key] = shiftSubs(marks[b.key], -cx, -cy);
  }
  for (const p of walls) {
    if (memberIds.has(p.it.wall.id)) continue;
    const cx = (p.e - p.s) / 2,
      cy = p.h / 2;
    parts[p.key] = shiftSubs(parts[p.key], -cx, -cy);
    if (marks[p.key]) marks[p.key] = shiftSubs(marks[p.key], -cx, -cy);
  }

  return {
    parts,
    marks,
    info: dedupeInfo(info),
    walls: walls.filter((p) => !memberIds.has(p.it.wall.id)),
    boards: bs,
    roofPanels,
    trusses: builtTrusses,
    rails: builtRails,
    extraPoses,
    outerHeights: {},
    hosts,
  };
}

// ---------- Orientation (outer face up on laser bed), kerf, and 3D poses ----------

const X: V3 = [1, 0, 0],
  Y: V3 = [0, 1, 0],
  Z: V3 = [0, 0, 1];
const neg = (a: V3): V3 => [-a[0], -a[1], -a[2]];

export const TURNED_OVER = ['floor', 'back', 'right'];
export const boardTurned = (b: Board) => (b.axis === 'h') === (b.edges[0]?.inside === 1);

export function mirrorX(sp: SubPath): SubPath {
  const f = (p: { x: number; y: number }) => ({ x: -p.x, y: p.y });
  const ns = !sp.closed ? [...sp.nodes].reverse() : sp.nodes.length ? [sp.nodes[0], ...sp.nodes.slice(1).reverse()] : [];
  return {
    ...sp,
    nodes: ns.map((n) => {
      const { cin, cout, ...rest } = n;
      return { ...rest, ...f(n), ...(cout ? { cin: f(cout) } : {}), ...(cin ? { cout: f(cin) } : {}) };
    }),
  };
}

export function turnOver(
  parts: Parts,
  marks: Record<string, SubPath[]>,
  keys: string[],
): { parts: Parts; marks: Record<string, SubPath[]> } {
  const outParts: Parts = { ...parts };
  const outMarks: Record<string, SubPath[]> = { ...marks };
  for (const k of keys) {
    if (outParts[k]) outParts[k] = outParts[k].map(mirrorX);
    if (outMarks[k]) outMarks[k] = outMarks[k].map(mirrorX);
  }
  return { parts: outParts, marks: outMarks };
}

/** 3D assembly poses for every part of the house (floor, walls, boards, roof panels, trusses, rails, chimney, mid-floor, 3D frames) */
export function housePoses(built: BuiltHouse, d: HouseDims, keys: string[]): Record<string, Pose> {
  const { W, D, H, t } = d;
  const floorZ = d.floor ? t : 0;
  const down = neg(Z);
  const turn = (k: string, a: V3) => (TURNED_OVER.includes(k) ? neg(a) : a);
  const zMid = (k: OuterWallKey) => (built.outerHeights[k]?.topZ ?? H) / 2;

  const all: Record<string, Pose> = {
    floor: { o: [W / 2, D / 2, 0], u: turn('floor', X), v: neg(Y), n: Z },
    front: { o: [W / 2, 0, zMid('front')], u: X, v: down, n: Y },
    back: { o: [W / 2, D - t, zMid('back')], u: turn('back', X), v: down, n: Y },
    left: { o: [0, D / 2, zMid('left')], u: neg(Y), v: down, n: X },
    right: { o: [W - t, D / 2, zMid('right')], u: turn('right', neg(Y)), v: down, n: X },
  };

  for (const rp of built.roofPanels) all[rp.key] = rp.pose;
  for (const tr of built.trusses) all[tr.key] = tr.pose;
  for (const rl of built.rails) all[rl.key] = rl.pose;
  Object.assign(all, built.extraPoses);

  const along = (key: string, axis: 'h' | 'v', pos: number, mid: number, z: number, over = false) => {
    const u = axis === 'h' ? X : neg(Y);
    all[key] =
      axis === 'h'
        ? { o: [t + mid, D - t - pos - t / 2, z], u: over ? neg(u) : u, v: down, n: Y }
        : { o: [t + pos - t / 2, D - t - mid, z], u: over ? neg(u) : u, v: down, n: X };
  };
  for (const p of built.walls) along(p.key, p.it.wall.axis, p.it.wall.pos, p.s + (p.e - p.s) / 2, floorZ + p.h / 2);
  for (const b of built.boards) along(b.key, b.axis, b.pos, (b.bs + b.be) / 2, floorZ + b.h / 2, boardTurned(b));

  return Object.fromEntries(keys.filter((k) => all[k]).map((k) => [k, all[k]]));
}

export function withKerf(parts: Parts, kerf: number): Parts {
  const out: Parts = {};
  for (const [k, subs] of Object.entries(parts)) out[k] = widen(subs, kerf);
  return out;
}

function dedupeInfo(list: JointMsg[]): JointMsg[] {
  const seen = new Set<string>();
  return list.filter((i) => {
    const k = i.code + JSON.stringify(i.values ?? {});
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

export { JointError };
