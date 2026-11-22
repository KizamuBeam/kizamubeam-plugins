import { host, type Pt, type SubPath } from '../../../sdk/ts';
import { bbox, flattenSub, pointInPoly, polyArea, type BridgeCount, type BridgeDirection } from './types';

type Poly = Pt[];

interface Dir {
  vertical: boolean;
  sign: -1 | 1;
}

const UP: Dir = { vertical: true, sign: -1 };
const DOWN: Dir = { vertical: true, sign: 1 };
const LEFT: Dir = { vertical: false, sign: -1 };
const RIGHT: Dir = { vertical: false, sign: 1 };
const opposite = (d: Dir): Dir => ({ vertical: d.vertical, sign: d.sign === 1 ? -1 : 1 });

const DIRS: Record<BridgeDirection, Dir[]> = {
  shortest: [UP, DOWN, LEFT, RIGHT],
  vertical: [UP, DOWN],
  horizontal: [LEFT, RIGHT],
};

/** Overshoot past the stroke edges so boolean difference cuts cleanly through without slivers (mm) */
const OVER = 0.15;

/** Where line (x = c if vertical, else y = c) crosses the polygons, sorted ascending */
function crossings(polys: Poly[], vertical: boolean, c: number): number[] {
  const out: number[] = [];
  for (const p of polys) {
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const a = p[j];
      const b = p[i];
      const [au, av, bu, bv] = vertical ? [a.x, a.y, b.x, b.y] : [a.y, a.x, b.y, b.x];
      if (au > c !== bu > c) out.push(av + ((c - au) * (bv - av)) / (bu - au));
    }
  }
  return out.sort((p, q) => p - q);
}

/** Check if point q lies strictly in the exterior (outside ALL outer contours of the glyph) */
function isExterior(outers: Poly[], q: Pt): boolean {
  for (const o of outers) {
    if (pointInPoly(o, q)) return false;
  }
  return true;
}

interface BridgeSpan {
  lo: number;
  hi: number;
  c: number;
  len: number;
  reachesExterior: boolean;
}

/**
 * Find the bridge span crossing the glyph stroke from an island `hole` in direction `d`.
 * Checks whether the far end reaches the glyph exterior (outer dial sheet) rather than another internal counter.
 */
function findBridge(all: Poly[], outers: Poly[], hole: Poly, d: Dir, width: number): BridgeSpan | null {
  const b = bbox(hole);
  const c = d.vertical ? (b.x0 + b.x1) / 2 : (b.y0 + b.y1) / 2;
  let lo = Infinity;
  let hi = -Infinity;
  let hits = 0;
  let centerFar = 0;

  for (let k = -4; k <= 4; k++) {
    const linePos = c + (k / 4) * (width / 2) * 0.96;
    const hs = crossings([hole], d.vertical, linePos);
    if (hs.length < 2) {
      if (k === 0) return null;
      continue;
    }
    const edge = d.sign < 0 ? hs[0] : hs[hs.length - 1];
    const at = edge + d.sign * 1e-3;
    const xs = crossings(all, d.vertical, linePos);
    let found: [number, number] | null = null;
    for (let i = 0; i + 1 < xs.length; i += 2) {
      if (xs[i] <= at && at <= xs[i + 1]) {
        found = [xs[i], xs[i + 1]];
        break;
      }
    }
    if (!found) {
      if (k === 0) return null;
      continue;
    }
    hits++;
    const [a, z] = d.sign < 0 ? [found[0], edge] : [edge, found[1]];
    if (k === 0) centerFar = d.sign < 0 ? found[0] : found[1];
    if (a < lo) lo = a;
    if (z > hi) hi = z;
  }

  if (!hits || !Number.isFinite(lo) || !Number.isFinite(hi)) return null;

  // Test point just beyond the far edge of the stroke along the center ray
  const testAlong = centerFar + d.sign * 0.05;
  const testPt: Pt = d.vertical ? { x: c, y: testAlong } : { x: testAlong, y: c };
  const ext = isExterior(outers, testPt);

  return { lo: lo - OVER, hi: hi + OVER, c, len: hi - lo, reachesExterior: ext };
}

function bridgeRect(d: Dir, span: BridgeSpan, width: number): SubPath {
  const c0 = span.c - width / 2;
  const c1 = span.c + width / 2;
  const nodes: Pt[] = d.vertical
    ? [
        { x: c0, y: span.lo },
        { x: c1, y: span.lo },
        { x: c1, y: span.hi },
        { x: c0, y: span.hi },
      ]
    : [
        { x: span.lo, y: c0 },
        { x: span.hi, y: c0 },
        { x: span.hi, y: c1 },
        { x: span.lo, y: c1 },
      ];
  return { closed: true, nodes };
}

export interface BridgedGlyphResult {
  subs: SubPath[];
  islands: number;
  bridges: number;
}

/**
 * Automatically detect inner counter islands in a cut-out numeral glyph (e.g. 0, 4, 6, 8, 9)
 * and cut stencil bridges through the glyph stroke via host.boolean so every island stays connected to the dial.
 */
export function applyStencilBridges(
  glyphSubs: SubPath[],
  width: number,
  count: BridgeCount,
  direction: BridgeDirection,
): BridgedGlyphResult {
  const closed = glyphSubs.filter((s) => s.closed && s.nodes.length >= 3);
  if (closed.length < 2) {
    return { subs: glyphSubs, islands: 0, bridges: 0 };
  }

  const polys = closed.map((s) => flattenSub(s, 16));
  const withDepth = polys.map((poly, i) => ({
    poly,
    depth: polys.filter((q, j) => j !== i && pointInPoly(q, poly[0])).length,
  }));

  const outers = withDepth.filter((x) => x.depth % 2 === 0).map((x) => x.poly);
  const holes = withDepth.filter((x) => x.depth % 2 === 1 && polyArea(x.poly) >= 0.25);

  if (!holes.length) {
    return { subs: glyphSubs, islands: 0, bridges: 0 };
  }

  const cuts: SubPath[] = [];
  let bridgeTotal = 0;

  for (const h of holes) {
    const b = bbox(h.poly);
    const maxSpan = Math.max(b.x1 - b.x0, b.y1 - b.y0);
    const wantTwo = count === '2' || (count === 'auto' && maxSpan >= 8);

    const candidates = DIRS[direction]
      .map((d) => ({ d, span: findBridge(polys, outers, h.poly, d, width) }))
      .filter((x): x is { d: Dir; span: BridgeSpan } => x.span !== null)
      // Always prioritize bridges that reach the exterior dial sheet, then shortest stroke crossing
      .sort((a, z) => {
        if (a.span.reachesExterior !== z.span.reachesExterior) {
          return a.span.reachesExterior ? -1 : 1;
        }
        return a.span.len - z.span.len;
      });

    if (!candidates.length) continue;

    const first = candidates[0];
    const chosen = [first];

    if (wantTwo) {
      const opp = opposite(first.d);
      const oppSpan = findBridge(polys, outers, h.poly, opp, width);
      const altExt = candidates.find(
        (x) => (x.d.vertical !== first.d.vertical || x.d.sign !== first.d.sign) && x.span.reachesExterior,
      );
      if (oppSpan && oppSpan.reachesExterior && (!altExt || oppSpan.len <= altExt.span.len * 1.6)) {
        chosen.push({ d: opp, span: oppSpan });
      } else if (altExt) {
        chosen.push(altExt);
      } else if (oppSpan) {
        chosen.push({ d: opp, span: oppSpan });
      }
    }

    for (const c of chosen) {
      cuts.push(bridgeRect(c.d, c.span, width));
      bridgeTotal++;
    }
  }

  if (!cuts.length) {
    return { subs: glyphSubs, islands: holes.length, bridges: 0 };
  }

  const bridged = host.boolean({ op: 'difference', a: closed, b: cuts });
  return { subs: bridged, islands: holes.length, bridges: bridgeTotal };
}
