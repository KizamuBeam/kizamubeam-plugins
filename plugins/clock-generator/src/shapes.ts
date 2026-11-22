import { circle, K, regular, roundedRect, type Node, type SubPath } from '../../../sdk/ts';
import { ellipse, reverseSub, SYMMETRIC_SHAPES, type ClockParams } from './types';

export interface ClockGeometry {
  /** Outer width and height bounding box of the clock (mm) */
  outerWidth: number;
  outerHeight: number;
  /** Center of the clock dial & movement shaft (x is always 0) */
  dialCx: number;
  dialCy: number;
  /** Maximum inscribed radius available around (dialCx, dialCy) inside the outer outline */
  dialMaxRadius: number;
  /** Outer cut contour */
  outer: SubPath;
  /** Exact inner cut contour for a spacer ring of width `ringWidth` (or null if too wide) */
  innerForRing(ringWidth: number): SubPath | null;
  /** Minimum half-dimension that limits spacer ring width */
  minHalfDim: number;
  /** Top-most Y coordinate of the outer shape (negative) */
  topY: number;
}

/** Exact circular arc as Bézier nodes, from angle a0 to a1 (radians, 0 = +x, CCW in math = CW in y-down) */
export function circleArcNodes(cx: number, cy: number, r: number, a0: number, a1: number): Node[] {
  const span = a1 - a0;
  const n = Math.max(1, Math.ceil(Math.abs(span) / (Math.PI / 2)));
  const d = span / n;
  const k = (4 / 3) * Math.tan(d / 4) * r;
  const nodes: Node[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + i * d;
    const x = cx + r * Math.cos(a);
    const y = cy + r * Math.sin(a);
    const tx = -Math.sin(a);
    const ty = Math.cos(a);
    const nd: Node = { x, y };
    if (i > 0) nd.cin = { x: x - tx * k, y: y - ty * k };
    if (i < n) nd.cout = { x: x + tx * k, y: y + ty * k };
    if (i > 0 && i < n) nd.smooth = true;
    nodes.push(nd);
  }
  return nodes;
}

/** Arch outline (flat bottom, vertical sides, semicircular/elliptical top), centered at (0, 0) */
function archPath(w: number, h: number): SubPath {
  const rx = w / 2;
  const ry = Math.min(rx, h * 0.85);
  const yBot = h / 2;
  const yTop = -h / 2;
  const ySpring = yTop + ry;
  const kx = rx * K;
  const ky = ry * K;
  const nodes: Node[] = [
    { x: -rx, y: yBot },
    { x: -rx, y: ySpring, cout: { x: -rx, y: ySpring - ky } },
    { x: 0, y: yTop, cin: { x: -kx, y: yTop }, cout: { x: kx, y: yTop }, smooth: true },
    { x: rx, y: ySpring, cin: { x: rx, y: ySpring - ky } },
    { x: rx, y: yBot },
  ];
  return { closed: true, nodes };
}

/** Scalloped 12-lobed clock outline with peaks aligned to the 12 hours */
function scallopedPath(rOuter: number, rValley: number): SubPath {
  const lobes = 12;
  const step = (2 * Math.PI) / lobes;
  const halfStep = step / 2;
  const ctrlAngle = step * 0.3;
  const rCtrl = (rOuter - 0.25 * rValley * Math.cos(halfStep)) / (0.75 * Math.cos(ctrlAngle));
  const nodes: Node[] = [];
  for (let i = 0; i < lobes; i++) {
    const aPrev = (i - 0.5) * step - Math.PI / 2;
    const aPeak = i * step - Math.PI / 2;
    const aNext = (i + 0.5) * step - Math.PI / 2;
    const vx = rValley * Math.cos(aPrev);
    const vy = rValley * Math.sin(aPrev);
    const cOutA = aPeak - ctrlAngle;
    const prevPeak = (i - 1) * step - Math.PI / 2;
    const cInA = prevPeak + ctrlAngle;
    nodes.push({
      x: vx,
      y: vy,
      cin: { x: rCtrl * Math.cos(cInA), y: rCtrl * Math.sin(cInA) },
      cout: { x: rCtrl * Math.cos(cOutA), y: rCtrl * Math.sin(cOutA) },
    });
    void aNext;
  }
  return { closed: true, nodes };
}

/** Regular polygon given flat-to-flat diameter (apothem = flatDia / 2) */
function flatPolygon(flatDia: number, sides: number, startAngle: number): SubPath {
  const apothem = flatDia / 2;
  const rCircum = apothem / Math.cos(Math.PI / sides);
  return regular(0, 0, rCircum, sides, startAngle);
}

/** Wall-mount keyhole slot centered around (cx, cy); ~9 mm wide × 16.75 mm tall */
export function keyholePath(cx: number, cy: number): SubPath {
  const rBig = 4.5;
  const rSmall = 2.25;
  const yBig = cy + 4.5;
  const yTop = cy - 5.5;
  const dy = Math.sqrt(rBig * rBig - rSmall * rSmall);
  const yJoin = yBig - dy;
  // Angle on big circle from +x axis (y-down): right join is in upper-right (-alpha), left join is -(PI - alpha)
  const alpha = Math.atan2(-dy, rSmall); // negative angle in (-PI/2, 0)
  const aStart = alpha; // right join
  const aEnd = Math.PI - alpha; // goes clockwise through +PI/2 (bottom) to left join (PI + |alpha|)
  const bigArc = circleArcNodes(cx, yBig, rBig, aStart, aEnd);
  const topArc = circleArcNodes(cx, yTop, rSmall, Math.PI, 2 * Math.PI);

  // Merge seamlessly: topArc (left -> top -> right) -> right vertical -> bigArc (right -> bottom -> left) -> left vertical
  const nodes: Node[] = [];
  for (let i = 0; i < topArc.length; i++) {
    nodes.push({ ...topArc[i] });
  }
  // Ensure last node of topArc connects straight down to bigArc[0]
  nodes[nodes.length - 1].cout = undefined;
  for (let i = 0; i < bigArc.length; i++) {
    const nd = { ...bigArc[i] };
    if (i === 0) nd.cin = undefined;
    if (i === bigArc.length - 1) nd.cout = undefined;
    nodes.push(nd);
  }
  nodes[0].cin = undefined;
  return { closed: true, nodes };
}

/** Build outer geometry, dial bounds, and spacer-ring inner path for the chosen clock shape */
export function buildClockGeometry(p: ClockParams): ClockGeometry {
  const isSym = SYMMETRIC_SHAPES.has(p.shape);
  const W = isSym ? p.diameter : p.width;
  const H = isSym ? p.diameter : p.height;

  switch (p.shape) {
    case 'circle': {
      const r = W / 2;
      return {
        outerWidth: W,
        outerHeight: W,
        dialCx: 0,
        dialCy: 0,
        dialMaxRadius: r,
        outer: circle(0, 0, r),
        innerForRing: (rw) => (r - rw >= 4 ? reverseSub(circle(0, 0, r - rw)) : null),
        minHalfDim: r,
        topY: -r,
      };
    }

    case 'square':
    case 'rectangle': {
      const cr = Math.min(p.cornerRadius, W / 2, H / 2);
      const minHalf = Math.min(W, H) / 2;
      return {
        outerWidth: W,
        outerHeight: H,
        dialCx: 0,
        dialCy: 0,
        dialMaxRadius: minHalf,
        outer: roundedRect(W, H, cr),
        innerForRing: (rw) => {
          const iw = W - 2 * rw;
          const ih = H - 2 * rw;
          if (iw < 8 || ih < 8) return null;
          return reverseSub(roundedRect(iw, ih, Math.max(0, cr - rw)));
        },
        minHalfDim: minHalf,
        topY: -H / 2,
      };
    }

    case 'oval': {
      const rx = W / 2;
      const ry = H / 2;
      const minHalf = Math.min(rx, ry);
      return {
        outerWidth: W,
        outerHeight: H,
        dialCx: 0,
        dialCy: 0,
        dialMaxRadius: minHalf,
        outer: ellipse(0, 0, rx, ry, K, false),
        innerForRing: (rw) => (rx - rw >= 4 && ry - rw >= 4 ? ellipse(0, 0, rx - rw, ry - rw, K, true) : null),
        minHalfDim: minHalf,
        topY: -ry,
      };
    }

    case 'octagon': {
      const r = W / 2;
      const start = Math.PI / 8;
      return {
        outerWidth: W,
        outerHeight: W,
        dialCx: 0,
        dialCy: 0,
        dialMaxRadius: r,
        outer: flatPolygon(W, 8, start),
        innerForRing: (rw) => (W - 2 * rw >= 8 ? reverseSub(flatPolygon(W - 2 * rw, 8, start)) : null),
        minHalfDim: r,
        topY: -r,
      };
    }

    case 'hexagon': {
      const r = W / 2;
      // Flat top and bottom: vertices at 0, 60°, 120°, ...
      const rCircum = r / Math.cos(Math.PI / 6);
      return {
        outerWidth: 2 * rCircum,
        outerHeight: W,
        dialCx: 0,
        dialCy: 0,
        dialMaxRadius: r,
        outer: flatPolygon(W, 6, 0),
        innerForRing: (rw) => (W - 2 * rw >= 8 ? reverseSub(flatPolygon(W - 2 * rw, 6, 0)) : null),
        minHalfDim: r,
        topY: -r,
      };
    }

    case 'dodecagon': {
      const r = W / 2;
      const start = Math.PI / 12;
      return {
        outerWidth: W,
        outerHeight: W,
        dialCx: 0,
        dialCy: 0,
        dialMaxRadius: r,
        outer: flatPolygon(W, 12, start),
        innerForRing: (rw) => (W - 2 * rw >= 8 ? reverseSub(flatPolygon(W - 2 * rw, 12, start)) : null),
        minHalfDim: r,
        topY: -r,
      };
    }

    case 'arch': {
      const rx = W / 2;
      const ry = Math.min(rx, H * 0.85);
      // Place dial concentrically inside the top semicircle when H >= W
      const dialCy = H >= W ? -H / 2 + rx : 0;
      const dialMaxRadius = Math.min(rx, H / 2);
      return {
        outerWidth: W,
        outerHeight: H,
        dialCx: 0,
        dialCy,
        dialMaxRadius,
        outer: archPath(W, H),
        innerForRing: (rw) => {
          const iw = W - 2 * rw;
          const ih = H - 2 * rw;
          if (iw < 8 || ih < 8 || ry - rw < 4) return null;
          return reverseSub(archPath(iw, ih));
        },
        minHalfDim: Math.min(rx, H / 2),
        topY: -H / 2,
      };
    }

    case 'squircle': {
      const r = W / 2;
      const SQUIRCLE_K = 0.76;
      return {
        outerWidth: W,
        outerHeight: W,
        dialCx: 0,
        dialCy: 0,
        dialMaxRadius: r,
        outer: ellipse(0, 0, r, r, SQUIRCLE_K, false),
        innerForRing: (rw) => (r - rw >= 4 ? ellipse(0, 0, r - rw, r - rw, SQUIRCLE_K, true) : null),
        minHalfDim: r,
        topY: -r,
      };
    }

    case 'scalloped': {
      const rOuter = W / 2;
      const rValley = rOuter * 0.935;
      return {
        outerWidth: W,
        outerHeight: W,
        dialCx: 0,
        dialCy: 0,
        dialMaxRadius: rValley,
        outer: scallopedPath(rOuter, rValley),
        innerForRing: (rw) => (rValley - rw >= 4 ? reverseSub(circle(0, 0, rValley - rw)) : null),
        minHalfDim: rValley,
        topY: -rOuter,
      };
    }
  }
}
