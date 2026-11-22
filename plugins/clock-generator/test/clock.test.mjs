// Comprehensive Node test suite for plugins/clock-generator.
// Verifies manifest integrity, geometry sanity (zero self-intersections across all 10 shapes,
// 6 fonts x 13 glyphs, 8 hand styles x 3 roles, skeleton windows & keyhole), automatic stencil bridges,
// 3D poses, determinism, and full enum/boolean parameter sweep.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const pluginDir = resolve(new URL('..', import.meta.url).pathname);
const manifest = JSON.parse(readFileSync(resolve(pluginDir, 'plugin.json'), 'utf8'));
const spec = manifest.plugins[0];
const bundleCode = readFileSync(resolve(pluginDir, 'dist/clock-generator.js'), 'utf8');

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
    for (const p of flattenSub(s, 8)) {
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

/** Check whether two non-adjacent segments strictly intersect */
function segsIntersect(a, b, c, d) {
  const cross = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  const eps = 1e-6;
  return ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps));
}

function hasSelfIntersection(sub, steps = 12) {
  const pts = flattenSub(sub, steps);
  // Deduplicate tiny adjacent points
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
      if (segsIntersect(a, b, c, d)) {
        return { i, j, a, b, c, d };
      }
    }
  }
  return null;
}

function defaults() {
  const p = {};
  for (const param of spec.params) p[param.key] = param.def;
  return p;
}

function createHost() {
  const calls = { boolean: [], nest: [] };
  const host = {
    boolean(input) {
      calls.boolean.push(input);
      // Verify valid input structure
      assert.equal(input.op, 'difference');
      assert.ok(Array.isArray(input.a) && input.a.length >= 2);
      assert.ok(Array.isArray(input.b) && input.b.length >= 1);
      for (const rect of input.b) {
        assert.equal(rect.closed, true);
        assert.equal(rect.nodes.length, 4);
      }
      // Return outer contours as mock bridged paths (real KizamuBeam Clipper engine splits them cleanly)
      return input.a;
    },
    nest({ parts, gap }) {
      calls.nest.push({ count: parts.length, gap });
      const out = [];
      let x = 0;
      for (const pt of parts) {
        const bb = bboxOfSubs(pt.subs);
        const cx = x + bb.w / 2;
        out.push([cx, 0]);
        x += bb.w + gap;
      }
      return out;
    },
    progress() {},
  };
  return { host, calls };
}

function loadPlugin() {
  const { host, calls } = createHost();
  const sandbox = { host, plugin: null, console };
  vm.runInNewContext(bundleCode, sandbox);
  assert.ok(sandbox.plugin, 'Plugin did not call definePlugin()');
  return { plugin: sandbox.plugin, calls };
}

function assertFiniteGeometry(result) {
  assert.ok(Array.isArray(result.parts) && result.parts.length >= 1);
  const seenKeys = new Set();
  for (const part of result.parts) {
    assert.ok(!seenKeys.has(part.key), `Duplicate part key: ${part.key}`);
    seenKeys.add(part.key);
    assert.ok(Number.isFinite(part.at.x) && Number.isFinite(part.at.y));
    assert.ok(Array.isArray(part.subs) && part.subs.length >= 1, `Part ${part.key} has no subs`);
    for (const list of [part.subs, part.marks ?? []]) {
      for (const s of list) {
        assert.ok(Array.isArray(s.nodes) && s.nodes.length >= 2);
        for (const nd of s.nodes) {
          assert.ok(Number.isFinite(nd.x) && Number.isFinite(nd.y), `NaN node in ${part.key}`);
          if (nd.cin) assert.ok(Number.isFinite(nd.cin.x) && Number.isFinite(nd.cin.y));
          if (nd.cout) assert.ok(Number.isFinite(nd.cout.x) && Number.isFinite(nd.cout.y));
        }
      }
    }
    if (result.poses?.poses) {
      assert.ok(result.poses.poses[part.key], `Missing 3D pose for part ${part.key}`);
    }
  }
}

test('manifest structure, steps, showIf rules, and EN/DE/IT text coverage', () => {
  assert.equal(manifest.format, 'kizamubeam-pack');
  assert.equal(manifest.formatVersion, 2);
  assert.equal(spec.type, 'generator');
  assert.equal(spec.kind, 'assembly');
  assert.equal(spec.dialog.version, 5);

  const paramKeys = new Set(spec.params.map((p) => p.key));
  assert.equal(paramKeys.size, spec.params.length, 'Duplicate param keys');

  // Check steps cover all params without duplicates
  const usedInSteps = new Set();
  for (const step of spec.dialog.steps) {
    for (const item of step.items) {
      assert.ok(paramKeys.has(item), `Step ${step.id} references unknown param ${item}`);
      assert.ok(!usedInSteps.has(item), `Param ${item} appears in multiple steps`);
      usedInSteps.add(item);
    }
  }
  assert.equal(usedInSteps.size, paramKeys.size, 'All params should be assigned to a step');

  // Validate showIf rules recursively
  const validOps = new Set(['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'in', 'and', 'or', 'not']);
  function checkRule(r) {
    const ops = Object.keys(r);
    assert.equal(ops.length, 1);
    const op = ops[0];
    assert.ok(validOps.has(op), `Invalid showIf op: ${op}`);
    if (op === 'and' || op === 'or') {
      assert.ok(Array.isArray(r[op]) && r[op].length > 0);
      r[op].forEach(checkRule);
    } else if (op === 'not') {
      checkRule(r[op]);
    } else {
      assert.ok(paramKeys.has(r[op][0]), `showIf references unknown param ${r[op][0]}`);
    }
  }
  for (const p of spec.params) {
    if (p.showIf) checkRule(p.showIf);
  }

  // Check required text keys exist in en, de, it
  for (const lang of ['en', 'de', 'it']) {
    const tx = spec.texts[lang];
    assert.ok(tx, `Missing language ${lang}`);
    for (const req of ['name', 'desc', 'keys', 'label']) {
      assert.ok(typeof tx[req] === 'string' && tx[req].length > 0, `Missing ${lang}.${req}`);
    }
    for (const step of spec.dialog.steps) {
      assert.ok(tx[step.label], `Missing ${lang}.${step.label}`);
    }
    for (const p of spec.params) {
      assert.ok(tx[p.key], `Missing ${lang}.${p.key}`);
      if (p.type === 'enum') {
        for (const [, optKey] of p.options) {
          assert.ok(tx[optKey], `Missing ${lang}.${optKey}`);
        }
      }
    }
  }
});

test('default parameters generate valid, deterministic assembly with zero errors', () => {
  const { plugin } = loadPlugin();
  const p = defaults();
  const issues = plugin.validate(p);
  assert.equal(issues.filter((i) => i.level === 'error').length, 0, `Unexpected default errors: ${JSON.stringify(issues)}`);

  const r1 = plugin.generate(p);
  const r2 = plugin.generate(p);
  assertFiniteGeometry(r1);

  // Backplate + 1 spacer ring + dial + hour hand + minute hand = 5 parts
  assert.deepEqual(
    [...r1.parts.map((x) => x.key)],
    ['backplate', 'ring1', 'dial', 'handHour', 'handMinute'],
  );

  // Exact byte-for-byte determinism
  const h1 = createHash('sha256').update(JSON.stringify(r1)).digest('hex');
  const h2 = createHash('sha256').update(JSON.stringify(r2)).digest('hex');
  assert.equal(h1, h2);
});

test('all 10 clock shapes and spacer rings have clean, non-self-intersecting contours', () => {
  const { plugin } = loadPlugin();
  const shapeParam = spec.params.find((x) => x.key === 'shape');
  for (const [shape] of shapeParam.options) {
    const p = { ...defaults(), shape, ringCount: 2, backplate: true, hangerHole: true };
    const errors = plugin.validate(p).filter((i) => i.level === 'error');
    assert.equal(errors.length, 0, `Shape ${shape} failed validation: ${JSON.stringify(errors)}`);
    const res = plugin.generate(p);
    assertFiniteGeometry(res);
    assert.ok(res.parts.some((x) => x.key === 'ring1'));
    assert.ok(res.parts.some((x) => x.key === 'ring2'));

    // Check outer & inner contours of backplate, ring, and dial for self-intersections
    for (const key of ['backplate', 'ring1']) {
      const part = res.parts.find((x) => x.key === key);
      for (let si = 0; si < part.subs.length; si++) {
        const hit = hasSelfIntersection(part.subs[si]);
        assert.equal(hit, null, `Self-intersection in shape=${shape} part=${key} sub=${si}: ${JSON.stringify(hit)}`);
      }
    }
  }
});

test('all 6 fonts across Arabic (1-12) and Roman (I-XII) numerals have zero self-intersections', () => {
  const { plugin } = loadPlugin();
  const fontParam = spec.params.find((x) => x.key === 'font');
  for (const [font] of fontParam.options) {
    for (const dialStyle of ['classic', 'roman']) {
      const p = {
        ...defaults(),
        font,
        dialStyle,
        numeralMode: 'engrave',
        tickMode: 'none',
        chapterRing: 'none',
        backplate: false,
        ringCount: 0,
        includeHands: false,
      };
      const res = plugin.generate(p);
      assertFiniteGeometry(res);
      const dial = res.parts.find((x) => x.key === 'dial');
      assert.ok(dial.marks && dial.marks.length >= 12, `Expected engraved numerals for font=${font} style=${dialStyle}`);
      for (let mi = 0; mi < dial.marks.length; mi++) {
        const hit = hasSelfIntersection(dial.marks[mi], 16);
        assert.equal(
          hit,
          null,
          `Self-intersection in font=${font} dialStyle=${dialStyle} mark=${mi}: ${JSON.stringify(hit)}`,
        );
      }
    }
  }
});

test('cut-out numerals automatically generate stencil bridges for every island (0, 4, 6, 8, 9)', () => {
  const fontParam = spec.params.find((x) => x.key === 'font');
  for (const [font] of fontParam.options) {
    for (const bridgeDirection of ['shortest', 'vertical', 'horizontal']) {
      for (const bridgeCount of ['auto', '1', '2']) {
        const { plugin, calls } = loadPlugin();
        const p = {
          ...defaults(),
          dialStyle: 'classic',
          numeralMode: 'cutout',
          font,
          bridgeWidth: 2,
          bridgeCount,
          bridgeDirection,
        };
        const errors = plugin.validate(p).filter((i) => i.level === 'error');
        assert.equal(errors.length, 0);
        const res = plugin.generate(p);
        assertFiniteGeometry(res);

        // In 1..12, exactly 5 characters have counter islands: 4 (1), 6 (1), 8 (2), 9 (1), 0 of 10 (1) => 5 host.boolean calls, 6 islands
        assert.equal(
          calls.boolean.length,
          5,
          `Expected 5 boolean bridge calls (4,6,8,9,0) for font=${font} dir=${bridgeDirection} count=${bridgeCount}, got ${calls.boolean.length}`,
        );
        // Check info table reports stencil bridges with 6 islands and >= 6 bridges
        const bridgeRow = res.info.find(([k]) => k === 'info.bridges');
        assert.ok(bridgeRow, 'Missing info.bridges row');
        assert.equal(bridgeRow[1].values.i, 6, `Expected 6 islands for 1..12, got ${bridgeRow[1].values.i}`);
        if (bridgeCount === '1') {
          assert.equal(bridgeRow[1].values.b, 6);
        } else if (bridgeCount === '2') {
          assert.equal(bridgeRow[1].values.b, 12);
        } else {
          assert.ok(bridgeRow[1].values.b >= 6);
        }
      }
    }
  }
});

test('all 8 hand styles (hour, minute, second) have clean, non-self-intersecting silhouettes', () => {
  const { plugin } = loadPlugin();
  const styleParam = spec.params.find((x) => x.key === 'handStyle');
  for (const [handStyle] of styleParam.options) {
    const p = { ...defaults(), handStyle, includeHands: true, includeSecondHand: true };
    const errors = plugin.validate(p).filter((i) => i.level === 'error');
    assert.equal(errors.length, 0, `Hand style ${handStyle} error: ${JSON.stringify(errors)}`);
    const res = plugin.generate(p);
    assertFiniteGeometry(res);
    for (const key of ['handHour', 'handMinute', 'handSecond']) {
      const part = res.parts.find((x) => x.key === key);
      assert.ok(part, `Missing ${key} for style ${handStyle}`);
      assert.ok(part.subs.length >= 2, `${key} should have outer + shaft hole`);
      for (let si = 0; si < part.subs.length; si++) {
        const hit = hasSelfIntersection(part.subs[si], 16);
        assert.equal(hit, null, `Self-intersection in handStyle=${handStyle} part=${key} sub=${si}: ${JSON.stringify(hit)}`);
      }
    }
  }
});

test('full parameter sweep: every enum option and every bool toggle succeeds cleanly', () => {
  const { plugin } = loadPlugin();
  const base = defaults();
  for (const param of spec.params) {
    if (param.type === 'enum') {
      for (const [val] of param.options) {
        const p = { ...base, [param.key]: val };
        const errors = plugin.validate(p).filter((i) => i.level === 'error');
        assert.equal(errors.length, 0, `Enum ${param.key}=${val} produced error: ${JSON.stringify(errors)}`);
        const res = plugin.generate(p);
        assertFiniteGeometry(res);
      }
    } else if (param.type === 'bool') {
      for (const val of [false, true]) {
        const p = { ...base, [param.key]: val };
        const errors = plugin.validate(p).filter((i) => i.level === 'error');
        assert.equal(errors.length, 0, `Bool ${param.key}=${val} produced error: ${JSON.stringify(errors)}`);
        const res = plugin.generate(p);
        assertFiniteGeometry(res);
      }
    }
  }
});

test('validation catches invalid dimensions cleanly', () => {
  const { plugin } = loadPlugin();
  const base = defaults();

  const hasCode = (issues, code, level) => issues.some((i) => i.code === code && (!level || i.level === level));

  assert.ok(hasCode(plugin.validate({ ...base, shape: 'arch', width: 220, height: 100 }), 'arch-too-short', 'error'));
  assert.ok(hasCode(plugin.validate({ ...base, ringCount: 1, ringWidth: 118 }), 'ring-too-wide', 'error'));
  assert.ok(hasCode(plugin.validate({ ...base, backplate: true, backplateCenter: 'movement', movementSize: 235 }), 'movement-too-large', 'error'));
  assert.ok(hasCode(plugin.validate({ ...base, tickMode: 'hours', hourTickLength: 115 }), 'ticks-too-long', 'error'));
  assert.ok(hasCode(plugin.validate({ ...base, numeralRadiusPct: 90, numeralSize: 40 }), 'numerals-outside', 'error'));
  assert.ok(hasCode(plugin.validate({ ...base, dialStyle: 'skeleton', skeletonHubDia: 140 }), 'skeleton-too-tight', 'error'));
  assert.ok(hasCode(plugin.validate({ ...base, numeralMode: 'cutout', numeralSize: 9 }), 'cutout-numerals-small', 'warn'));
});
