// Core types and coordinate helpers for the Labyrinth / Tilt Maze generator plugin.
import type { Params } from '../../../sdk/ts';

export type Axis = 'h' | 'v';
export type MazeAlgorithm = 'dfs' | 'prim' | 'kruskal' | 'huntKill' | 'sidewinder';
export type LayerCountMode = 'auto' | 'manual';
export type CornerHoleMode = 'none' | 'pins' | 'screws';
export type StartSymbol = 'dot' | 'circle' | 'flag' | 'none';
export type GoalSymbol = 'star' | 'target' | 'flag' | 'none';
export type GlueGuideMode = 'islands' | 'all' | 'none';

export interface MazeParams extends Params {
  cols: number;
  rows: number;
  algorithm: string;
  seed: number;
  braid: number;
  autoEndpoints: boolean;
  ballDia: number;
  ballPlay: number;
  wallWidth: number;
  borderWidth: number;
  cornerRadius: number;
  fromMaterial: boolean;
  thickness: number;
  kerf: number;
  layerCountMode: string;
  layerCount: number;
  ballTopPlay: number;
  cover: boolean;
  coverThickness: number;
  separateCoverPage: boolean;
  topFrame: boolean;
  cornerHoles: string;
  holeDia: number;
  startSymbol: string;
  goalSymbol: string;
  glueGuides: string;
  showSolution: boolean;
  walls: string;
  wallsRef: string;
  wallMode: string;
  endpoints: string;
}

/**
 * A contiguous wall on a grid line (integer cell coordinates):
 * - axis === 'h': runs horizontally along row boundary `pos` (0..rows) from col `from` to col `to` (0 <= from < to <= cols)
 * - axis === 'v': runs vertically along col boundary `pos` (0..cols) from row `from` to row `to` (0 <= from < to <= rows)
 * - `open: true`: only on outer boundaries (pos === 0 or pos === rows/cols), marks an opened entry/exit gate.
 */
export interface Wall {
  id: number;
  axis: Axis;
  pos: number;
  from: number;
  to: number;
  open?: boolean;
}

/** Start and Goal cell coordinates (0-indexed: 0 <= x < cols, 0 <= y < rows) */
export interface Endpoints {
  sx: number;
  sy: number;
  gx: number;
  gy: number;
}

/** Exact boolean wall grid representation for a cols x rows labyrinth */
export interface MazeGrid {
  cols: number;
  rows: number;
  /** Horizontal walls: (rows + 1) rows x cols columns. true = solid wall, false = open passage */
  h: boolean[][];
  /** Vertical walls: (cols + 1) cols x rows rows. true = solid wall, false = open passage */
  v: boolean[][];
}

/** Physical dimensions of the laser-cut tilt maze (all in mm) */
export interface MazeDims {
  cols: number;
  rows: number;
  ballDia: number;
  ballPlay: number;
  /** Channel width = ballDia + ballPlay */
  ch: number;
  /** Interior wall width */
  wallW: number;
  /** Grid pitch = ch + wallW */
  pitch: number;
  /** Outer border width */
  border: number;
  /** Clamped outer corner radius */
  cornerRadius: number;
  /** Inner labyrinth field width = cols * ch + (cols - 1) * wallW */
  innerW: number;
  /** Inner labyrinth field height = rows * ch + (rows - 1) * wallW */
  innerH: number;
  /** Total board width = innerW + 2 * border */
  totalW: number;
  /** Total board height = innerH + 2 * border */
  totalH: number;
  /** Wood sheet thickness */
  t: number;
  /** Laser kerf */
  kerf: number;
  /** Number of stacked maze layers */
  layerCount: number;
  /** Channel depth = layerCount * t */
  channelDepth: number;
  /** Total assembled height including base, maze layers, optional cover & top frame */
  totalHeight: number;
  cover: boolean;
  coverThickness: number;
  topFrame: boolean;
  cornerHoles: CornerHoleMode;
  holeDia: number;
}

/** Topology & solvability analysis of the current labyrinth */
export interface MazeAnalysis {
  solvable: boolean;
  /** Cell coordinates [col, row] from start to goal along shortest path (empty if unsolvable) */
  solutionPath: [number, number][];
  /** Number of steps (= solutionPath.length - 1, or 0 if unsolvable) */
  solutionSteps: number;
  /** Number of cells reachable from start */
  reachableCells: number;
  totalCells: number;
  /** Count of dead-end cells (cells with 3 closed walls) */
  deadEnds: number;
  /** Number of open outer wall segments (entry/exit gates) */
  openOuterCount: number;
  /** Solid matrix of size (2*rows + 1) x (2*cols + 1) */
  solid: boolean[][];
  /** Connected-component id per cell of `solid` (-1 = empty, 0 = main frame, >= 1 = floating wall island) */
  comp: number[][];
  /** Number of disconnected floating wall islands */
  islandCount: number;
}

/** Max allowed walls in stored JSON and max JSON text size */
export const MAX_WALLS = 1200;
export const MAX_TEXT = 120_000;

/** Cell center in inner maze coordinates (origin at inner top-left, mm, y down) */
export function cellCenterInner(c: number, r: number, d: Pick<MazeDims, 'ch' | 'pitch'>): [number, number] {
  return [c * d.pitch + d.ch / 2, r * d.pitch + d.ch / 2];
}

/** Cell center in part-local centered coordinates (origin at board center, mm, y down) */
export function cellCenterLocal(c: number, r: number, d: Pick<MazeDims, 'ch' | 'pitch' | 'border' | 'totalW' | 'totalH'>): [number, number] {
  return [d.border + c * d.pitch + d.ch / 2 - d.totalW / 2, d.border + r * d.pitch + d.ch / 2 - d.totalH / 2];
}

/**
 * Centerline coordinate (mm, inner maze space) of a grid wall line `pos`:
 * - pos === 0: -border / 2 (or -wallW / 2 for inner alignment; wall face is at 0)
 * - 1 <= pos < count: pos * pitch - wallW / 2
 * - pos === count: innerSize + wallW / 2
 */
export function wallLineCenterInner(pos: number, count: number, d: Pick<MazeDims, 'pitch' | 'wallW' | 'border'>): number {
  if (pos <= 0) return -d.border / 2;
  if (pos >= count) return count * d.pitch - d.wallW + d.border / 2;
  return pos * d.pitch - d.wallW / 2;
}

/**
 * Physical thickness (mm) of a wall on grid line `pos` (border for outer walls, wallW for interior walls).
 */
export function wallLineThickness(pos: number, count: number, d: Pick<MazeDims, 'wallW' | 'border'>): number {
  return pos <= 0 || pos >= count ? d.border : d.wallW;
}

/**
 * Span [a0, a1] in inner maze mm along a wall running from grid index `from` to `to`:
 * Each wall covers its interior channels plus the wallWidth posts at its ends (clamped cleanly to outer borders).
 */
export function wallSpanInner(from: number, to: number, count: number, d: Pick<MazeDims, 'pitch' | 'wallW' | 'border'>): [number, number] {
  const a0 = from <= 0 ? -d.border : from * d.pitch - d.wallW;
  const a1 = to >= count ? count * d.pitch - d.wallW + d.border : to * d.pitch;
  return [a0, a1];
}

/** Outer wall predicate */
export const isOuterWall = (axis: Axis, pos: number, cols: number, rows: number): boolean =>
  axis === 'h' ? pos === 0 || pos === rows : pos === 0 || pos === cols;
