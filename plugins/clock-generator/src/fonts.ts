import { strokeText, textWidth, type Node, type SubPath } from '../../../sdk/ts';
import { ellipse, roundedPoly, transformSub, type FontFamily } from './types';

interface FontSpec {
  /** Nominal digit width in 0..100 cap-height units */
  w: number;
  /** Vertical / primary stroke thickness */
  sw: number;
  /** Horizontal / secondary stroke thickness */
  sh: number;
  /** Elliptical handle multiplier (0.5523 = ellipse, 0.72 = squared) */
  k: number;
  /** Serif treatment */
  serif: 'none' | 'bracket' | 'slab' | 'deco';
  /** Open stroke terminal cap */
  cap: 'flat' | 'round' | 'ball';
  /** Chamfer size for technical octagonal font (0 = curved) */
  chamfer: number;
  /** Relative vertical waist position for 3 and 8 (0..1) */
  waist: number;
  /** Top bowl horizontal width ratio relative to bottom bowl */
  topScale: number;
  /** Letter spacing in 0..100 units */
  tracking: number;
}

const FONTS: Record<FontFamily, FontSpec> = {
  sans: {
    w: 62,
    sw: 15,
    sh: 13.5,
    k: 0.56,
    serif: 'none',
    cap: 'flat',
    chamfer: 0,
    waist: 0.46,
    topScale: 0.9,
    tracking: 9,
  },
  serif: {
    w: 64,
    sw: 17.5,
    sh: 7.5,
    k: 0.56,
    serif: 'bracket',
    cap: 'ball',
    chamfer: 0,
    waist: 0.45,
    topScale: 0.88,
    tracking: 10,
  },
  rounded: {
    w: 66,
    sw: 16.5,
    sh: 15.5,
    k: 0.5523,
    serif: 'none',
    cap: 'round',
    chamfer: 0,
    waist: 0.46,
    topScale: 0.91,
    tracking: 10,
  },
  artdeco: {
    w: 48,
    sw: 12.5,
    sh: 8.5,
    k: 0.56,
    serif: 'deco',
    cap: 'flat',
    chamfer: 0,
    waist: 0.37,
    topScale: 0.82,
    tracking: 9,
  },
  slab: {
    w: 64,
    sw: 17,
    sh: 15,
    k: 0.7,
    serif: 'slab',
    cap: 'flat',
    chamfer: 0,
    waist: 0.47,
    topScale: 0.93,
    tracking: 10,
  },
  technical: {
    w: 60,
    sw: 15,
    sh: 14.5,
    k: 0.56,
    serif: 'none',
    cap: 'flat',
    chamfer: 13,
    waist: 0.47,
    topScale: 0.94,
    tracking: 9,
  },
};

export interface GlyphData {
  width: number;
  subs: SubPath[];
}

/** Exact cubic Bézier elliptical arc nodes from angle a0 to a1 (radians, 0 = +x, +PI/2 = +y down) */
function ellipseArcNodes(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  a0: number,
  a1: number,
  kScale = 1,
): Node[] {
  const span = a1 - a0;
  const n = Math.max(1, Math.ceil(Math.abs(span) / (Math.PI / 2)));
  const d = span / n;
  const alpha = (4 / 3) * Math.tan(d / 4) * kScale;
  const nodes: Node[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + i * d;
    const x = cx + rx * Math.cos(a);
    const y = cy + ry * Math.sin(a);
    const dx = -rx * Math.sin(a);
    const dy = ry * Math.cos(a);
    const nd: Node = { x, y };
    if (i > 0) nd.cin = { x: x - dx * alpha, y: y - dy * alpha };
    if (i < n) nd.cout = { x: x + dx * alpha, y: y + dy * alpha };
    if (i > 0 && i < n) nd.smooth = true;
    nodes.push(nd);
  }
  return nodes;
}

/** Append an arc node sequence to an existing node list, merging duplicate junction point cleanly */
function appendChain(dst: Node[], src: Node[]): void {
  if (!src.length) return;
  if (dst.length) {
    const last = dst[dst.length - 1];
    const first = src[0];
    if (Math.hypot(last.x - first.x, last.y - first.y) < 1e-4) {
      if (first.cout) last.cout = first.cout;
      for (let i = 1; i < src.length; i++) dst.push(src[i]);
      return;
    }
  }
  for (const nd of src) dst.push(nd);
}

/** Close a node chain into a SubPath, merging last node into first if coincident */
function closeChain(nodes: Node[]): SubPath {
  if (nodes.length > 1) {
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) < 1e-4) {
      if (last.cin && !first.cin) first.cin = last.cin;
      nodes.pop();
    }
  }
  return { closed: true, nodes };
}

/** Connect two points (p1 -> p2) with a semicircular rounded cap bulging to the right of (p1 -> p2) */
function appendCap(dst: Node[], p1: { x: number; y: number }, p2: { x: number; y: number }, cap: FontSpec['cap']): void {
  if (cap === 'flat') {
    appendChain(dst, [{ x: p1.x, y: p1.y }, { x: p2.x, y: p2.y }]);
    return;
  }
  const mx = (p1.x + p2.x) / 2;
  const my = (p1.y + p2.y) / 2;
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const r = Math.hypot(dx, dy) / 2;
  if (r < 0.2) {
    appendChain(dst, [{ x: p1.x, y: p1.y }, { x: p2.x, y: p2.y }]);
    return;
  }
  const a0 = Math.atan2(p1.y - my, p1.x - mx);
  // Semicircle sweeping CW in y-down (= bulging outward past the stroke end)
  const bulge = cap === 'ball' ? 1.15 : 1.0;
  const arc = ellipseArcNodes(mx, my, r * bulge, r * bulge, a0, a0 + Math.PI);
  // Ensure exact endpoints p1 and p2
  arc[0].x = p1.x;
  arc[0].y = p1.y;
  arc[arc.length - 1].x = p2.x;
  arc[arc.length - 1].y = p2.y;
  appendChain(dst, arc);
}

/** Closed polygon helper from [x, y] pairs */
const poly = (pts: [number, number][]): SubPath => ({
  closed: true,
  nodes: pts.map(([x, y]) => ({ x, y })),
});

/** Chamfered rectangle (45° beveled corners) */
function chamferRect(x0: number, y0: number, x1: number, y1: number, c: number, ccw = false): SubPath {
  const ch = Math.max(0, Math.min(c, (x1 - x0) * 0.42, (y1 - y0) * 0.42));
  const pts: [number, number][] =
    ch <= 0.1
      ? [
          [x0, y0],
          [x1, y0],
          [x1, y1],
          [x0, y1],
        ]
      : [
          [x0 + ch, y0],
          [x1 - ch, y0],
          [x1, y0 + ch],
          [x1, y1 - ch],
          [x1 - ch, y1],
          [x0 + ch, y1],
          [x0, y1 - ch],
          [x0, y0 + ch],
        ];
  if (ccw) pts.reverse();
  return poly(pts);
}

/** Solve intersection y of two vertically stacked ellipses (cx, y1, rx1, ry1) and (cx, y2, rx2, ry2) */
function stackedEllipseWaist(y1: number, rx1: number, ry1: number, y2: number, rx2: number, ry2: number): { xw: number; yw: number } {
  // Solve rx1^2*(1 - ((y-y1)/ry1)^2) = rx2^2*(1 - ((y-y2)/ry2)^2)
  const a1 = (rx1 * rx1) / (ry1 * ry1);
  const a2 = (rx2 * rx2) / (ry2 * ry2);
  const A = a2 - a1;
  const B = 2 * (a1 * y1 - a2 * y2);
  const C = rx1 * rx1 - rx2 * rx2 - a1 * y1 * y1 + a2 * y2 * y2;
  let yw = (y1 + ry1 + (y2 - ry2)) / 2;
  if (Math.abs(A) < 1e-8) {
    if (Math.abs(B) > 1e-8) yw = -C / B;
  } else {
    const disc = Math.max(0, B * B - 4 * A * C);
    const s = Math.sqrt(disc);
    const r1 = (-B + s) / (2 * A);
    const r2 = (-B - s) / (2 * A);
    // Pick root inside [y1, y2]
    if (r1 >= y1 && r1 <= y2) yw = r1;
    else if (r2 >= y1 && r2 <= y2) yw = r2;
  }
  const t = Math.max(0, 1 - ((yw - y1) / ry1) ** 2);
  const xw = rx1 * Math.sqrt(t);
  return { xw, yw };
}

/** Rotate a GlyphData 180° around (width/2, 50) */
function rotate180(g: GlyphData): GlyphData {
  return {
    width: g.width,
    subs: g.subs.map((s) => transformSub(s, g.width, 100, 1, Math.PI)),
  };
}

// ------------------------------------------------------------------ Individual Glyphs

function glyph0(f: FontSpec): GlyphData {
  const w = f.w;
  if (f.chamfer > 0) {
    const outer = chamferRect(0, 0, w, 100, f.chamfer, false);
    const inner = chamferRect(f.sw, f.sh, w - f.sw, 100 - f.sh, Math.max(4, f.chamfer - f.sw * 0.45), true);
    return { width: w, subs: [outer, inner] };
  }
  const cx = w / 2;
  const rx = w / 2;
  const ry = 50;
  const outer = ellipse(cx, 50, rx, ry, f.k, false);
  const inner = ellipse(cx, 50, rx - f.sw, ry - f.sh, Math.min(f.k, 0.62), true);
  return { width: w, subs: [outer, inner] };
}

function glyphI(f: FontSpec): GlyphData {
  const sw = f.sw;
  if (f.serif === 'bracket') {
    const ext = 11;
    const w = sw + 2 * ext;
    const sh = f.sh;
    const br = 6;
    const nodes: Node[] = [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: sh },
      { x: w - ext + br, y: sh, cout: { x: w - ext, y: sh } },
      { x: w - ext, y: sh + br, cin: { x: w - ext, y: sh } },
      { x: w - ext, y: 100 - sh - br, cout: { x: w - ext, y: 100 - sh } },
      { x: w - ext + br, y: 100 - sh, cin: { x: w - ext, y: 100 - sh } },
      { x: w, y: 100 - sh },
      { x: w, y: 100 },
      { x: 0, y: 100 },
      { x: 0, y: 100 - sh },
      { x: ext - br, y: 100 - sh, cout: { x: ext, y: 100 - sh } },
      { x: ext, y: 100 - sh - br, cin: { x: ext, y: 100 - sh } },
      { x: ext, y: sh + br, cout: { x: ext, y: sh } },
      { x: ext - br, y: sh, cin: { x: ext, y: sh } },
      { x: 0, y: sh },
    ];
    return { width: w, subs: [{ closed: true, nodes }] };
  }
  if (f.serif === 'slab') {
    const ext = 10;
    const w = sw + 2 * ext;
    const sh = f.sh * 0.85;
    return {
      width: w,
      subs: [
        poly([
          [0, 0],
          [w, 0],
          [w, sh],
          [w - ext, sh],
          [w - ext, 100 - sh],
          [w, 100 - sh],
          [w, 100],
          [0, 100],
          [0, 100 - sh],
          [ext, 100 - sh],
          [ext, sh],
          [0, sh],
        ]),
      ],
    };
  }
  if (f.serif === 'deco') {
    const ext = 7;
    const w = sw + 2 * ext;
    const sh = f.sh;
    return {
      width: w,
      subs: [
        poly([
          [0, 0],
          [w, 0],
          [w - ext, sh * 1.3],
          [w - ext, 100 - sh * 1.3],
          [w, 100],
          [0, 100],
          [ext, 100 - sh * 1.3],
          [ext, sh * 1.3],
        ]),
      ],
    };
  }
  if (f.cap === 'round') {
    const r = sw / 2;
    const nodes: Node[] = [];
    appendChain(nodes, ellipseArcNodes(r, r, r, r, Math.PI, 2 * Math.PI));
    appendChain(nodes, ellipseArcNodes(r, 100 - r, r, r, 0, Math.PI));
    return { width: sw, subs: [closeChain(nodes)] };
  }
  return { width: sw, subs: [poly([[0, 0], [sw, 0], [sw, 100], [0, 100]])] };
}

function glyph1(f: FontSpec): GlyphData {
  const sw = f.sw;
  const sh = f.sh;
  if (f.serif === 'bracket') {
    const extL = 16;
    const extR = 11;
    const w = extL + sw + extR;
    const sx = extL;
    const br = 6;
    const nodes: Node[] = [
      { x: sx + sw, y: 0 },
      { x: sx + sw, y: 100 - sh - br, cout: { x: sx + sw, y: 100 - sh } },
      { x: sx + sw + br, y: 100 - sh, cin: { x: sx + sw, y: 100 - sh } },
      { x: w, y: 100 - sh },
      { x: w, y: 100 },
      { x: 4, y: 100 },
      { x: 4, y: 100 - sh },
      { x: sx - br, y: 100 - sh, cout: { x: sx, y: 100 - sh } },
      { x: sx, y: 100 - sh - br, cin: { x: sx, y: 100 - sh } },
      { x: sx, y: 20 },
      { x: 0, y: 24 },
      { x: 0, y: 15, cout: { x: sx * 0.65, y: 12 } },
      { x: sx + 3, y: 0, cin: { x: sx * 0.9, y: 6 } },
    ];
    return { width: w, subs: [{ closed: true, nodes }] };
  }
  if (f.serif === 'slab') {
    const extL = 14;
    const extR = 11;
    const w = extL + sw + extR;
    const sx = extL;
    const bh = sh * 0.85;
    return {
      width: w,
      subs: [
        poly([
          [sx + sw, 0],
          [sx + sw, 100 - bh],
          [w, 100 - bh],
          [w, 100],
          [2, 100],
          [2, 100 - bh],
          [sx, 100 - bh],
          [sx, bh + 4],
          [0, bh + 4],
          [0, 4],
          [sx - 4, 0],
        ]),
      ],
    };
  }
  if (f.serif === 'deco') {
    const extL = 14;
    const w = extL + sw + 4;
    const sx = extL;
    return {
      width: w,
      subs: [
        poly([
          [sx + sw, 0],
          [sx + sw, 100],
          [sx, 100],
          [sx, 20],
          [0, 20],
          [sx - 1, 0],
        ]),
      ],
    };
  }
  if (f.cap === 'round') {
    const extL = 16;
    const w = extL + sw;
    const sx = extL;
    const r = sw / 2;
    const nodes: Node[] = [];
    // Top-right cap of stem -> down to bottom cap -> up left of stem -> flag
    appendChain(nodes, ellipseArcNodes(sx + r, r, r, r, -Math.PI / 2, 0));
    appendChain(nodes, ellipseArcNodes(sx + r, 100 - r, r, r, 0, Math.PI));
    nodes.push({ x: sx, y: 25 });
    // Flag pointing down-left with rounded tip
    const fx = 5,
      fy = 30;
    const aFlag = Math.atan2(fy - r, fx - (sx + r));
    const fr = r * 0.82;
    appendChain(nodes, ellipseArcNodes(fx, fy, fr, fr, aFlag - Math.PI / 2, aFlag + Math.PI / 2));
    nodes.push({ x: sx + r, y: 0 });
    return { width: w, subs: [closeChain(nodes)] };
  }
  // sans & technical
  const extL = 18;
  const w = extL + sw;
  const sx = extL;
  return {
    width: w,
    subs: [
      poly([
        [sx + sw, 0],
        [sx + sw, 100],
        [sx, 100],
        [sx, 24],
        [0, 34],
        [0, 19],
        [sx + 2, 0],
      ]),
    ],
  };
}

function glyph7(f: FontSpec): GlyphData {
  const w = f.w;
  const sw = f.sw;
  const sh = f.sh;
  if (f.serif === 'bracket') {
    const drop = 24;
    const xFootL = w * 0.28;
    const xFootR = xFootL + sw * 0.95;
    const nodes: Node[] = [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: sh * 1.3, cout: { x: w * 0.72, y: 42 } },
      { x: xFootR, y: 100, cin: { x: xFootR + 2, y: 74 } },
      { x: xFootL, y: 100, cout: { x: xFootL + 2, y: 72 } },
      { x: w - sw * 0.9, y: sh * 1.4, cin: { x: w * 0.56, y: 40 } },
      { x: sh * 1.3, y: sh * 1.4 },
      { x: sh * 0.9, y: drop },
      { x: 0, y: drop },
    ];
    return { width: w, subs: [{ closed: true, nodes }] };
  }
  if (f.serif === 'slab') {
    const drop = 24;
    const xFootL = w * 0.25;
    const xFootR = xFootL + sw;
    return {
      width: w,
      subs: [
        poly([
          [0, 0],
          [w, 0],
          [w, sh],
          [xFootR, 100],
          [xFootL, 100],
          [w - sw, sh],
          [sh * 0.85, sh],
          [sh * 0.85, drop],
          [0, drop],
        ]),
      ],
    };
  }
  if (f.cap === 'round') {
    const r = sh / 2;
    const xFoot = w * 0.34;
    const rf = sw / 2;
    const nodes: Node[] = [];
    // Left rounded cap of top bar
    appendChain(nodes, ellipseArcNodes(r, r, r, r, Math.PI / 2, 1.5 * Math.PI));
    // Top-right corner rounded
    appendChain(nodes, ellipseArcNodes(w - r, r, r, r, -Math.PI / 2, 0.2));
    // Bottom rounded tip of leg
    appendChain(nodes, ellipseArcNodes(xFoot, 100 - rf, rf, rf, 0.2, Math.PI + 0.2));
    // Inner top corner
    nodes.push({ x: w - sw * 1.15, y: sh });
    nodes.push({ x: r, y: sh });
    return { width: w, subs: [closeChain(nodes)] };
  }
  if (f.chamfer > 0) {
    const c = f.chamfer * 0.8;
    const xFootL = w * 0.28;
    const xFootR = xFootL + sw;
    return {
      width: w,
      subs: [
        poly([
          [0, 0],
          [w - c, 0],
          [w, c],
          [w, 22],
          [xFootR, 64],
          [xFootR, 100],
          [xFootL, 100],
          [xFootL, 58],
          [w - sw, 20],
          [w - sw, sh],
          [0, sh],
        ]),
      ],
    };
  }
  // sans & artdeco
  const xFootL = f.serif === 'deco' ? w * 0.2 : w * 0.26;
  const xFootR = xFootL + sw;
  return {
    width: w,
    subs: [
      poly([
        [0, 0],
        [w, 0],
        [w, sh],
        [xFootR, 100],
        [xFootL, 100],
        [w - sw * 1.05, sh],
        [0, sh],
      ]),
    ],
  };
}

function glyph4(f: FontSpec): GlyphData {
  const w = f.w + (f.serif === 'deco' ? 4 : 2);
  const sw = f.sw;
  const sh = f.sh;
  const barTop = f.serif === 'deco' ? 68 : 62;
  const barBot = barTop + sh;
  const rightOver = f.serif === 'deco' ? 9 : 11;
  const stemR = w - rightOver;
  const stemL = stemR - sw;
  // Diagonal outer edge goes from (stemL - 1, 0) to (0, barTop)
  const xTopDiag = stemL;
  const dx = xTopDiag;
  const dy = barTop;
  const len = Math.hypot(dx, dy);
  // Perpendicular inward shift by diagW
  const diagW = f.serif === 'bracket' ? sh * 1.25 : sw * 0.85;
  const nx = (dy / len) * diagW;
  const ny = (dx / len) * diagW;
  // Inner diagonal line passes through (xTopDiag + nx, ny) with direction (-dx, dy)
  // Intersect with y = barTop: t = (barTop - ny) / dy => x = (xTopDiag + nx) - t * dx
  const xTriL = Math.max(diagW * 1.1, xTopDiag + nx - ((barTop - ny) / dy) * dx);
  // Intersect with x = stemL: s = (xTopDiag + nx - stemL) / dx => y = ny + s * dy
  const yTriTop = Math.max(sh * 1.2, ny + ((xTopDiag + nx - stemL) / dx) * dy);

  // Outer contour CW
  const outerPts: [number, number][] = [
    [stemL, 0],
    [stemR, 0],
    [stemR, barTop],
    [w, barTop],
    [w, barBot],
    [stemR, barBot],
  ];
  if (f.serif === 'bracket' || f.serif === 'slab') {
    const ext = 8;
    const bh = sh * (f.serif === 'slab' ? 0.85 : 1);
    outerPts.push(
      [stemR, 100 - bh],
      [Math.min(w, stemR + ext), 100 - bh],
      [Math.min(w, stemR + ext), 100],
      [Math.max(0, stemL - ext), 100],
      [Math.max(0, stemL - ext), 100 - bh],
      [stemL, 100 - bh],
    );
  } else {
    outerPts.push([stemR, 100], [stemL, 100]);
  }
  outerPts.push([stemL, barBot], [0, barBot], [0, barTop]);

  // Inner triangular counter CCW
  const inner = poly([
    [xTriL, barTop],
    [stemL, yTriTop],
    [stemL, barTop],
  ]);

  const outer = f.cap === 'round' ? roundedPoly(outerPts, 4.5) : poly(outerPts);
  return { width: w, subs: [outer, inner] };
}

function glyph8(f: FontSpec): GlyphData {
  const w = f.w;
  const cx = w / 2;
  const sw = f.sw;
  const sh = f.sh;

  if (f.chamfer > 0) {
    const c = f.chamfer * 0.85;
    const yMid = 100 * f.waist;
    const topW = w * f.topScale;
    const tx0 = cx - topW / 2;
    const tx1 = cx + topW / 2;
    const pinch = 5.5;
    const outer = poly([
      [tx0 + c, 0],
      [tx1 - c, 0],
      [tx1, c],
      [tx1, yMid - pinch],
      [tx1 - pinch, yMid],
      [w, yMid + pinch],
      [w, 100 - c],
      [w - c, 100],
      [c, 100],
      [0, 100 - c],
      [0, yMid + pinch],
      [tx0 + pinch, yMid],
      [tx0, yMid - pinch],
      [tx0, c],
    ]);
    const hHalf = sh * 0.5;
    const topHole = chamferRect(tx0 + sw, sh, tx1 - sw, yMid - hHalf, 4, true);
    const botHole = chamferRect(sw, yMid + hHalf, w - sw, 100 - sh, 4, true);
    return { width: w, subs: [outer, topHole, botHole] };
  }

  const shLobe = Math.min(sh, 12);
  const overlap = 4.5;
  const ry1 = (100 * f.waist + overlap) / 2;
  const y1 = ry1;
  const ry2 = (100 * (1 - f.waist) + overlap) / 2;
  const y2 = 100 - ry2;
  const rx2 = w / 2;
  const rx1 = rx2 * f.topScale;
  const kScale = f.k / 0.5522847498;

  const { xw, yw } = stackedEllipseWaist(y1, rx1, ry1, y2, rx2, ry2);
  const aTopR = Math.atan2((yw - y1) / ry1, xw / rx1);
  const aBotR = Math.atan2((yw - y2) / ry2, xw / rx2);

  const nodes: Node[] = [];
  // Top arc CW from left waist up over top to right waist
  appendChain(nodes, ellipseArcNodes(cx, y1, rx1, ry1, Math.PI - aTopR, 2 * Math.PI + aTopR, kScale));
  // Bottom arc CW from right waist down over bottom to left waist
  appendChain(nodes, ellipseArcNodes(cx, y2, rx2, ry2, aBotR, Math.PI - aBotR, kScale));

  // Inner counters (CCW), guaranteeing solid waist bar between top and bottom counters
  const swTop = sw * (0.5 + 0.5 * f.topScale);
  const ry1In = Math.max(4, ry1 - shLobe);
  const ry2In = Math.max(4, ry2 - shLobe);
  const topHole = ellipse(cx, y1, Math.max(3, rx1 - swTop), ry1In, Math.min(f.k, 0.6), true);
  const botHole = ellipse(cx, y2, Math.max(3, rx2 - sw), ry2In, Math.min(f.k, 0.6), true);
  return { width: w, subs: [closeChain(nodes), topHole, botHole] };
}

function glyph6(f: FontSpec): GlyphData {
  const w = f.w;
  const cx = w / 2;
  const sw = f.sw;
  const sh = f.sh;

  if (f.chamfer > 0) {
    const c = f.chamfer * 0.85;
    const yBowlTop = 42;
    const outer = poly([
      [c, 0],
      [w - c, 0],
      [w, c],
      [w, 22],
      [w - sw, 22],
      [w - sw, sh],
      [sw, sh],
      [sw, yBowlTop],
      [w - c, yBowlTop],
      [w, yBowlTop + c],
      [w, 100 - c],
      [w - c, 100],
      [c, 100],
      [0, 100 - c],
      [0, c],
    ]);
    const inner = chamferRect(sw, yBowlTop + sh, w - sw, 100 - sh, 4, true);
    return { width: w, subs: [outer, inner] };
  }

  const rx = w / 2;
  const ryBot = f.serif === 'deco' ? 30 : 31;
  const yBot = 100 - ryBot;
  const ryArch = yBot;
  const a1 = rx - sw;
  const b1 = ryArch - sh;
  const a2 = rx;
  const b2 = ryBot;
  // Exact upper-left intersection of inner arch (a1, b1) and outer lower bowl (a2, b2)
  const denom = 1 / (a1 * a1 * b2 * b2) - 1 / (a2 * a2 * b1 * b1);
  const u2 = (1 / (b2 * b2) - 1 / (b1 * b1)) / denom;
  const v2 = (1 / (a1 * a1) - 1 / (a2 * a2)) / denom;
  const u = -Math.sqrt(Math.max(0.01, u2));
  const v = -Math.sqrt(Math.max(0.01, v2));

  const aInJoin = Math.atan2(v / b1, u / a1); // in (-PI, -PI/2) => add 2PI -> (PI, 1.5PI)
  const aBowlJoin = Math.atan2(v / b2, u / a2);
  const aInJoinPos = aInJoin < 0 ? aInJoin + 2 * Math.PI : aInJoin;
  const aBowlJoinPos = aBowlJoin < 0 ? aBowlJoin + 2 * Math.PI : aBowlJoin;

  const aEnd = 2 * Math.PI - 0.24 * Math.PI; // upper-right terminal (~50° past top)
  const kScale = f.k / 0.5522847498;

  const pEndOut = { x: cx + rx * Math.cos(aEnd), y: yBot + ryArch * Math.sin(aEnd) };
  const pEndIn = { x: cx + a1 * Math.cos(aEnd), y: yBot + b1 * Math.sin(aEnd) };

  const nodes: Node[] = [];
  // 1. Outer upper spine CW from left tangent (PI) over top (1.5PI) to aEnd
  appendChain(nodes, ellipseArcNodes(cx, yBot, rx, ryArch, Math.PI, aEnd, kScale));
  // 2. Cap at upper-right terminal
  appendCap(nodes, pEndOut, pEndIn, f.cap);
  // 3. Inner upper spine CCW from aEnd back to join point with lower bowl
  appendChain(nodes, ellipseArcNodes(cx, yBot, a1, b1, aEnd, aInJoinPos, kScale));
  // 4. Lower bowl outer arc CW from join point over right, bottom, back to left tangent (3PI = PI)
  appendChain(nodes, ellipseArcNodes(cx, yBot, a2, b2, aBowlJoinPos, 3 * Math.PI, kScale));

  const inner = ellipse(cx, yBot, Math.max(3, rx - sw), Math.max(3, ryBot - sh), Math.min(f.k, 0.6), true);
  return { width: w, subs: [closeChain(nodes), inner] };
}

function glyph9(f: FontSpec): GlyphData {
  return rotate180(glyph6(f));
}

function glyph3(f: FontSpec): GlyphData {
  const w = f.w;
  const cx = w / 2;
  const sw = f.sw;
  const sh = f.sh;

  if (f.chamfer > 0) {
    const c = f.chamfer * 0.85;
    const yMid = 100 * f.waist;
    const mh = sh * 0.5;
    const topW = w * f.topScale;
    const tx0 = cx - topW / 2;
    const tx1 = cx + topW / 2;
    const pinch = 5.5;
    const barL = w * 0.34;
    return {
      width: w,
      subs: [
        poly([
          [tx0, 0],
          [tx1 - c, 0],
          [tx1, c],
          [tx1, yMid - pinch],
          [tx1 - pinch, yMid],
          [w, yMid + pinch],
          [w, 100 - c],
          [w - c, 100],
          [0, 100],
          [0, 100 - sh],
          [w - sw, 100 - sh],
          [w - sw, yMid + mh],
          [barL, yMid + mh],
          [barL, yMid - mh],
          [tx1 - sw, yMid - mh],
          [tx1 - sw, sh],
          [tx0, sh],
        ]),
      ],
    };
  }

  const shLobe = Math.min(sh, 12);
  const overlap = 4.5;
  const ry1 = (100 * f.waist + overlap) / 2;
  const y1 = ry1;
  const ry2 = (100 * (1 - f.waist) + overlap) / 2;
  const y2 = 100 - ry2;
  const rx2 = w / 2;
  const rx1 = rx2 * f.topScale;
  const kScale = f.k / 0.5522847498;

  const { xw, yw } = stackedEllipseWaist(y1, rx1, ry1, y2, rx2, ry2);
  const aTopR = Math.atan2((yw - y1) / ry1, xw / rx1);
  const aBotR = Math.atan2((yw - y2) / ry2, xw / rx2);

  const aTopStart = Math.PI + 0.14 * Math.PI;
  const aBotEnd = Math.PI - 0.14 * Math.PI;
  const swTop = sw * (0.5 + 0.5 * f.topScale);
  const rx1In = Math.max(3, rx1 - swTop);
  const ry1In = Math.max(4, ry1 - shLobe);
  const rx2In = Math.max(3, rx2 - sw);
  const ry2In = Math.max(4, ry2 - shLobe);

  // Middle bar spans from xBarL into the inner bowls
  const midHalf = Math.max(3.5, shLobe * 0.45);
  const yMidTop = Math.min(y1 + ry1In * 0.92, yw - midHalf);
  const yMidBot = Math.max(y2 - ry2In * 0.92, yw + midHalf);
  const aTopInMid = Math.asin(Math.max(-0.98, Math.min(0.98, (yMidTop - y1) / ry1In)));
  const aBotInMid = Math.asin(Math.max(-0.98, Math.min(0.98, (yMidBot - y2) / ry2In)));
  const xBarL = cx - rx2 * 0.22;

  const pTopOut = { x: cx + rx1 * Math.cos(aTopStart), y: y1 + ry1 * Math.sin(aTopStart) };
  const pTopIn = { x: cx + rx1In * Math.cos(aTopStart), y: y1 + ry1In * Math.sin(aTopStart) };
  const pBotOut = { x: cx + rx2 * Math.cos(aBotEnd), y: y2 + ry2 * Math.sin(aBotEnd) };
  const pBotIn = { x: cx + rx2In * Math.cos(aBotEnd), y: y2 + ry2In * Math.sin(aBotEnd) };

  const nodes: Node[] = [];
  // Top outer CW from top-left over top to right waist
  appendChain(nodes, ellipseArcNodes(cx, y1, rx1, ry1, aTopStart, 2 * Math.PI + aTopR, kScale));
  // Bottom outer CW from right waist over bottom to bottom-left
  appendChain(nodes, ellipseArcNodes(cx, y2, rx2, ry2, aBotR, aBotEnd, kScale));
  // Bottom-left terminal cap
  appendCap(nodes, pBotOut, pBotIn, f.cap);
  // Bottom inner CCW from bottom-left back around right to middle bar bottom
  appendChain(nodes, ellipseArcNodes(cx, y2, rx2In, ry2In, aBotEnd, aBotInMid, kScale));
  // Middle bar left end
  appendChain(nodes, [
    { x: xBarL, y: yMidBot },
    { x: xBarL, y: yMidTop },
  ]);
  // Top inner CCW from middle bar top around right & top back to top-left
  appendChain(nodes, ellipseArcNodes(cx, y1, rx1In, ry1In, 2 * Math.PI + aTopInMid, aTopStart, kScale));
  // Top-left terminal cap
  appendCap(nodes, pTopIn, pTopOut, f.cap);

  return { width: w, subs: [closeChain(nodes)] };
}

function glyph5(f: FontSpec): GlyphData {
  const w = f.w;
  const cx = w / 2;
  const sw = f.sw;
  const sh = f.sh;

  if (f.chamfer > 0) {
    const c = f.chamfer * 0.85;
    const yBowlTop = 38;
    return {
      width: w,
      subs: [
        poly([
          [2, 0],
          [w - 2, 0],
          [w - 2, sh],
          [2 + sw, sh],
          [2 + sw, yBowlTop],
          [w - c, yBowlTop],
          [w, yBowlTop + c],
          [w, 100 - c],
          [w - c, 100],
          [c, 100],
          [0, 100 - c],
          [0, 76],
          [sw, 76],
          [sw, 100 - sh],
          [w - sw, 100 - sh],
          [w - sw, yBowlTop + sh],
          [2, yBowlTop + sh],
        ]),
      ],
    };
  }

  const rx = w / 2;
  const ryBot = f.serif === 'deco' ? 32 : 33;
  const yBot = 100 - ryBot;
  const rxIn = Math.max(3, rx - sw);
  const ryIn = Math.max(4, ryBot - sh);
  const kScale = f.k / 0.5522847498;

  const neckW = f.serif === 'bracket' ? sh * 1.25 : sw * 0.92;
  const xTopL = w * 0.14;
  const xTopR = w * 0.92;
  const xNeckL = xTopL - 4;
  const xNeckR = xNeckL + neckW;

  // Join points where left neck meets top of lower bowl
  const aOuterStart = Math.acos(Math.max(-0.95, Math.min(0.2, (xNeckR - cx) / rx)));
  const aOuter = 2 * Math.PI - aOuterStart; // upper-left in (1.5PI, 2PI) wait: cos < 0 => aOuterStart in (PI/2, PI), so 2PI - aOuterStart in (PI, 1.5PI)
  const yOuterJoin = yBot + ryBot * Math.sin(aOuter);

  const aInnerStart = Math.acos(Math.max(-0.92, Math.min(0.2, (xNeckL - cx) / rxIn)));
  // Clamp inner join cleanly
  const aInner = 2 * Math.PI - aInnerStart;
  const yInnerJoin = yBot + ryIn * Math.sin(aInner);
  const aEnd = Math.PI - 0.16 * Math.PI;

  const pEndOut = { x: cx + rx * Math.cos(aEnd), y: yBot + ryBot * Math.sin(aEnd) };
  const pEndIn = { x: cx + rxIn * Math.cos(aEnd), y: yBot + ryIn * Math.sin(aEnd) };

  const nodes: Node[] = [];
  // Top bar
  nodes.push({ x: xTopL, y: 0 }, { x: xTopR, y: 0 }, { x: xTopR, y: sh }, { x: xTopL + neckW, y: sh });
  // Inner neck down to top of bowl
  nodes.push({ x: xNeckR, y: yOuterJoin });
  // Lower bowl outer CW from upper-left around right & bottom to bottom-left
  appendChain(nodes, ellipseArcNodes(cx, yBot, rx, ryBot, aOuter, 2 * Math.PI + aEnd, kScale));
  // Bottom-left terminal cap
  appendCap(nodes, pEndOut, pEndIn, f.cap);
  // Lower bowl inner CCW back to upper-left inner join
  appendChain(nodes, ellipseArcNodes(cx, yBot, rxIn, ryIn, 2 * Math.PI + aEnd, aInner, kScale));
  // Outer left neck back up to top-left
  nodes.push({ x: xNeckL, y: Math.min(yInnerJoin, yOuterJoin + sh * 1.1) });

  return { width: w, subs: [closeChain(nodes)] };
}

function glyph2(f: FontSpec): GlyphData {
  const w = f.w;
  const cx = w / 2;
  const sw = f.sw;
  const sh = f.sh;

  if (f.chamfer > 0) {
    const c = f.chamfer * 0.85;
    return {
      width: w,
      subs: [
        poly([
          [c, 0],
          [w - c, 0],
          [w, c],
          [w, 42],
          [sw, 100 - sh],
          [w, 100 - sh],
          [w, 100],
          [0, 100],
          [0, 86],
          [w - sw, 38],
          [w - sw, sh],
          [sw, sh],
          [sw, 26],
          [0, 26],
          [0, c],
        ]),
      ],
    };
  }

  const rx = w / 2;
  const ryTop = f.serif === 'deco' ? 25 : 28;
  const yTop = ryTop;
  const rxIn = Math.max(3, rx - sw);
  const ryIn = Math.max(4, ryTop - sh);
  const kScale = f.k / 0.5522847498;

  const aStart = Math.PI + 0.08 * Math.PI;
  const aDrop = 2 * Math.PI + 0.1 * Math.PI; // just past 3 o'clock on top arch
  const pStartOut = { x: cx + rx * Math.cos(aStart), y: yTop + ryTop * Math.sin(aStart) };
  const pStartIn = { x: cx + rxIn * Math.cos(aStart), y: yTop + ryIn * Math.sin(aStart) };

  const pDropOut = { x: cx + rx * Math.cos(aDrop), y: yTop + ryTop * Math.sin(aDrop) };
  const pDropIn = { x: cx + rxIn * Math.cos(aDrop), y: yTop + ryIn * Math.sin(aDrop) };
  const baseH = f.serif === 'bracket' ? sh * 1.45 : sh;
  const xBaseIn = Math.min(w * 0.44, sw * 1.35);

  const nodes: Node[] = [];
  // 1. Top outer arch CW from left-top to right-drop
  appendChain(nodes, ellipseArcNodes(cx, yTop, rx, ryTop, aStart, aDrop, kScale));
  // 2. Right/outer diagonal sweeping down-left from pDropOut to top of base bar (xBaseIn, 100 - baseH)
  nodes[nodes.length - 1].cout = { x: pDropOut.x - 2, y: pDropOut.y + 22 };
  nodes.push({ x: xBaseIn, y: 100 - baseH, cin: { x: xBaseIn + (pDropOut.x - xBaseIn) * 0.35, y: 72 } });
  // 3. Base bar right end (walking CW: top -> right -> bottom)
  if (f.serif === 'bracket') {
    nodes.push(
      { x: w - sh * 1.5, y: 100 - baseH, cout: { x: w - sh * 0.85, y: 100 - baseH } },
      { x: w - sh * 0.85, y: 100 - baseH * 2.0 },
      { x: w, y: 100 - baseH * 2.0 },
      { x: w, y: 100 },
    );
  } else if (f.serif === 'slab') {
    nodes.push(
      { x: w - sh * 0.8, y: 100 - baseH },
      { x: w - sh * 0.8, y: 100 - baseH * 1.75 },
      { x: w, y: 100 - baseH * 1.75 },
      { x: w, y: 100 },
    );
  } else if (f.cap === 'round') {
    const r = baseH / 2;
    appendChain(nodes, ellipseArcNodes(w - r, 100 - r, r, r, -Math.PI / 2, Math.PI / 2));
  } else {
    nodes.push({ x: w, y: 100 - baseH }, { x: w, y: 100 });
  }
  // 4. Bottom base bar back to left, then up to outer diagonal start (0, 100 - baseH * 0.9)
  nodes.push({ x: 0, y: 100 }, { x: 0, y: 100 - baseH * 0.9, cout: { x: pDropIn.x * 0.32, y: 70 } });
  // 5. Left/inner diagonal sweeping up-right to pDropIn, then inner arch CCW back to pStartIn
  const inArch = ellipseArcNodes(cx, yTop, rxIn, ryIn, aDrop, aStart, kScale);
  inArch[0].cin = { x: pDropIn.x - 1, y: pDropIn.y + 18 };
  appendChain(nodes, inArch);
  // 6. Top-left terminal cap
  appendCap(nodes, pStartIn, pStartOut, f.cap);

  return { width: w, subs: [closeChain(nodes)] };
}

function glyphV(f: FontSpec): GlyphData {
  const w = f.w + (f.serif === 'deco' ? 4 : 6);
  const swL = f.sw;
  const swR = f.serif === 'bracket' ? f.sh * 1.2 : f.sw;
  const apexW = f.serif === 'deco' ? 3 : Math.min(swL, swR) * 0.72;
  const cx = w / 2;

  // Left arm: outer (0, 0) -> (cx - apexW/2, 100); inner (swL, 0) -> (cx, yIn)
  // Right arm: outer (w, 0) -> (cx + apexW/2, 100); inner (w - swR, 0) -> (cx, yIn)
  // Compute exact inner V meeting point (xIn, yIn)
  const lDx = cx - apexW / 2;
  const rDx = w - (cx + apexW / 2);
  // Inner lines parallel to outer edges shifted horizontally by swL / swR
  // Left inner: x = swL + (y/100) * lDx
  // Right inner: x = (w - swR) - (y/100) * rDx
  const yIn = (100 * (w - swR - swL)) / (lDx + rDx);
  const xIn = swL + (yIn / 100) * lDx;

  if (f.serif === 'bracket' || f.serif === 'slab') {
    const ext = 7;
    const sh = f.sh * (f.serif === 'slab' ? 0.85 : 1);
    const totalW = w + 2 * ext;
    const ox = ext;
    return {
      width: totalW,
      subs: [
        poly([
          [0, 0],
          [ox + swL + ext * 0.7, 0],
          [ox + swL + ext * 0.7, sh],
          [ox + swL + (sh / 100) * lDx, sh],
          [ox + xIn, yIn],
          [ox + (w - swR) - (sh / 100) * rDx, sh],
          [ox + w - swR - ext * 0.7, sh],
          [ox + w - swR - ext * 0.7, 0],
          [totalW, 0],
          [totalW, sh],
          [ox + w - (sh / 100) * rDx, sh],
          [ox + cx + apexW / 2, 100],
          [ox + cx - apexW / 2, 100],
          [ox + (sh / 100) * lDx, sh],
          [0, sh],
        ]),
      ],
    };
  }
  const vPts: [number, number][] = [
    [0, 0],
    [swL, 0],
    [xIn, yIn],
    [w - swR, 0],
    [w, 0],
    [cx + apexW / 2, 100],
    [cx - apexW / 2, 100],
  ];
  return {
    width: w,
    subs: [f.cap === 'round' ? roundedPoly(vPts, 4.5) : poly(vPts)],
  };
}

function glyphX(f: FontSpec): GlyphData {
  const w = f.w + (f.serif === 'deco' ? 2 : 6);
  const t1 = f.sw * 1.05; // top-left to bottom-right (thick in serif)
  const t2 = f.serif === 'bracket' ? f.sh * 1.3 : f.sw * 1.05; // top-right to bottom-left

  // Line equations x(y):
  // Bar 1 (TL->BR): left x = m1 * y, right x = t1 + m1 * y, where m1 = (w - t1) / 100
  // Bar 2 (TR->BL): left x = (w - t2) - m2 * y, right x = w - m2 * y, where m2 = (w - t2) / 100
  const m1 = (w - t1) / 100;
  const m2 = (w - t2) / 100;
  const intersect = (c1: number, s1: number, c2: number, s2: number): [number, number] => {
    const y = (c2 - c1) / (s1 - s2);
    return [c1 + s1 * y, y];
  };
  const topNotch = intersect(t1, m1, w - t2, -m2);
  const rightNotch = intersect(t1, m1, w, -m2);
  const botNotch = intersect(0, m1, w, -m2);
  const leftNotch = intersect(0, m1, w - t2, -m2);

  if (f.serif === 'bracket' || f.serif === 'slab') {
    const ext = 6;
    const sh = f.sh * (f.serif === 'slab' ? 0.85 : 1);
    const totalW = w + 2 * ext;
    const ox = ext;
    return {
      width: totalW,
      subs: [
        poly([
          [0, 0],
          [ox + t1 + ext * 0.7, 0],
          [ox + t1 + ext * 0.7, sh],
          [ox + t1 + m1 * sh, sh],
          [ox + topNotch[0], topNotch[1]],
          [ox + (w - t2) - m2 * sh, sh],
          [ox + w - t2 - ext * 0.7, sh],
          [ox + w - t2 - ext * 0.7, 0],
          [totalW, 0],
          [totalW, sh],
          [ox + w - m2 * sh, sh],
          [ox + rightNotch[0], rightNotch[1]],
          [ox + t1 + m1 * (100 - sh), 100 - sh],
          [totalW, 100 - sh],
          [totalW, 100],
          [ox + w - t1 - ext * 0.7, 100],
          [ox + w - t1 - ext * 0.7, 100 - sh],
          [ox + m1 * (100 - sh), 100 - sh],
          [ox + botNotch[0], botNotch[1]],
          [ox + w - m2 * (100 - sh), 100 - sh],
          [ox + t2 + ext * 0.7, 100 - sh],
          [ox + t2 + ext * 0.7, 100],
          [0, 100],
          [0, 100 - sh],
          [ox + (w - t2) - m2 * (100 - sh), 100 - sh],
          [ox + leftNotch[0], leftNotch[1]],
          [ox + m1 * sh, sh],
          [0, sh],
        ]),
      ],
    };
  }

  const xPts: [number, number][] = [
    [0, 0],
    [t1, 0],
    topNotch,
    [w - t2, 0],
    [w, 0],
    rightNotch,
    [w, 100],
    [w - t1, 100],
    botNotch,
    [t2, 100],
    [0, 100],
    leftNotch,
  ];
  return {
    width: w,
    subs: [f.cap === 'round' ? roundedPoly(xPts, 4.5) : poly(xPts)],
  };
}

function buildChar(ch: string, f: FontSpec): GlyphData {
  switch (ch) {
    case '0':
      return glyph0(f);
    case '1':
      return glyph1(f);
    case '2':
      return glyph2(f);
    case '3':
      return glyph3(f);
    case '4':
      return glyph4(f);
    case '5':
      return glyph5(f);
    case '6':
      return glyph6(f);
    case '7':
      return glyph7(f);
    case '8':
      return glyph8(f);
    case '9':
      return glyph9(f);
    case 'I':
      return glyphI(f);
    case 'V':
      return glyphV(f);
    case 'X':
      return glyphX(f);
    default:
      return { width: f.w * 0.5, subs: [] };
  }
}

const glyphCache = new Map<string, GlyphData>();

export function getGlyph(font: FontFamily, ch: string): GlyphData {
  const key = `${font}:${ch}`;
  let g = glyphCache.get(key);
  if (!g) {
    g = buildChar(ch, FONTS[font]);
    glyphCache.set(key, g);
  }
  return g;
}

/** Width of a numeral string in mm for a given font and cap height */
export function numeralTextWidth(text: string, size: number, font: FontFamily, singleStroke = false): number {
  if (singleStroke) return textWidth(text, size);
  const f = FONTS[font];
  const scale = size / 100;
  let w = 0;
  for (let i = 0; i < text.length; i++) {
    if (i > 0) w += f.tracking;
    w += getGlyph(font, text[i]).width;
  }
  return w * scale;
}

/**
 * Build closed outline SubPaths for a numeral string (e.g. "12", "VIII") centered at (0, 0) in upright mm coordinates.
 * Returns one array of SubPaths per character so automatic stencil bridges can be applied per glyph cleanly!
 */
export function buildNumeralGlyphsLocal(text: string, size: number, font: FontFamily): SubPath[][] {
  const f = FONTS[font];
  const scale = size / 100;
  const glyphs = Array.from(text, (ch) => getGlyph(font, ch));
  let totalW = 0;
  for (let i = 0; i < glyphs.length; i++) {
    if (i > 0) totalW += f.tracking;
    totalW += glyphs[i].width;
  }
  const startX = (-totalW / 2) * scale;
  const startY = -size / 2;
  const out: SubPath[][] = [];
  let pen = 0;
  for (let i = 0; i < glyphs.length; i++) {
    const g = glyphs[i];
    const tx = startX + pen * scale;
    out.push(g.subs.map((s) => transformSub(s, tx, startY, scale, 0)));
    pen += g.width + f.tracking;
  }
  return out;
}

/** Build single-stroke engraved lines for a numeral string placed at (x, y) with optional rotation (degrees CW) */
export function buildStrokeNumeral(text: string, size: number, x: number, y: number, angleDeg = 0): SubPath[] {
  return strokeText(text, size, { x, y, align: 'center', valign: 'middle', angle: angleDeg });
}
