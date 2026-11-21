// Where a staff month stands in HR's month workflow (2026-11-10), for the MD: the three steps (Generated -> Payroll Done ->
// Paid) with their dates, and the people outside the ordinary run: verified (Cleared), held, new joiners waiting, paid
// separately, not included and left since. Read-only: HR does all of it on the Staff Payroll page.

import { useState } from "react";
import { Check, ChevronDown, Circle } from "lucide-react";
import SectionCard from "@/components/md/kit/SectionCard";
import { dayLong, inrCompact, num } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import { Explain, Figure } from "./parts";
import type { PayMonthRow, PayNotIncluded } from "./types";

type Step = { id: string; label: string; done: boolean; current: boolean; when: string | null; note?: string | null };

const day = (iso: string | null | undefined) => (iso ? dayLong(iso.slice(0, 10)) : null);

/** The three steps of the month, the one it is at marked current. */
export function workflowSteps(row: PayMonthRow): Step[] {
  const w = row.workflow;
  const generated = w.slips > 0;
  const done = w.locked;
  const paid = !!w.markedPaidAt;
  return [
    {
      id: "generated",
      label: "Generated",
      done: generated,
      current: generated && !done,
      when: null,
      note: generated && !done ? "still open: HR can work it out again" : null,
    },
    {
      id: "finalized",
      label: "Payroll Done",
      done,
      current: done && !paid,
      when: day(w.finalizedAt),
      note: done && !paid && w.paymentPendingDays != null ? `payment pending ${num(w.paymentPendingDays)} days` : null,
    },
    {
      id: "paid",
      label: "Paid",
      done: paid,
      current: paid,
      when: day(w.markedPaidAt),
      note: paid && w.daysToPay != null ? `${num(w.daysToPay)} days after Payroll Done` : null,
    },
  ];
}

function Steps({ steps }: { steps: Step[] }) {
  return (
    <ol className="grid grid-cols-3 gap-2" data-testid="md-pay-flow-steps">
      {steps.map((s) => (
        <li
          key={s.id}
          className={cn("md-money-metric flex flex-col gap-1", s.current && "md-money-metric-wine")}
          data-testid={`md-pay-flow-${s.id}`}
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

const REASON: Record<PayNotIncluded["people"][number]["reason"], string> = {
  not_generated: "not generated",
  no_salary: "no monthly salary on the profile",
};

function NotIncludedList({ data }: { data: PayNotIncluded }) {
  const [open, setOpen] = useState(false);
  if (!data.count) return null;
  return (
    <div className="md-panel-sand rounded-xl px-3 py-2" data-testid="md-pay-not-included">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 text-left text-[12.5px] font-bold text-md-ink"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-testid="md-pay-not-included-toggle"
      >
        <span>
          {num(data.count)} active staff not in this month's payroll
          {data.noSalary ? ` (${num(data.noSalary)} without a monthly salary)` : ""}
        </span>
        <ChevronDown size={15} aria-hidden className={cn("shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <ul className="mt-2 divide-y divide-md-line text-[12.5px]" data-testid="md-pay-not-included-list">
          {data.people.map((p) => (
            <li key={p.employeeId} className="flex flex-wrap items-baseline justify-between gap-x-3 py-1.5">
              <span className="min-w-0 font-semibold text-md-ink">
                {p.name} <span className="font-mono text-[11px] text-md-ink-soft">{p.code}</span>
              </span>
              <span className="text-[11.5px] text-md-ink-soft">
                {[p.department, REASON[p.reason]].filter(Boolean).join(" · ")}
              </span>
            </li>
          ))}
          {data.count > data.people.length && (
            <li className="py-1.5 text-[11.5px] text-md-ink-soft">
              and {num(data.count - data.people.length)} more (HR's Staff Payroll lists them under Not included)
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/** The month's workflow card. */
export default function StaffWorkflow({ row, notIncluded }: { row: PayMonthRow; notIncluded: PayNotIncluded | null }) {
  const w = row.workflow;
  return (
    <SectionCard
      testId="md-pay-flow"
      title={`Where ${row.label} stands`}
      subtitle="HR's month: Generated, then Payroll Done (locked), then Paid. Cleared only means HR checked a salary."
      actions={<Explain ids={["workflow", "not-included", "left-since"]} />}
    >
      <div className="space-y-3">
        <Steps steps={workflowSteps(row)} />
        <div className="grid grid-cols-2 gap-2.5 @3xl:grid-cols-3 @5xl:grid-cols-6" data-testid="md-pay-flow-figures">
          <Figure
            label="Verified (Cleared)"
            value={`${num(w.clearedSlips)} of ${num(w.slips)}`}
            sub={`${num(w.paidSlips)} paid`}
            testId="md-pay-flow-cleared"
          />
          <Figure
            label="On hold"
            value={num(w.onHold)}
            sub={w.onHold ? `${inrCompact(w.onHoldNet)} net, not paid with the month` : "none"}
            testId="md-pay-flow-hold"
          />
          <Figure
            label="New joiners waiting"
            value={num(w.newJoinersWaiting)}
            sub={w.newJoinersWaiting ? `${inrCompact(w.newJoinersNet)}, not in the figures yet` : "none"}
            testId="md-pay-flow-new-joiners"
          />
          <Figure
            label="Paid separately"
            value={num(w.paidSeparately)}
            sub="released after Payroll Done"
            testId="md-pay-flow-separately"
          />
          <Figure
            label="Not included"
            value={notIncluded ? num(notIncluded.count) : "—"}
            sub="active staff with no payroll"
            testId="md-pay-flow-not-included"
          />
          <Figure
            label="Left since"
            value={num(w.leftSince)}
            sub={w.leftSince ? `${inrCompact(w.leftSinceNet)} net, in these figures` : "everyone still active"}
            testId="md-pay-flow-left"
          />
        </div>
        {notIncluded && <NotIncludedList data={notIncluded} />}
      </div>
    </SectionCard>
  );
}
