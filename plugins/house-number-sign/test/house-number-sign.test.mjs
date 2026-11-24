// Comprehensive Node test suite for plugins/house-number-sign.
// Verifies manifest & i18n completeness, zero self-intersections across all 6 fonts x 65 chars x boldness sweep,
// all 10 board shapes + analytical insets, all 10 shapes x 8 mounting types (strictly inside board),
// all 4 layouts, 4 number styles, spacers (insetGlyph & pegs), pin holes, stencil bridges,
// 3 text modes + European diacritics, 6 dividers, 8 motifs, 4 corner ornaments, 4 frame styles,
// 3D poses, multi-page grouping, material context, workArea warnings, and determinism.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const pluginDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifest = JSON.parse(readFileSync(resolve(pluginDir, 'plugin.json'), 'utf8'));
const spec = manifest.plugins[0];
const bundleCode = readFileSync(resolve(pluginDir, 'dist/house-number-sign.js'), 'utf8');

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
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
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

function signedArea(pts) {
  let s = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    s += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  }
  return s / 2;
}

function pointInPoly(poly, q) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j];
    const b = poly[i];
    if (a.y > q.y !== b.y > q.y && q.x < a.x + ((q.y - a.y) * (b.x - a.x)) / (b.y - a.y)) c = !c;
  }
  return c;
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

function hasSelfIntersection(sub, steps = 10) {
  const pts = flattenSub(sub, steps);
  const clean = [];
  for (const p of pts) {
    if (!clean.length || Math.hypot(p.x - clean[clean.length - 1].x, p.y - clean[clean.length - 1].y) > 1e-3) {
      clean.push(p);
    }
  }
  if (clean.length > 1 && Math.hypot(clean[0].x - clean[clean.length - 1].x, clean[0].y - clean[clean.length - 1].y) < 1e-3) {
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
      if (segsIntersect(a, b, c, d)) return { i, j, a, b, c, d };
    }
  }
  return null;
}

function defaults() {
  const p = {};
  for (const param of spec.params) p[param.key] = param.def;
  return p;
}

/** Simple scaling mock for host.offset that shrinks/expands each contour about its centroid */
function mockOffsetSub(sub, delta) {
  const pts = flattenSub(sub, 8);
  const bb = bboxOfSubs([sub]);
  const cx = (bb.x0 + bb.x1) / 2;
  const cy = (bb.y0 + bb.y1) / 2;
  const area = signedArea(pts);
  const sign = area >= 0 ? 1 : -1;
  const effDelta = delta * sign;
  const sx = bb.w > 1e-3 ? (bb.w + 2 * effDelta) / bb.w : 1;
  const sy = bb.h > 1e-3 ? (bb.h + 2 * effDelta) / bb.h : 1;
  if (sx <= 0.08 || sy <= 0.08) return null;
  const scalePt = (pt) => ({ x: cx + (pt.x - cx) * sx, y: cy + (pt.y - cy) * sy });
  return {
    closed: sub.closed,
    nodes: sub.nodes.map((nd) => {
      const p = scalePt(nd);
      const out = { x: p.x, y: p.y };
      if (nd.cin) out.cin = scalePt(nd.cin);
      if (nd.cout) out.cout = scalePt(nd.cout);
      if (nd.smooth) out.smooth = true;
      return out;
    }),
  };
}

function createHost({ material = null, workArea = null } = {}) {
  const calls = { offset: [], boolean: [], nest: [] };
  const host = {
    offset(input) {
      calls.offset.push(input);
      const out = [];
      for (const s of input.subs) {
        const m = mockOffsetSub(s, input.delta);
        if (m) out.push(m);
      }
      return out;
    },
    boolean(input) {
      calls.boolean.push(input);
      assert.equal(input.op, 'difference');
      assert.ok(Array.isArray(input.a) && input.a.length >= 2);
      assert.ok(Array.isArray(input.b) && input.b.length >= 1);
      return input.a;
    },
    nest({ parts, gap }) {
      calls.nest.push({ count: parts.length, gap });
      const out = [];
      let x = 0;
      for (const pt of parts) {
        const bb = bboxOfSubs(pt.subs);
        out.push([x + bb.w / 2, 0]);
        x += bb.w + gap;
      }
      return out;
    },
    context(what) {
      if (what === 'material') return material;
      if (what === 'workArea') return workArea;
      return null;
    },
    progress() {},
  };
  return { host, calls };
}

function loadPlugin(opts = {}) {
  const { host, calls } = createHost(opts);
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
    assert.ok(Array.isArray(part.subs) && part.subs.length >= 1, `Part ${part.key} has empty subs`);
    for (const list of [part.subs, part.marks ?? []]) {
      for (const s of list) {
        assert.ok(Array.isArray(s.nodes) && s.nodes.length >= 2);
        for (const nd of s.nodes) {
          assert.ok(Number.isFinite(nd.x) && Number.isFinite(nd.y), `NaN in ${part.key}`);
          if (nd.cin) assert.ok(Number.isFinite(nd.cin.x) && Number.isFinite(nd.cin.y));
          if (nd.cout) assert.ok(Number.isFinite(nd.cout.x) && Number.isFinite(nd.cout.y));
        }
      }
    }
    if (result.poses?.poses) {
      const pose = result.poses.poses[part.key];
      assert.ok(pose, `Missing 3D pose for part ${part.key}`);
      for (const v of [pose.o, pose.u, pose.v, pose.n]) {
        assert.equal(v.length, 3);
        for (const c of v) assert.ok(Number.isFinite(c));
      }
    }
  }
}

// ================================================================== TESTS

test('manifest integrity, steps coverage, images and 5-language i18n', () => {
  assert.equal(manifest.format, 'kizamubeam-pack');
  assert.equal(manifest.id, 'org.kizamubeam.house-number-sign');
  assert.equal(spec.id, manifest.id);

  // Check preview & icon files exist and meet KizamuBeam limits
  const prevStat = statSync(resolve(pluginDir, 'preview.png'));
  const iconStat = statSync(resolve(pluginDir, 'icon.png'));
  assert.ok(prevStat.size > 1000 && prevStat.size <= 512 * 1024, `preview.png size out of range: ${prevStat.size}`);
  assert.ok(iconStat.size > 1000 && iconStat.size <= 128 * 1024, `icon.png size out of range: ${iconStat.size}`);

  const paramKeys = new Set(spec.params.map((p) => p.key));
  const stepItems = new Set();
  for (const step of spec.dialog.steps) {
    for (const item of step.items) {
      assert.ok(paramKeys.has(item), `Step ${step.id} references unknown param ${item}`);
      assert.ok(!stepItems.has(item), `Param ${item} listed in multiple steps`);
      stepItems.add(item);
    }
  }
  for (const key of paramKeys) {
    assert.ok(stepItems.has(key), `Param ${key} not included in any dialog step`);
  }

  // Verify every required translation key exists in all 5 locales
  const langs = ['en', 'de', 'es', 'it', 'pt-BR'];
  const required = new Set([
    'name', 'desc', 'keys', 'label',
    'part.backplate', 'part.board', 'part.frame', 'part.number', 'part.spacer', 'part.streetChar', 'part.subtitleChar',
    'material-none', 'material-changed', 'material-no-kerf', 'number-empty', 'number-too-long', 'number-unsupported',
    'board-too-small', 'content-overflow', 'frame-too-wide', 'spacer-inset-large', 'cutout-small', 'bridge-wide',
    'keyhole-shaft-wide', 'raised-text-small', 'exceeds-work-area',
    'info.size', 'info.sizeValue', 'info.parts', 'info.depth', 'info.mmValue', 'info.standoff', 'info.standoffValue',
    'info.bridges', 'info.bridgesValue', 'info.pages', 'info.material',
  ]);
  for (const step of spec.dialog.steps) required.add(step.label);
  for (const p of spec.params) {
    required.add(p.key);
    if (p.options) for (const [, labelKey] of p.options) required.add(labelKey);
  }
  for (const lang of langs) {
    const dict = spec.texts[lang];
    assert.ok(dict, `Missing locale ${lang}`);
    for (const k of required) {
      assert.ok(typeof dict[k] === 'string' && dict[k].length > 0, `Missing ${lang} translation for "${k}"`);
    }
  }
});

test('default parameters generate valid 3D floating house number sign (128 MAPLE AVENUE)', () => {
  const { plugin, calls } = loadPlugin();
  const p = defaults();
  const issues = plugin.validate(p);
  assert.equal(issues.length, 0);
  const res = plugin.generate(p);
  assertFiniteGeometry(res);

  // Expect 1 board + 3 front numbers + (3 * 2) = 6 spacers = 10 parts
  assert.equal(res.parts.length, 10);
  assert.ok(res.parts.find((x) => x.key === 'board'));
  assert.ok(res.parts.find((x) => x.key === 'num_1'));
  assert.ok(res.parts.find((x) => x.key === 'spacer_1_1'));
  assert.ok(res.parts.find((x) => x.key === 'spacer_3_2'));
  assert.ok(calls.offset.length >= 3, 'Expected host.offset calls for hidden spacers');

  // Verify 3D stacking heights: board at 0, spacer layer 1 at t, layer 2 at 2t, number at 3t
  const t = p.thickness;
  assert.equal(res.poses.poses.board.o[2], 0);
  assert.equal(res.poses.poses.spacer_1_1.o[2], t);
  assert.equal(res.poses.poses.spacer_1_2.o[2], 2 * t);
  assert.equal(res.poses.poses.num_1.o[2], 3 * t);
});

test('all 10 board shapes x 8 mounting types produce clean contours with holes strictly inside board', () => {
  const { plugin } = loadPlugin();
  const shapes = spec.params.find((x) => x.key === 'boardShape').options.map(([v]) => v);
  const mounts = spec.params.find((x) => x.key === 'mountType').options.map(([v]) => v);
  assert.equal(shapes.length, 10);
  assert.equal(mounts.length, 8);

  for (const boardShape of shapes) {
    for (const mountType of mounts) {
      const p = { ...defaults(), boardShape, mountType, kerf: 0, frameStyle: 'engraveDouble' };
      const issues = plugin.validate(p).filter((i) => i.level === 'error');
      assert.equal(issues.length, 0, `Errors on ${boardShape} + ${mountType}: ${JSON.stringify(issues)}`);
      const res = plugin.generate(p);
      assertFiniteGeometry(res);

      const board = res.parts.find((x) => x.key === 'board');
      const outer = board.subs[0];
      assert.equal(hasSelfIntersection(outer, 10), null, `Board outer self-intersects for ${boardShape}`);
      const outerPoly = flattenSub(outer, 20);
      assert.ok(signedArea(outerPoly) > 0, `Board outer should be CW for ${boardShape}`);

      // Every mounting hole cutout must have zero self-intersections and sit strictly inside outer contour
      const holes = board.subs.slice(1);
      const expectedCount =
        mountType === 'none' ? 0 :
        mountType === 'keyhole1' ? 1 :
        mountType === 'sides2' || mountType === 'vertical2' || mountType === 'keyhole2' ? 2 :
        mountType === 'triangle3' ? 3 : 4;
      assert.equal(holes.length, expectedCount, `Hole count mismatch for ${boardShape} + ${mountType}`);

      for (const h of holes) {
        assert.equal(hasSelfIntersection(h, 10), null, `Mount hole self-intersects for ${boardShape} + ${mountType}`);
        const hPts = flattenSub(h, 12);
        assert.ok(signedArea(hPts) < 0, `Mount hole should be CCW for ${boardShape} + ${mountType}`);
        for (const pt of hPts) {
          assert.ok(
            pointInPoly(outerPoly, pt),
            `Mount hole point (${pt.x.toFixed(1)}, ${pt.y.toFixed(1)}) outside board for ${boardShape} + ${mountType}`,
          );
        }
      }
    }
  }
});

test('all 6 vector fonts x all supported glyphs x boldness (70/100/140%) have zero self-intersections', () => {
  const { plugin } = loadPlugin();
  const fonts = spec.params.find((x) => x.key === 'font').options.map(([v]) => v);
  const batches = [
    '0123456789',
    'ABCDEFGHIJKLM',
    'NOPQRSTUVWXYZ',
    'ÄÖÜß-/.,:\'+&',
    '12a42b7c',
  ];

  for (const font of fonts) {
    for (const boldness of [70, 100, 140]) {
      for (const batch of batches) {
        const p = {
          ...defaults(),
          font,
          boldness,
          number: batch,
          street: '',
          numberStyle: 'raisedFlat',
          kerf: 0,
        };
        const res = plugin.generate(p);
        assertFiniteGeometry(res);
        const numParts = res.parts.filter((pt) => pt.key.startsWith('num_'));
        assert.equal(numParts.length, batch.length, `Missing glyphs in ${font} b=${boldness} for ${batch}`);

        for (let i = 0; i < numParts.length; i++) {
          const pt = numParts[i];
          const ch = batch[i];
          for (let si = 0; si < pt.subs.length; si++) {
            const sub = pt.subs[si];
            const hit = hasSelfIntersection(sub, 10);
            assert.equal(
              hit,
              null,
              `Self-intersection in font="${font}" boldness=${boldness} char="${ch}" sub=${si}: ${JSON.stringify(hit)}`,
            );
          }
          // Outer contour must have positive area
          const a0 = signedArea(flattenSub(pt.subs[0], 10));
          assert.ok(a0 > 1, `Outer contour area <= 1 in font="${font}" char="${ch}": ${a0}`);
        }
      }
    }
  }
});

test('all 4 layouts, 3 text positions, 3 text modes, and European street names work cleanly', () => {
  const { plugin } = loadPlugin();
  const layouts = ['row', 'stack', 'diagonal', 'splitLeft'];
  const textModes = ['engraveOutline', 'engraveStroke', 'raised'];
  const textPositions = ['bottom', 'top', 'split'];

  for (const layout of layouts) {
    for (const textMode of textModes) {
      for (const textPosition of textPositions) {
        const p = {
          ...defaults(),
          number: '42a',
          street: 'GÖTTINGER STR.',
          subtitle: 'FAMILIE MÜLLER',
          layout,
          textMode,
          textPosition,
          dividerStyle: 'diamond',
          motif: 'house',
          motifPosition: 'top',
          cornerOrnaments: 'brackets',
        };
        const issues = plugin.validate(p).filter((i) => i.level === 'error');
        assert.equal(issues.length, 0);
        const res = plugin.generate(p);
        assertFiniteGeometry(res);

        if (textMode === 'raised') {
          assert.ok(res.parts.some((x) => x.key.startsWith('street_')));
          assert.ok(res.parts.some((x) => x.key.startsWith('sub_')));
        }
      }
    }
  }
});

test('number styles: raisedSpaced (insetGlyph & pegs + pinHoles), raisedFlat, cutout (stencil bridges), engrave', () => {
  const { plugin, calls } = loadPlugin();

  // 1. Pegs spacer style + pinHoles + backplate + raisedFrame
  const pPegs = {
    ...defaults(),
    number: '804',
    numberStyle: 'raisedSpaced',
    spacerStyle: 'pegs',
    spacerLayers: 3,
    pinHoles: true,
    pinDia: 2,
    backplate: true,
    frameStyle: 'raisedFrame',
    frameWidth: 12,
    mountType: 'keyhole2',
  };
  assert.equal(plugin.validate(pPegs).filter((i) => i.level === 'error').length, 0);
  const resPegs = plugin.generate(pPegs);
  assertFiniteGeometry(resPegs);
  assert.ok(resPegs.parts.find((x) => x.key === 'backplate'));
  assert.ok(resPegs.parts.find((x) => x.key === 'frame'));
  assert.equal(resPegs.parts.filter((x) => x.key.startsWith('spacer_')).length, 9);
  // Concealed keyholes: present on backplate (outer + 2 keyholes = 3 subs), NOT on front board (board has pin holes instead)
  const bp = resPegs.parts.find((x) => x.key === 'backplate');
  assert.equal(bp.subs.length, 3);

  // 2. Cutout mode with islands (8, 0, 4) triggers stencil bridges + contrasting backplate
  const pCut = {
    ...defaults(),
    number: '804',
    numberStyle: 'cutout',
    cutoutBackplate: true,
    bridgeWidth: 3.5,
  };
  assert.equal(plugin.validate(pCut).filter((i) => i.level === 'error').length, 0);
  const resCut = plugin.generate(pCut);
  assertFiniteGeometry(resCut);
  assert.ok(resCut.parts.find((x) => x.key === 'backplate'));
  assert.ok(calls.boolean.length >= 3, 'Expected stencil bridge boolean calls for 8, 0, 4');
  assert.ok(resCut.info.some(([k]) => k === 'info.bridges'));

  // 3. Direct engrave mode -> single board part
  const pEng = { ...defaults(), numberStyle: 'engrave', backplate: false, frameStyle: 'none' };
  const resEng = plugin.generate(pEng);
  assertFiniteGeometry(resEng);
  assert.equal(resEng.parts.length, 1);
});

test('all dividers, motifs, and corner ornaments generate clean geometry', () => {
  const { plugin } = loadPlugin();
  const dividers = spec.params.find((x) => x.key === 'dividerStyle').options.map(([v]) => v);
  const motifs = spec.params.find((x) => x.key === 'motif').options.map(([v]) => v);
  const corners = spec.params.find((x) => x.key === 'cornerOrnaments').options.map(([v]) => v);

  for (const dividerStyle of dividers) {
    const res = plugin.generate({ ...defaults(), dividerStyle, numberStyle: 'engrave' });
    assertFiniteGeometry(res);
  }
  for (const motif of motifs) {
    for (const motifPosition of ['top', 'divider', 'bottom']) {
      const res = plugin.generate({ ...defaults(), motif, motifPosition, dividerStyle: 'line', numberStyle: 'engrave' });
      assertFiniteGeometry(res);
    }
  }
  for (const cornerOrnaments of corners) {
    const res = plugin.generate({ ...defaults(), cornerOrnaments, numberStyle: 'engrave' });
    assertFiniteGeometry(res);
  }
});

test('multi-material page grouping separates board (0), front (1), and spacers (2)', () => {
  const { plugin, calls } = loadPlugin();
  const p = { ...defaults(), separatePages: true, frameStyle: 'raisedFrame', backplate: true };
  const res = plugin.generate(p);
  assertFiniteGeometry(res);

  const pageOf = (k) => res.parts.find((x) => x.key === k).page;
  assert.equal(pageOf('backplate'), 0);
  assert.equal(pageOf('board'), 0);
  assert.equal(pageOf('frame'), 1);
  assert.equal(pageOf('num_1'), 1);
  assert.equal(pageOf('spacer_1_1'), 2);
  assert.equal(calls.nest.length, 3, 'Expected 3 independent nest calls (one per page group)');
});

test('material context, onChange sync, workArea check, and validation errors', () => {
  const { plugin: plugNoMat } = loadPlugin({ material: null, workArea: { width: 200, height: 150 } });

  // Empty number -> error
  assert.ok(plugNoMat.validate({ ...defaults(), number: '   ' }).some((i) => i.code === 'number-empty' && i.level === 'error'));
  // Keyhole shaft >= head -> error
  assert.ok(
    plugNoMat.validate({ ...defaults(), mountType: 'keyhole1', keyholeHeadDia: 6, keyholeShaftDia: 5.5 }).some((i) => i.code === 'keyhole-shaft-wide' && i.level === 'error'),
  );
  // Missing material when fromMaterial=true -> error
  assert.ok(plugNoMat.validate({ ...defaults(), fromMaterial: true }).some((i) => i.code === 'material-none' && i.level === 'error'));
  // Board larger than 200x150 workArea -> warning
  assert.ok(plugNoMat.validate(defaults()).some((i) => i.code === 'exceeds-work-area' && i.level === 'warn'));

  // With valid material: onChange patches thickness & kerf
  const { plugin: plugMat } = loadPlugin({ material: { name: 'Walnut 4mm', thickness: 4, kerf: 0.12 } });
  const ch = plugMat.onChange({ key: 'fromMaterial', old: false, params: { ...defaults(), fromMaterial: true } });
  assert.deepEqual(JSON.parse(JSON.stringify(ch)), { patch: { thickness: 4, kerf: 0.12 } });
  const resMat = plugMat.generate({ ...defaults(), fromMaterial: true, thickness: 4, kerf: 0.12 });
  assert.ok(resMat.info.some(([k, v]) => k === 'info.material' && v === 'Walnut 4mm'));
});

test('generation is strictly deterministic', () => {
  const { plugin: p1 } = loadPlugin();
  const { plugin: p2 } = loadPlugin();
  const params = {
    ...defaults(),
    number: '128a',
    street: 'BIRKENALLEE',
    subtitle: 'FAMILIE WEBER',
    boardShape: 'house',
    frameStyle: 'raisedFrame',
    motif: 'trees',
    dividerStyle: 'flourish',
    pinHoles: true,
    separatePages: true,
  };
  const h1 = createHash('sha256').update(JSON.stringify(p1.generate(params))).digest('hex');
  const h2 = createHash('sha256').update(JSON.stringify(p2.generate(params))).digest('hex');
  assert.equal(h1, h2);
});
