// Pure wall-editing operations for the interactive Labyrinth plan editor,
// modeled directly on box-composer-advanced/src/edit.ts.
// All wall coordinates live on integer grid lines so every edit snaps cleanly to maze geometry.
import { gridToWalls, normalizeWalls, wallsToGrid } from './maze';
import { isOuterWall, type Axis, type MazeGrid, type Wall } from './types';

export type Run = [number, number];

export interface Group {
  axis: Axis;
  pos: number;
  runs: Run[];
}

export type EditResult =
  | { ok: true; walls: Wall[]; pos?: number; groups?: Group[] }
  | { ok: false; code: string; values?: Record<string, number> };

/** Merge overlapping or adjacent runs on the same line */
export function joinRuns(runs: Run[]): Run[] {
  if (!runs.length) return [];
  const sorted = [...runs].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Run[] = [[sorted[0][0], sorted[0][1]]];
  for (let i = 1; i < sorted.length; i++) {
    const [a, b] = sorted[i];
    const last = out[out.length - 1];
    if (a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Subtract a single run from a list of runs */
export function subtractRun(runs: Run[], cut: Run): Run[] {
  const out: Run[] = [];
  for (const [a, b] of runs) {
    if (b <= cut[0] || a >= cut[1]) {
      out.push([a, b]);
    } else {
      if (a < cut[0]) out.push([a, cut[0]]);
      if (b > cut[1]) out.push([cut[1], b]);
    }
  }
  return out;
}

/**
 * Junction points (T-joints and crossings) along a wall `w` where perpendicular solid walls meet it.
 * Used to split a wall into selectable stretches (just like box-composer-advanced).
 */
export function wallJunctions(g: MazeGrid, w: Wall): number[] {
  const pts: number[] = [];
  const { cols, rows } = g;
  if (w.axis === 'h') {
    for (let c = w.from + 1; c < w.to; c++) {
      const up = w.pos > 0 && g.v[c][w.pos - 1];
      const down = w.pos < rows && g.v[c][w.pos];
      if (up || down) pts.push(c);
    }
  } else {
    for (let r = w.from + 1; r < w.to; r++) {
      const left = w.pos > 0 && g.h[r][w.pos - 1];
      const right = w.pos < cols && g.h[r][w.pos];
      if (left || right) pts.push(r);
    }
  }
  return pts;
}

/** All stretches of a wall between its ends and perpendicular junctions */
export function stretchesOf(g: MazeGrid, w: Wall): Run[] {
  const marks = [w.from, ...wallJunctions(g, w), w.to];
  const out: Run[] = [];
  for (let i = 0; i + 1 < marks.length; i++) {
    if (marks[i + 1] > marks[i]) out.push([marks[i], marks[i + 1]]);
  }
  return out;
}

/** The stretch of wall `w` that contains grid coordinate `along` */
export function stretchAt(g: MazeGrid, w: Wall, along: number): Run {
  const sts = stretchesOf(g, w);
  for (const [a, b] of sts) {
    if (along >= a - 1e-6 && along <= b + 1e-6) return [a, b];
  }
  return sts[0] ?? [w.from, w.to];
}

/** Does a wall exist on the grid for this segment? */
export function getEdge(g: MazeGrid, axis: Axis, pos: number, idx: number): boolean {
  if (axis === 'h') {
    if (pos < 0 || pos > g.rows || idx < 0 || idx >= g.cols) return false;
    return g.h[pos][idx];
  }
  if (pos < 0 || pos > g.cols || idx < 0 || idx >= g.rows) return false;
  return g.v[pos][idx];
}

/** Set a single grid wall segment to solid or open */
export function setEdge(g: MazeGrid, axis: Axis, pos: number, idx: number, solid: boolean): void {
  if (axis === 'h') {
    if (pos >= 0 && pos <= g.rows && idx >= 0 && idx < g.cols) g.h[pos][idx] = solid;
  } else {
    if (pos >= 0 && pos <= g.cols && idx >= 0 && idx < g.rows) g.v[pos][idx] = solid;
  }
}

/** Set a run [from, to) on a grid line to solid or open */
function setRun(g: MazeGrid, axis: Axis, pos: number, from: number, to: number, solid: boolean): void {
  const maxIdx = axis === 'h' ? g.cols : g.rows;
  const a = Math.max(0, Math.min(maxIdx, Math.round(from)));
  const b = Math.max(0, Math.min(maxIdx, Math.round(to)));
  for (let i = a; i < b; i++) setEdge(g, axis, pos, i, solid);
}

/**
 * Find the open span [from, to] along `axis` at grid line `pos`, starting at `along` (grid coordinate),
 * extending in both directions until hitting a perpendicular solid wall or the outer border.
 */
export function acrossOpen(g: MazeGrid, axis: Axis, pos: number, along: number): Run {
  const maxAlong = axis === 'h' ? g.cols : g.rows;
  const startCell = Math.max(0, Math.min(maxAlong - 1, Math.floor(along)));

  // Scan backward from startCell
  let from = startCell;
  while (from > 0) {
    const blocked =
      axis === 'h'
        ? (pos > 0 && g.v[from][pos - 1]) || (pos < g.rows && g.v[from][pos])
        : (pos > 0 && g.h[from][pos - 1]) || (pos < g.cols && g.h[from][pos]);
    if (blocked) break;
    from--;
  }

  // Scan forward from startCell + 1
  let to = startCell + 1;
  while (to < maxAlong) {
    const blocked =
      axis === 'h'
        ? (pos > 0 && g.v[to][pos - 1]) || (pos < g.rows && g.v[to][pos])
        : (pos > 0 && g.h[to][pos - 1]) || (pos < g.cols && g.h[to][pos]);
    if (blocked) break;
    to++;
  }

  return [from, to];
}

/**
 * Find the span from a starting grid junction `startAlong` in direction `side` (-1 or +1)
 * on perpendicular axis until hitting the next perpendicular solid wall (for Ctrl+Click target wall).
 */
export function rayAcross(g: MazeGrid, axis: Axis, pos: number, startAlong: number, side: -1 | 1): Run {
  const maxAlong = axis === 'h' ? g.cols : g.rows;
  if (side > 0) {
    let to = Math.min(maxAlong, startAlong + 1);
    while (to < maxAlong) {
      const hitPerp =
        axis === 'h'
          ? (pos > 0 && g.v[to][pos - 1]) || (pos < g.rows && g.v[to][pos])
          : (pos > 0 && g.h[to][pos - 1]) || (pos < g.cols && g.h[to][pos]);
      if (hitPerp) break;
      to++;
    }
    return [startAlong, to];
  } else {
    let from = Math.max(0, startAlong - 1);
    while (from > 0) {
      const hitPerp =
        axis === 'h'
          ? (pos > 0 && g.v[from][pos - 1]) || (pos < g.rows && g.v[from][pos])
          : (pos > 0 && g.h[from][pos - 1]) || (pos < g.cols && g.h[from][pos]);
      if (hitPerp) break;
      from--;
    }
    return [from, startAlong];
  }
}

/** Add a solid wall run on grid line `pos` from `from` to `to` */
export function addWall(walls: Wall[], cols: number, rows: number, axis: Axis, pos: number, from: number, to: number): EditResult {
  const maxPos = axis === 'h' ? rows : cols;
  const maxAlong = axis === 'h' ? cols : rows;
  const p = Math.round(pos);
  const a = Math.max(0, Math.min(maxAlong, Math.round(Math.min(from, to))));
  const b = Math.max(0, Math.min(maxAlong, Math.round(Math.max(from, to))));
  if (p < 0 || p > maxPos) return { ok: false, code: 'edit-outside' };
  if (b <= a) return { ok: false, code: 'edit-too-short' };

  const g = wallsToGrid(walls, cols, rows);
  let changed = false;
  for (let i = a; i < b; i++) {
    if (!getEdge(g, axis, p, i)) {
      setEdge(g, axis, p, i, true);
      changed = true;
    }
  }
  if (!changed) return { ok: false, code: 'add-on-wall' };
  return { ok: true, walls: normalizeWalls([...walls, { id: 0, axis, pos: p, from: a, to: b }], cols, rows) };
}

/**
 * Remove stretch(es) on grid line `pos`:
 * - On an interior line: opens passages (removes the wall segments).
 * - On an outer border line: toggles those segments between open (entry/exit gate) and closed!
 */
export function deleteRuns(walls: Wall[], cols: number, rows: number, axis: Axis, pos: number, runs: Run[]): EditResult {
  const maxPos = axis === 'h' ? rows : cols;
  const p = Math.round(pos);
  if (p < 0 || p > maxPos) return { ok: false, code: 'edit-outside' };
  const g = wallsToGrid(walls, cols, rows);
  const outer = isOuterWall(axis, p, cols, rows);
  let changed = false;

  for (const [r0, r1] of runs) {
    const a = Math.max(0, Math.min(axis === 'h' ? cols : rows, Math.round(Math.min(r0, r1))));
    const b = Math.max(0, Math.min(axis === 'h' ? cols : rows, Math.round(Math.max(r0, r1))));
    if (b <= a) continue;
    if (outer) {
      // If any segment is currently solid, open the stretch; if all are open, close it back!
      let anySolid = false;
      for (let i = a; i < b; i++) if (getEdge(g, axis, p, i)) anySolid = true;
      setRun(g, axis, p, a, b, !anySolid);
      changed = true;
    } else {
      for (let i = a; i < b; i++) {
        if (getEdge(g, axis, p, i)) {
          setEdge(g, axis, p, i, false);
          changed = true;
        }
      }
    }
  }
  if (!changed) return { ok: false, code: 'edit-no-wall' };
  return { ok: true, walls: preserveIds(walls, gridToWalls(g)) };
}

/** Move selected runs on an interior line `pos` to another interior line `targetPos` */
export function moveRuns(
  walls: Wall[],
  cols: number,
  rows: number,
  axis: Axis,
  pos: number,
  runs: Run[],
  targetPos: number,
): EditResult {
  const maxPos = axis === 'h' ? rows : cols;
  if (isOuterWall(axis, pos, cols, rows)) return { ok: false, code: 'edit-outer-fixed' };
  const to = Math.max(1, Math.min(maxPos - 1, Math.round(targetPos)));
  if (to === pos) return { ok: true, walls, pos };

  const g = wallsToGrid(walls, cols, rows);
  for (const [a, b] of runs) setRun(g, axis, pos, a, b, false);
  for (const [a, b] of runs) setRun(g, axis, to, a, b, true);
  return { ok: true, walls: preserveIds(walls, gridToWalls(g)), pos: to };
}

/** Move multiple selected wall groups together by (dCol, dRow) */
export function moveGroups(
  walls: Wall[],
  cols: number,
  rows: number,
  groups: Group[],
  dCol: number,
  dRow: number,
): EditResult {
  if (groups.some((gr) => isOuterWall(gr.axis, gr.pos, cols, rows))) {
    return { ok: false, code: 'edit-outer-fixed' };
  }
  const g = wallsToGrid(walls, cols, rows);
  const moved: Group[] = [];

  for (const gr of groups) {
    for (const [a, b] of gr.runs) setRun(g, gr.axis, gr.pos, a, b, false);
  }
  for (const gr of groups) {
    const maxPos = gr.axis === 'h' ? rows : cols;
    const delta = gr.axis === 'h' ? dRow : dCol;
    const to = Math.max(1, Math.min(maxPos - 1, Math.round(gr.pos + delta)));
    for (const [a, b] of gr.runs) setRun(g, gr.axis, to, a, b, true);
    moved.push({ axis: gr.axis, pos: to, runs: gr.runs });
  }
  return { ok: true, walls: preserveIds(walls, gridToWalls(g)), groups: moved };
}

/** Lengthen or shorten one endpoint (`from` or `to`) of wall `id` */
export function stretchEnd(
  walls: Wall[],
  cols: number,
  rows: number,
  id: number,
  which: 'from' | 'to',
  target: number,
): EditResult {
  const w = walls.find((q) => q.id === id);
  if (!w) return { ok: false, code: 'edit-no-wall' };
  if (isOuterWall(w.axis, w.pos, cols, rows)) return { ok: false, code: 'edit-outer-fixed' };
  const maxAlong = w.axis === 'h' ? cols : rows;
  const t = Math.max(0, Math.min(maxAlong, Math.round(target)));
  const nFrom = which === 'from' ? Math.min(t, w.to - 1) : w.from;
  const nTo = which === 'to' ? Math.max(t, w.from + 1) : w.to;
  if (nFrom === w.from && nTo === w.to) return { ok: true, walls };

  const g = wallsToGrid(walls, cols, rows);
  setRun(g, w.axis, w.pos, w.from, w.to, false);
  setRun(g, w.axis, w.pos, nFrom, nTo, true);
  return { ok: true, walls: preserveIds(walls, gridToWalls(g)) };
}

/** Toggle or force a single 1-cell grid wall segment (used by right-click & Draw/Carve mode) */
export function toggleEdge(
  walls: Wall[],
  cols: number,
  rows: number,
  axis: Axis,
  pos: number,
  idx: number,
  forceSolid?: boolean,
): EditResult {
  const maxPos = axis === 'h' ? rows : cols;
  const maxIdx = axis === 'h' ? cols : rows;
  if (pos < 0 || pos > maxPos || idx < 0 || idx >= maxIdx) return { ok: false, code: 'edit-outside' };

  const g = wallsToGrid(walls, cols, rows);
  const cur = getEdge(g, axis, pos, idx);
  const next = forceSolid !== undefined ? forceSolid : !cur;
  if (next === cur) return { ok: true, walls };
  setEdge(g, axis, pos, idx, next);
  return { ok: true, walls: preserveIds(walls, gridToWalls(g)) };
}

/** Carve an open passage between two orthogonally adjacent cells (for pen-carving in Carve mode) */
export function carveBetween(
  walls: Wall[],
  cols: number,
  rows: number,
  c0: number,
  r0: number,
  c1: number,
  r1: number,
): EditResult {
  if (c0 < 0 || c0 >= cols || r0 < 0 || r0 >= rows || c1 < 0 || c1 >= cols || r1 < 0 || r1 >= rows) {
    return { ok: false, code: 'edit-outside' };
  }
  if (Math.abs(c0 - c1) + Math.abs(r0 - r1) !== 1) return { ok: true, walls };
  const axis: Axis = c0 === c1 ? 'h' : 'v';
  const pos = axis === 'h' ? Math.max(r0, r1) : Math.max(c0, c1);
  const idx = axis === 'h' ? c0 : r0;
  return toggleEdge(walls, cols, rows, axis, pos, idx, false);
}

/** Re-attach existing wall IDs to newly extracted canonical walls where they overlap */
function preserveIds(oldWalls: Wall[], fresh: Wall[]): Wall[] {
  const used = new Set<number>();
  let maxId = oldWalls.reduce((m, w) => Math.max(m, w.id), 0);
  return fresh.map((nw) => {
    const match = oldWalls.find(
      (ow) =>
        !used.has(ow.id) &&
        ow.axis === nw.axis &&
        ow.pos === nw.pos &&
        !!ow.open === !!nw.open &&
        Math.min(ow.to, nw.to) > Math.max(ow.from, nw.from),
    );
    if (match) {
      used.add(match.id);
      return { ...nw, id: match.id };
    }
    return { ...nw, id: ++maxId };
  });
}
