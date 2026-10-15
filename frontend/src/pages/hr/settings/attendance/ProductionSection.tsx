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
 * Production attendance is not set on this tab. From the start date of the production shift rules a production day is
 * worked out by the Production Shifts tab (groups, ladders, breaks, grace). What is left here is the OLD calculation, which
 * every earlier day keeps: its punch times and pay segments, read-only and no longer edited anywhere.
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
      purpose="Nothing above applies to production workers: a production day earns the shifts worked out by the production shift rules on the Production Shifts tab, whatever mode is chosen. (Production Payroll has a Strict / Simple setting of its own, used only by its late check.)"
      usedBy={[
        { label: "Production Attendance", to: "/hr/attendance/production" },
        { label: "Production Payroll", to: "/hr/production-payroll" },
      ]}
      testId="attendance-production"
    >
      <SettingBlock
        id="production-attendance"
        title="Old production punch times and pay segments"
        purpose="Before the production shift rules start, a production day earns the segments its punches cover: a segment is earned when the worker arrives by its start plus the grace and leaves no earlier than its end minus the grace. This is the old calculation, kept read-only for those days; from the rules' start date the Production Shifts tab decides."
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
        note="Punch 2 and Punch 3 are stored but nothing reads them. Punch 1 and Punch 4 only raise Late and Early Out flags (no pay effect). The grace decides which segments are earned; 0 behaves as 10. These values are no longer edited anywhere, so what was paid with them never changes."
        preview={
          <PreviewCard
            title="The old setup and two example days"
            scenario={`Read-only: the old calculation, worked out for a worker paid ${rupees(PER_SHIFT)} per shift.`}
          >
            {isLoading ? (
              <p className="text-[12px] text-gray-500">Loading the production setup…</p>
            ) : isError || !config ? (
              <p className="text-[12px] text-gray-500">
                The old production setup could not be loaded here. It is read-only and no longer edited anywhere.
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
          title="Edited on the Production Shifts tab"
          to="/hr/settings?tab=production_shifts"
          linkLabel="Open Production Shifts"
          testId="production-managed-elsewhere"
        >
          The default timings (Day, Night and Sunday), the ladders of shifts earned, the unpaid breaks and the 5-minute
          grace are edited there, and a day from the start date is worked out with them. The numbers above are only the
          old calculation, used for the days before it.
        </ManagedElsewhere>
      </SettingBlock>

      <SettingBlock
        id="production-late"
        title="Production late deductions"
        purpose="What a late production arrival costs is set on Settings - Production Payroll (Late Detection), with its own free allowance and slabs. From the start date of the production shift rules a day is judged late from its group's start and the grace on the Production Shifts tab; before it, from the old production shift in Manage Shift, not from Punch 1 above."
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
