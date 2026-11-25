// Rounded box (#513): floor, optional lid and one bent wall strip with living hinge cuts in the corners.
import { definePlugin, host } from '../../../sdk/ts';
import { build, type P } from './box';

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
    return { parts: b.parts, info: b.info, distribute: { rotate: true } };
  },
});
