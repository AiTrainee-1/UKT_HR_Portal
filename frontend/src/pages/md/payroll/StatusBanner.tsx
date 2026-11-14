import { CircleAlert, CircleCheck, Hourglass, Info } from "lucide-react";
import ProvenanceButton from "@/components/md/kit/ProvenanceButton";
import type { Provenance } from "@/lib/md/types";
import { cn } from "@/lib/utils";
import { STATE_STYLE, describeStatus, statusDates, statusFacts, type StatusSummary } from "./logic";
import { OVERLINE, Pill, toneClass, type MoneyTone } from "./parts";
import type { MonthStatus } from "./types";

// Sage = all well, ochre = watch, crimson = a problem, periwinkle = information. Never wine: that is the brand.
const TONE: Record<StatusSummary["tone"], { tone: MoneyTone; icon: typeof Info }> = {
  good: { tone: "success", icon: CircleCheck },
  warn: { tone: "warning", icon: Hourglass },
  bad: { tone: "danger", icon: CircleAlert },
  info: { tone: "info", icon: Info },
};

/**
 * Which month the figures describe, and where it stands in HR's month workflow: still open, Payroll Done with the
 * payment pending for N days, or Paid on a date (production: cleared = paid). Cleared staff salaries are shown as a
 * "verified" count, never as paid; salaries on hold, new joiners waiting to be added and people paid separately get a
 * chip each. It sits right under the filters so a number is never read without it.
 */
export default function StatusBanner({
  status,
  provenance,
}: {
  status: MonthStatus | undefined;
  provenance?: Provenance[];
}) {
  if (!status) return null;
  const view = describeStatus(status);
  const style = STATE_STYLE[status.state] ?? STATE_STYLE.generated;
  const tone = TONE[view.tone];
  const Icon = tone.icon;
  const facts = statusFacts(status);
  const dates = statusDates(status);
  return (
    <div
      className={cn("md-card md-money-status", toneClass(tone.tone))}
      data-testid="md-payroll-status-banner"
      data-state={status.state}
    >
      <span className="md-money-tile md-money-tile-solid">
        <Icon size={20} aria-hidden />
      </span>
      <div className="min-w-0 flex-[1_1_16rem]">
        <p className="flex flex-wrap items-center gap-2 text-[17px] font-black leading-tight tracking-tight text-md-ink">
          <span data-testid="md-payroll-status-month">{status.label}</span>
          <Pill className={style.chip}>{view.headline}</Pill>
        </p>
        <p className="mt-1 text-[13px] leading-snug text-md-ink-soft" data-testid="md-payroll-status-detail">
          {view.detail}
        </p>
        {facts.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-1.5" data-testid="md-payroll-status-facts">
            {facts.map((f) => (
              <li key={f.id}>
                <span
                  className={cn("md-chip text-[11.5px] tabular-nums", f.chip)}
                  title={f.title}
                  data-testid={`md-payroll-status-fact-${f.id}`}
                >
                  {f.text}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {dates.length > 0 && (
        <dl
          className="grid w-full grid-cols-2 gap-x-5 gap-y-2 @md:flex @md:w-auto @md:flex-wrap @2xl:border-l @2xl:border-md-line @2xl:pl-5"
          data-testid="md-payroll-status-dates"
        >
          {dates.map((d) => (
            <div key={d.id} className="min-w-0">
              <dt className={OVERLINE}>{d.label}</dt>
              <dd className="mt-0.5 text-[13px] font-bold tabular-nums text-md-ink">{d.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <ProvenanceButton provenance={provenance} ids={["payroll-status", "provisional"]} />
    </div>
  );
}
