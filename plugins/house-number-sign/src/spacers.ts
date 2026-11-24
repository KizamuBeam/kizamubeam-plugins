// Hidden standoff spacer generator (inset glyph copies OR round pegs) and interior alignment pin finder.
import { circle, host, type Pt, type SubPath } from '../../../sdk/ts';
import { bboxPts, distToPoly, flattenSub, pointInPoly, polyArea, reverseSub } from './types';

interface InteriorSample {
  x: number;
  y: number;
  /** Signed clearance to nearest boundary (outer or hole) in mm */
  clearance: number;
}

/**
 * Sample interior points of a glyph (closed outer contours CW, holes CCW) with their exact distance
 * to all glyph boundaries. Sorted deepest-first.
 */
function sampleGlyphInterior(glyphSubs: SubPath[], gridSteps = 22): InteriorSample[] {
  const closed = glyphSubs.filter((s) => s.closed && s.nodes.length >= 3);
  if (!closed.length) return [];
  const polys = closed.map((s) => flattenSub(s, 14));
  const withDepth = polys.map((poly, i) => ({
    poly,
    depth: polys.filter((q, j) => j !== i && pointInPoly(q, poly[0])).length,
  }));
  const outers = withDepth.filter((x) => x.depth % 2 === 0).map((x) => x.poly);
  const holes = withDepth.filter((x) => x.depth % 2 === 1).map((x) => x.poly);
  if (!outers.length) return [];

  const allPts = outers.flat();
  const bb = bboxPts(allPts);
  if (bb.w < 0.5 || bb.h < 0.5) return [];

  const nx = Math.max(8, Math.min(gridSteps, Math.ceil(bb.w / 2.2)));
  const ny = Math.max(8, Math.min(gridSteps + 8, Math.ceil(bb.h / 2.2)));
  const dx = bb.w / nx;
  const dy = bb.h / ny;
  const samples: InteriorSample[] = [];

  for (let iy = 0; iy < ny; iy++) {
    const y = bb.y0 + (iy + 0.5) * dy;
    for (let ix = 0; ix < nx; ix++) {
      const x = bb.x0 + (ix + 0.5) * dx;
      const q: Pt = { x, y };
      let inside = false;
      for (const o of outers) {
        if (pointInPoly(o, q)) {
          inside = true;
          break;
        }
      }
      if (!inside) continue;
      let inHole = false;
      for (const h of holes) {
        if (pointInPoly(h, q)) {
          inHole = true;
          break;
        }
      }
      if (inHole) continue;

      let dMin = Infinity;
      for (const p of polys) {
        const d = distToPoly(p, q);
        if (d < dMin) dMin = d;
      }
      if (dMin > 0.25) samples.push({ x, y, clearance: dMin });
    }
  }
  samples.sort((a, b) => b.clearance - a.clearance);
  return samples;
}

/**
 * Pick up to `maxCount` well-separated interior anchor points with boundary clearance >= `minClear`.
 * Prefers vertical spread (top & bottom stability) so stacked pieces never wobble or twist.
 */
export function findInteriorAnchors(
  glyphSubs: SubPath[],
  minClear: number,
  minSep: number,
  maxCount: number,
): Pt[] {
  const all = sampleGlyphInterior(glyphSubs, 24);
  if (!all.length) return [];
  const valid = all.filter((s) => s.clearance >= minClear);
  const pool = valid.length ? valid : all.slice(0, Math.max(1, Math.floor(all.length * 0.25)));

  const chosen: InteriorSample[] = [];
  // Seed with the deepest point in the upper half if available for balanced top/bottom spread
  const ys = pool.map((s) => s.y);
  const yMid = (Math.min(...ys) + Math.max(...ys)) / 2;
  const upperBest = pool.find((s) => s.y <= yMid);
  chosen.push(upperBest ?? pool[0]);

  while (chosen.length < maxCount) {
    let best: InteriorSample | null = null;
    let bestScore = -1;
    for (const cand of pool) {
      let minD = Infinity;
      for (const c of chosen) {
        const d = Math.hypot(cand.x - c.x, cand.y - c.y);
        if (d < minD) minD = d;
      }
      if (minD < minSep) continue;
      // Score combines separation and stroke-centering clearance
      const score = minD + cand.clearance * 1.4;
      if (score > bestScore) {
        bestScore = score;
        best = cand;
      }
    }
    if (!best) break;
    chosen.push(best);
  }
  return chosen.map(({ x, y }) => ({ x, y }));
}

export interface SpacerBuildResult {
  /** Cutout SubPaths for ONE spacer layer of this glyph (centered in glyph local coords) */
  subs: SubPath[];
  /** Optional alignment pin holes already placed in local coords (for board & number guide marks) */
  pins: Pt[];
  /** Peg centers (only populated in 'pegs' mode for glue guide circles) */
  pegCenters: Pt[];
  pegRadius: number;
}

/**
 * Build hidden spacer geometry for one character glyph (in local coordinates centered at 0, 0).
 * - `insetGlyph`: shrinks glyph inward by `spacerInset` using `host.offset`, with graceful fallback.
 * - `pegs`: places 2–4 round standoff discs strictly inside the glyph strokes (inset by `spacerInset`).
 */
export function buildGlyphSpacer(
  glyphSubs: SubPath[],
  spacerStyle: 'insetGlyph' | 'pegs',
  spacerInset: number,
  kerf: number,
  withPins: boolean,
  pinDia: number,
): SpacerBuildResult {
  const kerfHalf = kerf > 0 ? kerf / 2 : 0;

  if (spacerStyle === 'pegs') {
    const samples = sampleGlyphInterior(glyphSubs, 24);
    const maxClear = samples.length ? samples[0].clearance : 3;
    // Peg radius sits inside stroke with `spacerInset` shadow gap from outer edge
    const pegR = Math.max(2.5, Math.min(8.5, maxClear - spacerInset * 0.85));
    const minClear = pegR + Math.max(0.6, spacerInset * 0.75);
    const minSep = Math.max(pegR * 2.8, 12);
    let centers = findInteriorAnchors(glyphSubs, minClear, minSep, 4);
    if (!centers.length && samples.length) centers = [{ x: samples[0].x, y: samples[0].y }];
    if (!centers.length) centers = [{ x: 0, y: 0 }];

    const pins: Pt[] = [];
    const pinR = pinDia / 2;
    const subs: SubPath[] = [];
    for (const c of centers) {
      subs.push(circle(c.x, c.y, pegR + kerfHalf));
      if (withPins && pegR >= pinR + 1.2) {
        pins.push(c);
        subs.push(reverseSub(circle(c.x, c.y, Math.max(0.4, pinR - kerfHalf))));
      }
    }
    return { subs, pins, pegCenters: centers, pegRadius: pegR };
  }

  // `insetGlyph` mode: shrink glyph inward via host.offset
  const netDelta = -spacerInset + kerfHalf;
  let spacerSubs: SubPath[] = [];
  if (netDelta < -0.05) {
    spacerSubs = host.offset({ subs: glyphSubs, delta: netDelta, join: 'round' });
  } else {
    spacerSubs = glyphSubs;
  }

  // Filter out microscopic slivers (< 1 mm²) that could burn away
  spacerSubs = spacerSubs.filter((s) => s.closed && s.nodes.length >= 3 && polyArea(flattenSub(s, 8)) >= 1.0);

  // Graceful fallback if stroke was too thin for requested spacerInset
  if (!spacerSubs.length) {
    const halfInset = Math.max(0.4, spacerInset * 0.45);
    const retry = host.offset({ subs: glyphSubs, delta: -halfInset + kerfHalf, join: 'round' });
    spacerSubs = retry.filter((s) => s.closed && s.nodes.length >= 3 && polyArea(flattenSub(s, 8)) >= 0.8);
  }
  if (!spacerSubs.length) {
    // Ultimate fallback: small central hidden puck inside glyph
    const samples = sampleGlyphInterior(glyphSubs, 16);
    const pt = samples[0] ?? { x: 0, y: 0, clearance: 2.5 };
    const r = Math.max(2.0, Math.min(5.0, pt.clearance * 0.75));
    spacerSubs = [circle(pt.x, pt.y, r)];
  }

  const pins: Pt[] = [];
  if (withPins) {
    const pinR = pinDia / 2;
    const found = findInteriorAnchors(spacerSubs, pinR + 1.5, Math.max(pinDia * 4, 14), 2);
    for (const pt of found) {
      pins.push(pt);
      spacerSubs.push(reverseSub(circle(pt.x, pt.y, Math.max(0.4, pinR - kerfHalf))));
    }
  }

  return { subs: spacerSubs, pins, pegCenters: [], pegRadius: 0 };
}

/** Find up to 2 deep interior pin positions directly in a glyph (for `raisedFlat` with pinHoles) */
export function findFlatGlyphPins(glyphSubs: SubPath[], pinDia: number): Pt[] {
  const pinR = pinDia / 2;
  return findInteriorAnchors(glyphSubs, pinR + 2.0, Math.max(pinDia * 4, 16), 2);
}
