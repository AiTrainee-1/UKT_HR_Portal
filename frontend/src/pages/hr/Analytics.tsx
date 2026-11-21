import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  BarChart3,
  CalendarDays,
  Factory,
  FileSpreadsheet,
  FileText,
  Info,
  Loader2,
  Users,
} from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { RefreshButton } from "@/components/PageRefreshBar";
import { Chip, EmptyNote } from "@/components/payroll/kit/parts";
import { ExportMenu } from "@/components/payroll/kit/ExportMenu";
import { useUrlParams } from "@/components/payroll/kit/url-state";
import { Button } from "@/components/ui/button";
import { PillTabs } from "@/components/ui/pill-tabs";
import { canView, useAuth } from "@/contexts/AuthContext";
import { useListEmployeesLite } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { AttentionList } from "./analytics/AttentionList";
import { CategoryGrid } from "./analytics/CategoryGrid";
import { CategoryDistribution, DepartmentChart, WeeklyTrend } from "./analytics/Charts";
import { CategorySheet } from "./analytics/CategorySheet";
import { EmployeeSheet } from "./analytics/EmployeeSheet";
import { FilterBar, useDebouncedSearch } from "./analytics/FilterBar";
import { HodView } from "./analytics/HodView";
import { Insights, SummaryBand, resultSentence } from "./analytics/Overview";
import { errorText, fetchCategories, useAnalyticsSummary } from "./analytics/api";
import {
  TAB_LABEL,
  URL_DEFAULTS,
  buildInsights,
  dataGapNote,
  employeeParams,
  filterWords,
  filtersActive,
  isoOf,
  rangeLabel,
  serverParams,
  stateFromUrl,
  stateToUrl,
  type AnalyticsUrl,
  type Filters,
  type InsightAction,
  type LevelFilter,
} from "./analytics/logic";
import type { AnalyticsTab } from "./analytics/types";
import { useCompany } from "./report-log/useCompany";

const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView?.({ behavior: "smooth", block: "start" });

/**
 * HR Analytics (owner 2026-11-21): who has recurring attendance issues or unusual behaviour, and why, without opening
 * attendance records one by one. Staff and Production tabs share one set of filters (search, period, department,
 * employee), kept in the address with the open drill-down, so a reload or a shared link opens the same view. Insights
 * first (what stands out, the categories, who needs attention), numbers after (the HOD view, the charts). Read only.
 */
export default function Analytics() {
  const { user } = useAuth();
  const company = useCompany();
  const queryClient = useQueryClient();
  const [url, setUrl] = useUrlParams<AnalyticsUrl>(URL_DEFAULTS);
  const today = isoOf(new Date());
  const state = useMemo(() => stateFromUrl(url, today), [url, today]);

  // each tab is a permission of its own (analytics.staff / analytics.production): a role sees only the tabs it may
  const allowed = useMemo(
    () => (["staff", "production"] as AnalyticsTab[]).filter((t) => canView(user, `analytics.${t}`)),
    [user],
  );
  const tab: AnalyticsTab = allowed.includes(state.tab) ? state.tab : (allowed[0] ?? state.tab);

  const filters: Filters = useMemo(
    () => ({ tab, period: state.period, dept: state.dept, emp: state.emp, q: state.q }),
    [tab, state.period, state.dept, state.emp, state.q],
  );
  const params = useMemo(() => serverParams(filters), [filters]);
  const personParams = useMemo(() => employeeParams(filters), [filters]);
  const { data, isError, error, isFetching, isPlaceholderData, refetch } = useAnalyticsSummary(params);
  // a tab switch never shows the other tab's figures while its own load
  const summary = data && data.type === tab ? data : undefined;
  const loading = !summary && !isError;
  const updating = !!summary && isFetching && isPlaceholderData;
  const { data: employees } = useListEmployeesLite({ status: "active" });

  const [levelFilter, setLevelFilter] = useState<LevelFilter>("needs");
  const insights = useMemo(() => (summary ? buildInsights(summary) : []), [summary]);

  const setFilters = useCallback((patch: Partial<Filters>) => setUrl(stateToUrl(patch)), [setUrl]);
  const search = useDebouncedSearch(filters.q, (q) => setFilters({ q }));
  const switchTab = (next: string) => {
    if (next === tab) return;
    // every filter stays; only an open drill-down (it belongs to the tab) closes
    setUrl({ tab: next, cat: "", person: "" });
  };
  const clearFilters = () => setUrl({ period: "", from: "", to: "", dept: "", emp: "", q: "" });
  const openCategory = (key: string) => setUrl({ cat: key, person: "" });
  const openEmployee = (id: number) => setUrl({ person: String(id) });
  const pickLevel = (level: LevelFilter) => {
    setLevelFilter(level);
    scrollTo("attention-list");
  };
  const onInsight = (a: InsightAction) => {
    if (a.type === "level") pickLevel(a.level);
    else if (a.type === "category") openCategory(a.key);
    else if (a.type === "employee") openEmployee(a.id);
    else if (a.type === "department") setFilters({ dept: a.id });
    else scrollTo("hod-view");
  };

  const departmentName = summary?.options.departments.find((d) => d.id === filters.dept)?.name ?? null;
  const picked = (employees ?? []).find((e) => e.id === filters.emp);
  const employeeName = picked
    ? `${`${picked.firstName ?? ""} ${picked.lastName ?? ""}`.trim()} (${picked.employeeCode})`
    : null;
  const words = filterWords(filters, { department: departmentName, employee: employeeName });
  // the period asked for, at once (the server answers for the same days: it clamps `to` to today, as we do)
  const periodText = rangeLabel(filters.period.from, filters.period.to);
  const gapNote = dataGapNote(summary?.period.dataGaps);
  const openMeta = summary?.categories.find((c) => c.key === state.cat);

  const exportInput = async () => {
    if (!summary) throw new Error("The figures are still loading.");
    const categories = await fetchCategories(
      queryClient,
      summary.categories.map((c) => c.key),
      params,
    );
    return { ...company.excel, summary, filterText: words, levelFilter, categories, now: new Date() };
  };

  return (
    <HrLayout>
      <div className="min-w-0 space-y-5" data-ui-area="payroll" data-testid="analytics-page">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-2xl font-black text-gray-900">
              <BarChart3 size={22} className="text-indigo-600" /> Analytics
            </h2>
            <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">
              Who has recurring attendance issues or unusual patterns, and why, without opening records one by one.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {allowed.length === 1 && <Chip tone="accent">{TAB_LABEL[tab]}</Chip>}
              <Chip tone="info" icon={CalendarDays} className="text-xs">
                <span data-testid="period-label">{periodText}</span>
              </Chip>
              {words.map((w) => (
                <Chip key={w} tone="neutral">
                  {w}
                </Chip>
              ))}
              {updating && (
                <span className="inline-flex items-center gap-1 text-[11px] text-slate-500" role="status">
                  <Loader2 size={12} className="animate-spin" /> Updating
                </span>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <RefreshButton className="h-10" />
            <ExportMenu
              testId="analytics-export"
              label="Export"
              size="default"
              className="h-10 gap-2 border-emerald-200 text-emerald-700 hover:bg-emerald-50"
              heading={`${TAB_LABEL[tab]} · ${periodText}`}
              disabled={!summary}
              items={[
                {
                  key: "xlsx",
                  label: "Excel (.xlsx)",
                  hint: `Summary, one sheet per category with every record${tab === "staff" ? ", and the HODs" : ""}`,
                  icon: FileSpreadsheet,
                  run: async () => (await import("./analytics/export")).downloadPageExcel(await exportInput()),
                },
                {
                  key: "pdf",
                  label: "PDF",
                  hint: "A4 landscape: the figures, the list, each category's top 10",
                  icon: FileText,
                  run: async () => (await import("./analytics/export")).downloadPagePdf(await exportInput()),
                },
              ]}
            />
          </div>
        </div>

        {allowed.length > 1 && (
          <div className="max-w-full overflow-x-auto pb-0.5" data-testid="analytics-tabs">
            <PillTabs
              items={allowed.map((t) => ({
                value: t,
                label: TAB_LABEL[t],
                icon: t === "staff" ? <Users size={13} /> : <Factory size={13} />,
              }))}
              value={tab}
              onChange={switchTab}
              baseColor="#312e81"
              pillBg="#eef2ff"
              idleTextColor="#475569"
            />
          </div>
        )}

        <div className="z-20 -mx-1 rounded-2xl border border-slate-200/70 bg-white/80 p-2.5 shadow-sm backdrop-blur md:sticky md:-top-4 lg:-top-6">
          <FilterBar
            filters={filters}
            today={today}
            departments={summary?.options.departments ?? data?.options.departments ?? []}
            employees={employees}
            onChange={setFilters}
            onClear={clearFilters}
            narrowed={filtersActive(filters)}
            search={search}
          />
        </div>

        {gapNote && (
          <div
            className="flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600"
            data-testid="data-gap-note"
          >
            <Info size={14} className="mt-0.5 shrink-0 text-slate-400" />
            <p>{gapNote}. Nobody is counted absent on those days.</p>
          </div>
        )}

        <p className="sr-only" aria-live="polite" data-testid="analytics-live">
          {summary
            ? resultSentence(summary.totals)
            : isError
              ? "The figures could not be loaded."
              : "Loading the figures."}
        </p>

        {isError && !summary ? (
          <EmptyNote
            icon={AlertTriangle}
            title="The analytics could not be loaded"
            hint={errorText(error)}
            action={
              <Button variant="outline" size="sm" onClick={() => refetch()}>
                Retry
              </Button>
            }
            testId="analytics-error"
          />
        ) : (
          <div className={cn("space-y-5 transition-opacity", updating && "opacity-70")}>
            <SummaryBand
              totals={summary?.totals}
              tab={tab}
              loading={loading}
              levelFilter={levelFilter}
              onLevel={pickLevel}
            />
            <Insights insights={insights} loading={loading} onAction={onInsight} />
            <CategoryGrid
              categories={summary?.categories ?? []}
              employees={summary?.employees ?? []}
              weekly={summary?.weekly ?? []}
              loading={loading}
              onOpen={openCategory}
            />
            <AttentionList
              employees={summary?.employees ?? []}
              categories={summary?.categories ?? []}
              query={search.text}
              levelFilter={levelFilter}
              onLevel={setLevelFilter}
              loading={loading}
              onOpenEmployee={openEmployee}
              onOpenCategory={openCategory}
            />
            {tab === "staff" && <HodView hods={summary?.hods ?? []} loading={loading} />}
            <WeeklyTrend
              key={tab}
              weekly={summary?.weekly ?? []}
              categories={summary?.categories ?? []}
              loading={loading}
            />
            <div className="grid min-w-0 gap-5 xl:grid-cols-2">
              <CategoryDistribution categories={summary?.categories ?? []} loading={loading} onOpen={openCategory} />
              <DepartmentChart
                departments={summary?.departments ?? []}
                loading={loading}
                onPick={(id) => setFilters({ dept: id })}
              />
            </div>
          </div>
        )}

        <CategorySheet
          categoryKey={state.cat && !state.person ? state.cat : null}
          meta={openMeta}
          params={params}
          onClose={() => setUrl({ cat: "" })}
          onOpenEmployee={openEmployee}
        />
        <EmployeeSheet
          employeeId={state.person}
          params={personParams}
          company={company.excel}
          backTo={state.cat ? (openMeta?.label ?? "the category") : null}
          onBack={() => setUrl({ person: "" })}
          onClose={() => setUrl({ person: "", cat: "" })}
          onOpenCategory={openCategory}
        />
      </div>
    </HrLayout>
  );
}
