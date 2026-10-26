import { Users } from "lucide-react";
import { ManagedElsewhere, SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { PRODUCTION_SHIFT_SECTIONS, productionShiftText } from "../ProductionShiftsTab.meta";

/**
 * The Staff page of the Production Shifts tab: nothing is set here. Staff shifts, their start and end and their grace come
 * from Manage Shifts, and how a staff day's punches become a Full Day, Half Day or Absent is on Attendance, Staff page, so
 * this page only says so, with links. The production shift rules on the Production page never apply to staff.
 */
export function StaffShiftsPage() {
  return (
    <SettingsSection
      icon={Users}
      title={PRODUCTION_SHIFT_SECTIONS.staff}
      purpose="Staff are not affected by anything on the Production page. This page only says where a staff member's shift and grace are set."
      usedBy={[
        { label: "Staff Attendance", to: "/hr/attendance/staff" },
        { label: "Manage Shifts", to: "/hr/shifts" },
      ]}
      testId="production-shifts-staff-section"
    >
      <SettingBlock
        id="staff-shifts-where"
        {...productionShiftText("staff-shifts-where")}
        affects={[
          {
            where: "Staff Attendance",
            what: "a staff day is worked out from the shift assigned in Manage Shifts and the rules on Attendance, never from the production shift rules",
            to: "/hr/attendance/staff",
          },
          {
            where: "Manage Shifts",
            what: "staff shifts, their start and end times and their grace are created and assigned there",
            to: "/hr/shifts",
          },
          { where: "Production workers", what: "use the Production page of this tab instead" },
        ]}
      >
        <ManagedElsewhere
          title="Staff shifts and grace"
          to="/hr/shifts"
          linkLabel="Open Manage Shifts"
          testId="staff-shifts-manage"
        >
          Manage Shifts: each staff shift's start and end time, its grace and who it is assigned to are set there. The
          grace of a staff shift is part of that shift, not a setting of this tab.
        </ManagedElsewhere>
        <ManagedElsewhere
          title="Staff attendance rules"
          to="/hr/settings?tab=attendance#attendance-mode"
          linkLabel="Open Attendance - Staff"
          testId="staff-shifts-attendance"
        >
          Attendance, Staff page: how a staff day's punches become a Full Day, Half Day or Absent, and when an arrival
          is Late or a departure Early Out, are set there.
        </ManagedElsewhere>
        <ManagedElsewhere
          title="What staff late marks cost"
          to="/hr/settings?tab=late_detection#free-allowance"
          linkLabel="Open Late Detection - Staff"
          testId="staff-shifts-late"
        >
          Late Detection, Staff page: the free marks a month and the deduction slabs for staff are set there.
        </ManagedElsewhere>
      </SettingBlock>
    </SettingsSection>
  );
}
