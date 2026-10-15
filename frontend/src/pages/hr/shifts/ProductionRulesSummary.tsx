import { Link } from "wouter";
import { ArrowUpRight, Timer } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useProductionShiftRules, type ProductionShiftGroup } from "@/lib/api-client/custom-hooks";
import { prettyDate } from "@/pages/hr/settings/compensation/form";
import { clock12, pointText } from "@/pages/hr/settings/production-shifts/time";

const SETTINGS_PATH = "/hr/settings?tab=production_shifts";

/** "8 rows, up to 3.00 shifts" for one group: how many rows are on and what the top of the ladder earns. */
function ladderLine(group: ProductionShiftGroup): string {
  const on = group.rules.filter((r) => r.enabled);
  if (on.length === 0) return "no rows are on";
  const top = on.reduce((best, r) => (Number(r.shiftValue) >= Number(best.shiftValue) ? r : best));
  const most = Number(top.shiftValue);
  return `${on.length} ${on.length === 1 ? "row" : "rows"}, up to ${most.toFixed(2)} ${most === 1 ? "shift" : "shifts"}`;
}

/**
 * What Manage Shifts shows for the Production type now that production shifts are worked out by the rules on Settings ->
 * Production Shifts: a short read-only summary and a link there. The punch times and segments this page used to edit are the
 * OLD calculation, kept for the days before the rules start and no longer edited anywhere.
 */
export default function ProductionRulesSummary() {
  const { data, isLoading, isError } = useProductionShiftRules();

  return (
    <Card className="border-0 shadow-sm" data-testid="production-rules-summary">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-bold">
          <Timer size={15} /> Production shift rules
        </CardTitle>
        <Link
          href={SETTINGS_PATH}
          className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 hover:text-slate-900"
          data-testid="production-rules-edit-link"
        >
          Edit in Settings <ArrowUpRight size={13} />
        </Link>
      </CardHeader>
      <CardContent className="space-y-2 text-[13px] leading-relaxed text-slate-600">
        {isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : isError || !data ? (
          <p data-testid="production-rules-summary-error">
            The production shift rules could not be loaded here. They are edited on Settings, Production Shifts.
          </p>
        ) : (
          <>
            <p data-testid="production-rules-summary-status">
              <b className="text-slate-800">
                {data.enabled !== false
                  ? data.effectiveFrom
                    ? `On from ${prettyDate(data.effectiveFrom)}.`
                    : "On."
                  : "Off: every production day uses the old calculation."}
              </b>{" "}
              Shifts earned come from these rules, not from this page: grace {data.graceMinutes} minutes.
              {data.enabled !== false && data.effectiveFrom ? " Earlier days keep the old calculation." : ""}
            </p>
            {data.groups.length > 0 && (
              <ul className="list-disc space-y-0.5 pl-5" data-testid="production-rules-summary-groups">
                {data.groups.map((g) => (
                  <li key={g.id}>
                    <b className="text-slate-800">{g.label}</b>
                    {g.enabled ? "" : " (off)"}: starts {clock12(g.startTime)}
                    {g.mainOutTime ? `, standard departure ${pointText(g.mainOutTime, g.mainOutNextDay)}` : ""};{" "}
                    {ladderLine(g)}.
                  </li>
                ))}
              </ul>
            )}
            <p data-testid="production-rules-summary-breaks">
              {data.breaks.filter((b) => b.enabled).length === 0
                ? "No unpaid breaks."
                : `Unpaid breaks: ${data.breaks
                    .filter((b) => b.enabled)
                    .map((b) => `${b.label} ${clock12(b.startTime)} to ${clock12(b.endTime)}`)
                    .join(", ")}.`}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
