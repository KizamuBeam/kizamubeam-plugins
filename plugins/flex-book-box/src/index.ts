// Flex Book Box generator plugin for KizamuBeam.
// Combines a one-piece living-hinge book cover (using KizamuBeam's Living Hinge engine)
// with a finger-jointed, scored page block supporting all features of Finger Joint Box with Dividers.
//
// Build: npm run pack -- plugins/flex-book-box
// Test:  node --test plugins/flex-book-box/test/flex-book-box.test.mjs
import { definePlugin, host, mm, type Change, type EventResult, type GenResult, type Issue, type Part, type Text } from '../../../sdk/ts';
import { bookDims, buildBook, hingeOptions } from './book';
import { defaultDistribution, distributeGaps, resizeDistribution } from './distribution';
import { fingerboxSegments, horizontalSegments } from './dividers';
import { computeSpineHinge, suggestHinge } from './hinge';
import type { BookDims, P } from './types';

function readMaterial(): { thickness: number; kerf: number | null; clearance: number | null; name: string | null } | null {
  const m = host.context('material');
  if (!m || m.thickness == null) return null;
  return { thickness: m.thickness, kerf: m.kerf, clearance: m.pairPlayTotal ?? m.slotPlay, name: m.name };
}

function materialIssues(p: P): { issues: Issue[]; materialName: string | null } {
  const issues: Issue[] = [];
  if (!p.fromMaterial) return { issues, materialName: null };
  const m = readMaterial();
  if (!m) {
    return { issues: [{ key: 'fromMaterial', level: 'error', code: 'material-none' }], materialName: null };
  }
  const off = (a: number | null, b: number) => a != null && Math.abs(a - b) > 1e-6;
  if (off(m.thickness, p.thickness) || off(m.kerf, p.kerf) || off(m.clearance, p.clearance)) {
    issues.push({ key: 'fromMaterial', level: 'warn', code: 'material-changed', values: { thickness: m.thickness } });
  }
  if (m.kerf == null) issues.push({ key: 'fromMaterial', level: 'warn', code: 'material-no-kerf', values: { kerf: p.kerf } });
  if (m.clearance == null) issues.push({ key: 'fromMaterial', level: 'warn', code: 'material-no-play', values: { play: p.clearance } });
  return { issues, materialName: m.name };
}

function hasDividers(p: P): boolean {
  return p.compartmentsX > 1 || p.compartmentsY > 1;
}

function fitsWorkArea(parts: Part[]): boolean {
  const area = host.context('workArea');
  if (!area) return true;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const part of parts) {
    for (const s of part.subs) {
      for (const n of s.nodes) {
        x0 = Math.min(x0, n.x + part.at.x);
        x1 = Math.max(x1, n.x + part.at.x);
        y0 = Math.min(y0, n.y + part.at.y);
        y1 = Math.max(y1, n.y + part.at.y);
      }
    }
  }
  const w = x1 - x0;
  const h = y1 - y0;
  return (w <= area.width && h <= area.height) || (h <= area.width && w <= area.height);
}

/** Validate parameters and geometry; returns all issues and (if valid) the built assembly */
function evaluate(p: P): { issues: Issue[]; d: BookDims; materialName: string | null; built: ReturnType<typeof buildBook> | null } {
  const { issues, materialName } = materialIssues(p);
  const d = bookDims(p);
  if (issues.some((i) => i.level === 'error')) return { issues, d, materialName, built: null };

  // Basic cover & page block dimensional checks
  if (d.sq < 0 || d.Wb <= 2 * d.t || d.Hb <= 2 * d.t) {
    issues.push({ key: 'square', level: 'error', code: 'page-block-small' });
    return { issues, d, materialName, built: null };
  }
  if (d.P <= 2 * d.t) {
    issues.push({ key: 'pageThickness', level: 'error', code: 'page-thickness-small' });
    return { issues, d, materialName, built: null };
  }
  if (d.spineLen <= 2 * d.t) {
    issues.push({ key: 'spineAllowance', level: 'error', code: 'spine-too-narrow' });
    return { issues, d, materialName, built: null };
  }
  if (p.coverCornerRadius > Math.min(d.Wc / 2, d.Hc / 2)) {
    issues.push({ key: 'coverCornerRadius', level: 'error', code: 'corner-radius-large' });
    return { issues, d, materialName, built: null };
  }
  if (d.t > 4) {
    issues.push({ key: 'thickness', level: 'warn', code: 'thickness-bend-warn', values: { thickness: d.t } });
  }
  if (Math.abs(d.clearance) >= d.finger / 2) {
    issues.push({ key: 'clearance', level: 'error', code: 'clearance-too-large' });
    return { issues, d, materialName, built: null };
  }

  // Finger count & minimum finger width check
  const edgeLens = [d.Wb - 2 * d.t, d.Hb - 2 * d.t, d.P - (d.floor ? d.t : 0)];
  try {
    const widths = edgeLens.map((len, i) => len / (i === 2 ? fingerboxSegments(len, d.finger) : horizontalSegments(len, d.finger)));
    if (Math.min(...widths) <= d.t) {
      issues.push({ key: 'finger', level: 'warn', code: 'finger-narrow-warn' });
    }
  } catch (e) {
    issues.push({ key: 'finger', level: 'error', code: e instanceof Error ? e.message : 'too-many-fingers' });
    return { issues, d, materialName, built: null };
  }

  // Compartment distribution validation
  for (const [key, length, count, spec] of [
    ['ratiosX', d.Wb, p.compartmentsX, p.ratiosX],
    ['ratiosY', d.Hb, p.compartmentsY, p.ratiosY],
  ] as const) {
    try {
      distributeGaps(length, d.t, count, spec);
    } catch (e) {
      issues.push({ key, level: 'error', code: e instanceof Error ? e.message : 'expr-invalid' });
    }
  }
  if (issues.some((i) => i.level === 'error')) return { issues, d, materialName, built: null };

  // Living hinge pre-validation
  const hingeCheck = computeSpineHinge(-d.spineLen / 2, -d.Hc / 2, d.spineLen / 2, d.Hc / 2, hingeOptions(p));
  if (hingeCheck.error) {
    issues.push({
      key: 'hingeSpacing',
      level: 'error',
      code: hingeCheck.error.code,
      ...(hingeCheck.error.values ? { values: hingeCheck.error.values } : {}),
    });
    return { issues, d, materialName, built: null };
  }

  // Complexity guard for large divider grids
  if (hasDividers(p)) {
    const estimate =
      (p.compartmentsX - 1) * (Math.ceil(d.Hb / d.finger) + 3 * p.compartmentsY + Math.ceil(d.P / d.finger)) +
      (p.compartmentsY - 1) * (Math.ceil(d.Wb / d.finger) + 3 * p.compartmentsX + Math.ceil(d.P / d.finger));
    if (estimate > 20_000) {
      issues.push({ key: 'compartmentsX', level: 'error', code: 'too-many-dividers' });
      return { issues, d, materialName, built: null };
    }
  }

  // Full geometry build & design check
  try {
    const built = buildBook(p, d);
    for (const w of new Set(built.warnings)) {
      issues.push({ level: 'warn', code: w });
    }
    const area = host.context('workArea');
    const findings = host.check({
      parts: built.checkParts,
      kerf: d.kerf,
      ...(area ? { workArea: area } : {}),
    });
    for (const f of findings) {
      if (f.level === 'info') continue;
      issues.push({
        level: f.level as 'error' | 'warn',
        code: f.code,
        ...(f.values ? { values: f.values } : {}),
      });
    }
    return { issues, d, materialName, built };
  } catch (e) {
    const err = e as Error & { values?: Record<string, number> };
    issues.push({
      level: 'error',
      code: err instanceof Error ? err.message : 'build-failed',
      ...(err?.values ? { values: err.values } : {}),
    });
    return { issues, d, materialName, built: null };
  }
}

definePlugin<P>({
  validate(p) {
    return evaluate(p).issues;
  },

  view(p) {
    const autoText: Record<string, Text> = {};
    if (Number.isInteger(p.compartmentsX) && p.compartmentsX >= 1 && p.compartmentsX <= 20) {
      autoText.ratiosX = defaultDistribution(p.compartmentsX);
    }
    if (Number.isInteger(p.compartmentsY) && p.compartmentsY >= 1 && p.compartmentsY <= 20) {
      autoText.ratiosY = defaultDistribution(p.compartmentsY);
    }
    return { autoText };
  },

  onChange({ key, old, params: p }): Change | null {
    // Sync fields from layer material when switching on "From material"
    if (key === 'fromMaterial' && p.fromMaterial) {
      const m = readMaterial();
      if (!m) return null;
      return {
        patch: {
          thickness: m.thickness,
          ...(m.kerf != null ? { kerf: m.kerf } : {}),
          ...(m.clearance != null ? { clearance: m.clearance } : {}),
        },
      };
    }

    // Smart compartment ratio resizing (identical to Finger Joint Box with Dividers)
    const ratioKey = key === 'compartmentsX' ? 'ratiosX' : key === 'compartmentsY' ? 'ratiosY' : '';
    const count = Number(p[key]);
    if (ratioKey && Number.isInteger(count) && count >= 1 && count <= 20 && count !== Number(old)) {
      const resized = resizeDistribution(String(p[ratioKey] ?? ''), Number(old), count);
      if (!resized) return null;
      const patch = { [ratioKey]: resized.text };
      if (!resized.removed.length) return { patch };
      return {
        ask: {
          question: { code: 'ask.drop-ratios', values: { values: resized.removed.join(' : ') } },
          options: [{ label: { code: 'ask.ok' }, patch }],
        },
      };
    }

    return null;
  },

  onEvent({ action, params: p }): EventResult | null {
    if (action === 'suggestHinge') {
      const t = p.thickness;
      return {
        patch: suggestHinge(t),
        message: { code: 'msg.hinge-suggested', values: { thickness: mm(t) } },
      };
    }
    return null;
  },

  generate(p): GenResult {
    const d = bookDims(p);
    const built = buildBook(p, d);
    const { materialName } = materialIssues(p);

    const labels: Record<string, Text> = {
      cover: { code: 'part.cover' },
      bottom: { code: 'part.bottom' },
      tail: { code: 'part.tail' },
      head: { code: 'part.head' },
      fore: { code: 'part.fore' },
      spine: { code: 'part.spine' },
    };
    for (const part of built.parts) {
      const mx = /^divx-(\d+)$/.exec(part.key);
      if (mx) labels[part.key] = { code: 'part.divx', values: { n: Number(mx[1]) } };
      const my = /^divy-(\d+)$/.exec(part.key);
      if (my) labels[part.key] = { code: 'part.divy', values: { n: Number(my[1]) } };
    }

    const closedThick = d.P + 2 * d.t;
    const info: [Text, Text][] = [
      ['info.book', `${mm(d.Wc)} × ${mm(d.Hc)} × ${mm(closedThick)} mm`],
      ['info.cover', `${mm(d.coverTotalW)} × ${mm(d.Hc)} mm`],
      ['info.spine', `${mm(d.spineLen)} mm`],
      ['info.hinge', { code: 'info.hinge.val', values: { cuts: built.hinge.cuts, meters: mm(built.hinge.totalLength / 1000) } }],
      ['info.pageBlock', `${mm(d.Wb)} × ${mm(d.Hb)} × ${mm(d.P)} mm`],
    ];
    if (hasDividers(p)) {
      info.push(
        ['info.gapsX', `${built.gapsX.map(mm).join(' : ')} mm`],
        ['info.gapsY', `${built.gapsY.map(mm).join(' : ')} mm`],
      );
    }
    info.push(['info.parts', String(built.parts.length)]);
    if (materialName) info.push(['info.material', materialName]);

    return {
      parts: built.parts,
      info,
      label: {
        code: 'label',
        values: { coverWidth: mm(d.Wc), coverHeight: mm(d.Hc), pageThickness: mm(d.P) },
      },
      labels,
      poses: { poses: built.poses },
      ...(!fitsWorkArea(built.parts) ? { distribute: { rotate: true } } : {}),
    };
  },
});
