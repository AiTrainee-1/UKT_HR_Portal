import { useState } from "react";
import {
  CalendarClock,
  CircleAlert,
  CircleCheck,
  Coins,
  Hourglass,
  IndianRupee,
  Info,
  Landmark,
  Receipt,
  ScissorsLineDashed,
  TreePalm,
  UserX,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import SectionCard from "@/components/md/kit/SectionCard";
import StatCard, { type StatTone } from "@/components/md/kit/StatCard";
import { EmptyBlock, NoteBanner } from "@/components/md/kit/states";
import { inr, inrCompact, num } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import { CL_LEGEND, ClChart, DEDUCTION_LEGEND, DeductionTypesChart, SalaryTrendChart, TREND_LEGEND } from "./charts";
import { GLOSSARY } from "./glossary";
import {
  arrowText,
  changeBetween,
  clRows,
  compareLines,
  daysText,
  deductionRows,
  deltaOf,
  flowRows,
  kpiChange,
  kpiValue,
  otherDeductions,
  sortRows,
  statusTone,
  sumFigures,
  type KpiKey,
  type SortDir,
  type StatusTone,
} from "./logic";
import { CardError, ChartLegend, Explain, Figure, ToneChip, failed } from "./parts";
import type { DashQueries } from "./queries";
import SortTable, { type Col } from "./SortTable";
import type { PayFigures, PayMonthRow, PayMonthlyResponse } from "./types";

const STATUS_ICON: Record<StatusTone, LucideIcon> = {
  success: CircleCheck,
  warning: Hourglass,
  danger: CircleAlert,
  info: Info,
  neutral: CalendarClock,
};

/** Which month the figures describe and where its payroll stands (generated, payment pending, paid), right under the
 *  filters, so no number is read without it. */
export function MonthStatus({ row }: { row: PayMonthRow }) {
  const tone = statusTone(row.status.state);
  const Icon = STATUS_ICON[tone];
  return (
    <div
      className={cn("md-card md-money-status", `md-money-t-${tone}`)}
      data-testid="md-pay-status"
      data-state={row.status.state}
    >
      <span className="md-money-tile md-money-tile-solid">
        <Icon size={20} aria-hidden />
      </span>
      <div className="min-w-0 flex-[1_1_15rem]">
        <p className="flex flex-wrap items-center gap-2 text-[17px] font-black leading-tight tracking-tight text-md-ink">
          <span data-testid="md-pay-status-month">{row.label}</span>
          <ToneChip tone={tone}>{row.status.label}</ToneChip>
        </p>
        <p className="mt-1 text-[13px] leading-snug text-md-ink-soft" data-testid="md-pay-status-detail">
          {row.status.detail ?? `${num(row.employees)} employees were paid for this month.`}
        </p>
      </div>
      <dl className="flex gap-5 text-[13px] sm:border-l sm:border-md-line sm:pl-5">
        <div>
          <dt className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-md-ink-soft">Employees</dt>
          <dd className="mt-0.5 font-bold tabular-nums text-md-ink">{num(row.employees)}</dd>
        </div>
        <div>
          <dt className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-md-ink-soft">Net paid</dt>
          <dd className="mt-0.5 font-bold tabular-nums text-md-ink">{inrCompact(row.netPaid)}</dd>
        </div>
      </dl>
      <Explain ids={["month-rule"]} />
    </div>
  );
}

type Kpi = {
  key: KpiKey;
  label: string;
  icon: LucideIcon;
  tone: StatTone;
  kind: "money" | "count" | "days";
  goodWhen: "up" | "down" | "neutral";
  ids: string[];
  sub: (f: PayFigures) => string;
};

const KPIS: Kpi[] = [
  {
    key: "companyCost",
    label: "Company cost",
    icon: Landmark,
    tone: "blue",
    kind: "money",
    goodWhen: "down",
    ids: ["company-cost"],
    sub: (f) => `incl. ${inrCompact(f.employerPfEsi)} PF / ESI`,
  },
  {
    key: "actualSalary",
    label: "Actual salary",
    icon: IndianRupee,
    tone: "indigo",
    kind: "money",
    goodWhen: "neutral",
    ids: ["actual-salary"],
    // staff only, in every scope: production is paid per shift and has no fixed salary (so with production in the
    // scope it is not comparable with earned salary, which covers both)
    sub: (f) => (f.actualSalary == null ? "production is paid per shift" : "staff, if every day were paid"),
  },
  {
    key: "earnedSalary",
    label: "Earned salary",
    icon: Coins,
    tone: "teal",
    kind: "money",
    goodWhen: "neutral",
    ids: ["earned-salary"],
    sub: () => "for the days and shifts paid",
  },
  {
    key: "attendanceDeduction",
    label: "Attendance deductions",
    icon: UserX,
    tone: "amber",
    kind: "money",
    goodWhen: "down",
    ids: ["attendance-deductions", "loss-of-pay"],
    sub: (f) => `${inrCompact(f.lossOfPay ?? 0)} LOP · ${inrCompact(f.lateDeduction)} late`,
  },
  {
    key: "otherDeductions",
    label: "Other deductions",
    icon: Receipt,
    tone: "slate",
    kind: "money",
    goodWhen: "neutral",
    ids: ["other-deductions"],
    sub: (f) => `PF ${inrCompact(f.deductions.pf)} · ESI ${inrCompact(f.deductions.esi)}`,
  },
  {
    key: "netPaid",
    label: "Net paid",
    icon: Wallet,
    tone: "green",
    kind: "money",
    goodWhen: "neutral",
    ids: ["net-paid"],
    sub: (f) => `after ${inrCompact(f.deductions.total)} deductions`,
  },
  {
    key: "clDays",
    label: "CL days",
    icon: TreePalm,
    tone: "purple",
    kind: "days",
    goodWhen: "neutral",
    ids: ["cl"],
    sub: () => "approved, on paid days",
  },
  {
    key: "clAmount",
    label: "CL amount",
    icon: ScissorsLineDashed,
    tone: "purple",
    kind: "money",
    goodWhen: "neutral",
    ids: ["cl"],
    sub: (f) => (f.clDays > 0 ? `${inr(f.clAmount / f.clDays)} per CL day` : "no casual leave paid"),
  },
  {
    key: "employees",
    label: "Employees paid",
    icon: Users,
    tone: "slate",
    kind: "count",
    goodWhen: "neutral",
    ids: ["employees"],
    sub: () => "with a salary slip",
  },
];

const valueText = (kpi: Kpi, f: PayFigures) => {
  const v = kpiValue(f, kpi.key);
  if (kpi.kind === "count") return num(v);
  if (kpi.kind === "days") return daysText(v);
  return inrCompact(v);
};

/** The month's headline figures, each against the month before and with its line over the months shown. Two across on a
 *  phone (the odd last one spans both), three across from a tablet. */
export function MonthlyKpis({ data, loading }: { data: PayMonthlyResponse | undefined; loading: boolean }) {
  const current = data?.current ?? null;
  return (
    <div
      className="grid grid-cols-2 gap-2.5 @lg:gap-3 @3xl:grid-cols-3 @max-3xl:[&>*:last-child:nth-child(odd)]:col-span-2"
      data-testid="md-pay-kpis"
    >
      {KPIS.map((kpi) => (
        <StatCard
          key={kpi.key}
          testId={`md-pay-kpi-${kpi.key}`}
          label={kpi.label}
          icon={kpi.icon}
          tone={kpi.tone}
          loading={loading}
          value={current ? valueText(kpi, current) : "—"}
          sub={current ? kpi.sub(current) : undefined}
          delta={deltaOf(kpiChange(data, kpi.key), kpi.kind, kpi.goodWhen)}
          spark={data?.months.map((m) => kpiValue(m, kpi.key))}
          provenance={GLOSSARY}
          provenanceIds={kpi.ids}
        />
      ))}
    </div>
  );
}

function CompareCard({ data }: { data: PayMonthlyResponse }) {
  const current = data.current;
  const previous = data.previous;
  const lines = compareLines(current, previous);
  return (
    <SectionCard
      testId="md-pay-compare"
      title={previous ? `${current?.label} against ${previous.label}` : "Against the month before"}
      subtitle="What moved since the month before"
      actions={<Explain ids={["earned-salary", "attendance-deductions", "other-deductions", "company-cost"]} />}
      className="h-full"
    >
      {!previous ? (
        <p className="md-panel-sand px-3 py-6 text-center text-[13px] text-md-ink-soft">
          There is no month before {current?.label} to compare with.
        </p>
      ) : (
        <ul className="divide-y divide-md-line" data-testid="md-pay-compare-lines">
          {lines.map((l) => {
            // less lost to attendance is good news; the rest is neither by itself
            const attendance = l.id === "lossOfPay" || l.id === "lateDeduction";
            const delta = deltaOf(l.change, l.kind, attendance ? "down" : "neutral");
            const show = (v: number | null) =>
              l.kind === "count" ? num(v) : l.kind === "days" ? daysText(v) : inrCompact(v);
            return (
              <li
                key={l.id}
                className="grid grid-cols-[minmax(0,1fr)_auto_auto_4.75rem] items-center gap-x-2.5 py-1.5"
                data-testid={`md-pay-compare-${l.id}`}
              >
                <span className="min-w-0 truncate text-[12.5px] font-semibold text-md-ink-soft">{l.label}</span>
                <span className="text-right text-[13px] font-bold tabular-nums text-md-ink">{show(l.current)}</span>
                <span className="text-right text-[11px] font-medium tabular-nums text-md-ink-soft">
                  was {show(l.previous)}
                </span>
                <span className="text-right">
                  {delta ? (
                    <span
                      className={cn(
                        "md-chip md-money-delta",
                        delta.tone === "good" && "md-chip-success",
                        delta.tone === "bad" && "md-chip-danger",
                      )}
                      data-tone={delta.tone}
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

type MonthSortKey =
  | "month"
  | "employees"
  | "actualSalary"
  | "earnedSalary"
  | "attendanceDeduction"
  | "otherDeductions"
  | "netPaid"
  | "companyCost"
  | "clDays"
  | "clAmount";

const monthSortValue = (row: PayMonthRow, key: MonthSortKey): string | number | null =>
  key === "month" ? row.month : key === "otherDeductions" ? otherDeductions(row) : row[key];

function MonthTable({ data, onSelect }: { data: PayMonthlyResponse; onSelect: (month: string) => void }) {
  const [sort, setSort] = useState<{ key: MonthSortKey; dir: SortDir }>({ key: "month", dir: "desc" });
  const months = data.months;
  const before = new Map(months.map((m, i) => [m.month, months[i - 1] ?? null]));
  const rows = sortRows(months, (r) => monthSortValue(r, sort.key), sort.dir);
  const total = sumFigures(months);
  const money = (key: Exclude<MonthSortKey, "month" | "employees" | "clDays">, label: string, title?: string) =>
    ({
      key,
      header: label,
      sortKey: key,
      align: "right",
      title,
      cell: (r: PayMonthRow) => inr(monthSortValue(r, key) as number | null),
      total: inr(key === "otherDeductions" ? otherDeductions(total) : total[key]),
    }) satisfies Col<PayMonthRow>;
  const columns: Col<PayMonthRow>[] = [
    {
      key: "month",
      header: "Month",
      sortKey: "month",
      cell: (r) => (
        <span className="flex flex-col items-start gap-1">
          <span className="font-bold">{r.label}</span>
          <ToneChip tone={statusTone(r.status.state)} className="text-[11px]">
            {r.status.label}
          </ToneChip>
        </span>
      ),
      total: <span className="font-extrabold">{months.length} months</span>,
    },
    {
      key: "employees",
      header: "Employees",
      sortKey: "employees",
      align: "right",
      cell: (r) => num(r.employees),
      total: "",
    },
    money("actualSalary", "Actual", "Full monthly salary of the staff"),
    money("earnedSalary", "Earned", "What the days paid earned"),
    money("attendanceDeduction", "Attendance ded.", "Loss of pay + late / early-out / permission penalties"),
    money("otherDeductions", "Other ded.", "PF, ESI, TDS, advance and other lines"),
    money("netPaid", "Net paid"),
    money("companyCost", "Company cost"),
    {
      key: "clDays",
      header: "CL days",
      sortKey: "clDays",
      align: "right",
      cell: (r) => daysText(r.clDays),
      total: daysText(total.clDays),
    },
    money("clAmount", "CL amount"),
    {
      key: "change",
      header: "Cost change",
      align: "right",
      title: "Company cost against the month before",
      cell: (r) => {
        const prev = before.get(r.month);
        if (!prev) return <span className="text-md-ink-soft">—</span>;
        const d = deltaOf(changeBetween(r.companyCost, prev.companyCost), "money", "neutral");
        return <span className="font-semibold tabular-nums">{arrowText(d)}</span>;
      },
    },
  ];
  return (
    <SectionCard
      testId="md-pay-month-table"
      title="Month by month"
      subtitle="Every figure for each month shown. Click a month to open it."
      actions={<Explain ids={["actual-salary", "earned-salary", "attendance-deductions", "other-deductions", "cl"]} />}
    >
      <SortTable
        caption="Payroll month by month"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.month}
        sort={sort}
        onSort={(key) =>
          setSort((s) =>
            s.key === key
              ? { key: s.key, dir: s.dir === "asc" ? "desc" : "asc" }
              : { key: key as MonthSortKey, dir: "desc" },
          )
        }
        onRowClick={(r) => onSelect(r.month)}
        rowLabel={(r) => `Open ${r.label}`}
        highlight={(r) => r.month === data.month}
        totals
        minWidth="50rem"
      />
    </SectionCard>
  );
}

/**
 * Monthly: what the company spent on salaries in the month, what was deducted and what the employees received, against
 * the month before and over the months before it. Clicking a month on a chart or in the table opens it.
 */
export default function MonthlyView({
  query,
  onSelectMonth,
  onLatest,
}: {
  query: DashQueries["monthly"];
  onSelectMonth: (month: string) => void;
  onLatest: () => void;
}) {
  // loss of pay is usually far bigger than every other deduction together: it starts hidden so the rest can be read
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(["lossOfPay"]));
  const data = query.data;

  if (failed(query)) return <CardError query={query} />;

  if (query.isPending) {
    return (
      <div className="space-y-4 @lg:space-y-5" data-testid="md-pay-monthly" aria-busy="true">
        <MonthlyKpis data={undefined} loading />
        <SectionCard title="Salary bill, month by month" loading />
      </div>
    );
  }

  if (!data || data.months.length === 0) {
    return (
      <SectionCard title="Payroll" testId="md-pay-monthly-empty">
        <EmptyBlock icon={Wallet} title="No payroll for this selection">
          There are no salary slips for this unit, department and type. The figures appear here once HR generates a
          month's payroll.
        </EmptyBlock>
      </SectionCard>
    );
  }

  if (!data.current) {
    return (
      <SectionCard title={`No payroll for ${data.label ?? "this month"}`} testId="md-pay-month-empty">
        <EmptyBlock
          icon={Wallet}
          title={`Nothing was paid for ${data.label ?? "this month"}`}
          action={
            <button
              type="button"
              className="md-btn md-btn-soft md-btn-sm"
              onClick={onLatest}
              data-testid="md-pay-latest"
            >
              Show the latest month
            </button>
          }
        >
          No salary slips exist for this month in this selection.
        </EmptyBlock>
      </SectionCard>
    );
  }

  const selected = data.month;
  const toggle = (key: string) =>
    setHidden((h) => {
      const next = new Set(h);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const clTotal = data.months.reduce((a, m) => ({ days: a.days + m.clDays, amount: a.amount + m.clAmount }), {
    days: 0,
    amount: 0,
  });

  return (
    <div className="space-y-4 @lg:space-y-5" data-testid="md-pay-monthly">
      <MonthStatus row={data.current} />
      {data.notes.map((n) => (
        <NoteBanner key={n}>{n}</NoteBanner>
      ))}
      {data.previous && (
        <p className="px-1 text-[11.5px] font-medium text-md-ink-soft" data-testid="md-pay-kpi-caption">
          Arrows compare {data.label} with {data.previous.label}; the small lines show the {data.months.length} months
          up to it.
        </p>
      )}
      <MonthlyKpis data={data} loading={false} />

      <div className="grid grid-cols-1 items-stretch gap-4 @lg:gap-5 @5xl:grid-cols-12">
        <div className="min-w-0 @5xl:col-span-8">
          <SectionCard
            testId="md-pay-trend"
            title="Salary bill, month by month"
            subtitle="What was paid, deducted and lost to attendance, with the company cost. Click a month to open it."
            className="flex h-full flex-col"
            bodyClassName="flex flex-1 flex-col"
            actions={
              <>
                <AskAiButton question={`Why did the company's salary cost change in ${data.label}?`} />
                <Explain
                  ids={["net-paid", "other-deductions", "attendance-deductions", "earned-salary", "company-cost"]}
                />
              </>
            }
          >
            <SalaryTrendChart rows={flowRows(data.months, selected)} onSelect={onSelectMonth} height={320} grow />
            <ChartLegend items={TREND_LEGEND} testId="md-pay-trend-legend" />
          </SectionCard>
        </div>
        <div className="min-w-0 @5xl:col-span-4">
          <CompareCard data={data} />
        </div>
      </div>

      <div className="grid grid-cols-1 items-start gap-4 @lg:gap-5 @5xl:grid-cols-12">
        <div className="min-w-0 @5xl:col-span-7">
          <SectionCard
            testId="md-pay-deductions"
            title="Deductions by type"
            subtitle="Attendance first (loss of pay, late / early-out), then the slip's own lines. Loss of pay starts hidden as it dwarfs the rest: tap a type to show or hide it."
            actions={<Explain ids={["attendance-deductions", "loss-of-pay", "other-deductions"]} />}
          >
            <DeductionTypesChart rows={deductionRows(data.months, selected)} hidden={hidden} onSelect={onSelectMonth} />
            <ChartLegend items={DEDUCTION_LEGEND} hidden={hidden} onToggle={toggle} testId="md-pay-deductions-legend" />
          </SectionCard>
        </div>
        <div className="min-w-0 @5xl:col-span-5">
          <SectionCard
            testId="md-pay-cl"
            title="Casual leave paid"
            subtitle="The salary paid for approved casual leave (bars) and the days (line)"
            actions={<Explain ids={["cl"]} />}
          >
            <div className="mb-3 grid grid-cols-2 gap-2.5">
              <Figure
                label={`CL in ${data.label}`}
                value={inrCompact(data.current.clAmount)}
                sub={`${daysText(data.current.clDays)} days`}
                emphasis
                testId="md-pay-cl-month"
              />
              <Figure
                label={`${data.months.length} months`}
                value={inrCompact(clTotal.amount)}
                sub={`${daysText(Math.round(clTotal.days * 2) / 2)} days`}
                testId="md-pay-cl-total"
              />
            </div>
            <ClChart rows={clRows(data.months, selected)} onSelect={onSelectMonth} height={220} />
            <ChartLegend items={CL_LEGEND} testId="md-pay-cl-legend" />
          </SectionCard>
        </div>
      </div>

      <MonthTable data={data} onSelect={onSelectMonth} />
    </div>
  );
}
