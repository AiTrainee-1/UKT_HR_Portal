import { Flag } from "lucide-react";
import { clock, type ArrivalSettings } from "@/lib/arrival-rules";
import { PreviewCard, PreviewLine, SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { ToggleField } from "../kit/Field";
import { describeShift, type ExampleShift } from "./example";
import type { StaffAccess, StaffDraft } from "./form";
import { PERMISSION_MINUTES, judgeStaffDay } from "./preview";
import { SettingLink } from "./SettingLink";

const NOT_REPORTED_NOTE = "Not reported by the server, so it cannot be changed here";

/** The two switches that decide which marks go into the monthly late pool (priced on Late Detection). */
export function LateMarksSection({
  draft,
  patch,
  access,
  loaded,
  shift,
  arrival,
  arrivalValid,
  secondHalfStart,
}: {
  draft: StaffDraft;
  patch: (p: Partial<StaffDraft>) => void;
  access: StaffAccess;
  loaded: boolean;
  shift: ExampleShift | null;
  arrival: ArrivalSettings;
  arrivalValid: boolean;
  secondHalfStart: number | null;
}) {
  const morningOn = draft.morningLateInEnabled === true;
  const eveningOn = draft.eveningEarlyOutEnabled === true;
  const scenario = shift ? `For the example: ${describeShift(shift)}.` : undefined;

  const examples = (() => {
    if (!shift || !arrivalValid || secondHalfStart === null) return null;
    const day = (punches: number[], opts: { morning?: boolean; eveningPermission?: boolean } = {}) =>
      judgeStaffDay({
        punches,
        shift,
        arrival,
        secondHalfStart,
        morningLateIn: opts.morning ?? morningOn,
        eveningEarlyOut: eveningOn,
        eveningPermission: opts.eveningPermission,
      });
    const lateAt = shift.start + shift.grace + 15;
    const lateDay = day([lateAt, shift.end + 5]);
    const quarterAt = lateDay.limits ? Math.min(lateDay.limits.lateUntil + 20, lateDay.limits.firstHalfUntil) : null;
    const quarterDay =
      quarterAt !== null && lateDay.limits && quarterAt > lateDay.limits.lateUntil
        ? day([quarterAt, shift.end + 5], { morning: false })
        : null;
    const leaveAt = shift.end - shift.grace - 1;
    return {
      shift,
      lateAt,
      lateDay,
      quarterAt,
      quarterDay,
      leaveAt,
      leaveEarly: day([shift.start, leaveAt]),
      permitted: day([shift.start, leaveAt], { eveningPermission: true }),
    };
  })();

  return (
    <SettingsSection
      id="attendance-late-marks"
      icon={Flag}
      title="Late and Early Out marks"
      purpose="Two company-wide switches that decide which marks go into each employee's monthly late pool. What the marks cost is set on the Late Detection tab."
      usedBy={[
        { label: "Staff Attendance", to: "/hr/attendance/staff" },
        { label: "Late Detection", to: "/hr/settings?tab=late_detection" },
        { label: "WhatsApp Control", to: "/hr/whatsapp-control" },
      ]}
      testId="attendance-late-marks"
    >
      <SettingBlock
        id="morning-late-in"
        labelFor="morning-late-in-switch"
        title="Morning Late-In"
        purpose="Turns the Late mark on or off for a first punch inside the Late window. Each Late day is one mark in the monthly late pool."
        affects={[
          { where: "Staff Attendance", what: "Late badges and Late counts", to: "/hr/attendance/staff" },
          {
            where: "Late Detection and Staff Payroll",
            what: "Late days count toward the free allowance and then the deduction slabs",
            to: "/hr/settings?tab=late_detection",
          },
          {
            where: "WhatsApp late alert",
            what: "is not sent while this is off (WhatsApp Control has its own Late alert switch, which also needs this on)",
            to: "/hr/whatsapp-control",
          },
          { where: "Reports, MD portal and employee apps", what: "hide or skip late figures while it is off" },
        ]}
        defaultText="On"
        note="Off removes only the Late mark. The arrival timeline still applies: a quarter-shift arrival still loses its quarter shift, and a first punch after the first-half limit still misses the morning half. The dashboard's 'late yesterday' count does not follow this switch."
        preview={
          <PreviewCard title="Example" scenario={scenario}>
            {examples ? (
              <>
                <PreviewLine
                  label={`First punch ${clock(examples.lateAt)}`}
                  result={examples.lateDay.late ? "Late: 1 mark in the pool, Full Day" : "not Late, no mark, Full Day"}
                  tone={examples.lateDay.late ? "warn" : "good"}
                />
                {examples.quarterDay && examples.quarterAt !== null && (
                  <PreviewLine
                    label={`First punch ${clock(examples.quarterAt)} (after the Late window)`}
                    result={`${examples.quarterDay.shifts.toFixed(2)} shift whether this is on or off`}
                    tone="info"
                  />
                )}
              </>
            ) : (
              <p className="text-[12px] text-gray-500">Enter a valid example shift and valid numbers to see it.</p>
            )}
          </PreviewCard>
        }
      >
        <ToggleField
          id="morning-late-in-switch"
          checked={morningOn}
          onChange={(v) => patch({ morningLateInEnabled: v })}
          onLabel="Morning Late-In marks are counted"
          offLabel="Morning Late-In marks are off"
          disabled={!loaded || !access.companyWideEditable || !access.morningReported}
        >
          Judged against each shift's start plus its grace.
        </ToggleField>
        {loaded && !access.morningReported && (
          <p data-testid="morning-not-reported" className="text-[11px] font-medium text-slate-500">
            {NOT_REPORTED_NOTE}
          </p>
        )}
      </SettingBlock>

      <SettingBlock
        id="evening-early-out"
        labelFor="evening-early-out-switch"
        title="Evening Early-Out"
        purpose="Turns the Early Out mark on or off for a last punch before the shift end minus its grace. Each Early Out day is one mark in the same monthly pool as Late."
        affects={[
          {
            where: "Staff Attendance",
            what: "Early Out badges; Attendance Search shows its Early Out filters only while this is on",
            to: "/hr/attendance/staff",
          },
          {
            where: "Late Detection and Staff Payroll",
            what: "Early Out days join the same free allowance and deduction slabs",
            to: "/hr/settings?tab=late_detection",
          },
          { where: "Reports and employee apps", what: "hide Early Out wording and counts while it is off" },
        ]}
        defaultText="Off"
        note={`Turning it on adds a new deduction for every staff member. A day needs at least two punches to be Early Out. An approved Evening Early-Out permission within the monthly cap moves that day's end ${PERMISSION_MINUTES} minutes earlier.`}
        preview={
          <PreviewCard title="Example" scenario={scenario}>
            {examples ? (
              <>
                <PreviewLine
                  label={`Last punch ${clock(examples.leaveAt)}`}
                  result={
                    examples.leaveEarly.earlyOut ? "Early Out: 1 mark in the pool" : "no mark (the switch is off)"
                  }
                  tone={examples.leaveEarly.earlyOut ? "warn" : "good"}
                />
                <PreviewLine label={`Last punch ${clock(examples.leaveAt + 1)}`} result="no mark" tone="good" />
                <PreviewLine
                  label="With an approved Evening Early-Out permission"
                  result={`only a last punch before ${clock(examples.permitted.earlyOutBefore)} is Early Out`}
                  tone="info"
                />
              </>
            ) : (
              <p className="text-[12px] text-gray-500">Enter a valid example shift and valid numbers to see it.</p>
            )}
          </PreviewCard>
        }
      >
        <ToggleField
          id="evening-early-out-switch"
          checked={eveningOn}
          onChange={(v) => patch({ eveningEarlyOutEnabled: v })}
          onLabel="Evening Early-Out marks are counted"
          offLabel="Evening Early-Out marks are off"
          disabled={!loaded || !access.companyWideEditable || !access.eveningReported}
        >
          Judged against each shift's end minus its grace.
        </ToggleField>
        {loaded && !access.eveningReported && (
          <p data-testid="evening-not-reported" className="text-[11px] font-medium text-slate-500">
            {NOT_REPORTED_NOTE}
          </p>
        )}
      </SettingBlock>

      {!access.companyWideEditable && (
        <p data-testid="company-wide-note-late" className="text-[11px] font-medium text-slate-500">
          Company-wide rule - set by an administrator
        </p>
      )}
      <p className="pt-2 text-[12px] text-gray-500">
        What each mark costs:{" "}
        <SettingLink tab="late_detection" setting="free-allowance">
          Late Detection - free allowance and deduction slabs
        </SettingLink>
      </p>
    </SettingsSection>
  );
}
