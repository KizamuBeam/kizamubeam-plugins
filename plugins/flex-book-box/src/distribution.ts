// Compartment distribution parser and resizer, ported 1:1 from KizamuBeam's
// Finger Joint Box with Dividers (fingerbox-distribution.ts & fingerbox-resize.ts).
// Syntax: colon-separated expressions, either a ratio or a length in mm (e.g. "50mm:1:2").

export interface Distribution {
  gaps: number[];
  centres: number[];
}

type Quantity = { value: number; dimension: 0 | 1 };
const fail = (code: string): never => {
  throw new Error(code);
};

/** Safe arithmetic parser (+ - * /, parentheses, mm suffix) without eval */
function expression(source: string): Quantity {
  let i = 0;
  const text = source.replace(/\s+/g, '').toLowerCase();
  const skip = (s: string) => (text[i] === s ? (i++, true) : false);

  function primary(): Quantity {
    if (skip('+')) return primary();
    if (skip('-')) {
      const q = primary();
      return { ...q, value: -q.value };
    }
    if (skip('(')) {
      const q = sum();
      if (!skip(')')) fail('expr-bracket');
      return q;
    }
    const m = /^(?:\d+(?:[.,]\d*)?|[.,]\d+)/.exec(text.slice(i));
    if (!m) return fail('expr-invalid');
    i += m[0].length;
    const value = Number(m[0].replace(',', '.'));
    let dimension: 0 | 1 = 0;
    if (text.slice(i, i + 2) === 'mm') {
      i += 2;
      dimension = 1;
    }
    return { value, dimension };
  }

  function product(): Quantity {
    let q = primary();
    while (text[i] === '*' || text[i] === '/') {
      const op = text[i++];
      const right = primary();
      if (op === '/' && right.value === 0) fail('expr-div-zero');
      const dim = op === '*' ? q.dimension + right.dimension : q.dimension - right.dimension;
      if (dim !== 0 && dim !== 1) fail('expr-units');
      q = { value: op === '*' ? q.value * right.value : q.value / right.value, dimension: dim as 0 | 1 };
    }
    return q;
  }

  function sum(): Quantity {
    let q = product();
    while (text[i] === '+' || text[i] === '-') {
      const op = text[i++];
      const right = product();
      const dimension: 0 | 1 = q.dimension === 1 || right.dimension === 1 ? 1 : 0;
      q = { value: op === '+' ? q.value + right.value : q.value - right.value, dimension };
    }
    return q;
  }

  const result = sum();
  if (i !== text.length) fail('expr-invalid');
  if (!Number.isFinite(result.value) || result.value <= 0) fail('ratio-not-positive');
  return result;
}

export function defaultDistribution(compartments: number): string {
  if (!Number.isInteger(compartments) || compartments < 1 || compartments > 20) fail('compartments-range');
  return Array(compartments).fill('1').join(':');
}

/**
 * Compute clear compartment gaps and divider centre-line positions (measured from outer edge 0..outerLength).
 * Throws an error code string on invalid expressions or insufficient space.
 */
export function distributeGaps(
  outerLength: number,
  thickness: number,
  compartments: number,
  spec: string,
): Distribution {
  const fallback = defaultDistribution(compartments);
  if (!Number.isFinite(outerLength) || !Number.isFinite(thickness) || outerLength <= 0 || thickness <= 0) {
    fail('size-invalid');
  }
  if (spec.length > 2000) fail('input-too-long');
  const available = outerLength - 2 * thickness - (compartments - 1) * thickness;
  if (available <= 0) fail('no-space');

  const fields = (spec.trim() ? spec : fallback).split(':');
  if (fields.length !== compartments) fail('ratio-count');

  const parsed = fields.map(expression);
  const fixed = parsed.reduce((acc, q) => acc + (q.dimension === 1 ? q.value : 0), 0);
  const weight = parsed.reduce((acc, q) => acc + (q.dimension === 0 ? q.value : 0), 0);
  if (!Number.isFinite(fixed) || !Number.isFinite(weight)) fail('ratio-too-large');

  const rest = available - fixed;
  const eps = 1e-9 * Math.max(1, available);
  if (weight > 0 && rest <= 0) fail('fixed-no-space');
  if (weight === 0 && Math.abs(rest) > eps) fail('fixed-mismatch');

  const gaps = parsed.map((q) => (q.dimension === 1 ? q.value : rest * (q.value / weight)));
  if (gaps.some((g) => !Number.isFinite(g) || g <= 0)) fail('gap-not-positive');

  const centres: number[] = [];
  let pos = thickness;
  for (let i = 0; i < gaps.length - 1; i++) {
    pos += gaps[i];
    centres.push(pos + thickness / 2);
    pos += thickness;
  }
  return { gaps, centres };
}

/**
 * Resize a complete user distribution when compartment count changes.
 * Returns null if the existing text is empty or incomplete (leaves it untouched for user correction).
 */
export function resizeDistribution(
  spec: string,
  oldCount: number,
  count: number,
): { text: string; removed: string[] } | null {
  if (!spec || !Number.isInteger(oldCount) || !Number.isInteger(count) || count < 1 || count > 20) return null;
  const fields = spec.split(':');
  if (fields.length !== oldCount || fields.some((v) => !v.trim())) return null;
  const removed = fields.slice(count).filter((v) => v.trim() !== '1');
  const fieldsNew = fields.slice(0, count);
  while (fieldsNew.length < count) fieldsNew.push('1');
  return { text: fieldsNew.join(':'), removed };
}
