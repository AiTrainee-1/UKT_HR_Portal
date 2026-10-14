import { useMemo } from "react";
import { Banknote, CalendarClock, Hourglass, Moon, XCircle } from "lucide-react";
import { KpiTile, SkeletonKpis } from "@/components/payroll/kit/parts";
import { FilterSelect, LoadError, ResetButton, SearchField } from "@/components/payroll/panels/issues/panel-kit";
import { errorDetail } from "@/components/payroll/panels/issues/lists";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useOvertimeList } from "@/lib/api-client/custom-hooks";
import { VIEW_SAFE_ATTR } from "@/lib/view-only-lock";
import { formatDuration } from "@/pages/hr/settings/compensation/time";
import { MONTH_NAMES, countOf, fmtShifts, minutesText, monthYearFromUrl, todayIst, yearChoices } from "../logic";
import type { CompensationUrl } from "../logic";
import { SwitchOffNotice } from "../ui";
import { LegacySection } from "./LegacySection";
import { Type1Section } from "./Type1Section";
import { Type2Section } from "./Type2Section";
import { assignModes, filterOt, groupOt, otDepartments, otKpis, type2Pause } from "./ot-logic";

type SetUrl = (patch: Partial<CompensationUrl>) => void;

/**
 * OT Detection (staff only): the month's extra work past the shift end, in two clearly separate lists. Type 1 is the
 * automatic next-day late-in allowance (read-only). Type 2 is shift-based compensation that HR assigns as Relaxation or
 * Payment. Everything stays readable while a feature is off in Settings; only the changes are paused.
 */
export default function OtTab({
  featuresOff,
  url,
  setUrl,
}: {
  featuresOff: boolean;
  url: CompensationUrl;
  setUrl: SetUrl;
}) {
  const today = useMemo(() => todayIst(), []);
  const { month, year } = monthYearFromUrl(url.month, url.year, today);
  const query = useOvertimeList(month, year);
  const rows = useMemo(() => query.data?.results ?? [], [query.data]);
  const config = query.data?.config;

  const groups = useMemo(() => groupOt(rows), [rows]);
  const kpis = useMemo(() => otKpis(rows), [rows]);
  const filters = useMemo(() => ({ q: url.otq, dept: url.otdept }), [url.otq, url.otdept]);
  const departments = useMemo(() => otDepartments(rows), [rows]);
  const allowance = useMemo(() => filterOt(groups.allowance, filters), [groups.allowance, filters]);
  const waiting = useMemo(() => filterOt(groups.waiting, filters), [groups.waiting, filters]);
  const history = useMemo(() => filterOt(groups.history, filters), [groups.history, filters]);
  const legacy = useMemo(() => filterOt(groups.legacy, filters), [groups.legacy, filters]);

  const modes = assignModes(config);
  const pause = type2Pause(config, featuresOff);
  const loading = query.isLoading;
  const masterOn = !featuresOff && config?.masterEnabled !== false;
  const filtersOn = (url.otq ? 1 : 0) + (url.otdept ? 1 : 0);
  const years = yearChoices(today);

  const reset = () => setUrl({ otq: "", otdept: "" });

  return (
    <div className="space-y-4" data-testid="ot-tab">
      {/* what is switched off in Settings (the master switch has its own notice at the top of the page) */}
      {masterOn && config && !config.allowanceEnabled && (
        <SwitchOffNotice
          testId="ot-type1-off"
          title="Type 1 (next-day late-in allowance) is switched off."
          setting="allowance-enabled"
        >
          No new allowance is detected or given. The rows already earned stay readable below.
        </SwitchOffNotice>
      )}
      {masterOn && config && !config.shiftEnabled && (
        <SwitchOffNotice
          testId="ot-type2-off"
          title="Type 2 (shift-based compensation) is switched off."
          setting="shift-enabled"
        >
          Assigning and rejecting are paused. Everything already assigned or rejected stays readable below.
        </SwitchOffNotice>
      )}
      {masterOn && config && config.shiftEnabled && !config.relaxationEnabled && !config.payEnabled && (
        <SwitchOffNotice
          testId="ot-modes-off"
          title="Neither Relaxation nor Payment is switched on."
          setting="shift-relaxation"
        >
          Type 2 cannot be assigned until one of them is on.
        </SwitchOffNotice>
      )}

      {/* controls */}
      <div
        className="clay-card flex flex-wrap items-center gap-2 rounded-2xl border border-slate-100 p-3"
        role="search"
        aria-label="OT Detection filters"
        {...{ [VIEW_SAFE_ATTR]: "" }}
      >
        <Select value={String(month)} onValueChange={(v) => setUrl({ month: v })}>
          <SelectTrigger className="h-10 w-40" aria-label="Month" data-testid="ot-month">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MONTH_NAMES.map((name, i) => (
              <SelectItem key={name} value={String(i + 1)}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={String(year)} onValueChange={(v) => setUrl({ year: v })}>
          <SelectTrigger className="h-10 w-28" aria-label="Year" data-testid="ot-year">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {years.map((y) => (
              <SelectItem key={y} value={String(y)}>
                {y}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FilterSelect
          value={url.otdept}
          onChange={(v) => setUrl({ otdept: v })}
          options={departments.map((d) => ({ value: d, label: d }))}
          allLabel="All departments"
          label="Filter by department"
          testId="ot-dept"
          className="w-full sm:w-52"
        />
        <SearchField
          value={url.otq}
          onChange={(v) => setUrl({ otq: v })}
          placeholder="Search by name, code or department"
          label="Search overtime records"
          testId="ot-search"
          className="min-w-52 flex-1"
        />
        {filtersOn > 0 && <ResetButton count={filtersOn} onClick={reset} testId="ot-reset" />}
      </div>

      {query.isError && !query.data ? (
        <LoadError
          what="the overtime records"
          detail={errorDetail(query.error)}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
          testId="ot-error"
        />
      ) : (
        <>
          {loading ? (
            <SkeletonKpis count={5} className="xl:grid-cols-5" />
          ) : (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5" data-testid="ot-kpis">
              <KpiTile
                testId="ot-kpi-earned"
                label="Type 1 earned"
                value={kpis.allowanceEarned}
                sub={`${minutesText(kpis.allowanceMinutes)} allowed in all`}
                icon={Moon}
                tone="bg-slate-100 text-slate-800"
              />
              <KpiTile
                testId="ot-kpi-used"
                label="Type 1 used"
                value={kpis.allowanceUsed}
                sub={`${minutesText(kpis.allowanceUsedMinutes)} used · ${kpis.allowanceNotUsed} not used · ${kpis.allowancePending} pending`}
                icon={CalendarClock}
                tone="bg-emerald-50 text-emerald-800"
              />
              <KpiTile
                testId="ot-kpi-waiting"
                label="Type 2 waiting for HR"
                value={kpis.waiting}
                sub={
                  kpis.waiting > 0 ? `${fmtShifts(kpis.waitingSuggestedShifts)} shifts suggested` : "Nothing to decide"
                }
                icon={Hourglass}
                tone="bg-amber-50 text-amber-800"
              />
              <KpiTile
                testId="ot-kpi-assigned"
                label="Assigned this month"
                value={kpis.assigned}
                sub={`${fmtShifts(kpis.assignedShifts)} shifts · ${countOf(kpis.assignedRelaxation, "relaxation")}, ${countOf(kpis.assignedPay, "payment")}`}
                icon={Banknote}
                tone="bg-indigo-50 text-indigo-800"
              />
              <KpiTile
                testId="ot-kpi-rejected"
                label="Rejected"
                value={kpis.rejected}
                sub={kpis.rejected === 1 ? "record" : "records"}
                icon={XCircle}
                tone="bg-rose-50 text-rose-800"
              />
            </div>
          )}

          <Type1Section
            rows={allowance}
            total={groups.allowance.length}
            loading={loading}
            off={config?.allowanceEnabled === false}
          />
          <Type2Section
            waiting={waiting}
            waitingTotal={groups.waiting.length}
            history={history}
            historyTotal={groups.history.length}
            loading={loading}
            pause={pause}
            modes={modes}
            historyStatus={url.otstatus}
            onHistoryStatus={(v) => setUrl({ otstatus: v })}
          />
          <LegacySection
            rows={legacy}
            paused={!!pause && (featuresOff || config?.masterEnabled === false)}
            pauseReason="Paused: the OT / Compensation features are switched off in Settings → Payroll"
          />
          {query.data && (
            <p className="px-1 text-[11px] text-muted-foreground" data-testid="ot-footnote">
              {countOf(rows.length, "record")} in {MONTH_NAMES[month - 1]} {year}. Type 2 threshold:{" "}
              {formatDuration(config?.shiftMinExtraMinutes ?? 150)} past the shift end. Staff only: production employees
              are never listed.
            </p>
          )}
        </>
      )}
    </div>
  );
}
