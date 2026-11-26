// Box from a contour (#513): floor and lid follow a smooth closed outline from the selection, the wall is one strip
// with living hinge cuts in its bends, joined to floor and lid with finger joints.
import { definePlugin, host, mm } from '../../../sdk/ts';
import { build, type P } from './box';
import { encode, fromSelection } from './contour';

const area = () => {
  try {
    return host.context('workArea');
  } catch {
    return null;
  }
};

definePlugin<P>({
  validate: (p) => build(p, area()).issues,
  generate(p) {
    const b = build(p, area());
    return { parts: b.parts, info: b.info, poses: { poses: b.poses }, distribute: { rotate: true }, ...(b.labels ? { labels: b.labels } : {}) };
  },
  onEvent({ action, inputs }) {
    if (action !== 'fromSelection') return null;
    const pts = fromSelection(inputs.selection);
    if (!pts) return { message: 'sel-none' };
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    return { patch: { contour: encode(pts) }, message: { code: 'sel-ok', values: { w: mm(Math.max(...xs) - Math.min(...xs)), h: mm(Math.max(...ys) - Math.min(...ys)) } } };
  },
});
