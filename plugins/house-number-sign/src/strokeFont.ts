// Extended single-stroke engraving font for street names, subtitles, and hidden spacer labels.
// Grid: 4 wide × 6 tall (cap height), y pointing down. Includes German/European diacritics.
import type { SubPath } from '../../../sdk/ts';

const G: Record<string, string> = {
  '0': '1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0',
  '1': '1,1 2,0 2,6|1,6 3,6',
  '2': '0,1 1,0 3,0 4,1 4,2 0,6 4,6',
  '3': '0,0 4,0 2,2.5 3,2.5 4,3.5 4,5 3,6 1,6 0,5',
  '4': '3,6 3,0 0,4 4,4',
  '5': '4,0 0,0 0,2.5 3,2.5 4,3.5 4,5 3,6 0,6',
  '6': '3,0 1,0 0,1 0,5 1,6 3,6 4,5 4,3.5 3,2.5 0,2.5',
  '7': '0,0 4,0 1.5,6',
  '8': '3,3 1,3 0,4 0,5 1,6 3,6 4,5 4,4 3,3 4,2 4,1 3,0 1,0 0,1 0,2 1,3',
  '9': '4,3.5 1,3.5 0,2.5 0,1 1,0 3,0 4,1 4,5 3,6 1,6',
  A: '0,6 0,2 2,0 4,2 4,6|0,3.5 4,3.5',
  B: '0,3 3,3 4,4 4,5 3,6 0,6 0,0 3,0 4,1 4,2 3,3',
  C: '4,1 3,0 1,0 0,1 0,5 1,6 3,6 4,5',
  D: '0,0 0,6 2.5,6 4,4.5 4,1.5 2.5,0 0,0',
  E: '4,0 0,0 0,6 4,6|0,3 3,3',
  F: '4,0 0,0 0,6|0,3 3,3',
  G: '4,1 3,0 1,0 0,1 0,5 1,6 3,6 4,5 4,3.5 2,3.5',
  H: '0,0 0,6|4,0 4,6|0,3 4,3',
  I: '1,0 3,0|2,0 2,6|1,6 3,6',
  J: '4,0 4,5 3,6 1,6 0,5',
  K: '0,0 0,6|4,0 0,3.5|1.3,2.7 4,6',
  L: '0,0 0,6 4,6',
  M: '0,6 0,0 2,3 4,0 4,6',
  N: '0,6 0,0 4,6 4,0',
  O: '1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0',
  P: '0,6 0,0 3,0 4,1 4,2 3,3 0,3',
  Q: '1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0|2.5,4.5 4,6',
  R: '0,6 0,0 3,0 4,1 4,2 3,3 0,3|2,3 4,6',
  S: '4,1 3,0 1,0 0,1 0,2 1,3 3,3 4,4 4,5 3,6 1,6 0,5',
  T: '0,0 4,0|2,0 2,6',
  U: '0,0 0,5 1,6 3,6 4,5 4,0',
  V: '0,0 2,6 4,0',
  W: '0,0 1,6 2,3 3,6 4,0',
  X: '0,0 4,6|4,0 0,6',
  Y: '0,0 2,3 4,0|2,3 2,6',
  Z: '0,0 4,0 0,6 4,6',
  // German & European letters
  'Ä': '0,6 0,2 2,0 4,2 4,6|0,3.5 4,3.5|0.8,-1.1 1.4,-1.1 1.4,-0.5 0.8,-0.5 0.8,-1.1|2.6,-1.1 3.2,-1.1 3.2,-0.5 2.6,-0.5 2.6,-1.1',
  'Ö': '1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0|0.8,-1.1 1.4,-1.1 1.4,-0.5 0.8,-0.5 0.8,-1.1|2.6,-1.1 3.2,-1.1 3.2,-0.5 2.6,-0.5 2.6,-1.1',
  'Ü': '0,0 0,5 1,6 3,6 4,5 4,0|0.8,-1.1 1.4,-1.1 1.4,-0.5 0.8,-0.5 0.8,-1.1|2.6,-1.1 3.2,-1.1 3.2,-0.5 2.6,-0.5 2.6,-1.1',
  'ß': '0.3,6 0.3,1 1.2,0 2.8,0 3.7,0.9 3.7,1.9 2.7,2.8 1.6,2.8 3.1,3.3 4,4.2 4,5.1 3,6 1.5,6',
  'É': '4,0 0,0 0,6 4,6|0,3 3,3|1.6,-0.5 2.8,-1.4',
  'È': '4,0 0,0 0,6 4,6|0,3 3,3|1.2,-1.4 2.4,-0.5',
  'Ê': '4,0 0,0 0,6 4,6|0,3 3,3|1,-0.5 2,-1.4 3,-0.5',
  'Á': '0,6 0,2 2,0 4,2 4,6|0,3.5 4,3.5|1.6,-0.5 2.8,-1.4',
  'À': '0,6 0,2 2,0 4,2 4,6|0,3.5 4,3.5|1.2,-1.4 2.4,-0.5',
  'Â': '0,6 0,2 2,0 4,2 4,6|0,3.5 4,3.5|1,-0.5 2,-1.4 3,-0.5',
  'Å': '0,6 0,2 2,0 4,2 4,6|0,3.5 4,3.5|1.5,-1.2 2.5,-1.2 2.5,-0.3 1.5,-0.3 1.5,-1.2',
  'Ç': '4,1 3,0 1,0 0,1 0,5 1,6 3,6 4,5|2,6 2,6.8 1.3,7.2',
  'Ñ': '0,6 0,0 4,6 4,0|0.8,-0.7 1.6,-1.3 2.4,-0.7 3.2,-1.3',
  'Ó': '1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0|1.6,-0.5 2.8,-1.4',
  'Ò': '1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0|1.2,-1.4 2.4,-0.5',
  'Ô': '1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0|1,-0.5 2,-1.4 3,-0.5',
  'Ø': '1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0|0,6 4,0',
  'Ú': '0,0 0,5 1,6 3,6 4,5 4,0|1.6,-0.5 2.8,-1.4',
  'Ù': '0,0 0,5 1,6 3,6 4,5 4,0|1.2,-1.4 2.4,-0.5',
  'Û': '0,0 0,5 1,6 3,6 4,5 4,0|1,-0.5 2,-1.4 3,-0.5',
  'Í': '1,0 3,0|2,0 2,6|1,6 3,6|1.6,-0.5 2.8,-1.4',
  'Š': '4,1 3,0 1,0 0,1 0,2 1,3 3,3 4,4 4,5 3,6 1,6 0,5|1,-1.3 2,-0.5 3,-1.3',
  'Ž': '0,0 4,0 0,6 4,6|1,-1.3 2,-0.5 3,-1.3',
  'Č': '4,1 3,0 1,0 0,1 0,5 1,6 3,6 4,5|1,-1.3 2,-0.5 3,-1.3',
  'Ł': '0,0 0,6 4,6|-0.4,3.8 1.8,2.2',
  // Punctuation
  '-': '0.8,3 3.2,3',
  '–': '0.4,3 3.6,3',
  '+': '2,1.5 2,4.5|0.5,3 3.5,3',
  '.': '1.6,5.4 2.4,5.4 2.4,6 1.6,6 1.6,5.4',
  ',': '2.2,5.2 2.2,6 1.5,7',
  ':': '1.6,1.6 2.4,1.6 2.4,2.2 1.6,2.2 1.6,1.6|1.6,5.4 2.4,5.4 2.4,6 1.6,6 1.6,5.4',
  '/': '0,6 4,0',
  '&': '4,6 0.6,2.2 0.6,1 1.5,0 2.6,0 3.3,0.8 3.3,1.8 0.3,4.2 0.3,5.2 1.2,6 2.5,6 4,3.8',
  '#': '1.2,0.5 0.8,5.5|3.2,0.5 2.8,5.5|0.2,2.2 3.8,2.2|0,3.8 3.6,3.8',
  '°': '1,0 2.5,0 2.5,1.5 1,1.5 1,0',
  '"': '1.4,0 1.4,1.5|2.6,0 2.6,1.5',
  "'": '2,0 2,1.5',
  '(': '3,0 2,1 1.5,3 2,5 3,6',
  ')': '1,0 2,1 2.5,3 2,5 1,6',
  '!': '2,0 2,4|1.7,5.4 2.3,5.4 2.3,6 1.7,6 1.7,5.4',
};

const parsed = new Map<string, [number, number][][]>();

function lookupStrokeGlyph(ch: string): [number, number][][] {
  const key = ch === 'ß' ? 'ß' : G[ch] !== undefined ? ch : ch.toUpperCase();
  let g = parsed.get(key);
  if (!g) {
    const src = G[key];
    g = src
      ? src.split('|').map((s) => s.split(' ').map((p) => p.split(',').map(Number) as [number, number]))
      : [];
    parsed.set(key, g);
  }
  return g;
}

const NARROW = new Set(['.', ',', ':', "'", '1', 'I', '!', 'Í']);

function charAdvance(ch: string, spacingPct: number): number {
  const extra = ((spacingPct - 12) / 100) * 6;
  if (ch === ' ') return 3.6 + extra * 0.5;
  const base = NARROW.has(ch) ? 4.4 : 5.4;
  return Math.max(2.5, base + extra);
}

/** Width of single-stroke text in mm at cap height `size` */
export function strokeTextWidth(text: string, size: number, spacingPct = 12): number {
  if (!text) return 0;
  const u = size / 6;
  let w = 0;
  for (const ch of text) w += charAdvance(ch, spacingPct);
  const trail = Math.max(0, charAdvance('A', spacingPct) - 4);
  return Math.max(0, w - trail) * u;
}

export interface StrokeTextOpts {
  x?: number;
  y?: number;
  align?: 'left' | 'center' | 'right';
  valign?: 'top' | 'middle' | 'baseline';
  spacingPct?: number;
}

/** Render open single-stroke engraving lines for `text` at cap height `size` (mm) */
export function buildStrokeText(text: string, size: number, o: StrokeTextOpts = {}): SubPath[] {
  const spacingPct = o.spacingPct ?? 12;
  const u = size / 6;
  let lo = Infinity;
  let hi = -Infinity;
  let at = 0;
  for (const ch of text) {
    for (const stroke of lookupStrokeGlyph(ch)) {
      for (const [gx] of stroke) {
        if (at + gx < lo) lo = at + gx;
        if (at + gx > hi) hi = at + gx;
      }
    }
    at += charAdvance(ch, spacingPct);
  }
  if (lo > hi) lo = hi = 0;
  const dx = (o.align === 'center' ? -(lo + hi) / 2 : o.align === 'right' ? -hi : -lo) * u;
  const dy = o.valign === 'top' ? 0 : o.valign === 'middle' ? -size / 2 : -size;
  const x0 = o.x ?? 0;
  const y0 = o.y ?? 0;

  const out: SubPath[] = [];
  let pen = 0;
  for (const ch of text) {
    for (const stroke of lookupStrokeGlyph(ch)) {
      out.push({
        closed: false,
        nodes: stroke.map(([gx, gy]) => ({
          x: x0 + dx + (pen + gx) * u,
          y: y0 + dy + gy * u,
        })),
      });
    }
    pen += charAdvance(ch, spacingPct);
  }
  return out;
}
