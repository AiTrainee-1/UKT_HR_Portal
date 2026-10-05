import { useMdQuery, type MdQueryParams } from "@/lib/api-client/custom-hooks/md";
import type {
  GroupBy,
  TeaAttention,
  TeaBreakdown,
  TeaHeatmap,
  TeaOffenders,
  TeaRule,
  TeaSummary,
  TeaTrend,
} from "./types";

/** Every request the page makes, one per card, so a slow or failed one never blanks the others. The rule does not
 *  depend on the filters. */
export function useTeaBreakData(params: MdQueryParams, by: GroupBy) {
  return {
    summary: useMdQuery<TeaSummary>("tea-break/summary", params),
    attention: useMdQuery<TeaAttention>("tea-break/attention", params),
    trend: useMdQuery<TeaTrend>("tea-break/trend", params),
    groups: useMdQuery<TeaBreakdown>("tea-break/departments", { ...params, by, limit: 25 }),
    shifts: useMdQuery<TeaBreakdown>("tea-break/shifts", { ...params, limit: 25 }),
    heatmap: useMdQuery<TeaHeatmap>("tea-break/heatmap", params),
    offenders: useMdQuery<TeaOffenders>("tea-break/offenders", { ...params, limit: 25 }),
    rule: useMdQuery<TeaRule>("tea-break/rule"),
  };
}
