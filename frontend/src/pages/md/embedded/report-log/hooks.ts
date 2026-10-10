import { useMdQuery, type MdQueryParams } from "@/lib/api-client/custom-hooks/md";
import type { GroupBy, RlAttention, RlBreakdown, RlBriefing, RlExports, RlGaps, RlSummary, RlTrend } from "./types";

/** Every request the Insights tab makes, one per card, so a slow or failed one never blanks the others. The exports are
 *  company-wide (the audit trail has no unit or department), so they take the period only. */
export function useReportLogData(params: MdQueryParams, period: MdQueryParams, by: GroupBy) {
  return {
    summary: useMdQuery<RlSummary>("reportlog/summary", params),
    briefing: useMdQuery<RlBriefing>("reportlog/briefing", params),
    attention: useMdQuery<RlAttention>("reportlog/attention", params),
    trend: useMdQuery<RlTrend>("reportlog/trend", params),
    gaps: useMdQuery<RlGaps>("reportlog/gaps", params),
    groups: useMdQuery<RlBreakdown>("reportlog/departments", { ...params, by, limit: 25 }),
    exports: useMdQuery<RlExports>("reportlog/exports", { ...period, limit: 10 }),
  };
}
