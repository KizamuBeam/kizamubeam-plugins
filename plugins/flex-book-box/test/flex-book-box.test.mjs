// Comprehensive Node test suite for plugins/flex-book-box.
// Verifies manifest integrity, all 6 KizamuBeam Living Hinge patterns, suggestHinge action,
// Finger Joint Box with Dividers expressions/resizing/cross-laps, floor/frame modes,
// kerf & clearance compensation, page-edge score mark slot clipping, 3D pose alignment,
// zero self-intersections, and determinism.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const pluginDir = resolve(new URL('..', import.meta.url).pathname);
const manifest = JSON.parse(readFileSync(resolve(pluginDir, 'plugin.json'), 'utf8'));
const spec = manifest.plugins[0];
const bundleCode = readFileSync(resolve(pluginDir, 'dist/plugin.js'), 'utf8');

function defaultParams() {
  const p = {};
  for (const param of spec.params) p[param.key] = param.def;
  return p;
}

function flattenSub(s, steps = 12) {
  const out = [];
  const n = s.nodes.length;
  for (let i = 0; i < n; i++) {
    const a = s.nodes[i];
    const b = s.nodes[(i + 1) % n];
    out.push({ x: a.x, y: a.y });
    if (i === n - 1 && !s.closed) break;
    if (!a.cout && !b.cin) continue;
    const c1 = a.cout ?? a;
    const c2 = b.cin ?? b;
    for (let k = 1; k < steps; k++) {
      const t = k / steps;
      const u = 1 - t;
      out.push({
        x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
        y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
      });
    }
  }
  return out;
}

function bboxOfSubs(subs) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const s of subs) {
    for (const p of flattenSub(s, 10)) {
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

function segsIntersect(a, b, c, d) {
  const cross = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  const eps = 1e-6;
  return ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps));
}

function hasSelfIntersection(sub) {
  const pts = flattenSub(sub, 12);
  const clean = [];
  for (const p of pts) {
    if (!clean.length || Math.hypot(p.x - clean[clean.length - 1].x, p.y - clean[clean.length - 1].y) > 1e-4) {
      clean.push(p);
    }
  }
  if (clean.length > 1 && Math.hypot(clean[0].x - clean[clean.length - 1].x, clean[0].y - clean[clean.length - 1].y) < 1e-4) {
    clean.pop();
  }
  const n = clean.length;
  for (let i = 0; i < n; i++) {
    const a = clean[i];
    const b = clean[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = clean[j];
      const d = clean[(j + 1) % n];
      if (segsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}

/** Simple orthogonal miter outward offset for rectilinear polygons (used in mock host.offset) */
function orthoOffset(sub, delta) {
  const pts = sub.nodes;
  const n = pts.length;
  // Determine signed area (y down: CW has positive area, CCW has negative area)
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    area += a.x * b.y - b.x * a.y;
  }
  const sign = area >= 0 ? 1 : -1;
  const out = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const cur = pts[i];
    const next = pts[(i + 1) % n];
    const d1x = cur.x - prev.x;
    const d1y = cur.y - prev.y;
    const l1 = Math.hypot(d1x, d1y) || 1;
    const d2x = next.x - cur.x;
    const d2y = next.y - cur.y;
    const l2 = Math.hypot(d2x, d2y) || 1;
    // Outward normal for each edge
    const n1x = (sign * d1y) / l1;
    const n1y = (-sign * d1x) / l1;
    const n2x = (sign * d2y) / l2;
    const n2y = (-sign * d2x) / l2;
    out.push({ x: cur.x + delta * (n1x + n2x), y: cur.y + delta * (n1y + n2y) });
  }
  return { closed: true, nodes: out };
}

/** Load the bundled plugin inside a QuickJS-like sandbox with realistic host mocks */
function loadPlugin(ctxOverrides = {}) {
  const material = ctxOverrides.material !== undefined ? ctxOverrides.material : { name: 'Birch 3mm', thickness: 3, kerf: 0.15, pairPlay: 0.05, pairPlayTotal: 0.1, slotPlay: 0.1 };
  const workArea = ctxOverrides.workArea !== undefined ? ctxOverrides.workArea : { width: 600, height: 400 };

  const host = {
    context(what) {
      if (what === 'material') return material;
      if (what === 'workArea') return workArea;
      throw new Error(`host-bad-input: ${what}`);
    },
    joints(input) {
      assert.equal(input.op, 'panel');
      assert.equal(input.v, 2);
      const { width: a, height: b, kerf = 0 } = input;
      const hw = (a + kerf) / 2;
      const hh = (b + kerf) / 2;
      return {
        v: 2,
        outline: {
          closed: true,
          nodes: [
            { x: -hw, y: -hh },
            { x: hw, y: -hh },
            { x: hw, y: hh },
            { x: -hw, y: hh },
          ],
        },
      };
    },
    offset({ subs, delta }) {
      return subs.map((s) => orthoOffset(s, delta));
    },
    nest({ parts, gap }) {
      let x = 0;
      return parts.map((p) => {
        const bb = bboxOfSubs(p.subs);
        const cx = x - bb.x0;
        x += bb.w + gap;
        return [cx, -bb.y0];
      });
    },
    check({ parts }) {
      const findings = [];
      for (const p of parts) {
        for (const s of p.subs) {
          if (!s.closed) findings.push({ code: 'check-open', level: 'error', parts: [p.key] });
        }
      }
      return findings;
    },
    progress() {},
  };

  const sandbox = { host, Math, Number, String, Boolean, Array, Object, JSON, Map, Set, Error, RegExp, parseFloat, parseInt, isFinite, isNaN, structuredClone };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(bundleCode, sandbox);
  const raw = sandbox.plugin;
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  return {
    validate: (p) => clone(raw.validate(p)),
    generate: (p) => clone(raw.generate(p)),
    view: (p) => clone(raw.view(p)),
    onChange: (i) => clone(raw.onChange(i)),
    onEvent: (i) => clone(raw.onEvent(i)),
  };
}

const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]].map((v) => (Object.is(v, -0) ? 0 : v));
const toWorld3 = (pose, x, y, s = 0) => [
  pose.o[0] + x * pose.u[0] + y * pose.v[0] + s * pose.n[0],
  pose.o[1] + x * pose.u[1] + y * pose.v[1] + s * pose.n[1],
  pose.o[2] + x * pose.u[2] + y * pose.v[2] + s * pose.n[2],
];

// ---------------------------------------------------------------------------
// 1. Manifest integrity
// ---------------------------------------------------------------------------
test('manifest schema, steps, showIf rules, and 5-language texts are complete and valid', () => {
  assert.equal(manifest.format, 'kizamubeam-pack');
  assert.equal(manifest.formatVersion, 2);
  assert.equal(spec.id, 'org.kizamubeam.flex-book-box');
  assert.equal(spec.type, 'generator');
  assert.equal(spec.kind, 'assembly');
  assert.equal(spec.assemblyCheck, true);
  assert.deepEqual(spec.fit, { kind: 'pair', play: 'clearance', total: true });
  assert.ok(!spec.host.includes('context'), 'context must not be listed in host[]');
  assert.deepEqual(spec.context, ['material', 'workArea']);

  const paramKeys = new Set(spec.params.map((p) => p.key));
  const actionIds = new Set((spec.dialog.actions ?? []).map((a) => a.id));
  assert.ok(paramKeys.has(spec.fit.play));

  // Every non-data param and action must appear in steps exactly once
  const stepItems = [];
  for (const step of spec.dialog.steps) {
    assert.ok(spec.texts.en[step.label], `missing step label ${step.label}`);
    for (const item of step.items) {
      assert.ok(paramKeys.has(item) || actionIds.has(item), `unknown step item ${item}`);
      assert.ok(!stepItems.includes(item), `duplicate step item ${item}`);
      stepItems.push(item);
    }
  }
  for (const p of spec.params) {
    if (p.type !== 'data') assert.ok(stepItems.includes(p.key), `param ${p.key} missing from dialog.steps`);
  }
  for (const a of spec.dialog.actions ?? []) {
    assert.ok(stepItems.includes(a.id), `action ${a.id} missing from dialog.steps`);
  }

  // Every language must define the exact same text keys as English
  const enKeys = Object.keys(spec.texts.en).sort();
  for (const lang of ['de', 'es', 'it', 'pt-BR']) {
    assert.ok(spec.texts[lang], `missing language ${lang}`);
    const langKeys = Object.keys(spec.texts[lang]).sort();
    assert.deepEqual(langKeys, enKeys, `text keys mismatch for language ${lang}`);
  }
});

// ---------------------------------------------------------------------------
// 2. Default generation & Living Hinge patterns (all 6 KizamuBeam patterns)
// ---------------------------------------------------------------------------
test('all 6 KizamuBeam living hinge patterns generate valid cuts inside the spine bend zone', () => {
  const plugin = loadPlugin();
  const base = defaultParams();
  const spineLen = Math.PI * ((base.pageThickness + base.thickness) / 2);
  const kinds = ['straight', 'wave', 'diamond', 'honeycomb', 'triangle', 'cross'];

  for (const kind of kinds) {
    const p = { ...base, hingeKind: kind };
    const issues = plugin.validate(p);
    assert.deepEqual(
      issues.filter((i) => i.level === 'error'),
      [],
      `unexpected validation error for hingeKind=${kind}: ${JSON.stringify(issues)}`,
    );

    const res = plugin.generate(p);
    const cover = res.parts.find((x) => x.key === 'cover');
    assert.ok(cover, `cover missing for ${kind}`);
    assert.equal(cover.subs[0].closed, true, 'cover outer outline must be closed');
    const hingeSubs = cover.subs.slice(1);
    assert.ok(hingeSubs.length >= 10, `expected hinge cuts for ${kind}, got ${hingeSubs.length}`);

    const xMin = -spineLen / 2 + p.hingeMargin - 1e-4;
    const xMax = spineLen / 2 - p.hingeMargin + 1e-4;
    const yMin = -p.coverHeight / 2 + p.hingeMargin - 1e-4;
    const yMax = p.coverHeight / 2 - p.hingeMargin + 1e-4;

    for (const s of hingeSubs) {
      assert.equal(s.closed, false, `hinge cut must be open (${kind})`);
      assert.ok(s.nodes.length >= 2);
      for (const pt of flattenSub(s, 10)) {
        assert.ok(pt.x >= xMin && pt.x <= xMax, `${kind}: cut x=${pt.x} outside [${xMin}, ${xMax}]`);
        assert.ok(pt.y >= yMin && pt.y <= yMax, `${kind}: cut y=${pt.y} outside [${yMin}, ${yMax}]`);
      }
    }

    if (kind === 'wave') {
      // Wave cuts must use cubic Bézier handles (Hermite pieces per eighth-wave)
      assert.ok(hingeSubs.some((s) => s.nodes.some((n) => n.cout || n.cin)), 'wave hinge must generate Bézier curves');
    }
  }
});

test('suggestHinge action matches KizamuBeam suggestHinge(thickness) formula', () => {
  const plugin = loadPlugin();
  const base = defaultParams();
  for (const thickness of [2, 3, 4, 5]) {
    const ev = plugin.onEvent({ action: 'suggestHinge', params: { ...base, thickness }, inputs: {} });
    assert.ok(ev && ev.patch);
    const r = (v) => Math.round(v * 10) / 10;
    assert.equal(ev.patch.hingeBridge, r(Math.max(2, thickness)));
    assert.equal(ev.patch.hingeSpacing, r(Math.max(1, thickness / 2)));
    assert.equal(ev.patch.hingeCutLength, r(Math.max(15, 6 * thickness)));
    assert.equal(ev.patch.hingeMargin, r(Math.max(2, thickness)));
    assert.equal(ev.patch.hingeWaveAmp, r(Math.max(0.5, thickness / 3)));
    assert.equal(ev.patch.hingeWaveLength, r(Math.max(5, 2.5 * thickness)));
  }
});

// ---------------------------------------------------------------------------
// 3. Finger Joint Box with Dividers capabilities
// ---------------------------------------------------------------------------
test('dividers support ratio & mm expressions, cross-laps, dividerDrop, and floor/frame modes', () => {
  const plugin = loadPlugin();
  const p = {
    ...defaultParams(),
    coverWidth: 160,
    coverHeight: 230,
    pageThickness: 48,
    square: 5,
    compartmentsX: 3,
    ratiosX: '35mm:1:2',
    compartmentsY: 3,
    ratiosY: '(20mm+20mm):1:1.5',
    dividerDrop: 6,
    pageBlockFloor: true,
    kerf: 0.2,
    clearance: 0.1,
  };

  const issues = plugin.validate(p);
  assert.deepEqual(issues.filter((i) => i.level === 'error'), [], `unexpected errors: ${JSON.stringify(issues)}`);
  const res = plugin.generate(p);

  // Expected parts: cover, bottom, tail, head, fore, spine, divx-1, divx-2, divy-1, divy-2 = 10 parts
  assert.equal(res.parts.length, 10);
  const keys = res.parts.map((x) => x.key);
  for (const expected of ['cover', 'bottom', 'tail', 'head', 'fore', 'spine', 'divx-1', 'divx-2', 'divy-1', 'divy-2']) {
    assert.ok(keys.includes(expected), `missing part ${expected}`);
    assert.ok(res.poses.poses[expected], `missing 3D pose for ${expected}`);
    assert.ok(res.labels[expected], `missing label for ${expected}`);
  }

  // Every closed outline and slot must be free of self-intersections
  for (const part of res.parts) {
    for (const s of part.subs) {
      if (s.closed) assert.equal(hasSelfIntersection(s), false, `self-intersection in part ${part.key}`);
    }
  }

  // Frame-only mode (pageBlockFloor = false): no bottom plate, warning emitted, dividers have flat bottom
  const pNoFloor = { ...p, pageBlockFloor: false };
  const issuesNoFloor = plugin.validate(pNoFloor);
  assert.deepEqual(issuesNoFloor.filter((i) => i.level === 'error'), []);
  assert.ok(issuesNoFloor.some((i) => i.level === 'warn' && i.code === 'dividers-no-floor'));
  const resNoFloor = plugin.generate(pNoFloor);
  assert.equal(resNoFloor.parts.length, 9);
  assert.ok(!resNoFloor.parts.some((x) => x.key === 'bottom'));
});

test('view() autoText and onChange() smart ratio resizing & fromMaterial work identically to fingerbox', () => {
  const plugin = loadPlugin();
  const base = defaultParams();

  const v = plugin.view({ ...base, compartmentsX: 3, compartmentsY: 4 });
  assert.equal(v.autoText.ratiosX, '1:1:1');
  assert.equal(v.autoText.ratiosY, '1:1:1:1');

  // Increasing compartments extends with :1 without asking
  const grow = plugin.onChange({ key: 'compartmentsX', old: 2, params: { ...base, compartmentsX: 4, ratiosX: '40mm:2' } });
  assert.deepEqual(grow, { patch: { ratiosX: '40mm:2:1:1' } });

  // Decreasing compartments removing custom value asks confirmation
  const shrinkAsk = plugin.onChange({ key: 'compartmentsX', old: 3, params: { ...base, compartmentsX: 2, ratiosX: '40mm:2:3' } });
  assert.ok(shrinkAsk.ask);
  assert.equal(shrinkAsk.ask.question.code, 'ask.drop-ratios');
  assert.equal(shrinkAsk.ask.options[0].patch.ratiosX, '40mm:2');

  // Decreasing compartments removing only '1' patches silently
  const shrinkSilent = plugin.onChange({ key: 'compartmentsX', old: 3, params: { ...base, compartmentsX: 2, ratiosX: '40mm:2:1' } });
  assert.deepEqual(shrinkSilent, { patch: { ratiosX: '40mm:2' } });

  // fromMaterial copies thickness, kerf, and pairPlayTotal from host.context('material')
  const matPatch = plugin.onChange({ key: 'fromMaterial', old: false, params: { ...base, fromMaterial: true } });
  assert.deepEqual(matPatch, { patch: { thickness: 3, kerf: 0.15, clearance: 0.1 } });
});

// ---------------------------------------------------------------------------
// 4. Exact 3D Pose Alignment & Outer Face Normals (for asymmetric dividers!)
// ---------------------------------------------------------------------------
test('3D poses align asymmetric divider slots across all walls & floor to <1e-6 mm and face marks outward', () => {
  const plugin = loadPlugin();
  const p = {
    ...defaultParams(),
    coverWidth: 160,
    coverHeight: 220,
    pageThickness: 45,
    square: 5,
    compartmentsX: 3,
    ratiosX: '35mm:1:2',
    compartmentsY: 2,
    ratiosY: '50mm:1',
    dividerDrop: 5,
    pageBlockFloor: true,
    kerf: 0,
    clearance: 0,
  };
  const res = plugin.generate(p);
  const poses = res.poses.poses;

  // Verify laser-engraved face normal -(u × v) directions
  const normal = (pose) => cross3(pose.u, pose.v).map((v) => (v === 0 ? 0 : -v));
  assert.deepEqual(normal(poses.cover), [0, 0, 1], 'cover inside face must face +Z (up)');
  assert.deepEqual(normal(poses.bottom), [0, 0, 1], 'bottom inside face must face +Z (up)');
  assert.deepEqual(normal(poses.tail), [0, -1, 0], 'tail engraved outer face must face -Y');
  assert.deepEqual(normal(poses.head), [0, 1, 0], 'head engraved outer face must face +Y');
  assert.deepEqual(normal(poses.fore), [1, 0, 0], 'fore engraved outer face must face +X');
  assert.deepEqual(normal(poses.spine), [-1, 0, 0], 'spine engraved outer face must face -X');

  // Verify every X-divider aligns in world X with its slots on tail, head, and bottom
  const tail = res.parts.find((x) => x.key === 'tail');
  const head = res.parts.find((x) => x.key === 'head');
  const fore = res.parts.find((x) => x.key === 'fore');
  const spine = res.parts.find((x) => x.key === 'spine');
  const bottom = res.parts.find((x) => x.key === 'bottom');

  const slotWorldCentres = (part, pose) =>
    part.subs.slice(1).map((hole) => {
      const bb = bboxOfSubs([hole]);
      return toWorld3(pose, (bb.x0 + bb.x1) / 2, (bb.y0 + bb.y1) / 2, 0);
    });

  const tailSlotsW = slotWorldCentres(tail, poses.tail);
  const headSlotsW = slotWorldCentres(head, poses.head);
  const foreSlotsW = slotWorldCentres(fore, poses.fore);
  const spineSlotsW = slotWorldCentres(spine, poses.spine);
  const bottomSlotsW = slotWorldCentres(bottom, poses.bottom);

  // Every tail slot world X & Z must have a matching head slot at the exact same world X & Z
  assert.equal(tailSlotsW.length, headSlotsW.length);
  for (const ts of tailSlotsW) {
    assert.ok(
      headSlotsW.some((hs) => Math.abs(hs[0] - ts[0]) < 1e-6 && Math.abs(hs[2] - ts[2]) < 1e-6),
      `tail slot at X=${ts[0]}, Z=${ts[2]} has no matching head slot`,
    );
  }
  // Every fore slot world Y & Z must have a matching spine slot at the exact same world Y & Z
  assert.equal(foreSlotsW.length, spineSlotsW.length);
  for (const fs of foreSlotsW) {
    assert.ok(
      spineSlotsW.some((ss) => Math.abs(ss[1] - fs[1]) < 1e-6 && Math.abs(ss[2] - fs[2]) < 1e-6),
      `fore slot at Y=${fs[1]}, Z=${fs[2]} has no matching spine slot`,
    );
  }

  // Every X-divider centre X must match its tail/head/bottom slots
  for (const k of ['divx-1', 'divx-2']) {
    const divX = poses[k].o[0] + p.thickness / 2;
    assert.ok(tailSlotsW.some((s) => Math.abs(s[0] - divX) < 1e-6), `${k} X=${divX} not found in tail slots`);
    assert.ok(bottomSlotsW.some((s) => Math.abs(s[0] - divX) < 1e-6), `${k} X=${divX} not found in bottom slots`);
  }
  // Every Y-divider centre Y must match its fore/spine/bottom slots
  const divY = poses['divy-1'].o[1] + p.thickness / 2;
  assert.ok(foreSlotsW.some((s) => Math.abs(s[1] - divY) < 1e-6), `divy-1 Y=${divY} not found in fore slots`);
  assert.ok(bottomSlotsW.some((s) => Math.abs(s[1] - divY) < 1e-6), `divy-1 Y=${divY} not found in bottom slots`);

  // Page-edge score marks must never intersect any wall slot hole
  for (const wall of [tail, head, fore]) {
    assert.ok(wall.marks && wall.marks.length > 0, `expected page-edge marks on ${wall.key}`);
    const slotBoxes = wall.subs.slice(1).map((h) => bboxOfSubs([h]));
    for (const m of wall.marks) {
      const a = m.nodes[0];
      const b = m.nodes[1];
      const mx0 = Math.min(a.x, b.x);
      const mx1 = Math.max(a.x, b.x);
      const my = a.y;
      for (const sb of slotBoxes) {
        const insideY = my > sb.y0 && my < sb.y1;
        const overlapsX = mx1 > sb.x0 && mx0 < sb.x1;
        assert.equal(insideY && overlapsX, false, `page mark on ${wall.key} crosses divider slot`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 5. Kerf, clearance, validation errors, and determinism
// ---------------------------------------------------------------------------
test('kerf expands outer contours and shrinks internal slots; clearance controls slot width', () => {
  const plugin = loadPlugin();
  const base = { ...defaultParams(), compartmentsX: 2, kerf: 0, clearance: 0 };
  const withKerf = { ...base, kerf: 0.2, clearance: 0.1 };

  const r0 = plugin.generate(base);
  const r1 = plugin.generate(withKerf);

  const c0 = bboxOfSubs([r0.parts.find((x) => x.key === 'cover').subs[0]]);
  const c1 = bboxOfSubs([r1.parts.find((x) => x.key === 'cover').subs[0]]);
  assert.ok(Math.abs((c1.w - c0.w) - 0.2) < 1e-6, 'cover width should grow by +kerf');
  assert.ok(Math.abs((c1.h - c0.h) - 0.2) < 1e-6, 'cover height should grow by +kerf');

  const s0 = bboxOfSubs([r0.parts.find((x) => x.key === 'tail').subs[1]]);
  const s1 = bboxOfSubs([r1.parts.find((x) => x.key === 'tail').subs[1]]);
  // Slot width = thickness + clearance - kerf = 3 + 0.1 - 0.2 = 2.9 (vs 3.0)
  assert.ok(Math.abs(s0.w - 3.0) < 1e-6);
  assert.ok(Math.abs(s1.w - 2.9) < 1e-6);
});

test('validation catches invalid parameters and warnings cleanly', () => {
  const plugin = loadPlugin();
  const base = defaultParams();

  // Bad expression
  assert.ok(plugin.validate({ ...base, compartmentsX: 2, ratiosX: '1:2:3' }).some((i) => i.code === 'ratio-count'));
  assert.ok(plugin.validate({ ...base, compartmentsX: 2, ratiosX: '(1:2' }).some((i) => i.code === 'expr-bracket'));
  assert.ok(plugin.validate({ ...base, compartmentsX: 2, ratiosX: '1/0:1' }).some((i) => i.code === 'expr-div-zero'));
  assert.ok(plugin.validate({ ...base, compartmentsX: 2, ratiosX: '500mm:1' }).some((i) => i.code === 'fixed-no-space'));

  // Hinge margin too large
  assert.ok(plugin.validate({ ...base, hingeMargin: 50 }).some((i) => i.code === 'hinge-margin-large'));

  // Thick material warning
  assert.ok(plugin.validate({ ...base, thickness: 5 }).some((i) => i.level === 'warn' && i.code === 'thickness-bend-warn'));

  // Missing material context when fromMaterial is on
  const noMat = loadPlugin({ material: null });
  assert.ok(noMat.validate({ ...base, fromMaterial: true }).some((i) => i.level === 'error' && i.code === 'material-none'));
});

test('output is 100% deterministic across repeated invocations', () => {
  const plugin = loadPlugin();
  const p = { ...defaultParams(), hingeKind: 'wave', compartmentsX: 2, ratiosX: '50mm:1', compartmentsY: 2, coverCornerRadius: 4, kerf: 0.15 };
  const h1 = createHash('sha256').update(JSON.stringify(plugin.generate(p))).digest('hex');
  const h2 = createHash('sha256').update(JSON.stringify(plugin.generate(p))).digest('hex');
  assert.equal(h1, h2);
});
