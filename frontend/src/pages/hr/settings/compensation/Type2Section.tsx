import { Moon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { ToggleField } from "../kit/Field";
import { parseNumber } from "../payroll/form";
import { COMPENSATION_SECTIONS, compensationText } from "../CompensationTab.meta";
import { Type2Example } from "./Examples";
import { LadderTable } from "./LadderTable";
import { THRESHOLD } from "./form";
import { formatDuration } from "./time";
import { masterOffNote, notes, Problem, type SectionProps } from "./ui";
import { otPath } from "@/pages/hr/compensation/routes";

const block = (id: string) => ({ id, ...compensationText(id) });

/** OT Detection - Type 2: shift-based compensation (0.25 / 0.50 / 0.75 / 1 shift) that HR assigns as Relaxation or Payment. */
export function Type2Section(props: SectionProps) {
  const { draft, patch, readOnly, masterOn, validation } = props;
  const threshold = parseNumber(draft.shiftMinExtra, THRESHOLD).value;

  return (
    <SettingsSection
      id="compensation-type2"
      icon={Moon}
      title={COMPENSATION_SECTIONS.type2}
      purpose="For staff who work more than the threshold past their shift end (2 hours 30 by default). Not automatic: the days are listed on Compensation, OT Detection, with the shifts the table below suggests, and HR assigns them as Relaxation (an alternative day) or as Payment, for a date of the same month. Staff only."
      usedBy={[
        { label: "Compensation", to: otPath("type-2") },
        { label: "Staff Payroll", to: "/hr/payroll" },
        { label: "Staff Attendance", to: "/hr/attendance/staff" },
      ]}
      testId="compensation-type2"
    >
      <SettingBlock
        {...block("shift-enabled")}
        labelFor="compensation-shift-switch"
        defaultText="Off"
        affects={[
          {
            where: "Compensation - OT Detection",
            what: "lists each day that qualifies with its suggested shifts, for HR to assign or reject",
            to: otPath("type-2"),
          },
          {
            where: "Staff Payroll",
            what: "only a day HR assigned as Payment adds pay; nothing is added by detection alone",
            to: "/hr/payroll",
          },
          {
            where: "Staff Attendance",
            what: "a day HR assigned as Relaxation is topped up and marked Compensation",
            to: "/hr/attendance/staff",
          },
        ]}
        note={notes("Nothing is given until HR assigns it.", masterOffNote(masterOn))}
        preview={<Type2Example draft={draft} />}
      >
        <ToggleField
          id="compensation-shift-switch"
          checked={draft.shiftEnabled}
          onChange={(v) => patch({ shiftEnabled: v })}
          onLabel="Type 2 is on"
          offLabel="Type 2 is off"
          disabled={readOnly}
        >
          Not automatic: HR assigns each one.
        </ToggleField>
        {validation.shiftMode && <Problem testId="shift-mode-error">{validation.shiftMode}</Problem>}
      </SettingBlock>

      <SettingBlock
        {...block("shift-threshold")}
        labelFor="compensation-shift-threshold"
        defaultText="150 minutes (2 hours 30)"
        affects={[
          {
            where: "Compensation - OT Detection",
            what: "a day is listed when the last punch-out is more than this many minutes after the employee's own shift end",
            to: otPath("type-2"),
          },
          {
            where: "Type 1 allowance",
            what: "covers the extra work up to this; Type 2 takes over beyond it",
          },
        ]}
      >
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="compensation-shift-threshold"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={draft.shiftMinExtra}
              disabled={readOnly}
              aria-invalid={validation.threshold ? true : undefined}
              onChange={(e) => patch({ shiftMinExtra: e.target.value })}
              className={cn("w-28 tabular-nums", validation.threshold && "border-red-400")}
            />
            <span className="text-xs font-semibold text-gray-500">minutes after the shift end</span>
            {threshold !== null && <span className="text-xs text-gray-500">= {formatDuration(threshold)}</span>}
          </div>
          {validation.threshold && <Problem testId="shift-threshold-error">{validation.threshold}</Problem>}
          <p className="text-xs text-gray-500">
            More than this, not exactly this: a day that ends exactly on the threshold is still Type 1.
          </p>
        </div>
      </SettingBlock>

      <SettingBlock
        {...block("shift-relaxation")}
        labelFor="compensation-relaxation-switch"
        defaultText="On"
        affects={[
          {
            where: "Compensation - OT Detection",
            what: "HR can choose Relaxation for a day only while this is on",
            to: otPath("type-2"),
          },
          {
            where: "Staff Attendance",
            what: "the date HR picks is topped up by the assigned shifts and marked Compensation, so HR can see it was used",
            to: "/hr/attendance/staff",
          },
          { where: "Employee apps", what: "the attendance calendar and the Compensation page show the relaxation day" },
        ]}
        note={notes(
          "Relaxation and Payment can be on together (HR chooses each time), or one of them alone.",
          masterOffNote(masterOn),
        )}
      >
        <ToggleField
          id="compensation-relaxation-switch"
          checked={draft.relaxationEnabled}
          onChange={(v) => patch({ relaxationEnabled: v })}
          onLabel="Relaxation can be given"
          offLabel="Relaxation is not offered"
          disabled={readOnly}
        >
          An alternative day for the extra work.
        </ToggleField>
      </SettingBlock>

      <SettingBlock
        {...block("shift-pay")}
        labelFor="compensation-pay-switch"
        defaultText="Off"
        affects={[
          {
            where: "Compensation - OT Detection",
            what: "HR can choose Payment for a day only while this is on",
            to: otPath("type-2"),
          },
          {
            where: "Staff Payroll",
            what: "that month's payroll adds the shifts times the employee's daily rate, the next time it is generated",
            to: "/hr/payroll",
          },
        ]}
        note={notes(
          "Changes pay. A payslip already generated keeps its amount until that month's payroll is generated again.",
          "Payment applies to Type 2 only: the Type 1 allowance is never paid.",
          masterOffNote(masterOn),
        )}
      >
        <ToggleField
          id="compensation-pay-switch"
          checked={draft.payEnabled}
          onChange={(v) => patch({ payEnabled: v })}
          onLabel="Payment can be given"
          offLabel="Payment is not offered"
          disabled={readOnly}
        >
          Money for the extra work: shifts x one day's pay.
        </ToggleField>
      </SettingBlock>

      <SettingBlock
        {...block("shift-ladder")}
        defaultText="before 9:00 PM: 0.25, before 12:00 AM: 0.50, before 2:00 AM next day: 0.75, no limit: 1.00"
        affects={[
          {
            where: "Compensation - OT Detection",
            what: "each listed day's suggested shifts come from this table; HR may choose another of the four amounts when assigning",
            to: otPath("type-2", "how"),
          },
        ]}
        note="The time is the day's last punch-out, counted from the start of the day the shift began: a punch-out after midnight is written with 'next day'. The last rule that is on has no upper limit, so every later punch-out earns a shift."
      >
        <LadderTable {...props} />
      </SettingBlock>
    </SettingsSection>
  );
}
