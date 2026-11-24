// Pure maze generation, canonical wall representation, BFS solver, and solid-matrix island analysis.
// Zero host dependencies so every algorithm can be thoroughly verified in Node tests.
import { random } from '../../../sdk/ts';
import {
  isOuterWall,
  MAX_TEXT,
  MAX_WALLS,
  type Axis,
  type Endpoints,
  type MazeAlgorithm,
  type MazeAnalysis,
  type MazeGrid,
  type Wall,
} from './types';

/** Create a grid with all walls closed (`fill = true`) or only outer border closed (`fill = false`) */
export function createGrid(cols: number, rows: number, fillInterior: boolean): MazeGrid {
  const h: boolean[][] = Array.from({ length: rows + 1 }, (_, r) =>
    Array.from({ length: cols }, () => r === 0 || r === rows || fillInterior),
  );
  const v: boolean[][] = Array.from({ length: cols + 1 }, (_, c) =>
    Array.from({ length: rows }, () => c === 0 || c === cols || fillInterior),
  );
  return { cols, rows, h, v };
}

/** Deep clone of a MazeGrid */
export function cloneGrid(g: MazeGrid): MazeGrid {
  return {
    cols: g.cols,
    rows: g.rows,
    h: g.h.map((row) => [...row]),
    v: g.v.map((col) => [...col]),
  };
}

/** Remove the wall between two orthogonally adjacent cells */
function removeBetween(g: MazeGrid, c0: number, r0: number, c1: number, r1: number): void {
  if (c0 === c1 && Math.abs(r0 - r1) === 1) {
    g.h[Math.max(r0, r1)][c0] = false;
  } else if (r0 === r1 && Math.abs(c0 - c1) === 1) {
    g.v[Math.max(c0, c1)][r0] = false;
  }
}

/** Check if the passage between two orthogonally adjacent cells is open */
export function isOpenBetween(g: MazeGrid, c0: number, r0: number, c1: number, r1: number): boolean {
  if (c0 === c1 && Math.abs(r0 - r1) === 1) {
    return !g.h[Math.max(r0, r1)][c0];
  }
  if (r0 === r1 && Math.abs(c0 - c1) === 1) {
    return !g.v[Math.max(c0, c1)][r0];
  }
  return false;
}

const DIRS: readonly [number, number][] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

function shuffleInPlace<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/** Iterative Recursive Backtracker (DFS) — long winding corridors, classic tilt maze */
function genDFS(cols: number, rows: number, rng: () => number): MazeGrid {
  const g = createGrid(cols, rows, true);
  const vis = Array.from({ length: rows }, () => new Uint8Array(cols));
  const sc = Math.floor(rng() * cols);
  const sr = Math.floor(rng() * rows);
  const stack: [number, number][] = [[sc, sr]];
  vis[sr][sc] = 1;

  while (stack.length > 0) {
    const [c, r] = stack[stack.length - 1];
    const nbrs: [number, number][] = [];
    for (const [dc, dr] of DIRS) {
      const nc = c + dc;
      const nr = r + dr;
      if (nc >= 0 && nc < cols && nr >= 0 && nr < rows && !vis[nr][nc]) {
        nbrs.push([nc, nr]);
      }
    }
    if (nbrs.length === 0) {
      stack.pop();
      continue;
    }
    const [nc, nr] = nbrs[Math.floor(rng() * nbrs.length)];
    removeBetween(g, c, r, nc, nr);
    vis[nr][nc] = 1;
    stack.push([nc, nr]);
  }
  return g;
}

/** Randomized Prim's algorithm — higher branching factor, shorter dead ends */
function genPrim(cols: number, rows: number, rng: () => number): MazeGrid {
  const g = createGrid(cols, rows, true);
  const inMaze = Array.from({ length: rows }, () => new Uint8Array(cols));
  const frontier: [number, number, number, number][] = [];

  const addCell = (c: number, r: number) => {
    inMaze[r][c] = 1;
    for (const [dc, dr] of DIRS) {
      const nc = c + dc;
      const nr = r + dr;
      if (nc >= 0 && nc < cols && nr >= 0 && nr < rows && !inMaze[nr][nc]) {
        frontier.push([c, r, nc, nr]);
      }
    }
  };

  addCell(Math.floor(rng() * cols), Math.floor(rng() * rows));
  while (frontier.length > 0) {
    const idx = Math.floor(rng() * frontier.length);
    const [c0, r0, c1, r1] = frontier[idx];
    frontier[idx] = frontier[frontier.length - 1];
    frontier.pop();
    if (inMaze[r1][c1]) continue;
    removeBetween(g, c0, r0, c1, r1);
    addCell(c1, r1);
  }
  return g;
}

/** Randomized Kruskal's algorithm — balanced, organic passages */
function genKruskal(cols: number, rows: number, rng: () => number): MazeGrid {
  const g = createGrid(cols, rows, true);
  const n = cols * rows;
  const parent = new Int32Array(n);
  const rank = new Uint8Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;

  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const unite = (a: number, b: number): boolean => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return false;
    if (rank[ra] < rank[rb]) parent[ra] = rb;
    else if (rank[ra] > rank[rb]) parent[rb] = ra;
    else {
      parent[rb] = ra;
      rank[ra]++;
    }
    return true;
  };

  const edges: [number, number, number, number][] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (c + 1 < cols) edges.push([c, r, c + 1, r]);
      if (r + 1 < rows) edges.push([c, r, c, r + 1]);
    }
  }
  shuffleInPlace(edges, rng);

  for (const [c0, r0, c1, r1] of edges) {
    if (unite(r0 * cols + c0, r1 * cols + c1)) {
      removeBetween(g, c0, r0, c1, r1);
    }
  }
  return g;
}

/** Hunt-and-Kill algorithm — winding paths with fewer dead ends than Prim */
function genHuntKill(cols: number, rows: number, rng: () => number): MazeGrid {
  const g = createGrid(cols, rows, true);
  const vis = Array.from({ length: rows }, () => new Uint8Array(cols));
  let c = Math.floor(rng() * cols);
  let r = Math.floor(rng() * rows);
  vis[r][c] = 1;

  while (true) {
    // Random walk while unvisited neighbor exists
    while (true) {
      const nbrs: [number, number][] = [];
      for (const [dc, dr] of DIRS) {
        const nc = c + dc;
        const nr = r + dr;
        if (nc >= 0 && nc < cols && nr >= 0 && nr < rows && !vis[nr][nc]) {
          nbrs.push([nc, nr]);
        }
      }
      if (nbrs.length === 0) break;
      const [nc, nr] = nbrs[Math.floor(rng() * nbrs.length)];
      removeBetween(g, c, r, nc, nr);
      vis[nr][nc] = 1;
      c = nc;
      r = nr;
    }

    // Hunt phase: find first unvisited cell adjacent to a visited cell
    let found = false;
    for (let hr = 0; hr < rows && !found; hr++) {
      for (let hc = 0; hc < cols && !found; hc++) {
        if (vis[hr][hc]) continue;
        const visNbrs: [number, number][] = [];
        for (const [dc, dr] of DIRS) {
          const nc = hc + dc;
          const nr = hr + dr;
          if (nc >= 0 && nc < cols && nr >= 0 && nr < rows && vis[nr][nc]) {
            visNbrs.push([nc, nr]);
          }
        }
        if (visNbrs.length > 0) {
          const [nc, nr] = visNbrs[Math.floor(rng() * visNbrs.length)];
          removeBetween(g, hc, hr, nc, nr);
          vis[hr][hc] = 1;
          c = hc;
          r = hr;
          found = true;
        }
      }
    }
    if (!found) break;
  }
  return g;
}

/** Sidewinder algorithm — distinctive horizontal runs connected northward */
function genSidewinder(cols: number, rows: number, rng: () => number): MazeGrid {
  const g = createGrid(cols, rows, true);
  for (let r = 0; r < rows; r++) {
    let runStart = 0;
    for (let c = 0; c < cols; c++) {
      const atEast = c === cols - 1;
      const atNorth = r === 0;
      const closeOut = atEast || (!atNorth && rng() < 0.5);
      if (closeOut) {
        if (!atNorth) {
          const pick = runStart + Math.floor(rng() * (c - runStart + 1));
          removeBetween(g, pick, r, pick, r - 1);
        }
        runStart = c + 1;
      } else {
        removeBetween(g, c, r, c + 1, r);
      }
    }
  }
  return g;
}

/** Open a percentage (0..100) of dead ends to introduce loops/alternate routes */
function applyBraid(g: MazeGrid, braidPct: number, rng: () => number): void {
  const pct = Math.max(0, Math.min(100, braidPct));
  if (pct <= 0) return;

  const deadEnds: [number, number][] = [];
  const wallCount = (c: number, r: number): number => {
    let n = 0;
    if (g.h[r][c]) n++;
    if (g.h[r + 1][c]) n++;
    if (g.v[c][r]) n++;
    if (g.v[c + 1][r]) n++;
    return n;
  };

  for (let r = 0; r < g.rows; r++) {
    for (let c = 0; c < g.cols; c++) {
      if (wallCount(c, r) === 3) deadEnds.push([c, r]);
    }
  }

  shuffleInPlace(deadEnds, rng);
  const target = Math.round((deadEnds.length * pct) / 100);
  let opened = 0;
  for (const [c, r] of deadEnds) {
    if (opened >= target) break;
    if (wallCount(c, r) !== 3) continue; // already opened from neighbor
    const closedNbrs: [number, number][] = [];
    for (const [dc, dr] of DIRS) {
      const nc = c + dc;
      const nr = r + dr;
      if (nc >= 0 && nc < g.cols && nr >= 0 && nr < g.rows && !isOpenBetween(g, c, r, nc, nr)) {
        closedNbrs.push([nc, nr]);
      }
    }
    if (!closedNbrs.length) continue;
    // Prefer connecting to another dead end to eliminate two dead ends cleanly
    const best = closedNbrs.filter(([nc, nr]) => wallCount(nc, nr) === 3);
    const pool = best.length ? best : closedNbrs;
    const [nc, nr] = pool[Math.floor(rng() * pool.length)];
    removeBetween(g, c, r, nc, nr);
    opened++;
  }
}

/** Generate a deterministic parametric maze grid */
export function generateMazeGrid(
  cols: number,
  rows: number,
  algorithm: MazeAlgorithm,
  seed: number,
  braidPct = 0,
): MazeGrid {
  const c = Math.max(2, Math.round(cols));
  const r = Math.max(2, Math.round(rows));
  // Mix algorithm index into seed so switching algorithms with the same seed gives distinct mazes
  const algSalt: Record<MazeAlgorithm, number> = {
    dfs: 0x13579bdf,
    prim: 0x2468ace1,
    kruskal: 0x369cf258,
    huntKill: 0x48bf36ad,
    sidewinder: 0x5a0e7c19,
  };
  const s = ((Math.round(seed) >>> 0) ^ (algSalt[algorithm] ?? 0) ^ (c * 73856093) ^ (r * 19349663)) >>> 0;
  const rng = random(s || 1);
  let g: MazeGrid;
  switch (algorithm) {
    case 'prim':
      g = genPrim(c, r, rng);
      break;
    case 'kruskal':
      g = genKruskal(c, r, rng);
      break;
    case 'huntKill':
      g = genHuntKill(c, r, rng);
      break;
    case 'sidewinder':
      g = genSidewinder(c, r, rng);
      break;
    case 'dfs':
    default:
      g = genDFS(c, r, rng);
      break;
  }
  if (braidPct > 0) applyBraid(g, braidPct, rng);
  return g;
}

/** Canonical signature for auto-generated maze parameters */
export function autoSignature(cols: number, rows: number, algorithm: string, seed: number, braid: number): string {
  return `${cols}x${rows}:${algorithm}:${seed}:${braid}`;
}

/**
 * Convert a MazeGrid into a canonical sorted list of merged contiguous Wall runs:
 * - Interior horizontal walls: axis 'h', pos 1..rows-1
 * - Interior vertical walls: axis 'v', pos 1..cols-1
 * - Any opened outer border segments: axis 'h'|'v', pos 0 or rows/cols, open: true
 */
export function gridToWalls(g: MazeGrid): Wall[] {
  const out: Wall[] = [];
  let nextId = 1;

  // Interior horizontal walls
  for (let r = 1; r < g.rows; r++) {
    let start = -1;
    for (let c = 0; c <= g.cols; c++) {
      const solid = c < g.cols && g.h[r][c];
      if (solid && start < 0) start = c;
      else if (!solid && start >= 0) {
        out.push({ id: nextId++, axis: 'h', pos: r, from: start, to: c });
        start = -1;
      }
    }
  }

  // Interior vertical walls
  for (let c = 1; c < g.cols; c++) {
    let start = -1;
    for (let r = 0; r <= g.rows; r++) {
      const solid = r < g.rows && g.v[c][r];
      if (solid && start < 0) start = r;
      else if (!solid && start >= 0) {
        out.push({ id: nextId++, axis: 'v', pos: c, from: start, to: r });
        start = -1;
      }
    }
  }

  // Outer horizontal openings (r = 0, r = rows)
  for (const r of [0, g.rows]) {
    let start = -1;
    for (let c = 0; c <= g.cols; c++) {
      const open = c < g.cols && !g.h[r][c];
      if (open && start < 0) start = c;
      else if (!open && start >= 0) {
        out.push({ id: nextId++, axis: 'h', pos: r, from: start, to: c, open: true });
        start = -1;
      }
    }
  }

  // Outer vertical openings (c = 0, c = cols)
  for (const c of [0, g.cols]) {
    let start = -1;
    for (let r = 0; r <= g.rows; r++) {
      const open = r < g.rows && !g.v[c][r];
      if (open && start < 0) start = r;
      else if (!open && start >= 0) {
        out.push({ id: nextId++, axis: 'v', pos: c, from: start, to: r, open: true });
        start = -1;
      }
    }
  }

  return out;
}

/**
 * Convert a list of Wall entries into a MazeGrid (all outer borders default solid, interior default open).
 */
export function wallsToGrid(walls: Wall[], cols: number, rows: number): MazeGrid {
  const g = createGrid(cols, rows, false);
  for (const w of walls) {
    if (w.axis === 'h') {
      const r = Math.round(w.pos);
      if (r < 0 || r > rows) continue;
      const a = Math.max(0, Math.min(cols, Math.round(Math.min(w.from, w.to))));
      const b = Math.max(0, Math.min(cols, Math.round(Math.max(w.from, w.to))));
      if (a >= b) continue;
      const outer = r === 0 || r === rows;
      if (outer) {
        if (w.open) {
          for (let c = a; c < b; c++) g.h[r][c] = false;
        }
      } else if (!w.open) {
        for (let c = a; c < b; c++) g.h[r][c] = true;
      }
    } else if (w.axis === 'v') {
      const c = Math.round(w.pos);
      if (c < 0 || c > cols) continue;
      const a = Math.max(0, Math.min(rows, Math.round(Math.min(w.from, w.to))));
      const b = Math.max(0, Math.min(rows, Math.round(Math.max(w.from, w.to))));
      if (a >= b) continue;
      const outer = c === 0 || c === cols;
      if (outer) {
        if (w.open) {
          for (let r = a; r < b; r++) g.v[c][r] = false;
        }
      } else if (!w.open) {
        for (let r = a; r < b; r++) g.v[c][r] = true;
      }
    }
  }
  return g;
}

/**
 * Canonicalize walls via the grid so overlapping/adjacent runs are merged and invalid/empty runs are dropped.
 * Preserves existing wall IDs where a merged wall overlaps an earlier wall on the same line.
 */
export function normalizeWalls(walls: Wall[], cols: number, rows: number): Wall[] {
  const g = wallsToGrid(walls, cols, rows);
  const fresh = gridToWalls(g);
  const used = new Set<number>();
  let maxId = walls.reduce((m, w) => Math.max(m, Math.floor(w.id) || 0), 0);

  return fresh.map((nw) => {
    const match = walls.find(
      (ow) =>
        !used.has(ow.id) &&
        ow.id > 0 &&
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

/** Parse walls JSON string; returns null if malformed */
export function readWalls(text: string): Wall[] | null {
  if (typeof text !== 'string' || text.length > MAX_TEXT) return null;
  if (!text.trim()) return [];
  try {
    const raw = JSON.parse(text);
    if (!Array.isArray(raw) || raw.length > MAX_WALLS) return null;
    const out: Wall[] = [];
    for (let i = 0; i < raw.length; i++) {
      const it = raw[i];
      if (!it || typeof it !== 'object') return null;
      const axis = it.axis === 'h' || it.axis === 'v' ? it.axis : null;
      const pos = Number(it.pos);
      const from = Number(it.from);
      const to = Number(it.to);
      if (!axis || !Number.isFinite(pos) || !Number.isFinite(from) || !Number.isFinite(to)) return null;
      const id = Number.isInteger(it.id) && it.id > 0 ? it.id : i + 1;
      const open = it.open === true ? true : undefined;
      out.push({ id, axis, pos: Math.round(pos), from: Math.round(from), to: Math.round(to), ...(open ? { open } : {}) });
    }
    return out;
  } catch {
    return null;
  }
}

/** Serialize walls cleanly for the `walls` data parameter */
export function writeWalls(walls: Wall[]): string {
  return JSON.stringify(
    walls.map((w) => ({
      id: w.id,
      axis: w.axis,
      pos: w.pos,
      from: w.from,
      to: w.to,
      ...(w.open ? { open: true } : {}),
    })),
  );
}

/** Clamp endpoints inside the grid; ensures start and goal differ if grid has > 1 cell */
export function clampEndpoints(ep: Endpoints, cols: number, rows: number): Endpoints {
  const sx = Math.max(0, Math.min(cols - 1, Math.round(ep.sx)));
  const sy = Math.max(0, Math.min(rows - 1, Math.round(ep.sy)));
  let gx = Math.max(0, Math.min(cols - 1, Math.round(ep.gx)));
  let gy = Math.max(0, Math.min(rows - 1, Math.round(ep.gy)));
  if (sx === gx && sy === gy && cols * rows > 1) {
    gx = sx === cols - 1 ? 0 : cols - 1;
    gy = sy === rows - 1 ? 0 : rows - 1;
  }
  return { sx, sy, gx, gy };
}

/** Parse endpoints JSON string; returns null if empty or invalid */
export function readEndpoints(text: string): Endpoints | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== 'object') return null;
    const sx = Number(raw.sx);
    const sy = Number(raw.sy);
    const gx = Number(raw.gx);
    const gy = Number(raw.gy);
    if (![sx, sy, gx, gy].every(Number.isFinite)) return null;
    return { sx: Math.round(sx), sy: Math.round(sy), gx: Math.round(gx), gy: Math.round(gy) };
  } catch {
    return null;
  }
}

export function writeEndpoints(ep: Endpoints): string {
  return JSON.stringify({ sx: ep.sx, sy: ep.sy, gx: ep.gx, gy: ep.gy });
}

/** BFS helper from a single source cell, returning distance matrix & parent pointers */
function bfsFrom(g: MazeGrid, sc: number, sr: number): { dist: Int32Array; parent: Int32Array; farthest: [number, number]; maxDist: number; visited: number } {
  const { cols, rows } = g;
  const n = cols * rows;
  const dist = new Int32Array(n).fill(-1);
  const parent = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;

  const sIdx = sr * cols + sc;
  dist[sIdx] = 0;
  queue[tail++] = sIdx;
  let farC = sc;
  let farR = sr;
  let maxDist = 0;

  while (head < tail) {
    const cur = queue[head++];
    const c = cur % cols;
    const r = (cur - c) / cols;
    const d = dist[cur];
    if (d > maxDist) {
      maxDist = d;
      farC = c;
      farR = r;
    }
    for (const [dc, dr] of DIRS) {
      const nc = c + dc;
      const nr = r + dr;
      if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
      if (!isOpenBetween(g, c, r, nc, nr)) continue;
      const ni = nr * cols + nc;
      if (dist[ni] !== -1) continue;
      dist[ni] = d + 1;
      parent[ni] = cur;
      queue[tail++] = ni;
    }
  }
  return { dist, parent, farthest: [farC, farR], maxDist, visited: tail };
}

/** Find the two farthest cells in the maze (two-pass BFS diameter heuristic) */
export function findDiameterEndpoints(g: MazeGrid): Endpoints {
  const pass1 = bfsFrom(g, 0, 0);
  const [sx, sy] = pass1.farthest;
  const pass2 = bfsFrom(g, sx, sy);
  const [gx, gy] = pass2.farthest;
  return clampEndpoints({ sx, sy, gx, gy }, g.cols, g.rows);
}

/** Default endpoints: top-left to bottom-right, or diameter if autoEndpoints is enabled */
export function defaultEndpoints(g: MazeGrid, autoEndpoints: boolean): Endpoints {
  if (autoEndpoints) return findDiameterEndpoints(g);
  return { sx: 0, sy: 0, gx: g.cols - 1, gy: g.rows - 1 };
}

/**
 * Build the (2*rows + 1) x (2*cols + 1) solid matrix representing the exact laser-cut wood layer:
 * - Odd/odd (2c+1, 2r+1): cell interior. Open unless all 4 surrounding walls are closed AND it is neither Start nor Goal
 *   (so completely walled-off single cells stay solid wood instead of useless tiny cutouts!).
 * - Odd/even (2c+1, 2r): horizontal wall segment h[r][c].
 * - Even/odd (2c, 2r+1): vertical wall segment v[c][r].
 * - Even/even (2c, 2r): grid post/pillar. Solid iff ANY of its 4 incident wall segments is solid.
 *
 * Mathematical guarantee: because any solid wall segment makes both of its endpoint pillars solid,
 * checkerboard vertices (two diagonally opposite solid cells meeting at a corner) are IMPOSSIBLE!
 */
export function buildSolidMatrix(g: MazeGrid, ep: Endpoints): boolean[][] {
  const W = 2 * g.cols + 1;
  const H = 2 * g.rows + 1;
  const solid: boolean[][] = Array.from({ length: H }, () => Array(W).fill(false));

  // Horizontal wall slots
  for (let r = 0; r <= g.rows; r++) {
    for (let c = 0; c < g.cols; c++) {
      solid[2 * r][2 * c + 1] = g.h[r][c];
    }
  }

  // Vertical wall slots
  for (let c = 0; c <= g.cols; c++) {
    for (let r = 0; r < g.rows; r++) {
      solid[2 * r + 1][2 * c] = g.v[c][r];
    }
  }

  // Corner posts / pillars
  for (let r = 0; r <= g.rows; r++) {
    for (let c = 0; c <= g.cols; c++) {
      const leftH = c > 0 && g.h[r][c - 1];
      const rightH = c < g.cols && g.h[r][c];
      const upV = r > 0 && g.v[c][r - 1];
      const downV = r < g.rows && g.v[c][r];
      solid[2 * r][2 * c] = leftH || rightH || upV || downV;
    }
  }

  // Completely enclosed 1x1 non-endpoint cells stay solid wood (cleaner cut & stronger board when carving custom designs)
  for (let r = 0; r < g.rows; r++) {
    for (let c = 0; c < g.cols; c++) {
      const isEp = (c === ep.sx && r === ep.sy) || (c === ep.gx && r === ep.gy);
      if (isEp) continue;
      if (g.h[r][c] && g.h[r + 1][c] && g.v[c][r] && g.v[c + 1][r]) {
        solid[2 * r + 1][2 * c + 1] = true;
      }
    }
  }

  return solid;
}

/**
 * Full analysis of a labyrinth: shortest solution path (BFS), dead ends, open outer gates,
 * solid matrix, and connected-component classification for floating wall islands.
 */
export function analyzeMaze(g: MazeGrid, ep: Endpoints): MazeAnalysis {
  const { cols, rows } = g;
  const { dist, parent, visited } = bfsFrom(g, ep.sx, ep.sy);
  const gIdx = ep.gy * cols + ep.gx;
  const solvable = dist[gIdx] >= 0;
  const solutionPath: [number, number][] = [];
  if (solvable) {
    let cur = gIdx;
    while (cur !== -1) {
      const c = cur % cols;
      const r = (cur - c) / cols;
      solutionPath.push([c, r]);
      cur = parent[cur];
    }
    solutionPath.reverse();
  }

  let deadEnds = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let wc = 0;
      if (g.h[r][c]) wc++;
      if (g.h[r + 1][c]) wc++;
      if (g.v[c][r]) wc++;
      if (g.v[c + 1][r]) wc++;
      if (wc === 3) deadEnds++;
    }
  }

  let openOuterCount = 0;
  for (let c = 0; c < cols; c++) {
    if (!g.h[0][c]) openOuterCount++;
    if (!g.h[rows][c]) openOuterCount++;
  }
  for (let r = 0; r < rows; r++) {
    if (!g.v[0][r]) openOuterCount++;
    if (!g.v[cols][r]) openOuterCount++;
  }

  const solid = buildSolidMatrix(g, ep);
  const H = solid.length;
  const W = solid[0].length;
  const comp: number[][] = Array.from({ length: H }, () => Array(W).fill(-1));

  const flood = (sy: number, sx: number, id: number) => {
    const q: [number, number][] = [[sx, sy]];
    comp[sy][sx] = id;
    let head = 0;
    while (head < q.length) {
      const [x, y] = q[head++];
      for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < W && ny >= 0 && ny < H && solid[ny][nx] && comp[ny][nx] === -1) {
          comp[ny][nx] = id;
          q.push([nx, ny]);
        }
      }
    }
  };

  // Component 0: all solid cells connected to the outer boundary of the board
  for (let x = 0; x < W; x++) {
    if (solid[0][x] && comp[0][x] === -1) flood(0, x, 0);
    if (solid[H - 1][x] && comp[H - 1][x] === -1) flood(H - 1, x, 0);
  }
  for (let y = 0; y < H; y++) {
    if (solid[y][0] && comp[y][0] === -1) flood(y, 0, 0);
    if (solid[y][W - 1] && comp[y][W - 1] === -1) flood(y, W - 1, 0);
  }

  // Components 1..k: floating wall islands not connected to the outer rim
  let islandCount = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      if (solid[y][x] && comp[y][x] === -1) {
        islandCount++;
        flood(y, x, islandCount);
      }
    }
  }

  return {
    solvable,
    solutionPath,
    solutionSteps: solvable ? solutionPath.length - 1 : 0,
    reachableCells: visited,
    totalCells: cols * rows,
    deadEnds,
    openOuterCount,
    solid,
    comp,
    islandCount,
  };
}

/** Check whether a wall has any segment belonging to a floating island (comp >= 1) */
export function isIslandWall(w: Wall, analysis: MazeAnalysis, cols: number, rows: number): boolean {
  if (w.open || isOuterWall(w.axis, w.pos, cols, rows)) return false;
  if (w.axis === 'h') {
    for (let c = w.from; c < w.to; c++) {
      if (analysis.comp[2 * w.pos]?.[2 * c + 1] > 0) return true;
    }
  } else {
    for (let r = w.from; r < w.to; r++) {
      if (analysis.comp[2 * r + 1]?.[2 * w.pos] > 0) return true;
    }
  }
  return false;
}
