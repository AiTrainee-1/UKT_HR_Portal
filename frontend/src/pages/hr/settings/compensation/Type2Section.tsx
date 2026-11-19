import { Moon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { QuarterRuleHistoryEntry } from "@/lib/api-client/custom-hooks";
import { RuleHistory, type RuleHistoryLine } from "../kit/RuleHistory";
import { SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { ToggleField } from "../kit/Field";
import { parseNumber } from "../payroll/form";
import { COMPENSATION_SECTIONS, compensationText } from "../CompensationTab.meta";
import { QuarterExample, Type2Example } from "./Examples";
import { LadderTable } from "./LadderTable";
import { prettyDate, THRESHOLD } from "./form";
import { formatDuration } from "./time";
import { masterOffNote, notes, Problem, type SectionProps } from "./ui";
import { otPath } from "@/pages/hr/compensation/routes";

const block = (id: string) => ({ id, ...compensationText(id) });

/** The quarters rule's dated history in words, oldest first. */
export function quarterHistoryLines(history: QuarterRuleHistoryEntry[]): RuleHistoryLine[] {
  return history.map((entry) => ({
    when: entry.from ? `From ${prettyDate(entry.from)}` : "From the claims date",
    what: entry.on ? "on (the credit in quarters of the shift)" : "off (the last punch-out table)",
  }));
}

/**
 * OT Detection - Type 2: shift-based compensation (0.25 / 0.50 / 0.75 / 1 shift). From the claims date the credit is worked
 * out in quarters of the employee's own working shift (the quarters rule), claimed by the employee or HR and approved by the
 * Department Head into the compensation balance; HR may still pay a record. Days before the claims date keep the ladder and
 * HR's Relaxation or Payment.
 */
export function Type2Section(props: SectionProps) {
  const { draft, patch, readOnly, masterOn, validation, claimsFrom, quarterRuleHistory = [] } = props;
  const threshold = parseNumber(draft.shiftMinExtra, THRESHOLD).value;
  const fromText = claimsFrom ? prettyDate(claimsFrom) : "the claims date";
  const quarters = draft.quarterRule === true;

  return (
    <SettingsSection
      id="compensation-type2"
      icon={Moon}
      title={COMPENSATION_SECTIONS.type2}
      purpose="For staff who work past their shift end. From the claims date, with the quarters rule on, a day is Type 2 once its overtime reaches a quarter of the employee's own working shift (less is the Type 1 allowance); before that date, or with the quarters rule off, it needs more than the threshold (2 hours 30 by default). Not automatic: the days are listed on Compensation, OT Detection with their credit. From the claims date the employee or HR claims it and the Department Head approves it into the compensation balance (to use on another day), or HR pays it; earlier days are assigned by HR as Relaxation or Payment. Staff only."
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
            what: "lists each day that qualifies with its credit, to claim for the employee, pay or reject",
            to: otPath("type-2"),
          },
          {
            where: "Approvals",
            what: "a claim goes to the employee's Department Head; once approved the shifts are added to the compensation balance",
          },
          {
            where: "Staff Payroll",
            what: "only a day HR paid adds pay; nothing is added by detection alone, and a credited day is never paid",
            to: "/hr/payroll",
          },
          {
            where: "Employee apps",
            what: "the employee sees the day, claims it, and later uses the balance on another day",
          },
        ]}
        note={notes(
          "Nothing is given until a claim is approved or HR pays it. One day is paid or credited, never both.",
          masterOffNote(masterOn),
        )}
        preview={quarters ? undefined : <Type2Example draft={draft} />}
      >
        <ToggleField
          id="compensation-shift-switch"
          checked={draft.shiftEnabled}
          onChange={(v) => patch({ shiftEnabled: v })}
          onLabel="Type 2 is on"
          offLabel="Type 2 is off"
          disabled={readOnly}
        >
          Not automatic: claimed and approved, or paid by HR.
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
            what: `for days before ${fromText}, and while the quarters rule is off: a day is listed when the last punch-out is more than this many minutes after the employee's own shift end`,
            to: otPath("type-2"),
          },
          {
            where: "Type 1 allowance",
            what: "covers the extra work up to this where this decides; under the quarters rule it covers less than a quarter of the shift",
          },
        ]}
        note={
          quarters
            ? `The quarters rule is on, so this threshold decides only days before ${fromText}: from then a day is Type 2 once its overtime reaches a quarter of the employee's shift (2 hours of an 8-hour shift), and the Type 1 allowance covers less than that.`
            : undefined
        }
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
        {...block("shift-quarter-rule")}
        labelFor="compensation-quarter-switch"
        defaultText="On"
        affects={[
          {
            where: "Compensation - OT Detection",
            what: "each day's credit is its overtime in quarters of the employee's own working shift (end - start - lunch), rounded down, at most 1.00",
            to: otPath("type-2"),
          },
          {
            where: "Employee apps and Approvals",
            what: "a claim starts at that credit; the Department Head sees the shifts asked for",
          },
        ]}
        note={notes(
          `Applies to days from ${fromText}. Below a quarter of the shift there is no Type 2 credit (the day may still earn the Type 1 allowance). Off: the last punch-out table below suggests the shifts instead.`,
          draft.quarterRule === null
            ? "This server does not report the quarters rule yet, so it cannot be changed here."
            : null,
        )}
        preview={<QuarterExample draft={draft} />}
      >
        <ToggleField
          id="compensation-quarter-switch"
          checked={quarters}
          onChange={(v) => patch({ quarterRule: v })}
          onLabel="The credit is counted in quarters of the shift"
          offLabel="The credit comes from the last punch-out table"
          disabled={readOnly || draft.quarterRule === null}
        >
          The overtime divided by the employee&apos;s own working shift, rounded down to 0.25, 0.50, 0.75 or 1.00.
        </ToggleField>
        <RuleHistory lines={quarterHistoryLines(quarterRuleHistory)} testId="quarter-rule-history" />
      </SettingBlock>

      <SettingBlock
        {...block("shift-relaxation")}
        labelFor="compensation-relaxation-switch"
        defaultText="On"
        affects={[
          {
            where: "Compensation - OT Detection",
            what: `HR can choose Relaxation only for a day before ${fromText}, and only while this is on; from then a claim credits the balance instead`,
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
            what: "each listed day's suggested shifts come from this table for days before the claims date, and from then only while the quarters rule is off; HR may choose another of the four amounts",
            to: otPath("type-2", "how"),
          },
        ]}
        note={notes(
          "The time is the day's last punch-out, counted from the start of the day the shift began: a punch-out after midnight is written with 'next day'. The last rule that is on has no upper limit, so every later punch-out earns a shift.",
          quarters ? `The quarters rule is on, so this table is used only for days before ${fromText}.` : null,
        )}
        preview={quarters ? <Type2Example draft={draft} /> : undefined}
      >
        <LadderTable {...props} />
      </SettingBlock>
    </SettingsSection>
  );
}
