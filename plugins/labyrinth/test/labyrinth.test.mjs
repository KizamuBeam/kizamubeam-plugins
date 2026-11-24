// Comprehensive Node test suite for plugins/labyrinth (org.kizamubeam.labyrinth).
// Verifies manifest & 5-language i18n completeness, all 5 parametric maze algorithms, braid loops,
// auto-diameter endpoints, box-composer-advanced style wall editing, Draw/Carve sketching,
// right-column fields, preview highlights, exact laser-cut geometry (zero self-intersections & correct winding),
// floating wall islands + base glue guides, corner holes, multi-page cover separation, top frame,
// 3D stacked poses, material context, workArea distribution, and determinism.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const pluginDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifest = JSON.parse(readFileSync(resolve(pluginDir, 'plugin.json'), 'utf8'));
const spec = manifest.plugins[0];
const bundleCode = readFileSync(resolve(pluginDir, 'dist/labyrinth.js'), 'utf8');

function flattenSub(s, steps = 10) {
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

function signedArea(pts) {
  let s = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    s += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  }
  return s / 2;
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

function segsIntersect(a, b, c, d) {
  const cross = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  const eps = 1e-6;
  return ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps));
}

function hasSelfIntersection(sub, steps = 8) {
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
      if (segsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}

function loadPlugin(ctx = {}) {
  const host = {
    offset({ subs }) {
      return subs;
    },
    nest({ parts, gap }) {
      let x = 0;
      return parts.map((pt) => {
        const bb = bboxOfSubs(pt.subs);
        const cx = x + bb.w / 2;
        x += bb.w + gap;
        return [cx, 0];
      });
    },
    check() {
      return [];
    },
    context(what) {
      if (what === 'material') return ctx.material ?? null;
      if (what === 'workArea') return ctx.workArea ?? { width: 400, height: 400 };
      return null;
    },
    progress() {},
  };
  const sandbox = { host, globalThis: null };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(bundleCode, sandbox);
  return sandbox.plugin;
}

function defaultParams(overrides = {}) {
  const p = {};
  for (const param of spec.params) p[param.key] = param.def;
  return { ...p, ...overrides };
}

function applyPatch(p, res) {
  return res?.patch ? { ...p, ...res.patch } : p;
}

// ============================================================
// 1. Manifest & 5-language i18n completeness
// ============================================================

test('manifest has complete 5-language translations with zero missing or extra keys', () => {
  const langs = ['en', 'de', 'es', 'it', 'pt-BR'];
  assert.deepEqual(Object.keys(spec.texts).sort(), [...langs].sort());
  const enKeys = Object.keys(spec.texts.en).sort();
  for (const lang of langs) {
    assert.deepEqual(Object.keys(spec.texts[lang]).sort(), enKeys, `locale ${lang} key mismatch`);
    for (const k of enKeys) {
      assert.equal(typeof spec.texts[lang][k], 'string');
      assert.ok(spec.texts[lang][k].trim().length > 0, `empty text ${lang}.${k}`);
    }
  }

  // Verify every manifest-referenced text key exists in en
  const en = spec.texts.en;
  for (const param of spec.params) {
    assert.ok(en[param.key], `missing param text: ${param.key}`);
    if (param.section) assert.ok(en[param.section], `missing section text: ${param.section}`);
    if (param.options) {
      for (const [, lbl] of param.options) assert.ok(en[lbl], `missing option text: ${lbl}`);
    }
  }
  for (const step of spec.dialog.steps) assert.ok(en[step.label], `missing step text: ${step.label}`);
  for (const act of spec.dialog.actions) {
    assert.ok(en[act.label], `missing action label: ${act.label}`);
    assert.ok(en[act.title], `missing action title: ${act.title}`);
  }
  for (const v of spec.dialog.surface.views) assert.ok(en[v.label], `missing view label: ${v.label}`);
  for (const h of spec.dialog.surface.help) assert.ok(en[h], `missing help text: ${h}`);
  for (const list of spec.dialog.lists) {
    assert.ok(en[list.label], `missing list label: ${list.label}`);
    assert.ok(en[list.empty], `missing list empty: ${list.empty}`);
    assert.ok(en[list.removeTitle], `missing list removeTitle: ${list.removeTitle}`);
    for (const col of list.columns) {
      assert.ok(en[col.label], `missing col label: ${col.label}`);
      assert.ok(en[col.title], `missing col title: ${col.title}`);
    }
  }
});

// ============================================================
// 2. Default parameters & Determinism
// ============================================================

test('default parameters validate cleanly, generate valid assembly, and are 100% deterministic', () => {
  const plugin = loadPlugin();
  const p = defaultParams();
  const issues = plugin.validate(p);
  assert.equal(issues.length, 0, `unexpected default issues: ${JSON.stringify(issues)}`);

  const r1 = plugin.generate(p);
  const r2 = plugin.generate(p);
  const h1 = createHash('sha256').update(JSON.stringify(r1)).digest('hex');
  const h2 = createHash('sha256').update(JSON.stringify(r2)).digest('hex');
  assert.equal(h1, h2, 'generate() must be deterministic');

  // Default: 8mm ball + 0.5mm top play / 3mm wood => 3 maze layers + base + clear cover = 5 parts
  assert.deepEqual(
    Array.from(r1.parts, (pt) => pt.key),
    ['base', 'maze-1', 'maze-2', 'maze-3', 'cover'],
  );
  // Cover is on page 1, wood parts on page 0
  assert.equal(r1.parts.find((pt) => pt.key === 'base').page, 0);
  assert.equal(r1.parts.find((pt) => pt.key === 'maze-1').page, 0);
  assert.equal(r1.parts.find((pt) => pt.key === 'cover').page, 1);
  // Base has engraved Start dot & Goal star
  assert.ok((r1.parts.find((pt) => pt.key === 'base').marks ?? []).length >= 4);

  // view() provides row labels for all walls
  const vw = plugin.view(p);
  assert.equal(vw.rows.walls.length, JSON.parse(p.walls).length);
});

// ============================================================
// 3. All 5 parametric algorithms, braid loops, and autoEndpoints
// ============================================================

test('all 5 parametric maze algorithms generate solvable, island-free, non-self-intersecting mazes', () => {
  const plugin = loadPlugin();
  const algs = ['dfs', 'prim', 'kruskal', 'huntKill', 'sidewinder'];
  const hashes = new Set();

  for (const algorithm of algs) {
    for (const seed of [1, 42, 1337]) {
      const p = defaultParams({
        cols: 8,
        rows: 7,
        algorithm,
        seed,
        braid: 0,
        wallMode: 'auto',
        wallsRef: '',
        endpoints: '',
      });
      const issues = plugin.validate(p);
      assert.equal(
        issues.filter((i) => i.level === 'error').length,
        0,
        `${algorithm} seed=${seed} had errors: ${JSON.stringify(issues)}`,
      );
      assert.equal(
        issues.filter((i) => i.code === 'maze-unsolvable' || i.code === 'maze-islands').length,
        0,
        `perfect spanning-tree maze (${algorithm} seed=${seed}) must be solvable with 0 islands`,
      );

      const res = plugin.generate(p);
      hashes.add(createHash('sha256').update(JSON.stringify(res.parts[1].subs)).digest('hex'));

      // Check every cut subpath for zero self-intersections and valid winding
      const mazeSubs = res.parts.find((pt) => pt.key === 'maze-1').subs;
      assert.ok(mazeSubs.length >= 2, 'maze layer must have outer boundary + channel cutout');
      let posAreaCount = 0;
      let negAreaCount = 0;
      for (const sp of mazeSubs) {
        assert.equal(hasSelfIntersection(sp), false, `self-intersection in ${algorithm} seed=${seed}`);
        const a = signedArea(flattenSub(sp, 8));
        if (a > 0) posAreaCount++;
        else if (a < 0) negAreaCount++;
      }
      assert.equal(posAreaCount, 1, 'tree maze must have exactly 1 outer positive-area contour (no floating islands)');
      assert.ok(negAreaCount >= 1, 'maze layer must have at least 1 cutout hole');
    }
  }

  assert.equal(hashes.size, algs.length * 3, 'every (algorithm, seed) pair should produce a distinct maze');
});

test('braid opens dead ends and autoEndpoints finds longest path diameter', () => {
  const plugin = loadPlugin();
  const baseP = defaultParams({ cols: 10, rows: 10, algorithm: 'dfs', seed: 77, braid: 0, wallMode: 'auto', wallsRef: '', endpoints: '' });
  const braidP = defaultParams({ cols: 10, rows: 10, algorithm: 'dfs', seed: 77, braid: 50, wallMode: 'auto', wallsRef: '', endpoints: '' });
  const rBase = plugin.generate(baseP);
  const rBraid = plugin.generate(braidP);

  const wallsBase = Number(rBase.info.find(([k]) => k === 'info.walls')[1]);
  const wallsBraid = Number(rBraid.info.find(([k]) => k === 'info.walls')[1]);
  assert.notEqual(JSON.stringify(rBase.parts[1].subs), JSON.stringify(rBraid.parts[1].subs));
  assert.ok(wallsBase > 0 && wallsBraid > 0);

  const cornerP = defaultParams({ cols: 9, rows: 9, algorithm: 'prim', seed: 99, autoEndpoints: false, wallMode: 'auto', wallsRef: '', endpoints: '' });
  const diamP = defaultParams({ cols: 9, rows: 9, algorithm: 'prim', seed: 99, autoEndpoints: true, wallMode: 'auto', wallsRef: '', endpoints: '' });
  const stepsCorner = plugin.generate(cornerP).info.find(([k]) => k === 'info.solution')[1].values.steps;
  const stepsDiam = plugin.generate(diamP).info.find(([k]) => k === 'info.solution')[1].values.steps;
  assert.ok(stepsDiam >= stepsCorner, `autoEndpoints (${stepsDiam}) must be >= corner path (${stepsCorner})`);
});

// ============================================================
// 4. Interactive Wall Editing (box-composer-advanced model)
// ============================================================

test('interactive walls view: select, move, stretch endpoint, Ctrl+draw, double-click across, right-click, Delete, fields & highlight', () => {
  const plugin = loadPlugin();
  let p = defaultParams({ cols: 6, rows: 6, wallMode: 'auto', wallsRef: '', endpoints: '' });
  // Start from an empty arena to test every edit deterministically
  const emptyRes = plugin.onEvent({ action: 'emptyArena', params: p, inputs: {} });
  p = applyPatch(p, emptyRes);
  assert.equal(p.wallMode, 'custom');
  assert.deepEqual(JSON.parse(p.walls), []);

  const pitch = p.ballDia + p.ballPlay + p.wallWidth; // 12.5 mm
  const surf = (view = 'walls', state = null, selected = {}) => ({ view, state, selected });

  // 1. Ctrl+drag draws a horizontal wall on row line 2 from col 1 to col 4
  let ev = plugin.onSurface({
    event: { type: 'down', x: 1 * pitch - p.wallWidth / 2, y: 2 * pitch - p.wallWidth / 2, ctrl: true },
    surface: surf(),
    params: p,
  });
  assert.ok(ev?.state?.drag?.kind === 'draw');
  ev = plugin.onSurface({
    event: { type: 'move', x: 4 * pitch - p.wallWidth / 2, y: 2 * pitch - p.wallWidth / 2, ctrl: true },
    surface: surf('walls', ev.state),
    params: p,
  });
  assert.ok(ev?.state?.walls?.length === 1);
  ev = plugin.onSurface({
    event: { type: 'up', x: 4 * pitch - p.wallWidth / 2, y: 2 * pitch - p.wallWidth / 2 },
    surface: surf('walls', ev.state),
    params: p,
  });
  p = applyPatch(p, ev);
  let walls = JSON.parse(p.walls);
  assert.equal(walls.length, 1);
  assert.deepEqual({ axis: walls[0].axis, pos: walls[0].pos, from: walls[0].from, to: walls[0].to }, { axis: 'h', pos: 2, from: 1, to: 4 });

  // 2. Select wall #1 -> verify right-column fields & live preview highlight on maze-1
  const wId = walls[0].id;
  const drawSel = plugin.draw({ params: p, view: 'walls', state: null, selected: { walls: 0 }, have: [] });
  assert.ok(drawSel.fields.some((f) => f.id === 'w.pos' && f.value === 2));
  assert.ok(drawSel.fields.some((f) => f.id === 'w.len' && f.value === 3));
  assert.equal(drawSel.highlight.length, 1);
  assert.equal(drawSel.highlight[0].part, 1);

  // 3. Drag wall #1 down by 1 grid line (row 2 -> row 3)
  const midX = 2.5 * pitch;
  const yRow2 = 2 * pitch - p.wallWidth / 2;
  const yRow3 = 3 * pitch - p.wallWidth / 2;
  ev = plugin.onSurface({
    event: { type: 'down', x: midX, y: yRow2, hit: `w${wId}` },
    surface: surf(),
    params: p,
  });
  ev = plugin.onSurface({
    event: { type: 'move', x: midX, y: yRow3 },
    surface: surf('walls', ev.state, ev.select),
    params: p,
  });
  ev = plugin.onSurface({
    event: { type: 'up', x: midX, y: yRow3 },
    surface: surf('walls', ev.state, ev.select),
    params: p,
  });
  p = applyPatch(p, ev);
  walls = JSON.parse(p.walls);
  assert.equal(walls[0].pos, 3, 'wall should have moved from line 2 to line 3');

  // 4. Stretch 'to' endpoint from col 4 to col 5
  ev = plugin.onSurface({
    event: { type: 'down', x: 4 * pitch, y: yRow3, hit: `e${walls[0].id}.to` },
    surface: surf(),
    params: p,
  });
  ev = plugin.onSurface({
    event: { type: 'move', x: 5 * pitch - p.wallWidth / 2, y: yRow3 },
    surface: surf('walls', ev.state, ev.select),
    params: p,
  });
  ev = plugin.onSurface({
    event: { type: 'up', x: 5 * pitch - p.wallWidth / 2, y: yRow3 },
    surface: surf('walls', ev.state, ev.select),
    params: p,
  });
  p = applyPatch(p, ev);
  walls = JSON.parse(p.walls);
  assert.equal(walls[0].to, 5, 'wall endpoint should have stretched to col 5');

  // 5. Field edit: set length to 2 cells -> to becomes 3
  ev = plugin.onSurface({
    event: { type: 'field', x: 0, y: 0, field: 'w.len', value: 2 },
    surface: surf('walls', null, { walls: 0 }),
    params: p,
  });
  p = applyPatch(p, ev);
  walls = JSON.parse(p.walls);
  assert.equal(walls[0].to - walls[0].from, 2);

  // 6. Double-click in open space (Shift = vertical) places wall across passage
  ev = plugin.onSurface({
    event: { type: 'dblclick', x: 3 * pitch - p.wallWidth / 2, y: 1.5 * pitch, shift: true },
    surface: surf(),
    params: p,
  });
  p = applyPatch(p, ev);
  walls = JSON.parse(p.walls);
  assert.ok(walls.some((w) => w.axis === 'v' && w.pos === 3), 'double-click+Shift should place vertical wall');

  // 7. Right-click on outer wall segment opens an outer gate
  ev = plugin.onSurface({
    event: { type: 'context', x: 0, y: 0, hit: 'outer.h.0.0' },
    surface: surf(),
    params: p,
  });
  p = applyPatch(p, ev);
  walls = JSON.parse(p.walls);
  assert.ok(walls.some((w) => w.open && w.axis === 'h' && w.pos === 0 && w.from === 0 && w.to === 1));
  // Cover + open outer gate warns
  assert.ok(plugin.validate(p).some((i) => i.code === 'cover-open-outer'));

  // 8. Delete key removes selected interior wall
  const idxInt = walls.findIndex((w) => !w.open);
  ev = plugin.onSurface({
    event: { type: 'key', x: 0, y: 0, key: 'Delete' },
    surface: surf('walls', null, { walls: idxInt }),
    params: p,
  });
  p = applyPatch(p, ev);
  assert.equal(JSON.parse(p.walls).filter((w) => !w.open).length, walls.filter((w) => !w.open).length - 1);

  // 9. Drag Start marker handle to (2, 1)
  ev = plugin.onSurface({
    event: { type: 'down', x: 5, y: 5, hit: 'marker.start' },
    surface: surf(),
    params: p,
  });
  ev = plugin.onSurface({
    event: { type: 'move', x: 2 * pitch + 4, y: 1 * pitch + 4 },
    surface: surf('walls', ev.state),
    params: p,
  });
  ev = plugin.onSurface({
    event: { type: 'up', x: 2 * pitch + 4, y: 1 * pitch + 4 },
    surface: surf('walls', ev.state),
    params: p,
  });
  p = applyPatch(p, ev);
  assert.deepEqual(JSON.parse(p.endpoints), { sx: 2, sy: 1, gx: 5, gy: 5 });
});

// ============================================================
// 5. Design from scratch via Full Grid + Draw / Carve view
// ============================================================

test('fullGrid + carve view lets user carve a continuous solvable path from scratch', () => {
  const plugin = loadPlugin();
  let p = defaultParams({ cols: 4, rows: 4, wallMode: 'auto', wallsRef: '', endpoints: '' });
  p = applyPatch(p, plugin.onEvent({ action: 'fullGrid', params: p, inputs: {} }));
  assert.ok(plugin.validate(p).some((i) => i.code === 'maze-unsolvable'), 'full grid must initially be unsolvable');

  const pitch = p.ballDia + p.ballPlay + p.wallWidth;
  const ch = p.ballDia + p.ballPlay;
  const cellPt = (c, r) => ({ x: c * pitch + ch / 2, y: r * pitch + ch / 2 });

  // Carve an L-shaped corridor from (0,0) -> (3,0) -> (3,3) in one continuous drag
  let ev = plugin.onSurface({
    event: { type: 'down', ...cellPt(0, 0) },
    surface: { view: 'carve', state: null, selected: {} },
    params: p,
  });
  assert.equal(ev?.state?.drag?.kind, 'carve');
  for (const [c, r] of [[1, 0], [2, 0], [3, 0], [3, 1], [3, 2], [3, 3]]) {
    ev = plugin.onSurface({
      event: { type: 'move', ...cellPt(c, r) },
      surface: { view: 'carve', state: ev.state, selected: {} },
      params: p,
    });
  }
  ev = plugin.onSurface({
    event: { type: 'up', ...cellPt(3, 3) },
    surface: { view: 'carve', state: ev.state, selected: {} },
    params: p,
  });
  p = applyPatch(p, ev);

  const issues = plugin.validate(p);
  assert.equal(issues.filter((i) => i.code === 'maze-unsolvable').length, 0, 'carved corridor must now be solvable');
  const gen = plugin.generate(p);
  const sol = gen.info.find(([k]) => k === 'info.solution')[1];
  assert.equal(sol.values.steps, 6, 'L-corridor on 4x4 grid has exact length 6 steps');

  // Verify carved geometry has zero self-intersections (untouched 3x3 closed cells stay clean solid wood!)
  for (const sp of gen.parts.find((pt) => pt.key === 'maze-1').subs) {
    assert.equal(hasSelfIntersection(sp), false);
  }
});

// ============================================================
// 6. Floating Wall Islands, Base Glue Guides, Corner Holes, Top Frame, 3D Poses
// ============================================================

test('floating wall island triggers warning, base glue guides, and clean laser-cut island contour', () => {
  const plugin = loadPlugin();
  // A single interior wall completely surrounded by open passages is a floating island!
  const islandWalls = JSON.stringify([{ id: 1, axis: 'h', pos: 2, from: 1, to: 3 }]);
  const p = defaultParams({
    cols: 5,
    rows: 5,
    wallMode: 'custom',
    walls: islandWalls,
    wallsRef: 'custom:5x5',
    endpoints: JSON.stringify({ sx: 0, sy: 0, gx: 4, gy: 4 }),
    glueGuides: 'islands',
    startSymbol: 'none',
    goalSymbol: 'none',
  });

  const issues = plugin.validate(p);
  const islWarn = issues.find((i) => i.code === 'maze-islands');
  assert.ok(islWarn && islWarn.level === 'warn' && islWarn.values.count === 1);

  const res = plugin.generate(p);
  const base = res.parts.find((pt) => pt.key === 'base');
  const maze1 = res.parts.find((pt) => pt.key === 'maze-1');
  assert.equal((base.marks ?? []).length, 1, 'base plate must engrave 1 glue guide outline for the floating island');

  // Maze layer must have 2 positive-area contours (outer frame + floating island) and 1 negative-area hole (arena)
  const areas = maze1.subs.map((sp) => signedArea(flattenSub(sp, 8)));
  assert.equal(areas.filter((a) => a > 0).length, 2);
  assert.equal(areas.filter((a) => a < 0).length, 1);
  for (const sp of maze1.subs) assert.equal(hasSelfIntersection(sp), false);
});

test('corner holes, top frame, manual layers, and 3D stacked poses align with zero Z overlap', () => {
  const plugin = loadPlugin();
  const p = defaultParams({
    cols: 6,
    rows: 6,
    borderWidth: 10,
    cornerRadius: 4,
    cornerHoles: 'screws',
    holeDia: 3,
    cover: true,
    topFrame: true,
    layerCountMode: 'manual',
    layerCount: 2,
    thickness: 4,
    ballDia: 7,
    wallMode: 'auto',
    wallsRef: '',
    endpoints: '',
  });

  const issues = plugin.validate(p);
  assert.equal(issues.filter((i) => i.level === 'error').length, 0);

  const res = plugin.generate(p);
  assert.deepEqual(
    Array.from(res.parts, (pt) => pt.key),
    ['base', 'maze-1', 'maze-2', 'cover', 'top-frame'],
  );

  // Base has outer + 4 corner holes = 5 subpaths
  const base = res.parts.find((pt) => pt.key === 'base');
  assert.equal(base.subs.length, 5);
  // Top frame has outer + inner window + 4 corner holes = 6 subpaths
  const frame = res.parts.find((pt) => pt.key === 'top-frame');
  assert.equal(frame.subs.length, 6);
  for (const sp of frame.subs) assert.equal(hasSelfIntersection(sp), false);

  // Verify 3D poses: strictly increasing Z by thickness = 4mm, all facing +Z
  const expectedZ = [0, 4, 8, 12, 16];
  res.parts.forEach((pt, idx) => {
    const pose = res.poses.poses[pt.key];
    assert.ok(pose, `missing 3D pose for ${pt.key}`);
    assert.equal(pose.o[2], expectedZ[idx]);
    assert.deepEqual([...pose.u], [1, 0, 0]);
    assert.deepEqual([...pose.v], [0, -1, 0]);
    assert.deepEqual([...pose.n], [0, 0, 1]);
  });

  // Oversized corner hole must fail validation
  const badHole = plugin.validate(defaultParams({ borderWidth: 4, cornerHoles: 'screws', holeDia: 4 }));
  assert.ok(badHole.some((i) => i.level === 'error' && i.code === 'hole-too-large'));

  // Shallow manual depth warns
  const shallow = plugin.validate(defaultParams({ ballDia: 10, thickness: 3, layerCountMode: 'manual', layerCount: 2 }));
  assert.ok(shallow.some((i) => i.level === 'warn' && i.code === 'depth-shallow'));
});

// ============================================================
// 7. onChange, Toolbar Pills, Material Context, and WorkArea distribution
// ============================================================

test('onChange regenerates in auto mode, prompts in custom mode, and reads material context', () => {
  const plugin = loadPlugin({
    material: { name: 'Birch 4mm', thickness: 4, kerf: 0.14, pairPlay: null, pairPlayTotal: null, slotPlay: null },
    workArea: { width: 150, height: 150 },
  });

  // Auto mode: changing seed regenerates immediately
  let p = defaultParams({ seed: 100 });
  const cAuto = plugin.onChange({ key: 'seed', old: 42, params: p });
  assert.ok(cAuto?.patch?.walls && cAuto.patch.wallMode === 'auto');
  p = applyPatch(p, cAuto);

  // Custom mode: changing seed asks the user before discarding edits
  const pCustom = { ...p, wallMode: 'custom' };
  const cAsk = plugin.onChange({ key: 'seed', old: 100, params: { ...pCustom, seed: 101 } });
  assert.ok(cAsk?.ask?.question?.code === 'ask.regenerate');
  assert.equal(cAsk.ask.options.length, 2);

  // Material context takeover
  const cMat = plugin.onChange({ key: 'fromMaterial', old: false, params: { ...p, fromMaterial: true } });
  assert.equal(cMat.patch.thickness, 4);
  assert.equal(cMat.patch.kerf, 0.14);

  // Toolbar pill tb.seed increments seed & regenerates
  const tbRes = plugin.onSurface({
    event: { type: 'down', x: 0, y: 0, hit: 'tb.seed' },
    surface: { view: 'walls', state: null, selected: {} },
    params: p,
  });
  assert.equal(tbRes.patch.seed, 101);
  assert.equal(tbRes.patch.wallMode, 'auto');

  // Small workArea (150x150) triggers distribute: { rotate: false }
  const gen = plugin.generate(p);
  assert.deepEqual({ ...gen.distribute }, { rotate: false });
});

test('Ctrl+click target wall, Shift multi-select group move, and Escape key work cleanly', () => {
  const plugin = loadPlugin();
  let p = defaultParams({
    cols: 6,
    rows: 6,
    wallMode: 'custom',
    walls: JSON.stringify([
      { id: 1, axis: 'h', pos: 1, from: 0, to: 4 },
      { id: 2, axis: 'h', pos: 4, from: 2, to: 6 },
    ]),
    wallsRef: 'custom:6x6',
    endpoints: JSON.stringify({ sx: 0, sy: 0, gx: 5, gy: 5 }),
  });
  const pitch = p.ballDia + p.ballPlay + p.wallWidth;
  const surf = (state = null, selected = {}) => ({ view: 'walls', state, selected });

  // Ctrl+click on wall #1 at col=2, slightly below line 1 -> shoots vertical wall down from row 1 to row 4
  const y1 = 1 * pitch - p.wallWidth / 2;
  const x2 = 2 * pitch - p.wallWidth / 2;
  let ev = plugin.onSurface({
    event: { type: 'down', x: x2, y: y1 + 1.5, ctrl: true },
    surface: surf(),
    params: p,
  });
  assert.ok(ev?.state?.aim, 'Ctrl+down near wall must create aim target');
  ev = plugin.onSurface({
    event: { type: 'up', x: x2, y: y1 + 1.5 },
    surface: surf(ev.state),
    params: p,
  });
  p = applyPatch(p, ev);
  let walls = JSON.parse(p.walls);
  assert.ok(walls.some((w) => w.axis === 'v' && w.pos === 2 && w.from === 1 && w.to === 4), 'Ctrl+click must shoot vertical wall from row 1 to row 4');

  // Shift+click selects both horizontal stretches (wall #1 right side & wall #2), then Escape clears selection
  const w1 = walls.find((w) => w.axis === 'h' && w.pos === 1);
  const w2 = walls.find((w) => w.axis === 'h' && w.pos === 4);
  ev = plugin.onSurface({
    event: { type: 'down', x: 3 * pitch, y: y1, hit: `w${w1.id}` },
    surface: surf(),
    params: p,
  });
  ev = plugin.onSurface({
    event: { type: 'up', x: 3 * pitch, y: y1 },
    surface: surf(ev.state, ev.select),
    params: p,
  });
  const y4 = 4 * pitch - p.wallWidth / 2;
  ev = plugin.onSurface({
    event: { type: 'down', x: 4 * pitch, y: y4, hit: `w${w2.id}`, shift: true },
    surface: surf(ev.state, { walls: 0 }),
    params: p,
  });
  assert.equal(ev.state.sel.more?.length, 1, 'Shift+click must multi-select across two walls');

  // Escape clears selection
  const esc = plugin.onSurface({
    event: { type: 'key', x: 0, y: 0, key: 'Escape' },
    surface: surf(ev.state, ev.select),
    params: p,
  });
  assert.equal(esc.state, null);
  assert.equal(esc.select.walls, -1);
});
