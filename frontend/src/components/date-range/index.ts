// The HR portal's one date filter (owner brief 2026-11-24): Today / Yesterday / This Month (and earlier months) / Custom.
// The pure rules are in lib/date-range.ts; this is the bar, the address hook and the "N more outside these dates" note.
export { DateRangeBar } from "./DateRangeBar";
export { OutsideRangeNote } from "./OutsideRangeNote";
export { useDateRange, useIstToday, type DateRange } from "./useDateRange";
