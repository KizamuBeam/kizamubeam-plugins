// Parametric vector outline font engine for House Number Sign.
// 6 distinct architectural font families (sans, serif, rounded, artdeco, slab, technical)
// with configurable boldness, supporting 0-9, A-Z, Ä Ö Ü ß, European accents, and punctuation.
// Coordinates in glyph design space: y in [0..100] (0 = cap top, 100 = baseline), y down.
// Outer contours are CW (positive area); inner holes are CCW (negative area).
import type { Node, SubPath } from '../../../sdk/ts';
import {
  appendChain,
  closeChain,
  ellipse,
  ellipseArcNodes,
  poly,
  roundedPoly,
  scaleSub,
  transformSub,
  translateSub,
  type FontFamily,
} from './types';

interface FontSpec {
  w: number;
  sw: number;
  sh: number;
  k: number;
  serif: 'none' | 'bracket' | 'slab' | 'deco';
  cap: 'flat' | 'round' | 'ball';
  chamfer: number;
  waist: number;
  topScale: number;
}

const BASE_FONTS: Record<FontFamily, FontSpec> = {
  sans: { w: 62, sw: 15.5, sh: 13.5, k: 0.56, serif: 'none', cap: 'flat', chamfer: 0, waist: 0.46, topScale: 0.9 },
  serif: { w: 64, sw: 17, sh: 8.5, k: 0.56, serif: 'bracket', cap: 'ball', chamfer: 0, waist: 0.45, topScale: 0.88 },
  rounded: { w: 66, sw: 16.5, sh: 15, k: 0.5523, serif: 'none', cap: 'round', chamfer: 0, waist: 0.46, topScale: 0.91 },
  artdeco: { w: 50, sw: 13, sh: 9, k: 0.56, serif: 'deco', cap: 'flat', chamfer: 0, waist: 0.38, topScale: 0.84 },
  slab: { w: 64, sw: 16.5, sh: 14.5, k: 0.7, serif: 'slab', cap: 'flat', chamfer: 0, waist: 0.47, topScale: 0.93 },
  technical: { w: 62, sw: 15, sh: 14, k: 0.56, serif: 'none', cap: 'flat', chamfer: 13, waist: 0.47, topScale: 0.94 },
};

function getSpec(font: FontFamily, boldnessPct: number): FontSpec {
  const b = BASE_FONTS[font] ?? BASE_FONTS.sans;
  const f = Math.max(0.7, Math.min(1.4, boldnessPct / 100));
  const sw = Math.min(b.w * 0.36, b.sw * f);
  const sh = Math.min(20, b.sh * f);
  // Gently widen very bold glyphs so counters stay crisp and open
  const wBoost = f > 1 ? 1 + (f - 1) * 0.22 : 1;
  return { ...b, w: b.w * wBoost, sw, sh };
}

/** Nominal minimum stroke width in mm for a given font, boldness (%) and cap height */
export function getFontStrokeWidth(font: FontFamily, boldnessPct: number, height: number): number {
  const s = getSpec(font, boldnessPct);
  return (Math.min(s.sw, s.sh) / 100) * height;
}

export interface GlyphData {
  width: number;
  subs: SubPath[];
}

function appendCap(dst: Node[], p1: { x: number; y: number }, p2: { x: number; y: number }, cap: FontSpec['cap']): void {
  if (cap === 'flat') {
    appendChain(dst, [{ x: p1.x, y: p1.y }, { x: p2.x, y: p2.y }]);
    return;
  }
  const mx = (p1.x + p2.x) / 2;
  const my = (p1.y + p2.y) / 2;
  const r = Math.hypot(p2.x - p1.x, p2.y - p1.y) / 2;
  if (r < 0.2) {
    appendChain(dst, [{ x: p1.x, y: p1.y }, { x: p2.x, y: p2.y }]);
    return;
  }
  const a0 = Math.atan2(p1.y - my, p1.x - mx);
  const bulge = cap === 'ball' ? 1.12 : 1.0;
  const arc = ellipseArcNodes(mx, my, r * bulge, r * bulge, a0, a0 + Math.PI);
  arc[0].x = p1.x;
  arc[0].y = p1.y;
  arc[arc.length - 1].x = p2.x;
  arc[arc.length - 1].y = p2.y;
  appendChain(dst, arc);
}

function chamferRect(x0: number, y0: number, x1: number, y1: number, c: number, ccw = false): SubPath {
  const ch = Math.max(0, Math.min(c, (x1 - x0) * 0.4, (y1 - y0) * 0.4));
  const pts: [number, number][] =
    ch <= 0.1
      ? [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
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

function stackedEllipseWaist(y1: number, rx1: number, ry1: number, y2: number, rx2: number, ry2: number): { xw: number; yw: number } {
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
    if (r1 >= y1 && r1 <= y2) yw = r1;
    else if (r2 >= y1 && r2 <= y2) yw = r2;
  }
  const t = Math.max(0, 1 - ((yw - y1) / ry1) ** 2);
  return { xw: rx1 * Math.sqrt(t), yw };
}

function rotate180(g: GlyphData): GlyphData {
  return {
    width: g.width,
    subs: g.subs.map((s) => transformSub(s, g.width, 100, 1, Math.PI)),
  };
}

function lineIntersect(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, x4: number, y4: number): [number, number] {
  const d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(d) < 1e-9) return [(x2 + x3) / 2, (y2 + y3) / 2];
  const a = x1 * y2 - y1 * x2;
  const b = x3 * y4 - y3 * x4;
  return [(a * (x3 - x4) - (x1 - x2) * b) / d, (a * (y3 - y4) - (y1 - y2) * b) / d];
}

function maybeRound(pts: [number, number][], f: FontSpec, r = 3.5): SubPath {
  return f.cap === 'round' ? roundedPoly(pts, r) : poly(pts);
}

// ================================================================== DIGITS 0-9

function glyph0(f: FontSpec): GlyphData {
  const w = f.w;
  if (f.chamfer > 0) {
    const outer = chamferRect(0, 0, w, 100, f.chamfer, false);
    const inner = chamferRect(f.sw, f.sh, w - f.sw, 100 - f.sh, Math.max(3, f.chamfer - f.sw * 0.45), true);
    return { width: w, subs: [outer, inner] };
  }
  const cx = w / 2;
  const outer = ellipse(cx, 50, w / 2, 50, f.k, false);
  const inner = ellipse(cx, 50, Math.max(4, w / 2 - f.sw), Math.max(6, 50 - f.sh), Math.min(f.k, 0.62), true);
  return { width: w, subs: [outer, inner] };
}

function glyph1(f: FontSpec): GlyphData {
  const sw = f.sw;
  const sh = f.sh;
  if (f.serif === 'bracket') {
    const extL = 16;
    const extR = 11;
    const w = extL + sw + extR;
    const sx = extL;
    const br = 5.5;
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
    const bh = sh * 0.82;
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
      subs: [poly([[sx + sw, 0], [sx + sw, 100], [sx, 100], [sx, 20], [0, 20], [sx - 1, 0]])],
    };
  }
  if (f.cap === 'round') {
    const extL = 16;
    const w = extL + sw;
    const sx = extL;
    const r = sw / 2;
    const nodes: Node[] = [];
    appendChain(nodes, ellipseArcNodes(sx + r, r, r, r, -Math.PI / 2, 0));
    appendChain(nodes, ellipseArcNodes(sx + r, 100 - r, r, r, 0, Math.PI));
    nodes.push({ x: sx, y: 27 });
    const fx = 5;
    const fy = 31;
    const aFlag = Math.atan2(fy - r, fx - (sx + r));
    const fr = Math.min(r * 0.78, 7.5);
    appendChain(nodes, ellipseArcNodes(fx, fy, fr, fr, aFlag - Math.PI / 2, aFlag + Math.PI / 2));
    nodes.push({ x: sx + r, y: 0 });
    return { width: w, subs: [closeChain(nodes)] };
  }
  const extL = 18;
  const w = extL + sw;
  const sx = extL;
  return {
    width: w,
    subs: [poly([[sx + sw, 0], [sx + sw, 100], [sx, 100], [sx, 24], [0, 34], [0, 19], [sx + 2, 0]])],
  };
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
          [c, 0], [w - c, 0], [w, c], [w, 42],
          [sw, 100 - sh], [w, 100 - sh], [w, 100], [0, 100], [0, 86],
          [w - sw, 38], [w - sw, sh], [sw, sh], [sw, 26], [0, 26], [0, c],
        ]),
      ],
    };
  }

  const rx = w / 2;
  const ryTop = f.serif === 'deco' ? 26 : 28;
  const yTop = ryTop;
  const rxIn = Math.max(4, rx - sw);
  const ryIn = Math.max(4, ryTop - sh);
  const kScale = f.k / 0.5522847498;
  const aStart = Math.PI + 0.08 * Math.PI;
  const aDrop = 2 * Math.PI + 0.1 * Math.PI;
  const pStartOut = { x: cx + rx * Math.cos(aStart), y: yTop + ryTop * Math.sin(aStart) };
  const pStartIn = { x: cx + rxIn * Math.cos(aStart), y: yTop + ryIn * Math.sin(aStart) };
  const pDropOut = { x: cx + rx * Math.cos(aDrop), y: yTop + ryTop * Math.sin(aDrop) };
  const pDropIn = { x: cx + rxIn * Math.cos(aDrop), y: yTop + ryIn * Math.sin(aDrop) };
  const baseH = f.serif === 'bracket' ? Math.min(18, sh * 1.35) : sh;
  const xBaseIn = Math.min(w * 0.44, sw * 1.25);

  const nodes: Node[] = [];
  appendChain(nodes, ellipseArcNodes(cx, yTop, rx, ryTop, aStart, aDrop, kScale));
  nodes[nodes.length - 1].cout = { x: pDropOut.x - 2, y: pDropOut.y + 22 };
  nodes.push({ x: xBaseIn, y: 100 - baseH, cin: { x: xBaseIn + (pDropOut.x - xBaseIn) * 0.35, y: 72 } });
  if (f.serif === 'bracket') {
    nodes.push(
      { x: w - baseH * 1.1, y: 100 - baseH, cout: { x: w - baseH * 0.65, y: 100 - baseH } },
      { x: w - baseH * 0.65, y: 100 - baseH * 1.75 },
      { x: w, y: 100 - baseH * 1.75 },
      { x: w, y: 100 },
    );
  } else if (f.serif === 'slab') {
    nodes.push(
      { x: w - baseH * 0.65, y: 100 - baseH },
      { x: w - baseH * 0.65, y: 100 - baseH * 1.55 },
      { x: w, y: 100 - baseH * 1.55 },
      { x: w, y: 100 },
    );
  } else if (f.cap === 'round') {
    const r = baseH / 2;
    appendChain(nodes, ellipseArcNodes(w - r, 100 - r, r, r, -Math.PI / 2, Math.PI / 2));
  } else {
    nodes.push({ x: w, y: 100 - baseH }, { x: w, y: 100 });
  }
  nodes.push({ x: 0, y: 100 }, { x: 0, y: 100 - baseH * 0.9, cout: { x: pDropIn.x * 0.32, y: 70 } });
  const inArch = ellipseArcNodes(cx, yTop, rxIn, ryIn, aDrop, aStart, kScale);
  inArch[0].cin = { x: pDropIn.x - 1, y: pDropIn.y + 18 };
  appendChain(nodes, inArch);
  appendCap(nodes, pStartIn, pStartOut, f.cap);
  return { width: w, subs: [closeChain(nodes)] };
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
          [tx0, 0], [tx1 - c, 0], [tx1, c], [tx1, yMid - pinch], [tx1 - pinch, yMid],
          [w, yMid + pinch], [w, 100 - c], [w - c, 100], [0, 100], [0, 100 - sh],
          [w - sw, 100 - sh], [w - sw, yMid + mh], [barL, yMid + mh], [barL, yMid - mh],
          [tx1 - sw, yMid - mh], [tx1 - sw, sh], [tx0, sh],
        ]),
      ],
    };
  }

  const shLobe = Math.min(sh, 12.5);
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
  const rx1In = Math.max(4, rx1 - swTop);
  const ry1In = Math.max(4, ry1 - shLobe);
  const rx2In = Math.max(4, rx2 - sw);
  const ry2In = Math.max(4, ry2 - shLobe);

  const midHalf = Math.max(3.5, shLobe * 0.44);
  const yMidTop = Math.min(y1 + ry1In * 0.9, yw - midHalf);
  const yMidBot = Math.max(y2 - ry2In * 0.9, yw + midHalf);
  const aTopInMid = Math.asin(Math.max(-0.96, Math.min(0.96, (yMidTop - y1) / ry1In)));
  const aBotInMid = Math.asin(Math.max(-0.96, Math.min(0.96, (yMidBot - y2) / ry2In)));
  const xBarL = cx - rx2 * 0.2;

  const pTopOut = { x: cx + rx1 * Math.cos(aTopStart), y: y1 + ry1 * Math.sin(aTopStart) };
  const pTopIn = { x: cx + rx1In * Math.cos(aTopStart), y: y1 + ry1In * Math.sin(aTopStart) };
  const pBotOut = { x: cx + rx2 * Math.cos(aBotEnd), y: y2 + ry2 * Math.sin(aBotEnd) };
  const pBotIn = { x: cx + rx2In * Math.cos(aBotEnd), y: y2 + ry2In * Math.sin(aBotEnd) };

  const nodes: Node[] = [];
  appendChain(nodes, ellipseArcNodes(cx, y1, rx1, ry1, aTopStart, 2 * Math.PI + aTopR, kScale));
  appendChain(nodes, ellipseArcNodes(cx, y2, rx2, ry2, aBotR, aBotEnd, kScale));
  appendCap(nodes, pBotOut, pBotIn, f.cap);
  appendChain(nodes, ellipseArcNodes(cx, y2, rx2In, ry2In, aBotEnd, aBotInMid, kScale));
  appendChain(nodes, [{ x: xBarL, y: yMidBot }, { x: xBarL, y: yMidTop }]);
  appendChain(nodes, ellipseArcNodes(cx, y1, rx1In, ry1In, 2 * Math.PI + aTopInMid, aTopStart, kScale));
  appendCap(nodes, pTopIn, pTopOut, f.cap);
  return { width: w, subs: [closeChain(nodes)] };
}

function glyph4(f: FontSpec): GlyphData {
  const w = f.w + (f.serif === 'deco' ? 4 : 3);
  const sw = f.sw;
  const sh = f.sh;
  const barTop = f.serif === 'deco' ? 66 : 62;
  const barBot = barTop + sh;
  const rightOver = f.serif === 'deco' ? 8 : 10;
  const stemR = w - rightOver;
  const stemL = stemR - sw;
  const dx = stemL;
  const dy = barTop;
  const len = Math.hypot(dx, dy);
  const diagW = Math.min(stemL * 0.42, f.serif === 'bracket' ? sh * 1.25 : sw * 0.85);
  const nx = (dy / len) * diagW;
  const ny = (dx / len) * diagW;
  const xTriL = Math.max(diagW * 1.05, Math.min(stemL - 5, stemL + nx - ((barTop - ny) / dy) * dx));
  const yTriTop = Math.max(sh * 1.1, Math.min(barTop - 8, ny + ((stemL + nx - stemL) / dx) * dy));

  const outerPts: [number, number][] = [
    [stemL, 0], [stemR, 0], [stemR, barTop], [w, barTop], [w, barBot], [stemR, barBot],
  ];
  if (f.serif === 'bracket' || f.serif === 'slab') {
    const ext = 7;
    const bh = sh * (f.serif === 'slab' ? 0.85 : 1);
    outerPts.push(
      [stemR, 100 - bh], [Math.min(w, stemR + ext), 100 - bh], [Math.min(w, stemR + ext), 100],
      [Math.max(0, stemL - ext), 100], [Math.max(0, stemL - ext), 100 - bh], [stemL, 100 - bh],
    );
  } else {
    outerPts.push([stemR, 100], [stemL, 100]);
  }
  outerPts.push([stemL, barBot], [0, barBot], [0, barTop]);
  const inner = poly([[xTriL, barTop], [stemL, yTriTop], [stemL, barTop]]);
  return { width: w, subs: [maybeRound(outerPts, f, 4), inner] };
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
          [2, 0], [w - 2, 0], [w - 2, sh], [2 + sw, sh], [2 + sw, yBowlTop],
          [w - c, yBowlTop], [w, yBowlTop + c], [w, 100 - c], [w - c, 100],
          [c, 100], [0, 100 - c], [0, 76], [sw, 76], [sw, 100 - sh],
          [w - sw, 100 - sh], [w - sw, yBowlTop + sh], [2, yBowlTop + sh],
        ]),
      ],
    };
  }

  const rx = w / 2;
  const ryBot = f.serif === 'deco' ? 32 : 33;
  const yBot = 100 - ryBot;
  const rxIn = Math.max(4, rx - sw);
  const ryIn = Math.max(4, ryBot - sh);
  const kScale = f.k / 0.5522847498;
  const neckW = Math.min(rx * 0.65, f.serif === 'bracket' ? sh * 1.25 : sw * 0.9);
  const xTopL = w * 0.14;
  const xTopR = w * 0.92;
  const xNeckL = Math.max(2, xTopL - 3);
  const xNeckR = xNeckL + neckW;

  const aOuter = 2 * Math.PI - Math.acos(Math.max(-0.92, Math.min(0.2, (xNeckR - cx) / rx)));
  const yOuterJoin = yBot + ryBot * Math.sin(aOuter);
  const aInner = 2 * Math.PI - Math.acos(Math.max(-0.88, Math.min(0.2, (xNeckL - cx) / rxIn)));
  const yInnerJoin = yBot + ryIn * Math.sin(aInner);
  const aEnd = Math.PI - 0.16 * Math.PI;
  const pEndOut = { x: cx + rx * Math.cos(aEnd), y: yBot + ryBot * Math.sin(aEnd) };
  const pEndIn = { x: cx + rxIn * Math.cos(aEnd), y: yBot + ryIn * Math.sin(aEnd) };

  const nodes: Node[] = [
    { x: xTopL, y: 0 }, { x: xTopR, y: 0 }, { x: xTopR, y: sh }, { x: xTopL + neckW, y: sh },
    { x: xNeckR, y: yOuterJoin },
  ];
  appendChain(nodes, ellipseArcNodes(cx, yBot, rx, ryBot, aOuter, 2 * Math.PI + aEnd, kScale));
  appendCap(nodes, pEndOut, pEndIn, f.cap);
  appendChain(nodes, ellipseArcNodes(cx, yBot, rxIn, ryIn, 2 * Math.PI + aEnd, aInner, kScale));
  nodes.push({ x: xNeckL, y: Math.min(yInnerJoin, yOuterJoin + sh * 1.05) });
  return { width: w, subs: [closeChain(nodes)] };
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
      [c, 0], [w - c, 0], [w, c], [w, 22], [w - sw, 22], [w - sw, sh], [sw, sh],
      [sw, yBowlTop], [w - c, yBowlTop], [w, yBowlTop + c], [w, 100 - c],
      [w - c, 100], [c, 100], [0, 100 - c], [0, c],
    ]);
    const inner = chamferRect(sw, yBowlTop + sh, w - sw, 100 - sh, 3, true);
    return { width: w, subs: [outer, inner] };
  }

  const rx = w / 2;
  const ryBot = f.serif === 'deco' ? 30 : 31;
  const yBot = 100 - ryBot;
  const ryArch = yBot;
  const a1 = Math.max(4, rx - sw);
  const b1 = Math.max(6, ryArch - sh);
  const a2 = rx;
  const b2 = ryBot;
  const denom = 1 / (a1 * a1 * b2 * b2) - 1 / (a2 * a2 * b1 * b1);
  const u2 = (1 / (b2 * b2) - 1 / (b1 * b1)) / denom;
  const v2 = (1 / (a1 * a1) - 1 / (a2 * a2)) / denom;
  const u = -Math.sqrt(Math.max(0.01, u2));
  const v = -Math.sqrt(Math.max(0.01, v2));
  const aInJoin = Math.atan2(v / b1, u / a1);
  const aBowlJoin = Math.atan2(v / b2, u / a2);
  const aInJoinPos = aInJoin < 0 ? aInJoin + 2 * Math.PI : aInJoin;
  const aBowlJoinPos = aBowlJoin < 0 ? aBowlJoin + 2 * Math.PI : aBowlJoin;
  const aEnd = 2 * Math.PI - 0.24 * Math.PI;
  const kScale = f.k / 0.5522847498;
  const pEndOut = { x: cx + rx * Math.cos(aEnd), y: yBot + ryArch * Math.sin(aEnd) };
  const pEndIn = { x: cx + a1 * Math.cos(aEnd), y: yBot + b1 * Math.sin(aEnd) };

  const nodes: Node[] = [];
  appendChain(nodes, ellipseArcNodes(cx, yBot, rx, ryArch, Math.PI, aEnd, kScale));
  appendCap(nodes, pEndOut, pEndIn, f.cap);
  appendChain(nodes, ellipseArcNodes(cx, yBot, a1, b1, aEnd, aInJoinPos, kScale));
  appendChain(nodes, ellipseArcNodes(cx, yBot, a2, b2, aBowlJoinPos, 3 * Math.PI, kScale));
  const inner = ellipse(cx, yBot, Math.max(4, rx - sw), Math.max(4, ryBot - sh), Math.min(f.k, 0.6), true);
  return { width: w, subs: [closeChain(nodes), inner] };
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
      { x: 0, y: 0 }, { x: w, y: 0 },
      { x: w, y: sh * 1.3, cout: { x: w * 0.72, y: 42 } },
      { x: xFootR, y: 100, cin: { x: xFootR + 2, y: 74 } },
      { x: xFootL, y: 100, cout: { x: xFootL + 2, y: 72 } },
      { x: w - sw * 0.9, y: sh * 1.4, cin: { x: w * 0.56, y: 40 } },
      { x: sh * 1.2, y: sh * 1.4 }, { x: sh * 0.85, y: drop }, { x: 0, y: drop },
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
          [0, 0], [w, 0], [w, sh], [xFootR, 100], [xFootL, 100],
          [w - sw, sh], [sh * 0.85, sh], [sh * 0.85, drop], [0, drop],
        ]),
      ],
    };
  }
  if (f.cap === 'round') {
    const r = sh / 2;
    const xFoot = w * 0.34;
    const rf = sw / 2;
    const nodes: Node[] = [];
    appendChain(nodes, ellipseArcNodes(r, r, r, r, Math.PI / 2, 1.5 * Math.PI));
    appendChain(nodes, ellipseArcNodes(w - r, r, r, r, -Math.PI / 2, 0.2));
    appendChain(nodes, ellipseArcNodes(xFoot, 100 - rf, rf, rf, 0.2, Math.PI + 0.2));
    nodes.push({ x: w - sw * 1.15, y: sh }, { x: r, y: sh });
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
          [0, 0], [w - c, 0], [w, c], [w, 22], [xFootR, 64], [xFootR, 100],
          [xFootL, 100], [xFootL, 58], [w - sw, 20], [w - sw, sh], [0, sh],
        ]),
      ],
    };
  }
  const xFootL = f.serif === 'deco' ? w * 0.2 : w * 0.26;
  return {
    width: w,
    subs: [poly([[0, 0], [w, 0], [w, sh], [xFootL + sw, 100], [xFootL, 100], [w - sw * 1.05, sh], [0, sh]])],
  };
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
      [tx0 + c, 0], [tx1 - c, 0], [tx1, c], [tx1, yMid - pinch], [tx1 - pinch, yMid],
      [w, yMid + pinch], [w, 100 - c], [w - c, 100], [c, 100], [0, 100 - c],
      [0, yMid + pinch], [tx0 + pinch, yMid], [tx0, yMid - pinch], [tx0, c],
    ]);
    const hHalf = sh * 0.48;
    const topHole = chamferRect(tx0 + sw, sh, tx1 - sw, yMid - hHalf, 3, true);
    const botHole = chamferRect(sw, yMid + hHalf, w - sw, 100 - sh, 3, true);
    return { width: w, subs: [outer, topHole, botHole] };
  }

  const shLobe = Math.min(sh, 12.5);
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
  appendChain(nodes, ellipseArcNodes(cx, y1, rx1, ry1, Math.PI - aTopR, 2 * Math.PI + aTopR, kScale));
  appendChain(nodes, ellipseArcNodes(cx, y2, rx2, ry2, aBotR, Math.PI - aBotR, kScale));
  const swTop = sw * (0.5 + 0.5 * f.topScale);
  const topHole = ellipse(cx, y1, Math.max(4, rx1 - swTop), Math.max(4, ry1 - shLobe), Math.min(f.k, 0.6), true);
  const botHole = ellipse(cx, y2, Math.max(4, rx2 - sw), Math.max(4, ry2 - shLobe), Math.min(f.k, 0.6), true);
  return { width: w, subs: [closeChain(nodes), topHole, botHole] };
}

function glyph9(f: FontSpec): GlyphData {
  return rotate180(glyph6(f));
}

// ================================================================== LETTERS A-Z

function glyphA(f: FontSpec): GlyphData {
  const w = f.w + 8;
  const cx = w / 2;
  const swL = f.serif === 'bracket' ? Math.max(9, f.sh * 1.25) : f.sw;
  const swR = f.sw;
  const sh = f.sh;
  const apexW = f.serif === 'deco' ? Math.min(swL, swR) * 0.7 : Math.min(swL, swR) * 0.9;
  const barBot = f.serif === 'deco' ? 76 : 74;
  const barTop = barBot - sh;

  // Outer left: (cx - apexW/2, 0) -> (0, 100); Outer right: (cx + apexW/2, 0) -> (w, 100)
  const dxL = cx - apexW / 2;
  const dxR = w - (cx + apexW / 2);
  // Inner legs parallel to outer edges shifted horizontally inward by swL / swR
  // Left inner: x = swL + (1 - y/100) * dxL  (Wait: at y=100, x=swL; at y=0, x=swL + dxL)
  const xLAt = (y: number) => swL + ((100 - y) / 100) * dxL;
  const xRAt = (y: number) => w - swR - ((100 - y) / 100) * dxR;
  const [xApexIn, yApexIn] = lineIntersect(xLAt(100), 100, xLAt(0), 0, xRAt(100), 100, xRAt(0), 0);

  const xBarInL = xLAt(barTop);
  const xBarInR = xRAt(barTop);
  const xBotInL = xLAt(barBot);
  const xBotInR = xRAt(barBot);

  const outerPts: [number, number][] = [
    [cx - apexW / 2, 0],
    [cx + apexW / 2, 0],
    [w, 100],
    [w - swR, 100],
    [xBotInR, barBot],
    [xBotInL, barBot],
    [swL, 100],
    [0, 100],
  ];
  const inner = poly([
    [xApexIn, Math.min(barTop - 6, yApexIn)],
    [xBarInL, barTop],
    [xBarInR, barTop],
  ]);
  return { width: w, subs: [maybeRound(outerPts, f, 3.5), inner] };
}

function glyphB(f: FontSpec): GlyphData {
  const w = f.w + 2;
  const sw = f.sw;
  const sh = Math.min(f.sh, 12.5);
  const yMid = 100 * f.waist;

  if (f.chamfer > 0) {
    const c = f.chamfer * 0.78;
    const topW = w * 0.92;
    const pinch = 5;
    const outer = poly([
      [0, 0], [topW - c, 0], [topW, c], [topW, yMid - pinch], [topW - pinch, yMid],
      [w, yMid + pinch], [w, 100 - c], [w - c, 100], [0, 100],
    ]);
    const hHalf = sh * 0.48;
    const topHole = chamferRect(sw, sh, topW - sw, yMid - hHalf, 3, true);
    const botHole = chamferRect(sw, yMid + hHalf, w - sw, 100 - sh, 3, true);
    return { width: w, subs: [outer, topHole, botHole] };
  }

  const kScale = f.k / 0.5522847498;
  const overlap = 4;
  const ry1 = (yMid + overlap) / 2;
  const y1 = ry1;
  const ry2 = (100 - yMid + overlap) / 2;
  const y2 = 100 - ry2;
  const xSpine = w * 0.52;
  const rx1 = w * 0.92 - xSpine;
  const rx2 = w - xSpine;

  const { xw, yw } = stackedEllipseWaist(y1, rx1, ry1, y2, rx2, ry2);
  const aTopR = Math.atan2((yw - y1) / ry1, xw / rx1);
  const aBotR = Math.atan2((yw - y2) / ry2, xw / rx2);

  const nodes: Node[] = [{ x: 0, y: 0 }];
  appendChain(nodes, ellipseArcNodes(xSpine, y1, rx1, ry1, -Math.PI / 2, aTopR, kScale));
  appendChain(nodes, ellipseArcNodes(xSpine, y2, rx2, ry2, aBotR, Math.PI / 2, kScale));
  nodes.push({ x: 0, y: 100 });

  // Inner bowls (CCW)
  const makeD = (xL: number, xC: number, rx: number, cy: number, ry: number): SubPath => {
    const rxI = Math.max(3, rx);
    const ryI = Math.max(4, ry);
    const nds: Node[] = [];
    // CCW: top-left -> bottom-left -> bottom-arc-start -> arc bottom to top -> top-left
    nds.push({ x: xL, y: cy - ryI }, { x: xL, y: cy + ryI });
    appendChain(nds, ellipseArcNodes(xC, cy, rxI, ryI, Math.PI / 2, -Math.PI / 2, kScale));
    return closeChain(nds);
  };
  const midHalf = sh * 0.48;
  const topRy = (yMid - midHalf - sh) / 2;
  const botRy = (100 - sh - (yMid + midHalf)) / 2;
  const topHole = makeD(sw, Math.max(sw + 4, xSpine - 2), Math.max(4, w * 0.92 - sw - Math.max(sw + 4, xSpine - 2)), sh + topRy, topRy);
  const botHole = makeD(sw, Math.max(sw + 4, xSpine - 2), Math.max(4, w - sw - Math.max(sw + 4, xSpine - 2)), yMid + midHalf + botRy, botRy);
  return { width: w, subs: [closeChain(nodes), topHole, botHole] };
}

function glyphC(f: FontSpec): GlyphData {
  const w = f.w;
  const cx = w / 2;
  const sw = f.sw;
  const sh = f.sh;

  if (f.chamfer > 0) {
    const c = f.chamfer;
    return {
      width: w,
      subs: [
        poly([
          [c, 0], [w - c, 0], [w, c], [w, 26], [w - sw, 26], [w - sw, sh],
          [sw, sh], [sw, 100 - sh], [w - sw, 100 - sh], [w - sw, 74], [w, 74],
          [w, 100 - c], [w - c, 100], [c, 100], [0, 100 - c], [0, c],
        ]),
      ],
    };
  }

  const rx = w / 2;
  const ry = 50;
  const rxIn = Math.max(4, rx - sw);
  const ryIn = Math.max(6, ry - sh);
  const kScale = f.k / 0.5522847498;
  const gapA = 0.24 * Math.PI; // ~43° opening on right
  const aStart = gapA;
  const aEnd = 2 * Math.PI - gapA;
  const pOutS = { x: cx + rx * Math.cos(aStart), y: 50 + ry * Math.sin(aStart) };
  const pInS = { x: cx + rxIn * Math.cos(aStart), y: 50 + ryIn * Math.sin(aStart) };
  const pOutE = { x: cx + rx * Math.cos(aEnd), y: 50 + ry * Math.sin(aEnd) };
  const pInE = { x: cx + rxIn * Math.cos(aEnd), y: 50 + ryIn * Math.sin(aEnd) };

  const nodes: Node[] = [];
  appendChain(nodes, ellipseArcNodes(cx, 50, rx, ry, aStart, aEnd, kScale));
  appendCap(nodes, pOutE, pInE, f.cap);
  appendChain(nodes, ellipseArcNodes(cx, 50, rxIn, ryIn, aEnd, aStart, kScale));
  appendCap(nodes, pInS, pOutS, f.cap);
  return { width: w, subs: [closeChain(nodes)] };
}

function glyphD(f: FontSpec): GlyphData {
  const w = f.w + 3;
  const sw = f.sw;
  const sh = f.sh;

  if (f.chamfer > 0) {
    const c = f.chamfer * 1.15;
    const outer = poly([[0, 0], [w - c, 0], [w, c], [w, 100 - c], [w - c, 100], [0, 100]]);
    const ci = Math.max(3, c - sw * 0.45);
    const inner = poly([
      [sw, sh], [sw, 100 - sh], [w - sw - ci, 100 - sh], [w - sw, 100 - sh - ci],
      [w - sw, sh + ci], [w - sw - ci, sh],
    ]);
    return { width: w, subs: [outer, inner] };
  }

  const kScale = f.k / 0.5522847498;
  const xC = w * 0.42;
  const rx = w - xC;
  const nodes: Node[] = [{ x: 0, y: 0 }];
  appendChain(nodes, ellipseArcNodes(xC, 50, rx, 50, -Math.PI / 2, Math.PI / 2, kScale));
  nodes.push({ x: 0, y: 100 });

  const xCi = Math.max(sw + 4, xC);
  const rxI = Math.max(4, w - sw - xCi);
  const ryI = Math.max(6, 50 - sh);
  const holeNodes: Node[] = [{ x: sw, y: sh }, { x: sw, y: 100 - sh }];
  appendChain(holeNodes, ellipseArcNodes(xCi, 50, rxI, ryI, Math.PI / 2, -Math.PI / 2, kScale));
  return { width: w, subs: [closeChain(nodes), closeChain(holeNodes)] };
}

function glyphE(f: FontSpec): GlyphData {
  const w = f.w * 0.9;
  const sw = f.sw;
  const sh = f.sh;
  const yMid = 100 * f.waist;
  const midTop = yMid - sh * 0.46;
  const midBot = yMid + sh * 0.46;
  const midW = w * 0.86;
  const pts: [number, number][] = [
    [0, 0], [w, 0], [w, sh], [sw, sh], [sw, midTop], [midW, midTop],
    [midW, midBot], [sw, midBot], [sw, 100 - sh], [w, 100 - sh], [w, 100], [0, 100],
  ];
  return { width: w, subs: [maybeRound(pts, f, 3)] };
}

function glyphF(f: FontSpec): GlyphData {
  const w = f.w * 0.86;
  const sw = f.sw;
  const sh = f.sh;
  const yMid = 100 * f.waist;
  const midTop = yMid - sh * 0.46;
  const midBot = yMid + sh * 0.46;
  const midW = w * 0.84;
  const pts: [number, number][] = [
    [0, 0], [w, 0], [w, sh], [sw, sh], [sw, midTop], [midW, midTop],
    [midW, midBot], [sw, midBot], [sw, 100], [0, 100],
  ];
  return { width: w, subs: [maybeRound(pts, f, 3)] };
}

function glyphG(f: FontSpec): GlyphData {
  const w = f.w + 3;
  const cx = w / 2;
  const sw = f.sw;
  const sh = f.sh;

  if (f.chamfer > 0) {
    const c = f.chamfer;
    const yBar = 48;
    const xBar = w * 0.48;
    return {
      width: w,
      subs: [
        poly([
          [c, 0], [w - c, 0], [w, c], [w, 26], [w - sw, 26], [w - sw, sh],
          [sw, sh], [sw, 100 - sh], [w - sw, 100 - sh], [w - sw, yBar + sh],
          [xBar, yBar + sh], [xBar, yBar], [w, yBar], [w, 100 - c],
          [w - c, 100], [c, 100], [0, 100 - c], [0, c],
        ]),
      ],
    };
  }

  const rx = w / 2;
  const ry = 50;
  const rxIn = Math.max(4, rx - sw);
  const ryIn = Math.max(6, ry - sh);
  const kScale = f.k / 0.5522847498;
  const aTopEnd = 2 * Math.PI - 0.24 * Math.PI;
  const yBarTop = 48;
  const yBarBot = yBarTop + sh;
  const xBarL = cx + 2;
  const aBarOut = Math.asin(Math.max(-0.9, Math.min(0.9, (yBarTop - 50) / ry)));
  const aBarIn = Math.asin(Math.max(-0.9, Math.min(0.9, (yBarBot - 50) / ryIn)));
  const pOutE = { x: cx + rx * Math.cos(aTopEnd), y: 50 + ry * Math.sin(aTopEnd) };
  const pInE = { x: cx + rxIn * Math.cos(aTopEnd), y: 50 + ryIn * Math.sin(aTopEnd) };

  const nodes: Node[] = [];
  // Outer right bar down from yBarTop -> lower arc -> left -> top -> aTopEnd
  appendChain(nodes, ellipseArcNodes(cx, 50, rx, ry, aBarOut, aTopEnd, kScale));
  appendCap(nodes, pOutE, pInE, f.cap);
  // Inner CCW back around top, left, bottom to aBarIn
  appendChain(nodes, ellipseArcNodes(cx, 50, rxIn, ryIn, aTopEnd, aBarIn, kScale));
  // Horizontal spur inward and back out to outer ellipse at yBarTop
  nodes.push(
    { x: xBarL, y: yBarBot },
    { x: xBarL, y: yBarTop },
  );
  return { width: w, subs: [closeChain(nodes)] };
}

function glyphH(f: FontSpec): GlyphData {
  const w = f.w + 4;
  const sw = f.sw;
  const sh = f.sh;
  const yMid = 100 * f.waist;
  const midTop = yMid - sh * 0.48;
  const midBot = yMid + sh * 0.48;
  const pts: [number, number][] = [
    [0, 0], [sw, 0], [sw, midTop], [w - sw, midTop], [w - sw, 0], [w, 0],
    [w, 100], [w - sw, 100], [w - sw, midBot], [sw, midBot], [sw, 100], [0, 100],
  ];
  return { width: w, subs: [maybeRound(pts, f, 3)] };
}

function glyphI(f: FontSpec): GlyphData {
  const sw = f.sw;
  const sh = f.sh;
  if (f.serif === 'bracket') {
    const ext = 10;
    const w = sw + 2 * ext;
    const br = 5;
    const nodes: Node[] = [
      { x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: sh },
      { x: w - ext + br, y: sh, cout: { x: w - ext, y: sh } },
      { x: w - ext, y: sh + br, cin: { x: w - ext, y: sh } },
      { x: w - ext, y: 100 - sh - br, cout: { x: w - ext, y: 100 - sh } },
      { x: w - ext + br, y: 100 - sh, cin: { x: w - ext, y: 100 - sh } },
      { x: w, y: 100 - sh }, { x: w, y: 100 }, { x: 0, y: 100 }, { x: 0, y: 100 - sh },
      { x: ext - br, y: 100 - sh, cout: { x: ext, y: 100 - sh } },
      { x: ext, y: 100 - sh - br, cin: { x: ext, y: 100 - sh } },
      { x: ext, y: sh + br, cout: { x: ext, y: sh } },
      { x: ext - br, y: sh, cin: { x: ext, y: sh } },
      { x: 0, y: sh },
    ];
    return { width: w, subs: [{ closed: true, nodes }] };
  }
  if (f.serif === 'slab') {
    const ext = 9;
    const w = sw + 2 * ext;
    const bh = sh * 0.85;
    return {
      width: w,
      subs: [
        poly([
          [0, 0], [w, 0], [w, bh], [w - ext, bh], [w - ext, 100 - bh], [w, 100 - bh],
          [w, 100], [0, 100], [0, 100 - bh], [ext, 100 - bh], [ext, bh], [0, bh],
        ]),
      ],
    };
  }
  if (f.serif === 'deco') {
    const ext = 6;
    const w = sw + 2 * ext;
    return {
      width: w,
      subs: [
        poly([
          [0, 0], [w, 0], [w - ext, sh * 1.2], [w - ext, 100 - sh * 1.2],
          [w, 100], [0, 100], [ext, 100 - sh * 1.2], [ext, sh * 1.2],
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

function glyphJ(f: FontSpec): GlyphData {
  const w = f.w * 0.82;
  const sw = f.sw;
  const sh = f.sh;

  if (f.chamfer > 0) {
    const c = f.chamfer * 0.85;
    return {
      width: w,
      subs: [
        poly([
          [w - sw, 0], [w, 0], [w, 100 - c], [w - c, 100], [c, 100], [0, 100 - c],
          [0, 72], [sw, 72], [sw, 100 - sh], [w - sw, 100 - sh],
        ]),
      ],
    };
  }

  const rx = w / 2;
  const ry = 28;
  const cy = 100 - ry;
  const rxIn = Math.max(3, rx - sw);
  const ryIn = Math.max(4, ry - sh);
  const kScale = f.k / 0.5522847498;
  const nodes: Node[] = [{ x: w - sw, y: 0 }, { x: w, y: 0 }];
  appendChain(nodes, ellipseArcNodes(w / 2, cy, rx, ry, 0, Math.PI, kScale));
  appendCap(nodes, { x: 0, y: cy }, { x: sw, y: cy }, f.cap);
  appendChain(nodes, ellipseArcNodes(w / 2, cy, rxIn, ryIn, Math.PI, 0, kScale));
  return { width: w, subs: [closeChain(nodes)] };
}

function glyphK(f: FontSpec): GlyphData {
  const w = f.w + 4;
  const sw = f.sw;
  const dw = sw * 1.1;
  // Upper arm: inner edge (sw, 44) -> (w - dw, 0), outer edge (sw, 62) -> (w, 0)
  // Lower arm: meets upper outer edge cleanly
  const yJoin = 48;
  const xTopIn = w - dw;
  const [xForkOut, yForkOut] = lineIntersect(sw, yJoin + 14, w, 0, w, 100, sw + 4, yJoin - 4);
  const [xForkIn, yForkIn] = lineIntersect(sw, yJoin + 14, w, 0, w - dw, 100, sw, yJoin + 10);
  const yUpIn = Math.min(yJoin + 6, 54);
  const pts: [number, number][] = [
    [0, 0], [sw, 0], [sw, yUpIn], [xTopIn, 0], [w, 0],
    [xForkOut, yForkOut], [w, 100], [w - dw, 100],
    [Math.max(sw + 1, xForkIn), yForkIn], [sw, Math.min(82, yForkIn + 8)],
    [sw, 100], [0, 100],
  ];
  return { width: w, subs: [maybeRound(pts, f, 3)] };
}

function glyphL(f: FontSpec): GlyphData {
  const w = f.w * 0.85;
  const sw = f.sw;
  const sh = f.sh;
  const pts: [number, number][] = [[0, 0], [sw, 0], [sw, 100 - sh], [w, 100 - sh], [w, 100], [0, 100]];
  return { width: w, subs: [maybeRound(pts, f, 3)] };
}

function glyphM(f: FontSpec): GlyphData {
  const w = f.w + 18;
  const cx = w / 2;
  const sw = Math.min(f.sw, w * 0.21);
  const apexW = Math.min(sw * 0.9, 12);
  const yVTop = 64;
  const yVBot = 86;
  const pts: [number, number][] = [
    [0, 0], [sw * 1.15, 0], [cx, yVTop], [w - sw * 1.15, 0], [w, 0],
    [w, 100], [w - sw, 100], [w - sw, 28], [cx + apexW / 2, yVBot],
    [cx - apexW / 2, yVBot], [sw, 28], [sw, 100], [0, 100],
  ];
  return { width: w, subs: [maybeRound(pts, f, 3)] };
}

function glyphN(f: FontSpec): GlyphData {
  const w = f.w + 6;
  const sw = Math.min(f.sw, w * 0.26);
  const pts: [number, number][] = [
    [0, 0], [sw * 1.15, 0], [w - sw, 72], [w - sw, 0], [w, 0],
    [w, 100], [w - sw * 1.15, 100], [sw, 28], [sw, 100], [0, 100],
  ];
  return { width: w, subs: [maybeRound(pts, f, 3)] };
}

function glyphO(f: FontSpec): GlyphData {
  return glyph0({ ...f, w: f.w + 6 });
}

function glyphP(f: FontSpec): GlyphData {
  const w = f.w + 1;
  const sw = f.sw;
  const sh = f.sh;
  const bowlH = f.serif === 'deco' ? 52 : 56;

  if (f.chamfer > 0) {
    const c = f.chamfer * 0.8;
    const outer = poly([
      [0, 0], [w - c, 0], [w, c], [w, bowlH - c], [w - c, bowlH], [sw, bowlH], [sw, 100], [0, 100],
    ]);
    const inner = chamferRect(sw, sh, w - sw, bowlH - sh, 3, true);
    return { width: w, subs: [outer, inner] };
  }

  const ry = bowlH / 2;
  const xC = w * 0.52;
  const rx = w - xC;
  const kScale = f.k / 0.5522847498;
  const nodes: Node[] = [{ x: 0, y: 0 }];
  appendChain(nodes, ellipseArcNodes(xC, ry, rx, ry, -Math.PI / 2, Math.PI / 2, kScale));
  nodes.push({ x: sw, y: bowlH }, { x: sw, y: 100 }, { x: 0, y: 100 });

  const xCi = Math.max(sw + 4, xC - 2);
  const rxI = Math.max(4, w - sw - xCi);
  const ryI = Math.max(4, ry - sh);
  const holeNodes: Node[] = [{ x: sw, y: sh }, { x: sw, y: bowlH - sh }];
  appendChain(holeNodes, ellipseArcNodes(xCi, ry, rxI, ryI, Math.PI / 2, -Math.PI / 2, kScale));
  return { width: w, subs: [closeChain(nodes), closeChain(holeNodes)] };
}

function glyphQ(f: FontSpec): GlyphData {
  const w = f.w + 6;
  const cx = w / 2;
  const sw = f.sw;
  const sh = f.sh;
  const tailExt = 10;

  if (f.chamfer > 0) {
    const c = f.chamfer;
    const outer = poly([
      [c, 0], [w - c, 0], [w, c], [w, 100 - c], [w - c + 4, 100 - 4],
      [w + tailExt * 0.7, 100 + tailExt * 0.7], [w - 4, 100 + tailExt * 0.7],
      [w - c - 6, 100], [c, 100], [0, 100 - c], [0, c],
    ]);
    const inner = chamferRect(sw, sh, w - sw, 100 - sh, Math.max(3, c - sw * 0.45), true);
    return { width: w + tailExt * 0.5, subs: [outer, inner] };
  }

  const rx = w / 2;
  const ry = 50;
  const kScale = f.k / 0.5522847498;
  const a1 = 0.2 * Math.PI;
  const a2 = 0.34 * Math.PI;
  const nodes: Node[] = [];
  appendChain(nodes, ellipseArcNodes(cx, 50, rx, ry, a2, 2 * Math.PI + a1, kScale));
  // Tail jutting cleanly down-right from between a1 and a2
  nodes.push(
    { x: w + tailExt * 0.5, y: 100 + tailExt * 0.5 },
    { x: w - sw * 0.55, y: 100 + tailExt * 0.5 },
  );
  const inner = ellipse(cx, 50, Math.max(4, rx - sw), Math.max(6, ry - sh), Math.min(f.k, 0.62), true);
  return { width: w + tailExt * 0.35, subs: [closeChain(nodes), inner] };
}

function glyphR(f: FontSpec): GlyphData {
  const w = f.w + 3;
  const sw = f.sw;
  const sh = f.sh;
  const bowlH = f.serif === 'deco' ? 50 : 54;
  const legW = sw * 1.05;

  if (f.chamfer > 0) {
    const c = f.chamfer * 0.8;
    const xLegStart = Math.max(sw + 4, w - sw * 1.9);
    const outer = poly([
      [0, 0], [w - c, 0], [w, c], [w, bowlH - c], [w - c, bowlH],
      [w, 100], [w - legW, 100], [xLegStart, bowlH], [sw, bowlH], [sw, 100], [0, 100],
    ]);
    const inner = chamferRect(sw, sh, w - sw, bowlH - sh, 3, true);
    return { width: w, subs: [outer, inner] };
  }

  const ry = bowlH / 2;
  const xC = w * 0.5;
  const rx = w * 0.96 - xC;
  const kScale = f.k / 0.5522847498;
  const aLeg = 0.33 * Math.PI;
  const xLegIn = Math.max(sw + 3, xC + rx * Math.cos(aLeg) - legW * 1.05);

  const nodes: Node[] = [{ x: 0, y: 0 }];
  appendChain(nodes, ellipseArcNodes(xC, ry, rx, ry, -Math.PI / 2, aLeg, kScale));
  nodes.push(
    { x: w, y: 100 },
    { x: w - legW, y: 100 },
    { x: xLegIn, y: bowlH },
    { x: sw, y: bowlH },
    { x: sw, y: 100 },
    { x: 0, y: 100 },
  );

  const xCi = Math.max(sw + 4, xC - 2);
  const rxI = Math.max(4, w * 0.96 - sw - xCi);
  const ryI = Math.max(4, ry - sh);
  const holeNodes: Node[] = [{ x: sw, y: sh }, { x: sw, y: bowlH - sh }];
  appendChain(holeNodes, ellipseArcNodes(xCi, ry, rxI, ryI, Math.PI / 2, -Math.PI / 2, kScale));
  return { width: w, subs: [closeChain(nodes), closeChain(holeNodes)] };
}

function glyphS(f: FontSpec): GlyphData {
  const w = f.w;
  const sw = f.sw;
  const sh = f.sh;

  if (f.chamfer > 0) {
    const c = f.chamfer * 0.85;
    const yMid = 100 * f.waist;
    const mh = sh * 0.5;
    return {
      width: w,
      subs: [
        poly([
          [c, 0], [w - c, 0], [w, c], [w, 24], [w - sw, 24], [w - sw, sh],
          [sw, sh], [sw, yMid - mh], [w - c, yMid - mh], [w, yMid - mh + c * 0.7],
          [w, 100 - c], [w - c, 100], [c, 100], [0, 100 - c], [0, 74],
          [sw, 74], [sw, 100 - sh], [w - sw, 100 - sh], [w - sw, yMid + mh],
          [c, yMid + mh], [0, yMid + mh - c * 0.7], [0, c],
        ]),
      ],
    };
  }

  // Smooth S built as two joined rounded bowls with clean diagonal spine (guaranteed zero self-intersection)
  const cx = w / 2;
  const shL = Math.min(sh, 12.5);
  const swL = Math.min(sw, w * 0.3);
  const yMid = 100 * f.waist;
  const ry1 = yMid / 2 + shL * 0.28;
  const y1 = ry1;
  const ry2 = (100 - yMid) / 2 + shL * 0.28;
  const y2 = 100 - ry2;
  const rx1 = (w * 0.94) / 2;
  const rx2 = w / 2;
  const rx1I = Math.max(4, rx1 - swL);
  const ry1I = Math.max(4, ry1 - shL);
  const rx2I = Math.max(4, rx2 - swL);
  const ry2I = Math.max(4, ry2 - shL);
  const kScale = f.k / 0.5522847498;

  const aTopEnd = 2 * Math.PI - 0.16 * Math.PI;
  const aBotStart = Math.PI - 0.16 * Math.PI;
  const pTopOut = { x: cx + rx1 * Math.cos(aTopEnd), y: y1 + ry1 * Math.sin(aTopEnd) };
  const pTopIn = { x: cx + rx1I * Math.cos(aTopEnd), y: y1 + ry1I * Math.sin(aTopEnd) };
  const pBotOut = { x: cx + rx2 * Math.cos(aBotStart), y: y2 + ry2 * Math.sin(aBotStart) };
  const pBotIn = { x: cx + rx2I * Math.cos(aBotStart), y: y2 + ry2I * Math.sin(aBotStart) };

  // Walk CW around entire S:
  // 1. Top inner CCW from top-right terminal around top & left to bottom of upper bowl (a = PI/2)
  // 2. Outer bottom bowl CW from top of lower bowl (-PI/2) around right & bottom to bottom-left terminal
  // 3. Bottom-left cap
  // 4. Bottom inner CCW around bottom & right to top of inner lower bowl (-PI/2)
  // 5. Outer top bowl CW from bottom of upper outer bowl (PI/2) around left & top to top-right terminal
  // 6. Top-right cap
  const nodes: Node[] = [];
  appendChain(nodes, ellipseArcNodes(cx, y1, rx1I, ry1I, aTopEnd, 0.5 * Math.PI, kScale));
  appendChain(nodes, ellipseArcNodes(cx, y2, rx2, ry2, -0.5 * Math.PI, aBotStart, kScale));
  appendCap(nodes, pBotOut, pBotIn, f.cap);
  appendChain(nodes, ellipseArcNodes(cx, y2, rx2I, ry2I, aBotStart, -0.5 * Math.PI, kScale));
  appendChain(nodes, ellipseArcNodes(cx, y1, rx1, ry1, 0.5 * Math.PI, aTopEnd, kScale));
  appendCap(nodes, pTopOut, pTopIn, f.cap);
  return { width: w, subs: [closeChain(nodes)] };
}

function glyphT(f: FontSpec): GlyphData {
  const w = f.w + 2;
  const sw = f.sw;
  const sh = f.sh;
  const xL = (w - sw) / 2;
  const xR = (w + sw) / 2;
  const pts: [number, number][] = [
    [0, 0], [w, 0], [w, sh], [xR, sh], [xR, 100], [xL, 100], [xL, sh], [0, sh],
  ];
  return { width: w, subs: [maybeRound(pts, f, 3)] };
}

function glyphU(f: FontSpec): GlyphData {
  const w = f.w + 2;
  const sw = f.sw;
  const sh = f.sh;

  if (f.chamfer > 0) {
    const c = f.chamfer;
    return {
      width: w,
      subs: [
        poly([
          [0, 0], [sw, 0], [sw, 100 - sh], [w - sw, 100 - sh], [w - sw, 0], [w, 0],
          [w, 100 - c], [w - c, 100], [c, 100], [0, 100 - c],
        ]),
      ],
    };
  }

  const rx = w / 2;
  const ry = 34;
  const cy = 100 - ry;
  const rxIn = Math.max(4, rx - sw);
  const ryIn = Math.max(4, ry - sh);
  const kScale = f.k / 0.5522847498;
  const nodes: Node[] = [{ x: w - sw, y: 0 }, { x: w, y: 0 }];
  appendChain(nodes, ellipseArcNodes(w / 2, cy, rx, ry, 0, Math.PI, kScale));
  nodes.push({ x: 0, y: 0 }, { x: sw, y: 0 });
  appendChain(nodes, ellipseArcNodes(w / 2, cy, rxIn, ryIn, Math.PI, 0, kScale));
  return { width: w, subs: [closeChain(nodes)] };
}

function glyphV(f: FontSpec): GlyphData {
  const w = f.w + 6;
  const swL = f.sw;
  const swR = f.serif === 'bracket' ? Math.max(9, f.sh * 1.2) : f.sw;
  const apexW = f.serif === 'deco' ? 4 : Math.min(swL, swR) * 0.72;
  const cx = w / 2;
  const lDx = cx - apexW / 2;
  const rDx = w - (cx + apexW / 2);
  const yIn = (100 * (w - swR - swL)) / (lDx + rDx);
  const xIn = swL + (yIn / 100) * lDx;
  const pts: [number, number][] = [
    [0, 0], [swL, 0], [xIn, Math.min(92, yIn)], [w - swR, 0], [w, 0],
    [cx + apexW / 2, 100], [cx - apexW / 2, 100],
  ];
  return { width: w, subs: [maybeRound(pts, f, 3.5)] };
}

function glyphW(f: FontSpec): GlyphData {
  const w = f.w + 26;
  const sw = Math.min(f.sw, w * 0.17);
  const cx = w / 2;
  const xB1 = w * 0.25;
  const xB2 = w * 0.75;
  const bw = sw * 0.85;
  const pts: [number, number][] = [
    [0, 0], [sw, 0], [xB1, 74], [cx - bw * 0.55, 16], [cx + bw * 0.55, 16],
    [xB2, 74], [w - sw, 0], [w, 0], [xB2 + bw * 0.5, 100], [xB2 - bw * 0.5, 100],
    [cx, 40], [xB1 + bw * 0.5, 100], [xB1 - bw * 0.5, 100],
  ];
  return { width: w, subs: [maybeRound(pts, f, 3)] };
}

function glyphX(f: FontSpec): GlyphData {
  const w = f.w + 6;
  const t1 = Math.min(w * 0.34, f.sw * 1.05);
  const t2 = Math.min(w * 0.34, f.serif === 'bracket' ? Math.max(9, f.sh * 1.3) : f.sw * 1.05);
  const m1 = (w - t1) / 100;
  const m2 = (w - t2) / 100;
  const ix = (c1: number, s1: number, c2: number, s2: number): [number, number] => {
    const y = (c2 - c1) / (s1 - s2);
    return [c1 + s1 * y, y];
  };
  const topN = ix(t1, m1, w - t2, -m2);
  const rightN = ix(t1, m1, w, -m2);
  const botN = ix(0, m1, w, -m2);
  const leftN = ix(0, m1, w - t2, -m2);
  const pts: [number, number][] = [
    [0, 0], [t1, 0], topN, [w - t2, 0], [w, 0], rightN,
    [w, 100], [w - t1, 100], botN, [t2, 100], [0, 100], leftN,
  ];
  return { width: w, subs: [maybeRound(pts, f, 3)] };
}

function glyphY(f: FontSpec): GlyphData {
  const w = f.w + 6;
  const cx = w / 2;
  const sw = f.sw;
  const yFork = 54;
  const xSL = cx - sw / 2;
  const xSR = cx + sw / 2;
  const pts: [number, number][] = [
    [0, 0], [sw * 1.1, 0], [cx, yFork - 12], [w - sw * 1.1, 0], [w, 0],
    [xSR, yFork], [xSR, 100], [xSL, 100], [xSL, yFork],
  ];
  return { width: w, subs: [maybeRound(pts, f, 3)] };
}

function glyphZ(f: FontSpec): GlyphData {
  const w = f.w;
  const sw = f.sw;
  const sh = f.sh;
  const pts: [number, number][] = [
    [0, 0], [w, 0], [w, sh * 1.1], [sw * 1.25, 100 - sh], [w, 100 - sh],
    [w, 100], [0, 100], [0, 100 - sh * 1.1], [w - sw * 1.25, sh], [0, sh],
  ];
  return { width: w, subs: [maybeRound(pts, f, 3)] };
}

function glyphSS(f: FontSpec): GlyphData {
  // German ß: vertical stem + top arch + two right-hand bowls
  const w = f.w + 2;
  const sw = Math.min(f.sw, w * 0.28);
  const sh = Math.min(f.sh, 12);
  const yMid = 44;
  const topW = w * 0.88;
  const pts: [number, number][] = [
    [0, 18], [14, 0], [topW - 14, 0], [topW, 14], [topW, yMid - 8],
    [topW - 11, yMid], [w, yMid + 10], [w, 86], [w - 14, 100],
    [sw + 10, 100], [sw + 10, 100 - sh], [w - sw, 100 - sh],
    [w - sw, yMid + sh * 0.65], [sw + 12, yMid + sh * 0.65],
    [sw + 12, yMid - sh * 0.65], [topW - sw, yMid - sh * 0.65],
    [topW - sw, sh], [sw, sh], [sw, 100], [0, 100],
  ];
  return { width: w, subs: [roundedPoly(pts, f.chamfer > 0 ? 1.5 : 5)] };
}

// ================================================================== DIACRITICS & PUNCTUATION

function addDots(base: GlyphData, f: FontSpec): GlyphData {
  const r = Math.max(5.2, Math.min(7.5, f.sh * 0.52));
  const y = -r - 5;
  const cx = base.width / 2;
  const sep = Math.max(r * 1.6, base.width * 0.22);
  const mk = (x: number): SubPath =>
    f.chamfer > 0
      ? chamferRect(x - r, y - r, x + r, y + r, 2, false)
      : f.cap === 'flat' && f.serif === 'none'
        ? poly([[x - r, y - r], [x + r, y - r], [x + r, y + r], [x - r, y + r]])
        : ellipse(x, y, r, r, f.k, false);
  return { width: base.width, subs: [...base.subs, mk(cx - sep), mk(cx + sep)] };
}

function addAccent(base: GlyphData, f: FontSpec, kind: 'acute' | 'grave' | 'circ' | 'tilde' | 'ring'): GlyphData {
  const cx = base.width / 2;
  const sh = Math.max(6, Math.min(9, f.sh * 0.6));
  if (kind === 'ring') {
    const r = 8;
    const cy = -r - 4;
    return { width: base.width, subs: [...base.subs, ellipse(cx, cy, r, r, f.k, false), ellipse(cx, cy, r * 0.48, r * 0.48, f.k, true)] };
  }
  if (kind === 'acute') {
    return { width: base.width, subs: [...base.subs, poly([[cx + 2, -19], [cx + 12, -19], [cx - 1, -5], [cx - 8, -5]])] };
  }
  if (kind === 'grave') {
    return { width: base.width, subs: [...base.subs, poly([[cx - 12, -19], [cx - 2, -19], [cx + 8, -5], [cx + 1, -5]])] };
  }
  if (kind === 'circ') {
    return { width: base.width, subs: [...base.subs, poly([[cx, -20], [cx + 14, -5], [cx + 7, -5], [cx, -12.5], [cx - 7, -5], [cx - 14, -5]])] };
  }
  // tilde
  return {
    width: base.width,
    subs: [
      ...base.subs,
      poly([
        [cx - 14, -8], [cx - 6, -17], [cx + 6, -12], [cx + 14, -17],
        [cx + 14, -10], [cx + 6, -5], [cx - 6, -10], [cx - 14, -5 + sh * 0.1],
      ]),
    ],
  };
}

function glyphHyphen(f: FontSpec): GlyphData {
  const w = f.w * 0.56;
  const h = f.sh * 0.95;
  const y0 = 50 - h / 2;
  const y1 = 50 + h / 2;
  const pts: [number, number][] = [[0, y0], [w, y0], [w, y1], [0, y1]];
  return { width: w, subs: [maybeRound(pts, f, h * 0.45)] };
}

function glyphSlash(f: FontSpec): GlyphData {
  const w = f.w * 0.68;
  const sw = f.sw * 0.85;
  const pts: [number, number][] = [[w - sw, 0], [w, 0], [sw, 100], [0, 100]];
  return { width: w, subs: [maybeRound(pts, f, 2.5)] };
}

function glyphDot(f: FontSpec): GlyphData {
  const d = Math.max(12, f.sw * 1.05);
  const r = d / 2;
  const sub =
    f.cap === 'round' || f.serif === 'bracket'
      ? ellipse(r, 100 - r, r, r, f.k, false)
      : poly([[0, 100 - d], [d, 100 - d], [d, 100], [0, 100]]);
  return { width: d, subs: [sub] };
}

function glyphComma(f: FontSpec): GlyphData {
  const d = Math.max(12, f.sw);
  return {
    width: d,
    subs: [poly([[0, 100 - d], [d, 100 - d], [d, 100], [d * 0.35, 114], [0, 110], [d * 0.25, 100], [0, 100]])],
  };
}

function glyphColon(f: FontSpec): GlyphData {
  const d = Math.max(12, f.sw * 0.95);
  const r = d / 2;
  const mk = (cy: number): SubPath =>
    f.cap === 'round' || f.serif === 'bracket'
      ? ellipse(r, cy, r, r, f.k, false)
      : poly([[0, cy - r], [d, cy - r], [d, cy + r], [0, cy + r]]);
  return { width: d, subs: [mk(30), mk(100 - r)] };
}

function glyphApostrophe(f: FontSpec): GlyphData {
  const w = Math.max(10, f.sw * 0.72);
  return { width: w, subs: [poly([[0, 0], [w, 0], [w * 0.7, 26], [w * 0.15, 26]])] };
}

function glyphPlus(f: FontSpec): GlyphData {
  const w = f.w * 0.85;
  const cx = w / 2;
  const t = Math.min(f.sw, f.sh);
  const ht = t / 2;
  const y0 = 50 - w / 2;
  const y1 = 50 + w / 2;
  const pts: [number, number][] = [
    [cx - ht, y0], [cx + ht, y0], [cx + ht, 50 - ht], [w, 50 - ht],
    [w, 50 + ht], [cx + ht, 50 + ht], [cx + ht, y1], [cx - ht, y1],
    [cx - ht, 50 + ht], [0, 50 + ht], [0, 50 - ht], [cx - ht, 50 - ht],
  ];
  return { width: w, subs: [maybeRound(pts, f, 2.5)] };
}

function glyphAmp(f: FontSpec): GlyphData {
  // Clean geometric ampersand (outer loop + 2 crisp inner counters, zero self-intersections)
  const w = f.w + 8;
  const sw = Math.min(f.sw, w * 0.22);
  const sh = Math.min(f.sh, 12);
  const cx = w * 0.44;
  const topW = w * 0.64;
  const tx0 = cx - topW / 2;
  const tx1 = cx + topW / 2;
  const yMid = 44;
  const outer = roundedPoly(
    [
      [tx0, 0], [tx1, 0], [tx1, yMid - 4], [cx + sw * 0.55, yMid + 2],
      [w - sw * 0.9, yMid + 2], [w, yMid + 2], [w, yMid + 14], [w - sw * 0.6, yMid + 14],
      [w - sw * 0.35, 76], [w, 92], [w, 100], [w - sw * 1.15, 100],
      [w - sw * 1.65, 92], [w * 0.56, 100], [0, 100], [0, yMid + 8], [tx0 + 6, yMid - 2], [tx0, yMid - 10],
    ],
    f.chamfer > 0 ? 2 : 6,
  );
  const topHole = chamferRect(tx0 + sw * 0.85, sh, tx1 - sw * 0.85, yMid - sh * 0.6, 3, true);
  const botHole = chamferRect(sw * 0.9, yMid + sh * 0.8, w * 0.68 - sw * 0.5, 100 - sh, 4, true);
  return { width: w, subs: [outer, topHole, botHole] };
}

// ================================================================== DISPATCH

function buildRawGlyph(ch: string, f: FontSpec): GlyphData | null {
  switch (ch) {
    case '0': return glyph0(f);
    case '1': return glyph1(f);
    case '2': return glyph2(f);
    case '3': return glyph3(f);
    case '4': return glyph4(f);
    case '5': return glyph5(f);
    case '6': return glyph6(f);
    case '7': return glyph7(f);
    case '8': return glyph8(f);
    case '9': return glyph9(f);
    case 'A': return glyphA(f);
    case 'B': return glyphB(f);
    case 'C': return glyphC(f);
    case 'D': return glyphD(f);
    case 'E': return glyphE(f);
    case 'F': return glyphF(f);
    case 'G': return glyphG(f);
    case 'H': return glyphH(f);
    case 'I': return glyphI(f);
    case 'J': return glyphJ(f);
    case 'K': return glyphK(f);
    case 'L': return glyphL(f);
    case 'M': return glyphM(f);
    case 'N': return glyphN(f);
    case 'O': return glyphO(f);
    case 'P': return glyphP(f);
    case 'Q': return glyphQ(f);
    case 'R': return glyphR(f);
    case 'S': return glyphS(f);
    case 'T': return glyphT(f);
    case 'U': return glyphU(f);
    case 'V': return glyphV(f);
    case 'W': return glyphW(f);
    case 'X': return glyphX(f);
    case 'Y': return glyphY(f);
    case 'Z': return glyphZ(f);
    case 'Ä': return addDots(glyphA(f), f);
    case 'Ö': return addDots(glyphO(f), f);
    case 'Ü': return addDots(glyphU(f), f);
    case 'ß': return glyphSS(f);
    case 'Á': return addAccent(glyphA(f), f, 'acute');
    case 'À': return addAccent(glyphA(f), f, 'grave');
    case 'Â': return addAccent(glyphA(f), f, 'circ');
    case 'Å': return addAccent(glyphA(f), f, 'ring');
    case 'É': return addAccent(glyphE(f), f, 'acute');
    case 'È': return addAccent(glyphE(f), f, 'grave');
    case 'Ê': return addAccent(glyphE(f), f, 'circ');
    case 'Í': return addAccent(glyphI(f), f, 'acute');
    case 'Ñ': return addAccent(glyphN(f), f, 'tilde');
    case 'Ó': return addAccent(glyphO(f), f, 'acute');
    case 'Ò': return addAccent(glyphO(f), f, 'grave');
    case 'Ô': return addAccent(glyphO(f), f, 'circ');
    case 'Ú': return addAccent(glyphU(f), f, 'acute');
    case 'Ù': return addAccent(glyphU(f), f, 'grave');
    case 'Û': return addAccent(glyphU(f), f, 'circ');
    case 'Ç': return glyphC(f);
    case 'Ø': return glyphO(f);
    case '-':
    case '–': return glyphHyphen(f);
    case '/': return glyphSlash(f);
    case '.': return glyphDot(f);
    case ',': return glyphComma(f);
    case ':': return glyphColon(f);
    case "'": return glyphApostrophe(f);
    case '+': return glyphPlus(f);
    case '&': return glyphAmp(f);
    default: return null;
  }
}

export function isSupportedOutlineChar(ch: string): boolean {
  if (ch === ' ') return true;
  if (ch === 'ß') return true;
  const up = ch.toUpperCase();
  return buildRawGlyph(up, BASE_FONTS.sans) !== null;
}

export interface CharGlyph {
  char: string;
  /** Width in mm */
  width: number;
  /** Visual height in mm (smaller for small-cap lowercase when preserveCase is true) */
  height: number;
  /** Offset from full cap-height top (0 for full cap, >0 for baseline-aligned small-cap) */
  yOffset: number;
  /** Outlines centered at (0, 0) where x in [-width/2..width/2], y in [-height/2..height/2] */
  subs: SubPath[];
}

/**
 * Build a single character glyph centered at local (0, 0).
 * When `preserveCase` is true (e.g. house number "12a"), lowercase letters are rendered as
 * baseline-aligned architectural small-caps (74% height, slightly adjusted stroke weight).
 */
export function buildCharGlyph(
  ch: string,
  font: FontFamily,
  boldnessPct: number,
  capHeight: number,
  preserveCase = true,
): CharGlyph | null {
  if (ch === ' ') return null;
  const isLower = preserveCase && ch !== 'ß' && ch === ch.toLowerCase() && ch !== ch.toUpperCase();
  const key = ch === 'ß' ? 'ß' : ch.toUpperCase();
  const effBold = isLower ? Math.min(140, boldnessPct * 1.12) : boldnessPct;
  const spec = getSpec(font, effBold);
  const raw = buildRawGlyph(key, spec);
  if (!raw) return null;

  const h = isLower ? capHeight * 0.74 : capHeight;
  const scale = h / 100;
  const w = raw.width * scale;
  const yOffset = capHeight - h; // aligns baseline of small-cap to full cap baseline

  const subs = raw.subs.map((s) =>
    scaleSub(s, scale, scale, -w / 2, -h / 2),
  );
  return { char: ch, width: w, height: h, yOffset, subs };
}

/** Measure total width in mm of an outline string */
export function measureOutlineString(
  text: string,
  font: FontFamily,
  boldnessPct: number,
  height: number,
  spacingPct: number,
  preserveCase = false,
): number {
  const gap = (spacingPct / 100) * height;
  const spaceW = height * 0.36;
  let total = 0;
  let count = 0;
  for (const ch of text) {
    if (ch === ' ') {
      if (count > 0) total += spaceW;
      continue;
    }
    const g = buildCharGlyph(ch, font, boldnessPct, height, preserveCase);
    if (!g) continue;
    if (count > 0) total += gap;
    total += g.width;
    count++;
  }
  return total;
}

export interface PlacedGlyph {
  char: string;
  /** Center X in target coordinate system */
  cx: number;
  /** Center Y in target coordinate system */
  cy: number;
  width: number;
  height: number;
  /** SubPaths in local coordinates (centered at 0, 0) */
  localSubs: SubPath[];
  /** SubPaths placed at (cx, cy) */
  placedSubs: SubPath[];
}

/** Layout an outline string horizontally, returning both placed SubPaths and per-character glyphs */
export function layoutOutlineString(
  text: string,
  font: FontFamily,
  boldnessPct: number,
  height: number,
  spacingPct: number,
  cx: number,
  cy: number,
  align: 'left' | 'center' | 'right' = 'center',
  preserveCase = false,
): { width: number; glyphs: PlacedGlyph[]; subs: SubPath[] } {
  const gap = (spacingPct / 100) * height;
  const spaceW = height * 0.36;
  const items: Array<{ space: true; w: number } | { space: false; g: CharGlyph }> = [];

  for (const ch of text) {
    if (ch === ' ') {
      items.push({ space: true, w: spaceW });
    } else {
      const g = buildCharGlyph(ch, font, boldnessPct, height, preserveCase);
      if (g) items.push({ space: false, g });
    }
  }
  // Trim leading/trailing spaces
  while (items.length && items[0].space) items.shift();
  while (items.length && items[items.length - 1].space) items.pop();

  let totalW = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.space) {
      totalW += it.w;
    } else {
      if (i > 0 && !items[i - 1].space) totalW += gap;
      totalW += it.g.width;
    }
  }

  const startX = align === 'center' ? cx - totalW / 2 : align === 'right' ? cx - totalW : cx;
  const topY = cy - height / 2;
  let pen = startX;
  const glyphs: PlacedGlyph[] = [];
  const subs: SubPath[] = [];

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.space) {
      pen += it.w;
      continue;
    }
    if (i > 0 && !items[i - 1].space) pen += gap;
    const gx = pen + it.g.width / 2;
    const gy = topY + it.g.yOffset + it.g.height / 2;
    const placedSubs = it.g.subs.map((s) => translateSub(s, gx, gy));
    glyphs.push({
      char: it.g.char,
      cx: gx,
      cy: gy,
      width: it.g.width,
      height: it.g.height,
      localSubs: it.g.subs,
      placedSubs,
    });
    subs.push(...placedSubs);
    pen += it.g.width;
  }

  return { width: totalW, glyphs, subs };
}

/** Export list of all outline characters supported (useful for exhaustive tests) */
export const ALL_OUTLINE_CHARS =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÜßÁÀÂÅÉÈÊÍÑÓÒÔÚÙÛ-/.,:\'+&';
