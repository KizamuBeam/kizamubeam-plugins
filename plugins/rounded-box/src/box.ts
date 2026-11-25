// Rounded box (#513): the parts and their problems from the parameters. The living hinge cuts come from the app
// (host.hinge), so this file runs in the plugin and, with the host functions of the app, in the Node tests.
import { host, mm, type HingeInput, type Issue, type Part, type Pose, type SubPath } from '../../../sdk/ts';
import { clipCircular, closedRing, dovetail, merge, pieceOutline, pointAt, ring, slot, stripMap, type V } from './geom';

export interface P {
  [k: string]: number | string | boolean;
  width: number;
  depth: number;
  height: number;
  radius: number;
  thickness: number;
  clearance: number;
  kerf: number;
  lid: boolean;
  rim: number;
  hingeKind: string;
  cutLength: number;
  bridge: number;
  spacing: number;
  bendExtra: number;
  tabWidth: number;
  tabPitch: number;
}

export interface Built {
  parts: Part[];
  issues: Issue[];
  info: [string, string][];
  /** Strip pieces as [x0, x1] along the strip, and the strip length (for tests) */
  pieces: [number, number][];
  stripLength: number;
  /** Parts in space for the 3D view and the assembly check: the wall pieces bent along the centre line */
  poses: Record<string, Pose>;
}

/** Angle between two points of a bent wall in the 3D view: 1.5° keeps the chords within 0.01 mm of the arc up to r = 100 (tabs in the slots show no false overlap) */
const POSE_STEP = (1.5 * Math.PI) / 180;

/** Room left at each end of a piece and around the dovetails, beside a tab and as the extension of a bend */
const GAP = 2;

export function build(p: P, workArea: { width: number; height: number } | null): Built {
  const t = p.thickness, c = p.clearance, k = p.kerf, w = p.tabWidth, H = p.height;
  const issues: Issue[] = [];
  const parts: Part[] = [];
  const empty = (): Built => ({ parts, issues, info: [], pieces: [], stripLength: 0, poses: {} });
  const minR = 1.5 * t;
  if (p.radius < minR) issues.push({ key: 'radius', level: 'error', code: 'radius-small', values: { min: Number(mm(minR)) } });
  const maxR = Math.min(p.width, p.depth) / 2;
  if (p.radius > maxR + 1e-9) issues.push({ key: 'radius', level: 'error', code: 'radius-large', values: { max: Number(mm(maxR)) } });
  const dv = dovetail(t);
  if (H < dv.head + 2 * t) issues.push({ key: 'height', level: 'error', code: 'height-small', values: { min: Number(mm(dv.head + 2 * t)) } });
  if (w + c - k <= 0 || t + c - k <= 0) issues.push({ key: 'kerf', level: 'error', code: 'kerf-large' });
  if (issues.some((i) => i.level === 'error')) return empty();
  const r = Math.min(p.radius, maxR);
  // Bend radius on the inside of the board: below about five thicknesses most boards need a test piece
  if (r - t < 5 * t) issues.push({ key: 'radius', level: 'warn', code: 'radius-tight', values: { r: Number(mm(r - t)) } });

  // Centre line of the wall, and the strip laid flat
  const rg = ring(p.width - t, p.depth - t, r - t / 2);
  const map = stripMap(rg, p.bendExtra);
  const L = map.length;
  // The seam lies in the middle of the longest straight side (s0 along the centre line, at x = 0 along the strip)
  const longest = map.straights.reduce<[number, number] | null>((b, q) => (!b || q[1] - q[0] > b[1] - b[0] ? q : b), null);
  const seamX = longest ? (longest[0] + longest[1]) / 2 : 0;
  const keepEnd = dv.depth + c + GAP;
  if (!longest || longest[1] - longest[0] < 2 * keepEnd) issues.push({ level: 'warn', code: 'seam-in-bend' });
  // Straight sides and bends along the strip, from the seam
  const straight = clipCircular(map.straights, L, seamX, 0, L);
  const bendsAll = clipCircular(map.bends.map(([a, b]) => [a - t, b + t] as [number, number]), L, seamX, -L, 2 * L);

  // Pieces: one, or as many as the work area needs; the joints between them go onto straight sides where possible
  const maxLen = workArea ? Math.max(workArea.width, workArea.height) - dv.depth - 2 * GAP : Infinity;
  let n = Math.max(1, Math.ceil(L / maxLen));
  let joints: number[] = [];
  for (let tries = 0; tries < 50; tries++, n++) {
    joints = [];
    for (let j = 1; j < n; j++) {
      const ideal = (j * L) / n;
      let best = ideal, dist = Infinity;
      for (const [a, b] of straight) {
        const lo = a + keepEnd, hi = b - keepEnd;
        if (hi < lo) continue;
        const x = Math.min(hi, Math.max(lo, ideal));
        if (Math.abs(x - ideal) < dist) (dist = Math.abs(x - ideal)), (best = x);
      }
      joints.push(best);
    }
    const ends = [0, ...joints, L];
    if (ends.every((x, i) => i === 0 || (x - ends[i - 1] <= maxLen && x - ends[i - 1] > 2 * keepEnd + w))) break;
    // Snapping made a piece too long: equal pieces instead, and more of them if that is not enough either
    joints = Array.from({ length: n - 1 }, (_, j) => ((j + 1) * L) / n);
    if ((L / n) <= maxLen) break;
  }
  const ends = [0, ...joints, L];
  const pieces: [number, number][] = ends.slice(1).map((x, i) => [ends[i], x]);
  if (joints.some((x) => !straight.some(([a, b]) => x >= a + keepEnd - 1e-6 && x <= b - keepEnd + 1e-6))) issues.push({ level: 'warn', code: 'joint-in-bend' });

  // Dovetails across the strip: one per 40 mm of height, away from the tabs
  const tailN = Math.max(1, Math.floor((H - 2 * t) / 40));
  const tails = Array.from({ length: tailN }, (_, i) => t + ((H - 2 * t) * (i + 0.5)) / tailN);

  const strips: { key: string; subs: SubPath[] }[] = [];
  const poses: Record<string, Pose> = {};
  const slots: SubPath[] = [];
  let cuts = 0;
  const hingeErr = new Set<string>();
  pieces.forEach(([x0, x1], i) => {
    // Tabs evenly over the piece, away from its ends
    const a = x0 + keepEnd + w / 2, b = x1 - keepEnd - w / 2;
    const tabs: number[] = [];
    if (b >= a) {
      const m = Math.max(1, Math.floor((b - a) / p.tabPitch) + 1);
      for (let j = 0; j < m; j++) tabs.push(m === 1 ? (a + b) / 2 : a + ((b - a) * j) / (m - 1));
    }
    const outline = pieceOutline({ x0, x1, h: H, t, tabs, tabWidth: w, top: p.lid, tails, clearance: c, kerf: k });
    // Living hinge where the piece bends, not into the sockets at its start nor right at its end
    const zones = merge(bendsAll.map(([u, v]) => [Math.max(u, x0 + keepEnd), Math.min(v, x1 - GAP)] as [number, number]).filter(([u, v]) => v - u > 1e-6));
    const cutsHere: SubPath[] = [];
    for (const [za, zb] of zones) {
      const rect = (u0: number, y0: number, u1: number, y1: number): SubPath => ({ closed: true, nodes: [{ x: u0, y: y0 }, { x: u1, y: y0 }, { x: u1, y: y1 }, { x: u0, y: y1 }] });
      // Uncut material around the root of each tab: notches out of the area (holes by even-odd)
      const notch = w / 2 + p.bridge, nh = p.bridge + t / 2;
      const holes: SubPath[] = [];
      for (const xc of tabs) {
        const u0 = Math.max(za, xc - notch), u1 = Math.min(zb, xc + notch);
        if (u1 - u0 < 1e-6) continue;
        holes.push(rect(u0, H - nh, u1, H));
        if (p.lid) holes.push(rect(u0, 0, u1, nh));
      }
      const input: HingeInput = {
        area: [rect(za, 0, zb, H), ...holes], kind: p.hingeKind === 'wave' ? 'wave' : 'straight', orient: 'vertical', margin: 0,
        cutLength: p.cutLength, bridge: p.bridge, spacing: p.spacing,
      };
      const res = host.hinge(input);
      if (res.error) {
        // A bend too narrow for one row of cuts gets none; other problems are the user's to fix
        if (res.error.code !== 'hinge-too-small') hingeErr.add(res.error.code);
        continue;
      }
      cutsHere.push(...res.subs);
    }
    cuts += cutsHere.length;
    const cx = (x0 + x1) / 2, cy = H / 2;
    const toLocal = (q: V) => ({ x: q[0] - cx, y: q[1] - cy });
    const move = (s: SubPath): SubPath => ({ closed: s.closed, nodes: s.nodes.map((nd) => ({ ...nd, x: nd.x - cx, y: nd.y - cy, ...(nd.cin ? { cin: { x: nd.cin.x - cx, y: nd.cin.y - cy } } : {}), ...(nd.cout ? { cout: { x: nd.cout.x - cx, y: nd.cout.y - cy } } : {}) })) });
    const key = pieces.length > 1 ? `wall${i + 1}` : 'wall';
    strips.push({ key, subs: [{ closed: true, nodes: outline.map(toLocal) }, ...cutsHere.map(move)] });
    poses[key] = wallPose(x0, x1, cx);
    // Slots for the tabs in floor and lid, at the same places along the centre line
    const half = (w + c - k) / 2;
    for (const xc of tabs) {
      const s = map.s(xc + seamX);
      slots.push(slot(rg, s - half, s + half, t + c - k));
    }
  });
  /**
   * A wall piece standing on the floor, bent along the centre line. Space: the floor seen from above (y of the work
   * area → −Y), X right, Z up. Local x of the piece is x − cx along the strip, local y runs down from mid height. The
   * centre line runs anticlockwise seen from above, so n (the path turned to the left) points into the box and the
   * laser side of the wall faces out (#463).
   */
  function wallPose(x0: number, x1: number, cx: number): Pose {
    const pts: [number, number, number][] = [];
    // A point at strip position x, moved d outwards from the centre line
    const add = (x: number, d: number) => {
      const q = pointAt(rg, map.s(x + seamX), d);
      pts.push([x, q[0], -q[1]]);
    };
    add(x0, 0);
    add(x1, 0);
    // Points 1.5° apart in each bend. The 3D view measures the strip along the chords, so the points move out until
    // each chord is as long as its piece of strip (also with bendExtra): the wall then closes exactly, and the pieces
    // meet at their joints
    const R = r - t / 2;
    for (const [a, b] of bendsAll.map(([u, v]) => [u + t, v - t])) {
      const lo = Math.max(a, x0), hi = Math.min(b, x1);
      if (hi <= lo) continue;
      const steps = Math.max(1, Math.ceil((hi - lo) / (b - a) / (POSE_STEP / (Math.PI / 2)) - 1e-9));
      const phi = ((Math.PI / 2) * (hi - lo)) / (b - a) / steps;
      const d = (hi - lo) / steps / (2 * Math.sin(phi / 2)) - R;
      for (let j = 0; j <= steps; j++) add(lo + ((hi - lo) * j) / steps, d);
    }
    const path: [number, number][] = [];
    for (const [, x, y] of pts.sort((p1, p2) => p1[0] - p2[0])) {
      const last = path[path.length - 1];
      if (!last || Math.hypot(x - last[0], y - last[1]) > 1e-6) path.push([x, y]);
    }
    return { o: [0, 0, t + H / 2], u: [1, 0, 0], v: [0, 0, -1], n: [0, 1, 0], bend: { path, x0: x0 - cx } };
  }
  for (const code of hingeErr) issues.push({ level: 'error', code });
  if (issues.some((i) => i.level === 'error')) return empty();

  // Floor and lid: the outline of the wall plus the rim, with the slots
  const plate = (): SubPath[] => [closedRing(rg, t / 2 + p.rim + k / 2), ...slots];
  parts.push({ key: 'floor', subs: plate(), at: { x: 0, y: 0 } });
  if (p.lid) parts.push({ key: 'lid', subs: plate(), at: { x: 0, y: 0 } });
  for (const s of strips) parts.push({ key: s.key, subs: s.subs, at: { x: 0, y: 0 } });
  // Floor and lid seen from above like the work area (y → −Y), the wall between them
  poses.floor = { o: [0, 0, 0], u: [1, 0, 0], v: [0, -1, 0], n: [0, 0, 1] };
  if (p.lid) poses.lid = { o: [0, 0, t + H], u: [1, 0, 0], v: [0, -1, 0], n: [0, 0, 1] };
  // Arrangement: the app's compact layout
  const at = host.nest({ parts: parts.map((q) => ({ key: q.key, subs: [q.subs[0]] })), gap: 5 }) as [number, number][];
  parts.forEach((q, i) => (q.at = { x: at[i][0], y: at[i][1] }));
  return {
    parts,
    issues,
    info: [
      ['info.strip', `${mm(L)} mm`],
      ['info.pieces', String(pieces.length)],
      ['info.bend', `${mm(r - t)} mm`],
      ['info.cuts', String(cuts)],
    ],
    pieces,
    stripLength: L,
    poses,
  };
}
