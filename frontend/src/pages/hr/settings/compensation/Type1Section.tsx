import { Clock } from "lucide-react";
import { SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { ToggleField } from "../kit/Field";
import { COMPENSATION_SECTIONS, compensationText } from "../CompensationTab.meta";
import { AllowanceTable } from "./AllowanceTable";
import { Type1Example } from "./Examples";
import { warningsFor } from "./form";
import { FromDate, masterOffNote, notes, type SectionProps } from "./ui";

const block = (id: string) => ({ id, ...compensationText(id) });

/** OT Detection - Type 1: the automatic next-day late-in allowance (never paid, nothing to claim). */
export function Type1Section(props: SectionProps) {
  const { draft, patch, readOnly, masterOn, validation, today } = props;
  const warnings = warningsFor(draft);
  return (
    <SettingsSection
      id="compensation-type1"
      icon={Clock}
      title={COMPENSATION_SECTIONS.type1}
      purpose="Automatic and never paid. Staff who work extra hours after their shift end get an allowance for their first punch the next working day: if they arrive late inside it, it is not marked Late, it is marked Compensation instead. Nothing to claim and nothing for HR to assign. Staff only."
      usedBy={[
        { label: "Staff Attendance", to: "/hr/attendance/staff" },
        { label: "Compensation", to: "/hr/compensation" },
        { label: "Employee apps" },
      ]}
      testId="compensation-type1"
    >
      <SettingBlock
        {...block("allowance-enabled")}
        labelFor="compensation-allowance-switch"
        defaultText="Off"
        affects={[
          {
            where: "Staff Attendance",
            what: "a first punch inside the allowance is not marked Late and is not cut by the quarter-shift rule; the day is marked Compensation so HR can see it was used",
            to: "/hr/attendance/staff",
          },
          {
            where: "Staff Payroll",
            what: "no pay is added; the Late mark that is no longer made no longer counts towards the late deduction",
            to: "/hr/payroll",
          },
          {
            where: "Compensation - History & Reports",
            what: "lists who got the allowance and who used it",
            to: "/hr/compensation",
          },
          {
            where: "Employee apps",
            what: "the attendance calendar shows the Compensation marker on a day that used it",
          },
        ]}
        note={notes(
          "Applies from the date below and only to staff; production workers are never affected.",
          masterOffNote(masterOn),
        )}
        preview={<Type1Example draft={draft} />}
      >
        <ToggleField
          id="compensation-allowance-switch"
          checked={draft.allowanceEnabled}
          onChange={(v) => patch({ allowanceEnabled: v })}
          onLabel="Type 1 allowance is on"
          offLabel="Type 1 allowance is off"
          disabled={readOnly}
        >
          Automatic: the employee does not claim it and may or may not use it. It is never paid.
        </ToggleField>
      </SettingBlock>

      <SettingBlock
        {...block("allowance-effective-from")}
        labelFor="compensation-allowance-from"
        defaultText="Today, whenever Type 1 is switched on"
        affects={[
          {
            where: "Staff Attendance",
            what: "days before this date are judged exactly as before, even when their month is opened or generated again",
            to: "/hr/attendance/staff",
          },
          {
            where: "Staff Payroll",
            what: "payslips already generated are never rewritten by this switch",
            to: "/hr/payroll",
          },
        ]}
      >
        <FromDate
          id="compensation-allowance-from"
          testId="allowance-from"
          value={draft.allowanceFrom}
          onChange={(v) => patch({ allowanceFrom: v })}
          error={validation.allowanceFrom}
          today={today}
          readOnly={readOnly}
          blankText="Not set yet: switching Type 1 on sets it to today."
        />
      </SettingBlock>

      <SettingBlock
        {...block("allowance-rules")}
        defaultText="1 hour: 30 min, 1 hour 30 minutes: 30 min, 2 hours: 60 min, 2 hours 30 minutes: 60 min"
        affects={[
          {
            where: "Staff Attendance",
            what: "the next morning's first-punch limit moves later by the allowance of the row the day reached; the shift's own grace still applies on top",
            to: "/hr/attendance/staff",
          },
          {
            where: "Compensation - OT Detection",
            what: "lists each day with the allowance it earned",
            to: "/hr/compensation",
          },
        ]}
        note={notes(
          "Switching a row off keeps it in the table without using it. The allowance applies to the next working day's first punch only, and only up to where Type 2 starts: more extra work than that is Type 2's.",
          ...warnings.map((w) => (
            <span key={w} data-testid="allowance-warning">
              {w}
            </span>
          )),
        )}
      >
        <AllowanceTable {...props} />
      </SettingBlock>
    </SettingsSection>
  );
}
