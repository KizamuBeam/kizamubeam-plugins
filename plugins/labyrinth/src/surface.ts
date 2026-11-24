// Interactive plan editor for the Labyrinth / Tilt Maze plugin, modeled directly on
// box-composer-advanced/src/surface.ts with two complementary views:
// - 'walls': box-composer-advanced style wall editor (select stretches, Shift multi-select, drag to move,
//            drag end handles to extend/shorten, Ctrl target/draw, double-click across, right-click & Delete,
//            draggable Start/Goal handles, right-column numeric fields, live preview highlight).
// - 'carve': rapid direct sketching view (click/drag edges to paint/erase walls, drag across cells to carve corridors).
import { mm, polygon, type Drawing, type EventResult, type Item, type Pointer, type Style, type SubPath, type Surface, type Text } from '../../../sdk/ts';
import {
  acrossOpen,
  addWall,
  carveBetween,
  deleteRuns,
  getEdge,
  joinRuns,
  moveGroups,
  moveRuns,
  rayAcross,
  stretchAt,
  stretchEnd,
  subtractRun,
  toggleEdge,
  wallJunctions,
  type EditResult,
  type Group,
  type Run,
} from './edit';
import {
  analyzeMaze,
  autoSignature,
  clampEndpoints,
  createGrid,
  defaultEndpoints,
  generateMazeGrid,
  gridToWalls,
  isIslandWall,
  wallsToGrid,
  writeEndpoints,
  writeWalls,
} from './maze';
import { cornerHoleCenters } from './geometry';
import {
  cellCenterInner,
  isOuterWall,
  wallLineCenterInner,
  wallSpanInner,
  type Axis,
  type Endpoints,
  type MazeAlgorithm,
  type MazeDims,
  type MazeGrid,
  type Wall,
} from './types';

export interface MazePlan {
  d: MazeDims;
  walls: Wall[];
  endpoints: Endpoints;
  algorithm: MazeAlgorithm;
  seed: number;
  braid: number;
  autoEndpoints: boolean;
  showSolution: boolean;
}

const LIST = 'walls';
const r1 = (v: number) => Math.round(v * 10) / 10;

interface Sel extends Group {
  more?: Group[];
}

interface Aim {
  axis: Axis;
  pos: number;
  along: number;
  side: -1 | 1;
}

interface Drag {
  kind: 'move' | 'end' | 'draw' | 'start' | 'goal' | 'paint' | 'carve';
  id?: number;
  sel?: Sel;
  aim?: Aim;
  axis?: Axis;
  which?: 'from' | 'to';
  /** Paint mode: true = add walls, false = remove walls */
  paintSolid?: boolean;
  /** Carve mode: last visited cell [c, r] */
  lastCell?: [number, number];
  /** Draw mode: starting grid intersection [c, r] */
  gx0?: number;
  gy0?: number;
  base: Wall[];
  baseEp: Endpoints;
  x0: number;
  y0: number;
}

interface State {
  walls?: Wall[];
  endpoints?: Endpoints;
  drag?: Drag;
  draft?: [number, number, number, number];
  sel?: Sel;
  at?: { id: number; along: number };
  aim?: Aim;
  free?: [number, number];
}

const stateOf = (s: unknown): State => (s && typeof s === 'object' ? (s as State) : {});
const groupsOf = (s: Sel): Group[] => [{ axis: s.axis, pos: s.pos, runs: s.runs }, ...(s.more ?? [])];
const selOf = (gs: Group[]): Sel => ({ ...gs[0], ...(gs.length > 1 ? { more: gs.slice(1) } : {}) });
const onLine = (w: Wall, g: Group) => !w.open && w.axis === g.axis && w.pos === g.pos;
const runsFor = (s: Sel, w: Wall): Run[] => groupsOf(s).find((g) => onLine(w, g))?.runs ?? [];
const touches = (w: Wall, s: Sel) => runsFor(s, w).some(([a, b]) => Math.min(b, w.to) > Math.max(a, w.from));
const whole = (w: Wall): Sel => ({ axis: w.axis, pos: w.pos, runs: [[w.from, w.to]] });
const covers = (runs: Run[], r: Run) => runs.some(([a, b]) => a <= r[0] && b >= r[1]);

const idAt = (p: MazePlan, row: number | undefined) => (row !== undefined && row >= 0 ? p.walls[row]?.id : undefined);
export const selectedWallId = (p: MazePlan, s: Surface) => {
  const st = stateOf(s.state);
  if (st.at?.id !== undefined) return st.at.id;
  return idAt(p, s.selected[LIST]);
};

function selection(st: State, walls: Wall[], id: number | undefined): Sel | undefined {
  const s = st.sel;
  if (s && walls.some((w) => touches(w, s))) return s;
  const x = walls.find((w) => w.id === id && !w.open);
  return x ? whole(x) : undefined;
}

const wallAt = (walls: Wall[], s: Sel, along: number) =>
  walls.find((w) => onLine(w, s) && w.from <= along + 0.01 && w.to >= along - 0.01);

/** Convert inner mm coordinate to cell index */
function mmToCell(x: number, y: number, d: MazeDims): [number, number] {
  const c = Math.max(0, Math.min(d.cols - 1, Math.floor((x + d.wallW / 2) / d.pitch)));
  const r = Math.max(0, Math.min(d.rows - 1, Math.floor((y + d.wallW / 2) / d.pitch)));
  return [c, r];
}

/** Convert inner mm coordinate to nearest grid intersection [c, r] in [0..cols] x [0..rows] */
function mmToNode(x: number, y: number, d: MazeDims): [number, number] {
  const c = Math.max(0, Math.min(d.cols, Math.round((x + d.wallW / 2) / d.pitch)));
  const r = Math.max(0, Math.min(d.rows, Math.round((y + d.wallW / 2) / d.pitch)));
  return [c, r];
}

/** Inner mm coordinates of grid intersection (c, r) */
function nodeInner(c: number, r: number, d: MazeDims): [number, number] {
  const x = c <= 0 ? -d.wallW / 2 : c >= d.cols ? d.innerW + d.wallW / 2 : c * d.pitch - d.wallW / 2;
  const y = r <= 0 ? -d.wallW / 2 : r >= d.rows ? d.innerH + d.wallW / 2 : r * d.pitch - d.wallW / 2;
  return [x, y];
}

/** Rectangle polygon points in inner mm space */
const rectPts = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [
  [r1(x0), r1(y0)],
  [r1(x1), r1(y0)],
  [r1(x1), r1(y1)],
  [r1(x0), r1(y1)],
];

/** Visual rectangle [x0, y0, x1, y1] in inner mm for a wall run on grid line `pos` from `from` to `to` */
function wallRectInner(axis: Axis, pos: number, from: number, to: number, d: MazeDims): [number, number, number, number] {
  const count = axis === 'h' ? d.rows : d.cols;
  const alongCount = axis === 'h' ? d.cols : d.rows;
  const outer = pos === 0 || pos === count;
  const halfT = outer ? d.border / 2 : d.wallW / 2;
  const cAcross = wallLineCenterInner(pos, count, d);
  const [a0, a1] = wallSpanInner(from, to, alongCount, d);
  return axis === 'h'
    ? [a0, cAcross - halfT, a1, cAcross + halfT]
    : [cAcross - halfT, a0, cAcross + halfT, a1];
}

/** Find nearest grid wall edge (interior or outer) to pointer (x, y) in inner mm */
function nearestEdge(x: number, y: number, d: MazeDims): { axis: Axis; pos: number; idx: number; dist: number } | null {
  if (x < -d.border - 2 || x > d.innerW + d.border + 2 || y < -d.border - 2 || y > d.innerH + d.border + 2) return null;

  let best: { axis: Axis; pos: number; idx: number; dist: number } | null = null;

  // Candidate horizontal line
  const rLine = Math.max(0, Math.min(d.rows, Math.round((y + d.wallW / 2) / d.pitch)));
  const cIdx = Math.max(0, Math.min(d.cols - 1, Math.floor((x + d.wallW / 2) / d.pitch)));
  const yLine = wallLineCenterInner(rLine, d.rows, d);
  const cx = cIdx * d.pitch + d.ch / 2;
  const dH = Math.hypot(Math.max(0, Math.abs(x - cx) - d.ch / 2), y - yLine);
  best = { axis: 'h', pos: rLine, idx: cIdx, dist: dH };

  // Candidate vertical line
  const cLine = Math.max(0, Math.min(d.cols, Math.round((x + d.wallW / 2) / d.pitch)));
  const rIdx = Math.max(0, Math.min(d.rows - 1, Math.floor((y + d.wallW / 2) / d.pitch)));
  const xLine = wallLineCenterInner(cLine, d.cols, d);
  const cy = rIdx * d.pitch + d.ch / 2;
  const dV = Math.hypot(x - xLine, Math.max(0, Math.abs(y - cy) - d.ch / 2));
  if (dV < best.dist) best = { axis: 'v', pos: cLine, idx: rIdx, dist: dV };

  return best;
}

/** Find Ctrl target on any solid wall (interior or outer) near (x, y) */
function aimFor(p: MazePlan, g: MazeGrid, x: number, y: number): Aim | null {
  const { d } = p;
  if (x < -d.border - 2 || x > d.innerW + d.border + 2 || y < -d.border - 2 || y > d.innerH + d.border + 2) return null;
  const maxDist = Math.max(d.wallW * 1.8, d.pitch * 0.42);

  let best: { axis: Axis; pos: number; idx: number; dist: number } | null = null;

  // Candidate horizontal solid wall
  const rLine = Math.max(0, Math.min(d.rows, Math.round((y + d.wallW / 2) / d.pitch)));
  const cIdx = Math.max(0, Math.min(d.cols - 1, Math.floor((x + d.wallW / 2) / d.pitch)));
  const yLine = wallLineCenterInner(rLine, d.rows, d);
  for (const ci of [cIdx, cIdx - 1, cIdx + 1]) {
    if (ci < 0 || ci >= d.cols || !getEdge(g, 'h', rLine, ci)) continue;
    const cx = ci * d.pitch + d.ch / 2;
    const dist = Math.hypot(Math.max(0, Math.abs(x - cx) - (d.ch / 2 + d.wallW / 2)), y - yLine);
    if (dist <= maxDist && (!best || dist < best.dist)) best = { axis: 'h', pos: rLine, idx: ci, dist };
  }

  // Candidate vertical solid wall
  const cLine = Math.max(0, Math.min(d.cols, Math.round((x + d.wallW / 2) / d.pitch)));
  const rIdx = Math.max(0, Math.min(d.rows - 1, Math.floor((y + d.wallW / 2) / d.pitch)));
  const xLine = wallLineCenterInner(cLine, d.cols, d);
  for (const ri of [rIdx, rIdx - 1, rIdx + 1]) {
    if (ri < 0 || ri >= d.rows || !getEdge(g, 'v', cLine, ri)) continue;
    const cy = ri * d.pitch + d.ch / 2;
    const dist = Math.hypot(x - xLine, Math.max(0, Math.abs(y - cy) - (d.ch / 2 + d.wallW / 2)));
    if (dist <= maxDist && (!best || dist < best.dist)) best = { axis: 'v', pos: cLine, idx: ri, dist };
  }

  if (!best) return null;

  const [nx, ny] = mmToNode(x, y, d);
  const along = best.axis === 'h' ? nx : ny;
  const maxAlong = best.axis === 'h' ? d.cols : d.rows;
  // Must launch a perpendicular interior wall, so `along` must be strictly inside [1..maxAlong-1]
  const clampedAlong = Math.max(1, Math.min(maxAlong - 1, along));
  const cAcross = wallLineCenterInner(best.pos, best.axis === 'h' ? d.rows : d.cols, d);
  const acrossVal = best.axis === 'h' ? y : x;
  let side: -1 | 1 = acrossVal >= cAcross ? 1 : -1;
  if (best.pos === 0) side = 1;
  else if (best.pos === (best.axis === 'h' ? d.rows : d.cols)) side = -1;
  return { axis: best.axis, pos: best.pos, along: clampedAlong, side };
}

/** Draw clickable toolbar pills along the top edge of the surface (modeled on house-composer) */
interface Pill {
  id: string;
  label: Text;
  style: Style;
}

function drawToolbar(items: Item[], pills: Pill[], x0: number, x1: number, yMid: number, pillH: number): void {
  if (!pills.length) return;
  const totalSpan = x1 - x0;
  const gap = Math.max(2, pillH * 0.25);
  const pillW = Math.max(18, (totalSpan - (pills.length - 1) * gap) / pills.length);
  const rowW = pills.length * pillW + (pills.length - 1) * gap;
  const startX = (x0 + x1) / 2 - rowW / 2;
  const y0 = yMid - pillH / 2;
  const y1 = yMid + pillH / 2;

  pills.forEach((pill, i) => {
    const px0 = startX + i * (pillW + gap);
    const px1 = px0 + pillW;
    items.push(
      {
        type: 'line',
        pts: rectPts(px0, y0, px1, y1),
        closed: true,
        style: pill.style,
        width: pill.style === 'accent' ? 1.8 : 1.2,
        id: pill.id,
      },
      {
        type: 'line',
        pts: [[r1(px0 + 1), r1(yMid)], [r1(px1 - 1), r1(yMid)]],
        style: pill.style,
        width: 1,
        alpha: 0.01,
        id: pill.id,
      },
      {
        type: 'text',
        x: r1((px0 + px1) / 2),
        y: r1(yMid),
        text: pill.label,
        style: pill.style,
        align: 'center',
      },
    );
  });
}

/** Draw a 5-pointed star icon on the surface */
function starPts(cx: number, cy: number, R: number, r: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = i % 2 === 0 ? R : r;
    pts.push([r1(cx + rad * Math.cos(a)), r1(cy + rad * Math.sin(a))]);
  }
  return pts;
}

/** Draw a circle polygon on the surface */
function circlePts(cx: number, cy: number, r: number, segs = 20): [number, number][] {
  return Array.from({ length: segs }, (_, i): [number, number] => {
    const a = (i * 2 * Math.PI) / segs;
    return [r1(cx + r * Math.cos(a)), r1(cy + r * Math.sin(a))];
  });
}

/** Right-column numeric fields for the selected wall or endpoints */
function planFields(p: MazePlan, walls: Wall[], ep: Endpoints, selId: number | undefined): NonNullable<Drawing['fields']> {
  const { d } = p;
  const x = walls.find((w) => w.id === selId && !w.open);
  if (x) {
    const maxPos = (x.axis === 'h' ? d.rows : d.cols) - 1;
    const maxAlong = x.axis === 'h' ? d.cols : d.rows;
    return [
      { id: 'w.pos', label: { code: `field.pos.${x.axis}` }, value: x.pos, min: 1, max: Math.max(1, maxPos) },
      { id: 'w.from', label: { code: 'field.from' }, value: x.from, min: 0, max: Math.max(0, x.to - 1) },
      { id: 'w.to', label: { code: 'field.to' }, value: x.to, min: Math.min(maxAlong, x.from + 1), max: maxAlong },
      { id: 'w.len', label: { code: 'field.len' }, value: x.to - x.from, min: 1, max: maxAlong - x.from },
    ];
  }
  return [
    { id: 'ep.sx', label: { code: 'field.startCol' }, value: ep.sx + 1, min: 1, max: d.cols },
    { id: 'ep.sy', label: { code: 'field.startRow' }, value: ep.sy + 1, min: 1, max: d.rows },
    { id: 'ep.gx', label: { code: 'field.goalCol' }, value: ep.gx + 1, min: 1, max: d.cols },
    { id: 'ep.gy', label: { code: 'field.goalRow' }, value: ep.gy + 1, min: 1, max: d.rows },
  ];
}

/** Live preview highlight for the selected wall (on maze-1, part index 1) */
export function wallHighlight(p: MazePlan, s: Surface): NonNullable<Drawing['highlight']> {
  const id = selectedWallId(p, s);
  if (id === undefined) return [];
  const w = p.walls.find((q) => q.id === id && !q.open);
  if (!w) return [];
  const { d } = p;
  const [x0, y0, x1, y1] = wallRectInner(w.axis, w.pos, w.from, w.to, d);
  const ox = d.border - d.totalW / 2;
  const oy = d.border - d.totalH / 2;
  const sub: SubPath = polygon([
    [x0 + ox, y0 + oy],
    [x1 + ox, y0 + oy],
    [x1 + ox, y1 + oy],
    [x0 + ox, y1 + oy],
  ]);
  // Part 0 = base, Part 1 = maze-1
  return [{ part: 1, subs: [sub] }];
}

/** Build the Drawing returned to KizamuBeam's interactive dialog surface */
export function planDraw(p: MazePlan, s: Surface & { have: string[]; size?: { width: number; height: number } }): Drawing {
  const { d } = p;
  const st = stateOf(s.state);
  const walls = st.walls ?? p.walls;
  const ep = st.endpoints ?? p.endpoints;
  const g = wallsToGrid(walls, d.cols, d.rows);
  const analysis = analyzeMaze(g, ep);
  const isCarve = s.view === 'carve';

  const pad = Math.max(6, d.border * 0.7);
  const sw = s.size?.width || 560;
  const sh = s.size?.height || 480;
  const boardSpanX = d.totalW + 2 * pad;
  const pillH = Math.max(8, Math.min(18, boardSpanX * 0.065));
  const tbY = -d.border - pillH * 0.85 - 2;
  const frame = {
    x0: -d.border - pad,
    y0: tbY - pillH * 0.75,
    x1: d.innerW + d.border + pad,
    y1: d.innerH + d.border + pad,
  };
  const k = Math.min((0.92 * sw) / (frame.x1 - frame.x0), (0.9 * sh) / (frame.y1 - frame.y0));
  const px = (n: number) => n / k;

  const items: Item[] = [];

  // 1. Top clickable toolbar pills
  drawToolbar(
    items,
    [
      { id: 'tb.generate', label: { code: 'tb.generate' }, style: 'normal' },
      { id: 'tb.seed', label: { code: 'tb.seed' }, style: 'normal' },
      { id: 'tb.empty', label: { code: 'tb.empty' }, style: 'normal' },
      { id: 'tb.full', label: { code: 'tb.full' }, style: 'normal' },
      { id: 'tb.path', label: { code: 'tb.path' }, style: p.showSolution ? 'accent' : 'muted' },
    ],
    -d.border,
    d.innerW + d.border,
    tbY,
    pillH,
  );

  // 2. Outer board silhouette & corner holes
  items.push({
    type: 'line',
    pts: rectPts(-d.border, -d.border, d.innerW + d.border, d.innerH + d.border),
    closed: true,
    style: 'muted',
    width: 1,
    alpha: 0.65,
  });

  if (d.cornerHoles !== 'none') {
    const ox = d.totalW / 2 - d.border;
    const oy = d.totalH / 2 - d.border;
    for (const [cx, cy] of cornerHoleCenters(d)) {
      items.push({
        type: 'line',
        pts: circlePts(cx + ox, cy + oy, d.holeDia / 2, 16),
        closed: true,
        style: 'muted',
        width: 1,
        alpha: 0.7,
      });
    }
  }

  // 3. Faint dashed grid slots for all empty interior wall positions (clickable in carve mode & right-clickable in walls mode)
  for (let r = 1; r < d.rows; r++) {
    const y = wallLineCenterInner(r, d.rows, d);
    for (let c = 0; c < d.cols; c++) {
      if (g.h[r][c]) continue;
      const x0 = c * d.pitch;
      const x1 = x0 + d.ch;
      items.push({
        type: 'line',
        pts: [[r1(x0), r1(y)], [r1(x1), r1(y)]],
        style: 'muted',
        width: isCarve ? 1.4 : 0.8,
        dash: true,
        alpha: isCarve ? 0.55 : 0.3,
        id: `slot.h.${r}.${c}`,
      });
    }
  }
  for (let c = 1; c < d.cols; c++) {
    const x = wallLineCenterInner(c, d.cols, d);
    for (let r = 0; r < d.rows; r++) {
      if (g.v[c][r]) continue;
      const y0 = r * d.pitch;
      const y1 = y0 + d.ch;
      items.push({
        type: 'line',
        pts: [[r1(x), r1(y0)], [r1(x), r1(y1)]],
        style: 'muted',
        width: isCarve ? 1.4 : 0.8,
        dash: true,
        alpha: isCarve ? 0.55 : 0.3,
        id: `slot.v.${c}.${r}`,
      });
    }
  }

  // 4. Outer border wall segments (solid or dashed when opened as an entry/exit gate)
  const drawOuterSide = (axis: Axis, pos: number) => {
    const maxIdx = axis === 'h' ? d.cols : d.rows;
    for (let i = 0; i < maxIdx; i++) {
      const solid = getEdge(g, axis, pos, i);
      const [x0, y0, x1, y1] = wallRectInner(axis, pos, i, i + 1, d);
      items.push({
        type: 'line',
        pts: rectPts(x0, y0, x1, y1),
        closed: true,
        style: solid ? 'normal' : 'muted',
        width: solid ? 1.4 : 1,
        ...(solid ? {} : { dash: true, alpha: 0.5 }),
        id: `outer.${axis}.${pos}.${i}`,
      });
    }
  };
  drawOuterSide('h', 0);
  drawOuterSide('h', d.rows);
  drawOuterSide('v', 0);
  drawOuterSide('v', d.cols);

  // 5. Shortest solution path overlay (if solvable & enabled)
  if (p.showSolution && analysis.solvable && analysis.solutionPath.length >= 2) {
    const pts = analysis.solutionPath.map(([c, r]): [number, number] => {
      const [cx, cy] = cellCenterInner(c, r, d);
      return [r1(cx), r1(cy)];
    });
    items.push({
      type: 'line',
      pts,
      style: 'accent',
      width: 2,
      dash: true,
      alpha: 0.65,
    });
  }

  // 6. Interior walls (exact physical thickness, selection highlights, island warnings, handles)
  const selId = st.drag?.kind === 'move' || st.drag?.kind === 'end' ? st.at?.id ?? st.drag.id : idAt(p, s.selected[LIST]);
  const pick = isCarve ? undefined : selection(st, walls, selId);
  const picked = (w: Wall) => (pick ? touches(w, pick) : !isCarve && w.id === selId);

  const interiorWalls = walls.filter((w) => !w.open && !isOuterWall(w.axis, w.pos, d.cols, d.rows));
  const order = [...interiorWalls].sort((a, b) => Number(a.id === selId) - Number(b.id === selId));

  for (const w of order) {
    const island = isIslandWall(w, analysis, d.cols, d.rows);
    const isSel = picked(w) || (!isCarve && w.id === selId);
    const style: Style = isSel ? 'accent' : island ? 'warn' : 'normal';
    const pale = isSel && pick && runsFor(pick, w).some(([a, b]) => a > w.from || b < w.to);
    const [x0, y0, x1, y1] = wallRectInner(w.axis, w.pos, w.from, w.to, d);

    items.push({
      type: 'line',
      pts: rectPts(x0, y0, x1, y1),
      closed: true,
      style,
      width: isSel ? 2 : 1.4,
      id: `w${w.id}`,
      ...(pale ? { alpha: 0.45 } : {}),
    });

    // Centerline for easy hitting
    const cAcross = wallLineCenterInner(w.pos, w.axis === 'h' ? d.rows : d.cols, d);
    const [a0, a1] = wallSpanInner(w.from, w.to, w.axis === 'h' ? d.cols : d.rows, d);
    items.push({
      type: 'line',
      pts: w.axis === 'h' ? [[r1(a0), r1(cAcross)], [r1(a1), r1(cAcross)]] : [[r1(cAcross), r1(a0)], [r1(cAcross), r1(a1)]],
      style,
      width: 1,
      alpha: 0.35,
      id: `w${w.id}`,
    });

    // Endpoint handles in 'walls' view (just like box-composer-advanced!)
    if (!isCarve) {
      const [fx, fy] = w.axis === 'h' ? nodeInner(w.from, w.pos, d) : nodeInner(w.pos, w.from, d);
      const [tx, ty] = w.axis === 'h' ? nodeInner(w.to, w.pos, d) : nodeInner(w.pos, w.to, d);
      const hSize = isSel ? 4 : 2.5;
      items.push(
        { type: 'handle', x: r1(fx), y: r1(fy), id: `e${w.id}.from`, style, size: hSize },
        { type: 'handle', x: r1(tx), y: r1(ty), id: `e${w.id}.to`, style, size: hSize },
      );
    }

    // Junction diamond marks (just like box-composer-advanced!)
    if (!isCarve) {
      for (const j of wallJunctions(g, w)) {
        const [jx, jy] = w.axis === 'h' ? nodeInner(j, w.pos, d) : nodeInner(w.pos, j, d);
        const r = d.wallW * 0.65;
        items.push({
          type: 'line',
          closed: true,
          style: 'accent',
          alpha: 0.45,
          width: 1,
          pts: [[r1(jx - r), r1(jy)], [r1(jx), r1(jy - r)], [r1(jx + r), r1(jy)], [r1(jx), r1(jy + r)]],
        });
      }
    }
  }

  // 7. Highlight selected stretches with strong outline + center grip handle + dimension bubble
  if (pick && !isCarve) {
    for (const w of interiorWalls.filter((q) => touches(q, pick))) {
      for (const [a0, b0] of runsFor(pick, w)) {
        const a = Math.max(a0, w.from);
        const b = Math.min(b0, w.to);
        if (b <= a) continue;
        const [x0, y0, x1, y1] = wallRectInner(w.axis, w.pos, a, b, d);
        items.push({
          type: 'line',
          pts: rectPts(x0 - 0.35, y0 - 0.35, x1 + 0.35, y1 + 0.35),
          closed: true,
          style: 'accent',
          width: 2.4,
          id: `w${w.id}`,
        });
        const mx = (x0 + x1) / 2;
        const my = (y0 + y1) / 2;
        items.push({ type: 'handle', x: r1(mx), y: r1(my), id: `w${w.id}`, style: 'accent', size: 4.5 });
      }
    }

    const selX = interiorWalls.find((q) => q.id === selId);
    if (selX) {
      const [x0, y0, x1, y1] = wallRectInner(selX.axis, selX.pos, selX.from, selX.to, d);
      const cells = selX.to - selX.from;
      const lenMm = selX.axis === 'h' ? x1 - x0 : y1 - y0;
      const label = `#${selX.id} · ${cells} (${mm(lenMm)} mm)`;
      if (selX.axis === 'h') {
        items.push({
          type: 'text',
          x: r1((x0 + x1) / 2),
          y: r1(y0 - px(10)),
          text: label,
          style: 'accent',
          align: 'center',
          bubble: true,
        });
      } else {
        items.push({
          type: 'text',
          x: r1(x1 + px(11)),
          y: r1((y0 + y1) / 2),
          text: label,
          style: 'accent',
          align: 'center',
          angle: 90,
          bubble: true,
        });
      }
    }
  }

  // 8. Ctrl target preview (exact box-composer-advanced style!)
  if (st.aim && !st.drag && !isCarve) {
    const aimAxis: Axis = st.aim.axis === 'h' ? 'v' : 'h';
    const [r0, r1g] = rayAcross(g, aimAxis, st.aim.along, st.aim.pos, st.aim.side);
    const [cx, cy] = st.aim.axis === 'h' ? nodeInner(st.aim.along, st.aim.pos, d) : nodeInner(st.aim.pos, st.aim.along, d);
    const rad = Math.max(d.wallW * 1.4, px(8));
    items.push(
      { type: 'line', pts: circlePts(cx, cy, rad, 20), closed: true, style: 'accent', width: 1.5 },
      { type: 'line', pts: [[r1(cx - 1.5 * rad), r1(cy)], [r1(cx + 1.5 * rad), r1(cy)]], style: 'accent', width: 1 },
      { type: 'line', pts: [[r1(cx), r1(cy - 1.5 * rad)], [r1(cx), r1(cy + 1.5 * rad)]], style: 'accent', width: 1 },
      { type: 'text', x: r1(cx + rad), y: r1(cy - rad), text: { code: 'plan.start' }, style: 'accent' },
    );
    if (r1g > r0) {
      const [p0x, p0y] = aimAxis === 'h' ? nodeInner(r0, st.aim.along, d) : nodeInner(st.aim.along, r0, d);
      const [p1x, p1y] = aimAxis === 'h' ? nodeInner(r1g, st.aim.along, d) : nodeInner(st.aim.along, r1g, d);
      items.push({ type: 'line', pts: [[r1(p0x), r1(p0y)], [r1(p1x), r1(p1y)]], style: 'accent', dash: true, width: 1.8 });
    }
  }

  // Ctrl free intersection crosshair
  if (st.free && !st.drag && !isCarve) {
    const [fx, fy] = st.free;
    const rad = Math.max(d.wallW * 1.2, px(7));
    items.push(
      { type: 'line', pts: [[r1(fx - rad), r1(fy)], [r1(fx + rad), r1(fy)]], style: 'accent', width: 1.5 },
      { type: 'line', pts: [[r1(fx), r1(fy - rad)], [r1(fx), r1(fy + rad)]], style: 'accent', width: 1.5 },
    );
  }

  // Draft rejected line
  if (st.draft) {
    const [dx0, dy0, dx1, dy1] = st.draft;
    items.push({ type: 'line', pts: [[r1(dx0), r1(dy0)], [r1(dx1), r1(dy1)]], style: 'warn', dash: true, width: 1.6 });
  }

  // 9. Start (Dot) & Goal (Star) markers with draggable handles
  const [sx, sy] = cellCenterInner(ep.sx, ep.sy, d);
  const [gx, gy] = cellCenterInner(ep.gx, ep.gy, d);
  const mr = Math.min(d.ch * 0.34, 6);
  const epStyle: Style = analysis.solvable ? 'accent' : 'warn';

  items.push(
    { type: 'line', pts: circlePts(sx, sy, mr, 18), closed: true, style: epStyle, width: 1.8, id: 'marker.start' },
    { type: 'line', pts: circlePts(sx, sy, mr * 0.45, 14), closed: true, style: epStyle, width: 1.5, id: 'marker.start' },
    { type: 'handle', x: r1(sx), y: r1(sy), id: 'marker.start', style: epStyle, size: 4 },
  );

  items.push(
    { type: 'line', pts: starPts(gx, gy, mr * 1.15, mr * 0.48), closed: true, style: epStyle, width: 1.8, id: 'marker.goal' },
    { type: 'handle', x: r1(gx), y: r1(gy), id: 'marker.goal', style: epStyle, size: 4 },
  );

  // Unsolvable banner at the bottom of the board
  if (!analysis.solvable) {
    items.push({
      type: 'text',
      x: r1(d.innerW / 2),
      y: r1(d.innerH + d.border + pad * 0.45),
      text: { code: 'plan.unsolvable' },
      style: 'warn',
      align: 'center',
      bubble: true,
    });
  }

  const fields = st.drag ? [] : planFields(p, walls, ep, isCarve ? undefined : selId);

  return {
    frame,
    items,
    track: !isCarve,
    cursor: isCarve ? 'crosshair' : st.aim || st.free ? 'default' : undefined,
    escape: !!(pick || st.aim || st.free || st.drag),
    fields,
  };
}

/** Format a live status message after an edit or selection */
function statusMessage(p: MazePlan, walls: Wall[], ep: Endpoints, selId?: number): Text {
  const { d } = p;
  const g = wallsToGrid(walls, d.cols, d.rows);
  const analysis = analyzeMaze(g, ep);
  const w = selId !== undefined ? walls.find((q) => q.id === selId) : undefined;
  if (w && !w.open) {
    const cells = w.to - w.from;
    const lenMm = cells * d.ch + (cells + 1) * d.wallW;
    return {
      code: `plan.info.${w.axis}`,
      values: { id: w.id, pos: w.pos, from: w.from, to: w.to, cells, len: Math.round(lenMm * 10) / 10 },
    };
  }
  if (!analysis.solvable) return { code: 'plan.status.blocked' };
  if (analysis.islandCount > 0) {
    return { code: 'plan.status.islands', values: { steps: analysis.solutionSteps, islands: analysis.islandCount } };
  }
  return { code: 'plan.status.ok', values: { steps: analysis.solutionSteps, walls: walls.filter((q) => !q.open).length } };
}

/** Commit edited walls / endpoints into plugin parameters */
function commitCustom(
  p: MazePlan,
  walls: Wall[],
  ep: Endpoints,
  selId?: number,
  state?: State | null,
): EventResult {
  const row = selId === undefined ? -1 : walls.findIndex((q) => q.id === selId);
  return {
    patch: {
      walls: writeWalls(walls),
      wallMode: 'custom',
      wallsRef: `custom:${p.d.cols}x${p.d.rows}`,
      endpoints: writeEndpoints(ep),
    },
    state: state ?? null,
    select: { [LIST]: row },
    message: statusMessage(p, walls, ep, selId),
  };
}

/** Handle clickable top toolbar pills */
function handleToolbar(p: MazePlan, hit: string): EventResult | null {
  const { d } = p;
  if (hit === 'tb.generate' || hit === 'tb.seed') {
    const nextSeed = hit === 'tb.seed' ? (p.seed >= 99999 ? 1 : p.seed + 1) : p.seed;
    const g = generateMazeGrid(d.cols, d.rows, p.algorithm, nextSeed, p.braid);
    const walls = gridToWalls(g);
    const ep = defaultEndpoints(g, p.autoEndpoints);
    return {
      patch: {
        seed: nextSeed,
        walls: writeWalls(walls),
        wallMode: 'auto',
        wallsRef: autoSignature(d.cols, d.rows, p.algorithm, nextSeed, p.braid),
        endpoints: writeEndpoints(ep),
      },
      state: null,
      select: { [LIST]: -1 },
      message: statusMessage(p, walls, ep),
    };
  }
  if (hit === 'tb.empty') {
    const g = createGrid(d.cols, d.rows, false);
    const walls = gridToWalls(g);
    return commitCustom(p, walls, p.endpoints, undefined, null);
  }
  if (hit === 'tb.full') {
    const g = createGrid(d.cols, d.rows, true);
    const walls = gridToWalls(g);
    return commitCustom(p, walls, p.endpoints, undefined, null);
  }
  if (hit === 'tb.path') {
    return { patch: { showSolution: !p.showSolution } };
  }
  return null;
}

const refusal = (r: Extract<EditResult, { ok: false }>): Text => ({ code: r.code, ...(r.values ? { values: r.values } : {}) });

/** Main pointer & keyboard handler for both 'walls' and 'carve' views */
export function planPointer(p: MazePlan, ev: Pointer, s: Surface): EventResult | null {
  const { d } = p;
  const st = stateOf(s.state);
  const base = p.walls;
  const baseEp = p.endpoints;
  const isCarve = s.view === 'carve';

  // List row selection synced with canvas
  if (ev.type === 'select') {
    const w = base.find((q) => q.id === idAt(p, ev.row));
    return {
      state: w && !w.open ? { sel: whole(w), at: { id: w.id, along: (w.from + w.to) / 2 } } : null,
      message: statusMessage(p, base, baseEp, w?.id),
    };
  }

  // Right-column numeric field committed
  if (ev.type === 'field' && ev.value !== undefined && !st.drag) {
    const v = Math.round(ev.value);
    if (ev.field?.startsWith('ep.')) {
      const nextEp = { ...baseEp };
      if (ev.field === 'ep.sx') nextEp.sx = v - 1;
      else if (ev.field === 'ep.sy') nextEp.sy = v - 1;
      else if (ev.field === 'ep.gx') nextEp.gx = v - 1;
      else if (ev.field === 'ep.gy') nextEp.gy = v - 1;
      const clamped = clampEndpoints(nextEp, d.cols, d.rows);
      return {
        patch: { endpoints: writeEndpoints(clamped) },
        message: statusMessage(p, base, clamped),
      };
    }
    const selId = selectedWallId(p, s);
    const x = base.find((q) => q.id === selId && !q.open);
    if (!x) return null;
    if (ev.field === 'w.pos') {
      const r = moveRuns(base, d.cols, d.rows, x.axis, x.pos, [[x.from, x.to]], v);
      if (!r.ok) return { message: refusal(r) };
      const moved = r.walls.find((q) => !q.open && q.axis === x.axis && q.pos === (r.pos ?? v) && Math.min(q.to, x.to) > Math.max(q.from, x.from));
      return commitCustom(p, r.walls, baseEp, moved?.id ?? x.id, moved ? { sel: whole(moved), at: { id: moved.id, along: (moved.from + moved.to) / 2 } } : null);
    }
    if (ev.field === 'w.from' || ev.field === 'w.to' || ev.field === 'w.len') {
      const which = ev.field === 'w.from' ? 'from' : 'to';
      const target = ev.field === 'w.len' ? x.from + Math.max(1, v) : v;
      const r = stretchEnd(base, d.cols, d.rows, x.id, which, target);
      if (!r.ok) return { message: refusal(r) };
      const kept = r.walls.find((q) => q.id === x.id) ?? r.walls.find((q) => !q.open && q.axis === x.axis && q.pos === x.pos);
      return commitCustom(p, r.walls, baseEp, kept?.id, kept ? { sel: whole(kept), at: { id: kept.id, along: (kept.from + kept.to) / 2 } } : null);
    }
    return null;
  }

  // Keyboard shortcuts: Escape & Delete/Backspace
  if (ev.type === 'key' && ev.key === 'Escape') {
    return { state: null, select: { [LIST]: -1 }, message: '' };
  }
  if (ev.type === 'key' && (ev.key === 'Delete' || ev.key === 'Backspace')) {
    const sel = selection(st, base, idAt(p, s.selected[LIST]));
    if (!sel) {
      // If an open outer gate row is selected in the list, toggle it back closed
      const w = base.find((q) => q.id === idAt(p, s.selected[LIST]));
      if (w?.open) {
        const r = deleteRuns(base, d.cols, d.rows, w.axis, w.pos, [[w.from, w.to]]);
        return r.ok ? commitCustom(p, r.walls, baseEp, undefined, null) : { message: refusal(r) };
      }
      return null;
    }
    let cur = base;
    for (const gr of groupsOf(sel)) {
      const r = deleteRuns(cur, d.cols, d.rows, gr.axis, gr.pos, gr.runs);
      if (!r.ok) return { message: refusal(r) };
      cur = r.walls;
    }
    return commitCustom(p, cur, baseEp, undefined, null);
  }

  // Pointer down
  if (ev.type === 'down') {
    // 1. Toolbar pills
    if (ev.hit?.startsWith('tb.')) {
      return handleToolbar(p, ev.hit);
    }

    // 2. Start or Goal marker drag (works in BOTH views!)
    if (ev.hit === 'marker.start' || ev.hit === 'marker.goal') {
      const kind = ev.hit === 'marker.start' ? 'start' : 'goal';
      return {
        state: { drag: { kind, base, baseEp, x0: ev.x, y0: ev.y }, endpoints: baseEp },
        select: { [LIST]: -1 },
      };
    }

    // 3. 'carve' view: click/drag on edge paints/erases walls; drag inside cells carves passages!
    if (isCarve) {
      const ne = nearestEdge(ev.x, ev.y, d);
      const edgeHitTol = Math.max(d.wallW * 1.1, d.pitch * 0.28);
      if (ne && ne.dist <= edgeHitTol) {
        const g = wallsToGrid(base, d.cols, d.rows);
        const curSolid = getEdge(g, ne.axis, ne.pos, ne.idx);
        const paintSolid = !curSolid;
        const r = toggleEdge(base, d.cols, d.rows, ne.axis, ne.pos, ne.idx, paintSolid);
        const nextWalls = r.ok ? r.walls : base;
        return {
          state: {
            drag: { kind: 'paint', paintSolid, base, baseEp, x0: ev.x, y0: ev.y },
            walls: nextWalls,
          },
          select: { [LIST]: -1 },
          message: statusMessage(p, nextWalls, baseEp),
        };
      }
      // Inside a cell -> start corridor carving!
      if (ev.x >= 0 && ev.x <= d.innerW && ev.y >= 0 && ev.y <= d.innerH) {
        const cell = mmToCell(ev.x, ev.y, d);
        return {
          state: {
            drag: { kind: 'carve', lastCell: cell, base, baseEp, x0: ev.x, y0: ev.y },
            walls: base,
          },
          select: { [LIST]: -1 },
        };
      }
      return null;
    }

    // 4. 'walls' view (box-composer-advanced interactions!)
    const g = wallsToGrid(base, d.cols, d.rows);
    const endMatch = /^e(\d+)\.(from|to)$/.exec(ev.hit ?? '');
    const wallMatch = /^w(\d+)$/.exec(ev.hit ?? '');

    // Ctrl: draw new wall from wall target or free grid intersection
    if (ev.ctrl && !ev.shift) {
      const aim = aimFor(p, g, ev.x, ev.y);
      if (aim) {
        const [gx0, gy0] = aim.axis === 'h' ? [aim.along, aim.pos] : [aim.pos, aim.along];
        const axis: Axis = aim.axis === 'h' ? 'v' : 'h';
        return {
          state: { drag: { kind: 'draw', base, baseEp, x0: ev.x, y0: ev.y, gx0, gy0, axis, aim }, aim },
        };
      }
      if (ev.x >= 0 && ev.x <= d.innerW && ev.y >= 0 && ev.y <= d.innerH) {
        const [gx0, gy0] = mmToNode(ev.x, ev.y, d);
        return {
          state: { drag: { kind: 'draw', base, baseEp, x0: ev.x, y0: ev.y, gx0, gy0 } },
        };
      }
    }

    // Endpoint handle drag -> extend/shorten wall
    if (endMatch) {
      const id = Number(endMatch[1]);
      const which = endMatch[2] as 'from' | 'to';
      const w = base.find((q) => q.id === id && !q.open);
      if (w) {
        const row = base.findIndex((q) => q.id === id);
        return {
          state: { drag: { kind: 'end', id, which, base, baseEp, x0: ev.x, y0: ev.y }, sel: whole(w), at: { id, along: which === 'from' ? w.from : w.to } },
          select: { [LIST]: row },
          message: statusMessage(p, base, baseEp, id),
        };
      }
    }

    // Wall click -> select stretch (Shift multi-select, Ctrl+Shift whole wall) & start move drag
    if (wallMatch) {
      const id = Number(wallMatch[1]);
      const w = base.find((q) => q.id === id && !q.open);
      if (w) {
        const row = base.findIndex((q) => q.id === id);
        const alongRaw = ((w.axis === 'h' ? ev.x : ev.y) + d.wallW / 2) / d.pitch;
        const along = Math.max(w.from, Math.min(w.to, alongRaw));
        const run = stretchAt(g, w, along);
        const old = selection(st, base, idAt(p, s.selected[LIST]));
        const gs = old ? groupsOf(old) : [];
        const i = gs.findIndex((gr) => onLine(w, gr));
        const first = (k: number) => selOf([gs[k], ...gs.filter((_, j) => j !== k)]);

        let sel: Sel;
        if (ev.ctrl && ev.shift) {
          sel = whole(w);
        } else if (ev.shift && old) {
          if (i < 0) gs.push({ axis: w.axis, pos: w.pos, runs: [run] });
          else {
            const runs = covers(gs[i].runs, run) ? subtractRun(gs[i].runs, run) : joinRuns([...gs[i].runs, run]);
            if (runs.length) gs[i] = { ...gs[i], runs };
            else gs.splice(i, 1);
          }
          if (!gs.length) return { state: null, select: { [LIST]: -1 }, message: '' };
          const k = gs.findIndex((gr) => onLine(w, gr));
          sel = first(k < 0 ? 0 : k);
        } else {
          sel = i >= 0 && covers(gs[i].runs, run) ? first(i) : { axis: w.axis, pos: w.pos, runs: [run] };
        }

        return {
          state: { drag: { kind: 'move', id, sel, base, baseEp, x0: ev.x, y0: ev.y }, sel, at: { id, along } },
          select: { [LIST]: row },
          message: statusMessage(p, base, baseEp, id),
        };
      }
    }

    // Clicking empty space clears selection
    return { state: null, select: { [LIST]: -1 }, message: '' };
  }

  // Hover move without drag (Ctrl aim preview in 'walls' view)
  if (ev.type === 'move' && !st.drag) {
    if (isCarve) return null;
    const ctrl = !!ev.ctrl && !ev.shift;
    const g = wallsToGrid(base, d.cols, d.rows);
    const aim = ctrl ? aimFor(p, g, ev.x, ev.y) : null;
    let free: [number, number] | null = null;
    if (ctrl && !aim && ev.x >= 0 && ev.x <= d.innerW && ev.y >= 0 && ev.y <= d.innerH) {
      const [nc, nr] = mmToNode(ev.x, ev.y, d);
      free = nodeInner(nc, nr, d);
    }
    if (JSON.stringify([aim, free]) === JSON.stringify([st.aim ?? null, st.free ?? null])) return null;
    const rest: State = { ...st };
    delete rest.aim;
    delete rest.free;
    const next: State = { ...rest, ...(aim ? { aim } : {}), ...(free ? { free } : {}) };
    return { state: Object.keys(next).length ? next : null };
  }

  // Active drag move
  if (ev.type === 'move' && st.drag) {
    const dr = st.drag;

    // Start / Goal drag
    if (dr.kind === 'start' || dr.kind === 'goal') {
      const [c, r] = mmToCell(ev.x, ev.y, d);
      const nextEp = dr.kind === 'start' ? { ...dr.baseEp, sx: c, sy: r } : { ...dr.baseEp, gx: c, gy: r };
      if (nextEp.sx === nextEp.gx && nextEp.sy === nextEp.gy) return null;
      return {
        state: { drag: dr, endpoints: nextEp },
        message: statusMessage(p, dr.base, nextEp),
      };
    }

    // Carve view: edge painting
    if (dr.kind === 'paint') {
      const ne = nearestEdge(ev.x, ev.y, d);
      const tol = Math.max(d.wallW * 1.2, d.pitch * 0.3);
      if (!ne || ne.dist > tol) return null;
      const cur = st.walls ?? dr.base;
      const r = toggleEdge(cur, d.cols, d.rows, ne.axis, ne.pos, ne.idx, dr.paintSolid);
      if (!r.ok || r.walls === cur) return null;
      return {
        state: { drag: dr, walls: r.walls },
        message: statusMessage(p, r.walls, dr.baseEp),
      };
    }

    // Carve view: corridor carving across cells
    if (dr.kind === 'carve') {
      if (ev.x < 0 || ev.x > d.innerW || ev.y < 0 || ev.y > d.innerH) return null;
      const [c, r] = mmToCell(ev.x, ev.y, d);
      const prev = dr.lastCell ?? [c, r];
      if (c === prev[0] && r === prev[1]) return null;
      let cur = st.walls ?? dr.base;
      let cc = prev[0];
      let cr = prev[1];
      // Step orthogonally (Manhattan) so fast drags never skip intermediate walls
      let guard = 0;
      while ((cc !== c || cr !== r) && guard++ < 64) {
        const dc = c - cc;
        const drr = r - cr;
        const nc = Math.abs(dc) >= Math.abs(drr) ? cc + Math.sign(dc) : cc;
        const nr = Math.abs(dc) >= Math.abs(drr) ? cr : cr + Math.sign(drr);
        const res = carveBetween(cur, d.cols, d.rows, cc, cr, nc, nr);
        if (res.ok) cur = res.walls;
        cc = nc;
        cr = nr;
      }
      const nextDrag: Drag = { ...dr, lastCell: [c, r] };
      return {
        state: { drag: nextDrag, walls: cur },
        message: statusMessage(p, cur, dr.baseEp),
      };
    }

    // Walls view: Ctrl+drag drawing a new straight wall
    if (dr.kind === 'draw' && dr.gx0 !== undefined && dr.gy0 !== undefined) {
      const [gx1, gy1] = mmToNode(ev.x, ev.y, d);
      const dx = gx1 - dr.gx0;
      const dy = gy1 - dr.gy0;
      if (dx === 0 && dy === 0) return null;
      const axis: Axis = dr.axis ?? (Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v');
      const pos = axis === 'h' ? dr.gy0 : dr.gx0;
      const a = axis === 'h' ? Math.min(dr.gx0, gx1) : Math.min(dr.gy0, gy1);
      const b = axis === 'h' ? Math.max(dr.gx0, gx1) : Math.max(dr.gy0, gy1);
      const r = addWall(dr.base, d.cols, d.rows, axis, pos, a, b);
      if (!r.ok) {
        const [p0x, p0y] = nodeInner(dr.gx0, dr.gy0, d);
        const [p1x, p1y] = axis === 'h' ? nodeInner(gx1, dr.gy0, d) : nodeInner(dr.gx0, gy1, d);
        return { state: { drag: dr, draft: [p0x, p0y, p1x, p1y] }, message: refusal(r) };
      }
      return {
        state: { drag: dr, walls: r.walls },
        message: statusMessage(p, r.walls, dr.baseEp),
      };
    }

    // Walls view: moving selected stretch(es) across grid lines
    if (dr.kind === 'move' && dr.sel) {
      const dCol = Math.round((ev.x - dr.x0) / d.pitch);
      const dRow = Math.round((ev.y - dr.y0) / d.pitch);
      if (dr.sel.more?.length) {
        const r = moveGroups(dr.base, d.cols, d.rows, groupsOf(dr.sel), dCol, dRow);
        if (!r.ok || !r.groups) return { state: st, message: r.ok ? '' : refusal(r) };
        const movedSel = selOf(r.groups);
        const along = (movedSel.runs[0][0] + movedSel.runs[0][1]) / 2;
        const id = wallAt(r.walls, movedSel, along)?.id;
        return {
          state: { drag: dr, walls: r.walls, sel: movedSel, ...(id !== undefined ? { at: { id, along } } : {}) },
          message: statusMessage(p, r.walls, dr.baseEp, id),
        };
      }
      const delta = dr.sel.axis === 'h' ? dRow : dCol;
      const to = dr.sel.pos + delta;
      const r = moveRuns(dr.base, d.cols, d.rows, dr.sel.axis, dr.sel.pos, dr.sel.runs, to);
      if (!r.ok) return { state: st, message: refusal(r) };
      const movedSel: Sel = { ...dr.sel, pos: r.pos ?? to };
      const along = (movedSel.runs[0][0] + movedSel.runs[0][1]) / 2;
      const id = wallAt(r.walls, movedSel, along)?.id;
      return {
        state: { drag: dr, walls: r.walls, sel: movedSel, ...(id !== undefined ? { at: { id, along } } : {}) },
        message: statusMessage(p, r.walls, dr.baseEp, id),
      };
    }

    // Walls view: stretching endpoint handle
    if (dr.kind === 'end' && dr.id !== undefined && dr.which) {
      const orig = dr.base.find((q) => q.id === dr.id);
      if (!orig) return null;
      const [nc, nr] = mmToNode(ev.x, ev.y, d);
      const target = orig.axis === 'h' ? nc : nr;
      const r = stretchEnd(dr.base, d.cols, d.rows, dr.id, dr.which, target);
      if (!r.ok) return { state: st, message: refusal(r) };
      const kept = r.walls.find((q) => q.id === dr.id) ?? r.walls.find((q) => !q.open && q.axis === orig.axis && q.pos === orig.pos);
      return {
        state: { drag: dr, walls: r.walls, ...(kept ? { sel: whole(kept), at: { id: kept.id, along: target } } : {}) },
        message: statusMessage(p, r.walls, dr.baseEp, kept?.id),
      };
    }
    return null;
  }

  // Pointer up -> commit drag into parameters
  if (ev.type === 'up' && st.drag) {
    const dr = st.drag;

    if (dr.kind === 'start' || dr.kind === 'goal') {
      const ep = st.endpoints ?? dr.baseEp;
      if (ep.sx === dr.baseEp.sx && ep.sy === dr.baseEp.sy && ep.gx === dr.baseEp.gx && ep.gy === dr.baseEp.gy) {
        return { state: null };
      }
      return {
        patch: { endpoints: writeEndpoints(ep) },
        state: null,
        message: statusMessage(p, dr.base, ep),
      };
    }

    // Ctrl+click on aim target (no drag movement) -> shoot wall across corridor!
    if (dr.kind === 'draw' && dr.aim && !st.walls && !st.draft) {
      const g = wallsToGrid(dr.base, d.cols, d.rows);
      const axis: Axis = dr.aim.axis === 'h' ? 'v' : 'h';
      const [from, to] = rayAcross(g, axis, dr.aim.along, dr.aim.pos, dr.aim.side);
      const r = addWall(dr.base, d.cols, d.rows, axis, dr.aim.along, from, to);
      if (!r.ok) return { state: null, message: refusal(r) };
      const added = r.walls.find((q) => !q.open && q.axis === axis && q.pos === dr.aim!.along && Math.min(q.to, to) > Math.max(q.from, from));
      return commitCustom(p, r.walls, dr.baseEp, added?.id, added ? { sel: whole(added), at: { id: added.id, along: (added.from + added.to) / 2 } } : null);
    }

    if (!st.walls || JSON.stringify(st.walls) === JSON.stringify(dr.base)) {
      const keep: State = { ...(st.sel ? { sel: st.sel } : {}), ...(st.at ? { at: st.at } : {}) };
      return { state: Object.keys(keep).length ? keep : null };
    }

    const selId = dr.kind === 'paint' || dr.kind === 'carve' ? undefined : st.at?.id ?? dr.id;
    const keepState: State | null =
      dr.kind === 'paint' || dr.kind === 'carve'
        ? null
        : st.sel
          ? { sel: st.sel, ...(st.at ? { at: st.at } : {}) }
          : null;
    return commitCustom(p, st.walls, dr.baseEp, selId, keepState);
  }

  // Double-click in 'walls' view: on a wall selects whole wall; in open space places wall across corridor
  if (ev.type === 'dblclick' && !isCarve) {
    const wallMatch = /^w(\d+)$/.exec(ev.hit ?? '');
    if (wallMatch) {
      const w = base.find((q) => q.id === Number(wallMatch[1]) && !q.open);
      if (w) {
        return {
          state: { sel: whole(w), at: { id: w.id, along: (w.from + w.to) / 2 } },
          select: { [LIST]: base.findIndex((q) => q.id === w.id) },
          message: statusMessage(p, base, baseEp, w.id),
        };
      }
    }
    if (!ev.hit || ev.hit.startsWith('slot.')) {
      const axis: Axis = ev.shift ? 'v' : 'h';
      const [nc, nr] = mmToNode(ev.x, ev.y, d);
      const pos = axis === 'h' ? Math.max(1, Math.min(d.rows - 1, nr)) : Math.max(1, Math.min(d.cols - 1, nc));
      const [cc, cr] = mmToCell(ev.x, ev.y, d);
      const g = wallsToGrid(base, d.cols, d.rows);
      const [from, to] = acrossOpen(g, axis, pos, axis === 'h' ? cc : cr);
      const r = addWall(base, d.cols, d.rows, axis, pos, from, to);
      if (!r.ok) return { message: refusal(r) };
      const added = r.walls.find((q) => !q.open && q.axis === axis && q.pos === pos && Math.min(q.to, to) > Math.max(q.from, from));
      return commitCustom(p, r.walls, baseEp, added?.id, added ? { sel: whole(added), at: { id: added.id, along: (added.from + added.to) / 2 } } : null);
    }
    return null;
  }

  // Right-click (context): remove stretch (on wall), toggle gate (on outer wall), add wall (on empty slot)
  if (ev.type === 'context') {
    const g = wallsToGrid(base, d.cols, d.rows);

    const endMatch = /^e(\d+)\.(from|to)$/.exec(ev.hit ?? '');
    if (endMatch) {
      const w = base.find((q) => q.id === Number(endMatch[1]) && !q.open);
      if (!w) return null;
      const r = deleteRuns(base, d.cols, d.rows, w.axis, w.pos, [[w.from, w.to]]);
      return r.ok ? commitCustom(p, r.walls, baseEp, undefined, null) : { message: refusal(r) };
    }

    const wallMatch = /^w(\d+)$/.exec(ev.hit ?? '');
    if (wallMatch) {
      const w = base.find((q) => q.id === Number(wallMatch[1]) && !q.open);
      if (!w) return null;
      const along = Math.max(w.from, Math.min(w.to, ((w.axis === 'h' ? ev.x : ev.y) + d.wallW / 2) / d.pitch));
      const run = stretchAt(g, w, along);
      const r = deleteRuns(base, d.cols, d.rows, w.axis, w.pos, [run]);
      return r.ok ? commitCustom(p, r.walls, baseEp, undefined, null) : { message: refusal(r) };
    }

    const outerMatch = /^outer\.(h|v)\.(\d+)\.(\d+)$/.exec(ev.hit ?? '');
    if (outerMatch) {
      const r = toggleEdge(base, d.cols, d.rows, outerMatch[1] as Axis, Number(outerMatch[2]), Number(outerMatch[3]));
      return r.ok ? commitCustom(p, r.walls, baseEp, undefined, null) : { message: refusal(r) };
    }

    const slotMatch = /^slot\.(h|v)\.(\d+)\.(\d+)$/.exec(ev.hit ?? '');
    if (slotMatch) {
      const r = toggleEdge(base, d.cols, d.rows, slotMatch[1] as Axis, Number(slotMatch[2]), Number(slotMatch[3]), true);
      return r.ok ? commitCustom(p, r.walls, baseEp, undefined, null) : { message: refusal(r) };
    }

    // Fallback: toggle nearest edge if close enough
    const ne = nearestEdge(ev.x, ev.y, d);
    if (ne && ne.dist <= Math.max(d.wallW * 1.4, d.pitch * 0.35)) {
      const r = toggleEdge(base, d.cols, d.rows, ne.axis, ne.pos, ne.idx);
      return r.ok ? commitCustom(p, r.walls, baseEp, undefined, null) : { message: refusal(r) };
    }
    return null;
  }

  return null;
}
