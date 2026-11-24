// House Number Sign generator plugin for KizamuBeam.
// Creates modern layered 3D address signs with floating shadow-casting numbers on hidden spacers,
// 10 architectural board shapes, 6 vector outline fonts, 4 layouts, dual text lines,
// 8 decorative motifs, 6 dividers, 8 mounting systems, alignment pin holes, glue guides,
// multi-material page separation, and full 3D assembly preview.
import {
  circle,
  definePlugin,
  host,
  mm,
  type Change,
  type Issue,
  type Part,
  type Pose,
  type Pt,
  type SubPath,
  type Text,
} from '../../../sdk/ts';
import { applyStencilBridges } from './bridges';
import { buildCornerOrnaments, buildDivider, buildMotif } from './decor';
import {
  buildCharGlyph,
  getFontStrokeWidth,
  isSupportedOutlineChar,
  layoutOutlineString,
  measureOutlineString,
  type CharGlyph,
  type PlacedGlyph,
} from './fonts';
import {
  buildBoardContour,
  buildMountingHoles,
  shapeAutoPaddingExtra,
  type BoardSpec,
} from './shapes';
import { buildGlyphSpacer, findFlatGlyphPins } from './spacers';
import { buildStrokeText, strokeTextWidth } from './strokeFont';
import {
  bboxSubs,
  distToPoly,
  flattenSub,
  line,
  pointInPoly,
  polyline,
  reverseSub,
  translateSub,
  type SignParams,
} from './types';

function readMaterial(): { thickness: number; kerf: number | null; name: string | null } | null {
  const m = host.context('material');
  if (!m || m.thickness == null) return null;
  return { thickness: m.thickness, kerf: m.kerf, name: m.name };
}

function resolveMaterial(p: SignParams): {
  thickness: number;
  kerf: number;
  materialName: string | null;
  issues: Issue[];
} {
  const issues: Issue[] = [];
  if (!p.fromMaterial) {
    return { thickness: p.thickness, kerf: p.kerf, materialName: null, issues };
  }
  const m = readMaterial();
  if (!m) {
    issues.push({ key: 'fromMaterial', level: 'error', code: 'material-none' });
    return { thickness: p.thickness, kerf: p.kerf, materialName: null, issues };
  }
  if (Math.abs(m.thickness - p.thickness) > 1e-6 || (m.kerf != null && Math.abs(m.kerf - p.kerf) > 1e-6)) {
    issues.push({ key: 'fromMaterial', level: 'warn', code: 'material-changed', values: { thickness: m.thickness } });
  }
  if (m.kerf == null) {
    issues.push({ key: 'fromMaterial', level: 'warn', code: 'material-no-kerf', values: { kerf: p.kerf } });
  }
  return { thickness: m.thickness, kerf: m.kerf ?? p.kerf, materialName: m.name, issues };
}

interface NumberBlockLayout {
  width: number;
  height: number;
  glyphs: PlacedGlyph[];
  unsupportedCount: number;
}

/** Build the number glyphs centered around local (0, 0) for the chosen layout */
function layoutNumberBlock(p: SignParams): NumberBlockLayout {
  const raw = (p.number ?? '').trim();
  const gap = (p.charSpacing / 100) * p.numberHeight;
  const spaceW = p.numberHeight * 0.32;
  let unsupportedCount = 0;

  if (p.layout === 'row' || p.layout === 'splitLeft') {
    const items: Array<{ space: true; w: number } | { space: false; g: CharGlyph }> = [];
    for (const ch of raw) {
      if (ch === ' ') {
        items.push({ space: true, w: spaceW });
      } else {
        const g = buildCharGlyph(ch, p.font, p.boldness, p.numberHeight, true);
        if (g) items.push({ space: false, g });
        else unsupportedCount++;
      }
    }
    while (items.length && items[0].space) items.shift();
    while (items.length && items[items.length - 1].space) items.pop();

    let totalW = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.space) totalW += it.w;
      else {
        if (i > 0 && !items[i - 1].space) totalW += gap;
        totalW += it.g.width;
      }
    }
    let pen = -totalW / 2;
    const topY = -p.numberHeight / 2;
    const glyphs: PlacedGlyph[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.space) {
        pen += it.w;
        continue;
      }
      if (i > 0 && !items[i - 1].space) pen += gap;
      const cx = pen + it.g.width / 2;
      const cy = topY + it.g.yOffset + it.g.height / 2;
      glyphs.push({
        char: it.g.char,
        cx,
        cy,
        width: it.g.width,
        height: it.g.height,
        localSubs: it.g.subs,
        placedSubs: it.g.subs.map((s) => translateSub(s, cx, cy)),
      });
      pen += it.g.width;
    }
    return { width: totalW, height: p.numberHeight, glyphs, unsupportedCount };
  }

  // Filter non-space characters for `stack` and `diagonal`
  const chars: CharGlyph[] = [];
  for (const ch of raw) {
    if (ch === ' ') continue;
    const g = buildCharGlyph(ch, p.font, p.boldness, p.numberHeight, true);
    if (g) chars.push(g);
    else unsupportedCount++;
  }
  if (!chars.length) return { width: 0, height: 0, glyphs: [], unsupportedCount };

  if (p.layout === 'stack') {
    const maxW = Math.max(...chars.map((c) => c.width));
    const totalH = chars.reduce((s, c) => s + c.height, 0) + (chars.length - 1) * gap;
    let yPen = -totalH / 2;
    const glyphs: PlacedGlyph[] = [];
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      const cy = yPen + c.height / 2;
      glyphs.push({
        char: c.char,
        cx: 0,
        cy,
        width: c.width,
        height: c.height,
        localSubs: c.subs,
        placedSubs: c.subs.map((s) => translateSub(s, 0, cy)),
      });
      yPen += c.height + gap;
    }
    return { width: maxW, height: totalH, glyphs, unsupportedCount };
  }

  // `diagonal`: modern staggered staircase
  const stepY = p.numberHeight * 0.44;
  const rawPos: { g: CharGlyph; x: number; y: number }[] = [];
  let penX = 0;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const cx = penX + c.width / 2;
    const cy = i * stepY + c.yOffset + c.height / 2;
    rawPos.push({ g: c, x: cx, y: cy });
    penX += c.width * 0.72 + gap;
  }
  const x0 = Math.min(...rawPos.map((r) => r.x - r.g.width / 2));
  const x1 = Math.max(...rawPos.map((r) => r.x + r.g.width / 2));
  const y0 = Math.min(...rawPos.map((r) => r.y - r.g.height / 2));
  const y1 = Math.max(...rawPos.map((r) => r.y + r.g.height / 2));
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  const glyphs: PlacedGlyph[] = rawPos.map((r) => {
    const cx = r.x - mx;
    const cy = r.y - my;
    return {
      char: r.g.char,
      cx,
      cy,
      width: r.g.width,
      height: r.g.height,
      localSubs: r.g.subs,
      placedSubs: r.g.subs.map((s) => translateSub(s, cx, cy)),
    };
  });
  return { width: x1 - x0, height: y1 - y0, glyphs, unsupportedCount };
}

function measureTextLine(text: string, p: SignParams, height: number): number {
  if (!text) return 0;
  return p.textMode === 'engraveStroke'
    ? strokeTextWidth(text, height, p.textSpacing)
    : measureOutlineString(text, p.font, p.boldness, height, p.textSpacing, false);
}

interface Composition {
  W: number;
  H: number;
  contentW: number;
  contentH: number;
  boardSpec: BoardSpec;
  boardOuter: SubPath;
  numberGlyphs: PlacedGlyph[];
  unsupportedCount: number;
  streetPos: { text: string; x: number; y: number; h: number; align: 'left' | 'center' } | null;
  subtitlePos: { text: string; x: number; y: number; h: number; align: 'left' | 'center' } | null;
  dividers: { cx: number; cy: number; spanW: number; vertical?: boolean; centerGap?: number }[];
  motifPos: { cx: number; cy: number; size: number } | null;
}

/** Compute full 2D sign layout, dimensions, and element placements */
function computeComposition(p: SignParams): Composition {
  const numBlock = layoutNumberBlock(p);
  const street = (p.street ?? '').trim();
  const subtitle = (p.subtitle ?? '').trim();
  const hasStreet = street.length > 0;
  const hasSubtitle = subtitle.length > 0;
  const hasMotif = p.motif !== 'none';
  const streetH0 = p.streetHeight;
  const subH0 = Math.max(5, streetH0 * 0.78);
  const gapSection = Math.max(8, p.numberHeight * 0.14);
  const gapLines = Math.max(4, streetH0 * 0.42);

  // Determine inner padding requirement (respecting raised frame / engraved border)
  const framePad =
    p.frameStyle === 'raisedFrame'
      ? p.frameWidth + 8
      : p.frameStyle !== 'none'
        ? p.frameInset + 6
        : 0;
  const effPadX = Math.max(p.paddingX, framePad);
  const effPadY = Math.max(p.paddingY, framePad);

  // Measure nominal text widths
  const streetW0 = measureTextLine(street, p, streetH0);
  const subW0 = measureTextLine(subtitle, p, subH0);

  if (p.layout === 'splitLeft' && (hasStreet || hasSubtitle)) {
    // Side-by-side architectural plaque: number on left, vertical bar, text stacked on right
    const dividerGap = Math.max(12, p.numberHeight * 0.18);
    const maxTextColW = p.sizingMode === 'custom'
      ? Math.max(30, p.boardWidth - 2 * effPadX - numBlock.width - dividerGap * 2)
      : Math.max(80, Math.min(260, Math.max(streetW0, subW0)));

    const streetScale = streetW0 > maxTextColW && streetW0 > 0 ? maxTextColW / streetW0 : 1;
    const subScale = subW0 > maxTextColW && subW0 > 0 ? maxTextColW / subW0 : 1;
    const scaleT = Math.min(streetScale, subScale);
    const streetH = streetH0 * scaleT;
    const subH = subH0 * scaleT;
    const textColW = Math.max(measureTextLine(street, p, streetH), measureTextLine(subtitle, p, subH));
    const textColH = (hasStreet ? streetH : 0) + (hasSubtitle ? subH : 0) + (hasStreet && hasSubtitle ? gapLines : 0) + (hasMotif ? p.motifSize + gapLines : 0);

    const contentW = numBlock.width + dividerGap * 2 + textColW;
    const contentH = Math.max(numBlock.height, textColH);
    const extra = shapeAutoPaddingExtra(p.boardShape, contentW, contentH, p.roofPitch);

    const W = p.sizingMode === 'custom' ? p.boardWidth : contentW + 2 * (effPadX + extra.side);
    const H = p.sizingMode === 'custom' ? p.boardHeight : contentH + 2 * effPadY + extra.top + extra.bottom;
    const opticalDy = (extra.top - extra.bottom) * 0.32;

    const xLeft = -contentW / 2;
    const numCx = xLeft + numBlock.width / 2;
    const divX = xLeft + numBlock.width + dividerGap;
    const textX = divX + dividerGap;

    const numberGlyphs = numBlock.glyphs.map((g) => ({
      ...g,
      cx: g.cx + numCx,
      cy: g.cy + opticalDy,
      placedSubs: g.localSubs.map((s) => translateSub(s, g.cx + numCx, g.cy + opticalDy)),
    }));

    // Stack motif + street + subtitle vertically centered at opticalDy
    let yPen = opticalDy - textColH / 2;
    let motifPos: Composition['motifPos'] = null;
    if (hasMotif && p.motifPosition === 'top') {
      motifPos = { cx: textX + textColW / 2, cy: yPen + p.motifSize / 2, size: p.motifSize };
      yPen += p.motifSize + gapLines;
    }
    const streetPos = hasStreet
      ? { text: street, x: textX, y: yPen + streetH / 2, h: streetH, align: 'left' as const }
      : null;
    if (hasStreet) yPen += streetH + (hasSubtitle ? gapLines : 0);
    const subtitlePos = hasSubtitle
      ? { text: subtitle, x: textX, y: yPen + subH / 2, h: subH, align: 'left' as const }
      : null;
    if (hasSubtitle) yPen += subH;
    if (hasMotif && p.motifPosition !== 'top') {
      motifPos = { cx: textX + textColW / 2, cy: yPen + gapLines + p.motifSize / 2, size: p.motifSize };
    }

    const dividers: Composition['dividers'] =
      p.dividerStyle !== 'none'
        ? [{ cx: divX, cy: opticalDy, spanW: Math.min(contentH * 0.85, H - 2 * effPadY), vertical: true }]
        : [];

    const boardSpec: BoardSpec = { shape: p.boardShape, W, H, cornerRadius: p.cornerRadius, roofPitch: p.roofPitch };
    const boardOuter = buildBoardContour(boardSpec, 0)!;
    return {
      W,
      H,
      contentW,
      contentH,
      boardSpec,
      boardOuter,
      numberGlyphs,
      unsupportedCount: numBlock.unsupportedCount,
      streetPos,
      subtitlePos,
      dividers,
      motifPos,
    };
  }

  // Vertical stacked composition (`row`, `stack`, `diagonal`, or `splitLeft` without text)
  const capAutoTextW = Math.max(numBlock.width * 1.15, 160);
  const customMaxTextW = p.sizingMode === 'custom' ? Math.max(30, p.boardWidth - 2 * effPadX - 10) : capAutoTextW;
  const maxAllowedW = p.sizingMode === 'custom' ? customMaxTextW : Math.max(numBlock.width * 1.35, 180);

  const streetH = streetW0 > maxAllowedW && streetW0 > 0 ? streetH0 * (maxAllowedW / streetW0) : streetH0;
  const subH = subW0 > maxAllowedW && subW0 > 0 ? subH0 * (maxAllowedW / subW0) : subH0;
  const streetW = measureTextLine(street, p, streetH);
  const subW = measureTextLine(subtitle, p, subH);

  type Band =
    | { kind: 'motif'; h: number; w: number }
    | { kind: 'street'; h: number; w: number }
    | { kind: 'subtitle'; h: number; w: number }
    | { kind: 'number'; h: number; w: number }
    | { kind: 'divider'; h: number; w: number; withMotif: boolean };

  const bands: Band[] = [];
  const divH = p.dividerStyle !== 'none' ? Math.max(6, p.numberHeight * 0.08) : 0;
  const motifInDiv = hasMotif && p.motifPosition === 'divider';

  if (hasMotif && p.motifPosition === 'top') {
    bands.push({ kind: 'motif', h: p.motifSize, w: p.motifSize * 1.4 });
  }

  if (p.textPosition === 'top') {
    if (hasStreet) bands.push({ kind: 'street', h: streetH, w: streetW });
    if (hasSubtitle) bands.push({ kind: 'subtitle', h: subH, w: subW });
    if ((hasStreet || hasSubtitle) && (p.dividerStyle !== 'none' || motifInDiv)) {
      bands.push({ kind: 'divider', h: motifInDiv ? Math.max(divH, p.motifSize) : divH, w: Math.max(numBlock.width, streetW), withMotif: motifInDiv });
    }
    bands.push({ kind: 'number', h: numBlock.height, w: numBlock.width });
  } else if (p.textPosition === 'split') {
    if (hasStreet) {
      bands.push({ kind: 'street', h: streetH, w: streetW });
      if (p.dividerStyle !== 'none') {
        bands.push({ kind: 'divider', h: divH, w: Math.max(numBlock.width, streetW), withMotif: false });
      }
    }
    bands.push({ kind: 'number', h: numBlock.height, w: numBlock.width });
    if (hasSubtitle || motifInDiv) {
      if (p.dividerStyle !== 'none' || motifInDiv) {
        bands.push({ kind: 'divider', h: motifInDiv ? Math.max(divH, p.motifSize) : divH, w: Math.max(numBlock.width, subW), withMotif: motifInDiv });
      }
      if (hasSubtitle) bands.push({ kind: 'subtitle', h: subH, w: subW });
    }
  } else {
    // Classic `bottom`
    bands.push({ kind: 'number', h: numBlock.height, w: numBlock.width });
    if (hasStreet || hasSubtitle || motifInDiv) {
      if (p.dividerStyle !== 'none' || motifInDiv) {
        bands.push({ kind: 'divider', h: motifInDiv ? Math.max(divH, p.motifSize) : divH, w: Math.max(numBlock.width, streetW, subW), withMotif: motifInDiv });
      }
      if (hasStreet) bands.push({ kind: 'street', h: streetH, w: streetW });
      if (hasSubtitle) bands.push({ kind: 'subtitle', h: subH, w: subW });
    }
  }

  if (hasMotif && p.motifPosition === 'bottom') {
    bands.push({ kind: 'motif', h: p.motifSize, w: p.motifSize * 1.4 });
  }

  // Calculate total vertical height with smart inter-band gaps
  const bandGap = (a: Band, b: Band): number => {
    if ((a.kind === 'street' && b.kind === 'subtitle') || (a.kind === 'subtitle' && b.kind === 'street')) return gapLines;
    if (a.kind === 'divider' || b.kind === 'divider') return gapSection * 0.55;
    if (a.kind === 'motif' || b.kind === 'motif') return gapSection * 0.72;
    return gapSection;
  };

  let contentH = 0;
  let contentW = 0;
  for (let i = 0; i < bands.length; i++) {
    contentH += bands[i].h;
    if (bands[i].w > contentW) contentW = bands[i].w;
    if (i > 0) contentH += bandGap(bands[i - 1], bands[i]);
  }

  const extra = shapeAutoPaddingExtra(p.boardShape, contentW, contentH, p.roofPitch);
  const W = p.sizingMode === 'custom' ? p.boardWidth : contentW + 2 * (effPadX + extra.side);
  const H = p.sizingMode === 'custom' ? p.boardHeight : contentH + 2 * effPadY + extra.top + extra.bottom;
  const opticalDy = (extra.top - extra.bottom) * 0.34;

  let yPen = opticalDy - contentH / 2;
  let numberGlyphs: PlacedGlyph[] = [];
  let streetPos: Composition['streetPos'] = null;
  let subtitlePos: Composition['subtitlePos'] = null;
  const dividers: Composition['dividers'] = [];
  let motifPos: Composition['motifPos'] = null;

  for (let i = 0; i < bands.length; i++) {
    if (i > 0) yPen += bandGap(bands[i - 1], bands[i]);
    const b = bands[i];
    const cy = yPen + b.h / 2;
    if (b.kind === 'number') {
      numberGlyphs = numBlock.glyphs.map((g) => ({
        ...g,
        cy: g.cy + cy,
        placedSubs: g.localSubs.map((s) => translateSub(s, g.cx, g.cy + cy)),
      }));
    } else if (b.kind === 'street') {
      streetPos = { text: street, x: 0, y: cy, h: streetH, align: 'center' };
    } else if (b.kind === 'subtitle') {
      subtitlePos = { text: subtitle, x: 0, y: cy, h: subH, align: 'center' };
    } else if (b.kind === 'motif') {
      motifPos = { cx: 0, cy, size: p.motifSize };
    } else if (b.kind === 'divider') {
      const spanW = Math.min(Math.max(b.w, W * 0.52), W - 2 * effPadX - 8);
      if (b.withMotif) {
        motifPos = { cx: 0, cy, size: p.motifSize };
      }
      if (p.dividerStyle !== 'none') {
        dividers.push({ cx: 0, cy, spanW, centerGap: b.withMotif ? p.motifSize * 1.45 : 0 });
      }
    }
    yPen += b.h;
  }

  const boardSpec: BoardSpec = { shape: p.boardShape, W, H, cornerRadius: p.cornerRadius, roofPitch: p.roofPitch };
  const boardOuter = buildBoardContour(boardSpec, 0)!;
  return {
    W,
    H,
    contentW,
    contentH,
    boardSpec,
    boardOuter,
    numberGlyphs,
    unsupportedCount: numBlock.unsupportedCount,
    streetPos,
    subtitlePos,
    dividers,
    motifPos,
  };
}

/** Build subtle 4-corner L-tick glue marks around a glyph bounding box */
function buildCornerTicks(subs: SubPath[], tickLen = 4): SubPath[] {
  const bb = bboxSubs(subs, 8);
  const len = Math.min(tickLen, bb.w * 0.28, bb.h * 0.28);
  if (len < 1) return [];
  return [
    polyline([[bb.x0, bb.y0 + len], [bb.x0, bb.y0], [bb.x0 + len, bb.y0]]),
    polyline([[bb.x1 - len, bb.y0], [bb.x1, bb.y0], [bb.x1, bb.y0 + len]]),
    polyline([[bb.x1, bb.y1 - len], [bb.x1, bb.y1], [bb.x1 - len, bb.y1]]),
    polyline([[bb.x0 + len, bb.y1], [bb.x0, bb.y1], [bb.x0, bb.y1 - len]]),
  ];
}

function flatPose(cx: number, cy: number, z: number): Pose {
  return { o: [cx, -cy, z], u: [1, 0, 0], v: [0, -1, 0], n: [0, 0, 1] };
}

function applyKerf(subs: SubPath[], kerf: number): SubPath[] {
  if (kerf <= 1e-4) return subs;
  const out = host.offset({ subs, delta: kerf / 2, join: 'round' });
  return out.length ? out : subs;
}

definePlugin<SignParams>({
  onChange({ key, params }) {
    if (key === 'fromMaterial' && params.fromMaterial) {
      const m = readMaterial();
      if (!m) return null;
      const patch: Record<string, number> = { thickness: m.thickness };
      if (m.kerf != null) patch.kerf = m.kerf;
      return { patch };
    }
    return null;
  },

  validate(p) {
    const out: Issue[] = [];
    const mat = resolveMaterial(p);
    out.push(...mat.issues);

    const rawNum = (p.number ?? '').trim();
    const validChars = [...rawNum].filter((c) => c !== ' ' && isSupportedOutlineChar(c));
    if (!validChars.length) {
      out.push({ key: 'number', level: 'error', code: 'number-empty' });
      return out;
    }
    if (validChars.length > 16) {
      out.push({ key: 'number', level: 'error', code: 'number-too-long', values: { max: 16 } });
      return out;
    }
    const unsupported = [...rawNum].filter((c) => c !== ' ' && !isSupportedOutlineChar(c));
    if (unsupported.length) {
      out.push({ key: 'number', level: 'warn', code: 'number-unsupported', values: { chars: unsupported.join(' ') } });
    }

    const comp = computeComposition(p);
    if (comp.W < 40 || comp.H < 30) {
      out.push({ key: 'boardWidth', level: 'error', code: 'board-too-small' });
    }

    if (p.sizingMode === 'custom') {
      const innerCheck = buildBoardContour(comp.boardSpec, 4);
      if (innerCheck) {
        const bPoly = flattenSub(innerCheck, 24);
        let overflow = false;
        for (const g of comp.numberGlyphs) {
          for (const s of g.placedSubs) {
            for (const pt of flattenSub(s, 6)) {
              if (!pointInPoly(bPoly, pt)) {
                overflow = true;
                break;
              }
            }
            if (overflow) break;
          }
          if (overflow) break;
        }
        if (overflow) {
          out.push({ key: 'boardWidth', level: 'warn', code: 'content-overflow' });
        }
      }
    }

    if (p.frameStyle === 'raisedFrame') {
      const frameInner = buildBoardContour(comp.boardSpec, p.frameWidth);
      if (!frameInner) {
        out.push({ key: 'frameWidth', level: 'error', code: 'frame-too-wide' });
      }
    }

    if (p.numberStyle === 'raisedSpaced') {
      const minStroke = getFontStrokeWidth(p.font, p.boldness, p.numberHeight);
      if (p.spacerInset >= minStroke * 0.48) {
        out.push({
          key: 'spacerInset',
          level: 'warn',
          code: 'spacer-inset-large',
          values: { max: mm(Math.max(0.5, minStroke * 0.42)) },
        });
      }
    }

    if (p.numberStyle === 'cutout') {
      if (p.numberHeight < 25) {
        out.push({ key: 'numberHeight', level: 'warn', code: 'cutout-small' });
      }
      if (p.bridgeWidth > p.numberHeight * 0.2) {
        out.push({ key: 'bridgeWidth', level: 'warn', code: 'bridge-wide' });
      }
    }

    if (p.mountType === 'keyhole1' || p.mountType === 'keyhole2') {
      if (p.keyholeShaftDia >= p.keyholeHeadDia * 0.85) {
        out.push({ key: 'keyholeShaftDia', level: 'error', code: 'keyhole-shaft-wide' });
      }
    }

    if (p.textMode === 'raised' && (comp.streetPos || comp.subtitlePos)) {
      const minH = Math.min(comp.streetPos?.h ?? Infinity, comp.subtitlePos?.h ?? Infinity);
      if (minH < 12) {
        out.push({ key: 'streetHeight', level: 'warn', code: 'raised-text-small' });
      }
    }

    // Check against machine work area when available
    const workArea = host.context('workArea');
    if (workArea) {
      const fits =
        (comp.W <= workArea.width && comp.H <= workArea.height) ||
        (comp.H <= workArea.width && comp.W <= workArea.height);
      if (!fits) {
        out.push({
          key: 'numberHeight',
          level: 'warn',
          code: 'exceeds-work-area',
          values: { w: mm(comp.W), h: mm(comp.H), aw: mm(workArea.width), ah: mm(workArea.height) },
        });
      }
    }

    return out;
  },

  generate(p) {
    const mat = resolveMaterial(p);
    const t = mat.thickness;
    const kerf = mat.kerf;
    const comp = computeComposition(p);
    const { W, H, boardSpec, boardOuter } = comp;

    const parts: Part[] = [];
    const labels: Record<string, Text> = {};
    const poses: Record<string, Pose> = {};

    const hasBackplate = p.numberStyle === 'cutout' ? p.cutoutBackplate : p.backplate;
    const isKeyholeMount = p.mountType === 'keyhole1' || p.mountType === 'keyhole2';
    const mountRes = buildMountingHoles(p, boardSpec, boardOuter);

    const pageBoard = 0;
    const pageFront = p.separatePages ? 1 : 0;
    const pageSpacer = p.separatePages ? 2 : 0;

    let z = 0;

    // -------------------------------------------------------- 1. Optional Backplate
    if (hasBackplate) {
      const bpSubs: SubPath[] = [boardOuter, ...mountRes.cuts];
      parts.push({
        key: 'backplate',
        subs: applyKerf(bpSubs, kerf),
        at: { x: 0, y: 0 },
        page: pageBoard,
      });
      labels.backplate = { code: 'part.backplate' };
      poses.backplate = flatPose(0, 0, z);
      z += t;
    }

    // -------------------------------------------------------- 2. Main Board (Front Plate)
    const boardSubs: SubPath[] = [boardOuter];
    const boardMarks: SubPath[] = [];

    // Concealed keyholes stay ONLY on backplate when a backplate is present
    if (!(hasBackplate && isKeyholeMount)) {
      boardSubs.push(...mountRes.cuts);
    }
    boardMarks.push(...mountRes.marks);

    // Engraved border frame
    if (p.frameStyle === 'engraveSingle' || p.frameStyle === 'engraveDouble') {
      const f1 = buildBoardContour(boardSpec, p.frameInset);
      if (f1) boardMarks.push(f1);
      if (p.frameStyle === 'engraveDouble') {
        const f2 = buildBoardContour(boardSpec, p.frameInset + Math.max(2.5, Math.min(4.5, Math.min(W, H) * 0.018)));
        if (f2) boardMarks.push(f2);
      }
    }

    // Corner ornaments
    if (p.cornerOrnaments !== 'none') {
      const hasCornerHoles = p.mountType === 'corners4' || p.mountType === 'standoff4' || p.mountType === 'triangle3';
      const holeClear = hasCornerHoles
        ? p.holeInset + (p.mountType === 'standoff4' ? p.holeDia * 1.35 : p.holeDia * 0.8) + 4
        : 12;
      const ornInset =
        p.frameStyle === 'raisedFrame'
          ? Math.max(p.frameWidth + 8, holeClear)
          : p.frameStyle !== 'none'
            ? Math.max(p.frameInset + 8, holeClear)
            : Math.max(12, Math.min(holeClear, 28));
      boardMarks.push(...buildCornerOrnaments(p.cornerOrnaments, W, H, ornInset, boardOuter));
    }

    // Dividers
    for (const d of comp.dividers) {
      if (d.vertical) {
        const hh = d.spanW / 2;
        if (p.dividerStyle === 'double') {
          boardMarks.push(line(d.cx - 1.2, d.cy - hh, d.cx - 1.2, d.cy + hh), line(d.cx + 1.2, d.cy - hh, d.cx + 1.2, d.cy + hh));
        } else {
          boardMarks.push(line(d.cx, d.cy - hh, d.cx, d.cy + hh));
        }
      } else {
        boardMarks.push(...buildDivider(p.dividerStyle, d.cx, d.cy, d.spanW, d.centerGap ?? 0));
      }
    }

    // Motif
    if (comp.motifPos) {
      boardMarks.push(...buildMotif(p.motif, comp.motifPos.cx, comp.motifPos.cy, comp.motifPos.size));
    }

    // Street & subtitle text
    const raisedTextParts: { key: string; labelChar: string; glyph: PlacedGlyph; isSub: boolean; idx: number }[] = [];
    const emitTextLine = (
      lineInfo: { text: string; x: number; y: number; h: number; align: 'left' | 'center' } | null,
      isSub: boolean,
    ) => {
      if (!lineInfo) return;
      if (p.textMode === 'engraveStroke') {
        boardMarks.push(
          ...buildStrokeText(lineInfo.text, lineInfo.h, {
            x: lineInfo.x,
            y: lineInfo.y,
            align: lineInfo.align,
            valign: 'middle',
            spacingPct: p.textSpacing,
          }),
        );
      } else if (p.textMode === 'engraveOutline') {
        const res = layoutOutlineString(
          lineInfo.text,
          p.font,
          p.boldness,
          lineInfo.h,
          p.textSpacing,
          lineInfo.x,
          lineInfo.y,
          lineInfo.align,
          false,
        );
        boardMarks.push(...res.subs);
      } else {
        // `raised` text cut as separate letters glued onto board
        const res = layoutOutlineString(
          lineInfo.text,
          p.font,
          p.boldness,
          lineInfo.h,
          p.textSpacing,
          lineInfo.x,
          lineInfo.y,
          lineInfo.align,
          false,
        );
        res.glyphs.forEach((g, idx) => {
          raisedTextParts.push({
            key: `${isSub ? 'sub' : 'street'}_${idx + 1}`,
            labelChar: g.char,
            glyph: g,
            isSub,
            idx: idx + 1,
          });
          if (p.glueGuides === 'outline') {
            boardMarks.push(...g.placedSubs);
          } else if (p.glueGuides === 'corners') {
            boardMarks.push(...buildCornerTicks(g.placedSubs, 2.5));
          }
        });
      }
    };
    emitTextLine(comp.streetPos, false);
    emitTextLine(comp.subtitlePos, true);

    // Numbers: engrave, cutout, raisedFlat, or raisedSpaced
    const zBoard = z;
    const zBoardTop = z + t;
    let totalIslands = 0;
    let totalBridges = 0;
    let totalSpacers = 0;

    const deferredParts: Part[] = [];
    const deferredLabels: Record<string, Text> = {};
    const deferredPoses: Record<string, Pose> = {};

    if (p.numberStyle === 'engrave') {
      for (const g of comp.numberGlyphs) {
        boardMarks.push(...g.placedSubs);
      }
    } else if (p.numberStyle === 'cutout') {
      for (const g of comp.numberGlyphs) {
        const bridged = applyStencilBridges(g.placedSubs, p.bridgeWidth);
        totalIslands += bridged.islands;
        totalBridges += bridged.bridges;
        for (const s of bridged.subs) {
          boardSubs.push(reverseSub(s));
        }
      }
    } else {
      // `raisedSpaced` or `raisedFlat`
      const pinR = Math.max(0.4, p.pinDia / 2 - (kerf > 0 ? kerf / 2 : 0));

      comp.numberGlyphs.forEach((g, idx) => {
        const numIdx = idx + 1;
        let charPins: Pt[] = [];

        if (p.numberStyle === 'raisedSpaced') {
          const sp = buildGlyphSpacer(
            g.localSubs,
            p.spacerStyle,
            p.spacerInset,
            kerf,
            p.pinHoles,
            p.pinDia,
          );
          charPins = sp.pins;

          // Glue guides on the board (hidden completely underneath the raised number)
          if (p.glueGuides === 'outline') {
            if (p.spacerStyle === 'pegs') {
              for (const pc of sp.pegCenters) {
                boardMarks.push(circle(g.cx + pc.x, g.cy + pc.y, sp.pegRadius));
              }
            } else {
              for (const s of sp.subs) {
                boardMarks.push(translateSub(s, g.cx, g.cy));
              }
            }
          } else if (p.glueGuides === 'corners') {
            boardMarks.push(...buildCornerTicks(g.placedSubs, Math.max(3, p.numberHeight * 0.06)));
          }

          // Emit each stacked hidden spacer layer
          for (let layer = 1; layer <= p.spacerLayers; layer++) {
            const spKey = `spacer_${numIdx}_${layer}`;
            const spMarks: SubPath[] = [];
            if (p.partLabels && p.spacerStyle === 'insetGlyph') {
              const bb = bboxSubs(sp.subs, 6);
              const lblH = Math.max(2.6, Math.min(5.0, Math.min(bb.w, bb.h) * 0.16));
              // Place small label near centroid of first spacer contour
              const pts = flattenSub(sp.subs[0], 8);
              const mid = pts.reduce((acc, q) => ({ x: acc.x + q.x / pts.length, y: acc.y + q.y / pts.length }), { x: 0, y: 0 });
              if (pointInPoly(pts, mid) && distToPoly(pts, mid) > lblH * 0.5) {
                spMarks.push(...buildStrokeText(`${numIdx}.${layer}`, lblH, { x: mid.x, y: mid.y, align: 'center', valign: 'middle' }));
              }
            }
            deferredParts.push({
              key: spKey,
              subs: sp.subs,
              at: { x: 0, y: 0 },
              page: pageSpacer,
              ...(spMarks.length ? { marks: spMarks } : {}),
            });
            deferredLabels[spKey] = {
              code: 'part.spacer',
              values: { char: g.char, layer },
            };
            deferredPoses[spKey] = flatPose(g.cx, g.cy, zBoardTop + (layer - 1) * t);
            totalSpacers++;
          }
        } else {
          // `raisedFlat`
          if (p.pinHoles) {
            charPins = findFlatGlyphPins(g.localSubs, p.pinDia);
          }
          if (p.glueGuides === 'outline') {
            boardMarks.push(...g.placedSubs);
          } else if (p.glueGuides === 'corners') {
            boardMarks.push(...buildCornerTicks(g.placedSubs, Math.max(3, p.numberHeight * 0.06)));
          }
        }

        // Alignment pin holes cut cleanly through the board
        for (const pin of charPins) {
          boardSubs.push(reverseSub(circle(g.cx + pin.x, g.cy + pin.y, pinR)));
        }

        // Front raised number piece (pristine visible face, kerf-compensated)
        const numKey = `num_${numIdx}`;
        const numZ = p.numberStyle === 'raisedSpaced' ? zBoardTop + p.spacerLayers * t : zBoardTop;
        deferredParts.push({
          key: numKey,
          subs: applyKerf(g.localSubs, kerf),
          at: { x: 0, y: 0 },
          page: pageFront,
        });
        deferredLabels[numKey] = {
          code: 'part.number',
          values: { char: g.char, n: numIdx },
        };
        deferredPoses[numKey] = flatPose(g.cx, g.cy, numZ);
      });
    }

    // Add main board part
    parts.push({
      key: 'board',
      subs: applyKerf(boardSubs, kerf),
      at: { x: 0, y: 0 },
      page: pageBoard,
      ...(boardMarks.length ? { marks: boardMarks } : {}),
    });
    labels.board = { code: 'part.board' };
    poses.board = flatPose(0, 0, zBoard);

    // -------------------------------------------------------- 3. Optional Raised Frame Layer
    if (p.frameStyle === 'raisedFrame') {
      const frameInner = buildBoardContour(boardSpec, p.frameWidth);
      if (frameInner) {
        const frameSubs: SubPath[] = [boardOuter, reverseSub(frameInner)];
        // Cut mounting screw holes through raised frame too if they fall inside the frame rim
        if (!isKeyholeMount && mountRes.centers.length) {
          const innerPoly = flattenSub(frameInner, 24);
          const rHole = p.holeDia / 2;
          for (const c of mountRes.centers) {
            if (!pointInPoly(innerPoly, c)) {
              frameSubs.push(reverseSub(circle(c.x, c.y, rHole)));
            }
          }
        }
        parts.push({
          key: 'frame',
          subs: applyKerf(frameSubs, kerf),
          at: { x: 0, y: 0 },
          page: pageFront,
        });
        labels.frame = { code: 'part.frame' };
        poses.frame = flatPose(0, 0, zBoardTop);
      }
    }

    // -------------------------------------------------------- 4. Add Numbers, Spacers & Raised Text
    for (const pt of deferredParts) parts.push(pt);
    Object.assign(labels, deferredLabels);
    Object.assign(poses, deferredPoses);

    for (const rt of raisedTextParts) {
      parts.push({
        key: rt.key,
        subs: applyKerf(rt.glyph.localSubs, kerf),
        at: { x: 0, y: 0 },
        page: pageFront,
      });
      labels[rt.key] = {
        code: rt.isSub ? 'part.subtitleChar' : 'part.streetChar',
        values: { char: rt.labelChar, n: rt.idx },
      };
      poses[rt.key] = flatPose(rt.glyph.cx, rt.glyph.cy, zBoardTop);
    }

    // -------------------------------------------------------- 5. 2D Nesting per Page Group
    const pages = new Map<number, Part[]>();
    for (const pt of parts) {
      const pg = pt.page ?? 0;
      const list = pages.get(pg);
      if (list) list.push(pt);
      else pages.set(pg, [pt]);
    }
    for (const group of pages.values()) {
      const positions = host.nest({
        parts: group.map((pt) => ({ key: pt.key, subs: pt.subs })),
        gap: p.partGap,
      });
      group.forEach((pt, i) => {
        pt.at = { x: positions[i][0], y: positions[i][1] };
      });
    }

    // -------------------------------------------------------- 6. Info Table & Labels
    const standoffDepth = p.numberStyle === 'raisedSpaced' ? p.spacerLayers * t : 0;
    const totalDepth =
      (hasBackplate ? t : 0) +
      t +
      (p.numberStyle === 'raisedSpaced'
        ? (p.spacerLayers + 1) * t
        : p.numberStyle === 'raisedFlat' || p.frameStyle === 'raisedFrame' || raisedTextParts.length > 0
          ? t
          : 0);

    const info: [Text, Text][] = [
      ['info.size', { code: 'info.sizeValue', values: { w: mm(W), h: mm(H) } }],
      ['info.parts', String(parts.length)],
      ['info.depth', { code: 'info.mmValue', values: { v: mm(totalDepth) } }],
    ];
    if (p.numberStyle === 'raisedSpaced') {
      info.push([
        'info.standoff',
        { code: 'info.standoffValue', values: { d: mm(standoffDepth), n: totalSpacers } },
      ]);
    }
    if (p.numberStyle === 'cutout' && totalIslands > 0) {
      info.push(['info.bridges', { code: 'info.bridgesValue', values: { b: totalBridges, i: totalIslands } }]);
    }
    if (p.separatePages) {
      info.push(['info.pages', String(pages.size)]);
    }
    if (mat.materialName) {
      info.push(['info.material', mat.materialName]);
    }

    return {
      parts,
      info,
      labels,
      label: {
        code: 'label',
        values: {
          num: (p.number ?? '').trim(),
          w: mm(W),
          h: mm(H),
        },
      },
      poses: { poses },
      distribute: { rotate: false },
    };
  },
});
