import { useState } from "react";
import {
  CalendarClock,
  Check,
  Circle,
  CircleAlert,
  CircleCheck,
  Clock,
  Coins,
  Factory,
  HandCoins,
  Hourglass,
  Info,
  Landmark,
  Percent,
  Receipt,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import SectionCard from "@/components/md/kit/SectionCard";
import StatCard, { type StatTone } from "@/components/md/kit/StatCard";
import { EmptyBlock, NoteBanner } from "@/components/md/kit/states";
import { dayLong, inr, inrCompact, num, pct } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import { GLOSSARY } from "../glossary";
import { arrowText, changeBetween, deltaOf, sortRows, type SortDir, type StatusTone } from "../logic";
import { CardError, ChartLegend, Explain, Figure, ToneChip, failed } from "../parts";
import SortTable, { type Col } from "../SortTable";
import type { ProdOverviewResponse, ProdPeriodRow, ProdPeriodStatus, ProdYearBlock } from "../types";
import YearCompare, { type YearSide } from "../YearCompare";
import { MonthCycleChart, PERIOD_LEGEND, PeriodTrendChart, monthLegend } from "./charts";
import {
  cyclesIn,
  deductionLines,
  monthCycleRows,
  periodRows,
  periodTone,
  prodChange,
  prodValue,
  type ProdKpiKey,
} from "./logic";
import type { ProdQueries } from "./queries";

const STATUS_ICON: Record<StatusTone, LucideIcon> = {
  success: CircleCheck,
  warning: Hourglass,
  danger: CircleAlert,
  info: Info,
  neutral: CalendarClock,
};

const day = (iso: string | null | undefined) => (iso ? dayLong(iso.slice(0, 10)) : null);

/** Generated -> Payroll Done -> Paid, with the dates, for one period. */
function PeriodSteps({ status }: { status: ProdPeriodStatus }) {
  const done = status.locked;
  const paid = status.state === "paid";
  const steps = [
    {
      id: "generated",
      label: "Generated",
      done: status.slips > 0,
      current: !done && !paid,
      when: null as string | null,
      note: !done && !paid ? "open: HR can work it out again" : null,
    },
    {
      id: "finalized",
      label: "Payroll Done",
      done,
      current: done && !paid,
      when: day(status.finalizedAt),
      note:
        done && !paid && status.paymentPendingDays != null
          ? `payment pending ${num(status.paymentPendingDays)} days`
          : status.finalizedBy
            ? `by ${status.finalizedBy}`
            : null,
    },
    {
      id: "paid",
      label: "Paid",
      done: paid,
      current: paid,
      when: day(status.paidOn ?? status.paidAt),
      note: status.daysToPay != null ? `${num(status.daysToPay)} days after Payroll Done` : null,
    },
  ];
  return (
    <ol className="grid grid-cols-3 gap-2" data-testid="md-prod-steps">
      {steps.map((s) => (
        <li
          key={s.id}
          className={cn("md-money-metric flex flex-col gap-1", s.current && "md-money-metric-wine")}
          data-testid={`md-prod-step-${s.id}`}
          data-done={s.done ? "true" : "false"}
        >
          <span className="flex items-center gap-1.5 text-[12.5px] font-extrabold text-md-ink">
            {s.done ? <Check size={14} aria-hidden /> : <Circle size={12} aria-hidden className="opacity-50" />}
            {s.label}
          </span>
          <span className="text-[11.5px] font-semibold tabular-nums text-md-ink-soft">
            {s.when ?? (s.done ? "done" : "not yet")}
          </span>
          {s.note && <span className="text-[11px] leading-snug text-md-ink-soft">{s.note}</span>}
        </li>
      ))}
    </ol>
  );
}

/** Which period the figures describe and where it stands, right under the filters. */
export function PeriodStatusCard({ data }: { data: ProdOverviewResponse }) {
  const status = data.status!;
  const tone = periodTone(status.state);
  const Icon = STATUS_ICON[tone];
  return (
    <div className="space-y-3">
      <div
        className={cn("md-card md-money-status", `md-money-t-${tone}`)}
        data-testid="md-prod-status"
        data-state={status.state}
      >
        <span className="md-money-tile md-money-tile-solid">
          <Icon size={20} aria-hidden />
        </span>
        <div className="min-w-0 flex-[1_1_15rem]">
          <p className="flex flex-wrap items-center gap-2 text-[17px] font-black leading-tight tracking-tight text-md-ink">
            <span data-testid="md-prod-status-period">
              {data.cycleLabel} · {data.period?.label}
            </span>
            <ToneChip tone={tone}>{status.label}</ToneChip>
          </p>
          <p className="mt-1 text-[13px] leading-snug text-md-ink-soft" data-testid="md-prod-status-detail">
            {status.detail}
          </p>
        </div>
        <dl className="flex gap-5 text-[13px] sm:border-l sm:border-md-line sm:pl-5">
          <div>
            <dt className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-md-ink-soft">Workers</dt>
            <dd className="mt-0.5 font-bold tabular-nums text-md-ink">{num(data.current?.employees)}</dd>
          </div>
          <div>
            <dt className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-md-ink-soft">Net paid</dt>
            <dd className="mt-0.5 font-bold tabular-nums text-md-ink">{inrCompact(data.current?.netPaid)}</dd>
          </div>
        </dl>
        <Explain ids={["prod-state", "prod-cycle"]} />
      </div>
      <PeriodSteps status={status} />
      <div className="grid grid-cols-2 gap-2.5 @3xl:grid-cols-4" data-testid="md-prod-status-figures">
        <Figure
          label="Verified (Cleared)"
          value={`${num(status.clearedSlips)} of ${num(status.slips)}`}
          testId="md-prod-cleared"
        />
        <Figure
          label="Paid"
          value={`${num(status.paidSlips)} of ${num(status.slips)}`}
          sub={status.unpaidSlips ? `${inrCompact(status.unpaidNet)} not paid yet` : "everyone paid"}
          testId="md-prod-paid"
        />
        <Figure
          label="Waiting in New Joiners"
          value={num(status.parked.count)}
          sub={
            status.parked.count
              ? `${num(status.parked.newJoiners)} new, ${num(status.parked.movedIn)} moved in · ${inrCompact(status.parked.net)}, not in the figures`
              : "none"
          }
          testId="md-prod-parked"
        />
        <Figure
          label="Left since"
          value={num(status.leftSince)}
          sub={status.leftSince ? `${inrCompact(status.leftSinceNet)} net, in these figures` : "everyone still active"}
          testId="md-prod-left"
        />
      </div>
    </div>
  );
}

type Kpi = {
  key: ProdKpiKey;
  label: string;
  icon: LucideIcon;
  tone: StatTone;
  kind: "money" | "count" | "days" | "pct";
  goodWhen: "up" | "down" | "neutral";
  ids: string[];
  sub: (d: ProdOverviewResponse) => string;
};

const KPIS: Kpi[] = [
  {
    key: "companyCost",
    label: "Company cost",
    icon: Landmark,
    tone: "blue",
    kind: "money",
    goodWhen: "down",
    ids: ["prod-cost"],
    sub: (d) => `incl. ${inrCompact(d.current?.employerPfEsi)} PF / ESI`,
  },
  {
    key: "grossPay",
    label: "Gross pay",
    icon: Coins,
    tone: "teal",
    kind: "money",
    goodWhen: "neutral",
    ids: ["prod-gross"],
    sub: (d) => `shifts x rate (avg ${inr(d.current?.averageRatePerShift)} a shift)`,
  },
  {
    key: "shifts",
    label: "Shifts",
    icon: Clock,
    tone: "amber",
    kind: "days",
    goodWhen: "neutral",
    ids: ["prod-shifts"],
    sub: (d) => `${num(d.current?.shiftsPerWorker, 1)} per worker`,
  },
  {
    key: "employees",
    label: "Workers paid",
    icon: Users,
    tone: "slate",
    kind: "count",
    goodWhen: "neutral",
    ids: ["prod-cycle"],
    sub: (d) => `${num(d.current?.slips)} payslips`,
  },
  {
    key: "bonus",
    label: "Excess - detection",
    icon: HandCoins,
    tone: "teal",
    kind: "money",
    goodWhen: "neutral",
    ids: ["excess"],
    sub: (d) => `+${inrCompact(d.current?.excess)} excess · -${inrCompact(d.current?.detection)} detection`,
  },
  {
    key: "deductions",
    label: "Deductions",
    icon: Receipt,
    tone: "slate",
    kind: "money",
    goodWhen: "neutral",
    ids: ["deductions"],
    sub: (d) =>
      `PF ${inrCompact(d.current?.deductions.pf)} · ESI ${inrCompact(d.current?.deductions.esi)} · advance ${inrCompact(d.current?.deductions.advance)}`,
  },
  {
    key: "netPaid",
    label: "Net paid",
    icon: Wallet,
    tone: "green",
    kind: "money",
    goodWhen: "neutral",
    ids: ["prod-net"],
    sub: (d) => `${inr(d.current?.averageNetPerWorker)} a worker`,
  },
  {
    key: "attendancePct",
    label: "Attendance",
    icon: Percent,
    tone: "purple",
    kind: "pct",
    goodWhen: "up",
    ids: ["prod-shifts"],
    sub: (d) => `${num(d.current?.daysWorked)} days worked, ${num(d.current?.daysAbsent)} absent`,
  },
];

const valueText = (kpi: Kpi, d: ProdOverviewResponse) => {
  const v = prodValue(d.current, kpi.key);
  if (kpi.kind === "count") return num(v);
  if (kpi.kind === "days") return num(v, 1);
  if (kpi.kind === "pct") return pct(v);
  return inrCompact(v);
};

function Kpis({ data, loading }: { data: ProdOverviewResponse | undefined; loading: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-2.5 @lg:gap-3 @3xl:grid-cols-4" data-testid="md-prod-kpis">
      {KPIS.map((kpi) => (
        <StatCard
          key={kpi.key}
          testId={`md-prod-kpi-${kpi.key}`}
          label={kpi.label}
          icon={kpi.icon}
          tone={kpi.tone}
          loading={loading}
          value={data?.current ? valueText(kpi, data) : "—"}
          sub={data?.current ? kpi.sub(data) : undefined}
          delta={deltaOf(prodChange(data, kpi.key), kpi.kind === "pct" ? "count" : kpi.kind, kpi.goodWhen)}
          spark={data?.trend.map((t) => prodValue(t, kpi.key))}
          provenance={GLOSSARY}
          provenanceIds={kpi.ids}
        />
      ))}
    </div>
  );
}

function CompareCard({ data }: { data: ProdOverviewResponse }) {
  const cur = data.current!;
  const prev = data.previous;
  const lines: {
    id: string;
    label: string;
    c: number | null;
    p: number | null;
    kind: "money" | "count" | "days";
    good?: "down";
  }[] = [
    { id: "employees", label: "Workers paid", c: cur.employees, p: prev?.employees ?? null, kind: "count" },
    { id: "shifts", label: "Shifts", c: cur.shifts, p: prev?.shifts ?? null, kind: "days" },
    { id: "grossPay", label: "Gross pay", c: cur.grossPay, p: prev?.grossPay ?? null, kind: "money" },
    { id: "bonus", label: "Excess - detection", c: cur.bonus, p: prev?.bonus ?? null, kind: "money" },
    {
      id: "deductions",
      label: "Deductions",
      c: cur.deductions.total,
      p: prev?.deductions.total ?? null,
      kind: "money",
    },
    { id: "netPaid", label: "Net paid", c: cur.netPaid, p: prev?.netPaid ?? null, kind: "money" },
    { id: "companyCost", label: "Company cost", c: cur.companyCost, p: prev?.companyCost ?? null, kind: "money" },
    {
      id: "daysAbsent",
      label: "Days absent",
      c: cur.daysAbsent,
      p: prev?.daysAbsent ?? null,
      kind: "days",
      good: "down",
    },
  ];
  return (
    <SectionCard
      testId="md-prod-compare"
      title={prev ? `Against ${prev.label}` : "Against the period before"}
      subtitle="What moved since the cycle's period before"
      actions={<Explain ids={["prod-gross", "prod-net", "prod-cost"]} />}
      className="h-full"
    >
      {!prev ? (
        <p className="md-panel-sand px-3 py-6 text-center text-[13px] text-md-ink-soft">
          There is no earlier {data.cycleLabel} period to compare with.
        </p>
      ) : (
        <ul className="divide-y divide-md-line" data-testid="md-prod-compare-lines">
          {lines.map((l) => {
            const delta = deltaOf(changeBetween(l.c, l.p), l.kind, l.good ?? "neutral");
            const show = (v: number | null) =>
              l.kind === "count" ? num(v) : l.kind === "days" ? num(v, 1) : inrCompact(v);
            return (
              <li
                key={l.id}
                className="grid grid-cols-[minmax(0,1fr)_auto_auto_4.75rem] items-center gap-x-2.5 py-1.5"
                data-testid={`md-prod-compare-${l.id}`}
              >
                <span className="min-w-0 truncate text-[12.5px] font-semibold text-md-ink-soft">{l.label}</span>
                <span className="text-right text-[13px] font-bold tabular-nums text-md-ink">{show(l.c)}</span>
                <span className="text-right text-[11px] font-medium tabular-nums text-md-ink-soft">
                  was {show(l.p)}
                </span>
                <span className="text-right">
                  {delta ? (
                    <span
                      className={cn(
                        "md-chip md-money-delta",
                        delta.tone === "good" && "md-chip-success",
                        delta.tone === "bad" && "md-chip-danger",
                      )}
                    >
                      {arrowText(delta)}
                    </span>
                  ) : (
                    <span className="text-[11px] text-md-ink-soft">—</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}

function DeductionsCard({ data }: { data: ProdOverviewResponse }) {
  const lines = deductionLines(data.current!);
  return (
    <SectionCard
      testId="md-prod-deductions"
      title="Deductions this period"
      subtitle={`${inr(data.current!.deductions.total)} taken off ${num(data.current!.employees)} workers`}
      actions={<Explain ids={["deductions"]} />}
      className="h-full"
    >
      {lines.length === 0 ? (
        <p className="md-panel-sand px-3 py-6 text-center text-[13px] text-md-ink-soft">Nothing was deducted.</p>
      ) : (
        <ul className="space-y-2.5" data-testid="md-prod-deduction-lines">
          {lines.map((l) => (
            <li key={l.key} data-testid={`md-prod-deduction-${l.key}`}>
              <div className="flex items-baseline justify-between gap-2 text-[12.5px]">
                <span className="font-semibold text-md-ink-soft">{l.label}</span>
                <span className="font-bold tabular-nums text-md-ink">
                  {inr(l.amount)} <span className="text-[11px] font-medium text-md-ink-soft">{pct(l.share)}</span>
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-md-ink/10">
                <div
                  className="h-full rounded-full bg-md-wine"
                  style={{ width: `${Math.max(2, Math.min(100, l.share))}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

type PeriodSortKey = "period" | "employees" | "shifts" | "grossPay" | "deductions" | "netPaid" | "companyCost";

function PeriodTable({ data, onSelect }: { data: ProdOverviewResponse; onSelect: (key: string) => void }) {
  const [sort, setSort] = useState<{ key: PeriodSortKey; dir: SortDir }>({ key: "period", dir: "desc" });
  const value = (r: ProdPeriodRow, key: PeriodSortKey) =>
    key === "period" ? r.start : key === "deductions" ? r.deductions.total : r[key];
  const rows = sortRows(data.trend, (r) => value(r, sort.key), sort.dir);
  const money = (key: Exclude<PeriodSortKey, "period" | "employees" | "shifts">, header: string) =>
    ({
      key,
      header,
      sortKey: key,
      align: "right",
      cell: (r: ProdPeriodRow) => inr(value(r, key) as number),
    }) satisfies Col<ProdPeriodRow>;
  const columns: Col<ProdPeriodRow>[] = [
    {
      key: "period",
      header: "Period",
      sortKey: "period",
      cell: (r) => (
        <span className="flex flex-col items-start gap-1">
          <span className="font-bold">{r.label}</span>
          <ToneChip tone={periodTone(r.state)} className="text-[11px]">
            {r.stateLabel}
          </ToneChip>
        </span>
      ),
    },
    { key: "employees", header: "Workers", sortKey: "employees", align: "right", cell: (r) => num(r.employees) },
    { key: "shifts", header: "Shifts", sortKey: "shifts", align: "right", cell: (r) => num(r.shifts, 1) },
    money("grossPay", "Gross pay"),
    money("deductions", "Deductions"),
    money("netPaid", "Net paid"),
    money("companyCost", "Company cost"),
  ];
  return (
    <SectionCard
      testId="md-prod-period-table"
      title={`${data.cycleLabel} periods`}
      subtitle="The cycle's latest periods up to the one chosen. Click a period to open it."
      actions={<Explain ids={["prod-state"]} />}
    >
      <SortTable
        caption="Pay periods of the cycle"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.key}
        sort={sort}
        onSort={(key) =>
          setSort((s) =>
            s.key === key
              ? { key: s.key, dir: s.dir === "asc" ? "desc" : "asc" }
              : { key: key as PeriodSortKey, dir: "desc" },
          )
        }
        onRowClick={(r) => onSelect(r.key)}
        rowLabel={(r) => `Open ${r.label}`}
        highlight={(r) => r.key === data.period?.key}
        minWidth="44rem"
      />
    </SectionCard>
  );
}

export function prodYearSide(block: ProdYearBlock | null | undefined): YearSide | null {
  if (!block) return null;
  return {
    label: block.label,
    months: block.months,
    companyCost: block.companyCost,
    netPaid: block.netPaid,
    pay: block.grossPay,
    bonus: block.bonus,
    deductions: block.deductions.total,
    employees: block.employees,
  };
}

/**
 * Overview: the chosen period of the cycle (figures, where it stands, against the period before), the cycle's periods,
 * production month by month (every cycle) and the year so far. Clicking a period on the chart or in the table opens it.
 */
export default function OverviewView({
  query,
  onSelectPeriod,
  onLatest,
}: {
  query: ProdQueries["overview"];
  onSelectPeriod: (key: string) => void;
  onLatest: () => void;
}) {
  const data = query.data;
  if (failed(query)) return <CardError query={query} />;
  if (query.isPending) {
    return (
      <div className="space-y-4 @lg:space-y-5" data-testid="md-prod-overview" aria-busy="true">
        <Kpis data={undefined} loading />
        <SectionCard title="Pay periods" loading />
      </div>
    );
  }
  if (!data || data.cycles.length === 0) {
    return (
      <SectionCard title="Production payroll" testId="md-prod-empty">
        <EmptyBlock icon={Factory} title="No production payroll for this selection">
          There are no production payslips for this unit and department. The figures appear here once HR generates a pay
          period on a Production Payroll page.
        </EmptyBlock>
        {data?.notes.map((n) => (
          <NoteBanner key={n}>{n}</NoteBanner>
        ))}
      </SectionCard>
    );
  }
  if (!data.current || !data.status) {
    return (
      <SectionCard title={`No ${data.cycleLabel ?? ""} payroll here`} testId="md-prod-period-empty">
        <EmptyBlock
          icon={Factory}
          title="Nothing was paid for this period"
          action={
            <button
              type="button"
              className="md-btn md-btn-soft md-btn-sm"
              onClick={onLatest}
              data-testid="md-prod-latest"
            >
              Show the latest period
            </button>
          }
        >
          {data.notes[data.notes.length - 1] ?? "There are no payslips for this period in this selection."}
        </EmptyBlock>
      </SectionCard>
    );
  }

  const cycles = cyclesIn(data.months);
  const year = Number((data.period?.end ?? "").slice(0, 4)) || new Date().getFullYear();

  return (
    <div className="space-y-4 @lg:space-y-5" data-testid="md-prod-overview">
      <PeriodStatusCard data={data} />
      {data.notes.map((n) => (
        <NoteBanner key={n}>{n}</NoteBanner>
      ))}
      {data.previous && (
        <p className="px-1 text-[11.5px] font-medium text-md-ink-soft" data-testid="md-prod-kpi-caption">
          Arrows compare {data.period?.label} with {data.previous.label}; the small lines show the cycle's last{" "}
          {data.trend.length} periods.
        </p>
      )}
      <Kpis data={data} loading={false} />

      <div className="grid grid-cols-1 items-stretch gap-4 @lg:gap-5 @5xl:grid-cols-12">
        <div className="min-w-0 @5xl:col-span-8">
          <SectionCard
            testId="md-prod-trend"
            title={`${data.cycleLabel} pay, period by period`}
            subtitle="Net paid and deductions per period, with the company cost. Click a period to open it."
            actions={
              <>
                <AskAiButton
                  question={`Why did the ${data.cycleLabel} production pay change in ${data.period?.label}?`}
                />
                <Explain ids={["prod-net", "prod-cost"]} />
              </>
            }
          >
            <PeriodTrendChart rows={periodRows(data.trend, data.period?.key)} onSelect={onSelectPeriod} height={300} />
            <ChartLegend items={PERIOD_LEGEND} testId="md-prod-trend-legend" />
          </SectionCard>
        </div>
        <div className="min-w-0 @5xl:col-span-4">
          <CompareCard data={data} />
        </div>
      </div>

      <div className="grid grid-cols-1 items-stretch gap-4 @lg:gap-5 @5xl:grid-cols-12">
        <div className="min-w-0 @5xl:col-span-7">
          <SectionCard
            testId="md-prod-months"
            title="Production month by month"
            subtitle="Company cost of every cycle together, each period in the month it ends in"
            actions={<Explain ids={["prod-month"]} />}
          >
            {data.months.length ? (
              <>
                <MonthCycleChart rows={monthCycleRows(data.months)} cycles={cycles} />
                <ChartLegend items={monthLegend(cycles)} testId="md-prod-months-legend" />
              </>
            ) : (
              <p className="md-panel-sand px-3 py-6 text-center text-[13px] text-md-ink-soft">
                No production months yet.
              </p>
            )}
          </SectionCard>
        </div>
        <div className="min-w-0 @5xl:col-span-5">
          <DeductionsCard data={data} />
        </div>
      </div>

      {data.yearly && (
        <YearCompare
          year={year}
          current={prodYearSide(data.yearly.current)}
          previous={prodYearSide(data.yearly.previous)}
          previousFull={prodYearSide(data.yearly.previousFull)}
          change={
            data.yearly.change
              ? {
                  companyCost: data.yearly.change.companyCost,
                  netPaid: data.yearly.change.netPaid,
                  pay: data.yearly.change.grossPay,
                  bonus: data.yearly.change.bonus,
                  deductions: data.yearly.change.deductions,
                  employees: data.yearly.change.employees,
                }
              : null
          }
          months={data.yearly.months}
          payLabel="Gross pay"
          testId="md-prod-year"
        />
      )}

      <PeriodTable data={data} onSelect={onSelectPeriod} />
    </div>
  );
}
