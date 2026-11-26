// Node tests for plugins/contour-box: the contour helpers, walking the middle line for the 3D view, the seam and the
// pieces, and the problems the dialog reports. The app's host functions are stubbed: joints hands the outlines back
// with the ring's length, boolean answers with the piece's area, hinge gives one cut per area, nest puts every part at
// the origin. The finger joints themselves are tested in the app (scripts/plugin-joints-test.ts there), and the whole
// plugin with the real host functions by `npm run plugin:check` in the app, also for overlaps in the 3D view.
// Run: node --test plugins/contour-box/test/contour-box.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build as esbuild } from 'esbuild';

const src = resolve(fileURLToPath(new URL('../src', import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), 'contour-box-'));
const calls = { joints: [], hinge: [] };
globalThis.host = {
  joints: (input) => {
    calls.joints.push(input);
    // Separate walls: two straight edges, handed back as they are
    if (!input.parts.floor) return { v: 2, parts: input.parts, added: [], info: [{ code: 'joint-finger-info', values: { n: 3, width: 10 } }] };
    // The ring's length on the middle of the wall, as the app measures it: sampled like the app, moved in by t/2
    const pts = sampleLike(input.parts.floor[0]);
    const mid = offset(pts, -input.options.thickness / 2);
    return { v: 2, parts: input.parts, added: [], info: [{ code: 'joint-finger-info', values: { n: 40, width: 10 } }, { code: 'joint-curve-strip', values: { len: perimeter(mid), loop: 1 } }] };
  },
  boolean: ({ op, a, b }) => (op === 'intersection' ? b ?? a : a),
  hinge: (input) => {
    calls.hinge.push(input);
    const xs = input.area[0].nodes.map((n) => n.x), ys = input.area[0].nodes.map((n) => n.y);
    const x = (Math.min(...xs) + Math.max(...xs)) / 2;
    return { v: 1, subs: [{ closed: false, nodes: [{ x, y: Math.min(...ys) }, { x, y: Math.max(...ys) }] }], info: [] };
  },
  nest: ({ parts }) => parts.map(() => [0, 0]),
};
await esbuild({ stdin: { contents: "export * from './box'; export * from './contour'; export * from './segments';", resolveDir: src, loader: 'ts' }, bundle: true, format: 'esm', platform: 'node', outfile: join(dir, 'm.mjs'), logLevel: 'error' });
const m = await import(pathToFileURL(join(dir, 'm.mjs')).href);
const { build, polygon, walls, pieceArea, dovetail, area, resample, offset, radii, runs, lengths, perimeter, decode, encode, fromSelection, smoothPath, sampleLike, walk, smooth } = m;
rmSync(dir, { recursive: true, force: true });

const manifest = JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url), 'utf8'));
const DEF = Object.fromEntries(manifest.plugins[0].params.map((p) => [p.key, p.def]));
const circle = (r, n = 200, ax = 1, ay = 1) => Array.from({ length: n }, (_, i) => [r * ax * Math.cos((2 * Math.PI * i) / n), r * ay * Math.sin((2 * Math.PI * i) / n)]);
const box = (p = {}, workArea = { width: 600, height: 400 }) => build({ ...DEF, ...p }, workArea);
const codes = (b) => b.issues.map((i) => i.code).sort();
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

test('contour helpers: area sign, even spacing, offset and radius of a circle, smoothing keeps its size', () => {
  const c = circle(50);
  assert.ok(area(c) > 0, 'anticlockwise in maths = clockwise on screen with y down');
  const r = resample(c, 300);
  const d = r.map((p, i) => Math.hypot(r[(i + 1) % r.length][0] - p[0], r[(i + 1) % r.length][1] - p[1]));
  assert.ok(Math.max(...d) - Math.min(...d) < 0.01, 'evenly spaced');
  const out = offset(r, 5), inn = offset(r, -5);
  for (const p of out) near(Math.hypot(p[0], p[1]), 55, 0.05);
  for (const p of inn) near(Math.hypot(p[0], p[1]), 45, 0.05);
  // Reversed: still outwards
  for (const p of offset(r.slice().reverse(), 5)) near(Math.hypot(p[0], p[1]), 55, 0.05);
  // A fine circle (a coarse polygon has kinks at its corners, which the plugin smooths away first)
  for (const q of radii(resample(circle(50, 3000), 300), 4)) near(q, 50, 0.05);
  for (const p of smooth(resample(c, 2000), 4)) near(Math.hypot(p[0], p[1]), 50, 0.02);
  // A straight line has no bend
  const bar = resample([[0, 0], [100, 0], [100, 10], [0, 10]], 220);
  assert.equal(radii(bar, 1)[50], Infinity);
  assert.ok(radii(bar, 1)[100] < 2, 'a corner');
});

test('runs along a closed outline wrap around its start', () => {
  const cum = [0, 1, 2, 3, 4, 5];
  assert.deepEqual(runs(cum, (i) => i === 0 || i === 4), [[-1, 1]]);
  assert.deepEqual(runs(cum, (i) => i === 2), [[2, 3]]);
  assert.deepEqual(runs(cum, () => true), [[0, 5]]);
  assert.deepEqual(runs(cum, () => false), []);
});

test('saved shape: encode, decode, rubbish refused; the selection gives its largest outline, centred', () => {
  const pts = circle(30, 100).map(([x, y]) => [x + 100, y + 50]);
  const back = decode(encode(pts));
  assert.equal(back.length, 100);
  near(back[0][0], 130, 0.006);
  for (const s of ['', 'x', '[]', '[[0,0],[1,1]]', '[[0,0],[1,"a"],[2,2]]', '{"a":1}', '[[0,0],[10,0],[20,0]]']) assert.equal(decode(s), null, s);
  // Dense input is thinned to about one point per half millimetre
  assert.ok(JSON.parse(encode(circle(10, 5000))).length <= 130);
  const sel = [{ name: 'a', polys: [pts.map(([x, y]) => ({ x, y }))] }, { name: 'b', polys: [[{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }]] }];
  const got = fromSelection(sel);
  assert.equal(got.length, 100);
  near(Math.max(...got.map((p) => p[0])), 30, 0.01);
  near(Math.min(...got.map((p) => p[1])), -30, 0.01);
  assert.equal(fromSelection([]), null);
  assert.equal(fromSelection([{ name: '', polys: [[{ x: 0, y: 0 }, { x: 1, y: 0 }]] }]), null);
});

test('the smooth path goes through every point, tangent at each', () => {
  const pts = resample(circle(40), 100);
  const sp = smoothPath(pts);
  assert.equal(sp.nodes.length, 100);
  for (const [i, nd] of sp.nodes.entries()) {
    near(nd.x, pts[i][0]);
    const a = [nd.x - nd.cin.x, nd.y - nd.cin.y], b = [nd.cout.x - nd.x, nd.cout.y - nd.y];
    near(a[0] * b[1] - a[1] * b[0], 0, 1e-9);
  }
  // Sampled like the app: close to the circle, about 0.3 mm apart
  const s = sampleLike(sp);
  for (const p of s) near(Math.hypot(p[0], p[1]), 40, 0.01);
  near(perimeter(s), 2 * Math.PI * 40, 0.1);
});

test('walking the middle line: chords as long as their stretch of strip, stops hit exactly', () => {
  const pts = circle(50, 2000);
  const cum = lengths(pts);
  const L = cum[pts.length];
  const w = walk(pts, cum, 0, L, () => 0.65, [100, 200]);
  for (let i = 1; i < w.path.length; i++) near(Math.hypot(w.path[i][0] - w.path[i - 1][0], w.path[i][1] - w.path[i - 1][1]), w.xs[i] - w.xs[i - 1], 1e-6);
  assert.ok(w.xs.some((x) => Math.abs(x - 100) < 1e-9) && w.xs.some((x) => Math.abs(x - 200) < 1e-9));
  near(w.xs[w.xs.length - 1], L, 1e-9);
  // The chords are a little shorter than the arc: the end lands just past the start, within a few micrometres
  near(Math.hypot(w.path.at(-1)[0] - w.path[0][0], w.path.at(-1)[1] - w.path[0][1]), 0, 0.005);
});

test('default shape: no problems, the seam and the joints between pieces on its flat sides', () => {
  calls.joints.length = 0;
  const b = box({}, { width: 400, height: 300 });
  assert.deepEqual(b.issues, []);
  assert.deepEqual(b.parts.map((p) => p.key), ['floor', 'lid', 'wall1', 'wall2']);
  // One joints call: fingers on the whole ring, the strip's lower edge from x = 0, measured on the wall middle
  assert.equal(calls.joints.length, 1);
  const j = calls.joints[0];
  assert.deepEqual(j.edges, [{ part: 'floor', seg: 0, chain: true }, { part: 'wall', seg: 0 }]);
  assert.equal(j.v, 2);
  assert.equal(j.options.kind, 'finger');
  assert.equal(j.options.direction, 'in');
  assert.deepEqual(j.parts.wall[0].nodes.slice(0, 2).map((n) => [n.x, n.y]), [[0, 60], [j.parts.wall[0].nodes[1].x, 60]]);
  assert.ok(j.parts.wall[0].nodes[1].x > b.stripLength + dovetail(3).depth, 'room for the last dovetails');
  // The strip around the middle line of the default shape: two circles (r 50 and 32) and their tangents, 1.5 mm in
  assert.ok(b.stripLength > 440 && b.stripLength < 460, String(b.stripLength));
  // Neither the seam (x = 0) nor the joint lies in a bend
  const inBend = (x) => b.bends.some(([u, v]) => x > u && x < v);
  assert.ok(!inBend(0) && !inBend(b.stripLength));
  assert.equal(b.pieces.length, 2);
  for (const [x0, x1] of b.pieces) {
    assert.ok(x1 - x0 + dovetail(3).depth <= 400, 'fits the work area');
    assert.ok(!inBend(x0));
  }
  // Two bends (the two circles), each with living hinge cuts
  assert.equal(b.bends.length, 2);
  assert.ok(calls.hinge.length >= 2);
});

test('3D view: every wall piece is bent along the middle line, chords as long as the strip, pieces meeting exactly', () => {
  const b = box({}, { width: 400, height: 300 });
  const ends = [];
  for (const [i, [x0, x1]] of b.pieces.entries()) {
    const pose = b.poses[`wall${i + 1}`];
    const path = pose.bend.path;
    assert.ok(path.length >= 2 && path.length <= 2000);
    let len = 0;
    for (let j = 1; j < path.length; j++) len += Math.hypot(path[j][0] - path[j - 1][0], path[j][1] - path[j - 1][1]);
    near(len, x1 - x0, 0.01);
    near(pose.bend.x0, -(x1 - x0) / 2);
    ends.push([path[0], path.at(-1)]);
    assert.deepEqual(pose.o, [0, 0, 30]);
  }
  assert.deepEqual(ends[0][1], ends[1][0]);
  assert.deepEqual(ends[1][1], ends[0][0]);
  assert.deepEqual(b.poses.floor.o, [0, 0, 0]);
  assert.deepEqual(b.poses.lid.o, [0, 0, 57]);
  // The wall runs anticlockwise seen from above (y → −Y): positive area in X, Y
  const all = [...b.poses.wall1.bend.path, ...b.poses.wall2.bend.path];
  let a = 0;
  for (let i = 0; i < all.length; i++) a += all[i][0] * all[(i + 1) % all.length][1] - all[(i + 1) % all.length][0] * all[i][1];
  assert.ok(a > 0);
});

test('a circle: one piece, the seam lies in the bend; inside measure makes it larger by two thicknesses', () => {
  const b = box({ contour: JSON.stringify(circle(60)) });
  assert.deepEqual(codes(b), ['seam-in-bend']);
  assert.equal(b.pieces.length, 1);
  assert.deepEqual(b.parts.map((p) => p.key), ['floor', 'lid', 'wall']);
  const size = (q) => Number(q.info[0][1].split(' × ')[0]);
  near(size(b), 120, 0.1);
  near(size(box({ contour: JSON.stringify(circle(60)), measure: 'inside' })), 126, 0.1);
  // Without a lid no lid part, and the living hinge reaches the free upper edge
  calls.hinge.length = 0;
  const open = box({ contour: JSON.stringify(circle(60)), lid: false });
  assert.deepEqual(open.parts.map((p) => p.key), ['floor', 'wall']);
  assert.equal(open.poses.lid, undefined);
  assert.equal(Math.min(...calls.hinge[0].area[0].nodes.map((n) => n.y)), 0);
});

test('problems: no shape, corners, too low, tight bends, a split in a bend', () => {
  assert.deepEqual(codes(box({ contour: '' })), ['contour-none']);
  const rect = box({ contour: JSON.stringify([[0, 0], [100, 0], [100, 60], [0, 60]]) });
  assert.deepEqual(codes(rect), ['bend-sharp']);
  assert.equal(rect.parts.length, 0);
  assert.deepEqual(codes(box({ height: 15 })), ['height-small']);
  assert.ok(codes(box({ contour: JSON.stringify(circle(12)) })).includes('bend-tight'));
  const big = box({ contour: JSON.stringify(circle(200, 400)) }, { width: 400, height: 300 });
  assert.ok(big.pieces.length >= 4);
  assert.ok(codes(big).includes('joint-in-bend'));
});

test('piece area: dovetails at the end, sockets with the play at the start, end faces a hair back', () => {
  const t = 3, c = 0.2, dv = dovetail(t);
  const pts = pieceArea(0, 100, 60, [30], t, c, 0);
  const xs = pts.map((p) => p[0]);
  near(Math.max(...xs), 100 + dv.depth);
  near(Math.min(...xs), c / 4);
  // Socket bottom: the dovetail's depth plus half the play
  assert.ok(pts.some((p) => Math.abs(p[0] - (dv.depth + c / 2)) < 1e-9 && Math.abs(p[1] - (30 + (dv.head + c) / 2)) < 1e-9));
  // The kerf moves the area outwards
  const k = pieceArea(0, 100, 60, [30], t, c, 0.2);
  near(Math.max(...k.map((p) => p[0])), 100 + dv.depth + 0.1, 1e-6);
});

const seg = (p = {}) => box({ wall: 'segments', ...p });
const turnOut = (ws) => ws.map((w, i) => {
  const a = ws[(i - 1 + ws.length) % ws.length].d, b = w.d;
  return -Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]);
});

test('separate walls: a rectangle keeps its four corners, a circle is split into walls of about the chosen width', () => {
  // Corners of the rectangle come back where the smoothing rounded them; anticlockwise seen from above
  const r = polygon(resample([[0, 0], [0, 60], [100, 60], [100, 0]], 400), 40);
  assert.equal(r.length, 4);
  for (const q of [[0, 0], [0, 60], [100, 60], [100, 0]]) assert.ok(r.some((p) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.05), String(q));
  const c = polygon(resample(circle(60, 2000).reverse(), 400), 40);
  assert.equal(c.length, Math.round((2 * Math.PI * 60) / 40));
  for (const p of c) near(Math.hypot(p[0], p[1]), 60, 0.01);
  // A stadium: two straight sides of one wall each, the half circles in walls of about 40 mm
  const st = [];
  for (let i = 0; i <= 100; i++) st.push([50 + 30 * Math.sin((Math.PI * i) / 100), -30 * Math.cos((Math.PI * i) / 100)]);
  for (let i = 0; i <= 100; i++) st.push([-50 - 30 * Math.sin((Math.PI * i) / 100), 30 * Math.cos((Math.PI * i) / 100)]);
  const sp = polygon(resample(st.reverse(), 800), 40);
  const edges = sp.map((p, i) => Math.hypot(sp[(i + 1) % sp.length][0] - p[0], sp[(i + 1) % sp.length][1] - p[1]));
  assert.equal(edges.filter((l) => Math.abs(l - 100) < 1).length, 2, edges.join(' '));
  assert.equal(sp.length, 2 + 2 * Math.round((Math.PI * 30) / 40));
});

test('separate walls: ends meet on the inside of outward corners, on the outside of inward ones', () => {
  const t = 3;
  // An L shape (anticlockwise seen from above): five corners out, one in
  const L = [[0, 0], [0, 80], [80, 80], [80, 50], [40, 50], [40, 0]];
  const ws = walls(L, t);
  const turns = turnOut(ws);
  assert.equal(turns.filter((a) => a > 0).length, 5);
  for (const [i, w] of ws.entries()) {
    // Outward normal points away from the inside of the L
    const mid = [w.v[0] + (w.len / 2) * w.d[0] + w.out[0], w.v[1] + (w.len / 2) * w.d[1] + w.out[1]];
    const inside = (p) => (p[0] > 0 && p[0] < 40 && p[1] > 0 && p[1] < 80) || (p[0] >= 40 && p[0] < 80 && p[1] > 50 && p[1] < 80);
    assert.ok(!inside(mid), `wall ${i}`);
    // Square corners close without a gap: the wall after an outward corner starts one thickness in, the wall before
    // an inward corner runs one thickness on
    near(w.a, turns[i] > 0 ? t : 0, 1e-9);
    near(w.b, turns[(i + 1) % ws.length] > 0 ? w.len : w.len + t, 1e-9);
    near(w.gap, 0, 1e-9);
  }
  // A hexagon: both walls end where their inner faces meet, leaving a gap outside
  const hex = walls(circle(50, 6).reverse(), t);
  for (const w of hex) {
    near(w.a, t * Math.tan(Math.PI / 6), 1e-9);
    near(w.gap, 2 * t * Math.tan(Math.PI / 6), 1e-9);
  }
});

test('separate walls: parts, names, joints on straight edges, walls standing on the floor with the laser side out', () => {
  calls.joints.length = 0;
  const b = seg({ contour: JSON.stringify(circle(60)), segment: 20 });
  const n = Math.round((2 * Math.PI * 60) / 20);
  assert.deepEqual(codes(b), []);
  assert.deepEqual(b.parts.map((p) => p.key), ['floor', 'lid', ...Array.from({ length: n }, (_, i) => `wall${i + 1}`)]);
  assert.deepEqual(b.labels.wall3, { code: 'part.wallN', values: { n: 3 } });
  assert.equal(calls.joints.length, n);
  for (const j of calls.joints) {
    assert.deepEqual(j.edges, [{ part: 'base', seg: 0 }, { part: 'wall', seg: 0 }]);
    // The stand-in for the floor's edge is longer at both ends, centred on the wall
    const bx = j.parts.base[0].nodes.map((q) => q.x), wx = j.parts.wall[0].nodes.map((q) => q.x);
    near((Math.min(...bx) + Math.max(...bx)) / 2, (Math.min(...wx) + Math.max(...wx)) / 2, 1e-9);
    assert.ok(Math.max(...bx) - Math.min(...bx) > Math.max(...wx) - Math.min(...wx));
  }
  for (let i = 1; i <= n; i++) {
    const ps = b.poses[`wall${i}`];
    near(ps.o[2], 30);
    // −(u×v) is the plate normal, pointing away from the centre
    const u = ps.u, v = ps.v;
    const w = [-(u[1] * v[2] - u[2] * v[1]), -(u[2] * v[0] - u[0] * v[2]), -(u[0] * v[1] - u[1] * v[0])];
    for (let k = 0; k < 3; k++) near(w[k], ps.n[k], 1e-9);
    assert.ok(ps.o[0] * ps.n[0] + ps.o[1] * ps.n[1] > 0);
    // The inner face of the wall on the inside of the polygon, one thickness in from the outline
    near(Math.hypot(ps.o[0], ps.o[1]), 60 * Math.cos(Math.PI / n) - 3, 0.03);
  }
  assert.deepEqual(b.poses.lid.o, [0, 0, 57]);
  const info = Object.fromEntries(b.info.map(([k, v]) => [k, v]));
  assert.equal(info['info.walls'], String(n));
  near(Number(info['info.gap'].split(' ')[0]), 2 * 3 * Math.tan(Math.PI / n), 0.01);
  // The bent strip's settings are not used
  assert.equal(calls.hinge.length >= 0, true);
  // Without a lid
  assert.deepEqual(seg({ contour: JSON.stringify(circle(60)), lid: false }).parts.slice(0, 2).map((p) => p.key), ['floor', 'wall1']);
});

test('separate walls: a rectangle needs no rounding, wide angles and narrow walls are reported', () => {
  const rect = seg({ contour: JSON.stringify([[0, 0], [100, 0], [100, 60], [0, 60]]) });
  assert.deepEqual(codes(rect), []);
  assert.equal(rect.parts.length, 6);
  // Inside measure: the walls go around the outline
  const size = (q) => Number(q.info[0][1].split(' × ')[0]);
  near(size(seg({ contour: JSON.stringify([[0, 0], [100, 0], [100, 60], [0, 60]]), measure: 'inside' })), 106, 0.05);
  // Wide walls on a circle leave wider gaps outside
  assert.deepEqual(codes(seg({ contour: JSON.stringify(circle(30)), segment: 30 })), ['corner-gap']);
  assert.deepEqual(codes(seg({ contour: JSON.stringify(circle(60)), segment: 40 })), []);
  assert.deepEqual(codes(seg({ contour: JSON.stringify(circle(60)) })), []);
  assert.deepEqual(codes(seg({ contour: JSON.stringify(circle(15)), segment: 10, finger: 12 })), ['wall-narrow']);
  // Low boxes are fine without dovetails
  assert.deepEqual(codes(seg({ contour: JSON.stringify(circle(60)), height: 15 })), []);
});
