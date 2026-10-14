import { ArrowUpRight, ListChecks } from "lucide-react";
import { Link } from "wouter";
import { useCompensationConfig } from "@/lib/api-client/custom-hooks";
import { formatDuration, formatUntil } from "@/pages/hr/settings/compensation/time";
import { compensationSettingsHref, fmtShifts } from "../logic";

// "How it is worked out": the rules the page is using right now, read from Settings -> Compensation, so HR can see why a row
// has the allowance or the suggested shifts it has. Read-only: the rules are edited in Settings.

function Summary({ children }: { children: string }) {
  return (
    <summary className="flex cursor-pointer select-none items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-slate-900">
      <ListChecks size={13} />
      {children}
    </summary>
  );
}

function SettingsLink({ setting }: { setting: string }) {
  return (
    <Link
      href={compensationSettingsHref(setting)}
      className="inline-flex items-center gap-0.5 font-semibold text-blue-700 hover:underline"
    >
      Change the rules in Settings <ArrowUpRight size={11} />
    </Link>
  );
}

/** Type 1: "Worked 1 hour past the shift end: 30 minutes on the next morning's first punch". */
export function AllowanceRules() {
  const { data, isLoading, isError } = useCompensationConfig();
  const rules = (data?.allowanceRules ?? [])
    .filter((r) => r.enabled)
    .sort((a, b) => a.minExtraMinutes - b.minExtraMinutes);
  return (
    <details className="rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2" data-testid="rules-type1">
      <Summary>How the allowance is worked out</Summary>
      <div className="mt-2 space-y-2 text-xs text-slate-600">
        {isLoading ? (
          <p>Loading the rules…</p>
        ) : isError ? (
          <p data-testid="rules-type1-error">The rules could not be loaded. Reload the page to try again.</p>
        ) : rules.length === 0 ? (
          <p>No Type 1 rule is switched on.</p>
        ) : (
          <ul className="list-disc space-y-0.5 pl-5">
            {rules.map((r) => (
              <li key={r.id}>
                Worked {formatDuration(r.minExtraMinutes)} past the shift end: {formatDuration(r.allowanceMinutes)}{" "}
                later on the next working day&apos;s first punch.
              </li>
            ))}
          </ul>
        )}
        <p>
          It applies only up to {formatDuration(data?.shift.minExtraMinutes ?? 150)} of extra work; more than that is
          Type 2. The shift&apos;s own grace still applies on top.
        </p>
        <SettingsLink setting="allowance-rules" />
      </div>
    </details>
  );
}

/** Type 2: the ladder of last punch-out times and the shifts each earns. */
export function ShiftRules() {
  const { data, isLoading, isError } = useCompensationConfig();
  const rules = (data?.shiftRules ?? []).filter((r) => r.enabled).sort((a, b) => a.sortOrder - b.sortOrder);
  return (
    <details className="rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2" data-testid="rules-type2">
      <Summary>How the suggested shifts are worked out</Summary>
      <div className="mt-2 space-y-2 text-xs text-slate-600">
        <p>
          Counted only when the last punch-out is more than {formatDuration(data?.shift.minExtraMinutes ?? 150)} past
          the shift end. HR can change the suggestion when assigning.
        </p>
        {isLoading ? (
          <p>Loading the rules…</p>
        ) : isError ? (
          <p data-testid="rules-type2-error">The rules could not be loaded. Reload the page to try again.</p>
        ) : rules.length === 0 ? (
          <p>No Type 2 rule is switched on.</p>
        ) : (
          <ul className="list-disc space-y-0.5 pl-5">
            {rules.map((r) => (
              <li key={r.id}>
                {r.untilMinutes === null
                  ? "Any later punch-out"
                  : `Last punch-out up to ${formatUntil(r.untilMinutes)}`}
                : {fmtShifts(r.shifts)} {r.shifts === 1 ? "shift" : "shifts"}
              </li>
            ))}
          </ul>
        )}
        <SettingsLink setting="shift-ladder" />
      </div>
    </details>
  );
}
