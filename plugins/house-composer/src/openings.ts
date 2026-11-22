// Doors and windows for the house composer: data model, JSON read/write, preset generation, validation against wall
// silhouettes and joints, laser cutout shapes (rect, arch, round, cross, grid, double) and engraved frame marks.
// Pure computation, no host functions, so it can be tested in Node.
import { circle, K, polygon, type Node, type SubPath } from '../../../sdk/ts';
import type { OuterWallKey, RoofSpec, WallProfile } from './roof';
import { wallProfile } from './roof';

export type OpeningKind = 'door' | 'window';
export type OpeningStyle = 'rect' | 'arch' | 'cross' | 'grid' | 'round' | 'double';

export const OUTER_WALLS: OuterWallKey[] = ['front', 'back', 'left', 'right'];
export const OPENING_KINDS: OpeningKind[] = ['door', 'window'];
export const OPENING_STYLES: OpeningStyle[] = ['rect', 'arch', 'cross', 'grid', 'round', 'double'];

export interface Opening {
  id: number;
  /** 'front' | 'back' | 'left' | 'right' or 'wall-<id>' for an interior wall */
  wall: string;
  kind: OpeningKind;
  style: OpeningStyle;
  /** Horizontal center along the wall (mm, from left edge when viewed from outside) */
  x: number;
  /** Bottom sill height above interior floor (mm); doors typically sit at 0 */
  y: number;
  /** Width in mm */
  w: number;
  /** Height in mm */
  h: number;
}

export interface OpeningIssue {
  key?: string;
  level: 'error' | 'warn';
  code: string;
  values?: Record<string, number | string>;
}

/** Description of a wall surface that can host openings (outer wall or interior wall) */
export interface WallHost {
  key: string;
  width: number;
  /** Interior floor top elevation (t if floor enabled, 0 otherwise) */
  floorZ: number;
  /** Lowest valid cutout Z: floorZ + solid threshold when floor is enabled (keeps floor finger joints intact), 0 when floor is off */
  sillZ: number;
  /** Top height Z(x) in exterior coordinates x ∈ [0, width] */
  zAt: (x: number) => number;
  maxZ: number;
  /** Horizontal centers (in exterior wall coords) of perpendicular wall joints (T-joints / crossings) on this wall */
  jointXs: number[];
  /** Left & right edge corner-joint margin (t if joined to perpendicular wall, 0 if open/free) */
  marginLeft: number;
  marginRight: number;
  /** Whether top edge has roof/lid joints requiring extra margin */
  topJointMargin: number;
  /** Built horizontal stretches in exterior coords (for shaped L/U/C outer walls; undefined = full [0, width]) */
  spans?: [number, number][];
}

export const MAX_OPENINGS = 80;
const MAX_TEXT = 100_000;
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Minimum horizontal and vertical web between openings and wall boundaries */
export const webMin = (t: number) => Math.max(2, t);

/** Lowest valid cutout Z on a wall: above floor plate + solid threshold when floor is on, 0 when floor is off */
export const sillBaseZ = (floor: boolean, t: number) => (floor ? t + webMin(t) : 0);

export const isOuterWall = (w: string): w is OuterWallKey => (OUTER_WALLS as string[]).includes(w);

/** Default openings for a brand-new 120 × 90 × 70 mm house: front door + balanced windows on all four walls */
export function defaultOpenings(W = 120, D = 90, H = 70, t = 3): Opening[] {
  return classicFacadePreset(W, D, H, t);
}

/** Generate a balanced classic house facade (front door + symmetrically placed windows) scaled to W × D × H */
export function classicFacadePreset(W: number, D: number, H: number, t: number, floor = true): Opening[] {
  const sillZ = sillBaseZ(floor, t);
  const clearH = Math.max(12, H - sillZ - webMin(t));
  const out: Opening[] = [];
  let id = 1;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

  // Front door centered on front wall
  const dw = r2(clamp(W * 0.18, 12, Math.min(36, W - 4 * t)));
  const dh = r2(clamp(clearH * 0.66, 16, Math.max(16, clearH - t)));
  const canDoor = dw >= 10 && dh >= 12 && W >= dw + 4 * t && clearH >= dh + 2;
  if (canDoor) {
    out.push({ id: id++, wall: 'front', kind: 'door', style: 'rect', x: r2(W / 2), y: 0, w: dw, h: dh });
  }

  // Front flanking windows if enough room beside the door
  const ww = r2(clamp(W * 0.15, 10, 26));
  const wh = r2(clamp(clearH * 0.34, 10, Math.min(28, clearH - 2 * t)));
  const wy = r2(clamp(clearH * 0.28, 4, Math.max(4, clearH - wh - t - 1)));
  const sideSpace = (W - (canDoor ? dw : 0)) / 2 - 2 * t;
  if (canDoor && sideSpace >= ww + 2 * t && wh >= 8 && wy + wh <= clearH - t) {
    const leftX = r2(t + (W / 2 - dw / 2 - t) / 2);
    const rightX = r2(W - leftX);
    out.push({ id: id++, wall: 'front', kind: 'window', style: 'cross', x: leftX, y: wy, w: ww, h: wh });
    out.push({ id: id++, wall: 'front', kind: 'window', style: 'cross', x: rightX, y: wy, w: ww, h: wh });
  }

  // Back wall: 1 or 2 windows
  if (W >= ww + 4 * t && wh >= 8 && wy + wh <= clearH - t) {
    if (W >= 2 * ww + 7 * t) {
      out.push({ id: id++, wall: 'back', kind: 'window', style: 'cross', x: r2(W * 0.3), y: wy, w: ww, h: wh });
      out.push({ id: id++, wall: 'back', kind: 'window', style: 'cross', x: r2(W * 0.7), y: wy, w: ww, h: wh });
    } else {
      out.push({ id: id++, wall: 'back', kind: 'window', style: 'cross', x: r2(W / 2), y: wy, w: ww, h: wh });
    }
  }

  // Left & Right walls: 1 centered window each
  const sw = r2(clamp(D * 0.2, 10, Math.min(24, D - 4 * t)));
  if (D >= sw + 4 * t && wh >= 8 && wy + wh <= clearH - t) {
    out.push({ id: id++, wall: 'left', kind: 'window', style: 'cross', x: r2(D / 2), y: wy, w: sw, h: wh });
    out.push({ id: id++, wall: 'right', kind: 'window', style: 'cross', x: r2(D / 2), y: wy, w: sw, h: wh });
  }

  return out;
}

/** Parse openings JSON parameter; null if malformed */
export function readOpenings(text: string): Opening[] | null {
  if (typeof text !== 'string' || text.length > MAX_TEXT) return null;
  if (!text.trim()) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(raw) || raw.length > MAX_OPENINGS) return null;
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const out: Opening[] = [];
  const used = new Set<number>();
  let nextId = 1;
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const q = item as Record<string, unknown>;
    const wall = typeof q.wall === 'string' && (isOuterWall(q.wall) || /^wall-\d+$/.test(q.wall)) ? q.wall : 'front';
    const kind: OpeningKind = q.kind === 'door' || q.kind === 'window' ? q.kind : 'window';
    const style: OpeningStyle = (OPENING_STYLES as string[]).includes(String(q.style)) ? (q.style as OpeningStyle) : 'rect';
    if (!num(q.x) || !num(q.y) || !num(q.w) || !num(q.h)) return null;
    let id = num(q.id) && Number.isInteger(q.id) && q.id >= 1 && !used.has(q.id) ? q.id : 0;
    if (!id) {
      while (used.has(nextId)) nextId++;
      id = nextId++;
    }
    used.add(id);
    out.push({
      id,
      wall,
      kind,
      style,
      x: r2(q.x),
      y: r2(Math.max(0, q.y)),
      w: r2(Math.max(1, q.w)),
      h: r2(Math.max(1, q.h)),
    });
  }
  return out;
}

export function writeOpenings(list: Opening[]): string {
  return JSON.stringify(
    list.map((o) => ({
      id: o.id,
      wall: o.wall,
      kind: o.kind,
      style: o.style,
      x: r2(o.x),
      y: r2(o.y),
      w: r2(o.w),
      h: r2(o.h),
    })),
  );
}

/**
 * Scale opening positions and sizes proportionally when house width, depth or height changes.
 * Also scales openings on interior walls (`wall-<id>`) along their axis.
 */
export function scaleOpenings(
  list: Opening[],
  oldW: number,
  oldD: number,
  newW: number,
  newD: number,
  oldH = 0,
  newH = 0,
  innerAxes?: Map<number, 'h' | 'v'>,
  floor = true,
  t = 3,
): Opening[] {
  const sx = oldW > 0 ? newW / oldW : 1;
  const sy = oldD > 0 ? newD / oldD : 1;
  const sillZ = sillBaseZ(floor, t);
  const oldClear = oldH > sillZ + 4 ? oldH - sillZ : oldH;
  const newClear = newH > sillZ + 4 ? newH - sillZ : newH;
  const sh = oldH > 0 && newH > 0 && oldClear > 0 ? newClear / oldClear : 1;
  const scaleH = Math.abs(sh - 1) > 1e-6;

  return list.map((o) => {
    let alongScale = 1;
    if (o.wall === 'front' || o.wall === 'back') alongScale = sx;
    else if (o.wall === 'left' || o.wall === 'right') alongScale = sy;
    else {
      const m = /^wall-(\d+)$/.exec(o.wall);
      const ax = m && innerAxes ? innerAxes.get(Number(m[1])) : undefined;
      if (ax === 'h') alongScale = sx;
      else if (ax === 'v') alongScale = sy;
    }
    const scaleX = Math.abs(alongScale - 1) > 1e-6;
    return {
      ...o,
      ...(scaleX ? { x: r2(o.x * alongScale), w: r2(Math.max(4, o.w * alongScale)) } : {}),
      ...(scaleH ? { y: o.y > 0.01 ? r2(Math.max(0, o.y * sh)) : 0, h: r2(Math.max(4, o.h * sh)) } : {}),
    };
  });
}

export function nextOpeningId(list: Opening[]): number {
  return list.reduce((m, o) => Math.max(m, o.id), 0) + 1;
}

/** Build a WallHost from an outer wall profile and T-wall joint locations */
export function outerWallHost(
  profile: WallProfile,
  floorZ: number,
  sillZ: number,
  t: number,
  hasLeftAdj: boolean,
  hasRightAdj: boolean,
  topJointMargin: number,
  jointXs: number[],
  spans?: [number, number][],
): WallHost {
  return {
    key: profile.wall,
    width: profile.width,
    floorZ,
    sillZ,
    zAt: profile.zAt,
    maxZ: profile.maxZ,
    jointXs,
    marginLeft: hasLeftAdj ? t : 0,
    marginRight: hasRightAdj ? t : 0,
    topJointMargin,
    ...(spans ? { spans } : {}),
  };
}

/** Sample the maximum allowable Z of the top of an opening of width w centered at x (accounting for arch/round curvature) */
function openingTopNeededZ(op: Opening, xSample: number, sillZ: number): number {
  const dx = Math.abs(xSample - op.x);
  const hw = op.w / 2;
  if (op.style === 'round') {
    const r = Math.min(op.w, op.h) / 2;
    const cy = sillZ + op.y + op.h / 2;
    return dx <= r ? cy + Math.sqrt(Math.max(0, r * r - dx * dx)) : sillZ + op.y;
  }
  if (op.style === 'arch') {
    const r = Math.min(op.w / 2, op.h / 2);
    const cy = sillZ + op.y + op.h - r;
    const straightHalf = hw - r;
    if (dx <= straightHalf) return sillZ + op.y + op.h;
    const u = dx - straightHalf;
    return u <= r ? cy + Math.sqrt(Math.max(0, r * r - u * u)) : sillZ + op.y;
  }
  return sillZ + op.y + op.h;
}

/**
 * Maximum safe engraved frame width around `op` so the frame stays strictly inside its wall's wood area,
 * clear of corner joints, roof edges, T-wall slots, and neighboring openings' frames.
 */
export function safeFrameWidth(op: Opening, host: WallHost, others: Opening[], requested: number, t: number): number {
  if (requested <= 0.2) return 0;
  const xL = op.x - op.w / 2;
  const xR = op.x + op.w / 2;
  // Exact outer overhang multipliers matching openingMarks() (window sill = 1.4x wide / 1.3x below; double door header = 1.5x / 1.6x)
  const multsOf = (o: Opening) => ({
    x: o.style === 'round' ? 1 : o.kind !== 'door' ? 1.4 : o.style === 'double' ? 1.5 : 1,
    top: o.kind === 'door' && o.style === 'double' ? 1.6 : 1,
    bot: o.kind === 'door' ? 0 : o.style === 'round' || o.style === 'arch' ? 1 : 1.3,
  });
  const m = multsOf(op);

  // Determine enclosing built span
  let s0 = host.marginLeft;
  let s1 = host.width - host.marginRight;
  if (host.spans?.length) {
    const sp = host.spans.find(([a, b]) => xL >= a - 0.01 && xR <= b + 0.01);
    if (sp) {
      s0 = sp[0] + t;
      s1 = sp[1] - t;
    }
  }
  const pad = 0.4;
  let maxF = requested;
  // Horizontal clearance to wall edges / corner fingers
  maxF = Math.min(maxF, Math.max(0, (xL - s0 - pad) / m.x), Math.max(0, (s1 - xR - pad) / m.x));
  // Bottom clearance
  if (m.bot > 0) {
    const availBot = host.sillZ - host.floorZ + op.y - pad;
    maxF = Math.min(maxF, Math.max(0, availBot / m.bot));
  }
  // Top clearance against wall profile (roofline / top joint)
  for (let i = 0; i <= 6; i++) {
    const sx = xL + (op.w * i) / 6;
    const topSpace = host.zAt(sx) - host.topJointMargin - openingTopNeededZ(op, sx, host.sillZ) - pad;
    maxF = Math.min(maxF, Math.max(0, topSpace / m.top));
  }
  // Clearance from interior wall T-joints
  for (const jx of host.jointXs) {
    if (jx <= xL) maxF = Math.min(maxF, Math.max(0, (xL - (jx + t / 2) - pad) / m.x));
    else if (jx >= xR) maxF = Math.min(maxF, Math.max(0, (jx - t / 2 - xR - pad) / m.x));
  }
  // Clearance to neighboring openings on the same wall
  for (const o of others) {
    if (o.id === op.id) continue;
    const om = multsOf(o);
    const gapX = Math.max(xL - (o.x + o.w / 2), o.x - o.w / 2 - xR);
    const gapY = Math.max(op.y - (o.y + o.h), o.y - (op.y + op.h));
    if (gapY < requested * (m.top + om.bot + 0.5) && gapX >= 0) {
      maxF = Math.min(maxF, Math.max(0, (gapX - pad) / (m.x + om.x)));
    }
    if (gapX < requested * (m.x + om.x + 0.5) && gapY >= 0) {
      const vSum = op.y >= o.y + o.h ? m.bot + om.top : m.top + om.bot;
      if (vSum > 0) maxF = Math.min(maxF, Math.max(0, (gapY - pad) / vSum));
    }
  }
  return maxF >= 0.4 ? r2(maxF) : 0;
}

/** Validate all openings against their host walls, roof silhouettes, joints, overlaps, and optional engraved frames */
export function validateOpenings(
  openings: Opening[],
  hosts: Map<string, WallHost>,
  t: number,
  mullionW: number,
  engraveFrames = false,
  frameW = 0,
): OpeningIssue[] {
  const issues: OpeningIssue[] = [];
  const web = webMin(t);
  const byWall = new Map<string, Opening[]>();

  for (const op of openings) {
    const host = hosts.get(op.wall);
    if (!host) {
      issues.push({ key: 'openings', level: 'warn', code: 'opening-wall-missing', values: { id: op.id } });
      continue;
    }
    const list = byWall.get(op.wall) ?? [];
    list.push(op);
    byWall.set(op.wall, list);

    if (op.w < 4 || op.h < 4) {
      issues.push({ key: 'openings', level: 'error', code: 'opening-small', values: { id: op.id, min: 4 } });
      continue;
    }

    // Mullion check for cross / grid / double windows
    if (op.style === 'cross' && (op.w - mullionW < 4 || op.h - mullionW < 4)) {
      issues.push({ key: 'openings', level: 'warn', code: 'opening-mullions-tight', values: { id: op.id } });
    } else if (op.style === 'grid') {
      const cols = op.w > op.h * 1.2 ? 3 : 2;
      const rows = op.w > op.h * 1.2 ? 2 : 3;
      if ((op.w - (cols - 1) * mullionW) / cols < 2 || (op.h - (rows - 1) * mullionW) / rows < 2) {
        issues.push({ key: 'openings', level: 'warn', code: 'opening-mullions-tight', values: { id: op.id } });
      }
    }

    // Horizontal clearance from wall side edges (or actual built spans on shaped L/U/C footprints)
    const xL = op.x - op.w / 2;
    const xR = op.x + op.w / 2;
    if (host.spans) {
      const fitsSpan = host.spans.some(([a, b]) => xL >= a + t + web - 0.01 && xR <= b - t - web + 0.01);
      if (!fitsSpan) {
        issues.push({ key: 'openings', level: 'error', code: 'opening-outside', values: { id: op.id } });
        continue;
      }
    } else {
      const minL = host.marginLeft + web;
      const maxR = host.width - host.marginRight - web;
      if (xL < minL - 0.01 || xR > maxR + 0.01) {
        issues.push({ key: 'openings', level: 'error', code: 'opening-outside', values: { id: op.id } });
        continue;
      }
    }

    // Bottom clearance: y >= 0 sits on sillZ (solid threshold above floor joint when floor is on, or bottom edge when off)
    if (op.y < -0.01) {
      issues.push({ key: 'openings', level: 'error', code: 'opening-outside', values: { id: op.id } });
      continue;
    }

    // Top clearance against wall profile (handles sloped gable and shed rooflines accurately!)
    const topMargin = host.topJointMargin + web;
    const samples = 9;
    let hitsTop = false;
    for (let i = 0; i <= samples; i++) {
      const sx = xL + (op.w * i) / samples;
      const needZ = openingTopNeededZ(op, sx, host.sillZ);
      const availZ = host.zAt(sx) - topMargin;
      if (needZ > availZ + 0.01) {
        hitsTop = true;
        break;
      }
    }
    if (hitsTop) {
      issues.push({ key: 'openings', level: 'error', code: 'opening-outside', values: { id: op.id } });
      continue;
    }

    // Clearance from perpendicular inner wall T-joints on this wall
    for (const jx of host.jointXs) {
      if (xL < jx + t / 2 + web - 0.01 && xR > jx - t / 2 - web + 0.01) {
        issues.push({ key: 'openings', level: 'error', code: 'opening-hits-wall', values: { id: op.id } });
        break;
      }
    }
  }

  // Pairwise overlap / thin-web check + engraved frame clearance warning on the same wall
  for (const [wk, list] of byWall.entries()) {
    const host = hosts.get(wk)!;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i],
          b = list[j];
        const gapX = Math.max(a.x - a.w / 2 - (b.x + b.w / 2), b.x - b.w / 2 - (a.x + a.w / 2));
        const gapY = Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h));
        if (gapX < web - 0.01 && gapY < web - 0.01) {
          issues.push({ key: 'openings', level: 'error', code: 'openings-overlap', values: { id: a.id, id2: b.id, min: web } });
        }
      }
      if (engraveFrames && frameW > 0.2) {
        const safe = safeFrameWidth(list[i], host, list, frameW, t);
        if (safe < frameW - 0.05) {
          issues.push({ key: 'frameWidth', level: 'warn', code: 'opening-frame-tight', values: { id: list[i].id } });
        }
      }
    }
  }

  return issues;
}

/** Helper: axis-aligned rectangle sub-path */
const rectAt = (x0: number, y0: number, x1: number, y1: number): SubPath =>
  polygon([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);

/** Helper: arched rectangle (semicircular or rounded arch top, flat bottom at y1) */
function archAt(cx: number, y0: number, y1: number, w: number): SubPath {
  const hw = w / 2;
  const h = y1 - y0;
  const r = Math.min(hw, h / 2);
  if (r < 0.5) return rectAt(cx - hw, y0, cx + hw, y1);
  const k = r * K;
  const xL = cx - hw,
    xR = cx + hw;
  const ySpring = y0 + r;
  const n = (x: number, y: number, ix?: number, iy?: number, ox?: number, oy?: number): Node => ({
    x,
    y,
    ...(ix !== undefined && iy !== undefined ? { cin: { x: ix, y: iy } } : {}),
    ...(ox !== undefined && oy !== undefined ? { cout: { x: ox, y: oy } } : {}),
  });
  if (Math.abs(hw - r) < 1e-4) {
    // True semicircular arch
    return {
      closed: true,
      nodes: [
        n(xL, y1),
        n(xL, ySpring, xL, ySpring, xL, ySpring - k),
        n(cx, y0, cx - k, y0, cx + k, y0),
        n(xR, ySpring, xR, ySpring - k, xR, ySpring),
        n(xR, y1),
      ],
    };
  }
  // Wide arch with flat top segment between two quarter-circle corners
  return {
    closed: true,
    nodes: [
      n(xL, y1),
      n(xL, ySpring, xL, ySpring, xL, ySpring - k),
      n(xL + r, y0, xL + r - k, y0, xL + r, y0),
      n(xR - r, y0, xR - r, y0, xR - r + k, y0),
      n(xR, ySpring, xR, ySpring - k, xR, ySpring),
      n(xR, y1),
    ],
  };
}

/**
 * Laser cutout sub-paths for one opening in uncentered panel coordinates (y pointing down).
 * `cx`: horizontal center in panel coordinates; `yBot`: bottom edge in panel coordinates (Z = floorZ + op.y).
 * `cutThroughBottom`: true when floor is off and op.y == 0 so the doorway opens through the bottom edge of the wall.
 */
export function openingCutouts(
  op: Opening,
  cx: number,
  yBot: number,
  mullionW: number,
  cutThroughBottom = false,
): SubPath[] {
  const hw = op.w / 2;
  const yTop = yBot - op.h;
  const bot = cutThroughBottom ? yBot + 1 : yBot;

  if (op.style === 'round') {
    const r = Math.min(op.w, op.h) / 2;
    return [circle(cx, (yTop + yBot) / 2, r)];
  }
  if (op.style === 'arch') {
    return [archAt(cx, yTop, bot, op.w)];
  }
  if (op.style === 'cross') {
    const pw = (op.w - mullionW) / 2;
    const ph = (op.h - mullionW) / 2;
    if (pw < 2 || ph < 2) return [rectAt(cx - hw, yTop, cx + hw, bot)];
    const mx0 = cx - mullionW / 2,
      mx1 = cx + mullionW / 2;
    const my = (yTop + yBot) / 2;
    const my0 = my - mullionW / 2,
      my1 = my + mullionW / 2;
    return [
      rectAt(cx - hw, yTop, mx0, my0),
      rectAt(mx1, yTop, cx + hw, my0),
      rectAt(cx - hw, my1, mx0, bot),
      rectAt(mx1, my1, cx + hw, bot),
    ];
  }
  if (op.style === 'grid') {
    const cols = op.w > op.h * 1.2 ? 3 : 2;
    const rows = op.w > op.h * 1.2 ? 2 : 3;
    const pw = (op.w - (cols - 1) * mullionW) / cols;
    const ph = (op.h - (rows - 1) * mullionW) / rows;
    if (pw < 2 || ph < 2) return [rectAt(cx - hw, yTop, cx + hw, bot)];
    const out: SubPath[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x0 = cx - hw + c * (pw + mullionW);
        const y0 = yTop + r * (ph + mullionW);
        const y1 = r === rows - 1 && cutThroughBottom ? bot : y0 + ph;
        out.push(rectAt(x0, y0, x0 + pw, y1));
      }
    }
    return out;
  }
  if (op.style === 'double' && op.kind === 'window') {
    const pw = (op.w - mullionW) / 2;
    if (pw < 2) return [rectAt(cx - hw, yTop, cx + hw, bot)];
    return [
      rectAt(cx - hw, yTop, cx - mullionW / 2, bot),
      rectAt(cx + mullionW / 2, yTop, cx + hw, bot),
    ];
  }
  // rect or double door
  return [rectAt(cx - hw, yTop, cx + hw, bot)];
}

/**
 * Engraved architectural trim marks (outer frame, window sill, door lintel) in uncentered panel coordinates.
 * Kept strictly inside the wall panel so marks never spill off the edge.
 */
export function openingMarks(
  op: Opening,
  cx: number,
  yBot: number,
  frameW: number,
): SubPath[] {
  if (frameW <= 0.2) return [];
  const hw = op.w / 2;
  const yTop = yBot - op.h;
  const marks: SubPath[] = [];

  if (op.style === 'round') {
    const r = Math.min(op.w, op.h) / 2;
    marks.push(circle(cx, (yTop + yBot) / 2, r + frameW));
    return marks;
  }

  if (op.style === 'arch') {
    if (op.kind === 'door') {
      // Open-bottom arched frame around doorway
      const full = archAt(cx, yTop - frameW, yBot, op.w + 2 * frameW);
      marks.push({ closed: false, nodes: full.nodes });
    } else {
      marks.push(archAt(cx, yTop - frameW, yBot + frameW, op.w + 2 * frameW));
      // Window sill extending slightly beyond frame
      marks.push({
        closed: false,
        nodes: [
          { x: cx - hw - frameW * 1.4, y: yBot + frameW },
          { x: cx + hw + frameW * 1.4, y: yBot + frameW },
        ],
      });
    }
    return marks;
  }

  if (op.kind === 'door') {
    // 3-sided door casing (left jamb, top lintel, right jamb)
    marks.push({
      closed: false,
      nodes: [
        { x: cx - hw - frameW, y: yBot },
        { x: cx - hw - frameW, y: yTop - frameW },
        { x: cx + hw + frameW, y: yTop - frameW },
        { x: cx + hw + frameW, y: yBot },
      ],
    });
    if (op.style === 'double') {
      // Extra decorative pediment / header bar above double door
      marks.push({
        closed: false,
        nodes: [
          { x: cx - hw - frameW * 1.5, y: yTop - frameW * 1.6 },
          { x: cx + hw + frameW * 1.5, y: yTop - frameW * 1.6 },
        ],
      });
    }
    return marks;
  }

  // Window: full rectangular frame + slightly wider engraved sill below
  marks.push(rectAt(cx - hw - frameW, yTop - frameW, cx + hw + frameW, yBot + frameW));
  marks.push({
    closed: false,
    nodes: [
      { x: cx - hw - frameW * 1.4, y: yBot + frameW * 1.3 },
      { x: cx + hw + frameW * 1.4, y: yBot + frameW * 1.3 },
    ],
  });
  return marks;
}

/** Find a valid, non-overlapping placement for a newly added door or window on the given wall host */
export function findOpeningSpot(
  host: WallHost,
  existing: Opening[],
  kind: OpeningKind,
  t: number,
  mullionW: number,
): Opening | null {
  const web = webMin(t);
  const availW = host.width - host.marginLeft - host.marginRight - 2 * web;
  const clearH = host.zAt(host.width / 2) - host.sillZ - host.topJointMargin - web;
  if (availW < 6 || clearH < 6) return null;

  const isDoor = kind === 'door';
  const w = r2(Math.min(isDoor ? 22 : 18, Math.max(8, availW * (isDoor ? 0.28 : 0.24))));
  const h = r2(Math.min(isDoor ? 40 : 20, Math.max(8, clearH * (isDoor ? 0.72 : 0.42))));
  const y = isDoor ? 0 : r2(Math.max(2, Math.min(clearH - h - 1, clearH * 0.35)));
  const style: OpeningStyle = isDoor ? 'rect' : 'cross';

  // Try candidate horizontal positions: center first, then spread left/right across the wall
  const xMin = host.marginLeft + web + w / 2;
  const xMax = host.width - host.marginRight - web - w / 2;
  if (xMin > xMax) return null;

  const cands: number[] = [r2((xMin + xMax) / 2)];
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    const f = i / (steps + 1);
    cands.push(r2(xMin + (xMax - xMin) * f));
  }
  const hostsMap = new Map([[host.key, host]]);
  const wallOps = existing.filter((o) => o.wall === host.key);

  for (const x of cands) {
    const cand: Opening = { id: nextOpeningId(existing), wall: host.key, kind, style, x, y, w, h };
    const errs = validateOpenings([...wallOps, cand], hostsMap, t, mullionW).filter((i) => i.level === 'error');
    if (!errs.length) return cand;
  }

  // Fallback: place at center with smaller size if crowded
  const sw = r2(Math.max(6, Math.min(w * 0.65, availW / 2)));
  const sh = r2(Math.max(6, Math.min(h * 0.7, clearH - 2)));
  const sy = isDoor ? 0 : r2(Math.max(2, (clearH - sh) / 2));
  for (const x of cands) {
    const cand: Opening = { id: nextOpeningId(existing), wall: host.key, kind, style: 'rect', x, y: sy, w: sw, h: sh };
    const errs = validateOpenings([...wallOps, cand], hostsMap, t, mullionW).filter((i) => i.level === 'error');
    if (!errs.length) return cand;
  }

  return null;
}

/** Build WallHost map for a rectangular house (outer walls + interior walls) */
export function buildWallHosts(
  W: number,
  D: number,
  H: number,
  t: number,
  floor: boolean,
  sides: Record<'x0' | 'x1' | 'y0' | 'y1', boolean>,
  roof: RoofSpec,
  innerWalls: { id: number; axis: 'h' | 'v'; pos: number; s: number; e: number; h: number; startOuter?: 'x0' | 'x1' | 'y0' | 'y1'; endOuter?: 'x0' | 'x1' | 'y0' | 'y1'; joints: number[] }[],
): Map<string, WallHost> {
  const hosts = new Map<string, WallHost>();
  const floorZ = floor ? t : 0;
  const sillZ = sillBaseZ(floor, t);
  const sideOn: Record<OuterWallKey, boolean> = { front: sides.y1, back: sides.y0, left: sides.x0, right: sides.x1 };
  const adjLeft: Record<OuterWallKey, boolean> = { front: sides.x0, back: sides.x1, left: sides.y0, right: sides.y1 };
  const adjRight: Record<OuterWallKey, boolean> = { front: sides.x1, back: sides.x0, left: sides.y1, right: sides.y0 };

  // Collect inner wall T-joints hitting each outer wall (converted to exterior horizontal x!)
  const outerJoints: Record<OuterWallKey, number[]> = { front: [], back: [], left: [], right: [] };
  for (const iw of innerWalls) {
    for (const s of [iw.startOuter, iw.endOuter]) {
      if (!s) continue;
      // iw.pos is in inner coords [0..w] or [0..d]; outer 3D coordinate is iw.pos + t
      if (s === 'y1') outerJoints.front.push(iw.pos + t);
      if (s === 'y0') outerJoints.back.push(W - (iw.pos + t));
      if (s === 'x0') outerJoints.left.push(iw.pos + t);
      if (s === 'x1') outerJoints.right.push(D - (iw.pos + t));
    }
  }

  for (const wall of OUTER_WALLS) {
    if (!sideOn[wall]) continue;
    const prof = wallProfile(wall, W, D, H, t, roof);
    const hasTopJoint =
      roof.mount === 'fixed' &&
      (roof.type === 'flat' ||
        roof.type === 'hip' ||
        roof.type === 'pyramid' ||
        (roof.type === 'gable' && prof.kind === 'gable') ||
        (roof.type === 'shed' && prof.kind === 'shed-slope'));
    hosts.set(
      wall,
      outerWallHost(prof, floorZ, sillZ, t, adjLeft[wall], adjRight[wall], hasTopJoint ? t : 0, outerJoints[wall]),
    );
  }

  // Interior wall hosts
  for (const iw of innerWalls) {
    const len = iw.e - iw.s;
    if (len < 2 * t) continue;
    hosts.set(`wall-${iw.id}`, {
      key: `wall-${iw.id}`,
      width: len,
      floorZ,
      sillZ,
      zAt: () => floorZ + iw.h,
      maxZ: floorZ + iw.h,
      jointXs: iw.joints.map((a) => a - iw.s),
      marginLeft: t,
      marginRight: t,
      topJointMargin: 0,
    });
  }

  return hosts;
}
