import { Link } from "wouter";
import { AlarmClock, ArrowUpRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { usePayrollSettings } from "@/lib/api-client/custom-hooks";

const CYCLES = [
  { href: "/hr/production-payroll/weekly", label: "Weekly" },
  { href: "/hr/production-payroll/biweekly", label: "BiWeekly" },
  { href: "/hr/production-payroll/monthly", label: "Monthly" },
] as const;

/**
 * Where the staff Report Log has its Late-Penalty Breakdown, the Production Report Log says where production late
 * deductions are: they are not a monthly figure. Production payroll works them out per pay period, each cycle with its
 * own free lates and slabs (Settings -> Late Detection -> Production), and only while Production Late Detection is on; the
 * staff breakdown's own rows are written for staff alone, so a copy of it here would always be empty.
 */
export default function ProductionLateNote() {
  const { data: settings, isLoading } = usePayrollSettings();
  const on = !!settings?.prodLateDetectionEnabled;
  return (
    <Card className="rounded-2xl px-4 py-3" data-testid="production-late-note">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0 rounded-xl bg-amber-50 p-2 text-amber-600" aria-hidden>
          <AlarmClock size={16} />
        </span>
        <div className="min-w-0 space-y-1.5">
          <p className="text-sm font-bold text-amber-700">Late deductions</p>
          <p className="text-xs leading-relaxed text-gray-600" data-testid="production-late-note-text">
            {isLoading
              ? "Checking the production late rules…"
              : on
                ? "Production late deductions are worked out per pay period, each cycle with its own free lates and slabs. Open a payslip's breakdown on its payroll page to see the late days and what was deducted."
                : "Production Late Detection is off (Settings → Late Detection → Production), so production payroll deducts nothing for late arrivals. The Daily Late Report still lists who came in late."}
          </p>
          {on && (
            <div className="flex flex-wrap gap-2 pt-0.5">
              {CYCLES.map((c) => (
                <Link
                  key={c.href}
                  href={c.href}
                  className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  data-testid={`production-late-note-${c.label.toLowerCase()}`}
                >
                  {c.label} payroll <ArrowUpRight size={12} aria-hidden />
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
