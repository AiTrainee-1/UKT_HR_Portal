import { useMemo } from "react";
import { Archive, Banknote, CalendarClock, Hourglass, Moon, XCircle } from "lucide-react";
import { EmptyNote, KpiTile, SkeletonKpis } from "@/components/payroll/kit/parts";
import { FilterSelect, LoadError, ResetButton, SearchField } from "@/components/payroll/panels/issues/panel-kit";
import { errorDetail } from "@/components/payroll/panels/issues/lists";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useDraft } from "@/hooks/use-debounced";
import { useCompensationConfig, useOvertimeList } from "@/lib/api-client/custom-hooks";
import { VIEW_SAFE_ATTR } from "@/lib/view-only-lock";
import { formatDuration } from "@/pages/hr/settings/compensation/time";
import { SubtabBar } from "@/components/ui/subtab-nav";
import {
  MONTH_NAMES,
  countOf,
  dateShort,
  fmtShifts,
  minutesText,
  monthYearFromUrl,
  todayIst,
  yearChoices,
} from "../logic";
import type { CompensationUrl } from "../logic";
import { NestedTabs } from "@/components/ui/nested-tabs";
import { OT_NESTED, OT_SUBS, OT_SUB_LABEL, pagePath, subPath, type OtSub } from "../routes";
import { keepOpenNested, openDefaultNested, useCanOpen } from "../visible";
import { SwitchOffNotice } from "../ui";
import { LegacySection } from "./LegacySection";
import { Type1How, Type1Section } from "./Type1Section";
import { Type2Section, type Type2View } from "./Type2Section";
import {
  assignModes,
  claimPause,
  claimsFromOf,
  filterOt,
  filterType1,
  groupOt,
  isType1Filter,
  otDepartments,
  otKpis,
  type2Pause,
} from "./ot-logic";

type SetUrl = (patch: Partial<CompensationUrl>) => void;

const OT_BASE = pagePath("ot");

/**
 * OT Detection (staff only): the month's extra work past the shift end, in subtabs that each show one list. Type 1 is the
 * next-day late-in allowance and Type 2 the shift-based credit; from the claims date (Settings -> Compensation) both are
 * given only after a claim (by the employee in the apps, or by HR here) is approved by the employee's Department Head, and
 * HR may still pay a Type 2 record. Earlier records are the ones made before the overhaul. The month, the filters and the
 * five tiles stay on top of every subtab. Type 1 and Type 2 show one section at a time as nested subtabs (the list, the
 * decisions, how it is worked out), each with its count where it has one. Everything stays readable while a feature is off
 * in Settings; only the changes are paused.
 */
export default function OtTab({
  sub,
  nested,
  featuresOff,
  url,
  setUrl,
}: {
  sub: OtSub;
  /** The nested subtab of Type 1 / Type 2 (the page redirects a missing or unknown one before this renders). */
  nested: string | undefined;
  featuresOff: boolean;
  url: CompensationUrl;
  setUrl: SetUrl;
}) {
  const canOpen = useCanOpen();
  const today = useMemo(() => todayIst(), []);
  const { month, year } = monthYearFromUrl(url.month, url.year, today);
  const query = useOvertimeList(month, year);
  const rows = useMemo(() => query.data?.results ?? [], [query.data]);
  const config = query.data?.config;
  // the claim workflow's start date: the OT list may name it, the Compensation settings always do (a newer server)
  const rules = useCompensationConfig();
  const claimsFrom = claimsFromOf(config?.claimsFrom, rules.data?.claims?.from);

  const groups = useMemo(() => groupOt(rows), [rows]);
  const kpis = useMemo(() => otKpis(rows, claimsFrom), [rows, claimsFrom]);
  // The box shows every letter; the address (and the lists filtered from it) changes once typing pauses, so the page is
  // not re-rendered per keystroke.
  const [searchDraft, setSearchDraft] = useDraft(url.otq, (otq) => setUrl({ otq }));
  const filters = useMemo(() => ({ q: url.otq, dept: url.otdept }), [url.otq, url.otdept]);
  const departments = useMemo(() => otDepartments(rows), [rows]);
  const type1Status = isType1Filter(url.ot1status) ? url.ot1status : "all";
  const allowance = useMemo(
    () => filterType1(filterOt(groups.allowance, filters), type1Status, claimsFrom),
    [groups.allowance, filters, type1Status, claimsFrom],
  );
  const waiting = useMemo(() => filterOt(groups.waiting, filters), [groups.waiting, filters]);
  const history = useMemo(() => filterOt(groups.history, filters), [groups.history, filters]);
  const legacy = useMemo(() => filterOt(groups.legacy, filters), [groups.legacy, filters]);

  const modes = assignModes(config);
  const pause = type2Pause(config, featuresOff);
  const pause1 = claimPause(config, featuresOff, 1);
  const pause2 = claimPause(config, featuresOff, 2);
  const loading = query.isLoading;
  const masterOn = !featuresOff && config?.masterEnabled !== false;
  const filtersOn = (url.otq ? 1 : 0) + (url.otdept ? 1 : 0) + (sub === "type-1" && type1Status !== "all" ? 1 : 0);
  const years = yearChoices(today);

  const reset = () => setUrl({ otq: "", otdept: "", ot1status: "all" });

  return (
    <div className="space-y-4" data-testid="ot-tab">
      <SubtabBar
        base={OT_BASE}
        value={sub}
        testId="ot-subtabs"
        items={OT_SUBS.filter((v) => v !== "earlier" || groups.legacy.length > 0 || sub === "earlier")
          .filter((v) => v === sub || canOpen(subPath("ot", v)))
          .map((v) => ({
            value: v,
            label: OT_SUB_LABEL[v],
          }))}
        landing={(next) => openDefaultNested(canOpen, "ot", next)}
      />

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
          value={searchDraft}
          onChange={setSearchDraft}
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
                sub={`${minutesText(kpis.allowanceMinutes)} allowed in all${
                  kpis.allowanceClaimable + kpis.allowanceClaimPending > 0
                    ? ` · ${kpis.allowanceClaimable} claimable · ${kpis.allowanceClaimPending} with the HOD`
                    : ""
                }`}
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
                label="Type 2 waiting"
                value={kpis.waiting}
                sub={
                  kpis.waiting > 0
                    ? `${fmtShifts(kpis.waitingSuggestedShifts)} shifts suggested${
                        kpis.waitingClaimPending > 0 ? ` · ${kpis.waitingClaimPending} with the HOD` : ""
                      }`
                    : "Nothing to decide"
                }
                icon={Hourglass}
                tone="bg-amber-50 text-amber-800"
              />
              <KpiTile
                testId="ot-kpi-assigned"
                label={kpis.credited > 0 ? "Given this month" : "Assigned this month"}
                value={kpis.assigned + kpis.credited}
                sub={`${fmtShifts(kpis.assignedShifts + kpis.creditedShifts)} shifts · ${countOf(kpis.assignedRelaxation, "relaxation")}, ${countOf(kpis.assignedPay, "payment")}${
                  kpis.credited > 0 ? `, ${kpis.credited} credited by claim` : ""
                }`}
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

          {sub === "type-1" && (
            <>
              {masterOn && config && !config.allowanceEnabled && (
                <SwitchOffNotice
                  testId="ot-type1-off"
                  title="Type 1 (next-day late-in allowance) is switched off."
                  setting="allowance-enabled"
                >
                  No new allowance is detected, claimed or given. The rows already earned stay readable below.
                </SwitchOffNotice>
              )}
              <NestedTabs
                base={subPath("ot", "type-1")}
                value={nested ?? "allowance"}
                testId="ot-type1-nested"
                label="Sections of Type 1"
                items={keepOpenNested(canOpen, "ot", "type-1", [
                  {
                    value: "allowance",
                    label: OT_NESTED["type-1"][0].label,
                    count: loading ? undefined : groups.allowance.length,
                  },
                  { value: "how", label: OT_NESTED["type-1"][1].label },
                ])}
              >
                {nested === "how" ? (
                  <Type1How claimsFrom={claimsFrom} />
                ) : (
                  <Type1Section
                    rows={allowance}
                    total={groups.allowance.length}
                    loading={loading}
                    off={config?.allowanceEnabled === false}
                    claimsFrom={claimsFrom}
                    pause={pause1}
                    status={type1Status}
                    onStatus={(v) => setUrl({ ot1status: v })}
                  />
                )}
              </NestedTabs>
            </>
          )}
          {sub === "type-2" && (
            <>
              {masterOn && config && !config.shiftEnabled && (
                <SwitchOffNotice
                  testId="ot-type2-off"
                  title="Type 2 (shift-based compensation) is switched off."
                  setting="shift-enabled"
                >
                  Claiming, paying and rejecting are paused. Everything already decided stays readable below.
                </SwitchOffNotice>
              )}
              {masterOn && config && config.shiftEnabled && !config.relaxationEnabled && !config.payEnabled && (
                <SwitchOffNotice
                  testId="ot-modes-off"
                  title="Neither Relaxation nor Payment is switched on."
                  setting="shift-relaxation"
                >
                  {claimsFrom
                    ? "HR cannot pay or assign Type 2 until one of them is on; claims still go to the Department Head."
                    : "Type 2 cannot be assigned until one of them is on."}
                </SwitchOffNotice>
              )}
              <NestedTabs
                base={subPath("ot", "type-2")}
                value={nested ?? "waiting"}
                testId="ot-type2-nested"
                label="Sections of Type 2"
                items={keepOpenNested(canOpen, "ot", "type-2", [
                  {
                    value: "waiting",
                    label: OT_NESTED["type-2"][0].label,
                    count: loading ? undefined : groups.waiting.length,
                  },
                  {
                    value: "assigned",
                    label: OT_NESTED["type-2"][1].label,
                    count: loading ? undefined : groups.history.length,
                  },
                  { value: "how", label: OT_NESTED["type-2"][2].label },
                ])}
              >
                <Type2Section
                  view={(nested ?? "waiting") as Type2View}
                  waiting={waiting}
                  waitingTotal={groups.waiting.length}
                  history={history}
                  historyTotal={groups.history.length}
                  loading={loading}
                  pause={pause}
                  modes={modes}
                  historyStatus={url.otstatus}
                  onHistoryStatus={(v) => setUrl({ otstatus: v })}
                  claimsFrom={claimsFrom}
                  claimPause={pause2}
                />
              </NestedTabs>
            </>
          )}
          {sub === "earlier" &&
            (legacy.length > 0 ? (
              <LegacySection
                rows={legacy}
                paused={!!pause && (featuresOff || config?.masterEnabled === false)}
                pauseReason="Paused: the OT / Compensation features are switched off in Settings → Payroll"
              />
            ) : (
              <EmptyNote
                icon={Archive}
                title={groups.legacy.length > 0 ? "No earlier record matches these filters" : "No earlier records"}
                hint={
                  groups.legacy.length > 0
                    ? "Change the search or the department to see the others."
                    : "Overtime announced before the new rules appears here. Nothing from before is left in this month."
                }
                testId="ot-earlier-empty"
              />
            ))}
          {query.data && (
            <p className="px-1 text-[11px] text-muted-foreground" data-testid="ot-footnote">
              {countOf(rows.length, "record")} in {MONTH_NAMES[month - 1]} {year}. Type 2 threshold:{" "}
              {formatDuration(config?.shiftMinExtraMinutes ?? 150)} past the shift end.
              {claimsFrom ? ` Claims apply from ${dateShort(claimsFrom)}; earlier days keep the old rules.` : ""} Staff
              only: production employees are never listed.
            </p>
          )}
        </>
      )}
    </div>
  );
}
