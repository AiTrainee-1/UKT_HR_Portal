import { History as HistoryIcon } from "lucide-react";
import { EmptyNote, SkeletonKpis, SkeletonRows } from "@/components/payroll/kit/parts";
import { FilterSelect, LoadError } from "@/components/payroll/panels/issues/panel-kit";
import { errorDetail } from "@/components/payroll/panels/issues/lists";
import { useCompensationReport } from "@/lib/api-client/custom-hooks";
import { NestedTabs } from "@/components/ui/nested-tabs";
import { SubtabBar } from "@/components/ui/subtab-nav";
import { rangeLabel, type CompensationUrl } from "../logic";
import { PeriodBar } from "../period";
import { HISTORY_SUBS, nestedOf, pagePath, subPath } from "../routes";
import { RedemptionsCard, ReportSectionCard } from "./ReportSectionCard";
import { useReportFilters } from "./useReportFilters";

type SetUrl = (patch: Partial<CompensationUrl>) => void;

const HISTORY_BASE = pagePath("history");

/**
 * History: who benefited from each kind of compensation, one subtab per kind (its summary cards and its rows). Today, a
 * Week or a Month, a date, the department and the branch stay above the subtabs and apply to all of them; each subtab
 * says how many records it holds. Staff only; always readable, whatever the switches say. (The cross-type summary and the
 * Excel / CSV export are on the Reports page.) A kind with two sections shows one at a time as nested subtabs: Company windows
 * (Late-in window, Early-out window) and Holiday / Sunday work (the work, the balance redeemed).
 */

/** What each nested subtab lists: the kinds of record of its section. */
const NESTED_TYPES: Record<string, readonly string[]> = {
  "late-in": ["window_late_in"],
  "early-out": ["window_early_out"],
  work: ["holiday_work"],
  redeemed: ["holiday_work"],
};
export default function HistoryTab({
  sub,
  nested,
  featuresOff,
  isBranchScoped,
  url,
  setUrl,
}: {
  sub: string;
  /** The nested subtab of `sub`, when it has some (the page redirects a missing or unknown one before this renders). */
  nested: string | undefined;
  featuresOff: boolean;
  isBranchScoped: boolean;
  url: CompensationUrl;
  setUrl: SetUrl;
}) {
  const f = useReportFilters(url, isBranchScoped);
  // every kind in one request (the pills count them all), so a subtab switch is instant and shares Reports' answer
  const query = useCompensationReport({
    period: f.period,
    date: f.date,
    departmentId: f.departmentId,
    branchId: f.branchId,
  });
  const report = query.data;

  const info = HISTORY_SUBS.find((s) => s.value === sub) ?? HISTORY_SUBS[0];
  const sections = (types: readonly string[]) => (report?.sections ?? []).filter((s) => types.includes(s.type));
  const items = HISTORY_SUBS.map((s) => ({
    value: s.value,
    label: s.label,
    count: report ? sections(s.types).reduce((n, section) => n + section.rows.length, 0) : undefined,
  }));
  const nestedInfo = nestedOf("history", info.value);
  const rowsOf = (types: readonly string[]) => sections(types).reduce((n, section) => n + section.rows.length, 0);
  const redeemedCount = sections(["holiday_work"]).reduce((n, section) => n + (section.redemptions?.length ?? 0), 0);
  // Balance redeemed is listed only when there is some (as before); it stays while it is the one open
  const nestedItems = nestedInfo
    .filter((n) => n.value !== "redeemed" || redeemedCount > 0 || nested === "redeemed")
    .map((n) => ({
      value: n.value,
      label: n.label,
      count: report ? (n.value === "redeemed" ? redeemedCount : rowsOf(NESTED_TYPES[n.value] ?? [])) : undefined,
    }));
  const shown = sections(nested ? (NESTED_TYPES[nested] ?? info.types) : info.types);

  const content = (
    <>
      {query.isLoading ? (
        <div className="space-y-4" data-testid="history-loading">
          <SkeletonKpis count={3} className="md:grid-cols-3 xl:grid-cols-3" />
          <SkeletonRows rows={4} />
        </div>
      ) : query.isError && !report ? (
        <LoadError
          what="the report"
          detail={errorDetail(query.error)}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
          testId="history-error"
        />
      ) : report ? (
        <>
          <p className="px-1 text-xs font-semibold text-slate-600" data-testid="history-range">
            {rangeLabel(report.from, report.to)}
            {f.filtersOn > 0 ? " · with the filters on" : ""}
          </p>

          {shown.length === 0 ? (
            <EmptyNote icon={HistoryIcon} title="Nothing to show for this kind" testId="history-no-sections" />
          ) : (
            shown.map((section) =>
              nested === "redeemed" ? (
                <RedemptionsCard key={section.type} section={section} />
              ) : (
                <ReportSectionCard
                  key={section.type}
                  section={section}
                  masterOn={!featuresOff}
                  withRedemptions={nested === undefined}
                />
              ),
            )
          )}

          <p className="px-1 text-[11px] text-muted-foreground">
            Staff only: production employees are never part of Compensation. Each record is filed under the date it
            belongs to (the day off granted, the work day, the birthday). Overtime announced before the new rules is not
            in this history: it stays listed under Earlier records on the OT Detection page.
          </p>
        </>
      ) : null}
    </>
  );

  return (
    <div className="space-y-4" data-testid="history-tab">
      <SubtabBar base={HISTORY_BASE} items={items} value={info.value} testId="history-subtabs" />

      <PeriodBar
        period={f.period}
        date={f.date}
        today={f.today}
        onPeriod={(next) => setUrl({ period: next })}
        onDate={(next) => setUrl({ date: next === f.today ? "" : next })}
        testId="history-period"
      >
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          <FilterSelect
            value={url.dept}
            onChange={(v) => setUrl({ dept: v })}
            options={(f.departments ?? []).map((d) => ({ value: String(d.id), label: d.name }))}
            allLabel="All departments"
            label="Filter by department"
            testId="history-dept"
            className="h-9 w-full sm:w-48"
          />
          {!isBranchScoped && (
            <FilterSelect
              value={url.branch}
              onChange={(v) => setUrl({ branch: v })}
              options={(f.branches ?? []).map((b) => ({ value: String(b.id), label: b.name }))}
              allLabel="All branches"
              label="Filter by branch"
              testId="history-branch"
              className="h-9 w-full sm:w-44"
            />
          )}
        </div>
      </PeriodBar>

      {nestedItems.length > 0 && nested ? (
        <NestedTabs
          base={subPath("history", info.value)}
          value={nested}
          testId="history-nested"
          label={`Sections of ${info.label}`}
          items={nestedItems}
        >
          {content}
        </NestedTabs>
      ) : (
        content
      )}
    </div>
  );
}
