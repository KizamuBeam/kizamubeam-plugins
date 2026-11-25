// Node tests for plugins/rounded-box: centre line and Bézier arcs, strip mapping, slots where the tabs land,
// dovetail play, kerf, lid, round box, splitting for the work area and problems. The app's host functions are
// stubbed (one cut per living hinge area, nest at the origin); the living hinge cuts themselves are tested in the app
// (scripts/plugin-hinge-test.ts there). Run: node --test plugins/rounded-box/test/rounded-box.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build as esbuild } from 'esbuild';

const src = resolve(fileURLToPath(new URL('../src', import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), 'rounded-box-'));
const hingeCalls = [];
globalThis.host = {
  hinge: (input) => {
    hingeCalls.push(input);
    const xs = input.area[0].nodes.map((n) => n.x), ys = input.area[0].nodes.map((n) => n.y);
    const x = (Math.min(...xs) + Math.max(...xs)) / 2;
    return { v: 1, subs: [{ closed: false, nodes: [{ x, y: Math.min(...ys) }, { x, y: Math.max(...ys) }] }], info: [] };
  },
  nest: ({ parts }) => parts.map(() => [0, 0]),
};
await esbuild({ stdin: { contents: "export * from './box'; export * from './geom';", resolveDir: src, loader: 'ts' }, bundle: true, format: 'esm', platform: 'node', outfile: join(dir, 'm.mjs'), logLevel: 'error' });
const { build, ring, pointAt, trace, closedRing, slot, stripMap, offsetPolygon, pieceOutline, dovetail } = await import(pathToFileURL(join(dir, 'm.mjs')).href);
rmSync(dir, { recursive: true, force: true });

const DEF = {
  width: 160, depth: 110, height: 60, radius: 35, thickness: 3, clearance: 0.1, kerf: 0, lid: false, rim: 4,
  hingeKind: 'straight', cutLength: 18, bridge: 3, spacing: 1.5, bendExtra: 0, tabWidth: 10, tabPitch: 40,
};
const box = (p = {}, area = { width: 600, height: 400 }) => build({ ...DEF, ...p }, area);
const codes = (b) => b.issues.map((i) => i.code).sort();
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
function samples(s, n = 8) {
  const out = [];
  const N = s.nodes.length, segs = s.closed ? N : N - 1;
  for (let i = 0; i < segs; i++) {
    const a = s.nodes[i], b = s.nodes[(i + 1) % N];
    const c1 = a.cout ?? a, c2 = b.cin ?? b;
    for (let k = 0; k < n; k++) {
      const t = k / n, m = 1 - t;
      out.push({ x: m * m * m * a.x + 3 * m * m * t * c1.x + 3 * m * t * t * c2.x + t * t * t * b.x, y: m * m * m * a.y + 3 * m * m * t * c1.y + 3 * m * t * t * c2.y + t * t * t * b.y });
    }
  }
  return out;
}
const bbox = (pts) => ({ x0: Math.min(...pts.map((p) => p.x)), x1: Math.max(...pts.map((p) => p.x)), y0: Math.min(...pts.map((p) => p.y)), y1: Math.max(...pts.map((p) => p.y)) });

test('centre line: length of a rounded rectangle, arcs as Bézier curves on it, slots across it', () => {
  const rg = ring(157, 107, 33.5);
  near(rg.length, 2 * (157 + 107) - 8 * 33.5 + 2 * Math.PI * 33.5);
  const out = closedRing(rg, 5);
  assert.equal(out.nodes.length, 8);
  const dist = (p) => Math.hypot(Math.max(Math.abs(p.x) - 45, 0), Math.max(Math.abs(p.y) - 20, 0)) - 38.5;
  // A quarter circle as one Bézier curve is off by less than 0.03 % of its radius
  for (const p of samples(out, 16)) assert.ok(Math.abs(dist(p)) < 3e-4 * 38.5, `${p.x}, ${p.y}: ${dist(p)}`);
  const tr = trace(rg, 10, 150, -2);
  const end = pointAt(rg, 150, -2);
  near(tr[tr.length - 1].x, end[0]);
  near(tr[tr.length - 1].y, end[1]);
  for (const p of samples(slot(rg, 100, 110, 3.1))) {
    const d = Math.hypot(p.x - 45, p.y - 20);
    assert.ok(d > 33.5 - 1.56 && d < 33.5 + 1.56, String(d));
  }
});

test('strip map: bends get the extra length, straight sides keep theirs', () => {
  const rg = ring(100, 60, 20);
  const m1 = stripMap(rg, 1.5);
  near(stripMap(rg, 0).length, rg.length);
  near(m1.length, rg.length + 6);
  for (const s of [0, 17, 60, 123.4, rg.length - 1]) near(m1.s(m1.x(s)), s);
  assert.equal(m1.bends.length, 4);
  assert.equal(m1.straights.length, 4);
});

test('default box: floor and one strip as long as the centre line, a slot per tab, vertical hinge areas', () => {
  hingeCalls.length = 0;
  const b = box();
  assert.deepEqual(codes(b), []);
  assert.deepEqual(b.parts.map((p) => p.key), ['floor', 'wall']);
  near(b.stripLength, 2 * (157 + 107) - 8 * 33.5 + 2 * Math.PI * 33.5);
  const floor = b.parts[0].subs;
  const fb = bbox(samples(floor[0], 16));
  near(fb.x1 - fb.x0, 168, 1e-3);
  near(fb.y1 - fb.y0, 118, 1e-3);
  const wall = b.parts[1].subs;
  const below = wall[0].nodes.filter((n) => n.y > 30 + 1e-6);
  assert.equal(floor.length - 1, below.length / 2, 'one slot per tab');
  assert.equal(hingeCalls.length, 4, 'one living hinge area per corner');
  for (const c of hingeCalls) assert.deepEqual([c.orient, c.margin, c.kind], ['vertical', 0, 'straight']);
});

test('slots sit where the tabs reach the floor', () => {
  const b = box({ tabPitch: 25 });
  const rg = ring(157, 107, 33.5);
  const m = stripMap(rg, 0);
  const low = b.parts[1].subs[0].nodes.filter((n) => n.y > 30 + 1e-6);
  const straight = m.straights.reduce((a, q) => (q[1] - q[0] > a[1] - a[0] ? q : a));
  const seam = (straight[0] + straight[1]) / 2;
  const slots = b.parts[0].subs.slice(1);
  for (let i = 0; i < low.length; i += 2) {
    const x = (low[i].x + low[i + 1].x) / 2;
    const p = pointAt(rg, m.s(seam + x + b.stripLength / 2));
    assert.ok(slots.some((s) => {
      const bb = bbox(samples(s));
      return p[0] > bb.x0 - 1e-6 && p[0] < bb.x1 + 1e-6 && p[1] > bb.y0 - 1e-6 && p[1] < bb.y1 + 1e-6;
    }), `tab at ${x}`);
  }
});

test('dovetails fit their sockets with the play; kerf moves the outline out', () => {
  const dv = dovetail(3);
  const o = pieceOutline({ x0: 0, x1: 300, h: 60, t: 3, tabs: [50], tabWidth: 10, top: false, tails: [30], clearance: 0.2, kerf: 0 });
  const head = o.filter(([x]) => Math.abs(x - 300 - dv.depth) < 1e-9).map(([, y]) => y);
  near(Math.max(...head) - Math.min(...head), dv.head);
  const sock = o.filter(([x]) => Math.abs(x - dv.depth - 0.1) < 1e-9).map(([, y]) => y);
  near(Math.max(...sock) - Math.min(...sock), dv.head + 0.2);
  const k = offsetPolygon([[0, 0], [10, 0], [10, 5], [0, 5]], 0.1);
  assert.deepEqual(k.map((p) => p.map((v) => Math.round(v * 1e9) / 1e9)), [[-0.1, -0.1], [10.1, -0.1], [10.1, 5.1], [-0.1, 5.1]]);
});

test('lid, round box, work area and problems', () => {
  const lid = box({ lid: true });
  assert.deepEqual(lid.parts.map((p) => p.key), ['floor', 'lid', 'wall']);
  assert.deepEqual(lid.parts[1].subs, lid.parts[0].subs);
  assert.deepEqual(codes(box({ width: 120, depth: 120, radius: 60 })), ['seam-in-bend']);
  const long = box({ width: 500, depth: 300, radius: 50, height: 80 }, { width: 400, height: 300 });
  assert.deepEqual(codes(long), []);
  assert.ok(long.pieces.length >= 4);
  for (const [a, z] of long.pieces) assert.ok(z - a <= 400 - dovetail(3).depth - 4 + 1e-6);
  assert.equal(box({ width: 500, depth: 300, radius: 50 }, null).pieces.length, 1);
  assert.deepEqual(codes(box({ radius: 3 })), ['radius-small']);
  assert.deepEqual(codes(box({ radius: 60 })), ['radius-large']);
  assert.deepEqual(codes(box({ height: 12 })), ['height-small']);
  assert.deepEqual(codes(box({ thickness: 1, kerf: 1, clearance: -1 })), ['kerf-large']);
  assert.deepEqual(codes(box({ radius: 12 })), ['radius-tight']);
  near(box({ bendExtra: 1 }).stripLength - box().stripLength, 4);
});
