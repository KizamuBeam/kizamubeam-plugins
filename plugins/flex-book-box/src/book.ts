// One-piece Flex Book cover with Living Hinge spine, glue registration marks,
// 3D open-book assembly poses, and 2D part nesting.
import { host, roundedRect, type Part, type Pose, type SubPath, type V3 } from '../../../sdk/ts';
import { computeSpineHinge, type HingeResult } from './hinge';
import { buildPageBlock, type BoxPartData } from './box';
import type { BookDims, HingeOptions, P } from './types';

export interface BookBuild {
  parts: Part[];
  /** Closed contours only (cover outline without open hinge cuts + all box/divider parts) for host.check */
  checkParts: { key: string; subs: SubPath[] }[];
  poses: Record<string, Pose>;
  hinge: HingeResult;
  gapsX: number[];
  gapsY: number[];
  warnings: string[];
}

const X: V3 = [1, 0, 0];
const Y: V3 = [0, 1, 0];
const Z: V3 = [0, 0, 1];
const neg = (a: V3): V3 => [-a[0], -a[1], -a[2]];
const pose = (o: V3, u: V3, v: V3, n: V3): Pose => ({ o, u, v, n });

export function hingeOptions(p: P): HingeOptions {
  return {
    kind: p.hingeKind,
    cutLength: p.hingeCutLength,
    bridge: p.hingeBridge,
    spacing: p.hingeSpacing,
    margin: p.hingeMargin,
    waveAmp: p.hingeWaveAmp,
    waveLength: p.hingeWaveLength,
    diamondAngle: p.hingeDiamondAngle,
  };
}

/** Compute derived geometric dimensions of the Flex Book Box */
export function bookDims(p: P): BookDims {
  const Wc = p.coverWidth;
  const Hc = p.coverHeight;
  const P_h = p.pageThickness;
  const sq = p.square;
  const t = p.thickness;
  const Wb = Wc - sq;
  const Hb = Hc - 2 * sq;
  // Semicircular 180° wrap along the neutral axis of the cover sheet (r_mid = (P + t) / 2)
  const spineLen = Math.PI * ((P_h + t) / 2) + p.spineAllowance;
  const coverTotalW = 2 * Wc + spineLen;
  const hasDiv = p.compartmentsX > 1 || p.compartmentsY > 1;
  const dividerHeight = hasDiv ? P_h - p.dividerDrop : P_h;
  return {
    Wc,
    Hc,
    P: P_h,
    sq,
    Wb,
    Hb,
    spineLen,
    coverTotalW,
    t,
    kerf: p.kerf,
    clearance: p.clearance,
    finger: p.finger,
    floor: p.pageBlockFloor,
    dividerHeight,
  };
}

/**
 * Subtle L-shaped glue alignment marks on the inside face of the back cover,
 * showing exact placement of the page block (flush with the spine crease, inset by `square`).
 */
function glueAlignmentMarks(d: BookDims): SubPath[] {
  const x0 = d.spineLen / 2;
  const x1 = x0 + d.Wb;
  const y0 = -d.Hb / 2;
  const y1 = d.Hb / 2;
  const arm = Math.max(3, Math.min(12, d.Wb / 5, d.Hb / 5));

  const corner = (cx: number, cy: number, dx: number, dy: number): SubPath => ({
    closed: false,
    nodes: [
      { x: cx + dx * arm, y: cy },
      { x: cx, y: cy },
      { x: cx, y: cy + dy * arm },
    ],
  });

  // 4 corners of the page block footprint + centre tick along the spine crease
  return [
    corner(x0, y0, 1, 1),
    corner(x1, y0, -1, 1),
    corner(x1, y1, -1, -1),
    corner(x0, y1, 1, -1),
    {
      closed: false,
      nodes: [
        { x: x0, y: -arm / 2 },
        { x: x0, y: arm / 2 },
      ],
    },
  ];
}

/**
 * 3D poses showing the assembled book lying open flat on Z = 0:
 * - `cover` flat at Z = 0..t with inside face up (+Z, showing glue alignment marks)
 * - Page block resting on the right half (back cover) at Z = t..t+P
 * - Every outer wall has its laser-engraved face −(u×v) facing outward (so page-edge marks show outside)
 */
export function bookPoses(d: BookDims, centresX: number[], centresY: number[]): Record<string, Pose> {
  const { Wb, Hb, P: H, t, spineLen, dividerHeight: hd, floor } = d;
  const x0 = spineLen / 2;
  const x1 = x0 + Wb;
  const cx = x0 + Wb / 2;
  const y0 = -Hb / 2;
  const y1 = Hb / 2;
  const cy = 0;
  const z0 = t;
  const cz = z0 + H / 2;
  const down = neg(Z);

  const poses: Record<string, Pose> = {
    // Open cover flat on table; -(X × -Y) = +Z (inside face up)
    cover: pose([0, 0, 0], X, neg(Y), Z),
    // Outer walls (each outer engraved face -(u×v) points outward)
    tail: pose([cx, y0, cz], X, down, Y),
    head: pose([cx, y1 - t, cz], neg(X), down, Y),
    fore: pose([x1 - t, cy, cz], Y, down, X),
    spine: pose([x0, cy, cz], neg(Y), down, X),
  };

  if (floor) {
    // Page block floor plate at Z = t..2t; -(X × -Y) = +Z (inside floor up)
    poses.bottom = pose([cx, cy, z0], X, neg(Y), Z);
  }

  centresX.forEach((c, i) => {
    poses[`divx-${i + 1}`] = pose([x0 + c - t / 2, cy, z0 + hd / 2], Y, down, X);
  });
  centresY.forEach((c, i) => {
    poses[`divy-${i + 1}`] = pose([cx, y0 + c - t / 2, z0 + hd / 2], X, down, Y);
  });

  return poses;
}

/** Build the complete Flex Book Box assembly (2D nested parts + 3D poses) */
export function buildBook(p: P, d: BookDims): BookBuild {
  // 1. One-piece cover outer contour (expanded outward by kerf/2)
  const rOuter = p.coverCornerRadius > 0 ? p.coverCornerRadius + d.kerf / 2 : 0;
  const coverOutline = roundedRect(d.coverTotalW + d.kerf, d.Hc + d.kerf, rOuter);

  // 2. KizamuBeam Living Hinge cuts inside the spine zone [-spineLen/2, +spineLen/2] x [-Hc/2, +Hc/2]
  const hinge = computeSpineHinge(-d.spineLen / 2, -d.Hc / 2, d.spineLen / 2, d.Hc / 2, hingeOptions(p));
  if (hinge.error) {
    const err = new Error(hinge.error.code) as Error & { values?: Record<string, number> };
    if (hinge.error.values) err.values = hinge.error.values;
    throw err;
  }

  const coverMarks = p.glueMarks ? glueAlignmentMarks(d) : [];
  const coverPart: BoxPartData = {
    key: 'cover',
    subs: [coverOutline, ...hinge.subs],
    ...(coverMarks.length ? { marks: coverMarks } : {}),
  };

  // 3. Finger-jointed page block with dividers & page-edge score marks
  const block = buildPageBlock(p, d);

  const rawParts: BoxPartData[] = [coverPart, ...block.parts];

  // 4. Compact 2D nesting via host.nest (only pass outer closed outline for cover to keep nesting fast)
  const nestInput = rawParts.map((part) => ({
    key: part.key,
    subs: part.key === 'cover' ? [coverOutline] : part.subs,
  }));
  const placed = host.nest({ parts: nestInput, gap: 6 });

  const parts: Part[] = rawParts.map((part, i) => ({
    key: part.key,
    subs: part.subs,
    at: { x: placed[i][0], y: placed[i][1] },
    ...(part.marks?.length ? { marks: part.marks } : {}),
  }));

  // For host.check: exclude intentional open living-hinge cuts from cover so check-open doesn't false-positive
  const checkParts = rawParts.map((part) => ({
    key: part.key,
    subs: part.key === 'cover' ? [coverOutline] : part.subs,
  }));

  const poses = bookPoses(d, block.dividers.centresX, block.dividers.centresY);

  return {
    parts,
    checkParts,
    poses,
    hinge,
    gapsX: block.dividers.gapsX,
    gapsY: block.dividers.gapsY,
    warnings: block.dividers.warnings,
  };
}
