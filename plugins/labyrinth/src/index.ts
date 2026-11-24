// Labyrinth / Tilt Maze generator plugin for KizamuBeam.
// Generates laser-cut stacked ball-bearing labyrinths (inspired by Tilt Maze) with three workflows:
// 1. Parametric generation (5 algorithms, seed, braid/loop control, auto-diameter endpoints)
// 2. Interactive post-generation wall editing (modeled directly on box-composer-advanced)
// 3. Hand-designed labyrinths from scratch (Empty arena / Full grid + Edit walls & Draw/Carve views).
import {
  definePlugin,
  host,
  mm,
  type Change,
  type EventResult,
  type Issue,
  type Part,
  type SubPath,
  type Text,
} from '../../../sdk/ts';
import { buildMazeAssembly, cornerHoleMinWeb } from './geometry';
import {
  analyzeMaze,
  autoSignature,
  clampEndpoints,
  createGrid,
  defaultEndpoints,
  generateMazeGrid,
  gridToWalls,
  normalizeWalls,
  readEndpoints,
  readWalls,
  wallsToGrid,
  writeEndpoints,
  writeWalls,
} from './maze';
import { planDraw, planPointer, wallHighlight, type MazePlan } from './surface';
import type {
  CornerHoleMode,
  Endpoints,
  GlueGuideMode,
  GoalSymbol,
  LayerCountMode,
  MazeAlgorithm,
  MazeDims,
  MazeGrid,
  MazeParams,
  StartSymbol,
  Wall,
} from './types';

const VALID_ALGS: MazeAlgorithm[] = ['dfs', 'prim', 'kruskal', 'huntKill', 'sidewinder'];

const algOf = (v: string): MazeAlgorithm => (VALID_ALGS.includes(v as MazeAlgorithm) ? (v as MazeAlgorithm) : 'dfs');
const layerModeOf = (v: string): LayerCountMode => (v === 'manual' ? 'manual' : 'auto');
const holeModeOf = (v: string): CornerHoleMode => (v === 'pins' || v === 'screws' ? v : 'none');
const startSymOf = (v: string): StartSymbol => (['dot', 'circle', 'flag', 'none'].includes(v) ? (v as StartSymbol) : 'dot');
const goalSymOf = (v: string): GoalSymbol => (['star', 'target', 'flag', 'none'].includes(v) ? (v as GoalSymbol) : 'star');
const glueModeOf = (v: string): GlueGuideMode => (['islands', 'all', 'none'].includes(v) ? (v as GlueGuideMode) : 'islands');

function readMaterial(): { thickness: number; kerf: number | null; name: string | null } | null {
  const m = host.context('material');
  if (!m || m.thickness == null) return null;
  return { thickness: m.thickness, kerf: m.kerf, name: m.name };
}

function resolveMaterial(p: MazeParams): {
  thickness: number;
  kerf: number;
  materialName: string | null;
  issues: Issue[];
} {
  const issues: Issue[] = [];
  if (!p.fromMaterial) {
    return { thickness: Number(p.thickness) || 3, kerf: Number(p.kerf) || 0, materialName: null, issues };
  }
  const m = readMaterial();
  if (!m) {
    issues.push({ key: 'fromMaterial', level: 'error', code: 'material-none' });
    return { thickness: Number(p.thickness) || 3, kerf: Number(p.kerf) || 0, materialName: null, issues };
  }
  if (Math.abs(m.thickness - p.thickness) > 1e-6 || (m.kerf != null && Math.abs(m.kerf - p.kerf) > 1e-6)) {
    issues.push({ key: 'fromMaterial', level: 'warn', code: 'material-changed', values: { thickness: m.thickness } });
  }
  if (m.kerf == null) {
    issues.push({ key: 'fromMaterial', level: 'warn', code: 'material-no-kerf', values: { kerf: p.kerf } });
  }
  return { thickness: m.thickness, kerf: m.kerf ?? p.kerf, materialName: m.name, issues };
}

/** Compute exact physical dimensions of the stacked tilt maze */
function computeDims(p: MazeParams, thickness: number, kerf: number): MazeDims {
  const cols = Math.max(3, Math.min(24, Math.round(Number(p.cols) || 9)));
  const rows = Math.max(3, Math.min(24, Math.round(Number(p.rows) || 9)));
  const ballDia = Math.max(2, Number(p.ballDia) || 8);
  const ballPlay = Math.max(0.2, Number(p.ballPlay) || 1.5);
  const ch = ballDia + ballPlay;
  const wallW = Math.max(1, Number(p.wallWidth) || 3);
  const pitch = ch + wallW;
  const border = Math.max(2, Number(p.borderWidth) || 8);
  const innerW = cols * ch + (cols - 1) * wallW;
  const innerH = rows * ch + (rows - 1) * wallW;
  const totalW = innerW + 2 * border;
  const totalH = innerH + 2 * border;
  const maxR = Math.min(totalW / 2 - 0.5, totalH / 2 - 0.5, border + ch * 0.45);
  const cornerRadius = Math.max(0, Math.min(Number(p.cornerRadius) || 0, maxR));
  const t = Math.max(0.5, thickness);
  const ballTopPlay = Math.max(0, Number(p.ballTopPlay) || 0);
  const layerCount =
    layerModeOf(p.layerCountMode) === 'manual'
      ? Math.max(1, Math.min(12, Math.round(Number(p.layerCount) || 3)))
      : Math.max(1, Math.min(12, Math.ceil((ballDia + ballTopPlay) / t)));
  const channelDepth = layerCount * t;
  const cover = !!p.cover;
  const coverThickness = Math.max(0.5, Number(p.coverThickness) || 2);
  const topFrame = cover && !!p.topFrame;
  const totalHeight = t + channelDepth + (cover ? coverThickness : 0) + (topFrame ? t : 0);

  return {
    cols,
    rows,
    ballDia,
    ballPlay,
    ch,
    wallW,
    pitch,
    border,
    cornerRadius,
    innerW,
    innerH,
    totalW,
    totalH,
    t,
    kerf: Math.max(0, kerf),
    layerCount,
    channelDepth,
    totalHeight,
    cover,
    coverThickness,
    topFrame,
    cornerHoles: holeModeOf(p.cornerHoles),
    holeDia: Math.max(1, Number(p.holeDia) || 3),
  };
}

/**
 * Resolve the active maze walls, grid, and endpoints from plugin parameters.
 * - In 'auto' mode: if `wallsRef` matches current parametric settings and `walls` parses cleanly, uses `walls`
 *   (allowing direct edits in Step 4's Wall List to apply immediately); otherwise regenerates parametrically.
 * - In 'custom' mode: reads and normalizes `walls` directly (preserving user edits / hand designs).
 */
function resolveMaze(p: MazeParams, d: MazeDims): {
  walls: Wall[];
  grid: MazeGrid;
  endpoints: Endpoints;
  badWalls: boolean;
} {
  const alg = algOf(p.algorithm);
  const seed = Math.max(1, Math.round(Number(p.seed) || 42));
  const braid = Math.max(0, Math.min(60, Math.round(Number(p.braid) || 0)));
  const sig = autoSignature(d.cols, d.rows, alg, seed, braid);
  const parsed = readWalls(p.walls);
  const isCustom = p.wallMode === 'custom';

  let walls: Wall[];
  let grid: MazeGrid;

  if (isCustom) {
    if (parsed === null) {
      grid = createGrid(d.cols, d.rows, false);
      return { walls: [], grid, endpoints: { sx: 0, sy: 0, gx: d.cols - 1, gy: d.rows - 1 }, badWalls: true };
    }
    walls = normalizeWalls(parsed, d.cols, d.rows);
    grid = wallsToGrid(walls, d.cols, d.rows);
  } else if (p.wallsRef === sig && parsed !== null) {
    walls = normalizeWalls(parsed, d.cols, d.rows);
    grid = wallsToGrid(walls, d.cols, d.rows);
  } else {
    grid = generateMazeGrid(d.cols, d.rows, alg, seed, braid);
    walls = gridToWalls(grid);
  }

  const parsedEp = readEndpoints(p.endpoints);
  const endpoints = parsedEp ? clampEndpoints(parsedEp, d.cols, d.rows) : defaultEndpoints(grid, !!p.autoEndpoints);

  return { walls, grid, endpoints, badWalls: false };
}

function buildPlan(p: MazeParams): MazePlan {
  const mat = resolveMaterial(p);
  const d = computeDims(p, mat.thickness, mat.kerf);
  const { walls, endpoints } = resolveMaze(p, d);
  return {
    d,
    walls,
    endpoints,
    algorithm: algOf(p.algorithm),
    seed: Math.max(1, Math.round(Number(p.seed) || 42)),
    braid: Math.max(0, Math.min(60, Math.round(Number(p.braid) || 0))),
    autoEndpoints: !!p.autoEndpoints,
    showSolution: !!p.showSolution,
  };
}

/** Check if every page group fits inside the workArea as one nested block */
function fitsWorkArea(parts: Part[]): boolean {
  const area = host.context('workArea');
  if (!area) return true;
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
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const pt of group) {
      for (const s of pt.subs) {
        for (const n of s.nodes) {
          x0 = Math.min(x0, n.x + pt.at.x);
          x1 = Math.max(x1, n.x + pt.at.x);
          y0 = Math.min(y0, n.y + pt.at.y);
          y1 = Math.max(y1, n.y + pt.at.y);
        }
      }
    }
    const w = x1 - x0;
    const h = y1 - y0;
    if (!((w <= area.width && h <= area.height) || (h <= area.width && w <= area.height))) return false;
  }
  return true;
}

/** Run host.check on generated parts */
function checkCutParts(rawParts: Record<string, SubPath[]>, kerf: number): Issue[] {
  const area = host.context('workArea');
  const found = host.check({
    parts: Object.entries(rawParts).map(([key, subs]) => ({ key, subs })),
    kerf,
    ...(area ? { workArea: area } : {}),
  });
  return found
    .filter((f) => f.level !== 'info')
    .map((f) => ({ level: f.level as 'error' | 'warn', code: f.code, ...(f.values ? { values: f.values } : {}) }));
}

/** Build parametric patch for a given parameter set */
function parametricPatch(p: MazeParams, seedOverride?: number): Record<string, string | number | boolean> {
  const cols = Math.max(3, Math.min(24, Math.round(Number(p.cols) || 9)));
  const rows = Math.max(3, Math.min(24, Math.round(Number(p.rows) || 9)));
  const alg = algOf(p.algorithm);
  const seed = Math.max(1, Math.round(seedOverride ?? (Number(p.seed) || 42)));
  const braid = Math.max(0, Math.min(60, Math.round(Number(p.braid) || 0)));
  const g = generateMazeGrid(cols, rows, alg, seed, braid);
  const walls = gridToWalls(g);
  const ep = defaultEndpoints(g, !!p.autoEndpoints);
  return {
    ...(seedOverride !== undefined ? { seed } : {}),
    walls: writeWalls(walls),
    wallMode: 'auto',
    wallsRef: autoSignature(cols, rows, alg, seed, braid),
    endpoints: writeEndpoints(ep),
  };
}

definePlugin<MazeParams>({
  onChange({ key, params }): Change | null {
    if (key === 'fromMaterial' && params.fromMaterial) {
      const m = readMaterial();
      if (!m) return null;
      return {
        patch: {
          thickness: m.thickness,
          ...(m.kerf != null ? { kerf: m.kerf } : {}),
        },
      };
    }

    const genKeys = ['cols', 'rows', 'algorithm', 'seed', 'braid', 'autoEndpoints'];
    if (genKeys.includes(key)) {
      if (params.wallMode !== 'custom') {
        return { patch: parametricPatch(params) };
      }

      // Custom walls exist! Handle gracefully with a prompt just like box-composer-advanced.
      const cols = Math.max(3, Math.min(24, Math.round(Number(params.cols) || 9)));
      const rows = Math.max(3, Math.min(24, Math.round(Number(params.rows) || 9)));
      const parsed = readWalls(params.walls) ?? [];

      if (key === 'autoEndpoints') {
        const g = wallsToGrid(normalizeWalls(parsed, cols, rows), cols, rows);
        return { patch: { endpoints: writeEndpoints(defaultEndpoints(g, !!params.autoEndpoints)) } };
      }

      if (key === 'cols' || key === 'rows') {
        const keptWalls = normalizeWalls(parsed, cols, rows);
        const keptEp = clampEndpoints(readEndpoints(params.endpoints) ?? { sx: 0, sy: 0, gx: cols - 1, gy: rows - 1 }, cols, rows);
        return {
          ask: {
            question: { code: 'ask.resize' },
            options: [
              {
                label: { code: 'ask.keepWalls' },
                patch: {
                  walls: writeWalls(keptWalls),
                  wallMode: 'custom',
                  wallsRef: `custom:${cols}x${rows}`,
                  endpoints: writeEndpoints(keptEp),
                },
              },
              {
                label: { code: 'ask.generateNew' },
                patch: parametricPatch(params),
              },
            ],
          },
        };
      }

      // algorithm / seed / braid changed while custom walls exist
      return {
        ask: {
          question: { code: 'ask.regenerate' },
          options: [
            { label: { code: 'ask.generateNew' }, patch: parametricPatch(params) },
            { label: { code: 'ask.keepWalls' }, patch: {} },
          ],
        },
      };
    }

    return null;
  },

  onEvent({ action, params, surface }): EventResult | null {
    const cols = Math.max(3, Math.min(24, Math.round(Number(params.cols) || 9)));
    const rows = Math.max(3, Math.min(24, Math.round(Number(params.rows) || 9)));

    if (action === 'generateMaze') {
      return {
        patch: parametricPatch(params),
        select: { walls: -1 },
        ...(surface ? { state: null } : {}),
        message: { code: 'msg.generated' },
      };
    }

    if (action === 'nextSeed') {
      const cur = Math.max(1, Math.round(Number(params.seed) || 42));
      const next = cur >= 99999 ? 1 : cur + 1;
      return {
        patch: parametricPatch(params, next),
        select: { walls: -1 },
        ...(surface ? { state: null } : {}),
        message: { code: 'msg.newSeed', values: { seed: next } },
      };
    }

    if (action === 'emptyArena') {
      const g = createGrid(cols, rows, false);
      const walls = gridToWalls(g);
      const ep = clampEndpoints(readEndpoints(params.endpoints) ?? { sx: 0, sy: 0, gx: cols - 1, gy: rows - 1 }, cols, rows);
      return {
        patch: {
          walls: writeWalls(walls),
          wallMode: 'custom',
          wallsRef: `custom:${cols}x${rows}`,
          endpoints: writeEndpoints(ep),
        },
        select: { walls: -1 },
        ...(surface ? { state: null } : {}),
        message: { code: 'msg.empty' },
      };
    }

    if (action === 'fullGrid') {
      const g = createGrid(cols, rows, true);
      const walls = gridToWalls(g);
      const ep = clampEndpoints(readEndpoints(params.endpoints) ?? { sx: 0, sy: 0, gx: cols - 1, gy: rows - 1 }, cols, rows);
      return {
        patch: {
          walls: writeWalls(walls),
          wallMode: 'custom',
          wallsRef: `custom:${cols}x${rows}`,
          endpoints: writeEndpoints(ep),
        },
        select: { walls: -1 },
        ...(surface ? { state: null } : {}),
        message: { code: 'msg.full' },
      };
    }

    return null;
  },

  view(p) {
    const mat = resolveMaterial(p);
    const d = computeDims(p, mat.thickness, mat.kerf);
    const { walls } = resolveMaze(p, d);
    return {
      rows: {
        walls: walls.map((w): Text => ({
          code: `row.${w.open ? 'open.' : ''}${w.axis}`,
          values: { id: w.id },
        })),
      },
    };
  },

  draw({ params, ...s }) {
    const pl = buildPlan(params);
    return { ...planDraw(pl, s), highlight: wallHighlight(pl, s) };
  },

  onSurface({ event, surface, params }) {
    const pl = buildPlan(params);
    return planPointer(pl, event, surface);
  },

  validate(p) {
    const mat = resolveMaterial(p);
    const issues: Issue[] = [...mat.issues];
    if (issues.some((i) => i.level === 'error')) return issues;

    const d = computeDims(p, mat.thickness, mat.kerf);
    const { grid, endpoints, badWalls } = resolveMaze(p, d);

    if (badWalls) {
      issues.push({ key: 'walls', level: 'error', code: 'walls-bad' });
      return issues;
    }

    if (d.wallW < 1.5) {
      issues.push({ key: 'wallWidth', level: 'error', code: 'wall-thin', values: { min: 1.5 } });
    } else if (d.kerf > 0 && d.wallW < d.kerf * 6) {
      issues.push({ key: 'wallWidth', level: 'warn', code: 'wall-narrow-kerf' });
    }

    if (d.cornerHoles !== 'none') {
      const minWeb = cornerHoleMinWeb(d);
      if (minWeb < 0.8) {
        issues.push({ key: 'holeDia', level: 'error', code: 'hole-too-large', values: { border: d.border } });
      } else if (minWeb < 1.5) {
        issues.push({ key: 'holeDia', level: 'warn', code: 'hole-tight' });
      }
    }

    if (d.channelDepth < d.ballDia) {
      issues.push({
        key: 'layerCount',
        level: 'warn',
        code: 'depth-shallow',
        values: { depth: mm(d.channelDepth), ball: mm(d.ballDia) },
      });
    }

    const analysis = analyzeMaze(grid, endpoints);

    if (!analysis.solvable) {
      issues.push({ key: 'walls', level: 'warn', code: 'maze-unsolvable' });
    }

    if (analysis.islandCount > 0) {
      issues.push({
        key: 'walls',
        level: 'warn',
        code: 'maze-islands',
        values: { count: analysis.islandCount },
      });
    }

    if (d.cover && analysis.openOuterCount > 0) {
      issues.push({ key: 'cover', level: 'warn', code: 'cover-open-outer' });
    }

    if (issues.some((i) => i.level === 'error')) return issues;

    const built = buildMazeAssembly(grid, endpoints, analysis, d, {
      separateCoverPage: !!p.separateCoverPage,
      startSymbol: startSymOf(p.startSymbol),
      goalSymbol: goalSymOf(p.goalSymbol),
      glueGuides: glueModeOf(p.glueGuides),
    });

    issues.push(...checkCutParts(built.rawParts, d.kerf));
    return issues;
  },

  generate(p) {
    const mat = resolveMaterial(p);
    if (mat.issues.some((i) => i.level === 'error')) {
      throw new Error(mat.issues.find((i) => i.level === 'error')!.code);
    }

    const d = computeDims(p, mat.thickness, mat.kerf);
    const { walls, grid, endpoints, badWalls } = resolveMaze(p, d);
    if (badWalls) throw new Error('walls-bad');

    const analysis = analyzeMaze(grid, endpoints);
    const built = buildMazeAssembly(grid, endpoints, analysis, d, {
      separateCoverPage: !!p.separateCoverPage,
      startSymbol: startSymOf(p.startSymbol),
      goalSymbol: goalSymOf(p.goalSymbol),
      glueGuides: glueModeOf(p.glueGuides),
    });

    const interiorCount = walls.filter((w) => !w.open).length;
    const info: [Text, Text][] = [
      ['info.size', `${mm(d.totalW)} × ${mm(d.totalH)} mm`],
      ['info.channel', `${mm(d.ch)} mm (Ø ${mm(d.ballDia)} mm)`],
      ['info.layers', `${d.layerCount} × ${mm(d.t)} mm = ${mm(d.channelDepth)} mm`],
      ['info.totalHeight', `${mm(d.totalHeight)} mm`],
      ['info.walls', String(interiorCount)],
      [
        'info.solution',
        analysis.solvable ? { code: 'info.steps', values: { steps: analysis.solutionSteps } } : { code: 'info.unsolvable' },
      ],
    ];
    if (analysis.islandCount > 0) {
      info.push(['info.islands', String(analysis.islandCount)]);
    }
    if (mat.materialName) {
      info.push(['info.material', `${mat.materialName} · ${mm(d.t)} mm`]);
    }

    const spread = fitsWorkArea(built.parts) ? {} : { distribute: { rotate: false } };

    return {
      parts: built.parts,
      info,
      labels: built.labels,
      poses: { poses: built.poses },
      ...spread,
    };
  },
});
