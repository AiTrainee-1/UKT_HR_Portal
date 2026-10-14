// The compensation marker of an attendance day, shared by every HR screen that draws a day (and so by the Managing
// Director's copies of those pages). Data and wording: ./kinds.ts; the chip, the compact symbol and the legend:
// ./CompensationMarker.tsx.
export { CompensationChip, CompensationLegend, CompensationSymbol } from "./CompensationMarker";
export {
  COMPENSATION_KINDS,
  KIND_META,
  compensationMark,
  countMarks,
  isPunchlessRelaxation,
  kindLabel,
  markKinds,
  markShort,
  markTitle,
  type CompensationFields,
  type CompensationMark,
  type MarkKind,
} from "./kinds";
