import { useMemo, useState } from "react";
import { Hourglass, UserCheck } from "lucide-react";
import { FilterBar, PeriodBar, ScopeBar } from "@/components/md/kit/FilterBar";
import MdPageHeader from "@/components/md/kit/MdPageHeader";
import { EmptyBlock, ErrorBanner, NoteBanner } from "@/components/md/kit/states";
import MdLayout from "@/components/md/MdLayout";
import { describeMdError, useMdOrg, useMdQuery } from "@/lib/api-client/custom-hooks/md";
import { usePublishAssistantContext } from "@/lib/md/assistant-store";
import { EVERYONE, periodParams, scopeParams, type PeriodChoice, type ScopeChoice } from "@/lib/md/period";
import AttentionCard from "./attendance/AttentionCard";
import CoverageNote from "./attendance/CoverageNote";
import DayCard from "./attendance/DayCard";
import DepartmentCard from "./attendance/DepartmentCard";
import ExceptionsCard from "./attendance/ExceptionsCard";
import HeatmapCard from "./attendance/HeatmapCard";
import KpiStrip from "./attendance/KpiStrip";
import LeaveCard from "./attendance/LeaveCard";
import OvertimeCard from "./attendance/OvertimeCard";
import TodayStrip from "./attendance/TodayStrip";
import TrendCard from "./attendance/TrendCard";
import WeekdayCard from "./attendance/WeekdayCard";
import {
  buildAssistantContext,
  notesWithoutCoverage,
  withDepartment,
  withType,
  withUnit,
  type AskContext,
} from "./attendance/logic";
import type {
  AttendanceDepartments,
  AttendanceExceptions,
  AttendanceHeatmap,
  AttendanceLeave,
  AttendanceOvertime,
  AttendanceSummary,
  AttendanceTrend,
  AttendanceWeekday,
} from "./attendance/types";

/**
 * Attendance Analytics: are people turning up, on time, and what does overtime cost? Exceptions first (who and where),
 * then the trend, the pattern by weekday and department, the people behind the numbers, overtime and leave. Every figure
 * is for complete days (today is shown live) and says how much of the period has attendance records behind it.
 */
export default function MdAttendance() {
  const [period, setPeriod] = useState<PeriodChoice>({ preset: "last_30_days" });
  const [scope, setScope] = useState<ScopeChoice>(EVERYONE);
  const params = useMemo(() => ({ ...periodParams(period), ...scopeParams(scope) }), [period, scope]);

  const org = useMdOrg();
  const summary = useMdQuery<AttendanceSummary>("attendance/summary", params);
  const exceptions = useMdQuery<AttendanceExceptions>("attendance/exceptions", { ...params, limit: 25 });
  const trend = useMdQuery<AttendanceTrend>("attendance/trend", params);
  const weekday = useMdQuery<AttendanceWeekday>("attendance/weekday", params);
  const departments = useMdQuery<AttendanceDepartments>("attendance/departments", { ...params, limit: 50 });
  const heatmap = useMdQuery<AttendanceHeatmap>("attendance/heatmap", params);
  const overtime = useMdQuery<AttendanceOvertime>("attendance/overtime", { ...params, limit: 10 });
  const leave = useMdQuery<AttendanceLeave>("attendance/leave", params);

  const data = summary.data;
  const context: AskContext = {
    period: data?.period?.label ?? "this period",
    scope: data?.scope?.description ?? "the whole company",
    summary: data,
  };
  usePublishAssistantContext(buildAssistantContext(data, context.period, context.scope));

  const todayOnly = !!data && data.measured === null;
  const live = data?.live;

  return (
    <MdLayout>
      <div className="mx-auto max-w-[1500px] space-y-5" data-testid="md-attendance-page">
        <MdPageHeader
          icon={UserCheck}
          title="Attendance Analytics"
          subtitle="Are people turning up, on time, and what does overtime cost?"
          updatedAt={data?.generatedAt}
        />
        <FilterBar>
          <PeriodBar value={period} onChange={setPeriod} />
          <ScopeBar value={scope} onChange={setScope} org={org.data} />
        </FilterBar>

        {summary.isError && (
          <ErrorBanner message={describeMdError(summary.error)} onRetry={() => void summary.refetch()} />
        )}
        {notesWithoutCoverage(data?.notes ?? []).map((note) => (
          <NoteBanner key={note}>{note}</NoteBanner>
        ))}

        {live && <TodayStrip live={live} provenance={data?.provenance} context={context} />}

        {todayOnly ? (
          <EmptyBlock icon={Hourglass} title="Today is still running" testId="md-attendance-today-only">
            A rate needs at least one finished day. Choose Last 7 days or Yesterday to see attendance, absence and
            lateness; the count above is who has punched in so far.
          </EmptyBlock>
        ) : (
          <>
            <KpiStrip summary={data} loading={summary.isPending} context={context} />
            <AttentionCard query={exceptions} context={context} />
            <div className="grid grid-cols-1 items-start gap-5 @4xl:grid-cols-12">
              <TrendCard query={trend} context={context} className="@4xl:col-span-8" />
              <WeekdayCard query={weekday} context={context} className="@4xl:col-span-4" />
            </div>
            <DepartmentCard
              query={departments}
              context={context}
              onDepartment={(name) => setScope((s) => withDepartment(s, name))}
              onUnit={(id) => setScope((s) => withUnit(s, id))}
              onType={(key) => setScope((s) => withType(s, key))}
            />
            <div className="grid grid-cols-1 items-start gap-5 @4xl:grid-cols-12">
              <HeatmapCard query={heatmap} context={context} className="@4xl:col-span-8" />
              <DayCard scope={scope} context={context} className="@4xl:col-span-4" />
            </div>
            <ExceptionsCard query={exceptions} context={context} />
            <div className="grid grid-cols-1 items-start gap-5 @3xl:grid-cols-2">
              <OvertimeCard query={overtime} context={context} />
              <LeaveCard query={leave} context={context} />
            </div>
            <CoverageNote coverage={data?.coverage} context={context} />
          </>
        )}
      </div>
    </MdLayout>
  );
}
