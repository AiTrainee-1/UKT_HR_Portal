import { AlertTriangle, CalendarClock, RefreshCw, Settings as SettingsIcon, Users } from "lucide-react";
import { Link } from "wouter";
import { BusyIcon } from "@/components/payroll/kit/parts";
import { Button } from "@/components/ui/button";
import { PAY_CYCLE_INFO, type CyclePeriod, type PayCycle } from "@/lib/api-client/custom-hooks";
import { formatPeriod, unassignedNotice } from "./logic";

/** What the Settings tab of a cycle is called in the notices, and the address that opens it. */
export const cycleSettingsHref = (cycle: PayCycle): string =>
  `/hr/settings?tab=production_payroll#${cycle}-first-period`;

/**
 * Shown instead of the payroll when the cycle has no usable period rule (BiWeekly and Monthly need a first period
 * start date before the weeks can be paired up).
 */
export function SetupNeeded({ cycle, problem }: { cycle: PayCycle; problem: string }) {
  const label = PAY_CYCLE_INFO[cycle].label;
  return (
    <div
      className="clay-card flex flex-col items-center rounded-2xl border-2 border-dashed border-amber-300 bg-amber-50/70 px-6 py-10 text-center"
      data-testid="pcp-setup-needed"
    >
      <span className="mb-3 rounded-2xl bg-white/80 p-3 text-amber-600">
        <AlertTriangle size={26} />
      </span>
      <p className="text-sm font-bold text-amber-900">{label} payroll is not set up yet</p>
      <p className="mx-auto mt-1 max-w-xl text-xs text-amber-800">{problem}</p>
      <Button asChild className="mt-4 gap-2 bg-amber-600 hover:bg-amber-700">
        <Link href={cycleSettingsHref(cycle)}>
          <SettingsIcon size={14} /> Open {label} settings
        </Link>
      </Button>
    </div>
  );
}

/** A reminder that some production employees are in no cycle, so no page pays them. Nothing when everyone is placed. */
export function UnassignedNotice({ unassigned }: { unassigned: number }) {
  const text = unassignedNotice(unassigned);
  if (!text) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-900"
      data-testid="pcp-unassigned-notice"
    >
      <span className="rounded-xl bg-white/70 p-1.5 text-amber-600">
        <Users size={14} />
      </span>
      <span className="min-w-0 flex-1 basis-56">{text}</span>
      <Link href="/hr/employees/productionEmployee" className="font-semibold text-amber-800 underline">
        Assign them on Production Employees
      </Link>
    </div>
  );
}

/** What went wrong, in one sentence: the server's own words when it gave any. */
export function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * The chosen period could not be worked out (a pay period the cycle does not have, or the server did not answer): the tabs
 * show this instead of their figures. The period picker above is the way out; Retry is for a server that did not answer.
 */
export function PeriodError({
  error,
  onRetry,
  retrying,
}: {
  error: unknown;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return (
    <div
      className="flex flex-col items-center gap-3 rounded-2xl border border-red-200 bg-red-50 px-6 py-10 text-center"
      role="alert"
      data-testid="pcp-period-error"
    >
      <span className="rounded-2xl bg-white/80 p-3 text-red-600">
        <AlertTriangle size={24} />
      </span>
      <div>
        <p className="text-sm font-bold text-red-900">This pay period could not be loaded</p>
        <p className="mx-auto mt-1 max-w-xl break-words text-xs text-red-800">
          {errorText(error, "The server did not answer.")} Pick another pay period above.
        </p>
      </div>
      {onRetry && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5 bg-white"
          onClick={onRetry}
          disabled={retrying}
        >
          <BusyIcon busy={!!retrying} icon={RefreshCw} size={13} /> Try again
        </Button>
      )}
    </div>
  );
}

/** A period that has not ended yet cannot be generated: payroll for it opens on its last day. */
export function NotEndedNote({ period }: { period: CyclePeriod }) {
  return (
    <p
      className="flex items-center gap-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800"
      data-testid="pcp-not-ended"
    >
      <CalendarClock size={14} className="shrink-0 text-amber-600" />
      {formatPeriod(period)} has not ended yet: payroll for it can be generated from its last day.
    </p>
  );
}
