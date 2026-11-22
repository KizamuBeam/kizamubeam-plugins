import { circle, type Node, type SubPath } from '../../../sdk/ts';
import { circleArcNodes } from './shapes';
import { reverseSub, type ClockParams, type HandStyle } from './types';

export type HandRole = 'hour' | 'minute' | 'second';

/**
 * Mirror a right-half node chain (running from top-center (0, yTop) clockwise down x >= 0 to bottom-center (0, yBot))
 * across x = 0 to produce a guaranteed-symmetric, closed Bézier SubPath.
 */
function symmetricProfile(rightHalf: Node[]): SubPath {
  const nodes: Node[] = rightHalf.map((nd) => ({
    x: nd.x,
    y: nd.y,
    ...(nd.cin ? { cin: { ...nd.cin } } : {}),
    ...(nd.cout ? { cout: { ...nd.cout } } : {}),
    ...(nd.smooth ? { smooth: true } : {}),
  }));

  // Mirror interior nodes in reverse order (skipping last node at x=0 and first node at x=0)
  const last = rightHalf[rightHalf.length - 1];
  const first = rightHalf[0];
  // Mirror last node's cin into its cout (symmetric bottom)
  if (Math.abs(last.x) < 1e-4 && last.cin) {
    nodes[nodes.length - 1].cout = { x: -last.cin.x, y: last.cin.y };
  }
  for (let i = rightHalf.length - 2; i >= 1; i--) {
    const a = rightHalf[i];
    const nd: Node = { x: -a.x, y: a.y };
    if (a.cout) nd.cin = { x: -a.cout.x, y: a.cout.y };
    if (a.cin) nd.cout = { x: -a.cin.x, y: a.cin.y };
    if (a.smooth) nd.smooth = true;
    nodes.push(nd);
  }
  // Mirror first node's cout into its cin (symmetric top)
  if (Math.abs(first.x) < 1e-4 && first.cout) {
    nodes[0].cin = { x: -first.cout.x, y: first.cout.y };
  }
  return { closed: true, nodes };
}

/** Append circular arc nodes to a chain, merging coincident endpoints cleanly */
function pushArc(dst: Node[], arc: Node[]): void {
  if (!arc.length) return;
  if (dst.length) {
    const prev = dst[dst.length - 1];
    const first = arc[0];
    if (Math.hypot(prev.x - first.x, prev.y - first.y) < 1e-3) {
      if (first.cout) prev.cout = first.cout;
      for (let i = 1; i < arc.length; i++) dst.push(arc[i]);
      return;
    }
  }
  for (const nd of arc) dst.push(nd);
}

/** Add the right-side circular hub arc around (0, 0) connecting (xUpper, -yUpper) to (xLower, +yLower) */
function pushHubArc(dst: Node[], rHub: number, xUpper: number, xLower: number): void {
  const xu = Math.min(xUpper, rHub * 0.96);
  const xl = Math.min(xLower, rHub * 0.96);
  const aStart = -Math.acos(xu / rHub); // upper-right (negative angle in y-down)
  const aEnd = Math.acos(xl / rHub); // lower-right (positive angle in y-down)
  pushArc(dst, circleArcNodes(0, 0, rHub, aStart, aEnd));
}

/** Build a single clock hand (outer contour + center shaft hole + any decorative cutout) centered at pivot (0, 0), pointing UP (-y) */
export function buildHand(
  style: HandStyle,
  role: HandRole,
  length: number,
  baseWidth: number,
  holeDia: number,
): SubPath[] {
  const isHour = role === 'hour';
  const isSecond = role === 'second';
  // Effective blade half-width (ensuring laser-cuttable thickness >= 0.8 mm half-width = 1.6 mm total)
  const w = isSecond
    ? Math.max(1.8, baseWidth * 0.24)
    : isHour
      ? Math.max(3.4, baseWidth)
      : Math.max(2.6, baseWidth * 0.72);
  const hw = w / 2;
  const rHole = holeDia / 2;
  const minWall = isSecond ? 2.0 : Math.max(2.2, w * 0.3);
  const rHub = Math.max(rHole + minWall, hw * 1.18);
  const tail = Math.max(rHub + 5, length * (isSecond ? 0.28 : isHour ? 0.26 : 0.22));
  const holes: SubPath[] = [reverseSub(circle(0, 0, rHole))];

  let outer: SubPath;

  if (isSecond && style === 'railway') {
    // Iconic Swiss railway lollipop second hand ("Kelle")
    const rDisc = Math.max(4.5, Math.min(length * 0.11, baseWidth * 1.1));
    const yDisc = -(length - rDisc);
    const stemHW = Math.max(0.95, hw * 0.85);
    const tailHW = Math.max(1.2, hw * 1.05);
    const right: Node[] = [];
    // Top of lollipop disc down to stem join
    const aJoin = Math.acos(Math.min(0.9, stemHW / rDisc)); // angle from +x to lower-right join? Wait: bottom of disc is +PI/2!
    const aBottomJoin = Math.PI / 2 - Math.asin(Math.min(0.9, stemHW / rDisc));
    void aJoin;
    pushArc(right, circleArcNodes(0, yDisc, rDisc, -Math.PI / 2, aBottomJoin));
    pushHubArc(right, rHub, stemHW, tailHW);
    right.push({ x: tailHW, y: tail }, { x: 0, y: tail });
    outer = symmetricProfile(right);
    return [outer, ...holes];
  }

  switch (style) {
    case 'baton': {
      const tipHW = Math.max(0.9, hw * 0.78);
      const tailHW = Math.max(1.1, hw * 0.85);
      const right: Node[] = [];
      pushArc(right, circleArcNodes(0, -length + tipHW, tipHW, -Math.PI / 2, 0));
      pushHubArc(right, rHub, hw, tailHW);
      pushArc(right, circleArcNodes(0, tail - tailHW, tailHW, 0, Math.PI / 2));
      outer = symmetricProfile(right);
      break;
    }

    case 'dauphine': {
      const maxHW = Math.max(rHub, hw * 1.25);
      const right: Node[] = [
        { x: 0, y: -length },
        { x: maxHW, y: 0 },
        { x: 0, y: tail },
      ];
      outer = symmetricProfile(right);
      break;
    }

    case 'railway': {
      const tipHW = Math.max(1.1, hw * 0.92);
      const rootHW = Math.max(rHub, hw * 1.12);
      const tailHW = Math.max(1.4, hw * 1.15);
      const right: Node[] = [
        { x: 0, y: -length },
        { x: tipHW, y: -length },
        { x: rootHW, y: 0 },
        { x: tailHW, y: tail },
        { x: 0, y: tail },
      ];
      outer = symmetricProfile(right);
      break;
    }

    case 'arrow': {
      const shaftHW = Math.max(0.95, hw * 0.62);
      const headLen = Math.min(length * 0.28, Math.max(10, w * 2.4));
      const headHW = Math.max(shaftHW * 2.1, hw * 1.65);
      const tailHW = Math.max(1.2, hw * 0.9);
      const yBarb = -length + headLen;
      const right: Node[] = [
        { x: 0, y: -length },
        { x: headHW, y: yBarb },
        { x: shaftHW, y: yBarb - headLen * 0.14 },
      ];
      pushHubArc(right, rHub, shaftHW, shaftHW);
      // Swallowtail flare
      right.push({ x: tailHW * 1.35, y: tail }, { x: 0, y: tail - tailHW * 1.1 });
      outer = symmetricProfile(right);
      break;
    }

    case 'spade': {
      const neckHW = Math.max(1.0, hw * 0.55);
      const tailHW = Math.max(1.0, hw * 0.55);
      const right: Node[] = [];
      if (isHour) {
        // Classic Victorian spade bulb near tip
        const bulbW = Math.max(hw * 1.9, rHub * 1.15);
        const yTip = -length;
        const yBelly = -length * 0.68;
        const yCollar = -length * 0.52;
        right.push(
          { x: 0, y: yTip, cout: { x: bulbW * 0.2, y: yTip + length * 0.08 } },
          {
            x: bulbW,
            y: yBelly,
            cin: { x: bulbW, y: yTip + length * 0.22 },
            cout: { x: bulbW, y: yBelly + length * 0.12 },
            smooth: true,
          },
          {
            x: neckHW,
            y: yCollar,
            cin: { x: bulbW * 0.45, y: yCollar },
          },
        );
      } else {
        // Slender spearhead for minute / second hand
        const spearW = Math.max(neckHW * 1.75, hw * 1.25);
        const yBelly = -length * 0.72;
        const yCollar = -length * 0.56;
        right.push(
          { x: 0, y: -length, cout: { x: spearW * 0.35, y: -length * 0.9 } },
          {
            x: spearW,
            y: yBelly,
            cin: { x: spearW, y: -length * 0.8 },
            cout: { x: spearW, y: -length * 0.64 },
            smooth: true,
          },
          { x: neckHW, y: yCollar, cin: { x: spearW * 0.45, y: yCollar } },
        );
      }
      pushHubArc(right, rHub, neckHW, tailHW);
      // Teardrop finial tail
      const tailR = Math.max(tailHW * 1.4, rHub * 0.52);
      const yTailBulb = tail - tailR;
      right.push({ x: tailHW, y: Math.max(rHub + 1, yTailBulb - tailR * 0.9) });
      pushArc(right, circleArcNodes(0, yTailBulb, tailR, -Math.PI / 4, Math.PI / 2));
      outer = symmetricProfile(right);
      break;
    }

    case 'breguet': {
      // Classic Breguet "pomme" hand with open moon ring near the tip
      const neckHW = Math.max(1.0, hw * 0.5);
      const tailHW = Math.max(1.1, hw * 0.55);
      const rMoon = isSecond
        ? Math.max(3.2, hw * 2.2)
        : Math.max(hw * 1.45, Math.min(length * 0.14, isHour ? 9.5 : 7.5));
      const yMoon = -length * (isHour ? 0.68 : 0.74);
      const tipStart = Math.min(-length + 4, yMoon - rMoon * 1.15);
      const tipHW = Math.max(0.85, neckHW * 0.78);
      const aTop = -Math.PI / 2 + Math.asin(Math.min(0.85, tipHW / rMoon));
      const aBot = Math.PI / 2 - Math.asin(Math.min(0.85, neckHW / rMoon));

      const right: Node[] = [{ x: 0, y: -length }];
      if (tipStart > -length + 1) {
        right.push({ x: tipHW, y: yMoon - Math.sqrt(Math.max(0.5, rMoon * rMoon - tipHW * tipHW)) });
      }
      pushArc(right, circleArcNodes(0, yMoon, rMoon, aTop, aBot));
      pushHubArc(right, rHub, neckHW, tailHW);
      pushArc(right, circleArcNodes(0, tail - tailHW, tailHW, 0, Math.PI / 2));
      outer = symmetricProfile(right);

      // Inner moon ring cutout (keep laser-safe ring wall >= 1.8 mm)
      const wall = Math.max(1.8, rMoon * 0.34);
      const rMoonIn = rMoon - wall;
      if (rMoonIn >= 1.2) {
        holes.push(reverseSub(circle(0, yMoon, rMoonIn)));
      }
      break;
    }

    case 'leaf': {
      // Graceful organic Feuille (leaf) hand
      const bellyW = Math.max(hw * 1.35, rHub * 0.92);
      const neckHW = Math.max(1.0, hw * 0.62);
      const tailW = Math.max(1.3, hw * 0.85);
      const yBelly = -length * 0.42;
      const yNeck = -Math.max(rHub * 1.05, length * 0.15);
      const right: Node[] = [
        { x: 0, y: -length, cout: { x: bellyW * 0.45, y: -length * 0.82 } },
        {
          x: bellyW,
          y: yBelly,
          cin: { x: bellyW, y: -length * 0.62 },
          cout: { x: bellyW, y: -length * 0.25 },
          smooth: true,
        },
        { x: neckHW, y: yNeck, cin: { x: bellyW * 0.65, y: yNeck - 2 } },
      ];
      pushHubArc(right, rHub, neckHW, neckHW);
      right.push(
        {
          x: tailW,
          y: tail * 0.68,
          cin: { x: tailW, y: tail * 0.42 },
          cout: { x: tailW, y: tail * 0.88 },
          smooth: true,
        },
        { x: 0, y: tail, cin: { x: tailW * 0.5, y: tail } },
      );
      outer = symmetricProfile(right);
      break;
    }

    case 'cathedral': {
      // Ornate vintage cathedral hand with gothic lancet cutout window
      const bodyW = isSecond ? hw * 1.15 : Math.max(hw * 1.65, rHub * 1.05);
      const neckHW = Math.max(1.1, hw * 0.65);
      const tailHW = Math.max(1.2, hw * 0.72);
      const yShoulder = -length * 0.72;
      const yBase = -Math.max(rHub * 1.25, length * 0.22);
      const right: Node[] = [
        { x: 0, y: -length },
        { x: neckHW * 0.85, y: -length * 0.82 },
        { x: bodyW, y: yShoulder, cout: { x: bodyW, y: yShoulder + (yBase - yShoulder) * 0.35 } },
        { x: bodyW * 0.92, y: yBase, cin: { x: bodyW, y: yBase - (yBase - yShoulder) * 0.3 } },
      ];
      pushHubArc(right, rHub, neckHW, tailHW);
      right.push({ x: tailHW * 1.2, y: tail * 0.75 }, { x: 0, y: tail });
      outer = symmetricProfile(right);

      // Gothic lancet cutout window when hand is wide & long enough for safe walls (>= 1.8 mm)
      const wall = Math.max(1.8, bodyW * 0.35);
      const winHW = bodyW - wall;
      const winTop = yShoulder + wall * 0.7;
      const winBot = yBase - wall * 0.7;
      if (!isSecond && winHW >= 1.2 && winBot - winTop >= 6) {
        const winRight: Node[] = [
          { x: 0, y: winTop, cout: { x: winHW * 0.75, y: winTop + (winBot - winTop) * 0.22 } },
          { x: winHW, y: winTop + (winBot - winTop) * 0.42 },
          { x: winHW * 0.88, y: winBot },
          { x: 0, y: winBot },
        ];
        holes.push(reverseSub(symmetricProfile(winRight)));
      }
      break;
    }
  }

  return [outer, ...holes];
}

export interface ClockHandsResult {
  hour: SubPath[];
  minute: SubPath[];
  second?: SubPath[];
  hourLength: number;
  minuteLength: number;
  secondLength?: number;
}

/** Generate hour, minute, and optional second hands proportioned to `dialMaxRadius` */
export function buildClockHands(p: ClockParams, dialMaxRadius: number): ClockHandsResult {
  const hourLength = Math.max(20, (dialMaxRadius * p.hourHandPct) / 100);
  const minuteLength = Math.max(26, (dialMaxRadius * p.minuteHandPct) / 100);
  const hour = buildHand(p.handStyle, 'hour', hourLength, p.handWidth, p.hourHoleDia);
  const minute = buildHand(p.handStyle, 'minute', minuteLength, p.handWidth, p.minuteHoleDia);
  const res: ClockHandsResult = { hour, minute, hourLength, minuteLength };
  if (p.includeSecondHand) {
    const secondLength = Math.min(dialMaxRadius - 4, minuteLength * 1.08);
    res.second = buildHand(p.handStyle, 'second', secondLength, p.handWidth, p.secondHoleDia);
    res.secondLength = secondLength;
  }
  return res;
}
