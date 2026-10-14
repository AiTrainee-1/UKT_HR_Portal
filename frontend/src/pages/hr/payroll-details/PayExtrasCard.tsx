import type { ReactNode } from "react";
import { Clock, HandCoins, PencilLine, Timer, Wallet } from "lucide-react";
import { SectionCard } from "@/components/payroll/kit/parts";
import { inr2 } from "@/components/payroll/kit/format";
import type { PayrollDetails } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import type { Accent } from "./accent";
import { factValue, humanizeKey, isDegraded, sectionDomId } from "./logic";

function Panel({
  icon: Icon,
  title,
  children,
  testId,
  className,
}: {
  icon: typeof Wallet;
  title: string;
  children: ReactNode;
  testId: string;
  className?: string;
}) {
  return (
    <div className={cn("rounded-xl border border-slate-100 p-4", className)} data-testid={testId}>
      <h4 className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-500">
        <Icon size={14} /> {title}
      </h4>
      {children}
    </div>
  );
}

/** What else moved the pay: advance recoveries, the late deduction, HR's own adjustment and overtime. */
export function PayExtrasCard({ details, accent }: { details: PayrollDetails; accent: Accent }) {
  const { advances, money } = details;
  // a payroll with no breakdown shows its notes (they say why) in the notice at the top of the page instead
  const notes = isDegraded(details) ? null : details.notes;
  const advanceTotal = advances.reduce((sum, a) => sum + a.amount, 0);
  const late = details.issues.find((i) => i.code === "late_penalty");
  const lateFacts = Object.entries(late?.facts ?? {});

  return (
    <SectionCard
      id={sectionDomId("pay")}
      testId="pd-section-pay"
      className="scroll-mt-16"
      icon={Wallet}
      title="Pay & deductions"
      description="The advance recoveries, the late deduction, any adjustment HR made and overtime behind the figures above."
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Panel icon={HandCoins} title="Advance recovery" testId="pd-advances">
          {advances.length === 0 ? (
            <p className="text-sm text-muted-foreground">No advance was recovered in this payroll.</p>
          ) : (
            <>
              <ul className="divide-y divide-slate-100">
                {advances.map((a) => (
                  <li
                    key={`${a.advanceId}-${a.repaymentId}`}
                    className="flex items-start justify-between gap-3 py-2"
                    data-testid={`pd-advance-${a.advanceId}`}
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-800">Advance #{a.advanceId}</p>
                      <p className="text-xs text-muted-foreground">
                        Repayment #{a.repaymentId}
                        {a.notes ? ` · ${a.notes}` : ""}
                      </p>
                    </div>
                    <p className="shrink-0 text-sm font-semibold tabular-nums text-red-700">− {inr2(a.amount)}</p>
                  </li>
                ))}
              </ul>
              {advances.length > 1 && (
                <p className="mt-1 flex justify-between border-t border-slate-100 pt-2 text-sm font-bold">
                  <span>Total recovered</span>
                  <span className="tabular-nums text-red-700">− {inr2(advanceTotal)}</span>
                </p>
              )}
            </>
          )}
        </Panel>

        <Panel icon={PencilLine} title="Adjustment by HR" testId="pd-adjustment">
          {notes || money.bonus ? (
            <div className="space-y-2">
              {money.bonus ? (
                <p className="flex justify-between text-sm">
                  <span className="text-slate-700">Bonus added</span>
                  <span className="font-semibold tabular-nums text-emerald-700">+ {inr2(money.bonus)}</span>
                </p>
              ) : null}
              {notes && (
                <p
                  className={cn(
                    "whitespace-pre-line rounded-lg px-3 py-2 text-sm leading-snug text-slate-700",
                    accent.soft,
                  )}
                  data-testid="pd-adjustment-note"
                >
                  {notes}
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">HR made no adjustment to this payroll.</p>
          )}
        </Panel>

        <Panel icon={Clock} title="Overtime" testId="pd-overtime">
          {money.otAmount ? (
            <p className="flex justify-between text-sm">
              <span className="text-slate-700">Overtime pay</span>
              <span className="font-semibold tabular-nums text-emerald-700">+ {inr2(money.otAmount)}</span>
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">No overtime pay on this payroll.</p>
          )}
        </Panel>

        {late && (
          <Panel icon={Timer} title="Late deduction" testId="pd-late-deduction">
            <p className="text-sm leading-snug text-slate-700">{late.detail}</p>
            {lateFacts.length > 0 && (
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                {lateFacts.map(([key, value]) => (
                  <div key={key} className="flex justify-between gap-2 border-b border-dashed border-slate-100 py-0.5">
                    <dt className="capitalize text-muted-foreground">{humanizeKey(key)}</dt>
                    <dd className="font-semibold tabular-nums text-slate-800">{factValue(value)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </Panel>
        )}
      </div>
    </SectionCard>
  );
}
