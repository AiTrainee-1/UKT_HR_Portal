// The shared kit of Gate Pass, Visitors and Tea Break (and the gate monitor's lists): one look, one set of filters, one
// table, one drawer, one way to download a file. Import from "../kit" (or "@/pages/hr/outpass-visitors/kit"); add to a
// piece here rather than forking it in a page.

export { StatTile, StatRow, type TileTone } from "./StatTile";
export { FilterBar, SelectFilter, SearchFilter, ClearFilters, CONTROL_H, type FilterOption } from "./FilterBar";
export { DateRangeFilter, type DateRangePatch } from "./DateRangeFilter";
export { ExportButton } from "./ExportButton";
export { DataTable, type DataColumn, type DataTablePagination } from "./DataTable";
export { StatusChip, GATE_STATUS_TONE, toneOf, type KitTone } from "./StatusChip";
export { PersonCell } from "./PersonCell";
export { DetailDrawer, DrawerSection, DrawerFields } from "./DetailDrawer";
export { TimeBar } from "./TimeBar";
export { WhenCell } from "./WhenCell";
export { useGateFilters, type GateFilters } from "./useGateFilters";
export {
  downloadGateFile,
  exportParams,
  hrToken,
  GateDownloadError,
  TOO_MANY_ROWS_MESSAGE,
  type DownloadGateFileOptions,
  type GateFileFormat,
  type GateFileQuery,
} from "./download";
export {
  NONE,
  DATE_PRESETS,
  fmtCount,
  fmtDate,
  fmtDateTime,
  fmtMinutes,
  fmtRangeLabel,
  fmtTime,
  fmtWhen,
  isDateKey,
  isTodayIst,
  istDateKey,
  presetRange,
  resolveDateRange,
  toInstant,
  type DateInput,
  type DatePreset,
  type DateRangeKind,
} from "./fmt";
