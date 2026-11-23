// Shared types for the Flex Book Box generator plugin.
import type { Params } from '../../../sdk/ts';

export type HingeKind = 'straight' | 'wave' | 'diamond' | 'honeycomb' | 'triangle' | 'cross';

export interface P extends Params {
  // Step 1: Book
  coverWidth: number;
  coverHeight: number;
  pageThickness: number;
  square: number;
  pageBlockFloor: boolean;
  coverCornerRadius: number;
  pageLines: boolean;
  pageLineSpacing: number;
  glueMarks: boolean;
  // Step 2: Dividers (Finger Joint Box with Dividers)
  compartmentsX: number;
  ratiosX: string;
  compartmentsY: number;
  ratiosY: string;
  dividerDrop: number;
  // Step 3: Living Hinge (KizamuBeam Living Hinge Tool)
  hingeKind: HingeKind;
  hingeCutLength: number;
  hingeBridge: number;
  hingeSpacing: number;
  hingeMargin: number;
  hingeWaveAmp: number;
  hingeWaveLength: number;
  hingeDiamondAngle: number;
  spineAllowance: number;
  // Step 4: Material & Joints
  fromMaterial: boolean;
  thickness: number;
  kerf: number;
  clearance: number;
  finger: number;
}

export interface BookDims {
  /** Cover width from spine crease to fore-edge (mm) */
  Wc: number;
  /** Cover height from head to tail (mm) */
  Hc: number;
  /** Page block outer height / thickness (mm) */
  P: number;
  /** Cover overhang past page block at head, tail, and fore-edge (mm) */
  sq: number;
  /** Page block outer width, spine to fore-edge (mm) */
  Wb: number;
  /** Page block outer height/depth along spine, head to tail (mm) */
  Hb: number;
  /** Semicircular neutral-axis living-hinge spine wrap length (mm) */
  spineLen: number;
  /** Total flat cover width = 2 * Wc + spineLen (mm) */
  coverTotalW: number;
  /** Material thickness (mm) */
  t: number;
  /** Kerf width (mm) */
  kerf: number;
  /** Total play of joints (v2 semantics, mm) */
  clearance: number;
  /** Minimum finger width (mm) */
  finger: number;
  /** Whether the page block has its own bottom plate */
  floor: boolean;
  /** Divider height = P - dividerDrop (mm) */
  dividerHeight: number;
}

export interface HingeOptions {
  kind: HingeKind;
  cutLength: number;
  bridge: number;
  spacing: number;
  margin: number;
  waveAmp: number;
  waveLength: number;
  diamondAngle: number;
}
