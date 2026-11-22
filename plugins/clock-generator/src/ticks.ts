import { circle, polygon, type SubPath } from '../../../sdk/ts';
import { line, type ClockParams } from './types';

export interface TicksResult {
  /** Engraved tick marks and chapter rings */
  marks: SubPath[];
  /** Cut-out tick slots (when tickStyle === 'cutout') */
  cuts: SubPath[];
  /** Inner radius reached by the longest tick marks */
  innerRadius: number;
  /** Number of ticks generated */
  count: number;
}

/** Build a radial bar/trapezoid oriented at angle `a` (0 = 12 o'clock / -y, clockwise) */
function radialBar(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  wOuter: number,
  wInner: number,
  angle: number,
): SubPath {
  const sx = Math.sin(angle);
  const sy = -Math.cos(angle);
  // Perpendicular tangent vector (clockwise)
  const tx = Math.cos(angle);
  const ty = Math.sin(angle);
  const ho = wOuter / 2;
  const hi = wInner / 2;
  return polygon([
    [cx + sx * rOuter - tx * ho, cy + sy * rOuter - ty * ho],
    [cx + sx * rOuter + tx * ho, cy + sy * rOuter + ty * ho],
    [cx + sx * rInner + tx * hi, cy + sy * rInner + ty * hi],
    [cx + sx * rInner - tx * hi, cy + sy * rInner - ty * hi],
  ]);
}

/** Build a radial double-bar (classic 12 o'clock accent) */
function radialDoubleBar(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  barW: number,
  gap: number,
  angle: number,
): SubPath[] {
  const sx = Math.sin(angle);
  const sy = -Math.cos(angle);
  const tx = Math.cos(angle);
  const ty = Math.sin(angle);
  const offset = (barW + gap) / 2;
  const out: SubPath[] = [];
  for (const sign of [-1, 1]) {
    const ox = cx + tx * offset * sign;
    const oy = cy + ty * offset * sign;
    out.push(radialBar(ox, oy, rOuter, rInner, barW, barW, angle));
  }
  return out;
}

/** Generate tick marks and chapter rings around `(cx, cy)` inside `dialMaxRadius` */
export function buildTicks(p: ClockParams, cx: number, cy: number, dialMaxRadius: number): TicksResult {
  const marks: SubPath[] = [];
  const cuts: SubPath[] = [];
  const rOuter = dialMaxRadius - p.tickInset;
  let minInner = rOuter;
  let count = 0;

  const isStation = p.dialStyle === 'station';
  // Station style always displays bold station indices unless user explicitly sets tickMode === 'none'
  const effectiveMode = isStation && p.tickMode === 'none' ? 'hoursAndMinutes' : p.tickMode;
  const effectiveStyle = isStation && p.tickStyle === 'line' ? 'bar' : p.tickStyle;

  if (effectiveMode !== 'none') {
    const total = effectiveMode === 'hoursAndMinutes' || effectiveMode === 'minutesOnly' ? 60 : effectiveMode === 'hours' ? 12 : 4;
    const stepAngle = (2 * Math.PI) / total;

    for (let i = 0; i < total; i++) {
      const a = i * stepAngle;
      const isQuarter =
        (total === 60 && i % 15 === 0) || (total === 12 && i % 3 === 0) || total === 4;
      const isHour =
        effectiveMode === 'minutesOnly'
          ? false
          : total === 60
            ? i % 5 === 0
            : true;
      const isTwelve = i === 0;

      // Length and width for this tick
      let len: number;
      let w: number;
      if (isStation) {
        if (isHour) {
          len = p.hourTickLength * (isQuarter && p.quarterAccent ? 1.25 : 1.15);
          w = Math.max(p.hourTickWidth * 1.4, dialMaxRadius * 0.038);
        } else {
          len = p.minuteTickLength * 1.1;
          w = Math.max(p.minuteTickWidth * 1.25, dialMaxRadius * 0.014);
        }
      } else if (isHour) {
        const qMulL = isQuarter && p.quarterAccent && effectiveMode !== 'quarters' ? 1.22 : 1.0;
        const qMulW = isQuarter && p.quarterAccent && effectiveMode !== 'quarters' ? 1.3 : 1.0;
        len = p.hourTickLength * qMulL;
        w = p.hourTickWidth * qMulW;
      } else {
        len = p.minuteTickLength;
        w = p.minuteTickWidth;
      }

      const rInner = Math.max(p.shaftDia / 2 + 2, rOuter - len);
      if (rInner < minInner) minInner = rInner;
      count++;

      const sx = Math.sin(a);
      const sy = -Math.cos(a);

      if (effectiveStyle === 'line') {
        marks.push(line(cx + sx * rOuter, cy + sy * rOuter, cx + sx * rInner, cy + sy * rInner));
      } else if (effectiveStyle === 'dot') {
        const rDot = Math.max(0.4, w / 2);
        const rMid = rOuter - len / 2;
        marks.push(circle(cx + sx * rMid, cy + sy * rMid, rDot));
      } else if (effectiveStyle === 'taper') {
        marks.push(radialBar(cx, cy, rOuter, rInner, w, w * 0.38, a));
      } else if (effectiveStyle === 'cutout') {
        // Cut-out rectangular slots in the dial
        const slotW = Math.max(0.8, w);
        cuts.push(radialBar(cx, cy, rOuter, rInner, slotW, slotW, a));
      } else {
        // 'bar' (filled/outlined rectangle)
        if (isTwelve && p.quarterAccent && isStation) {
          const subW = Math.max(1.2, w * 0.45);
          const gap = Math.max(1.2, w * 0.25);
          marks.push(...radialDoubleBar(cx, cy, rOuter, rInner, subW, gap, a));
        } else {
          marks.push(radialBar(cx, cy, rOuter, rInner, w, w, a));
        }
      }
    }
  }

  // Decorative chapter ring(s) rendered as thin annular rings (0.8 mm band) so they work on both Line and Fill layers
  if (p.chapterRing !== 'none') {
    const bandHalf = 0.4;
    const addRing = (r: number) => {
      if (r - bandHalf > p.shaftDia / 2 + 1.5 && r + bandHalf < dialMaxRadius - 1.2) {
        marks.push(circle(cx, cy, r + bandHalf));
        marks.push({
          closed: true,
          nodes: circle(cx, cy, r - bandHalf)
            .nodes.slice()
            .reverse()
            .map((nd) => ({
              x: nd.x,
              y: nd.y,
              ...(nd.cout ? { cin: nd.cout } : {}),
              ...(nd.cin ? { cout: nd.cin } : {}),
            })),
        });
      }
    };
    const rRingOuter = rOuter + 1.8;
    const rRingInner =
      effectiveMode !== 'none'
        ? Math.max(
            p.shaftDia / 2 + 3,
            rOuter -
              (effectiveMode === 'hoursAndMinutes' || effectiveMode === 'minutesOnly'
                ? p.minuteTickLength
                : p.hourTickLength) -
              1.8,
          )
        : Math.max(p.shaftDia / 2 + 3, rOuter - 8);

    if (p.chapterRing === 'outer' || p.chapterRing === 'double') {
      addRing(rRingOuter);
    }
    if (p.chapterRing === 'inner' || p.chapterRing === 'double') {
      addRing(rRingInner);
    }
  }

  return { marks, cuts, innerRadius: minInner, count };
}
