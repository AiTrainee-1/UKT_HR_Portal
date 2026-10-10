import { CircleAlert, CircleCheck, Hourglass, Info } from "lucide-react";
import ProvenanceButton from "@/components/md/kit/ProvenanceButton";
import type { Provenance } from "@/lib/md/types";
import { cn } from "@/lib/utils";
import { STATE_STYLE, describeStatus, whenText, type StatusSummary } from "./logic";
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
 * Which month the figures describe, and where it stands: paid, part paid, generated, still running, provisional. The
 * system has no "finalised" switch, so this is the nearest honest answer, and it sits right under the filters so a
 * number is never read without it.
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
  const style = STATE_STYLE[status.state];
  const tone = TONE[view.tone];
  const Icon = tone.icon;
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
      </div>
      {(status.generatedAt || status.paidAt) && (
        <dl className="flex gap-5 sm:border-l sm:border-md-line sm:pl-5">
          {status.generatedAt && (
            <div>
              <dt className={OVERLINE}>Generated</dt>
              <dd className="mt-0.5 text-[13px] font-bold tabular-nums text-md-ink">{whenText(status.generatedAt)}</dd>
            </div>
          )}
          {status.paidAt && (
            <div>
              <dt className={OVERLINE}>Last marked paid</dt>
              <dd className="mt-0.5 text-[13px] font-bold tabular-nums text-md-ink">{whenText(status.paidAt)}</dd>
            </div>
          )}
        </dl>
      )}
      <ProvenanceButton provenance={provenance} ids={["payroll-status", "provisional"]} />
    </div>
  );
}
