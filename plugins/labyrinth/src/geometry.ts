// Exact laser-cut geometry generation for the Labyrinth / Tilt Maze:
// - Exact orthogonal polygon contour tracing from the (2*cols+1) x (2*rows+1) solid matrix (zero self-intersections)
// - Outer corner rounding with cubic Béziers
// - Base plate with engraved Start/Goal symbols and optional glue guides (for floating islands or all walls)
// - Stacked maze layers (auto or manual layer count), optional clear cover (separate page), optional top bezel frame
// - Optional corner alignment pin / screw holes across all layers
// - Kerf compensation via host.offset and stacked 3D assembly poses.
import { circle, host, K, polygon, roundedRect, type Node, type Part, type Pose, type SubPath, type Text } from '../../../sdk/ts';
import {
  cellCenterLocal,
  type Endpoints,
  type GlueGuideMode,
  type GoalSymbol,
  type MazeAnalysis,
  type MazeDims,
  type MazeGrid,
  type StartSymbol,
} from './types';

const EPS = 1e-6;

/** Flat horizontal part pose in 3D view (cut/engraved top face pointing +Z) */
export function flatPose(cx: number, cy: number, z: number): Pose {
  return { o: [cx, -cy, z], u: [1, 0, 0], v: [0, -1, 0], n: [0, 0, 1] };
}

/** Widen cut parts by half the kerf: outline outwards, holes inwards, sharp corners */
export function applyKerf(subs: SubPath[], kerf: number): SubPath[] {
  if (kerf <= 1e-4) return subs;
  const out = host.offset({ subs, delta: kerf / 2, join: 'miter' });
  return out.length ? out : subs;
}

/** Compute the (2*cols + 2) X coordinates and (2*rows + 2) Y coordinates in centered part-local space (mm) */
export function gridAxisCoords(d: MazeDims): { xs: number[]; ys: number[] } {
  const xs: number[] = [-d.totalW / 2];
  let curX = -d.totalW / 2 + d.border;
  xs.push(curX);
  for (let c = 0; c < d.cols; c++) {
    curX += d.ch;
    xs.push(curX);
    if (c < d.cols - 1) {
      curX += d.wallW;
      xs.push(curX);
    }
  }
  xs.push(d.totalW / 2);

  const ys: number[] = [-d.totalH / 2];
  let curY = -d.totalH / 2 + d.border;
  ys.push(curY);
  for (let r = 0; r < d.rows; r++) {
    curY += d.ch;
    ys.push(curY);
    if (r < d.rows - 1) {
      curY += d.wallW;
      ys.push(curY);
    }
  }
  ys.push(d.totalH / 2);

  return { xs, ys };
}

/**
 * Trace exact closed rectilinear loops from a boolean matrix `mask` (H x W) onto coordinate grids `xs` (W+1) and `ys` (H+1).
 * In y-down coordinates, solid regions lie to the RIGHT of each directed edge:
 * - Outer boundaries wind with positive signed area (CW visually)
 * - Cutout holes wind with negative signed area (CCW visually)
 * Collinear consecutive segments are merged so every loop has minimal vertices.
 */
export function traceOrthogonalContours(mask: boolean[][], xs: number[], ys: number[]): [number, number][][] {
  const H = mask.length;
  const W = mask[0].length;
  const isSolid = (gx: number, gy: number) => gx >= 0 && gx < W && gy >= 0 && gy < H && mask[gy][gx];

  const vKey = (ix: number, iy: number) => `${ix},${iy}`;
  const outgoing = new Map<string, [number, number][]>();
  const addEdge = (x0: number, y0: number, x1: number, y1: number) => {
    const k = vKey(x0, y0);
    let list = outgoing.get(k);
    if (!list) {
      list = [];
      outgoing.set(k, list);
    }
    list.push([x1, y1]);
  };

  for (let gy = 0; gy < H; gy++) {
    for (let gx = 0; gx < W; gx++) {
      if (!mask[gy][gx]) continue;
      // Top edge: left -> right
      if (!isSolid(gx, gy - 1)) addEdge(gx, gy, gx + 1, gy);
      // Right edge: top -> bottom
      if (!isSolid(gx + 1, gy)) addEdge(gx + 1, gy, gx + 1, gy + 1);
      // Bottom edge: right -> left
      if (!isSolid(gx, gy + 1)) addEdge(gx + 1, gy + 1, gx, gy + 1);
      // Left edge: bottom -> top
      if (!isSolid(gx - 1, gy)) addEdge(gx, gy + 1, gx, gy);
    }
  }

  const loops: [number, number][][] = [];

  for (const [startKey, starts] of outgoing) {
    while (starts.length > 0) {
      const [sx, sy] = startKey.split(',').map(Number);
      const next0 = starts.pop()!;
      const gridLoop: [number, number][] = [[sx, sy]];
      let cx = next0[0];
      let cy = next0[1];
      let dx = cx - sx;
      let dy = cy - sy;

      let guard = 0;
      const maxSteps = (W + 1) * (H + 1) * 4 + 16;
      while ((cx !== sx || cy !== sy) && guard++ < maxSteps) {
        gridLoop.push([cx, cy]);
        const list = outgoing.get(vKey(cx, cy));
        if (!list || list.length === 0) break;
        // If degree > 1 (cannot happen for our checkerboard-free maze matrix, but handled safely anyway):
        // prefer turning right (keeping solid tightly bounded)
        let pickIdx = 0;
        if (list.length > 1) {
          let bestScore = -Infinity;
          for (let i = 0; i < list.length; i++) {
            const ndx = list[i][0] - cx;
            const ndy = list[i][1] - cy;
            const cross = dx * ndy - dy * ndx;
            const dot = dx * ndx + dy * ndy;
            const score = cross > 0 ? 3 : dot > 0 ? 2 : 1;
            if (score > bestScore) {
              bestScore = score;
              pickIdx = i;
            }
          }
        }
        const [nx, ny] = list.splice(pickIdx, 1)[0];
        dx = nx - cx;
        dy = ny - cy;
        cx = nx;
        cy = ny;
      }

      if (gridLoop.length < 4) continue;

      // Convert to mm coordinates and drop collinear intermediate points
      const mmPts: [number, number][] = gridLoop.map(([ix, iy]) => [xs[ix], ys[iy]]);
      const simplified: [number, number][] = [];
      const n = mmPts.length;
      for (let i = 0; i < n; i++) {
        const prev = mmPts[(i - 1 + n) % n];
        const curr = mmPts[i];
        const next = mmPts[(i + 1) % n];
        const cross = (curr[0] - prev[0]) * (next[1] - curr[1]) - (curr[1] - prev[1]) * (next[0] - curr[0]);
        if (Math.abs(cross) > 1e-7) simplified.push(curr);
      }
      if (simplified.length >= 3) loops.push(simplified);
    }
  }

  return loops;
}

/**
 * Convert a rectilinear polygon loop to a SubPath, rounding convex 90° corners that lie on the
 * 4 extreme corners of the outer board (±totalW/2, ±totalH/2) with exact cubic Bézier quarter-arcs.
 */
function polyToRoundedSubPath(pts: [number, number][], cornerRadius: number, halfW: number, halfH: number): SubPath {
  const n = pts.length;
  if (cornerRadius <= 1e-4) return polygon(pts);

  const isBoardCorner = (p: [number, number]) =>
    Math.abs(Math.abs(p[0]) - halfW) < 1e-3 && Math.abs(Math.abs(p[1]) - halfH) < 1e-3;

  const nodes: Node[] = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const curr = pts[i];
    const next = pts[(i + 1) % n];
    const v1x = curr[0] - prev[0];
    const v1y = curr[1] - prev[1];
    const v2x = next[0] - curr[0];
    const v2y = next[1] - curr[1];
    const l1 = Math.hypot(v1x, v1y);
    const l2 = Math.hypot(v2x, v2y);
    const cross = v1x * v2y - v1y * v2x;

    // Convex outer 90° corner (cross > 0 in CW y-down outer loop)
    if (isBoardCorner(curr) && cross > 1e-5 && l1 > 1e-3 && l2 > 1e-3) {
      const r = Math.min(cornerRadius, l1 * 0.49, l2 * 0.49);
      if (r > 0.05) {
        const u1x = v1x / l1;
        const u1y = v1y / l1;
        const u2x = v2x / l2;
        const u2y = v2y / l2;
        const pInX = curr[0] - u1x * r;
        const pInY = curr[1] - u1y * r;
        const pOutX = curr[0] + u2x * r;
        const pOutY = curr[1] + u2y * r;
        const k = r * K;
        nodes.push({
          x: pInX,
          y: pInY,
          cout: { x: pInX + u1x * k, y: pInY + u1y * k },
        });
        nodes.push({
          x: pOutX,
          y: pOutY,
          cin: { x: pOutX - u2x * k, y: pOutY - u2y * k },
        });
        continue;
      }
    }
    nodes.push({ x: curr[0], y: curr[1] });
  }
  return { closed: true, nodes };
}

/** 4 corner hole centers in part-local centered coordinates (mm) */
export function cornerHoleCenters(d: MazeDims): [number, number][] {
  if (d.cornerHoles === 'none') return [];
  const off = d.border / 2;
  const hx = d.totalW / 2 - off;
  const hy = d.totalH / 2 - off;
  return [
    [-hx, -hy],
    [hx, -hy],
    [hx, hy],
    [-hx, hy],
  ];
}

/** Reverse a closed SubPath so its winding is CCW (hole) */
function reverseSubPath(sp: SubPath): SubPath {
  const ns = sp.nodes;
  if (!sp.closed || ns.length < 2) return sp;
  const rev = [ns[0], ...ns.slice(1).reverse()];
  return {
    closed: true,
    nodes: rev.map((n) => ({
      x: n.x,
      y: n.y,
      ...(n.cout ? { cin: { ...n.cout } } : {}),
      ...(n.cin ? { cout: { ...n.cin } } : {}),
      ...(n.smooth ? { smooth: n.smooth } : {}),
    })),
  };
}

/** Build the 4 corner hole SubPaths (CCW holes) */
function buildCornerHoleSubs(d: MazeDims): SubPath[] {
  const r = d.holeDia / 2;
  if (d.cornerHoles === 'none' || r <= 0) return [];
  return cornerHoleCenters(d).map(([cx, cy]) => reverseSubPath(circle(cx, cy, r)));
}

/** Minimum radial web between a corner hole and the nearest outer edge / rounded corner / inner channel */
export function cornerHoleMinWeb(d: MazeDims): number {
  if (d.cornerHoles === 'none') return Infinity;
  const off = d.border / 2;
  const rHole = d.holeDia / 2;
  // Distance to straight outer side
  let minEdgeDist = off;
  // Distance to rounded outer corner arc if cornerRadius > off
  if (d.cornerRadius > off) {
    const R = d.cornerRadius;
    const distToArcCenter = Math.hypot(R - off, R - off);
    minEdgeDist = Math.min(minEdgeDist, R - distToArcCenter);
  }
  // Distance to inner channel corner (border, border) from (off, off)
  const distToInnerCorner = Math.hypot(d.border - off, d.border - off);
  return Math.min(minEdgeDist, distToInnerCorner) - rHole;
}

/** Build a 5-pointed star SubPath centered at (cx, cy) with outer radius R and inner radius r */
function starSub(cx: number, cy: number, R: number, r: number): SubPath {
  const pts: [number, number][] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = i % 2 === 0 ? R : r;
    pts.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]);
  }
  return polygon(pts);
}

/** Build a small pennant flag engraving centered at (cx, cy) */
function flagMarks(cx: number, cy: number, r: number): SubPath[] {
  const px = cx - r * 0.38;
  const topY = cy - r * 0.85;
  const botY = cy + r * 0.85;
  const pole: SubPath = { closed: false, nodes: [{ x: px, y: botY }, { x: px, y: topY }] };
  const pennant: SubPath = polygon([
    [px, topY],
    [px + r * 1.05, topY + r * 0.42],
    [px, topY + r * 0.85],
  ]);
  const baseLine: SubPath = { closed: false, nodes: [{ x: px - r * 0.35, y: botY }, { x: px + r * 0.35, y: botY }] };
  return [pole, pennant, baseLine];
}

/** Build engraved Start marker SubPaths on the base plate */
function buildStartMarks(cx: number, cy: number, ch: number, style: StartSymbol): SubPath[] {
  const r = Math.min(ch * 0.34, 8);
  if (style === 'none') return [];
  if (style === 'dot') {
    return [circle(cx, cy, r), circle(cx, cy, r * 0.58), circle(cx, cy, r * 0.22)];
  }
  if (style === 'circle') {
    return [circle(cx, cy, r)];
  }
  if (style === 'flag') {
    return flagMarks(cx, cy, r);
  }
  return [];
}

/** Build engraved Goal marker SubPaths on the base plate */
function buildGoalMarks(cx: number, cy: number, ch: number, style: GoalSymbol): SubPath[] {
  const r = Math.min(ch * 0.38, 9);
  if (style === 'none') return [];
  if (style === 'star') {
    return [starSub(cx, cy, r, r * 0.42), starSub(cx, cy, r * 0.55, r * 0.23)];
  }
  if (style === 'target') {
    return [
      circle(cx, cy, r),
      circle(cx, cy, r * 0.58),
      circle(cx, cy, r * 0.2),
      { closed: false, nodes: [{ x: cx - r * 1.15, y: cy }, { x: cx + r * 1.15, y: cy }] },
      { closed: false, nodes: [{ x: cx, y: cy - r * 1.15 }, { x: cx, y: cy + r * 1.15 }] },
    ];
  }
  if (style === 'flag') {
    return flagMarks(cx, cy, r);
  }
  return [];
}

/** Build glue-guide engraving SubPaths on the base plate (islands only, or all maze wall outlines) */
function buildGlueGuides(analysis: MazeAnalysis, d: MazeDims, mode: GlueGuideMode): SubPath[] {
  if (mode === 'none') return [];
  const { xs, ys } = gridAxisCoords(d);
  const H = analysis.solid.length;
  const W = analysis.solid[0].length;

  if (mode === 'islands') {
    if (analysis.islandCount === 0) return [];
    const islandMask: boolean[][] = Array.from({ length: H }, (_, y) =>
      Array.from({ length: W }, (_, x) => analysis.comp[y][x] > 0),
    );
    return traceOrthogonalContours(islandMask, xs, ys).map((pts) => polygon(pts));
  }

  // mode === 'all': engrave all interior channel/wall boundaries (excluding the outer board perimeter)
  const loops = traceOrthogonalContours(analysis.solid, xs, ys);
  const halfW = d.totalW / 2;
  const halfH = d.totalH / 2;
  const out: SubPath[] = [];
  for (const pts of loops) {
    const isOuterPerimeter = pts.every(
      ([x, y]) => Math.abs(Math.abs(x) - halfW) < 1e-3 || Math.abs(Math.abs(y) - halfH) < 1e-3,
    );
    if (!isOuterPerimeter) out.push(polygon(pts));
  }
  return out;
}

/** Build the cut SubPaths of one maze wall layer (un-kerfed) */
export function buildMazeLayerSubs(analysis: MazeAnalysis, d: MazeDims): SubPath[] {
  const { xs, ys } = gridAxisCoords(d);
  const loops = traceOrthogonalContours(analysis.solid, xs, ys);
  const halfW = d.totalW / 2;
  const halfH = d.totalH / 2;
  const subs = loops.map((pts) => polyToRoundedSubPath(pts, d.cornerRadius, halfW, halfH));
  const holes = buildCornerHoleSubs(d);
  return [...subs, ...holes];
}

export interface BuiltMaze {
  parts: Part[];
  labels: Record<string, Text>;
  poses: Record<string, Pose>;
  /** Un-kerfed cut geometry by part key (for host.check) */
  rawParts: Record<string, SubPath[]>;
}

/**
 * Assemble all laser-cut parts (base plate, N stacked maze layers, optional clear cover, optional top wood frame),
 * nest them cleanly per page group, and compute exact 3D assembly poses.
 */
export function buildMazeAssembly(
  grid: MazeGrid,
  ep: Endpoints,
  analysis: MazeAnalysis,
  d: MazeDims,
  opts: {
    separateCoverPage: boolean;
    startSymbol: StartSymbol;
    goalSymbol: GoalSymbol;
    glueGuides: GlueGuideMode;
  },
): BuiltMaze {
  const outerPlate = roundedRect(d.totalW, d.totalH, d.cornerRadius);
  const holes = buildCornerHoleSubs(d);

  // 1. Base plate (solid wood bottom + engraved Start/Goal symbols + optional glue guides)
  const baseRaw: SubPath[] = [outerPlate, ...holes];
  const [sx, sy] = cellCenterLocal(ep.sx, ep.sy, d);
  const [gx, gy] = cellCenterLocal(ep.gx, ep.gy, d);
  const baseMarks: SubPath[] = [
    ...buildStartMarks(sx, sy, d.ch, opts.startSymbol),
    ...buildGoalMarks(gx, gy, d.ch, opts.goalSymbol),
    ...buildGlueGuides(analysis, d, opts.glueGuides),
  ];

  // 2. Stacked maze layers (identical cutout sheets stacked layerCount times)
  const mazeLayerRaw = buildMazeLayerSubs(analysis, d);
  const mazeLayerKerfed = applyKerf(mazeLayerRaw, d.kerf);

  const rawParts: Record<string, SubPath[]> = {};
  const parts: Part[] = [];
  const labels: Record<string, Text> = {};
  const poses: Record<string, Pose> = {};

  let z = 0;

  // Base
  rawParts.base = baseRaw;
  parts.push({
    key: 'base',
    subs: applyKerf(baseRaw, d.kerf),
    at: { x: 0, y: 0 },
    ...(baseMarks.length ? { marks: baseMarks } : {}),
    page: 0,
  });
  labels.base = { code: 'part.base' };
  poses.base = flatPose(0, 0, z);
  z += d.t;

  // Stacked maze wall layers
  for (let i = 1; i <= d.layerCount; i++) {
    const key = `maze-${i}`;
    rawParts[key] = mazeLayerRaw;
    parts.push({
      key,
      subs: mazeLayerKerfed,
      at: { x: 0, y: 0 },
      page: 0,
    });
    labels[key] = d.layerCount === 1 ? { code: 'part.mazeSingle' } : { code: 'part.mazeLayer', values: { n: i } };
    poses[key] = flatPose(0, 0, z);
    z += d.t;
  }

  // Optional clear cover (page 1 when separateCoverPage is enabled so acrylic & wood don't mix!)
  if (d.cover) {
    const coverRaw: SubPath[] = [outerPlate, ...holes];
    rawParts.cover = coverRaw;
    parts.push({
      key: 'cover',
      subs: applyKerf(coverRaw, d.kerf),
      at: { x: 0, y: 0 },
      page: opts.separateCoverPage ? 1 : 0,
    });
    labels.cover = { code: 'part.cover' };
    poses.cover = flatPose(0, 0, z);
    z += d.t;
  }

  // Optional decorative wood top frame / bezel over the clear cover
  if (d.cover && d.topFrame) {
    const winR = Math.min(d.cornerRadius > 0 ? Math.max(1.5, d.cornerRadius - d.border * 0.5) : 0, d.innerW * 0.2, d.innerH * 0.2);
    const windowHole = reverseSubPath(roundedRect(d.innerW, d.innerH, winR));
    const frameRaw: SubPath[] = [outerPlate, windowHole, ...holes];
    rawParts['top-frame'] = frameRaw;
    parts.push({
      key: 'top-frame',
      subs: applyKerf(frameRaw, d.kerf),
      at: { x: 0, y: 0 },
      page: 0,
    });
    labels['top-frame'] = { code: 'part.topFrame' };
    poses['top-frame'] = flatPose(0, 0, z);
  }

  // Nest parts separately per page group
  const gap = Math.max(4, 2 * d.kerf + 3);
  const byPage = new Map<number, Part[]>();
  for (const pt of parts) {
    const pg = pt.page ?? 0;
    let list = byPage.get(pg);
    if (!list) {
      list = [];
      byPage.set(pg, list);
    }
    list.push(pt);
  }
  for (const group of byPage.values()) {
    const placed = host.nest({ parts: group.map((pt) => ({ key: pt.key, subs: pt.subs })), gap });
    for (let i = 0; i < group.length; i++) {
      group[i].at = { x: placed[i][0], y: placed[i][1] };
    }
  }

  return { parts, labels, poses, rawParts };
}
