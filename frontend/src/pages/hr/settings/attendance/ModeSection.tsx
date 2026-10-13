import { Clock } from "lucide-react";
import { clock } from "@/lib/arrival-rules";
import { cn } from "@/lib/utils";
import { PreviewCard, PreviewLine, SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { capitalise, describeShift, type ExampleShift } from "./example";
import type { StaffDraft } from "./form";
import { lunchReturn } from "./preview";

const MODES = [
  {
    value: "strict" as const,
    title: "Strict mode (4 punches)",
    text: "Also looks for the lunch-out and lunch-return punches and flags a late return from lunch. The flag is information only.",
  },
  {
    value: "simple" as const,
    title: "Simple mode (first and last punch)",
    text: "Uses only the first and the last punch of the day. Nothing about lunch is recorded.",
  },
];

/** Strict or Simple: the only difference is whether the lunch return is checked (pay is the same in both). */
export function ModeSection({
  draft,
  patch,
  loaded,
  shift,
  nightLateWindow,
  lunchZone,
}: {
  draft: StaffDraft;
  patch: (p: Partial<StaffDraft>) => void;
  loaded: boolean;
  shift: ExampleShift | null;
  nightLateWindow: number;
  lunchZone: number;
}) {
  const strict = draft.attendanceMode === "strict";
  const lunchOut = shift ? shift.lunchStart - 20 : 0;
  const back = shift ? lunchOut + shift.lunchMinutes + 10 : 0;
  const lunch = shift ? lunchReturn(lunchOut, back, shift.lunchMinutes, nightLateWindow, lunchZone) : null;
  const lunchFlag =
    lunch?.verdict === "night_late"
      ? "Late after lunch"
      : lunch?.verdict === "lunch_permission"
        ? "Lunch-return permission"
        : "no flag";

  return (
    <SettingsSection
      id="attendance-mode-section"
      icon={Clock}
      title="Attendance Calculation Mode"
      purpose="Staff only. Production workers are judged by their shift segments whatever is chosen here."
      usedBy={[
        { label: "Staff Attendance", to: "/hr/attendance/staff" },
        { label: "Report Log", to: "/hr/attendance/report-log" },
      ]}
      testId="attendance-mode-section"
    >
      <SettingBlock
        id="attendance-mode"
        title="Strict or Simple mode"
        purpose="Chooses whether a staff day also records how late someone came back from lunch. Full Day, Half Day or Absent, Late, Early Out and pay are worked out the same way in both modes."
        affects={[
          {
            where: "Staff Attendance",
            what: "Strict adds the 'Late after lunch' and 'Lunch-return permission' flags; the Report Log and Attendance Search show a Strict / Simple badge per day",
            to: "/hr/attendance/staff",
          },
          {
            where: "WhatsApp missing-punch alert",
            what: "in Strict it also chases the lunch-out and lunch-return punches; in Simple only the first and last",
            to: "/hr/whatsapp-control",
          },
          {
            where: "Staff Payroll",
            what: "only in Strict does generating payroll refresh the monthly shift summary behind the employee apps' My Shift screen; the payslip breakdown records the mode",
            to: "/hr/payroll",
          },
          { where: "Reports", what: "the late analysis adds a 'Night late' column in Strict", to: "/hr/reports" },
        ]}
        defaultText="Strict"
        note="Switching re-judges past days too: lunch flags appear or disappear on past months the next time they are opened. Pay does not change."
        preview={
          <PreviewCard
            title="Example"
            scenario={
              shift
                ? `${capitalise(describeShift(shift))}: in ${clock(shift.start + 5)}, out for lunch ${clock(lunchOut)}, back ${clock(back)}, out ${clock(shift.end + 5)}.`
                : undefined
            }
          >
            {shift && lunch ? (
              <>
                <PreviewLine label="Both modes" result="Full Day, not Late, 1.00 shift" tone="good" />
                <PreviewLine
                  label={`Strict also checks the lunch (due back ${clock(lunch.deadline)})`}
                  result={lunch.verdict === "on_time" ? "no flag" : `${lunchFlag}, ${lunch.minutesOver} min over`}
                  tone={strict ? "warn" : "neutral"}
                />
                <PreviewLine label="Simple" result="no lunch flag" tone={strict ? "neutral" : "info"} />
              </>
            ) : (
              <p className="text-[12px] text-gray-500">Enter a valid example shift to see it.</p>
            )}
          </PreviewCard>
        }
      >
        <div role="radiogroup" aria-label="Attendance calculation mode" className="grid gap-2 sm:grid-cols-2">
          {MODES.map((m) => {
            const active = draft.attendanceMode === m.value;
            return (
              <button
                key={m.value}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={!loaded}
                onClick={() => patch({ attendanceMode: m.value })}
                data-testid={`attendance-mode-${m.value}`}
                className={cn(
                  "rounded-2xl border-2 p-3 text-left transition-all disabled:cursor-not-allowed disabled:opacity-60",
                  active
                    ? "settings-clay !border-blue-400"
                    : "settings-glass !border-transparent hover:!border-blue-200",
                )}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="text-sm font-bold text-gray-900">{m.title}</span>
                  {active && (
                    <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-bold text-blue-700">
                      Selected
                    </span>
                  )}
                </span>
                <span className="mt-1 block text-xs leading-relaxed text-gray-500">{m.text}</span>
              </button>
            );
          })}
        </div>
      </SettingBlock>
    </SettingsSection>
  );
}
