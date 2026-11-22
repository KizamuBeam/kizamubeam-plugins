// House composer: parametric laser-cut house generator oriented on box-composer-advanced.
// Features freely placed interior room walls (T-joints, corners, free ends, crossings), 5 roof types
// (gable, shed, flat, hip, pyramid) with configurable pitch/height, overhangs, mount & engraved patterns,
// and interactive doors & windows (rect, arch, cross, grid, round, double) across outer and interior walls.
// All wood joints come from the app via host.joints (v: 2).
import { definePlugin, host, mm, type Change, type Drawing, type EventResult, type Issue, type Part, type SubPath, type Text } from '../../../sdk/ts';
import { JointError } from './joints';
import { current, keepWalls } from './edit';
import { buildModel, EPS, mergeWalls, readLayout, scaleLayout, unify, writeLayout, type Layout, type Limits, type Model, type Side, type Wall } from './model';
import { bbox, isRect } from './outline';
import {
  classicFacadePreset,
  cottageFacadePreset,
  duplicateOpeningOnWall,
  findOpeningSpot,
  modernFacadePreset,
  readOpenings,
  scaleOpenings,
  validateOpenings,
  writeOpenings,
  type Opening,
} from './openings';
import {
  boardTurned,
  buildHouseParts,
  floorSpans,
  housePoses,
  houseWallHosts,
  innerHeight,
  outlineOuterPoly3D,
  turnOver,
  TURNED_OVER,
  wallPanels,
  withKerf,
  type BuiltHouse,
  type HouseDims,
} from './parts';
import {
  computeRoofMetrics,
  validateChimney,
  validateRoof,
  type ChimneyPos,
  type ChimneySpec,
  type OuterWallKey,
  type RoofMount,
  type RoofPattern,
  type RoofSizeMode,
  type RoofSpec,
  type RoofType,
} from './roof';
import { activeWallKey, houseDraw, housePointer, planSelectedId, selectedOpeningId, type HouseSurfaceCtx } from './surface';
import type { Plan } from './planSurface';

interface P {
  [k: string]: number | string | boolean;
  width: number;
  depth: number;
  height: number;
  floor: boolean;
  midFloor: boolean;
  midFloorHeight: number;
  midFloorStair: boolean;
  wallFront: boolean;
  wallBack: boolean;
  wallLeft: boolean;
  wallRight: boolean;
  dividerDrop: number;
  fromMaterial: boolean;
  thickness: number;
  clearance: number;
  kerf: number;
  finger: number;
  roofType: string;
  roofSizeMode: string;
  roofAngle: number;
  roofHeight: number;
  ridgeAxis: string;
  shedDir: string;
  roofOverhang: number;
  roofGableOverhang: number;
  roofMount: string;
  roofPattern: string;
  roofPatternSize: number;
  chimney: boolean;
  chimneyPos: string;
  chimneySize: number;
  engraveFrames: boolean;
  cutoutFrames: boolean;
  frameWidth: number;
  mullionWidth: number;
  openings: string;
  walls: string;
  wallsRef: string;
}

const sidesOf = (p: P): Record<Side, boolean> => ({ x0: p.wallLeft, x1: p.wallRight, y0: p.wallBack, y1: p.wallFront });
const SIDE_KEYS: Record<string, Side> = { wallLeft: 'x0', wallRight: 'x1', wallBack: 'y0', wallFront: 'y1' };
const RECT_KEYS = ['back', 'right', 'front', 'left'];

function roofOf(p: P): RoofSpec {
  return {
    type: (p.roofType as RoofType) || 'gable',
    sizeMode: (p.roofSizeMode as RoofSizeMode) || 'angle',
    angle: Number(p.roofAngle) || 35,
    height: Number(p.roofHeight) || 32,
    ridgeAxis: p.ridgeAxis === 'y' ? 'y' : 'x',
    shedDir: (['front', 'back', 'left', 'right'].includes(String(p.shedDir)) ? p.shedDir : 'front') as OuterWallKey,
    overhang: Math.max(0, Number(p.roofOverhang) || 0),
    gableOverhang: Math.max(0, Number(p.roofGableOverhang) || 0),
    mount: p.roofMount === 'removable' ? 'removable' : ('fixed' as RoofMount),
    pattern: (['none', 'tiles', 'shingles', 'seams'].includes(String(p.roofPattern)) ? p.roofPattern : 'none') as RoofPattern,
    patternSize: Math.max(4, Number(p.roofPatternSize) || 10),
  };
}

function chimneyOf(p: P): ChimneySpec {
  return {
    enabled: !!p.chimney,
    pos: (['left', 'center', 'right'].includes(String(p.chimneyPos)) ? p.chimneyPos : 'right') as ChimneyPos,
    size: Math.max(8, Number(p.chimneySize) || 14),
  };
}

function layoutOf(p: P, w: number, d: number): Layout | null {
  const l = readLayout(p.walls, p.wallsRef);
  if (!l) return null;
  const ref: [number, number] = l.ref[0] > 0 && l.ref[1] > 0 ? l.ref : [w, d];
  return { ref, walls: unify(l.walls, ref[0], ref[1], p.thickness, sidesOf(p)), sides: sidesOf(p) };
}

function fromMaterial(): { thickness: number; kerf: number | null; clearance: number | null; name: string | null } | null {
  const m = host.context('material');
  if (!m || m.thickness == null) return null;
  return { thickness: m.thickness, kerf: m.kerf, clearance: m.slotPlay, name: m.name };
}

function dims(p: P): { d: HouseDims | null; issues: Issue[]; material: string | null } {
  const issues: Issue[] = [];
  let material: string | null = null;
  if (p.fromMaterial) {
    const m = fromMaterial();
    if (!m) return { d: null, issues: [{ key: 'fromMaterial', level: 'error', code: 'material-none' }], material: null };
    material = m.name;
    const off = (a: number | null, b: number) => a != null && Math.abs(a - b) > 1e-6;
    if (off(m.thickness, p.thickness) || off(m.kerf, p.kerf) || off(m.clearance, p.clearance))
      issues.push({ key: 'fromMaterial', level: 'warn', code: 'material-changed', values: { thickness: m.thickness } });
    if (m.kerf == null) issues.push({ key: 'fromMaterial', level: 'warn', code: 'material-no-kerf', values: { kerf: p.kerf } });
    if (m.clearance == null) issues.push({ key: 'fromMaterial', level: 'warn', code: 'material-no-play', values: { play: p.clearance } });
  }
  const sides = sidesOf(p);
  const any = sides.x0 || sides.x1 || sides.y0 || sides.y1;
  const d: HouseDims = {
    W: p.width,
    D: p.depth,
    H: p.height,
    t: p.thickness,
    finger: p.finger,
    clearance: p.clearance,
    kerf: p.kerf,
    floor: !!p.floor,
    midFloor: !!p.midFloor,
    midFloorHeight: Number(p.midFloorHeight) || 50,
    midFloorStair: !!p.midFloorStair,
    sides,
    drop: any ? p.dividerDrop : 0,
    roof: roofOf(p),
    chimney: chimneyOf(p),
    engraveFrames: !!p.engraveFrames,
    cutoutFrames: !!p.cutoutFrames,
    frameWidth: Math.max(0.5, Number(p.frameWidth) || 2.5),
    mullionWidth: Math.max(1, Number(p.mullionWidth) || 2),
  };
  return { d, issues, material };
}

const limits = (t: number): Limits => ({ t, gap: t, minLen: 2 * t, freeLen: 2 * t });

function planOf(p: P): Plan | null {
  const t = p.thickness;
  const w = p.width - 2 * t,
    d = p.depth - 2 * t;
  const layout = w > 0 && d > 0 ? layoutOf(p, w, d) : null;
  if (!(w > 0 && d > 0) || !layout) return null;
  return { w, d, t, lim: limits(t), layout, sides: sidesOf(p) };
}

function modelOf(p: P, d: HouseDims): Model | Issue {
  const t = d.t;
  const w = d.W - 2 * t,
    dd = d.D - 2 * t;
  if (!(w > 2 * t && dd > 2 * t)) return { level: 'error', code: 'house-small' };
  if (innerHeight(d) < 2 * t) return { key: 'height', level: 'error', code: 'walls-low', values: { min: 2 * t } };
  const l = layoutOf(p, w, dd);
  if (!l) return { key: 'walls', level: 'error', code: 'walls-bad' };
  return buildModel(l, w, dd, limits(t));
}
const isIssue = (m: Model | Issue): m is Issue => 'code' in m;

function compute(p: P) {
  const { d, issues, material } = dims(p);
  if (!d) return { issues, d, material, built: null as BuiltHouse | null, m: null as Model | null, box: null as NonNullable<Model['box']> | null, openings: [] as Opening[] };

  const openings = readOpenings(p.openings);
  if (!openings) {
    issues.push({ key: 'openings', level: 'error', code: 'openings-bad' });
    return { issues, d, material, built: null, m: null, box: null, openings: [] };
  }

  const m = modelOf(p, d);
  if (isIssue(m)) return { issues: [...issues, m], d, material, built: null, m: null, box: null, openings };
  issues.push(...m.issues.map((i) => ({ key: 'walls', ...i })));
  if (!m.box || issues.some((i) => i.level === 'error')) return { issues, d, material, built: null, m, box: m.box ?? null, openings };

  const box = m.box;
  const sides = box.sides;
  const any = sides.x0 || sides.x1 || sides.y0 || sides.y1;
  const db: HouseDims = {
    ...d,
    W: box.size[0] + 2 * d.t,
    D: box.size[1] + 2 * d.t,
    sides,
    drop: any ? p.dividerDrop : 0,
  };

  // Validate roof & optional chimney against actual outline shape & dimensions
  const rect = isRect(box.pts);
  const outerPoly3D = rect ? null : outlineOuterPoly3D(box.model, db.W, db.D, db.t);
  issues.push(...validateRoof(db.W, db.D, db.H, db.t, db.roof, rect, outerPoly3D));
  if (db.chimney?.enabled) {
    issues.push(...validateChimney(db.W, db.D, db.H, db.t, db.floor, db.roof, db.chimney, rect, db.clearance, outerPoly3D));
  }

  // Validate optional intermediate floor slab (works on rectangular AND L/U-shaped footprints!)
  let validMidFloorZ: number | undefined;
  if (db.midFloor) {
    const rm = computeRoofMetrics(db.W, db.D, db.H, db.t, db.roof, outerPoly3D);
    const floorZ = db.floor ? db.t : 0;
    const topZ = rm.flushFlat ? db.H - db.t : db.H;
    const minMid = floorZ + 2 * db.t + 6;
    const maxMid = topZ - 3 * db.t - 4;
    const mz = db.midFloorHeight ?? 50;
    if (mz < minMid - 0.01 || mz > maxMid + 0.01) {
      issues.push({ key: 'midFloorHeight', level: 'error', code: 'midfloor-bounds', values: { min: minMid, max: Math.max(minMid, maxMid) } });
    } else {
      validMidFloorZ = mz;
    }
  }

  // If floor is off, warn/error if any interior wall has two free ends (would float!)
  if (!db.floor) {
    for (const wi of box.model.walls) {
      if (wi.start.kind === 'free' && wi.end.kind === 'free' && !wi.tees.length && !wi.crosses.length) {
        issues.push({ key: 'floor', level: 'error', code: 'wall-floating', values: { id: box.src.get(wi.wall.id) ?? wi.wall.id } });
      }
    }
  }

  // Validate openings against wall silhouettes, joints, overlaps, mid-floor slab & engraved frame clearance
  const hosts = houseWallHosts(box.model, db);
  issues.push(...validateOpenings(openings, hosts, db.t, db.mullionWidth, db.engraveFrames, db.frameWidth, validMidFloorZ));

  if (issues.some((i) => i.level === 'error')) return { issues, d: db, material, built: null, m, box, openings };

  try {
    return { issues, d: db, material, built: buildHouseParts(box.model, db, openings), m, box, openings };
  } catch (e) {
    if (e instanceof JointError) {
      return {
        issues: [...issues, { level: 'error' as const, code: e.code, ...(e.values ? { values: e.values } : {}) }],
        d: db,
        material,
        built: null,
        m,
        box,
        openings,
      };
    }
    throw e;
  }
}

function checkIssues(parts: Record<string, SubPath[]>, kerf: number, roofType: RoofType): Issue[] {
  const area = host.context('workArea');
  const found = host.check({ parts: Object.entries(parts).map(([key, subs]) => ({ key, subs })), kerf, ...(area ? { workArea: area } : {}) });
  // Hip/pyramid roof triangles & trapezoids have natural 45°–55° outer corners that checkGeom's ray check
  // flags as thin webs/web-cut; keep all checks active on walls, openings, joints, roof trusses & rails, and check-too-big.
  const isAngledRoofPanel = (k: string) =>
    (roofType === 'hip' || roofType === 'pyramid') &&
    k.startsWith('roof-') &&
    !k.startsWith('roof-truss') &&
    !k.startsWith('roof-rail');
  return found
    .filter((f) => f.level !== 'info' && !((f.code === 'check-web' || f.code === 'check-web-cut') && f.parts.length === 1 && isAngledRoofPanel(f.parts[0])))
    .map((f) => ({ level: f.level as 'error' | 'warn', code: f.code, ...(f.values ? { values: f.values } : {}) }));
}

function fitsArea(parts: Part[]): boolean {
  const area = host.context('workArea');
  if (!area) return true;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const p of parts)
    for (const s of p.subs)
      for (const n of s.nodes) {
        x0 = Math.min(x0, n.x + p.at.x);
        x1 = Math.max(x1, n.x + p.at.x);
        y0 = Math.min(y0, n.y + p.at.y);
        y1 = Math.max(y1, n.y + p.at.y);
      }
  const w = x1 - x0,
    h = y1 - y0;
  return (w <= area.width && h <= area.height) || (h <= area.width && w <= area.height);
}

/** Build the surface context for draw / onSurface / onEvent */
function surfaceCtx(p: P): HouseSurfaceCtx | null {
  const pl = planOf(p);
  const { d } = dims(p);
  const openings = readOpenings(p.openings);
  if (!pl || !d || !openings) return null;
  const m = buildModel(pl.layout, pl.w, pl.d, pl.lim);
  const box = m.box;
  const db: HouseDims = box
    ? { ...d, W: box.size[0] + 2 * d.t, D: box.size[1] + 2 * d.t, sides: box.sides }
    : d;
  const subModel = box ? box.model : { w: pl.w, d: pl.d, walls: [], issues: [] };
  const hosts = houseWallHosts(subModel, db);
  const innerWalls = wallPanels(subModel, db).map((q) => ({
    id: box?.src.get(q.it.wall.id) ?? q.it.wall.id,
    key: q.key,
    axis: q.it.wall.axis,
    pos: q.it.wall.pos,
    s: q.s,
    e: q.e,
    h: q.h,
  }));
  const isShaped = !!(box && !isRect(box.pts));
  const outerPoly3D = isShaped && box ? outlineOuterPoly3D(box.model, db.W, db.D, db.t) : null;
  return {
    plan: pl,
    W: db.W,
    D: db.D,
    H: db.H,
    t: db.t,
    floor: db.floor,
    roof: db.roof,
    openings,
    hosts,
    engraveFrames: db.engraveFrames,
    frameWidth: db.frameWidth,
    mullionWidth: db.mullionWidth,
    midFloorZ: db.midFloor ? db.midFloorHeight : undefined,
    isShaped,
    outerPoly3D,
    innerWalls,
  };
}

/** Cache last built parts for preview highlighting on pointer moves */
type Marked = { keys: string[]; walls: BuiltHouse['walls']; d: HouseDims; src: Map<number, number>; part: Map<number, string> };
let marked: { key: string; built: Marked | null } | null = null;
function builtFor(p: P): Marked | null {
  const key = JSON.stringify(p);
  if (marked?.key !== key) {
    const c = compute(p);
    marked = {
      key,
      built: c.built && c.box && c.d ? { keys: Object.keys(c.built.parts), walls: c.built.walls, d: c.d, src: c.box.src, part: partOf(c.built, c.box) } : null,
    };
  }
  return marked.built;
}

function partOf(built: BuiltHouse, box: NonNullable<Model['box']>): Map<number, string> {
  const out = new Map<number, string>();
  const src = (id: number) => box.src.get(id) ?? id;
  for (const b of built.boards) {
    for (const e of b.edges) out.set(box.edgeWall[e.k], b.key);
    for (const q of b.members) out.set(src(q.it.wall.id), b.key);
  }
  if (!built.boards.length && isRect(box.pts)) box.edgeWall.forEach((id, k) => out.set(id, RECT_KEYS[k]));
  for (const q of built.walls) if (!out.has(src(q.it.wall.id))) out.set(src(q.it.wall.id), q.key);
  return out;
}

function highlightPart(p: P, ctx: HouseSurfaceCtx, s: { view: string; state: unknown; selected: Record<string, number> }): NonNullable<Drawing['highlight']> {
  const b = builtFor(p);
  if (!b) return [];

  if (s.view !== 'plan') {
    const selOpId = selectedOpeningId(ctx, s);
    const op = selOpId !== undefined ? ctx.openings.find((o) => o.id === selOpId) : undefined;
    const wk = op?.wall ?? activeWallKey(ctx, s);
    const part = wk ? b.keys.indexOf(wk) : -1;
    return part >= 0 ? [{ part }] : [];
  }

  const id = planSelectedId(ctx.plan, s);
  if (id === undefined) return [];
  const key = b.part.get(id);
  const part = key ? b.keys.indexOf(key) : -1;
  if (part < 0) return [];
  const out: NonNullable<Drawing['highlight']> = [{ part }];
  const floor = b.keys.indexOf('floor');
  const panel = b.walls.find((q) => q.key === key);
  if (floor < 0 || !panel) return out;
  const { t, W, D, clearance } = b.d;
  const w = panel.it.wall;
  const ht = (t + clearance) / 2;
  const subs: SubPath[] = floorSpans(panel, b.d).map((sp) => {
    const c = (sp.a + sp.b) / 2,
      hl = (sp.width + clearance) / 2;
    const corners: [number, number][] = [[c - hl, -ht], [c + hl, -ht], [c + hl, ht], [c - hl, ht]];
    return {
      closed: true,
      nodes: corners.map(([a, sv]) =>
        w.axis === 'h' ? { x: a + t - W / 2, y: w.pos + t - D / 2 + sv } : { x: w.pos + t - W / 2 + sv, y: a + t - D / 2 },
      ),
    };
  });
  if (subs.length) out.push({ part: floor, subs });
  return out;
}

/** Width, depth, or height changed: ask whether inner walls & openings scale proportionally or keep mm sizes */
function resized(key: string, old: unknown, p: P) {
  if ((key !== 'width' && key !== 'depth' && key !== 'height') || typeof old !== 'number') return null;
  const t = p.thickness;
  const oW = key === 'width' ? old : p.width;
  const oD = key === 'depth' ? old : p.depth;
  const oH = key === 'height' ? old : p.height;
  const nW = p.width;
  const nD = p.depth;
  const nH = p.height;
  const ow = oW - 2 * t,
    od = oD - 2 * t,
    nw = nW - 2 * t,
    nd = nD - 2 * t;
  const changedPlan = Math.abs(ow - nw) >= 1e-9 || Math.abs(od - nd) >= 1e-9;
  const changedH = Math.abs(oH - nH) >= 1e-9;
  if (!(ow > 0 && od > 0 && nw > 0 && nd > 0 && oH > 0 && nH > 0) || (!changedPlan && !changedH)) return null;

  const l = layoutOf(p, ow, od);
  const m = l && buildModel(l, ow, od, limits(t));
  const hasWalls = !!(changedPlan && l && m && !(m.box && isRect(m.box.pts) && !m.box.model.walls.length));
  const ops = readOpenings(p.openings) ?? [];
  if (!hasWalls && !ops.length) return null;

  const innerAxes = new Map<number, 'h' | 'v'>();
  if (m?.box) {
    for (const wi of m.box.model.walls) {
      innerAxes.set(wi.wall.id, wi.wall.axis);
      const srcId = m.box.src.get(wi.wall.id);
      if (srcId !== undefined) innerAxes.set(srcId, wi.wall.axis);
    }
  }

  const scaledPatch: Record<string, string> = {};
  const keptPatch: Record<string, string> = {};
  if (hasWalls && l) {
    const walls = current(l, ow, od);
    Object.assign(scaledPatch, writeLayout({ ref: [nw, nd], walls: scaleLayout({ ref: [ow, od], walls }, nw, nd) }));
    Object.assign(keptPatch, writeLayout({ ref: [nw, nd], walls: keepWalls(walls, ow, od, nw, nd) }));
  }
  if (ops.length) {
    scaledPatch.openings = writeOpenings(scaleOpenings(ops, oW, oD, nW, nD, oH, nH, innerAxes, !!p.floor, t));
  }
  return {
    ask: {
      question: { code: 'ask.resize' },
      options: [
        { label: { code: 'ask.scale' }, patch: scaledPatch },
        { label: { code: 'ask.keep' }, patch: keptPatch },
      ],
    },
  };
}

function sideToggled(side: Side, p: P) {
  const t = p.thickness;
  const w = p.width - 2 * t,
    d = p.depth - 2 * t;
  const l = w > 0 && d > 0 ? layoutOf(p, w, d) : null;
  if (!l) return null;
  const on = sidesOf(p)[side];
  const before = buildModel({ ...l, sides: { ...sidesOf(p), [side]: !on } }, w, d, limits(t));
  if (!before.box) return null;
  const [x0, y0, x1, y1] = bbox(before.box.pts);
  const axis = side === 'x0' || side === 'x1' ? 'v' : 'h';
  const pos = { x0, x1, y0, y1 }[side];
  const walls = current(l, w, d);
  const onSide = (q: Wall) => q.axis === axis && Math.abs(q.pos - pos) < EPS;
  const set = (q: Wall): Wall => ({ id: q.id, axis: q.axis, pos: q.pos, from: q.from, to: q.to, ...(on ? {} : { open: true }) });
  let next: Wall[];
  if (walls.some(onSide)) next = walls.map((q) => (onSide(q) ? set(q) : q));
  else if (on) next = [...walls, { id: walls.reduce((m, q) => Math.max(m, q.id), 0) + 1, axis, pos, from: axis === 'v' ? y0 : x0, to: axis === 'v' ? y1 : x1 }];
  else return null;
  const stored = writeLayout({ ref: [w, d], walls: mergeWalls(next) });
  return { patch: { walls: stored.walls, wallsRef: stored.wallsRef } };
}

definePlugin<P>({
  onChange({ key, old, params }): Change | null {
    if (key === 'width' || key === 'depth' || key === 'height') return resized(key, old, params);
    if (key in SIDE_KEYS) return sideToggled(SIDE_KEYS[key], params);
    // Keep roof angle & height in sync when switching roofSizeMode
    if (key === 'roofSizeMode' && typeof old === 'string') {
      const prevSpec = { ...roofOf(params), sizeMode: old as RoofSizeMode };
      const rm = computeRoofMetrics(params.width, params.depth, params.height, params.thickness, prevSpec);
      if (params.roofSizeMode === 'height') return { patch: { roofHeight: Math.max(5, Math.round(rm.rise * 10) / 10) } };
      if (params.roofSizeMode === 'angle') return { patch: { roofAngle: Math.max(5, Math.min(75, Math.round(rm.pitchDeg * 10) / 10)) } };
    }
    if (key === 'fromMaterial' && params.fromMaterial) {
      const m = fromMaterial();
      if (!m) return null;
      return {
        patch: {
          thickness: m.thickness,
          ...(m.kerf != null ? { kerf: m.kerf } : {}),
          ...(m.clearance != null ? { clearance: m.clearance } : {}),
        },
      };
    }
    return null;
  },

  view(p) {
    const l = readLayout(p.walls, p.wallsRef);
    const ops = readOpenings(p.openings) ?? [];
    const opRows = ops.map((o): Text => {
      if (o.wall === 'front' || o.wall === 'back' || o.wall === 'left' || o.wall === 'right') {
        return { code: `op.row.${o.wall}`, values: { id: o.id } };
      }
      const m = /^wall-(\d+)$/.exec(o.wall);
      return { code: 'op.row.inner', values: { id: o.id, wall: m ? Number(m[1]) : 0 } };
    });
    return {
      rows: {
        walls: (l?.walls ?? []).map((w): Text => ({ code: `row.${w.open ? 'open.' : ''}${w.axis}`, values: { id: w.id } })),
        openings: opRows,
      },
    };
  },

  onEvent({ action, params, row, surface }): EventResult | null {
    const ctx = surfaceCtx(params);
    const ops = readOpenings(params.openings) ?? [];

    if (action === 'addDoor' || action === 'addWindow') {
      if (!ctx) return null;
      const target =
        (surface ? activeWallKey(ctx, surface) : null) ??
        (['front', 'back', 'left', 'right'].find((k) => ctx.hosts.has(k)) ?? [...ctx.hosts.keys()][0]);
      const hostWall = target ? ctx.hosts.get(target) : undefined;
      if (!hostWall) return { message: { code: 'elev.wall-off' } };
      const added = findOpeningSpot(hostWall, ops, action === 'addDoor' ? 'door' : 'window', ctx.t, ctx.mullionWidth, ctx.midFloorZ);
      if (!added) return { message: { code: 'opening-no-space' } };
      const next = [...ops, added];
      const targetView = added.wall.startsWith('wall-') ? 'inner' : added.wall;
      return {
        patch: { openings: writeOpenings(next) },
        select: { openings: next.length - 1 },
        ...(surface ? { view: targetView, state: { selId: added.id } } : {}),
      };
    }

    if (action === 'presetClassic' || action === 'presetModern' || action === 'presetCottage') {
      const W = ctx ? ctx.W : params.width;
      const D = ctx ? ctx.D : params.depth;
      const H = ctx ? ctx.H : params.height;
      const t = ctx ? ctx.t : params.thickness;
      const mw = ctx ? ctx.mullionWidth : Math.max(1, Number(params.mullionWidth) || 2);
      const midZ = params.midFloor ? Number(params.midFloorHeight) || 50 : undefined;
      const preset =
        action === 'presetModern'
          ? modernFacadePreset(W, D, H, t, !!params.floor, ctx?.hosts, mw, midZ)
          : action === 'presetCottage'
            ? cottageFacadePreset(W, D, H, t, !!params.floor, ctx?.hosts, ctx?.roof ?? roofOf(params), mw, midZ)
            : classicFacadePreset(W, D, H, t, !!params.floor, ctx?.hosts, mw, midZ);
      return {
        patch: { openings: writeOpenings(preset) },
        select: { openings: preset.length ? 0 : -1 },
      };
    }

    if (action === 'clearOpenings') {
      return {
        patch: { openings: '[]' },
        select: { openings: -1 },
        ...(surface ? { state: null } : {}),
      };
    }

    if (action === 'nextWall' && row !== undefined && row >= 0 && row < ops.length && ctx) {
      const cur = ops[row];
      const available = ['front', 'right', 'back', 'left', ...ctx.innerWalls.map((w) => w.key)].filter((k) => ctx.hosts.has(k));
      if (!available.length) return null;
      const idx = available.indexOf(cur.wall);
      const nextWall = available[(idx + 1) % available.length];
      const nextHost = ctx.hosts.get(nextWall)!;
      const web = Math.max(2, ctx.t);
      const w = Math.min(cur.w, Math.max(6, nextHost.width - nextHost.marginLeft - nextHost.marginRight - 2 * web));
      const x = Math.max(nextHost.marginLeft + web + w / 2, Math.min(nextHost.width - nextHost.marginRight - web - w / 2, cur.x));
      const next = ops.map((o, i) => (i === row ? { ...o, wall: nextWall, x: Math.round(x * 100) / 100, w: Math.round(w * 100) / 100 } : o));
      return {
        patch: { openings: writeOpenings(next) },
        select: { openings: row },
        ...(surface
          ? {
              view: nextWall.startsWith('wall-') ? 'inner' : nextWall,
              state: nextWall.startsWith('wall-') ? { selId: cur.id, wallKey: nextWall } : { selId: cur.id },
            }
          : {}),
      };
    }

    if (action === 'centerOpening' && row !== undefined && row >= 0 && row < ops.length && ctx) {
      const cur = ops[row];
      const hostWall = ctx.hosts.get(cur.wall);
      if (!hostWall) return null;
      const cx = Math.round((hostWall.width / 2) * 100) / 100;
      const next = ops.map((o, i) => (i === row ? { ...o, x: cx } : o));
      return { patch: { openings: writeOpenings(next) }, select: { openings: row } };
    }

    if (action === 'mirrorOpening' && row !== undefined && row >= 0 && row < ops.length && ctx) {
      const cur = ops[row];
      const hostWall = ctx.hosts.get(cur.wall);
      if (!hostWall) return null;
      const mx = Math.round((hostWall.width - cur.x) * 100) / 100;
      const next = ops.map((o, i) => (i === row ? { ...o, x: mx } : o));
      return { patch: { openings: writeOpenings(next) }, select: { openings: row } };
    }

    if (action === 'duplicateOpening' && row !== undefined && row >= 0 && row < ops.length && ctx) {
      const cur = ops[row];
      const hostWall = ctx.hosts.get(cur.wall);
      if (!hostWall) return { message: { code: 'elev.wall-off' } };
      const dup = duplicateOpeningOnWall(cur, hostWall, ops, ctx.t, ctx.mullionWidth, ctx.midFloorZ);
      if (!dup) return { message: { code: 'opening-no-space' } };
      const next = [...ops, dup];
      return {
        patch: { openings: writeOpenings(next) },
        select: { openings: next.length - 1 },
        ...(surface
          ? {
              view: dup.wall.startsWith('wall-') ? 'inner' : dup.wall,
              state: dup.wall.startsWith('wall-') ? { selId: dup.id, wallKey: dup.wall } : { selId: dup.id },
            }
          : {}),
      };
    }

    return null;
  },

  draw({ params, ...s }) {
    const ctx = surfaceCtx(params);
    if (!ctx) return { frame: { x0: 0, y0: 0, x1: 100, y1: 40 }, items: [{ type: 'text', x: 4, y: 20, text: { code: 'walls-bad' }, style: 'warn' }] };
    return { ...houseDraw(ctx, s), highlight: highlightPart(params, ctx, s) };
  },

  onSurface({ event, surface, params }) {
    const ctx = surfaceCtx(params);
    return ctx ? housePointer(ctx, event, surface) : null;
  },

  validate(p) {
    const c = compute(p);
    if (!c.built || !c.d) return c.issues;
    return [...c.issues, ...checkIssues(c.built.parts, c.d.kerf, c.d.roof.type)];
  },

  generate(p) {
    const c = compute(p);
    if (!c.built || !c.box || !c.d) throw new Error(c.issues.find((i) => i.level === 'error')?.code ?? 'walls-bad');

    const kerfed = withKerf(c.built.parts, c.d.kerf);
    const turnedKeys = [...TURNED_OVER, ...c.built.boards.filter(boardTurned).map((b) => b.key)];
    const { parts, marks } = turnOver(kerfed, c.built.marks, turnedKeys);
    const keys = Object.keys(parts);
    const at = host.nest({ parts: keys.map((key) => ({ key, subs: parts[key] })), gap: Math.max(3, 2 * c.d.kerf + 2) });
    const out: Part[] = keys.map((key, i) => ({
      key,
      subs: parts[key],
      at: { x: at[i][0], y: at[i][1] },
      ...(marks[key]?.length ? { marks: marks[key] } : {}),
    }));

    const labels: Record<string, Text> = {};
    for (const w of c.built.walls) labels[w.key] = { code: 'part.wall', values: { id: c.box.src.get(w.it.wall.id) ?? w.it.wall.id } };
    for (const b of c.built.boards) labels[b.key] = { code: 'part.wall', values: { id: Math.min(...b.edges.map((e) => c.box!.edgeWall[e.k])) } };
    for (const key of keys) {
      const fm = /^frame-(\d+)$/.exec(key);
      if (fm) labels[key] = { code: 'part.frame', values: { id: Number(fm[1]) } };
      const rmNum = /^roof-(\d+)$/.exec(key);
      if (rmNum) labels[key] = { code: 'part.roof-n', values: { id: Number(rmNum[1]) } };
      const rmSide = /^roof-(front|back|left|right)-(\d+)$/.exec(key);
      if (rmSide) labels[key] = [{ code: `part.roof-${rmSide[1]}` }, ` ${rmSide[2]}`];
      const rtNum = /^roof-truss-(\d+)$/.exec(key);
      if (rtNum && Number(rtNum[1]) > 3) labels[key] = { code: 'part.roof-truss-n', values: { id: Number(rtNum[1]) } };
      const rrNum = /^roof-rail-(\d+)$/.exec(key);
      if (rrNum && Number(rrNum[1]) > 2) labels[key] = { code: 'part.roof-rail-n', values: { id: Number(rrNum[1]) } };
    }

    const outerPoly3D = isRect(c.box.pts) ? null : outlineOuterPoly3D(c.box.model, c.d.W, c.d.D, c.d.t);
    const rm = computeRoofMetrics(c.d.W, c.d.D, c.d.H, c.d.t, c.d.roof, outerPoly3D);
    const doors = c.openings.filter((o) => o.kind === 'door').length;
    const windows = c.openings.filter((o) => o.kind === 'window').length;

    const info: [Text, Text][] = [
      ['info.size', `${mm(c.d.W)} × ${mm(c.d.D)} × ${mm(rm.totalHeight)} mm`],
      ['info.roof', c.d.roof.type === 'flat' ? { code: 'roofType.flat' } : [{ code: `roofType.${c.d.roof.type}` }, ` · ${mm(rm.rise)} mm (${mm(Math.round(rm.pitchDeg * 10) / 10)}°)`]],
      ['info.openings', { code: 'info.openings.val', values: { doors, windows } }],
    ];
    if (c.built.walls.length) info.push(['info.walls', String(c.built.walls.length)]);
    if (c.material) info.push(['info.material', `${c.material} · ${mm(c.d.t)} mm`]);

    const spread = fitsArea(out) ? {} : { distribute: { rotate: false } };
    return {
      parts: out,
      info,
      labels,
      poses: { poses: housePoses(c.built, c.d, keys) },
      ...spread,
    };
  },
});
