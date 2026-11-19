import { Link } from "wouter";
import { ArrowUpRight, Cake, CalendarClock, Megaphone } from "lucide-react";
import { SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { ToggleField } from "../kit/Field";
import { COMPENSATION_SECTIONS, compensationText } from "../CompensationTab.meta";
import { prettyDate } from "./form";
import { FromDate, masterOffNote, notes, type SectionProps } from "./ui";
import { leavePath } from "@/pages/hr/compensation/routes";

const block = (id: string) => ({ id, ...compensationText(id) });

/** Compensation Leave - A: the dates HR announces for late-in or early-out for everybody. */
export function WindowsSection({ draft, patch, readOnly, masterOn }: SectionProps) {
  return (
    <SettingsSection
      id="compensation-leave-a"
      icon={Megaphone}
      title={COMPENSATION_SECTIONS.windows}
      purpose="For a day the company announces (a festival, an event, bad weather): HR gives the date, whether it is a late-in or an early-out, the time and a reason. Staff only."
      usedBy={[
        { label: "Compensation", to: leavePath("announcements") },
        { label: "Staff Attendance", to: "/hr/attendance/staff" },
        { label: "Employee apps" },
      ]}
      testId="compensation-leave-a"
    >
      <SettingBlock
        {...block("windows-enabled")}
        labelFor="compensation-windows-switch"
        defaultText="Off"
        affects={[
          {
            where: "Compensation - Compensation Leave",
            what: "the announcement form (date, Late-in or Early-out, time, reason) is offered only while this is on",
            to: leavePath("announcements"),
          },
          {
            where: "Staff Attendance",
            what: "on that date all staff may arrive or leave by the announced time: their own shift start or end and grace do not apply, and no late-in or early-out is detected for it",
            to: "/hr/attendance/staff",
          },
          { where: "Employee apps", what: "the day shows the announcement and the Compensation marker" },
        ]}
        note={notes(
          "An announcement is for one date, so it only ever acts on that date; days before it are never changed. Only a future announcement can be deleted.",
          masterOffNote(masterOn),
        )}
      >
        <ToggleField
          id="compensation-windows-switch"
          checked={draft.windowsEnabled}
          onChange={(v) => patch({ windowsEnabled: v })}
          onLabel="HR can announce late-in / early-out days"
          offLabel="Announcements are not offered"
          disabled={readOnly}
        >
          Switching this off stops new announcements; the ones already made are kept.
        </ToggleField>
      </SettingBlock>
    </SettingsSection>
  );
}

/** Compensation Leave - B: alternative-day compensation for work on Sundays and company holidays, after the HOD approves. */
export function HolidayWorkSection({ draft, patch, readOnly, masterOn }: SectionProps) {
  return (
    <SettingsSection
      id="compensation-leave-b"
      icon={CalendarClock}
      title={COMPENSATION_SECTIONS.holidayWork}
      purpose="0.25, 0.50, 0.75 or 1 shift of alternative-day compensation, by the shifts the employee worked on a Sunday or a company holiday: claimed by the employee or HR, approved by the Department Head, then added to the balance. Staff only."
      usedBy={[
        { label: "Compensation", to: leavePath("holiday-work") },
        { label: "Approvals" },
        { label: "Employee apps" },
      ]}
      testId="compensation-leave-b"
    >
      <SettingBlock
        {...block("holiday-work-enabled")}
        labelFor="compensation-holiday-work-switch"
        defaultText="Off"
        affects={[
          {
            where: "Compensation - Compensation Leave",
            what: "the employee or HR can claim shifts for a Sunday or company-holiday work day only while this is on",
            to: leavePath("holiday-work"),
          },
          {
            where: "Approvals",
            what: "the request appears for the employee's Department Head, who verifies it; only after that is it added to the compensation balance",
          },
          { where: "Employee apps", what: "the compensation balance and the request show on the Compensation page" },
        ]}
        note={notes(
          <>
            Who approves, and in what order, is set in{" "}
            <Link
              href="/hr/user-management?tab=approvals"
              className="inline-flex items-center gap-0.5 font-semibold underline"
              data-testid="link-approval-workflow"
            >
              User Management - Approval Workflow Control
              <ArrowUpRight size={11} />
            </Link>
            . It is not set here.
          </>,
          masterOffNote(masterOn),
        )}
      >
        <ToggleField
          id="compensation-holiday-work-switch"
          checked={draft.holidayWorkEnabled}
          onChange={(v) => patch({ holidayWorkEnabled: v })}
          onLabel="Sunday and holiday work can be claimed"
          offLabel="Sunday and holiday work is not offered"
          disabled={readOnly}
        >
          The employee or HR claims it; it counts only after the Department Head approves it.
        </ToggleField>
      </SettingBlock>
    </SettingsSection>
  );
}

/**
 * Compensation Leave - C: the birthday, judged from attendance (from the claims date): absent or on leave = paid Birthday
 * leave; present = one 1.00 credit to claim. Before the claims date it was automatic.
 */
export function BirthdaySection({ draft, patch, readOnly, masterOn, validation, today, claimsFrom }: SectionProps) {
  const fromText = claimsFrom ? prettyDate(claimsFrom) : "the claims date";
  return (
    <SettingsSection
      id="compensation-leave-c"
      icon={Cake}
      title={COMPENSATION_SECTIONS.birthday}
      purpose="The birthday is a normal working day, worked out from the date of birth on the employee record and judged from attendance: never given without checking it. Staff only; HR sees each employee's outcome on the Compensation page."
      usedBy={[
        { label: "Compensation", to: leavePath("birthdays") },
        { label: "Staff Attendance", to: "/hr/attendance/staff" },
        { label: "Staff Payroll", to: "/hr/payroll" },
        { label: "Employee apps" },
      ]}
      testId="compensation-leave-c"
    >
      <SettingBlock
        {...block("birthday-enabled")}
        labelFor="compensation-birthday-switch"
        defaultText="Off"
        affects={[
          {
            where: "Staff Attendance",
            what: "absent (no punch) or on approved leave, casual leave included, on the birthday: the day becomes paid Birthday leave (1.00 shift) without using any leave balance",
            to: "/hr/attendance/staff",
          },
          { where: "Staff Payroll", what: "the Birthday leave day is paid as a full working day", to: "/hr/payroll" },
          {
            where: "Compensation - Compensation Leave",
            what: "shows each employee's outcome: paid leave, a credit to claim, claimed, approved",
            to: leavePath("birthdays"),
          },
          {
            where: "Approvals",
            what: "present or half day on the birthday: one 1.00 credit, claimed by the employee or HR, approved by the Department Head into the balance",
          },
          {
            where: "Employee apps",
            what: "the calendar shows the Birthday leave; My Compensation offers the credit to claim",
          },
        ]}
        note={notes(
          "A birthday on a Sunday, a company holiday or an off Saturday gives nothing (working that day is ordinary holiday work). A birthday on 29 February counts on 28 February in other years. An employee with no date of birth gets nothing.",
          `This applies from ${fromText}; birthdays before it kept the old automatic paid day.`,
          masterOffNote(masterOn),
        )}
      >
        <ToggleField
          id="compensation-birthday-switch"
          checked={draft.birthdayEnabled}
          onChange={(v) => patch({ birthdayEnabled: v })}
          onLabel="Birthday leave is given"
          offLabel="Birthday leave is not given"
          disabled={readOnly}
        >
          Judged from attendance: paid leave when absent or on leave, a credit to claim when present. Staff only.
        </ToggleField>
      </SettingBlock>

      <SettingBlock
        {...block("birthday-effective-from")}
        labelFor="compensation-birthday-from"
        defaultText="Today, whenever birthday leave is switched on"
        affects={[
          {
            where: "Staff Attendance",
            what: "birthdays before this date are judged exactly as before, even when their month is opened or generated again",
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
          id="compensation-birthday-from"
          testId="birthday-from"
          value={draft.birthdayFrom}
          onChange={(v) => patch({ birthdayFrom: v })}
          error={validation.birthdayFrom}
          today={today}
          readOnly={readOnly}
          blankText="Not set yet: switching birthday leave on sets it to today."
        />
      </SettingBlock>
    </SettingsSection>
  );
}
