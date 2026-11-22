// Analog Clock Generator for KizamuBeam: generates multi-layer laser-cut analog clocks in 10 shapes,
// with optional backplate, optional stackable spacer rings, 7 dial styles, 6 selectable vector fonts,
// engraved or cut-out numerals with automatic stencil bridges, configurable ticks, and 8 clock hand designs.
// Coordinates are mm, y down; origin (0, 0) at part centre.
import {
  circle,
  definePlugin,
  host,
  mm,
  roundedRect,
  strokeText,
  type Issue,
  type Node,
  type Part,
  type Pose,
  type SubPath,
  type Text,
} from '../../../sdk/ts';
import { applyStencilBridges } from './bridges';
import { buildNumeralGlyphsLocal, buildStrokeNumeral, numeralTextWidth } from './fonts';
import { buildClockHands } from './hands';
import { buildClockGeometry, circleArcNodes, keyholePath, type ClockGeometry } from './shapes';
import { buildTicks } from './ticks';
import {
  HAS_NUMERALS_STYLE,
  reverseSub,
  transformSub,
  translateSub,
  type ClockParams,
  type DialStyle,
} from './types';

const ARABIC_ALL = ['12', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'];
const ROMAN_ALL = ['XII', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI'];

interface NumeralEntry {
  hourIndex: number; // 0 = 12 o'clock, 1..11 = 1..11 o'clock
  text: string;
}

function getNumerals(style: DialStyle): NumeralEntry[] {
  if (style === 'classic' || style === 'skeleton') {
    return ARABIC_ALL.map((text, hourIndex) => ({ hourIndex, text }));
  }
  if (style === 'quarters') {
    return [0, 3, 6, 9].map((hourIndex) => ({ hourIndex, text: ARABIC_ALL[hourIndex] }));
  }
  if (style === 'roman') {
    return ROMAN_ALL.map((text, hourIndex) => ({ hourIndex, text }));
  }
  if (style === 'romanQuarters') {
    return [0, 3, 6, 9].map((hourIndex) => ({ hourIndex, text: ROMAN_ALL[hourIndex] }));
  }
  return [];
}

/** Build skeleton annular sector windows around (cx, cy) with uniform spoke width */
function buildSkeletonWindows(
  cx: number,
  cy: number,
  rInner: number,
  rOuter: number,
  spokes: number,
  spokeWidth: number,
): SubPath[] {
  const out: SubPath[] = [];
  if (rOuter - rInner < 5 || spokes < 3) return out;
  const sector = (2 * Math.PI) / spokes;
  const halfW = spokeWidth / 2;
  if (halfW >= rInner * 0.85 || halfW >= rOuter * 0.85) return out;
  const daIn = Math.asin(halfW / rInner);
  const daOut = Math.asin(halfW / rOuter);
  if (sector - 2 * daIn < 0.08 || sector - 2 * daOut < 0.08) return out;

  for (let i = 0; i < spokes; i++) {
    const aStart = i * sector - Math.PI / 2;
    const aEnd = (i + 1) * sector - Math.PI / 2;
    const outerArc = circleArcNodes(cx, cy, rOuter, aStart + daOut, aEnd - daOut);
    const innerArc = circleArcNodes(cx, cy, rInner, aEnd - daIn, aStart + daIn);
    const nodes: Node[] = [];
    for (let k = 0; k < outerArc.length; k++) {
      const nd = { ...outerArc[k] };
      if (k === 0) nd.cin = undefined;
      if (k === outerArc.length - 1) nd.cout = undefined;
      nodes.push(nd);
    }
    for (let k = 0; k < innerArc.length; k++) {
      const nd = { ...innerArc[k] };
      if (k === 0) nd.cin = undefined;
      if (k === innerArc.length - 1) nd.cout = undefined;
      nodes.push(nd);
    }
    out.push(reverseSub({ closed: true, nodes }));
  }
  return out;
}

/** Compute the skeleton window outer radius so windows clear numerals, ticks, and hub cleanly */
function skeletonOuterRadius(p: ClockParams, geom: ClockGeometry): number {
  const rNumeral = (geom.dialMaxRadius * p.numeralRadiusPct) / 100;
  const rNumInner = rNumeral - p.numeralSize * 0.62 - 4;
  const rTickInner =
    p.tickMode !== 'none'
      ? geom.dialMaxRadius - p.tickInset - p.hourTickLength * (p.quarterAccent ? 1.22 : 1.0) - 4
      : geom.dialMaxRadius - 12;
  return Math.min(rNumInner, rTickInner);
}

/** Compute safe Y position for a top keyhole hanger on the backplate, or null if no room */
function keyholeY(p: ClockParams, geom: ClockGeometry): number | null {
  const halfKeyH = 9; // keyhole spans [cy - 7.75, cy + 9.0]
  // Top boundary: stay inside spacer ring opening if rings are present (so nail sits inside cavity), else stay below outer edge
  const topLimit = p.ringCount > 0 ? geom.topY + p.ringWidth + 5 + 8 : geom.topY + 12 + 8;
  // Bottom boundary: stay above movement cutout or shaft hole
  let botLimit: number;
  if (p.backplateCenter === 'movement') {
    botLimit = geom.dialCy - p.movementSize / 2 - 5 - halfKeyH;
  } else if (p.backplateCenter === 'shaft') {
    botLimit = geom.dialCy - p.shaftDia / 2 - 6 - halfKeyH;
  } else {
    botLimit = geom.dialCy - 10;
  }
  if (topLimit <= botLimit) {
    // Place near the top of the available cavity for stable hanging balance
    return Math.min(botLimit, topLimit + Math.min(10, (botLimit - topLimit) * 0.25));
  }
  // Fallback: if ring cavity is tight, place above the center hole if outer edge allows
  const fallbackTop = geom.topY + 11 + 8;
  if (fallbackTop <= botLimit) return (fallbackTop + botLimit) / 2;
  return null;
}

/** 3D pose for a clock hand rotated clockwise by `angleDeg` from 12 o'clock at height `z` */
function handPose(cx: number, cy: number, z: number, angleDeg: number): Pose {
  const a = (angleDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return {
    o: [cx, -cy, z],
    u: [c, -s, 0],
    v: [-s, -c, 0],
    n: [0, 0, 1],
  };
}

definePlugin<ClockParams>({
  validate(p) {
    const out: Issue[] = [];
    const geom = buildClockGeometry(p);
    const R = geom.dialMaxRadius;

    if (p.shape === 'arch' && p.height < p.width * 0.55) {
      out.push({ key: 'height', level: 'error', code: 'arch-too-short', values: { min: Math.ceil(p.width * 0.55) } });
    }

    if (p.shaftDia >= R * 0.7) {
      out.push({ key: 'shaftDia', level: 'error', code: 'shaft-too-large', values: { max: Math.floor(R * 0.7) } });
    }

    if (p.ringCount > 0 && p.ringWidth >= geom.minHalfDim - 6) {
      out.push({ key: 'ringWidth', level: 'error', code: 'ring-too-wide', values: { max: Math.floor(geom.minHalfDim - 6) } });
    }

    if (p.backplate && p.backplateCenter === 'movement') {
      const maxMov = Math.floor(2 * (R - 6));
      if (p.movementSize > maxMov) {
        out.push({ key: 'movementSize', level: 'error', code: 'movement-too-large', values: { max: maxMov } });
      } else if (p.ringCount > 0 && (p.movementSize / 2) * Math.SQRT2 > geom.minHalfDim - p.ringWidth - 1) {
        out.push({ key: 'movementSize', level: 'warn', code: 'movement-touches-ring' });
      }
    }

    if (p.tickMode !== 'none') {
      const maxTickLen = R - p.tickInset - p.shaftDia / 2 - 2;
      if (p.hourTickLength >= maxTickLen) {
        out.push({ key: 'hourTickLength', level: 'error', code: 'ticks-too-long' });
      }
      if (p.tickStyle === 'cutout' && p.hourTickWidth < 1.2) {
        out.push({ key: 'hourTickWidth', level: 'warn', code: 'tick-cutout-thin' });
      }
    }

    if (HAS_NUMERALS_STYLE.has(p.dialStyle)) {
      const rNum = (R * p.numeralRadiusPct) / 100;
      const outerReach = rNum + p.numeralSize * 0.55;
      const innerReach = rNum - p.numeralSize * 0.55;
      if (outerReach > R - 2) {
        out.push({ key: 'numeralRadiusPct', level: 'error', code: 'numerals-outside' });
      }
      if (innerReach < p.shaftDia / 2 + 2) {
        out.push({ key: 'numeralRadiusPct', level: 'error', code: 'numerals-hit-shaft' });
      }
      if (p.tickMode !== 'none') {
        const tickInner = R - p.tickInset - p.hourTickLength * (p.quarterAccent ? 1.22 : 1.0);
        if (outerReach > tickInner + 1 && outerReach <= R - 2) {
          out.push({ key: 'numeralRadiusPct', level: 'warn', code: 'ticks-overlap-numerals' });
        }
      }
      if (p.numeralMode === 'cutout') {
        if (p.numeralSize < 12) {
          out.push({ key: 'numeralSize', level: 'warn', code: 'cutout-numerals-small' });
        }
        if (p.bridgeWidth > p.numeralSize * 0.25) {
          out.push({ key: 'bridgeWidth', level: 'warn', code: 'bridge-wide' });
        }
      }
    }

    if (p.dialStyle === 'skeleton') {
      const rHub = Math.max(p.skeletonHubDia / 2, p.shaftDia / 2 + 4);
      const rOut = skeletonOuterRadius(p, geom);
      if (rOut - rHub < 6) {
        out.push({ key: 'skeletonHubDia', level: 'error', code: 'skeleton-too-tight' });
      }
    }

    if (p.includeHands) {
      if (p.hourHoleDia > R * 0.4) {
        out.push({ key: 'hourHoleDia', level: 'error', code: 'shaft-too-large', values: { max: Math.floor(R * 0.4) } });
      }
      if (p.minuteHoleDia > R * 0.4) {
        out.push({ key: 'minuteHoleDia', level: 'error', code: 'shaft-too-large', values: { max: Math.floor(R * 0.4) } });
      }
    }

    return out;
  },

  generate(p) {
    const geom = buildClockGeometry(p);
    const { dialCx: cx, dialCy: cy, dialMaxRadius: R } = geom;
    const parts: Part[] = [];
    const labels: Record<string, Text> = {};
    const poses: Record<string, Pose> = {};
    let z = 0;
    const layerPose = (zPos: number): Pose => ({ o: [0, 0, zPos], u: [1, 0, 0], v: [0, -1, 0], n: [0, 0, 1] });

    // -------------------------------------------------------- 1. Backplate (optional)
    if (p.backplate) {
      const subs: SubPath[] = [geom.outer];
      const marks: SubPath[] = [];

      if (p.backplateCenter === 'shaft') {
        subs.push(reverseSub(circle(cx, cy, p.shaftDia / 2)));
      } else if (p.backplateCenter === 'movement') {
        subs.push(translateSub(reverseSub(roundedRect(p.movementSize, p.movementSize, 2)), cx, cy));
      }

      if (p.hangerHole) {
        const ky = keyholeY(p, geom);
        if (ky !== null) {
          subs.push(reverseSub(keyholePath(0, ky)));
        }
      }

      if (p.glueMarks) {
        if (p.ringCount > 0) {
          const inner = geom.innerForRing(p.ringWidth);
          if (inner) marks.push(inner);
        }
        // Subtle alignment crosshair + layer number at bottom
        const yMark = geom.topY + geom.outerHeight - Math.min(10, p.ringCount > 0 ? p.ringWidth / 2 : 10);
        marks.push(...strokeText('B', 4, { x: 0, y: yMark, align: 'center', valign: 'middle' }));
      }

      parts.push({ key: 'backplate', subs, at: { x: 0, y: 0 }, ...(marks.length ? { marks } : {}) });
      labels.backplate = { code: 'part.backplate' };
      poses.backplate = layerPose(z);
      z += p.thickness;
    }

    // -------------------------------------------------------- 2. Spacer Rings (optional, 0..10)
    const ringInner = p.ringCount > 0 ? geom.innerForRing(p.ringWidth) : null;
    for (let i = 0; i < p.ringCount; i++) {
      const key = `ring${i + 1}`;
      const subs: SubPath[] = [geom.outer];
      if (ringInner) subs.push(ringInner);
      const marks: SubPath[] = [];
      if (p.glueMarks) {
        const yMark = geom.topY + geom.outerHeight - Math.min(p.ringWidth / 2, 10);
        const hTxt = Math.min(5, Math.max(2.5, p.ringWidth * 0.45));
        marks.push(...strokeText(`R${i + 1}`, hTxt, { x: 0, y: yMark, align: 'center', valign: 'middle' }));
      }
      parts.push({ key, subs, at: { x: 0, y: 0 }, ...(marks.length ? { marks } : {}) });
      labels[key] = { code: 'part.ring', values: { n: i + 1 } };
      poses[key] = layerPose(z);
      z += p.thickness;
    }

    // -------------------------------------------------------- 3. Dial (always generated)
    const dialSubs: SubPath[] = [geom.outer, reverseSub(circle(cx, cy, p.shaftDia / 2))];
    const dialMarks: SubPath[] = [];

    // Skeleton openwork windows
    if (p.dialStyle === 'skeleton') {
      const rHub = Math.max(p.skeletonHubDia / 2, p.shaftDia / 2 + 4);
      const rOut = skeletonOuterRadius(p, geom);
      const spokeW = Math.max(5.5, R * 0.065);
      dialSubs.push(...buildSkeletonWindows(cx, cy, rHub, rOut, p.skeletonSpokes, spokeW));
      // Decorative engraved ring around hub (thin annular band, safe on both Line and Fill layers)
      const rAccent = rHub - 1.5;
      if (rAccent - 0.35 > p.shaftDia / 2 + 1) {
        dialMarks.push(circle(cx, cy, rAccent + 0.35), reverseSub(circle(cx, cy, rAccent - 0.35)));
      }
    }

    // Tick marks & chapter ring
    const tickRes = buildTicks(p, cx, cy, R);
    dialMarks.push(...tickRes.marks);
    dialSubs.push(...tickRes.cuts);

    // Numerals (engraved or cut-out with automatic stencil bridges)
    const numerals = getNumerals(p.dialStyle);
    let totalIslands = 0;
    let totalBridges = 0;

    if (numerals.length > 0) {
      const rNum = (R * p.numeralRadiusPct) / 100;
      const isSingleStroke = p.numeralMode === 'engraveStroke';
      const isCutout = p.numeralMode === 'cutout';

      // Fit check so wide Roman numerals like VIII never crash into neighbours
      const maxArcGap = ((2 * Math.PI * rNum) / Math.max(4, numerals.length)) * 0.85;
      const widest = Math.max(...numerals.map((e) => numeralTextWidth(e.text, p.numeralSize, p.font, isSingleStroke)));
      const effectiveSize = widest > maxArcGap && widest > 0 ? (p.numeralSize * maxArcGap) / widest : p.numeralSize;

      for (const entry of numerals) {
        const angleRad = (entry.hourIndex * Math.PI) / 6; // 0 = 12 o'clock (-y), clockwise
        const nx = cx + rNum * Math.sin(angleRad);
        const ny = cy - rNum * Math.cos(angleRad);
        // Optional radial rotation (keep lower numerals upright-ish or purely radial)
        const rotRad = p.rotateNumerals ? angleRad : 0;
        const rotDeg = (rotRad * 180) / Math.PI;

        if (isSingleStroke) {
          dialMarks.push(...buildStrokeNumeral(entry.text, effectiveSize, nx, ny, rotDeg));
        } else {
          const perGlyph = buildNumeralGlyphsLocal(entry.text, effectiveSize, p.font);
          for (const gSubs of perGlyph) {
            if (isCutout) {
              const bridged = applyStencilBridges(gSubs, p.bridgeWidth, p.bridgeCount, p.bridgeDirection);
              totalIslands += bridged.islands;
              totalBridges += bridged.bridges;
              for (const s of bridged.subs) {
                dialSubs.push(transformSub(s, nx, ny, 1, rotRad));
              }
            } else {
              for (const s of gSubs) {
                dialMarks.push(transformSub(s, nx, ny, 1, rotRad));
              }
            }
          }
        }
      }
    }

    parts.push({ key: 'dial', subs: dialSubs, at: { x: 0, y: 0 }, ...(dialMarks.length ? { marks: dialMarks } : {}) });
    labels.dial = { code: 'part.dial' };
    poses.dial = layerPose(z);
    z += p.thickness;

    // -------------------------------------------------------- 4. Clock Hands (optional)
    let handsInfo: ReturnType<typeof buildClockHands> | null = null;
    if (p.includeHands) {
      handsInfo = buildClockHands(p, R);
      const clearanceZ = 1.5;

      parts.push({ key: 'handHour', subs: handsInfo.hour, at: { x: 0, y: 0 } });
      labels.handHour = { code: 'part.handHour' };
      poses.handHour = handPose(cx, cy, z + clearanceZ, -55); // Classic 10:10 hour hand
      z += clearanceZ + p.thickness;

      parts.push({ key: 'handMinute', subs: handsInfo.minute, at: { x: 0, y: 0 } });
      labels.handMinute = { code: 'part.handMinute' };
      poses.handMinute = handPose(cx, cy, z + clearanceZ, 60); // Classic 10:10 minute hand
      z += clearanceZ + p.thickness;

      if (handsInfo.second) {
        parts.push({ key: 'handSecond', subs: handsInfo.second, at: { x: 0, y: 0 } });
        labels.handSecond = { code: 'part.handSecond' };
        poses.handSecond = handPose(cx, cy, z + clearanceZ, 150); // 25s sweep
        z += clearanceZ + p.thickness;
      }
    }

    // -------------------------------------------------------- 5. 2D Nesting Layout
    const positions = host.nest({
      parts: parts.map((pt) => ({ key: pt.key, subs: [pt.subs[0]] })),
      gap: 6,
    });
    parts.forEach((pt, idx) => {
      pt.at = { x: positions[idx][0], y: positions[idx][1] };
    });

    // -------------------------------------------------------- 6. Info Table & Labels
    const layerCount = (p.backplate ? 1 : 0) + p.ringCount + 1;
    const totalDepth = layerCount * p.thickness;
    const info: [Text, Text][] = [
      [
        'info.size',
        {
          code: 'info.sizeValue',
          values: { w: mm(geom.outerWidth), h: mm(geom.outerHeight) },
        },
      ],
      ['info.parts', String(parts.length)],
      ['info.depth', { code: 'info.mmValue', values: { v: mm(totalDepth) } }],
    ];
    if (tickRes.count > 0) {
      info.push(['info.ticks', String(tickRes.count)]);
    }
    if (p.numeralMode === 'cutout' && numerals.length > 0) {
      info.push(['info.bridges', { code: 'info.bridgesValue', values: { b: totalBridges, i: totalIslands } }]);
    }
    if (handsInfo) {
      info.push([
        'info.hands',
        {
          code: 'info.handsValue',
          values: { h: mm(handsInfo.hourLength), m: mm(handsInfo.minuteLength) },
        },
      ]);
    }

    return {
      parts,
      info,
      labels,
      label: {
        code: 'label',
        values: {
          w: mm(geom.outerWidth),
          h: mm(geom.outerHeight),
        },
      },
      poses: { poses },
      distribute: { rotate: false },
    };
  },
});
