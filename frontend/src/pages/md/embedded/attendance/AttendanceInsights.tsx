import { useMemo, useState } from "react";
import { Hourglass } from "lucide-react";
import { EmptyBlock, ErrorBanner, NoteBanner } from "@/components/md/kit/states";
import { describeMdError, useMdOrg, useMdQuery } from "@/lib/api-client/custom-hooks/md";
import { usePublishAssistantContext } from "@/lib/md/assistant-store";
import AttentionCard from "@/pages/md/attendance/AttentionCard";
import CoverageNote from "@/pages/md/attendance/CoverageNote";
import DayCard from "@/pages/md/attendance/DayCard";
import DepartmentCard from "@/pages/md/attendance/DepartmentCard";
import ExceptionsCard from "@/pages/md/attendance/ExceptionsCard";
import HeatmapCard from "@/pages/md/attendance/HeatmapCard";
import LeaveCard from "@/pages/md/attendance/LeaveCard";
import OvertimeCard from "@/pages/md/attendance/OvertimeCard";
import TrendCard from "@/pages/md/attendance/TrendCard";
import WeekdayCard from "@/pages/md/attendance/WeekdayCard";
import { notesWithoutCoverage, withDepartment, withUnit, type AskContext } from "@/pages/md/attendance/logic";
import type {
  AttendanceDepartments,
  AttendanceExceptions,
  AttendanceHeatmap,
  AttendanceLeave,
  AttendanceOvertime,
  AttendanceSummary,
  AttendanceTrend,
  AttendanceWeekday,
} from "@/pages/md/attendance/types";
import type { InsightsDefaults } from "../shared/filters";
import InsightsFilterBar from "../shared/InsightsFilterBar";
import { useInsightsFilters } from "../shared/useInsightsFilters";
import DrillSheet from "./DrillSheet";
import { assistantContext, PAGE_OF, type AttendanceKind } from "./logic";
import { BriefingCard, KpiTiles, TodayBoard } from "./parts";
import type { Drill, InsightsSummary } from "./types";

/** The filters each page opens with: this month, everyone of the page's kind. Module constants (useInsightsFilters). */
export const DEFAULTS: Record<AttendanceKind, InsightsDefaults> = {
  staff: { scope: { branch: "", department: "", type: "staff" } },
  production: { scope: { branch: "", department: "", type: "production" } },
};

/**
 * Staff / Production Attendance, Insights & AI. Executive overview first (the server's briefing, today's six cards as on
 * HR's page, the headline figures), then what needs attention, the trend, where it is weakest and the detail. Every figure
 * follows the month (or range) and the unit / department; a click on a figure, a card or a person opens who is behind it.
 * The HR page itself is the Operations tab next to this one.
 */
export default function AttendanceInsights({ kind }: { kind: AttendanceKind }) {
  const page = PAGE_OF[kind];
  const { filters, params: chosen, label, setWhen, setScope } = useInsightsFilters(DEFAULTS[kind]);
  // the page is one kind of employee: whatever the address says, ask for that kind
  const params = useMemo(() => ({ ...chosen, type: kind }), [chosen, kind]);
  const [drill, setDrill] = useState<Drill | null>(null);

  const org = useMdOrg();
  const summary = useMdQuery<InsightsSummary>("attendance/summary", params);
  const exceptions = useMdQuery<AttendanceExceptions>("attendance/exceptions", { ...params, limit: 25 });
  const trend = useMdQuery<AttendanceTrend>("attendance/trend", params);
  const weekday = useMdQuery<AttendanceWeekday>("attendance/weekday", params);
  const departments = useMdQuery<AttendanceDepartments>("attendance/departments", { ...params, limit: 50 });
  const heatmap = useMdQuery<AttendanceHeatmap>("attendance/heatmap", params);
  const overtime = useMdQuery<AttendanceOvertime>("attendance/overtime", { ...params, limit: 10 });
  const leave = useMdQuery<AttendanceLeave>("attendance/leave", params);

  const data = summary.data;
  const scopeText = data?.scope?.description ?? "the whole company";
  const where = `${label}, ${scopeText}`;
  // the older analytics cards read these three things
  const context: AskContext = {
    period: label,
    scope: scopeText,
    summary: data as unknown as AttendanceSummary | undefined,
  };
  usePublishAssistantContext(assistantContext(kind, data, label, scopeText));

  const todayOnly = !!data && data.measured === null;
  const live = data?.live;

  return (
    <div className="space-y-5" data-testid={`md-att-insights-${kind}`}>
      <InsightsFilterBar
        filters={filters}
        onWhen={setWhen}
        onScope={setScope}
        org={org.data}
        showType={false}
        testId="md-att-filters"
      />

      {summary.isError && (
        <ErrorBanner message={describeMdError(summary.error)} onRetry={() => void summary.refetch()} />
      )}
      {notesWithoutCoverage(data?.notes ?? []).map((note) => (
        <NoteBanner key={note}>{note}</NoteBanner>
      ))}

      <BriefingCard
        summary={data}
        loading={summary.isPending}
        title={`${page.title} in brief`}
        question={`Give me a short briefing on ${page.noun}' attendance (${where}): what is good, what is wrong, what to do first.`}
      />

      {live?.board && (
        <TodayBoard
          live={live}
          question={`Who among ${page.noun} is not in yet today (${scopeText}), and which departments are short?`}
          onOpen={(state) => setDrill({ kind: "today", state })}
        />
      )}

      {todayOnly ? (
        <EmptyBlock icon={Hourglass} title="Today is still running" testId="md-att-today-only">
          A rate needs at least one finished day. Pick an earlier month or a range of days to see attendance, absence
          and lateness; the cards above are who is in so far.
        </EmptyBlock>
      ) : (
        <>
          <KpiTiles
            summary={data}
            loading={summary.isPending}
            kind={kind}
            where={where}
            onDrill={(metric, title) => setDrill({ kind: "people", metric, title })}
          />
          <AttentionCard query={exceptions} context={context} />
          <div className="grid grid-cols-1 items-start gap-5 @4xl:grid-cols-12">
            <TrendCard query={trend} context={context} className="@4xl:col-span-8" />
            <WeekdayCard query={weekday} context={context} className="@4xl:col-span-4" />
          </div>
          <DepartmentCard
            query={departments}
            context={context}
            onDepartment={(name) => setScope(withDepartment(filters.scope, name))}
            onUnit={(id) => setScope(withUnit(filters.scope, id))}
            onType={() => {}}
          />
          <div className="grid grid-cols-1 items-start gap-5 @4xl:grid-cols-12">
            <HeatmapCard query={heatmap} context={context} className="@4xl:col-span-8" />
            <DayCard scope={{ ...filters.scope, type: kind }} context={context} className="@4xl:col-span-4" />
          </div>
          <ExceptionsCard query={exceptions} context={context} />
          <div className="grid grid-cols-1 items-start gap-5 @3xl:grid-cols-2">
            <OvertimeCard query={overtime} context={context} />
            <LeaveCard query={leave} context={context} />
          </div>
          <CoverageNote coverage={data?.coverage} context={context} />
        </>
      )}

      <DrillSheet
        drill={drill}
        params={params}
        kind={kind}
        where={where}
        onDrill={setDrill}
        onClose={() => setDrill(null)}
      />
    </div>
  );
}
