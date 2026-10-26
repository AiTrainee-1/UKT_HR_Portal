import { CalendarClock } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ToggleField } from "../kit/Field";
import { PreviewCard, PreviewLine, SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { PRODUCTION_SHIFT_SECTIONS, productionShiftText } from "../ProductionShiftsTab.meta";
import { prettyDate } from "../compensation/form";
import { graceExample } from "./examples";
import { Problem, FromDate, type SectionProps } from "./ui";

const block = (id: string) => ({ id, ...productionShiftText(id) });

/**
 * "When the production rules apply": the master switch, the day they start from (every earlier day keeps the old
 * calculation) and the grace. The grace has its own example, worked out from the box. `legacy` is what the old calculation
 * used, in a line ("" when the server sent nothing).
 */
export function WhenSection({ draft, patch, readOnly, validation, today, legacy }: SectionProps & { legacy: string }) {
  const example = graceExample(draft);
  const from = draft.effectiveFrom;
  return (
    <SettingsSection
      id="production-shifts-when"
      icon={CalendarClock}
      title={PRODUCTION_SHIFT_SECTIONS.when}
      purpose="For production employees only. The switch says whether the rules are used at all, the date says from which day, and the grace says how many minutes of early or late are forgiven."
      usedBy={[
        { label: "Production Attendance", to: "/hr/attendance/production" },
        { label: "Production Payroll", to: "/hr/production-payroll" },
        { label: "HR Reports", to: "/hr/reports" },
      ]}
      testId="production-shifts-when"
    >
      <SettingBlock
        {...block("rules-enabled")}
        labelFor="production-rules-switch"
        defaultText="On"
        affects={[
          {
            where: "Production Attendance",
            what: "the shifts each production day earns, and its Late and Left early flags",
            to: "/hr/attendance/production",
          },
          {
            where: "Production Payroll",
            what: "pay is the shifts earned times the salary per shift; a period already generated keeps its amounts until it is generated again",
            to: "/hr/production-payroll",
          },
          {
            where: "HR Reports",
            what: "Production Daily Punches shows the same shifts, and Production Shift Rules lists these rules",
            to: "/hr/reports",
          },
        ]}
        note="Switching it off sends every day from the start date back to the old calculation, which changes shifts earned (and pay once payroll is generated again). Staff employees are never affected."
      >
        <ToggleField
          id="production-rules-switch"
          checked={draft.enabled}
          onChange={(v) => patch({ enabled: v, ...(v && from.trim() === "" ? { effectiveFrom: today } : {}) })}
          onLabel="The production rules are on"
          offLabel="The production rules are off"
          disabled={readOnly}
        >
          Production employees only.
        </ToggleField>
      </SettingBlock>

      <SettingBlock
        {...block("rules-effective-from")}
        labelFor="production-rules-from"
        affects={[
          {
            where: "Production Attendance and Production Payroll",
            what: "a day before this date is worked out the old way; this day and every later one with the rules",
            to: "/hr/attendance/production",
          },
        ]}
        note="Saving a date in the past judges those days again the next time they are opened. Payslips already generated are never rewritten, but a period whose payroll is generated again will change."
        preview={
          <PreviewCard
            title="The old calculation"
            scenario={
              from
                ? `Every day before ${prettyDate(from)} is worked out the old way${legacy ? `: ${legacy}` : ""}. It is no longer edited anywhere, so what was paid stays as it was.`
                : "Every day before the start date is worked out the old way."
            }
            testId="rules-legacy"
          >
            <PreviewLine
              label={from ? `Days before ${prettyDate(from)}` : "Days before the start date"}
              result="Old calculation"
              tone="neutral"
            />
            <PreviewLine
              label={from ? `${prettyDate(from)} and later` : "The start date and later"}
              result={draft.enabled ? "These rules" : "Old calculation (the rules are off)"}
              tone={draft.enabled ? "good" : "warn"}
            />
          </PreviewCard>
        }
      >
        <FromDate
          id="production-rules-from"
          value={from}
          onChange={(v) => patch({ effectiveFrom: v })}
          error={validation.effectiveFrom}
          today={today}
          readOnly={readOnly}
        />
      </SettingBlock>

      <SettingBlock
        {...block("rules-grace")}
        labelFor="production-rules-grace"
        defaultText="5 minutes"
        affects={[
          {
            where: "Production Attendance",
            what: "a first punch within the grace after the start is not Late; a punch within it before a ladder row counts as that row",
            to: "/hr/attendance/production",
          },
          {
            where: "Production Payroll",
            what: "Late days (after the grace) feed the late deductions of Settings, Late Detection (Production page)",
            to: "/hr/production-payroll",
          },
        ]}
        preview={
          example && (
            <PreviewCard
              title="Worked example"
              scenario={`${example.group}, with ${example.grace} ${example.grace === 1 ? "minute" : "minutes"}' grace (what is typed above, not saved).`}
              testId="grace-example"
            >
              <PreviewLine
                testId="grace-on-time"
                label={`First punch at ${example.onTime}`}
                result="On time: nothing is lost"
                tone="good"
              />
              <PreviewLine
                testId="grace-late"
                label={`First punch at ${example.late}`}
                result="Late: a little of the first band is lost"
                tone="warn"
              />
              {example.snap && (
                <PreviewLine
                  testId="grace-snap"
                  label={`Leaving at ${example.snap.leaves}`}
                  result={`Counts as ${example.snap.counts}: ${example.snap.shifts} shift${example.snap.shifts === "1.00" ? "" : "s"}`}
                  tone="info"
                />
              )}
            </PreviewCard>
          )
        }
      >
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="production-rules-grace"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={draft.graceMinutes}
              disabled={readOnly}
              aria-invalid={validation.grace ? true : undefined}
              onChange={(e) => patch({ graceMinutes: e.target.value })}
              className={cn("w-28 tabular-nums", validation.grace && "border-red-400")}
            />
            <span className="text-xs font-semibold text-gray-500">minutes (0 to 30)</span>
          </div>
          {validation.grace && <Problem testId="rules-grace-error">{validation.grace}</Problem>}
          <p className="text-xs text-gray-500">
            The old calculation keeps its own grace for the days before the start date; changing this one never touches
            it.
          </p>
        </div>
      </SettingBlock>
    </SettingsSection>
  );
}
