import { useState } from "react";
import { ArrowLeft, Factory } from "lucide-react";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock, NoteBanner } from "@/components/md/kit/states";
import { dayShort, inr, inrCompact, num, weekdayShort } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import { employeeStatusTone, words } from "../logic";
import { CardError, ChartLegend, Explain, Figure, ToneChip, failed } from "../parts";
import SortTable, { type Col } from "../SortTable";
import type { ProdDay, ProdWorkerPeriod } from "../types";
import { WORKER_LEGEND, WorkerChart } from "./charts";
import { paymentWords, periodTone, workerChartRows } from "./logic";
import type { ProdQueries } from "./queries";

const DAY_TONE: Record<string, string> = {
  present: "md-chip-success",
  half_shift: "md-chip-warning",
  absent: "md-chip-danger",
};

/** The days of one pay period: the date, what the day was, the shifts earned, late, and the punches. */
export function DayGrid({ days }: { days: ProdDay[] }) {
  if (days.length === 0) {
    return <p className="px-1 text-[12px] text-md-ink-soft">This payslip keeps no day-by-day list.</p>;
  }
  return (
    <ul className="grid grid-cols-2 gap-2 @lg:grid-cols-4 @5xl:grid-cols-7" data-testid="md-prod-days">
      {days.map((d, i) => (
        <li
          key={`${d.date}-${i}`}
          className="md-money-metric flex flex-col gap-0.5"
          data-testid="md-prod-day"
          data-status={d.status}
        >
          <span className="flex items-center justify-between gap-1 text-[12px] font-extrabold text-md-ink">
            <span>{d.date ? `${weekdayShort(d.date)} ${dayShort(d.date)}` : "—"}</span>
            {d.late && <span className="md-chip md-chip-warning text-[11px]">Late</span>}
          </span>
          <span className={cn("md-chip w-fit text-[11px]", DAY_TONE[d.status])}>{words(d.status) || "—"}</span>
          <span className="text-[11.5px] font-semibold tabular-nums text-md-ink">
            {num(d.shifts, 1)} shift{d.shifts === 1 ? "" : "s"}
          </span>
          <span className="text-[11px] tabular-nums text-md-ink-soft">
            {d.firstPunch ?? "—"} to {d.lastPunch ?? "—"}
            {d.lastPunchNextDay ? " (next day)" : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * One worker's pay periods (every cycle, newest first): who they are, the periods added up, net and shifts per period,
 * and each period's figures, where it stands and its days (the one open on the page is opened first).
 */
export default function WorkerProfile({
  query,
  period,
  onBack,
}: {
  query: ProdQueries["person"];
  /** the period the page is on: its days open first */
  period: string;
  onBack: () => void;
}) {
  const data = query.data;
  const [open, setOpen] = useState<string | null>(null);
  const back = (
    <button type="button" className="md-btn md-btn-soft md-btn-sm" onClick={onBack} data-testid="md-prod-worker-back">
      <ArrowLeft size={14} aria-hidden /> Back to the workers
    </button>
  );
  if (failed(query)) {
    return (
      <div className="space-y-3" data-testid="md-prod-worker">
        {back}
        <CardError query={query} />
      </div>
    );
  }
  if (query.isPending || !data) {
    return (
      <div className="space-y-3" data-testid="md-prod-worker" aria-busy="true">
        {back}
        <SectionCard title="Pay periods" loading />
      </div>
    );
  }
  const e = data.employee;
  const t = data.totals;
  const shown = open ?? (data.periods.some((p) => p.key === period) ? period : (data.periods[0]?.key ?? null));
  const columns: Col<ProdWorkerPeriod>[] = [
    {
      key: "period",
      header: "Period",
      cell: (p) => (
        <span className="flex flex-col items-start gap-1">
          <span className="font-bold">{p.label}</span>
          <span className="flex flex-wrap gap-1">
            <span className="md-chip text-[11px]">{p.cycleLabel}</span>
            <ToneChip tone={periodTone(p.state)} className="text-[11px]">
              {p.stateLabel}
            </ToneChip>
          </span>
        </span>
      ),
    },
    { key: "rate", header: "Rate", align: "right", cell: (p) => inr(p.ratePerShift) },
    {
      key: "shifts",
      header: "Shifts",
      align: "right",
      cell: (p) => (
        <span className="flex flex-col items-end">
          <span className="font-semibold">{num(p.shifts, 1)}</span>
          <span className="text-[11px] text-md-ink-soft">
            {num(p.daysWorked)} worked · {num(p.daysAbsent)} absent · {num(p.lateDays)} late
          </span>
        </span>
      ),
    },
    { key: "gross", header: "Gross pay", align: "right", cell: (p) => inr(p.grossPay) },
    {
      key: "bonus",
      header: "Excess - det.",
      align: "right",
      cell: (p) =>
        p.excess || p.detection ? (
          <span className="flex flex-col items-end">
            <span>{inr(p.bonus)}</span>
            <span className="text-[11px] text-md-ink-soft">
              +{inr(p.excess)} / -{inr(p.detection)}
            </span>
          </span>
        ) : (
          <span className="text-md-ink-soft">—</span>
        ),
    },
    {
      key: "deductions",
      header: "Deductions",
      align: "right",
      cell: (p) => (
        <span className="flex flex-col items-end" title="PF, ESI, TDS, advance, late, other">
          <span>{inr(p.deductions.total)}</span>
          {p.deductions.total > 0 && (
            <span className="text-[11px] text-md-ink-soft">
              {[
                p.deductions.pf && `PF ${inr(p.deductions.pf)}`,
                p.deductions.esi && `ESI ${inr(p.deductions.esi)}`,
                p.deductions.tds && `TDS ${inr(p.deductions.tds)}`,
                p.deductions.advance && `adv. ${inr(p.deductions.advance)}`,
                p.deductions.late && `late ${inr(p.deductions.late)}`,
                p.deductions.other && `other ${inr(p.deductions.other)}`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          )}
        </span>
      ),
    },
    {
      key: "net",
      header: "Net paid",
      align: "right",
      cell: (p) => <span className="font-bold">{inr(p.netPaid)}</span>,
    },
    {
      key: "payment",
      header: "Payment",
      cell: (p) => {
        const w = paymentWords(p.paymentStatus, p.cleared);
        return (
          <ToneChip tone={w.tone} className="text-[11px]">
            {w.label}
          </ToneChip>
        );
      },
    },
  ];

  return (
    <div className="space-y-4 @lg:space-y-5" data-testid="md-prod-worker">
      {back}
      <section className="md-card p-3.5 sm:p-5" data-testid="md-prod-worker-head">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p
              className="text-[19px] font-black leading-tight tracking-tight text-md-ink"
              data-testid="md-prod-worker-name"
            >
              {e.name}
            </p>
            <p className="mt-0.5 font-mono text-[12px] text-md-ink-soft">{e.code}</p>
            <p className="mt-1 text-[12.5px] text-md-ink-soft">
              {[e.designation, e.department, e.unit].filter(Boolean).join(" · ") || "—"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="md-chip md-chip-wine">{e.cycleLabel ?? "No pay cycle now"}</span>
            <ToneChip tone={employeeStatusTone(e.status)}>{words(e.status) || "—"}</ToneChip>
            <span className="md-chip">{e.ratePerShift != null ? `${inr(e.ratePerShift)} a shift` : "No rate set"}</span>
          </div>
        </div>
      </section>
      {data.notes.map((n) => (
        <NoteBanner key={n}>{n}</NoteBanner>
      ))}
      {data.periods.length === 0 ? (
        <SectionCard title="Pay periods" testId="md-prod-worker-empty">
          <EmptyBlock icon={Factory} title="No pay period yet">
            No production payslip has been generated for this worker yet.
          </EmptyBlock>
        </SectionCard>
      ) : (
        <>
          <div
            className="grid grid-cols-2 gap-2.5 @3xl:grid-cols-5 @max-3xl:[&>*:last-child:nth-child(odd)]:col-span-2"
            data-testid="md-prod-worker-totals"
          >
            <Figure label="Periods shown" value={num(data.periods.length)} emphasis testId="md-prod-worker-periods" />
            <Figure
              label="Shifts"
              value={num(t.shifts, 1)}
              sub={`${num(t.daysAbsent)} days absent`}
              testId="md-prod-worker-shifts"
            />
            <Figure label="Gross pay" value={inrCompact(t.grossPay)} testId="md-prod-worker-gross" />
            <Figure label="Deductions" value={inrCompact(t.deductions.total)} testId="md-prod-worker-deductions" />
            <Figure label="Net paid" value={inrCompact(t.netPaid)} testId="md-prod-worker-net" />
          </div>
          <SectionCard
            testId="md-prod-worker-chart-card"
            title="Pay period by period"
            subtitle="Net paid and deductions, with the shifts. Click a period to see its days."
            actions={<Explain ids={["prod-net", "prod-shifts"]} />}
          >
            <WorkerChart rows={workerChartRows(data.periods)} selected={shown} onSelect={setOpen} />
            <ChartLegend items={WORKER_LEGEND} testId="md-prod-worker-legend" />
          </SectionCard>
          <SectionCard
            testId="md-prod-worker-table"
            title="Every pay period"
            subtitle="Click a period to open its days."
            actions={<Explain ids={["prod-state", "excess", "deductions"]} />}
          >
            <SortTable
              caption="The worker's pay periods"
              columns={columns}
              rows={data.periods}
              rowKey={(p) => p.key + p.cycle}
              onRowClick={(p) => setOpen(p.key === shown ? "" : p.key)}
              rowLabel={(p) => `Show the days of ${p.label}`}
              highlight={(p) => p.key === shown}
              detail={(p) => (p.key === shown ? <DayGrid days={p.days} /> : null)}
              minWidth="56rem"
            />
          </SectionCard>
        </>
      )}
    </div>
  );
}
