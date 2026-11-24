// 10 architectural board shapes, analytical inset contours (for engraved borders & raised frames),
// and shape-aware mounting hole & keyhole placement for House Number Sign.
import { circle, rect, roundedRect, type Node, type Pt, type SubPath } from '../../../sdk/ts';
import {
  appendChain,
  circleArcNodes,
  closeChain,
  distToPoly,
  ellipse,
  flattenSub,
  pointInPoly,
  poly,
  reverseSub,
  type BoardShape,
  type MountType,
  type SignParams,
} from './types';

export interface BoardSpec {
  shape: BoardShape;
  W: number;
  H: number;
  cornerRadius: number;
  roofPitch: number;
}

/**
 * Build a board outline (CW in y-down coords, centered at (0, 0)) optionally inset inward by `inset` mm.
 * Returns null if `inset` is too large for the board dimensions.
 */
export function buildBoardContour(spec: BoardSpec, inset = 0): SubPath | null {
  const W = spec.W - 2 * inset;
  const H = spec.H - 2 * inset;
  if (W < 8 || H < 8) return null;
  const hw = W / 2;
  const hh = H / 2;

  switch (spec.shape) {
    case 'rect':
      return rect(W, H);

    case 'rounded': {
      const r = Math.max(0, Math.min(spec.cornerRadius - inset, hw - 0.5, hh - 0.5));
      return r <= 0.1 ? rect(W, H) : roundedRect(W, H, r);
    }

    case 'pill': {
      const r = Math.min(hw, hh);
      return roundedRect(W, H, r);
    }

    case 'arch': {
      // Round arch top, flat bottom
      const rBase = Math.min(spec.W / 2, spec.H * 0.45);
      const r = Math.max(2, Math.min(rBase - inset, hw, H * 0.6));
      const yArc = -hh + r;
      const nodes: Node[] = [];
      // Top-left arc CW: PI -> 1.5PI around (-hw + r, yArc)
      appendChain(nodes, circleArcNodes(-hw + r, yArc, r, Math.PI, 1.5 * Math.PI));
      // Top-right arc CW: 1.5PI -> 2PI around (hw - r, yArc)
      appendChain(nodes, circleArcNodes(hw - r, yArc, r, 1.5 * Math.PI, 2 * Math.PI));
      nodes.push({ x: hw, y: hh }, { x: -hw, y: hh });
      return closeChain(nodes);
    }

    case 'oval':
      return ellipse(0, 0, hw, hh);

    case 'chamfer': {
      const baseC = Math.min(spec.cornerRadius, spec.W * 0.3, spec.H * 0.3);
      // Parallel inward offset of a 45° chamfer reduces chamfer leg by inset * (sqrt(2) - 1)
      const c = Math.max(0, Math.min(baseC - inset * (Math.SQRT2 - 1), hw - 1, hh - 1));
      if (c <= 0.2) return rect(W, H);
      return poly([
        [-hw + c, -hh],
        [hw - c, -hh],
        [hw, -hh + c],
        [hw, hh - c],
        [hw - c, hh],
        [-hw + c, hh],
        [-hw, hh - c],
        [-hw, -hh + c],
      ]);
    }

    case 'house': {
      // Pitched gable roof on top, vertical walls, flat bottom
      const origW = spec.W;
      const origH = spec.H;
      const roofH0 = origH * (Math.max(15, Math.min(55, spec.roofPitch)) / 100);
      const halfW0 = origW / 2;
      const slopeLen = Math.hypot(halfW0, roofH0);
      // Exact parallel offset of roof slope lines
      const dyApex = inset * (slopeLen / halfW0);
      const yApex = -origH / 2 + dyApex;
      const yBot = origH / 2 - inset;
      const xWall = halfW0 - inset;
      // Roof line at xWall: y = yApex + (roofH0 / halfW0) * xWall
      const yEave = yApex + (roofH0 / halfW0) * xWall;
      if (yEave >= yBot - 4 || xWall < 4) return null;
      return poly([
        [0, yApex],
        [xWall, yEave],
        [xWall, yBot],
        [-xWall, yBot],
        [-xWall, yEave],
      ]);
    }

    case 'hexagon': {
      // Elongated architectural plaque hexagon: flat top & bottom, pointed left & right
      const origW = spec.W;
      const origH = spec.H;
      const tip0 = Math.min(origW * 0.2, origH * 0.42);
      const halfH0 = origH / 2;
      const edgeLen = Math.hypot(tip0, halfH0);
      const dxTip = inset * (edgeLen / halfH0);
      const yTop = -halfH0 + inset;
      const yBot = halfH0 - inset;
      const xTip = origW / 2 - dxTip;
      const xFlat = xTip - (tip0 / halfH0) * (halfH0 - inset);
      if (xFlat <= 2 || yBot - yTop < 6) return null;
      return poly([
        [-xFlat, yTop],
        [xFlat, yTop],
        [xTip, 0],
        [xFlat, yBot],
        [-xFlat, yBot],
        [-xTip, 0],
      ]);
    }

    case 'shield': {
      // Classic architectural shield: gently arched top, vertical upper sides, tapered curved bottom point
      const sx = W / spec.W;
      const sy = H / spec.H;
      const origHw = spec.W / 2;
      const origHh = spec.H / 2;
      const yShoulder = -origHh + spec.H * 0.08;
      const yMid = origHh * 0.12;
      const p = (x: number, y: number) => ({ x: x * sx, y: y * sy });
      const topL = p(-origHw, yShoulder);
      const topR = p(origHw, yShoulder);
      const midR = p(origHw, yMid);
      const midL = p(-origHw, yMid);
      const tip = p(0, origHh);
      const nodes: Node[] = [
        {
          x: topL.x,
          y: topL.y,
          cout: p(-origHw * 0.42, -origHh * 1.03),
        },
        {
          x: topR.x,
          y: topR.y,
          cin: p(origHw * 0.42, -origHh * 1.03),
        },
        {
          x: midR.x,
          y: midR.y,
          cout: p(origHw, origHh * 0.62),
        },
        {
          x: tip.x,
          y: tip.y,
          cin: p(origHw * 0.42, origHh * 0.88),
          cout: p(-origHw * 0.42, origHh * 0.88),
        },
        {
          x: midL.x,
          y: midL.y,
          cin: p(-origHw, origHh * 0.62),
        },
      ];
      return { closed: true, nodes };
    }

    case 'scalloped': {
      // Classic European enamel plaque: rectangle with concave quarter-circle corner notches
      const rNotchBase = Math.max(6, Math.min(spec.cornerRadius, spec.W * 0.16, spec.H * 0.16));
      const rNotch = rNotchBase + inset * 0.4;
      if (rNotch >= hw - 3 || rNotch >= hh - 3) return rect(W, H);
      const nodes: Node[] = [];
      // Top edge (-hw + r, -hh) -> (hw - r, -hh)
      // Top-right concave notch centered at (hw, -hh), sweeping CCW from PI to PI/2
      appendChain(nodes, [{ x: -hw + rNotch, y: -hh }]);
      appendChain(nodes, circleArcNodes(hw, -hh, rNotch, Math.PI, Math.PI / 2));
      // Bottom-right concave notch centered at (hw, hh), sweeping CCW from -PI/2 to -PI
      appendChain(nodes, circleArcNodes(hw, hh, rNotch, -Math.PI / 2, -Math.PI));
      // Bottom-left concave notch centered at (-hw, hh), sweeping CCW from 0 to -PI/2
      appendChain(nodes, circleArcNodes(-hw, hh, rNotch, 0, -Math.PI / 2));
      // Top-left concave notch centered at (-hw, -hh), sweeping CCW from PI/2 to 0
      appendChain(nodes, circleArcNodes(-hw, -hh, rNotch, Math.PI / 2, 0));
      return closeChain(nodes);
    }
  }
}

/** Extra margin factors for auto-sizing so content clears curved/pitched boundaries gracefully */
export function shapeAutoPaddingExtra(
  shape: BoardShape,
  contentW: number,
  contentH: number,
  roofPitch: number,
): { top: number; bottom: number; side: number } {
  switch (shape) {
    case 'arch':
      return { top: Math.max(26, Math.min(58, contentW * 0.24)), bottom: 2, side: 10 };
    case 'pill':
      return { top: 4, bottom: 4, side: Math.min(58, contentH * 0.34) };
    case 'house': {
      const pitchFrac = Math.max(0.15, Math.min(0.55, roofPitch / 100));
      return { top: Math.max(24, contentH * pitchFrac * 1.0), bottom: 2, side: 8 };
    }
    case 'shield':
      return { top: 14, bottom: Math.max(36, contentH * 0.3), side: 16 };
    case 'hexagon':
      return { top: 4, bottom: 4, side: Math.max(22, contentH * 0.26) };
    case 'oval':
      return { top: Math.max(16, contentH * 0.2), bottom: Math.max(16, contentH * 0.2), side: Math.max(20, contentW * 0.15) };
    case 'chamfer':
      return { top: 4, bottom: 4, side: 6 };
    case 'scalloped':
      return { top: 8, bottom: 8, side: 8 };
    default:
      return { top: 0, bottom: 0, side: 0 };
  }
}

/** Keyhole hanger slot centered at (cx, cy) with bottom head circle and upper shaft slot (CW) */
export function keyholePath(cx: number, cy: number, headDia: number, shaftDia: number): SubPath {
  const rHead = headDia / 2;
  const rShaft = Math.min(shaftDia / 2, rHead * 0.82);
  const slotLift = rHead + Math.max(4.5, rShaft * 2.4);
  const ratio = Math.max(-0.98, Math.min(0.98, rShaft / rHead));
  const dx = rShaft;
  const dy = Math.sqrt(Math.max(0.01, rHead * rHead - dx * dx));
  const aLeft = Math.atan2(-dy, -dx); // upper-left junction in (-PI, -PI/2)
  const aRight = Math.atan2(-dy, dx); // upper-right junction in (-PI/2, 0)
  const yTop = cy - slotLift;

  const nodes: Node[] = [];
  // Upper shaft semicircle CW from left (-PI) over top to right (0)
  appendChain(nodes, circleArcNodes(cx, yTop, rShaft, Math.PI, 2 * Math.PI));
  // Down right shaft wall to head junction, then head arc CW around bottom back to left junction
  appendChain(nodes, circleArcNodes(cx, cy, rHead, aRight, aLeft + 2 * Math.PI));
  return closeChain(nodes);
}

/**
 * Pull a candidate point (x, y) radially inward toward (0, 0) until it is strictly inside `boardPoly`
 * with at least `minClear` mm distance to every edge.
 */
function pullInsideBoard(boardPoly: Pt[], x: number, y: number, minClear: number): Pt {
  if (pointInPoly(boardPoly, { x, y }) && distToPoly(boardPoly, { x, y }) >= minClear) {
    return { x, y };
  }
  // Binary search t in [0, 1] along ray from origin (0, 0) to (x, y)
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) / 2;
    const pt = { x: x * mid, y: y * mid };
    if (pointInPoly(boardPoly, pt) && distToPoly(boardPoly, pt) >= minClear) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return { x: x * lo, y: y * lo };
}

export interface MountingResult {
  /** Cutout holes (CCW) to add to the board */
  cuts: SubPath[];
  /** Optional engraved clearance rings (e.g. standoff barrel outer rings) */
  marks: SubPath[];
  /** Hole center positions for info/checks */
  centers: Pt[];
}

/** Build shape-aware mounting holes / keyholes strictly inside the board outline */
export function buildMountingHoles(
  p: SignParams,
  spec: BoardSpec,
  boardOuter: SubPath,
): MountingResult {
  const cuts: SubPath[] = [];
  const marks: SubPath[] = [];
  const centers: Pt[] = [];
  if (p.mountType === 'none') return { cuts, marks, centers };

  const boardPoly = flattenSub(boardOuter, 24);
  const hw = spec.W / 2;
  const hh = spec.H / 2;
  const inset = Math.max(4, p.holeInset);

  const isKeyhole = p.mountType === 'keyhole1' || p.mountType === 'keyhole2';
  const rHole = isKeyhole ? p.keyholeHeadDia / 2 : p.holeDia / 2;
  // Minimum edge clearance = max(inset, rHole + 3) for target placement, guaranteed >= rHole + 2.5
  const minClear = Math.max(rHole + 2.5, Math.min(inset, Math.min(hw, hh) * 0.35));

  const placeCircle = (tx: number, ty: number) => {
    const pt = pullInsideBoard(boardPoly, tx, ty, minClear);
    centers.push(pt);
    cuts.push(reverseSub(circle(pt.x, pt.y, rHole)));
    if (p.mountType === 'standoff4' && p.standoffRingMark) {
      const rBarrel = Math.min(rHole * 2.2, minClear - 0.5 + rHole);
      if (rBarrel > rHole + 1) {
        marks.push(circle(pt.x, pt.y, rBarrel));
      }
    }
  };

  const placeKeyhole = (tx: number, ty: number) => {
    const headR = p.keyholeHeadDia / 2;
    const shaftR = Math.min(p.keyholeShaftDia / 2, headR * 0.82);
    const slotLift = headR + Math.max(4.5, shaftR * 2.4);
    // Test both top of slot and bottom of head inside the board
    const topClear = headR + 3;
    let cx = tx;
    let cy = Math.max(ty, -hh + inset + slotLift + shaftR);
    // Pull inward until both (cx, cy) and (cx, cy - slotLift) are strictly inside with clearance
    for (let step = 0; step < 30; step++) {
      const okBot = pointInPoly(boardPoly, { x: cx, y: cy }) && distToPoly(boardPoly, { x: cx, y: cy }) >= topClear;
      const okTop =
        pointInPoly(boardPoly, { x: cx, y: cy - slotLift }) &&
        distToPoly(boardPoly, { x: cx, y: cy - slotLift }) >= shaftR + 3;
      if (okBot && okTop) break;
      cx *= 0.9;
      cy = cy * 0.9 + 1.5;
    }
    centers.push({ x: cx, y: cy });
    cuts.push(reverseSub(keyholePath(cx, cy, p.keyholeHeadDia, p.keyholeShaftDia)));
  };

  const xL = -hw + inset;
  const xR = hw - inset;
  const yT = -hh + inset;
  const yB = hh - inset;

  switch (p.mountType as MountType) {
    case 'corners4':
    case 'standoff4':
      placeCircle(xL, yT);
      placeCircle(xR, yT);
      placeCircle(xR, yB);
      placeCircle(xL, yB);
      break;

    case 'triangle3':
      placeCircle(0, yT);
      placeCircle(xR, yB);
      placeCircle(xL, yB);
      break;

    case 'sides2':
      placeCircle(xL, 0);
      placeCircle(xR, 0);
      break;

    case 'vertical2':
      placeCircle(0, yT);
      placeCircle(0, yB);
      break;

    case 'keyhole1':
      placeKeyhole(0, -hh + inset + p.keyholeHeadDia + 5);
      break;

    case 'keyhole2': {
      const kx = Math.max(12, hw * 0.48);
      const ky = -hh + inset + p.keyholeHeadDia + 6;
      placeKeyhole(-kx, ky);
      placeKeyhole(kx, ky);
      break;
    }
  }

  return { cuts, marks, centers };
}
