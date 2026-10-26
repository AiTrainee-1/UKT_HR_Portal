import { Link } from "wouter";
import { ArrowUpRight, Landmark } from "lucide-react";
import { Chip, SectionCard } from "@/components/payroll/kit/parts";
import { inr2 } from "@/components/payroll/kit/format";
import { CO_EMP_EMPLOYEES_PATH, PF_ESI_SETTINGS_PATH, type StatutoryView } from "@/components/payroll/kit/statutory";
import { cn } from "@/lib/utils";
import type { Accent } from "./accent";

/**
 * "How PF, ESI and TDS were worked out": what payroll recorded about the employee's PF / ESI / TDS category, the rule it
 * matched and the base it worked on, in sentences. It only reads what was stored with the payroll
 * (`breakdown_details.deductions.statutory`); a payroll generated before the PF / ESI redesign has none, and then the
 * page simply has no such card.
 */
export function StatutoryCard({ view, accent }: { view: StatutoryView; accent: Accent }) {
  const link =
    view.category === "co_emp"
      ? { href: PF_ESI_SETTINGS_PATH, label: "Open PF & ESI rules" }
      : { href: CO_EMP_EMPLOYEES_PATH, label: "Open Employees (Co Emp and TDS)" };
  return (
    <SectionCard
      id="pd-statutory"
      testId="pd-section-statutory"
      className="scroll-mt-16"
      icon={Landmark}
      title="How PF, ESI and TDS were worked out"
      description="What payroll recorded when it decided which of them apply to this employee. Nothing here recalculates anything."
      actions={
        <Link
          href={link.href}
          className={cn(
            "inline-flex items-center gap-1 whitespace-nowrap text-xs font-semibold underline-offset-2 hover:underline print:hidden",
            accent.text,
          )}
          data-testid="pd-statutory-link"
        >
          {link.label} <ArrowUpRight size={12} />
        </Link>
      }
    >
      <p
        className={cn("rounded-xl px-4 py-3 text-sm text-slate-800", accent.soft)}
        data-testid="pd-statutory-headline"
        data-category={view.category}
      >
        {view.headline}
      </p>

      {view.lines.length > 0 && (
        <ul className="mt-3 divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-100">
          {view.lines.map((line) => (
            <li
              key={line.key}
              className="flex items-start justify-between gap-3 px-4 py-3"
              data-testid={`pd-statutory-line-${line.key}`}
              data-applied={line.applied ? "true" : "false"}
            >
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-800">
                  {line.title}
                  {!line.applied && <Chip tone="neutral">nothing deducted</Chip>}
                </p>
                <p className="mt-0.5 text-sm text-slate-700">{line.summary}</p>
                {line.notes.map((note, i) => (
                  <p key={i} className="mt-0.5 text-xs leading-snug text-muted-foreground">
                    {note}
                  </p>
                ))}
              </div>
              <p
                className={cn(
                  "shrink-0 text-sm font-semibold tabular-nums",
                  line.applied ? "text-red-700" : "text-slate-400",
                )}
              >
                {line.applied ? `− ${inr2(line.amount)}` : inr2(0)}
              </p>
            </li>
          ))}
        </ul>
      )}

      {view.eligibility.length > 0 && (
        <div className="mt-3" data-testid="pd-statutory-eligibility">
          <h4 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-slate-500">
            What the rules were tested on (a full month, not prorated)
          </h4>
          <dl className="grid gap-2 sm:grid-cols-3">
            {view.eligibility.map((e) => (
              <div key={e.label} className="rounded-lg border border-slate-100 px-3 py-2">
                <dt className="text-[11px] text-muted-foreground">{e.label}</dt>
                <dd className="text-sm font-black tabular-nums text-slate-800">{inr2(e.amount)}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </SectionCard>
  );
}
