import { Factory } from "lucide-react";
import { clock, minutesOf } from "@/lib/arrival-rules";
import { useProductionShiftConfig } from "@/lib/api-client/custom-hooks";
import { ManagedElsewhere, PreviewCard, PreviewLine, SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { rupees } from "./example";
import { productionDay } from "./preview";

/** The production example's rate (the Payroll tabs use the same made-up ₹600 per shift). */
const PER_SHIFT = 600;
const EXAMPLES = [
  ["08:35", "12:50", "13:35", "17:35"],
  ["08:35", "12:50", "13:35", "19:55"],
];

/**
 * Production attendance is not set on this tab: the punch times and pay segments are edited with the production shift
 * in Manage Shift (the very editor this tab used to repeat). What is left here is what they mean, read-only.
 */
export function ProductionSection() {
  const { data: config, isLoading, isError } = useProductionShiftConfig();
  const segments = config?.segments ?? [];
  const active = segments.filter((s) => s.isActive);
  const total = active.reduce((sum, s) => sum + s.shiftValue, 0);

  return (
    <SettingsSection
      id="attendance-production"
      icon={Factory}
      title="Production workers"
      purpose="Nothing above applies to production workers: a production day earns the shift-value segments its punches cover, whatever mode is chosen. (Production Payroll has a Strict / Simple setting of its own, used only by its late check.)"
      usedBy={[
        { label: "Production Attendance", to: "/hr/attendance/production" },
        { label: "Production Payroll", to: "/hr/production-payroll" },
      ]}
      testId="attendance-production"
    >
      <SettingBlock
        id="production-attendance"
        title="Production punch times and pay segments"
        purpose="Each segment is a stretch of the day worth part of a shift. A worker earns a segment when they arrive by its start plus the grace and leave no earlier than its end minus the grace; pay is the shifts earned times the worker's salary per shift."
        affects={[
          {
            where: "Production Attendance",
            what: "shifts earned per day, and the Late / Early Out flags",
            to: "/hr/attendance/production",
          },
          {
            where: "Production Payroll",
            what: "pay = total shifts earned x salary per shift",
            to: "/hr/production-payroll",
          },
        ]}
        note="Punch 2 and Punch 3 are stored but nothing reads them. Punch 1 and Punch 4 only raise Late and Early Out flags (no pay effect). The grace decides which segments are earned; 0 behaves as 10. A change re-judges past days when they are next opened; production payroll already generated stays until it is generated again."
        preview={
          <PreviewCard
            title="The saved setup and two example days"
            scenario={`Read-only: what is saved now, worked out for a worker paid ${rupees(PER_SHIFT)} per shift.`}
          >
            {isLoading ? (
              <p className="text-[12px] text-gray-500">Loading the production setup…</p>
            ) : isError || !config ? (
              <p className="text-[12px] text-gray-500">
                The production setup could not be loaded here: open Manage Shift.
              </p>
            ) : (
              <>
                <PreviewLine
                  label="Punch 1 / Punch 4 / grace"
                  result={`${config.punch1Time} / ${config.punch4Time} / ${config.graceMinutes} min`}
                  tone="neutral"
                />
                <div
                  className="settings-line overflow-x-auto rounded-xl border bg-white"
                  data-testid="production-segments"
                >
                  <table className="w-full text-[12px]">
                    <tbody>
                      {segments.map((s) => (
                        <tr key={s.id} className="border-t border-slate-50 first:border-t-0">
                          <td className="px-2.5 py-1 font-medium text-gray-800">{s.label}</td>
                          <td className="whitespace-nowrap px-2.5 py-1 font-mono text-gray-600">
                            {s.startTime} - {s.endTime}
                          </td>
                          <td className="whitespace-nowrap px-2.5 py-1 text-right font-semibold text-gray-800">
                            {s.shiftValue.toFixed(2)} shift
                          </td>
                          <td className="px-2.5 py-1 text-right text-[10px] font-bold">
                            {s.isActive ? (
                              <span className="text-emerald-600">counted</span>
                            ) : (
                              <span className="text-red-500">switched off</span>
                            )}
                          </td>
                        </tr>
                      ))}
                      {segments.length === 0 && (
                        <tr>
                          <td className="px-2.5 py-2 text-gray-500">
                            No segments: every day with punches earns 0.25 shift.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <PreviewLine
                  label="A full day of every counted segment"
                  result={`${total.toFixed(2)} shift`}
                  tone="info"
                />
                {EXAMPLES.map((times) => {
                  const day = productionDay(
                    times.map((t) => minutesOf(t) ?? 0),
                    segments,
                    config.graceMinutes,
                    config.punch1Time,
                    config.punch4Time,
                  );
                  return (
                    <PreviewLine
                      key={times.join("-")}
                      label={`Punches ${times.join(", ")}`}
                      result={`${day.shifts.toFixed(2)} shift = ${rupees(day.shifts * PER_SHIFT)}${day.late ? ", Late flag" : ""}${day.earlyOut ? ", Early Out flag" : ""}`}
                      tone={day.half ? "warn" : "good"}
                    />
                  );
                })}
                <p className="text-[11px] text-gray-500">
                  Late flag after {clock((minutesOf(config.punch1Time) ?? 0) + (config.graceMinutes || 10))}, Early Out
                  flag before {clock((minutesOf(config.punch4Time) ?? 0) - (config.graceMinutes || 10))}.
                </p>
              </>
            )}
          </PreviewCard>
        }
      >
        <ManagedElsewhere
          title="Edited in Manage Shift"
          to="/hr/shifts"
          linkLabel="Open Manage Shift"
          testId="production-managed-elsewhere"
        >
          Open Manage Shift and pick Production on the Shifts tab: the punch times, the grace and the segments are
          edited there (the same editor this tab used to show). Saving there needs edit access to Settings - Attendance.
        </ManagedElsewhere>
      </SettingBlock>

      <SettingBlock
        id="production-late"
        title="Production late deductions"
        purpose="What a late production arrival costs is set on Settings - Production Payroll (Late Detection). It is judged from the production shift's own start and grace in Manage Shift, not from Punch 1 above, and it has its own free allowance and slabs."
        affects={[
          {
            where: "Production Payroll",
            what: "late deductions per pay period",
            to: "/hr/production-payroll",
          },
        ]}
      >
        <ManagedElsewhere
          title="Production late rules"
          to="/hr/settings?tab=production_payroll"
          linkLabel="Open Production Payroll settings"
          testId="production-late-elsewhere"
        >
          The staff late rules (this tab and Late Detection) never apply to production workers.
        </ManagedElsewhere>
      </SettingBlock>
    </SettingsSection>
  );
}
