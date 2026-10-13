import { AlertTriangle, Settings as SettingsIcon, Users } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { PAY_CYCLE_INFO, type PayCycle } from "@/lib/api-client/custom-hooks";
import { unassignedNotice } from "./logic";

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
      className="rounded-xl border-2 border-dashed border-amber-300 bg-amber-50/70 p-8 text-center"
      data-testid="pcp-setup-needed"
    >
      <AlertTriangle size={30} className="mx-auto mb-3 text-amber-600" />
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
      className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-900"
      data-testid="pcp-unassigned-notice"
    >
      <Users size={14} className="shrink-0 text-amber-600" />
      <span className="min-w-0 flex-1 basis-56">{text}</span>
      <Link href="/hr/employees/productionEmployee" className="font-semibold text-amber-800 underline">
        Assign them on Production Employees
      </Link>
    </div>
  );
}
