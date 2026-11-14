import { useEffect, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronRight, Coins, Landmark, Receipt, TreePalm, UserX, Wallet } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import SectionCard from "@/components/md/kit/SectionCard";
import StatCard from "@/components/md/kit/StatCard";
import { EmptyBlock, NoteBanner, SkeletonBlock } from "@/components/md/kit/states";
import { dayLong, dayShort, inr, inrCompact, num } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import { PERSON_LEGEND, PersonChart } from "./charts";
import { GLOSSARY } from "./glossary";
import {
  daysText,
  employeeStatusTone,
  paymentChip,
  personChartRows,
  saysAlready,
  signedRupees,
  statusTone,
  typeLabel,
  words,
} from "./logic";
import { CardError, ChartLegend, Explain, ToneChip, failed } from "./parts";
import type { DashQueries } from "./queries";
import SortTable, { type Col } from "./SortTable";
import type { PayPersonMonth, PayPersonResponse } from "./types";

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

function Header({ data }: { data: PayPersonResponse }) {
  const e = data.employee;
  const latest = data.months[0];
  const rate = latest?.periods.find((p) => p.ratePerShift != null)?.ratePerShift ?? null;
  const range =
    data.months.length > 0
      ? `${data.months.length} ${data.months.length === 1 ? "month" : "months"}: ${data.months[data.months.length - 1].label} to ${data.months[0].label}`
      : "No salary slips yet";
  return (
    <div
      className="md-card flex flex-wrap items-center gap-x-5 gap-y-3 p-3.5 sm:p-5"
      data-testid="md-pay-profile-header"
    >
      <span className="md-money-tile md-money-tile-lg md-money-tile-solid md-money-t-wine shrink-0 text-base font-black">
        {initials(e.name)}
      </span>
      <div className="min-w-0 flex-[1_1_14rem]">
        <h3 className="text-lg font-black leading-tight tracking-tight text-md-ink" data-testid="md-pay-profile-name">
          {e.name}
        </h3>
        <p className="mt-0.5 text-[12.5px] font-medium text-md-ink-soft">
          {e.code}
          {e.designation ? ` · ${e.designation}` : ""}
          {e.joinDate ? ` · joined ${dayLong(e.joinDate)}` : ""}
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5" data-testid="md-pay-profile-chips">
          <span className="md-chip">{e.department ?? "No department"}</span>
          {e.unit && <span className="md-chip">{e.unit}</span>}
          <span className="md-chip md-chip-wine">{typeLabel(e.type)}</span>
          <ToneChip tone={employeeStatusTone(e.status)}>{words(e.status)}</ToneChip>
        </div>
      </div>
      <dl className="flex flex-wrap gap-x-6 gap-y-2 sm:border-l sm:border-md-line sm:pl-5">
        <div>
          <dt className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-md-ink-soft">
            {e.type === "staff" ? "Monthly salary today" : "Pay"}
          </dt>
          <dd className="mt-0.5 text-xl font-black tabular-nums text-md-ink" data-testid="md-pay-profile-salary">
            {e.type === "staff" ? inr(e.monthlySalary) : rate != null ? `${inr(rate)} a shift` : "Per shift"}
          </dd>
        </div>
        <div>
          <dt className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-md-ink-soft">History</dt>
          <dd className="mt-1 text-[12.5px] font-semibold text-md-ink">{range}</dd>
        </div>
      </dl>
    </div>
  );
}

function Kpis({ data }: { data: PayPersonResponse }) {
  const t = data.totals;
  const n = Math.max(1, data.months.length);
  return (
    <div
      className="grid grid-cols-2 gap-2.5 @lg:gap-3 @3xl:grid-cols-3 @6xl:grid-cols-6"
      data-testid="md-pay-profile-kpis"
    >
      <StatCard
        testId="md-pay-profile-earned"
        label="Total earned"
        icon={Coins}
        tone="teal"
        value={inrCompact(t.earnedSalary)}
        sub={t.actualSalary != null ? `of ${inrCompact(t.actualSalary)} actual salary` : "shifts x rate"}
        provenance={GLOSSARY}
        provenanceIds={["earned-salary", "actual-salary"]}
      />
      <StatCard
        testId="md-pay-profile-deductions"
        label="Total deductions"
        icon={Receipt}
        tone="slate"
        value={inrCompact(t.deductions.total)}
        sub={`PF ${inrCompact(t.deductions.pf)} · ESI ${inrCompact(t.deductions.esi)}`}
        provenance={GLOSSARY}
        provenanceIds={["deductions"]}
      />
      <StatCard
        testId="md-pay-profile-net"
        label="Total net paid"
        icon={Wallet}
        tone="green"
        value={inrCompact(t.netPaid)}
        sub={`about ${inrCompact(t.netPaid / n)} a month`}
        provenance={GLOSSARY}
        provenanceIds={["net-paid"]}
      />
      <StatCard
        testId="md-pay-profile-attendance"
        label="Attendance deductions"
        icon={UserX}
        tone="amber"
        value={inrCompact(t.attendanceDeduction)}
        sub={`${daysText(t.lopDays)} LOP days · ${inrCompact(t.lateDeduction)} late`}
        provenance={GLOSSARY}
        provenanceIds={["attendance-deductions", "loss-of-pay"]}
      />
      <StatCard
        testId="md-pay-profile-cl"
        label="Casual leave"
        icon={TreePalm}
        tone="purple"
        value={`${daysText(t.clDays)} days`}
        sub={`${inrCompact(t.clAmount)} paid for them`}
        provenance={GLOSSARY}
        provenanceIds={["cl"]}
      />
      <StatCard
        testId="md-pay-profile-cost"
        label="Company cost"
        icon={Landmark}
        tone="blue"
        value={inrCompact(t.companyCost)}
        sub={`incl. ${inrCompact(t.employerPfEsi)} employer PF / ESI`}
        provenance={GLOSSARY}
        provenanceIds={["company-cost"]}
      />
    </div>
  );
}

/** What a month's row opens: the attendance behind it, the payment, an HR adjustment, and a production month's periods. */
function MonthDetail({ m }: { m: PayPersonMonth }) {
  const facts = [
    m.dailyRate != null ? `Daily rate ${inr(m.dailyRate, 2)}` : null,
    `Present ${daysText(m.presentDays)} days`,
    m.holidayDays ? `Holidays ${daysText(m.holidayDays)}` : null,
    m.lateDays ? `Late on ${num(m.lateDays)} ${m.lateDays === 1 ? "day" : "days"}` : null,
    m.paymentPaidAt ? `Paid ${dayLong(m.paymentPaidAt)}` : null,
    m.adjustment != null ? `Adjusted by HR ${signedRupees(m.adjustment)}` : null,
  ].filter(Boolean);
  return (
    // pinned to the left of the scrolling table, as wide as the page, so it reads without scrolling sideways
    <div className="sticky left-2 max-w-[calc(100cqw-3rem)] space-y-2 whitespace-normal text-[12px] text-md-ink">
      <p className="text-md-ink-soft">{facts.join(" · ")}</p>
      {m.periods.length > 0 && (
        <ul className="grid grid-cols-1 gap-1.5 @2xl:grid-cols-2" data-testid={`md-pay-periods-${m.month}`}>
          {m.periods.map((p) => (
            <li
              key={`${p.start}-${p.end}`}
              className="md-panel flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5"
            >
              <span className="font-semibold">
                {dayShort(p.start)} – {dayShort(p.end)}
                {p.cycle ? <span className="font-medium text-md-ink-soft"> · {words(p.cycle)}</span> : null}
              </span>
              <span className="tabular-nums text-md-ink-soft">
                {num(p.shifts)} shifts{p.ratePerShift != null ? ` × ${inr(p.ratePerShift)}` : ""} ·{" "}
                <b className="text-md-ink">{inr(p.netPaid)}</b>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The month's status, and its payment when that adds something ("Paid" under "Paid" would only repeat it). */
function MonthChips({ m }: { m: PayPersonMonth }) {
  const chip = paymentChip(m.paymentStatus, m.onHold);
  const pay = chip && !saysAlready(m.status.label, chip.text) ? chip : null;
  return (
    <>
      <ToneChip tone={statusTone(m.status.state)} className="text-[11px]">
        {m.status.label}
      </ToneChip>
      {pay && (
        <ToneChip tone={pay.tone} className="text-[11px]">
          {pay.text}
        </ToneChip>
      )}
    </>
  );
}

/** One figure in a phone card. */
const Fact = ({ label, value }: { label: string; value: string }) => (
  <span className="min-w-0">
    <span className="block truncate text-md-ink-soft">{label}</span>
    <span className="block font-bold tabular-nums text-md-ink">{value}</span>
  </span>
);

/**
 * The history on a phone: a card per month with what matters at a glance (net paid, earned, deductions, days paid,
 * attendance deductions, CL); a tap opens every figure of the month, its attendance and its pay periods.
 */
function HistoryCards({
  data,
  open,
  onToggle,
  highlight,
}: {
  data: PayPersonResponse;
  open: Set<string>;
  onToggle: (month: string) => void;
  highlight: string;
}) {
  const staff = data.months.some((m) => m.actualSalary != null);
  return (
    <ul className="grid grid-cols-1 gap-2.5 @xl:grid-cols-2" data-testid="md-pay-history-cards">
      {data.months.map((m) => {
        const isOpen = open.has(m.month);
        const all: [string, string][] = [
          ["Working days", daysText(m.workingDays)],
          ["Paid days", daysText(m.paidDays)],
          ["LOP days", daysText(m.lopDays)],
          ...(staff
            ? ([
                ["Actual salary", inr(m.actualSalary)],
                ["Loss of pay", inr(m.lossOfPay)],
              ] as [string, string][])
            : []),
          ["Earned salary", inr(m.earnedSalary)],
          ["Late deduction", inr(m.lateDeduction)],
          ["Overtime", inr(m.overtime)],
          ["Bonus", inr(m.bonus)],
          ["PF", inr(m.deductions.pf)],
          ["ESI", inr(m.deductions.esi)],
          ["TDS", inr(m.deductions.tds)],
          ["Advance", inr(m.deductions.advance)],
          ["Other", inr(m.deductions.other)],
          ["Adjustment by HR", m.adjustment == null ? "—" : signedRupees(m.adjustment)],
          ["CL", `${daysText(m.clDays)} days · ${inr(m.clAmount)}`],
          ["Net paid", inr(m.netPaid)],
        ];
        return (
          <li
            key={m.month}
            className={cn("md-panel p-3", m.month === highlight && "md-panel-wine")}
            data-testid={`md-pay-history-card-${m.month}`}
          >
            <button
              type="button"
              onClick={() => onToggle(m.month)}
              aria-expanded={isOpen}
              className="flex w-full flex-col gap-2.5 text-left"
            >
              <span className="flex w-full items-start justify-between gap-3">
                <span className="min-w-0">
                  <span className="flex items-center gap-1 text-[14px] font-extrabold text-md-ink">
                    {isOpen ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
                    {m.label}
                  </span>
                  <span className="mt-1 flex flex-wrap gap-1">
                    <MonthChips m={m} />
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-[15px] font-black tabular-nums text-md-ink">{inr(m.netPaid)}</span>
                  <span className="block text-[11px] font-medium text-md-ink-soft">net paid</span>
                </span>
              </span>
              <span className="grid w-full grid-cols-3 gap-x-2 gap-y-2 text-[11px]">
                <Fact label="Earned" value={inrCompact(m.earnedSalary)} />
                <Fact label="Deductions" value={inrCompact(m.deductions.total)} />
                <Fact label="Days paid" value={`${daysText(m.paidDays)} / ${daysText(m.workingDays)}`} />
                <Fact label="Attendance" value={inrCompact(m.attendanceDeduction)} />
                <Fact label="CL" value={m.clDays > 0 ? `${daysText(m.clDays)} d · ${inrCompact(m.clAmount)}` : "—"} />
                {m.periods.length > 0 ? (
                  <Fact label="Pay periods" value={num(m.periods.length)} />
                ) : (
                  <Fact label="Actual" value={inrCompact(m.actualSalary)} />
                )}
              </span>
            </button>
            {isOpen && (
              <div className="mt-3 space-y-3 border-t border-md-line pt-3">
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[12px]">
                  {all.map(([label, value]) => (
                    <div key={label} className="flex items-baseline justify-between gap-2">
                      <dt className="text-md-ink-soft">{label}</dt>
                      <dd className="font-semibold tabular-nums text-md-ink">{value}</dd>
                    </div>
                  ))}
                </dl>
                <MonthDetail m={m} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function History({
  data,
  open,
  onToggle,
  highlight,
}: {
  data: PayPersonResponse;
  open: Set<string>;
  onToggle: (month: string) => void;
  highlight: string;
}) {
  const t = data.totals;
  const money = (
    key: string,
    header: string,
    get: (m: PayPersonMonth) => number | null,
    total: number | null,
    title?: string,
  ) =>
    ({
      key,
      header,
      align: "right",
      title,
      cell: (m: PayPersonMonth) => inr(get(m)),
      total: inr(total),
    }) satisfies Col<PayPersonMonth>;
  const days = (key: string, header: string, get: (m: PayPersonMonth) => number, total: number) =>
    ({
      key,
      header,
      align: "right",
      cell: (m: PayPersonMonth) => daysText(get(m)),
      total: daysText(total),
    }) satisfies Col<PayPersonMonth>;
  const adjustments = data.months.filter((m) => m.adjustment != null);
  const columns: Col<PayPersonMonth>[] = [
    {
      key: "month",
      header: "Month",
      cell: (m) => {
        const isOpen = open.has(m.month);
        const Icon = isOpen ? ChevronDown : ChevronRight;
        return (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggle(m.month);
            }}
            aria-expanded={isOpen}
            className="flex items-start gap-1.5 text-left"
            data-testid={`md-pay-expand-${m.month}`}
          >
            <Icon size={14} className="mt-0.5 shrink-0 text-md-ink-soft" aria-hidden />
            <span className="flex flex-col items-start gap-1">
              <span className="font-bold">{m.label}</span>
              {m.periods.length > 0 && (
                <span className="text-[11px] font-medium text-md-ink-soft">
                  {m.periods.length} pay {m.periods.length === 1 ? "period" : "periods"}
                </span>
              )}
            </span>
          </button>
        );
      },
      total: <span className="font-extrabold">{data.months.length} months</span>,
    },
    {
      key: "status",
      header: "Status",
      cell: (m) => (
        <span className="flex flex-col items-start gap-1">
          <MonthChips m={m} />
        </span>
      ),
    },
    days("workingDays", "Working", (m) => m.workingDays, t.workingDays),
    days("paidDays", "Paid", (m) => m.paidDays, t.paidDays),
    days("lopDays", "LOP", (m) => m.lopDays, t.lopDays),
    money("actualSalary", "Actual", (m) => m.actualSalary, t.actualSalary, "Full monthly salary"),
    money("earnedSalary", "Earned", (m) => m.earnedSalary, t.earnedSalary),
    money("lossOfPay", "Loss of pay", (m) => m.lossOfPay, t.lossOfPay, "Actual - earned: days not paid"),
    money("late", "Late ded.", (m) => m.lateDeduction, t.lateDeduction, "Late / early-out / permission penalties"),
    money("overtime", "Overtime", (m) => m.overtime, t.overtime),
    money("bonus", "Bonus", (m) => m.bonus, t.bonus),
    money("pf", "PF", (m) => m.deductions.pf, t.deductions.pf),
    money("esi", "ESI", (m) => m.deductions.esi, t.deductions.esi),
    money("tds", "TDS", (m) => m.deductions.tds, t.deductions.tds),
    money("advance", "Advance", (m) => m.deductions.advance, t.deductions.advance),
    money("other", "Other", (m) => m.deductions.other, t.deductions.other),
    {
      key: "adjustment",
      header: "Adjustment",
      align: "right",
      title: "Changed by hand by HR after the slip was computed",
      cell: (m) => (m.adjustment == null ? <span className="text-md-ink-soft">—</span> : signedRupees(m.adjustment)),
      total: adjustments.length ? signedRupees(adjustments.reduce((a, m) => a + (m.adjustment ?? 0), 0)) : "",
    },
    {
      key: "netPaid",
      header: "Net paid",
      align: "right",
      cell: (m) => <b className="font-extrabold">{inr(m.netPaid)}</b>,
      total: inr(t.netPaid),
    },
    days("clDays", "CL days", (m) => m.clDays, t.clDays),
    money("clAmount", "CL amount", (m) => m.clAmount, t.clAmount),
  ];
  // a production worker has no actual salary and so no loss of pay: two columns of dashes say nothing
  const perShift = data.months.every((m) => m.actualSalary == null);
  const shown = perShift ? columns.filter((c) => c.key !== "actualSalary" && c.key !== "lossOfPay") : columns;
  return (
    <SortTable
      caption={`${data.employee.name}: salary month by month`}
      columns={shown}
      rows={data.months}
      rowKey={(m) => m.month}
      onRowClick={(m) => onToggle(m.month)}
      rowLabel={(m) => `${open.has(m.month) ? "Hide" : "Show"} the details of ${m.label}`}
      highlight={(m) => m.month === highlight}
      detail={(m) => (open.has(m.month) ? <MonthDetail m={m} /> : null)}
      totals
      minWidth="112rem"
      testId="md-pay-history-table"
    />
  );
}

/**
 * One employee's complete monthly salary history: who they are and what they are paid today, the totals over the history,
 * a chart of actual, earned and net paid per month, and every month's figures (a production month lists its pay periods).
 */
export default function EmployeeProfile({
  id,
  query,
  month,
  onBack,
}: {
  id: number;
  query: DashQueries["person"];
  /** the month chosen on the page: highlighted in the history */
  month: string;
  onBack: () => void;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [highlight, setHighlight] = useState(month);
  useEffect(() => setHighlight(month), [month]);
  const data = query.data && query.data.employee.id === id ? query.data : undefined;

  const toggle = (m: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(m)) next.delete(m);
      else next.add(m);
      return next;
    });

  const back = (
    <button type="button" onClick={onBack} className="md-btn md-btn-soft md-btn-sm h-8" data-testid="md-pay-back">
      <ArrowLeft size={14} aria-hidden /> All employees
    </button>
  );

  if (failed(query) && !data) {
    return (
      <div className="space-y-4" data-testid="md-pay-profile">
        {back}
        <CardError query={query} />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="space-y-4" data-testid="md-pay-profile" aria-busy="true">
        {back}
        <div className="md-card p-5">
          <SkeletonBlock rows={4} />
        </div>
      </div>
    );
  }

  const pick = (m: string) => {
    setHighlight(m);
    setOpen((s) => new Set(s).add(m));
    // the table row on a wide screen, the card on a phone (whichever is shown)
    requestAnimationFrame(() => {
      const targets = [`[data-testid="row-${m}"]`, `[data-testid="md-pay-history-card-${m}"]`]
        .map((s) => document.querySelector<HTMLElement>(s))
        .filter((el): el is HTMLElement => !!el && el.offsetParent !== null);
      targets[0]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  };

  return (
    <div className="space-y-4 @lg:space-y-5" data-testid="md-pay-profile" data-employee={id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {back}
        <AskAiButton
          question={`Summarise ${data.employee.name}'s salary over the last ${data.months.length} months.`}
        />
      </div>
      <Header data={data} />
      {data.notes.map((n) => (
        <NoteBanner key={n}>{n}</NoteBanner>
      ))}
      {data.months.length === 0 ? (
        <SectionCard title="Salary history" testId="md-pay-profile-empty">
          <EmptyBlock icon={Wallet} title="No salary slips for this employee">
            Their months appear here once HR generates a payroll that includes them.
          </EmptyBlock>
        </SectionCard>
      ) : (
        <>
          <Kpis data={data} />
          <SectionCard
            testId="md-pay-profile-chart"
            title="Month by month"
            subtitle="Actual salary, what the paid days earned and what was paid, with the deductions as a dashed line. Click a month to find it below."
            actions={<Explain ids={["actual-salary", "earned-salary", "net-paid", "deductions"]} />}
          >
            <PersonChart rows={personChartRows(data.months)} selected={highlight} onSelect={pick} />
            <ChartLegend
              items={
                data.employee.type === "staff" ? PERSON_LEGEND : PERSON_LEGEND.filter((l) => l.key !== "actualSalary")
              }
              testId="md-pay-profile-legend"
            />
          </SectionCard>
          <SectionCard
            testId="md-pay-history"
            title="Complete history"
            subtitle="Newest first. Click a month for its attendance, payment and pay periods."
            actions={<Explain ids={["days", "loss-of-pay", "other-deductions", "adjustment", "cl"]} />}
          >
            <div className="hidden @3xl:block" data-layout="table">
              <History data={data} open={open} onToggle={toggle} highlight={highlight} />
            </div>
            <div className="@3xl:hidden" data-layout="cards">
              <HistoryCards data={data} open={open} onToggle={toggle} highlight={highlight} />
            </div>
          </SectionCard>
        </>
      )}
    </div>
  );
}
