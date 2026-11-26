// Box from a contour (#513): floor and lid follow any smooth closed outline, the wall is one strip bent around it with
// living hinge cuts where it curves. Floor, lid and strip interlock with finger joints from the app's Joint tool
// (host.joints with chain: true measures them on the middle of the wall), the strip ends meet with dovetails, and a
// strip longer than the work area is split into pieces that join the same way.
import { host, mm, type HingeInput, type Issue, type Part, type Pose, type SubPath, type Text } from '../../../sdk/ts';
import { buildSegments } from './segments';
import { area, decode, lengths, offset, perimeter, radii, resample, runs, sampleLike, smooth, smoothPath, walk, type V } from './contour';

export interface P {
  [k: string]: number | string | boolean;
  contour: string;
  wall: string;
  segment: number;
  measure: string;
  height: number;
  lid: boolean;
  thickness: number;
  clearance: number;
  kerf: number;
  finger: number;
  hingeKind: string;
  cutLength: number;
  bridge: number;
  spacing: number;
  flatRadius: number;
}

export interface Built {
  parts: Part[];
  issues: Issue[];
  info: [Text, Text][];
  /** Strip pieces as [x0, x1] along the strip, the strip length and the bend zones along it (for tests) */
  pieces: [number, number][];
  stripLength: number;
  bends: [number, number][];
  poses: Record<string, Pose>;
  /** Names of the parts by key (separate walls only) */
  labels?: Record<string, Text>;
}

/** Room left at each end of a piece, beside the dovetails and before the end of a bend */
const GAP = 2;
/** Angle between two points of a bent wall in the 3D view (at most 2 mm apart): the chords stay within 3 µm of the curve */
const POSE_STEP = (0.75 * Math.PI) / 180;

export const dovetail = (t: number) => {
  const depth = Math.max(4, 2 * t);
  return { depth, neck: 0.9 * depth, head: 1.6 * depth };
};

/** Polygon moved e outwards (miter joins); for the kerf, e is small against the features */
export function grow(pts: V[], e: number): V[] {
  if (Math.abs(e) < 1e-12) return pts;
  const sgn = area(pts) > 0 ? 1 : -1;
  const n = pts.length;
  const normal = (p: V, q: V): V => {
    const dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy);
    return [(sgn * dy) / l, (-sgn * dx) / l];
  };
  return pts.map((p, i) => {
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const n1 = normal(a, p), n2 = normal(p, b);
    const c = 1 + n1[0] * n2[0] + n1[1] * n2[1];
    if (c < 1e-6) return [p[0] + n1[0] * e, p[1] + n1[1] * e];
    return [p[0] + ((n1[0] + n2[0]) * e) / c, p[1] + ((n1[1] + n2[1]) * e) / c];
  });
}

/**
 * The area of one strip piece from x0 to x1 (y down, the strip from 0 to h): dovetails sticking out at x1 and sockets
 * for the dovetails of the piece before it at x0, moved outwards by half the kerf. Wider than the strip, so cutting
 * the strip with it keeps its finger joints.
 */
export function pieceArea(x0: number, x1: number, h: number, tails: number[], t: number, c: number, k: number): V[] {
  const dv = dovetail(t);
  // The end faces stand back a little (a quarter of the play, at least 10 µm), so two pieces meet with a hair of
  // room instead of touching exactly; the dovetails keep their length from x1
  const e = Math.max(0.01, c / 4);
  const a = x0 + e, b = x1 - e;
  const pts: V[] = [[a, -h], [b, -h]];
  for (const y of tails) pts.push([b, y - dv.neck / 2], [x1 + dv.depth, y - dv.head / 2], [x1 + dv.depth, y + dv.head / 2], [b, y + dv.neck / 2]);
  pts.push([b, 2 * h], [a, 2 * h]);
  const sd = dv.depth + c / 2, sn = dv.neck + c, sh = dv.head + c;
  for (const y of tails.slice().reverse()) pts.push([a, y + sn / 2], [x0 + sd, y + sh / 2], [x0 + sd, y - sh / 2], [a, y - sn / 2]);
  return grow(pts, k / 2);
}

const rect = (x0: number, y0: number, x1: number, y1: number): SubPath => ({ closed: true, nodes: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }] });

const mapSub = (s: SubPath, f: (x: number, y: number) => { x: number; y: number }): SubPath => ({
  closed: s.closed,
  nodes: s.nodes.map((nd) => ({ ...nd, ...f(nd.x, nd.y), ...(nd.cin ? { cin: f(nd.cin.x, nd.cin.y) } : {}), ...(nd.cout ? { cout: f(nd.cout.x, nd.cout.y) } : {}) })),
});

/** Merge overlapping intervals */
function merge(iv: [number, number][]): [number, number][] {
  const s = iv.slice().sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const q of s) {
    const last = out[out.length - 1];
    if (last && q[0] <= last[1]) last[1] = Math.max(last[1], q[1]);
    else out.push([q[0], q[1]]);
  }
  return out;
}

/** Intervals of a closed outline of length L that may wrap (start < 0 or end > L), cut into pieces within 0 … L */
function unwrap(iv: [number, number][], L: number): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of iv) {
    if (a < 0) out.push([a + L, L], [0, b]);
    else if (b > L) out.push([a, L], [0, b - L]);
    else out.push([a, b]);
  }
  return merge(out.filter(([a, b]) => b - a > 1e-9));
}

export function build(p: P, workArea: { width: number; height: number } | null): Built {
  const t = p.thickness, c = p.clearance, k = p.kerf, H = p.height;
  const issues: Issue[] = [];
  const parts: Part[] = [];
  const empty = (): Built => ({ parts: [], issues, info: [], pieces: [], stripLength: 0, bends: [], poses: {} });
  const dv = dovetail(t);
  const raw = decode(p.contour);
  if (!raw) issues.push({ level: 'error', code: 'contour-none' });
  const segs = p.wall === 'segments';
  // Room for the dovetails between strip pieces; separate walls need only their finger joints
  const minH = segs ? 2 * t + 3 : dv.head + 2 + 2 * t;
  if (H < minH) issues.push({ key: 'height', level: 'error', code: 'height-small', values: { min: Number(mm(minH)) } });
  if (!raw || issues.some((i) => i.level === 'error')) return empty();

  // The outline anticlockwise seen from above (y down: negative area), so the wall's laser side faces out (#463).
  // Polygons (outlines of curves as the app hands them over) have small kinks at every point: evened out over about
  // 2 mm, then one point every 1.5 mm, which the Bézier curves through them follow without new kinks
  let pts = area(raw!) > 0 ? raw!.slice().reverse() : raw!;
  const per = perimeter(pts);
  pts = smooth(resample(pts, Math.max(64, Math.min(8000, Math.round(per / 0.25)))), Math.max(1, Math.round(1 / Math.max(0.25, per / 8000))));
  pts = resample(pts, Math.max(48, Math.min(1500, Math.round(perimeter(pts) / 1.5))));
  if (segs) {
    const sb = buildSegments(p, pts);
    return { parts: sb.parts, issues: sb.issues, info: sb.info, pieces: [], stripLength: 0, bends: [], poses: sb.poses, labels: sb.labels };
  }
  // Outside of the wall, and the middle of the wall (the layer that keeps its length when the board bends)
  const outer = p.measure === 'inside' ? offset(pts, t) : pts;
  const mid0 = offset(outer, -t / 2);
  const rad0 = radii(mid0, Math.max(2, 1.5 * t));
  // Bend radius on the inside of the board, from neighbouring points (rad0 evens out over a few millimetres for the
  // bend zones and would hide a corner). Below one thickness the fingers' flanks would cross.
  const inner = Math.min(...radii(mid0, 1)) - t / 2;
  if (inner < t) {
    issues.push({ level: 'error', code: 'bend-sharp', values: { r: Number(mm(Math.max(0, inner))), min: Number(mm(t)) } });
    return empty();
  }
  if (inner < 5 * t) issues.push({ level: 'warn', code: 'bend-tight', values: { r: Number(mm(inner)) } });

  // The seam (start of the strip) in the middle of the longest flat part, so the dovetails do not have to bend
  const keepEnd = dv.depth + c + GAP;
  const cum0 = lengths(mid0);
  const flat0 = runs(cum0, (i) => rad0[i] >= p.flatRadius);
  const longest = flat0.reduce<[number, number] | null>((b, q) => (!b || q[1] - q[0] > b[1] - b[0] ? q : b), null);
  let seamS: number;
  if (longest && longest[1] - longest[0] >= 2 * keepEnd) seamS = (longest[0] + longest[1]) / 2;
  else {
    issues.push({ level: 'warn', code: 'seam-in-bend', values: { len: Number(mm(keepEnd + GAP)) } });
    let bi = 0;
    rad0.forEach((r, i) => (r > rad0[bi] ? (bi = i) : 0));
    seamS = cum0[bi];
  }
  const L0 = cum0[cum0.length - 1];
  const n = outer.length;
  let k0 = 0;
  for (let i = 0; i < n; i++) if (Math.abs(cum0[i] - (((seamS % L0) + L0) % L0)) < Math.abs(cum0[k0] - (((seamS % L0) + L0) % L0))) k0 = i;
  const rot = <T>(a: T[]) => [...a.slice(k0), ...a.slice(0, k0)];
  const out = rot(outer), mid = rot(mid0), rad = rot(rad0);
  const cum = lengths(mid);
  const Lm = cum[n];

  // Finger joints from the app: the floor's outline is the ring, the strip's lower edge runs from x = 0 to the right.
  // The strip is longer than the ring: the pattern starts at x = 0, the rest stays plain and holds the last dovetails.
  const floorSub = smoothPath(out);
  const Lx = Lm * 1.02 + dv.depth + 10;
  const strip: SubPath = { closed: true, nodes: [{ x: 0, y: H }, { x: Lx, y: H }, { x: Lx, y: 0 }, { x: 0, y: 0 }] };
  const jr = host.joints({
    op: 'edge', v: 2, options: { kind: 'finger', thickness: t, fingerWidth: p.finger, direction: 'in', kerf: k, clearance: c },
    parts: { floor: [floorSub], wall: [strip] }, edges: [{ part: 'floor', seg: 0, chain: true }, { part: 'wall', seg: 0 }],
  });
  if (jr.error) {
    issues.push({ level: 'error', code: jr.error.code, values: jr.error.values as Record<string, number> | undefined });
    return empty();
  }
  const lenInfo = jr.info.find((m) => m.code === 'joint-curve-strip');
  const L = lenInfo && typeof lenInfo.values?.len === 'number' ? (lenInfo.values.len as number) : Lm;
  // Lengths along the strip → along this file's middle line
  const sig = Lm / L;
  // The middle of the wall sampled as the app measured it, for the 3D view: its length is the strip's
  const fine = offset(sampleLike(floorSub), -t / 2);
  const fineCum = lengths(fine);
  const fineSig = fineCum[fine.length] / L;
  let wall = jr.parts.wall;
  // With a lid the upper edge gets the same notches: the strip mirrored top to bottom keeps every x
  if (p.lid) wall = host.boolean({ op: 'intersection', a: wall, b: wall.map((s) => mapSub(s, (x, y) => ({ x, y: H - y }))) });

  // Flat parts and bends along the strip
  const flat = unwrap(runs(cum, (i) => rad[i] >= p.flatRadius).map(([a, b]) => [a / sig, b / sig] as [number, number]), L);
  const bends = unwrap(runs(cum, (i) => rad[i] < p.flatRadius).map(([a, b]) => [a / sig - t, b / sig + t] as [number, number]), L);

  // Pieces: one, or as many as the work area needs; the joints between them go onto flat parts where possible
  const maxLen = workArea ? Math.max(workArea.width, workArea.height) - dv.depth - 2 * GAP : Infinity;
  let pieceN = Math.max(1, Math.ceil(L / maxLen));
  let joints: number[] = [];
  for (let tries = 0; tries < 50; tries++, pieceN++) {
    joints = [];
    for (let j = 1; j < pieceN; j++) {
      const ideal = (j * L) / pieceN;
      let best = ideal, d = Infinity;
      for (const [a, b] of flat) {
        const lo = a + keepEnd, hi = b - keepEnd;
        if (hi < lo) continue;
        const x = Math.min(hi, Math.max(lo, ideal));
        if (Math.abs(x - ideal) < d) (d = Math.abs(x - ideal)), (best = x);
      }
      joints.push(best);
    }
    const ends = [0, ...joints, L];
    if (ends.every((x, i) => i === 0 || (x - ends[i - 1] <= maxLen && x - ends[i - 1] > 2 * keepEnd))) break;
    joints = Array.from({ length: pieceN - 1 }, (_, j) => ((j + 1) * L) / pieceN);
    if (L / pieceN <= maxLen) break;
  }
  const ends = [0, ...joints, L];
  const pieces: [number, number][] = ends.slice(1).map((x, i) => [ends[i], x]);
  if (joints.some((x) => !flat.some(([a, b]) => x >= a + keepEnd - 1e-6 && x <= b - keepEnd + 1e-6))) issues.push({ level: 'warn', code: 'joint-in-bend' });

  // Dovetails across the strip between the finger joints: one per 40 mm of height
  const tailN = Math.max(1, Math.floor((H - 2 * t) / 40));
  const tails = Array.from({ length: tailN }, (_, i) => t + ((H - 2 * t) * (i + 0.5)) / tailN);

  const poses: Record<string, Pose> = {};
  const walls: Part[] = [];
  let cuts = 0;
  const hingeErr = new Set<string>();
  // Bend radius at a length along the middle line, for the spacing of the points of the 3D view
  const radAt = (s: number) => {
    const u = ((s % Lm) + Lm) % Lm;
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (cum[m] <= u) lo = m;
      else hi = m - 1;
    }
    return rad[lo];
  };
  // The middle of the wall in space, walked once around for all pieces, so they meet exactly at their joints; the
  // last point is the first, so the wall closes
  const all = walk(fine, fineCum, 0, L * fineSig, (s) => Math.min(2, Math.max(0.3, radAt((s / fineSig) * sig) * POSE_STEP)), joints);
  all.path[all.path.length - 1] = all.path[0];
  pieces.forEach(([x0, x1], i) => {
    const subs = host.boolean({ op: 'intersection', a: wall, b: [{ closed: true, nodes: pieceArea(x0, x1, H, tails, t, c, k).map(([x, y]) => ({ x, y })) }] });
    // Living hinge where the piece bends, between the finger joints, not into the sockets at its start nor at its end
    const y0 = p.lid ? t + p.bridge : 0, y1 = H - t - p.bridge;
    const zones = merge(bends.map(([u, v]) => [Math.max(u, x0 + keepEnd), Math.min(v, x1 - GAP)] as [number, number]).filter(([u, v]) => v - u > 1e-6));
    const cutsHere: SubPath[] = [];
    if (y1 - y0 > 1) {
      for (const [za, zb] of zones) {
        const input: HingeInput = {
          area: [rect(za, y0, zb, y1)], kind: p.hingeKind === 'wave' ? 'wave' : 'straight', orient: 'vertical', margin: 0,
          cutLength: p.cutLength, bridge: p.bridge, spacing: p.spacing,
        };
        const res = host.hinge(input);
        if (res.error) {
          if (res.error.code !== 'hinge-too-small') hingeErr.add(res.error.code);
          continue;
        }
        cutsHere.push(...res.subs);
      }
    }
    cuts += cutsHere.length;
    const cx = (x0 + x1) / 2, cy = H / 2;
    const key = pieces.length > 1 ? `wall${i + 1}` : 'wall';
    walls.push({ key, subs: [...subs, ...cutsHere].map((s) => mapSub(s, (x, y) => ({ x: x - cx, y: y - cy }))), at: { x: 0, y: 0 } });
    // The piece in space: standing on the floor plane, bent along the middle of the wall (seen from above, y → −Y).
    // Consecutive points are as far apart as their stretch of strip, so the strip closes where its length says.
    const a = all.xs.findIndex((x) => Math.abs(x - x0) < 1e-6), b = all.xs.findIndex((x) => Math.abs(x - x1) < 1e-6);
    let path = all.path.slice(a, b + 1);
    // At most LIMITS.bendPoints (2000) points per part: thin out evenly, keeping both ends
    if (path.length > 1990) path = path.filter((_, j) => j === path.length - 1 || j % Math.ceil(path.length / 1990) === 0);
    poses[key] = { o: [0, 0, H / 2], u: [1, 0, 0], v: [0, 0, -1], n: [0, 1, 0], bend: { path: path.map(([x, y]) => [x, -y] as [number, number]), x0: x0 - cx } };
  });
  for (const code of hingeErr) issues.push({ level: 'error', code });
  if (issues.some((i) => i.level === 'error')) return empty();

  parts.push({ key: 'floor', subs: jr.parts.floor, at: { x: 0, y: 0 } });
  if (p.lid) parts.push({ key: 'lid', subs: jr.parts.floor, at: { x: 0, y: 0 } });
  parts.push(...walls);
  poses.floor = { o: [0, 0, 0], u: [1, 0, 0], v: [0, -1, 0], n: [0, 0, 1] };
  if (p.lid) poses.lid = { o: [0, 0, H - t], u: [1, 0, 0], v: [0, -1, 0], n: [0, 0, 1] };
  const at = host.nest({ parts: parts.map((q) => ({ key: q.key, subs: q.subs.filter((s) => s.closed) })), gap: 5 }) as [number, number][];
  parts.forEach((q, i) => (q.at = { x: at[i][0], y: at[i][1] }));

  const xs = out.map((q) => q[0]), ys = out.map((q) => q[1]);
  const fingers = jr.info.find((m) => m.code === 'joint-finger-info');
  return {
    parts,
    issues,
    info: [
      ['info.size', `${mm(Math.max(...xs) - Math.min(...xs))} × ${mm(Math.max(...ys) - Math.min(...ys))} × ${mm(H)} mm`],
      ['info.strip', `${mm(L)} mm`],
      ['info.pieces', String(pieces.length)],
      ['info.bend', `${mm(inner)} mm`],
      ['info.cuts', String(cuts)],
      ...(fingers ? [['info.fingers', { code: fingers.code, values: fingers.values as Record<string, number> }] as [Text, Text]] : []),
    ],
    pieces,
    stripLength: L,
    bends,
    poses,
  };
}
