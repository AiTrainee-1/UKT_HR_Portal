import { Power } from "lucide-react";
import { cn } from "@/lib/utils";
import { SettingLink } from "../attendance/SettingLink";

/**
 * The top of the tab: whether the master switch (Settings -> Payroll -> OT / Compensation) is on, and that everything
 * here is for staff only. It is a read-only strip: the master switch has one home, on the Payroll tab. While it is off
 * every setting below can still be edited and saved, but none of it acts.
 */
export function MasterStrip({ masterOn }: { masterOn: boolean }) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-start gap-x-4 gap-y-2 rounded-xl border px-4 py-3",
        masterOn ? "border-slate-200 bg-white" : "border-amber-200 bg-amber-50",
      )}
      data-testid="compensation-master-strip"
      data-state={masterOn ? "on" : "off"}
    >
      <span
        className={cn(
          "mt-0.5 rounded-lg p-2",
          masterOn ? "bg-emerald-50 text-emerald-700" : "bg-amber-100 text-amber-800",
        )}
      >
        <Power size={16} />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-semibold text-slate-900" data-testid="compensation-master-status">
          OT and Compensation features are {masterOn ? "ON" : "OFF"}
        </p>
        <p className="text-[13px] leading-snug text-slate-600">
          {masterOn
            ? "This master switch sits above every feature on this tab: a feature acts only while its own switch and this one are both on. "
            : "Everything below can still be edited and saved, but none of it acts - nothing is detected, allowed, announced or paid - until the master switch is turned on. "}
          Change it in{" "}
          <SettingLink tab="payroll" setting="compensation-features" testId="link-master-switch">
            Settings, Payroll, OT / Compensation
          </SettingLink>
          .
        </p>
      </div>
      <span
        className="settings-chip self-center px-2.5 py-1 text-[11px] font-semibold text-slate-700"
        data-testid="compensation-staff-only"
        title="Production workers are never affected by anything on this tab."
      >
        Staff employees only
      </span>
    </div>
  );
}
