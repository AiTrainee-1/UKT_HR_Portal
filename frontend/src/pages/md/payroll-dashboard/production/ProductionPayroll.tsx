import { useEffect, useRef } from "react";
import { Building2, ChevronLeft, ChevronRight, LayoutDashboard, Users } from "lucide-react";
import { FilterBar, ScopeBar } from "@/components/md/kit/FilterBar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useMdOrg } from "@/lib/api-client/custom-hooks/md";
import { usePublishAssistantContext, type AssistantPageContext } from "@/lib/md/assistant-store";
import { inrCompact, num, pct } from "@/lib/md/format";
import { describeScope } from "@/lib/md/period";
import { cn } from "@/lib/utils";
import { orgFor } from "../logic";
import { SearchBox } from "../parts";
import type { ProdCycleInfo, ProdPeriodBrief } from "../types";
import DepartmentsView from "./DepartmentsView";
import { prodScopeOf, type ProdState, type ProdView } from "./logic";
import OverviewView from "./OverviewView";
import { cameFromWorkers, FROM_WORKERS_STATE, useProdState, useProductionPayroll, type ProdQueries } from "./queries";
import WorkerProfile from "./WorkerProfile";
import WorkersView from "./WorkersView";

const TABS: { id: ProdView; label: string; icon: typeof Users }[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "departments", label: "Departments", icon: Building2 },
  { id: "workers", label: "Workers", icon: Users },
];

function ProdTabs({ value, onChange }: { value: ProdView; onChange: (view: ProdView) => void }) {
  return (
    <div
      role="tablist"
      aria-label="Production payroll views"
      className="md-seg md-shell-seg grid w-full grid-cols-3 @lg:inline-flex @lg:w-auto"
      data-testid="md-prod-tabs"
    >
      {TABS.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={value === id}
          data-testid={`md-prod-tab-${id}`}
          onClick={() => onChange(id)}
          className={cn(
            "md-seg-item min-h-9 justify-center whitespace-nowrap px-2 text-[12.5px] @lg:px-4 @lg:text-[13px]",
            value === id && "md-money-seg-on",
          )}
        >
          <Icon size={14} strokeWidth={2.2} aria-hidden="true" className="hidden shrink-0 @sm:block" />
          {label}
        </button>
      ))}
    </div>
  );
}

/** The cycles that have payroll, as a switch (only those that exist). */
function CycleSwitch({
  cycles,
  value,
  onChange,
}: {
  cycles: ProdCycleInfo[];
  value: string;
  onChange: (cycle: ProdCycleInfo["cycle"]) => void;
}) {
  if (cycles.length === 0) return null;
  return (
    <div className="max-w-full overflow-x-auto scrollbar-hide" data-testid="md-prod-cycles">
      <div role="tablist" aria-label="Pay cycle" className="md-seg md-shell-seg md-shell-seg-sm">
        {cycles.map((c) => (
          <button
            key={c.cycle}
            type="button"
            role="tab"
            aria-selected={c.cycle === value}
            onClick={() => onChange(c.cycle)}
            className={cn("md-seg-item whitespace-nowrap", c.cycle === value && "md-money-seg-on")}
            data-testid={`md-prod-cycle-${c.cycle}`}
            title={`${c.periods} period${c.periods === 1 ? "" : "s"} with payroll${c.assigned ? `, ${c.assigned} workers on it now` : ""}`}
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The cycle's periods (newest first), with arrows to step to the older / newer one. */
function PeriodPicker({
  periods,
  value,
  onChange,
}: {
  periods: ProdPeriodBrief[];
  value: string;
  onChange: (key: string) => void;
}) {
  if (periods.length === 0) return null;
  const index = periods.findIndex((p) => p.key === value);
  const older = index >= 0 ? periods[index + 1] : undefined;
  const newer = index > 0 ? periods[index - 1] : undefined;
  const arrow =
    // p-0 + a non-shrinking icon: the glass button's own padding would otherwise squeeze the chevron to nothing
    "md-btn inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg p-0 text-md-ink-soft disabled:opacity-40";
  return (
    <div
      role="group"
      aria-label="Pay period"
      className="flex max-w-full items-center gap-1.5"
      data-testid="md-prod-period"
    >
      <button
        type="button"
        className={arrow}
        disabled={!older}
        onClick={() => older && onChange(older.key)}
        aria-label="Older period"
        data-testid="md-prod-period-prev"
      >
        <ChevronLeft size={15} aria-hidden className="shrink-0" />
      </button>
      {/* "" (not undefined) when the period is not in the list: the select stays controlled and shows its placeholder */}
      <Select value={index >= 0 ? value : ""} onValueChange={onChange}>
        <SelectTrigger
          className="md-field h-9 min-w-0 flex-1 text-xs font-semibold sm:w-[16rem] sm:flex-none"
          aria-label="Pay period"
          data-testid="md-prod-period-select"
        >
          <SelectValue placeholder="Choose a period" />
        </SelectTrigger>
        <SelectContent>
          {periods.map((p) => (
            <SelectItem key={p.key} value={p.key}>
              {p.label} · {p.stateLabel}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <button
        type="button"
        className={arrow}
        disabled={!newer}
        onClick={() => newer && onChange(newer.key)}
        aria-label="Newer period"
        data-testid="md-prod-period-next"
      >
        <ChevronRight size={15} aria-hidden className="shrink-0" />
      </button>
    </div>
  );
}

const VIEW_NAME: Record<ProdView, string> = { overview: "Overview", departments: "Departments", workers: "Workers" };

function assistantContext(state: ProdState, q: ProdQueries, branchName: string | undefined): AssistantPageContext {
  const o = q.overview.data;
  const worker = state.worker && q.person.data?.employee.id === state.worker ? q.person.data : undefined;
  const filters: AssistantPageContext["filters"] = {
    Payroll: "Production (pay cycles)",
    View: worker ? "One worker's pay periods" : VIEW_NAME[state.view],
    Cycle: o?.cycleLabel ?? (state.cycle || "Main cycle"),
    Period: o?.period?.label ?? (state.period || "Latest ended period"),
    Scope: describeScope(prodScopeOf(state), branchName, state.department || undefined),
    Search: state.view === "workers" && state.q ? state.q : undefined,
    Worker: worker ? `${worker.employee.name} (${worker.employee.code})` : undefined,
  };
  let summary: AssistantPageContext["summary"];
  if (worker) {
    const t = worker.totals;
    summary = {
      Worker: `${worker.employee.name}, ${worker.employee.code}`,
      Cycle: worker.employee.cycleLabel,
      "Rate per shift": worker.employee.ratePerShift != null ? inrCompact(worker.employee.ratePerShift) : null,
      "Periods shown": worker.periods.length,
      Shifts: num(t.shifts, 1),
      "Gross pay": inrCompact(t.grossPay),
      "Net paid": inrCompact(t.netPaid),
    };
  } else if (o?.current) {
    const c = o.current;
    summary = {
      Workers: num(c.employees),
      Shifts: num(c.shifts, 1),
      "Gross pay": inrCompact(c.grossPay),
      "Excess - detection": inrCompact(c.bonus),
      Deductions: inrCompact(c.deductions.total),
      "Net paid": inrCompact(c.netPaid),
      "Company cost": inrCompact(c.companyCost),
      Attendance: pct(c.attendancePct),
      "Period status": o.status?.label ?? null,
      "Waiting in New Joiners": o.status?.parked.count ? num(o.status.parked.count) : null,
    };
  }
  return { page: "payroll", title: "Production payroll", filters, summary };
}

let listScroll = 0;
const scroller = () => document.querySelector("main");

/**
 * Production payroll (/md/payroll?kind=production): per pay cycle and period, like HR's Production Payroll pages. A cycle
 * switch (only the cycles that have payroll), the cycle's periods (latest ended first), the unit and department, and three
 * tabs: Overview (the period's figures, status, trend, months, year), Departments and Workers (each worker's pay periods
 * open inside the page). All of it lives in the address.
 */
export default function ProductionPayroll() {
  const [state, update] = useProdState();
  const org = useMdOrg();
  const q = useProductionPayroll(state);
  const overview = q.overview.data;

  const previousWorker = useRef(state.worker);
  useEffect(() => {
    const was = previousWorker.current;
    previousWorker.current = state.worker;
    const main = scroller();
    if (!main || was === state.worker) return;
    if (state.worker) main.scrollTo({ top: 0 });
    else if (was) requestAnimationFrame(() => (main.scrollTop = listScroll));
  }, [state.worker]);

  const openWorker = (id: number) => {
    listScroll = scroller()?.scrollTop ?? 0;
    update({ worker: id }, { push: true, historyState: FROM_WORKERS_STATE });
  };
  const backToList = () => {
    if (cameFromWorkers()) window.history.back();
    else update({ worker: null });
  };

  const branchName = org.data?.branches.find((b) => String(b.id) === state.branch)?.name;
  usePublishAssistantContext(assistantContext(state, q, branchName));

  return (
    <div
      className="space-y-4 @lg:space-y-5"
      data-testid="md-pay-production"
      data-view={state.worker ? "worker" : state.view}
    >
      <ProdTabs value={state.view} onChange={(view) => update({ view, worker: null }, { push: true })} />

      {!state.worker && (
        <FilterBar>
          <CycleSwitch
            cycles={overview?.cycles ?? []}
            value={q.cycle}
            onChange={(cycle) => update({ cycle, period: "" })}
          />
          <PeriodPicker
            periods={overview?.periods ?? []}
            value={q.period}
            onChange={(period) => update({ period, cycle: q.cycle as ProdState["cycle"] })}
          />
          <ScopeBar
            value={prodScopeOf(state)}
            onChange={(s) => update({ branch: s.branch, department: s.department })}
            org={orgFor(org.data, overview?.departments)}
            showType={false}
          />
          {state.view === "workers" && <SearchBox value={state.q} onChange={(text) => update({ q: text })} />}
        </FilterBar>
      )}

      {state.worker ? (
        <WorkerProfile query={q.person} period={q.period} onBack={backToList} />
      ) : state.view === "departments" ? (
        <DepartmentsView
          query={q.departments}
          chosen={state.department}
          onOpen={(department) => update({ view: "workers", department, q: "" }, { push: true })}
        />
      ) : state.view === "workers" ? (
        <WorkersView query={q.people} state={state} update={update} onOpen={openWorker} />
      ) : (
        <OverviewView
          query={q.overview}
          onSelectPeriod={(period) => update({ period, cycle: q.cycle as ProdState["cycle"] })}
          onLatest={() => update({ period: "" })}
        />
      )}
    </div>
  );
}
