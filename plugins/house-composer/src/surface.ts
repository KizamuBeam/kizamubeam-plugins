// Multi-view interactive drawing surface for the house composer:
// - 'plan': floor plan editor (planSurface.ts) + roof overhang/ridge lines + architectural door & window symbols
// - 'front' | 'back' | 'left' | 'right' | 'inner': interactive wall elevation editors for placing, dragging,
//   resizing and deleting doors & windows directly on each wall.
import { mm, type Drawing, type EventResult, type Item, type Pointer, type Surface, type Text } from '../../../sdk/ts';
import {
  nextOpeningId,
  safeFrameWidth,
  validateOpenings,
  writeOpenings,
  type Opening,
  type OpeningKind,
  type WallHost,
} from './openings';
import { planDraw, planPointer, selectedId as planSelectedId, type Plan } from './planSurface';
import { roofPlanLines, wallProfile, type OuterWallKey, type RoofSpec } from './roof';
import type { Wall } from './model';

export interface HouseSurfaceCtx {
  plan: Plan;
  W: number;
  D: number;
  H: number;
  t: number;
  floor: boolean;
  roof: RoofSpec;
  openings: Opening[];
  hosts: Map<string, WallHost>;
  engraveFrames: boolean;
  frameWidth: number;
  mullionWidth: number;
  /** True when the outer footprint is non-rectangular (L/U/C shape) */
  isShaped?: boolean;
  /** Interior walls currently built (for 'inner' view and plan opening symbols) */
  innerWalls: { id: number; key: string; axis: 'h' | 'v'; pos: number; s: number; e: number; h: number }[];
}

interface ElevDrag {
  kind: 'move' | 'l' | 'r' | 't' | 'b';
  id: number;
  x0: number;
  y0: number;
  orig: Opening;
}

interface ElevState {
  drag?: ElevDrag;
  openings?: Opening[];
  selId?: number;
  wallKey?: string;
}

const OP_LIST = 'openings';
const WALL_LIST = 'walls';
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

const isElevView = (v: string): v is OuterWallKey | 'inner' =>
  v === 'front' || v === 'back' || v === 'left' || v === 'right' || v === 'inner';

function elevStateOf(s: unknown): ElevState {
  if (s && typeof s === 'object' && ('drag' in s || 'openings' in s || 'selId' in s || 'wallKey' in s)) return s as ElevState;
  return {};
}

/** Which wall key an elevation view currently targets ('front'|'back'|'left'|'right' or 'wall-<id>') */
export function activeWallKey(ctx: HouseSurfaceCtx, s: Surface): string | null {
  if (s.view === 'front' || s.view === 'back' || s.view === 'left' || s.view === 'right') return s.view;
  if (s.view === 'inner') {
    const st = elevStateOf(s.state);
    if (st.wallKey && ctx.innerWalls.some((w) => w.key === st.wallKey)) return st.wallKey;
    const wid = planSelectedId(ctx.plan, s);
    if (wid !== undefined) {
      const found = ctx.innerWalls.find((w) => w.id === wid);
      if (found) return found.key;
    }
    return ctx.innerWalls[0]?.key ?? null;
  }
  return null;
}

/** Currently selected opening id (from state or list selection) */
export function selectedOpeningId(ctx: HouseSurfaceCtx, s: Surface): number | undefined {
  const st = elevStateOf(s.state);
  const ops = st.openings ?? ctx.openings;
  if (st.selId !== undefined && ops.some((o) => o.id === st.selId)) return st.selId;
  const row = s.selected[OP_LIST];
  if (row !== undefined && row >= 0 && row < ops.length) return ops[row].id;
  return undefined;
}

/** Draw architectural door & window symbols + roof overhang/ridge overlay + side labels on top of the floor plan view */
function planOverlayItems(ctx: HouseSurfaceCtx): { items: Item[]; pad: number } {
  const { plan: pl, W, D, t, roof, openings, innerWalls } = ctx;
  const items: Item[] = [];

  // 1. Subtle roof overhang outline and ridge / hip lines (only for rectangular footprints)
  if (!ctx.isShaped) {
    const rl = roofPlanLines(pl.w, pl.d, t, roof);
    items.push({ type: 'line', pts: rl.outline, closed: true, style: 'muted', width: 1, dash: true, alpha: 0.45 });
    for (const [a, b] of rl.ridges) {
      items.push({ type: 'line', pts: [a, b], style: 'muted', width: 1, dash: true, alpha: 0.55 });
    }
  }

  // 2. Subtle side compass labels so the user immediately sees which edge matches Front/Back/Left/Right views
  const maxOh = Math.max(roof.overhang, roof.type === 'gable' || roof.type === 'shed' ? roof.gableOverhang : 0);
  const lblOff = t + Math.max(8, maxOh + 5);
  items.push(
    { type: 'text', x: pl.w / 2, y: pl.d + lblOff, text: { code: 'view.front' }, style: 'muted', align: 'center' },
    { type: 'text', x: pl.w / 2, y: -lblOff, text: { code: 'view.back' }, style: 'muted', align: 'center' },
    { type: 'text', x: -lblOff, y: pl.d / 2, text: { code: 'view.left' }, style: 'muted', angle: 90, align: 'center' },
    { type: 'text', x: pl.w + lblOff, y: pl.d / 2, text: { code: 'view.right' }, style: 'muted', angle: 90, align: 'center' },
  );

  // Helper: draw door swing arc or window glazing line in plan coordinates
  const drawPlanOpening = (
    axis: 'h' | 'v',
    pos: number,
    centerAlong: number,
    w: number,
    kind: OpeningKind,
    inwardSign: -1 | 1,
  ) => {
    const hw = w / 2;
    const pt = (along: number, across: number): [number, number] => (axis === 'h' ? [along, across] : [across, along]);
    if (kind === 'window') {
      const off = t * 0.45;
      items.push(
        { type: 'line', pts: [pt(centerAlong - hw, pos - off), pt(centerAlong + hw, pos - off)], style: 'accent', width: 1.5, alpha: 0.85 },
        { type: 'line', pts: [pt(centerAlong - hw, pos + off), pt(centerAlong + hw, pos + off)], style: 'accent', width: 1.5, alpha: 0.85 },
      );
    } else {
      const hinge = centerAlong - hw;
      const swing = Math.min(w, Math.max(8, w * 0.85)) * inwardSign;
      items.push({ type: 'line', pts: [pt(hinge, pos), pt(hinge, pos + swing)], style: 'accent', width: 1.6, alpha: 0.9 });
      const arc: [number, number][] = [];
      const steps = 10;
      for (let i = 0; i <= steps; i++) {
        const ang = (Math.PI / 2) * (i / steps);
        const a = hinge + Math.cos(ang) * w;
        const c = pos + Math.sin(ang) * swing;
        arc.push(pt(a, c));
      }
      items.push({ type: 'line', pts: arc, style: 'accent', width: 1, dash: true, alpha: 0.75 });
    }
  };

  for (const op of openings) {
    if (op.wall === 'front') drawPlanOpening('h', pl.d + t / 2, op.x - t, op.w, op.kind, -1);
    else if (op.wall === 'back') drawPlanOpening('h', -t / 2, W - t - op.x, op.w, op.kind, 1);
    else if (op.wall === 'left') drawPlanOpening('v', -t / 2, op.x - t, op.w, op.kind, 1);
    else if (op.wall === 'right') drawPlanOpening('v', pl.w + t / 2, D - t - op.x, op.w, op.kind, -1);
    else {
      const iw = innerWalls.find((q) => q.key === op.wall);
      if (iw) drawPlanOpening(iw.axis, iw.pos, iw.s + op.x, op.w, op.kind, 1);
    }
  }

  return { items, pad: Math.max(maxOh + 8, 12) };
}

/** Sample an opening's display polylines in elevation coordinates (x left→right, y down from maxZ to 0) */
function openingElevationItems(
  op: Opening,
  maxZ: number,
  floorZ: number,
  selected: boolean,
  invalid: boolean,
  mullionW: number,
  engraveFrames: boolean,
  frameW: number,
): Item[] {
  const items: Item[] = [];
  const style = invalid ? 'warn' : selected ? 'accent' : 'normal';
  const width = selected || invalid ? 2.2 : 1.4;
  const id = `op:${op.id}`;
  const yBot = maxZ - (floorZ + op.y);
  const yTop = yBot - op.h;
  const xL = op.x - op.w / 2;
  const xR = op.x + op.w / 2;

  const sampleCircle = (cx: number, cy: number, r: number): [number, number][] => {
    const pts: [number, number][] = [];
    const n = 28;
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return pts;
  };

  const sampleArch = (xl: number, xr: number, yt: number, yb: number): [number, number][] => {
    const w = xr - xl,
      h = yb - yt;
    const r = Math.min(w / 2, h / 2);
    const pts: [number, number][] = [[xl, yb]];
    const n = 16;
    const ySpring = yt + r;
    const leftArcCx = xl + r;
    const rightArcCx = xr - r;
    for (let i = 0; i <= n / 2; i++) {
      const a = Math.PI + (Math.PI / 2) * (i / (n / 2));
      pts.push([leftArcCx + r * Math.cos(a), ySpring + r * Math.sin(a)]);
    }
    for (let i = 0; i <= n / 2; i++) {
      const a = (3 * Math.PI) / 2 + (Math.PI / 2) * (i / (n / 2));
      pts.push([rightArcCx + r * Math.cos(a), ySpring + r * Math.sin(a)]);
    }
    pts.push([xr, yb]);
    return pts;
  };

  // Optional subtle frame outline preview (matching exact clamped engraved frame & window sill / double-door pediment)
  if (engraveFrames && frameW > 0.2) {
    if (op.style === 'round') {
      const r = Math.min(op.w, op.h) / 2;
      items.push({ type: 'line', pts: sampleCircle(op.x, (yTop + yBot) / 2, r + frameW), closed: true, style: 'muted', width: 0.8, alpha: 0.55 });
    } else if (op.style === 'arch') {
      const pts = sampleArch(xL - frameW, xR + frameW, yTop - frameW, op.kind === 'door' ? yBot : yBot + frameW);
      items.push({ type: 'line', pts, closed: op.kind !== 'door', style: 'muted', width: 0.8, alpha: 0.55 });
      if (op.kind !== 'door') {
        items.push({ type: 'line', pts: [[xL - frameW * 1.4, yBot + frameW], [xR + frameW * 1.4, yBot + frameW]], style: 'muted', width: 0.9, alpha: 0.55 });
      }
    } else if (op.kind === 'door') {
      items.push({
        type: 'line',
        pts: [[xL - frameW, yBot], [xL - frameW, yTop - frameW], [xR + frameW, yTop - frameW], [xR + frameW, yBot]],
        style: 'muted',
        width: 0.8,
        alpha: 0.55,
      });
      if (op.style === 'double') {
        items.push({
          type: 'line',
          pts: [[xL - frameW * 1.5, yTop - frameW * 1.6], [xR + frameW * 1.5, yTop - frameW * 1.6]],
          style: 'muted',
          width: 0.9,
          alpha: 0.55,
        });
      }
    } else {
      items.push(
        {
          type: 'line',
          pts: [[xL - frameW, yTop - frameW], [xR + frameW, yTop - frameW], [xR + frameW, yBot + frameW], [xL - frameW, yBot + frameW]],
          closed: true,
          style: 'muted',
          width: 0.8,
          alpha: 0.55,
        },
        {
          type: 'line',
          pts: [[xL - frameW * 1.4, yBot + frameW * 1.3], [xR + frameW * 1.4, yBot + frameW * 1.3]],
          style: 'muted',
          width: 0.9,
          alpha: 0.55,
        },
      );
    }
  }

  // Main opening outline (hittable!)
  if (op.style === 'round') {
    const r = Math.min(op.w, op.h) / 2;
    items.push({ type: 'line', pts: sampleCircle(op.x, (yTop + yBot) / 2, r), closed: true, style, width, id });
  } else if (op.style === 'arch') {
    items.push({ type: 'line', pts: sampleArch(xL, xR, yTop, yBot), closed: true, style, width, id });
  } else {
    items.push({ type: 'line', pts: [[xL, yTop], [xR, yTop], [xR, yBot], [xL, yBot]], closed: true, style, width, id });
    if (op.style === 'cross' && op.w > mullionW + 4 && op.h > mullionW + 4) {
      items.push(
        { type: 'line', pts: [[op.x, yTop], [op.x, yBot]], style, width: 1.2, id },
        { type: 'line', pts: [[xL, (yTop + yBot) / 2], [xR, (yTop + yBot) / 2]], style, width: 1.2, id },
      );
    } else if (op.style === 'grid') {
      const cols = op.w > op.h * 1.2 ? 3 : 2;
      const rows = op.w > op.h * 1.2 ? 2 : 3;
      for (let c = 1; c < cols; c++) {
        const mx = xL + (op.w * c) / cols;
        items.push({ type: 'line', pts: [[mx, yTop], [mx, yBot]], style, width: 1, id });
      }
      for (let r = 1; r < rows; r++) {
        const my = yTop + (op.h * r) / rows;
        items.push({ type: 'line', pts: [[xL, my], [xR, my]], style, width: 1, id });
      }
    } else if (op.style === 'double') {
      items.push({ type: 'line', pts: [[op.x, yTop], [op.x, yBot]], style, width: 1.1, dash: op.kind === 'door', id });
    }
  }

  // Center hit cross / label for easy dragging even inside large openings
  items.push({
    type: 'line',
    pts: [[xL + 1, yTop + 1], [xR - 1, yBot - 1]],
    style,
    width: 0.6,
    alpha: selected ? 0.25 : 0.1,
    id,
  });

  // Resize handles on the selected opening
  if (selected) {
    const ym = (yTop + yBot) / 2;
    items.push(
      { type: 'handle', x: xL, y: ym, id: `h:l:${op.id}`, style: 'accent' },
      { type: 'handle', x: xR, y: ym, id: `h:r:${op.id}`, style: 'accent' },
      { type: 'handle', x: op.x, y: yTop, id: `h:t:${op.id}`, style: 'accent' },
    );
    if (op.kind === 'window') {
      items.push({ type: 'handle', x: op.x, y: yBot, id: `h:b:${op.id}`, style: 'accent' });
    }
  }

  return items;
}

/** Draw an elevation view ('front' | 'back' | 'left' | 'right' | 'inner') */
function elevationDraw(ctx: HouseSurfaceCtx, s: Surface): Drawing {
  const wk = activeWallKey(ctx, s);
  const host = wk ? ctx.hosts.get(wk) : undefined;
  if (!wk || !host) {
    return {
      frame: { x0: 0, y0: 0, x1: 120, y1: 60 },
      items: [
        {
          type: 'text',
          x: 60,
          y: 30,
          text: { code: s.view === 'inner' ? 'elev.no-inner' : 'elev.wall-off' },
          style: 'muted',
          align: 'center',
        },
      ],
    };
  }

  const st = elevStateOf(s.state);
  const ops = st.openings ?? ctx.openings;
  const wallOps = ops.filter((o) => o.wall === wk);
  const selId = selectedOpeningId(ctx, s);
  const sel = wallOps.find((o) => o.id === selId);

  // Live validation of openings on this wall so collisions/overlaps glow in 'warn' style immediately while dragging
  const wallIssues = validateOpenings(wallOps, new Map([[wk, host]]), ctx.t, ctx.mullionWidth).filter((i) => i.level === 'error');
  const invalidIds = new Set<number>();
  for (const iss of wallIssues) {
    if (typeof iss.values?.id === 'number') invalidIds.add(iss.values.id);
    if (typeof iss.values?.id2 === 'number') invalidIds.add(iss.values.id2);
  }

  const L = host.width;
  const maxZ = host.maxZ;
  const floorZ = host.floorZ;
  const sillZ = host.sillZ;
  const padX = Math.max(18, L * 0.14);
  const padY = Math.max(16, maxZ * 0.16);
  const hasInnerPicker = s.view === 'inner' && ctx.innerWalls.length > 0;
  const topExtra = hasInnerPicker ? Math.max(14, maxZ * 0.16) : 0;
  const items: Item[] = [];

  // 0. Clickable interior-wall selector pills above the wall in 'inner' view
  if (hasInnerPicker) {
    const pillH = Math.max(7, Math.min(11, maxZ * 0.13));
    const pillW = Math.max(14, Math.min(24, L / Math.max(3, ctx.innerWalls.length + 0.6)));
    const gap = Math.max(2.5, pillW * 0.18);
    const totalW = ctx.innerWalls.length * pillW + (ctx.innerWalls.length - 1) * gap;
    const startX = (L - totalW) / 2;
    const yMidPill = -padY * 0.45 - pillH * 0.4;
    const y0p = yMidPill - pillH / 2;
    const y1p = yMidPill + pillH / 2;
    ctx.innerWalls.forEach((iw, idx) => {
      const x0p = startX + idx * (pillW + gap);
      const x1p = x0p + pillW;
      const active = iw.key === wk;
      const pid = `pickwall:${iw.id}`;
      items.push(
        {
          type: 'line',
          pts: [[x0p, y0p], [x1p, y0p], [x1p, y1p], [x0p, y1p]],
          closed: true,
          style: active ? 'accent' : 'muted',
          width: active ? 1.8 : 1,
          id: pid,
        },
        {
          type: 'text',
          x: (x0p + x1p) / 2,
          y: yMidPill,
          text: { code: 'part.wall', values: { id: iw.id } },
          style: active ? 'accent' : 'muted',
          align: 'center',
        },
      );
    });
  }

  // 1. Wall outer silhouette polygon (y = maxZ - Z); for shaped outer walls, highlight actually built spans!
  if (host.spans?.length) {
    // Full bounding box as faint dashed guide so cut-out corners are clearly visible
    items.push({ type: 'line', pts: [[0, 0], [L, 0], [L, maxZ], [0, maxZ]], closed: true, style: 'muted', width: 1, dash: true, alpha: 0.35 });
    for (const [sa, sb] of host.spans) {
      items.push({ type: 'line', pts: [[sa, 0], [sb, 0], [sb, maxZ], [sa, maxZ]], closed: true, style: 'normal', width: 2 });
    }
  } else {
    const topPts: [number, number][] =
      wk === 'front' || wk === 'back' || wk === 'left' || wk === 'right'
        ? wallProfile(wk, ctx.W, ctx.D, ctx.H, ctx.t, ctx.roof).topPoints.map(([x, z]) => [x, maxZ - z])
        : [[0, 0], [L, 0]];
    const wallPoly: [number, number][] = [...topPts, [L, maxZ], [0, maxZ]];
    items.push({ type: 'line', pts: wallPoly, closed: true, style: 'normal', width: 2 });
  }

  // 2. Floor band at bottom (Z = 0..t) and solid threshold line (Z = sillZ)
  if (floorZ > 0) {
    const yf = maxZ - floorZ;
    items.push({ type: 'line', pts: [[0, yf], [L, yf]], style: 'muted', width: 1, dash: true, alpha: 0.7 });
  }
  if (sillZ > floorZ) {
    const ys = maxZ - sillZ;
    items.push({ type: 'line', pts: [[0, ys], [L, ys]], style: 'muted', width: 0.8, dash: true, alpha: 0.4 });
  }

  // 3. Eaves reference line when wall rises above H (gable / shed)
  if (maxZ > ctx.H + 0.5 && wk !== 'inner' && !wk.startsWith('wall-')) {
    const ye = maxZ - ctx.H;
    items.push({ type: 'line', pts: [[0, ye], [L, ye]], style: 'muted', width: 0.9, dash: true, alpha: 0.45 });
  }

  // 4. Corner joint bands (left & right)
  if (host.marginLeft > 0) {
    items.push({ type: 'line', pts: [[host.marginLeft, maxZ - host.zAt(host.marginLeft)], [host.marginLeft, maxZ]], style: 'muted', width: 0.8, dash: true, alpha: 0.35 });
  }
  if (host.marginRight > 0) {
    const xr = L - host.marginRight;
    items.push({ type: 'line', pts: [[xr, maxZ - host.zAt(xr)], [xr, maxZ]], style: 'muted', width: 0.8, dash: true, alpha: 0.35 });
  }

  // 5. Interior wall T-joint vertical guides
  for (const jx of host.jointXs) {
    const yTopJ = maxZ - Math.min(host.zAt(jx), ctx.H);
    items.push({ type: 'line', pts: [[jx, yTopJ], [jx, maxZ - floorZ]], style: 'warn', width: 1, dash: true, alpha: 0.5 });
  }

  // 6. Wall overall width & height reference labels
  items.push({
    type: 'text',
    x: L / 2,
    y: maxZ + padY * 0.45,
    text: `${mm(L)} mm`,
    style: 'muted',
    align: 'center',
  });
  items.push({
    type: 'text',
    x: -padX * 0.45,
    y: maxZ / 2,
    text: `${mm(maxZ)} mm`,
    style: 'muted',
    angle: 90,
    align: 'center',
  });

  // 7. Doors & windows on this wall (unselected first, selected on top) with exact clamped engraved frame width
  const frameFor = (op: Opening) => (ctx.engraveFrames ? safeFrameWidth(op, host, wallOps, ctx.frameWidth, ctx.t) : 0);
  for (const op of wallOps) {
    if (op.id === sel?.id) continue;
    items.push(...openingElevationItems(op, maxZ, sillZ, false, invalidIds.has(op.id), ctx.mullionWidth, ctx.engraveFrames, frameFor(op)));
  }
  if (sel) {
    items.push(...openingElevationItems(sel, maxZ, sillZ, true, invalidIds.has(sel.id), ctx.mullionWidth, ctx.engraveFrames, frameFor(sel)));
    // Dimension lines for the selected opening
    const yBot = maxZ - (sillZ + sel.y);
    const yTop = yBot - sel.h;
    const xL = sel.x - sel.w / 2;
    const xR = sel.x + sel.w / 2;
    const ym = (yTop + yBot) / 2;

    // Distance from left edge
    if (xL > 2) {
      items.push(
        { type: 'line', pts: [[0, ym], [xL, ym]], style: 'accent', width: 0.8, dash: true, alpha: 0.65 },
        { type: 'text', x: xL / 2, y: ym, text: `${mm(r1(xL))}`, style: 'accent', align: 'center', bubble: true },
      );
    }
    // Distance from right edge (makes symmetric placement instantly verifiable)
    if (L - xR > 2) {
      items.push(
        { type: 'line', pts: [[xR, ym], [L, ym]], style: 'accent', width: 0.8, dash: true, alpha: 0.65 },
        { type: 'text', x: (xR + L) / 2, y: ym, text: `${mm(r1(L - xR))}`, style: 'accent', align: 'center', bubble: true },
      );
    }
    // Width × height label
    items.push({
      type: 'text',
      x: sel.x,
      y: yTop - Math.max(4, maxZ * 0.05),
      text: `${mm(r1(sel.w))} × ${mm(r1(sel.h))}`,
      style: invalidIds.has(sel.id) ? 'warn' : 'accent',
      align: 'center',
      bubble: true,
    });
    // Sill height (for windows above threshold)
    if (sel.y > 0.5) {
      const ySill = maxZ - sillZ;
      items.push(
        { type: 'line', pts: [[sel.x, yBot], [sel.x, ySill]], style: 'accent', width: 0.8, dash: true, alpha: 0.65 },
        { type: 'text', x: sel.x, y: (yBot + ySill) / 2, text: `${mm(r1(sel.y))}`, style: 'accent', align: 'center', bubble: true },
      );
    }
  }

  // Right-column live number fields for the selected opening
  const fields: Drawing['fields'] = sel
    ? [
        { id: 'ox', label: { code: 'field.ox' }, value: r2(sel.x), min: 1, max: L - 1 },
        { id: 'oy', label: { code: 'field.oy' }, value: r2(sel.y), min: 0, max: Math.max(0, maxZ - sillZ - 4) },
        { id: 'ow', label: { code: 'field.ow' }, value: r2(sel.w), min: 4, max: L },
        { id: 'oh', label: { code: 'field.oh' }, value: r2(sel.h), min: 4, max: Math.max(4, maxZ - sillZ) },
      ]
    : undefined;

  return {
    frame: { x0: -padX, y0: -padY * 0.75 - topExtra, x1: L + padX, y1: maxZ + padY * 0.85 },
    items,
    ...(fields ? { fields } : {}),
  };
}

/** Snap horizontal center x to wall center, room centers, other openings, symmetric mirrors, or 1 mm grid */
function snapX(x: number, host: WallHost, others: Opening[], snapDist: number): number {
  const targets: number[] = [host.width / 2];
  const cuts = [host.marginLeft, ...[...host.jointXs].sort((a, b) => a - b), host.width - host.marginRight];
  for (let i = 0; i + 1 < cuts.length; i++) targets.push((cuts[i] + cuts[i + 1]) / 2);
  for (const o of others) {
    targets.push(o.x);
    targets.push(host.width - o.x); // symmetric counterpart across wall center!
  }
  for (const tg of targets) {
    if (Math.abs(x - tg) <= snapDist) return r2(tg);
  }
  return Math.round(x);
}

/** Snap vertical sill y to floor (0), other windows' sill/top alignments, or 1 mm grid */
function snapY(y: number, h: number, others: Opening[], snapDist: number): number {
  if (Math.abs(y) <= snapDist) return 0;
  for (const o of others) {
    if (Math.abs(y - o.y) <= snapDist) return r2(o.y);
    if (Math.abs(y + h - (o.y + o.h)) <= snapDist) return r2(Math.max(0, o.y + o.h - h));
  }
  return Math.max(0, Math.round(y));
}

function clampOpeningToHost(op: Opening, host: WallHost, t: number): Opening {
  const web = Math.max(2, t);
  const minX = host.marginLeft + web + op.w / 2;
  const maxX = host.width - host.marginRight - web - op.w / 2;
  const x = minX <= maxX ? Math.max(minX, Math.min(maxX, op.x)) : host.width / 2;
  const maxTop = host.zAt(x) - host.topJointMargin - web;
  const maxY = Math.max(0, maxTop - host.sillZ - op.h);
  const y = Math.max(0, Math.min(maxY, op.y));
  return { ...op, x: r2(x), y: r2(y), w: r2(op.w), h: r2(op.h) };
}

function openingMsg(op: Opening): Text {
  return {
    code: op.kind === 'door' ? 'elev.info.door' : 'elev.info.window',
    values: { id: op.id, x: mm(op.x), y: mm(op.y), w: mm(op.w), h: mm(op.h) },
  };
}

/** Handle pointer, field and keyboard events in an elevation view */
function elevationPointer(ctx: HouseSurfaceCtx, ev: Pointer, s: Surface): EventResult | null {
  const wk = activeWallKey(ctx, s);
  const host = wk ? ctx.hosts.get(wk) : undefined;
  if (!wk || !host) return null;

  const st = elevStateOf(s.state);
  const base = st.openings ?? ctx.openings;
  const maxZ = host.maxZ;
  const sillZ = host.sillZ;
  const snapDist = Math.max(2, ctx.t);
  const rowOf = (ops: Opening[], id: number | undefined) => (id === undefined ? -1 : ops.findIndex((o) => o.id === id));
  const keepWall = s.view === 'inner' ? { wallKey: wk } : {};

  const commit = (ops: Opening[], selId: number | undefined, msg?: Text): EventResult => ({
    patch: { [OP_LIST]: writeOpenings(ops) },
    state: selId !== undefined || s.view === 'inner' ? { ...keepWall, ...(selId !== undefined ? { selId } : {}) } : null,
    select: { [OP_LIST]: rowOf(ops, selId) },
    ...(msg !== undefined ? { message: msg } : {}),
  });

  if (ev.type === 'select' && ev.list === OP_LIST) {
    const op = ev.row !== undefined ? base[ev.row] : undefined;
    return op ? { state: { ...keepWall, selId: op.id }, message: openingMsg(op) } : { state: s.view === 'inner' ? keepWall : null, message: '' };
  }

  if (ev.type === 'down') {
    // Clicking an interior-wall selector pill in 'inner' view switches directly to that interior wall
    const wMatch = /^pickwall:(\d+)$/.exec(ev.hit ?? '');
    if (wMatch) {
      const targetId = Number(wMatch[1]);
      const targetWall = ctx.innerWalls.find((w) => w.id === targetId);
      if (targetWall) {
        const wallRow = ctx.plan.layout.walls.findIndex((w: Wall) => w.id === targetId);
        return {
          state: { wallKey: targetWall.key },
          select: { [OP_LIST]: -1, ...(wallRow >= 0 ? { [WALL_LIST]: wallRow } : {}) },
          message: { code: 'part.wall', values: { id: targetId } },
        };
      }
    }

    const hMatch = /^h:([lrtb]):(\d+)$/.exec(ev.hit ?? '');
    if (hMatch) {
      const id = Number(hMatch[2]);
      const orig = base.find((o) => o.id === id);
      if (!orig) return null;
      return {
        state: {
          ...keepWall,
          drag: { kind: hMatch[1] as ElevDrag['kind'], id, x0: ev.x, y0: ev.y, orig },
          openings: base,
          selId: id,
        },
        select: { [OP_LIST]: rowOf(base, id) },
        message: openingMsg(orig),
      };
    }
    const oMatch = /^op:(\d+)$/.exec(ev.hit ?? '');
    if (oMatch) {
      const id = Number(oMatch[1]);
      const orig = base.find((o) => o.id === id);
      if (!orig) return null;
      return {
        state: {
          ...keepWall,
          drag: { kind: 'move', id, x0: ev.x, y0: ev.y, orig },
          openings: base,
          selId: id,
        },
        select: { [OP_LIST]: rowOf(base, id) },
        message: openingMsg(orig),
      };
    }
    return { state: s.view === 'inner' ? keepWall : null, select: { [OP_LIST]: -1 }, message: '' };
  }

  if (ev.type === 'move' && st.drag) {
    const g = st.drag;
    const dx = ev.x - g.x0;
    const dy = ev.y - g.y0; // y down, so moving mouse UP (dy < 0) INCREASES Z / height!
    const others = base.filter((o) => o.wall === wk && o.id !== g.id);
    let next: Opening = { ...g.orig };

    if (g.kind === 'move') {
      const nx = ev.alt ? r1(g.orig.x + dx) : snapX(g.orig.x + dx, host, others, snapDist);
      const rawY = g.orig.kind === 'door' && !ev.shift ? 0 : Math.max(0, g.orig.y - dy);
      const ny = g.orig.kind === 'door' && !ev.shift ? 0 : ev.alt ? r1(rawY) : snapY(rawY, g.orig.h, others, snapDist);
      next = clampOpeningToHost({ ...g.orig, x: nx, y: ny }, host, ctx.t);
    } else if (g.kind === 'l') {
      const rightEdge = g.orig.x + g.orig.w / 2;
      const newLeft = Math.min(rightEdge - 6, Math.round(g.orig.x - g.orig.w / 2 + dx));
      const nw = rightEdge - newLeft;
      next = clampOpeningToHost({ ...g.orig, x: newLeft + nw / 2, w: nw }, host, ctx.t);
    } else if (g.kind === 'r') {
      const leftEdge = g.orig.x - g.orig.w / 2;
      const newRight = Math.max(leftEdge + 6, Math.round(g.orig.x + g.orig.w / 2 + dx));
      const nw = newRight - leftEdge;
      next = clampOpeningToHost({ ...g.orig, x: leftEdge + nw / 2, w: nw }, host, ctx.t);
    } else if (g.kind === 't') {
      const nh = Math.max(6, Math.round(g.orig.h - dy));
      next = clampOpeningToHost({ ...g.orig, h: nh }, host, ctx.t);
    } else if (g.kind === 'b') {
      const topY = g.orig.y + g.orig.h;
      const newY = Math.max(0, Math.min(topY - 6, Math.round(g.orig.y - dy)));
      next = clampOpeningToHost({ ...g.orig, y: newY, h: topY - newY }, host, ctx.t);
    }

    const updated = base.map((o) => (o.id === g.id ? next : o));
    return { state: { ...st, ...keepWall, openings: updated, selId: g.id }, message: openingMsg(next) };
  }

  if (ev.type === 'up' && st.drag) {
    const cur = st.openings ?? base;
    if (JSON.stringify(cur) === JSON.stringify(ctx.openings)) {
      return { state: { ...keepWall, selId: st.drag.id } };
    }
    const sel = cur.find((o) => o.id === st.drag!.id);
    return commit(cur, st.drag.id, sel ? openingMsg(sel) : undefined);
  }

  if (ev.type === 'dblclick') {
    if (ev.hit) return null;
    if (ev.x < 0 || ev.x > host.width || ev.y < 0 || ev.y > maxZ) return null;
    const clickZ = maxZ - ev.y;
    const clearH = Math.max(12, host.zAt(ev.x) - sillZ - host.topJointMargin - Math.max(2, ctx.t));
    const nearFloor = clickZ <= sillZ + clearH * 0.25;
    const isDoor = !!ev.shift || nearFloor;
    const w = isDoor ? Math.min(22, Math.max(8, host.width * 0.22)) : Math.min(18, Math.max(8, host.width * 0.18));
    const h = isDoor ? Math.min(40, Math.max(12, clearH * 0.7)) : Math.min(20, Math.max(8, clearH * 0.38));
    const others = base.filter((o) => o.wall === wk);
    const sx = snapX(ev.x, host, others, snapDist);
    const sy = isDoor ? 0 : snapY(Math.max(2, clickZ - sillZ - h / 2), h, others, snapDist);
    const created = clampOpeningToHost(
      { id: nextOpeningId(base), wall: wk, kind: isDoor ? 'door' : 'window', style: isDoor ? 'rect' : 'cross', x: sx, y: sy, w: r1(w), h: r1(h) },
      host,
      ctx.t,
    );
    const errs = validateOpenings([...others, created], new Map([[wk, host]]), ctx.t, ctx.mullionWidth).filter((i) => i.level === 'error');
    if (errs.length) return { message: { code: errs[0].code, ...(errs[0].values ? { values: errs[0].values } : {}) } };
    return commit([...base, created], created.id, openingMsg(created));
  }

  if (ev.type === 'context') {
    const m = /^op:(\d+)$/.exec(ev.hit ?? '');
    if (!m) return null;
    const id = Number(m[1]);
    return commit(base.filter((o) => o.id !== id), undefined, '');
  }

  if (ev.type === 'field' && ev.value !== undefined) {
    const selId = selectedOpeningId(ctx, s);
    const cur = base.find((o) => o.id === selId && o.wall === wk);
    if (!cur) return null;
    const next: Opening = {
      ...cur,
      ...(ev.field === 'ox' ? { x: r2(ev.value) } : {}),
      ...(ev.field === 'oy' ? { y: r2(Math.max(0, ev.value)) } : {}),
      ...(ev.field === 'ow' ? { w: r2(Math.max(4, ev.value)) } : {}),
      ...(ev.field === 'oh' ? { h: r2(Math.max(4, ev.value)) } : {}),
    };
    return commit(base.map((o) => (o.id === cur.id ? next : o)), cur.id, openingMsg(next));
  }

  if (ev.type === 'key' && ev.key === 'Escape') {
    return { state: s.view === 'inner' ? keepWall : null, select: { [OP_LIST]: -1 }, message: '' };
  }

  if (ev.type === 'key' && (ev.key === 'Delete' || ev.key === 'Backspace')) {
    const selId = selectedOpeningId(ctx, s);
    if (selId === undefined) return null;
    return commit(base.filter((o) => o.id !== selId), undefined, '');
  }

  return null;
}

/** Draw the active view of the house composer surface */
export function houseDraw(ctx: HouseSurfaceCtx, s: Surface & { have: string[]; size?: { width: number; height: number } }): Drawing {
  if (isElevView(s.view)) return elevationDraw(ctx, s);
  const base = planDraw(ctx.plan, s);
  const { items: overlay, pad } = planOverlayItems(ctx);
  const extraPad = Math.max(0, pad - 4);
  return {
    ...base,
    frame: {
      x0: base.frame.x0 - extraPad,
      y0: base.frame.y0 - extraPad,
      x1: base.frame.x1 + extraPad,
      y1: base.frame.y1 + extraPad,
    },
    items: [...overlay, ...base.items],
  };
}

/** Handle events on the active view of the house composer surface */
export function housePointer(ctx: HouseSurfaceCtx, ev: Pointer, s: Surface): EventResult | null {
  // Selecting a row in the openings list switches directly to that opening's wall view if needed!
  if (ev.type === 'select' && ev.list === OP_LIST && ev.row !== undefined && ev.row >= 0) {
    const op = ctx.openings[ev.row];
    if (op) {
      const targetView = op.wall.startsWith('wall-') ? 'inner' : op.wall;
      const wallRow = op.wall.startsWith('wall-')
        ? ctx.plan.layout.walls.findIndex((w: Wall) => `wall-${w.id}` === op.wall)
        : undefined;
      return {
        view: targetView,
        state: { selId: op.id },
        select: { [OP_LIST]: ev.row, ...(wallRow !== undefined && wallRow >= 0 ? { [WALL_LIST]: wallRow } : {}) },
        message: openingMsg(op),
      };
    }
  }

  if (isElevView(s.view)) return elevationPointer(ctx, ev, s);
  return planPointer(ctx.plan, ev, s);
}

export { planSelectedId };
