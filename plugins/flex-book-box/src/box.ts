// Page block construction: finger-jointed panels via host.joints (v2), dividers,
// kerf compensation, and decorative horizontal paper-edge score lines (marks).
import { host, type JointPattern, type SubPath } from '../../../sdk/ts';
import { makeDividers, type DividerResult, type SlotRect } from './dividers';
import type { BookDims, P } from './types';

export interface BoxPartData {
  key: string;
  subs: SubPath[];
  marks?: SubPath[];
}

export interface PageBlockResult {
  parts: BoxPartData[];
  dividers: DividerResult;
}

/**
 * Subtract blocked horizontal intervals [b0, b1] from [x0, x1] with a small margin around divider slots
 * so score lines never cut across empty slot openings.
 */
function clipLineAgainstSlots(x0: number, x1: number, y: number, slots: SlotRect[], pad = 0.5): [number, number][] {
  const blocked: [number, number][] = [];
  for (const s of slots) {
    if (y >= s.y0 - pad && y <= s.y1 + pad) {
      blocked.push([s.x0 - pad, s.x1 + pad]);
    }
  }
  if (!blocked.length) return [[x0, x1]];
  blocked.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  let cur = x0;
  for (const [b0, b1] of blocked) {
    if (b1 <= cur) continue;
    if (b0 > cur + 1) out.push([cur, Math.min(x1, b0)]);
    cur = Math.max(cur, b1);
    if (cur >= x1) break;
  }
  if (x1 - cur > 1) out.push([cur, x1]);
  return out;
}

/**
 * Generate horizontal score lines (marks) mimicking stacked book pages on a visible outer wall.
 * Lines stay inside the clear wall field between corner joints and above the bottom finger zone,
 * and skip across any divider slots.
 */
function pageEdgeMarks(
  wallWidth: number,
  wallHeight: number,
  t: number,
  floor: boolean,
  spacing: number,
  slots: SlotRect[],
): SubPath[] {
  if (!(spacing > 0)) return [];
  const x0 = -wallWidth / 2 + t + 0.5;
  const x1 = wallWidth / 2 - t - 0.5;
  if (x1 - x0 <= 2) return [];

  // y runs down: top of wall (facing front cover) is -wallHeight/2, bottom is +wallHeight/2
  const zMin = floor ? t + Math.max(0.8, spacing * 0.5) : Math.max(0.8, spacing * 0.5);
  const zMax = wallHeight - Math.max(0.8, spacing * 0.5);
  if (zMax <= zMin) return [];

  const usable = zMax - zMin;
  const count = Math.floor(usable / spacing) + 1;
  const totalSpan = (count - 1) * spacing;
  const zStart = (zMin + zMax - totalSpan) / 2;

  const marks: SubPath[] = [];
  for (let i = 0; i < count; i++) {
    const z = zStart + i * spacing;
    const y = wallHeight / 2 - z;
    const segs = clipLineAgainstSlots(x0, x1, y, slots);
    const rev = i % 2 === 1;
    if (rev) segs.reverse();
    for (const [a, b] of segs) {
      marks.push({
        closed: false,
        nodes: rev ? [{ x: b, y }, { x: a, y }] : [{ x: a, y }, { x: b, y }],
      });
    }
  }
  return marks;
}

/** Apply outward kerf/2 offset to a divider outline via host.offset when kerf > 0 */
function offsetDividerOutline(outline: SubPath, kerf: number): SubPath {
  if (kerf <= 1e-9) return outline;
  const out = host.offset({ subs: [outline], delta: kerf / 2, join: 'miter' });
  if (out.length !== 1 || !out[0].closed || out[0].nodes.length < 3) {
    throw new Error('kerf-splits-contour');
  }
  return out[0];
}

/**
 * Build all parts of the finger-jointed page block:
 * - optional bottom plate (when pageBlockFloor = true)
 * - 4 outer walls: tail, head (width Wb x P, corners = true), fore, spine (width Hb x P, corners = false)
 * - optional X and Y dividers with cross-lap joints and wall/floor slots
 * - optional horizontal page-edge score marks on tail, head, and fore walls
 */
export function buildPageBlock(p: P, d: BookDims): PageBlockResult {
  const { Wb, Hb, P: H, t, finger, clearance, kerf, floor } = d;
  const panel = (
    width: number,
    height: number,
    edges: [JointPattern, JointPattern, JointPattern, JointPattern],
    corners: boolean,
  ): SubPath =>
    host.joints({
      op: 'panel',
      v: 2,
      width,
      height,
      thickness: t,
      finger,
      clearance,
      kerf,
      edges,
      corners,
    }).outline;

  const bottomEdgePattern: JointPattern = floor ? 'B' : 'flat';
  const tailOutline = panel(Wb, H, ['flat', 'A', bottomEdgePattern, 'A'], true);
  const headOutline = panel(Wb, H, ['flat', 'A', bottomEdgePattern, 'A'], true);
  const foreOutline = panel(Hb, H, ['flat', 'B', bottomEdgePattern, 'B'], false);
  const spineOutline = panel(Hb, H, ['flat', 'B', bottomEdgePattern, 'B'], false);

  const div = makeDividers({
    Wb,
    Hb,
    P: H,
    t,
    finger,
    clearance,
    kerf,
    floor,
    compartmentsX: p.compartmentsX,
    ratiosX: p.ratiosX,
    compartmentsY: p.compartmentsY,
    ratiosY: p.ratiosY,
    dividerHeight: d.dividerHeight,
  });

  const parts: BoxPartData[] = [];

  if (floor) {
    const bottomOutline = panel(Wb, Hb, ['A', 'A', 'A', 'A'], false);
    parts.push({ key: 'bottom', subs: [bottomOutline, ...div.holes.bottom] });
  }

  const lineSpacing = p.pageLineSpacing;
  const tailMarks = p.pageLines ? pageEdgeMarks(Wb, H, t, floor, lineSpacing, div.wallSlots.tail) : [];
  const headMarks = p.pageLines ? pageEdgeMarks(Wb, H, t, floor, lineSpacing, div.wallSlots.head) : [];
  const foreMarks = p.pageLines ? pageEdgeMarks(Hb, H, t, floor, lineSpacing, div.wallSlots.fore) : [];

  parts.push(
    { key: 'tail', subs: [tailOutline, ...div.holes.tail], ...(tailMarks.length ? { marks: tailMarks } : {}) },
    { key: 'head', subs: [headOutline, ...div.holes.head], ...(headMarks.length ? { marks: headMarks } : {}) },
    { key: 'fore', subs: [foreOutline, ...div.holes.fore], ...(foreMarks.length ? { marks: foreMarks } : {}) },
    { key: 'spine', subs: [spineOutline, ...div.holes.spine] },
  );

  for (const divider of div.dividers) {
    parts.push({
      key: divider.key,
      subs: [offsetDividerOutline(divider.outline, kerf)],
    });
  }

  return { parts, dividers: div };
}
