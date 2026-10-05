import { CircleAlert, CircleCheck, Hourglass, Info } from "lucide-react";
import ProvenanceButton from "@/components/md/kit/ProvenanceButton";
import type { Provenance } from "@/lib/md/types";
import { cn } from "@/lib/utils";
import { STATE_STYLE, describeStatus, whenText, type StatusSummary } from "./logic";
import { Pill } from "./parts";
import type { MonthStatus } from "./types";

const TONE: Record<StatusSummary["tone"], { box: string; icon: typeof Info; iconClass: string }> = {
  good: { box: "border-green-200 bg-green-50/70", icon: CircleCheck, iconClass: "text-green-600" },
  warn: { box: "border-amber-200 bg-amber-50/70", icon: Hourglass, iconClass: "text-amber-600" },
  bad: { box: "border-red-200 bg-red-50/70", icon: CircleAlert, iconClass: "text-red-600" },
  info: { box: "border-blue-200 bg-blue-50/60", icon: Info, iconClass: "text-blue-600" },
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
      className={cn("flex flex-wrap items-start gap-3 rounded-2xl border p-3.5", tone.box)}
      data-testid="md-payroll-status-banner"
      data-state={status.state}
    >
      <Icon size={20} className={cn("mt-0.5 shrink-0", tone.iconClass)} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-bold text-gray-900">
          <span data-testid="md-payroll-status-month">{status.label}</span>
          <Pill className={style.chip}>{view.headline}</Pill>
        </p>
        <p className="mt-0.5 text-xs text-gray-600" data-testid="md-payroll-status-detail">
          {view.detail}
        </p>
      </div>
      {(status.generatedAt || status.paidAt) && (
        <dl className="flex gap-4 text-[11px] text-gray-500">
          {status.generatedAt && (
            <div>
              <dt className="font-semibold uppercase tracking-wide">Generated</dt>
              <dd>{whenText(status.generatedAt)}</dd>
            </div>
          )}
          {status.paidAt && (
            <div>
              <dt className="font-semibold uppercase tracking-wide">Last marked paid</dt>
              <dd>{whenText(status.paidAt)}</dd>
            </div>
          )}
        </dl>
      )}
      <ProvenanceButton provenance={provenance} ids={["payroll-status", "provisional"]} />
    </div>
  );
}
