// Engraved dividers, decorative motifs, and corner ornaments for House Number Sign.
import { circle, type SubPath } from '../../../sdk/ts';
import {
  ellipse,
  flattenSub,
  line,
  pointInPoly,
  poly,
  polyline,
  distToPoly,
  transformSub,
  type CornerOrnaments,
  type DividerStyle,
  type MotifKind,
} from './types';

/** Build an engraved horizontal divider centered at (cx, cy) spanning width `spanW` */
export function buildDivider(
  style: DividerStyle,
  cx: number,
  cy: number,
  spanW: number,
  centerGap = 0,
): SubPath[] {
  if (style === 'none' || spanW < 10) return [];
  const hw = spanW / 2;
  const g = centerGap > 0 ? centerGap / 2 + 4 : 0;

  const hSpan = (y: number, halfLen: number): SubPath[] => {
    if (g > 0) {
      if (halfLen <= g + 3) return [];
      return [line(cx - halfLen, y, cx - g, y), line(cx + g, y, cx + halfLen, y)];
    }
    return [line(cx - halfLen, y, cx + halfLen, y)];
  };

  switch (style) {
    case 'line':
      return hSpan(cy, hw);

    case 'double':
      return [...hSpan(cy - 1.3, hw), ...hSpan(cy + 1.3, hw * 0.88)];

    case 'diamond': {
      const d = Math.max(2.4, Math.min(4.2, spanW * 0.035));
      if (g > 0) return hSpan(cy, hw);
      const out: SubPath[] = [
        poly([
          [cx, cy - d],
          [cx + d * 1.4, cy],
          [cx, cy + d],
          [cx - d * 1.4, cy],
        ]),
      ];
      if (hw > d * 2 + 4) {
        out.push(line(cx - hw, cy, cx - d * 2.1, cy), line(cx + d * 2.1, cy, cx + hw, cy));
      }
      return out;
    }

    case 'dots': {
      const r = Math.max(1.1, Math.min(2.0, spanW * 0.015));
      const step = r * 5.2;
      const count = Math.max(3, Math.min(15, Math.floor(spanW / step) | 1));
      const out: SubPath[] = [];
      const total = (count - 1) * step;
      for (let i = 0; i < count; i++) {
        const x = cx - total / 2 + i * step;
        if (g > 0 && Math.abs(x - cx) < g) continue;
        const ri = i === Math.floor(count / 2) ? r * 1.25 : r;
        out.push(circle(x, cy, ri));
      }
      return out;
    }

    case 'flourish': {
      const h = Math.max(1.8, Math.min(3.2, spanW * 0.022));
      if (g > 0) {
        const out: SubPath[] = [...hSpan(cy, hw)];
        if (hw > g + 8) {
          out.push(
            line(cx - hw + 4, cy - h, cx - g - 3, cy - h),
            line(cx + g + 3, cy - h, cx + hw - 4, cy - h),
          );
        }
        return out;
      }
      return [
        // Tapered architectural bar
        poly([
          [cx - hw, cy],
          [cx - hw * 0.55, cy - h * 0.65],
          [cx, cy - h],
          [cx + hw * 0.55, cy - h * 0.65],
          [cx + hw, cy],
          [cx + hw * 0.55, cy + h * 0.65],
          [cx, cy + h],
          [cx - hw * 0.55, cy + h * 0.65],
        ]),
      ];
    }
  }
}

/** Build a decorative engraved motif centered at (cx, cy) with overall height `size` (mm) */
export function buildMotif(kind: MotifKind, cx: number, cy: number, size: number): SubPath[] {
  if (kind === 'none' || size < 4) return [];
  const s = size / 20; // design space is [-10..10] vertically
  const place = (subs: SubPath[]): SubPath[] => subs.map((sp) => transformSub(sp, cx, cy, s, 0));

  switch (kind) {
    case 'house':
      return place([
        // Pitched roof + walls
        polyline([[-11, -1], [0, -10], [11, -1]]),
        polyline([[-8.2, -3.3], [-8.2, 9.5], [8.2, 9.5], [8.2, -3.3]]),
        // Chimney
        polyline([[4.2, -6.6], [4.2, -9.8], [7, -9.8], [7, -4.3]]),
        // Door
        polyline([[-2.2, 9.5], [-2.2, 2.2], [2.2, 2.2], [2.2, 9.5]]),
      ]);

    case 'leaf':
      return place([
        // Central stem curving gently
        {
          closed: false,
          nodes: [
            { x: -13, y: 3, cout: { x: -4, y: 1 } },
            { x: 13, y: -3, cin: { x: 4, y: -1 } },
          ],
        },
        // 3 pairs of almond leaves along stem
        ...([-7, -0.5, 6] as const).flatMap((lx, idx) => {
          const sc = idx === 1 ? 1.0 : 0.82;
          const ly = -lx * 0.22;
          const up: SubPath = {
            closed: true,
            nodes: [
              { x: lx, y: ly, cout: { x: lx - 0.5 * sc, y: ly - 4.2 * sc } },
              { x: lx + 3.6 * sc, y: ly - 6.8 * sc, cin: { x: lx + 2.5 * sc, y: ly - 5.2 * sc }, cout: { x: lx + 3.8 * sc, y: ly - 2.6 * sc } },
              { x: lx, y: ly, cin: { x: lx + 2.4 * sc, y: ly - 0.8 * sc } },
            ],
          };
          const dn: SubPath = {
            closed: true,
            nodes: [
              { x: lx + 1.5, y: ly, cout: { x: lx + 2.2 * sc, y: ly + 4.0 * sc } },
              { x: lx + 5.0 * sc, y: ly + 6.4 * sc, cin: { x: lx + 4.4 * sc, y: ly + 4.8 * sc }, cout: { x: lx + 4.8 * sc, y: ly + 2.2 * sc } },
              { x: lx + 1.5, y: ly, cin: { x: lx + 3.6 * sc, y: ly + 0.8 * sc } },
            ],
          };
          return [up, dn];
        }),
      ]);

    case 'compass': {
      const star: [number, number][] = [];
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4 - Math.PI / 2;
        const r = i % 2 === 0 ? 10 : 3.2;
        star.push([r * Math.cos(a), r * Math.sin(a)]);
      }
      return place([
        poly(star),
        circle(0, 0, 5.2),
        circle(0, 0, 1.6),
      ]);
    }

    case 'sun': {
      const rays: SubPath[] = [circle(0, 0, 4.4)];
      for (let i = 0; i < 12; i++) {
        const a = (i * Math.PI) / 6;
        const r0 = 6.0;
        const r1 = i % 2 === 0 ? 10.2 : 8.4;
        rays.push(line(r0 * Math.cos(a), r0 * Math.sin(a), r1 * Math.cos(a), r1 * Math.sin(a)));
      }
      return place(rays);
    }

    case 'key':
      return place([
        circle(-7.5, 0, 5.2),
        circle(-7.5, 0, 2.3),
        polyline([[-2.3, 0], [11.5, 0], [11.5, 4.2], [9.2, 4.2], [9.2, 1.8], [6.5, 1.8], [6.5, 3.6], [4.5, 3.6], [4.5, 0]]),
      ]);

    case 'paw':
      return place([
        // Main pad
        ellipse(0, 3.6, 5.4, 4.2),
        // 4 toes
        ellipse(-6.8, -2.0, 2.3, 3.0),
        ellipse(-2.5, -5.8, 2.3, 3.1),
        ellipse(2.5, -5.8, 2.3, 3.1),
        ellipse(6.8, -2.0, 2.3, 3.0),
      ]);

    case 'heart':
      return place([
        {
          closed: true,
          nodes: [
            { x: 0, y: 9.2, cin: { x: -3.5, y: 5.5 }, cout: { x: 3.5, y: 5.5 } },
            { x: 9.5, y: -2.2, cin: { x: 9.8, y: 2.8 }, cout: { x: 9.2, y: -7.5 } },
            { x: 0, y: -4.2, cin: { x: 4.5, y: -9.8 }, cout: { x: -4.5, y: -9.8 } },
            { x: -9.5, y: -2.2, cin: { x: -9.2, y: -7.5 }, cout: { x: -9.8, y: 2.8 } },
          ],
        },
      ]);

    case 'trees': {
      const tree = (tx: number, ty: number, sc: number): SubPath[] => [
        poly([
          [tx, ty - 10 * sc],
          [tx + 5.2 * sc, ty - 2 * sc],
          [tx + 2.8 * sc, ty - 2 * sc],
          [tx + 6.8 * sc, ty + 5.5 * sc],
          [tx - 6.8 * sc, ty + 5.5 * sc],
          [tx - 2.8 * sc, ty - 2 * sc],
          [tx - 5.2 * sc, ty - 2 * sc],
        ]),
        line(tx, ty + 5.5 * sc, tx, ty + 9.2 * sc),
      ];
      return place([...tree(-8.5, 1.5, 0.72), ...tree(0, 0, 1.0), ...tree(8.5, 1.5, 0.72)]);
    }
  }
}

/** Build engraved corner ornaments strictly inside `boardOuter` */
export function buildCornerOrnaments(
  style: CornerOrnaments,
  W: number,
  H: number,
  inset: number,
  boardOuter: SubPath,
): SubPath[] {
  if (style === 'none') return [];
  const boardPoly = flattenSub(boardOuter, 20);
  const hw = W / 2;
  const hh = H / 2;
  const out: SubPath[] = [];

  const corners: [number, number, number, number][] = [
    [-hw + inset, -hh + inset, 1, 1],
    [hw - inset, -hh + inset, -1, 1],
    [hw - inset, hh - inset, -1, -1],
    [-hw + inset, hh - inset, 1, -1],
  ];

  const rMin = Math.max(4, Math.min(9, Math.min(W, H) * 0.045));

  for (const [tx, ty, sx, sy] of corners) {
    // Pull ornament anchor inward along diagonal if shape cuts corner off (oval, pill, arch, etc.)
    let ax = tx;
    let ay = ty;
    for (let k = 0; k < 20; k++) {
      if (pointInPoly(boardPoly, { x: ax, y: ay }) && distToPoly(boardPoly, { x: ax, y: ay }) >= rMin + 2) break;
      ax *= 0.92;
      ay *= 0.92;
    }
    if (!pointInPoly(boardPoly, { x: ax, y: ay })) continue;

    if (style === 'dots') {
      const r = Math.max(1.5, Math.min(2.6, rMin * 0.35));
      out.push(circle(ax, ay, r));
    } else if (style === 'diamonds') {
      const d = Math.max(2.2, Math.min(4.0, rMin * 0.52));
      out.push(
        poly([
          [ax, ay - d],
          [ax + d, ay],
          [ax, ay + d],
          [ax - d, ay],
        ]),
      );
    } else if (style === 'brackets') {
      const len = Math.max(6, Math.min(13, rMin * 1.6));
      out.push(
        polyline([
          [ax + sx * len, ay],
          [ax, ay],
          [ax, ay + sy * len],
        ]),
      );
    }
  }

  return out;
}
